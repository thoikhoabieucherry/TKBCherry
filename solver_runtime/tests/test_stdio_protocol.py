from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


RUNTIME_ROOT = Path(__file__).resolve().parents[1]
SOLVE_SCRIPT = RUNTIME_ROOT / "scripts" / "solve_stdio.py"
WSL_SOLVE_SCRIPT = RUNTIME_ROOT / "scripts" / "wsl_solve.py"
PROTOCOL = "tkb-reference-solver-stdio-v1"
PROGRESS_PROTOCOL = "tkb-reference-solver-progress-v1"
PROGRESS_PREFIX = b"@@TKB_PROGRESS@@"


class StdioProtocolTests(unittest.TestCase):
    @unittest.skipIf(os.name == "nt", "WSL wrapper uses Linux process limits")
    def test_wsl_wrapper_preserves_protocol_and_resource_environment(self) -> None:
        environment = dict(os.environ)
        environment.update(
            {
                "TKB_AGENT_SOLVER_RUN_ID": "a" * 32,
                "TKB_SOLVER_MAX_MEMORY_MB": "4096",
                "TKB_SOLVER_HARD_TIMEOUT_SECONDS": "30",
                "TKB_SOLVER_MAX_WORKERS": "2",
            }
        )
        completed = subprocess.run(
            [sys.executable, str(WSL_SOLVE_SCRIPT), "solve"],
            input=b"",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=RUNTIME_ROOT,
            env=environment,
            check=False,
            timeout=40,
        )

        self.assertEqual(
            completed.returncode,
            0,
            completed.stderr.decode("utf-8", errors="replace"),
        )
        wrapper = json.loads(completed.stdout.decode("utf-8"))
        self.assertEqual(wrapper["protocol"], PROTOCOL)
        self.assertEqual(wrapper["status"], 400)
        self.assertEqual(completed.stdout.count(b"\n"), 1)

    def test_solve_entrypoint_emits_one_framed_json_document(self) -> None:
        completed = subprocess.run(
            [sys.executable, str(SOLVE_SCRIPT), "solve"],
            input=b"",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=RUNTIME_ROOT,
            check=False,
            timeout=30,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr.decode("utf-8", errors="replace"))
        wrapper = json.loads(completed.stdout.decode("utf-8"))
        self.assertEqual(wrapper["protocol"], PROTOCOL)
        self.assertEqual(wrapper["status"], 400)
        self.assertIsInstance(wrapper["payload"], dict)
        self.assertEqual(completed.stdout.count(b"\n"), 1)
        progress_frames = [
            json.loads(line[len(PROGRESS_PREFIX) :].decode("utf-8"))
            for line in completed.stderr.splitlines()
            if line.startswith(PROGRESS_PREFIX)
        ]
        self.assertGreaterEqual(len(progress_frames), 2)
        self.assertEqual(progress_frames[0]["protocol"], PROGRESS_PROTOCOL)
        self.assertEqual(progress_frames[0]["stage"], "runtime:loading")
        self.assertEqual(progress_frames[-1]["stage"], "result:error")

    def test_progress_frames_use_stderr_and_monotonic_sequence(self) -> None:
        child_code = "\n".join(
            [
                "from scripts import solve_stdio",
                "solve_stdio.emit_progress({'stage': 'session:model', 'message': 'model'})",
                "solve_stdio.emit_progress({'stage': 'session:solve', 'iteration': 2})",
            ]
        )
        completed = subprocess.run(
            [sys.executable, "-c", child_code],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=RUNTIME_ROOT,
            check=False,
            timeout=30,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr.decode("utf-8", errors="replace"))
        self.assertEqual(completed.stdout, b"")
        progress_frames = [
            json.loads(line[len(PROGRESS_PREFIX) :].decode("utf-8"))
            for line in completed.stderr.splitlines()
            if line.startswith(PROGRESS_PREFIX)
        ]
        self.assertEqual([frame["stage"] for frame in progress_frames], ["session:model", "session:solve"])
        self.assertEqual([frame["sequence"] for frame in progress_frames], [1, 2])
        self.assertTrue(all(frame["protocol"] == PROGRESS_PROTOCOL for frame in progress_frames))
        self.assertTrue(all(isinstance(frame["elapsedMs"], int) for frame in progress_frames))
        self.assertTrue(all(isinstance(frame["emittedAtMs"], int) for frame in progress_frames))

    def test_fd_level_stdout_noise_is_quarantined_to_stderr(self) -> None:
        child_code = "\n".join(
            [
                "import os",
                "from scripts import solve_stdio as protocol",
                "protocol._install_stdout_protocol_guard()",
                "os.write(1, b'native-before\\n')",
                "protocol.write_json({'ok': True, 'source': 'protocol'})",
                "os.write(1, b'native-after\\n')",
            ]
        )
        completed = subprocess.run(
            [sys.executable, "-c", child_code],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=RUNTIME_ROOT,
            check=False,
            timeout=30,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr.decode("utf-8", errors="replace"))
        wrapper = json.loads(completed.stdout.decode("utf-8"))
        self.assertEqual(wrapper["protocol"], PROTOCOL)
        self.assertEqual(wrapper["payload"], {"ok": True, "source": "protocol"})
        self.assertNotIn(b"native-", completed.stdout)
        self.assertIn(b"native-before", completed.stderr)
        self.assertIn(b"native-after", completed.stderr)

    def test_result_wrapper_is_flushed_before_optional_artifact_logging(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            order_path = Path(temp_dir) / "order.txt"
            child_code = "\n".join(
                [
                    "from pathlib import Path",
                    "from scripts import solve_stdio as protocol",
                    "protocol._install_stdout_protocol_guard()",
                    f"order = Path({str(order_path)!r})",
                    "original_write = protocol._write_protocol_value",
                    "def write(value):",
                    "    order.write_text('wire\\n', encoding='utf-8')",
                    "    original_write(value)",
                    "def save(payload, status):",
                    "    with order.open('a', encoding='utf-8') as stream:",
                    "        stream.write('artifact\\n')",
                    "protocol._write_protocol_value = write",
                    "protocol._save_solve_artifacts = save",
                    "protocol.write_json({'ok': True}, 200)",
                ]
            )
            completed = subprocess.run(
                [sys.executable, "-c", child_code],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=RUNTIME_ROOT,
                check=False,
                timeout=30,
            )

            self.assertEqual(
                completed.returncode,
                0,
                completed.stderr.decode("utf-8", errors="replace"),
            )
            wrapper = json.loads(completed.stdout.decode("utf-8"))
            self.assertEqual(wrapper["status"], 200)
            self.assertEqual(
                order_path.read_text(encoding="utf-8").splitlines(),
                ["wire", "artifact"],
            )

    def test_no_logs_disables_sensitive_solver_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            child_code = "\n".join(
                [
                    "from pathlib import Path",
                    "from scripts import solve_stdio",
                    f"solve_stdio.ROOT = Path({temp_dir!r})",
                    "solve_stdio.CURRENT_REQUEST_BODY = b'{}'",
                    "solve_stdio._save_solve_artifacts({'error': 'test'}, 500)",
                ]
            )
            env = dict(os.environ)
            env["TKB_NO_LOGS"] = "1"
            env.pop("TKB_SAVE_SOLVE_ARTIFACTS", None)
            completed = subprocess.run(
                [sys.executable, "-c", child_code],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=RUNTIME_ROOT,
                env=env,
                check=False,
                timeout=30,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr.decode("utf-8", errors="replace"))
            self.assertFalse((Path(temp_dir) / "logs").exists())


if __name__ == "__main__":
    unittest.main()
