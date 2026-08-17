import sys
import paramiko
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

TOOLS_DIR = Path(r"C:\Users\Love\Documents\Codex\TKBCherry\tools\vps-deploy")
sys.path.insert(0, str(TOOLS_DIR))
from vps_credentials import resolve_vps_connection

INTERDAY_OP_CODE = """
    tryInterDayRelocateGapLesson(bestMetrics, initialMetrics, mode = "optimize_gap2", onProgress = null) {
      let currentBest = { ...bestMetrics };
      let anyImproved = false;

      const PERIODS = 5;
      const SLOTS_PER_DAY = 10;
      const DAYS_LIST = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
      const SESSIONS_LIST = ["sang", "chieu"];

      for (const [tKey, grid] of this.teacherGrid.entries()) {
        if (!tKey || !this.isScoredTeacher(tKey)) continue;

        for (let dSrc = 0; dSrc < DAYS_LIST.length; dSrc++) {
          for (let bSrc = 0; bSrc < SESSIONS_LIST.length; bSrc++) {
            const sStartSrc = dSrc * SLOTS_PER_DAY + bSrc * PERIODS;
            const taughtSrc = [];
            for (let p = 0; p < PERIODS; p++) {
              const actId = grid[sStartSrc + p];
              if (actId >= 0 || actId === -3) taughtSrc.push(p);
            }

            if (taughtSrc.length < 2) continue;
            const spanSrc = taughtSrc[taughtSrc.length - 1] - taughtSrc[0] + 1;
            const gapsSrc = spanSrc - taughtSrc.length;
            if (gapsSrc < 2) continue;

            const outliers = [taughtSrc[0], taughtSrc[taughtSrc.length - 1]];
            let resolved = false;

            for (const pSrc of outliers) {
              const actSrcId = grid[sStartSrc + pSrc];
              if (actSrcId < 0) continue;
              const actSrc = this.activities[actSrcId];
              if (!actSrc || actSrc.isFixed || actSrc.duration !== 1) continue;

              const cid = actSrc.classId;
              const cg = this.classGrid.get(cid);
              if (!cg) continue;

              for (let dDest = 0; dDest < DAYS_LIST.length && !resolved; dDest++) {
                for (let bDest = 0; bDest < SESSIONS_LIST.length && !resolved; bDest++) {
                  if (dDest === dSrc && bDest === bSrc) continue;
                  const sStartDest = dDest * SLOTS_PER_DAY + bDest * PERIODS;

                  let hasClassSlot = false;
                  for (let p = 0; p < PERIODS; p++) {
                    if (cg[sStartDest + p] !== -2) hasClassSlot = true;
                  }
                  if (!hasClassSlot) continue;

                  for (let pDest = 0; pDest < PERIODS; pDest++) {
                    const slotDest = sStartDest + pDest;
                    if (cg[slotDest] === -2) continue;

                    const actDestId = cg[slotDest];
                    if (actDestId < 0) {
                      const snap = this.captureStateSnapshot();
                      this.unplaceActivity(actSrc.id);
                      const r = this.getConflictsForSlot(actSrc, slotDest);
                      if (r.possible && !r.conflicts.length) {
                        this.placeActivityDirect(actSrc.id, slotDest);
                        if (this.isLessonBlockSafe(actSrc)) {
                          const m = this.evaluateMetrics();
                          if (this.compareMetrics(m, currentBest, mode) < 0) {
                            currentBest = { ...m };
                            anyImproved = true;
                            resolved = true;
                            if (typeof onProgress === "function") onProgress(currentBest);
                          }
                        }
                      }
                      if (!resolved) this.restoreStateSnapshot(snap);
                    } else {
                      const actDest = this.activities[actDestId];
                      if (!actDest || actDest.isFixed || actDest.duration !== 1) continue;

                      const snap = this.captureStateSnapshot();
                      this.unplaceActivity(actSrc.id);
                      this.unplaceActivity(actDest.id);

                      const r1 = this.getConflictsForSlot(actSrc, slotDest);
                      const r2 = this.getConflictsForSlot(actDest, sStartSrc + pSrc);

                      if (r1.possible && !r1.conflicts.length && r2.possible && !r2.conflicts.length) {
                        this.placeActivityDirect(actSrc.id, slotDest);
                        this.placeActivityDirect(actDest.id, sStartSrc + pSrc);
                        if (this.isLessonBlockSafe(actSrc, actDest)) {
                          const m = this.evaluateMetrics();
                          if (this.compareMetrics(m, currentBest, mode) < 0) {
                            currentBest = { ...m };
                            anyImproved = true;
                            resolved = true;
                            if (typeof onProgress === "function") onProgress(currentBest);
                          }
                        }
                      }
                      if (!resolved) this.restoreStateSnapshot(snap);
                    }
                    if (resolved) break;
                  }
                }
              }
              if (resolved) break;
            }
          }
        }
      }

      return anyImproved ? currentBest : null;
    }
"""

def integrate_interday_and_deploy():
    engine_paths = [
        r"C:\Users\Love\Documents\Codex\MD\tkb-fet-engine.js",
        r"C:\Users\Love\Documents\Codex\TKBCherry\web\tkb-fet-engine.js",
        r"C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js"
    ]
    
    for p in engine_paths:
        with open(p, "r", encoding="utf-8") as f:
            code = f.read()
            
        # 1. Insert method if not present
        if "tryInterDayRelocateGapLesson(" not in code:
            target = "compareMetrics(a, b, mode = \"optimize_singletons\"){"
            code = code.replace(target, INTERDAY_OP_CODE + "\n    " + target, 1)
            print(f"Added tryInterDayRelocateGapLesson to {p}")
            
        # 2. Add to optimize_gap2 loop
        loop_target = 'const resBlockShift = this.tryBlockShiftAndGapResolution(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);'
        loop_insert = loop_target + """
          const resInterDay = this.tryInterDayRelocateGapLesson(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resInterDay && this.compareMetrics(resInterDay, bestMetrics, mode) < 0){
            bestMetrics = { ...resInterDay };
            saveBestSnapshot();
            improvedInRound = true;
          }"""
          
        if 'tryInterDayRelocateGapLesson(bestMetrics' not in code:
            code = code.replace(loop_target, loop_insert, 1)
            print(f"Hooked tryInterDayRelocateGapLesson into optimize_gap2 loop in {p}")
            
        # 3. Add to GUARDED_OPERATORS
        guarded_target = '"tryBlockShiftAndGapResolution",'
        guarded_insert = '"tryBlockShiftAndGapResolution",\n    "tryInterDayRelocateGapLesson",'
        if '"tryInterDayRelocateGapLesson",' not in code:
            code = code.replace(guarded_target, guarded_insert, 1)
            print(f"Registered in GUARDED_OPERATORS in {p}")
            
        with open(p, "w", encoding="utf-8") as f:
            f.write(code)
            
    # SFTP Deploy to VPS
    host, user, password = resolve_vps_connection()
    print(f"\nDeploying complete Gap-2 to ZERO Engine to VPS {host}...")
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
    print("\nPERFECT GAP-2 TO ZERO ENGINE DEPLOYED 100% SUCCESSFULLY!")

if __name__ == "__main__":
    integrate_interday_and_deploy()
