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

const phanmonCode = fs.readFileSync(path.join(__dirname, '../web/pages/phanmon.js'), 'utf8');
vm.runInContext(phanmonCode, ctx);

console.log("=== UNIT TEST: isCellFixed & isCellOff ===");
const engine = new windowObj.FetTimetableEngine({});

const fixedSamples = [
  { cd: 1 },
  { cd: true },
  { codinh: true },
  { codinh: 1 },
  { fixed: true },
  { fixed: 1 },
  { isFixed: true },
  { locked: true },
  "!Toán",
  "Toán*",
  "[fixed]Toán",
  "[cd]Toán",
  "Toán (cố định)"
];

fixedSamples.forEach((sample, i) => {
  const isFix = engine.isCellFixed(sample);
  console.log(`Sample ${i} (${JSON.stringify(sample)}): isCellFixed = ${isFix}`);
  if(!isFix) throw new Error(`Failed to recognize fixed cell: ${JSON.stringify(sample)}`);
});

const offSamples = [
  "OFF",
  "off",
  "nghi",
  { off: true },
  { off: 1 },
  { nghi: true },
  { val: "OFF" },
  { mon: "OFF" }
];

offSamples.forEach((sample, i) => {
  const isOff = engine.isCellOff(sample);
  console.log(`Sample ${i} (${JSON.stringify(sample)}): isCellOff = ${isOff}`);
  if(!isOff) throw new Error(`Failed to recognize off cell: ${JSON.stringify(sample)}`);
});

console.log("ALL CELL TESTS PASSED!");
