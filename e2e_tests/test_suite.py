import unittest
import urllib.request
import urllib.error
import json
import os
import time


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

class TestSuite(unittest.TestCase):
    BASE_URL = os.environ.get("TKB_E2E_BASE_URL", "http://127.0.0.1:1085").rstrip("/")

    def setUp(self):
        # Production permits one school registration per client IP. Give every
        # isolated test case a deterministic address from the benchmarking
        # network so registrations in earlier tests cannot block later ones.
        # The local Rust server trusts X-Real-IP only from its loopback peer.
        test_names = sorted(
            name for name in dir(type(self)) if name.startswith("test_")
        )
        offset = test_names.index(self._testMethodName)
        third_octet, host_octet = divmod(offset, 254)
        self._test_client_ip = f"198.18.{third_octet}.{host_octet + 1}"

    def _post(self, path, payload, headers=None, timeout=None):
        url = self.BASE_URL + path
        headers = dict(headers or {})
        headers.setdefault("X-Real-IP", self._test_client_ip)
        if "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
        
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode('utf-8') if payload is not None else None,
            headers=headers,
            method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                status = resp.status
                body = resp.read().decode('utf-8')
                return status, json.loads(body) if body else {}
        except urllib.error.HTTPError as e:
            status = e.code
            body = e.read().decode('utf-8')
            try:
                data = json.loads(body)
            except Exception:
                data = body
            return status, data
        except Exception as e:
            # For connection reset or other unexpected client errors
            return 599, {"error": str(e)}

    def _get(self, path, headers=None):
        url = self.BASE_URL + path
        headers = headers or {}
        req = urllib.request.Request(
            url,
            headers=headers,
            method="GET"
        )
        try:
            with urllib.request.urlopen(req) as resp:
                status = resp.status
                body = resp.read().decode('utf-8')
                return status, json.loads(body) if body else {}
        except urllib.error.HTTPError as e:
            status = e.code
            body = e.read().decode('utf-8')
            try:
                data = json.loads(body)
            except Exception:
                data = body
            return status, data
        except Exception as e:
            return 599, {"error": str(e)}

    def _get_raw(self, path, follow_redirects=True):
        request = urllib.request.Request(self.BASE_URL + path, method="GET")
        opener = urllib.request.build_opener() if follow_redirects else urllib.request.build_opener(_NoRedirect())
        try:
            with opener.open(request) as response:
                return response.status, dict(response.headers.items()), response.read()
        except urllib.error.HTTPError as error:
            return error.code, dict(error.headers.items()), error.read()

    def _get_tiny_data(self):
        return {
            "lop": [
                {"id": "10A1", "ten": "10A1", "khoi": "Khối 10", "buoi": "Cả ngày"}
            ],
            "giaovien": [
                {"hodem": "Nguyên", "ten": "Lộc", "magv": "VA.Lộc"}
            ],
            "monhoc": [
                {"ten": "Toán", "ma": "Toán"}
            ],
            "mon": [
                {"khoi": "Khối 10", "ten": "Toán", "sotiet": 2, "gioihan": 1}
            ],
            "pccmMatrix": {
                "10A1|Toán": "VA.Lộc"
            }
        }

    def _auth_login_id(self, prefix):
        return f"{prefix}_{time.time_ns()}"

    def _wait_for_solver_jobs(self, job_ids, timeout=5, active_only=False):
        expected = set(job_ids)
        deadline = time.monotonic() + timeout
        last_status = None
        last_state = {}
        while time.monotonic() < deadline:
            heartbeat_id = next(iter(expected), "")
            suffix = f"?jobId={heartbeat_id}" if heartbeat_id else ""
            last_status, last_state = self._get(f"/api/solver-state{suffix}")
            if last_status == 200:
                active = {
                    item.get("jobId")
                    for item in last_state.get("jobs", [])
                    if isinstance(item, dict)
                }
                queued = {
                    item.get("jobId")
                    for item in last_state.get("queue", [])
                    if isinstance(item, dict)
                }
                visible = active if active_only else active | queued
                if expected <= visible:
                    return last_status, last_state
            time.sleep(0.05)
        return last_status, last_state

    def _cancel_solver_jobs(self, *job_ids):
        return {
            job_id: self._post("/api/solve-cancel", {"jobId": job_id})
            for job_id in job_ids
        }

    def _auth_registration_payload(self, login_id, password="SecurePassword123!", **overrides):
        payload = {
            "loginId": login_id,
            "password": password,
            "email": f"{login_id}@example.test",
            "phone": "0900000000",
            "schoolName": f"School {login_id}",
            "scheduleNumber": 1,
            "effectiveDate": "2026-07-10",
            "clientIp": ""
        }
        payload.update(overrides)
        return payload

    def _register_and_login(self, login_id, password="SecurePassword123!"):
        register_status, register_data = self._post(
            "/api/auth/register",
            self._auth_registration_payload(login_id, password)
        )
        self.assertEqual(register_status, 200, register_data)
        self.assertTrue(register_data.get("ok"), register_data)

        login_status, login_data = self._post("/api/auth/login", {
            "loginId": login_id,
            "password": password,
            "clientIp": ""
        })
        self.assertEqual(login_status, 200, login_data)
        self.assertTrue(login_data.get("ok"), login_data)
        token = login_data.get("sessionToken")
        self.assertTrue(token, login_data)
        return register_data, login_data, token

    # ==========================================
    # Tier 1: Auth & User Registry (SQLite) (18 tests)
    # ==========================================

    def test_auth_register_success(self):
        login_id = self._auth_login_id("new_user")
        payload = self._auth_registration_payload(login_id)
        status, data = self._post("/api/auth/register", payload)
        self.assertEqual(status, 200, data)
        self.assertTrue(data.get("ok"))
        self.assertEqual(data.get("loginId"), login_id)
        self.assertTrue(data.get("schoolId"))
        self.assertTrue(data.get("scheduleSid"))

    def test_auth_register_duplicate(self):
        login_id = self._auth_login_id("dup_user")
        payload = self._auth_registration_payload(login_id)
        status1, data1 = self._post("/api/auth/register", payload)
        self.assertEqual(status1, 200, data1)
        
        status2, data2 = self._post("/api/auth/register", payload)
        self.assertEqual(status2, 409)
        self.assertFalse(data2.get("ok"))

    def test_auth_register_invalid_username(self):
        payload = self._auth_registration_payload("a")
        status, data = self._post("/api/auth/register", payload)
        self.assertEqual(status, 400)
        self.assertFalse(data.get("ok"))

    def test_auth_register_invalid_password(self):
        login_id = self._auth_login_id("weak_user")
        payload = self._auth_registration_payload(login_id, password="123")
        status, data = self._post("/api/auth/register", payload)
        self.assertEqual(status, 400)
        self.assertFalse(data.get("ok"))

    def test_auth_register_missing_school(self):
        login_id = self._auth_login_id("no_school")
        payload = self._auth_registration_payload(login_id, schoolName="")
        status, data = self._post("/api/auth/register", payload)
        self.assertEqual(status, 400)
        self.assertFalse(data.get("ok"))

    def test_auth_login_success(self):
        login_id = self._auth_login_id("login_user")
        password = "SecurePassword123!"
        register_data, data, token = self._register_and_login(login_id, password)
        self.assertEqual(data.get("sessionToken"), token)
        self.assertEqual(data.get("role"), "school_admin")
        self.assertEqual(data.get("schoolId"), register_data.get("schoolId"))
        self.assertEqual(data.get("user", {}).get("id"), login_id)

    def test_auth_login_wrong_password(self):
        login_id = self._auth_login_id("wrongpass")
        password = "SecurePassword123!"
        register_status, register_data = self._post(
            "/api/auth/register",
            self._auth_registration_payload(login_id, password)
        )
        self.assertEqual(register_status, 200, register_data)
        status, data = self._post("/api/auth/login", {
            "loginId": login_id,
            "password": "wrong_password",
            "clientIp": ""
        })
        self.assertEqual(status, 401)
        self.assertFalse(data.get("ok"))

    def test_auth_login_wrong_username(self):
        status, data = self._post("/api/auth/login", {
            "loginId": self._auth_login_id("missing_user"),
            "password": "SecurePassword123!",
            "clientIp": ""
        })
        self.assertEqual(status, 401)
        self.assertFalse(data.get("ok"))

    def test_auth_login_empty_payload(self):
        status, data = self._post("/api/auth/login", {})
        self.assertEqual(status, 400)
        self.assertFalse(data.get("ok"))

    def test_auth_login_rejects_second_active_session_until_logout(self):
        login_id = self._auth_login_id("single_session")
        password = "SecurePassword123!"
        _, first_login, first_token = self._register_and_login(login_id, password)

        second_status, second_data = self._post("/api/auth/login", {
            "loginId": login_id,
            "password": password,
            "clientIp": ""
        })
        self.assertEqual(second_status, 409, second_data)
        self.assertFalse(second_data.get("ok"))
        self.assertEqual(second_data.get("error"), "account_already_logged_in")

        first_headers = {"Authorization": f"Bearer {first_token}"}
        session_status, session_data = self._get("/api/auth/session", headers=first_headers)
        self.assertEqual(session_status, 200, session_data)

        logout_status, logout_data = self._post(
            "/api/auth/logout", None, headers=first_headers
        )
        self.assertEqual(logout_status, 200, logout_data)

        retry_status, retry_data = self._post("/api/auth/login", {
            "loginId": login_id,
            "password": password,
            "clientIp": ""
        })
        self.assertEqual(retry_status, 200, retry_data)
        self.assertTrue(retry_data.get("ok"))
        self.assertNotEqual(retry_data.get("sessionToken"), first_login.get("sessionToken"))

    def test_auth_logout_only_releases_its_own_active_session(self):
        login_id = self._auth_login_id("logout_owner")
        password = "SecurePassword123!"
        _, _, first_token = self._register_and_login(login_id, password)
        first_headers = {"Authorization": f"Bearer {first_token}"}
        logout_status, _ = self._post("/api/auth/logout", None, headers=first_headers)
        self.assertEqual(logout_status, 200)

        login_status, login_data = self._post("/api/auth/login", {
            "loginId": login_id,
            "password": password,
            "clientIp": ""
        })
        self.assertEqual(login_status, 200, login_data)
        second_token = login_data.get("sessionToken")

        # Repeating logout with the old token must not release the newer session.
        stale_logout_status, _ = self._post(
            "/api/auth/logout", None, headers=first_headers
        )
        self.assertEqual(stale_logout_status, 200)
        blocked_status, blocked_data = self._post("/api/auth/login", {
            "loginId": login_id,
            "password": password,
            "clientIp": ""
        })
        self.assertEqual(blocked_status, 409, blocked_data)

        second_headers = {"Authorization": f"Bearer {second_token}"}
        second_session_status, second_session_data = self._get(
            "/api/auth/session", headers=second_headers
        )
        self.assertEqual(second_session_status, 200, second_session_data)

    def test_auth_protected_api_no_token(self):
        status, data = self._get("/api/auth/registry")
        self.assertEqual(status, 401)
        self.assertEqual(data.get("error"), "auth_required")

    def test_auth_protected_api_invalid_token(self):
        status, data = self._get(
            "/api/auth/registry",
            headers={"Authorization": "Bearer invalidtoken123"}
        )
        self.assertEqual(status, 401)
        self.assertEqual(data.get("error"), "auth_required")

    def test_auth_registry_allowed_school_admin(self):
        login_id = self._auth_login_id("school_admin")
        _, _, token = self._register_and_login(login_id)
        headers = {"Authorization": f"Bearer {token}"}
        status, data = self._get("/api/auth/registry", headers=headers)
        self.assertEqual(status, 200, data)
        self.assertIn(login_id, data.get("users", {}))

    def test_auth_registry_sanitizes_password_hashes(self):
        login_id = self._auth_login_id("registry_sanitize")
        _, _, token = self._register_and_login(login_id)
        headers = {"Authorization": f"Bearer {token}"}
        status, data = self._get("/api/auth/registry", headers=headers)
        self.assertEqual(status, 200, data)
        users = data.get("users", {})
        self.assertIn(login_id, users)
        self.assertTrue(all("passwordHash" not in user for user in users.values()))

    def test_auth_session_success(self):
        login_id = self._auth_login_id("session_user")
        _, _, token = self._register_and_login(login_id)
        headers = {"Authorization": f"Bearer {token}"}
        status, data = self._get("/api/auth/session", headers=headers)
        self.assertEqual(status, 200, data)
        self.assertTrue(data.get("ok"))
        self.assertEqual(data.get("session", {}).get("userId"), login_id)
        self.assertEqual(data.get("session", {}).get("role"), "school_admin")

    def test_auth_session_logout(self):
        login_id = self._auth_login_id("logout_user")
        _, _, token = self._register_and_login(login_id)
        headers = {"Authorization": f"Bearer {token}"}
        logout_status, logout_data = self._post("/api/auth/logout", None, headers=headers)
        self.assertEqual(logout_status, 200)
        self.assertTrue(logout_data.get("ok"))
        status, data = self._get("/api/auth/session", headers=headers)
        self.assertEqual(status, 401)
        self.assertEqual(data.get("error"), "invalid_session")

    def test_auth_session_expiration(self):
        status, data = self._get(
            "/api/auth/session",
            headers={"Authorization": "Bearer expiredtoken123"}
        )
        self.assertEqual(status, 401)
        self.assertEqual(data.get("error"), "invalid_session")


    # ==========================================
    # Tier 2: API Endpoints (Rust HTTP Server) (15 tests)
    # ==========================================

    def test_api_health(self):
        status, data = self._get("/api/health")
        self.assertEqual(status, 200)
        self.assertTrue(data.get("ok"))
        self.assertEqual(data.get("api"), "rust")

    def test_api_version(self):
        status, data = self._get("/api/version")
        self.assertEqual(status, 200)
        self.assertEqual(data.get("app"), "tkb_new")
        self.assertIn("version", data)

    def test_clean_page_route_serves_html_with_security_headers(self):
        status, headers, body = self._get_raw("/app")
        normalized = {key.lower(): value for key, value in headers.items()}
        self.assertEqual(status, 200)
        self.assertIn("text/html", normalized.get("content-type", ""))
        self.assertEqual(normalized.get("x-content-type-options"), "nosniff")
        self.assertEqual(normalized.get("x-frame-options"), "DENY")
        self.assertIn(b"<!doctype html>", body.lower())

    def test_legacy_html_route_redirects_to_clean_url_and_keeps_query(self):
        status, headers, _ = self._get_raw("/pages/sapxep.html?sid=abc123", follow_redirects=False)
        normalized = {key.lower(): value for key, value in headers.items()}
        self.assertEqual(status, 308)
        self.assertEqual(normalized.get("location"), "/pages/sapxep?sid=abc123")

    def test_static_server_does_not_expose_hidden_or_unknown_files(self):
        hidden_status, _, _ = self._get_raw("/.env", follow_redirects=False)
        unknown_status, _, _ = self._get_raw("/source.map", follow_redirects=False)
        self.assertEqual(hidden_status, 404)
        self.assertEqual(unknown_status, 404)

    def test_api_sample_data(self):
        status, data = self._get("/api/sample-data")
        self.assertEqual(status, 200)
        self.assertIn("lop", data)
        self.assertIn("giaovien", data)

    def test_api_solver_state(self):
        status, data = self._get("/api/solver-state")
        self.assertEqual(status, 200)
        self.assertTrue(data.get("ok"))
        self.assertIn("activeJobs", data)
        self.assertIn("maxConcurrent", data)

    def test_api_solve_precheck_valid(self):
        payload = {
            "settings": {},
            "data": self._get_tiny_data()
        }
        status, data = self._post("/api/solve-precheck", payload)
        self.assertEqual(status, 200)
        self.assertTrue(data.get("ok"))
        self.assertTrue(data.get("nativePrecheck"))

    def test_api_solve_precheck_invalid_grades(self):
        tiny_data = self._get_tiny_data()
        tiny_data["lop"][0]["khoi"] = ""
        payload = {
            "settings": {},
            "data": tiny_data
        }
        status, data = self._post("/api/solve-precheck", payload)
        self.assertEqual(status, 200)
        self.assertTrue(data.get("ok"))
        self.assertEqual(data.get("skippedUnknownClass"), 1)

    def test_api_solve_precheck_empty_payload(self):
        status, data = self._post("/api/solve-precheck", {})
        self.assertEqual(status, 400)
        self.assertFalse(data.get("ok"))

    def test_api_export_xlsx_empty(self):
        status, data = self._post("/api/export/tkb-class-xlsx?date=09072026", None)
        self.assertEqual(status, 400)
        self.assertFalse(data.get("ok"))
        self.assertEqual(data.get("error"), "empty_xlsx_payload")

    def test_api_export_xlsx_valid(self):
        status, data = self._post("/api/export/tkb-class-xlsx?date=09072026&prefix=e2e_test", {"fake": "bytes"})
        self.assertEqual(status, 200)
        self.assertTrue(data.get("ok"))
        self.assertIn("fileName", data)

    def test_api_export_docx_empty(self):
        status, data = self._post("/api/export/tkb-class-docx?date=09072026", None)
        self.assertEqual(status, 400)
        self.assertFalse(data.get("ok"))
        self.assertEqual(data.get("error"), "empty_docx_payload")

    def test_api_export_docx_valid(self):
        status, data = self._post("/api/export/tkb-class-docx?date=09072026&prefix=e2e_test", {"fake": "bytes"})
        self.assertEqual(status, 200)
        self.assertTrue(data.get("ok"))
        self.assertIn("fileName", data)

    def test_api_invalid_route(self):
        status, data = self._get("/api/non_existent_route")
        self.assertEqual(status, 404)

    def test_api_invalid_method(self):
        status, data = self._post("/api/health", {})
        self.assertEqual(status, 404)

    def test_api_cors_options(self):
        url = self.BASE_URL + "/api/health"
        req = urllib.request.Request(url, method="OPTIONS")
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 204)
            headers = resp.headers
            self.assertIn("Access-Control-Allow-Origin", headers)
            self.assertIn("Access-Control-Allow-Methods", headers)

    def test_api_large_payload(self):
        url = self.BASE_URL + "/api/solve-data"
        large_data = b"A" * (16 * 1024 * 1024 + 100)
        req = urllib.request.Request(
            url,
            data=large_data,
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        try:
            with urllib.request.urlopen(req) as resp:
                status = resp.status
        except urllib.error.HTTPError as e:
            status = e.code
        self.assertIn(status, (400, 413))


    # ==========================================
    # Tier 3: Solver timeout/best-effort (5 tests)
    # ==========================================

    def test_solver_fast_solve(self):
        payload = {
            "settings": {
                "native_force_rust_solver": True,
                "require_complete_schedule": False
            },
            "data": self._get_tiny_data()
        }
        status, data = self._post("/api/solve-data", payload)
        self.assertEqual(status, 200)
        self.assertTrue(data.get("ok"))
        self.assertIn("lessons", data)

    def test_solver_timeout_return_422(self):
        status_sample, sample_data = self._get("/api/sample-data")
        self.assertEqual(status_sample, 200)
        
        payload = {
            "settings": {
                "native_force_rust_solver": True,
                "require_complete_schedule": True,
                "best_effort_on_timeout": False,
                "backend_deadline_ms": 1000,
                "native_global_deadline_ms": 1000
            },
            "data": sample_data
        }
        status, data = self._post("/api/solve-data", payload)
        self.assertEqual(status, 422)
        self.assertFalse(data.get("ok"))
        self.assertEqual(data.get("kind"), "no_complete_schedule_before_deadline")

    def test_solver_timeout_return_best_effort(self):
        status_sample, sample_data = self._get("/api/sample-data")
        self.assertEqual(status_sample, 200)
        
        payload = {
            "settings": {
                "native_force_rust_solver": True,
                "require_complete_schedule": True,
                "best_effort_on_timeout": True,
                "backend_deadline_ms": 1000,
                "native_global_deadline_ms": 1000
            },
            "data": sample_data
        }
        status, data = self._post("/api/solve-data", payload)
        self.assertEqual(status, 200)
        self.assertTrue(data.get("ok"))
        self.assertTrue(data.get("bestEffort") or data.get("metrics", {}).get("best_effort"))

    def test_solver_cancel_solve(self):
        import threading
        solve_status = []
        solve_data = []
        
        status_sample, sample_data = self._get("/api/sample-data")
        self.assertEqual(status_sample, 200)
        
        job_id = self._auth_login_id("cancel_test_job")
        payload = {
            "settings": {
                "native_force_rust_solver": True,
                "ui_solver_fifo_admission": True,
                "solve_run_id": job_id,
                "backend_deadline_ms": 20000,
                "native_global_deadline_ms": 20000
            },
            "data": sample_data
        }
        
        def run_solve():
            status, data = self._post("/api/solve-data", payload)
            solve_status.append(status)
            solve_data.append(data)
            
        t = threading.Thread(target=run_solve)
        t.start()

        state_status = None
        state_data = {}
        cancel_status = None
        cancel_res = {}
        try:
            state_status, state_data = self._wait_for_solver_jobs([job_id])
            cancel_status, cancel_res = self._post("/api/solve-cancel", {"jobId": job_id})
        finally:
            self._cancel_solver_jobs(job_id)
            t.join(timeout=10)

        self.assertEqual(state_status, 200, state_data)
        visible_jobs = {
            item.get("jobId")
            for key in ("jobs", "queue")
            for item in state_data.get(key, [])
            if isinstance(item, dict)
        }
        self.assertIn(job_id, visible_jobs, state_data)
        self.assertEqual(cancel_status, 200)
        self.assertTrue(cancel_res.get("ok"))
        self.assertTrue(cancel_res.get("cancelRequested"))
        self.assertFalse(t.is_alive())
        self.assertTrue(len(solve_status) > 0)

    def test_solver_concurrent_limit(self):
        import threading
        status_sample, sample_data = self._get("/api/sample-data")
        self.assertEqual(status_sample, 200)

        run_id = time.time_ns()
        job_ids = [f"concurrent-job-{index}-{run_id}" for index in range(1, 4)]

        def payload(job_id):
            return {
                "settings": {
                    "native_force_rust_solver": True,
                    "ui_solver_fifo_admission": True,
                    "solve_run_id": job_id,
                    "backend_deadline_ms": 20000,
                    "native_global_deadline_ms": 20000
                },
                "data": sample_data
            }

        def solve_job_1():
            self._post("/api/solve-data", payload(job_ids[0]))

        def solve_job_2():
            self._post("/api/solve-data", payload(job_ids[1]))
            
        t1 = threading.Thread(target=solve_job_1)
        t2 = threading.Thread(target=solve_job_2)
        t1.start()
        t2.start()

        state_status = None
        state_data = {}
        status3 = None
        data3 = {}
        try:
            state_status, state_data = self._wait_for_solver_jobs(
                job_ids[:2],
                active_only=True,
            )
            status3, data3 = self._post("/api/solve-data", payload(job_ids[2]))
        finally:
            self._cancel_solver_jobs(*job_ids)
            t1.join(timeout=10)
            t2.join(timeout=10)

        self.assertEqual(state_status, 200, state_data)
        active_ids = {
            item.get("jobId")
            for item in state_data.get("jobs", [])
            if isinstance(item, dict)
        }
        self.assertTrue(set(job_ids[:2]) <= active_ids, state_data)
        self.assertFalse(t1.is_alive())
        self.assertFalse(t2.is_alive())
        self.assertEqual(status3, 202)
        self.assertFalse(data3.get("ok"))
        self.assertTrue(data3.get("queued"))
        self.assertEqual(data3.get("kind"), "solver_queued")
        self.assertEqual(data3.get("queuePosition"), 1)


    # ==========================================
    # Tier 4: Real-world Application Scenarios (5 tests)
    # ==========================================

    def test_scenario_full_lifecycle_success(self):
        # 1. Health check
        h_status, h_data = self._get("/api/health")
        self.assertEqual(h_status, 200)
        self.assertTrue(h_data.get("ok"))
        
        # 2. Get sample data
        s_status, s_data = self._get("/api/sample-data")
        self.assertEqual(s_status, 200)
        
        # 3. Precheck
        p_status, p_data = self._post("/api/solve-precheck", {"data": s_data})
        self.assertEqual(p_status, 200)
        self.assertTrue(p_data.get("ok"))
        
        # 4. Solve
        solve_payload = {
            "settings": {
                "native_force_rust_solver": True,
                "require_complete_schedule": False,
                "best_effort_on_timeout": True,
                "backend_deadline_ms": 5000,
                "native_global_deadline_ms": 5000,
                "native_skip_teacher_optimization": True,
                "random_seed": 1
            },
            "data": s_data
        }
        sol_status, sol_data = self._post("/api/solve-data", solve_payload, timeout=15)
        self.assertEqual(sol_status, 200)
        self.assertTrue(sol_data.get("ok"))
        self.assertIn("lessons", sol_data)
        
        # 5. Export
        exp_status, exp_data = self._post("/api/export/tkb-class-xlsx?date=09072026&prefix=lifecycle", sol_data)
        self.assertEqual(exp_status, 200)
        self.assertTrue(exp_data.get("ok"))
        self.assertIn("fileName", exp_data)

    def test_scenario_solver_timeout_recovery(self):
        status_sample, sample_data = self._get("/api/sample-data")
        self.assertEqual(status_sample, 200)
        
        payload_timeout = {
            "settings": {
                "native_force_rust_solver": True,
                "require_complete_schedule": True,
                "best_effort_on_timeout": False,
                "backend_deadline_ms": 1000,
                "native_global_deadline_ms": 1000
            },
            "data": sample_data
        }
        t_status, t_data = self._post("/api/solve-data", payload_timeout)
        self.assertEqual(t_status, 422)
        
        payload_normal = {
            "settings": {
                "native_force_rust_solver": True,
                "require_complete_schedule": False
            },
            "data": self._get_tiny_data()
        }
        n_status, n_data = self._post("/api/solve-data", payload_normal)
        self.assertEqual(n_status, 200)
        self.assertTrue(n_data.get("ok"))

    def test_scenario_auth_registry_audit(self):
        login_id = self._auth_login_id("registry_audit")
        _, _, token = self._register_and_login(login_id)

        status_registry, registry = self._get(
            "/api/auth/registry",
            headers={"Authorization": f"Bearer {token}"}
        )
        self.assertEqual(status_registry, 200, registry)
        self.assertIn(login_id, registry.get("users", {}))
        self.assertTrue(
            all("passwordHash" not in user for user in registry.get("users", {}).values())
        )

    def test_scenario_invalid_data_reject(self):
        p_status, p_data = self._post("/api/solve-precheck", {"data": {"lop": "not-an-array"}})
        s_status, s_data = self._post("/api/solve-data", {"data": None})
        self.assertIn(s_status, (400, 422, 500))

    def test_scenario_parallel_compilation_and_solve(self):
        import threading
        status_sample, sample_data = self._get("/api/sample-data")
        self.assertEqual(status_sample, 200)

        job_id = self._auth_login_id("parallel_job")
        payload = {
            "settings": {
                "native_force_rust_solver": True,
                "ui_solver_fifo_admission": True,
                "solve_run_id": job_id,
                "backend_deadline_ms": 20000,
                "native_global_deadline_ms": 20000
            },
            "data": sample_data
        }

        def run_solve():
            self._post("/api/solve-data", payload)

        t = threading.Thread(target=run_solve)
        t.start()

        status_state = None
        state_data = {}
        try:
            status_state, state_data = self._wait_for_solver_jobs([job_id])
        finally:
            self._cancel_solver_jobs(job_id)
            t.join(timeout=10)

        self.assertEqual(status_state, 200)
        self.assertTrue(state_data.get("ok"))
        visible_jobs = [*state_data.get("jobs", []), *state_data.get("queue", [])]
        self.assertTrue(any(j.get("jobId") == job_id for j in visible_jobs), state_data)
        self.assertFalse(t.is_alive())

if __name__ == "__main__":
    unittest.main()
