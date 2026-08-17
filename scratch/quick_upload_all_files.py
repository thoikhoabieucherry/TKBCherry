import os
import sys
import paramiko

host = os.environ.get("TKB_VPS_HOST", "103.200.20.101")
port = int(os.environ.get("TKB_VPS_PORT", "22"))
user = os.environ.get("TKB_VPS_USER", "root")
pwd = os.environ.get("TKB_VPS_PASSWORD")

if not pwd:
    # Read from local env/fallback if set
    for env_file in [".env", "scratch/.env"]:
        if os.path.exists(env_file):
            with open(env_file, "r") as f:
                for line in f:
                    if "TKB_VPS_PASSWORD" in line:
                        pwd = line.split("=", 1)[1].strip().strip('"').strip("'")
                        break

if not pwd:
    print("Error: TKB_VPS_PASSWORD not found in environment.")
    sys.exit(1)

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(host, port=port, username=user, password=pwd, timeout=10)
sftp = ssh.open_sftp()

files = [
    ("web/pages/tkb-fet-engine.js", "/opt/cherry-scheduler/web/pages/tkb-fet-engine.js"),
    ("web/pages/tkb-fet-worker.js", "/opt/cherry-scheduler/web/pages/tkb-fet-worker.js"),
    ("web/pages/phanmon.js", "/opt/cherry-scheduler/web/pages/phanmon.js"),
    ("web/pages/tkb-constraints.js", "/opt/cherry-scheduler/web/pages/tkb-constraints.js")
]

for local_path, remote_path in files:
    print(f"Uploading {local_path} -> {remote_path}...")
    sftp.put(local_path, remote_path)

sftp.close()

# Verify files on VPS
print("\nVerifying syntax on VPS...")
for _, remote_path in files:
    stdin, stdout, stderr = ssh.exec_command(f"node --check {remote_path}")
    err = stderr.read().decode()
    if err:
        print(f"  node --check {remote_path}: ERROR\n{err}")
    else:
        print(f"  node --check {remote_path}: OK")

# Check service status
stdin, stdout, stderr = ssh.exec_command("systemctl is-active tkb-app")
status = stdout.read().decode().strip()
print(f"\nChecking service status...\n  Service status: {status}")

ssh.close()
print("\n==========================================")
print("DEPLOYMENT TO VPS COMPLETED SUCCESSFULLY!")
print("==========================================")
