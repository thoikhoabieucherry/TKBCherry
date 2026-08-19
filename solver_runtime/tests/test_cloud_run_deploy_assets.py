from __future__ import annotations

import os
import json
from pathlib import Path
import shutil
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[2]
CLOUD_RUN = ROOT / "tools" / "cloud-run"


class CloudRunDeployAssetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.script = (CLOUD_RUN / "deploy.ps1").read_text(encoding="utf-8")
        cls.dockerfile = (CLOUD_RUN / "Dockerfile").read_text(encoding="utf-8")
        cls.cloudbuild = (CLOUD_RUN / "cloudbuild.yaml").read_text(
            encoding="utf-8"
        )
        cls.ignore = (CLOUD_RUN / ".gcloudignore").read_text(encoding="utf-8")
        cls.client = (
            ROOT / "solver_runtime" / "scripts" / "cloud_run_client.py"
        ).read_text(encoding="utf-8")
        cls.service = (
            ROOT / "solver_runtime" / "scripts" / "cloud_run_service.py"
        ).read_text(encoding="utf-8")
        cls.usage_timer = (
            CLOUD_RUN / "tkb-google-cloud-usage.timer"
        ).read_text(encoding="utf-8")

    def test_powershell_script_parses(self) -> None:
        powershell = shutil.which("pwsh") or shutil.which("powershell")
        if not powershell:
            self.skipTest("PowerShell is not installed")
        environment = os.environ.copy()
        environment["TKB_TEST_PS1"] = str(CLOUD_RUN / "deploy.ps1")
        command = (
            "$tokens=$null; $errors=$null; "
            "[System.Management.Automation.Language.Parser]::ParseFile("
            "$env:TKB_TEST_PS1,[ref]$tokens,[ref]$errors) | Out-Null; "
            "if ($errors.Count -ne 0) { "
            "$errors | ForEach-Object { Write-Error $_.Message }; exit 1 }"
        )
        result = subprocess.run(
            [powershell, "-NoProfile", "-NonInteractive", "-Command", command],
            capture_output=True,
            check=False,
            env=environment,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_script_refuses_to_run_without_explicit_confirmation(self) -> None:
        powershell = shutil.which("pwsh") or shutil.which("powershell")
        if not powershell:
            self.skipTest("PowerShell is not installed")
        result = subprocess.run(
            [
                powershell,
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(CLOUD_RUN / "deploy.ps1"),
                "-ProjectId",
                "tkb-test-project-123",
            ],
            capture_output=True,
            check=False,
            text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("No changes made", result.stderr)

    def test_minimal_build_context_is_constructed_without_tests_or_secrets(self) -> None:
        powershell = shutil.which("pwsh") or shutil.which("powershell")
        if not powershell:
            self.skipTest("PowerShell is not installed")
        result = subprocess.run(
            [
                powershell,
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(CLOUD_RUN / "deploy.ps1"),
                "-ProjectId",
                "tkb-test-project-123",
                "-ConfirmDeployment",
                "-ValidateBuildContext",
            ],
            capture_output=True,
            check=False,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertTrue(report["ok"])
        self.assertFalse(report["includesTests"])
        self.assertRegex(report["solverDigest"], r"^[0-9a-f]{64}$")
        self.assertGreater(report["files"], 10)

    def test_script_has_explicit_target_and_cost_guardrails(self) -> None:
        self.assertIn("[Parameter(Mandatory = $true)]", self.script)
        self.assertIn("[string]$ProjectId", self.script)
        self.assertIn("[string]$Region = 'asia-southeast2'", self.script)
        self.assertIn("[ValidateRange(1, 50)]", self.script)
        self.assertIn("[int]$MaxInstances = 3", self.script)
        self.assertIn("[switch]$ConfirmDeployment", self.script)
        self.assertIn("billingEnabled", self.script)

    def test_script_enables_required_apis_and_remote_build(self) -> None:
        for api in (
            "artifactregistry.googleapis.com",
            "cloudbuild.googleapis.com",
            "iamcredentials.googleapis.com",
            "monitoring.googleapis.com",
            "run.googleapis.com",
        ):
            self.assertIn(api, self.script)
        self.assertIn("'builds', 'submit'", self.script)
        self.assertIn("--ignore-file=$buildIgnoreFile", self.script)
        self.assertIn(
            "--substitutions=_IMAGE=$image,_SOLVER_DIGEST=$solverDigest",
            self.script,
        )

    def test_build_uses_a_minimal_allowlisted_context_and_source_digest(self) -> None:
        self.assertIn("function New-MinimalCloudBuildContext", self.script)
        self.assertIn("solver_runtime\\scripts\\solve_stdio.py", self.script)
        self.assertIn("solver_runtime\\scripts\\cloud_run_service.py", self.script)
        self.assertIn("solver_runtime\\src", self.script)
        self.assertNotIn("'solver_runtime\\tests'", self.script)
        self.assertIn("function Get-SolverSourceDigest", self.script)
        self.assertIn("TKB_CLOUD_RUN_SOLVER_DIGEST=$solverDigest", self.script)
        self.assertIn("TKB_SOLVER_DIGEST=${_SOLVER_DIGEST}", self.cloudbuild)

    def test_service_is_private_and_solver_resources_are_fixed(self) -> None:
        for option in (
            "--cpu=6",
            "--memory=8Gi",
            "--concurrency=1",
            "--timeout=300",
            "--min-instances=0",
            "--max-instances=$MaxInstances",
            "--no-traffic",
            "--tag=$canaryTag",
            "--no-allow-unauthenticated",
        ):
            self.assertIn(option, self.script)
        self.assertNotIn("'--allow-unauthenticated'", self.script)
        self.assertIn("roles/run.invoker", self.script)
        self.assertIn("roles/run.viewer", self.script)
        self.assertIn("[string]$RuntimeServiceAccount", self.script)
        self.assertIn("--service-account=$RuntimeServiceAccount", self.script)
        self.assertIn(
            "--labels=app=tkb-cherry,component=solver,runtime=cloud-run",
            self.script,
        )
        self.assertIn("TKB_CLOUD_RUN_MAX_SOLVE_SECONDS=285", self.script)
        self.assertIn("'update-traffic'", self.script)
        self.assertIn('"--to-revisions=$newRevision=100"', self.script)
        self.assertNotIn("'--to-latest'", self.script)

    def test_release_canaries_exact_revision_before_promoting_and_rolls_back(self) -> None:
        self.assertIn("function Get-RevisionTrafficSpec", self.script)
        self.assertIn("$oldTrafficSpec = Get-RevisionTrafficSpec", self.script)
        self.assertIn("function Assert-CloudRunRevision", self.script)
        self.assertIn("latestCreatedRevisionName", self.script)
        self.assertIn("latestReadyRevisionName", self.script)
        self.assertIn("TKB_CLOUD_RUN_SOLVER_DIGEST", self.script)
        self.assertIn("function Invoke-AuthenticatedCloudRunCanary", self.script)
        self.assertIn("'auth', 'print-identity-token'", self.script)
        self.assertIn("Invoke-WebRequest", self.script)
        self.assertIn("X-TKB-Solver-Digest", self.script)
        self.assertIn("X-TKB-Solver-Revision", self.script)
        self.assertIn("'X-TKB-Cloud-Protocol'", self.script)
        self.assertIn("'/solve'", self.script)
        self.assertIn("scheduled_periods", self.script)
        self.assertIn("one_period_teacher_sessions", self.script)
        self.assertIn("gap_distribution", self.script)
        canary_index = self.script.index("    Invoke-AuthenticatedCloudRunCanary `")
        promote_index = self.script.index('"--to-revisions=$newRevision=100"')
        self.assertLess(canary_index, promote_index)
        capture_index = self.script.index(
            "$oldTrafficSpec = Get-RevisionTrafficSpec"
        )
        deploy_index = self.script.index("Invoke-Gcloud -Arguments $deployArguments")
        self.assertLess(capture_index, deploy_index)
        self.assertIn('"--to-revisions=$oldTrafficSpec"', self.script)
        self.assertIn('"--remove-tags=$canaryTag"', self.script)
        self.assertIn("$canaryTagObserved = $true", self.script)

    def test_script_never_creates_or_prints_long_lived_credentials(self) -> None:
        lowered = self.script.lower()
        for forbidden in (
            "print-access-token",
            "service-accounts keys create",
            "auth application-default login",
        ):
            self.assertNotIn(forbidden, lowered)

    def test_cloud_timing_chain_is_fail_closed_below_300_seconds(self) -> None:
        self.assertIn("CLOUD_RUN_SOLVER_TIMEOUT_CAP_SECONDS: Final = 285", self.service)
        self.assertIn("CLOUD_RUN_HTTP_TIMEOUT_CAP_SECONDS: Final = 295.0", self.client)
        self.assertIn(
            "min(CLOUD_RUN_HTTP_TIMEOUT_CAP_SECONDS, max(30.0, value))",
            self.client,
        )
        self.assertIn("TKB_CLOUD_RUN_MAX_SOLVE_SECONDS=285", self.dockerfile)
        self.assertIn("--timeout=300", self.script)

    def test_docker_image_is_non_root_and_bounded(self) -> None:
        self.assertIn("FROM python:3.12-slim", self.dockerfile)
        self.assertIn("TKB_CLOUD_RUN_MAX_WORKERS=6", self.dockerfile)
        self.assertIn("TKB_CLOUD_RUN_MAX_SOLVE_SECONDS=285", self.dockerfile)
        self.assertIn("USER tkb", self.dockerfile)
        self.assertIn("EXPOSE 8080", self.dockerfile)
        self.assertIn("cloud_run_service.py", self.dockerfile)

    def test_cloud_build_uses_declared_dockerfile_and_image(self) -> None:
        self.assertIn("gcr.io/cloud-builders/docker", self.cloudbuild)
        self.assertIn("tools/cloud-run/Dockerfile", self.cloudbuild)
        self.assertGreaterEqual(self.cloudbuild.count("${_IMAGE}"), 2)
        self.assertIn("CLOUD_LOGGING_ONLY", self.cloudbuild)

    def test_build_context_excludes_local_credentials_and_tests(self) -> None:
        for pattern in (
            ".git",
            ".env",
            "**/*.key",
            "**/*.pem",
            "**/*.p12",
            "**/*.pfx",
            "**/*.sqlite",
            "**/*.xlsx",
            "**/*credentials*.json",
            "**/*service-account*.json",
            "solver_runtime/tests",
        ):
            self.assertIn(pattern, self.ignore)

    def test_google_usage_timer_refreshes_every_ten_minutes(self) -> None:
        self.assertIn("Description=Refresh TKB Cherry Google Cloud usage every 10 minutes", self.usage_timer)
        self.assertIn("OnBootSec=30s", self.usage_timer)
        self.assertIn("OnUnitActiveSec=10min", self.usage_timer)
        self.assertIn("AccuracySec=1s", self.usage_timer)
        self.assertIn("RandomizedDelaySec=0", self.usage_timer)


if __name__ == "__main__":
    unittest.main()
