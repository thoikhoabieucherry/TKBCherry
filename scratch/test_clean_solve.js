const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

let engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');

// In solve(): only run safe intra-session permutations for polish
const oldPolishBlock = `        // 4. Compact 1-period gaps
        for(let r = 0; r < 5; r++){
          const resGap1 = this.tryCrushTeacherGaps(polishMetrics, initialPolishMetrics, "optimize_gap1");
          if(resGap1) polishMetrics = { ...resGap1 };
          else break;
        }

        // 5. Consolidate isolated 1-period sessions
        for(let r = 0; r < 3; r++){
          const resSingle = this.tryConsolidateTeacherSingletons(polishMetrics, initialPolishMetrics);
          if(resSingle) polishMetrics = { ...resSingle };
          else break;
        }`;

const newPolishBlock = `        // Keep initial solve rock solid and fast`;

engineCode = engineCode.replace(oldPolishBlock, newPolishBlock);

eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;
const engine = new FetTimetableEngine(schoolData);

console.log("Running clean solve()...");
const t0 = Date.now();
const res = engine.solve();
const t1 = Date.now();

console.log(`Clean solve finished in ${t1 - t0}ms:`, res);

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

console.log("\nViolations:", engine.evaluateLessonBlockViolations());
