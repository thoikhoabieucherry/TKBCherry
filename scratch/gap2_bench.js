// Benchmark nut "2 tiet trong": chay dung duong ma worker chay
//   node scratch/gap2_bench.js <file.json> [capMs] [seed]
const fs = require('fs');
const path = require('path');
global.self = global;
require(process.env.ENGINE_OVERRIDE ? path.resolve(process.env.ENGINE_OVERRIDE) : path.resolve(__dirname, '../web/pages/tkb-fet-engine.js'));
const Engine = global.FetTimetableEngine;

const file = process.argv[2];
const capMs = Number(process.argv[3] || 60000);
const seed = Number(process.argv[4] || 12345);

const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const eng = new Engine(data, { uiBreathingMs: 0, optimizeHardCapMs: capMs, seed });
eng.loadExistingSchedule();
const before = eng.evaluateMetrics();
console.log('FILE  ', path.basename(file), 'cap=', capMs, 'seed=', seed);
console.log('TRUOC ', JSON.stringify({ gap2: before.soBuoiTrong2, s1: before.soBuoiDay1, buoi: before.tsBuoiDay, gap1: before.soBuoiTrong1 }));

const t0 = Date.now();
let lastPct = -1;
eng.optimizeGap2WithBorrow((p) => {
  if (p.percent !== lastPct && p.percent % 25 === 0) {
    lastPct = p.percent;
    process.stdout.write(`  [${p.percent}%] gap2=${p.currentMetric} t=${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
  }
}).then((res) => {
  const m = res.metrics;
  console.log('SAU   ', JSON.stringify({ gap2: m.soBuoiTrong2, s1: m.soBuoiDay1, buoi: m.tsBuoiDay, gap1: m.soBuoiTrong1 }));
  console.log('THOIGIAN', ((Date.now() - t0) / 1000).toFixed(1) + 's', '| borrowed=', res.borrowed === true);
  const eng2 = new Engine(data, { uiBreathingMs: 0 });
  eng2.loadExistingSchedule();
  const check = eng2.evaluateMetrics();
  console.log('KIEM CHUNG tu data.tkb', JSON.stringify({ gap2: check.soBuoiTrong2, s1: check.soBuoiDay1, buoi: check.tsBuoiDay, gap1: check.soBuoiTrong1 }));
  console.log('TOAN VEN', eng2.verifyPlacementIntegrity());
}).catch(e => { console.error('LOI', e); process.exit(1); });
