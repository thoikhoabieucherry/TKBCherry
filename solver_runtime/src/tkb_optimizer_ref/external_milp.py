"""Wire HiGHS MILP models to the local Browser Agent.

The reference solver still builds the canonical matrix on the VPS. When an
external callback is installed, this module serializes that same matrix as a
CPLEX LP document, lets the Browser HiGHS WASM runtime solve it, then checks the
returned primal vector against the original matrix before materialization.
"""

from __future__ import annotations

import base64
import json
import math
from types import SimpleNamespace
from typing import Any, Mapping

import numpy as np

from .external_cp_sat import (
    EXTERNAL_HIGHS_MODEL_MAGIC,
    ExternalCpSatProtocolError,
    ExternalCpSatUnusableResponse,
    active_external_solver,
)


class ExternalMilpUnusableResponse(ExternalCpSatUnusableResponse):
    """A Browser HiGHS run returned no usable primal vector."""

    def __init__(self, status_name: str) -> None:
        self.status = 0
        self.status_name = str(status_name or "UNKNOWN")
        self.args = (
            f"External HiGHS returned a non-materializable status: {self.status_name}",
        )


def _finite_number(value: Any, *, default: float | None = None) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def serialize_milp_lp(
    objective: Any,
    integrality: Any,
    lower_bounds: Any,
    upper_bounds: Any,
    matrix: Any,
    constraint_lower: Any,
    constraint_upper: Any,
) -> bytes:
    """Serialize SciPy's binary/integer MILP envelope to CPLEX LP text."""

    objective = np.asarray(objective, dtype=float).reshape(-1)
    integrality = np.asarray(integrality, dtype=int).reshape(-1)
    lower_bounds = np.asarray(lower_bounds, dtype=float).reshape(-1)
    upper_bounds = np.asarray(upper_bounds, dtype=float).reshape(-1)
    matrix = matrix.tocsr()
    constraint_lower = np.asarray(constraint_lower, dtype=float).reshape(-1)
    constraint_upper = np.asarray(constraint_upper, dtype=float).reshape(-1)
    variable_count = len(objective)
    if not (
        len(integrality) == variable_count
        and len(lower_bounds) == variable_count
        and len(upper_bounds) == variable_count
        and matrix.shape[1] == variable_count
        and matrix.shape[0] == len(constraint_lower) == len(constraint_upper)
    ):
        raise ExternalCpSatProtocolError("External HiGHS MILP dimensions are invalid")
    if any(int(value) not in (0, 1) for value in integrality):
        raise ExternalCpSatProtocolError("External HiGHS only supports continuous/integer variables")

    def term(coefficient: float, index: int) -> str:
        if abs(coefficient - round(coefficient)) < 1e-9:
            rendered = str(int(round(coefficient)))
        else:
            rendered = format(coefficient, ".12g")
        return f"{rendered} x{index}"

    lines = ["Minimize"]
    objective_terms = [
        term(float(value), index)
        for index, value in enumerate(objective)
        if abs(float(value)) > 1e-12
    ]
    lines.append(" obj: " + (" + ".join(objective_terms) if objective_terms else "0"))
    lines.append("Subject To")
    for row_index in range(matrix.shape[0]):
        start = int(matrix.indptr[row_index])
        end = int(matrix.indptr[row_index + 1])
        row_terms = [
            term(float(coefficient), int(column))
            for column, coefficient in zip(
                matrix.indices[start:end],
                matrix.data[start:end],
            )
            if abs(float(coefficient)) > 1e-12
        ]
        expression = " + ".join(row_terms) or "0"
        lower = float(constraint_lower[row_index])
        upper = float(constraint_upper[row_index])
        if math.isfinite(lower) and math.isfinite(upper) and abs(lower - upper) < 1e-9:
            lines.append(f" c{row_index}: {expression} = {format(lower, '.12g')}")
        else:
            if math.isfinite(lower):
                lines.append(f" c{row_index}lo: {expression} >= {format(lower, '.12g')}")
            if math.isfinite(upper):
                lines.append(f" c{row_index}hi: {expression} <= {format(upper, '.12g')}")
    lines.append("Bounds")
    for index, (lower, upper) in enumerate(zip(lower_bounds, upper_bounds)):
        lo = format(float(lower), ".12g") if math.isfinite(float(lower)) else ("-inf" if lower < 0 else "inf")
        hi = format(float(upper), ".12g") if math.isfinite(float(upper)) else ("-inf" if upper < 0 else "inf")
        lines.append(f" {lo} <= x{index} <= {hi}")
    binary = [
        f" x{index}"
        for index, value in enumerate(integrality)
        if int(value) == 1 and abs(float(lower_bounds[index])) < 1e-9 and abs(float(upper_bounds[index]) - 1) < 1e-9
    ]
    if binary:
        lines.append("Binary")
        lines.extend(binary)
    general = [
        f" x{index}"
        for index, value in enumerate(integrality)
        if int(value) == 1
        and not (
            abs(float(lower_bounds[index])) < 1e-9
            and abs(float(upper_bounds[index]) - 1) < 1e-9
        )
    ]
    if general:
        lines.append("General")
        lines.extend(general)
    lines.append("End")
    return "\n".join(lines).encode("ascii") + b"\n"


