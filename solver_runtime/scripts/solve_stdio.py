from __future__ import annotations

import base64
import binascii
import json
import os
import sys
import threading
import time
import traceback
from pathlib import Path


sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

STDIO_PROTOCOL = "tkb-reference-solver-stdio-v1"
PROGRESS_PROTOCOL = "tkb-reference-solver-progress-v1"
PROGRESS_PREFIX = "@@TKB_PROGRESS@@"
_PROTOCOL_STDOUT = None
_PROGRESS_STARTED = time.monotonic()
_PROGRESS_SEQUENCE = 0
_PROGRESS_LOCK = threading.Lock()


def _install_stdout_protocol_guard() -> None:
    """Reserve the original stdout pipe and quarantine all other output."""

    global _PROTOCOL_STDOUT
    if _PROTOCOL_STDOUT is not None:
        return

    # HiGHS and other native libraries can write directly to file descriptor 1,
    # bypassing Python redirect_stdout. Keep a private duplicate for the single
    # JSON response, then route fd-level diagnostics to the drained stderr pipe.
    sys.stdout.flush()
    protocol_fd = os.dup(sys.stdout.fileno())
    try:
        os.set_inheritable(protocol_fd, False)
        os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
        _PROTOCOL_STDOUT = os.fdopen(protocol_fd, "wb", buffering=0)
    except Exception:
        os.close(protocol_fd)
        raise


def _write_protocol_value(value: object) -> None:
    encoded = (json.dumps(value, ensure_ascii=False, default=str) + "\n").encode("utf-8")
    if _PROTOCOL_STDOUT is not None:
        _PROTOCOL_STDOUT.write(encoded)
        _PROTOCOL_STDOUT.flush()
        return
    sys.stdout.write(encoded.decode("utf-8"))
    sys.stdout.flush()


def emit_progress(event: dict) -> None:
    """Write one live progress frame to stderr without touching stdout.

    Progress is deliberately best-effort: a closed diagnostics pipe must never
    fail, cancel, or otherwise change the solver result contract.
    """

    if not isinstance(event, dict):
        return
    global _PROGRESS_SEQUENCE
    try:
        with _PROGRESS_LOCK:
            _PROGRESS_SEQUENCE += 1
            payload = dict(event)
            payload["protocol"] = PROGRESS_PROTOCOL
            payload["sequence"] = _PROGRESS_SEQUENCE
            payload["elapsedMs"] = max(0, int((time.monotonic() - _PROGRESS_STARTED) * 1000))
            payload["emittedAtMs"] = int(time.time() * 1000)
            sys.stderr.write(
                PROGRESS_PREFIX
                + json.dumps(payload, ensure_ascii=False, default=str, separators=(",", ":"))
                + "\n"
            )
            sys.stderr.flush()
    except Exception:
        pass


if __name__ == "__main__":
    # Install this before importing the solver stack so import-time and native
    # diagnostics can never corrupt the stdout wire protocol.
    _install_stdout_protocol_guard()
    emit_progress(
        {
            "stage": "runtime:loading",
            "message": "Dang khoi dong bo may sap xep",
        }
    )

from tkb_new.adapter import (  # noqa: E402
    _trim_context_to_available_slots,
    _unassigned_from_shortfall,
    build_payload,
    build_school_data_from_ui,
    solve_from_ui_data,
    validate_candidate_payload,
)
from tkb_new.fixture import build_ui_fixture_from_workbooks  # noqa: E402
from tkb_optimizer_ref.period_milp import PeriodAllocationError  # noqa: E402
from tkb_optimizer_ref.external_cp_sat import (  # noqa: E402
    EXTERNAL_HIGHS_MODEL_MAGIC,
    EXTERNAL_MODEL_PLAN_VERSION,
    ExternalCpSatPending,
    ExternalCpSatProtocolError,
    ExternalCpSatUnusableResponse,
    external_cp_sat_lns_policy_from_request,
    external_model_digest,
    external_solver_scope,
)


