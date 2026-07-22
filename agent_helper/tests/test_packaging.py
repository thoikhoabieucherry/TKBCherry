from __future__ import annotations

import unittest
from pathlib import Path

from agent_helper import VERSION
from agent_helper.relocation import default_install_dir


AGENT_ROOT = Path(__file__).resolve().parents[1]


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
        self.assertIn('"--hidden-import", "pystray._win32"', script)
        self.assertIn('"--hidden-import", "tkinter"', script)
        self.assertIn('"--hidden-import", "_tkinter"', script)
        self.assertIn('"--hidden-import", "PIL.PngImagePlugin"', script)
        for package in ("numpy", "scipy", "ortools", "openpyxl", "pystray"):
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


if __name__ == "__main__":
    unittest.main()
