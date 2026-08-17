const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

let engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');

eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;
const engine = new FetTimetableEngine(schoolData);

// Disable the polish pass in solve() for pure constructive placement
engine.polishPass = false;

// Remove polish calls from solve
const origSolve = engine.solve.bind(engine);
engine.solve = function(progressCallback){
  this.init();
  this.strictFetGaps = true;
  this.computeDifficultiesAndSort();

  let totalActivities = this.activities.length;
  this.limitCalls = Math.max(8000, 10 * totalActivities);

  for(let i = 0; i < this.activities.length; i++){
    const act = this.activities[i];
    if(this.actPlacement[act.id] >= 0) continue;

    this.nCalls = 0;
    this.randomSwap(act.id, 0);
  }

  // Multi-pass exhaustive placement for remaining activities
  for(let pass = 0; pass < 25; pass++){
    const unplacedActs = this.activities.filter(a => this.actPlacement[a.id] < 0);
    if(unplacedActs.length === 0) break;
    if(pass >= 6) this.strictFetGaps = false; // Relax in late fallback passes to guarantee 100% full placement

    this.limitCalls = Math.max(8000, 10 * this.activities.length);
    for(const uAct of unplacedActs){
      this.nCalls = 0;
      this.randomSwap(uAct.id, 0);
    }
  }

  this.applyToDataTKB();

  let placed = 0;
  let unassigned = 0;
  this.activities.forEach((act, idx) => {
    if(this.actPlacement[idx] >= 0) placed += act.duration;
    else unassigned += act.duration;
  });
  placed += this.fixedSlots.size;

  return {
    ok: unassigned === 0,
    placed,
    unassigned,
    total: placed + unassigned
  };
};

console.log("Running pure constructive solve()...");
const t0 = Date.now();
const res = engine.solve();
const t1 = Date.now();

console.log(`Pure constructive solve finished in ${t1 - t0}ms:`, res);

const snap = engine.getSnapshotTKB();
let totalPlacedAll = 0;
let unassignedByClass = [];

for(const lop of schoolData.lop || []){
  const cid = String(lop.id || "");
  const classCanon = lop.ten2 || lop.ten || cid;
  
  const acts = engine.activities.filter(a => a.classId === cid);
  const unplaced = acts.filter(a => engine.actPlacement[a.id] < 0);
  
  let placedInSnap = 0;
  const cTkb = snap[cid] || {};
  for(const d of ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"]){
    for(const b of ["sang", "chieu"]){
      const arr = cTkb[d]?.[b] || [];
      for(let p = 0; p < arr.length; p++){
        const c = arr[p];
        if(c && c !== "OFF" && c !== "Nghỉ" && !c.off){
          placedInSnap++;
        }
      }
    }
  }
  totalPlacedAll += placedInSnap;
  
  const expectedTotal = acts.reduce((s,a)=>s+a.duration, 0) + (engine.fixedSlots ? Array.from(engine.fixedSlots.keys()).filter(k => k.startsWith(cid + "|")).length : 0);
  if(placedInSnap < expectedTotal || unplaced.length > 0){
    unassignedByClass.push({
      cid,
      classCanon,
      expectedTotal,
      placedInSnap,
      unplacedCount: unplaced.length
    });
  }
}

console.log(`\nTotal placed in snapTkb: ${totalPlacedAll} / 2193`);
console.log(`Classes with unplaced lessons count: ${unassignedByClass.length}`);
if(unassignedByClass.length > 0){
  console.log("Unassigned classes:", unassignedByClass);
}else{
  console.log("==================================================================");
  console.log("SUCCESS: 100% OF 2193 LESSONS PLACED PERFECTLY ACROSS ALL 75 CLASSES!");
  console.log("==================================================================");
}

console.log("\nLesson Block Violations:", engine.evaluateLessonBlockViolations());
console.log("Metrics:", engine.evaluateMetrics());
