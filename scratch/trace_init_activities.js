const fs = require('fs');
const path = require('path');

const engineCode = fs.readFileSync(path.join(__dirname, '../web/pages/tkb-fet-engine.js'), 'utf8');

eval(engineCode);

const artifactPath = 'C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json';
const schoolData = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

const FetTimetableEngine = globalThis.FetTimetableEngine;
const engine = new FetTimetableEngine(schoolData);

engine.initSubjectConstraints();
engine.init();

console.log("Total activities generated:", engine.activities.length);
const dur2Count = engine.activities.filter(a => a.duration === 2).length;
console.log("Activities with duration === 2:", dur2Count);

// Let's see which subjects have duration 2
const dur2Subjs = new Map();
engine.activities.filter(a => a.duration === 2).forEach(a => {
  dur2Subjs.set(a.mon, (dur2Subjs.get(a.mon) || 0) + 1);
});
console.log("Duration 2 by subject:", dur2Subjs);
