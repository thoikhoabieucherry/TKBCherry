const fs = require('fs');

const rawData = JSON.parse(fs.readFileSync('./temp_data.json', 'utf8'));

const teachers = rawData.teachers;
const classes = rawData.classes;
const teacherGrid = rawData.teacher_grid;
const classGrid = rawData.class_grid;
const classOffSlots = {};
for(const [c, offList] of Object.entries(rawData.class_off_slots)){
  classOffSlots[c] = new Set(offList);
}
const slotInfo = rawData.slot_info;

// Map teacher -> index, class -> index
const teacherMap = new Map();
teachers.forEach((t, i) => teacherMap.set(t, i));
const classMap = new Map();
classes.forEach((c, i) => classMap.set(c, i));

// Build numeric grids
// tGrid[tIdx][slot] = { cIdx, subj, text } or null
// cGrid[cIdx][slot] = { tIdx, subj, text } or null
const numT = teachers.length;
const numC = classes.length;

let tGrid = Array.from({length: numT}, () => Array(60).fill(null));
let cGrid = Array.from({length: numC}, () => Array(60).fill(null));

for(let t = 0; t < numT; t++){
  const tname = teachers[t];
  for(let s = 0; s < 60; s++){
    const val = teacherGrid[tname][s];
    if(val){
      const parts = val.split('-');
      const cname = parts[0].trim();
      const subj = parts.slice(1).join('-').trim();
      const cIdx = classMap.get(cname);
      const cellObj = { tIdx: t, cIdx, subj, text: val };
      tGrid[t][s] = cellObj;
      cGrid[cIdx][s] = cellObj;
    }
  }
}

function countSingletons(tg){
  let count = 0;
  const singletonsList = [];
  for(let t = 0; t < numT; t++){
    for(let d = 0; d < 6; d++){
      for(let b = 0; b < 2; b++){
        const sStart = d * 10 + b * 5;
        let taughtInSess = 0;
        let lastObj = null;
        let lastS = -1;
        for(let p = 0; p < 5; p++){
          const s = sStart + p;
          if(tg[t][s] !== null){
            taughtInSess++;
            lastObj = tg[t][s];
            lastS = s;
          }
        }
        if(taughtInSess === 1){
          count++;
          singletonsList.push({ tIdx: t, tname: teachers[t], slot: lastS, cell: lastObj });
        }
      }
    }
  }
  return { count, singletonsList };
}

function countGaps(tg){
  let gaps = 0;
  for(let t = 0; t < numT; t++){
    for(let d = 0; d < 6; d++){
      for(let b = 0; b < 2; b++){
        const sStart = d * 10 + b * 5;
        const taught = [];
        for(let p = 0; p < 5; p++){
          if(tg[t][sStart + p] !== null) taught.push(p);
        }
        if(taught.length > 1){
          if(taught[taught.length - 1] - taught[0] + 1 > taught.length){
            gaps++;
          }
        }
      }
    }
  }
  return gaps;
}

function evaluateScore(tg){
  const { count: sing } = countSingletons(tg);
  const gaps = countGaps(tg);
  return sing * 10000 + gaps * 10;
}

console.log("Initial state:", countSingletons(tGrid).count, "singletons,", countGaps(tGrid), "gaps");

function cloneGrid(tg){
  return tg.map(row => row.slice());
}

