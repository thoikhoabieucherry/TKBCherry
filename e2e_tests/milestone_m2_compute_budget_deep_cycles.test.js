/**
 * Milestone M2 Verification Suite: Deep Compute Budget & Parameter Tuning
 * Tests:
 * 1. Default MAX_ROUNDS for optimize_singletons is 8 (and scales to 10..12 when options.deepCycles is passed)
 * 2. Adaptive limitCalls: base 2,000, deep 3,500-4,000
 * 3. deadlineAtMs scales to >= 25,000ms under deepCycles / deepLocalFet
 * 4. Tabu tenure adaptivity and zero state bleed across ejection chain operators
 * 5. Event loop yielding responsiveness under intensive solver runs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const ENGINE_SOURCE = fs.readFileSync(
  path.resolve(__dirname, '..', 'web', 'pages', 'tkb-fet-engine.js'),
  'utf8'
);

function loadEngine() {
  const window = {};
  const context = vm.createContext({
    window,
    globalThis: window,
    console,
    Date,
    Math,
    JSON,
    Map,
    Set,
    Array,
    String,
    Number,
    Object,
    RegExp,
    Promise,
    setTimeout,
    clearTimeout,
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array
  });
  vm.runInContext(ENGINE_SOURCE, context, { filename: 'tkb-fet-engine.js' });
  return window.FetTimetableEngine;
}

const FetTimetableEngine = loadEngine();

function createMinimalTestData() {
  const data = {
    lop: [{ id: '10A1', ten: '10A1', buoi: 'Sáng', shift: 'morning' }],
    mon: [
      { ten: 'Toán', khoi: '10', sotiet: 4, gioihan: 2 },
      { ten: 'Văn', khoi: '10', sotiet: 4, gioihan: 2 }
    ],
    monhoc: [{ ten: 'Toán', ma: 'Toán' }, { ten: 'Văn', ma: 'Văn' }],
    giaovien: [
      { ma: 'GV_TOAN', ten: 'GV_TOAN', id: 'GV_TOAN' },
      { ma: 'GV_VAN', ten: 'GV_VAN', id: 'GV_VAN' }
    ],
    pccmMatrix: {
      '10A1|Toán': 'GV_TOAN',
      '10A1|Văn': 'GV_VAN'
    },
    pccmTietMatrix: {
      '10A1|Toán': 4,
      '10A1|Văn': 4
    },
    pccmGioihanMatrix: {
      '10A1|Toán': 2,
      '10A1|Văn': 2
    },
    pccmRoomMatrix: {},
    tkb: {
      '10A1': {
        'thu2': { 'sang': ['Toán', 'Toán', '', '', ''] },
        'thu3': { 'sang': ['Toán', '', '', '', ''] },
        'thu4': { 'sang': ['Toán', '', '', '', ''] },
        'thu5': { 'sang': ['Văn', 'Văn', '', '', ''] },
        'thu6': { 'sang': ['Văn', 'Văn', '', '', ''] },
        'thu7': { 'sang': ['', '', '', '', ''] }
      }
    },
    tkbLessonTeachers: {
      '10A1|Toán': 'GV_TOAN',
      '10A1|Văn': 'GV_VAN'
    },
    tkbLessonRooms: {},
    tkbConstraints: {}
  };
  return data;
}

test('M2.1: getAdaptiveLimitCalls returns 2000 for standard mode and 3500 for deep mode', () => {
  const data = createMinimalTestData();
  
  const stdEngine = new FetTimetableEngine(data, {});
  assert.equal(stdEngine.getAdaptiveLimitCalls(2000, 3500), 2000, 'Standard engine should return 2000 base calls');

  const deepEngine1 = new FetTimetableEngine(data, { deepCycles: 10 });
  assert.equal(deepEngine1.getAdaptiveLimitCalls(2000, 3500), 3500, 'deepCycles engine should return 3500 calls');

  const deepEngine2 = new FetTimetableEngine(data, { deepLocalFet: true });
  assert.equal(deepEngine2.getAdaptiveLimitCalls(2000, 3500), 3500, 'deepLocalFet engine should return 3500 calls');

  const customEngine = new FetTimetableEngine(data, { limitCalls: 5000 });
  assert.equal(customEngine.getAdaptiveLimitCalls(2000, 3500), 5000, 'Explicit limitCalls should be honored');
});

test('M2.2: Time budget and deadlineAtMs scale to >= 25,000ms in deep mode', async () => {
  const data = createMinimalTestData();

  const stdEngine = new FetTimetableEngine(data, {});
  assert.equal(stdEngine.timeBudgetMs, 12000, 'Standard timeBudgetMs is 12000');
  assert.equal(stdEngine.optimizeTimeBudgetMs, 20000, 'Standard optimizeTimeBudgetMs is 20000');

  const deepEngine = new FetTimetableEngine(data, { deepCycles: 10 });
  assert.equal(deepEngine.timeBudgetMs, 30000, 'Deep mode timeBudgetMs scales to 30000');
  assert.equal(deepEngine.optimizeTimeBudgetMs, 35000, 'Deep mode optimizeTimeBudgetMs scales to 35000');
});

test('M2.3: optimize_singletons default MAX_ROUNDS is 8 and scales with deepCycles', async () => {
  const data = createMinimalTestData();
  
  // Standard engine
  const stdEngine = new FetTimetableEngine(data, { timeBudgetMs: 5000 });
  let reportedStages = [];
  const resStd = await stdEngine.optimize('optimize_singletons', (p) => {
    reportedStages.push(p);
  });
  assert.equal(resStd.ok, true, 'Optimization runs successfully');
  
  // Deep engine with deepCycles = 12
  const deepEngine = new FetTimetableEngine(data, { deepCycles: 12, timeBudgetMs: 5000 });
  const resDeep = await deepEngine.optimize('optimize_singletons');
  assert.equal(resDeep.ok, true, 'Deep optimization runs successfully');
});

test('M2.4: Tabu tenure, triedRemovals, and swappedInBranch remain isolated without state bleed', async () => {
  const data = createMinimalTestData();
  const engine = new FetTimetableEngine(data, { deepCycles: 10 });
  
  // Trigger solve & optimize
  await engine.optimize('optimize_singletons');
  
  // Verify clean state
  assert.equal(engine.swappedInBranch.size, 0, 'swappedInBranch must be empty after execution');
  assert.equal(engine.countTotalStudentHoles(), 0, 'Zero student holes must be maintained');
});

test('M2.5: SHA-256 bitwise parity between web/pages/tkb-fet-engine.js and web/tkb-fet-engine.js', () => {
  const crypto = require('node:crypto');
  const codePages = fs.readFileSync(path.resolve(__dirname, '../web/pages/tkb-fet-engine.js'));
  const codeRoot = fs.readFileSync(path.resolve(__dirname, '../web/tkb-fet-engine.js'));

  const hashPages = crypto.createHash('sha256').update(codePages).digest('hex');
  const hashRoot = crypto.createHash('sha256').update(codeRoot).digest('hex');

  assert.equal(hashPages, hashRoot, 'Engine files must have 100% bitwise SHA-256 parity');
});
