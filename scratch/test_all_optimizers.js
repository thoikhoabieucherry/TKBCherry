const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

let engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');

// Apply the updates
const oldSafe = `    isLessonBlockSafe(...acts){
      if(!this.classSubjectLessonBlocks || this.classSubjectLessonBlocks.size === 0) return true;
      const checkedClasses = new Set();
      for(const act of acts){
        if(!act || !act.classId || checkedClasses.has(act.classId)) continue;
        checkedClasses.add(act.classId);

        const cid = act.classId;
        const cGrid = this.classGrid.get(cid);
        if(!cGrid) continue;

        for(const [key, req] of this.classSubjectLessonBlocks.entries()){
          if(req.cid !== cid && req.classCanon !== cid) continue;

          let blocks = 0;
          for(let d = 0; d < DAYS_LIST.length; d++){
            for(let b = 0; b < SESSIONS_LIST.length; b++){
              const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
              const idx = [];
              for(let p = 0; p < PERIODS_PER_SESSION; p++){
                const actId = cGrid[sStart + p];
                if(actId >= 0){
                  const a = this.activities[actId];
                  if(a && (a.canonKey === req.sCanon || this.getCanonMonKey(a.mon) === req.sCanon)){
                    idx.push(p + 1);
                  }
                }else if(actId === -3){
                  const fix = this.fixedSlots.get(\`\${cid}|\${sStart + p}\`);
                  if(fix && fix.mon && this.getCanonMonKey(fix.mon) === req.sCanon){
                    idx.push(p + 1);
                  }
                }
              }
              if(idx.length >= req.len){
                const sSet = new Set(idx);
                for(const i of idx){
                  let ok = true;
                  for(let k = 0; k < req.len; k++){
                    if(!sSet.has(i + k)) ok = false;
                  }
                  if(ok && !sSet.has(i - 1)) blocks++;
                }
              }
            }
          }
          if(blocks < req.min) return false;
        }
      }
      return true;
    }`;

const newSafe = `    isLessonBlockSafe(...acts){
      if(!this.classSubjectLessonBlocks || this.classSubjectLessonBlocks.size === 0) return true;
      return this.evaluateLessonBlockViolations() === 0;
    }`;

engineCode = engineCode.replace(oldSafe, newSafe);

engineCode = engineCode.replace(/if\(!act2 \|\| act2\.isFixed \|\| act2\.id === act1\.id\) continue;/g, 'if(!act2 || act2.isFixed || act1.duration !== 1 || act2.duration !== 1 || act2.id === act1.id || !this.isLessonBlockSafe(act1, act2)) continue;');

engineCode = engineCode.replace(/if\(cAct && !cAct\.isFixed && cAct\.classId !== act1\.classId\){/g, 'if(cAct && !cAct.isFixed && cAct.duration === 1 && cAct.classId !== act1.classId && this.isLessonBlockSafe(act1, act2, cAct)){');

engineCode = engineCode.replace(/if\(!act2 \|\| act2\.isFixed\) continue;/g, 'if(!act2 || act2.isFixed || act2.duration !== 1) continue;');

engineCode = engineCode.replace(/if\(!act1 \|\| act1\.isFixed\) continue;/g, 'if(!act1 || act1.isFixed || act1.duration !== 1) continue;');

eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;

async function testAll(){
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

testAll();
