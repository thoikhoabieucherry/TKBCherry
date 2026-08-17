const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const engine = new FetTimetableEngine(schoolData);
engine.init();

console.log("Act 232:", engine.activities[232]);
console.log("Is L017|5 in offSlots?", engine.offSlots.has("L017|5"));
console.log("Is L017|5 in fixedSlots?", engine.fixedSlots.has("L017|5"));

const res = engine.getConflictsForSlot(engine.activities[232], 5);
console.log("getConflictsForSlot(act232, 5):", res);
