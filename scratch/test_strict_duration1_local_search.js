const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

let engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');

// Ensure all local search operations strictly require duration === 1 for all participating activities
engineCode = engineCode.replace(/if\(!act3 \|\| act3\.isFixed \|\| act3\.id === act1\.id \|\| act3\.id === act2\.id\) continue;/g, 'if(!act3 || act3.isFixed || act3.duration !== 1 || act3.id === act1.id || act3.id === act2.id) continue;');

engineCode = engineCode.replace(/if\(!act2 \|\| act2\.isFixed\) continue;/g, 'if(!act2 || act2.isFixed || act2.duration !== 1) continue;');

engineCode = engineCode.replace(/if\(!act1 \|\| act1\.isFixed\) continue;/g, 'if(!act1 || act1.isFixed || act1.duration !== 1) continue;');

// In solve(): only run safe local search if all placed
eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;
const engine = new FetTimetableEngine(schoolData);

console.log("Running solve() with strict duration === 1 protection...");
const t0 = Date.now();
const res = engine.solve();
const t1 = Date.now();

console.log(`Solve finished in ${t1 - t0}ms:`, res);

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
  console.log("SUCCESS: 100% OF 2193 LESSONS PLACED PERFECTLY ACROSS ALL 75 CLASSES!");
}

console.log("\nLesson Block Violations:", engine.evaluateLessonBlockViolations());
