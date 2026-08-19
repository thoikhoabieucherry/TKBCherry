from __future__ import annotations

from collections import Counter, defaultdict
from contextlib import contextmanager
import contextvars
from dataclasses import dataclass
import hashlib
import itertools
import os
from pathlib import Path
import re
import tempfile
from typing import Any, Callable, Iterator, Mapping

from google.protobuf import text_format
# Optional-dependency guard: engine v3 runs without ortools. Legacy CP-SAT
# lanes need the real package; with it missing they fail only when invoked.
class _MissingModule:
    """Placeholder that tolerates attribute chains (annotations) but raises
    with a clear message the moment legacy code actually calls into it."""

    def __init__(self, dep: str = "ortools"):
        self._dep = dep

    def __getattr__(self, name):
        return _MissingModule(self._dep)

    def __call__(self, *args, **kwargs):
        raise RuntimeError(
            f"{self._dep} is not installed; the legacy solver lane needs it "
            "(engine v3 does not)."
        )


try:
    from ortools.sat import cp_model_pb2, sat_parameters_pb2
    from ortools.sat.python import cp_model_helper
except Exception:  # pragma: no cover - machines without ortools
    cp_model_pb2 = _MissingModule("ortools")
    sat_parameters_pb2 = _MissingModule("ortools")
    cp_model_helper = _MissingModule("ortools")

from .model_plan import MODEL_PLAN_PROTOCOL


ExternalCpSatSolver = Callable[[bytes, bytes], bytes]
EXTERNAL_HIGHS_MODEL_MAGIC = b"TKB_HIGHS_LP_V1\0"
EXTERNAL_MODEL_PLAN_VERSION = MODEL_PLAN_PROTOCOL


class ExternalCpSatPending(BaseException):
    """Yield one model to a remote CP-SAT runtime.

    This deliberately derives from ``BaseException`` rather than ``Exception``.
    The reference adapter has many best-effort ``except Exception`` branches;
    a model hand-off must cross those branches without being mistaken for a
    solver failure or silently downgraded to a heuristic result.
    """

    def __init__(
        self,
        model_bytes: bytes,
        parameter_bytes: bytes,
        index: int,
        digest: str,
        *,
        kind: str = "external_cp_sat_model",
        runtime: str = "ortools-cp-sat-9.15-wire-v1",
        model_plan_version: str = EXTERNAL_MODEL_PLAN_VERSION,
    ) -> None:
        super().__init__("external CP-SAT model is ready")
        self.model_bytes = bytes(model_bytes)
        self.parameter_bytes = bytes(parameter_bytes)
        self.index = int(index)
        self.digest = str(digest)
        self.kind = str(kind)
        self.runtime = str(runtime)
        self.model_plan_version = str(model_plan_version)


_ACTIVE_EXTERNAL_SOLVER: contextvars.ContextVar[ExternalCpSatSolver | None] = (
    contextvars.ContextVar("tkb_external_cp_sat_solver", default=None)
)


@dataclass(frozen=True)
class ExternalCpSatLnsPolicy:
    """Request-scoped quality envelope for Browser CP-SAT neighborhoods."""

    enabled: bool = False
    already_scoped: bool = False
    random_seed: int = 1
    max_teacher_sessions: int | None = None
    max_one_period_sessions: int | None = None
    max_gap2_sessions: int | None = None
    fixed_teacher_periods: tuple[tuple[str, int, tuple[int, ...]], ...] = ()
    incumbent_teacher_periods: tuple[tuple[str, int, tuple[int, ...]], ...] = ()


@dataclass(frozen=True)
class ExternalCpSatPreparedModel:
    model_bytes: bytes
    parameter_bytes: bytes
    applied: bool = False
    fixed_primary_variables: int = 0
    released_assignments: int = 0
    target_teachers: int = 0


_ACTIVE_EXTERNAL_LNS_POLICY: contextvars.ContextVar[ExternalCpSatLnsPolicy | None] = (
    contextvars.ContextVar("tkb_external_cp_sat_lns_policy", default=None)
)

_N_VAR_RE = re.compile(r"^n_(\d+)_(\d+)$")
_PERIOD_BLOCK_VAR_RE = re.compile(r"^period_block_(\d+)_(\d+)_(\d+)_(\d+)$")
_TEACHER_SESSION_VAR_RE = re.compile(r"^z_(.+)_(\d+)$")
_CLASS_SESSION_VAR_RE = re.compile(r"^c_(.+)_(\d+)$")
_CLUSTER_PATTERN_VAR_RE = re.compile(
    r"^cluster_p_(\d+)_(\d+)_(\d+)_(\d+)$"
)
_CLUSTER_OCC_VAR_RE = re.compile(r"^cluster_occ_(.+)_(\d+)_(\d+)$")
_CLUSTER_ACTIVE_VAR_RE = re.compile(r"^cluster_active_(.+)_(\d+)$")
_INT64_MIN = -(2**63)
_INT64_MAX = 2**63 - 1


