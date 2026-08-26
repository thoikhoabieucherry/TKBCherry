// Do chi so hien trang cua cac bo du lieu co san: gap2 / s1 / buoi
const fs = require('fs');
const path = require('path');
global.self = global;
require(path.resolve(__dirname, '../web/pages/tkb-fet-engine.js'));
const Engine = global.FetTimetableEngine;

const files = process.argv.slice(2);
for (const f of files) {
  try {
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    const eng = new Engine(data, { uiBreathingMs: 0 });
    if (typeof eng.init === 'function') eng.init();
    eng.loadExistingSchedule();
    const m = eng.evaluateMetrics();
    console.log(path.basename(f).padEnd(34),
      'lop=' + (data.lop?.length ?? '-'),
      'gv=' + (data.giaovien?.length ?? data.gv?.length ?? '-'),
      '| gap2=' + m.soBuoiTrong2,
      's1=' + m.soBuoiDay1,
      'buoi=' + m.tsBuoiDay,
      'gap1=' + m.soBuoiTrong1);
  } catch (e) {
    console.log(path.basename(f).padEnd(34), 'ERR', String(e.message).slice(0, 120));
  }
}
