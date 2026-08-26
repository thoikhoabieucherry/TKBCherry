// Ep tung nuoc di ung vien cho ca gap2 con ton dong -> xem metrics thay doi ra sao.
//   node scratch/gap2_force_probe.js scratch/live_default_stuck.json
const fs = require('fs');
const path = require('path');
global.self = global;
require(path.resolve(__dirname, '../web/pages/tkb-fet-engine.js'));
const Engine = global.FetTimetableEngine;

const file = process.argv[2] || 'scratch/live_default_stuck.json';
const raw = fs.readFileSync(file, 'utf8');
const DAYS = ['thu2', 'thu3', 'thu4', 'thu5', 'thu6', 'thu7'];
const PER = 5, SPD = 10;

function fresh(seed) {
  const data = JSON.parse(raw);
  const e = new Engine(data, { uiBreathingMs: 0, seed });
  e.loadExistingSchedule();
  e.strictFetGaps = true;
  return e;
}

const base = fresh(1);
const bm = base.evaluateMetrics();
console.log('goc', JSON.stringify({ gap2: bm.soBuoiTrong2, s1: bm.soBuoiDay1, buoi: bm.tsBuoiDay, gap1: bm.soBuoiTrong1 }));

// tim ca ket
let cases = [];
base.teacherGrid.forEach((grid, tKey) => {
  if (!tKey || !base.isScoredTeacher(tKey)) return;
  for (let d = 0; d < 6; d++) for (let b = 0; b < 2; b++) {
    const sStart = d * SPD + b * PER;
    const taught = [];
    for (let p = 0; p < PER; p++) if (grid[sStart + p] >= 0 || grid[sStart + p] === -3) taught.push(p);
    if (taught.length < 2) continue;
    if (taught[taught.length - 1] - taught[0] + 1 - taught.length < 2) continue;
    cases.push({ tKey, d, b, sStart, taught });
  }
});
console.log('so ca:', cases.length);

for (const cs of cases) {
  const g0 = base.teacherGrid.get(cs.tKey);
  const actIds = [];
  for (const p of cs.taught) {
    const id = g0[cs.sStart + p];
    if (id >= 0 && base.actPlacement[id] === cs.sStart + p) actIds.push(id);
  }
  console.log(`\n### GV ${cs.tKey} ${DAYS[cs.d]}${cs.b === 0 ? 'S' : 'C'} taught=${cs.taught.join(',')}`);

  for (const id of actIds) {
    const actProbe = base.activities[id];
    if (!actProbe || actProbe.isFixed) continue;
    for (let target = 0; target < 60; target++) {
      for (const seed of [11, 22, 33]) {
        const e = fresh(seed);
        const act = e.activities[id];
        const home = e.actPlacement[id];
        if (home === target) continue;
        e.unplaceActivity(id);
        const c = e.getConflictsForSlot(act, target);
        if (!c.possible) continue;
        e.limitCalls = 200000; e.nCalls = 0;
        const ok = e.randomSwap(id, 0, [target]);
        if (!ok) continue;
        if (!e.verifyPlacementIntegrity()) continue;
        const m = e.evaluateMetrics();
        if (m.soBuoiTrong2 >= bm.soBuoiTrong2) continue;
        const dd = Math.floor(target / SPD), bb = Math.floor((target % SPD) / PER), pp = target % PER;
        console.log(`  ${act.classId}/${act.mon}x${act.duration} -> ${DAYS[dd]}${bb === 0 ? 'S' : 'C'}p${pp} seed${seed}: gap2 ${bm.soBuoiTrong2}->${m.soBuoiTrong2}  s1 ${bm.soBuoiDay1}->${m.soBuoiDay1}  buoi ${bm.tsBuoiDay}->${m.tsBuoiDay}  gap1 ${bm.soBuoiTrong1}->${m.soBuoiTrong1}`);
        break;
      }
    }
  }
}
