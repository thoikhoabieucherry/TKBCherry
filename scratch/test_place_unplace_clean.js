const fs = require('fs');

let engineCode = fs.readFileSync('scratch/test_no_decomp.js', 'utf8');

// In placeActivityDirect, ensure old slot is unplaced if act was placed
const oldPlace = `    placeActivityDirect(actId, slot){
      const act = this.activities[actId];
      if(!act) return;
      this.actPlacement[actId] = slot;`;

const newPlace = `    placeActivityDirect(actId, slot){
      const act = this.activities[actId];
      if(!act) return;
      if(this.actPlacement[actId] >= 0 && this.actPlacement[actId] !== slot){
        this.unplaceActivity(actId);
      }
      this.actPlacement[actId] = slot;`;

engineCode = engineCode.replace(oldPlace, newPlace);

eval(engineCode.split('const schoolData')[0]);

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const FetTimetableEngine = globalThis.FetTimetableEngine;
const engine = new FetTimetableEngine(schoolData);

console.log("Calling solve() with clean place/unplace...");
const t0 = Date.now();
const res = engine.solve();
const t1 = Date.now();

console.log(`Solve finished in ${t1 - t0}ms:`, res);
console.log("Lesson Block Violations:", engine.evaluateLessonBlockViolations());
console.log("Metrics:", engine.evaluateMetrics());
