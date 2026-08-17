const fs = require('fs');
const path = require('path');
const vm = require('vm');

// 1. Setup browser-like globals for Node VM
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

// Load tkb-constraints.js
const constraintsCode = fs.readFileSync(path.join(__dirname, '../web/pages/tkb-constraints.js'), 'utf8');
vm.runInContext(constraintsCode, ctx);

// Load tkb-fet-engine.js
const engineCode = fs.readFileSync(path.join(__dirname, '../web/pages/tkb-fet-engine.js'), 'utf8');
vm.runInContext(engineCode, ctx);

console.log('TKBConstraints available:', !!windowObj.TKBConstraints);
console.log('FetTimetableEngine available:', !!windowObj.FetTimetableEngine);

// Load school data
const brainScratchPath = 'C:\\Users\\Love\\.gemini\\antigravity\\brain\\e6e653cb-e567-476a-85f0-e418e6636dc4\\scratch\\school_default_vps.json';
const schoolData = JSON.parse(fs.readFileSync(brainScratchPath, 'utf8'));
windowObj.DATA = schoolData;

console.log('School loaded:', schoolData.schoolName || schoolData.name, 'classes:', (schoolData.lop || []).length);

// Helper to validate with TKBConstraints.validateAll
function validateCurrentTkb() {
  windowObj.TKBConstraints.invalidateConstraintCache();
  return windowObj.TKBConstraints.validateAll(3000) || [];
}

function fetHardViolationSignature(item){
  return [
    String(item?.kind || item?.type || "ui_hard_validation").trim().toLowerCase(),
    String(item?.lopId || item?.classId || "").trim().toLowerCase(),
    String(item?.teacherId || item?.gv || "").trim().toLowerCase(),
    String(item?.mon || item?.subjectId || "").trim().toLowerCase(),
    String(item?.session || item?.buoi || "").trim().toLowerCase(),
    String(item?.day || item?.thu || "").trim().toLowerCase(),
    Number.isFinite(Number(item?.ti ?? item?.period)) ? Number(item?.ti ?? item?.period) : "",
    String(item?.message || "").trim().toLowerCase()
  ].join("|");
}

function compareViolations(incumbentRows, candidateRows) {
  const incMap = new Map();
  incumbentRows.forEach(item => {
    const sig = fetHardViolationSignature(item);
    incMap.set(sig, (incMap.get(sig) || 0) + 1);
  });

  const candMap = new Map();
  candidateRows.forEach(item => {
    const sig = fetHardViolationSignature(item);
    candMap.set(sig, (candMap.get(sig) || 0) + 1);
  });

  const addedRows = [];
  candidateRows.forEach(item => {
    const sig = fetHardViolationSignature(item);
    const available = incMap.get(sig) || 0;
    if (available > 0) {
      incMap.set(sig, available - 1);
    } else {
      addedRows.push(item);
    }
  });

  return {
    incCount: incumbentRows.length,
    candCount: candidateRows.length,
    addedCount: addedRows.length,
    addedRows: addedRows
  };
}

async function runTests() {
  console.log('\n=== INITIAL SOLVE ("XẾP TKB") ===');
  const t0 = Date.now();
  const solveEngine = new windowObj.FetTimetableEngine(schoolData);
  const solveRes = await solveEngine.solve();
  const solveTime = Date.now() - t0;
  console.log(`Initial solve finished in ${solveTime}ms: placed=${solveRes.placed}/${solveRes.total}, unassigned=${solveRes.unassigned}`);

  // Set solved schedule onto schoolData.tkb
  const initialTkb = solveEngine.getSnapshotTKB();
  schoolData.tkb = initialTkb;
  schoolData.tkbLessonTeachers = solveEngine.data.tkbLessonTeachers;
  schoolData.tkbLessonRooms = solveEngine.data.tkbLessonRooms;

  const initialViolations = validateCurrentTkb();
  console.log('Initial solve TKBConstraints violations:', initialViolations.length);
  if (initialViolations.length > 0) {
    console.log('Initial violation kinds:', [...new Set(initialViolations.map(v => v.kind || v.type || v.message))]);
  }

  const initialEngine = new windowObj.FetTimetableEngine(schoolData);
  initialEngine.loadExistingSchedule();
  const initialMetrics = initialEngine.evaluateMetrics();
  console.log('Initial metrics:', initialMetrics);

  const modes = [
    { name: 'Button 1: optimize_singletons (Tối ưu 1 tiết/buổi)', mode: 'optimize_singletons' },
    { name: 'Button 2: optimize_sessions (Tối ưu Buổi dạy)', mode: 'optimize_sessions' },
    { name: 'Button 3: optimize_gap2 (Tối ưu 2 tiết trống)', mode: 'optimize_gap2' },
    { name: 'Button 4: optimize_gap1 (Tối ưu 1 tiết trống)', mode: 'optimize_gap1' },
  ];

  for (const item of modes) {
    console.log(`\n======================================================`);
    console.log(`=== TESTING ${item.name} ===`);
    console.log(`======================================================`);

    // Fresh engine from initial solved timetable
    schoolData.tkb = JSON.parse(JSON.stringify(initialTkb));
    const optEngine = new windowObj.FetTimetableEngine(schoolData);

    const startTime = Date.now();
    const optRes = await optEngine.optimize(item.mode, (prog) => {
      // console.log(`Progress: ${prog.percent}% | currentMetric: ${prog.currentMetric}`);
    });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`Optimization completed in ${elapsed}s: placed=${optRes.placed}, unassigned=${optRes.unassigned}`);

    const candidateTkb = optEngine.getSnapshotTKB();
    schoolData.tkb = candidateTkb;
    schoolData.tkbLessonTeachers = optEngine.data.tkbLessonTeachers;
    schoolData.tkbLessonRooms = optEngine.data.tkbLessonRooms;

    const candidateViolations = validateCurrentTkb();
    const comp = compareViolations(initialViolations, candidateViolations);

    console.log('Metrics before:', optRes.initialMetrics);
    console.log('Metrics after: ', optRes.metrics);
    console.log(`Constraint Check: Incumbent Violations = ${comp.incCount} | Candidate Violations = ${comp.candCount} | Added Violations = ${comp.addedCount}`);

    if (comp.addedCount > 0) {
      console.error('FAILED: Added violations detected!');
      console.error('Added violations sample:', comp.addedRows.slice(0, 5));
    } else {
      console.log('SUCCESS: 0 Added Violations! Candidate accepted cleanly without any warning modal.');
    }
  }
}

runTests().catch(err => {
  console.error('Test error:', err);
});
