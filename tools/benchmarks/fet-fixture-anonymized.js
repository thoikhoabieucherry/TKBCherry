"use strict";

/**
 * Deterministic, anonymised FET benchmark fixture.
 *
 * The fixture intentionally exercises the constraints that the browser FET
 * engine can check without relying on the production DATA singleton:
 *
 * - morning/afternoon class availability;
 * - shared teachers and rooms (collision pressure);
 * - class, teacher and room OFF cells;
 * - fixed lessons;
 * - two-period subject blocks;
 * - subject maximum periods per session.
 *
 * `createFixture()` returns a fresh object on every call.  The benchmark
 * harness can therefore run every seed/mode in isolation and never reuses a
 * mutated timetable from a previous run.
 */

const DAYS = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
const SESSIONS = ["sang", "chieu"];
const PERIODS = 5;

function emptyTimetable(classes){
  const tkb = {};
  for(const lop of classes){
    tkb[lop.id] = {};
    for(const thu of DAYS){
      tkb[lop.id][thu] = {};
      for(const buoi of SESSIONS){
        tkb[lop.id][thu][buoi] = [null, null, null, null, null];
      }
    }
  }
  return tkb;
}

function putCell(tkb, classId, thu, buoi, period, value){
  tkb[classId][thu][buoi][period] = value;
}

function markSlots(target, owner, slots){
  target[owner] = {};
  for(const [thu, buoi, period] of slots){
    target[owner][`${thu}|${buoi}|${period}`] = true;
  }
}

