const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('./test_state_0917.json', 'utf8'));
const engineCode = fs.readFileSync('../web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const solver = new globalThis.FetTimetableEngine(schoolData);
solver.loadExistingSchedule();

console.log("=== BENCHMARKING FULL EVALUATION VS LOCAL DELTA ===");

// 1. Full evaluateMetrics 10,000 times
const t0 = Date.now();
for(let i = 0; i < 10000; i++){
  solver.evaluateMetrics();
}
const t1 = Date.now();
console.log(`10,000 Full evaluateMetrics(): ${t1 - t0}ms (${Math.round(10000 / ((t1-t0)/1000))} evals/sec)`);

// 2. Incremental evaluateTeacherMetrics for 2 teachers 10,000 times
function evalDelta(tKeys){
  let s1 = 0, s2 = 0, g2 = 0;
  for(const tKey of tKeys){
    const grid = solver.teacherGrid.get(tKey);
    if(!grid) continue;
    for(let d = 0; d < 6; d++){
      for(let b = 0; b < 2; b++){
        const sStart = d * 10 + b * 5;
        let cnt = 0;
        for(let p = 0; p < 5; p++){
          if(grid[sStart + p] >= 0 || grid[sStart + p] === -3) cnt++;
        }
        if(cnt === 1) s1++;
        else if(cnt === 2) s2++;
      }
    }
  }
  return { s1, s2, g2 };
}

const testTeachers = ['t.minh', 'a.minh'];
const t2 = Date.now();
for(let i = 0; i < 10000; i++){
  evalDelta(testTeachers);
}
const t3 = Date.now();
console.log(`10,000 Local Delta evals: ${t3 - t2}ms (${Math.round(10000 / ((t3-t2)/1000))} evals/sec)`);
console.log(`SPEEDUP: ${(t1 - t0) / Math.max(1, (t3 - t2))}x faster!`);
