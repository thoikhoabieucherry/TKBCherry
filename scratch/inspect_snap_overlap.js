const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const engine = new FetTimetableEngine(schoolData);
engine.solve();

console.log("Unplaced activities count:", engine.activities.filter(a => engine.actPlacement[a.id] < 0).length);

// Let's check for every class grid in engine vs getSnapshotTKB
let totalPlacedInGrids = 0;
for(const [cid, grid] of engine.classGrid.entries()){
  for(let s = 0; s < 60; s++){
    if(grid[s] >= 0){
      totalPlacedInGrids++;
    }else if(grid[s] === -3){
      totalPlacedInGrids++;
    }
  }
}
console.log("Total placed in classGrid:", totalPlacedInGrids);

// Let's check getSnapshotTKB
const snap = engine.getSnapshotTKB();
let snapCount = 0;
const cellPositions = new Map(); // `${cid}|${s}` -> cell

for(const cid of Object.keys(snap)){
  const cTkb = snap[cid];
  for(const thu of ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"]){
    for(const buoi of ["sang", "chieu"]){
      const arr = cTkb[thu]?.[buoi] || [];
      for(let p = 0; p < arr.length; p++){
        const cell = arr[p];
        const dIdx = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"].indexOf(thu);
        const bIdx = buoi === "sang" ? 0 : 1;
        const s = dIdx * 10 + bIdx * 5 + p;
        if(cell && cell !== "OFF" && cell !== "Nghỉ" && !cell.off){
          snapCount++;
          cellPositions.set(`${cid}|${s}`, cell);
        }
      }
    }
  }
}
console.log("Total placed in snapTkb:", snapCount);

// Compare classGrid with cellPositions
for(const [cid, grid] of engine.classGrid.entries()){
  for(let s = 0; s < 60; s++){
    if(grid[s] >= 0 || grid[s] === -3){
      if(!cellPositions.has(`${cid}|${s}`)){
        console.log(`Discrepancy at ${cid}|${s}: classGrid has ${grid[s]}, but snapTkb has NO cell!`);
      }
    }
  }
}
