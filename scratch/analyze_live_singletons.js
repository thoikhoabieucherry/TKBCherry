const fs = require('fs');
global.self = global;
require('c:/Users/Love/Documents/Codex/TKBCherry/web/pages/tkb-fet-engine.js');
const Engine = global.FetTimetableEngine;

const data = JSON.parse(fs.readFileSync('c:/Users/Love/Documents/Codex/TKBCherry/scratch/live_default.json', 'utf8'));
const eng = new Engine(data, { mode: 'optimize_singletons', uiBreathingMs: 0 });
eng.init();
eng.loadExistingSchedule();

console.log('=== ANALYZING 25 INITIAL SINGLETONS IN LIVE DEFAULT ===');
const singletons = eng.findTeacherSingletons();
console.log('Total singletons found:', singletons.length);

for (const s of singletons) {
  const teacherId = s.teacherId || s.t;
  const teacherName = eng.teachers[teacherId]?.name || teacherId;
  const slot = s.slot !== undefined ? s.slot : (s.day * 10 + (s.session === 1 ? 5 : 0) + s.period);
  const day = Math.floor(slot / 10) + 2;
  const period = slot % 10;
  const session = period < 5 ? 'Sáng' : 'Chiều';
  const actId = eng.teacherGrid.get(teacherId)?.[slot];
  const act = eng.activities[actId];
  const className = act ? (eng.classes[act.classId]?.name || act.classId) : '?';
  const subName = act ? (eng.subjects[act.subjectId]?.name || act.subjectId) : '?';
  console.log(`- GV: ${teacherName} | Thứ ${day} ${session} tiết ${period % 5 + 1} | Lớp: ${className} | Môn: ${subName} | actId: ${actId}`);
}
