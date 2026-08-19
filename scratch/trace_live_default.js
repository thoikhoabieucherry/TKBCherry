const fs = require('fs');
global.self = global;
require('c:/Users/Love/Documents/Codex/TKBCherry/web/pages/tkb-fet-engine.js');
const Engine = global.FetTimetableEngine;

const data = JSON.parse(fs.readFileSync('c:/Users/Love/Documents/Codex/TKBCherry/scratch/live_default.json', 'utf8'));
const eng = new Engine(data, { mode: 'optimize_singletons', uiBreathingMs: 0 });
eng.init();
eng.loadExistingSchedule();

console.log('Initial metrics:', JSON.stringify(eng.evaluateMetrics()));

const methods = [
  'obliterateAllTeacherSingletons',
  'tryIntraClassCrossSubjectSingletonSwap',
  'tryAugmentingSingletonEjectionChain',
  'tryTargetedDeepSingletonChain',
  'tryReinforceTeacherSingletons',
  'tryConsolidateTeacherSingletons',
  'tryPairTeacherSingletonsToEmptySession'
];

methods.forEach(m => {
  const orig = eng[m];
  if (orig) {
    eng[m] = function(...args) {
      const t0 = Date.now();
      const res = orig.apply(this, args);
      const dur = Date.now() - t0;
      if (dur > 500 || res) {
        console.log(`[OPERATOR] ${m}: took ${dur}ms, improved: ${!!res}`);
      }
      return res;
    };
  }
});

let round = 0;
eng.optimize('optimize_singletons', (p) => {
  console.log(`[PROGRESS] Round update - metric: ${p.currentMetric}, percent: ${p.percent}%`);
}).then(res => {
  console.log('Finished optimize_singletons! Final metrics:', JSON.stringify(res.metrics));
}).catch(console.error);
