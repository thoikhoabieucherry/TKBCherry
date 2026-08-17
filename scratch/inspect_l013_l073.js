const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const engine = new FetTimetableEngine(schoolData);
engine.solve();

for(const targetCid of ['L013', 'L073']){
  console.log(`\n=== CLASS ${targetCid} ===`);
  const acts = engine.activities.filter(a => a.classId === targetCid);
  acts.forEach(a => {
    const slot = engine.actPlacement[a.id];
    console.log(`  Act ${a.id}: mon=${a.mon}, dur=${a.duration}, slot=${slot}`);
    for(let d = 0; d < a.duration; d++){
      const s = slot + d;
      const key = `${targetCid}|${s}`;
      if(engine.offSlots.has(key)) console.log(`    WARNING: slot ${s} is in offSlots!`);
      if(engine.fixedSlots.has(key)) console.log(`    WARNING: slot ${s} is in fixedSlots!`);
    }
  });
}
