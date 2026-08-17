const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

let engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');

eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;
const engine = new FetTimetableEngine(schoolData);

// Check if any activity is placed in an off or fixed slot during solve
engine.solve();

console.log("Checking all placed activities against offSlots and fixedSlots...");
let collCount = 0;
engine.activities.forEach(act => {
  const slot = engine.actPlacement[act.id];
  if(slot < 0){
    console.log(`Act ${act.id} (${act.classId} ${act.mon}) is UNPLACED!`);
    collCount++;
    return;
  }
  for(let d = 0; d < act.duration; d++){
    const s = slot + d;
    const key = `${act.classId}|${s}`;
    if(engine.offSlots.has(key)){
      console.log(`COLLISION: Act ${act.id} (${act.classId} ${act.mon}) is placed at slot ${s} which is in OFF SLOTS!`);
      collCount++;
    }
    if(engine.fixedSlots.has(key)){
      console.log(`COLLISION: Act ${act.id} (${act.classId} ${act.mon}) is placed at slot ${s} which is in FIXED SLOTS!`);
      collCount++;
    }
  }
});
console.log(`Total collisions: ${collCount}`);
