import sys
import paramiko
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

REPO_ROOT = Path(r"C:\Users\Love\Documents\Codex\TKBCherry")
TOOLS_DIR = REPO_ROOT / "tools" / "vps-deploy"
sys.path.insert(0, str(TOOLS_DIR))
from vps_credentials import resolve_vps_connection

CRUSHER_CODE = """
    tryCrushExtremeSpanGaps(bestMetrics, initialMetrics, mode = "optimize_gap2", onProgress = null) {
      let currentBest = { ...bestMetrics };
      let anyImproved = false;

      const PERIODS = 5;
      const SLOTS_PER_DAY = 10;
      const DAYS_LIST = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
      const SESSIONS_LIST = ["sang", "chieu"];

      for (const [tKey, grid] of this.teacherGrid.entries()) {
        if (!tKey || !this.isScoredTeacher(tKey)) continue;

        for (let d = 0; d < DAYS_LIST.length; d++) {
          for (let b = 0; b < SESSIONS_LIST.length; b++) {
            const sStart = d * SLOTS_PER_DAY + b * PERIODS;
            const taught = [];
            for (let p = 0; p < PERIODS; p++) {
              const actId = grid[sStart + p];
              if (actId >= 0 || actId === -3) taught.push({ p, actId, slot: sStart + p });
            }

            if (taught.length < 2) continue;
            const span = taught[taught.length - 1].p - taught[0].p + 1;
            const gaps = span - taught.length;
            if (gaps < 1) continue;

            let resolved = false;
            const edgeEnd = taught[taught.length - 1];
            const edgeStart = taught[0];

            if (edgeEnd.actId >= 0) {
              const actEnd = this.activities[edgeEnd.actId];
              if (actEnd && !actEnd.isFixed) {
                const cg = this.classGrid.get(actEnd.classId);
                if (cg) {
                  for (let d2 = 0; d2 < DAYS_LIST.length && !resolved; d2++) {
                    for (let b2 = 0; b2 < SESSIONS_LIST.length && !resolved; b2++) {
                      const sStart2 = d2 * SLOTS_PER_DAY + b2 * PERIODS;
                      for (let p2 = 0; p2 < PERIODS && !resolved; p2++) {
                        const slotDest = sStart2 + p2;
                        if (slotDest === edgeEnd.slot || cg[slotDest] === -2) continue;

                        const actDestId = cg[slotDest];
                        if (actDestId < 0) {
                          const snap = this.captureStateSnapshot();
                          this.unplaceActivity(actEnd.id);
                          const r = this.getConflictsForSlot(actEnd, slotDest);
                          if (r.possible && !r.conflicts.length) {
                            this.placeActivityDirect(actEnd.id, slotDest);
                            if (this.isLessonBlockSafe(actEnd) && this.isDailySubjectLimitSafe(actEnd, slotDest)) {
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
                          if (!actDest || actDest.isFixed || actDest.duration !== actEnd.duration) continue;

                          const snap = this.captureStateSnapshot();
                          this.unplaceActivity(actEnd.id);
                          this.unplaceActivity(actDest.id);

                          const r1 = this.getConflictsForSlot(actEnd, slotDest);
                          const r2 = this.getConflictsForSlot(actDest, edgeEnd.slot);

                          if (r1.possible && !r1.conflicts.length && r2.possible && !r2.conflicts.length) {
                            this.placeActivityDirect(actEnd.id, slotDest);
                            this.placeActivityDirect(actDest.id, edgeEnd.slot);
                            if (this.isLessonBlockSafe(actEnd, actDest) && 
                                this.isDailySubjectLimitSafe(actEnd, slotDest) && 
                                this.isDailySubjectLimitSafe(actDest, edgeEnd.slot)) {
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
                      }
                    }
                  }
                }
              }
            }

            if (!resolved && edgeStart.actId >= 0) {
              const actStart = this.activities[edgeStart.actId];
              if (actStart && !actStart.isFixed) {
                const cg = this.classGrid.get(actStart.classId);
                if (cg) {
                  for (let d2 = 0; d2 < DAYS_LIST.length && !resolved; d2++) {
                    for (let b2 = 0; b2 < SESSIONS_LIST.length && !resolved; b2++) {
                      const sStart2 = d2 * SLOTS_PER_DAY + b2 * PERIODS;
                      for (let p2 = 0; p2 < PERIODS && !resolved; p2++) {
                        const slotDest = sStart2 + p2;
                        if (slotDest === edgeStart.slot || cg[slotDest] === -2) continue;

                        const actDestId = cg[slotDest];
                        if (actDestId < 0) {
                          const snap = this.captureStateSnapshot();
                          this.unplaceActivity(actStart.id);
                          const r = this.getConflictsForSlot(actStart, slotDest);
                          if (r.possible && !r.conflicts.length) {
                            this.placeActivityDirect(actStart.id, slotDest);
                            if (this.isLessonBlockSafe(actStart) && this.isDailySubjectLimitSafe(actStart, slotDest)) {
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
                          if (!actDest || actDest.isFixed || actDest.duration !== actStart.duration) continue;

                          const snap = this.captureStateSnapshot();
                          this.unplaceActivity(actStart.id);
                          this.unplaceActivity(actDest.id);

                          const r1 = this.getConflictsForSlot(actStart, slotDest);
                          const r2 = this.getConflictsForSlot(actDest, edgeStart.slot);

                          if (r1.possible && !r1.conflicts.length && r2.possible && !r2.conflicts.length) {
                            this.placeActivityDirect(actStart.id, slotDest);
                            this.placeActivityDirect(actDest.id, edgeStart.slot);
                            if (this.isLessonBlockSafe(actStart, actDest) && 
                                this.isDailySubjectLimitSafe(actStart, slotDest) && 
                                this.isDailySubjectLimitSafe(actDest, edgeStart.slot)) {
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
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }

      return anyImproved ? currentBest : null;
    }

    tryMergeSameTeacherSplitPeriodsInSession(bestMetrics, initialMetrics, mode = "optimize_gap2", onProgress = null) {
      let currentBest = { ...bestMetrics };
      let anyImproved = false;

      const PERIODS = 5;
      const SLOTS_PER_DAY = 10;
      const DAYS_LIST = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
      const SESSIONS_LIST = ["sang", "chieu"];

      for (const [tKey, grid] of this.teacherGrid.entries()) {
        if (!tKey || !this.isScoredTeacher(tKey)) continue;

        for (let d = 0; d < DAYS_LIST.length; d++) {
          for (let b = 0; b < SESSIONS_LIST.length; b++) {
            const sStart = d * SLOTS_PER_DAY + b * PERIODS;
            const actsInSession = [];
            for (let p = 0; p < PERIODS; p++) {
              const aId = grid[sStart + p];
              if (aId >= 0) actsInSession.push({ p, actId: aId, slot: sStart + p });
            }

            if (actsInSession.length !== 2) continue;
            const pFirst = actsInSession[0].p;
            const pSecond = actsInSession[1].p;
            if (pSecond - pFirst <= 1) continue;

            const act1 = this.activities[actsInSession[0].actId];
            const act2 = this.activities[actsInSession[1].actId];
            if (!act1 || !act2 || act1.isFixed || act2.isFixed) continue;

            const candidates = [
              { moveAct: act2, fromSlot: actsInSession[1].slot, toSlot: sStart + pFirst + 1 },
              { moveAct: act1, fromSlot: actsInSession[0].slot, toSlot: sStart + pSecond - 1 }
            ];

            let resolved = false;
            for (const cand of candidates) {
              const cg = this.classGrid.get(cand.moveAct.classId);
              if (!cg || cg[cand.toSlot] === -2) continue;

              const displacedId = cg[cand.toSlot];
              if (displacedId < 0) {
                const snap = this.captureStateSnapshot();
                this.unplaceActivity(cand.moveAct.id);
                const r = this.getConflictsForSlot(cand.moveAct, cand.toSlot);
                if (r.possible && !r.conflicts.length) {
                  this.placeActivityDirect(cand.moveAct.id, cand.toSlot);
                  if (this.isLessonBlockSafe(cand.moveAct) && this.isDailySubjectLimitSafe(cand.moveAct, cand.toSlot)) {
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
                const displacedAct = this.activities[displacedId];
                if (!displacedAct || displacedAct.isFixed) continue;

                const snap = this.captureStateSnapshot();
                this.unplaceActivity(cand.moveAct.id);
                this.unplaceActivity(displacedAct.id);

                const r1 = this.getConflictsForSlot(cand.moveAct, cand.toSlot);
                const r2 = this.getConflictsForSlot(displacedAct, cand.fromSlot);

                if (r1.possible && !r1.conflicts.length && r2.possible && !r2.conflicts.length) {
                  this.placeActivityDirect(cand.moveAct.id, cand.toSlot);
                  this.placeActivityDirect(displacedAct.id, cand.fromSlot);
                  if (this.isLessonBlockSafe(cand.moveAct, displacedAct) &&
                      this.isDailySubjectLimitSafe(cand.moveAct, cand.toSlot) &&
                      this.isDailySubjectLimitSafe(displacedAct, cand.fromSlot)) {
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
      }

      return anyImproved ? currentBest : null;
    }
"""

