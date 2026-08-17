const fs = require('fs');

let engineCode = fs.readFileSync('scratch/test_fet_pair_first.js', 'utf8');

// Disable decompSingles in solve()
const oldDecomp = `      const decompSingles = [];
      const initialActCount = this.activities.length;
      for(let i = 0; i < initialActCount; i++){
        const act = this.activities[i];
        if(this.actPlacement[act.id] < 0 && act.duration >= 2){
          act.duration = 1;
          const extraSingle = {
            id: this.activities.length,
            classId: act.classId,
            classCanon: act.classCanon,
            lop: act.lop,
            mon: act.mon,
            canonKey: sCanon,
            gv: act.gv,
            room: act.room,
            duration: 1,
            isFixed: false,
            fixedSlot: -1,
            nIncompatible: act.nIncompatible
          };
          this.activities.push(extraSingle);
          this.actPlacement.push(-1);
          decompSingles.push(act);
          decompSingles.push(extraSingle);
        }
      }`;

const newDecomp = `      // Keep 2-period blocks intact!`;

engineCode = engineCode.replace(oldDecomp, newDecomp);
eval(engineCode.split('const artifactPath')[0]);

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const FetTimetableEngine = globalThis.FetTimetableEngine;
const engine = new FetTimetableEngine(schoolData);

console.log("Calling solve() without decomposing blocks...");
const t0 = Date.now();
const res = engine.solve();
const t1 = Date.now();

console.log(`Solve finished in ${t1 - t0}ms:`, res);
console.log("Lesson Block Violations:", engine.evaluateLessonBlockViolations());
console.log("Metrics:", engine.evaluateMetrics());
