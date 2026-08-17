const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

// Load constraints engine
globalThis.window = globalThis;
globalThis.document = { querySelectorAll: () => [], getElementById: () => null };
globalThis.DATA = schoolData;

const constraintsCode = fs.readFileSync('web/pages/tkb-constraints.js', 'utf8');
eval(constraintsCode);

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const engine = new FetTimetableEngine(schoolData);
engine.solve();

console.log("Applying engine snapshot to globalThis.DATA.tkb...");
globalThis.DATA.tkb = engine.getSnapshotTKB();

const violations = window.TKBConstraints.validateAll(3000);
console.log("Total violations from TKBConstraints.validateAll:", violations.length);

const lbViolations = violations.filter(v => v.kind === 'subject.lessonBlocks.min');
console.log(`subject.lessonBlocks.min violations count: ${lbViolations.length}`);
lbViolations.forEach(v => {
  console.log(`  ${v.lopId} (${v.className}) - ${v.mon}: ${v.message}`);
});