def active_external_solver() -> ExternalCpSatSolver | None:
    """Return the solver callback for the current request, if any."""

    return _ACTIVE_EXTERNAL_SOLVER.get()


@contextmanager
def external_solver_scope(
    solver: ExternalCpSatSolver | None,
    *,
    lns_policy: ExternalCpSatLnsPolicy | None = None,
) -> Iterator[None]:
    """Install an external solver callback for all nested CP-SAT phases."""

    token = _ACTIVE_EXTERNAL_SOLVER.set(solver)
    policy_token = _ACTIVE_EXTERNAL_LNS_POLICY.set(lns_policy)
    try:
        yield
    finally:
        _ACTIVE_EXTERNAL_LNS_POLICY.reset(policy_token)
        _ACTIVE_EXTERNAL_SOLVER.reset(token)


def _truthy(value: Any) -> bool:
    return str(value or "").strip().casefold() not in {"", "0", "false", "off", "no"}


def _nonnegative_int(value: Any) -> int | None:
    try:
        result = int(value)
    except (TypeError, ValueError):
        return None
    return result if result >= 0 else None


def external_cp_sat_lns_policy_from_request(
    ui_data: Mapping[str, Any] | None,
    settings: Mapping[str, Any] | None,
) -> ExternalCpSatLnsPolicy:
    """Build a conservative Browser-only LNS policy from a validated incumbent."""

    data = ui_data if isinstance(ui_data, Mapping) else {}
    options = settings if isinstance(settings, Mapping) else {}
    incumbent = data.get("tkbSolverResult")
    if not isinstance(incumbent, Mapping):
        return ExternalCpSatLnsPolicy()
    metrics = incumbent.get("metrics")
    validation = incumbent.get("validation")
    lessons = incumbent.get("lessons")
    if not isinstance(metrics, Mapping) or not isinstance(lessons, list):
        return ExternalCpSatLnsPolicy()
    hard_ok = metrics.get("hard_ok") is True or (
        isinstance(validation, Mapping) and validation.get("hard_ok") is True
    )
    expected = _nonnegative_int(metrics.get("expected_periods"))
    scheduled = _nonnegative_int(metrics.get("scheduled_periods"))
    unassigned = _nonnegative_int(metrics.get("unassigned_periods"))
    focus = str(options.get("optimization_focus") or "automatic").strip().casefold()
    one_period = _nonnegative_int(metrics.get("one_period_teacher_sessions"))
    gap2 = _nonnegative_int(metrics.get("teacher_gap2_sessions"))
    if gap2 is None:
        distribution = metrics.get("gap_distribution")
        if isinstance(distribution, Mapping):
            gap2 = sum(
                _nonnegative_int(value) or 0
                for key, value in distribution.items()
                if (_nonnegative_int(key) or 0) >= 2
            )
    # A complete incumbent may still carry singleton/Gap2 debt.  Refusing such
    # a neighborhood made the Browser Agent unable to improve the first Play
    # result; the per-model caps below remain bounded by that incumbent and
    # the server validates every returned candidate before publication.
    enabled = bool(
        _truthy(options.get("browser_wasm_external_cp_sat"))
        and focus in {"automatic", "sessions"}
        and hard_ok
        and expected is not None
        and expected > 0
        and scheduled == expected
        and (unassigned or 0) == 0
    )
    fixed_periods: dict[tuple[str, int], set[int]] = defaultdict(set)
    incumbent_periods: dict[tuple[str, int], set[int]] = defaultdict(set)
    if enabled:
        for lesson in lessons:
            if not isinstance(lesson, Mapping):
                continue
            teacher = str(lesson.get("teacher") or lesson.get("teacherId") or "").strip()
            part = str(lesson.get("session") or lesson.get("part") or "").strip().upper()
            day = _nonnegative_int(lesson.get("day"))
            period = _nonnegative_int(lesson.get("period"))
            if not teacher or part not in {"AM", "PM"} or day is None or not 2 <= day <= 7:
                continue
            if period is None or period <= 0:
                continue
            session_index = day - 2 + (6 if part == "PM" else 0)
            incumbent_periods[(teacher, session_index)].add(period)
            if lesson.get("fixed") is True:
                fixed_periods[(teacher, session_index)].add(period)
    try:
        random_seed = max(1, int(options.get("random_seed") or 1))
    except (TypeError, ValueError):
        random_seed = 1
    return ExternalCpSatLnsPolicy(
        enabled=enabled,
        # The Browser refinement pipeline already builds a bounded class
        # cluster. Applying this transformer again freezes most of that small
        # model and can leave no useful exchange neighborhood at all.
        already_scoped=(
            _truthy(options.get("browser_wasm_external_lns_already_scoped"))
            or (
                _truthy(options.get("ui_use_existing_complete_incumbent"))
                and _truthy(options.get("ui_existing_incumbent_revalidated"))
            )
        ),
        random_seed=random_seed,
        max_teacher_sessions=_nonnegative_int(metrics.get("teacher_sessions")),
        max_one_period_sessions=one_period,
        max_gap2_sessions=gap2,
        fixed_teacher_periods=tuple(
            (teacher, session_index, tuple(sorted(periods)))
            for (teacher, session_index), periods in sorted(fixed_periods.items())
        ),
        incumbent_teacher_periods=tuple(
            (teacher, session_index, tuple(sorted(periods)))
            for (teacher, session_index), periods in sorted(incumbent_periods.items())
        ),
    )


