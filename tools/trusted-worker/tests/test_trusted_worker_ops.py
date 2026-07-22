from __future__ import annotations

import importlib.util
import io
import os
import stat
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[3]
TOOL_DIR = ROOT / "tools" / "trusted-worker"
CREDENTIAL_PATH = TOOL_DIR / "create-credential.py"
INSTALLER_PATH = TOOL_DIR / "install-linux.sh"
SERVICE_PATH = TOOL_DIR / "tkb-trusted-worker.service"


def load_credential_module():
    spec = importlib.util.spec_from_file_location(
        "trusted_worker_credential", CREDENTIAL_PATH
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TrustedWorkerCredentialTests(unittest.TestCase):
    def test_digest_matches_the_server_domain_separator(self) -> None:
        module = load_credential_module()
        token = "tkbt_" + "a" * 64
        self.assertEqual(
            module.trusted_token_digest(token),
            "9ff59de9d6ff4cbca5d383c646d4e61a3011fa30acf54db9a573f57706e5a03d",
        )

    def test_create_credential_is_exclusive_private_and_returns_only_digest(self) -> None:
        module = load_credential_module()
        token = "tkbt_" + "b" * 64
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "trusted-worker.env"
            digest = module.create_credential(output, token=token)
            self.assertEqual(output.read_text(encoding="ascii"), f"TKB_AGENT_TOKEN={token}\n")
            if os.name != "nt":
                self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
            self.assertNotIn(token, digest)
            with self.assertRaises(FileExistsError):
                module.create_credential(output)

    def test_cli_never_prints_the_raw_generated_bearer(self) -> None:
        module = load_credential_module()
        token = "tkbt_" + "c" * 64
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "trusted-worker.env"
            stdout = io.StringIO()
            with (
                patch.object(module.secrets, "token_urlsafe", return_value="c" * 64),
                patch("sys.argv", [str(CREDENTIAL_PATH), "--output", str(output)]),
                redirect_stdout(stdout),
            ):
                self.assertEqual(module.main(), 0)
            rendered = stdout.getvalue()
            self.assertIn("TKB_TRUSTED_AGENT_TOKEN_SHA256=", rendered)
            self.assertNotIn(token, rendered)


class TrustedWorkerInstallerContractTests(unittest.TestCase):
    def test_service_is_headless_single_capacity_and_hardened(self) -> None:
        service = SERVICE_PATH.read_text(encoding="utf-8")
        self.assertIn("User=tkb-trusted-worker", service)
        self.assertIn("EnvironmentFile=/etc/tkbcherry/trusted-worker.env", service)
        self.assertIn("ExecStartPre=", service)
        self.assertIn("--check --config", service)
        self.assertIn("--headless --config", service)
        self.assertIn("ProtectSystem=strict", service)
        self.assertIn("NoNewPrivileges=true", service)
        self.assertIn("KillMode=control-group", service)
        self.assertNotIn("TKB_AGENT_TOKEN=", service)

    def test_installer_never_accepts_or_embeds_the_bearer(self) -> None:
        installer = INSTALLER_PATH.read_text(encoding="utf-8")
        self.assertIn("--no-start", installer)
        self.assertIn("create-credential.py", installer)
        self.assertNotIn("--token", installer)
        self.assertNotIn("export TKB_AGENT_TOKEN=", installer)
        self.assertNotIn("Environment=TKB_AGENT_TOKEN=", installer)
        self.assertIn("find \"$SOURCE_ROOT/agent_helper\"", installer)
        self.assertIn("$SOURCE_ROOT/solver_runtime/src", installer)
        self.assertNotIn("cp -a -- \"$SOURCE_ROOT/\"", installer)


if __name__ == "__main__":
    unittest.main()
