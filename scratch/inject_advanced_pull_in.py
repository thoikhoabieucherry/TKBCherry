import sys, codecs, re
sys.stdout.reconfigure(encoding='utf-8')

engine_file = r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js'

with codecs.open(engine_file, 'r', 'utf-8') as f:
    content = f.read()

advanced_strategy_b = """          // -------------------------------------------------------------------
          // CHIẾN LƯỢC B: PULL-IN ĐA TẦNG (Kéo tiết từ buổi nhiều tiết >=3t về ghép)
          // Trang bị đầy đủ: B1 (2-Way), B2 (3-Way Cycle), B3 (4-Way Chain), B4 (Direct)
          // -------------------------------------------------------------------
          if(!bestCandidate){
            for(let d2 = 0; d2 < DAYS; d2++){
              for(let b2 = 0; b2 < SESSIONS; b2++){
                if(d2 === sing.day && b2 === sing.session) continue;
                // Chỉ lấy buổi cùng ca (hoặc buổi nhiều tiết)
                if(b2 !== sing.session) continue;

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

                      // B1: 2-WAY CLOSED SWAP PULL-IN
                      if(occActId >= 0){
                        const actOcc = this.activities[occActId];
                        const tOccKey = actOcc && actOcc.gv ? actOcc.gv.toLowerCase() : '';
                        if(actOcc && !actOcc.isFixed && actOcc.duration === 1 && tOccKey && tOccKey !== tKey){
                          const tGridOcc = this.teacherGrid.get(tOccKey);
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
                                      type: 'pull_in_2way',
                                      moves: [
                                        { act: actDonor, to: sTgt },
                                        { act: actOcc, to: sDonor }
                                      ],
                                      metrics: { ...candM }
                                    };
                                  }
                                }
                              }
                            }
                            this.jrnRollback(jrnMark);
                          }

                          // B2: 3-WAY CYCLE PULL-IN (actDonor -> sTgt, actOcc -> s3, act3 -> sDonor)
                          if(!bestCandidate && tGridOcc && (tGridOcc[sDonor] >= 0 || tGridOcc[sDonor] === -3)){
                            const freeSlotsOcc = [];
                            for(let p3 = 0; p3 < PERIODS; p3++){
                              for(let d3 = 0; d3 < DAYS; d3++){
                                const candS3 = d3 * SLOTS_PER_DAY + sing.session * PERIODS + p3;
                                if(candS3 !== sTgt && candS3 !== sDonor && tGridOcc[candS3] < 0 && tGridOcc[candS3] !== -3){
                                  if(cGridDonor[candS3] >= 0) freeSlotsOcc.push(candS3);
                                }
                              }
                            }

                            for(const s3 of freeSlotsOcc){
                              const act3Id = cGridDonor[s3];
                              const act3 = this.activities[act3Id];
                              const t3Key = act3 && act3.gv ? act3.gv.toLowerCase() : '';
                              if(!act3 || act3.isFixed || act3.duration !== 1 || !t3Key || t3Key === tKey || t3Key === tOccKey) continue;
                              const tGrid3 = this.teacherGrid.get(t3Key);
                              if(!tGrid3 || tGrid3[sDonor] >= 0 || tGrid3[sDonor] === -3) continue;

                              const jrnMark = this.moveJournal.length;
                              this.jrnUnplace(actDonor.id);
                              this.jrnUnplace(actOcc.id);
                              this.jrnUnplace(act3.id);

                              const confD = this.getConflictsForSlot(actDonor, sTgt);
                              const confO = this.getConflictsForSlot(actOcc, s3);
                              const conf3 = this.getConflictsForSlot(act3, sDonor);

                              if(confD.possible && confD.conflicts.length === 0 &&
                                 confO.possible && confO.conflicts.length === 0 &&
                                 conf3.possible && conf3.conflicts.length === 0){
                                this.jrnPlace(actDonor.id, sTgt);
                                this.jrnPlace(actOcc.id, s3);
                                this.jrnPlace(act3.id, sDonor);

                                if(this.isLessonBlockSafe(actDonor, actOcc, act3) && this.countStudentHoles() <= maxStudentHolesAllowed){
                                  const candM = this.evaluateMetrics();
                                  const isStrictBetter = (candM.soBuoiDay1 < currentBest.soBuoiDay1) &&
                                                        (candM.soBuoiTrong2 <= currentBest.soBuoiTrong2) &&
                                                        (candM.soNgayMotTiet <= currentBest.soNgayMotTiet);
                                  if(isStrictBetter){
                                    if(!bestCandidate || this.compareMetrics(candM, bestCandidate.metrics, "optimize_singletons") < 0){
                                      bestCandidate = {
                                        type: 'pull_in_3way',
                                        moves: [
                                          { act: actDonor, to: sTgt },
                                          { act: actOcc, to: s3 },
                                          { act: act3, to: sDonor }
                                        ],
                                        metrics: { ...candM }
                                      };
                                    }
                                  }
                                }
                              }
                              this.jrnRollback(jrnMark);
                              if(bestCandidate) break;
                            }
                          }

                          // B3: 4-WAY EJECTION CHAIN PULL-IN (actDonor -> sTgt, actOcc -> s3, act3 -> s4, act4 -> sDonor)
                          if(!bestCandidate && tGridOcc && (tGridOcc[sDonor] >= 0 || tGridOcc[sDonor] === -3)){
                            const freeSlotsOcc = [];
                            for(let p3 = 0; p3 < PERIODS; p3++){
                              for(let d3 = 0; d3 < DAYS; d3++){
                                const candS3 = d3 * SLOTS_PER_DAY + sing.session * PERIODS + p3;
                                if(candS3 !== sTgt && candS3 !== sDonor && tGridOcc[candS3] < 0 && tGridOcc[candS3] !== -3){
                                  if(cGridDonor[candS3] >= 0) freeSlotsOcc.push(candS3);
                                }
                              }
                            }

                            for(const s3 of freeSlotsOcc){
                              const act3Id = cGridDonor[s3];
                              const act3 = this.activities[act3Id];
                              const t3Key = act3 && act3.gv ? act3.gv.toLowerCase() : '';
                              if(!act3 || act3.isFixed || act3.duration !== 1 || !t3Key || t3Key === tKey || t3Key === tOccKey) continue;
                              const tGrid3 = this.teacherGrid.get(t3Key);
                              if(!tGrid3) continue;

                              const freeSlots3 = [];
                              for(let p4 = 0; p4 < PERIODS; p4++){
                                for(let d4 = 0; d4 < DAYS; d4++){
                                  const candS4 = d4 * SLOTS_PER_DAY + sing.session * PERIODS + p4;
                                  if(candS4 !== sTgt && candS4 !== sDonor && candS4 !== s3 && tGrid3[candS4] < 0 && tGrid3[candS4] !== -3){
                                    if(cGridDonor[candS4] >= 0) freeSlots3.push(candS4);
                                  }
                                }
                              }

                              for(const s4 of freeSlots3){
                                const act4Id = cGridDonor[s4];
                                const act4 = this.activities[act4Id];
                                const t4Key = act4 && act4.gv ? act4.gv.toLowerCase() : '';
                                if(!act4 || act4.isFixed || act4.duration !== 1 || !t4Key || t4Key === tKey || t4Key === tOccKey || t4Key === t3Key) continue;
                                const tGrid4 = this.teacherGrid.get(t4Key);
                                if(!tGrid4 || tGrid4[sDonor] >= 0 || tGrid4[sDonor] === -3) continue;

                                const jrnMark = this.moveJournal.length;
                                this.jrnUnplace(actDonor.id);
                                this.jrnUnplace(actOcc.id);
                                this.jrnUnplace(act3.id);
                                this.jrnUnplace(act4.id);

                                const confD = this.getConflictsForSlot(actDonor, sTgt);
                                const confO = this.getConflictsForSlot(actOcc, s3);
                                const conf3 = this.getConflictsForSlot(act3, s4);
                                const conf4 = this.getConflictsForSlot(act4, sDonor);

                                if(confD.possible && confD.conflicts.length === 0 &&
                                   confO.possible && confO.conflicts.length === 0 &&
                                   conf3.possible && conf3.conflicts.length === 0 &&
                                   conf4.possible && conf4.conflicts.length === 0){
                                  this.jrnPlace(actDonor.id, sTgt);
                                  this.jrnPlace(actOcc.id, s3);
                                  this.jrnPlace(act3.id, s4);
                                  this.jrnPlace(act4.id, sDonor);

                                  if(this.isLessonBlockSafe(actDonor, actOcc, act3, act4) && this.countStudentHoles() <= maxStudentHolesAllowed){
                                    const candM = this.evaluateMetrics();
                                    const isStrictBetter = (candM.soBuoiDay1 < currentBest.soBuoiDay1) &&
                                                          (candM.soBuoiTrong2 <= currentBest.soBuoiTrong2) &&
                                                          (candM.soNgayMotTiet <= currentBest.soNgayMotTiet);
                                    if(isStrictBetter){
                                      if(!bestCandidate || this.compareMetrics(candM, bestCandidate.metrics, "optimize_singletons") < 0){
                                        bestCandidate = {
                                          type: 'pull_in_4way',
                                          moves: [
                                            { act: actDonor, to: sTgt },
                                            { act: actOcc, to: s3 },
                                            { act: act3, to: s4 },
                                            { act: act4, to: sDonor }
                                          ],
                                          metrics: { ...candM }
                                        };
                                      }
                                    }
                                  }
                                }
                                this.jrnRollback(jrnMark);
                                if(bestCandidate) break;
                              }
                              if(bestCandidate) break;
                            }
                          }
                        }
                      }
                      // B4: DIRECT PULL (Khi slot trống hoàn toàn)
                      else if(occActId < 0 && occActId !== -3){
                        const jrnMark = this.moveJournal.length;
                        this.jrnUnplace(actDonor.id);
                        const confD = this.getConflictsForSlot(actDonor, sTgt);
                        if(confD.possible && confD.conflicts.length === 0){
                          this.jrnPlace(actDonor.id, sTgt);
                          if(this.isLessonBlockSafe(actDonor) && this.countStudentHoles() <= maxStudentHolesAllowed){
                            const candM = this.evaluateMetrics();
                            const isStrictBetter = (candM.soBuoiDay1 < currentBest.soBuoiDay1) &&
                                                  (candM.soBuoiTrong2 <= currentBest.soBuoiTrong2) &&
                                                  (candM.soNgayMotTiet <= currentBest.soNgayMotTiet);
                            if(isStrictBetter){
                              if(!bestCandidate || this.compareMetrics(candM, bestCandidate.metrics, "optimize_singletons") < 0){
                                bestCandidate = {
                                  type: 'pull_in_direct',
                                  moves: [{ act: actDonor, to: sTgt }],
                                  metrics: { ...candM }
                                };
                              }
                            }
                          }
                        }
                        this.jrnRollback(jrnMark);
                      }
                    }
                    if(bestCandidate) break;
                  }
                  if(bestCandidate) break;
                }
              }
              if(bestCandidate) break;
            }
          }"""

pattern = r'\s*// -+[\r\n]+\s*// CHIẾN LƯỢC B: PULL-IN.*?(?=\n\s*// Commit best candidate)'
content = re.sub(pattern, '\n' + advanced_strategy_b, content, flags=re.DOTALL)

with codecs.open(engine_file, 'w', 'utf-8') as f:
    f.write(content)

with codecs.open(r'C:\Users\Love\Documents\Codex\TKBCherry\web\tkb-fet-engine.js', 'w', 'utf-8') as f:
    f.write(content)

# Update cache buster in sapxep.html
sapxep_file = r'C:\Users\Love\Documents\Codex\TKBCherry\web\pages\sapxep.html'
with codecs.open(sapxep_file, 'r', 'utf-8') as f:
    s_content = f.read()

s_content = re.sub(r'tkb-fet-engine\.js\?v=[^\"]+', 'tkb-fet-engine.js?v=20260818-advanced-pull-in-v9', s_content)
with codecs.open(sapxep_file, 'w', 'utf-8') as f:
    f.write(s_content)

print("Injected Advanced Multi-Tier Pull-In (2-Way, 3-Way, 4-Way Chains) into Engine v9!")