def _append_linear_constraint(
    model: cp_model_pb2.CpModelProto,
    coefficients: Mapping[int, int],
    lower_bound: int,
    upper_bound: int = _INT64_MAX,
) -> None:
    normalized = [(int(index), int(value)) for index, value in coefficients.items() if int(value)]
    if not normalized:
        if int(lower_bound) <= 0 <= int(upper_bound):
            return
        # Preserve an impossible constant constraint instead of silently
        # widening a malformed incumbent neighborhood.
    constraint = model.constraints.add()
    for index, value in sorted(normalized):
        constraint.linear.vars.append(index)
        constraint.linear.coeffs.append(value)
    constraint.linear.domain.extend([int(lower_bound), int(upper_bound)])


def _assignment_maps(
    model: cp_model_pb2.CpModelProto,
    names: list[str],
) -> tuple[dict[int, str], dict[int, str]]:
    teacher_sets: dict[int, set[str]] = defaultdict(set)
    class_sets: dict[int, set[str]] = defaultdict(set)
    for constraint in model.constraints:
        if constraint.WhichOneof("constraint") != "linear":
            continue
        n_indexes = [
            index
            for index in constraint.linear.vars
            if _N_VAR_RE.fullmatch(names[index])
        ]
        if not n_indexes:
            continue
        teacher_indexes = [
            index
            for index in constraint.linear.vars
            if _TEACHER_SESSION_VAR_RE.fullmatch(names[index])
        ]
        class_indexes = [
            index
            for index in constraint.linear.vars
            if _CLASS_SESSION_VAR_RE.fullmatch(names[index])
        ]
        if len(teacher_indexes) == 1:
            teacher = _TEACHER_SESSION_VAR_RE.fullmatch(names[teacher_indexes[0]]).group(1)
            for index in n_indexes:
                teacher_sets[int(_N_VAR_RE.fullmatch(names[index]).group(1))].add(teacher)
        if len(class_indexes) == 1:
            class_name = _CLASS_SESSION_VAR_RE.fullmatch(names[class_indexes[0]]).group(1)
            for index in n_indexes:
                class_sets[int(_N_VAR_RE.fullmatch(names[index]).group(1))].add(class_name)
    teachers = {
        assignment: next(iter(values))
        for assignment, values in teacher_sets.items()
        if len(values) == 1
    }
    classes = {
        assignment: next(iter(values))
        for assignment, values in class_sets.items()
        if len(values) == 1
    }
    return teachers, classes


