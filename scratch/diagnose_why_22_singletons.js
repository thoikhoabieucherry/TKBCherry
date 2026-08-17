const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;

async function diagnose(){
  const solver = new FetTimetableEngine(schoolData);
  solver.solve();
  schoolData.tkb = solver.getSnapshotTKB();

  const opt = new FetTimetableEngine(schoolData);
  await opt.optimize("optimize_singletons");

  const m = opt.evaluateMetrics();
  console.log("Metrics after current optimizer:", m);

  // Find all remaining singletons
  const singletons = [];
  for(const [gv, grid] of opt.teacherGrid.entries()){
    for(let d = 0; d < 6; d++){
      for(let b = 0; b < 2; b++){
        const sStart = d * 10 + b * 5;
        const taught = [];
        for(let p = 0; p < 5; p++){
          const s = sStart + p;
          const actId = grid[s];
          if(actId >= 0 || actId === -3){
            taught.push({ p, slot: s, actId, isFixed: actId === -3 });
          }
        }
        if(taught.length === 1){
          const item = taught[0];
          const act = item.actId >= 0 ? opt.activities[item.actId] : null;
          singletons.push({
            gv,
            day: d,
            session: b,
            slot: item.slot,
            period: item.p,
            isFixed: item.isFixed,
            actId: item.actId,
            classId: act?.classId,
            mon: act?.mon,
            duration: act?.duration
          });
        }
      }
    }
  }

  console.log(`\nRemaining singletons count: ${singletons.length}`);
  for(const s of singletons){
    console.log(`- Teacher ${s.gv}: Day ${s.day} (${s.session === 0 ? 'Sáng' : 'Chiều'}), Slot ${s.slot}, Class ${s.classId}, Mon ${s.mon}, Duration: ${s.duration}`);
  }
}

diagnose();