def _validate_primal_vector(
    values: Any,
    *,
    integrality: Any,
    lower_bounds: Any,
    upper_bounds: Any,
    matrix: Any,
    constraint_lower: Any,
    constraint_upper: Any,
) -> np.ndarray:
    vector = np.asarray(values, dtype=float).reshape(-1)
    integrality = np.asarray(integrality, dtype=int).reshape(-1)
    lower_bounds = np.asarray(lower_bounds, dtype=float).reshape(-1)
    upper_bounds = np.asarray(upper_bounds, dtype=float).reshape(-1)
    if len(vector) != len(integrality) or not np.all(np.isfinite(vector)):
        raise ExternalMilpUnusableResponse("invalid_primal_vector")
    if np.any(vector < lower_bounds - 1e-5) or np.any(vector > upper_bounds + 1e-5):
        raise ExternalMilpUnusableResponse("primal_outside_bounds")
    integer_indices = np.flatnonzero(integrality == 1)
    if integer_indices.size and np.any(
        np.abs(vector[integer_indices] - np.rint(vector[integer_indices])) > 1e-5
    ):
        raise ExternalMilpUnusableResponse("fractional_integer_primal")
    matrix = matrix.tocsr()
    activity = np.asarray(matrix @ vector, dtype=float).reshape(-1)
    constraint_lower = np.asarray(constraint_lower, dtype=float).reshape(-1)
    constraint_upper = np.asarray(constraint_upper, dtype=float).reshape(-1)
    if np.any(activity < constraint_lower - 1e-4) or np.any(activity > constraint_upper + 1e-4):
        raise ExternalMilpUnusableResponse("primal_violates_constraints")
    return vector


def solve_milp_with_external_runtime(
    objective: Any,
    integrality: Any,
    lower_bounds: Any,
    upper_bounds: Any,
    matrix: Any,
    constraint_lower: Any,
    constraint_upper: Any,
    *,
    time_limit_seconds: int,
    threads: int = 1,
    mip_rel_gap: float = 0.0,
) -> SimpleNamespace | None:
    """Solve through Browser HiGHS, or return ``None`` for native fallback."""

    runtime = active_external_solver()
    if runtime is None:
        return None
    lp_bytes = serialize_milp_lp(
        objective,
        integrality,
        lower_bounds,
        upper_bounds,
        matrix,
        constraint_lower,
        constraint_upper,
    )
    parameter_bytes = json.dumps(
        {
            "time_limit": max(1, int(time_limit_seconds)),
            "threads": max(1, int(threads)),
            "mip_rel_gap": max(0.0, float(mip_rel_gap)),
            "output_flag": False,
            "log_to_console": False,
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("ascii")
    response_bytes = runtime(EXTERNAL_HIGHS_MODEL_MAGIC + lp_bytes, parameter_bytes)
    try:
        response = json.loads(bytes(response_bytes).decode("utf-8"))
    except (TypeError, ValueError, UnicodeDecodeError) as exc:
        raise ExternalCpSatProtocolError("External HiGHS response is invalid JSON") from exc
    if not isinstance(response, Mapping):
        raise ExternalCpSatProtocolError("External HiGHS response is not an object")
    status_name = str(response.get("status") or "Unknown")
    accepted_statuses = {
        "Optimal",
        "Time limit reached",
        "Target for objective reached",
        "Bound on objective reached",
        "Iteration limit reached",
    }
    no_primal_statuses = {
        "Infeasible": 2,
        "Primal infeasible or unbounded": 2,
        "Unbounded": 3,
        "Load error": 4,
        "Model error": 4,
        "Presolve error": 4,
        "Solve error": 4,
        "Empty": 4,
        "Not Set": 4,
        "Unknown": 4,
    }
    values = response.get("values")
    if values is None and isinstance(response.get("valuesBase64"), str):
        try:
            values = json.loads(
                base64.b64decode(response["valuesBase64"], validate=True).decode("utf-8")
            )
        except (ValueError, UnicodeDecodeError) as exc:
            raise ExternalCpSatProtocolError("External HiGHS primal vector is invalid") from exc
    if values is None:
        if status_name in {"Time limit reached", "Iteration limit reached"}:
            return SimpleNamespace(
                status=1,
                message=status_name,
                x=None,
                fun=None,
                success=False,
            )
        if status_name in no_primal_statuses:
            return SimpleNamespace(
                status=no_primal_statuses[status_name],
                message=status_name,
                x=None,
                fun=None,
                success=False,
            )
        raise ExternalMilpUnusableResponse(status_name)
    if status_name not in accepted_statuses:
        raise ExternalMilpUnusableResponse(status_name)
    vector = _validate_primal_vector(
        values,
        integrality=integrality,
        lower_bounds=lower_bounds,
        upper_bounds=upper_bounds,
        matrix=matrix,
        constraint_lower=constraint_lower,
        constraint_upper=constraint_upper,
    )
    objective_value = float(np.dot(np.asarray(objective, dtype=float), vector))
    return SimpleNamespace(
        status=0 if status_name == "Optimal" else 1,
        message=status_name,
        x=vector,
        fun=objective_value,
        success=True,
    )


__all__ = [
    "ExternalMilpUnusableResponse",
    "serialize_milp_lp",
    "solve_milp_with_external_runtime",
]
