const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const engineCode = fs.readFileSync('scratch/test_fet_pair_first.js', 'utf8');
// evaluate it
eval(engineCode.split('const artifactPath')[0]);

const FetTimetableEngine = globalThis.FetTimetableEngine;
const engine = new FetTimetableEngine(schoolData);
engine.solve();

console.log("Checking class L001 lesson blocks:");
for(const [key, req] of engine.classSubjectLessonBlocks.entries()){
  if(req.cid === 'L001'){
    console.log(`Key: ${key}, req:`, req);
    // Print all slots of this subject in L001
    const cGrid = engine.classGrid.get('L001');
    const periodsBySession = [];
    for(let d = 0; d < 6; d++){
      for(let b = 0; b < 2; b++){
        const sStart = d * 10 + b * 5;
        const subSlots = [];
        for(let p = 0; p < 5; p++){
          const actId = cGrid[sStart + p];
          if(actId >= 0){
            const a = engine.activities[actId];
            if(a && engine.getCanonMonKey(a.mon) === req.sCanon){
              subSlots.push(p + 1);
            }
          }
        }
        if(subSlots.length > 0){
          periodsBySession.push({ day: d, buoi: b, periods: subSlots });
        }
      }
    }
    console.log("  Placed periods:", periodsBySession);
  }
}
