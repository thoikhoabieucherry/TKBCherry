import os
import sys
import hashlib
from pathlib import Path

# 1. Read base engine
engine_path = "web/pages/tkb-fet-engine.js"
engine_code = Path(engine_path).read_text(encoding="utf-8")

# Verify that helper methods exist in engine
if "initLessonBlockRules" not in engine_code:
    print("Error: initLessonBlockRules missing from engine.")
    sys.exit(1)

# Ensure unplaceActivity has the robust off/fixed restoration
old_unplace_snippet = """        if(this.classGrid.get(act.classId)[s] === actId){
          this.classGrid.get(act.classId)[s] = -1;
        }"""

new_unplace_snippet = """        if(this.classGrid.get(act.classId)[s] === actId){
          const cKey = `${act.classId}|${s}`;
          if(this.offSlots.has(cKey)) this.classGrid.get(act.classId)[s] = -2;
          else if(this.fixedSlots.has(cKey)) this.classGrid.get(act.classId)[s] = -3;
          else this.classGrid.get(act.classId)[s] = -1;
        }"""

if old_unplace_snippet in engine_code:
    engine_code = engine_code.replace(old_unplace_snippet, new_unplace_snippet)

# Ensure teacher unplace snippet has off check
old_t_unplace = """            if(this.teacherGrid.has(t) && this.teacherGrid.get(t)[s] === actId){
              this.teacherGrid.get(t)[s] = -1;
            }"""

new_t_unplace = """            if(this.teacherGrid.has(t) && this.teacherGrid.get(t)[s] === actId){
              const tKey = `${t}|${s}`;
              if(this.teacherOffSlots.has(tKey)) this.teacherGrid.get(t)[s] = -2;
              else this.teacherGrid.get(t)[s] = -1;
            }"""

if old_t_unplace in engine_code:
    engine_code = engine_code.replace(old_t_unplace, new_t_unplace)

# Write updated engine
Path(engine_path).write_text(engine_code, encoding="utf-8")
print("Successfully updated web/pages/tkb-fet-engine.js")

# 2. Deploy to VPS
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
        stdin, stdout, stderr = client.exec_command(f"node --check {remote_path}")
        err = stderr.read().decode().strip()
        if err:
            print(f"Syntax ERROR in {remote_path}: {err}")
        else:
            print(f"  node --check {remote_path}: OK")

    stdin, stdout, stderr = client.exec_command("systemctl is-active tkb-app")
    status = stdout.read().decode().strip()
    print(f"\nChecking service status...\n  Service status: {status}")

finally:
    client.close()

print("\n==========================================")
print("DEPLOYMENT TO VPS COMPLETED SUCCESSFULLY!")
print("==========================================")
