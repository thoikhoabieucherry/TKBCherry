const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

globalThis.window = globalThis;
globalThis.document = { querySelectorAll: () => [], getElementById: () => null };
globalThis.DATA = schoolData;

const constraintsCode = fs.readFileSync('web/pages/tkb-constraints.js', 'utf8');
eval(constraintsCode);

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const engine = new FetTimetableEngine(schoolData);
engine.solve();

globalThis.DATA.tkb = engine.getSnapshotTKB();

// Let's inspect L028 cells found by subjectCellsAfterPlace
const c = window.TKBConstraints.get();
const sobj = c.subject['Anh'];
const r = sobj.byClass['L028'];
console.log("L028 Anh rule:", r);

const tkbL028 = globalThis.DATA.tkb['L028'];
console.log("thu7 chieu tkbL028:", tkbL028['thu7']['chieu']);

// Check validateAll implementation
const vAll = window.TKBConstraints.validateAll(100);
console.log("All violations:", vAll);
