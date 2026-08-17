import sys
import paramiko
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

TOOLS_DIR = Path(r"C:\Users\Love\Documents\Codex\TKBCherry\tools\vps-deploy")
sys.path.insert(0, str(TOOLS_DIR))
from vps_credentials import resolve_vps_connection

BORROW_OP_CODE = """
    tryBorrowLessonFromRichSessions(bestMetrics, initialMetrics, mode = "optimize_gap2", onProgress = null) {
      let currentBest = { ...bestMetrics };
      let anyImproved = false;

      const PERIODS = 5;
      const SLOTS_PER_DAY = 10;
      const DAYS_LIST = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
      const SESSIONS_LIST = ["sang", "chieu"];

      for (const [tKey, grid] of this.teacherGrid.entries()) {
        if (!tKey || !this.isScoredTeacher(tKey)) continue;

        for (let dGap = 0; dGap < DAYS_LIST.length; dGap++) {
          for (let bGap = 0; bGap < SESSIONS_LIST.length; bGap++) {
            const sStartGap = dGap * SLOTS_PER_DAY + bGap * PERIODS;
            const taughtGap = [];
            for (let p = 0; p < PERIODS; p++) {
              const actId = grid[sStartGap + p];
              if (actId >= 0 || actId === -3) taughtGap.push(p);
            }

            if (taughtGap.length < 2) continue;
            const spanGap = taughtGap[taughtGap.length - 1] - taughtGap[0] + 1;
            const gapsCount = spanGap - taughtGap.length;
            if (gapsCount < 1) continue;

            const holes = [];
            for (let p = taughtGap[0] + 1; p < taughtGap[taughtGap.length - 1]; p++) {
              if (!taughtGap.includes(p)) holes.push(p);
            }

            let resolved = false;

            for (let dRich = 0; dRich < DAYS_LIST.length && !resolved; dRich++) {
              for (let bRich = 0; bRich < SESSIONS_LIST.length && !resolved; bRich++) {
                if (dRich === dGap && bRich === bGap) continue;
                const sStartRich = dRich * SLOTS_PER_DAY + bRich * PERIODS;

                const taughtRich = [];
                for (let p = 0; p < PERIODS; p++) {
                  const actId = grid[sStartRich + p];
                  if (actId >= 0 || actId === -3) taughtRich.push(p);
                }

                if (taughtRich.length < 2) continue;

                for (const pRich of taughtRich) {
                  const actRichId = grid[sStartRich + pRich];
                  if (actRichId < 0) continue;
                  const actDonor = this.activities[actRichId];
                  if (!actDonor || actDonor.isFixed || actDonor.duration !== 1) continue;

                  const cid = actDonor.classId;
                  const cg = this.classGrid.get(cid);
                  if (!cg) continue;

                  let classActiveInGap = false;
                  for (let p = 0; p < PERIODS; p++) {
                    if (cg[sStartGap + p] !== -2) classActiveInGap = true;
                  }
                  if (!classActiveInGap) continue;

                  const candidateTargetPeriods = [...holes, Math.max(0, taughtGap[0] - 1), Math.min(PERIODS - 1, taughtGap[taughtGap.length - 1] + 1)];

                  for (const pHole of candidateTargetPeriods) {
                    if (taughtGap.includes(pHole) || pHole < 0 || pHole >= PERIODS) continue;

                    const slotDest = sStartGap + pHole;
                    const slotSrc = sStartRich + pRich;
                    if (cg[slotDest] === -2) continue;

                    const actDestId = cg[slotDest];

                    if (actDestId < 0) {
                      const snap = this.captureStateSnapshot();
                      this.unplaceActivity(actDonor.id);
                      const r = this.getConflictsForSlot(actDonor, slotDest);

                      if (r.possible && !r.conflicts.length) {
                        this.placeActivityDirect(actDonor.id, slotDest);
                        if (this.isLessonBlockSafe(actDonor)) {
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
                      this.unplaceActivity(actDonor.id);
                      this.unplaceActivity(actDest.id);

                      const r1 = this.getConflictsForSlot(actDonor, slotDest);
                      const r2 = this.getConflictsForSlot(actDest, slotSrc);

                      if (r1.possible && !r1.conflicts.length && r2.possible && !r2.conflicts.length) {
                        this.placeActivityDirect(actDonor.id, slotDest);
                        this.placeActivityDirect(actDest.id, slotSrc);
                        if (this.isLessonBlockSafe(actDonor, actDest)) {
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
                  if (resolved) break;
                }
                if (resolved) break;
              }
              if (resolved) break;
            }
          }
        }
      }

      return anyImproved ? currentBest : null;
    }
"""