function createFixture(){
  const classes = [
    {id:"C01", ten:"10A1", ten2:"10A1", khoi:"10", ca:"sang"},
    {id:"C02", ten:"10A2", ten2:"10A2", khoi:"10", ca:"sang"},
    {id:"C03", ten:"10A3", ten2:"10A3", khoi:"10", ca:"chieu"},
    {id:"C04", ten:"10A4", ten2:"10A4", khoi:"10", ca:"chieu"},
    {id:"C05", ten:"10A5", ten2:"10A5", khoi:"10"}
  ];

  // Shared teachers/rooms create realistic contention while leaving ample
  // capacity so a valid schedule is attainable for every seed.
  const assignments = [
    ["C01", "Toán", "GV01", "R1", 4], ["C01", "Văn", "GV02", "R2", 3],
    ["C01", "Anh", "GV03", "R3", 2], ["C01", "Lý", "GV04", "R1", 2],
    ["C02", "Toán", "GV01", "R1", 3], ["C02", "Văn", "GV05", "R2", 2],
    ["C02", "Anh", "GV03", "R3", 3], ["C02", "Hóa", "GV06", "R2", 2],
    ["C03", "Toán", "GV07", "R1", 3], ["C03", "Văn", "GV02", "R2", 3],
    ["C03", "Anh", "GV03", "R3", 2], ["C03", "Sinh", "GV08", "R4", 2],
    ["C04", "Toán", "GV07", "R1", 2], ["C04", "Văn", "GV05", "R2", 2],
    ["C04", "Anh", "GV09", "R3", 3], ["C04", "Hóa", "GV06", "R2", 2],
    ["C05", "Toán", "GV01", "R1", 2], ["C05", "Văn", "GV02", "R2", 2],
    ["C05", "Anh", "GV09", "R3", 2], ["C05", "Lý", "GV04", "R1", 3]
  ];

  const pccmMatrix = {};
  const pccmTietMatrix = {};
  const pccmRoomMatrix = {};
  const pccmGioihanMatrix = {};
  const expectedByClassSubject = {};
  const teacherNames = new Map();
  const roomNames = new Set();

  for(const [classId, mon, teacher, room, periods] of assignments){
    const key = `${classId}|${mon}`;
    pccmMatrix[key] = teacher;
    pccmTietMatrix[key] = periods;
    pccmRoomMatrix[key] = room;
    pccmGioihanMatrix[key] = 2;
    expectedByClassSubject[key] = periods;
    teacherNames.set(teacher, teacher);
    roomNames.add(room);
  }

  const tkb = emptyTimetable(classes);

  // Fixed cells are represented with the same shape production TKB uses.
  const fixedCells = [
    ["C01", "thu2", "sang", 0, {mon:"Toán", gv:"GV01", room:"R1", fixed:true}],
    ["C02", "thu3", "sang", 1, {mon:"Anh", gv:"GV03", room:"R3", fixed:true}],
    ["C03", "thu2", "chieu", 0, {mon:"Văn", gv:"GV02", room:"R2", fixed:true}],
    ["C05", "thu4", "sang", 2, {mon:"Lý", gv:"GV04", room:"R1", fixed:true}]
  ];
  for(const [classId, thu, buoi, period, value] of fixedCells){
    putCell(tkb, classId, thu, buoi, period, value);
  }

  const classOff = {};
  markSlots(classOff, "C01", [["thu2", "sang", 1], ["thu2", "sang", 2], ["thu5", "chieu", 4]]);
  markSlots(classOff, "C02", [["thu3", "sang", 0], ["thu6", "sang", 4]]);
  markSlots(classOff, "C03", [["thu2", "chieu", 1], ["thu4", "chieu", 4]]);
  markSlots(classOff, "C04", [["thu3", "chieu", 0], ["thu6", "chieu", 4]]);
  markSlots(classOff, "C05", [["thu4", "sang", 0], ["thu7", "chieu", 4]]);

  const teacherOff = {};
  markSlots(teacherOff, "GV01", [["thu6", "sang", 0], ["thu6", "sang", 1]]);
  markSlots(teacherOff, "GV03", [["thu4", "sang", 0], ["thu4", "sang", 1]]);
  markSlots(teacherOff, "GV05", [["thu5", "chieu", 0]]);
  markSlots(teacherOff, "GV09", [["thu2", "chieu", 4]]);

  const roomOff = {};
  markSlots(roomOff, "R1", [["thu5", "sang", 0], ["thu5", "sang", 1]]);
  markSlots(roomOff, "R3", [["thu6", "chieu", 0]]);
  markSlots(roomOff, "R4", [["thu2", "chieu", 4]]);

  // At least one required pair for four classes.  The remaining periods are
  // deliberately odd so the engine must preserve both pair and singleton
  // activities instead of flattening every subject to one-period lessons.
  const subject = {
    Toán:{byClass:{C01:{lessonBlocks:{"2":{min:1, max:1}}}}},
    Anh:{byClass:{C02:{lessonBlocks:{"2":{min:1, max:1}}}}},
    Văn:{byClass:{C03:{lessonBlocks:{"2":{min:1, max:1}}}}},
    Lý:{byClass:{C05:{lessonBlocks:{"2":{min:1, max:1}}}}}
  };

  const monNames = Array.from(new Set(assignments.map(item => item[1])));
  const mon = monNames.map(ten => ({ten, khoi:"10", sotiet:1, gioihan:2}));
  const monhoc = monNames.map((ten, index) => ({ten, ma:`SUB${String(index + 1).padStart(2, "0")}`}));
  const giaovien = Array.from(teacherNames.keys()).sort().map(ma => ({ma, ten:`Teacher ${ma.replace(/^GV/, "")}`}));

  return {
    lop: classes,
    mon,
    monhoc,
    giaovien,
    pccmMatrix,
    pccmTietMatrix,
    pccmRoomMatrix,
    pccmGioihanMatrix,
    tkb,
    tkbLessonTeachers: Object.fromEntries(assignments.map(([cid, monName, teacher]) => [`${cid}|${monName}`, teacher])),
    tkbLessonRooms: Object.fromEntries(assignments.map(([cid, monName, , room]) => [`${cid}|${monName}`, room])),
    tkbConstraints:{
      fixedOff:{class:classOff, teacher:teacherOff, room:roomOff},
      subject
    },
    // Metadata is ignored by the production engine and used only by the
    // benchmark validator/reporting layer.
    __benchmark:{
      name:"fet-anonymized-contention-v1",
      anonymized:true,
      synthetic:false,
      expectedByClassSubject,
      fixedCells:fixedCells.map(([classId, thu, buoi, period]) => ({classId, thu, buoi, period})),
      requiredPeriods:assignments.reduce((sum, item) => sum + item[4], 0),
      activityCountEstimate:assignments.reduce((sum, item) => sum + Math.ceil(item[4] / 2), 0),
      classes:classes.length,
      teachers:teacherNames.size,
      rooms:roomNames.size,
      rules:{
        lessonBlocks:[
          {classId:"C01", subject:"Toán", rule:{lessonBlocks:{"2":{min:1, max:1}}}},
          {classId:"C02", subject:"Anh", rule:{lessonBlocks:{"2":{min:1, max:1}}}},
          {classId:"C03", subject:"Văn", rule:{lessonBlocks:{"2":{min:1, max:1}}}},
          {classId:"C05", subject:"Lý", rule:{lessonBlocks:{"2":{min:1, max:1}}}}
        ],
        spacingDays:[],
        noSameSession:[],
        noSameDay:[]
      },
      activeConstraintCounts:{classSession:4, lessonBlocks:4, spacingDays:0, noSameSession:0, noSameDay:0}
    }
  };
}

