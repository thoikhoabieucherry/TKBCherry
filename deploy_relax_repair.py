import sys
import paramiko
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

REPO_ROOT = Path(r"C:\Users\Love\Documents\Codex\TKBCherry")
TOOLS_DIR = REPO_ROOT / "tools" / "vps-deploy"
sys.path.insert(0, str(TOOLS_DIR))
from vps_credentials import resolve_vps_connection

RELAX_REPAIR_CODE = """
    tryRelaxAndRepairGapGaps(bestMetrics, initialMetrics, mode = "optimize_gap2", onProgress = null) {
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

            if (edgeEnd.actId >= 0) {
              const actToMove = this.activities[edgeEnd.actId];
              if (actToMove && !actToMove.isFixed) {
                const cg = this.classGrid.get(actToMove.classId);
                if (!cg) continue;

                for (let d2 = 0; d2 < DAYS_LIST.length && !resolved; d2++) {
                  for (let b2 = 0; b2 < SESSIONS_LIST.length && !resolved; b2++) {
                    if (d2 === d && b2 === b) continue;
                    const sStart2 = d2 * SLOTS_PER_DAY + b2 * PERIODS;

                    for (let p2 = 0; p2 < PERIODS && !resolved; p2++) {
                      const targetSlot = sStart2 + p2;
                      if (cg[targetSlot] === -2) continue;

                      const snap = this.captureStateSnapshot();
                      let placed = false;

                      const displacedId = cg[targetSlot];
                      if (displacedId < 0) {
                        this.unplaceActivity(actToMove.id);
                        const r = this.getConflictsForSlot(actToMove, targetSlot);
                        if (r.possible && !r.conflicts.length) {
                          this.placeActivityDirect(actToMove.id, targetSlot);
                          placed = true;
                        }
                      } else {
                        const displacedAct = this.activities[displacedId];
                        if (displacedAct && !displacedAct.isFixed && displacedAct.duration === actToMove.duration) {
                          this.unplaceActivity(actToMove.id);
                          this.unplaceActivity(displacedAct.id);

                          const r1 = this.getConflictsForSlot(actToMove, targetSlot);
                          const r2 = this.getConflictsForSlot(displacedAct, edgeEnd.slot);

                          if (r1.possible && !r1.conflicts.length && r2.possible && !r2.conflicts.length) {
                            this.placeActivityDirect(actToMove.id, targetSlot);
                            this.placeActivityDirect(displacedAct.id, edgeEnd.slot);
                            placed = true;
                          }
                        }
                      }

                      if (placed) {
                        const isBlockOk = this.isLessonBlockSafe(actToMove);
                        const isDailyLimitOk = this.isDailySubjectLimitSafe(actToMove, targetSlot);

                        if (isBlockOk && isDailyLimitOk) {
                          const m = this.evaluateMetrics();
                          if (this.compareMetrics(m, currentBest, mode) < 0) {
                            currentBest = { ...m };
                            anyImproved = true;
                            resolved = true;
                            if (typeof onProgress === "function") onProgress(currentBest);
                          }
                        }
                      }

                      if (!resolved) {
                        this.restoreStateSnapshot(snap);
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
"""

def integrate_relax_and_deploy():
    engine_files = [
        REPO_ROOT / "web" / "tkb-fet-engine.js",
        REPO_ROOT / "web" / "pages" / "tkb-fet-engine.js"
    ]
    
    for ep in engine_files:
        with open(ep, "r", encoding="utf-8") as f:
            code = f.read()
            
        if "tryRelaxAndRepairGapGaps(" not in code:
            target = "compareMetrics(a, b, mode = \"optimize_singletons\"){"
            code = code.replace(target, RELAX_REPAIR_CODE + "\n    " + target, 1)
            print(f"Added tryRelaxAndRepairGapGaps to {ep}")
            
        hook_target = 'const resCrushExtreme = this.tryCrushExtremeSpanGaps(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);'
        hook_insert = """
          const resRelaxRepair = this.tryRelaxAndRepairGapGaps(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resRelaxRepair && this.compareMetrics(resRelaxRepair, bestMetrics, mode) < 0){
            bestMetrics = { ...resRelaxRepair };
            saveBestSnapshot();
            improvedInRound = true;
          }
""" + hook_target

        if "resRelaxRepair" not in code:
            code = code.replace(hook_target, hook_insert, 1)
            print(f"Hooked tryRelaxAndRepairGapGaps into optimize_gap2 in {ep}")
            
        if '"tryRelaxAndRepairGapGaps",' not in code:
            code = code.replace('"tryCrushExtremeSpanGaps",', '"tryCrushExtremeSpanGaps",\n    "tryRelaxAndRepairGapGaps",', 1)
            print(f"Registered tryRelaxAndRepairGapGaps in GUARDED_OPERATORS in {ep}")
            
        with open(ep, "w", encoding="utf-8") as f:
            f.write(code)
            
    # Update cache buster in sapxep.html
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
    print(f"\nDeploying Relax & Repair Engine from {REPO_ROOT} to VPS {host}...")
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
    print("\n=== RELAX & REPAIR FULLY DEPLOYED TO PRODUCTION ===")

if __name__ == "__main__":
    integrate_relax_and_deploy()
