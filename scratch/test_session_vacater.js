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

const constraintsCode = fs.readFileSync(path.join(__dirname, '../web/pages/tkb-constraints.js'), 'utf8');
vm.runInContext(constraintsCode, ctx);

const engineCode = fs.readFileSync(path.join(__dirname, '../web/pages/tkb-fet-engine.js'), 'utf8');
vm.runInContext(engineCode, ctx);

const brainScratchPath = 'C:\\Users\\Love\\.gemini\\antigravity\\brain\\e6e653cb-e567-476a-85f0-e418e6636dc4\\scratch\\school_default_vps.json';
const schoolData = JSON.parse(fs.readFileSync(brainScratchPath, 'utf8'));
windowObj.DATA = schoolData;

async function testSessionVacater(){
  console.log("=== TESTING ADVANCED SESSION VACATER ===");
  const engine = new windowObj.FetTimetableEngine(JSON.parse(JSON.stringify(schoolData)));
  await engine.solve();
  
  const initialM = engine.evaluateMetrics();
  console.log("Metrics before:", initialM);

  const t0 = Date.now();
  const res = await engine.optimize("optimize_sessions", (p) => {
    // live progress
  });
  const t1 = Date.now();

  const finalM = engine.evaluateMetrics();
  console.log(`Optimization finished in ${((t1 - t0)/1000).toFixed(2)}s`);
  console.log("Metrics after:", finalM);
  console.log(`Total Sessions Reduced: ${initialM.tsBuoiDay} -> ${finalM.tsBuoiDay} (Saved ${initialM.tsBuoiDay - finalM.tsBuoiDay} sessions!)`);
  console.log(`Total Days Reduced: ${initialM.tsNgayDay} -> ${finalM.tsNgayDay} (Saved ${initialM.tsNgayDay - finalM.tsNgayDay} days off!)`);
}

testSessionVacater();
