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

// Step 1: Initial Crusher
opt.obliterateAllTeacherSingletons(20, Infinity);
opt.tryConsolidateTeacherSingletons(opt.evaluateMetrics(), opt.evaluateMetrics(), Infinity);
opt.tryReinforceTeacherSingletons(opt.evaluateMetrics(), opt.evaluateMetrics(), Infinity);

console.log("Singletons remaining:", opt.evaluateMetrics().soBuoiDay1);

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
        console.log(`\nTeacher: ${gv}, Day ${d+2} (${b===0?'Sáng':'Chiều'}), Class ${act.classId}, Mon ${act.mon}`);

        // Check user off constraints for this teacher:
        const offConstraints = [];
        for(let s = 0; s < 60; s++){
          if(opt.offSlots.has(`${gv}|${s}`)){
            offConstraints.push(s);
          }
        }
        console.log(`  User Off slots count for ${gv}: ${offConstraints.length}`);

        // Check gioihan / limits
        console.log(`  PCCM Gioi han for ${gv}:`, schoolData.pccmGioihanMatrix?.[gv] || 'none');
      }
    }
  }
}
