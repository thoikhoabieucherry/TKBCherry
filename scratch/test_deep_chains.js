const fs = require('fs');
const path = require('path');
const vm = require('vm');

const mockElement = {
  appendChild: () => {},
  removeChild: () => {},
  style: {},
  setAttribute: () => {},
  getAttribute: () => '',
  classList: { add: () => {}, remove: () => {}, contains: () => false },
};

const windowObj = {
  console: console,
  Math: Math,
  Date: Date,
  Set: Set,
  Map: Map,
  Array: Array,
  Object: Object,
  parseInt: parseInt,
  parseFloat: parseFloat,
  isNaN: isNaN,
  isFinite: isFinite,
  String: String,
  Number: Number,
  Boolean: Boolean,
  RegExp: RegExp,
  JSON: JSON,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  document: {
    createElement: () => mockElement,
    head: mockElement,
    body: mockElement,
    getElementById: () => mockElement,
    querySelector: () => mockElement,
    querySelectorAll: () => [],
  },
};
windowObj.window = windowObj;
windowObj.global = windowObj;
windowObj.self = windowObj;

const ctx = vm.createContext(windowObj);
const constraintsCode = fs.readFileSync('./web/pages/tkb-constraints.js', 'utf8');
vm.runInContext(constraintsCode, ctx);
const engineCode = fs.readFileSync('./web/pages/tkb-fet-engine.js', 'utf8');
vm.runInContext(engineCode, ctx);

const brainScratchPath = 'C:\\\\Users\\\\Love\\\\.gemini\\\\antigravity\\\\brain\\\\e6e653cb-e567-476a-85f0-e418e6636dc4\\\\scratch\\\\school_default_vps.json';
const schoolData = JSON.parse(fs.readFileSync(brainScratchPath, 'utf8'));
windowObj.DATA = schoolData;