/**
 * A deliberately constrained companion fixture.  It keeps the same
 * anonymised school data but adds a teacher whose two fixed lessons occupy
 * the edges of one half-day.  The resulting two-period teacher gap is a
 * structural floor: local optimization may report that it reached the best
 * known bound without pretending that fixed lessons can be moved.  This is
 * useful for verifying the benchmark's `targetReached`/floor reporting.
 */
function createPressureFixture(){
  const data = createFixture();
  const pressureClass = {id:"C06", ten:"10A6", ten2:"10A6", khoi:"10"};
  data.lop.push(pressureClass);
  data.tkb.C06 = {};
  for(const thu of DAYS){
    data.tkb.C06[thu] = {};
    for(const buoi of SESSIONS) data.tkb.C06[thu][buoi] = [null, null, null, null, null];
  }

  const key = "C06|Mỹ thuật";
  data.pccmMatrix[key] = "GV10";
  data.pccmTietMatrix[key] = 2;
  data.pccmRoomMatrix[key] = "R5";
  data.pccmGioihanMatrix[key] = 2;
  data.tkbLessonTeachers[key] = "GV10";
  data.tkbLessonRooms[key] = "R5";
  data.__benchmark.expectedByClassSubject[key] = 2;
  data.__benchmark.requiredPeriods += 2;
  data.__benchmark.activityCountEstimate += 1;
  data.__benchmark.classes += 1;
  data.__benchmark.teachers += 1;
  data.__benchmark.rooms += 1;

  const fixed0 = {mon:"Mỹ thuật", gv:"GV10", room:"R5", fixed:true};
  const fixed4 = {mon:"Mỹ thuật", gv:"GV10", room:"R5", fixed:true};
  data.tkb.C06.thu2.sang[0] = fixed0;
  data.tkb.C06.thu2.sang[4] = fixed4;
  data.__benchmark.fixedCells.push(
    {classId:"C06", thu:"thu2", buoi:"sang", period:0},
    {classId:"C06", thu:"thu2", buoi:"sang", period:4}
  );
  data.__benchmark.name = "fet-anonymized-pressure-v1";
  data.__benchmark.structuralFloors = {soBuoiTrong2:1};
  return data;
}

