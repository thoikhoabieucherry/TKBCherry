import sys, codecs
sys.stdout.reconfigure(encoding='utf-8')

engine_file = r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js'

with codecs.open(engine_file, 'r', 'utf-8') as f:
    content = f.read()

# -----------------------------------------------------------------------------
# 1. FIX P0 BUG 3.1: Tabu oldSlot in randomSwap
# -----------------------------------------------------------------------------
old_tabu_code = """        this.jrnPlace(actId, slot);

        const oldSlot = act.fixedSlot >= 0 ? act.fixedSlot : this.actPlacement[actId];
        if(oldSlot >= 0){
          this.tabuMap.set(`${actId}|${oldSlot}`, this.currentStep + this.activities.length);
        }"""

new_tabu_code = """        const oldSlot = act.fixedSlot >= 0 ? act.fixedSlot : this.actPlacement[actId];
        this.jrnPlace(actId, slot);

        if(oldSlot >= 0){
          this.tabuMap.set(`${actId}|${oldSlot}`, this.currentStep + this.activities.length);
        }"""

if old_tabu_code in content:
    content = content.replace(old_tabu_code, new_tabu_code)
    print("Fixed Bug 3.1 (tabu oldSlot in randomSwap)")
else:
    print("Bug 3.1 target not found or already patched")

# -----------------------------------------------------------------------------
# 2. FIX P0 BUG 3.2: candM in tryAugmentingSingletonEjectionChain 3-way
# -----------------------------------------------------------------------------
old_3way_cand = """                      this.jrnPlace(act1.id, s2);
                      this.jrnPlace(act2.id, s3);
                      this.jrnPlace(act3.id, s1);

                      const isBetter = (candM.soBuoiTrong2 <= currentBest.soBuoiTrong2) &&"""

new_3way_cand = """                      this.jrnPlace(act1.id, s2);
                      this.jrnPlace(act2.id, s3);
                      this.jrnPlace(act3.id, s1);

                      const candM = this.evaluateMetrics();
                      const isBetter = (candM.soBuoiTrong2 <= currentBest.soBuoiTrong2) &&"""

if old_3way_cand in content:
    content = content.replace(old_3way_cand, new_3way_cand)
    print("Fixed Bug 3.2 (candM in tryAugmentingSingletonEjectionChain)")
else:
    print("Bug 3.2 target not found or already patched")

