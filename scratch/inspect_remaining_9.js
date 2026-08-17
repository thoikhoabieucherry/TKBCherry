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

// Run the script
const augScript = fs.readFileSync('scratch/test_augmenting_path_singletons.js', 'utf8');
eval(augScript);

const finalSingletons = [];
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
      if(taught.length === 1){
        const act = taught[0].actId >= 0 ? opt.activities[taught[0].actId] : null;
        finalSingletons.push({
          gv, day: d, session: b, slot: taught[0].slot, actId: taught[0].actId,
          classId: act?.classId, mon: act?.mon, duration: act?.duration
        });
      }
    }
  }
}

console.log(`\nRemaining singletons (${finalSingletons.length}):`);
for(const s of finalSingletons){
  console.log(`- Teacher ${s.gv}: Day ${s.day} (${s.session===0?'Sáng':'Chiều'}), Slot ${s.slot}, Class ${s.classId}, Mon ${s.mon}, Dur ${s.duration}`);
}
