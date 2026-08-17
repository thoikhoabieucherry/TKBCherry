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

const snapTkb = globalThis.DATA.tkb['L012'];
console.log("6A12 (L012) actual TKB in DATA.tkb:");
for(const d of ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"]){
  console.log(`  ${d} sang:`, snapTkb[d]?.sang);
  console.log(`  ${d} chieu:`, snapTkb[d]?.chieu);
}

// Let's test countConsecutiveBlocks for Anh in 6A12
const thu5Sang = snapTkb['thu5']?.sang || [];
console.log("thu5 sang cells:", thu5Sang);
console.log("Anh indices in thu5 sang:", thu5Sang.map((c, i) => (c === 'Anh' || c?.mon === 'Anh') ? i : -1).filter(i => i >= 0));
