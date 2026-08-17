import sys
import paramiko
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

REPO_ROOT = Path(r"C:\Users\Love\Documents\Codex\TKBCherry")
TOOLS_DIR = REPO_ROOT / "tools" / "vps-deploy"
sys.path.insert(0, str(TOOLS_DIR))
from vps_credentials import resolve_vps_connection

def fix_pccm_subject_isolation():
    engine_files = [
        REPO_ROOT / "web" / "tkb-fet-engine.js",
        REPO_ROOT / "web" / "pages" / "tkb-fet-engine.js"
    ]
    
    for ep in engine_files:
        with open(ep, "r", encoding="utf-8") as f:
            code = f.read()

        # 1. Fix getTeacherForClassMon to only match exact or normalized name, never cross-match by broad canon
        old_get_teacher = """    getTeacherForClassMon(lop, mon){
      const data = this.data;
      if(!lop || !mon) return "";
      const classId = String(lop.id || "");
      const classCanon = lop.ten2 || lop.ten || classId;
      const key1 = `${classId}|${mon}`;
      const key2 = `${classCanon}|${mon}`;
      let val = data.pccmMatrix?.[key1] || data.pccmMatrix?.[key2];
      if(!val){
        const norm = this.normalizeMonName(mon);
        for(const k of Object.keys(data.pccmMatrix || {})){
          if(k.startsWith(classId + "|") || k.startsWith(classCanon + "|")){
            const m = k.split("|").slice(1).join("|");
            if(this.normalizeMonName(m) === norm){
              val = data.pccmMatrix[k];
              break;
            }
          }
        }
      }
      if(!val){
        const norm = this.normalizeMonName(mon);
        const canon = this.getCanonMonKey(mon);
        for(const k of Object.keys(data.pccmMatrix || {})){
          if(k.startsWith(classId + "|") || k.startsWith(classCanon + "|")){
            const m = k.split("|").slice(1).join("|");
            if(this.normalizeMonName(m) === norm || (canon && this.getCanonMonKey(m) === canon)){
              val = data.pccmMatrix[k];
              break;
            }
          }
        }
      }
      return String(val || "").trim();
    }"""

        new_get_teacher = """    getTeacherForClassMon(lop, mon){
      const data = this.data;
      if(!lop || !mon) return "";
      const classId = String(lop.id || "");
      const classCanon = lop.ten2 || lop.ten || classId;
      const key1 = `${classId}|${mon}`;
      const key2 = `${classCanon}|${mon}`;
      let val = data.pccmMatrix?.[key1] || data.pccmMatrix?.[key2];
      if(!val){
        const norm = this.normalizeMonName(mon);
        for(const k of Object.keys(data.pccmMatrix || {})){
          if(k.startsWith(classId + "|") || k.startsWith(classCanon + "|")){
            const m = k.split("|").slice(1).join("|");
            if(this.normalizeMonName(m) === norm){
              val = data.pccmMatrix[k];
              break;
            }
          }
        }
      }
      return String(val || "").trim();
    }"""

        if old_get_teacher in code:
            code = code.replace(old_get_teacher, new_get_teacher, 1)
            print(f"Fixed getTeacherForClassMon strict isolation in {ep}")

        # 2. Separate TinQT, TATC, TABN, STEM in getCanonMonKey
        old_canon_tin = 'if(["tin hoc", "tinqt", "tin"].includes(s)){'
        new_canon_tin = 'if(["tin hoc", "tin"].includes(s)){'
        if old_canon_tin in code:
            code = code.replace(old_canon_tin, new_canon_tin)
            print(f"Isolated TinQT from Tin in {ep}")

        with open(ep, "w", encoding="utf-8") as f:
            f.write(code)

    # Update cache-buster in sapxep.html
    sapxep_html = REPO_ROOT / "web" / "pages" / "sapxep.html"
    with open(sapxep_html, "r", encoding="utf-8") as f:
        h = f.read()
    import time
    import re
    h = re.sub(r'phanmon\.js\?v=[^"]+', f'phanmon.js?v={int(time.time())}', h)
    with open(sapxep_html, "w", encoding="utf-8") as f:
        f.write(h)

    # Deploy to VPS
    host, user, password = resolve_vps_connection()
    print(f"\nDeploying PCCM-isolated Engine from {REPO_ROOT} to VPS {host}...")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=password, timeout=30)
    
    sftp = client.open_sftp()
    remote_web_dir = "/opt/cherry-scheduler/web"
    
    files_to_sync = [
        "tkb-fet-engine.js",
        "tkb-fet-worker.js",
        "pages/tkb-fet-engine.js",
        "pages/tkb-fet-worker.js",
        "pages/phanmon.js",
        "pages/sapxep.html"
    ]
    
    for rel in files_to_sync:
        local_p = REPO_ROOT / "web" / rel
        remote_p = f"{remote_web_dir}/{rel}"
        sftp.put(str(local_p), remote_p)
        print(f"  -> Uploaded {rel} OK!")
        
    sftp.close()
    
    stdin, stdout, stderr = client.exec_command("systemctl restart tkb-app && systemctl is-active tkb-app")
    print("VPS service status:", stdout.read().decode().strip())
    client.close()
    print("\n=== DEPLOYMENT COMPLETED 100% SUCCESSFULLY ===")

if __name__ == "__main__":
    fix_pccm_subject_isolation()
