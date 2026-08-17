import sys
import paramiko
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

REPO_ROOT = Path(r"C:\Users\Love\Documents\Codex\TKBCherry")
TOOLS_DIR = REPO_ROOT / "tools" / "vps-deploy"
sys.path.insert(0, str(TOOLS_DIR))
from vps_credentials import resolve_vps_connection

def refactor_engine_and_deploy():
    engine_files = [
        REPO_ROOT / "web" / "tkb-fet-engine.js",
        REPO_ROOT / "web" / "pages" / "tkb-fet-engine.js",
        Path(r"C:\Users\Love\Documents\Codex\MD\tkb-fet-engine.js")
    ]
    
    for ep in engine_files:
        with open(ep, "r", encoding="utf-8") as f:
            code = f.read()
            
        # 1. Unlock gap2SessionBudget permanently from round 0
        old_budget_block = """        if(mode === "optimize_gap2"){
          // Session budget: gap2 = 0 outranks total sessions in the agreed
          // priority order, so unlock the controlled budget early — after the
          // first stagnation or 30% of rounds — and default it higher.
          if(round >= Math.floor(MAX_ROUNDS * 0.3) || consecutiveUnimprovedRounds >= 3){
            this.gap2SessionBudget = this.options.gap2SessionBudget || 6;
          }else{
            this.gap2SessionBudget = 0;
          }"""
          
        new_budget_block = """        if(mode === "optimize_gap2"){
          // Unconditional open session budget for aggressive gap2 -> 0 reduction
          this.gap2SessionBudget = this.options.gap2SessionBudget || 20;"""
          
        if old_budget_block in code:
            code = code.replace(old_budget_block, new_budget_block, 1)
            print(f"Unlocked permanent session budget in {ep}")
            
        # 2. Add top-priority operators right at the start of optimize_gap2
        gap2_start_target = """        if(mode === "optimize_gap2"){
          // Unconditional open session budget for aggressive gap2 -> 0 reduction
          this.gap2SessionBudget = this.options.gap2SessionBudget || 20;"""
          
        gap2_start_injection = gap2_start_target + """

          // Priority 1: Borrow lessons from rich sessions to fill holes
          const resBorrowEarly = this.tryBorrowLessonFromRichSessions(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resBorrowEarly && this.compareMetrics(resBorrowEarly, bestMetrics, mode) < 0){
            bestMetrics = { ...resBorrowEarly };
            saveBestSnapshot();
            improvedInRound = true;
          }

          // Priority 2: Inter-day relocation of gap lessons
          const resInterDayEarly = this.tryInterDayRelocateGapLesson(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resInterDayEarly && this.compareMetrics(resInterDayEarly, bestMetrics, mode) < 0){
            bestMetrics = { ...resInterDayEarly };
            saveBestSnapshot();
            improvedInRound = true;
          }

          // Priority 3: Block-shift & intra-class swap
          const resBlockShiftEarly = this.tryBlockShiftAndGapResolution(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resBlockShiftEarly && this.compareMetrics(resBlockShiftEarly, bestMetrics, mode) < 0){
            bestMetrics = { ...resBlockShiftEarly };
            saveBestSnapshot();
            improvedInRound = true;
          }

          // Priority 4: Cross-class chain
          const resChainEarly = this.tryIntraSessionCrossClassChain(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resChainEarly && this.compareMetrics(resChainEarly, bestMetrics, mode) < 0){
            bestMetrics = { ...resChainEarly };
            saveBestSnapshot();
            improvedInRound = true;
          }"""
          
        if "resBorrowEarly" not in code:
            code = code.replace(gap2_start_target, gap2_start_injection, 1)
            print(f"Injected top-priority operators into {ep}")
            
        with open(ep, "w", encoding="utf-8") as f:
            f.write(code)
            
    # Deploy to VPS
    host, user, password = resolve_vps_connection()
    print(f"\nDeploying final aggressive optimizer to VPS {host}...")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=password, timeout=30)
    
    sftp = client.open_sftp()
    local_src = str(REPO_ROOT / "web" / "tkb-fet-engine.js")
    sftp.put(local_src, "/opt/cherry-scheduler/web/tkb-fet-engine.js")
    sftp.put(local_src, "/opt/cherry-scheduler/web/pages/tkb-fet-engine.js")
    sftp.close()
    
    stdin, stdout, stderr = client.exec_command("systemctl restart tkb-app && systemctl is-active tkb-app")
    print("VPS service status:", stdout.read().decode().strip())
    client.close()
    print("DEPLOYMENT FULLY COMPLETED!")

if __name__ == "__main__":
    refactor_engine_and_deploy()