def _prepare_cluster_lns_model(
    model: cp_model_pb2.CpModelProto,
    parameters: sat_parameters_pb2.SatParameters,
    policy: ExternalCpSatLnsPolicy,
    *,
    step_index: int,
) -> ExternalCpSatPreparedModel | None:
    names = [str(variable.name or "") for variable in model.variables]
    patterns: dict[tuple[int, int, int, int], int] = {}
    for index, name in enumerate(names):
        match = _CLUSTER_PATTERN_VAR_RE.fullmatch(name)
        if match:
            patterns[tuple(int(match.group(part)) for part in range(1, 5))] = index
    if len(patterns) < 4:
        return None
    hint = {
        int(index): int(value)
        for index, value in zip(model.solution_hint.vars, model.solution_hint.values)
    }
    if sum(index in hint for index in patterns.values()) / len(patterns) < 0.95:
        return None

    assignment_teacher_sets: dict[int, set[str]] = defaultdict(set)
    adjacency: dict[int, set[int]] = defaultdict(set)
    for constraint in model.constraints:
        if constraint.WhichOneof("constraint") != "linear":
            continue
        pattern_indexes = [
            index
            for index in constraint.linear.vars
            if _CLUSTER_PATTERN_VAR_RE.fullmatch(names[index])
        ]
        assignments = {
            int(_CLUSTER_PATTERN_VAR_RE.fullmatch(names[index]).group(1))
            for index in pattern_indexes
        }
        if len(assignments) > 1:
            for assignment in sorted(assignments):
                adjacency[assignment].update(assignments - {assignment})
        occupied_indexes = [
            index
            for index in constraint.linear.vars
            if _CLUSTER_OCC_VAR_RE.fullmatch(names[index])
        ]
        if len(occupied_indexes) == 1 and pattern_indexes:
            teacher = _CLUSTER_OCC_VAR_RE.fullmatch(
                names[occupied_indexes[0]]
            ).group(1)
            for assignment in sorted(assignments):
                assignment_teacher_sets[assignment].add(teacher)
    all_assignments = {key[0] for key in patterns}
    assignment_teachers = {
        assignment: next(iter(values))
        for assignment, values in assignment_teacher_sets.items()
        if len(values) == 1
    }
    if all_assignments - assignment_teachers.keys():
        return None

    teacher_loads: dict[str, Counter[int]] = defaultdict(Counter)
    for (assignment, session_index, _start, duration), index in patterns.items():
        if hint.get(index, 0) > 0:
            teacher_loads[assignment_teachers[assignment]][session_index] += duration
    ranked_teachers = sorted(
        (
            teacher
            for teacher, loads in teacher_loads.items()
            if len(loads) >= 2 and sum(load <= 2 for load in loads.values()) >= 2
        ),
        key=lambda teacher: (
            -sum(load <= 2 for load in teacher_loads[teacher].values()),
            -len(teacher_loads[teacher]),
            teacher,
        ),
    )
    if not ranked_teachers:
        return None
    candidate_teachers = ranked_teachers[:12]
    pairs = list(itertools.combinations(candidate_teachers, 2)) or [tuple(candidate_teachers[:1])]
    neighborhoods: list[tuple[tuple[int, int, int], set[int]]] = []
    for pair in pairs:
        seed_assignments = {
            assignment
            for assignment, teacher in assignment_teachers.items()
            if teacher in pair
        }
        one_hop = set(seed_assignments)
        for assignment in sorted(seed_assignments):
            one_hop.update(adjacency.get(assignment, set()))
        neighborhoods.append(
            (
                (
                    len(one_hop),
                    len({assignment_teachers[item] for item in one_hop}),
                    -sum(
                        sum(load <= 2 for load in teacher_loads[teacher].values())
                        for teacher in pair
                    ),
                ),
                seed_assignments,
            )
        )
    neighborhoods.sort(key=lambda item: item[0])
    selected_index = max(0, int(step_index)) % min(4, len(neighborhoods))
    _score, released_assignments = neighborhoods[selected_index]
    # Session-reduction constraints often need a multi-class exchange. Four
    # bounded graph waves reached a feasible merge on the 1,566-period fixture;
    # fewer waves left the incumbent isolated behind the strict -1 session cap.
    for _wave in range(4):
        expanded = set(released_assignments)
        for assignment in sorted(released_assignments):
            expanded.update(adjacency.get(assignment, set()))
        released_assignments = expanded
    if not released_assignments:
        return None
    target_teachers = {
        assignment_teachers[assignment]
        for assignment in released_assignments
    }

    fixed_primary = 0
    for (assignment, _session_index, _start, _duration), index in patterns.items():
        if assignment in released_assignments or index not in hint:
            continue
        del model.variables[index].domain[:]
        model.variables[index].domain.extend([hint[index], hint[index]])
        fixed_primary += 1

    full_incumbent_periods = {
        (teacher, session_index): set(periods)
        for teacher, session_index, periods in policy.incumbent_teacher_periods
    }
    hinted_variable_periods: dict[tuple[str, int], set[int]] = defaultdict(set)
    pattern_by_teacher_session_period: dict[tuple[str, int, int], list[int]] = defaultdict(list)
    for (assignment, session_index, start, duration), index in patterns.items():
        teacher = assignment_teachers[assignment]
        for period in range(start, start + duration):
            pattern_by_teacher_session_period[(teacher, session_index, period)].append(index)
            if hint.get(index, 0) > 0:
                hinted_variable_periods[(teacher, session_index)].add(period)
    constant_periods = {
        key: set(periods) - hinted_variable_periods.get(key, set())
        for key, periods in full_incumbent_periods.items()
    }
    if policy.max_gap2_sessions == 0:
        for teacher in sorted(target_teachers):
            for session_index in range(12):
                fixed = constant_periods.get((teacher, session_index), set())
                for first in range(1, 6):
                    for last in range(first + 3, 6):
                        required_inside = last - first - 2
                        coefficients: Counter[int] = Counter()
                        fixed_inside = 0
                        for period in range(first + 1, last):
                            fixed_inside += int(period in fixed)
                            coefficients.update(
                                {
                                    index: 1
                                    for index in pattern_by_teacher_session_period.get(
                                        (teacher, session_index, period),
                                        [],
                                    )
                                }
                            )
                        coefficients.update(
                            {
                                index: -required_inside
                                for index in pattern_by_teacher_session_period.get(
                                    (teacher, session_index, first),
                                    [],
                                )
                            }
                        )
                        coefficients.update(
                            {
                                index: -required_inside
                                for index in pattern_by_teacher_session_period.get(
                                    (teacher, session_index, last),
                                    [],
                                )
                            }
                        )
                        lower_bound = (
                            required_inside
                            * (int(first in fixed) + int(last in fixed) - 1)
                            - fixed_inside
                        )
                        _append_linear_constraint(model, coefficients, lower_bound)

    if policy.max_teacher_sessions is not None:
        active_indexes = [
            index
            for index, name in enumerate(names)
            if _CLUSTER_ACTIVE_VAR_RE.fullmatch(name)
        ]
        if active_indexes:
            _append_linear_constraint(
                model,
                {index: 1 for index in active_indexes},
                _INT64_MIN,
                int(policy.max_teacher_sessions),
            )
    parameters.fix_variables_to_their_hinted_value = False
    parameters.repair_hint = False
    parameters.cp_model_presolve = True
    # Keep the per-pass budget chosen by the outer Browser pipeline. Raising
    # every 8-10 second LNS pass to 60 seconds prevents a multi-pass stream
    # from reaching its terminal result inside the canonical 180 second job.
    requested_seconds = float(parameters.max_time_in_seconds or 0.0)
    parameters.max_time_in_seconds = max(0.05, requested_seconds)
    return ExternalCpSatPreparedModel(
        model.SerializeToString(),
        parameters.SerializeToString(),
        applied=True,
        fixed_primary_variables=fixed_primary,
        released_assignments=len(released_assignments),
        target_teachers=len(target_teachers),
    )


