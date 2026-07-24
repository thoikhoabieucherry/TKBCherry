from __future__ import annotations

import unittest
from pathlib import Path

from agent_helper import VERSION
from agent_helper.relocation import default_install_dir


AGENT_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = AGENT_ROOT.parent


class PackagingTests(unittest.TestCase):
    def test_windows_fixed_and_display_versions_match_runtime_version(self) -> None:
        version_info = (AGENT_ROOT / "windows_version_info.txt").read_text(
            encoding="utf-8"
        )
        parts = tuple(int(part) for part in VERSION.split("."))
        self.assertEqual(3, len(parts))
        fixed_tuple = f"({parts[0]}, {parts[1]}, {parts[2]}, 0)"
        self.assertIn(f"filevers={fixed_tuple}", version_info)
        self.assertIn(f"prodvers={fixed_tuple}", version_info)
        self.assertIn(f"StringStruct(u'FileVersion', u'{VERSION}')", version_info)
        self.assertIn(f"StringStruct(u'ProductVersion', u'{VERSION}')", version_info)

    def test_windows_build_is_onedir_and_contains_solver_assets(self) -> None:
        script = (AGENT_ROOT / "build_windows.ps1").read_text(encoding="utf-8")
        build_requirements = (AGENT_ROOT / "requirements-build.txt").read_text(
            encoding="utf-8"
        )
        self.assertIn('"--onedir"', script)
        self.assertIn('"--windowed"', script)
        self.assertIn('"--noupx"', script)
        self.assertIn('"--icon"', script)
        self.assertIn('"--version-file"', script)
        self.assertIn('$ExpectedVersionMarkers', script)
        self.assertIn('windows_version_info.txt does not match Agent', script)
        self.assertIn('"--onefile"', script)
        self.assertNotIn('"--console"', script)
        self.assertIn("solver_runtime\\scripts", script)
        self.assertIn("solver_runtime\\src", script)
        self.assertIn('"--hidden-import", "scipy.optimize"', script)
        self.assertIn('"--hidden-import", "scipy.sparse"', script)
        self.assertIn('"--hidden-import", "ortools.sat.python.cp_model"', script)
        self.assertIn('"--collect-binaries", "ortools"', script)
        self.assertNotIn('"--hidden-import", "pystray._win32"', script)
        self.assertIn('"--hidden-import", "tkinter"', script)
        self.assertIn('"--hidden-import", "_tkinter"', script)
        self.assertNotIn('"--hidden-import", "PIL.PngImagePlugin"', script)
        self.assertIn("Pillow", build_requirements)
        self.assertIn('"--exclude-module", "PIL"', script)
        self.assertIn("wsl_runtime\\solver_runtime\\scripts", script)
        self.assertIn("wsl_runtime\\solver_runtime\\src", script)
        self.assertIn("requirements-wsl.txt", script)
        self.assertIn('StartsWith("solver_runtime/"', script)
        self.assertIn("Build-only Pillow files entered the Agent runtime", script)
        self.assertIn("function Get-RelativePathCompat", script)
        self.assertIn(
            "Get-RelativePathCompat $SourceDirectory $SourceFile.FullName", script
        )
        self.assertNotIn("[System.IO.Path]::GetRelativePath", script)
        self.assertIn('-Filter "*.json" -Recurse', script)
        self.assertIn('$_.Extension -notin @(".py", ".json", ".txt")', script)
        for package in ("numpy", "scipy", "ortools", "openpyxl"):
            self.assertNotIn(f'"--collect-all", "{package}"', script)
        self.assertIn("favicon-cherry.png');agent_helper\\assets", script)
        self.assertIn('"TKBCherryAgent-Windows.zip"', script)
        self.assertIn('"TKBCherryAgent-release.json"', script)
        self.assertIn('"tools\\agent-release\\sign_release.py"', script)
        self.assertIn("compileall -b -f -q -o 2", script)
        self.assertIn("--gui-smoke", script)
        self.assertIn("Test-PackagedGui", script)
        self.assertIn('$StartInfo.EnvironmentVariables.Remove("TCL_LIBRARY")', script)
        self.assertIn('$StartInfo.EnvironmentVariables.Remove("TK_LIBRARY")', script)
        self.assertNotIn("--best --lzma --force", script)
        self.assertNotIn("upx-5.2.0-win64", script)
        self.assertIn("Test-PackagedSolverChild", script)
        self.assertIn('"tkb-reference-solver-stdio-v1"', script)
        self.assertIn("Compress-Archive -LiteralPath $StandaloneExecutable", script)
        self.assertIn('$ReleaseEntry.FullName -cne "TKBCherryAgent.exe"', script)
        self.assertIn("Standalone executable created at", script)
        self.assertIn("Signed release manifest created at", script)
        self.assertIn("[switch]$SkipReleaseSigning", script)
        self.assertIn("candidate ZIP/EXE must be signed before publication", script)
        self.assertIn("Remove-Item -LiteralPath $ReleaseManifest -Force", script)
        self.assertNotRegex(script, r"(?i)\$env:TKB_AGENT_TOKEN\s*=")
        self.assertNotRegex(script, r"(?i)(password|authorization)\s*=")
        self.assertNotRegex(script, r"(?i)Cai-TKBCherry-Agent\.(cmd|ps1)")

    def test_packaged_launcher_relocates_only_the_gui_executable(self) -> None:
        launcher = (AGENT_ROOT / "launcher.py").read_text(encoding="utf-8")
        relocation = (AGENT_ROOT / "relocation.py").read_text(encoding="utf-8")
        self.assertIn("maybe_relaunch_from_install_dir", launcher)
        self.assertIn('INSTALL_DIR_NAME = "TKBCherryAgent"', relocation)
        self.assertEqual(
            str(default_install_dir(environ={"SystemDrive": "C:"})),
            r"C:\TKBCherryAgent",
        )
        self.assertIn('HEADLESS_FLAGS = frozenset', relocation)
        self.assertIn('"--gui-smoke"', relocation)
        self.assertIn("stop_running_windows_executable", relocation)
        self.assertIn('["taskkill", "/PID", str(process_id), "/T", "/F"]', relocation)
        self.assertNotIn("TKB_AGENT_TOKEN", relocation)

    def test_windows_ci_builds_an_unprivileged_release_candidate(self) -> None:
        workflow = (
            REPOSITORY_ROOT / ".github" / "workflows" / "build-agent-windows.yml"
        ).read_text(encoding="utf-8")
        self.assertIn("workflow_dispatch:", workflow)
        self.assertIn("permissions:\n  contents: read", workflow)
        self.assertIn("runs-on: windows-2022", workflow)
        self.assertIn("-SkipReleaseSigning", workflow)
        self.assertIn("-m unittest discover -s agent_helper/tests -v", workflow)
        self.assertIn("TKBCherryAgent-Windows.zip", workflow)
        self.assertIn("TKBCherryAgent.exe", workflow)
        self.assertIn("actions/upload-artifact@", workflow)
        self.assertNotIn("TKB_AGENT_RELEASE_SIGNING_KEY", workflow)
        self.assertNotIn("TKB_VPS_PASSWORD", workflow)

    def test_release_signer_uses_dpapi_without_loading_native_crypto(self) -> None:
        signer = (
            REPOSITORY_ROOT / "tools" / "agent-release" / "sign_release.py"
        ).read_text(encoding="utf-8")
        self.assertIn("_windows_dpapi", signer)
        self.assertIn("_parse_pkcs8_rsa_private_key", signer)
        self.assertIn("_rsa_pkcs1_sha256_sign", signer)
        self.assertIn("RSA private key consistency check failed", signer)
        self.assertNotIn("from cryptography", signer)
        self.assertNotIn("import cryptography", signer)


if __name__ == "__main__":
    unittest.main()
