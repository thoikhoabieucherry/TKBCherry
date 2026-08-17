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

const c = window.TKBConstraints.get();
console.log("Subject keys in constraints:", Object.keys(c.subject || {}));

Object.keys(c.subject || {}).forEach(sk => {
  const sobj = c.subject[sk];
  Object.keys(sobj.byClass || {}).forEach(lopId => {
    const r = sobj.byClass[lopId];
    if(!r.lessonBlocks) return;
    
    // Test what validateAll does here
    for(const len of [2, 3, 4, 5]){
      const min = Number(r.lessonBlocks?.[len]?.min || 0);
      if(min > 0){
        // Let's trace cells
        // In tkb-constraints.js:
        // const cells = subjectCellsAfterPlace(lopId, sk, { lopId, mon: sk });
        // Let's call validateAll to see what is generated
      }
    }
  });
});

const vAll = window.TKBConstraints.validateAll(100);
console.log("vAll length:", vAll.length);
vAll.forEach(v => console.log("  Violation:", v));
