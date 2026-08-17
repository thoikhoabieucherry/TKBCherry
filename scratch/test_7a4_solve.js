const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;
const engine = new FetTimetableEngine(schoolData);

console.log("Running solve()...");
const res = engine.solve();
console.log("Solve result:", res);

const snap = engine.getSnapshotTKB();
const snap7A4 = snap['L021'];
console.log("\n=== 7A4 (L021) SNAPSHOT TKB ===");
for(const thu of ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"]){
  for(const buoi of ["sang", "chieu"]){
    const arr = snap7A4[thu]?.[buoi] || [];
    console.log(`  ${thu} ${buoi}:`, arr);
  }
}

// Check unassigned for 7A4
const unassigned7A4 = engine.activities.filter(a => a.classId === 'L021' && engine.actPlacement[a.id] < 0);
console.log("\nUnassigned activities in 7A4 count:", unassigned7A4.length);
unassigned7A4.forEach(a => console.log("  Unassigned:", a));

// Check total unassigned across whole school
const totalUnassigned = engine.activities.filter(a => engine.actPlacement[a.id] < 0);
console.log("\nTotal unassigned activities across whole school:", totalUnassigned.length);
