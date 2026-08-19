const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('./test_state_0917.json', 'utf8'));
const engineCode = fs.readFileSync('../web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;

async function analyzeResiduals(){
  const solver = new FetTimetableEngine(schoolData);
  solver.loadExistingSchedule();
  console.log("Initial state:", solver.evaluateMetrics());

  // Run full optimize_singletons
  const res = await solver.optimize("optimize_singletons", (p) => {
    // console.log(p.percent, p.currentMetric);
  });
  console.log("State after full optimize_singletons:", solver.evaluateMetrics());

  const DAYS = 6;
  const SESSIONS = 2;
  const PERIODS = 5;
  const SLOTS_PER_DAY = 10;

  const remaining = [];
  solver.teacherGrid.forEach((grid, tKey) => {
    if(!tKey || !solver.isScoredTeacher(tKey)) return;
    for(let d = 0; d < DAYS; d++){
      for(let b = 0; b < SESSIONS; b++){
        const sStart = d * SLOTS_PER_DAY + b * PERIODS;
        const taught = [];
        for(let p = 0; p < PERIODS; p++){
          const s = sStart + p;
          const actId = grid[s];
          if(actId >= 0){
            taught.push({ slot: s, actId, act: solver.activities[actId] });
          }
        }
        if(taught.length === 1){
          remaining.push({ teacher: tKey, day: d, session: b, slot: taught[0].slot, act: taught[0].act });
        }
      }
    }
  });

  console.log(`\n=== REMAINING SINGLETONS: ${remaining.length} ===`);
  for(const r of remaining){
    const act = r.act;
    const cGrid = solver.classGrid.get(act.classId);
    const tGrid = solver.teacherGrid.get(r.teacher);
    console.log(`\nGV ${r.teacher} - Buổi ${r.day}.${r.session} - Môn ${act.subject} - Lớp ${act.classId} (Slot ${r.slot})`);
    
    let candSessions = 0;
    for(let d2 = 0; d2 < DAYS; d2++){
      if(d2 === r.day) continue;
      const sStart2 = d2 * SLOTS_PER_DAY + r.session * PERIODS;
      let cnt = 0;
      for(let p = 0; p < PERIODS; p++){
        if(tGrid[sStart2 + p] >= 0 || tGrid[sStart2 + p] === -3) cnt++;
      }
      if(cnt >= 1 && cnt < 5){
        candSessions++;
        console.log(`  -> Buổi ứng viên Thứ ${d2+2} (đã có ${cnt} tiết):`);
        for(let p = 0; p < PERIODS; p++){
          const s2 = sStart2 + p;
          const occC = cGrid[s2];
          const occT = tGrid[s2];
          let reason = [];
          if(occT >= 0 || occT === -3) reason.push(`GV bận (${occT})`);
          if(occC >= 0){
            const occAct = solver.activities[occC];
            reason.push(`Lớp có môn ${occAct.subject} (GV ${occAct.teacherId}, dur=${occAct.duration})`);
            const tGridOcc = solver.teacherGrid.get(occAct.teacherId);
            if(tGridOcc && (tGridOcc[r.slot] >= 0 || tGridOcc[r.slot] === -3)){
              reason.push(`GV ${occAct.teacherId} bận tại Slot ${r.slot}`);
            }
          }
          console.log(`     Slot ${s2}: ${reason.join(' | ') || 'Trống hoàn toàn'}`);
        }
      }
    }
    if(candSessions === 0){
      console.log(`  -> KHÔNG CÓ buổi nào khác cùng ca có 1-4 tiết!`);
    }
  }
}

analyzeResiduals();
