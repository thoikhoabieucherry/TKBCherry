const fs = require('fs');

const allSchools = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/all_vps_schools.json', 'utf8'));
const schoolData = allSchools['school_default'];

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;

const solver = new FetTimetableEngine(schoolData);
solver.solve();
schoolData.tkb = solver.getSnapshotTKB();

const opt = new FetTimetableEngine(schoolData);
opt.loadExistingSchedule();

// Step 1: Initial Crusher
opt.obliterateAllTeacherSingletons(20, Infinity);
opt.tryConsolidateTeacherSingletons(opt.evaluateMetrics(), opt.evaluateMetrics(), Infinity);
opt.tryReinforceTeacherSingletons(opt.evaluateMetrics(), opt.evaluateMetrics(), Infinity);

console.log("After initial crusher:", opt.evaluateMetrics());

// Step 2: Ruin & Recreate LNS on classes with singletons
function lnsRuinRecreateSingletons(engine, maxIterations = 30){
  const DAYS = 6;
  const SESSIONS = 2;
  const PERIODS = 5;
  let bestM = engine.evaluateMetrics();

  for(let iter = 0; iter < maxIterations; iter++){
    if(bestM.soBuoiDay1 <= 2) break;

    // Find all classes that contain a teacher singleton
    const classesWithSingletons = new Set();
    for(const [gv, grid] of engine.teacherGrid.entries()){
      for(let d = 0; d < DAYS; d++){
        for(let b = 0; b < SESSIONS; b++){
          const sStart = d * 10 + b * 5;
          const taught = [];
          for(let p = 0; p < PERIODS; p++){
            const s = sStart + p;
            if(grid[s] >= 0 || grid[s] === -3){
              taught.push({ p, slot: s, actId: grid[s] });
            }
          }
          if(taught.length === 1 && taught[0].actId >= 0){
            const act = engine.activities[taught[0].actId];
            if(act && act.classId) classesWithSingletons.add(act.classId);
          }
        }
      }
    }

    if(classesWithSingletons.size === 0) break;

    const classArray = Array.from(classesWithSingletons);
    engine.rng.shuffle(classArray);

    // Pick 2-4 coupled classes
    const targetClasses = classArray.slice(0, Math.min(3, classArray.length));

    // Save snapshot
    const snapPlacement = engine.actPlacement.slice();
    const snapClassGrid = new Map();
    engine.classGrid.forEach((arr, cid) => snapClassGrid.set(cid, arr.slice()));
    const snapTeacherGrid = new Map();
    engine.teacherGrid.forEach((arr, gv) => snapTeacherGrid.set(gv, arr.slice()));
    const snapRoomGrid = new Map();
    engine.roomGrid.forEach((arr, rm) => snapRoomGrid.set(rm, arr.slice()));

    // Ruin: unplace all duration=1 activities in targetClasses
    const unplacedActs = [];
    for(const cid of targetClasses){
      for(let s = 0; s < 60; s++){
        const cArr = engine.classGrid.get(cid);
        const actId = cArr[s];
        if(actId >= 0){
          const act = engine.activities[actId];
          if(act && !act.isFixed && act.duration === 1){
            engine.unplaceActivity(act.id);
            unplacedActs.push(act);
          }
        }
      }
    }

    // Recreate: sort unplaced activities and reassign them prioritizing sessions where teacher already teaches
    engine.rng.shuffle(unplacedActs);

    function solveRecreate(idx){
      if(idx >= unplacedActs.length){
        return engine.isLessonBlockSafe(...unplacedActs);
      }
      const act = unplacedActs[idx];
      const tGrid = engine.teacherGrid.get(act.gv);
      const cGrid = engine.classGrid.get(act.classId);

      // Score slots for this activity: prefer slots in sessions where teacher already teaches >= 1 periods
      const candidateSlots = [];
      for(let s = 0; s < 60; s++){
        if(engine.offSlots.has(`${act.classId}|${s}`)) continue;
        if(cGrid[s] !== -1) continue; // must be empty

        const r = engine.getConflictsForSlot(act, s);
        if(r.possible && r.conflicts.length === 0){
          const sess = Math.floor(s / 5);
          let teacherLoadInSess = 0;
          for(let p = 0; p < 5; p++){
            const ss = sess * 5 + p;
            if(tGrid && (tGrid[ss] >= 0 || tGrid[ss] === -3)) teacherLoadInSess++;
          }
          // Higher score is better (we want teacherLoadInSess >= 1)
          candidateSlots.push({ slot: s, score: teacherLoadInSess });
        }
      }

      candidateSlots.sort((a, b) => b.score - a.score);

      for(const cand of candidateSlots){
        engine.placeActivityDirect(act.id, cand.slot);
        if(solveRecreate(idx + 1)) return true;
        engine.unplaceActivity(act.id);
      }
      return false;
    }

    const success = solveRecreate(0);
    if(success){
      const newM = engine.evaluateMetrics();
      if(newM.soBuoiDay1 < bestM.soBuoiDay1){
        bestM = { ...newM };
        console.log(`[LNS Success] Singletons -> ${bestM.soBuoiDay1}, Sessions -> ${bestM.tsBuoiDay}`);
      }else{
        // Restore
        engine.actPlacement = snapPlacement;
        engine.classGrid = snapClassGrid;
        engine.teacherGrid = snapTeacherGrid;
        engine.roomGrid = snapRoomGrid;
      }
    }else{
      // Restore
      engine.actPlacement = snapPlacement;
      engine.classGrid = snapClassGrid;
      engine.teacherGrid = snapTeacherGrid;
      engine.roomGrid = snapRoomGrid;
    }
  }

  return bestM;
}

lnsRuinRecreateSingletons(opt, 50);
console.log("After LNS:", opt.evaluateMetrics());
