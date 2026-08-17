import os
import sys

sys.stdout.reconfigure(encoding='utf-8')

engine_path = r"c:\Users\Love\Documents\Codex\TKBCherry\web\pages\tkb-fet-engine.js"

with open(engine_path, "r", encoding="utf-8") as f:
    text = f.read()

# Safe replacement optimizer block
safe_optimizer_block = """    // Intra-Class Same-Teacher Consolidation: Merges multiple single periods of the same teacher in the same class into the same session
    tryConsolidateTeacherSingletons(bestMetrics, initialMetrics, maxGap2Limit = Infinity){
      const DAYS = DAYS_LIST.length;
      const SESSIONS = SESSIONS_LIST.length;
      const PERIODS = PERIODS_PER_SESSION;
      let currentBest = { ...bestMetrics };
      let anyImproved = false;

      const teacherList = Array.from(this.teacherGrid.keys()).filter(Boolean);
      this.rng.shuffle(teacherList);

      for(const tKey of teacherList){
        const tGrid = this.teacherGrid.get(tKey);
        if(!tGrid) continue;

        for(const lop of this.classes){
          const cid = String(lop.id || "");
          const cGrid = this.classGrid.get(cid);
          if(!cGrid) continue;

          // Find all single periods of teacher tKey in class cid
          const singleActs = [];
          for(let s = 0; s < 60; s++){
            if(cGrid[s] >= 0){
              const act = this.activities[cGrid[s]];
              if(act && act.gv === tKey && !act.isFixed && act.duration === 1){
                const sess = Math.floor(s / 5);
                singleActs.push({ act, slot: s, sess });
              }
            }
          }

          if(singleActs.length < 2) continue;

          for(let i = 0; i < singleActs.length; i++){
            for(let j = 0; j < singleActs.length; j++){
              if(i === j) continue;
              const itemA = singleActs[i];
              const itemB = singleActs[j];
              if(itemA.sess === itemB.sess) continue;

              const sessA = itemA.sess;
              const sessB = itemB.sess;

              let cntA = 0;
              let cntB = 0;
              for(let p = 0; p < PERIODS; p++){
                if(tGrid[sessA * 5 + p] >= 0 || tGrid[sessA * 5 + p] === -3) cntA++;
                if(tGrid[sessB * 5 + p] >= 0 || tGrid[sessB * 5 + p] === -3) cntB++;
              }

              if(cntA === 1 || cntB === 1){
                for(let p2 = 0; p2 < PERIODS; p2++){
                  const sTarget = sessB * 5 + p2;
                  if(sTarget === itemB.slot || this.offSlots.has(`${cid}|${sTarget}`)) continue;
                  if(tGrid[sTarget] >= 0 || tGrid[sTarget] === -3) continue;

                  const actIdDst = cGrid[sTarget];
                  if(actIdDst < 0){
                    this.unplaceActivity(itemA.act.id);
                    if(this.getConflictsForSlot(itemA.act, sTarget).possible && this.getConflictsForSlot(itemA.act, sTarget).conflicts.length === 0){
                      this.placeActivityDirect(itemA.act.id, sTarget);
                      if(this.isLessonBlockSafe(itemA.act)){
                        const m = this.evaluateMetrics();
                        if(m.soBuoiDay1 < currentBest.soBuoiDay1 && m.soBuoiTrong2 <= maxGap2Limit){
                          currentBest = { ...m };
                          anyImproved = true;
                          break;
                        }
                      }
                      this.unplaceActivity(itemA.act.id);
                    }
                    this.placeActivityDirect(itemA.act.id, itemA.slot);
                  }else{
                    const actDst = this.activities[actIdDst];
                    if(!actDst || actDst.isFixed || actDst.duration !== 1) continue;

                    const tDstGrid = this.teacherGrid.get(actDst.gv);
                    let consResolved = false;

                    // 2-way swap
                    if(tDstGrid && tDstGrid[itemA.slot] < 0 && tDstGrid[itemA.slot] !== -3){
                      this.unplaceActivity(itemA.act.id);
                      this.unplaceActivity(actDst.id);

                      const r1 = this.getConflictsForSlot(itemA.act, sTarget);
                      const r2 = this.getConflictsForSlot(actDst, itemA.slot);

                      if(r1.possible && r1.conflicts.length === 0 && r2.possible && r2.conflicts.length === 0){
                        this.placeActivityDirect(itemA.act.id, sTarget);
                        this.placeActivityDirect(actDst.id, itemA.slot);

                        if(this.isLessonBlockSafe(itemA.act, actDst)){
                          const m = this.evaluateMetrics();
                          if(m.soBuoiDay1 < currentBest.soBuoiDay1 && m.soBuoiTrong2 <= maxGap2Limit){
                            currentBest = { ...m };
                            anyImproved = true;
                            consResolved = true;
                            break;
                          }
                        }
                        this.unplaceActivity(itemA.act.id);
                        this.unplaceActivity(actDst.id);
                      }
                      this.placeActivityDirect(itemA.act.id, itemA.slot);
                      this.placeActivityDirect(actDst.id, sTarget);
                    }
                    if(consResolved) break;

                    // 3-way cyclic swap
                    for(let s3 = 0; s3 < 60; s3++){
                      if(s3 === itemA.slot || s3 === sTarget || this.offSlots.has(`${cid}|${s3}`)) continue;
                      const actId3 = cGrid[s3];
                      if(actId3 < 0) continue;
                      const act3 = this.activities[actId3];
                      if(!act3 || act3.isFixed || act3.duration !== 1) continue;

                      this.unplaceActivity(itemA.act.id);
                      this.unplaceActivity(actDst.id);
                      this.unplaceActivity(act3.id);

                      const r1 = this.getConflictsForSlot(itemA.act, sTarget);
                      const r2 = this.getConflictsForSlot(actDst, s3);
                      const r3 = this.getConflictsForSlot(act3, itemA.slot);

                      if(r1.possible && r1.conflicts.length === 0 &&
                         r2.possible && r2.conflicts.length === 0 &&
                         r3.possible && r3.conflicts.length === 0){
                        this.placeActivityDirect(itemA.act.id, sTarget);
                        this.placeActivityDirect(actDst.id, s3);
                        this.placeActivityDirect(act3.id, itemA.slot);

                        if(this.isLessonBlockSafe(itemA.act, actDst, act3)){
                          const m = this.evaluateMetrics();
                          if(m.soBuoiDay1 < currentBest.soBuoiDay1 && m.soBuoiTrong2 <= maxGap2Limit){
                            currentBest = { ...m };
                            anyImproved = true;
                            consResolved = true;
                            break;
                          }
                        }
                        this.unplaceActivity(itemA.act.id);
                        this.unplaceActivity(actDst.id);
                        this.unplaceActivity(act3.id);
                      }
                      this.placeActivityDirect(itemA.act.id, itemA.slot);
                      this.placeActivityDirect(actDst.id, sTarget);
                      this.placeActivityDirect(act3.id, s3);
                    }
                    if(consResolved) break;
                  }
                }
              }
            }
          }
        }
      }
      return anyImproved ? currentBest : null;
    }

    // Inbound Singleton Reinforcement: pulls lessons from multi-period sessions into 1-period sessions to reach >= 2 periods
    tryReinforceTeacherSingletons(bestMetrics, initialMetrics, maxGap2Limit = Infinity){
      const DAYS = DAYS_LIST.length;
      const SESSIONS = SESSIONS_LIST.length;
      const PERIODS = PERIODS_PER_SESSION;
      let currentBest = { ...bestMetrics };
      let anyImproved = false;

      const teacherList = Array.from(this.teacherGrid.keys()).filter(Boolean);
      this.rng.shuffle(teacherList);

      for(const tKey of teacherList){
        const tGrid = this.teacherGrid.get(tKey);
        if(!tGrid) continue;

        for(let d = 0; d < DAYS; d++){
          for(let b = 0; b < SESSIONS; b++){
            const sStart = d * 10 + b * 5;
            let taughtCount = 0;
            let singleSlot = -1;
            for(let p = 0; p < PERIODS; p++){
              const s = sStart + p;
              if(tGrid[s] >= 0 || tGrid[s] === -3){
                taughtCount++;
                singleSlot = s;
              }
            }
            if(taughtCount !== 1) continue;

            const richSessions = [];
            for(let d2 = 0; d2 < DAYS; d2++){
              for(let b2 = 0; b2 < SESSIONS; b2++){
                if(d2 === d && b2 === b) continue;
                const sStart2 = d2 * 10 + b2 * 5;
                const movableActs = [];
                let totalPeriods = 0;
                for(let p2 = 0; p2 < PERIODS; p2++){
                  const s2 = sStart2 + p2;
                  if(tGrid[s2] >= 0){
                    totalPeriods++;
                    const a = this.activities[tGrid[s2]];
                    if(a && !a.isFixed && a.duration === 1){
                      movableActs.push({ act: a, slot: s2 });
                    }
                  }else if(tGrid[s2] === -3){
                    totalPeriods++;
                  }
                }
                if(totalPeriods >= 3 && movableActs.length > 0){
                  richSessions.push({ sStart: sStart2, movableActs, totalPeriods });
                }
              }
            }
            if(richSessions.length === 0) continue;
            richSessions.sort((x, y) => y.totalPeriods - x.totalPeriods);

            let reinResolved = false;
            for(const rich of richSessions){
              for(const item of rich.movableActs){
                const actToPull = item.act;
                const pullCGrid = this.classGrid.get(actToPull.classId);
                if(!pullCGrid) continue;

                for(let p = 0; p < PERIODS; p++){
                  const sTarget = sStart + p;
                  if(sTarget === singleSlot || this.offSlots.has(`${actToPull.classId}|${sTarget}`)) continue;

                  const existingActId = pullCGrid[sTarget];
                  if(existingActId < 0){
                    this.unplaceActivity(actToPull.id);
                    const res = this.getConflictsForSlot(actToPull, sTarget);
                    if(res.possible && res.conflicts.length === 0){
                      this.placeActivityDirect(actToPull.id, sTarget);
                      if(this.isLessonBlockSafe(actToPull)){
                        const m = this.evaluateMetrics();
                        if((m.soBuoiDay1 < currentBest.soBuoiDay1 || (m.soBuoiDay1 === currentBest.soBuoiDay1 && m.tsBuoiDay < currentBest.tsBuoiDay)) && m.soBuoiTrong2 <= maxGap2Limit){
                          currentBest = { ...m };
                          anyImproved = true;
                          reinResolved = true;
                          break;
                        }
                      }
                      this.unplaceActivity(actToPull.id);
                    }
                    this.placeActivityDirect(actToPull.id, item.slot);
                  }else{
                    const existingAct = this.activities[existingActId];
                    if(!existingAct || existingAct.isFixed || existingAct.duration !== 1) continue;

                    const existingTGrid = this.teacherGrid.get(existingAct.gv);
                    // 2-way swap
                    if(existingTGrid && existingTGrid[item.slot] < 0 && existingTGrid[item.slot] !== -3){
                      this.unplaceActivity(actToPull.id);
                      this.unplaceActivity(existingAct.id);

                      const r1 = this.getConflictsForSlot(actToPull, sTarget);
                      const r2 = this.getConflictsForSlot(existingAct, item.slot);

                      if(r1.possible && r1.conflicts.length === 0 && r2.possible && r2.conflicts.length === 0){
                        this.placeActivityDirect(actToPull.id, sTarget);
                        this.placeActivityDirect(existingAct.id, item.slot);

                        if(this.isLessonBlockSafe(actToPull, existingAct)){
                          const m = this.evaluateMetrics();
                          if((m.soBuoiDay1 < currentBest.soBuoiDay1 || (m.soBuoiDay1 === currentBest.soBuoiDay1 && m.tsBuoiDay < currentBest.tsBuoiDay)) && m.soBuoiTrong2 <= maxGap2Limit){
                            currentBest = { ...m };
                            anyImproved = true;
                            reinResolved = true;
                            break;
                          }
                        }
                        this.unplaceActivity(actToPull.id);
                        this.unplaceActivity(existingAct.id);
                      }
                      this.placeActivityDirect(actToPull.id, item.slot);
                      this.placeActivityDirect(existingAct.id, sTarget);
                    }
                    if(reinResolved) break;

                    // 3-way cyclic swap
                    for(let s3 = 0; s3 < 60; s3++){
                      if(s3 === item.slot || s3 === sTarget || this.offSlots.has(`${actToPull.classId}|${s3}`)) continue;
                      const actId3 = pullCGrid[s3];
                      if(actId3 < 0) continue;
                      const act3 = this.activities[actId3];
                      if(!act3 || act3.isFixed || act3.duration !== 1) continue;

                      this.unplaceActivity(actToPull.id);
                      this.unplaceActivity(existingAct.id);
                      this.unplaceActivity(act3.id);

                      const r1 = this.getConflictsForSlot(actToPull, sTarget);
                      const r2 = this.getConflictsForSlot(existingAct, s3);
                      const r3 = this.getConflictsForSlot(act3, item.slot);

                      if(r1.possible && r1.conflicts.length === 0 &&
                         r2.possible && r2.conflicts.length === 0 &&
                         r3.possible && r3.conflicts.length === 0){
                        this.placeActivityDirect(actToPull.id, sTarget);
                        this.placeActivityDirect(existingAct.id, s3);
                        this.placeActivityDirect(act3.id, item.slot);

                        if(this.isLessonBlockSafe(actToPull, existingAct, act3)){
                          const m = this.evaluateMetrics();
                          if((m.soBuoiDay1 < currentBest.soBuoiDay1 || (m.soBuoiDay1 === currentBest.soBuoiDay1 && m.tsBuoiDay < currentBest.tsBuoiDay)) && m.soBuoiTrong2 <= maxGap2Limit){
                            currentBest = { ...m };
                            anyImproved = true;
                            reinResolved = true;
                            break;
                          }
                        }
                        this.unplaceActivity(actToPull.id);
                        this.unplaceActivity(existingAct.id);
                        this.unplaceActivity(act3.id);
                      }
                      this.placeActivityDirect(actToPull.id, item.slot);
                      this.placeActivityDirect(existingAct.id, sTarget);
                      this.placeActivityDirect(act3.id, s3);
                    }
                  }
                  if(reinResolved) break;
                }
                if(reinResolved) break;
              }
              if(reinResolved) break;
            }
          }
        }
      }
      return anyImproved ? currentBest : null;
    }

    // Comprehensive Singleton Obliterator: thoroughly merges 1-period teaching sessions across the whole school using 2-way and 3-way cycles
    obliterateAllTeacherSingletons(maxPasses = 15, maxGap2Limit = Infinity){
      const DAYS = DAYS_LIST.length;
      const SESSIONS = SESSIONS_LIST.length;
      const PERIODS = PERIODS_PER_SESSION;
      let currentBest = this.evaluateMetrics();
      let anyImproved = false;

      for(let pass = 0; pass < maxPasses; pass++){
        if(currentBest.soBuoiDay1 <= 2) break;
        let passImproved = false;

        const teacherList = Array.from(this.teacherGrid.keys()).filter(Boolean);
        this.rng.shuffle(teacherList);

        for(const tKey of teacherList){
          const tGrid = this.teacherGrid.get(tKey);
          if(!tGrid) continue;

          for(let d = 0; d < DAYS; d++){
            for(let b = 0; b < SESSIONS; b++){
              const sStart = d * 10 + b * 5;
              const taught = [];
              for(let p = 0; p < PERIODS; p++){
                const s = sStart + p;
                if(tGrid[s] >= 0){
                  const act = this.activities[tGrid[s]];
                  if(act && !act.isFixed && act.duration === 1){
                    taught.push({ slot: s, actId: tGrid[s], p });
                  }
                }else if(tGrid[s] === -3){
                  taught.push({ slot: s, actId: -3, p });
                }
              }

              if(taught.length !== 1 || taught[0].actId < 0) continue;

              const s1 = taught[0].slot;
              const act1 = this.activities[taught[0].actId];
              const cGrid = this.classGrid.get(act1.classId);
              if(!cGrid) continue;

              const targetSessions = [];
              for(let d2 = 0; d2 < DAYS; d2++){
                for(let b2 = 0; b2 < SESSIONS; b2++){
                  if(d2 === d && b2 === b) continue;
                  const sStart2 = d2 * 10 + b2 * 5;
                  let cnt = 0;
                  for(let p2 = 0; p2 < PERIODS; p2++){
                    if(tGrid[sStart2 + p2] >= 0 || tGrid[sStart2 + p2] === -3) cnt++;
                  }
                  if(cnt >= 1 && cnt < 5){
                    targetSessions.push({ sStart: sStart2, cnt });
                  }
                }
              }
              targetSessions.sort((x, y) => y.cnt - x.cnt);

              let resolved = false;

              for(const target of targetSessions){
                for(let p2 = 0; p2 < PERIODS; p2++){
                  const s2 = target.sStart + p2;
                  if(this.offSlots.has(`${act1.classId}|${s2}`)) continue;

                  const actId2 = cGrid[s2];
                  if(actId2 < 0){
                    // Case 1: Empty slot
                    this.unplaceActivity(act1.id);
                    const res = this.getConflictsForSlot(act1, s2);
                    if(res.possible && res.conflicts.length === 0){
                      this.placeActivityDirect(act1.id, s2);
                      if(this.isLessonBlockSafe(act1)){
                        const m = this.evaluateMetrics();
                        if((m.soBuoiDay1 < currentBest.soBuoiDay1 || (m.soBuoiDay1 === currentBest.soBuoiDay1 && m.tsBuoiDay < currentBest.tsBuoiDay)) && m.soBuoiTrong2 <= maxGap2Limit){
                          currentBest = { ...m };
                          anyImproved = true;
                          passImproved = true;
                          resolved = true;
                          break;
                        }
                      }
                      this.unplaceActivity(act1.id);
                    }
                    this.placeActivityDirect(act1.id, s1);
                  }else{
                    const act2 = this.activities[actId2];
                    if(!act2 || act2.isFixed) continue;

                    // Case 2: 2-way direct swap
                    if(act2.duration === 1){
                      this.unplaceActivity(act1.id);
                      this.unplaceActivity(act2.id);

                      const r1 = this.getConflictsForSlot(act1, s2);
                      const r2 = this.getConflictsForSlot(act2, s1);

                      if(r1.possible && r1.conflicts.length === 0 && r2.possible && r2.conflicts.length === 0){
                        this.placeActivityDirect(act1.id, s2);
                        this.placeActivityDirect(act2.id, s1);

                        if(this.isLessonBlockSafe(act1, act2)){
                          const m = this.evaluateMetrics();
                          if((m.soBuoiDay1 < currentBest.soBuoiDay1 || (m.soBuoiDay1 === currentBest.soBuoiDay1 && m.tsBuoiDay < currentBest.tsBuoiDay)) && m.soBuoiTrong2 <= maxGap2Limit){
                            currentBest = { ...m };
                            anyImproved = true;
                            passImproved = true;
                            resolved = true;
                            break;
                          }
                        }
                        this.unplaceActivity(act1.id);
                        this.unplaceActivity(act2.id);
                      }
                      this.placeActivityDirect(act1.id, s1);
                      this.placeActivityDirect(act2.id, s2);
                    }

                    if(resolved) break;

                    // Case 3: 3-way cyclic swap
                    for(let s3 = 0; s3 < 60; s3++){
                      if(s3 === s1 || s3 === s2 || this.offSlots.has(`${act1.classId}|${s3}`)) continue;
                      const actId3 = cGrid[s3];
                      if(actId3 < 0) continue; // Must be a closed cycle so slot s1 is not left empty

                      const act3 = this.activities[actId3];
                      if(!act3 || act3.isFixed || act3.duration !== 1) continue;

                      this.unplaceActivity(act1.id);
                      this.unplaceActivity(act2.id);
                      this.unplaceActivity(act3.id);

                      const r1 = this.getConflictsForSlot(act1, s2);
                      const r2 = this.getConflictsForSlot(act2, s3);
                      const r3 = this.getConflictsForSlot(act3, s1);

                      if(r1.possible && r1.conflicts.length === 0 &&
                         r2.possible && r2.conflicts.length === 0 &&
                         r3.possible && r3.conflicts.length === 0){
                        this.placeActivityDirect(act1.id, s2);
                        this.placeActivityDirect(act2.id, s3);
                        this.placeActivityDirect(act3.id, s1);

                        if(this.isLessonBlockSafe(act1, act2, act3)){
                          const m = this.evaluateMetrics();
                          if((m.soBuoiDay1 < currentBest.soBuoiDay1 || (m.soBuoiDay1 === currentBest.soBuoiDay1 && m.tsBuoiDay < currentBest.tsBuoiDay)) && m.soBuoiTrong2 <= maxGap2Limit){
                            currentBest = { ...m };
                            anyImproved = true;
                            passImproved = true;
                            resolved = true;
                            break;
                          }
                        }
                        this.unplaceActivity(act1.id);
                        this.unplaceActivity(act2.id);
                        this.unplaceActivity(act3.id);
                      }
                      this.placeActivityDirect(act1.id, s1);
                      this.placeActivityDirect(act2.id, s2);
                      this.placeActivityDirect(act3.id, s3);
                    }
                  }
                  // Case 4: Pair Displacement (act2 is duration = 2)
                  if(!resolved && act2 && !act2.isFixed && act2.duration === 2){
                    const pStart = this.actPlacement[act2.id];
                    for(let altD = 0; altD < DAYS; altD++){
                      for(let altB = 0; altB < SESSIONS; altB++){
                        if(altD === d && altB === b) continue;
                        if(altD === Math.floor(target.sStart / 10) && altB === Math.floor((target.sStart % 10) / 5)) continue;
                        const altSStart = altD * 10 + altB * 5;

                        for(let ap = 0; ap < PERIODS - 1; ap++){
                          const altP = altSStart + ap;
                          if(this.offSlots.has(`${act1.classId}|${altP}`) || this.offSlots.has(`${act1.classId}|${altP + 1}`)) continue;

                          const aId1 = cGrid[altP];
                          const aId2 = cGrid[altP + 1];
                          if(aId1 < 0 || aId2 < 0) continue;
                          const aAct1 = this.activities[aId1];
                          const aAct2 = this.activities[aId2];
                          if(!aAct1 || aAct1.isFixed || aAct1.duration !== 1 || !aAct2 || aAct2.isFixed || aAct2.duration !== 1) continue;

                          this.unplaceActivity(act1.id);
                          this.unplaceActivity(act2.id);
                          this.unplaceActivity(aAct1.id);
                          this.unplaceActivity(aAct2.id);

                          const rPair = this.getConflictsForSlot(act2, altP);
                          const rAct1 = this.getConflictsForSlot(act1, pStart);
                          const rA1 = this.getConflictsForSlot(aAct1, s1);
                          const rA2 = this.getConflictsForSlot(aAct2, pStart + 1);

                          if(rPair.possible && rPair.conflicts.length === 0 &&
                             rAct1.possible && rAct1.conflicts.length === 0 &&
                             rA1.possible && rA1.conflicts.length === 0 &&
                             rA2.possible && rA2.conflicts.length === 0){
                            this.placeActivityDirect(act2.id, altP);
                            this.placeActivityDirect(act1.id, pStart);
                            this.placeActivityDirect(aAct1.id, s1);
                            this.placeActivityDirect(aAct2.id, pStart + 1);

                            if(this.isLessonBlockSafe(act1, act2, aAct1, aAct2)){
                              const m = this.evaluateMetrics();
                              if((m.soBuoiDay1 < currentBest.soBuoiDay1 || (m.soBuoiDay1 === currentBest.soBuoiDay1 && m.tsBuoiDay < currentBest.tsBuoiDay)) && m.soBuoiTrong2 <= maxGap2Limit){
                                currentBest = { ...m };
                                anyImproved = true;
                                passImproved = true;
                                resolved = true;
                                break;
                              }
                            }
                            this.unplaceActivity(act2.id);
                            this.unplaceActivity(act1.id);
                            this.unplaceActivity(aAct1.id);
                            this.unplaceActivity(aAct2.id);
                          }
                          this.placeActivityDirect(act1.id, s1);
                          this.placeActivityDirect(act2.id, pStart);
                          this.placeActivityDirect(aAct1.id, altP);
                          this.placeActivityDirect(aAct2.id, altP + 1);
                        }
                        if(resolved) break;
                      }
                      if(resolved) break;
                    }
                  }
                  if(resolved) break;
                }
                if(resolved) break;
              }
            }
          }
        }
        if(!passImproved) break;
      }
      return anyImproved ? currentBest : null;
    }

    // Targeted LNS Gap Crusher: specifically eliminates 2-period gaps (trống 2 tiết) and 1-period gaps
    tryCrushTeacherGaps(bestMetrics, initialMetrics, mode = "optimize_gap2"){
      let currentBest = { ...bestMetrics };
      let anyImproved = false;

      const teacherList = Array.from(this.teacherGrid.keys()).filter(Boolean);
      this.rng.shuffle(teacherList);

      for(const tKey of teacherList){
        const tGrid = this.teacherGrid.get(tKey);
        if(!tGrid) continue;

        for(let d = 0; d < DAYS_LIST.length; d++){
          for(let b = 0; b < SESSIONS_LIST.length; b++){
            const sessionStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
            const taught = [];
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const s = sessionStart + p;
              if(tGrid[s] >= 0 || tGrid[s] === -3){
                taught.push({ slot: s, actId: tGrid[s], p });
              }
            }

            const k = taught.length;
            if(k < 2) continue;

            let hasTargetGap = false;
            let gapSize = 0;
            for(let i = 0; i < k - 1; i++){
              const g = taught[i + 1].p - taught[i].p - 1;
              if(mode === "optimize_gap2" && g >= 2){
                hasTargetGap = true;
                gapSize = g;
                break;
              }else if(mode === "optimize_gap1" && g === 1){
                hasTargetGap = true;
                gapSize = g;
                break;
              }
            }

            if(!hasTargetGap) continue;

            const movableTaught = taught.filter(t => t.actId >= 0 && !this.activities[t.actId].isFixed && this.activities[t.actId].duration === 1);
            if(movableTaught.length === 0) continue;

            let gapResolved = false;

            for(const srcItem of movableTaught){
              const act1 = this.activities[srcItem.actId];
              const cClassGrid = this.classGrid.get(act1.classId);
              if(!cClassGrid) continue;

              // 1. Try moving act1 into the internal gap
              for(let p = 0; p < PERIODS_PER_SESSION; p++){
                const targetSlot = sessionStart + p;
                if(tGrid[targetSlot] >= 0 || tGrid[targetSlot] === -3) continue;
                if(this.offSlots.has(`${act1.classId}|${targetSlot}`)) continue;

                const actId2 = cClassGrid[targetSlot];

                if(actId2 < 0){
                  this.unplaceActivity(act1.id);
                  const res = this.getConflictsForSlot(act1, targetSlot);
                  if(res.possible && res.conflicts.length === 0){
                    this.placeActivityDirect(act1.id, targetSlot);
                    if(this.isLessonBlockSafe(act1)){
                      const currentM = this.evaluateMetrics();
                      let isBetter = false;
                      if(mode === "optimize_gap2" && currentM.soBuoiDay1 <= bestMetrics.soBuoiDay1 && currentM.soBuoiTrong2 < currentBest.soBuoiTrong2){
                        isBetter = true;
                      }else if(mode === "optimize_gap1" && currentM.soBuoiDay1 <= bestMetrics.soBuoiDay1 && currentM.soBuoiTrong2 <= bestMetrics.soBuoiTrong2 && currentM.soBuoiTrong1 < currentBest.soBuoiTrong1){
                        isBetter = true;
                      }

                      if(isBetter){
                        currentBest = { ...currentM };
                        anyImproved = true;
                        gapResolved = true;
                        break;
                      }
                    }
                    this.unplaceActivity(act1.id);
                  }
                  this.placeActivityDirect(act1.id, srcItem.slot);
                }else{
                  const act2 = this.activities[actId2];
                  if(!act2 || act2.isFixed || act2.duration !== 1) continue;

                  const tDstGrid = this.teacherGrid.get(act2.gv);
                  if(tDstGrid && tDstGrid[srcItem.slot] < 0 && tDstGrid[srcItem.slot] !== -3){
                    this.unplaceActivity(act1.id);
                    this.unplaceActivity(act2.id);

                    const r1 = this.getConflictsForSlot(act1, targetSlot);
                    const r2 = this.getConflictsForSlot(act2, srcItem.slot);

                    if(r1.possible && r1.conflicts.length === 0 && r2.possible && r2.conflicts.length === 0){
                      this.placeActivityDirect(act1.id, targetSlot);
                      this.placeActivityDirect(act2.id, srcItem.slot);

                      if(this.isLessonBlockSafe(act1, act2)){
                        const currentM = this.evaluateMetrics();
                        let isBetter = false;
                        if(mode === "optimize_gap2" && currentM.soBuoiDay1 <= bestMetrics.soBuoiDay1 && currentM.soBuoiTrong2 < currentBest.soBuoiTrong2){
                          isBetter = true;
                        }else if(mode === "optimize_gap1" && currentM.soBuoiDay1 <= bestMetrics.soBuoiDay1 && currentM.soBuoiTrong2 <= bestMetrics.soBuoiTrong2 && currentM.soBuoiTrong1 < currentBest.soBuoiTrong1){
                          isBetter = true;
                        }

                        if(isBetter){
                          currentBest = { ...currentM };
                          anyImproved = true;
                          gapResolved = true;
                          break;
                        }
                      }
                      this.unplaceActivity(act1.id);
                      this.unplaceActivity(act2.id);
                    }
                    this.placeActivityDirect(act1.id, srcItem.slot);
                    this.placeActivityDirect(act2.id, targetSlot);
                  }
                }
              }
              if(gapResolved) break;
            }
          }
        }
      }
      return anyImproved ? currentBest : null;
    }

    // Powerful, time-budgeted asynchronous multi-pass optimizer
    async optimize(mode = "optimize_singletons", progressCallback = null){
      this.loadExistingSchedule();
      const initialMetrics = this.evaluateMetrics();
      let bestMetrics = { ...initialMetrics };
      let bestPlacement = this.actPlacement.slice();
      let bestClassGrid = new Map();
      this.classGrid.forEach((arr, cid) => bestClassGrid.set(cid, arr.slice()));
      let bestTeacherGrid = new Map();
      this.teacherGrid.forEach((arr, gv) => bestTeacherGrid.set(gv, arr.slice()));
      let bestRoomGrid = new Map();
      this.roomGrid.forEach((arr, rm) => bestRoomGrid.set(rm, arr.slice()));

      const saveBestSnapshot = () => {
        bestPlacement = this.actPlacement.slice();
        bestClassGrid = new Map();
        this.classGrid.forEach((arr, cid) => bestClassGrid.set(cid, arr.slice()));
        bestTeacherGrid = new Map();
        this.teacherGrid.forEach((arr, gv) => bestTeacherGrid.set(gv, arr.slice()));
        bestRoomGrid = new Map();
        this.roomGrid.forEach((arr, rm) => bestRoomGrid.set(rm, arr.slice()));
      };

      const getMetricVal = (m) => {
        if(mode === "optimize_singletons") return m.soBuoiDay1;
        if(mode === "optimize_sessions") return m.tsBuoiDay;
        if(mode === "optimize_gap2") return m.soBuoiTrong2;
        if(mode === "optimize_gap1") return m.soBuoiTrong1;
        return m.soBuoiDay1;
      };

      if(progressCallback){
        progressCallback({
          percent: 0,
          currentMetric: getMetricVal(bestMetrics),
          initialMetric: getMetricVal(initialMetrics),
          metrics: bestMetrics
        });
      }

      const MAX_ROUNDS = (mode === "optimize_singletons") ? 100 : ((mode === "optimize_gap2") ? 60 : 120);
      const classesList = this.classes.slice();
      let consecutiveUnimprovedRounds = 0;

      for(let round = 0; round < MAX_ROUNDS; round++){
        if(typeof window !== "undefined" && window.__AUTO_SORT_STOP_REQUESTED) break;

        let improvedInRound = false;
        await new Promise(resolve => setTimeout(resolve, 0));

        // PASS 0: Deep LNS Singleton Consolidation
        const maxG2 = (mode === "optimize_sessions" || mode === "optimize_gap2") ? bestMetrics.soBuoiTrong2 : Infinity;
        const subPasses = (mode === "optimize_singletons") ? 3 : 1;

        for(let sub = 0; sub < subPasses; sub++){
          const oblitM = this.obliterateAllTeacherSingletons(15, maxG2);
          if(oblitM && oblitM.soBuoiDay1 < bestMetrics.soBuoiDay1 && ((mode !== "optimize_sessions" && mode !== "optimize_gap2") || oblitM.soBuoiTrong2 <= bestMetrics.soBuoiTrong2)){
            bestMetrics = { ...oblitM };
            saveBestSnapshot();
            improvedInRound = true;
          }

          const resSingle = this.tryConsolidateTeacherSingletons(bestMetrics, initialMetrics, maxG2);
          if(resSingle && resSingle.soBuoiDay1 < bestMetrics.soBuoiDay1 && ((mode !== "optimize_sessions" && mode !== "optimize_gap2") || resSingle.soBuoiTrong2 <= bestMetrics.soBuoiTrong2)){
            bestMetrics = { ...resSingle };
            saveBestSnapshot();
            improvedInRound = true;
          }

          const resReinforce = this.tryReinforceTeacherSingletons(bestMetrics, initialMetrics, maxG2);
          if(resReinforce && resReinforce.soBuoiDay1 < bestMetrics.soBuoiDay1 && ((mode !== "optimize_sessions" && mode !== "optimize_gap2") || resReinforce.soBuoiTrong2 <= bestMetrics.soBuoiTrong2)){
            bestMetrics = { ...resReinforce };
            saveBestSnapshot();
            improvedInRound = true;
          }
        }

        // PASS 0.5: Targeted LNS Gap Crusher
        if(mode !== "optimize_singletons"){
          const resGap = this.tryCrushTeacherGaps(bestMetrics, initialMetrics, mode === "optimize_gap1" ? "optimize_gap1" : "optimize_gap2");
          if(resGap && resGap.soBuoiDay1 <= bestMetrics.soBuoiDay1){
            bestMetrics = { ...resGap };
            saveBestSnapshot();
            improvedInRound = true;
          }
        }

        if(mode === "optimize_singletons" || mode === "optimize_sessions"){
          const teacherList = Array.from(this.teacherGrid.keys()).filter(Boolean);
          for(const tKey of teacherList){
            const tGrid = this.teacherGrid.get(tKey);
            if(!tGrid) continue;

            for(let d1 = 0; d1 < DAYS_LIST.length; d1++){
              for(let b1 = 0; b1 < SESSIONS_LIST.length; b1++){
                const sessionStart1 = d1 * SLOTS_PER_DAY + b1 * PERIODS_PER_SESSION;
                const taught1 = [];
                for(let p = 0; p < PERIODS_PER_SESSION; p++){
                  const s = sessionStart1 + p;
                  if(tGrid[s] >= 0 || tGrid[s] === -3) taught1.push({ slot: s, actId: tGrid[s] });
                }

                if(taught1.length === 1 && taught1[0].actId >= 0){
                  const singleItem = taught1[0];
                  const act1 = this.activities[singleItem.actId];
                  if(!act1 || act1.isFixed || act1.duration !== 1) continue;

                  const classGridArr = this.classGrid.get(act1.classId);
                  if(!classGridArr) continue;

                  let resolved = false;

                  for(let d2 = 0; d2 < DAYS_LIST.length; d2++){
                    for(let b2 = 0; b2 < SESSIONS_LIST.length; b2++){
                      if(d2 === d1 && b2 === b1) continue;
                      const sessionStart2 = d2 * SLOTS_PER_DAY + b2 * PERIODS_PER_SESSION;

                      let teacherCountInSession2 = 0;
                      for(let p = 0; p < PERIODS_PER_SESSION; p++){
                        const s = sessionStart2 + p;
                        if(tGrid[s] >= 0 || tGrid[s] === -3) teacherCountInSession2++;
                      }
                      if(teacherCountInSession2 === 0) continue;

                      for(let p2 = 0; p2 < PERIODS_PER_SESSION; p2++){
                        const s2 = sessionStart2 + p2;
                        if(this.offSlots.has(`${act1.classId}|${s2}`)) continue;

                        const actId2 = classGridArr[s2];
                        if(actId2 < 0){
                          this.unplaceActivity(act1.id);
                          const res = this.getConflictsForSlot(act1, s2);
                          if(res.possible && res.conflicts.length === 0){
                            this.placeActivityDirect(act1.id, s2);
                            if(this.isLessonBlockSafe(act1)){
                              const currentM = this.evaluateMetrics();
                              if(currentM.soBuoiDay1 < bestMetrics.soBuoiDay1){
                                bestMetrics = { ...currentM };
                                saveBestSnapshot();
                                improvedInRound = true;
                                resolved = true;
                                break;
                              }
                            }
                            this.unplaceActivity(act1.id);
                          }
                          this.placeActivityDirect(act1.id, singleItem.slot);
                        }else{
                          const act2 = this.activities[actId2];
                          if(!act2 || act2.isFixed || act2.duration !== 1) continue;

                          const tGrid2 = this.teacherGrid.get(act2.gv);
                          if(tGrid2 && tGrid2[singleItem.slot] < 0 && tGrid2[singleItem.slot] !== -3){
                            this.unplaceActivity(act1.id);
                            this.unplaceActivity(act2.id);

                            const r1 = this.getConflictsForSlot(act1, s2);
                            const r2 = this.getConflictsForSlot(act2, singleItem.slot);

                            if(r1.possible && r1.conflicts.length === 0 && r2.possible && r2.conflicts.length === 0){
                              this.placeActivityDirect(act1.id, s2);
                              this.placeActivityDirect(act2.id, singleItem.slot);

                              if(this.isLessonBlockSafe(act1, act2)){
                                const currentM = this.evaluateMetrics();
                                if(currentM.soBuoiDay1 < bestMetrics.soBuoiDay1){
                                  bestMetrics = { ...currentM };
                                  saveBestSnapshot();
                                  improvedInRound = true;
                                  resolved = true;
                                  break;
                                }
                              }
                              this.unplaceActivity(act1.id);
                              this.unplaceActivity(act2.id);
                            }
                            this.placeActivityDirect(act1.id, singleItem.slot);
                            this.placeActivityDirect(act2.id, s2);
                          }
                        }
                      }
                      if(resolved) break;
                    }
                    if(resolved) break;
                  }
                }
              }
            }
          }
        }

        if(improvedInRound){
          consecutiveUnimprovedRounds = 0;
        }else{
          consecutiveUnimprovedRounds++;
        }

        const pct = Math.min(99, Math.round(((round + 1) / MAX_ROUNDS) * 100));
        if(progressCallback){
          progressCallback({
            percent: pct,
            currentMetric: getMetricVal(bestMetrics),
            initialMetric: getMetricVal(initialMetrics),
            metrics: bestMetrics
          });
        }

        if(getMetricVal(bestMetrics) === 0 || (mode === "optimize_singletons" && bestMetrics.soBuoiDay1 <= 2)){
          if(progressCallback){
            progressCallback({
              percent: 100,
              currentMetric: getMetricVal(bestMetrics),
              initialMetric: Math.max(1, getMetricVal(initialMetrics)),
              metrics: bestMetrics
            });
          }
          break;
        }

        const maxStagnantRounds = (mode === "optimize_singletons") ? 3 : 2;
        if(consecutiveUnimprovedRounds >= maxStagnantRounds){
          if(progressCallback){
            progressCallback({
              percent: 100,
              currentMetric: getMetricVal(bestMetrics),
              initialMetric: Math.max(1, getMetricVal(initialMetrics)),
              metrics: bestMetrics
            });
          }
          break;
        }
      }

      if(bestPlacement){
        this.actPlacement = bestPlacement;
        this.classGrid = bestClassGrid;
        this.teacherGrid = bestTeacherGrid;
        this.roomGrid = bestRoomGrid;
      }

      this.applyToDataTKB();

      let placed = 0;
      this.activities.forEach((act, idx) => {
        if(this.actPlacement[idx] >= 0) placed += act.duration;
      });
      placed += this.fixedSlots.size;

      return {
        ok: true,
        placed,
        unassigned: 0,
        initialMetrics,
        metrics: bestMetrics
      };
    }
"""

marker_start = "    tryConsolidateTeacherSingletons("
marker_end = "  }\n\n  global.FetTimetableEngine = FetTimetableEngine;"

pos_start = text.find(marker_start)
pos_end = text.rfind(marker_end)

if pos_start == -1 or pos_end == -1:
    print("Could not find markers! pos_start:", pos_start, "pos_end:", pos_end)
    sys.exit(1)

new_text = text[:pos_start] + safe_optimizer_block + text[pos_end:]

with open(engine_path, "w", encoding="utf-8") as f:
    f.write(new_text)

print("Safely replaced optimizer in engine with zero-violation guards!")
