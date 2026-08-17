const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;

const engine = new FetTimetableEngine(schoolData);

// Calculate total periods per teacher per shift (morning/afternoon)
const teacherShiftLoads = new Map();

engine.activities.forEach(act => {
  if(!act.gv) return;
  const cClass = engine.classes.find(c => c.id === act.classId);
  // Shift of class: 0 (morning) if class in Khối 8,9 or buổi Sáng, 1 (afternoon) if Khối 6,7 or buổi Chiều
  // Or check allowed slots:
  let isMorning = false;
  let isAfternoon = false;
  for(let s = 0; s < 60; s++){
    if(!engine.offSlots.has(`${act.classId}|${s}`)){
      if(s % 10 < 5) isMorning = true;
      else isAfternoon = true;
    }
  }
  const shift = isMorning ? 0 : 1;
  const key = `${act.gv}|${shift}`;
  teacherShiftLoads.set(key, (teacherShiftLoads.get(key) || 0) + act.duration);
});

console.log("Teachers with total load in a shift that mathematically causes unavoidable singletons:");
let unavoidableSingletons = 0;

teacherShiftLoads.forEach((totalPeriods, key) => {
  const [gv, shift] = key.split('|');
  const shiftName = shift === '0' ? 'Sáng' : 'Chiều';
  
  // If totalPeriods === 1: CANNOT be paired -> MUST BE 1 SINGLETON!
  if(totalPeriods === 1){
    console.log(`- Teacher ${gv} (${shiftName}): Total load = 1 period -> 1 UNAVOIDABLE SINGLETON (1+0)`);
    unavoidableSingletons += 1;
  }
  // If totalPeriods === 3: Max periods per day is typically 2 (or 3 if 1 class, but if distinct single-period classes or max 2/day constraint)
  else if(totalPeriods === 3){
    console.log(`- Teacher ${gv} (${shiftName}): Total load = 3 periods -> 1 UNAVOIDABLE SINGLETON if max 2 periods/day (2+1)`);
  }
});

console.log(`\nTotal hard unavoidable singletons (load = 1): ${unavoidableSingletons}`);
