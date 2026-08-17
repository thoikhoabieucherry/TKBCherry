const fs = require("fs");
const path = require("path");

const ENGINE_PATH = path.resolve(__dirname, "../web/pages/tkb-fet-engine.js");
eval(fs.readFileSync(ENGINE_PATH, "utf8"));

const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, "excel_data_parsed.json"), "utf8"));

const engine = new FetTimetableEngine(data, { seed: 101 });
engine.loadExistingSchedule();

const act9_13 = engine.activities.find(a => a.classId === "9/13" && a.mon.includes("KHTN") && engine.actPlacement[a.id] === 39);
const slot = 35; // thu 5 chieu tiet 1

console.log("=== STEP BY STEP DEBUG getConflictsForSlot(act9_13, 35) ===");
console.log("act9_13:", { id: act9_13.id, classId: act9_13.classId, mon: act9_13.mon, gv: act9_13.gv, duration: act9_13.duration });

// Check offSlots
const offKey = `${act9_13.classId}|${slot}`;
console.log("class offSlots.has:", engine.offSlots.has(offKey));

// Check fixedSlots
console.log("fixedSlots.has:", engine.fixedSlots.has(offKey));

// Check teacher offSlots
const tList = parseTeacherList(act9_13.gv);
for (const t of tList) {
  console.log(`teacher "${t}" offSlots.has:`, engine.teacherOffSlots.has(`${t}|${slot}`));
}

// Check room offSlots
if (act9_13.room) {
  console.log(`room "${act9_13.room}" offSlots.has:`, engine.roomOffSlots.has(`${act9_13.room.trim().toLowerCase()}|${slot}`));
}

// Check session subject limit & contiguity
const details = slotToDetails(slot);
console.log("details:", details);
const sessionStartSlot = details.dayIdx * SLOTS_PER_DAY + details.sessionIdx * PERIODS_PER_SESSION;
const sessionEndSlot = sessionStartSlot + PERIODS_PER_SESSION;
const maxPerSession = engine.getSubjectSessionLimit(act9_13.lop, act9_13.mon);
const actCanon = engine.getCanonMonKey(act9_13.mon);

console.log("maxPerSession:", maxPerSession, "actCanon:", actCanon);

const subjectPeriods = [];
for (let pi = 0; pi < PERIODS_PER_SESSION; pi++) {
  const s = sessionStartSlot + pi;
  if (s >= slot && s < slot + act9_13.duration) {
    subjectPeriods.push(pi);
  } else {
    const existingActId = engine.classGrid.get(act9_13.classId)[s];
    if (existingActId >= 0 && existingActId !== act9_13.id) {
      const existingAct = engine.activities[existingActId];
      if (existingAct && engine.getCanonMonKey(existingAct.mon) === actCanon) {
        subjectPeriods.push(pi);
      }
    }
  }
}
console.log("subjectPeriods:", subjectPeriods);
if (subjectPeriods.length > maxPerSession) console.log("FAILED maxPerSession limit!");
if (subjectPeriods.length >= 2) {
  subjectPeriods.sort((a, b) => a - b);
  const span = subjectPeriods[subjectPeriods.length - 1] - subjectPeriods[0] + 1;
  if (span !== subjectPeriods.length) console.log("FAILED contiguity check! span:", span, "len:", subjectPeriods.length);
}

// Check daily limits
const dayIdx = details.dayIdx;
const maxDaily = engine.getSubjectDailyLimit(act9_13.lop, act9_13.mon);
console.log("maxDaily limit:", maxDaily);

const dayPeriods = [];
for (let s = dayIdx * SLOTS_PER_DAY; s < (dayIdx + 1) * SLOTS_PER_DAY; s++) {
  if (s >= slot && s < slot + act9_13.duration) {
    dayPeriods.push(s);
  } else {
    const existingActId = engine.classGrid.get(act9_13.classId)[s];
    if (existingActId >= 0 && existingActId !== act9_13.id) {
      const existingAct = engine.activities[existingActId];
      if (existingAct && engine.getCanonMonKey(existingAct.mon) === actCanon) {
        dayPeriods.push(s);
      }
    }
  }
}
console.log("dayPeriods count:", dayPeriods.length);
if (dayPeriods.length > maxDaily) console.log("FAILED maxDaily limit!");
