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
    (r"C:\Users\Love\Documents\Codex\TKBCherry\web\pages\sapxep.html", "/opt/cherry-scheduler/web/pages/sapxep.html"),
    # 19/08: bridge phai di kem sapxep.html, neu khong 2 nut Cherry/Flash se khong gui duoc settings.engine
    (r"C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-rust-bridge.js", "/opt/cherry-scheduler/web/pages/tkb-rust-bridge.js"),
]

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
    sftp.close()
    print("Restart tkb-app...")
    _, out, _ = client.exec_command("systemctl restart tkb-app && systemctl is-active tkb-app")
    print("Trang thai:", out.read().decode().strip())
    client.close()
    print("\nDEPLOY XONG! Mo tkbcherry.com va nhan Ctrl+F5.")

if __name__ == "__main__":
    main()
