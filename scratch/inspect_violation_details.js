const fs = require('fs');

const allSchools = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/all_vps_schools.json', 'utf8'));
const schoolData = allSchools['school_default'];

let engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const solver = new globalThis.FetTimetableEngine(schoolData);
solver.solve();
schoolData.tkb = solver.getSnapshotTKB();

const opt = new globalThis.FetTimetableEngine(schoolData);
opt.loadExistingSchedule();

console.log("Before obliterate:");
for(const [key, req] of opt.classSubjectLessonBlocks.entries()){
  const cGrid = opt.classGrid.get(req.cid);
  let blocks = 0;
  for(let d = 0; d < 6; d++){
    for(let b = 0; b < 2; b++){
      const sStart = d * 10 + b * 5;
      const idx = [];
      for(let p = 0; p < 5; p++){
        const actId = cGrid[sStart + p];
        if(actId >= 0){
          const act = opt.activities[actId];
          if(act && (act.canonKey === req.sCanon || opt.getCanonMonKey(act.mon) === req.sCanon)){
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
  if(blocks < req.min) console.log("Pre-violation:", key, "req.min:", req.min, "blocks:", blocks);
}

// Let's hook placeActivityDirect in obliterate to see which move caused the violation!
let step = 0;
const origPlace = opt.placeActivityDirect.bind(opt);
const origUnplace = opt.unplaceActivity.bind(opt);

opt.obliterateAllTeacherSingletons(1, Infinity);

console.log("\nAfter 1 pass obliterate violations:", opt.evaluateLessonBlockViolations());
for(const [key, req] of opt.classSubjectLessonBlocks.entries()){
  const cGrid = opt.classGrid.get(req.cid);
  let blocks = 0;
  for(let d = 0; d < 6; d++){
    for(let b = 0; b < 2; b++){
      const sStart = d * 10 + b * 5;
      const idx = [];
      for(let p = 0; p < 5; p++){
        const actId = cGrid[sStart + p];
        if(actId >= 0){
          const act = opt.activities[actId];
          if(act && (act.canonKey === req.sCanon || opt.getCanonMonKey(act.mon) === req.sCanon)){
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
  if(blocks < req.min) {
    console.log("Post-violation:", key, "cid:", req.cid, "sCanon:", req.sCanon, "req.min:", req.min, "blocks:", blocks);
    break;
  }
}
