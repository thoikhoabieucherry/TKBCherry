import sys
import paramiko
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

REPO_ROOT = Path(r"C:\Users\Love\Documents\Codex\TKBCherry")
TOOLS_DIR = REPO_ROOT / "tools" / "vps-deploy"
sys.path.insert(0, str(TOOLS_DIR))
from vps_credentials import resolve_vps_connection

TEACHER_CANON_BUILDER = """
  function buildTeacherCanonMap(data) {
    const map = new Map();
    const gvList = Array.isArray(data?.giaovien) ? data.giaovien : (Array.isArray(data?.gv) ? data.gv : []);
    
    gvList.forEach(g => {
      if(!g) return;
      const canonId = String(g.id || g.ma || g.ten || "").trim().toLowerCase();
      if(!canonId) return;

      const keys = [
        String(g.id || "").trim().toLowerCase(),
        String(g.ma || "").trim().toLowerCase(),
        String(g.ten || "").trim().toLowerCase(),
        String(g.ten2 || "").trim().toLowerCase(),
        String(g.hoten || "").trim().toLowerCase()
      ];

      // Also add 'Ma - Ten'
      if(g.ma && g.ten) {
        keys.push(`${String(g.ma).trim().toLowerCase()} - ${String(g.ten).trim().toLowerCase()}`);
      }

      keys.filter(Boolean).forEach(k => {
        map.set(k, canonId);
        // Also strip diacritics
        const noDiacritics = k.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd');
        map.set(noDiacritics, canonId);
      });
    });

    return map;
  }
"""

def implement_robust_teacher_canonicalization():
    engine_files = [
        REPO_ROOT / "web" / "tkb-fet-engine.js",
        REPO_ROOT / "web" / "pages" / "tkb-fet-engine.js"
    ]
    
    for ep in engine_files:
        with open(ep, "r", encoding="utf-8") as f:
            code = f.read()

        # Update parseTeacherList to use global / engine teacher canon map if available
        old_parse_t = """  function parseTeacherList(raw){
    if(!raw) return [];
    if(Array.isArray(raw)) return raw.map(t => String(t || "").trim().toLowerCase()).filter(Boolean);
    return String(raw)
      .replace(/\\r?\\n/g, ",")
      .replace(/[;;]+/g, ",")
      .replace(/\\s*[++]\\s*/g, ",")
      .split(",")
      .map(t => t.trim().toLowerCase())
      .filter(Boolean);
  }"""

        new_parse_t = """  function parseTeacherList(raw, canonMap = null){
    if(!raw) return [];
    let list = [];
    if(Array.isArray(raw)){
      list = raw.map(t => String(t || "").trim().toLowerCase()).filter(Boolean);
    } else {
      list = String(raw)
        .replace(/\\r?\\n/g, ",")
        .replace(/[;;]+/g, ",")
        .replace(/\\s*[++]\\s*/g, ",")
        .split(",")
        .map(t => {
          let s = t.trim().toLowerCase();
          if(s.includes(" - ")) s = s.split(" - ")[0].trim(); // Extract short code if 'Ma - Ten'
          return s;
        })
        .filter(Boolean);
    }
    if(canonMap && canonMap.size > 0){
      return list.map(t => canonMap.get(t) || t);
    }
    return list;
  }"""

        if old_parse_t in code:
            code = code.replace(old_parse_t, TEACHER_CANON_BUILDER + "\n" + new_parse_t, 1)
            print(f"Updated parseTeacherList and added buildTeacherCanonMap to {ep}")

        with open(ep, "w", encoding="utf-8") as f:
            f.write(code)

    # Deploy to VPS
    host, user, password = resolve_vps_connection()
    print(f"\nDeploying Teacher-Canonized Engine from {REPO_ROOT} to VPS {host}...")
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
    print("\n=== COMPLETE ANTI-COLLISION DEPLOYMENT FINISHED 100% ===")

if __name__ == "__main__":
    implement_robust_teacher_canonicalization()
