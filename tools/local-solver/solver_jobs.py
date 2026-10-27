"""Chay bo giai Cherry (solver_runtime/scripts/solve_stdio.py) ngay trong may.

27/10/2026: lay tu Cherry Local (02/09) cho nut gat "May chu / May nay" — dung boi
tools/local-solver/cherry_local_solver.py.

Mo phong dung phan hop dong ma web/pages/tkb-rust-bridge.js mong doi tu may chu Rust:
  POST /api/solve-data     -> 202 {kind:"solver_started", jobId, ...} (mot job mot luc; dang ban -> 409 solver_busy)
  GET  /api/solve-result   -> 202 {kind:"solver_running", progress} khi dang chay; khi xong tra (status, payload)
  GET  /api/solver-state   -> {ok, busy, jobs:[...], queue:[], completedJobs:[...]}
  POST /api/solve-cancel   -> {retainBest:true} = dung mem (engine tra luoi tot nhat), khong = huy han
Tien do: solve_stdio.py in cac dong "@@TKB_PROGRESS@@{json}" ra stderr -> chuyen nguyen khung cho trinh duyet.
Ket qua: dong JSON cuoi cua stdout {"protocol":..., "status":..., "payload":...} -> chuan hoa nhu
rust_api/src/main.rs::normalize_reference_payload (du tiet / thieu tiet / het gio / thieu cho).
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

PROGRESS_PREFIX = "@@TKB_PROGRESS@@"
STDIO_PROTOCOL = "tkb-reference-solver-stdio-v1"
CONTRACT_VERSION = "tkb-reference-solver-contract-v1"

MIN_DEADLINE_MS = 1_000
MAX_DEADLINE_MS = 1_800_000
DEFAULT_DEADLINE_MS = 180_000
DEFAULT_RESERVE_MS = 1_500
MAX_RESERVE_MS = 30_000
UNIFIED_RESERVE_MS = 20_000
MAX_WATCHDOG_MS = 1_800_000
STOP_GRACE_MS = 15_000       # qua han bao nhieu thi dat co dung mem
KILL_GRACE_MS = 45_000       # qua han bao nhieu thi giet tien trinh
CANCEL_KILL_MS = 6_000       # huy han: cho engine tra ket qua toi da 6 s roi giet
COMPLETED_KEEP_MS = 30 * 60 * 1000


def now_ms() -> int:
    return int(time.time() * 1000)


# Bien moi truong cua ban online (Cloud Run / VPS / agent / Google) KHONG duoc lot vao tien trinh bo giai.
ENV_DROP_PREFIXES = ("TKB_CLOUD", "TKB_REFERENCE_", "TKB_EXTERNAL_", "TKB_ENGINE", "GOOGLE_", "CLOUDSDK_")
ENV_DROP_KEYS = {"K_SERVICE", "K_REVISION", "K_CONFIGURATION"}


def build_solver_env(workers: int, stop_file: Path, save_artifacts: bool = False) -> dict:
    env = {
        key: value for key, value in os.environ.items()
        if not ("CLOUD_RUN" in key.upper() or key.upper().startswith(ENV_DROP_PREFIXES) or key.upper() in ENV_DROP_KEYS)
    }
    env.update({
        "PYTHONIOENCODING": "utf-8",
        "PYTHONUTF8": "1",
        "TKB_SOLVER_MAX_WORKERS": str(max(1, int(workers))),
        # 03/09: portfolio cua engine v3 (nut Cherry / Toi uu v3 tru lane CP-SAT) truoc day bi chan cung
        # o 8 tien trinh (= Cloud Run 8 vCPU) bat ke may co bao nhieu nhan -> nang tran theo so worker.
        "TKB_V3_MAX_WORKERS": str(max(1, int(workers))),
        # 03/09: engine v3 ghi cung tran 600 s/luot (entry._solve_deadline_seconds) -> luot 15/30 phut cua o chon
        # thoi luong bi cat con 10 phut. May chu local cho toi MAX_DEADLINE_MS nen nang tran engine bang.
        "TKB_V3_MAX_SOLVE_SECONDS": str(MAX_DEADLINE_MS // 1000),
        # Lane CP-SAT cua Toi uu v3 (1 tien trinh x N luong) mac dinh min(8, cpu): cap theo may (engine tran 16).
        "TKB_CPSAT_THREADS": str(max(1, min(16, int(workers)))),
        "TKB_SOLVER_STOP_FILE": str(stop_file),
        # solve_stdio.py mac dinh ghi tron request/response (ca du lieu truong) vao solver_runtime/logs
        # moi luot khong hoan hao, khong gioi han dung luong -> tat, bat lai bang start.py --verbose.
        "TKB_SAVE_SOLVE_ARTIFACTS": "1" if save_artifacts else "0",
        "OMP_NUM_THREADS": "1", "OMP_THREAD_LIMIT": "1", "OPENBLAS_NUM_THREADS": "1",
        "MKL_NUM_THREADS": "1", "NUMEXPR_NUM_THREADS": "1", "VECLIB_MAXIMUM_THREADS": "1", "BLIS_NUM_THREADS": "1",
    })
    return env


def kill_tree(proc) -> None:
    """Giet ca cay tien trinh (engine v3 sinh worker multiprocessing) chu khong chi tien trinh cha."""
    if proc is None or proc.poll() is not None:
        return
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        else:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except Exception:
        pass
    try:
        proc.kill()
    except Exception:
        pass


def _unlink_quiet(path: Path) -> None:
    try:
        if path.exists():
            path.unlink()
    except OSError:
        pass


def _num(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def setting_bool(settings: dict, key: str, default: bool) -> bool:
    value = settings.get(key)
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    text = str(value).strip().lower()
    if text in {"1", "true", "on", "yes"}:
        return True
    if text in {"0", "false", "off", "no", ""}:
        return False
    return default


def setting_int(settings: dict, key: str, default: int, allow_zero: bool = False) -> int:
    n = _num(settings.get(key))
    if n is None:
        return default
    n = int(n)
    if n < 0 or (n == 0 and not allow_zero):
        return default
    return n


def clamp(value: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, value))


def uses_unified_budget(settings: dict) -> bool:
    if not setting_bool(settings, "ui_unified_auto_sort", False):
        return False
    if setting_bool(settings, "ui_unified_partial_repair", False):
        return False
    kind = str(settings.get("ui_unified_solve_kind") or "").strip().lower().replace("-", "_")
    return kind != "repair_partial"


def compute_budget(settings: dict) -> dict:
    """Port cua rust_api/src/main.rs::reference_solver_budget (bo san 'automatic large fresh')."""
    backend_ms = clamp(setting_int(settings, "backend_deadline_ms", DEFAULT_DEADLINE_MS), MIN_DEADLINE_MS, MAX_DEADLINE_MS)
    native_ms = clamp(setting_int(settings, "native_global_deadline_ms", backend_ms), MIN_DEADLINE_MS, MAX_DEADLINE_MS)
    requested_cap = setting_int(settings, "reference_watchdog_deadline_ms", 0, allow_zero=True)
    watchdog_cap = clamp(requested_cap, MIN_DEADLINE_MS, MAX_WATCHDOG_MS) if requested_cap > 0 else MAX_WATCHDOG_MS
    eff_backend = min(backend_ms, watchdog_cap)
    eff_native = min(native_ms, watchdog_cap)
    ceiling = min(eff_backend, eff_native)
    if uses_unified_budget(settings):
        reserve = clamp(setting_int(settings, "ui_unified_reference_watchdog_reserve_ms", UNIFIED_RESERVE_MS), UNIFIED_RESERVE_MS, 20_000)
        hard = min(ceiling + reserve, MAX_DEADLINE_MS, watchdog_cap)
        solver = max(min(ceiling, hard - reserve), MIN_DEADLINE_MS)
        return {"hard_ms": hard, "solver_ms": solver, "reserve_ms": hard - solver, "backend_ms": eff_backend, "native_ms": eff_native, "unified": True}
    hard = ceiling
    requested_reserve = min(setting_int(settings, "native_deadline_reserve_ms", DEFAULT_RESERVE_MS, allow_zero=True), MAX_RESERVE_MS)
    reserve = min(requested_reserve, max(0, hard - MIN_DEADLINE_MS))
    solver = max(hard - reserve, MIN_DEADLINE_MS)
    return {"hard_ms": hard, "solver_ms": solver, "reserve_ms": reserve, "backend_ms": eff_backend, "native_ms": eff_native, "unified": False}


def _cap_seconds(settings: dict, key: str, cap_seconds: int, insert_missing: bool) -> None:
    n = _num(settings.get(key))
    if n is None or n <= 0:
        if insert_missing:
            settings[key] = cap_seconds
        return
    if n > cap_seconds:
        settings[key] = cap_seconds


def prepare_request(request: dict, budget: dict, workers: int) -> bytes:
    """Port rut gon cua reference_solver_body: gan hop dong, so worker va tran thoi gian."""
    settings = request.get("settings")
    if not isinstance(settings, dict):
        settings = {}
        request["settings"] = settings
    settings["reference_solver_contract_version"] = CONTRACT_VERSION
    settings["num_workers"] = max(1, int(workers))
    # Cherry Local chi chay tai cho: xoa moi yeu cau dinh tuyen sang Cloud Run / agent ma
    # trinh duyet co the con gui theo thoi quen cua ban online.
    for key in ("ui_hybrid_executor", "ui_hybrid_cloud_run_requested", "ui_hybrid_deep_optimize",
                "cloud_profile_id", "serverless_profile_id"):
        settings.pop(key, None)
    settings["routing_mode"] = "local"
    settings["ui_local_executor"] = "cherry-local"
    solver_seconds = max(1, budget["solver_ms"] // 1000)
    _cap_seconds(settings, "overall_time_limit_seconds", solver_seconds, True)
    _cap_seconds(settings, "integrated_time_limit", solver_seconds, False)
    _cap_seconds(settings, "optimization_time_limit_seconds", solver_seconds, False)
    # 03/09: luot DAI (o chon thoi luong cua ban local) -> chia nhieu vong portfolio cho lane mot muc
    # tieu chay bang portfolio (1 tiet/buoi, trong 2): vong sau warm-start tu luoi tot nhat vong truoc
    # (do 25/08: 3 vong tot hon 1 vong cung tong thoi gian). Engine tran 6 vong; lane CP-SAT (buoi day,
    # trong 1) tu bo qua; request da noi ro focus_rounds thi giu nguyen.
    if (
        str(settings.get("engine") or "").strip().lower() in {"cherry", "v3", "engine_v3"}
        and solver_seconds > 120
        and settings.get("focus_rounds") in (None, "")
    ):
        settings["focus_rounds"] = max(3, min(6, solver_seconds // 60))
    settings["reference_solver_budget_ms"] = budget["solver_ms"]
    settings["reference_watchdog_deadline_ms"] = budget["hard_ms"]
    settings["reference_deadline_reserve_ms"] = budget["reserve_ms"]
    if budget.get("unified"):
        settings["ui_unified_reference_watchdog_reserve_ms"] = budget["reserve_ms"]
    return json.dumps(request, ensure_ascii=False).encode("utf-8")


# ---------------------------------------------------------------- payload helpers
def _metrics(payload: dict) -> dict:
    m = payload.get("metrics")
    return m if isinstance(m, dict) else {}


def metric_int(payload: dict, key: str) -> int:
    n = _num(_metrics(payload).get(key))
    return int(n) if n is not None else 0


def metric_opt_int(payload: dict, key: str):
    if key not in _metrics(payload):
        return None
    n = _num(_metrics(payload).get(key))
    return int(n) if n is not None else None


def metric_bool(payload: dict, key: str) -> bool:
    v = _metrics(payload).get(key)
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v != 0
    return str(v or "").strip().lower() in {"1", "true", "on", "yes"}


def metric_opt_bool(payload: dict, key: str):
    if key not in _metrics(payload):
        return None
    return metric_bool(payload, key)


def payload_complete(payload: dict) -> bool:
    expected = metric_int(payload, "expected_periods")
    scheduled = metric_int(payload, "scheduled_periods")
    return (
        expected > 0
        and scheduled == expected
        and metric_int(payload, "unassigned_periods") == 0
        and metric_int(payload, "app_constraint_violation_count") == 0
        and metric_bool(payload, "hard_ok")
    )


def payload_safe_capacity_partial(payload: dict) -> bool:
    metrics = _metrics(payload)
    if not metrics:
        return False
    expected = metric_opt_int(payload, "expected_periods")
    scheduled = metric_opt_int(payload, "scheduled_periods")
    unassigned = metric_opt_int(payload, "unassigned_periods")
    capacity_unassigned = metric_opt_int(payload, "capacity_unassigned_periods")
    solver_unassigned = metric_opt_int(payload, "solver_unassigned_periods")
    accounting_ok = metric_opt_bool(payload, "accounting_ok")
    if None in (expected, scheduled, unassigned, capacity_unassigned, solver_unassigned, accounting_ok):
        return False
    if (
        expected <= 0 or scheduled <= 0 or scheduled >= expected or unassigned <= 0
        or capacity_unassigned + solver_unassigned != unassigned
        or scheduled + unassigned != expected
        or not accounting_ok
    ):
        return False
    if "accounted_periods" in metrics and metric_opt_int(payload, "accounted_periods") != expected:
        return False
    return True


def payload_mentions_capacity_shortfall(payload: dict) -> bool:
    metrics = _metrics(payload)
    if metric_int(payload, "capacity_unassigned_periods") > 0:
        return True
    kind = str(payload.get("kind") or "").lower()
    return "capacity" in kind or "capacity_shortage" in json.dumps(list(metrics.keys()))


def payload_usable_partial(payload: dict) -> bool:
    if payload_mentions_capacity_shortfall(payload):
        return payload_safe_capacity_partial(payload)
    expected = metric_int(payload, "expected_periods")
    scheduled = metric_int(payload, "scheduled_periods")
    unassigned = metric_int(payload, "unassigned_periods")
    violations = metric_int(payload, "app_constraint_violation_count")
    placed_ok = (
        metric_bool(payload, "placement_hard_ok")
        or metric_bool(payload, "placement_core_hard_ok")
        or metric_bool(payload, "hard_ok")
        or metric_bool(payload, "core_hard_ok")
    )
    return expected > 0 and 0 < scheduled < expected and unassigned > 0 and violations == 0 and placed_ok


def _truthy(value) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return str(value or "").strip().lower() in {"1", "true", "on", "yes"}


def payload_reports_timeout(payload: dict) -> bool:
    if str(payload.get("kind") or "").strip() == "no_complete_schedule_before_deadline":
        return True
    for key in ("deadlineExhausted", "deadline_exhausted", "deadline_hit"):
        if key in payload and _truthy(payload.get(key)):
            return True
    runtime = payload.get("solver", {}).get("runtime_settings") if isinstance(payload.get("solver"), dict) else None
    if isinstance(runtime, dict):
        for key in ("deadlineExhausted", "deadline_exhausted", "deadline_hit"):
            if key in runtime and _truthy(runtime.get(key)):
                return True
    return False


def _norm_key(value) -> str:
    return " ".join(str(value or "").strip().lower().split())


def expected_periods_from_data(data: dict, settings: dict | None = None) -> int:
    """Uoc so tiet can xep: settings.expected_scheduled_periods -> tkbSolverResult.metrics
    -> tong pccmTietMatrix -> tiet chuan theo khoi cua cac mon da phan cong."""
    settings = settings or {}
    n = setting_int(settings, "expected_scheduled_periods", 0, allow_zero=True)
    if n > 0:
        return n
    if not isinstance(data, dict):
        return 0
    try:
        prev = data.get("tkbSolverResult", {}).get("metrics", {}).get("expected_periods")
        if _num(prev) is not None and int(_num(prev)) > 0:
            return int(_num(prev))
    except Exception:
        pass
    matrix = data.get("pccmTietMatrix")
    if isinstance(matrix, dict):
        total = 0
        for value in matrix.values():
            v = _num(value)
            if v is not None and v > 0:
                total += int(v)
        if total > 0:
            return total
    # Tiet chuan theo khoi x mon da co giao vien
    grade_of_class = {}
    for lop in data.get("lop") or []:
        if not isinstance(lop, dict):
            continue
        for alias in (lop.get("ten"), lop.get("ten2"), lop.get("id")):
            key = _norm_key(alias)
            if key:
                grade_of_class[key] = _norm_key(lop.get("khoi"))
    periods = {}
    for row in data.get("mon") or []:
        if not isinstance(row, dict):
            continue
        v = _num(row.get("sotiet"))
        if v is None or v <= 0:
            continue
        periods[(_norm_key(row.get("khoi")), _norm_key(row.get("ten")))] = int(v)
    total = 0
    for key, teacher in (data.get("pccmMatrix") or {}).items():
        if not str(teacher or "").strip():
            continue
        parts = str(key).split("|", 1)
        if len(parts) != 2:
            continue
        grade = grade_of_class.get(_norm_key(parts[0]), "")
        total += periods.get((grade, _norm_key(parts[1])), 0)
    return total


def normalize_payload(payload: dict, request: dict, status: int, elapsed_ms: int, budget: dict, deadline_hit: bool) -> tuple[int, dict]:
    """Port cua rust_api/src/main.rs::normalize_reference_payload."""
    settings = request.get("settings") if isinstance(request.get("settings"), dict) else {}
    require_complete = setting_bool(settings, "require_complete_schedule", True)
    best_effort_allowed = setting_bool(settings, "best_effort_on_timeout", not require_complete)
    out_status = int(status)
    complete = payload_complete(payload)
    safe_partial = payload_safe_capacity_partial(payload)
    usable_partial = payload_usable_partial(payload)
    deadline_hit = bool(deadline_hit or payload_reports_timeout(payload))
    timeout_best_effort = best_effort_allowed and deadline_hit and usable_partial and not complete

    if safe_partial:
        out_status = 200
        payload["ok"] = True
        payload["bestEffort"] = True
        payload["kind"] = "best_effort_unassigned_accepted"
        payload["error"] = ""
    elif out_status == 200 and require_complete and not complete and not timeout_best_effort:
        out_status = 422
        payload["ok"] = False
        payload["kind"] = "no_complete_schedule_before_deadline" if deadline_hit else "incomplete_schedule"
        if not str(payload.get("error") or "").strip():
            payload["error"] = "Bộ giải chưa trả được lịch hoàn chỉnh thỏa ràng buộc."
    elif out_status == 200 and timeout_best_effort:
        payload["ok"] = True
        payload["bestEffort"] = True

    if not (200 <= out_status < 300):
        payload["ok"] = False
        if out_status >= 500 and not str(payload.get("kind") or "").strip():
            payload["kind"] = "reference_solver_failed"

    solver = payload.get("solver")
    if not isinstance(solver, dict):
        solver = {}
        payload["solver"] = solver
    solver["backend"] = "cherry-local-python"
    solver.setdefault("name", "cherry_engine_v3_local")
    solver.setdefault("description", "Cherry engine v3 chạy trực tiếp trên máy này (Cherry Local).")
    runtime = solver.get("runtime_settings")
    if not isinstance(runtime, dict):
        runtime = {}
        solver["runtime_settings"] = runtime
    runtime.update({
        "elapsed_seconds": round(elapsed_ms / 1000.0, 2),
        "backend_deadline_ms": budget["backend_ms"],
        "native_global_deadline_ms": budget["native_ms"],
        "native_deadline_reserve_ms": budget["reserve_ms"],
        "reference_solver_budget_ms": budget["solver_ms"],
        "reference_watchdog_deadline_ms": budget["hard_ms"],
        "deadline_hit": deadline_hit,
        "returned_incumbent": deadline_hit and (complete or safe_partial or timeout_best_effort),
        "capacity_partial_accepted": safe_partial,
        "phase": "reference_pipeline",
        "require_complete_schedule": require_complete,
        "best_effort_on_timeout": best_effort_allowed,
        "executor": "cherry-local",
    })

    metrics = payload.get("metrics")
    if not isinstance(metrics, dict):
        metrics = {}
        payload["metrics"] = metrics
    if timeout_best_effort:
        metrics["best_effort"] = True
    if "teacher_gap2_sessions" not in metrics:
        gap2 = 0
        dist = metrics.get("gap_distribution")
        if isinstance(dist, dict):
            for gap, count in dist.items():
                try:
                    if int(gap) >= 2:
                        gap2 += int(_num(count) or 0)
                except (TypeError, ValueError):
                    continue
        metrics["teacher_gap2_sessions"] = gap2
    metrics.setdefault("best_effort", bool(payload.get("bestEffort") is True))
    unassigned_list = payload.get("unassignedLessons")
    metrics.setdefault("unassigned_periods", len(unassigned_list) if isinstance(unassigned_list, list) else 0)
    if "expected_periods" not in metrics:
        metrics["expected_periods"] = expected_periods_from_data(request.get("data") or {}, settings)
    return out_status, payload


def timeout_payload(request: dict, elapsed_ms: int, budget: dict, detail: str) -> dict:
    settings = request.get("settings") if isinstance(request.get("settings"), dict) else {}
    expected = expected_periods_from_data(request.get("data") or {}, settings)
    return {
        "ok": False,
        "kind": "no_complete_schedule_before_deadline",
        "error": detail,
        "metrics": {
            "expected_periods": expected,
            "scheduled_periods": 0,
            "unassigned_periods": expected,
            "app_constraint_violation_count": 0,
            "best_effort": False,
        },
        "solver": {
            "backend": "cherry-local-python",
            "runtime_settings": {
                "elapsed_seconds": round(elapsed_ms / 1000.0, 2),
                "reference_watchdog_deadline_ms": budget["hard_ms"],
                "deadline_hit": True,
                "phase": "reference_pipeline",
                "executor": "cherry-local",
            },
        },
    }


def parse_wrapper(stdout_text: str):
    """Dong JSON cuoi cung mang protocol stdio -> (status, payload)."""
    for line in reversed(stdout_text.splitlines()):
        line = line.strip()
        if not line or not line.startswith("{"):
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict) and "payload" in obj:
            status = obj.get("status")
            try:
                status = int(status)
            except (TypeError, ValueError):
                status = 200
            payload = obj.get("payload")
            if not isinstance(payload, dict):
                payload = {"ok": False, "error": "payload không phải object", "kind": "reference_solver_failed"}
            return status, payload
    return None


# ---------------------------------------------------------------- jobs
class SolverJob:
    def __init__(self, job_id: str, request: dict, body: bytes, budget: dict, workers: int, stop_file: Path):
        self.id = job_id
        self.request = request
        self.body = body
        self.budget = budget
        self.workers = workers
        self.stop_file = stop_file
        self.created_ms = now_ms()
        self.started_ms = 0
        self.completed_ms = 0
        self.proc = None
        self.progress = None
        self.progress_updated_ms = 0
        self.stderr_tail = []
        self.stdout_text = ""
        self.cancel_requested = False
        self.cancel_at_ms = 0
        self.best_effort_stop_requested = False
        self.stop_touched = False
        self.result = None      # (status, payload)
        self.error = ""
        self.lock = threading.Lock()

    @property
    def running(self) -> bool:
        return self.started_ms > 0 and self.completed_ms == 0

    def touch_stop_file(self) -> None:
        try:
            self.stop_file.parent.mkdir(parents=True, exist_ok=True)
            self.stop_file.write_text(str(now_ms()), encoding="utf-8")
            self.stop_touched = True
        except OSError:
            pass

    def snapshot(self) -> dict:
        return {
            "jobId": self.id,
            "startedAtMs": self.started_ms or None,
            "createdAtMs": self.created_ms,
            "scheduleScope": None,
            "scheduleFingerprint": None,
            "progressBudgetSeconds": max(1, self.budget["solver_ms"] // 1000),
            "progressRunIndex": 1,
            "progress": self.progress,
            "progressUpdatedAtMs": self.progress_updated_ms or None,
            "watchdogBudgetMs": self.budget["hard_ms"],
            "watchdogStartedAtMs": self.started_ms or None,
            "watchdogRemainingMs": max(0, self.budget["hard_ms"] - (now_ms() - self.started_ms)) if self.started_ms else None,
            "serverOwned": True,
            "executor": "vps",
            "executionPhase": "cancelling" if self.cancel_requested and self.running else ("completed" if self.completed_ms else "vps_running"),
            "executionGeneration": 1,
            "handoffInProgress": False,
            "cancelRequested": self.cancel_requested,
            "bestEffortStopRequested": self.best_effort_stop_requested,
            "allocatedWorkers": self.workers,
        }


class SolverManager:
    def __init__(self, solver_runtime_dir: Path, log_dir: Path, python_exe: str | None = None,
                 workers: int | None = None, save_artifacts: bool = False):
        self.solver_runtime_dir = Path(solver_runtime_dir)
        self.script = self.solver_runtime_dir / "scripts" / "solve_stdio.py"
        if not self.script.exists() and self.script.with_suffix(".pyc").exists():
            # Gói cài CherrySetup.exe chỉ mang bytecode của engine (không kèm mã nguồn .py).
            self.script = self.script.with_suffix(".pyc")
        self.log_dir = Path(log_dir)
        exe = Path(python_exe or sys.executable)
        if exe.name.lower() == "pythonw.exe" and exe.with_name("python.exe").exists():
            exe = exe.with_name("python.exe")
        self.python_exe = str(exe)
        self.save_artifacts = bool(save_artifacts)
        # "Chay = tai nguyen may" nhung do 03/09 tren THCS Thi Tran (1746 tiet, 60 s): 8, 15 va 21
        # tien trinh cho CUNG ket qua (1746/1746, 611 buoi), 8 tien trinh hoi tu som nhat (43 s), nhieu
        # hon chi lam tung tien trinh cham di (lane CP-SAT 8 luong = 16 luong). Mac dinh 8 (hoac cpu-1
        # neu it hon); doi bang start.py --workers N hoac bien CHERRY_LOCAL_WORKERS (engine nhan tran
        # nay qua TKB_V3_MAX_WORKERS). Cai lam manh hon la THOI GIAN moi luot (o chon tren giao dien).
        cpu = os.cpu_count() or 2
        self.workers = int(workers) if workers and int(workers) > 0 else max(1, min(8, cpu - 1))
        self.jobs: dict[str, SolverJob] = {}
        self.order: list[str] = []
        self.lock = threading.Lock()

    # ---- helpers
    def available(self) -> bool:
        return self.script.exists()

    def _active_job(self):
        for job_id in reversed(self.order):
            job = self.jobs.get(job_id)
            if job and job.running:
                return job
        return None

    def _prune(self) -> None:
        cutoff = now_ms() - COMPLETED_KEEP_MS
        for job_id in list(self.order):
            job = self.jobs.get(job_id)
            if job and job.completed_ms and job.completed_ms < cutoff:
                self.order.remove(job_id)
                self.jobs.pop(job_id, None)

    # ---- API
    def start(self, body: bytes) -> tuple[int, dict]:
        if not self.available():
            return 503, {"ok": False, "kind": "solver_unavailable", "error": f"Không thấy {self.script}. Thư mục solver_runtime/ bị thiếu hoặc chép chưa đủ.", "retryable": False}
        try:
            request = json.loads(body.decode("utf-8"))
        except Exception as exc:
            return 400, {"ok": False, "kind": "bad_request", "error": f"JSON không hợp lệ: {exc}", "retryable": False}
        if not isinstance(request, dict) or not isinstance(request.get("data"), dict):
            return 400, {"ok": False, "kind": "bad_request", "error": "Thiếu trường data.", "retryable": False}
        settings = request.get("settings") if isinstance(request.get("settings"), dict) else {}
        job_id = str(settings.get("solve_run_id") or settings.get("ui_solve_run_id") or "").strip() or f"local-{uuid.uuid4().hex[:12]}"
        with self.lock:
            self._prune()
            existing = self.jobs.get(job_id)
            if existing is not None:
                if existing.running:
                    return 202, self._running_payload(existing, kind="solver_running")
                if existing.result is not None:
                    status, payload = existing.result
                    return status, payload
            active = self._active_job()
            if active is not None:
                return 409, {
                    "ok": False, "kind": "solver_busy", "error": "solver_busy",
                    "jobId": active.id, "existingJobId": active.id, "retryAfterMs": 700,
                    "activeJobs": 1, "maxConcurrent": 1, "queuedJobs": 0, "slotsAvailable": 0,
                }
            budget = compute_budget(settings)
            prepared = prepare_request(request, budget, self.workers)
            stop_file = Path(tempfile.gettempdir()) / f"cherry-local-stop-{os.getpid()}-{uuid.uuid4().hex[:10]}.flag"
            job = SolverJob(job_id, request, prepared, budget, self.workers, stop_file)
            job.started_ms = now_ms()
            self.jobs[job_id] = job
            self.order.append(job_id)
        threading.Thread(target=self._run, args=(job,), name=f"cherry-local-solver-{job_id}", daemon=True).start()
        payload = self._running_payload(job, kind="solver_started")
        payload["requiredWorkers"] = self.workers
        payload["vpsWorkerTokensAllocated"] = self.workers
        return 202, payload

    def _running_payload(self, job: SolverJob, kind: str) -> dict:
        snap = job.snapshot()
        return {
            "ok": False, "running": True, "serverOwned": True, "kind": kind, "error": kind,
            "jobId": job.id, "startedAtMs": job.started_ms,
            "progressBudgetSeconds": snap["progressBudgetSeconds"], "progressRunIndex": 1,
            "progress": job.progress, "progressUpdatedAtMs": job.progress_updated_ms or None,
            "watchdogBudgetMs": job.budget["hard_ms"], "watchdogStartedAtMs": job.started_ms,
            "watchdogRemainingMs": snap["watchdogRemainingMs"],
            "executor": "vps", "executionPhase": snap["executionPhase"], "executionGeneration": 1,
            "cancelRequested": job.cancel_requested, "bestEffortStopRequested": job.best_effort_stop_requested,
            "allocatedWorkers": job.workers, "retryAfterMs": 700,
        }

    def result(self, job_id: str) -> tuple[int, dict]:
        job_id = str(job_id or "").strip()
        with self.lock:
            job = self.jobs.get(job_id)
        if job is None:
            return 404, {"ok": False, "kind": "solver_job_not_found", "error": "solver_job_not_found", "jobId": job_id, "retryAfterMs": 700}
        if job.running:
            return 202, self._running_payload(job, kind="solver_running")
        status, payload = job.result or (500, {"ok": False, "kind": "reference_solver_failed", "error": job.error or "Không có kết quả."})
        out = dict(payload)
        out.setdefault("jobId", job.id)
        out["bestEffortStopRequested"] = job.best_effort_stop_requested
        return status, out

    def state(self, job_id: str = "") -> dict:
        job_id = str(job_id or "").strip()
        with self.lock:
            self._prune()
            active = self._active_job()
            jobs = [active.snapshot()] if active else []
            completed = [
                {"jobId": j.id, "completedAtMs": j.completed_ms, "startedAtMs": j.started_ms, "status": (j.result or (0, {}))[0]}
                for j in (self.jobs[i] for i in self.order) if j.completed_ms
            ]
            requested = self.jobs.get(job_id) if job_id else None
        payload = {
            "ok": True,
            "busy": active is not None,
            "activeJobs": 1 if active else 0,
            "maxConcurrent": 1,
            "slotsAvailable": 0 if active else 1,
            "queuedJobs": 0,
            "workerTokensTotal": self.workers,
            "workerTokensAllocated": self.workers if active else 0,
            "workerTokensAvailable": 0 if active else self.workers,
            "jobs": jobs,
            "queue": [],
            "completedJobs": completed,
            "serverTimeMs": now_ms(),
        }
        if job_id:
            payload.update({
                "requestedJobId": job_id,
                "requestedJobActive": bool(requested and requested.running),
                "requestedJobQueued": False,
                "requestedJobResultReady": bool(requested and requested.result is not None),
                "requestedJobServerOwned": requested is not None,
                "requestedJobExecutionPhase": requested.snapshot()["executionPhase"] if requested else None,
                "requestedJobProgress": requested.progress if requested else None,
            })
        return payload

    def cancel(self, body: bytes) -> dict:
        try:
            req = json.loads(body.decode("utf-8")) if body else {}
        except Exception:
            req = {}
        job_id = str((req or {}).get("solve_run_id") or (req or {}).get("jobId") or "").strip()
        retain_best = bool((req or {}).get("retainBest") is True)
        with self.lock:
            job = self.jobs.get(job_id)
        requested = False
        if job is not None and job.running:
            requested = True
            if retain_best:
                job.best_effort_stop_requested = True
            else:
                job.cancel_requested = True
                job.cancel_at_ms = now_ms()
            job.touch_stop_file()
        active = self._active_job()
        return {
            "ok": True,
            "cancelRequested": requested and not retain_best,
            "bestEffortStopRequested": requested and retain_best,
            "jobId": job_id,
            "activeJobs": 1 if active else 0,
            "maxConcurrent": 1,
            "queuedJobs": 0,
            "slotsAvailable": 0 if active else 1,
        }

    # ---- chay tien trinh
    def _run(self, job: SolverJob) -> None:
        env = build_solver_env(job.workers, job.stop_file, self.save_artifacts)
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
        self.log_dir.mkdir(parents=True, exist_ok=True)
        safe_tail = "".join(ch if ch.isalnum() else "-" for ch in job.id[-16:])
        log_path = self.log_dir / f"solver-{time.strftime('%Y%m%d-%H%M%S')}-{safe_tail}.log"
        try:
            proc = subprocess.Popen(
                [self.python_exe, str(self.script), "solve"],
                cwd=str(self.solver_runtime_dir),
                env=env,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                creationflags=creationflags,
                start_new_session=(os.name != "nt"),
            )
        except OSError as exc:
            job.error = f"Không chạy được bộ giải: {exc}"
            job.result = (500, {"ok": False, "kind": "solver_worker_start_failed", "error": job.error, "jobId": job.id})
            job.completed_ms = now_ms()
            return
        job.proc = proc

        stdout_chunks: list[bytes] = []

        def read_stdout():
            try:
                stdout_chunks.append(proc.stdout.read())
            except Exception:
                pass

        def read_stderr():
            try:
                with open(log_path, "w", encoding="utf-8", errors="replace") as log:
                    for raw in iter(proc.stderr.readline, b""):
                        line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                        if line.startswith(PROGRESS_PREFIX):
                            try:
                                frame = json.loads(line[len(PROGRESS_PREFIX):])
                                if isinstance(frame, dict):
                                    frame.setdefault("executionGeneration", 1)
                                    frame["executor"] = "cherry-local"
                                    job.progress = frame
                                    job.progress_updated_ms = now_ms()
                            except json.JSONDecodeError:
                                pass
                            continue
                        log.write(line + "\n")
                        job.stderr_tail.append(line)
                        if len(job.stderr_tail) > 40:
                            del job.stderr_tail[0]
            except Exception:
                pass

        # Ghi stdin trong luong rieng: body lon + tien trinh treo thi vong canh gac ben duoi van chay
        # va van huy/giet duoc (ghi dong bo se chan luong nay vo han).
        def feed_stdin():
            try:
                proc.stdin.write(job.body)
                proc.stdin.close()
            except Exception as exc:
                job.error = f"Không gửi được dữ liệu cho bộ giải: {exc}"

        t_out = threading.Thread(target=read_stdout, daemon=True)
        t_err = threading.Thread(target=read_stderr, daemon=True)
        t_in = threading.Thread(target=feed_stdin, daemon=True)
        t_out.start()
        t_err.start()
        t_in.start()

        killed = False
        while proc.poll() is None:
            time.sleep(0.2)
            elapsed = now_ms() - job.started_ms
            if job.cancel_requested and job.cancel_at_ms and now_ms() - job.cancel_at_ms > CANCEL_KILL_MS:
                kill_tree(proc)
                killed = True
                break
            if elapsed > job.budget["hard_ms"] + STOP_GRACE_MS and not job.stop_touched:
                job.touch_stop_file()
            if elapsed > job.budget["hard_ms"] + KILL_GRACE_MS:
                kill_tree(proc)
                killed = True
                break
        t_in.join(timeout=5)
        t_out.join(timeout=10)
        t_err.join(timeout=10)
        if killed:
            kill_tree(proc)   # don not worker mo coi (multiprocessing) neu con
        # Giu file dung them mot luc de worker con dang ket thuc van thay tin hieu, roi moi xoa.
        timer = threading.Timer(60.0, _unlink_quiet, args=(job.stop_file,))
        timer.daemon = True
        timer.start()

        elapsed_ms = now_ms() - job.started_ms
        stdout_text = b"".join(stdout_chunks).decode("utf-8", errors="replace")
        job.stdout_text = stdout_text
        parsed = parse_wrapper(stdout_text)
        deadline_hit = elapsed_ms >= job.budget["hard_ms"]
        if job.cancel_requested:
            expected = expected_periods_from_data(job.request.get("data") or {}, job.request.get("settings") or {})
            job.result = (409, {
                "ok": False, "kind": "solver_cancelled", "error": "Đã dừng theo yêu cầu; lịch cũ giữ nguyên.",
                "jobId": job.id, "cancelled": True, "lessons": [], "unassignedLessons": [],
                "metrics": {"expected_periods": expected, "scheduled_periods": 0, "unassigned_periods": expected,
                            "app_constraint_violation_count": 0, "hard_ok": False, "best_effort": False},
                "solver": {"backend": "cherry-local-python", "runtime_settings": {"elapsed_seconds": round(elapsed_ms / 1000.0, 2), "cancelled": True, "executor": "cherry-local"}},
            })
        elif parsed is not None:
            status, payload = parsed
            status, payload = normalize_payload(payload, job.request, status, elapsed_ms, job.budget, deadline_hit)
            job.result = (status, payload)
        elif killed:
            job.result = (422, timeout_payload(job.request, elapsed_ms, job.budget, "Bộ giải không trả kết quả trước hạn nên đã bị dừng."))
        else:
            tail = "\n".join(job.stderr_tail[-8:])
            job.error = f"Bộ giải kết thúc (mã {proc.returncode}) mà không trả kết quả. {tail}".strip()
            job.result = (500, {"ok": False, "kind": "reference_solver_failed", "error": job.error, "jobId": job.id})
        # Tra bo nho: body request (ca du lieu truong) va stdout khong con can sau khi da co ket qua.
        job.body = b""
        job.stdout_text = ""
        job.request = {"settings": job.request.get("settings") or {}}
        job.completed_ms = now_ms()
