const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;

const solver = new FetTimetableEngine(schoolData);
solver.solve();
schoolData.tkb = solver.getSnapshotTKB();

const opt = new FetTimetableEngine(schoolData);
opt.loadExistingSchedule();

opt.optimize('optimize_singletons').then(() => {
  const m = opt.evaluateMetrics();
  console.log("Metrics:", m);

  // For each teacher with 1 singleton:
  for(const [gv, grid] of opt.teacherGrid.entries()){
    const singletons = [];
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
        if(taught.length === 1){
          const act = taught[0].actId >= 0 ? opt.activities[taught[0].actId] : null;
          singletons.push({ day: d, session: b, slot: taught[0].slot, act });
        }
      }
    }

    if(singletons.length > 0){
      console.log(`\n========================================`);
      console.log(`TEACHER: ${gv} (has ${singletons.length} singletons)`);
      for(const sing of singletons){
        console.log(`Singleton at Day ${sing.day+2} (${sing.session===0?'Sáng':'Chiều'}), Slot ${sing.slot}, Class ${sing.act?.classId}, Mon ${sing.act?.mon}`);
      }

      // Check all classes taught by this teacher
      const teacherClasses = new Set();
      opt.activities.forEach(a => { if(a.gv === gv) teacherClasses.add(a.classId); });
      console.log(`Classes taught by ${gv}:`, Array.from(teacherClasses));

      // Check week load of this teacher:
      for(let d = 0; d < 6; d++){
        const sActs = [];
        const cActs = [];
        for(let p = 0; p < 5; p++){
          const s1 = d * 10 + p;
          const s2 = d * 10 + 5 + p;
          if(grid[s1] >= 0) sActs.push(opt.activities[grid[s1]].mon);
          if(grid[s2] >= 0) cActs.push(opt.activities[grid[s2]].mon);
        }
        console.log(`Day ${d+2}: Sáng [${sActs.join(',')}] | Chiều [${cActs.join(',')}]`);
      }
    }
  }
});
