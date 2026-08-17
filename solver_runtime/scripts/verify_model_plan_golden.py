"""Verify a model-plan manifest against private captured artifacts.

Production school request/model/result files stay outside Git. This command
checks them against the committed, non-sensitive 1,566-period manifest.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import sys
from pathlib import Path
from typing import Any


RUNTIME_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME_ROOT / "src"))

from ortools.sat import cp_model_pb2  # noqa: E402

from tkb_optimizer_ref.model_plan import (  # noqa: E402
    ModelPlanContractError,
    canonical_json_bytes,
    model_plan_digest,
    validate_variable_map,
    verify_model_plan_artifacts,
)


def _role(name: str) -> str:
    for prefix, role in (
        ("period_block_", "lesson_block"),
        ("n_", "assignment_session_count"),
        ("u_", "assignment_session_used"),
        ("z_", "teacher_session_active"),
        ("c_", "class_session_active"),
        ("d_", "teacher_day_active"),
    ):
        if name.startswith(prefix):
            return role
    return "anonymous" if not name else "solver_variable"


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _wrapper_payload(path: Path) -> tuple[dict[str, Any], bytes, bytes]:
    wrapper = _load_json(path)
    payload = wrapper.get("payload", wrapper)
    if not isinstance(payload, dict):
        raise ModelPlanContractError("model wrapper payload is not an object")
    try:
        model_bytes = base64.b64decode(payload["modelBase64"], validate=True)
        parameter_bytes = base64.b64decode(
            payload.get("parameterBase64", ""), validate=True
        )
    except (KeyError, TypeError, ValueError, binascii.Error) as exc:
        raise ModelPlanContractError("model wrapper base64 is invalid") from exc
    return payload, model_bytes, parameter_bytes


def _cp_sat_statistics(model_bytes: bytes) -> tuple[dict[str, int], list[dict[str, Any]]]:
    model = cp_model_pb2.CpModelProto.FromString(model_bytes)
    variable_map = []
    for index, variable in enumerate(model.variables):
        name = str(variable.name or "")
        variable_map.append(
            {"index": index, "key": name or f"#{index}", "role": _role(name)}
        )
    statistics = {
        "variables": len(model.variables),
        "constraints": len(model.constraints),
        "objectiveVariables": len(model.objective.vars),
        "hintVariables": len(model.solution_hint.vars),
    }
    return statistics, variable_map


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--model-wrapper", type=Path, required=True)
    parser.add_argument("--result", type=Path, required=True)
    args = parser.parse_args()

    plan = _load_json(args.plan)
    request = _load_json(args.request)
    result = _load_json(args.result)
    payload, model_bytes, parameter_bytes = _wrapper_payload(args.model_wrapper)
    if payload.get("kind") != "external_cp_sat_model":
        raise ModelPlanContractError(
            "golden verifier currently expects an external_cp_sat_model frame"
        )
    statistics, variable_map = _cp_sat_statistics(model_bytes)
    expected_statistics = plan["model"]["statistics"]
    if statistics != expected_statistics:
        raise ModelPlanContractError(
            f"model statistics drifted: expected={expected_statistics}, actual={statistics}"
        )
    validate_variable_map(variable_map, expected_entries=statistics["variables"])
    if len(canonical_json_bytes(variable_map)) != plan["variableMap"]["bytes"]:
        raise ModelPlanContractError("variable map byte size drifted")
    verify_model_plan_artifacts(
        plan,
        request=request,
        model_bytes=model_bytes,
        parameter_bytes=parameter_bytes,
        variable_map=variable_map,
        result=result,
    )
    print(
        json.dumps(
            {
                "ok": True,
                "fixtureId": plan["fixtureId"],
                "planSha256": model_plan_digest(plan),
                "modelDigest": payload.get("modelDigest"),
                "variables": statistics["variables"],
                "constraints": statistics["constraints"],
                "quality": plan["result"]["quality"],
            },
            ensure_ascii=False,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ModelPlanContractError, OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"model-plan verification failed: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc
