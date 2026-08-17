import sys
import os

sys.stdout.reconfigure(encoding='utf-8')

def patch_engine():
    engine_path = r"C:\Users\Love\Documents\Codex\MD\tkb-fet-engine.js"
    with open(engine_path, "r", encoding="utf-8", errors="ignore") as f:
        content = f.read()
        
    # Operator implementation
    new_operator = """
    // 3f. Intra-Session Cross-Class Chain & 3-Cycle Gap Crusher (Toi uu triet de gap2 khong tang buoi 1 tiet)
    tryIntraSessionCrossClassChain(bestMetrics, initialMetrics, mode = "optimize_gap2", onProgress = null){
      const PERIODS = PERIODS_PER_SESSION;
      let currentBest = { ...bestMetrics };
      let anyImproved = false;

      const teacherList = Array.from(this.teacherGrid.keys()).filter(t => t && this.isScoredTeacher(t));
      this.rng.shuffle(teacherList);

      const parseTeacherList = (gvStr) => {
        if(!gvStr) return [];
        return gvStr.split(",").map(s => s.trim()).filter(Boolean);
      };

      for(const tKey of teacherList){
        const tGrid = this.teacherGrid.get(tKey);
        if(!tGrid) continue;

        for(let d = 0; d < DAYS_LIST.length; d++){
          for(let b = 0; b < SESSIONS_LIST.length; b++){
            const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
            const taughtPs = [];
            for(let p = 0; p < PERIODS; p++){
              if(tGrid[sStart + p] >= 0 || tGrid[sStart + p] === -3) taughtPs.push(p);
            }
            if(taughtPs.length < 2) continue;
            const holes = (taughtPs[taughtPs.length - 1] - taughtPs[0] + 1) - taughtPs.length;
            const isTarget = mode === "optimize_gap1" ? holes === 1 : holes >= 2;
            if(!isTarget) continue;

            // Thu thap tat ca cac lop hoc trong buoi nay
            const sessionClasses = [];
            this.classGrid.forEach((cg, cid) => {
              if(!cid) return;
              let hasLesson = false;
              for(let p = 0; p < PERIODS; p++){
                if(cg[sStart + p] >= 0){ hasLesson = true; break; }
              }
              if(hasLesson) sessionClasses.push(cid);
            });
            this.rng.shuffle(sessionClasses);

            let resolved = false;

            // --- 1. Thu Intra-Class 3-Cycle tren cac lop cua buoi ---
            for(const cid of sessionClasses){
              const cg = this.classGrid.get(cid);
              for(let p1 = 0; p1 < PERIODS; p1++){
                const a1Id = cg[sStart + p1];
                if(a1Id < 0) continue;
                const a1 = this.activities[a1Id];
                if(!a1 || a1.isFixed || a1.duration !== 1) continue;

                for(let p2 = 0; p2 < PERIODS; p2++){
                  if(p2 === p1) continue;
                  const a2Id = cg[sStart + p2];
                  if(a2Id < 0) continue;
                  const a2 = this.activities[a2Id];
                  if(!a2 || a2.isFixed || a2.duration !== 1) continue;

                  for(let p3 = 0; p3 < PERIODS; p3++){
                    if(p3 === p1 || p3 === p2) continue;
                    const a3Id = cg[sStart + p3];
                    if(a3Id < 0) continue;
                    const a3 = this.activities[a3Id];
                    if(!a3 || a3.isFixed || a3.duration !== 1) continue;

                    // Thu cycle: p1->p2, p2->p3, p3->p1
                    const snap = this.captureStateSnapshot();
                    this.unplaceActivity(a1.id);
                    this.unplaceActivity(a2.id);
                    this.unplaceActivity(a3.id);

                    const r1 = this.getConflictsForSlot(a1, sStart + p2);
                    const r2 = this.getConflictsForSlot(a2, sStart + p3);
                    const r3 = this.getConflictsForSlot(a3, sStart + p1);

                    let ok = r1.possible && !r1.conflicts.length &&
                             r2.possible && !r2.conflicts.length &&
                             r3.possible && !r3.conflicts.length;

                    if(ok){
                      this.placeActivityDirect(a1.id, sStart + p2);
                      this.placeActivityDirect(a2.id, sStart + p3);
                      this.placeActivityDirect(a3.id, sStart + p1);
                      if(this.isLessonBlockSafe(a1, a2, a3)){
                        const m = this.evaluateMetrics();
                        if(this.compareMetrics(m, currentBest, mode) < 0){
                          currentBest = { ...m };
                          anyImproved = true;
                          resolved = true;
                          if(typeof onProgress === "function") onProgress(currentBest);
                        }
                      }
                    }
                    if(!resolved) this.restoreStateSnapshot(snap);
                    if(resolved) break;
                  }
                  if(resolved) break;
                }
                if(resolved) break;
              }
              if(resolved) break;
            }
            if(resolved) break;

            // --- 2. Thu Intra-Session 2-Class Chain (cls1: p1<->p2, cls2: p3<->p4) ---
            for(let i = 0; i < sessionClasses.length && !resolved; i++){
              const cid1 = sessionClasses[i];
              const cg1 = this.classGrid.get(cid1);

              for(let j = 0; j < sessionClasses.length && !resolved; j++){
                if(i === j) continue;
                const cid2 = sessionClasses[j];
                const cg2 = this.classGrid.get(cid2);

                for(let p1 = 0; p1 < PERIODS; p1++){
                  const a1Id = cg1[sStart + p1];
                  if(a1Id < 0) continue;
                  const a1 = this.activities[a1Id];
                  if(!a1 || a1.isFixed || a1.duration !== 1) continue;

                  for(let p2 = 0; p2 < PERIODS; p2++){
                    if(p2 === p1) continue;
                    const a2Id = cg1[sStart + p2];
                    if(a2Id < 0) continue;
                    const a2 = this.activities[a2Id];
                    if(!a2 || a2.isFixed || a2.duration !== 1) continue;

                    for(let p3 = 0; p3 < PERIODS; p3++){
                      const a3Id = cg2[sStart + p3];
                      if(a3Id < 0) continue;
                      const a3 = this.activities[a3Id];
                      if(!a3 || a3.isFixed || a3.duration !== 1) continue;

                      for(let p4 = 0; p4 < PERIODS; p4++){
                        if(p4 === p3) continue;
                        const a4Id = cg2[sStart + p4];
                        if(a4Id < 0) continue;
                        const a4 = this.activities[a4Id];
                        if(!a4 || a4.isFixed || a4.duration !== 1) continue;

                        // Swap a1(p1)<->a2(p2) in cid1 and a3(p3)<->a4(p4) in cid2
                        const snap = this.captureStateSnapshot();
                        this.unplaceActivity(a1.id);
                        this.unplaceActivity(a2.id);
                        this.unplaceActivity(a3.id);
                        this.unplaceActivity(a4.id);

                        const r1 = this.getConflictsForSlot(a1, sStart + p2);
                        const r2 = this.getConflictsForSlot(a2, sStart + p1);
                        const r3 = this.getConflictsForSlot(a3, sStart + p4);
                        const r4 = this.getConflictsForSlot(a4, sStart + p3);

                        let ok = r1.possible && !r1.conflicts.length &&
                                 r2.possible && !r2.conflicts.length &&
                                 r3.possible && !r3.conflicts.length &&
                                 r4.possible && !r4.conflicts.length;

                        if(ok){
                          this.placeActivityDirect(a1.id, sStart + p2);
                          this.placeActivityDirect(a2.id, sStart + p1);
                          this.placeActivityDirect(a3.id, sStart + p4);
                          this.placeActivityDirect(a4.id, sStart + p3);
                          if(this.isLessonBlockSafe(a1, a2, a3, a4)){
                            const m = this.evaluateMetrics();
                            if(this.compareMetrics(m, currentBest, mode) < 0){
                              currentBest = { ...m };
                              anyImproved = true;
                              resolved = true;
                              if(typeof onProgress === "function") onProgress(currentBest);
                            }
                          }
                        }
                        if(!resolved) this.restoreStateSnapshot(snap);
                        if(resolved) break;
                      }
                      if(resolved) break;
                    }
                    if(resolved) break;
                  }
                  if(resolved) break;
                }
              }
            }
            if(resolved) break;
          }
          if(anyImproved) break;
        }
        if(anyImproved) break;
      }

      return anyImproved ? currentBest : null;
    }
"""
    
    # 1. Insert method definition before compareMetrics
    insertion_target = "compareMetrics(a, b, mode = \"optimize_singletons\"){"
    if insertion_target not in content:
        print("ERROR: Could not find compareMetrics insertion target!")
        return False
        
    content = content.replace(insertion_target, new_operator + "\n    " + insertion_target, 1)
    
    # 2. Insert call in optimize() under mode === "optimize_gap2"
    call_target = """          const resKempe = this.tryKempeChainPeriodSwap(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resKempe && this.compareMetrics(resKempe, bestMetrics, mode) < 0){
            bestMetrics = { ...resKempe };
            saveBestSnapshot();
            improvedInRound = true;
          }"""
          
    call_replacement = call_target + """

          // 3f. Intra-Session Cross-Class Chain & 3-Cycle (Toi uu triet de gap2 khong sinh 1-tiet/buoi)
          const resChain2 = this.tryIntraSessionCrossClassChain(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resChain2 && this.compareMetrics(resChain2, bestMetrics, mode) < 0){
            bestMetrics = { ...resChain2 };
            saveBestSnapshot();
            improvedInRound = true;
          }"""
          
    if call_target not in content:
        print("ERROR: Could not find call_target in optimize_gap2!")
        return False
        
    content = content.replace(call_target, call_replacement, 1)
    
    with open(engine_path, "w", encoding="utf-8") as f:
        f.write(content)
        
    print("SUCCESSFULLY PATCHED tkb-fet-engine.js!")
    return True

if __name__ == "__main__":
    patch_engine()