def prepare_external_cp_sat_lns_model(
    model_bytes: bytes,
    parameter_bytes: bytes,
    policy: ExternalCpSatLnsPolicy | None,
    *,
    step_index: int = 0,
) -> ExternalCpSatPreparedModel:
    """Freeze most primary decisions and release one connected quality neighborhood."""

    untouched = ExternalCpSatPreparedModel(bytes(model_bytes), bytes(parameter_bytes))
    if policy is None or not policy.enabled or policy.already_scoped:
        return untouched
    model = cp_model_pb2.CpModelProto()
    parameters = sat_parameters_pb2.SatParameters()
    try:
        model.ParseFromString(bytes(model_bytes))
        parameters.ParseFromString(bytes(parameter_bytes))
    except Exception:
        return untouched
    names = [str(variable.name or "") for variable in model.variables]
    cluster_prepared = _prepare_cluster_lns_model(
        model,
        parameters,
        policy,
        step_index=step_index,
    )
    if cluster_prepared is not None:
        return cluster_prepared
    n_indexes: dict[tuple[int, int], int] = {}
    period_indexes: dict[tuple[int, int, int, int], int] = {}
    z_indexes: dict[tuple[str, int], int] = {}
    for index, name in enumerate(names):
        match = _N_VAR_RE.fullmatch(name)
        if match:
            n_indexes[(int(match.group(1)), int(match.group(2)))] = index
            continue
        match = _PERIOD_BLOCK_VAR_RE.fullmatch(name)
        if match:
            period_indexes[tuple(int(match.group(part)) for part in range(1, 5))] = index
            continue
        match = _TEACHER_SESSION_VAR_RE.fullmatch(name)
        if match:
            z_indexes[(match.group(1), int(match.group(2)))] = index
    if len(n_indexes) < 4 or len(period_indexes) < 4 or not z_indexes:
        return untouched
    hint = {
        int(index): int(value)
        for index, value in zip(model.solution_hint.vars, model.solution_hint.values)
    }
    primary_indexes = set(n_indexes.values()) | set(period_indexes.values())
    if any(index not in hint for index in n_indexes.values()):
        return untouched
    hinted_period_ratio = sum(index in hint for index in period_indexes.values()) / len(period_indexes)
    if hinted_period_ratio < 0.95:
        return untouched
    assignment_teachers, assignment_classes = _assignment_maps(model, names)
    assignments = {assignment for assignment, _session in n_indexes}
    if assignments - assignment_teachers.keys() or assignments - assignment_classes.keys():
        return untouched

    teacher_loads: dict[str, Counter[int]] = defaultdict(Counter)
    for (assignment, session_index), index in n_indexes.items():
        value = hint.get(index, 0)
        if value > 0:
            teacher_loads[assignment_teachers[assignment]][session_index] += value
    ranked_teachers = sorted(
        (
            teacher
            for teacher, loads in teacher_loads.items()
            if len(loads) >= 2 and sum(load <= 2 for load in loads.values()) >= 2
        ),
        key=lambda teacher: (
            -sum(load <= 2 for load in teacher_loads[teacher].values()),
            -len(teacher_loads[teacher]),
            teacher,
        ),
    )
    if not ranked_teachers:
        return untouched
    candidate_teachers = ranked_teachers[:12]
    pairs = list(itertools.combinations(candidate_teachers, 2)) or [tuple(candidate_teachers[:1])]
    neighborhoods: list[tuple[tuple[int, int, str], set[int], set[str]]] = []
    for pair in pairs:
        seed_assignments = {
            assignment
            for assignment, teacher in assignment_teachers.items()
            if teacher in pair
        }
        affected_classes = {
            assignment_classes[assignment]
            for assignment in seed_assignments
        }
        released_assignments = {
            assignment
            for assignment, class_name in assignment_classes.items()
            if class_name in affected_classes
        }
        target_teachers = {
            assignment_teachers[assignment]
            for assignment in released_assignments
        }
        low_load_score = sum(
            sum(load <= 2 for load in teacher_loads[teacher].values())
            for teacher in pair
        )
        neighborhoods.append(
            (
                (len(released_assignments), len(target_teachers), -low_load_score),
                released_assignments,
                target_teachers,
            )
        )
    neighborhoods.sort(key=lambda item: item[0])
    selected_index = max(0, int(step_index)) % min(4, len(neighborhoods))
    _score, released_assignments, target_teachers = neighborhoods[selected_index]
    if not released_assignments or len(released_assignments) >= len(assignments):
        return untouched

    fixed_primary = 0
    for (assignment, _session_index), index in n_indexes.items():
        if assignment in released_assignments:
            continue
        del model.variables[index].domain[:]
        model.variables[index].domain.extend([hint[index], hint[index]])
        fixed_primary += 1
    for (assignment, _session_index, _duration, _start), index in period_indexes.items():
        if assignment in released_assignments or index not in hint:
            continue
        del model.variables[index].domain[:]
        model.variables[index].domain.extend([hint[index], hint[index]])
        fixed_primary += 1

    fixed_periods = {
        (teacher, session_index): set(periods)
        for teacher, session_index, periods in policy.fixed_teacher_periods
    }
    n_by_teacher_session: dict[tuple[str, int], list[int]] = defaultdict(list)
    period_by_teacher_session_period: dict[tuple[str, int, int], list[int]] = defaultdict(list)
    for (assignment, session_index), index in n_indexes.items():
        teacher = assignment_teachers[assignment]
        if teacher in target_teachers:
            n_by_teacher_session[(teacher, session_index)].append(index)
    for (assignment, session_index, duration, start), index in period_indexes.items():
        teacher = assignment_teachers[assignment]
        if teacher not in target_teachers:
            continue
        for period in range(start, start + duration):
            period_by_teacher_session_period[(teacher, session_index, period)].append(index)

    if policy.max_one_period_sessions == 0:
        for teacher in sorted(target_teachers):
            for session_index in range(12):
                z_index = z_indexes.get((teacher, session_index))
                if z_index is None:
                    continue
                coefficients = Counter(
                    {index: 1 for index in n_by_teacher_session.get((teacher, session_index), [])}
                )
                coefficients[z_index] -= 2
                fixed_load = len(fixed_periods.get((teacher, session_index), set()))
                _append_linear_constraint(model, coefficients, -fixed_load)

    if policy.max_gap2_sessions == 0:
        for teacher in sorted(target_teachers):
            for session_index in range(12):
                fixed = fixed_periods.get((teacher, session_index), set())
                for first in range(1, 6):
                    for last in range(first + 3, 6):
                        required_inside = last - first - 2
                        coefficients: Counter[int] = Counter()
                        fixed_inside = 0
                        for period in range(first + 1, last):
                            fixed_inside += int(period in fixed)
                            coefficients.update(
                                {
                                    index: 1
                                    for index in period_by_teacher_session_period.get(
                                        (teacher, session_index, period),
                                        [],
                                    )
                                }
                            )
                        coefficients.update(
                            {
                                index: -required_inside
                                for index in period_by_teacher_session_period.get(
                                    (teacher, session_index, first),
                                    [],
                                )
                            }
                        )
                        coefficients.update(
                            {
                                index: -required_inside
                                for index in period_by_teacher_session_period.get(
                                    (teacher, session_index, last),
                                    [],
                                )
                            }
                        )
                        lower_bound = (
                            required_inside
                            * (int(first in fixed) + int(last in fixed) - 1)
                            - fixed_inside
                        )
                        _append_linear_constraint(model, coefficients, lower_bound)

    if policy.max_teacher_sessions is not None:
        _append_linear_constraint(
            model,
            {index: 1 for index in z_indexes.values()},
            _INT64_MIN,
            int(policy.max_teacher_sessions),
        )

    # Derived z/u/c/d hints in the production model are individually sensible
    # but not jointly fixable. Keep only the primary incumbent decisions; this
    # is a complete feasible warm start for the LNS and avoids hint repair work.
    retained_hints = sorted(
        (index, value)
        for index, value in hint.items()
        if index in primary_indexes
    )
    del model.solution_hint.vars[:]
    del model.solution_hint.values[:]
    for index, value in retained_hints:
        model.solution_hint.vars.append(index)
        model.solution_hint.values.append(value)
    parameters.fix_variables_to_their_hinted_value = False
    parameters.repair_hint = False
    parameters.cp_model_presolve = True
    return ExternalCpSatPreparedModel(
        model.SerializeToString(),
        parameters.SerializeToString(),
        applied=True,
        fixed_primary_variables=fixed_primary,
        released_assignments=len(released_assignments),
        target_teachers=len(target_teachers),
    )


