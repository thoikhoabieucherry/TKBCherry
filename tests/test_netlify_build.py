"""27/10: bản web không đăng nhập cho Netlify (tools/netlify-local/build_netlify.py).

Kiểm: app.html / sapxep.html dùng shared/auth-local.js thay bộ đăng nhập, storage.js đọc kho
trình duyệt, "/" vào thẳng /app, không đăng kèm file dữ liệu trường nào (bản V4 từng đăng
web/data/<mã>.json công khai), và từ chối dựng khi web/ có dữ liệu.
"""
from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools" / "netlify-local"))

import build_netlify  # noqa: E402


class NetlifyBuildTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.out = build_netlify.build(ROOT / "web", Path(cls.tmp.name) / "site")

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def read(self, rel):
        return (self.out / rel).read_text(encoding="utf-8")

    def test_app_uses_local_auth(self):
        html = self.read("app.html")
        self.assertIn("shared/auth-local.js", html)
        for gone in ("shared/auth-api.js", "shared/auth.js", "shared/runtime.js", "btnLogout", 'window.location.replace("/")'):
            self.assertNotIn(gone, html)
        self.assertIn("modules/local-schools.js", html)
        self.assertIn('onclick="localSchoolsOpen()"', html)

    def test_planner_uses_local_auth_and_budget(self):
        html = self.read("pages/sapxep.html")
        self.assertIn("../shared/auth-local.js", html)
        self.assertNotIn("../shared/auth.js", html)
        self.assertLess(html.index("tkb-rust-bridge.js"), html.index("local-planner.js"))

    def test_storage_reads_browser_store(self):
        self.assertIn("window.__cherryHostStore.readSchoolSync(schoolId)", self.read("shared/storage.js"))

    def test_root_goes_straight_to_app_and_noindex(self):
        redirects = self.read("_redirects")
        self.assertIn("/               /app                 302!", redirects)
        self.assertIn("/app            /app.html            200", redirects)
        self.assertIn("noindex", self.read("_headers"))
        self.assertIn("Disallow: /", self.read("robots.txt"))

    def test_proxies_only_login_and_solver_paths(self):
        # 30/10: nút gạt Máy chủ — chỉ đăng nhập + giải đi qua Netlify sang tkbcherry.com;
        # kho trường (/api/school/store, /api/local/schools) và /api/* chung không bao giờ.
        proxied = {}
        for line in self.read("_redirects").splitlines():
            parts = line.split()
            if len(parts) >= 3 and "tkbcherry.com" in parts[1]:
                proxied[parts[0]] = (parts[1], parts[2])
        self.assertEqual(set(proxied), set(build_netlify.SERVER_API_PATHS))
        for path, (target, status) in proxied.items():
            self.assertEqual(target, "https://tkbcherry.com" + path)
            self.assertEqual(status, "200")
        for never in ("/api/*", "/api/school/store", "/api/local/schools", "/api/auth/registry", "/api/auth/register"):
            self.assertNotIn(never, proxied)
        shim = self.read("shared/auth-local.js")
        for path in build_netlify.SERVER_API_PATHS:
            self.assertIn(f'"{path}"', shim, f"auth-local.js phải biết đường {path}")

    def test_no_school_data_shipped(self):
        files = [p.relative_to(self.out).as_posix() for p in self.out.rglob("*") if p.is_file()]
        self.assertFalse([f for f in files if f.startswith("data/") or f.endswith((".cherry", ".db", ".sqlite"))])
        shim = self.read("shared/auth-local.js")
        for literal in ('"/data/', "'/data/", "`/data/"):  # không tự nạp dữ liệu trường từ web
            self.assertNotIn(literal, shim)

    def test_refuses_web_with_school_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            web = Path(tmp) / "web"
            shutil.copytree(ROOT / "web", web)
            (web / "data").mkdir()
            (web / "data" / "abc.json").write_text("{}", encoding="utf-8")
            with self.assertRaises(SystemExit):
                build_netlify.build(web, Path(tmp) / "site")


class NetlifyInstallerDownloadTests(unittest.TestCase):
    def test_installer_served_from_download_as_attachment(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake = Path(tmp) / "CherrySetup.exe"
            fake.write_bytes(b"MZ-fake-installer")
            out = build_netlify.build(ROOT / "web", Path(tmp) / "site", fake)
            self.assertEqual((out / "download" / "Cherry.exe").read_bytes(), b"MZ-fake-installer")
            self.assertEqual((out / "download" / "CherrySetup.exe").read_bytes(), b"MZ-fake-installer")
            headers = (out / "_headers").read_text(encoding="utf-8")
            self.assertIn("/download/*", headers)
            self.assertIn("Content-Disposition: attachment", headers)

    def test_self_update_files_published_next_to_installer(self):
        # 28/10: Cherry da cai tu cap nhat tu /download/cherry-latest.json + goi app (updater.py).
        with tempfile.TemporaryDirectory() as tmp:
            fake = Path(tmp) / "Cherry.exe"
            fake.write_bytes(b"MZ-fake-installer")
            (Path(tmp) / "cherry-app-b1.zip").write_bytes(b"PK-fake-app")
            (Path(tmp) / "cherry-latest.json").write_text(
                '{"build": "b1", "runtime": "r1", "app": "cherry-app-b1.zip", "sha256": "x", "size": 11}', encoding="utf-8")
            out = build_netlify.build(ROOT / "web", Path(tmp) / "site", fake)
            self.assertEqual((out / "download" / "cherry-app-b1.zip").read_bytes(), b"PK-fake-app")
            self.assertIn('"build": "b1"', (out / "download" / "cherry-latest.json").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