function createSyntheticFixture({name, classCount, subjectsPerClass, stress = false}){
  const classes = [];
  const tkb = {};
  const pccmMatrix = {};
  const pccmTietMatrix = {};
  const pccmRoomMatrix = {};
  const pccmGioihanMatrix = {};
  const tkbLessonTeachers = {};
  const tkbLessonRooms = {};
  const expectedByClassSubject = {};
  const fixedCells = [];
  const subject = {};
  const assignments = [];
  const teacherCount = Math.max(40, Math.ceil(classCount * subjectsPerClass / 8));
  const roomCount = Math.max(12, Math.ceil(classCount * subjectsPerClass / 20));
  const teacherNames = new Set();
  const roomNames = new Set();

  const initClass = (lop) => {
    tkb[lop.id] = {};
    for(const thu of DAYS){
      tkb[lop.id][thu] = {};
      for(const buoi of SESSIONS) tkb[lop.id][thu][buoi] = [null, null, null, null, null];
    }
  };
  const addOff = (map, owner, thu, buoi, period) => {
    if(!map[owner]) map[owner] = {};
    map[owner][`${thu}|${buoi}|${period}`] = true;
  };

  const classOff = {};
  const teacherOff = {};
  const roomOff = {};
  let requiredPeriods = 0;
  let activityCountEstimate = 0;

  for(let ci = 0; ci < classCount; ci++){
    const id = `S${String(ci + 1).padStart(3, "0")}`;
    // Stress keeps both sessions available so its 2,340-period demand is
    // structurally feasible per class; medium/smoke retain explicit `ca`
    // morning/afternoon domains for constraint coverage.
    const ca = stress ? undefined : (ci % 3 === 0 ? "sang" : (ci % 3 === 1 ? "chieu" : undefined));
    const lop = {id, ten:`Synthetic ${id}`, ten2:`Synthetic ${id}`, khoi:"10", ...(ca ? {ca} : {})};
    classes.push(lop);
    initClass(lop);

    // Three OFF cells per class, intentionally away from its fixed slot.
    addOff(classOff, id, DAYS[(ci + 1) % DAYS.length], ca === "chieu" ? "chieu" : "sang", 4);
    addOff(classOff, id, DAYS[(ci + 3) % DAYS.length], "sang", 0);
    addOff(classOff, id, DAYS[(ci + 4) % DAYS.length], "chieu", 4);

    for(let si = 0; si < subjectsPerClass; si++){
      const monName = `Môn ${String(si + 1).padStart(2, "0")}`;
      const key = `${id}|${monName}`;
      // Every Nth subject is a 3-period demand with one required 2-period
      // block.  Other subjects alternate 1/2 periods to create singleton and
      // session pressure without exceeding any class capacity.
      const blockStride = stress ? 10 : 6;
      const isPair = si % blockStride === 0;
      const periods = isPair ? 3 : (si % 3 === 0 ? 2 : 1);
      const teacher = si === 0
        ? `FIX${String(ci + 1).padStart(3, "0")}`
        : `GV${String((ci * 13 + si * 7) % teacherCount + 1).padStart(3, "0")}`;
      const room = `P${String((ci * 5 + si * 3) % roomCount + 1).padStart(3, "0")}`;
      pccmMatrix[key] = teacher;
      pccmTietMatrix[key] = periods;
      pccmRoomMatrix[key] = room;
      pccmGioihanMatrix[key] = 2;
      tkbLessonTeachers[key] = teacher;
      tkbLessonRooms[key] = room;
      expectedByClassSubject[key] = periods;
      assignments.push({classId:id, subject:monName, teacher, room, periods});
      teacherNames.add(teacher);
      roomNames.add(room);
      requiredPeriods += periods;
      activityCountEstimate += isPair ? 2 : periods;

      if(isPair){
        subject[monName] ||= {byClass:{}};
        subject[monName].byClass[id] = {lessonBlocks:{"2":{min:1, max:1}}};
      }

      // One fixed period per class.  Pair subjects intentionally leave two
      // periods, so the engine must create and preserve a real paired block.
      if(si === 0){
        const thu = DAYS[ci % DAYS.length];
        const buoi = ca === "chieu" ? "chieu" : "sang";
        const fixed = {mon:monName, gv:teacher, room, fixed:true};
        tkb[id][thu][buoi][0] = fixed;
        fixedCells.push({classId:id, thu, buoi, period:0});
      }
    }

    // Avoid the fixed slot (period 0 on the class's assigned session).
    addOff(classOff, id, DAYS[(ci + 2) % DAYS.length], ca === "chieu" ? "chieu" : "sang", 2);
  }

  // Sparse teacher/room OFF cells add domain pruning but retain large global
  // capacity.  They are deterministic and independent of any user identity.
  let offIndex = 0;
  for(const teacher of teacherNames){
    if(offIndex++ % 5 === 0) addOff(teacherOff, teacher, DAYS[offIndex % DAYS.length], "sang", 4);
  }
  offIndex = 0;
  for(const room of roomNames){
    if(offIndex++ % 7 === 0) addOff(roomOff, room, DAYS[(offIndex + 2) % DAYS.length], "chieu", 0);
  }

  const monNames = Array.from({length:subjectsPerClass}, (_, i) => `Môn ${String(i + 1).padStart(2, "0")}`);
  const mon = monNames.map(ten => ({ten, khoi:"10", sotiet:1, gioihan:2}));
  const monhoc = monNames.map((ten, i) => ({ten, ma:`SYN${String(i + 1).padStart(3, "0")}`}));
  const giaovien = Array.from(teacherNames).sort().map(ma => ({ma, ten:`Synthetic ${ma}`}));
  return {
    lop:classes,
    mon,
    monhoc,
    giaovien,
    pccmMatrix,
    pccmTietMatrix,
    pccmRoomMatrix,
    pccmGioihanMatrix,
    tkb,
    tkbLessonTeachers,
    tkbLessonRooms,
    tkbConstraints:{fixedOff:{class:classOff, teacher:teacherOff, room:roomOff}, subject},
    __benchmark:{
      name,
      anonymized:true,
      synthetic:true,
      classes:classes.length,
      teachers:teacherNames.size,
      rooms:roomNames.size,
      requiredPeriods,
      activityCountEstimate,
      expectedByClassSubject,
      fixedCells,
      assignments,
      rules:{
        lessonBlocks:Object.entries(subject).flatMap(([subjectName, row]) => Object.entries(row.byClass || {}).map(([classId, rule]) => ({classId, subject:subjectName, rule}))),
        spacingDays:[],
        noSameSession:[],
        noSameDay:[]
      },
      activeConstraintCounts:{classSession:classes.filter(lop => lop.ca).length, lessonBlocks:Object.keys(subject).length, spacingDays:0, noSameSession:0, noSameDay:0}
    }
  };
}

function createMediumFixture(){
  return createSyntheticFixture({name:"fet-anonymized-medium-v1", classCount:24, subjectsPerClass:12});
}

function createStressFixture(){
  return createSyntheticFixture({name:"fet-anonymized-stress-v1", classCount:60, subjectsPerClass:25, stress:true});
}

module.exports = {
  createFixture,
  createPressureFixture,
  createMediumFixture,
  createStressFixture,
  createSyntheticFixture,
  DAYS,
  SESSIONS,
  PERIODS
};