def solve_cp_sat_model(
    model: Any,
    solver: Any,
    callback: Any = None,
    *,
    external_solver: ExternalCpSatSolver | None = None,
) -> Any:
    """Solve locally or hand the exact model to the active remote runtime."""

    runtime = external_solver if external_solver is not None else active_external_solver()
    if runtime is None:
        return solver.Solve(model, callback)
    return solve_with_external_runtime(model, solver, runtime)


class ExternalCpSatProtocolError(RuntimeError):
    """Raised when an external CP-SAT runtime returns an invalid response."""


class ExternalCpSatUnusableResponse(BaseException):
    """Abort an external run that produced no materializable solution.

    This deliberately bypasses best-effort ``except Exception`` recovery
    lanes. Otherwise an UNKNOWN Browser solve can be replaced by a complete
    but much worse fallback and incorrectly published as Agent work.
    """

    def __init__(self, status: int, status_name: str) -> None:
        super().__init__(
            f"External CP-SAT returned a non-feasible status: {status_name}"
        )
        self.status = int(status)
        self.status_name = str(status_name)


def serialize_cp_model(model: Any) -> bytes:
    """Serialize the Python model wrapper into the stable CP-SAT wire proto."""

    export = getattr(model, "export_to_file", None)
    if callable(export):
        file_descriptor, raw_path = tempfile.mkstemp(prefix="tkb-cpsat-", suffix=".bin")
        os.close(file_descriptor)
        path = Path(raw_path)
        try:
            if export(str(path)) is not True:
                raise ExternalCpSatProtocolError("CP-SAT model binary export failed")
            raw = path.read_bytes()
            if not raw:
                raise ExternalCpSatProtocolError("CP-SAT model binary export was empty")
            return raw
        finally:
            try:
                path.unlink()
            except OSError:
                pass

    # Compatibility fallback for older OR-Tools Python wrappers.
    proto = cp_model_pb2.CpModelProto()
    text_format.Parse(str(model.proto), proto)
    return proto.SerializeToString()


