import sys
import paramiko
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

REPO_ROOT = Path(r"C:\Users\Love\Documents\Codex\TKBCherry")
TOOLS_DIR = REPO_ROOT / "tools" / "vps-deploy"
sys.path.insert(0, str(TOOLS_DIR))
from vps_credentials import resolve_vps_connection

BLOCK_SWAP_OP = """
    tryIntraClassSingleDoubleBlockSwap(bestMetrics, initialMetrics, mode = "optimize_gap2", onProgress = null) {
      let currentBest = { ...bestMetrics };
      let anyImproved = false;

      const PERIODS = 5;
      const SLOTS_PER_DAY = 10;
      const DAYS_LIST = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
      const SESSIONS_LIST = ["sang", "chieu"];

      for(const [cid, cg] of this.classGrid.entries()) {
        if(!cid || !cg) continue;

        for(let d = 0; d < DAYS_LIST.length; d++) {
          for(let b = 0; b < SESSIONS_LIST.length; b++) {
            const sStart = d * SLOTS_PER_DAY + b * PERIODS;

            for(let p1 = 0; p1 < PERIODS; p1++) {
              const act1Id = cg[sStart + p1];
              if(act1Id < 0) continue;
              const act1 = this.activities[act1Id];
              if(!act1 || act1.isFixed || act1.duration !== 1) continue;

              for(let p2 = 0; p2 < PERIODS - 1; p2++) {
                if(p2 === p1 || p2 + 1 === p1) continue;
                const act2Id = cg[sStart + p2];
                const act3Id = cg[sStart + p2 + 1];
                if(act2Id < 0 || act3Id < 0) continue;

                const act2 = this.activities[act2Id];
                const act3 = this.activities[act3Id];
                if(!act2 || !act3 || act2.isFixed || act3.isFixed) continue;

                if(p1 === 4 && p2 === 2) {
                  const snap = this.captureStateSnapshot();
                  this.unplaceActivity(act1.id);
                  this.unplaceActivity(act2.id);
                  this.unplaceActivity(act3.id);

                  const sP3 = sStart + 2;
                  const sP4 = sStart + 3;
                  const sP5 = sStart + 4;

                  const r1 = this.getConflictsForSlot(act1, sP3);
                  const r2 = this.getConflictsForSlot(act2, sP4);
                  const r3 = this.getConflictsForSlot(act3, sP5);

                  if(r1.possible && !r1.conflicts.length && r2.possible && !r2.conflicts.length && r3.possible && !r3.conflicts.length) {
                    this.placeActivityDirect(act1.id, sP3);
                    this.placeActivityDirect(act2.id, sP4);
                    this.placeActivityDirect(act3.id, sP5);

                    if(this.isLessonBlockSafe(act1, act2, act3) &&
                       this.isDailySubjectLimitSafe(act1, sP3) &&
                       this.isDailySubjectLimitSafe(act2, sP4) &&
                       this.isDailySubjectLimitSafe(act3, sP5)) {
                      const m = this.evaluateMetrics();
                      if(this.compareMetrics(m, currentBest, mode) < 0) {
                        currentBest = { ...m };
                        anyImproved = true;
                        if(typeof onProgress === "function") onProgress(currentBest);
                      }
                    }
                  }
                  if(!anyImproved) this.restoreStateSnapshot(snap);
                }

                if(p1 === 2 && p2 === 3) {
                  const snap = this.captureStateSnapshot();
                  this.unplaceActivity(act1.id);
                  this.unplaceActivity(act2.id);
                  this.unplaceActivity(act3.id);

                  const sP3 = sStart + 2;
                  const sP4 = sStart + 3;
                  const sP5 = sStart + 4;

                  const r2 = this.getConflictsForSlot(act2, sP3);
                  const r3 = this.getConflictsForSlot(act3, sP4);
                  const r1 = this.getConflictsForSlot(act1, sP5);

                  if(r1.possible && !r1.conflicts.length && r2.possible && !r2.conflicts.length && r3.possible && !r3.conflicts.length) {
                    this.placeActivityDirect(act2.id, sP3);
                    this.placeActivityDirect(act3.id, sP4);
                    this.placeActivityDirect(act1.id, sP5);

                    if(this.isLessonBlockSafe(act1, act2, act3) &&
                       this.isDailySubjectLimitSafe(act2, sP3) &&
                       this.isDailySubjectLimitSafe(act3, sP4) &&
                       this.isDailySubjectLimitSafe(act1, sP5)) {
                      const m = this.evaluateMetrics();
                      if(this.compareMetrics(m, currentBest, mode) < 0) {
                        currentBest = { ...m };
                        anyImproved = true;
                        if(typeof onProgress === "function") onProgress(currentBest);
                      }
                    }
                  }
                  if(!anyImproved) this.restoreStateSnapshot(snap);
                }
              }
            }
          }
        }
      }

      return anyImproved ? currentBest : null;
    }
"""

def integrate_block_swap_and_deploy():
    engine_files = [
        REPO_ROOT / "web" / "tkb-fet-engine.js",
        REPO_ROOT / "web" / "pages" / "tkb-fet-engine.js"
    ]
    
    for ep in engine_files:
        with open(ep, "r", encoding="utf-8") as f:
            code = f.read()
            
        if "tryIntraClassSingleDoubleBlockSwap(" not in code:
            target = "compareMetrics(a, b, mode = \"optimize_singletons\"){"
            code = code.replace(target, BLOCK_SWAP_OP + "\n    " + target, 1)
            print(f"Added tryIntraClassSingleDoubleBlockSwap to {ep}")
            
        hook_target = 'const resRelaxRepair = this.tryRelaxAndRepairGapGaps(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);'
        hook_insert = """
          const resBlockSwap = this.tryIntraClassSingleDoubleBlockSwap(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resBlockSwap && this.compareMetrics(resBlockSwap, bestMetrics, mode) < 0){
            bestMetrics = { ...resBlockSwap };
            saveBestSnapshot();
            improvedInRound = true;
          }
""" + hook_target

        if "resBlockSwap" not in code:
            code = code.replace(hook_target, hook_insert, 1)
            print(f"Hooked tryIntraClassSingleDoubleBlockSwap into optimize_gap2 in {ep}")
            
        if '"tryIntraClassSingleDoubleBlockSwap",' not in code:
            code = code.replace('"tryRelaxAndRepairGapGaps",', '"tryRelaxAndRepairGapGaps",\n    "tryIntraClassSingleDoubleBlockSwap",', 1)
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
    print(f"\nDeploying final engine with Intra-Class Block Swap to VPS {host}...")
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
    print("\n=== COMPLETE DEPLOYMENT FINISHED 100% ===")

if __name__ == "__main__":
    integrate_block_swap_and_deploy()
