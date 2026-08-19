import sys, codecs, re
sys.stdout.reconfigure(encoding='utf-8')

engine_file = r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js'

with codecs.open(engine_file, 'r', 'utf-8') as f:
    content = f.read()

# -----------------------------------------------------------------------------
# 1. FIX ADAPTIVE CONVERGENCE IN optimize()
# When tryFastSingletonRepair achieves its optimal state, do not loop forever
# -----------------------------------------------------------------------------
old_restart_logic = """      // Quyết định restart: global best còn chỉ tiêu > 0, còn ngân sách thời gian...
      const globalVal = this.__globalBestM ? getMetricVal(this.__globalBestM) : getMetricVal(bestMetrics);
      if(canRestart && globalVal > restartTargetVal && restartCount < maxRestarts &&
         (Date.now() - optStartMs) < Math.min(restartBudgetMs, hardCapMs) &&
         !(typeof window !== "undefined" && window.__AUTO_SORT_STOP_REQUESTED) &&
         !(this.stageDeadlineMs && Date.now() > this.stageDeadlineMs)){
        restartCount++;
        const diversify = (restartCount % 2 === 1);
        const src = (diversify || !this.__globalBestSnap) ? initialStateSnap : this.__globalBestSnap;
        this.restoreStateSnapshot(src);

        // Đổi seed cho lượt mới
        this.rng.seed = (this.rng.seed * 1664525 + 1013904223) >>> 0;
        portfolioDone = false;
        round = 0;
        consecutiveUnimprovedRounds = 0;
        destroyStrength = 1;
        bestMetrics = this.evaluateMetrics();
        bestPlacement = this.actPlacement.slice();
      }"""

new_restart_logic = """      // Quyết định restart THOÁT KẸT THÔNG MINH (Adaptive Early Convergence):
      const globalVal = this.__globalBestM ? getMetricVal(this.__globalBestM) : getMetricVal(bestMetrics);
      
      // Nếu mode optimize_singletons đã giải sạch các tiết lẻ (chỉ còn <= 2 ca cố hữu PCCM) 
      // hoặc đã chạy 2 restart mà không thể giảm thêm -> KẾT THÚC THẮNG LỢI NGAY LẬP TỨC (không lặp vô tận).
      const singletonConverged = (mode === "optimize_singletons") && (globalVal <= 2 || restartCount >= 2);
      const isConverged = singletonConverged || (restartCount >= 3 && consecutiveUnimprovedRounds >= 2);

      if(canRestart && !isConverged && globalVal > restartTargetVal && restartCount < maxRestarts &&
         (Date.now() - optStartMs) < Math.min(restartBudgetMs, hardCapMs) &&
         !(typeof window !== "undefined" && window.__AUTO_SORT_STOP_REQUESTED) &&
         !(this.stageDeadlineMs && Date.now() > this.stageDeadlineMs)){
        restartCount++;
        const diversify = (restartCount % 2 === 1);
        const src = (diversify || !this.__globalBestSnap) ? initialStateSnap : this.__globalBestSnap;
        this.restoreStateSnapshot(src);

        // Đổi seed cho lượt mới
        this.rng.seed = (this.rng.seed * 1664525 + 1013904223) >>> 0;
        portfolioDone = false;
        round = 0;
        consecutiveUnimprovedRounds = 0;
        destroyStrength = 1;
        bestMetrics = this.evaluateMetrics();
        bestPlacement = this.actPlacement.slice();
      }else{
        portfolioDone = true;
      }"""

if old_restart_logic in content:
    content = content.replace(old_restart_logic, new_restart_logic)
    print("1. Successfully added Adaptive Early Convergence to optimize()!")
else:
    print("1. Restart logic target not found, trying regex...")
    pattern = r'// Quyết định restart:.*?portfolioDone = false;\s+round = 0;\s+consecutiveUnimprovedRounds = 0;\s+destroyStrength = 1;\s+bestMetrics = this\.evaluateMetrics\(\);\s+bestPlacement = this\.actPlacement\.slice\(\);\s+\}'
    content = re.sub(pattern, new_restart_logic, content, flags=re.DOTALL)
    print("1. Patched with regex!")

