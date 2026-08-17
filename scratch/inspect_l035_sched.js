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
  const cid = 'L035';
  const cGrid = opt.classGrid.get(cid);
  console.log(`Class ${cid} schedule:`);
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
    console.log(`Day ${d+2}: Sáng [${sang.join(', ')}] | Chiều [${chieu.join(', ')}]`);
  }
});
