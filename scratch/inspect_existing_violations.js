const fs = require('fs');
const path = require('path');

const engineCode = fs.readFileSync(path.join(__dirname, '../web/pages/tkb-fet-engine.js'), 'utf8');

eval(engineCode);

const artifactPath = 'C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json';
const schoolData = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

const FetTimetableEngine = globalThis.FetTimetableEngine;
const engine = new FetTimetableEngine(schoolData);
engine.loadExistingSchedule();

console.log("Existing schedule lesson block violations:", engine.evaluateLessonBlockViolations());

// Check each class and subject in existing schedule
for(const [key, req] of engine.classSubjectLessonBlocks.entries()){
  const cGrid = engine.classGrid.get(req.cid);
  let blocks = 0;
  for(let d = 0; d < 6; d++){
    for(let b = 0; b < 2; b++){
      const sStart = d * 10 + b * 5;
      const idx = [];
      for(let p = 0; p < 5; p++){
        const actId = cGrid[sStart + p];
        if(actId >= 0){
          const act = engine.activities[actId];
          if(act && (act.canonKey === req.sCanon || engine.getCanonMonKey(act.mon) === req.sCanon)){
            idx.push(p + 1);
          }
        }else if(actId === -3){
          const fix = engine.fixedSlots.get(`${req.cid}|${sStart + p}`);
          if(fix && fix.mon && engine.getCanonMonKey(fix.mon) === req.sCanon){
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
  if(blocks < req.min){
    console.log(`Violation in class ${req.cid}, subject ${req.sCanon}, req: ${req.min}, found: ${blocks}`);
  }
}
