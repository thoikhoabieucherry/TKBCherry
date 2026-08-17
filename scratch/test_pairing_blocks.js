const fs = require('fs');
const path = require('path');

let engineCode = fs.readFileSync(path.join(__dirname, '../web/pages/tkb-fet-engine.js'), 'utf8');

eval(engineCode);

const artifactPath = 'C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json';
const schoolData = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

const FetTimetableEngine = globalThis.FetTimetableEngine;
const engine = new FetTimetableEngine(schoolData);

console.log("Calling solve()...");
engine.solve();
engine.initSubjectConstraints();

console.log("Violations before pairing:", engine.evaluateLessonBlockViolations());

// Now let's implement ensureAllLessonBlocksMin
function ensureAllLessonBlocksMin(eng){
  if(!eng.classSubjectLessonBlocks || eng.classSubjectLessonBlocks.size === 0) return;

  for(const [key, req] of eng.classSubjectLessonBlocks.entries()){
    const { cid, sCanon, len, min } = req;
    const cGrid = eng.classGrid.get(cid);
    if(!cGrid) continue;

    // Check current blocks
    let currentViolations = eng.checkLessonBlockDelta(cid, sCanon);
    if(currentViolations === 0) continue;

    // Find all acts of this subject in this class
    const subjActIds = [];
    for(let s = 0; s < 60; s++){
      const actId = cGrid[s];
      if(actId >= 0){
        const act = eng.activities[actId];
        if(act && (act.canonKey === sCanon || eng.getCanonMonKey(act.mon) === sCanon)){
          subjActIds.push({ actId, slot: s });
        }
      }
    }

    if(subjActIds.length < len) continue;

    // Try to pair acts into consecutive slots in one of the sessions where an act already exists
    for(const baseItem of subjActIds){
      if(eng.checkLessonBlockDelta(cid, sCanon) === 0) break;

      const baseSlot = eng.actPlacement[baseItem.actId];
      if(baseSlot < 0) continue;
      const baseDetails = eng.constructor ? null : null;
      const d = Math.floor(baseSlot / 10);
      const b = Math.floor((baseSlot % 10) / 5);
      const p = (baseSlot % 10) % 5;
      const sStart = d * 10 + b * 5;

      // Candidate adjacent period in same session
      const adjPeriods = [];
      if(p > 0) adjPeriods.push(p - 1);
      if(p < 4) adjPeriods.push(p + 1);

      for(const targetP of adjPeriods){
        if(eng.checkLessonBlockDelta(cid, sCanon) === 0) break;

        const targetSlot = sStart + targetP;
        const targetActId = cGrid[targetSlot];
        if(targetActId === -2 || targetActId === -3) continue; // OFF or FIXED

        // Find another act of same subject from a DIFFERENT session
        for(const donorItem of subjActIds){
          if(donorItem.actId === baseItem.actId) continue;
          const donorSlot = eng.actPlacement[donorItem.actId];
          if(donorSlot < 0) continue;
          const donorD = Math.floor(donorSlot / 10);
          const donorB = Math.floor((donorSlot % 10) / 5);
          if(donorD === d && donorB === b) continue; // already in same session

          const donorAct = eng.activities[donorItem.actId];
          if(!donorAct || donorAct.isFixed) continue;

          if(targetActId < 0){
            // Target slot is empty
            eng.unplaceActivity(donorItem.actId);
            const res = eng.getConflictsForSlot(donorAct, targetSlot);
            if(res.possible && res.conflicts.length === 0){
              eng.placeActivityDirect(donorItem.actId, targetSlot);
              if(eng.checkLessonBlockDelta(cid, sCanon) < currentViolations){
                currentViolations = eng.checkLessonBlockDelta(cid, sCanon);
                break;
              }
              eng.unplaceActivity(donorItem.actId);
              eng.placeActivityDirect(donorItem.actId, donorSlot);
            }else{
              eng.placeActivityDirect(donorItem.actId, donorSlot);
            }
          }else{
            // Target slot has another activity -> Swap donorAct with targetAct
            const targetAct = eng.activities[targetActId];
            if(!targetAct || targetAct.isFixed) continue;

            eng.unplaceActivity(donorItem.actId);
            eng.unplaceActivity(targetActId);

            const res1 = eng.getConflictsForSlot(donorAct, targetSlot);
            const res2 = eng.getConflictsForSlot(targetAct, donorSlot);

            if(res1.possible && res1.conflicts.length === 0 && res2.possible && res2.conflicts.length === 0){
              eng.placeActivityDirect(donorItem.actId, targetSlot);
              eng.placeActivityDirect(targetActId, donorSlot);

              if(eng.checkLessonBlockDelta(cid, sCanon) < currentViolations){
                currentViolations = eng.checkLessonBlockDelta(cid, sCanon);
                break;
              }
              eng.unplaceActivity(donorItem.actId);
              eng.unplaceActivity(targetActId);
              eng.placeActivityDirect(donorItem.actId, donorSlot);
              eng.placeActivityDirect(targetActId, targetSlot);
            }else{
              eng.placeActivityDirect(donorItem.actId, donorSlot);
              eng.placeActivityDirect(targetActId, targetSlot);
            }
          }
        }
      }
    }
  }
}

ensureAllLessonBlocksMin(engine);
console.log("Violations after pairing:", engine.evaluateLessonBlockViolations());
