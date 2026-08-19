const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('./test_state_0917.json', 'utf8'));
const engineCode = fs.readFileSync('../web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const solver = new globalThis.FetTimetableEngine(schoolData);
solver.loadExistingSchedule();
console.log("Activity fields:", solver.activities[0]);
console.log("Teacher keys in teacherGrid:", Array.from(solver.teacherGrid.keys()).slice(0, 10));
