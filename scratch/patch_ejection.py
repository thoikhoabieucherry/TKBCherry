import codecs

file_path = r'C:\Users\Love\Documents\Codex\TKBCherry\web\tkb-fet-engine.js'

with codecs.open(file_path, 'r', 'utf-8') as f:
    content = f.read()

# 1. Revert LNS limitCalls
content = content.replace(
    'this.limitCalls = 80000; // Increased from 6000 to allow deep targeted re-generation',
    'this.limitCalls = 6000;'
)

# 2. Adjust optimizeGap2WithBorrow (Phase B slack from 3 to 1 to reduce fluctuation)
content = content.replace(
    'await runPhase("optimize_gap2", 0.25, { singletonSlack: 3 }, 2);',
    'await runPhase("optimize_gap2", 0.25, { singletonSlack: 1 }, 2);'
)

# 3. Add trySingletonEjectionChain
new_method = """
    // FET-Style Deep Ejection Chain for Singletons (Triệt tiêu 1 tiết có chủ đích)
    trySingletonEjectionChain(targetTeachers, bestMetrics, mode = "optimize_singletons", onProgress = null) {
      let currentBest = { ...bestMetrics };
      let anyImproved = false;

      for(const tKey of targetTeachers){
        const grid = this.teacherGrid.get(tKey);
        if(!grid) continue;

        // Find singleton slots (1-tiet)
        const tSlots = [];
        let totalWeeklyPeriods = 0;
        for(let s = 0; s < TOTAL_SLOTS; s++){
          if(grid[s] >= 0 || grid[s] === -3) totalWeeklyPeriods++;
        }
        for(let d = 0; d < DAYS_LIST.length; d++){
          for(let b = 0; b < SESSIONS_LIST.length; b++){
            const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
            const taught = [];
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const s = sStart + p;
              if(grid[s] >= 0 || grid[s] === -3) taught.push({ s, actId: grid[s] });
            }
            if(taught.length === 1 && taught[0].actId >= 0){
              const act = this.activities[taught[0].actId];
              if(act && !act.isFixed && act.duration === 1) tSlots.push(act);
            }
          }
        }

        for(const act of tSlots){
          const snap = this.captureStateSnapshot();
          this.unplaceActivity(act.id);
          
          // Use randomSwap as a Deep Ejection Chain (similar to FET's swapActivity)
          const savedCalls = this.limitCalls;
          this.limitCalls = 12000; // Deep but bounded recursive search
          this.nCalls = 0;
          
          const ok = this.randomSwap(act.id, 0);
          this.limitCalls = savedCalls;

          if(ok && this.isLessonBlockSafe()){
            const m = this.evaluateMetrics();
            if(this.compareMetrics(m, currentBest, mode) < 0){
              currentBest = { ...m };
              anyImproved = true;
              if(typeof onProgress === "function") onProgress(currentBest);
              continue; // keep it
            }
          }
          this.restoreStateSnapshot(snap); // Rollback immediately if not strictly better
        }
      }
      return anyImproved ? currentBest : null;
    }
"""

if 'trySingletonEjectionChain(' not in content:
    # insert before tryDeepEjectionChain
    content = content.replace(
        'tryDeepEjectionChain(targetTeachers, bestMetrics, mode = "optimize_singletons", onProgress = null){',
        new_method + '\n    tryDeepEjectionChain(targetTeachers, bestMetrics, mode = "optimize_singletons", onProgress = null){'
    )

# 4. Call trySingletonEjectionChain in optimize loop
# Find where tryDeepEjectionChain is called and add trySingletonEjectionChain before it
opt_loop_call = """
              const resSing = this.trySingletonEjectionChain(bottleneckTeachers.slice(0, 10), bestMetrics, mode, notifyLiveProgress);
              if(resSing && this.compareMetrics(resSing, bestMetrics, mode) < 0){
                bestMetrics = { ...resSing };
                saveBestSnapshot();
                improvedInRound = true;
                consecutiveUnimprovedRounds = 0;
              }
"""

if 'this.trySingletonEjectionChain(bottleneckTeachers' not in content:
    content = content.replace(
        'const resChain = this.tryDeepEjectionChain(bottleneckTeachers.slice(0, 5)',
        opt_loop_call + '\n              const resChain = this.tryDeepEjectionChain(bottleneckTeachers.slice(0, 5)'
    )


with codecs.open(file_path, 'w', 'utf-8') as f:
    f.write(content)
print("Patch applied successfully.")
