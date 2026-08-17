import sys
import paramiko
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

REPO_ROOT = Path(r"C:\Users\Love\Documents\Codex\TKBCherry")
TOOLS_DIR = REPO_ROOT / "tools" / "vps-deploy"
sys.path.insert(0, str(TOOLS_DIR))
from vps_credentials import resolve_vps_connection

DAILY_LIMIT_METHODS = """
    getMaxDailyPeriodsForSubject(cid, subject) {
      if(!subject) return 2;
      const sCanon = this.getCanonMonKey(subject);
      if(this.classSubjectLessonBlocks){
        for(const [k, req] of this.classSubjectLessonBlocks.entries()){
          if((req.cid === cid || req.classCanon === cid) && req.sCanon === sCanon){
            if(req.len >= 2) return req.len;
          }
        }
      }
      const sNorm = this.normalizeMonName(subject);
      const singleSubjects = ["gdcd", "tin", "cn", "nhac", "nhạc", "mt", "my thuat", "mỹ thuật", "gddp", "gdđp", "hdtn 1", "hđtn 1", "hdtn 2", "hđtn 2", "hdtn 3", "hđtn 3", "chao co", "chào cờ", "sinh hoat", "sinh hoạt"];
      if(singleSubjects.includes(sCanon) || singleSubjects.includes(sNorm)){
        return 1;
      }
      return 2;
    }

    isDailySubjectLimitSafe(act, targetSlot) {
      if(!act || !act.classId || !act.subject) return true;
      const details = slotToDetails(targetSlot);
      if(!details || details.dayIdx < 0) return true;
      const targetDayIdx = details.dayIdx;
      const cg = this.classGrid.get(act.classId);
      if(!cg) return true;

      const dayStart = targetDayIdx * SLOTS_PER_DAY;
      let count = 0;
      for(let p = 0; p < SLOTS_PER_DAY; p++){
        const aId = cg[dayStart + p];
        if(aId >= 0 && aId !== act.id){
          const a = this.activities[aId];
          if(a && this.getCanonMonKey(a.subject) === this.getCanonMonKey(act.subject)){
            count += a.duration || 1;
          }
        }
      }

      const maxLimit = this.getMaxDailyPeriodsForSubject(act.classId, act.subject);
      return (count + (act.duration || 1)) <= maxLimit;
    }
"""

def update_all_and_deploy():
    engine_files = [
        REPO_ROOT / "web" / "tkb-fet-engine.js",
        REPO_ROOT / "web" / "pages" / "tkb-fet-engine.js"
    ]
    
    for ep in engine_files:
        with open(ep, "r", encoding="utf-8") as f:
            code = f.read()
            
        if "getMaxDailyPeriodsForSubject(" not in code:
            target = "compareMetrics(a, b, mode = \"optimize_singletons\"){"
            code = code.replace(target, DAILY_LIMIT_METHODS + "\n    " + target, 1)
            print(f"Added daily subject safety checks to {ep}")
            
        # Update tryBorrowLessonFromRichSessions to check isDailySubjectLimitSafe
        old_borrow_check = "if (this.isLessonBlockSafe(actDonor)) {"
        new_borrow_check = "if (this.isLessonBlockSafe(actDonor) && this.isDailySubjectLimitSafe(actDonor, slotDest)) {"
        if old_borrow_check in code and new_borrow_check not in code:
            code = code.replace(old_borrow_check, new_borrow_check)
            print(f"Secured tryBorrowLessonFromRichSessions against duplicate daily periods in {ep}")
            
        old_borrow_swap_check = "if (this.isLessonBlockSafe(actDonor, actDest)) {"
        new_borrow_swap_check = "if (this.isLessonBlockSafe(actDonor, actDest) && this.isDailySubjectLimitSafe(actDonor, slotDest) && this.isDailySubjectLimitSafe(actDest, slotSrc)) {"
        if old_borrow_swap_check in code and new_borrow_swap_check not in code:
            code = code.replace(old_borrow_swap_check, new_borrow_swap_check)
            print(f"Secured tryBorrowLessonFromRichSessions swap against duplicate daily periods in {ep}")
            
        # Update tryInterDayRelocateGapLesson to check isDailySubjectLimitSafe
        old_interday_check = "if (this.isLessonBlockSafe(actSrc)) {"
        new_interday_check = "if (this.isLessonBlockSafe(actSrc) && this.isDailySubjectLimitSafe(actSrc, slotDest)) {"
        if old_interday_check in code and new_interday_check not in code:
            code = code.replace(old_interday_check, new_interday_check)
            print(f"Secured tryInterDayRelocateGapLesson against duplicate daily periods in {ep}")

        old_interday_swap_check = "if (this.isLessonBlockSafe(actSrc, actDest)) {"
        new_interday_swap_check = "if (this.isLessonBlockSafe(actSrc, actDest) && this.isDailySubjectLimitSafe(actSrc, slotDest) && this.isDailySubjectLimitSafe(actDest, sStartSrc + pSrc)) {"
        if old_interday_swap_check in code and new_interday_swap_check not in code:
            code = code.replace(old_interday_swap_check, new_interday_swap_check)
            print(f"Secured tryInterDayRelocateGapLesson swap against duplicate daily periods in {ep}")
            
        with open(ep, "w", encoding="utf-8") as f:
            f.write(code)
            
    # Also sync phanmon.js and worker
    # Update cache-busting version in sapxep.html
    sapxep_html_path = REPO_ROOT / "web" / "pages" / "sapxep.html"
    with open(sapxep_html_path, "r", encoding="utf-8") as f:
        html_code = f.read()
    import time
    new_v = f"v={int(time.time())}"
    import re
    html_code = re.sub(r'phanmon\.js\?v=[^"]+', f'phanmon.js?{new_v}', html_code)
    with open(sapxep_html_path, "w", encoding="utf-8") as f:
        f.write(html_code)
    print(f"Updated sapxep.html script tag to {new_v}")
    
    # Deploy to VPS
    host, user, password = resolve_vps_connection()
    print(f"\nDeploying strictly synchronized codebase to VPS {host}...")
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
    print("ALL CODE FULLY SYNCHRONIZED AND DEPLOYED TO PRODUCTION!")

if __name__ == "__main__":
    update_all_and_deploy()
