"""27/10: bo giai "Cherry tren may nay" (tools/local-solver) cho nut gat May chu / May nay.

Kiem: chi tra loi trang duoc phep (tkbcherry.com, localhost) — trang la bi 403 va khong
khoi dong duoc luot giai; preflight co Access-Control-Allow-Private-Network; chi nghe
127.0.0.1; luot giai di tron vong solve-data -> solve-result; goi phat khong mang thu vien
chi may chu can (google-auth) va khong mang __pycache__ / logs.
"""
from __future__ import annotations

import json
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools" / "local-solver"))

import build_package  # noqa: E402
import cherry_local_solver as cls  # noqa: E402
from solver_jobs import SolverManager  # noqa: E402

FAKE_SOLVER = r'''
import json, sys
request = json.loads(sys.stdin.read() or "{}")
payload = {
    "ok": True, "lessons": [], "unassignedLessons": [],
    "metrics": {"expected_periods": 1, "scheduled_periods": 1, "unassigned_periods": 0,
                "app_constraint_violation_count": 0, "hard_ok": True},
    "echoEngine": (request.get("settings") or {}).get("engine"),
}
print(json.dumps({"protocol": "tkb-reference-solver-stdio-v1", "status": 200, "payload": payload}))
'''

ALLOWED = "https://tkbcherry.com"
EVIL = "https://evil.example.com"


