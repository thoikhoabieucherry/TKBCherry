// Chay dung nhu UI: KHONG truyen seed -> kiem tra moi lan bam co khac nhau khong
//   node scratch/gap2_bench_noseed.js <file.json> [capMs]
const fs = require('fs');
const path = require('path');
global.self = global;
require(path.resolve(__dirname, '../web/pages/tkb-fet-engine.js'));
const Engine = global.FetTimetableEngine;

const file = process.argv[2];
const capMs = Number(process.argv[3] || 240000);

const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const eng = new Engine(data, { uiBreathingMs: 0, optimizeHardCapMs: capMs }); // khong co seed
eng.loadExistingSchedule();
const b = eng.evaluateMetrics();
const t0 = Date.now();
eng.optimizeGap2WithBorrow(null).then(res => {
  const m = res.metrics;
  console.log(`gap2 ${b.soBuoiTrong2}->${m.soBuoiTrong2}  s1 ${b.soBuoiDay1}->${m.soBuoiDay1}  buoi ${b.tsBuoiDay}->${m.tsBuoiDay}  gap1 ${b.soBuoiTrong1}->${m.soBuoiTrong1}  ${((Date.now() - t0) / 1000).toFixed(0)}s borrowed=${res.borrowed === true}`);
});
