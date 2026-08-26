// Chay nut "2 tiet trong" den khi ket, luu trang thai ket, roi mo xe tung ca ton dong.
//   node scratch/gap2_diag.js <file.json> [capMs]
const fs = require('fs');
const path = require('path');
global.self = global;
require(path.resolve(__dirname, '../web/pages/tkb-fet-engine.js'));
const Engine = global.FetTimetableEngine;

const file = process.argv[2] || 'scratch/live_default.json';
const capMs = Number(process.argv[3] || 90000);
const stuckPath = file.replace(/\.json$/, '_stuck.json');

const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const eng = new Engine(data, { uiBreathingMs: 0, optimizeHardCapMs: capMs, seed: 12345 });
eng.loadExistingSchedule();
const before = eng.evaluateMetrics();
console.log('TRUOC', JSON.stringify({ gap2: before.soBuoiTrong2, s1: before.soBuoiDay1, buoi: before.tsBuoiDay, gap1: before.soBuoiTrong1 }));

eng.optimizeGap2WithBorrow(null).then((res) => {
  const m = res.metrics;
  console.log('SAU  ', JSON.stringify({ gap2: m.soBuoiTrong2, s1: m.soBuoiDay1, buoi: m.tsBuoiDay, gap1: m.soBuoiTrong1 }));
  fs.writeFileSync(stuckPath, JSON.stringify(data));
  console.log('Da luu trang thai ket ->', stuckPath);

  // ==== MO XE ====
  const e2 = new Engine(data, { uiBreathingMs: 0 });
  e2.loadExistingSchedule();
  e2.strictFetGaps = true;
  const DAYS = 6, SESS = 2, PER = 5, SLOTS_PER_DAY = 10;
  const resid = e2.getResidualGap2Sessions();
  console.log('\n=== ' + resid.length + ' CA TON DONG ===');

  for (const r of resid) {
    const tKey = r.teacher;
    const grid = e2.teacherGrid.get(tKey);
    // tim lai day/session
    for (let d = 0; d < DAYS; d++) {
      for (let b = 0; b < SESS; b++) {
        const sStart = d * SLOTS_PER_DAY + b * PER;
        const taught = [];
        for (let p = 0; p < PER; p++) {
          const s = sStart + p;
          if (grid[s] >= 0 || grid[s] === -3) taught.push({ p, s, actId: grid[s] });
        }
        if (taught.length < 2) continue;
        const span = taught[taught.length - 1].p - taught[0].p + 1;
        if (span - taught.length < 2) continue;

        const info = taught.map(t => {
          const a = t.actId >= 0 ? e2.activities[t.actId] : null;
          return `p${t.p}:${a ? (a.lop || a.classId) + '/' + a.mon + (a.duration > 1 ? 'x' + a.duration : '') + (a.isFixed ? '(CD)' : '') : 'CO-DINH'}`;
        }).join(' ');
        console.log(`\nGV ${tKey} | ${r.day} ${r.session} | ${info} | ly do=${r.reason}`);

        // Voi tung tiet trong buoi: dem cho di duoc
        for (const t of taught) {
          if (t.actId < 0) continue;
          const act = e2.activities[t.actId];
          if (!act || act.isFixed) continue;
          const home = e2.actPlacement[act.id];
          e2.unplaceActivity(act.id);
          let free = 0, needEject = 0, sameSessionFree = 0;
          for (let s = 0; s < DAYS * SLOTS_PER_DAY; s++) {
            const c = e2.getConflictsForSlot(act, s);
            if (!c.possible) continue;
            if (c.conflicts.length === 0) { free++; if (s >= sStart && s < sStart + PER) sameSessionFree++; }
            else needEject++;
          }
          // thu lai voi strictFetGaps tat
          e2.strictFetGaps = false;
          let freeRelaxed = 0;
          for (let s = 0; s < DAYS * SLOTS_PER_DAY; s++) {
            const c = e2.getConflictsForSlot(act, s);
            if (c.possible && c.conflicts.length === 0) freeRelaxed++;
          }
          e2.strictFetGaps = true;
          e2.placeActivityDirect(act.id, home);
          console.log(`   tiet p${t.p} ${act.lop || act.classId}/${act.mon}: o-trong-hop-le=${free} (trong-buoi=${sameSessionFree}) | can-day-tiet=${needEject} | neu-tha-luat-gap=${freeRelaxed}`);
        }

        // lo trong cua buoi: ai co the lap?
        const holes = [];
        for (let p = taught[0].p; p <= taught[taught.length - 1].p; p++) {
          if (!taught.some(t => t.p === p)) holes.push(p);
        }
        console.log('   lo trong tai p:', holes.join(','));
        for (const hp of holes) {
          const s = sStart + hp;
          // ai co the vao? tim cac tiet cua CHINH GV nay o noi khac
          let cands = 0;
          for (let id = 0; id < e2.activities.length; id++) {
            const a = e2.activities[id];
            if (!a || a.isFixed || a.duration !== 1) continue;
            if (!a.gv || String(a.gv).indexOf(tKey) < 0) continue;
            if (e2.actPlacement[id] === s) continue;
            const home2 = e2.actPlacement[id];
            if (home2 < 0) continue;
            e2.unplaceActivity(id);
            const c = e2.getConflictsForSlot(a, s);
            if (c.possible) cands++;
            e2.placeActivityDirect(id, home2);
          }
          console.log(`     lo p${hp}: so tiet cua GV nay co the chuyen vao (ke ca phai day tiet khac) = ${cands}`);
        }
      }
    }
  }
}).catch(e => { console.error('LOI', e); process.exit(1); });