# -----------------------------------------------------------------------------
# 3. ADD FAST-PATH SINGLETON REPAIR (tryFastSingletonRepair)
# -----------------------------------------------------------------------------
fast_repair_method = """
    // =========================================================================
    // FAST-PATH TARGETED SINGLETON REPAIR (ANTIGRAVITY DIRECTION 1)
    // Tối ưu siêu tốc deterministic chuyên biệt cho mục tiêu 1-tiết/buổi:
    // 1. Move-Out: Đẩy tiết đơn lẻ sang buổi khác cùng ca có sẵn tiết
    // 2. Pull-In / Reinforce: Kéo 1 tiết từ buổi giàu (>=3t) về ghép thành buổi 2t
    // 3. Incremental Delta Metrics & Transaction Journal Rollback
    // =========================================================================
    tryFastSingletonRepair(currentBestMetrics = null, initialMetrics = null, onProgress = null){
      const DAYS = DAYS_LIST.length;
      const SESSIONS = SESSIONS_LIST.length;
      const PERIODS = PERIODS_PER_SESSION;

      let currentBest = currentBestMetrics ? { ...currentBestMetrics } : this.evaluateMetrics();
      if(currentBest.soBuoiDay1 === 0) return currentBest;

      let anyImproved = false;
      const maxPasses = 10;

      for(let pass = 0; pass < maxPasses; pass++){
        if(currentBest.soBuoiDay1 === 0) break;
        let passImproved = false;

        // 1. Thu thập danh sách singletons thực sự
        const singletons = [];
        this.teacherGrid.forEach((grid, tKey) => {
          if(!tKey || !this.isScoredTeacher(tKey)) return;
          for(let d = 0; d < DAYS; d++){
            for(let b = 0; b < SESSIONS; b++){
              const sStart = d * SLOTS_PER_DAY + b * PERIODS;
              const taught = [];
              for(let p = 0; p < PERIODS; p++){
                const s = sStart + p;
                const actId = grid[s];
                if(actId >= 0){
                  const act = this.activities[actId];
                  if(act && !act.isFixed && act.duration === 1){
                    taught.push({ slot: s, actId, p, act });
                  }
                }else if(actId === -3){
                  taught.push({ slot: s, actId: -3, p, act: null });
                }
              }
              if(taught.length === 1 && taught[0].actId >= 0){
                singletons.push({
                  teacher: tKey,
                  day: d,
                  session: b,
                  sStart,
                  slot: taught[0].slot,
                  actId: taught[0].actId,
                  act: taught[0].act
                });
              }
            }
          }
        });

        if(singletons.length === 0) break;

        for(const sing of singletons){
          const tKey = sing.teacher;
          const tGrid = this.teacherGrid.get(tKey);
          if(!tGrid) continue;

          // Kiểm tra lại tính hợp lệ của singleton (chưa bị sửa bởi move trước trong pass)
          let currTaughtInSess = 0;
          for(let p = 0; p < PERIODS; p++){
            if(tGrid[sing.sStart + p] >= 0 || tGrid[sing.sStart + p] === -3) currTaughtInSess++;
          }
          if(currTaughtInSess !== 1) continue;

          const act1 = sing.act;
          const s1 = sing.slot;
          const cGrid1 = this.classGrid.get(act1.classId);
          if(!cGrid1) continue;

          let bestCandidate = null;

          // -------------------------------------------------------------------
          // CHIẾN LƯỢC A: MOVE-OUT (Dời tiết lẻ sang buổi khác cùng ca của GV)
          // -------------------------------------------------------------------
          const candidateSessionsA = [];
          for(let d2 = 0; d2 < DAYS; d2++){
            if(d2 === sing.day) continue;
            const sStart2 = d2 * SLOTS_PER_DAY + sing.session * PERIODS;
            let cnt = 0;
            for(let p2 = 0; p2 < PERIODS; p2++){
              if(tGrid[sStart2 + p2] >= 0 || tGrid[sStart2 + p2] === -3) cnt++;
            }
            if(cnt >= 1 && cnt < 5){
              candidateSessionsA.push({ d: d2, b: sing.session, sStart: sStart2, count: cnt });
            }
          }
          // Ưu tiên session đang có 1 tiết (để dồn cả 2 thành 2t), hoặc 2, 3 tiết
          candidateSessionsA.sort((x, y) => x.count - y.count);

          for(const tgt of candidateSessionsA){
            for(let p2 = 0; p2 < PERIODS; p2++){
              const s2 = tgt.sStart + p2;
              if(s2 === s1) continue;
              if(tGrid[s2] >= 0 || tGrid[s2] === -3) continue; // GV đã bận ở slot này

              const targetActId = cGrid1[s2];

              // A1: DIRECT MOVE (Slot lớp trống)
              if(targetActId < 0 && targetActId !== -3){
                const jrnMark = this.moveJournal.length;
                this.jrnUnplace(act1.id);
                const confA = this.getConflictsForSlot(act1, s2);
                if(confA.possible && confA.conflicts.length === 0){
                  this.jrnPlace(act1.id, s2);
                  if(this.isLessonBlockSafe(act1)){
                    const candM = this.evaluateMetrics();
                    const isStrictBetter = (candM.soBuoiDay1 < currentBest.soBuoiDay1) &&
                                          (candM.soBuoiTrong2 <= currentBest.soBuoiTrong2) &&
                                          (candM.soNgayMotTiet <= currentBest.soNgayMotTiet);
                    if(isStrictBetter){
                      if(!bestCandidate || this.compareMetrics(candM, bestCandidate.metrics, "optimize_singletons") < 0){
                        bestCandidate = {
                          type: 'direct_move',
                          moves: [{ act: act1, from: s1, to: s2 }],
                          metrics: { ...candM }
                        };
                      }
                    }
                  }
                }
                this.jrnRollback(jrnMark);
              }

              // A2: 2-WAY SAME-CLASS SWAP (Slot lớp có môn khác movable duration=1)
              else if(targetActId >= 0){
                const act2 = this.activities[targetActId];
                if(act2 && !act2.isFixed && act2.duration === 1 && act2.teacherId !== tKey){
                  const tGrid2 = this.teacherGrid.get(act2.teacherId);
                  if(tGrid2 && tGrid2[s1] < 0 && tGrid2[s1] !== -3){
                    const jrnMark = this.moveJournal.length;
                    this.jrnUnplace(act1.id);
                    this.jrnUnplace(act2.id);

                    const conf1 = this.getConflictsForSlot(act1, s2);
                    const conf2 = this.getConflictsForSlot(act2, s1);

                    if(conf1.possible && conf1.conflicts.length === 0 &&
                       conf2.possible && conf2.conflicts.length === 0){
                      this.jrnPlace(act1.id, s2);
                      this.jrnPlace(act2.id, s1);

                      if(this.isLessonBlockSafe(act1, act2)){
                        const candM = this.evaluateMetrics();
                        const isStrictBetter = (candM.soBuoiDay1 < currentBest.soBuoiDay1) &&
                                              (candM.soBuoiTrong2 <= currentBest.soBuoiTrong2) &&
                                              (candM.soNgayMotTiet <= currentBest.soNgayMotTiet);
                        if(isStrictBetter){
                          if(!bestCandidate || this.compareMetrics(candM, bestCandidate.metrics, "optimize_singletons") < 0){
                            bestCandidate = {
                              type: '2way_swap',
                              moves: [
                                { act: act1, from: s1, to: s2 },
                                { act: act2, from: s2, to: s1 }
                              ],
                              metrics: { ...candM }
                            };
                          }
                        }
                      }
                    }
                    this.jrnRollback(jrnMark);
                  }
                }
              }
            }
          }

          // -------------------------------------------------------------------
          // CHIẾN LƯỢC B: PULL-IN (Kéo 1 tiết từ buổi giàu >=3t về ghép thành buổi 2t)
          // -------------------------------------------------------------------
          if(!bestCandidate){
            for(let d2 = 0; d2 < DAYS; d2++){
              for(let b2 = 0; b2 < SESSIONS; b2++){
                if(d2 === sing.day && b2 === sing.session) continue;
                const sStartRich = d2 * SLOTS_PER_DAY + b2 * PERIODS;
                const richActs = [];
                for(let p2 = 0; p2 < PERIODS; p2++){
                  const actIdRich = tGrid[sStartRich + p2];
                  if(actIdRich >= 0){
                    const aRich = this.activities[actIdRich];
                    if(aRich && !aRich.isFixed && aRich.duration === 1){
                      richActs.push({ slot: sStartRich + p2, act: aRich });
                    }
                  }
                }
                // Chỉ rút từ buổi có >= 3 tiết (sau khi rút vẫn còn >= 2 tiết)
                if(richActs.length >= 3){
                  for(const donor of richActs){
                    const actDonor = donor.act;
                    const sDonor = donor.slot;
                    const cGridDonor = this.classGrid.get(actDonor.classId);
                    if(!cGridDonor) continue;

                    // Thử kéo về các slot trống của GV trong buổi singleton
                    for(let pTgt = 0; pTgt < PERIODS; pTgt++){
                      const sTgt = sing.sStart + pTgt;
                      if(sTgt === s1 || tGrid[sTgt] >= 0 || tGrid[sTgt] === -3) continue;

                      const occActId = cGridDonor[sTgt];

                      // B1: Direct pull (Lớp của donor đang trống tại sTgt)
                      if(occActId < 0 && occActId !== -3){
                        const jrnMark = this.moveJournal.length;
                        this.jrnUnplace(actDonor.id);
                        const confD = this.getConflictsForSlot(actDonor, sTgt);
                        if(confD.possible && confD.conflicts.length === 0){
                          this.jrnPlace(actDonor.id, sTgt);
                          if(this.isLessonBlockSafe(actDonor)){
                            const candM = this.evaluateMetrics();
                            const isStrictBetter = (candM.soBuoiDay1 < currentBest.soBuoiDay1) &&
                                                  (candM.soBuoiTrong2 <= currentBest.soBuoiTrong2) &&
                                                  (candM.soNgayMotTiet <= currentBest.soNgayMotTiet);
                            if(isStrictBetter){
                              if(!bestCandidate || this.compareMetrics(candM, bestCandidate.metrics, "optimize_singletons") < 0){
                                bestCandidate = {
                                  type: 'pull_in_direct',
                                  moves: [{ act: actDonor, from: sDonor, to: sTgt }],
                                  metrics: { ...candM }
                                };
                              }
                            }
                          }
                        }
                        this.jrnRollback(jrnMark);
                      }
                      // B2: 2-way closed swap pull-in
                      else if(occActId >= 0){
                        const actOcc = this.activities[occActId];
                        if(actOcc && !actOcc.isFixed && actOcc.duration === 1 && actOcc.teacherId !== tKey){
                          const tGridOcc = this.teacherGrid.get(actOcc.teacherId);
                          if(tGridOcc && tGridOcc[sDonor] < 0 && tGridOcc[sDonor] !== -3){
                            const jrnMark = this.moveJournal.length;
                            this.jrnUnplace(actDonor.id);
                            this.jrnUnplace(actOcc.id);

                            const confD = this.getConflictsForSlot(actDonor, sTgt);
                            const confO = this.getConflictsForSlot(actOcc, sDonor);

                            if(confD.possible && confD.conflicts.length === 0 &&
                               confO.possible && confO.conflicts.length === 0){
                              this.jrnPlace(actDonor.id, sTgt);
                              this.jrnPlace(actOcc.id, sDonor);

                              if(this.isLessonBlockSafe(actDonor, actOcc)){
                                const candM = this.evaluateMetrics();
                                const isStrictBetter = (candM.soBuoiDay1 < currentBest.soBuoiDay1) &&
                                                      (candM.soBuoiTrong2 <= currentBest.soBuoiTrong2) &&
                                                      (candM.soNgayMotTiet <= currentBest.soNgayMotTiet);
                                if(isStrictBetter){
                                  if(!bestCandidate || this.compareMetrics(candM, bestCandidate.metrics, "optimize_singletons") < 0){
                                    bestCandidate = {
                                      type: 'pull_in_swap',
                                      moves: [
                                        { act: actDonor, from: sDonor, to: sTgt },
                                        { act: actOcc, from: sTgt, to: sDonor }
                                      ],
                                      metrics: { ...candM }
                                    };
                                  }
                                }
                              }
                            }
                            this.jrnRollback(jrnMark);
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }

          // Commit best candidate nếu tìm được
          if(bestCandidate){
            for(const m of bestCandidate.moves){
              this.jrnUnplace(m.act.id);
            }
            for(const m of bestCandidate.moves){
              this.jrnPlace(m.act.id, m.to);
            }
            currentBest = this.evaluateMetrics();
            passImproved = true;
            anyImproved = true;
            if(onProgress) onProgress(currentBest);
            break; // refresh singleton list sau khi commit
          }
        }

        if(!passImproved) break;
      }

      return anyImproved ? currentBest : null;
    }
"""

