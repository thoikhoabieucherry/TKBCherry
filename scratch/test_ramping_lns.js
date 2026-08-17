const fs = require('fs');
const vm = require('vm');

const mockElement = { appendChild: () => {}, removeChild: () => {}, style: {}, setAttribute: () => {}, getAttribute: () => '', classList: { add: () => {}, remove: () => {}, contains: () => false } };
const windowObj = { console, Math, Date, Set, Map, Array, Object, parseInt, parseFloat, isNaN, isFinite, String, Number, Boolean, RegExp, JSON, setTimeout, clearTimeout, document: { createElement: () => mockElement, head: mockElement, body: mockElement, getElementById: () => mockElement, querySelector: () => mockElement, querySelectorAll: () => [] } };
windowObj.window = windowObj; windowObj.global = windowObj; windowObj.self = windowObj;
const ctx = vm.createContext(windowObj);
vm.runInContext(fs.readFileSync('./web/pages/tkb-constraints.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync('./web/pages/tkb-fet-engine.js', 'utf8'), ctx);

const schoolData = JSON.parse(fs.readFileSync('C:\\\\Users\\\\Love\\\\.gemini\\\\antigravity\\\\brain\\\\e6e653cb-e567-476a-85f0-e418e6636dc4\\\\scratch\\\\school_default_vps.json', 'utf8'));

async function testRampingLns() {
  const solveEngine = new windowObj.FetTimetableEngine(schoolData);
  await solveEngine.solve();
  const initialTkb = solveEngine.getSnapshotTKB();

  // Run initial optimize to reach 8 singletons
  const optEngine = new windowObj.FetTimetableEngine({ ...schoolData, tkb: JSON.parse(JSON.stringify(initialTkb)) });
  optEngine.loadExistingSchedule();

  let bestMetrics = optEngine.evaluateMetrics();
  console.log('Start metrics:', bestMetrics);

  let destroyStrength = 1;
  let stagnantCount = 0;
  const startTime = Date.now();

  for (let round = 1; round <= 60; round++) {
    let improved = false;

    // 1. Obliteration
    const mOblit = optEngine.obliterateAllTeacherSingletons(15, bestMetrics.soBuoiTrong2);
    if (mOblit && mOblit.soBuoiDay1 < bestMetrics.soBuoiDay1) {
      bestMetrics = { ...mOblit };
      improved = true;
      console.log(`Round ${round} (Oblit): soBuoiDay1=${bestMetrics.soBuoiDay1}`);
    }

    // 2. Reinforce
    const mReinf = optEngine.tryReinforceTeacherSingletons(bestMetrics, bestMetrics, bestMetrics.soBuoiTrong2);
    if (mReinf && mReinf.soBuoiDay1 < bestMetrics.soBuoiDay1) {
      bestMetrics = { ...mReinf };
      improved = true;
      console.log(`Round ${round} (Reinf): soBuoiDay1=${bestMetrics.soBuoiDay1}`);
    }

    // 3. Consolidate
    const mConsol = optEngine.tryConsolidateTeacherSingletons(bestMetrics, bestMetrics, bestMetrics.soBuoiTrong2);
    if (mConsol && mConsol.soBuoiDay1 < bestMetrics.soBuoiDay1) {
      bestMetrics = { ...mConsol };
      improved = true;
      console.log(`Round ${round} (Consol): soBuoiDay1=${bestMetrics.soBuoiDay1}`);
    }

    // 4. LNS Ruin & Recreate with ramping strength
    if (!improved && bestMetrics.soBuoiDay1 > 0) {
      const singlesMap = new Map();
      optEngine.teacherGrid.forEach((grid, tKey) => {
        if (!tKey) return;
        for (let d = 0; d < 6; d++) {
          for (let b = 0; b < 2; b++) {
            const sStart = d * 10 + b * 5;
            let cnt = 0;
            for (let p = 0; p < 5; p++) {
              if (grid[sStart + p] >= 0 || grid[sStart + p] === -3) cnt++;
            }
            if (cnt === 1) singlesMap.set(tKey, (singlesMap.get(tKey) || 0) + 1);
          }
        }
      });

      const singleTeachers = Array.from(singlesMap.keys());
      if (singleTeachers.length > 0) {
        optEngine.rng.shuffle(singleTeachers);
        const count = Math.min(singleTeachers.length, destroyStrength);
        const targets = singleTeachers.slice(0, count);

        const mLns = optEngine.tryLnsRuinAndRecreate(targets, bestMetrics, bestMetrics.soBuoiTrong2);
        if (mLns && mLns.soBuoiDay1 < bestMetrics.soBuoiDay1) {
          bestMetrics = { ...mLns };
          improved = true;
          destroyStrength = 1;
          console.log(`Round ${round} (LNS strength ${count}): soBuoiDay1=${bestMetrics.soBuoiDay1}`);
        } else {
          destroyStrength = Math.min(destroyStrength + 1, 6);
        }
      }
    }

    if (improved) {
      stagnantCount = 0;
    } else {
      stagnantCount++;
    }

    if (bestMetrics.soBuoiDay1 === 0) {
      console.log('REACHED 0 SINGLETONS!');
      break;
    }

    if (stagnantCount >= 25) {
      console.log('Stagnant for 25 rounds, stopping.');
      break;
    }
  }

  console.log(`Total time: ${((Date.now() - startTime) / 1000).toFixed(2)}s`);
  console.log('Final Metrics:', bestMetrics);

  const finalTkb = optEngine.getSnapshotTKB();
  schoolData.tkb = finalTkb;
  windowObj.TKBConstraints.invalidateConstraintCache();
  const vFinal = windowObj.TKBConstraints.validateAll(3000) || [];
  console.log('Final TKBConstraints violations:', vFinal.length);
}

testRampingLns();
