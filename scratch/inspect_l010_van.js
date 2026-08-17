const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const engine = new FetTimetableEngine(schoolData);
engine.init();

const actsL010Van = engine.activities.filter(a => a.classId === 'L010' && engine.getCanonMonKey(a.mon) === 'van');
console.log("Initial activities for L010 Văn:", actsL010Van);

// Check if L010 has any fixed Văn cells
for(let s = 0; s < 60; s++){
  const fix = engine.fixedSlots.get(`L010|${s}`);
  if(fix){
    console.log(`Fixed slot ${s}:`, fix);
  }
}
