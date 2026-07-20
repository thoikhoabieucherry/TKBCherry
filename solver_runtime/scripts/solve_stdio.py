from __future__ import annotations

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


CURRENT_REQUEST_BODY: bytes | None = None


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
        raw = sys.stdin.buffer.read()
        global CURRENT_REQUEST_BODY
        CURRENT_REQUEST_BODY = raw
        if not raw:
            write_json({"error": "Request body trong."}, status=400)
            return 0
        request = json.loads(raw.decode("utf-8"))
        if not isinstance(request, dict):
            write_json({"error": "JSON payload phai la object."}, status=400)
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
