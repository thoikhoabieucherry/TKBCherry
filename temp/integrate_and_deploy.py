import sys
import paramiko
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

TOOLS_DIR = Path(r"C:\Users\Love\Documents\Codex\TKBCherry\tools\vps-deploy")
sys.path.insert(0, str(TOOLS_DIR))
from vps_credentials import resolve_vps_connection

BLOCK_SHIFT_OP_CODE = """
    tryBlockShiftAndGapResolution(bestMetrics, initialMetrics, mode = "optimize_gap2", onProgress = null) {
      let currentBest = { ...bestMetrics };
      let anyImproved = false;

      const PERIODS = 5;
      const SLOTS_PER_DAY = 10;
      const DAYS_LIST = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
      const SESSIONS_LIST = ["sang", "chieu"];

      for (let d = 0; d < DAYS_LIST.length; d++) {
        for (let b = 0; b < SESSIONS_LIST.length; b++) {
          const sStart = d * SLOTS_PER_DAY + b * PERIODS;

          for (const [cid, cg] of this.classGrid.entries()) {
            for (let p1 = 0; p1 < PERIODS; p1++) {
              for (let p2 = 0; p2 < PERIODS; p2++) {
                if (p1 === p2) continue;

                const a1Id = cg[sStart + p1];
                const a2Id = cg[sStart + p2];
                if (a1Id < 0 || a2Id < 0) continue;

                const a1 = this.activities[a1Id];
                const a2 = this.activities[a2Id];
                if (!a1 || !a2 || a1.isFixed || a2.isFixed) continue;

                // Direct 2-way swap in class
                const snap = this.captureStateSnapshot();
                this.unplaceActivity(a1.id);
                this.unplaceActivity(a2.id);

                const r1 = this.getConflictsForSlot(a1, sStart + p2);
                const r2 = this.getConflictsForSlot(a2, sStart + p1);

                if (r1.possible && !r1.conflicts.length && r2.possible && !r2.conflicts.length) {
                  this.placeActivityDirect(a1.id, sStart + p2);
                  this.placeActivityDirect(a2.id, sStart + p1);
                  if (this.isLessonBlockSafe(a1, a2)) {
                    const m = this.evaluateMetrics();
                    if (this.compareMetrics(m, currentBest, mode) < 0) {
                      currentBest = { ...m };
                      anyImproved = true;
                      if (typeof onProgress === "function") onProgress(currentBest);
                    }
                  }
                }
                if (this.compareMetrics(this.evaluateMetrics(), currentBest, mode) >= 0) {
                  this.restoreStateSnapshot(snap);
                }

                // Double block shift
                const partnerP1 = (p1 + 1 < PERIODS && cg[sStart + p1 + 1] >= 0 && this.activities[cg[sStart + p1 + 1]]?.subject === a1.subject) ? p1 + 1 :
                                  (p1 - 1 >= 0 && cg[sStart + p1 - 1] >= 0 && this.activities[cg[sStart + p1 - 1]]?.subject === a1.subject) ? p1 - 1 : -1;

                if (partnerP1 >= 0) {
                  const aPartner = this.activities[cg[sStart + partnerP1]];
                  if (aPartner && !aPartner.isFixed) {
                    const minP = Math.min(p1, partnerP1);
                    const maxP = Math.max(p1, partnerP1);

                    if (p2 < minP) {
                      const snapBlock = this.captureStateSnapshot();
                      const aMin = this.activities[cg[sStart + minP]];
                      const aMax = this.activities[cg[sStart + maxP]];
                      const aOther = this.activities[cg[sStart + p2]];

                      this.unplaceActivity(aMin.id);
                      this.unplaceActivity(aMax.id);
                      this.unplaceActivity(aOther.id);

                      const rc1 = this.getConflictsForSlot(aMin, sStart + p2);
                      const rc2 = this.getConflictsForSlot(aMax, sStart + minP);
                      const rc3 = this.getConflictsForSlot(aOther, sStart + maxP);

                      if (rc1.possible && !rc1.conflicts.length && rc2.possible && !rc2.conflicts.length && rc3.possible && !rc3.conflicts.length) {
                        this.placeActivityDirect(aMin.id, sStart + p2);
                        this.placeActivityDirect(aMax.id, sStart + minP);
                        this.placeActivityDirect(aOther.id, sStart + maxP);
                        if (this.isLessonBlockSafe(aMin, aMax, aOther)) {
                          const m = this.evaluateMetrics();
                          if (this.compareMetrics(m, currentBest, mode) < 0) {
                            currentBest = { ...m };
                            anyImproved = true;
                            if (typeof onProgress === "function") onProgress(currentBest);
                          }
                        }
                      }
                      if (this.compareMetrics(this.evaluateMetrics(), currentBest, mode) >= 0) {
                        this.restoreStateSnapshot(snapBlock);
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
"""

def integrate_and_deploy():
    engine_paths = [
        r"C:\Users\Love\Documents\Codex\MD\tkb-fet-engine.js",
        r"C:\Users\Love\Documents\Codex\TKBCherry\web\tkb-fet-engine.js",
        r"C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js"
    ]
    
    for p in engine_paths:
        with open(p, "r", encoding="utf-8") as f:
            code = f.read()
            
        # 1. Insert method if not present
        if "tryBlockShiftAndGapResolution(" not in code:
            # Insert before compareMetrics
            target = "compareMetrics(a, b, mode = \"optimize_singletons\"){"
            code = code.replace(target, BLOCK_SHIFT_OP_CODE + "\n    " + target, 1)
            print(f"Added tryBlockShiftAndGapResolution to {p}")
            
        # 2. Add to optimize_gap2 loop if not present
        loop_target = 'const resChain2 = this.tryIntraSessionCrossClassChain(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);'
        loop_insert = loop_target + """
          const resBlockShift = this.tryBlockShiftAndGapResolution(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resBlockShift && this.compareMetrics(resBlockShift, bestMetrics, mode) < 0){
            bestMetrics = { ...resBlockShift };
            saveBestSnapshot();
            improvedInRound = true;
          }"""
          
        if 'tryBlockShiftAndGapResolution(bestMetrics' not in code:
            code = code.replace(loop_target, loop_insert, 1)
            print(f"Hooked tryBlockShiftAndGapResolution into optimize_gap2 loop in {p}")
            
        # 3. Add to GUARDED_OPERATORS if not present
        guarded_target = '"tryIntraSessionCrossClassChain",'
        guarded_insert = '"tryIntraSessionCrossClassChain",\n    "tryBlockShiftAndGapResolution",'
        if '"tryBlockShiftAndGapResolution",' not in code:
            code = code.replace(guarded_target, guarded_insert, 1)
            print(f"Registered in GUARDED_OPERATORS in {p}")
            
        with open(p, "w", encoding="utf-8") as f:
            f.write(code)
            
    # Deploy to VPS
    host, user, password = resolve_vps_connection()
    print(f"\nDeploying final engine with Block-Shift to VPS {host}...")
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
    print("\nBLOCK-SHIFT ENGINE FULLY DEPLOYED TO PRODUCTION!")

if __name__ == "__main__":
    integrate_and_deploy()