async function testDeepChains() {
  const solveEngine = new windowObj.FetTimetableEngine(schoolData);
  await solveEngine.solve();
  const initialTkb = solveEngine.getSnapshotTKB();

  const optEngine = new windowObj.FetTimetableEngine({ ...schoolData, tkb: JSON.parse(JSON.stringify(initialTkb)) });
  optEngine.loadExistingSchedule();

  let bestM = optEngine.evaluateMetrics();
  console.log('Initial metrics:', bestM);

  const DAYS = 6;
  const SESSIONS = 2;
  const PERIODS = 5;

  // DFS/BFS Ejection Chain for singletons
  function tryEjectionChain(act1, s1, s2, maxDepth = 6) {
    const cGrid = optEngine.classGrid.get(act1.classId);
    if (!cGrid) return false;

    const snapPlacement = optEngine.actPlacement.slice();
    const snapClass = new Map();
    optEngine.classGrid.forEach((arr, cid) => snapClass.set(cid, arr.slice()));
    const snapTeacher = new Map();
    optEngine.teacherGrid.forEach((arr, gv) => snapTeacher.set(gv, arr.slice()));
    const snapRoom = new Map();
    optEngine.roomGrid.forEach((arr, rm) => snapRoom.set(rm, arr.slice()));

    const movedActs = [act1];
    optEngine.unplaceActivity(act1.id);

    const r1 = optEngine.getConflictsForSlot(act1, s2);
    if (!r1.possible || r1.conflicts.length > 1) {
      // rollback
      optEngine.actPlacement = snapPlacement;
      optEngine.classGrid = snapClass;
      optEngine.teacherGrid = snapTeacher;
      optEngine.roomGrid = snapRoom;
      return false;
    }

    let displacedActId = cGrid[s2];
    optEngine.placeActivityDirect(act1.id, s2);

    if (displacedActId < 0) {
      // Direct placement into empty slot
      if (optEngine.isLessonBlockSafe(act1)) {
        const m = optEngine.evaluateMetrics();
        if (m.soBuoiDay1 < bestM.soBuoiDay1 && m.soBuoiTrong2 <= bestM.soBuoiTrong2) {
          bestM = { ...m };
          return true;
        }
      }
      optEngine.actPlacement = snapPlacement;
      optEngine.classGrid = snapClass;
      optEngine.teacherGrid = snapTeacher;
      optEngine.roomGrid = snapRoom;
      return false;
    }

    let currentDisplaced = optEngine.activities[displacedActId];
    if (!currentDisplaced || currentDisplaced.isFixed || currentDisplaced.duration !== 1) {
      optEngine.actPlacement = snapPlacement;
      optEngine.classGrid = snapClass;
      optEngine.teacherGrid = snapTeacher;
      optEngine.roomGrid = snapRoom;
      return false;
    }

    movedActs.push(currentDisplaced);
    optEngine.unplaceActivity(currentDisplaced.id);

    // Try finding chain
    function searchChain(currAct, depth, visitedSlots) {
      if (depth > maxDepth) return false;

      // 1. Can currAct go directly to s1? (Closed cycle)
      if (!visitedSlots.has(s1) && !optEngine.offSlots.has(currAct.classId + '|' + s1)) {
        const rClose = optEngine.getConflictsForSlot(currAct, s1);
        if (rClose.possible && rClose.conflicts.length === 0) {
          optEngine.placeActivityDirect(currAct.id, s1);
          if (optEngine.isLessonBlockSafe(...movedActs)) {
            const m = optEngine.evaluateMetrics();
            if (m.soBuoiDay1 < bestM.soBuoiDay1 && m.soBuoiTrong2 <= bestM.soBuoiTrong2) {
              bestM = { ...m };
              return true;
            }
          }
          optEngine.unplaceActivity(currAct.id);
        }
      }

      // 2. Can currAct go to other candidate slots in its class?
      const currCGrid = optEngine.classGrid.get(currAct.classId);
      if (!currCGrid) return false;

      const candSlots = [];
      for (let s = 0; s < 60; s++) {
        if (s === s1 || s === s2 || visitedSlots.has(s) || optEngine.offSlots.has(currAct.classId + '|' + s)) continue;
        candSlots.push(s);
      }
      optEngine.rng.shuffle(candSlots);

      for (const sTarget of candSlots) {
        const nextActId = currCGrid[sTarget];
        if (nextActId < 0) {
          // Empty slot
          const rEmpty = optEngine.getConflictsForSlot(currAct, sTarget);
          if (rEmpty.possible && rEmpty.conflicts.length === 0) {
            optEngine.placeActivityDirect(currAct.id, sTarget);
            if (optEngine.isLessonBlockSafe(...movedActs)) {
              const m = optEngine.evaluateMetrics();
              if (m.soBuoiDay1 < bestM.soBuoiDay1 && m.soBuoiTrong2 <= bestM.soBuoiTrong2) {
                bestM = { ...m };
                return true;
              }
            }
            optEngine.unplaceActivity(currAct.id);
          }
          continue;
        }

        const nextAct = optEngine.activities[nextActId];
        if (!nextAct || nextAct.isFixed || nextAct.duration !== 1 || movedActs.includes(nextAct)) continue;

        const rNext = optEngine.getConflictsForSlot(currAct, sTarget);
        if (rNext.possible && rNext.conflicts.length === 0) {
          optEngine.unplaceActivity(nextAct.id);
          optEngine.placeActivityDirect(currAct.id, sTarget);
          movedActs.push(nextAct);
          visitedSlots.add(sTarget);

          const ok = searchChain(nextAct, depth + 1, visitedSlots);
          if (ok) return true;

          // Backtrack step
          visitedSlots.delete(sTarget);
          movedActs.pop();
          optEngine.unplaceActivity(currAct.id);
          optEngine.placeActivityDirect(nextAct.id, sTarget);
        }
      }

      return false;
    }

    const found = searchChain(currentDisplaced, 1, new Set([s2]));
    if (found) return true;

    // Rollback entire chain
    optEngine.actPlacement = snapPlacement;
    optEngine.classGrid = snapClass;
    optEngine.teacherGrid = snapTeacher;
    optEngine.roomGrid = snapRoom;
    return false;
  }

  // Deep search loop
  console.log('--- Deep Ejection Chains ---');
  let pass = 0;
  while (pass < 20 && bestM.soBuoiDay1 > 0) {
    pass++;
    let passImproved = false;

    // First standard obliteration
    const mOblit = optEngine.obliterateAllTeacherSingletons(10, bestM.soBuoiTrong2);
    if (mOblit && mOblit.soBuoiDay1 < bestM.soBuoiDay1) {
      bestM = { ...mOblit };
      passImproved = true;
      console.log(`Pass ${pass} (Obliterate): soBuoiDay1=${bestM.soBuoiDay1}`);
    }

    // Now deep chains on remaining singletons
    const teacherList = Array.from(optEngine.teacherGrid.keys()).filter(Boolean);
    optEngine.rng.shuffle(teacherList);

    for (const tKey of teacherList) {
      const tGrid = optEngine.teacherGrid.get(tKey);
      if (!tGrid) continue;

      for (let d = 0; d < 6; d++) {
        for (let b = 0; b < 2; b++) {
          const sStart = d * 10 + b * 5;
          const taught = [];
          for (let p = 0; p < 5; p++) {
            const s = sStart + p;
            if (tGrid[s] >= 0) {
              const a = optEngine.activities[tGrid[s]];
              if (a && !a.isFixed && a.duration === 1) taught.push({ slot: s, act: a });
            }
          }
          if (taught.length !== 1) continue;

          const singleItem = taught[0];
          const act1 = singleItem.act;

          // Look for active sessions of tKey
          for (let d2 = 0; d2 < 6; d2++) {
            for (let b2 = 0; b2 < 2; b2++) {
              if (d2 === d && b2 === b) continue;
              const sStart2 = d2 * 10 + b2 * 5;
              let cnt = 0;
              for (let p2 = 0; p2 < 5; p2++) {
                if (tGrid[sStart2 + p2] >= 0 || tGrid[sStart2 + p2] === -3) cnt++;
              }
              if (cnt < 1 || cnt >= 5) continue;

              for (let p2 = 0; p2 < 5; p2++) {
                const sTarget = sStart2 + p2;
                if (tGrid[sTarget] >= 0 || tGrid[sTarget] === -3) continue;
                if (optEngine.offSlots.has(act1.classId + '|' + sTarget)) continue;

                const chainOk = tryEjectionChain(act1, singleItem.slot, sTarget, 5);
                if (chainOk) {
                  passImproved = true;
                  console.log(`Pass ${pass} (Deep Chain tKey=${tKey}): soBuoiDay1=${bestM.soBuoiDay1}`);
                  break;
                }
              }
            }
          }
        }
      }
    }

    if (!passImproved) break;
  }

  console.log('--- Final Result ---');
  console.log(bestM);

  const finalTkb = optEngine.getSnapshotTKB();
  schoolData.tkb = finalTkb;
  windowObj.TKBConstraints.invalidateConstraintCache();
  const vFinal = windowObj.TKBConstraints.validateAll(3000) || [];
  console.log('Final TKBConstraints violations:', vFinal.length);
}

testDeepChains();
