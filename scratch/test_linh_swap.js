const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;

const solver = new FetTimetableEngine(schoolData);
solver.solve();
schoolData.tkb = solver.getSnapshotTKB();

const opt = new FetTimetableEngine(schoolData);
opt.loadExistingSchedule();

console.log("Before swap:", opt.evaluateMetrics());

const actLinh = opt.activities[88]; // L005-LSĐL at slot 25
const actVang = opt.activities[92]; // L005-CN at slot 35

console.log("actLinh:", actLinh.mon, actLinh.gv, "at slot", opt.actPlacement[actLinh.id]);
console.log("actVang:", actVang.mon, actVang.gv, "at slot", opt.actPlacement[actVang.id]);

// Check if Linh is free at slot 35 and Vang is free at slot 25
const linhFree35 = opt.teacherGrid.get("sđ.linh")[35] === -1;
const vangFree25 = opt.teacherGrid.get("cn.vàng")[25] === -1;

console.log(`Linh free at slot 35: ${linhFree35}, Vang free at slot 25: ${vangFree25}`);

if(linhFree35 && vangFree25){
  opt.unplaceActivity(actLinh.id);
  opt.unplaceActivity(actVang.id);
  opt.placeActivityDirect(actLinh.id, 35);
  opt.placeActivityDirect(actVang.id, 25);
  console.log("After swap metrics:", opt.evaluateMetrics());
}
