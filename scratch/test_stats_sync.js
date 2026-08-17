const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

globalThis.window = globalThis;
globalThis.location = { search: '', href: '' };
globalThis.localStorage = { getItem: () => '', setItem: () => {}, removeItem: () => {} };
globalThis.addEventListener = () => {};
globalThis.document = {
  documentElement: { clientHeight: 800, style: { setProperty: () => {} } },
  addEventListener: () => {},
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => []
};
globalThis.DATA = schoolData;
globalThis.DAYS = ["thu2","thu3","thu4","thu5","thu6","thu7"];
globalThis.SANG = 5;
globalThis.CHIEU = 5;

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const phanmonCode = fs.readFileSync('web/pages/phanmon.js', 'utf8');
eval(phanmonCode + `
const solver = new FetTimetableEngine(schoolData);
solver.solve();
schoolData.tkb = solver.getSnapshotTKB();

const engineM = solver.evaluateMetrics();
const phanmonStats = calcTeacherTKBStats();

console.log("Engine evaluateMetrics():", engineM);
console.log("Phanmon calcTeacherTKBStats():", {
  soBuoiDay1: phanmonStats.soBuoiDay1,
  tsBuoiDay: phanmonStats.tsBuoiDay,
  tsNgayDay: phanmonStats.tsNgayDay,
  soBuoiTrong1: phanmonStats.soBuoiTrong1,
  soBuoiTrong2: phanmonStats.soBuoiTrong2
});
`);
