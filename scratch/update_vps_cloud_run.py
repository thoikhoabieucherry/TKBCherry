import sys
from pathlib import Path
sys.stdout.reconfigure(encoding='utf-8')
import paramiko

TOOLS_DIR = Path(r"C:\Users\Love\Documents\Codex\TKBCherry\tools\vps-deploy")
sys.path.insert(0, str(TOOLS_DIR))
from vps_credentials import resolve_vps_connection

NEW_DIGEST = "86f8a55b0c16390881e269e617e46feeddb8976b37741050443e0d4fb447b69c"
SERVICE_URL = "https://tkb-solver-tys7xrhbca-et.a.run.app"
NEW_PROFILE = '{"id":"cloud-run-project-61ee7855-507e-40a3-879","projectId":"project-61ee7855-507e-40a3-879","region":"asia-southeast2","url":"https://tkb-solver-tys7xrhbca-et.a.run.app","solverDigest":"' + NEW_DIGEST + '","budgetUsd":300,"infrastructureBudgetUsd":300,"estimatedCostUsd":0.06}'

CONF_CONTENT = f"""[Service]
Environment=GOOGLE_APPLICATION_CREDENTIALS=/root/.config/tkb-cherry/wif/credentials.json
Environment=TKB_CLOUD_RUN_SERVICE_ACCOUNT=tkb-cloud-run-invoker@project-61ee7855-507e-40a3-879.iam.gserviceaccount.com
Environment=TKB_CLOUD_RUN_TOKEN_CACHE_PATH=/run/tkb-cloud-run/id-token.json
Environment=TKB_CLOUD_RUN_URL={SERVICE_URL}
Environment=TKB_CLOUD_RUN_AUDIENCE={SERVICE_URL}
Environment=TKB_SERVERLESS_MODE=serverless_only
Environment=TKB_CLOUD_RUN_REGION=asia-southeast2
Environment=TKB_CLOUD_RUN_PROJECT_ID=project-61ee7855-507e-40a3-879
Environment=TKB_CLOUD_RUN_SOLVER_DIGEST={NEW_DIGEST}
Environment=TKB_CLOUD_RUN_ALLOW_UNPINNED_DIGEST=1
Environment='TKB_CLOUD_PROFILE={NEW_PROFILE}'
"""

def main():
    host, user, password = resolve_vps_connection()
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=password, timeout=30)
    
    sftp = client.open_sftp()
    with sftp.file("/etc/systemd/system/tkb-app.service.d/cloud-run.conf", "w") as f:
        f.write(CONF_CONTENT)
    sftp.close()
    print("Updated /etc/systemd/system/tkb-app.service.d/cloud-run.conf on VPS.")
    
    _, out, _ = client.exec_command("systemctl daemon-reload && systemctl restart tkb-app && systemctl is-active tkb-app")
    print("Trang thai tkb-app:", out.read().decode().strip())
    
    client.close()

if __name__ == "__main__":
    main()
