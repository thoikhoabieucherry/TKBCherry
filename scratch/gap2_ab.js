// A/B: tat/bat operator moi de do dong gop that su
//   node scratch/gap2_ab.js <file.json> <capMs> <seed> <off|on>
const fs = require('fs');
const path = require('path');
global.self = global;
require(path.resolve(__dirname, '../web/pages/tkb-fet-engine.js'));
const Engine = global.FetTimetableEngine;

const file = process.argv[2];
const capMs = Number(process.argv[3] || 90000);
const seed = Number(process.argv[4] || 12345);
const mode = process.argv[5] || 'on';

if (mode === 'off') Engine.prototype.tryGap2EjectWithCompanion = function () { return null; };

const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const eng = new Engine(data, { uiBreathingMs: 0, optimizeHardCapMs: capMs, seed });
eng.loadExistingSchedule();
const b = eng.evaluateMetrics();
const t0 = Date.now();
eng.optimizeGap2WithBorrow(null).then(res => {
  const m = res.metrics;
  console.log(`operator=${mode.padEnd(3)} seed=${String(seed).padEnd(9)} gap2 ${b.soBuoiTrong2}->${m.soBuoiTrong2}  s1 ${b.soBuoiDay1}->${m.soBuoiDay1}  buoi ${b.tsBuoiDay}->${m.tsBuoiDay}  gap1 ${b.soBuoiTrong1}->${m.soBuoiTrong1}  ${((Date.now() - t0) / 1000).toFixed(0)}s borrowed=${res.borrowed === true}`);
});
