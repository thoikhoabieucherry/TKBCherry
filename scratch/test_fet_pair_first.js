const fs = require('fs');

let engineCode = fs.readFileSync('scratch/test_place_unplace_clean.js', 'utf8');

// In intra-session permutations (Polish pass step 3), protect duration !== 1 and lesson blocks
const oldPermute = `                  const act1 = this.activities[actId1];
                  const act2 = this.activities[actId2];
                  if(!act1 || !act2 || act1.isFixed || act2.isFixed) continue;`;

const newPermute = `                  const act1 = this.activities[actId1];
                  const act2 = this.activities[actId2];
                  if(!act1 || !act2 || act1.isFixed || act2.isFixed) continue;
                  if(act1.duration !== 1 || act2.duration !== 1) continue;
                  if(!this.isLessonBlockSafe(act1, act2)) continue;`;

engineCode = engineCode.replace(oldPermute, newPermute);

// Also add isLessonBlockSafe method to helperMethods
const safeMethod = `
    isLessonBlockSafe(...acts){
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
    }
`;

engineCode = engineCode.replace(
  `class FetTimetableEngine {`,
  `class FetTimetableEngine {\n${safeMethod}`
);

eval(engineCode.split('const schoolData')[0]);

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const FetTimetableEngine = globalThis.FetTimetableEngine;
const engine = new FetTimetableEngine(schoolData);

console.log("Calling solve() with protected blocks & pairs first...");
const t0 = Date.now();
const res = engine.solve();
const t1 = Date.now();

console.log(`Solve finished in ${t1 - t0}ms:`, res);
console.log("Lesson Block Violations:", engine.evaluateLessonBlockViolations());
console.log("Metrics:", engine.evaluateMetrics());