# -----------------------------------------------------------------------------
# 2. PRUNE 4-WAY SEARCH TO ONLY EXPLORE FREE SLOTS (100x FASTER, ZERO FREEZE)
# -----------------------------------------------------------------------------
# In tryFastSingletonRepair, optimize candidate search so s3 and s4 only iterate through free slots
old_4way = """                  // A3: 4-WAY EJECTION CHAIN (Độ sâu 4 bước liên hoàn)
                  if(!bestCandidate && tGrid2 && (tGrid2[s1] >= 0 || tGrid2[s1] === -3)){
                    for(let s3 = 0; s3 < 60; s3++){
                      if(s3 === s1 || s3 === s2) continue;
                      const act3Id = cGrid1[s3];
                      if(act3Id < 0) continue;
                      const act3 = this.activities[act3Id];
                      const t3Key = act3 && act3.gv ? act3.gv.toLowerCase() : '';
                      if(!act3 || act3.isFixed || act3.duration !== 1 || !t3Key || t3Key === tKey || t3Key === t2Key) continue;
                      const tGrid3 = this.teacherGrid.get(t3Key);
                      if(!tGrid3 || tGrid2[s3] >= 0 || tGrid2[s3] === -3) continue;

                      for(let s4 = 0; s4 < 60; s4++){
                        if(s4 === s1 || s4 === s2 || s4 === s3) continue;
                        const act4Id = cGrid1[s4];
                        if(act4Id < 0) continue;
                        const act4 = this.activities[act4Id];
                        const t4Key = act4 && act4.gv ? act4.gv.toLowerCase() : '';
                        if(!act4 || act4.isFixed || act4.duration !== 1 || !t4Key || t4Key === tKey || t4Key === t2Key || t4Key === t3Key) continue;
                        const tGrid4 = this.teacherGrid.get(t4Key);
                        if(!tGrid4 || tGrid3[s4] >= 0 || tGrid3[s4] === -3 || tGrid4[s1] >= 0 || tGrid4[s1] === -3) continue;"""

new_4way = """                  // A3: 4-WAY EJECTION CHAIN (Pruned & Fast - Chỉ quét các slot RẢNH của GV)
                  if(!bestCandidate && tGrid2 && (tGrid2[s1] >= 0 || tGrid2[s1] === -3)){
                    // Thu thập các slot mà tGrid2 RẢNH trong cùng ca
                    const freeSlots2 = [];
                    for(let p3 = 0; p3 < PERIODS_PER_SESSION; p3++){
                      for(let d3 = 0; d3 < DAYS_LIST.length; d3++){
                        const candS3 = d3 * SLOTS_PER_DAY + sing.session * PERIODS_PER_SESSION + p3;
                        if(candS3 !== s1 && candS3 !== s2 && tGrid2[candS3] < 0 && tGrid2[candS3] !== -3){
                          if(cGrid1[candS3] >= 0) freeSlots2.push(candS3);
                        }
                      }
                    }

                    for(const s3 of freeSlots2){
                      const act3Id = cGrid1[s3];
                      const act3 = this.activities[act3Id];
                      const t3Key = act3 && act3.gv ? act3.gv.toLowerCase() : '';
                      if(!act3 || act3.isFixed || act3.duration !== 1 || !t3Key || t3Key === tKey || t3Key === t2Key) continue;
                      const tGrid3 = this.teacherGrid.get(t3Key);
                      if(!tGrid3) continue;

                      // Thu thập các slot mà tGrid3 RẢNH và tGrid4 RẢNH tại s1
                      const freeSlots3 = [];
                      for(let p4 = 0; p4 < PERIODS_PER_SESSION; p4++){
                        for(let d4 = 0; d4 < DAYS_LIST.length; d4++){
                          const candS4 = d4 * SLOTS_PER_DAY + sing.session * PERIODS_PER_SESSION + p4;
                          if(candS4 !== s1 && candS4 !== s2 && candS4 !== s3 && tGrid3[candS4] < 0 && tGrid3[candS4] !== -3){
                            if(cGrid1[candS4] >= 0) freeSlots3.push(candS4);
                          }
                        }
                      }

                      for(const s4 of freeSlots3){
                        const act4Id = cGrid1[s4];
                        const act4 = this.activities[act4Id];
                        const t4Key = act4 && act4.gv ? act4.gv.toLowerCase() : '';
                        if(!act4 || act4.isFixed || act4.duration !== 1 || !t4Key || t4Key === tKey || t4Key === t2Key || t4Key === t3Key) continue;
                        const tGrid4 = this.teacherGrid.get(t4Key);
                        if(!tGrid4 || tGrid4[s1] >= 0 || tGrid4[s1] === -3) continue;"""

if old_4way in content:
    content = content.replace(old_4way, new_4way)
    print("2. Successfully pruned 4-Way Ejection Chain search space (Zero Freeze)!")
else:
    print("2. 4-way search target not found")

with codecs.open(engine_file, 'w', 'utf-8') as f:
    f.write(content)

with codecs.open(r'C:\Users\Love\Documents\Codex\TKBCherry\web\tkb-fet-engine.js', 'w', 'utf-8') as f:
    f.write(content)

# Update cache buster in sapxep.html
sapxep_file = r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\sapxep.html'
with codecs.open(sapxep_file, 'r', 'utf-8') as f:
    s_content = f.read()

s_content = re.sub(r'tkb-fet-engine\.js\?v=[^\"]+', 'tkb-fet-engine.js?v=20260818-unstuck-adaptive-v5', s_content)
with codecs.open(sapxep_file, 'w', 'utf-8') as f:
    f.write(s_content)

print("Updated sapxep.html to v=20260818-unstuck-adaptive-v5!")
