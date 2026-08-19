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

const teacherMap = new Map();
teachers.forEach((t, i) => teacherMap.set(t, i));
const classMap = new Map();
classes.forEach((c, i) => classMap.set(c, i));

const numT = teachers.length;
const numC = classes.length;

let initialTGrid = Array.from({length: numT}, () => Array(60).fill(null));
let initialCGrid = Array.from({length: numC}, () => Array(60).fill(null));

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
      initialTGrid[t][s] = cellObj;
      initialCGrid[cIdx][s] = cellObj;
    }
  }
}

// Check which teachers are exempted:
// "cô Sương" -> TN.Sương
// "thầy Khánh" -> A.Khánh
const exemptedTeachers = new Set(['TN.Sương', 'A.Khánh']);
const exemptedTIdxs = new Set();
exemptedTeachers.forEach(t => {
  if(teacherMap.has(t)) exemptedTIdxs.add(teacherMap.get(t));
});

console.log("Exempted teachers:", Array.from(exemptedTeachers), "Indices:", Array.from(exemptedTIdxs));

function countSingletons(tg, ignoreExempted = true){
  let count = 0;
  const singletonsList = [];
  for(let t = 0; t < numT; t++){
    if(ignoreExempted && exemptedTIdxs.has(t)) continue;
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

function cloneGrid(g){
  return g.map(row => row.slice());
}

console.log("Initial non-exempted singletons:", countSingletons(initialTGrid, true).count);
console.log("Initial total singletons:", countSingletons(initialTGrid, false).count);

// Optimize using multi-stage Simulated Annealing + Targeted Ruin & Recreate
function runSearch(){
  let currT = cloneGrid(initialTGrid);
  let currC = cloneGrid(initialCGrid);
  
  let bestT = cloneGrid(currT);
  let bestC = cloneGrid(currC);
  
  let bestSing = countSingletons(bestT, true).count;
  let bestGaps = countGaps(bestT);
  let bestScore = bestSing * 10000 + bestGaps * 10;
  
  console.log(`Starting search: Target is 0 non-exempted singletons (Current: ${bestSing})`);
  
  const MAX_RESTARTS = 20;
  
  for(let restart = 0; restart < MAX_RESTARTS; restart++){
    if(bestSing === 0) break;
    
    // Start from best so far or perturbation
    currT = cloneGrid(bestT);
    currC = cloneGrid(bestC);
    
    let temp = 200.0;
    const cooling = 0.99998;
    const iters = 800000;
    
    let currScore = bestScore;
    
    for(let it = 0; it < iters; it++){
      const { singletonsList } = countSingletons(currT, true);
      if(singletonsList.length === 0){
        bestSing = 0;
        bestT = cloneGrid(currT);
        bestC = cloneGrid(currC);
        console.log(`\n🎉 REACHED EXACTLY 0 NON-EXEMPTED SINGLETONS AT RESTART ${restart}, ITER ${it}!`);
        break;
      }
      
      let cIdx;
      if(Math.random() < 0.75){
        // Pick class associated with a singleton
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
      
      if(item1 !== null && offSet.has(s2)) continue;
      if(item2 !== null && offSet.has(s1)) continue;
      
      const t1 = item1 ? item1.tIdx : -1;
      const t2 = item2 ? item2.tIdx : -1;
      
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
      
      const curSings = countSingletons(currT, true).count;
      const curGaps = countGaps(currT);
      const newScore = curSings * 10000 + curGaps * 10;
      const delta = newScore - currScore;
      
      if(delta < 0 || (temp > 0.0001 && Math.random() < Math.exp(-delta / temp))){
        currScore = newScore;
        if(newScore < bestScore || curSings < bestSing){
          if(curSings < bestSing){
            bestSing = curSings;
            console.log(`[Restart ${restart} Iter ${it}] NEW BEST SINGLETONS: ${bestSing} (Gaps: ${curGaps})`);
          }
          bestScore = newScore;
          bestT = cloneGrid(currT);
          bestC = cloneGrid(currC);
        }
      } else {
        // Revert
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
    }
  }
  
  console.log("\n==================== RESULT SUMMARY ====================");
  const finalNonExempt = countSingletons(bestT, true);
  const finalAll = countSingletons(bestT, false);
  console.log("Non-exempted Singletons (mục tiêu):", finalNonExempt.count);
  console.log("Total Singletons (tính cả cô Sương & thầy Khánh):", finalAll.count);
  
  console.log("\nChi tiết các tiết lẻ còn lại (nếu có):");
  for(const s of finalAll.singletonsList){
    const info = slotInfo[s.slot];
    console.log(`- GV ${s.tname}: Thứ ${info.day} ${info.session} Tiết ${info.period} (${s.cell.text})`);
  }
  
  // Verify constraints
  let valid = true;
  for(let c = 0; c < numC; c++){
    const cname = classes[c];
    const offSet = classOffSlots[cname] || new Set();
    for(let s = 0; s < 60; s++){
      if(bestC[c][s] !== null && offSet.has(s)){
        console.error(`VIOLATION: Class ${cname} in off-period at slot ${s}!`);
        valid = false;
      }
    }
  }
  if(valid) console.log("✅ 100% TIẾT NGHỈ ĐƯỢC BẢO TOÀN HOÀN TOÀN!");
  
  // Check overlaps
  let overlap = false;
  for(let s = 0; s < 60; s++){
    const seenC = new Set();
    for(let t = 0; t < numT; t++){
      if(bestT[t][s] !== null){
        const cIdx = bestT[t][s].cIdx;
        if(seenC.has(cIdx)){
          console.error(`OVERLAP: Class ${classes[cIdx]} has multiple teachers at slot ${s}!`);
          overlap = true;
        }
        seenC.add(cIdx);
      }
    }
  }
  if(!overlap) console.log("✅ 100% KHÔNG CÓ TRÙNG LỊCH!");
  
  // Find diff / changes from initial
  let diffCount = 0;
  const changes = [];
  for(let c = 0; c < numC; c++){
    const cname = classes[c];
    for(let s = 0; s < 60; s++){
      const initItem = initialCGrid[c][s];
      const bestItem = bestC[c][s];
      const initTxt = initItem ? initItem.text : "Trống";
      const bestTxt = bestItem ? bestItem.text : "Trống";
      if(initTxt !== bestTxt){
        diffCount++;
      }
    }
  }
  console.log(`Total slot changes across all classes: ${diffCount}`);
  
  // Save result
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
  fs.writeFileSync('./perfect_zero_singletons.json', JSON.stringify(exportResult, null, 2), 'utf8');
  console.log("Saved perfect_zero_singletons.json!");
}

runSearch();
