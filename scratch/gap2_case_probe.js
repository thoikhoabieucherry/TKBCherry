// Mo xe sau mot ca gap2 con ton dong tren trang thai da ket.
//   node scratch/gap2_case_probe.js scratch/live_default_stuck.json
const fs = require('fs');
const path = require('path');
global.self = global;
require(path.resolve(__dirname, '../web/pages/tkb-fet-engine.js'));
const Engine = global.FetTimetableEngine;

const file = process.argv[2] || 'scratch/live_default_stuck.json';
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const e = new Engine(data, { uiBreathingMs: 0 });
e.loadExistingSchedule();
e.strictFetGaps = true;

const DAYS = ['thu2', 'thu3', 'thu4', 'thu5', 'thu6', 'thu7'];
const PER = 5, SPD = 10;
const m = e.evaluateMetrics();
console.log('metrics', JSON.stringify({ gap2: m.soBuoiTrong2, s1: m.soBuoiDay1, buoi: m.tsBuoiDay, gap1: m.soBuoiTrong1 }));

const desc = (id) => {
  if (id === -3) return 'CO-DINH';
  if (id < 0) return '.';
  const a = e.activities[id];
  return `${a.classId}/${a.mon}${a.duration > 1 ? 'x' + a.duration : ''}${a.isFixed ? '(CD)' : ''}`;
};

e.teacherGrid.forEach((grid, tKey) => {
  if (!tKey || !e.isScoredTeacher(tKey)) return;
  for (let d = 0; d < 6; d++) {
    for (let b = 0; b < 2; b++) {
      const sStart = d * SPD + b * PER;
      const taught = [];
      for (let p = 0; p < PER; p++) if (grid[sStart + p] >= 0 || grid[sStart + p] === -3) taught.push(p);
      if (taught.length < 2) continue;
      const span = taught[taught.length - 1] - taught[0] + 1;
      if (span - taught.length < 2) continue;

      console.log('\n================================================');
      console.log(`CA KET: GV=${tKey} ${DAYS[d]} ${b === 0 ? 'sang' : 'chieu'}`);
      console.log('  buoi:', Array.from({ length: PER }, (_, p) => `p${p}=${desc(grid[sStart + p])}`).join(' | '));

      // Lich tuan cua GV
      console.log('  --- lich tuan cua GV ---');
      for (let d2 = 0; d2 < 6; d2++) {
        const row = [];
        for (let b2 = 0; b2 < 2; b2++) {
          const st = d2 * SPD + b2 * PER;
          let cnt = 0;
          for (let p = 0; p < PER; p++) if (grid[st + p] >= 0 || grid[st + p] === -3) cnt++;
          row.push((b2 === 0 ? 'S' : 'C') + ':' + Array.from({ length: PER }, (_, p) => (grid[st + p] >= 0 || grid[st + p] === -3) ? 'X' : '-').join(''));
        }
        console.log('   ', DAYS[d2], row.join('  '));
      }

      // Voi tiet MEP (dau/cuoi) — thu dua di khap noi, xem vuong gi
      for (const p of taught) {
        const id = grid[sStart + p];
        if (id < 0) continue;
        const act = e.activities[id];
        if (!act || act.isFixed) continue;
        if (e.actPlacement[id] !== sStart + p) continue; // chi lay o dau cua block
        const home = e.actPlacement[id];
        e.unplaceActivity(id);
        const rows = [];
        for (let s = 0; s < 60; s++) {
          const c = e.getConflictsForSlot(act, s);
          const dd = Math.floor(s / SPD), bb = Math.floor((s % SPD) / PER), pp = s % PER;
          if (!c.possible) continue;
          rows.push(`${DAYS[dd]}${bb === 0 ? 'S' : 'C'}p${pp}${c.conflicts.length ? '(day ' + c.conflicts.length + ': ' + c.conflicts.map(x => desc(x)).join(',') + ')' : '(TRONG)'}`);
        }
        console.log(`  --- tiet p${p} = ${act.classId}/${act.mon} x${act.duration}: ${rows.length} cho hop le`);
        console.log('      ', rows.slice(0, 24).join('  '));
        // thu tha luat gap
        e.strictFetGaps = false;
        const relaxed = [];
        for (let s = 0; s < 60; s++) {
          const c = e.getConflictsForSlot(act, s);
          if (!c.possible) continue;
          const dd = Math.floor(s / SPD), bb = Math.floor((s % SPD) / PER), pp = s % PER;
          relaxed.push(`${DAYS[dd]}${bb === 0 ? 'S' : 'C'}p${pp}${c.conflicts.length ? '/' + c.conflicts.length : '/TRONG'}`);
        }
        e.strictFetGaps = true;
        console.log(`      (tha luat gap: ${relaxed.length} cho) ${relaxed.slice(0, 24).join('  ')}`);
        e.placeActivityDirect(id, home);
      }

      // Cac lo: ai chiem o lop tuong ung
      for (let p = taught[0]; p <= taught[taught.length - 1]; p++) {
        if (taught.includes(p)) continue;
        console.log(`  --- lo p${p}: o cua cac lop ma GV nay day`);
        const classes = new Set();
        for (const q of taught) { const id = grid[sStart + q]; if (id >= 0) classes.add(e.activities[id].classId); }
        for (const cid of classes) {
          const cg = e.classGrid.get(cid);
          console.log(`      lop ${cid} p${p} = ${cg ? desc(cg[sStart + p]) : '?'}`);
        }
      }
    }
  }
});
