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

async function testLnsPrototype() {
  const solveEngine = new windowObj.FetTimetableEngine(schoolData);
  await solveEngine.solve();
  const initialTkb = solveEngine.getSnapshotTKB();

  const optEngine = new windowObj.FetTimetableEngine({ ...schoolData, tkb: JSON.parse(JSON.stringify(initialTkb)) });
  optEngine.loadExistingSchedule();

  console.log('--- Initial Metrics ---');
  let bestMetrics = optEngine.evaluateMetrics();
  console.log(bestMetrics);

  const DAYS = 6;
  const SESSIONS = 2;
  const PERIODS = 5;

  // LNS Ruin and Recreate method prototype
  function lnsRuinAndRecreate(optEngine, targetTeacherKeys, bestM) {
    const snapPlacement = optEngine.actPlacement.slice();
    const snapClass = new Map();
    optEngine.classGrid.forEach((arr, cid) => snapClass.set(cid, arr.slice()));
    const snapTeacher = new Map();
    optEngine.teacherGrid.forEach((arr, gv) => snapTeacher.set(gv, arr.slice()));
    const snapRoom = new Map();
    optEngine.roomGrid.forEach((arr, rm) => snapRoom.set(rm, arr.slice()));

    const unplacedActs = [];
    for (const tKey of targetTeacherKeys) {
      const tGrid = optEngine.teacherGrid.get(tKey);
      if (!tGrid) continue;

      for (let s = 0; s < 60; s++) {
        const actId = tGrid[s];
        if (actId >= 0) {
          const act = optEngine.activities[actId];
          if (act && !act.isFixed && act.duration === 1) {
            optEngine.unplaceActivity(act.id);
            unplacedActs.push(act);
          }
        }
      }
    }

    if (unplacedActs.length === 0) return null;

    // Sort unplaced acts by most-constrained first
    unplacedActs.sort((a, b) => {
      const cA = optEngine.classGrid.get(a.classId)?.filter(x => x === -1).length || 0;
      const cB = optEngine.classGrid.get(b.classId)?.filter(x => x === -1).length || 0;
      return cA - cB;
    });

    // Re-place activities using randomSwap with penalty
    let allPlaced = true;
    optEngine.limitCalls = 5000;

    for (const act of unplacedActs) {
      optEngine.nCalls = 0;
      const ok = optEngine.randomSwap(act.id, 0);
      if (!ok) {
        allPlaced = false;
        break;
      }
    }

    if (allPlaced && optEngine.isLessonBlockSafe(...unplacedActs)) {
      const m = optEngine.evaluateMetrics();
      if (m.soBuoiDay1 < bestM.soBuoiDay1 && m.soBuoiTrong2 <= bestM.soBuoiTrong2) {
        return m;
      }
    }

    // Rollback
    optEngine.actPlacement = snapPlacement;
    optEngine.classGrid = snapClass;
    optEngine.teacherGrid = snapTeacher;
    optEngine.roomGrid = snapRoom;
    return null;
  }

  // Multi-pass LNS loop
  console.log('--- Running Multi-Pass LNS Prototype ---');
  let round = 0;
  while (round < 30 && bestMetrics.soBuoiDay1 > 0) {
    round++;

    // 1. Run standard multi-hop obliteration
    const oblitM = optEngine.obliterateAllTeacherSingletons(15, bestMetrics.soBuoiTrong2);
    if (oblitM && oblitM.soBuoiDay1 < bestMetrics.soBuoiDay1) {
      bestMetrics = { ...oblitM };
      console.log(`Round ${round} (Obliterate): soBuoiDay1=${bestMetrics.soBuoiDay1}, tsBuoiDay=${bestMetrics.tsBuoiDay}, tsNgayDay=${bestMetrics.tsNgayDay}`);
    }

    // 2. Find teachers with singletons
    const singlesMap = new Map();
    optEngine.teacherGrid.forEach((grid, tKey) => {
      if (!tKey) return;
      for (let d = 0; d < 6; d++) {
        for (let b = 0; b < 2; b++) {
          const sStart = d * 10 + b * 5;
          let cnt = 0;
          for (let p = 0; p < 5; p++) {
            if (grid[sStart + p] >= 0 || grid[sStart + p] === -3) cnt++;
          }
          if (cnt === 1) {
            singlesMap.set(tKey, (singlesMap.get(tKey) || 0) + 1);
          }
        }
      }
    });

    if (singlesMap.size === 0) break;

    // 3. Try LNS Ruin & Recreate on singletons
    const singleTeachers = Array.from(singlesMap.keys());
    optEngine.rng.shuffle(singleTeachers);

    for (let i = 0; i < singleTeachers.length; i++) {
      const targets = [singleTeachers[i]];
      if (i + 1 < singleTeachers.length) targets.push(singleTeachers[i + 1]);

      const lnsM = lnsRuinAndRecreate(optEngine, targets, bestMetrics);
      if (lnsM) {
        bestMetrics = { ...lnsM };
        console.log(`Round ${round} (LNS Ruin/Recreate on ${targets.join(', ')}): soBuoiDay1=${bestMetrics.soBuoiDay1}, tsBuoiDay=${bestMetrics.tsBuoiDay}`);
        break;
      }
    }
  }

  console.log('--- Final Metrics ---');
  console.log(bestMetrics);

  const finalTkb = optEngine.getSnapshotTKB();
  schoolData.tkb = finalTkb;
  windowObj.TKBConstraints.invalidateConstraintCache();
  const vFinal = windowObj.TKBConstraints.validateAll(3000) || [];
  console.log('Final TKBConstraints violations:', vFinal.length);
}

testLnsPrototype();
