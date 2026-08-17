const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const engine = new FetTimetableEngine(schoolData);
engine.solve();

const snapTkb = engine.getSnapshotTKB();
schoolData.tkb = snapTkb;

// Let's count placed cells in snapTkb
let placedCount = 0;
let offCount = 0;
for(const cid of Object.keys(snapTkb)){
  const cTkb = snapTkb[cid];
  for(const d of ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"]){
    for(const b of ["sang", "chieu"]){
      const arr = cTkb[d]?.[b] || [];
      for(let p = 0; p < arr.length; p++){
        const cell = arr[p];
        if(cell && cell !== "OFF" && cell !== "Nghỉ" && !cell.off){
          placedCount++;
        }else if(cell === "OFF" || cell === "Nghỉ" || cell?.off){
          offCount++;
        }
      }
    }
  }
}
console.log(`Placed count in snapTkb: ${placedCount}, Off count: ${offCount}`);

// Let's see which classes have unplaced or missing periods according to PCCM
let totalPccm = 0;
const missingByClass = [];
for(const lop of schoolData.lop || []){
  const cid = String(lop.id || "");
  const classCanon = lop.ten2 || lop.ten || cid;
  
  // Count required
  let reqClass = 0;
  for(const [k, v] of Object.entries(schoolData.pccmTietMatrix || {})){
    if(k.startsWith(cid + "|") || k.startsWith(classCanon + "|")){
      const n = Number(v) || 0;
      reqClass += n;
    }
  }
  
  // Count placed in this class
  let placedInClass = 0;
  const cTkb = snapTkb[cid];
  if(cTkb){
    for(const d of ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"]){
      for(const b of ["sang", "chieu"]){
        const arr = cTkb[d]?.[b] || [];
        for(let p = 0; p < arr.length; p++){
          const cell = arr[p];
          if(cell && cell !== "OFF" && cell !== "Nghỉ" && !cell.off){
            placedInClass++;
          }
        }
      }
    }
  }
  
  totalPccm += reqClass;
  if(placedInClass < reqClass){
    missingByClass.push({ cid, classCanon, req: reqClass, placed: placedInClass, diff: reqClass - placedInClass });
  }
}

console.log(`Total PCCM required across all classes: ${totalPccm}`);
console.log(`Missing classes count: ${missingByClass.length}`);
missingByClass.forEach(m => console.log("  Missing:", m));
