const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const engine = new FetTimetableEngine(schoolData);
const res = engine.solve();

console.log("Solve output:", res);

const snap = engine.getSnapshotTKB();
let unassignedByClass = [];
let totalPlacedAll = 0;

for(const lop of schoolData.lop || []){
  const cid = String(lop.id || "");
  const classCanon = lop.ten2 || lop.ten || cid;
  
  const acts = engine.activities.filter(a => a.classId === cid);
  const unplaced = acts.filter(a => engine.actPlacement[a.id] < 0);
  
  let placedInSnap = 0;
  const cTkb = snap[cid] || {};
  for(const d of ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"]){
    for(const b of ["sang", "chieu"]){
      const arr = cTkb[d]?.[b] || [];
      for(let p = 0; p < arr.length; p++){
        const c = arr[p];
        if(c && c !== "OFF" && c !== "Nghỉ" && !c.off){
          placedInSnap++;
        }
      }
    }
  }
  totalPlacedAll += placedInSnap;
  
  if(unplaced.length > 0 || placedInSnap < acts.reduce((s,a)=>s+a.duration, 0) + (cid === 'L034' || cid === 'L021' || cid === 'L051' ? 2 : 0)){
    unassignedByClass.push({
      cid,
      classCanon,
      unplacedCount: unplaced.length,
      placedInSnap,
      unplacedActs: unplaced.map(a => `${a.mon} (${a.duration}t, ${a.gv})`)
    });
  }
}

console.log(`\nTotal placed in snapTkb: ${totalPlacedAll} / 2193`);
console.log(`Classes with unplaced lessons count: ${unassignedByClass.length}`);
if(unassignedByClass.length > 0){
  console.log("Unassigned classes:", unassignedByClass);
}else{
  console.log("PERFECT: ALL 75 CLASSES HAVE 100% PLACED LESSONS (0 UNASSIGNED)!");
}