def serialize_sat_parameters(parameters: Any) -> bytes:
    """Serialize Python CP-SAT parameters for the native or WASM runtime."""

    proto = sat_parameters_pb2.SatParameters()
    text_format.Parse(str(parameters), proto)
    return proto.SerializeToString()


def external_model_digest(model_bytes: bytes, parameter_bytes: bytes) -> str:
    """Digest the model so replay cannot install a stale solution vector.

    Parameters are intentionally excluded. A server watchdog may shorten the
    next step's time limit while the variable/constraint model stays identical;
    a response is compatible with that rebuilt model regardless of search
    budget or worker count.
    """

    digest = hashlib.sha256()
    digest.update(b"tkb-external-cp-sat-model-v1\0")
    digest.update(len(model_bytes).to_bytes(8, "big"))
    digest.update(model_bytes)
    return digest.hexdigest()


def install_solver_response(
    solver: Any,
    response_bytes: bytes | bytearray | memoryview,
    *,
    expected_variables: int | None = None,
) -> Any:
    """Install a wire CpSolverResponse into the regular Python materializer.

    OR-Tools' Python wrapper does not expose a binary parser on CpSolver, while
    the browser runtime returns the canonical protobuf bytes. Converting via
    protobuf text keeps all response fields and lets existing Value()/metrics
    code materialize the externally solved timetable without a second solve.
    """

    raw = bytes(response_bytes)
    if not raw:
        raise ExternalCpSatProtocolError("External CP-SAT returned an empty response")

    response_proto = cp_model_pb2.CpSolverResponse()
    try:
        consumed = response_proto.ParseFromString(raw)
    except Exception as exc:
        raise ExternalCpSatProtocolError(
            "External CP-SAT returned an invalid CpSolverResponse"
        ) from exc
    if consumed != len(raw):
        raise ExternalCpSatProtocolError(
            "External CP-SAT response contains trailing bytes"
        )

    status = int(response_proto.status)
    feasible_statuses = {
        int(cp_model_pb2.CpSolverStatus.FEASIBLE),
        int(cp_model_pb2.CpSolverStatus.OPTIMAL),
    }
    if status not in feasible_statuses:
        try:
            status_name = cp_model_pb2.CpSolverStatus.Name(status)
        except ValueError:
            status_name = str(status)
        raise ExternalCpSatUnusableResponse(status, status_name)
    if (
        expected_variables is not None
        and len(response_proto.solution) != max(0, int(expected_variables))
    ):
        raise ExternalCpSatProtocolError(
            "External CP-SAT solution vector does not match the model"
        )

    native_response = cp_model_helper.CpSolverResponse()
    try:
        native_response.parse_text_format(text_format.MessageToString(response_proto))
    except Exception as exc:
        raise ExternalCpSatProtocolError(
            "External CP-SAT response is incompatible with this OR-Tools runtime"
        ) from exc

    # CpSolver stores the response privately, but all public materialization
    # APIs read this one field. Keep the compatibility shim isolated here.
    setattr(solver, "_CpSolver__response", native_response)
    return native_response.status


