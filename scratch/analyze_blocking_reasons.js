const fs = require('fs');

const allSchools = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/all_vps_schools.json', 'utf8'));
const schoolData = allSchools['school_default'];

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;

const solver = new FetTimetableEngine(schoolData);
solver.solve();
schoolData.tkb = solver.getSnapshotTKB();

const opt = new FetTimetableEngine(schoolData);
opt.loadExistingSchedule();

opt.optimize('optimize_singletons').then(() => {
  console.log("Current singletons:", opt.evaluateMetrics().soBuoiDay1);

  // For each teacher with 1 singleton:
  for(const [gv, grid] of opt.teacherGrid.entries()){
    for(let d = 0; d < 6; d++){
      for(let b = 0; b < 2; b++){
        const sStart = d * 10 + b * 5;
        const taught = [];
        for(let p = 0; p < 5; p++){
          const s = sStart + p;
          if(grid[s] >= 0 || grid[s] === -3){
            taught.push({ p, slot: s, actId: grid[s] });
          }
        }
        if(taught.length === 1 && taught[0].actId >= 0){
          const act = opt.activities[taught[0].actId];
          console.log(`\n========================================`);
          console.log(`Teacher ${gv}: Singleton at Day ${d+2} (${b===0?'Sáng':'Chiều'}), Class ${act.classId}, Mon ${act.mon}`);

          // Why can't it move to other sessions where teacher teaches?
          for(let d2 = 0; d2 < 6; d2++){
            for(let b2 = 0; b2 < 2; b2++){
              if(d2 === d && b2 === b) continue;
              const sStart2 = d2 * 10 + b2 * 5;
              let cnt = 0;
              for(let p2 = 0; p2 < 5; p2++){
                if(grid[sStart2 + p2] >= 0 || grid[sStart2 + p2] === -3) cnt++;
              }
              if(cnt >= 1){
                console.log(`  Candidate target Day ${d2+2} (${b2===0?'Sáng':'Chiều'}): teacher teaches ${cnt} periods`);
                const cGrid = opt.classGrid.get(act.classId);
                for(let p2 = 0; p2 < 5; p2++){
                  const s2 = sStart2 + p2;
                  const occId = cGrid[s2];
                  if(occId >= 0){
                    const occAct = opt.activities[occId];
                    console.log(`    Slot P${p2+1} (s=${s2}): Occupied in class ${act.classId} by ${occAct.mon} (${occAct.gv}, dur=${occAct.duration})`);
                  }else if(occId === -2){
                    console.log(`    Slot P${p2+1} (s=${s2}): Class OFF`);
                  }else if(occId === -3){
                    console.log(`    Slot P${p2+1} (s=${s2}): Class FIXED`);
                  }else{
                    console.log(`    Slot P${p2+1} (s=${s2}): Class EMPTY`);
                  }
                }
              }
            }
          }
        }
      }
    }
  }
});
