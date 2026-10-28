"""Cherry tự cập nhật phần engine — 28/10/2026 (chủ dự án: "bạn phải chuẩn bị nếu có cập nhật thêm
tính năng cho Cherry.exe nha").

Bộ cài ghi app/update-url.txt (mặc định https://tkbcherry.netlify.app/download/cherry-latest.json).
90 s sau khi bật rồi mỗi 6 giờ: đọc cherry-latest.json {build, runtime, app, sha256, size}.
  - cùng build            -> không làm gì;
  - khác build, cùng bộ Python (runtime-id) -> tải cherry-app-<build>.zip (~1 MB), kiểm kích thước +
    SHA-256, giải nén ra <thư mục cài>/app.new, đợi lúc RẢNH (không có lượt xếp), chạy script đổi thư
    mục ẩn rồi tự thoát; script đợi tiến trình này thoát, đổi app.new -> app (giữ logs), bật lại bộ giải;
  - khác bộ Python        -> chỉ báo (khay + /api/health "update": "installer"): tải Cherry.exe mới.
Chỉ nhận https:// (hoặc http://127.0.0.1 khi thử nghiệm). CHERRY_UPDATE=0 tắt hẳn.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import zipfile
from pathlib import Path
from typing import Callable
from urllib.parse import urljoin, urlsplit

MAX_APP_BYTES = 64 * 1024 * 1024


def read_id(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def _ps_quote(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def url_allowed(url: str) -> bool:
    parts = urlsplit(url)
    if parts.scheme == "https" and parts.hostname:
        return True
    return parts.scheme == "http" and parts.hostname in ("127.0.0.1", "localhost")


SWAP_PS1 = r"""
# __VALUES__ (Updater.apply ghi gia tri vao day — khong truyen qua dong lenh: PowerShell 5.1
# doc sai dau ngoac kep trong tham so -File)
function Write-Log($m) { try { Add-Content -Path $Log -Value ((Get-Date -Format "yyyy-MM-dd HH:mm:ss") + " " + $m) -Encoding UTF8 } catch {} }
Write-Log "cap nhat: doi tien trinh $WaitPid thoat"
try { Wait-Process -Id $WaitPid -Timeout 60 -ErrorAction SilentlyContinue } catch {}
Write-Log "cap nhat: tien trinh cu da thoat"
Start-Sleep -Milliseconds 600
$app = Join-Path $Dest "app"; $new = Join-Path $Dest "app.new"; $old = Join-Path $Dest "app.old"
try {
    if (Test-Path $old) { Remove-Item $old -Recurse -Force }
    $logs = Join-Path $app "logs"
    if (Test-Path $logs) { Move-Item $logs (Join-Path $new "logs") -Force }
    Rename-Item $app "app.old"
    Rename-Item $new "app"
    $un = Join-Path $Dest "uninstall.ps1.new"
    if (Test-Path $un) { Move-Item $un (Join-Path $Dest "uninstall.ps1") -Force }
    Write-Log "cap nhat: da doi sang ban moi"
} catch {
    Write-Log ("cap nhat LOI: " + $_.Exception.Message)
    if ((-not (Test-Path $app)) -and (Test-Path $old)) { Rename-Item $old "app" }
}
Start-Process -FilePath $Exe -ArgumentList $ArgList -WorkingDirectory $app -WindowStyle Hidden
Write-Log "cap nhat: da bat lai bo giai"
Start-Sleep -Seconds 2
if (Test-Path $old) { Remove-Item $old -Recurse -Force -ErrorAction SilentlyContinue }
"""


class Updater:
    def __init__(
        self,
        app_dir: Path,
        is_busy: Callable[[], bool],
        log: Callable[[str], None],
        restart_args: list[str],
    ) -> None:
        self.app_dir = Path(app_dir)
        self.dest = self.app_dir.parent
        self.url = read_id(self.app_dir / "update-url.txt")
        self.build = read_id(self.app_dir / "build-id.txt")
        self.runtime = read_id(self.dest / "python" / "runtime-id.txt")
        self.is_busy = is_busy
        self.log = log
        self.restart_args = list(restart_args)
        self.notify: Callable[[str], None] | None = None
        self.on_restart: Callable[[], None] | None = None
        self.status = "idle"
        self.latest: dict | None = None
        self.checked_at: float | None = None
        self.error = ""
        self._notified_build = ""
        self._stop = threading.Event()
        self.delay = float(os.environ.get("CHERRY_UPDATE_DELAY_S") or 90)
        self.interval = float(os.environ.get("CHERRY_UPDATE_INTERVAL_S") or 6 * 3600)

    def enabled(self) -> bool:
        return bool(self.url and self.build and url_allowed(self.url) and os.environ.get("CHERRY_UPDATE", "1") != "0")

    def info(self) -> dict:
        out = {"build": self.build, "runtime": self.runtime, "update": self.status}
        if self.latest:
            out["latestBuild"] = self.latest.get("build")
        return out

    def start(self) -> None:
        if self.enabled():
            threading.Thread(target=self._loop, name="cherry-updater", daemon=True).start()

    def stop(self) -> None:
        self._stop.set()

    def _loop(self) -> None:
        if self._stop.wait(self.delay):
            return
        while not self._stop.is_set():
            try:
                self.check_once()
            except Exception as exc:  # noqa: BLE001 - cập nhật không bao giờ được làm sập bộ giải
                self.status, self.error = "error", repr(exc)[:200]
                self.log(f"cap nhat: loi {self.error}")
            if self.status == "ready":
                self._apply_when_idle()
                return
            if self._stop.wait(self.interval):
                return

    def _fetch(self, url: str, limit: int) -> bytes:
        if not url_allowed(url):
            raise ValueError(f"dia chi cap nhat khong hop le: {url}")
        req = urllib.request.Request(url, headers={"User-Agent": f"Cherry/{self.build}", "Cache-Control": "no-cache"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read(limit + 1)
        if len(data) > limit:
            raise ValueError("tep cap nhat qua lon")
        return data

    def check_once(self) -> str:
        self.checked_at = time.time()
        latest = json.loads(self._fetch(self.url, 64 * 1024).decode("utf-8"))
        self.latest = latest
        build = str(latest.get("build") or "").strip()
        runtime = str(latest.get("runtime") or "").strip()
        if not build or build == self.build:
            self.status = "current"
            return self.status
        if runtime != self.runtime:
            self.status = "installer"
            if self._notified_build != build:
                self._notified_build = build
                self.log(f"cap nhat: ban {build} can bo Python moi -> bao tai Cherry.exe")
                if self.notify:
                    try:
                        self.notify("Có bản Cherry mới — tải Cherry.exe trên trang TKB để cập nhật.")
                    except Exception:
                        pass
            return self.status
        self.status = "downloading"
        size = int(latest.get("size") or 0)
        if not (0 < size <= MAX_APP_BYTES):
            raise ValueError("kich thuoc goi cap nhat khong hop le")
        blob = self._fetch(urljoin(self.url, str(latest.get("app") or "")), size)
        if len(blob) != size or hashlib.sha256(blob).hexdigest() != str(latest.get("sha256") or "").lower():
            raise ValueError("goi cap nhat sai kich thuoc / SHA-256")
        self._stage(blob, build)
        self.status = "ready"
        self.log(f"cap nhat: da tai ban {build}, cho luc ranh de doi")
        return self.status

    def _stage(self, blob: bytes, build: str) -> None:
        new_dir = self.dest / "app.new"
        if new_dir.exists():
            shutil.rmtree(new_dir)
        with tempfile.TemporaryDirectory(prefix="cherry-upd-", dir=str(self.dest)) as tmp:
            tmp_path = Path(tmp)
            zpath = tmp_path / "app.zip"
            zpath.write_bytes(blob)
            out = tmp_path / "x"
            with zipfile.ZipFile(zpath) as zf:
                for name in zf.namelist():
                    target = (out / name).resolve()
                    if not str(target).startswith(str(out.resolve())) or name.startswith(("/", "\\")):
                        raise ValueError(f"duong dan la trong goi: {name}")
                zf.extractall(out)
            staged = out / "app"
            if not (staged / "cherry_local_solver.py").exists() or read_id(staged / "build-id.txt") != build:
                raise ValueError("goi cap nhat thieu tep / sai ma ban")
            shutil.move(str(staged), str(new_dir))
            un = out / "uninstall.ps1"
            if un.exists():
                shutil.copy2(un, self.dest / "uninstall.ps1.new")

    def _apply_when_idle(self) -> None:
        while not self._stop.is_set():
            try:
                busy = bool(self.is_busy())
            except Exception:
                busy = True
            if not busy:
                self.apply()
                return
            self._stop.wait(5)

    def apply(self) -> None:
        script = Path(tempfile.gettempdir()) / "CherryUpdateSwap.ps1"
        args = [str(self.app_dir / "cherry_local_solver.py"), *self.restart_args]
        # Start-Process -ArgumentList (PS 5.1) noi cac phan bang dau cach, khong tu bao ngoac ->
        # phan co dau cach (vd ten nguoi dung co dau cach) phai tu bao "...".
        items = ", ".join(_ps_quote(f'"{a}"' if (" " in a or not a) else a) for a in args)
        values = "\n".join([
            f"$WaitPid = {os.getpid()}",
            f"$Dest = {_ps_quote(str(self.dest))}",
            f"$Exe = {_ps_quote(sys.executable)}",
            f"$ArgList = @({items})",
            f"$Log = {_ps_quote(str(self.app_dir / 'logs' / 'cherry.log'))}",
        ])
        text = SWAP_PS1.replace("# __VALUES__", values + "\n#", 1)
        script.write_bytes(text.replace("\r\n", "\n").replace("\n", "\r\n").encode("utf-8-sig"))
        cmd = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", str(script)]
        if os.name == "nt":
            # CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP (+ BREAKAWAY_FROM_JOB neu duoc). KHONG dung
            # DETACHED_PROCESS: PowerShell khong co console se chet ngay (do 29/10).
            base = 0x08000000 | 0x00000200
            try:
                subprocess.Popen(cmd, creationflags=base | 0x01000000, close_fds=True)
            except OSError:
                subprocess.Popen(cmd, creationflags=base, close_fds=True)
        else:
            subprocess.Popen(cmd, close_fds=True, start_new_session=True)
        self.log(f"cap nhat: khoi dong lai sang ban {(self.latest or {}).get('build')}")
        if self.on_restart:
            self.on_restart()