def solve_with_external_runtime(
    model: Any,
    solver: Any,
    external_solver: ExternalCpSatSolver,
) -> Any:
    """Solve one Python-built model in an external native/WASM CP-SAT runtime."""

    model_bytes = serialize_cp_model(model)
    parameter_bytes = serialize_sat_parameters(solver.parameters)
    prepared = prepare_external_cp_sat_lns_model(
        model_bytes,
        parameter_bytes,
        _ACTIVE_EXTERNAL_LNS_POLICY.get(),
        step_index=max(0, int(getattr(external_solver, "calls", 0) or 0)),
    )
    model_bytes = prepared.model_bytes
    parameter_bytes = prepared.parameter_bytes
    try:
        response_bytes = external_solver(model_bytes, parameter_bytes)
    except ExternalCpSatProtocolError:
        raise
    except Exception as exc:
        raise ExternalCpSatProtocolError("External CP-SAT execution failed") from exc
    return install_solver_response(
        solver,
        response_bytes,
        expected_variables=len(model.proto.variables),
    )


__all__ = [
    "ExternalCpSatPending",
    "EXTERNAL_HIGHS_MODEL_MAGIC",
    "EXTERNAL_MODEL_PLAN_VERSION",
    "ExternalCpSatLnsPolicy",
    "ExternalCpSatPreparedModel",
    "ExternalCpSatProtocolError",
    "ExternalCpSatUnusableResponse",
    "ExternalCpSatSolver",
    "active_external_solver",
    "external_model_digest",
    "external_cp_sat_lns_policy_from_request",
    "external_solver_scope",
    "install_solver_response",
    "serialize_cp_model",
    "serialize_sat_parameters",
    "prepare_external_cp_sat_lns_model",
    "solve_cp_sat_model",
    "solve_with_external_runtime",
]
