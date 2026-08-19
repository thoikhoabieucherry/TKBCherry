const fs = require('fs');
global.self = global;
require('c:/Users/Love/Documents/Codex/TKBCherry/web/pages/tkb-fet-engine.js');
const Engine = global.FetTimetableEngine;

const data = JSON.parse(fs.readFileSync('c:/Users/Love/Documents/Codex/TKBCherry/scratch/live_default.json', 'utf8'));

const eng = new Engine(data, { uiBreathingMs: 0 });

console.log('=== STARTING OPTIMIZE_ALL BENCHMARK ON LIVE DEFAULT ===');
const startTime = Date.now();

let lastStage = '';
eng.optimizeAll((prog) => {
  if (prog.stage !== lastStage) {
    lastStage = prog.stage;
    console.log(`[STAGE] ${prog.stage} (${prog.percent}%)`);
  }
}).then(res => {
  const duration = Date.now() - startTime;
  console.log(`\n=== OPTIMIZE_ALL FINISHED IN ${duration}ms ===`);
  console.log('Initial metrics:', JSON.stringify(res.initialMetrics));
  console.log('Final metrics:  ', JSON.stringify(res.metrics));
  console.log('Singletons:     ', `${res.initialMetrics.soBuoiDay1} -> ${res.metrics.soBuoiDay1}`);
  console.log('1-tiet-ngay:    ', `${res.initialMetrics.soNgayMotTiet} -> ${res.metrics.soNgayMotTiet}`);
  console.log('Gaps 2:         ', `${res.initialMetrics.soBuoiTrong2} -> ${res.metrics.soBuoiTrong2}`);
  console.log('Gaps 1:         ', `${res.initialMetrics.soBuoiTrong1} -> ${res.metrics.soBuoiTrong1}`);
  console.log('Sessions:       ', `${res.initialMetrics.tsBuoiDay} -> ${res.metrics.tsBuoiDay}`);
  console.log('Integrity OK?   ', eng.verifyPlacementIntegrity());
}).catch(err => {
  console.error('Error in optimizeAll:', err);
});
