const fs = require('fs');

const allSchools = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/all_vps_schools.json', 'utf8'));
const schoolData = allSchools['school_default'];

const constraintsCode = fs.readFileSync('web/pages/tkb-constraints.js', 'utf8');
const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');

globalThis.window = globalThis;
globalThis.document = { createElement: () => ({ setAttribute: () => {}, appendChild: () => {} }), head: { appendChild: () => {} } };
eval(constraintsCode);
eval(engineCode);

const solver = new globalThis.FetTimetableEngine(schoolData);
solver.solve();
schoolData.tkb = solver.getSnapshotTKB();

const baselineReport = globalThis.TKBConstraints.validateAll(schoolData, schoolData.tkb);
console.log("Baseline violations count after solve:", baselineReport.violations?.length || 0);

const modes = ['optimize_singletons', 'optimize_sessions', 'optimize_gap2', 'optimize_gap1'];

async function testAll() {
  for (const mode of modes) {
    const opt = new globalThis.FetTimetableEngine(schoolData);
    opt.loadExistingSchedule();
    const res = await opt.optimize(mode);
    const report = globalThis.TKBConstraints.validateAll(schoolData, schoolData.tkb);
    console.log(`[${mode}] -> Violations: ${report.violations?.length || 0}, Placed: ${res.placed}, Singletons: ${res.metrics.soBuoiDay1}, Sessions: ${res.metrics.tsBuoiDay}`);
  }
}

testAll();