if 'tryFastSingletonRepair(' not in content:
    # Insert right before tryConsolidateTeacherSingletons
    target_pos = '    tryConsolidateTeacherSingletons('
    if target_pos in content:
        content = content.replace(target_pos, fast_repair_method + '\n' + target_pos)
        print("Inserted tryFastSingletonRepair into FetTimetableEngine")
    else:
        print("Could not find insertion position for tryFastSingletonRepair")
else:
    print("tryFastSingletonRepair already present")

# -----------------------------------------------------------------------------
# 4. HOOK INTO async optimize(mode = "optimize_singletons")
# -----------------------------------------------------------------------------
hook_target = '        if(mode === "optimize_singletons"){\n          // Nuoc chu luc hoc tu cong cu tham chieu (bo MD 17/08): chay DAU TIEN.\n          const relabelM = this.trySingletonRelabelCycles(bestMetrics, initialMetrics, notifyLiveProgress);'

hook_replacement = """        if(mode === "optimize_singletons"){
          // [FAST-PATH TARGETED SINGLETON REPAIR] (ANTIGRAVITY DIRECTION 1)
          const fastM = this.tryFastSingletonRepair(bestMetrics, initialMetrics, notifyLiveProgress);
          if(fastM && this.compareMetrics(fastM, bestMetrics, mode) < 0){
            bestMetrics = { ...fastM };
            saveBestSnapshot();
            improvedInRound = true;
            destroyStrength = 1;
          }
          if(bestMetrics.soBuoiDay1 === 0){
            portfolioDone = true;
            break;
          }

          // Nuoc chu luc hoc tu cong cu tham chieu (bo MD 17/08): chay DAU TIEN.
          const relabelM = this.trySingletonRelabelCycles(bestMetrics, initialMetrics, notifyLiveProgress);"""