function solveSA(){
  let currT = cloneGrid(tGrid);
  let currC = cloneGrid(cGrid);
  
  let bestT = cloneGrid(currT);
  let bestC = cloneGrid(currC);
  let bestScore = evaluateScore(bestT);
  let bestSing = countSingletons(bestT).count;
  let currScore = bestScore;
  
  let temp = 100.0;
  const cooling = 0.99999;
  const iterations = 500000;
  
  for(let it = 0; it < iterations; it++){
    // Choose move
    let cIdx;
    const { singletonsList } = countSingletons(currT);
    if(singletonsList.length > 0 && Math.random() < 0.8){
      const pick = singletonsList[Math.floor(Math.random() * singletonsList.length)];
      cIdx = pick.cell.cIdx;
    } else {
      cIdx = Math.floor(Math.random() * numC);
    }
    
    const cname = classes[cIdx];
    const offSet = classOffSlots[cname] || new Set();
    
    const s1 = Math.floor(Math.random() * 60);
    const s2 = Math.floor(Math.random() * 60);
    if(s1 === s2) continue;
    
    const item1 = currC[cIdx][s1];
    const item2 = currC[cIdx][s2];
    
    if(item1 === null && item2 === null) continue;
    
    // Check off periods
    if(item1 !== null && offSet.has(s2)) continue;
    if(item2 !== null && offSet.has(s1)) continue;
    
    const t1 = item1 ? item1.tIdx : -1;
    const t2 = item2 ? item2.tIdx : -1;
    
    // Check teacher availability
    if(t1 !== -1 && t1 !== t2 && currT[t1][s2] !== null) continue;
    if(t2 !== -1 && t1 !== t2 && currT[t2][s1] !== null) continue;
    
    // Apply swap
    currC[cIdx][s1] = item2;
    currC[cIdx][s2] = item1;
    if(t1 !== -1){
      currT[t1][s1] = null;
      currT[t1][s2] = item1;
    }
    if(t2 !== -1){
      currT[t2][s2] = null;
      currT[t2][s1] = item2;
    }
    
    const newScore = evaluateScore(currT);
    const delta = newScore - currScore;
    
    if(delta < 0 || (temp > 0.001 && Math.random() < Math.exp(-delta / temp))){
      currScore = newScore;
      if(newScore < bestScore){
        bestScore = newScore;
        const singCount = countSingletons(currT).count;
        bestSing = singCount;
        bestT = cloneGrid(currT);
        bestC = cloneGrid(currC);
        console.log(`Iter ${it}: Improved -> Singletons = ${bestSing}, Gaps = ${countGaps(currT)}, Score = ${bestScore}`);
        if(bestSing === 0 && countGaps(currT) <= 20){
          console.log("SUCCESSFULLY REACHED 0 SINGLETONS!");
          break;
        }
      }
    } else {
      // Revert swap
      currC[cIdx][s1] = item1;
      currC[cIdx][s2] = item2;
      if(t1 !== -1){
        currT[t1][s2] = null;
        currT[t1][s1] = item1;
      }
      if(t2 !== -1){
        currT[t2][s1] = null;
        currT[t2][s2] = item2;
      }
    }
    
    temp *= cooling;
    if(it % 50000 === 0){
      console.log(`Iter ${it}: Temp=${temp.toFixed(2)}, BestSing=${bestSing}, BestScore=${bestScore}`);
    }
  }
  
  console.log("\n=== FINAL RESULT ===");
  const finalSing = countSingletons(bestT);
  console.log("Remaining Singletons:", finalSing.count);
  for(const s of finalSing.singletonsList){
    const info = slotInfo[s.slot];
    console.log(`- GV ${s.tname}: Thứ ${info.day} ${info.session} Tiết ${info.period} (${s.cell.text})`);
  }
  console.log("Remaining Gaps:", countGaps(bestT));
  
  // Save optimized result
  const exportResult = {
    teacher_grid: {},
    class_grid: {}
  };
  for(let t = 0; t < numT; t++){
    const tname = teachers[t];
    exportResult.teacher_grid[tname] = bestT[t].map(x => x ? x.text : null);
  }
  for(let c = 0; c < numC; c++){
    const cname = classes[c];
    exportResult.class_grid[cname] = bestC[c].map(x => x ? [teachers[x.tIdx], x.subj, x.text] : null);
  }
  fs.writeFileSync('./optimized_tkb.json', JSON.stringify(exportResult, null, 2), 'utf8');
  console.log("Saved optimized_tkb.json!");
}

solveSA();