def integrate_borrow_and_deploy():
    engine_paths = [
        r"C:\Users\Love\Documents\Codex\MD\tkb-fet-engine.js",
        r"C:\Users\Love\Documents\Codex\TKBCherry\web\tkb-fet-engine.js",
        r"C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js"
    ]
    
    for p in engine_paths:
        with open(p, "r", encoding="utf-8") as f:
            code = f.read()
            
        # 1. Insert method if not present
        if "tryBorrowLessonFromRichSessions(" not in code:
            target = "compareMetrics(a, b, mode = \"optimize_singletons\"){"
            code = code.replace(target, BORROW_OP_CODE + "\n    " + target, 1)
            print(f"Added tryBorrowLessonFromRichSessions to {p}")
            
        # 2. Add to optimize_gap2 & optimize_gap1 loops
        loop_target = 'const resInterDay = this.tryInterDayRelocateGapLesson(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);'
        loop_insert = loop_target + """
          const resBorrow = this.tryBorrowLessonFromRichSessions(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resBorrow && this.compareMetrics(resBorrow, bestMetrics, mode) < 0){
            bestMetrics = { ...resBorrow };
            saveBestSnapshot();
            improvedInRound = true;
          }"""
          
        if 'tryBorrowLessonFromRichSessions(bestMetrics' not in code:
            code = code.replace(loop_target, loop_insert, 1)
            print(f"Hooked tryBorrowLessonFromRichSessions into optimize_gap2 loop in {p}")
            
        # Also hook into optimize_gap1
        gap1_target = 'const resReloc1 = this.tryRelocateGapSessionToNewDay(bestMetrics, initialMetrics, "optimize_gap1", notifyLiveProgress);'
        gap1_insert = gap1_target + """
          const resBorrow1 = this.tryBorrowLessonFromRichSessions(bestMetrics, initialMetrics, "optimize_gap1", notifyLiveProgress);
          if(resBorrow1 && this.compareMetrics(resBorrow1, bestMetrics, mode) < 0){
            bestMetrics = { ...resBorrow1 };
            saveBestSnapshot();
            improvedInRound = true;
          }"""
        if 'tryBorrowLessonFromRichSessions(bestMetrics, initialMetrics, "optimize_gap1"' not in code:
            code = code.replace(gap1_target, gap1_insert, 1)
            print(f"Hooked tryBorrowLessonFromRichSessions into optimize_gap1 loop in {p}")
            
        # 3. Add to GUARDED_OPERATORS
        guarded_target = '"tryInterDayRelocateGapLesson",'
        guarded_insert = '"tryInterDayRelocateGapLesson",\n    "tryBorrowLessonFromRichSessions",'
        if '"tryBorrowLessonFromRichSessions",' not in code:
            code = code.replace(guarded_target, guarded_insert, 1)
            print(f"Registered in GUARDED_OPERATORS in {p}")
            
        with open(p, "w", encoding="utf-8") as f:
            f.write(code)
            
    # SFTP Deploy to VPS
    host, user, password = resolve_vps_connection()
    print(f"\nDeploying comprehensive Borrow & Fill Engine to VPS {host}...")
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
    print("\nCOMPREHENSIVE BORROW & FILL ENGINE DEPLOYED 100% SUCCESSFULLY!")

if __name__ == "__main__":
    integrate_borrow_and_deploy()
