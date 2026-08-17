const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

let engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');

// 1. In PASS 2 (intra-session permutation): guard duration === 1 and isLessonBlockSafe
engineCode = engineCode.replace(/if\(!act1 \|\| !act2 \|\| act1\.isFixed \|\| act2\.isFixed\) continue;/g, 'if(!act1 || !act2 || act1.isFixed || act2.isFixed || act1.duration !== 1 || act2.duration !== 1 || !this.isLessonBlockSafe(act1, act2)) continue;');

// 2. In Direction 2 (optimize loop): guard duration === 1 and isLessonBlockSafe
engineCode = engineCode.replace(/if\(!dAct \|\| dAct\.isFixed\) continue;/g, 'if(!dAct || dAct.isFixed || dAct.duration !== 1) continue;');

engineCode = engineCode.replace(/if\(!otherAct \|\| otherAct\.isFixed \|\| otherAct\.id === dAct\.id\) continue;/g, 'if(!otherAct || otherAct.isFixed || otherAct.duration !== 1 || otherAct.id === dAct.id || !this.isLessonBlockSafe(dAct, otherAct)) continue;');

// 3. Disable destructive PASS 1 during gap2/gap1/singletons
engineCode = engineCode.replace(/if\(mode === "optimize_sessions"\){/g, 'if(false && mode === "optimize_sessions"){');

// 4. In tryCrushTeacherGaps: guard duration === 1
engineCode = engineCode.replace(/const act1 = this\.activities\[srcItem\.actId\];\s+if\(!act1 \|\| act1\.isFixed\) continue;/g, `const act1 = this.activities[srcItem.actId];\n                if(!act1 || act1.isFixed || act1.duration !== 1) continue;`);

engineCode = engineCode.replace(/const act2 = this\.activities\[actId2\];\s+if\(!act2 \|\| act2\.isFixed\) continue;/g, `const act2 = this.activities[actId2];\n                  if(!act2 || act2.isFixed || act2.duration !== 1 || !this.isLessonBlockSafe(act1, act2)) continue;`);

engineCode = engineCode.replace(/const act3 = this\.activities\[actId3\];\s+if\(!act3 \|\| act3\.isFixed \|\| act3\.id === act1\.id \|\| act3\.id === act2\.id\) continue;/g, `const act3 = this.activities[actId3];\n                      if(!act3 || act3.isFixed || act3.duration !== 1 || act3.id === act1.id || act3.id === act2.id || !this.isLessonBlockSafe(act1, act2, act3)) continue;`);

// Remove LNS randomSwap branch in tryCrushTeacherGaps
engineCode = engineCode.replace(/\/\/ 3\. Try LNS Displacement for act2[\s\S]*?\/\/ Backtrack/g, '// Backtrack');

// 5. In obliterateAllTeacherSingletons: remove randomSwap and guard duration === 1
engineCode = engineCode.replace(/const act1 = this\.activities\[single\.item\.actId\];\s+if\(!act1 \|\| act1\.isFixed\) continue;/g, `const act1 = this.activities[single.item.actId];\n            if(!act1 || act1.isFixed || act1.duration !== 1) continue;`);

engineCode = engineCode.replace(/const act2 = this\.activities\[actId2\];\s+if\(!act2 \|\| act2\.isFixed \|\| act2\.id === act1\.id\) continue;/g, `const act2 = this.activities[actId2];\n                if(!act2 || act2.isFixed || act2.duration !== 1 || act2.id === act1.id || !this.isLessonBlockSafe(act1, act2)) continue;`);

engineCode = engineCode.replace(/\/\/ 2\. Try LNS recursive displacement[\s\S]*?\/\/ Backtrack/g, '// Backtrack');

eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;

async function testAllSafe(){
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

testAllSafe();
