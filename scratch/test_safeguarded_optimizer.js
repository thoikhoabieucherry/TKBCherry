const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

let engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');

// In optimize loop: ensure act1 and act2 duration === 1 and isLessonBlockSafe
engineCode = engineCode.replace(/if\(!act2 \|\| act2\.isFixed \|\| act2\.id === act1\.id\) continue;/g, 'if(!act2 || act2.isFixed || act1.duration !== 1 || act2.duration !== 1 || act2.id === act1.id || !this.isLessonBlockSafe(act1, act2)) continue;');

// In 1-hop ejection chain inside optimize: check cAct duration === 1
engineCode = engineCode.replace(/if\(cAct && !cAct\.isFixed && cAct\.classId !== act1\.classId\){/g, 'if(cAct && !cAct.isFixed && cAct.duration === 1 && cAct.classId !== act1.classId && this.isLessonBlockSafe(act1, act2, cAct)){');

// In tryConsolidateTeacherSingletons, tryVacateTeacherSession, tryVacateTeacherDay, tryCrushTeacherGaps:
// add duration === 1 and isLessonBlockSafe checks
engineCode = engineCode.replace(/if\(!act2 \|\| act2\.isFixed\) continue;/g, 'if(!act2 || act2.isFixed || act2.duration !== 1) continue;');

engineCode = engineCode.replace(/if\(!act1 \|\| act1\.isFixed\) continue;/g, 'if(!act1 || act1.isFixed || act1.duration !== 1) continue;');

eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;

// 1. Solve initial schedule
const solver = new FetTimetableEngine(schoolData);
solver.solve();
schoolData.tkb = solver.getSnapshotTKB();

console.log("Initial schedule lesson block violations:", solver.evaluateLessonBlockViolations());
console.log("Initial schedule metrics:", solver.evaluateMetrics());

// 2. Load schedule in optimizer
const optimizer = new FetTimetableEngine(schoolData);
optimizer.loadExistingSchedule();

console.log("Loaded activities count:", optimizer.activities.length);
const dur2Acts = optimizer.activities.filter(a => a.duration === 2);
console.log("Duration 2 activities in loaded schedule:", dur2Acts.length);

// 3. Run optimizer
console.log("\nRunning optimizer.optimize('optimize_singletons')...");
const t0 = Date.now();
optimizer.optimize('optimize_singletons').then(res => {
  const t1 = Date.now();
  console.log(`Optimize finished in ${t1 - t0}ms:`, res);
  console.log("Post-optimize lesson block violations:", optimizer.evaluateLessonBlockViolations());
  console.log("Post-optimize metrics:", optimizer.evaluateMetrics());
  
  // Verify snapTkb
  const snap = optimizer.getSnapshotTKB();
  let placedCount = 0;
  for(const cid of Object.keys(snap)){
    const cTkb = snap[cid] || {};
    for(const d of ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"]){
      for(const b of ["sang", "chieu"]){
        const arr = cTkb[d]?.[b] || [];
        for(let p = 0; p < arr.length; p++){
          const c = arr[p];
          if(c && c !== "OFF" && c !== "Nghỉ" && !c.off) placedCount++;
        }
      }
    }
  }
  console.log(`Placed in snapTkb after optimize: ${placedCount} / 2193`);
});
