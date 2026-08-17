const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;

async function traceLinh(){
  const solver = new FetTimetableEngine(schoolData);
  solver.solve();
  schoolData.tkb = solver.getSnapshotTKB();

  const opt = new FetTimetableEngine(schoolData);
  opt.loadExistingSchedule();

  const gv = "sđ.linh";
  const tGrid = opt.teacherGrid.get(gv);
  console.log("Initial Linh teacher grid:");
  for(let d = 0; d < 6; d++){
    for(let b = 0; b < 2; b++){
      const sStart = d * 10 + b * 5;
      const taught = [];
      for(let p = 0; p < 5; p++){
        const s = sStart + p;
        if(tGrid[s] >= 0){
          const act = opt.activities[tGrid[s]];
          taught.push(`P${p+1}: ${act.classId}-${act.mon} (dur=${act.duration}, actId=${act.id})`);
        }
      }
      if(taught.length > 0){
        console.log(`Day ${d+2} ${b===0?'Sáng':'Chiều'}: [${taught.join(', ')}]`);
      }
    }
  }
}

traceLinh();
