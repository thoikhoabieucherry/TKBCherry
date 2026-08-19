global.self = global;
require('c:/Users/Love/Documents/Codex/TKBCherry/web/pages/tkb-fet-engine.js');
const Engine = global.FetTimetableEngine;
const eng = new Engine({}, {});

const a = { soBuoiDay1: 18, soBuoiTrong2: 44, tsBuoiDay: 768, tsNgayDay: 670, soBuoiTrong1: 206 };
const b = { soBuoiDay1: 72, soBuoiTrong2: 40, tsBuoiDay: 768, tsNgayDay: 670, soBuoiTrong1: 206 };

console.log('compareMetrics(a, b, "optimize_singletons"):', eng.compareMetrics(a, b, 'optimize_singletons'));
console.log('compareMetrics(a, b, "optimize_gap2"):', eng.compareMetrics(a, b, 'optimize_gap2'));
console.log('compareMetrics(a, b, "optimize_sessions"):', eng.compareMetrics(a, b, 'optimize_sessions'));
console.log('compareMetrics(a, b, "optimize_gap1"):', eng.compareMetrics(a, b, 'optimize_gap1'));
