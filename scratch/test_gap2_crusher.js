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
  addEventListener: () => {},
  removeEventListener: () => {},
  URLSearchParams: URLSearchParams,
  location: { search: '' },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  fetch: global.fetch || (() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })),
  document: {
    createElement: () => mockElement,
    head: mockElement,
    body: mockElement,
    getElementById: () => mockElement,
    querySelector: () => mockElement,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
  },
};
windowObj.window = windowObj;
windowObj.global = windowObj;
windowObj.self = windowObj;

const ctx = vm.createContext(windowObj);

const constraintsCode = fs.readFileSync(path.join(__dirname, '../web/pages/tkb-constraints.js'), 'utf8');
vm.runInContext(constraintsCode, ctx);

const engineCode = fs.readFileSync(path.join(__dirname, '../web/pages/tkb-fet-engine.js'), 'utf8');
vm.runInContext(engineCode, ctx);

async function runBenchmark(){
  const brainScratchPath = 'C:\\Users\\Love\\.gemini\\antigravity\\brain\\e6e653cb-e567-476a-85f0-e418e6636dc4\\scratch\\school_default_vps.json';
  const school = JSON.parse(fs.readFileSync(brainScratchPath, 'utf8'));
  windowObj.DATA = school;

  console.log("=== STEP 1: INITIAL SOLVE ===");
  const initEngine = new windowObj.FetTimetableEngine(school);
  const solveRes = await initEngine.solve();
  console.log(`Initial solve: placed=${solveRes.placed}/${solveRes.totalActivities}, unassigned=${solveRes.unassigned}`);

  const initialTkb = initEngine.getSnapshotTKB();
  school.tkb = initialTkb;
  school.tkbLessonTeachers = initEngine.data.tkbLessonTeachers;
  school.tkbLessonRooms = initEngine.data.tkbLessonRooms;

  const initViolations = windowObj.TKBConstraints.validateAll(school);
  console.log(`Initial hard violations: ${initViolations.length}`);

  const initMetrics = initEngine.evaluateMetrics();
  console.log("Initial Metrics:", initMetrics);

  console.log("\n=== STEP 2: RUN optimize_gap2 (Tối ưu 2 tiết trống) ===");
  const optData = JSON.parse(JSON.stringify(school));
  const optEngine = new windowObj.FetTimetableEngine(optData, { maxSeconds: 30, maxRounds: 10 });
  const t0 = Date.now();
  const optRes = await optEngine.optimize("optimize_gap2", (liveM) => {
    // live update
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`Optimization completed in ${elapsed}s`);
  console.log("Metrics before:", optRes.initialMetrics);
  console.log("Metrics after: ", optRes.metrics);
  console.log("Residual Gap2 Sessions:", optRes.residualGap2);

  const finalData = JSON.parse(JSON.stringify(optData));
  finalData.tkb = optData.tkb;
  const finalViolations = windowObj.TKBConstraints.validateAll(finalData);
  console.log(`Final hard violations: ${finalViolations.length} (Added: ${finalViolations.length - initViolations.length})`);

  if(finalViolations.length - initViolations.length > 0){
    console.error("FAIL: Constraint violations introduced!");
  }else{
    console.log("SUCCESS: 0 Added Violations!");
  }
}

runBenchmark().catch(console.error);
