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

const brainScratchPath = 'C:\\Users\\Love\\.gemini\\antigravity\\brain\\e6e653cb-e567-476a-85f0-e418e6636dc4\\scratch\\school_default_vps.json';
const schoolData = JSON.parse(fs.readFileSync(brainScratchPath, 'utf8'));
windowObj.DATA = schoolData;

// Read engine code
let engineCode = fs.readFileSync(path.join(__dirname, '../web/pages/tkb-fet-engine.js'), 'utf8');
vm.runInContext(engineCode, ctx);

// Let's verify solve
async function verifyAll() {
  console.log('=== SOLVE TEST ===');
  const solveEngine = new windowObj.FetTimetableEngine(schoolData);
  await solveEngine.solve();
  const initialTkb = solveEngine.getSnapshotTKB();
  schoolData.tkb = initialTkb;
  windowObj.TKBConstraints.invalidateConstraintCache();
  const vInitial = windowObj.TKBConstraints.validateAll(3000) || [];
  console.log('Initial solve violations:', vInitial.length);
  const m0 = solveEngine.evaluateMetrics();
  console.log('Initial metrics:', m0);
}

verifyAll();
