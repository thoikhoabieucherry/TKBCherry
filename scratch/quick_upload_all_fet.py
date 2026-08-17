import sys
import hashlib
from pathlib import Path

sys.path.insert(0, str(Path("tools/vps-deploy").resolve()))
from deploy import new_ssh_client
from vps_credentials import resolve_vps_connection

host, user, pwd = resolve_vps_connection()
if not pwd:
    print("No VPS credentials found!")
    sys.exit(1)

client = new_ssh_client()
client.connect(host, username=user, password=pwd, timeout=30, banner_timeout=30)

files_to_upload = [
    ("web/pages/tkb-fet-engine.js", "/opt/cherry-scheduler/web/pages/tkb-fet-engine.js"),
    ("web/pages/tkb-fet-worker.js", "/opt/cherry-scheduler/web/pages/tkb-fet-worker.js"),
    ("web/pages/phanmon.js", "/opt/cherry-scheduler/web/pages/phanmon.js"),
    ("web/pages/tkb-constraints.js", "/opt/cherry-scheduler/web/pages/tkb-constraints.js"),
    ("web/pages/sapxep.html", "/opt/cherry-scheduler/web/pages/sapxep.html"),
]

try:
    sftp = client.open_sftp()
    for local_path, remote_path in files_to_upload:
        print(f"Uploading {local_path} -> {remote_path}...")
        sftp.put(local_path, remote_path)
        local_sha = hashlib.sha256(Path(local_path).read_bytes()).hexdigest()
        stdin, stdout, stderr = client.exec_command(f"sha256sum {remote_path}")
        remote_out = stdout.read().decode().strip()
        print(f"  Local:  {local_sha}")
        print(f"  Remote: {remote_out}")
    sftp.close()

    print("\nVerifying syntax on VPS...")
    for _, remote_path in files_to_upload:
        if not remote_path.endswith(".js"):
            continue
        stdin, stdout, stderr = client.exec_command(f"node --check {remote_path}")
        err = stderr.read().decode().strip()
        if err:
            print(f"Syntax ERROR in {remote_path}: {err}")
            sys.exit(1)
        else:
            print(f"  node --check {remote_path}: OK")

    print("\nChecking service status...")
    stdin, stdout, stderr = client.exec_command("systemctl is-active tkb-app")
    status = stdout.read().decode().strip()
    print(f"  Service status: {status}")

    print("\n==========================================")
    print("DEPLOYMENT TO VPS COMPLETED SUCCESSFULLY!")
    print("==========================================")
finally:
    client.close()
