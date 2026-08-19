import sys, codecs
sys.stdout.reconfigure(encoding='utf-8')

engine_file = r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js'

with codecs.open(engine_file, 'r', 'utf-8') as f:
    content = f.read()

# Let's inspect tryFastSingletonRepair definition in content
# We will replace tryFastSingletonRepair with the strict student-holes safe version!

strict_fast_repair = """    // =========================================================================
    // FAST-PATH TARGETED SINGLETON REPAIR (ANTIGRAVITY DIRECTION 1)
    // Tối ưu siêu tốc deterministic chuyên biệt cho mục tiêu 1-tiết/buổi:
    // 1. Move-Out: Đẩy tiết đơn lẻ sang buổi khác cùng ca có sẵn tiết
    // 2. Pull-In / Reinforce: Kéo 1 tiết từ buổi giàu (>=3t) về ghép thành buổi 2t
    // 3. Bảo toàn 100% tiết nghỉ của lớp, không tạo lỗ trống học sinh
    // =========================================================================
    tryFastSingletonRepair(currentBestMetrics = null, initialMetrics = null, onProgress = null){
      const DAYS = DAYS_LIST.length;
      const SESSIONS = SESSIONS_LIST.length;
      const PERIODS = PERIODS_PER_SESSION;

      let currentBest = currentBestMetrics ? { ...currentBestMetrics } : this.evaluateMetrics();
      if(currentBest.soBuoiDay1 === 0) return currentBest;

      const maxStudentHolesAllowed = (typeof this.__studentHoleBaseline === "number") ? this.__studentHoleBaseline : 0;

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

          // Kiểm tra lại tính hợp lệ của singleton
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
          candidateSessionsA.sort((x, y) => x.count - y.count);

          for(const tgt of candidateSessionsA){
            for(let p2 = 0; p2 < PERIODS; p2++){
              const s2 = tgt.sStart + p2;
              if(s2 === s1) continue;
              if(tGrid[s2] >= 0 || tGrid[s2] === -3) continue;

              const targetActId = cGrid1[s2];

              // A1: 2-WAY SAME-CLASS SWAP (An toàn tuyệt đối 100% về số tiết học sinh)
              if(targetActId >= 0){
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

                      if(this.isLessonBlockSafe(act1, act2) && this.countStudentHoles() <= maxStudentHolesAllowed){
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

              // A2: DIRECT MOVE (Slot lớp trống & không tạo lỗ hổng học sinh)
              else if(targetActId < 0 && targetActId !== -3){
                const jrnMark = this.moveJournal.length;
                this.jrnUnplace(act1.id);
                const confA = this.getConflictsForSlot(act1, s2);
                if(confA.possible && confA.conflicts.length === 0){
                  this.jrnPlace(act1.id, s2);
                  if(this.isLessonBlockSafe(act1) && this.countStudentHoles() <= maxStudentHolesAllowed){
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
                if(richActs.length >= 3){
                  for(const donor of richActs){
                    const actDonor = donor.act;
                    const sDonor = donor.slot;
                    const cGridDonor = this.classGrid.get(actDonor.classId);
                    if(!cGridDonor) continue;

                    for(let pTgt = 0; pTgt < PERIODS; pTgt++){
                      const sTgt = sing.sStart + pTgt;
                      if(sTgt === s1 || tGrid[sTgt] >= 0 || tGrid[sTgt] === -3) continue;

                      const occActId = cGridDonor[sTgt];

                      // B1: 2-way closed swap pull-in
                      if(occActId >= 0){
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

                              if(this.isLessonBlockSafe(actDonor, actOcc) && this.countStudentHoles() <= maxStudentHolesAllowed){
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

          // Commit best candidate
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
            break;
          }
        }

        if(!passImproved) break;
      }

      return anyImproved ? currentBest : null;
    }"""

import re
# Replace old tryFastSingletonRepair
pattern = r'\s*// =+[\r\n]+\s*// FAST-PATH TARGETED SINGLETON REPAIR.*?(?=tryConsolidateTeacherSingletons\()'
content = re.sub(pattern, '\n' + strict_fast_repair + '\n    ', content, flags=re.DOTALL)

with codecs.open(engine_file, 'w', 'utf-8') as f:
    f.write(content)

with codecs.open(r'C:\Users\Love\Documents\Codex\TKBCherry\web\tkb-fet-engine.js', 'w', 'utf-8') as f:
    f.write(content)

print("Updated tryFastSingletonRepair with strict student holes safety!")
