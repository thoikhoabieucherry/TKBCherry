import sys
import paramiko
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

TOOLS_DIR = Path(r"C:\Users\Love\Documents\Codex\TKBCherry\tools\vps-deploy")
sys.path.insert(0, str(TOOLS_DIR))
from vps_credentials import resolve_vps_connection

def apply_relaxed_budget_policy():
    engine_paths = [
        r"C:\Users\Love\Documents\Codex\MD\tkb-fet-engine.js",
        r"C:\Users\Love\Documents\Codex\TKBCherry\web\tkb-fet-engine.js",
        r"C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js"
    ]
    
    old_compare_chunk = """      if(mode === "optimize_gap2"){
        if(a.soBuoiDay1 !== b.soBuoiDay1) return a.soBuoiDay1 - b.soBuoiDay1;

        const budget = this.gap2SessionBudget || 0;
        const baseTs = this.initialMetricsSnapshot?.tsBuoiDay || 0;
        if(baseTs > 0){
          const aOver = a.tsBuoiDay > (baseTs + budget);
          const bOver = b.tsBuoiDay > (baseTs + budget);
          if(aOver !== bOver) return aOver ? 1 : -1;
        }

        if(a.soBuoiTrong2 !== b.soBuoiTrong2) return a.soBuoiTrong2 - b.soBuoiTrong2;
        if(a.tsBuoiDay !== b.tsBuoiDay) return a.tsBuoiDay - b.tsBuoiDay;
        return a.tsNgayDay - b.tsNgayDay;
      }"""

    new_compare_chunk = """      if(mode === "optimize_gap2"){
        // Uu tien toi thuong cua optimize_gap2: soBuoiTrong2 phai giam manh ve 0!
        if(a.soBuoiTrong2 !== b.soBuoiTrong2){
          const initSingle = this.initialMetricsSnapshot?.soBuoiDay1 ?? 999;
          const aSingleExceed = Math.max(0, a.soBuoiDay1 - initSingle);
          const bSingleExceed = Math.max(0, b.soBuoiDay1 - initSingle);
          if(aSingleExceed !== bSingleExceed) return aSingleExceed - bSingleExceed;
          return a.soBuoiTrong2 - b.soBuoiTrong2;
        }
        if(a.soBuoiDay1 !== b.soBuoiDay1) return a.soBuoiDay1 - b.soBuoiDay1;
        if(a.tsBuoiDay !== b.tsBuoiDay) return a.tsBuoiDay - b.tsBuoiDay;
        if(a.soBuoiTrong1 !== b.soBuoiTrong1) return a.soBuoiTrong1 - b.soBuoiTrong1;
        return a.tsNgayDay - b.tsNgayDay;
      }"""

    for p in engine_paths:
        with open(p, "r", encoding="utf-8") as f:
            code = f.read()
        if old_compare_chunk in code:
            code = code.replace(old_compare_chunk, new_compare_chunk, 1)
            with open(p, "w", encoding="utf-8") as f:
                f.write(code)
            print(f"Updated compareMetrics in: {p}")
        else:
            print(f"Already updated or chunk not matched in: {p}")
            
    # SFTP direct deploy to VPS
    host, user, password = resolve_vps_connection()
    print(f"\nDeploying updated engine to live VPS {host}...")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=password, timeout=30)
    
    sftp = client.open_sftp()
    local_src = r"C:\Users\Love\Documents\Codex\TKBCherry\web\tkb-fet-engine.js"
    sftp.put(local_src, "/opt/cherry-scheduler/web/tkb-fet-engine.js")
    sftp.put(local_src, "/opt/cherry-scheduler/web/pages/tkb-fet-engine.js")
    sftp.close()
    
    stdin, stdout, stderr = client.exec_command("systemctl restart tkb-app && systemctl is-active tkb-app")
    print("VPS service status:", stdout.read().decode().strip())
    client.close()
    print("RELAXED GAP2 POLICY FULLY DEPLOYED TO PRODUCTION!")

if __name__ == "__main__":
    apply_relaxed_budget_policy()
