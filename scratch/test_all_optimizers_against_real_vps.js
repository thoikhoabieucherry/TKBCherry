const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;

async function testAll(){
  console.log("1. Solving initial schedule from scratch...");
  const solver = new FetTimetableEngine(schoolData);
  const solveRes = solver.solve();
  console.log("Solve result:", solveRes);

  const initTkb = solver.getSnapshotTKB();
  console.log("Initial lesson block violations:", solver.evaluateLessonBlockViolations());
  console.log("Initial metrics:", solver.evaluateMetrics());

  for(const mode of ["optimize_singletons", "optimize_gap2", "optimize_gap1", "optimize_sessions"]){
    console.log(`\n======================================================`);
    console.log(`TESTING OPTIMIZER: ${mode}`);
    console.log(`======================================================`);
    
    schoolData.tkb = JSON.parse(JSON.stringify(initTkb));
    const opt = new FetTimetableEngine(schoolData);
    
    const t0 = Date.now();
    const res = await opt.optimize(mode);
    const t1 = Date.now();

    console.log(`Mode [${mode}] completed in ${t1 - t0}ms:`, res);
    const violations = opt.evaluateLessonBlockViolations();
    console.log(`Lesson Block Violations: ${violations} (Must be 0)`);
    
    const snap = opt.getSnapshotTKB();
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
    console.log(`Total placed count in snapshot: ${placedCount} / 2193`);
    if(violations === 0 && placedCount === 2193){
      console.log(`>>> SUCCESS FOR [${mode}]! <<<`);
    }else{
      console.error(`>>> FAILED FOR [${mode}]! <<<`);
      process.exit(1);
    }
  }

  console.log("\n======================================================");
  console.log("ALL 4 OPTIMIZATION MODES PASSED WITH ZERO VIOLATIONS!");
  console.log("======================================================");
}

testAll();
