const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const engine = new FetTimetableEngine(schoolData);

// Add grid integrity checks to placeActivityDirect
const origPlace = engine.placeActivityDirect.bind(engine);
engine.placeActivityDirect = function(actId, slot){
  const act = this.activities[actId];
  if(act){
    const grid = this.classGrid.get(act.classId);
    for(let d = 0; d < act.duration; d++){
      const s = slot + d;
      if(this.offSlots.has(`${act.classId}|${s}`)){
        console.error(`ERROR: Placing act ${actId} (${act.classId} ${act.mon}) into OFF slot ${s}!`);
        console.trace();
        process.exit(1);
      }
      if(this.fixedSlots.has(`${act.classId}|${s}`)){
        console.error(`ERROR: Placing act ${actId} (${act.classId} ${act.mon}) into FIXED slot ${s}!`);
        console.trace();
        process.exit(1);
      }
    }
  }
  origPlace(actId, slot);
};

console.log("Running solve() with integrity check...");
engine.solve();
console.log("Integrity check passed with 0 off/fixed collisions!");
