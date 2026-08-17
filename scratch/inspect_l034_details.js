const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const engine = new FetTimetableEngine(schoolData);
engine.solve();

const snap = engine.getSnapshotTKB();
const snapL034 = snap['L034'];
console.log("L034 snapTkb:", snapL034);

// Let's count how many non-empty/non-OFF cells are in snapL034
let placedL034 = 0;
for(const d of ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"]){
  for(const b of ["sang", "chieu"]){
    const arr = snapL034[d]?.[b] || [];
    for(let p = 0; p < arr.length; p++){
      const c = arr[p];
      if(c && c !== "OFF" && c !== "Nghỉ" && !c.off){
        placedL034++;
        console.log(`  ${d} ${b} T${p+1}:`, c);
      }
    }
  }
}
console.log(`Total placed in L034: ${placedL034}`);

// Let's check pccmTietMatrix for L034
let reqL034 = 0;
for(const [k, v] of Object.entries(schoolData.pccmTietMatrix || {})){
  if(k.startsWith("L034|") || k.startsWith("7A17|")){
    console.log(`  PCCM requirement: ${k} = ${v}`);
    reqL034 += Number(v) || 0;
  }
}
console.log(`Total PCCM required for L034: ${reqL034}`);
