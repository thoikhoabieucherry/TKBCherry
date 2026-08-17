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

async function testFullSuite() {
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

  // Let's implement the complete LNS Singleton Optimizer from MD
  for (let round = 0; round < 15; round++) {
    let roundImproved = false;

    // Pass 1: Obliterate Singletons (2-way & 3-way cycles)
    const m1 = optEngine.obliterateAllTeacherSingletons(15, bestM.soBuoiTrong2);
    if (m1 && m1.soBuoiDay1 < bestM.soBuoiDay1) {
      bestM = { ...m1 };
      roundImproved = true;
      console.log(`Round ${round + 1} - Obliterate: soBuoiDay1=${bestM.soBuoiDay1}`);
    }

    // Pass 2: Inbound Singleton Reinforcement (Pulls lessons from rich sessions of the teacher)
    const m2 = optEngine.tryReinforceTeacherSingletons(bestM, bestM, bestM.soBuoiTrong2);
    if (m2 && m2.soBuoiDay1 < bestM.soBuoiDay1) {
      bestM = { ...m2 };
      roundImproved = true;
      console.log(`Round ${round + 1} - Reinforce: soBuoiDay1=${bestM.soBuoiDay1}`);
    }

    // Pass 3: Intra-Teacher Singleton Consolidation (Merges single-period sessions of teacher)
    const m3 = optEngine.tryConsolidateTeacherSingletons(bestM, bestM, bestM.soBuoiTrong2);
    if (m3 && m3.soBuoiDay1 < bestM.soBuoiDay1) {
      bestM = { ...m3 };
      roundImproved = true;
      console.log(`Round ${round + 1} - Consolidate: soBuoiDay1=${bestM.soBuoiDay1}`);
    }

    if (bestM.soBuoiDay1 === 0) break;
    if (!roundImproved && round >= 3) break;
  }

  console.log('--- Result after full suite ---');
  console.log(bestM);

  const residuals = optEngine.getResidualSingletons ? optEngine.getResidualSingletons() : [];
  console.log('Residuals count:', residuals.length);

  const finalTkb = optEngine.getSnapshotTKB();
  schoolData.tkb = finalTkb;
  windowObj.TKBConstraints.invalidateConstraintCache();
  const vFinal = windowObj.TKBConstraints.validateAll(3000) || [];
  console.log('Final TKBConstraints violations:', vFinal.length);
}

testFullSuite();
