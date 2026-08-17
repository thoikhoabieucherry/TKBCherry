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

console.log("Initial metrics:", opt.evaluateMetrics());

// Let's run optimize_singletons
opt.optimize('optimize_singletons').then(() => {
  console.log("After optimize_singletons:", opt.evaluateMetrics());

  // Find the exact singletons
  const singletons = [];
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
          singletons.push({ gv, day: d, session: b, slot: taught[0].slot, act });
        }
      }
    }
  }

  console.log(`\nExact remaining singletons (${singletons.length}):`);
  for(const sing of singletons){
    console.log(`\n=== Teacher: ${sing.gv} ===`);
    console.log(`Singleton: Day ${sing.day+2} (${sing.session===0?'Sáng':'Chiều'}), Slot ${sing.slot}, Class ${sing.act.classId}, Mon ${sing.act.mon}, Dur ${sing.act.duration}`);

    // Let's print the entire week schedule of this teacher
    const tGrid = opt.teacherGrid.get(sing.gv);
    for(let d = 0; d < 6; d++){
      const sang = [];
      const chieu = [];
      for(let p = 0; p < 5; p++){
        const s1 = d * 10 + p;
        const s2 = d * 10 + 5 + p;
        if(tGrid[s1] >= 0){
          const a = opt.activities[tGrid[s1]];
          sang.push(`P${p+1}:${a.classId}-${a.mon}`);
        }else if(tGrid[s1] === -3) sang.push(`P${p+1}:FIX`);
        else sang.push(`P${p+1}:_`);

        if(tGrid[s2] >= 0){
          const a = opt.activities[tGrid[s2]];
          chieu.push(`P${p+1}:${a.classId}-${a.mon}`);
        }else if(tGrid[s2] === -3) chieu.push(`P${p+1}:FIX`);
        else chieu.push(`P${p+1}:_`);
      }
      console.log(`  Day ${d+2}: Sáng [${sang.join(', ')}] | Chiều [${chieu.join(', ')}]`);
    }

    // Let's print the class schedule of sing.act.classId
    const cGrid = opt.classGrid.get(sing.act.classId);
    console.log(`\nClass ${sing.act.classId} schedule:`);
    for(let d = 0; d < 6; d++){
      const sang = [];
      const chieu = [];
      for(let p = 0; p < 5; p++){
        const s1 = d * 10 + p;
        const s2 = d * 10 + 5 + p;
        if(cGrid[s1] >= 0){
          const a = opt.activities[cGrid[s1]];
          sang.push(`P${p+1}:${a.mon}(${a.gv})`);
        }else if(cGrid[s1] === -2) sang.push(`P${p+1}:OFF`);
        else if(cGrid[s1] === -3) sang.push(`P${p+1}:FIX`);
        else sang.push(`P${p+1}:_`);

        if(cGrid[s2] >= 0){
          const a = opt.activities[cGrid[s2]];
          chieu.push(`P${p+1}:${a.mon}(${a.gv})`);
        }else if(cGrid[s2] === -2) chieu.push(`P${p+1}:OFF`);
        else if(cGrid[s2] === -3) chieu.push(`P${p+1}:FIX`);
        else chieu.push(`P${p+1}:_`);
      }
      console.log(`  Day ${d+2}: Sáng [${sang.join(', ')}] | Chiều [${chieu.join(', ')}]`);
    }
  }
});
