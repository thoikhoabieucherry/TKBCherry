const fs = require('fs');
const file = 'C:/Users/Love/Documents/Codex/TKBCherry/web/pages/tkb-fet-engine.js';
let content = fs.readFileSync(file, 'utf8');

// 1. Update compareMetrics
content = content.replace(
  'if(a.soBuoiTrong2 > b.soBuoiTrong2) return 1;',
  '// if(a.soBuoiTrong2 > b.soBuoiTrong2) return 1; // Allowed to increase if singletons drop'
);

// 2. Update tryReinforceTeacherSingletons
const oldRegex = /tryReinforceTeacherSingletons\([\s\S]*?return anyImproved \? currentBest : null;\s*\}/;

const newCode = `tryReinforceTeacherSingletons(bestMetrics, initialMetrics, maxGap2Limit = 0, onProgress = null){
      const DAYS = DAYS_LIST.length;
      const SESSIONS = SESSIONS_LIST.length;
      const PERIODS = PERIODS_PER_SESSION;
      let currentBest = { ...bestMetrics };
      let anyImproved = false;

      const teacherList = Array.from(this.teacherGrid.keys()).filter(t => t && this.isScoredTeacher(t));
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
                
                for(let p = 0; p < PERIODS; p++){
                  const sTarget = sStart + p;
                  if(sTarget === singleSlot || this.offSlots.has(\`\${actToPull.classId}|\${sTarget}\`)) continue;
                  if(tGrid[sTarget] >= 0 || tGrid[sTarget] === -3) continue;

                  const snap = this.captureStateSnapshot();
                  this.unplaceActivity(actToPull.id);
                  
                  const existingActId = this.classGrid.get(actToPull.classId)[sTarget];
                  let ok = false;
                  
                  if (existingActId >= 0) {
                    const existingAct = this.activities[existingActId];
                    if (existingAct && !existingAct.isFixed && existingAct.duration === 1) {
                      this.unplaceActivity(existingAct.id);
                      this.placeActivityDirect(actToPull.id, sTarget);
                      
                      const savedCalls = this.limitCalls;
                      this.limitCalls = 10000;
                      this.nCalls = 0;
                      ok = this.randomSwap(existingAct.id, 0);
                      this.limitCalls = savedCalls;
                    }
                  } else {
                    this.placeActivityDirect(actToPull.id, sTarget);
                    ok = true;
                  }

                  if(ok && this.isLessonBlockSafe()){
                    const m = this.evaluateMetrics();
                    if(m.soBuoiDay1 < currentBest.soBuoiDay1){
                      currentBest = { ...m };
                      anyImproved = true;
                      reinResolved = true;
                      if(typeof onProgress === "function") onProgress(currentBest);
                      break;
                    }
                  }
                  this.restoreStateSnapshot(snap);
                }
                if(reinResolved) break;
              }
              if(reinResolved) break;
            }
          }
        }
      }
      return anyImproved ? currentBest : null;
    }`;

content = content.replace(oldRegex, newCode);
fs.writeFileSync(file, content, 'utf8');
console.log('Update successful!');