if hook_target in content:
    content = content.replace(hook_target, hook_replacement)
    print("Hooked tryFastSingletonRepair into optimize() pipeline")
else:
    print("Hook target for optimize() not found or already hooked")

with codecs.open(engine_file, 'w', 'utf-8') as f:
    f.write(content)

# Also sync to web/tkb-fet-engine.js
engine_root_file = r'C:\Users\Love\Documents\Codex\TKBCherry\web\tkb-fet-engine.js'
with codecs.open(engine_root_file, 'w', 'utf-8') as f:
    f.write(content)

print("Successfully synced web/pages/tkb-fet-engine.js and web/tkb-fet-engine.js!")

# -----------------------------------------------------------------------------
# 5. WORKER THROTTLE IN tkb-fet-worker.js
# -----------------------------------------------------------------------------
worker_file = r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-worker.js'
with codecs.open(worker_file, 'r', 'utf-8') as f:
    w_content = f.read()

# Update runOptimizeImpl progress callback throttling
worker_target = '    const res = await runOptimize((prog) => {\n      self.postMessage({'
worker_replacement = """    let lastSnapshotAt = 0;
    let lastSnapshotTkb = null;
    const SNAPSHOT_INTERVAL_MS = 250;

    const res = await runOptimize((prog) => {
      const now = Date.now();
      if(!lastSnapshotTkb || now - lastSnapshotAt >= SNAPSHOT_INTERVAL_MS || prog.percent >= 100){
        try{
          lastSnapshotTkb = currentEngine ? currentEngine.getSnapshotTKB() : null;
          lastSnapshotAt = now;
        }catch(_){}
      }

      self.postMessage({"""

if worker_target in w_content:
    w_content = w_content.replace(worker_target, worker_replacement)
    # Also update snapshot assignment
    w_content = w_content.replace('snapshot: currentEngine.getSnapshotTKB()', 'snapshot: (lastSnapshotTkb || (currentEngine ? currentEngine.getSnapshotTKB() : null))')
    
    with codecs.open(worker_file, 'w', 'utf-8') as f:
        f.write(w_content)
    
    worker_root = r'C:\Users\Love\Documents\Codex\TKBCherry\web\tkb-fet-worker.js'
    with codecs.open(worker_root, 'w', 'utf-8') as f:
        f.write(w_content)
    print("Successfully updated and synced worker files with snapshot throttling!")
else:
    print("Worker target not found or already throttled")
