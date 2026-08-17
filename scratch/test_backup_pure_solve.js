const fs = require('fs');

const engineCode = fs.readFileSync('c:/Users/Love/Documents/Codex/backup/TKBCherry/web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const FetTimetableEngine = globalThis.FetTimetableEngine;
const engine = new FetTimetableEngine(schoolData);

console.log("Calling pure backup FET solve()...");
const t0 = Date.now();
const res = engine.solve();
const t1 = Date.now();

console.log(`Solve finished in ${t1 - t0}ms:`, res);
