const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

globalThis.window = globalThis;
globalThis.location = { search: "?sid=default" };
globalThis.window.addEventListener = () => {};
globalThis.window.removeEventListener = () => {};
globalThis.document = {
  querySelectorAll: () => [],
  getElementById: () => null,
  addEventListener: () => {},
  removeEventListener: () => {}
};
globalThis.DATA = schoolData;
globalThis.DAYS = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const phanmonCode = fs.readFileSync('web/pages/phanmon.js', 'utf8');
eval(phanmonCode);

const engine = new FetTimetableEngine(schoolData);
engine.solve();

globalThis.DATA.tkb = engine.getSnapshotTKB();
window.__TKB_GLOBAL_DATA_VERSION = 1;

const stats = calcSchoolTKBStats();
console.log("calcSchoolTKBStats output:", stats);

// Check if any class has chuaXep > 0
for(const lop of schoolData.lop || []){
  const cStats = calcClassTKBPeriodStats(lop.id);
  if(cStats.chuaXep > 0){
    console.log(`Class ${lop.ten2 || lop.ten || lop.id}: daXep=${cStats.daXep}, total=${cStats.totalPeriods}, chuaXep=${cStats.chuaXep}, oTrong=${cStats.oTrong}`);
  }
}