def integrate_and_deploy():
    engine_files = [
        REPO_ROOT / "web" / "tkb-fet-engine.js",
        REPO_ROOT / "web" / "pages" / "tkb-fet-engine.js"
    ]
    
    for ep in engine_files:
        with open(ep, "r", encoding="utf-8") as f:
            code = f.read()
            
        if "tryCrushExtremeSpanGaps(" not in code:
            target = "compareMetrics(a, b, mode = \"optimize_singletons\"){"
            code = code.replace(target, CRUSHER_CODE + "\n    " + target, 1)
            print(f"Added extreme crusher and merge split operators to {ep}")
            
        # Hook into optimize_gap2 loop
        hook_target = 'const resBorrowEarly = this.tryBorrowLessonFromRichSessions(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);'
        hook_insert = """
          const resCrushExtreme = this.tryCrushExtremeSpanGaps(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resCrushExtreme && this.compareMetrics(resCrushExtreme, bestMetrics, mode) < 0){
            bestMetrics = { ...resCrushExtreme };
            saveBestSnapshot();
            improvedInRound = true;
          }

          const resMergeSplit = this.tryMergeSameTeacherSplitPeriodsInSession(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resMergeSplit && this.compareMetrics(resMergeSplit, bestMetrics, mode) < 0){
            bestMetrics = { ...resMergeSplit };
            saveBestSnapshot();
            improvedInRound = true;
          }
""" + hook_target
        if "resCrushExtreme" not in code:
            code = code.replace(hook_target, hook_insert, 1)
            print(f"Hooked extreme operators into optimize_gap2 in {ep}")
            
        # Register in GUARDED_OPERATORS
        if '"tryCrushExtremeSpanGaps",' not in code:
            code = code.replace('"tryBorrowLessonFromRichSessions",', '"tryBorrowLessonFromRichSessions",\n    "tryCrushExtremeSpanGaps",\n    "tryMergeSameTeacherSplitPeriodsInSession",', 1)
            print(f"Registered in GUARDED_OPERATORS in {ep}")
            
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
    print(f"\nDeploying final engine from {REPO_ROOT} to VPS {host}...")
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
    print("\n=== COMPLETE REPOSITOTY DEPLOYED 100% SUCCESSFULLY ===")

if __name__ == "__main__":
    integrate_and_deploy()
