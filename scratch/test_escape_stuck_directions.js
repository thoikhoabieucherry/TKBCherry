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

// Load constraints and engine
const constraintsCode = fs.readFileSync(path.join(__dirname, '../web/pages/tkb-constraints.js'), 'utf8');
vm.runInContext(constraintsCode, ctx);

const engineCode = fs.readFileSync(path.join(__dirname, '../web/pages/tkb-fet-engine.js'), 'utf8');
vm.runInContext(engineCode, ctx);

const brainScratchPath = 'C:\\Users\\Love\\.gemini\\antigravity\\brain\\e6e653cb-e567-476a-85f0-e418e6636dc4\\scratch\\school_default_vps.json';
const schoolData = JSON.parse(fs.readFileSync(brainScratchPath, 'utf8'));
windowObj.DATA = schoolData;

const engine = new windowObj.FetTimetableEngine(schoolData);
console.log('Testing initial solve...');
const solveRes = engine.solve();
console.log('Solve placed:', solveRes.placed, 'unassigned:', solveRes.unassigned);

const initM = engine.evaluateMetrics();
console.log('Initial metrics:', initM);

// Run optimize_singletons
console.log('\n--- Running optimize_singletons with current engine ---');
const t0 = Date.now();
engine.optimize('optimize_singletons', (p) => {
  if (p.percent % 25 === 0) {
    console.log(`Progress ${p.percent}% - Metric: ${p.currentMetric}`);
  }
}).then(res => {
  const t1 = Date.now();
  console.log(`Singletons result in ${(t1 - t0) / 1000}s:`, res.metrics);
  console.log('Residual singletons count:', (res.residualSingletons || []).length);
});