CURRENT_REQUEST_BODY: bytes | None = None
MAX_EXTERNAL_CP_SAT_STEPS = 64
MAX_EXTERNAL_CP_SAT_MODEL_BYTES = 64 * 1024 * 1024
MAX_EXTERNAL_CP_SAT_PARAMETER_BYTES = 1024 * 1024
MAX_EXTERNAL_CP_SAT_RESPONSE_BYTES = 32 * 1024 * 1024
MAX_EXTERNAL_CP_SAT_STREAM_REQUEST_BYTES = 64 * 1024 * 1024
MAX_EXTERNAL_CP_SAT_STREAM_RESPONSE_LINE_BYTES = (
    ((MAX_EXTERNAL_CP_SAT_RESPONSE_BYTES + 2) // 3) * 4 + 4096
)


def _external_cp_sat_pending(
    model_bytes: bytes,
    parameter_bytes: bytes,
    index: int,
) -> ExternalCpSatPending:
    if not model_bytes or len(model_bytes) > MAX_EXTERNAL_CP_SAT_MODEL_BYTES:
        raise ExternalCpSatProtocolError("External CP-SAT model size is invalid")
    if len(parameter_bytes) > MAX_EXTERNAL_CP_SAT_PARAMETER_BYTES:
        raise ExternalCpSatProtocolError("External CP-SAT parameters are too large")
    if index >= MAX_EXTERNAL_CP_SAT_STEPS:
        raise ExternalCpSatProtocolError("External CP-SAT step limit exceeded")

    digest = external_model_digest(model_bytes, parameter_bytes)
    is_highs_model = model_bytes.startswith(EXTERNAL_HIGHS_MODEL_MAGIC)
    return ExternalCpSatPending(
        (
            model_bytes[len(EXTERNAL_HIGHS_MODEL_MAGIC) :]
            if is_highs_model
            else model_bytes
        ),
        parameter_bytes,
        index,
        digest,
        kind=("external_highs_model" if is_highs_model else "external_cp_sat_model"),
        runtime=(
            "highs-wasm-1.15-lp-v1"
            if is_highs_model
            else "ortools-cp-sat-9.15-wire-v1"
        ),
    )


def _decode_external_cp_sat_response(
    record: object,
    index: int,
    digest: str,
    *,
    require_step_index: bool,
) -> bytes:
    if not isinstance(record, dict):
        if not require_step_index:
            raise ExternalCpSatProtocolError(
                f"External CP-SAT response {index} does not match the rebuilt model"
            )
        raise ExternalCpSatProtocolError(
            f"External CP-SAT response {index} is not an object"
        )
    if require_step_index:
        step_index = record.get("stepIndex")
        if (
            not isinstance(step_index, int)
            or isinstance(step_index, bool)
            or step_index != index
        ):
            raise ExternalCpSatProtocolError(
                f"External CP-SAT response {index} has the wrong step index"
            )
    if record.get("modelDigest") != digest:
        raise ExternalCpSatProtocolError(
            f"External CP-SAT response {index} does not match the "
            f"{'emitted' if require_step_index else 'rebuilt'} model"
        )
    encoded = record.get("responseBase64")
    if not isinstance(encoded, str) or not encoded:
        raise ExternalCpSatProtocolError(
            f"External CP-SAT response {index} is empty"
        )
    try:
        response = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ExternalCpSatProtocolError(
            f"External CP-SAT response {index} is not valid base64"
        ) from exc
    if not response or len(response) > MAX_EXTERNAL_CP_SAT_RESPONSE_BYTES:
        raise ExternalCpSatProtocolError(
            f"External CP-SAT response {index} size is invalid"
        )
    return response


class _ReplayExternalCpSatSolver:
    """Replay accepted responses, then yield the next exact CP-SAT model."""

    def __init__(self, responses: object) -> None:
        if not isinstance(responses, list) or len(responses) > MAX_EXTERNAL_CP_SAT_STEPS:
            raise ExternalCpSatProtocolError("External CP-SAT response list is invalid")
        self._responses = responses
        self.calls = 0

    def __call__(self, model_bytes: bytes, parameter_bytes: bytes) -> bytes:
        index = self.calls
        self.calls += 1
        pending = _external_cp_sat_pending(model_bytes, parameter_bytes, index)
        if index >= len(self._responses):
            raise pending
        return _decode_external_cp_sat_response(
            self._responses[index],
            index,
            pending.digest,
            require_step_index=False,
        )


class _StreamingExternalCpSatSolver:
    """Exchange models and responses without rebuilding the Python solve."""

    def __init__(self, input_stream=None, write_pending=None) -> None:
        self._input_stream = input_stream if input_stream is not None else sys.stdin.buffer
        self._write_pending = (
            write_pending if write_pending is not None else _write_external_cp_sat_pending
        )
        self.calls = 0

    def __call__(self, model_bytes: bytes, parameter_bytes: bytes) -> bytes:
        index = self.calls
        self.calls += 1
        pending = _external_cp_sat_pending(model_bytes, parameter_bytes, index)
        self._write_pending(pending)

        raw = self._input_stream.readline(MAX_EXTERNAL_CP_SAT_STREAM_RESPONSE_LINE_BYTES + 1)
        if not raw:
            raise ExternalCpSatProtocolError(
                f"External CP-SAT response stream closed at step {index}"
            )
        if not isinstance(raw, (bytes, bytearray)):
            raise ExternalCpSatProtocolError("External CP-SAT response stream is not binary")
        if len(raw) > MAX_EXTERNAL_CP_SAT_STREAM_RESPONSE_LINE_BYTES:
            raise ExternalCpSatProtocolError(
                f"External CP-SAT response {index} line is too large"
            )
        try:
            record = json.loads(bytes(raw).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ExternalCpSatProtocolError(
                f"External CP-SAT response {index} is not valid JSON"
            ) from exc
        return _decode_external_cp_sat_response(
            record,
            index,
            pending.digest,
            require_step_index=True,
        )


def _write_external_cp_sat_pending(pending: ExternalCpSatPending) -> None:
    _write_protocol_value(
        {
            "protocol": STDIO_PROTOCOL,
            "status": 209,
            "payload": {
                "ok": True,
                "kind": pending.kind,
                "stepIndex": pending.index,
                "modelDigest": pending.digest,
                "modelBase64": base64.b64encode(pending.model_bytes).decode("ascii"),
                "parameterBase64": base64.b64encode(pending.parameter_bytes).decode("ascii"),
                "modelBytes": len(pending.model_bytes),
                "parameterBytes": len(pending.parameter_bytes),
                "runtime": pending.runtime,
                "modelPlanVersion": pending.model_plan_version,
            },
        }
    )
    emit_progress(
        {
            "stage": "external_cp_sat:model_ready",
            "message": "Da chuyen mo hinh CP-SAT sang Agent",
            "stepIndex": pending.index,
            "modelBytes": len(pending.model_bytes),
        }
    )


def _setting_enabled(settings: dict | None, key: str, *, default: bool) -> bool:
    if not isinstance(settings, dict) or key not in settings:
        return bool(default)
    return str(settings.get(key)).strip().casefold() not in {"0", "false", "off", "no"}


def _metric_number(payload: dict, key: str, default: int = 0) -> int:
    metrics = payload.get("metrics") if isinstance(payload.get("metrics"), dict) else {}
    value = metrics.get(key)
    try:
        return int(value)
    except (TypeError, ValueError):
        return int(default)


def _payload_needs_artifact(payload: dict, status: int) -> bool:
    if status >= 400:
        return True
    metrics = payload.get("metrics") if isinstance(payload.get("metrics"), dict) else {}
    solver = payload.get("solver") if isinstance(payload.get("solver"), dict) else {}
    runtime = solver.get("runtime_settings") if isinstance(solver.get("runtime_settings"), dict) else {}
    teacher_opt = solver.get("teacher_session_optimization") if isinstance(solver.get("teacher_session_optimization"), dict) else None
    mode = str(metrics.get("auto_sort_mode") or runtime.get("auto_sort_mode") or "").strip().lower()
    if mode == "teacher_session_opt" or teacher_opt is not None:
        return True
    scheduled = _metric_number(payload, "scheduled_periods", 0)
    expected = _metric_number(payload, "expected_periods", 0)
    unassigned = _metric_number(payload, "unassigned_periods", 0)
    violations = _metric_number(payload, "app_constraint_violation_count", 0)
    best_effort = payload.get("bestEffort") is True or metrics.get("best_effort") is True
    hard_ok = metrics.get("hard_ok")
    return best_effort or unassigned > 0 or violations > 0 or hard_ok is False or (expected > 0 and scheduled < expected)


def _save_solve_artifacts(payload: dict, status: int) -> None:
    if not CURRENT_REQUEST_BODY or not _payload_needs_artifact(payload, status):
        return
    if str(os.environ.get("TKB_NO_LOGS", "0")).casefold() in {"1", "true", "on", "yes"}:
        return
    if str(os.environ.get("TKB_SAVE_SOLVE_ARTIFACTS", "1")).casefold() in {"0", "false", "off", "no"}:
        return
    try:
        log_dir = ROOT / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        stamp = int(time.time() * 1000)
        scheduled = _metric_number(payload, "scheduled_periods", 0)
        expected = _metric_number(payload, "expected_periods", 0)
        prefix = f"solve-py-{stamp}-status{status}-{scheduled}of{expected}"
        (log_dir / f"{prefix}-request.json").write_bytes(CURRENT_REQUEST_BODY)
        (log_dir / f"{prefix}-response.json").write_text(
            json.dumps(payload, ensure_ascii=False, indent=2, default=str),
            encoding="utf-8",
        )
    except Exception:
        pass


def write_json(payload: dict, status: int = 200) -> None:
    # The stdout wrapper is the authoritative result. Flush it before optional
    # artifact logging so slow storage can never turn a completed timetable
    # into a parent-process watchdog timeout.
    _write_protocol_value(
        {
            "protocol": STDIO_PROTOCOL,
            "status": status,
            "payload": payload,
        }
    )
    emit_progress(
        {
            "stage": "result:complete" if status < 400 else "result:error",
            "message": "Hoan tat sap xep TKB" if status < 400 else "Khong the hoan tat sap xep TKB",
            "status": int(status),
        }
    )
    _save_solve_artifacts(payload, status)


def _safe_accounted_capacity_partial(payload: dict) -> bool:
    """Return true when only the explicitly unassigned remainder is incomplete.

    Global ``hard_ok`` is intentionally false when solver-unassigned periods
    exist.  Publication therefore relies on the independent placement gates,
    exact demand accounting, and zero concrete conflicts/violations.
    """

    metrics = payload.get("metrics") if isinstance(payload.get("metrics"), dict) else {}
    scheduled = _metric_number(payload, "scheduled_periods", 0)
    expected = _metric_number(payload, "expected_periods", 0)
    unassigned = _metric_number(payload, "unassigned_periods", 0)
    capacity_unassigned = _metric_number(payload, "capacity_unassigned_periods", 0)
    solver_unassigned = _metric_number(payload, "solver_unassigned_periods", 0)
    if (
        expected <= 0
        or scheduled <= 0
        or scheduled >= expected
        or unassigned <= 0
        or solver_unassigned < 0
        or capacity_unassigned + solver_unassigned != unassigned
        or scheduled + unassigned != expected
        or metrics.get("accounting_ok") is not True
        or metrics.get("placement_hard_ok") is not True
        or metrics.get("placement_core_hard_ok") is not True
    ):
        return False
    for key in (
        "class_slot_conflicts",
        "teacher_slot_conflicts",
        "room_slot_conflicts",
        "app_constraint_violation_count",
    ):
        if _metric_number(payload, key, 0) != 0:
            return False
    if isinstance(metrics.get("app_constraint_violations"), list) and metrics[
        "app_constraint_violations"
    ]:
        return False
    validation = payload.get("validation")
    if isinstance(validation, dict) and isinstance(validation.get("violations"), list):
        if validation["violations"]:
            return False
    lessons = payload.get("lessons")
    if isinstance(lessons, list) and len(lessons) != scheduled:
        return False
    unassigned_lessons = payload.get("unassignedLessons")
    if isinstance(unassigned_lessons, list):
        item_total = 0
        item_capacity = 0
        for item in unassigned_lessons:
            if not isinstance(item, dict):
                return False
            try:
                periods = int(item.get("periods", item.get("count", 0)))
            except (TypeError, ValueError):
                return False
            if periods <= 0:
                return False
            item_total += periods
            if str(item.get("reason") or "").strip() == "not_enough_available_slots":
                item_capacity += periods
        if item_total != unassigned or item_capacity != capacity_unassigned:
            return False
        if item_total - item_capacity != solver_unassigned:
            return False
    return True


def _finalize_solve_status(payload: dict, settings: dict | None) -> int:
    """Enforce the HTTP-style contract for incomplete solver results."""

    metrics = payload.get("metrics") if isinstance(payload.get("metrics"), dict) else {}
    scheduled = _metric_number(payload, "scheduled_periods", 0)
    expected = _metric_number(payload, "expected_periods", 0)
    capacity_unassigned = _metric_number(payload, "capacity_unassigned_periods", 0)
    explicit_solver_unassigned = _metric_number(payload, "solver_unassigned_periods", 0)
    # Older/direct fallback payloads may omit solver_unassigned_periods.  Infer
    # only the portion that is not explicitly explained by physical capacity;
    # capacity-only shortfall keeps its established best-possible semantics.
    unaccounted_shortfall = max(0, expected - scheduled - capacity_unassigned)
    solver_unassigned = max(explicit_solver_unassigned, unaccounted_shortfall)
    if solver_unassigned > explicit_solver_unassigned:
        metrics["solver_unassigned_periods"] = solver_unassigned
    zero_schedule = expected > 0 and scheduled <= 0
    require_complete = _setting_enabled(settings, "require_complete_schedule", default=True)
    if zero_schedule or solver_unassigned > 0:
        payload["ok"] = False
        metrics["hard_ok"] = False
        metrics["core_hard_ok"] = False
    if (
        not zero_schedule
        and solver_unassigned > 0
        and _safe_accounted_capacity_partial(payload)
    ):
        # A capacity proof means a complete timetable is impossible under the
        # current OFF/fixed constraints. Keep every independently validated
        # placement and expose the exact remainder through ``Chua phan``.
        payload["ok"] = True
        payload["bestEffort"] = True
        payload["kind"] = "best_effort_unassigned_accepted"
        payload["error"] = ""
        metrics["best_effort"] = True
        return 200
    if not zero_schedule and not (require_complete and solver_unassigned > 0):
        return 200

    payload["kind"] = (
        "no_complete_schedule_before_deadline"
        if payload.get("deadlineExhausted") is True or metrics.get("deadline_exhausted") is True
        else "incomplete_schedule"
    )
    if zero_schedule:
        payload["error"] = (
            "Backend chua tim duoc bat ky tiet hoc nao trong ngan sach thoi gian; "
            "ket qua all-unassigned da bi tu choi. Hay thu preset Max hoac noi bot rang buoc."
        )
    else:
        payload["error"] = (
            f"Backend con {solver_unassigned} tiet chua xep trong ngan sach thoi gian, "
            "nen khong tra ket qua nhu mot lich hoan chinh."
        )
    return 422


def period_allocation_error_payload(
    ui_data: dict,
    settings: dict | None,
    exc: PeriodAllocationError,
) -> dict:
    """Return a valid UI payload when period placement escapes with partial lessons."""

    settings = settings or {}
    original_ctx = build_school_data_from_ui(ui_data)
    ctx, capacity_unassigned = _trim_context_to_available_slots(original_ctx, original_ctx.rules, settings)
    lessons = list(exc.partial_lessons or [])
    solver_unassigned = _unassigned_from_shortfall(
        ctx,
        lessons,
        reason="period_allocation_best_effort",
        message=(
            "Chua xep duoc mot so tiet sau khi ap dung tiet nghi/rang buoc; "
            "da tra lich best-effort va dua phan con lai vao tiet chua phan."
        ),
    )
    solver_metrics = {
        "session_solver": {
            "solver": "period_allocation_error_best_effort",
            "status_name": "PARTIAL",
            "fallback_reason": "escaped_period_allocation_error_returned_best_effort",
            "requested_max_teacher_sessions": settings.get("max_teacher_sessions"),
            "effective_max_teacher_sessions": settings.get("max_teacher_sessions"),
        },
        "period_solver": {
            "solver": "period_allocation_error_best_effort",
            "already_placed": False,
            "lesson_count": len(lessons),
            "best_effort_failed_session_count": 1,
            "best_effort_failed_sessions": [exc.to_dict()],
        },
        "runtime_settings": {
            "overall_time_limit_seconds": settings.get("overall_time_limit_seconds", 60),
            "best_effort_on_timeout": settings.get("best_effort_on_timeout", True),
            "fallback_after_period_allocation_error": True,
        },
    }
    return build_payload(
        ctx,
        lessons,
        solver_metrics,
        original_ctx.rules,
        unassigned_lessons=[*capacity_unassigned, *solver_unassigned],
        original_ctx=original_ctx,
        best_effort=True,
        deadline_exhausted=False,
        optimization_skipped_reason=(
            "period allocation failed after rest-slot changes; returned best-effort instead of error"
        ),
    )


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else "solve"
    ui_data = None
    settings = {}
    try:
        if mode == "fixture":
            _write_protocol_value(
                build_ui_fixture_from_workbooks(ROOT / "web", include_fixed_off_excel=True)
            )
            return 0
        if mode == "sample":
            write_json({"ok": True, "data": build_ui_fixture_from_workbooks(ROOT / "web", include_fixed_off_excel=True)})
            return 0

        emit_progress(
            {
                "stage": "request:reading",
                "message": "Dang doc du lieu sap xep",
            }
        )
        if mode == "external-cp-sat-stream":
            raw = sys.stdin.buffer.readline(MAX_EXTERNAL_CP_SAT_STREAM_REQUEST_BYTES + 1)
        else:
            raw = sys.stdin.buffer.read()
        global CURRENT_REQUEST_BODY
        CURRENT_REQUEST_BODY = raw
        if not raw:
            write_json({"error": "Request body trong."}, status=400)
            return 0
        if (
            mode == "external-cp-sat-stream"
            and len(raw) > MAX_EXTERNAL_CP_SAT_STREAM_REQUEST_BYTES
        ):
            CURRENT_REQUEST_BODY = None
            write_json(
                {
                    "ok": False,
                    "kind": "external_cp_sat_request_invalid",
                    "error": "Request CP-SAT cua Agent vuot qua gioi han kich thuoc.",
                },
                status=413,
            )
            return 0
        request = json.loads(raw.decode("utf-8"))
        if not isinstance(request, dict):
            write_json({"error": "JSON payload phai la object."}, status=400)
            return 0
        if mode in {"external-cp-sat-step", "external-cp-sat-stream"}:
            solver_request = request.get("request")
            if not isinstance(solver_request, dict):
                CURRENT_REQUEST_BODY = None
                write_json(
                    {
                        "ok": False,
                        "kind": "external_cp_sat_request_invalid",
                        "error": "Thieu request de dung mo hinh CP-SAT cho Agent.",
                    },
                    status=400,
                )
                return 0
            external_ui_data = solver_request.get("data")
            external_settings = solver_request.get("settings")
            if not isinstance(external_ui_data, dict) or not isinstance(external_settings, dict):
                CURRENT_REQUEST_BODY = None
                write_json(
                    {
                        "ok": False,
                        "kind": "external_cp_sat_request_invalid",
                        "error": "Request CP-SAT cua Agent khong co data/settings hop le.",
                    },
                    status=400,
                )
                return 0
            external_solver = (
                _StreamingExternalCpSatSolver()
                if mode == "external-cp-sat-stream"
                else _ReplayExternalCpSatSolver(request.get("responses", []))
            )
            lns_policy = external_cp_sat_lns_policy_from_request(
                external_ui_data,
                external_settings,
            )
            CURRENT_REQUEST_BODY = None
            try:
                with external_solver_scope(external_solver, lns_policy=lns_policy):
                    result = solve_from_ui_data(
                        external_ui_data,
                        external_settings,
                        progress=emit_progress,
                    )
            except ExternalCpSatPending as pending:
                _write_external_cp_sat_pending(pending)
                return 0
            except ExternalCpSatProtocolError as protocol_error:
                if mode != "external-cp-sat-stream":
                    raise
                write_json(
                    {
                        "ok": False,
                        "kind": "external_cp_sat_protocol_error",
                        "error": str(protocol_error),
                    },
                    status=400,
                )
                return 0
            except ExternalCpSatUnusableResponse as unusable:
                write_json(
                    {
                        "ok": False,
                        "kind": "external_cp_sat_no_solution",
                        "error": str(unusable),
                        "cpSatStatus": unusable.status,
                        "cpSatStatusName": unusable.status_name,
                    },
                    status=422,
                )
                return 0
            result.setdefault("solver", {}).setdefault("runtime_settings", {}).update(
                {
                    "execution_runtime": "browser_cp_sat_wasm",
                    "browser_full_reference_refine": (
                        external_settings.get("browser_wasm_full_reference_refine") is True
                    ),
                    "external_cp_sat_steps": external_solver.calls,
                    "external_model_plan_version": EXTERNAL_MODEL_PLAN_VERSION,
                }
            )
            write_json(
                result,
                status=_finalize_solve_status(result, external_settings),
            )
            return 0
        if mode == "validate-candidate":
            solver_request = request.get("request")
            candidate = request.get("candidate")
            if not isinstance(solver_request, dict) or not isinstance(candidate, dict):
                CURRENT_REQUEST_BODY = None
                write_json({"ok": False, "error": "Thieu request/candidate de xac thuc."}, status=400)
                return 0
            candidate_data = solver_request.get("data")
            if not isinstance(candidate_data, dict):
                CURRENT_REQUEST_BODY = None
                write_json({"ok": False, "error": "Request khong co DATA hop le."}, status=400)
                return 0
            validation = validate_candidate_payload(candidate_data, candidate)
            CURRENT_REQUEST_BODY = None
            write_json(validation, status=200 if validation.get("ok") is True else 422)
            return 0
        ui_data = request.get("data")
        if not isinstance(ui_data, dict):
            write_json({"error": "Thieu truong data chua DATA cua UI."}, status=400)
            return 0
        raw_settings = request.get("settings")
        if raw_settings is not None and not isinstance(raw_settings, dict):
            write_json({"error": "Truong settings phai la object."}, status=400)
            return 0
        settings = raw_settings or {}
        emit_progress(
            {
                "stage": "solver:starting",
                "message": "Da nhan du lieu, bat dau sap xep",
            }
        )
        # 19/08: hai thuat toan bo sung, CHON THEO NUT tren UI (settings.engine).
        #   engine = "cherry" | "v3"     -> Cherry  (solver_runtime/src/tkb_engine_v3, log: Cherry/logs)
        #   engine = "flash"  | "cpsat"  -> Flash   (tkb_optimizer_ref/unified_cpsat_solver, log: Flash/logs)
        # Khong dat gia tri nao thi giu NGUYEN pipeline cu (nut Sap xep / Toi uu).
        engine_choice = (
            os.environ.get("TKB_ENGINE", "").strip().casefold()
            or str(settings.get("engine") or "").strip().casefold()
        )
        if engine_choice in {"cherry", "v3", "engine_v3"}:
            try:
                from tkb_engine_v3.entry import solve_from_ui_data_v3

                result = solve_from_ui_data_v3(ui_data, settings, progress=emit_progress)
            except Exception as exc:
                emit_progress(
                    {
                        "stage": "solver:fallback",
                        "message": "Cherry gap loi (%s); dung bo giai mac dinh"
                        % type(exc).__name__,
                    }
                )
                if os.environ.get("TKB_DEBUG_TRACE") == "1":
                    traceback.print_exc(file=sys.stderr)
                result = solve_from_ui_data(ui_data, settings, progress=emit_progress)
                result.setdefault("solver", {}).setdefault("runtime_settings", {})[
                    "cherry_fallback_reason"
                ] = repr(exc)[:300]
        elif engine_choice in {"flash", "cpsat", "unified", "unified_cpsat", "lightning"}:
            try:
                from tkb_engine_v3.cpsat_modes import solve_unified_cpsat

                result = solve_unified_cpsat(ui_data, settings, progress=emit_progress)
            except Exception as exc:
                emit_progress(
                    {
                        "stage": "solver:fallback",
                        "message": "Flash gap loi (%s); dung bo giai mac dinh"
                        % type(exc).__name__,
                    }
                )
                if os.environ.get("TKB_DEBUG_TRACE") == "1":
                    traceback.print_exc(file=sys.stderr)
                result = solve_from_ui_data(ui_data, settings, progress=emit_progress)
                result.setdefault("solver", {}).setdefault("runtime_settings", {})[
                    "flash_fallback_reason"
                ] = repr(exc)[:300]
        else:
            result = solve_from_ui_data(ui_data, settings, progress=emit_progress)

        emit_progress(
            {
                "stage": "result:finalizing",
                "message": "Dang kiem tra va dong goi ket qua",
            }
        )
        write_json(result, status=_finalize_solve_status(result, settings))
        return 0
    except ValueError as exc:
        write_json({"error": str(exc)}, status=400)
        return 0
    except PeriodAllocationError as exc:
        best_effort_enabled = str((settings or {}).get("best_effort_on_timeout", "1")).casefold() not in {
            "0",
            "false",
            "off",
            "no",
        }
        if best_effort_enabled and isinstance(ui_data, dict):
            try:
                payload = period_allocation_error_payload(ui_data, settings, exc)
                if os.environ.get("TKB_DEBUG_TRACE") == "1":
                    payload.setdefault("solver", {}).setdefault("period_solver", {})["trace"] = traceback.format_exc(limit=12)
                write_json(payload, status=_finalize_solve_status(payload, settings))
                return 0
            except Exception as fallback_exc:  # noqa: BLE001 - preserve a structured error if fallback also breaks.
                payload = {
                    "kind": "period_allocation_best_effort_failed",
                    "error": (
                        "Khong dung duoc fallback best-effort sau loi xep tiet. "
                        "Hay gui file du lieu/rang buoc de kiem tra tiep."
                    ),
                    "detail": exc.to_dict(),
                    "fallback_error": str(fallback_exc),
                }
                if os.environ.get("TKB_DEBUG_TRACE") == "1":
                    payload["trace"] = traceback.format_exc(limit=12)
                write_json(payload, status=500)
                return 0
        payload = {
            "kind": "period_allocation_best_effort_unavailable",
            "error": (
                "Chua xep duoc mot buoi hoc o muc tiet cu the. "
                "Hay giu best-effort bat de tra lich tot nhat kem tiet chua xep, "
                "hoac noi bot tiet nghi/rang buoc dang qua chat."
            ),
            "detail": exc.to_dict(),
        }
        if os.environ.get("TKB_DEBUG_TRACE") == "1":
            payload["trace"] = traceback.format_exc(limit=12)
        write_json(payload, status=500)
        return 0
    except RuntimeError as exc:
        message = str(exc)
        recognized_no_solution = any(
            token in message
            for token in (
                "No session solution found",
                "No CP-SAT session solution found",
                "Teacher session optimization did not find a complete timetable",
                "Integrated CP-SAT did not find a complete timetable",
                "First-click feasibility phase did not produce",
                "Constraint-change feasibility phase did not produce",
                "Benders teacher-session cap search failed",
            )
        )
        if recognized_no_solution:
            timeout_like = any(
                token in message.casefold()
                for token in ("status=unknown", "time limit", "timed out", "deadline")
            )
            if "teacher session optimization did not find a complete timetable" in message.casefold():
                timeout_like = True
            payload = {
                "kind": "infeasible_constraints",
                "error": (
                    "Ràng buộc hiện tại không có nghiệm lịch hợp lệ. "
                    "Hãy nới các giới hạn quá chặt như số buổi/tiết của giáo viên, "
                    "nghỉ cố định, hoặc giới hạn môn/nhóm môn rồi chạy lại."
                ),
                "detail": message,
            }
            if timeout_like:
                payload["kind"] = "no_complete_schedule_before_deadline"
                payload["error"] = (
                    "Backend chua kip tim lich hoan chinh trong thoi gian cho phep. "
                    "Day khong phai ket luan rang buoc vo nghiem; hay thu lai voi preset Vua/Max "
                    "hoac noi bot tiet nghi/rang buoc neu van lap lai."
                )
            metrics = getattr(exc, "metrics", None)
            attempts = getattr(exc, "attempts", None)
            if isinstance(metrics, dict) or isinstance(attempts, list):
                payload["solver"] = {}
                if isinstance(metrics, dict):
                    payload["solver"]["session_solver"] = metrics
                if isinstance(attempts, list):
                    payload["solver"]["attempts"] = attempts[-12:]
            if os.environ.get("TKB_DEBUG_TRACE") == "1":
                payload["trace"] = traceback.format_exc(limit=12)
            write_json(payload, status=422 if timeout_like else 409)
            return 0
        payload = {"error": message}
        if os.environ.get("TKB_DEBUG_TRACE") == "1":
            payload["trace"] = traceback.format_exc(limit=12)
        write_json(payload, status=500)
        return 0
    except Exception as exc:  # noqa: BLE001 - Rust API needs structured solver errors.
        payload = {"error": str(exc)}
        if os.environ.get("TKB_DEBUG_TRACE") == "1":
            payload["trace"] = traceback.format_exc(limit=12)
        write_json(payload, status=500)
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
