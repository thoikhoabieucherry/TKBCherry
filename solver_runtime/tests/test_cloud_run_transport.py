from __future__ import annotations

import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]


def _load(name: str, filename: str):
    path = ROOT / "scripts" / filename
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


client = _load("cloud_run_client", "cloud_run_client.py")
service = _load("cloud_run_service", "cloud_run_service.py")


class CloudRunTransportTests(unittest.TestCase):
    def test_service_prefers_framed_terminal_wrapper(self) -> None:
        legacy = {"status": 422, "payload": {"ok": False}}
        framed = {"status": 200, "payload": {"ok": True, "lessons": []}}
        stdout = "\n".join(
            [
                json.dumps(legacy),
                "solver noise",
                service.RESULT_PREFIX + json.dumps(framed),
            ]
        )
        self.assertEqual(service._parse_solver_wrapper(stdout), framed)

    def test_service_rejects_stdout_without_wrapper(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "terminal wrapper"):
            service._parse_solver_wrapper("solver noise only")

    def test_timeout_and_worker_caps_are_bounded(self) -> None:
        request = {
            "settings": {
                "reference_watchdog_deadline_ms": 180_000,
                "num_workers": 99,
            }
        }
        self.assertGreaterEqual(service._request_timeout_seconds(request), 180)
        self.assertLessEqual(service._request_timeout_seconds(request), 285)
        self.assertEqual(service._request_workers(request), 6)

    def test_270_second_compute_plus_watchdog_reserve_stops_at_285_wrapper(self) -> None:
        request = {
            "settings": {
                "reference_watchdog_deadline_ms": 290_000,
            }
        }
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(service._request_timeout_seconds(request), 285.0)

    def test_legacy_service_timeout_environment_cannot_exceed_285_seconds(self) -> None:
        request = {
            "settings": {
                "reference_watchdog_deadline_ms": 360_000,
            }
        }
        for legacy_seconds in (320, 330, 360, 900):
            with self.subTest(legacy_seconds=legacy_seconds), mock.patch.dict(
                os.environ,
                {"TKB_CLOUD_RUN_MAX_SOLVE_SECONDS": str(legacy_seconds)},
                clear=False,
            ):
                self.assertEqual(service._request_timeout_seconds(request), 285.0)

    def test_default_client_timeout_stays_below_cloud_request_limit(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(client._timeout_seconds(), 295.0)

    def test_rust_or_legacy_client_timeout_cannot_exceed_295_seconds(self) -> None:
        for requested_seconds in (295, 320, 330, 360, 900):
            with self.subTest(requested_seconds=requested_seconds), mock.patch.dict(
                os.environ,
                {"TKB_CLOUD_RUN_TIMEOUT_SECONDS": str(requested_seconds)},
                clear=False,
            ):
                self.assertEqual(client._timeout_seconds(), 295.0)

        with mock.patch.dict(
            os.environ,
            {"TKB_CLOUD_RUN_TIMEOUT_SECONDS": "90"},
            clear=False,
        ):
            self.assertEqual(client._timeout_seconds(), 90.0)

    def test_error_wrapper_preserves_structured_contract(self) -> None:
        wrapper = service._error_wrapper(504, "cloud_solver_timeout", "detail")
        self.assertEqual(wrapper["status"], 504)
        self.assertEqual(wrapper["payload"]["kind"], "cloud_solver_timeout")
        self.assertEqual(
            wrapper["payload"]["solver"]["backend"], "google-cloud-run"
        )

    def test_client_requires_https_by_default(self) -> None:
        previous = client.os.environ.get("TKB_CLOUD_RUN_URL")
        client.os.environ["TKB_CLOUD_RUN_URL"] = "http://localhost:8080"
        client.os.environ.pop("TKB_CLOUD_RUN_ALLOW_HTTP", None)
        try:
            with self.assertRaisesRegex(RuntimeError, "HTTPS"):
                client._cloud_url()
        finally:
            if previous is None:
                client.os.environ.pop("TKB_CLOUD_RUN_URL", None)
            else:
                client.os.environ["TKB_CLOUD_RUN_URL"] = previous

    def test_client_requires_a_pinned_solver_digest(self) -> None:
        previous = client.os.environ.pop("TKB_CLOUD_RUN_SOLVER_DIGEST", None)
        allow_previous = client.os.environ.pop(
            "TKB_CLOUD_RUN_ALLOW_UNPINNED_DIGEST", None
        )
        try:
            with self.assertRaisesRegex(RuntimeError, "64-character build digest"):
                client._expected_digest()
            client.os.environ["TKB_CLOUD_RUN_SOLVER_DIGEST"] = "a" * 64
            self.assertEqual(client._expected_digest(), "a" * 64)
        finally:
            if previous is not None:
                client.os.environ["TKB_CLOUD_RUN_SOLVER_DIGEST"] = previous
            else:
                client.os.environ.pop("TKB_CLOUD_RUN_SOLVER_DIGEST", None)
            if allow_previous is not None:
                client.os.environ["TKB_CLOUD_RUN_ALLOW_UNPINNED_DIGEST"] = (
                    allow_previous
                )

    def test_client_binds_identity_audience_to_service_url(self) -> None:
        previous = client.os.environ.get("TKB_CLOUD_RUN_AUDIENCE")
        client.os.environ["TKB_CLOUD_RUN_AUDIENCE"] = "https://attacker.example"
        try:
            with self.assertRaisesRegex(RuntimeError, "exactly match"):
                client._request_headers(
                    "https://solver-abc.run.app/solve", "a" * 64
                )
        finally:
            if previous is None:
                client.os.environ.pop("TKB_CLOUD_RUN_AUDIENCE", None)
            else:
                client.os.environ["TKB_CLOUD_RUN_AUDIENCE"] = previous

    def test_stop_probe_headers_are_complete_and_host_pinned(self) -> None:
        token = "e" * 64
        with mock.patch.dict(
            client.os.environ,
            {
                "TKB_CLOUD_RUN_ALLOW_UNAUTHENTICATED": "1",
                "TKB_CLOUD_RUN_JOB_ID": "job-123",
                "TKB_CLOUD_STOP_PROBE_URL": (
                    "https://tkbcherry.com/api/internal/solver-stop-probe"
                ),
                "TKB_CLOUD_STOP_PROBE_TOKEN": token,
            },
            clear=False,
        ):
            headers = client._request_headers(
                "https://solver-abc.run.app/solve", "a" * 64
            )
        self.assertEqual(headers["X-TKB-Stop-Probe-Job"], "job-123")
        self.assertEqual(headers["X-TKB-Stop-Probe-Token"], token)

        with mock.patch.dict(
            client.os.environ,
            {
                "TKB_CLOUD_RUN_JOB_ID": "job-123",
                "TKB_CLOUD_STOP_PROBE_URL": (
                    "https://attacker.example/api/internal/solver-stop-probe"
                ),
                "TKB_CLOUD_STOP_PROBE_TOKEN": token,
            },
            clear=False,
        ):
            with self.assertRaisesRegex(RuntimeError, "approved callback"):
                client._stop_probe_headers()

    def test_cloud_service_rejects_partial_or_external_stop_probe(self) -> None:
        with self.assertRaisesRegex(ValueError, "incomplete"):
            service._stop_probe_config(
                {"X-TKB-Stop-Probe-Job": "job-only"}
            )
        with self.assertRaisesRegex(ValueError, "not_allowed"):
            service._stop_probe_config(
                {
                    "X-TKB-Stop-Probe-Job": "job-1",
                    "X-TKB-Stop-Probe-Url": (
                        "https://attacker.example/api/internal/solver-stop-probe"
                    ),
                    "X-TKB-Stop-Probe-Token": "f" * 64,
                }
            )

    def test_client_mints_wif_identity_token_without_a_service_account_key(self) -> None:
        service_account = (
            "tkb-cloud-run-invoker@project-test.iam.gserviceaccount.com"
        )

        class Credentials:
            token = None

            def refresh(self, _request) -> None:
                self.token = "short-lived-federated-access-token"

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args) -> None:
                return None

            def read(self, _limit: int) -> bytes:
                return json.dumps({"token": "header.payload.signature"}).encode()

        google = types.ModuleType("google")
        google.__path__ = []
        auth = types.ModuleType("google.auth")
        auth.__path__ = []
        transport = types.ModuleType("google.auth.transport")
        transport.__path__ = []
        requests = types.ModuleType("google.auth.transport.requests")
        requests.Request = object
        auth.default = lambda scopes: (Credentials(), None)
        transport.requests = requests
        auth.transport = transport
        google.auth = auth
        modules = {
            "google": google,
            "google.auth": auth,
            "google.auth.transport": transport,
            "google.auth.transport.requests": requests,
        }
        captured = {}

        def open_request(request, timeout):
            captured["url"] = request.full_url
            captured["authorization"] = request.get_header("Authorization")
            captured["body"] = json.loads(request.data)
            captured["timeout"] = timeout
            return Response()

        with (
            mock.patch.dict(client.sys.modules, modules),
            mock.patch.dict(
                client.os.environ,
                {"TKB_CLOUD_RUN_SERVICE_ACCOUNT": service_account},
                clear=False,
            ),
            mock.patch.object(client.urllib.request, "urlopen", open_request),
        ):
            token = client._workload_identity_token(
                "https://solver-abc.run.app"
            )

        self.assertEqual(token, "header.payload.signature")
        self.assertIn(service_account, captured["url"])
        self.assertEqual(
            captured["authorization"],
            "Bearer short-lived-federated-access-token",
        )
        self.assertEqual(
            captured["body"],
            {"audience": "https://solver-abc.run.app", "includeEmail": True},
        )
        self.assertEqual(captured["timeout"], 30.0)

    @staticmethod
    def _fake_google_modules(id_token_calls: list[str]):
        class Credentials:
            token = "federated-access-token"

            def refresh(self, _request) -> None:
                return None

        google = types.ModuleType("google")
        google.__path__ = []
        auth = types.ModuleType("google.auth")
        auth.__path__ = []
        transport = types.ModuleType("google.auth.transport")
        transport.__path__ = []
        requests = types.ModuleType("google.auth.transport.requests")
        requests.Request = lambda: None
        oauth2 = types.ModuleType("google.oauth2")
        oauth2.__path__ = []
        id_token = types.ModuleType("google.oauth2.id_token")

        def fetch_id_token(_request, audience):
            id_token_calls.append(audience)
            raise RuntimeError("metadata server ping timed out")

        id_token.fetch_id_token = fetch_id_token
        auth.default = lambda scopes: (Credentials(), None)
        transport.requests = requests
        auth.transport = transport
        oauth2.id_token = id_token
        google.auth = auth
        google.oauth2 = oauth2
        return {
            "google": google,
            "google.auth": auth,
            "google.auth.transport": transport,
            "google.auth.transport.requests": requests,
            "google.oauth2": oauth2,
            "google.oauth2.id_token": id_token,
        }

    def test_wif_credentials_skip_the_metadata_server_ping(self) -> None:
        id_token_calls: list[str] = []
        with tempfile.TemporaryDirectory() as folder:
            adc = Path(folder) / "credentials.json"
            adc.write_text(json.dumps({"type": "external_account"}), encoding="utf-8")
            with (
                mock.patch.dict(client.sys.modules, self._fake_google_modules(id_token_calls)),
                mock.patch.dict(
                    client.os.environ,
                    {"GOOGLE_APPLICATION_CREDENTIALS": str(adc)},
                    clear=False,
                ),
                mock.patch.object(
                    client, "_workload_identity_token", return_value="a.b.c"
                ) as wif,
            ):
                self.assertEqual(client._identity_token("https://sin.example.run.app"), "a.b.c")
        self.assertEqual(id_token_calls, [])
        wif.assert_called_once_with("https://sin.example.run.app")

    def test_iam_error_keeps_googles_reason(self) -> None:
        body = json.dumps(
            {"error": {"code": 404, "message": "Account disabled: 281501759244137"}}
        ).encode("utf-8")

        def refuse(request, timeout):
            raise client.urllib.error.HTTPError(
                request.full_url, 404, "Not Found", {}, io.BytesIO(body)
            )

        with (
            mock.patch.dict(client.sys.modules, self._fake_google_modules([])),
            mock.patch.dict(
                client.os.environ,
                {"TKB_CLOUD_RUN_SERVICE_ACCOUNT": "inv@p.iam.gserviceaccount.com"},
                clear=False,
            ),
            mock.patch.object(client.urllib.request, "urlopen", refuse),
        ):
            with self.assertRaisesRegex(RuntimeError, "HTTP 404: Account disabled"):
                client._workload_identity_token("https://sin.example.run.app")

    def test_auth_failure_stops_before_trying_other_regions(self) -> None:
        minted: list[str] = []

        def no_token(audience: str) -> str:
            minted.append(audience)
            raise client.CloudRunAuthError("IAM Credentials HTTP 404: Account disabled")

        env = {
            "TKB_CLOUD_RUN_URL": "https://sin.example.run.app",
            "TKB_CLOUD_RUN_FALLBACK_URLS": "https://jkt.example.run.app,https://tpe.example.run.app",
            "TKB_CLOUD_RUN_SOLVER_DIGEST": "d" * 64,
        }
        with mock.patch.dict(client.os.environ, env, clear=False), mock.patch.object(
            client, "_read_request", return_value=b'{"data":{}}'
        ), mock.patch.object(client, "_identity_token", side_effect=no_token), mock.patch.object(
            client.urllib.request, "urlopen", side_effect=AssertionError("must not dispatch")
        ), mock.patch.object(client.sys, "stderr", io.StringIO()):
            with self.assertRaisesRegex(RuntimeError, "cloud_run_auth_unavailable.*Account disabled"):
                client.solve()
        # One identity serves every region: the same refusal would repeat, so
        # the Rust coordinator gets the failure at once (early VPS fallback).
        self.assertEqual(minted, ["https://sin.example.run.app"])

    def _run_client_solve_with_regions(self, responders, fallback_urls: str):
        """Drive client.solve() against fake per-URL responders.

        ``responders`` maps a service URL (without /solve) to either an
        exception instance to raise from urlopen or a wrapper dict to stream.
        Returns (calls, stdout, stderr).
        """
        digest = "d" * 64
        calls: list[str] = []

        class Response:
            def __init__(self, wrapper):
                self.headers = {
                    "X-TKB-Cloud-Protocol": client.CLOUD_PROTOCOL,
                    "X-TKB-Solver-Digest": digest,
                }
                self._wrapper = wrapper

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def __iter__(self):
                yield (client.RESULT_PREFIX + json.dumps(self._wrapper)).encode("utf-8")

        def fake_urlopen(request, timeout=None):
            url = request.full_url.rsplit("/solve", 1)[0]
            calls.append(url)
            outcome = responders[url]
            if isinstance(outcome, Exception):
                raise outcome
            return Response(outcome)

        env = {
            "TKB_CLOUD_RUN_URL": "https://jkt.example.run.app",
            "TKB_CLOUD_RUN_FALLBACK_URLS": fallback_urls,
            "TKB_CLOUD_RUN_SOLVER_DIGEST": digest,
            "TKB_CLOUD_RUN_ALLOW_UNAUTHENTICATED": "1",
        }
        body = json.dumps({"data": {}}).encode("utf-8")
        with mock.patch.dict(client.os.environ, env, clear=False), mock.patch.object(
            client, "_read_request", return_value=body
        ), mock.patch.object(
            client.urllib.request, "urlopen", side_effect=fake_urlopen
        ), mock.patch.object(client.sys, "stdout", io.StringIO()) as stdout, mock.patch.object(
            client.sys, "stderr", io.StringIO()
        ) as stderr:
            result = client.solve()
        return calls, stdout.getvalue(), stderr.getvalue(), result

    @staticmethod
    def _http_error(url: str, code: int, body: str):
        return client.urllib.error.HTTPError(
            url + "/solve", code, "refused", {}, io.BytesIO(body.encode("utf-8"))
        )

    def test_client_moves_to_next_region_when_cloud_run_has_no_instance(self) -> None:
        digest = "d" * 64
        wrapper = {
            "status": 200,
            "payload": {"ok": True, "solver": {"runtime_settings": {"cloud_solver_digest": digest}}},
        }
        jkt, sin, tpe = (
            "https://jkt.example.run.app",
            "https://sin.example.run.app",
            "https://tpe.example.run.app",
        )
        calls, stdout, stderr, result = self._run_client_solve_with_regions(
            {
                jkt: self._http_error(jkt, 429, "The request was aborted because there was no available instance."),
                sin: self._http_error(sin, 409, json.dumps({"error": "cloud_solver_digest_mismatch"})),
                tpe: wrapper,
            },
            f"{sin}/, {tpe}, {jkt}, http://plain.example",
        )
        self.assertEqual(result, 0)
        self.assertEqual(calls, [jkt, sin, tpe])
        self.assertTrue(json.loads(stdout)["payload"]["ok"])
        self.assertIn("jkt.example.run.app refused with HTTP 429", stderr)
        self.assertIn("sin.example.run.app refused with HTTP 409", stderr)
        self.assertIn("served by fallback region tpe.example.run.app", stderr)

    def test_client_reports_last_region_error_when_every_region_is_busy(self) -> None:
        jkt, sin = "https://jkt.example.run.app", "https://sin.example.run.app"
        with self.assertRaisesRegex(RuntimeError, "HTTP 429"):
            self._run_client_solve_with_regions(
                {
                    jkt: self._http_error(jkt, 429, "no available instance"),
                    sin: self._http_error(sin, 429, "no available instance"),
                },
                sin,
            )

    def test_client_does_not_retry_non_capacity_errors_on_another_region(self) -> None:
        jkt, sin = "https://jkt.example.run.app", "https://sin.example.run.app"
        recorded: list[str] = []

        def fake_urlopen(request, timeout=None):
            recorded.append(request.full_url)
            raise self._http_error(jkt, 400, json.dumps({"error": "cloud_protocol_mismatch"}))

        env = {
            "TKB_CLOUD_RUN_URL": jkt,
            "TKB_CLOUD_RUN_FALLBACK_URLS": sin,
            "TKB_CLOUD_RUN_SOLVER_DIGEST": "d" * 64,
            "TKB_CLOUD_RUN_ALLOW_UNAUTHENTICATED": "1",
        }
        with mock.patch.dict(client.os.environ, env, clear=False), mock.patch.object(
            client, "_read_request", return_value=b'{"data":{}}'
        ), mock.patch.object(client.urllib.request, "urlopen", side_effect=fake_urlopen), mock.patch.object(
            client.sys, "stderr", io.StringIO()
        ):
            with self.assertRaisesRegex(RuntimeError, "HTTP 400"):
                client.solve()
        # A protocol/config error is not a capacity answer: no second region.
        self.assertEqual(recorded, [jkt + "/solve"])

    def test_fallback_urls_skip_primary_duplicates_and_insecure_entries(self) -> None:
        with mock.patch.dict(
            client.os.environ,
            {
                "TKB_CLOUD_RUN_FALLBACK_URLS": " https://sin.example.run.app/ ,https://jkt.example.run.app, http://x.example, https://sin.example.run.app,,https://tpe.example.run.app"
            },
            clear=False,
        ):
            client.os.environ.pop("TKB_CLOUD_RUN_ALLOW_HTTP", None)
            self.assertEqual(
                client._fallback_urls("https://jkt.example.run.app"),
                ["https://sin.example.run.app/solve", "https://tpe.example.run.app/solve"],
            )

    def test_client_rejects_stale_service_digest_and_accepts_matching_wrapper(self) -> None:
        digest = "b" * 64
        wrapper = {
            "status": 200,
            "payload": {
                "ok": True,
                "solver": {
                    "runtime_settings": {"cloud_solver_digest": digest}
                },
            },
        }

        class Response:
            def __init__(self, advertised: str):
                self.headers = {
                    "X-TKB-Cloud-Protocol": client.CLOUD_PROTOCOL,
                    "X-TKB-Solver-Digest": advertised,
                }

            def __iter__(self):
                yield (
                    client.RESULT_PREFIX + json.dumps(wrapper)
                ).encode("utf-8")

        with self.assertRaisesRegex(RuntimeError, "does not match"):
            client._forward_stream(Response("c" * 64), digest)
        with mock.patch.object(client.sys, "stdout", io.StringIO()) as stdout:
            client._forward_stream(Response(digest), digest)
            self.assertTrue(json.loads(stdout.getvalue())["payload"]["ok"])

    def test_local_service_streams_progress_and_terminal_wrapper(self) -> None:
        fake_solver = """import json, sys
body = sys.stdin.read()
print('@@TKB_PROGRESS@@' + json.dumps({'protocol':'tkb-reference-solver-progress-v1','stage':'result:complete','status':200}), file=sys.stderr, flush=True)
print('@@TKB_RESULT@@' + json.dumps({'status':200,'payload':{'ok':True,'lessons':[],'metrics':{'scheduled_periods':0}}}), flush=True)
"""
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / "fake_solver.py"
            script.write_text(fake_solver, encoding="utf-8")
            previous = {
                key: os.environ.get(key)
                for key in (
                    "TKB_REFERENCE_SOLVER_SCRIPT",
                    "TKB_CLOUD_RUN_QUIET",
                    "TKB_CLOUD_RUN_MAX_SOLVE_SECONDS",
                    "TKB_CLOUD_RUN_SOLVER_DIGEST",
                )
            }
            os.environ["TKB_REFERENCE_SOLVER_SCRIPT"] = str(script)
            os.environ["TKB_CLOUD_RUN_QUIET"] = "1"
            os.environ["TKB_CLOUD_RUN_MAX_SOLVE_SECONDS"] = "30"
            os.environ["TKB_CLOUD_RUN_SOLVER_DIGEST"] = "d" * 64
            server = ThreadingHTTPServer(("127.0.0.1", 0), service.CloudSolverHandler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                payload = {"data": {}, "settings": {"backend_deadline_ms": 1000}}
                request = Request(
                    f"http://127.0.0.1:{server.server_port}/solve",
                    data=json.dumps(payload).encode("utf-8"),
                    headers={
                        "Content-Type": "application/json",
                        "X-TKB-Cloud-Protocol": service.CLOUD_PROTOCOL,
                    },
                    method="POST",
                )
                with urlopen(request, timeout=10) as response:
                    self.assertEqual(
                        response.headers["X-TKB-Solver-Digest"], "d" * 64
                    )
                    lines = response.read().decode("utf-8").splitlines()
                self.assertTrue(any(line.startswith(service.PROGRESS_PREFIX) for line in lines))
                terminal = [
                    line for line in lines if line.startswith(service.RESULT_PREFIX)
                ]
                self.assertEqual(len(terminal), 1)
                wrapper = json.loads(terminal[0][len(service.RESULT_PREFIX) :])
                self.assertEqual(wrapper["status"], 200)
                self.assertTrue(wrapper["payload"]["ok"])
                self.assertEqual(
                    wrapper["payload"]["solver"]["runtime_settings"][
                        "cloud_solver_digest"
                    ],
                    "d" * 64,
                )
            finally:
                server.shutdown()
                thread.join(timeout=2)
                server.server_close()
                for key, value in previous.items():
                    if value is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = value

    def test_local_cloud_service_cancel_signals_solver_stop_file(self) -> None:
        # 23/08 (chu du an: "nut Dung khong dung duoc"): HUY (cancelRequested)
        # cung phai dat file dung cho bo giai, khong chi ngung tham do.
        fake_solver = """import json, os, pathlib, sys, time
sys.stdin.read()
stop_file = pathlib.Path(os.environ['TKB_SOLVER_STOP_FILE'])
deadline = time.monotonic() + 5
while time.monotonic() < deadline and not stop_file.exists():
    time.sleep(0.02)
seen = stop_file.exists()
print('@@TKB_RESULT@@' + json.dumps({'status':200,'payload':{'ok':True,'lessons':[],'metrics':{'scheduled_periods':0},'solver':{'runtime_settings':{'cancel_stop_seen':seen}}}}), flush=True)
"""

        class CancelProbeHandler(BaseHTTPRequestHandler):
            calls = 0

            def log_message(self, _format, *_args) -> None:
                return None

            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length", "0"))
                self.rfile.read(length)
                type(self).calls += 1
                body = json.dumps(
                    {
                        "ok": True,
                        "known": True,
                        "stopRequested": False,
                        "cancelRequested": True,
                    }
                ).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / "fake_solver.py"
            script.write_text(fake_solver, encoding="utf-8")
            probe_server = ThreadingHTTPServer(("127.0.0.1", 0), CancelProbeHandler)
            cloud_server = ThreadingHTTPServer(
                ("127.0.0.1", 0), service.CloudSolverHandler
            )
            probe_thread = threading.Thread(
                target=probe_server.serve_forever, daemon=True
            )
            cloud_thread = threading.Thread(
                target=cloud_server.serve_forever, daemon=True
            )
            previous = {
                key: os.environ.get(key)
                for key in (
                    "TKB_REFERENCE_SOLVER_SCRIPT",
                    "TKB_CLOUD_RUN_QUIET",
                    "TKB_CLOUD_RUN_MAX_SOLVE_SECONDS",
                    "TKB_CLOUD_RUN_SOLVER_DIGEST",
                    "TKB_CLOUD_STOP_PROBE_ALLOW_LOCAL_HTTP",
                )
            }
            os.environ.update(
                {
                    "TKB_REFERENCE_SOLVER_SCRIPT": str(script),
                    "TKB_CLOUD_RUN_QUIET": "1",
                    "TKB_CLOUD_RUN_MAX_SOLVE_SECONDS": "30",
                    "TKB_CLOUD_RUN_SOLVER_DIGEST": "f" * 64,
                    "TKB_CLOUD_STOP_PROBE_ALLOW_LOCAL_HTTP": "1",
                }
            )
            probe_thread.start()
            cloud_thread.start()
            try:
                token = "b" * 64
                callback = (
                    f"http://127.0.0.1:{probe_server.server_port}"
                    "/api/internal/solver-stop-probe"
                )
                payload = {
                    "data": {},
                    "settings": {"backend_deadline_ms": 5_000},
                }
                request = Request(
                    f"http://127.0.0.1:{cloud_server.server_port}/solve",
                    data=json.dumps(payload).encode("utf-8"),
                    headers={
                        "Content-Type": "application/json",
                        "X-TKB-Cloud-Protocol": service.CLOUD_PROTOCOL,
                        "X-TKB-Stop-Probe-Job": "cancel-job",
                        "X-TKB-Stop-Probe-Url": callback,
                        "X-TKB-Stop-Probe-Token": token,
                    },
                    method="POST",
                )
                started = time.monotonic()
                with urlopen(request, timeout=10) as response:
                    lines = response.read().decode("utf-8").splitlines()
                elapsed = time.monotonic() - started
                terminal = next(
                    line for line in lines if line.startswith(service.RESULT_PREFIX)
                )
                wrapper = json.loads(terminal[len(service.RESULT_PREFIX) :])
                self.assertTrue(
                    wrapper["payload"]["solver"]["runtime_settings"][
                        "cancel_stop_seen"
                    ]
                )
                self.assertLess(elapsed, 4.0)
                self.assertGreaterEqual(CancelProbeHandler.calls, 1)
            finally:
                cloud_server.shutdown()
                probe_server.shutdown()
                cloud_thread.join(timeout=2)
                probe_thread.join(timeout=2)
                cloud_server.server_close()
                probe_server.server_close()
                for key, value in previous.items():
                    if value is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = value

    def test_local_cloud_service_soft_stop_reaches_solver_stop_file(self) -> None:
        fake_solver = """import json, os, pathlib, sys, time
sys.stdin.read()
stop_file = pathlib.Path(os.environ['TKB_SOLVER_STOP_FILE'])
deadline = time.monotonic() + 5
while time.monotonic() < deadline and not stop_file.exists():
    time.sleep(0.02)
seen = stop_file.exists()
print('@@TKB_RESULT@@' + json.dumps({'status':200,'payload':{'ok':True,'lessons':[],'metrics':{'scheduled_periods':0},'solver':{'runtime_settings':{'soft_stop_seen':seen}}}}), flush=True)
"""

        class StopProbeHandler(BaseHTTPRequestHandler):
            calls = 0
            received = None

            def log_message(self, _format, *_args) -> None:
                return None

            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length", "0"))
                type(self).received = json.loads(self.rfile.read(length))
                type(self).calls += 1
                body = json.dumps(
                    {
                        "ok": True,
                        "known": True,
                        "stopRequested": True,
                        "cancelRequested": False,
                    }
                ).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / "fake_solver.py"
            script.write_text(fake_solver, encoding="utf-8")
            probe_server = ThreadingHTTPServer(("127.0.0.1", 0), StopProbeHandler)
            cloud_server = ThreadingHTTPServer(
                ("127.0.0.1", 0), service.CloudSolverHandler
            )
            probe_thread = threading.Thread(
                target=probe_server.serve_forever, daemon=True
            )
            cloud_thread = threading.Thread(
                target=cloud_server.serve_forever, daemon=True
            )
            previous = {
                key: os.environ.get(key)
                for key in (
                    "TKB_REFERENCE_SOLVER_SCRIPT",
                    "TKB_CLOUD_RUN_QUIET",
                    "TKB_CLOUD_RUN_MAX_SOLVE_SECONDS",
                    "TKB_CLOUD_RUN_SOLVER_DIGEST",
                    "TKB_CLOUD_STOP_PROBE_ALLOW_LOCAL_HTTP",
                )
            }
            os.environ.update(
                {
                    "TKB_REFERENCE_SOLVER_SCRIPT": str(script),
                    "TKB_CLOUD_RUN_QUIET": "1",
                    "TKB_CLOUD_RUN_MAX_SOLVE_SECONDS": "30",
                    "TKB_CLOUD_RUN_SOLVER_DIGEST": "f" * 64,
                    "TKB_CLOUD_STOP_PROBE_ALLOW_LOCAL_HTTP": "1",
                }
            )
            probe_thread.start()
            cloud_thread.start()
            try:
                token = "a" * 64
                callback = (
                    f"http://127.0.0.1:{probe_server.server_port}"
                    "/api/internal/solver-stop-probe"
                )
                payload = {
                    "data": {},
                    "settings": {"backend_deadline_ms": 5_000},
                }
                request = Request(
                    f"http://127.0.0.1:{cloud_server.server_port}/solve",
                    data=json.dumps(payload).encode("utf-8"),
                    headers={
                        "Content-Type": "application/json",
                        "X-TKB-Cloud-Protocol": service.CLOUD_PROTOCOL,
                        "X-TKB-Stop-Probe-Job": "soft-stop-job",
                        "X-TKB-Stop-Probe-Url": callback,
                        "X-TKB-Stop-Probe-Token": token,
                    },
                    method="POST",
                )
                with urlopen(request, timeout=10) as response:
                    lines = response.read().decode("utf-8").splitlines()
                terminal = next(
                    line for line in lines if line.startswith(service.RESULT_PREFIX)
                )
                wrapper = json.loads(terminal[len(service.RESULT_PREFIX) :])
                self.assertTrue(
                    wrapper["payload"]["solver"]["runtime_settings"][
                        "soft_stop_seen"
                    ]
                )
                self.assertGreaterEqual(StopProbeHandler.calls, 1)
                self.assertEqual(StopProbeHandler.received["jobId"], "soft-stop-job")
                self.assertEqual(StopProbeHandler.received["token"], token)
            finally:
                cloud_server.shutdown()
                probe_server.shutdown()
                cloud_thread.join(timeout=2)
                probe_thread.join(timeout=2)
                cloud_server.server_close()
                probe_server.server_close()
                for key, value in previous.items():
                    if value is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = value


if __name__ == "__main__":
    unittest.main()
