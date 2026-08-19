const fs = require('fs');
global.self = global;
require('c:/Users/Love/Documents/Codex/TKBCherry/web/pages/tkb-fet-engine.js');
const Engine = global.FetTimetableEngine;

const data = JSON.parse(fs.readFileSync('c:/Users/Love/Documents/Codex/TKBCherry/scratch/live_default.json', 'utf8'));
const eng = new Engine(data, { uiBreathingMs: 0 });
eng.init();
eng.loadExistingSchedule();

console.log('Teacher off slots for TN.Hơn:');
for(const k of eng.teacherOffSlots || []){
  if(k.startsWith('TN.Hơn|') || k.startsWith('tn.hơn|')) console.log(k);
}

console.log('Slot 4 details:');
// Slot 4: Thứ 2, Sáng, Tiết 5 (0 * 10 + 0 * 5 + 4 = 4)
console.log('Class L001 at slot 4 in data.tkb:', data.tkb?.['L001']?.['Thứ 2']?.['Sáng']?.[4]);
console.log('Teacher TN.Hơn pccm for GDĐP in L001:', eng.getTeacherForClassMon(eng.classes.find(c => c.id === 'L001'), 'GDĐP'));