def request(port, method, path, origin=None, body=None):
    headers = {"Content-Type": "application/json"}
    if origin:
        headers["Origin"] = origin
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            raw = resp.read()
            return resp.status, dict(resp.headers), (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as err:
        raw = err.read()
        return err.code, dict(err.headers), (json.loads(raw) if raw else None)


class OriginTests(unittest.TestCase):
    def test_allowlist(self):
        allowed = tuple(o.lower() for o in cls.DEFAULT_ORIGINS)
        self.assertTrue(cls.origin_allowed("https://tkbcherry.com", allowed))
        self.assertTrue(cls.origin_allowed("https://www.tkbcherry.com/", allowed))
        self.assertTrue(cls.origin_allowed("http://127.0.0.1:2210", allowed))
        self.assertTrue(cls.origin_allowed("http://localhost:1010", allowed))
        self.assertTrue(cls.origin_allowed("", allowed))  # curl / test tren chinh may
        self.assertFalse(cls.origin_allowed(EVIL, allowed))
        self.assertFalse(cls.origin_allowed("http://tkbcherry.com", allowed))  # khong https
        self.assertFalse(cls.origin_allowed("https://tkbcherry.com.evil.example", allowed))
        self.assertFalse(cls.origin_allowed("null", allowed))


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls_):
        cls_.tmp = tempfile.TemporaryDirectory()
        runtime = Path(cls_.tmp.name) / "solver_runtime"
        (runtime / "scripts").mkdir(parents=True)
        (runtime / "scripts" / "solve_stdio.py").write_text(FAKE_SOLVER, encoding="utf-8")
        cls_.manager = SolverManager(runtime, Path(cls_.tmp.name) / "logs", workers=1)
        allowed = tuple(o.lower() for o in cls.DEFAULT_ORIGINS)
        cls_.server = cls.ExclusiveServer(("127.0.0.1", 0), cls.make_handler(cls_.manager, allowed))
        cls_.port = cls_.server.server_address[1]
        cls_.thread = threading.Thread(target=cls_.server.serve_forever, daemon=True)
        cls_.thread.start()

    @classmethod
    def tearDownClass(cls_):
        cls_.server.shutdown()
        cls_.server.server_close()
        cls_.tmp.cleanup()

    def test_binds_loopback_only(self):
        self.assertEqual(self.server.server_address[0], "127.0.0.1")

    def test_health_for_allowed_origin(self):
        status, headers, payload = request(self.port, "GET", "/api/health", ALLOWED)
        self.assertEqual(status, 200)
        self.assertEqual(payload["api"], "rust")  # bridge probeRustApiBase doi api:"rust"
        self.assertTrue(payload["localSolver"])
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), ALLOWED)
        self.assertEqual(headers.get("Access-Control-Allow-Private-Network"), "true")

    def test_preflight_allowed_origin(self):
        status, headers, _ = request(self.port, "OPTIONS", "/api/solve-data", ALLOWED)
        self.assertEqual(status, 204)
        self.assertEqual(headers.get("Access-Control-Allow-Private-Network"), "true")
        self.assertIn("POST", headers.get("Access-Control-Allow-Methods", ""))

    def test_foreign_origin_is_refused(self):
        for method, path, body in (
            ("OPTIONS", "/api/solve-data", None),
            ("GET", "/api/health", None),
            ("GET", "/api/solver-state", None),
            ("POST", "/api/solve-data", {"data": {}, "settings": {"solve_run_id": "evil-job"}}),
        ):
            status, headers, payload = request(self.port, method, path, EVIL, body)
            self.assertEqual(status, 403, (method, path))
            self.assertNotIn("Access-Control-Allow-Origin", headers)
            self.assertEqual(payload["kind"], "origin_not_allowed")
        self.assertNotIn("evil-job", self.manager.jobs)

    def test_solve_round_trip(self):
        body = {"data": {"lop": []}, "settings": {"solve_run_id": "job-local-1", "engine": "cherry"}}
        status, _, payload = request(self.port, "POST", "/api/solve-data", ALLOWED, body)
        self.assertEqual(status, 202)
        self.assertEqual(payload["jobId"], "job-local-1")
        deadline = time.time() + 30
        while True:
            status, _, payload = request(self.port, "GET", "/api/solve-result?jobId=job-local-1", ALLOWED)
            if status != 202 or time.time() > deadline:
                break
            time.sleep(0.2)
        self.assertEqual(status, 200, payload)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["echoEngine"], "cherry")
        self.assertEqual(payload["solver"]["backend"], "cherry-local-python")

    def test_status_page(self):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/")
        with urllib.request.urlopen(req, timeout=10) as resp:
            html = resp.read().decode("utf-8")
            self.assertIn("text/html", resp.headers.get("Content-Type"))
        self.assertIn("Cherry máy này", html)
        self.assertIn("/api/solve-data", html)

    def test_second_instance_cannot_share_the_port(self):
        # Windows: SO_REUSEADDR mac dinh cho 2 tien trinh cung nghe 1 cong -> phai doc quyen.
        with self.assertRaises(OSError):
            cls.ExclusiveServer(("127.0.0.1", self.port), cls.make_handler(self.manager, ()))
        self.assertTrue(cls.already_running(self.port))

    def test_unknown_path(self):
        status, _, payload = request(self.port, "GET", "/api/school/store", ALLOWED)
        self.assertEqual(status, 404)  # may nay chi GIAI, khong co kho du lieu


class PackageTests(unittest.TestCase):
    def test_package_contents(self):
        with tempfile.TemporaryDirectory() as tmp:
            zip_path = build_package.build(Path(tmp))
            with zipfile.ZipFile(zip_path) as zf:
                names = zf.namelist()
                reqs = zf.read("cherry-may-nay/solver_runtime/requirements.txt").decode("utf-8")
        prefix = "cherry-may-nay/"
        for required in ("cherry_local_solver.py", "solver_jobs.py", "status_page.html", "start-cherry-local.bat", "HUONG_DAN.txt",
                         "solver_runtime/scripts/solve_stdio.py",
                         "solver_runtime/src/tkb_engine_v3/entry.py"):
            self.assertIn(prefix + required, names)
        self.assertFalse(any("__pycache__" in n or n.endswith(".pyc") for n in names))
        self.assertFalse(any("/logs/" in n for n in names))
        self.assertIn("ortools", reqs)
        self.assertNotIn("google-auth", reqs)


if __name__ == "__main__":
    unittest.main()
