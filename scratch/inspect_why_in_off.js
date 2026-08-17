const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const engine = new FetTimetableEngine(schoolData);

// Monkey patch randomSwap to see when an act is placed in an off slot
const origPlace = engine.placeActivityDirect.bind(engine);
engine.placeActivityDirect = function(actId, slot){
  const act = this.activities[actId];
  if(act){
    for(let d = 0; d < act.duration; d++){
      const s = slot + d;
      if(this.offSlots.has(`${act.classId}|${s}`)){
        console.error(`ERROR: placeActivityDirect called for act ${actId} (${act.classId} ${act.mon} dur=${act.duration}) into OFF slot ${s}!`);
        console.trace();
        process.exit(1);
      }
    }
  }
  origPlace(actId, slot);
};

engine.solve();
console.log("Passed with 0 off slot placements!");
