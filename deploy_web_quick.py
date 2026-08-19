import sys
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')
import paramiko

TOOLS_DIR = Path(r"C:\Users\Love\Documents\Codex\TKBCherry\tools\vps-deploy")
sys.path.insert(0, str(TOOLS_DIR))
from vps_credentials import resolve_vps_connection

FILES = [
    (r"C:\Users\Love\Documents\Codex\TKBCherry\web\app.js", "/opt/cherry-scheduler/web/app.js"),
    (r"C:\Users\Love\Documents\Codex\TKBCherry\web\shared\storage.js", "/opt/cherry-scheduler/web/shared/storage.js"),
    (r"C:\Users\Love\Documents\Codex\TKBCherry\web\app.html", "/opt/cherry-scheduler/web/app.html"),
    (r"C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js", "/opt/cherry-scheduler/web/pages/tkb-fet-engine.js"),
    (r"C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-worker.js", "/opt/cherry-scheduler/web/pages/tkb-fet-worker.js"),
    (r"C:\Users\Love\Documents\Codex\TKBCherry\web\pages\phanmon.js", "/opt/cherry-scheduler/web/pages/phanmon.js"),
    (r"C:\Users\Love\Documents\Codex\TKBCherry\web\pages\phanmon.css", "/opt/cherry-scheduler/web/pages/phanmon.css"),
    (r"C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-rust-bridge.js", "/opt/cherry-scheduler/web/pages/tkb-rust-bridge.js"),
    (r"C:\Users\Love\Documents\Codex\TKBCherry\web\pages\sapxep.html", "/opt/cherry-scheduler/web/pages/sapxep.html"),
]

SOLVER_DIRS = [
    (r"C:\Users\Love\Documents\Codex\TKBCherry\solver_runtime\src", "/opt/cherry-scheduler/solver_runtime/src"),
]
SOLVER_FILES = [
    (r"C:\Users\Love\Documents\Codex\TKBCherry\solver_runtime\scripts\solve_stdio.py", "/opt/cherry-scheduler/solver_runtime/scripts/solve_stdio.py"),
    (r"C:\Users\Love\Documents\Codex\TKBCherry\solver_runtime\scripts\cloud_run_client.py", "/opt/cherry-scheduler/solver_runtime/scripts/cloud_run_client.py"),
    (r"C:\Users\Love\Documents\Codex\TKBCherry\solver_runtime\scripts\cloud_run_service.py", "/opt/cherry-scheduler/solver_runtime/scripts/cloud_run_service.py"),
]


def _put_tree(sftp, local_root, remote_root):
    from pathlib import Path as _P
    count = 0
    for path in _P(local_root).rglob("*"):
        if path.is_dir():
            if path.name == "__pycache__":
                continue
            continue
        if "__pycache__" in path.parts:
            continue
        if path.suffix.lower() not in (".py", ".json"):
            continue
        rel = path.relative_to(local_root).as_posix()
        remote = f"{remote_root}/{rel}"
        parent = remote.rsplit("/", 1)[0]
        try:
            sftp.stat(parent)
        except IOError:
            acc = ""
            for part in parent.strip("/").split("/"):
                acc += "/" + part
                try:
                    sftp.stat(acc)
                except IOError:
                    sftp.mkdir(acc)
        sftp.put(str(path), remote)
        count += 1
    return count


def main():
    host, user, password = resolve_vps_connection()
    print(f"Ket noi VPS {host}...")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=password, timeout=30)
    sftp = client.open_sftp()
    for local, remote in FILES:
        print(f"  {Path(local).name} -> {remote}")
        sftp.put(local, remote)
    print("Dong bo solver_runtime (lane du phong tren VPS)...")
    for local, remote in SOLVER_FILES:
        print(f"  {Path(local).name} -> {remote}")
        sftp.put(local, remote)
    for local_root, remote_root in SOLVER_DIRS:
        n = _put_tree(sftp, local_root, remote_root)
        print(f"  {n} file .py/.json -> {remote_root}")
    sftp.close()
    print("Restart tkb-app...")
    _, out, _ = client.exec_command("systemctl restart tkb-app && systemctl is-active tkb-app")
    print("Trang thai:", out.read().decode().strip())
    client.close()
    print("\nDEPLOY XONG! Mo tkbcherry.com va nhan Ctrl+F5.")

if __name__ == "__main__":
    main()
