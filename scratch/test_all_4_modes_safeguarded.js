const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

let engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');

// 1. In tryCrushTeacherGaps:
engineCode = engineCode.replace(/const act1 = this\.activities\[srcItem\.actId\];\s+if\(!act1 \|\| act1\.isFixed\) continue;/g, `const act1 = this.activities[srcItem.actId];\n                if(!act1 || act1.isFixed || act1.duration !== 1) continue;`);

engineCode = engineCode.replace(/const act2 = this\.activities\[actId2\];\s+if\(!act2 \|\| act2\.isFixed\) continue;/g, `const act2 = this.activities[actId2];\n                  if(!act2 || act2.isFixed || act2.duration !== 1) continue;`);

engineCode = engineCode.replace(/const act3 = this\.activities\[actId3\];\s+if\(!act3 \|\| act3\.isFixed \|\| act3\.id === act1\.id \|\| act3\.id === act2\.id\) continue;/g, `const act3 = this.activities[actId3];\n                      if(!act3 || act3.isFixed || act3.duration !== 1 || act3.id === act1.id || act3.id === act2.id) continue;`);

// 2. In tryConsolidateTeacherSingletons:
engineCode = engineCode.replace(/const act1 = this\.activities\[singleItem\.actId\];\s+if\(!act1 \|\| act1\.isFixed\) continue;/g, `const act1 = this.activities[singleItem.actId];\n                if(!act1 || act1.isFixed || act1.duration !== 1) continue;`);

engineCode = engineCode.replace(/const act2 = this\.activities\[actId2\];\s+if\(!act2 \|\| act2\.isFixed \|\| act2\.id === act1\.id\) continue;/g, `const act2 = this.activities[actId2];\n                  if(!act2 || act2.isFixed || act2.duration !== 1 || act2.id === act1.id) continue;`);

// 3. In tryReinforceTeacherSingletons:
engineCode = engineCode.replace(/const act2 = this\.activities\[richItem\.actId\];\s+if\(!act2 \|\| act2\.isFixed\) continue;/g, `const act2 = this.activities[richItem.actId];\n              if(!act2 || act2.isFixed || act2.duration !== 1) continue;`);

// 4. In optimize main loop:
engineCode = engineCode.replace(/if\(!act2 \|\| act2\.isFixed \|\| act2\.id === act1\.id\) continue;/g, 'if(!act2 || act2.isFixed || act1.duration !== 1 || act2.duration !== 1 || act2.id === act1.id || !this.isLessonBlockSafe(act1, act2)) continue;');

// 5. In obliterateAllTeacherSingletons:
engineCode = engineCode.replace(/const act1 = this\.activities\[single\.item\.actId\];\s+if\(!act1 \|\| act1\.isFixed\) continue;/g, `const act1 = this.activities[single.item.actId];\n            if(!act1 || act1.isFixed || act1.duration !== 1) continue;`);

engineCode = engineCode.replace(/const act2 = this\.activities\[actId2\];\s+if\(!act2 \|\| act2\.isFixed \|\| act2\.id === act1\.id\) continue;/g, `const act2 = this.activities[actId2];\n                if(!act2 || act2.isFixed || act2.duration !== 1 || act2.id === act1.id || !this.isLessonBlockSafe(act1, act2)) continue;`);

eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;

async function testAll4(){
  // 1. Solve initial schedule
  const solver = new FetTimetableEngine(schoolData);
  solver.solve();
  const initTkb = solver.getSnapshotTKB();

  for(const mode of ["optimize_singletons", "optimize_gap2", "optimize_gap1", "optimize_sessions"]){
    console.log(`\n==============================================`);
    console.log(`TESTING OPTIMIZER MODE: ${mode}`);
    console.log(`==============================================`);
    
    schoolData.tkb = JSON.parse(JSON.stringify(initTkb));
    const opt = new FetTimetableEngine(schoolData);
    opt.loadExistingSchedule();

    const t0 = Date.now();
    const res = await opt.optimize(mode);
    const t1 = Date.now();

    console.log(`Mode ${mode} finished in ${t1 - t0}ms:`, res);
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
    console.log(`Placed count: ${placedCount} / 2193 (Must be 2193)`);
  }
}

testAll4();
