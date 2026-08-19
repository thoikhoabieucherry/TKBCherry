"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const PHANMON_PATH = path.join(ROOT, "web", "pages", "phanmon.js");
const LIVE_SCHOOL_PATH = path.join(ROOT, "scratch", "live_school_default.json");
const DONGKHOI_PATH = path.join(ROOT, "scratch", "dongkhoi_1566.json");

function loadValidatorContext(customData = {}) {
  const phanmonSource = fs.readFileSync(PHANMON_PATH, "utf8");
  const start = phanmonSource.indexOf("function fetHardViolationSignature(");
  const end = phanmonSource.indexOf("function fetTelemetryNowMs()", start);
  assert.ok(start >= 0 && end > start, "Phanmon validation helper slice must be found");
  const codeSlice = phanmonSource.slice(start, end);

  const window = {
    DATA: customData,
    TKBConstraints: {}
  };

  const context = {
    window,
    DATA: customData,
    JSON,
    Array,
    Map,
    Set,
    Number,
    String,
    Object,
    Promise,
    console,
    clonePlannerScheduleState(data) {
      return {
        tkb: JSON.parse(JSON.stringify(data.tkb || {})),
        tkbLessonTeachers: JSON.parse(JSON.stringify(data.tkbLessonTeachers || {})),
        tkbLessonRooms: JSON.parse(JSON.stringify(data.tkbLessonRooms || {}))
      };
    },
    restorePlannerScheduleState(data, snapshot) {
      data.tkb = snapshot.tkb;
      data.tkbLessonTeachers = snapshot.tkbLessonTeachers;
      data.tkbLessonRooms = snapshot.tkbLessonRooms;
    }
  };

  vm.runInNewContext(codeSlice, context);
  return context;
}

// --------------------------------------------------------------------------
// SECTION 1: Intentional Teacher Clash Injection (FAIL-CLOSED)
// --------------------------------------------------------------------------

test("Challenger 1.1: Intentional Teacher Clash across 2 classes is rejected fail-closed", async () => {
  const mockData = {
    lop: [
      { id: "6A", ten: "6A" },
      { id: "6B", ten: "6B" }
    ],
    tkb: {
      "6A": { "thu2": { "sang": ["Toán", "", "", "", ""] } },
      "6B": { "thu2": { "sang": ["Văn", "", "", "", ""] } }
    },
    tkbLessonTeachers: {
      "6A|Toán": "GV_Toan_1",
      "6B|Toán": "GV_Toan_1",
      "6B|Văn": "GV_Van_1"
    }
  };

  const ctx = loadValidatorContext(mockData);

  // Candidate places GV_Toan_1 in BOTH 6A and 6B on Monday Morning Period 0
  const candidateTkb = {
    "6A": { "thu2": { "sang": ["Toán", "", "", "", ""] } },
    "6B": { "thu2": { "sang": ["Toán", "", "", "", ""] } }
  };

  const inspect = ctx.inspectTrueHardConflicts(mockData, candidateTkb);
  assert.equal(inspect.ok, false, "inspectTrueHardConflicts must fail on teacher clash");
  assert.ok(inspect.conflicts.some(c => c.type === "teacher_clash" && c.teacher === "gv_toan_1"), "Must report teacher_clash for gv_toan_1");

  const valRes = await ctx.validateFetCandidateHardConstraints(mockData, candidateTkb);
  assert.equal(valRes.ok, false, "validateFetCandidateHardConstraints must reject candidate");
  assert.equal(valRes.applied, false);
  assert.equal(valRes.hardValid, false);
  assert.equal(valRes.failureKind, "fet_candidate_hard_validation_failed");
  assert.match(valRes.error, /Trùng tiết giáo viên gv_toan_1/);
});

test("Challenger 1.2: Co-Teaching Clash (comma & plus separated) is rejected fail-closed", async () => {
  const mockData = {
    lop: [
      { id: "7A", ten: "7A" },
      { id: "7B", ten: "7B" }
    ],
    tkb: {
      "7A": { "thu3": { "chieu": ["TD", "", "", "", ""] } },
      "7B": { "thu3": { "chieu": ["QP", "", "", "", ""] } }
    },
    tkbLessonTeachers: {
      "7A|TD": "GV_TheDuc_A, GV_TheDuc_B",
      "7B|QP": "GV_TheDuc_B"
    }
  };

  const ctx = loadValidatorContext(mockData);

  const candidateTkb = {
    "7A": { "thu3": { "chieu": ["TD", "", "", "", ""] } },
    "7B": { "thu3": { "chieu": ["QP", "", "", "", ""] } }
  };

  const inspect = ctx.inspectTrueHardConflicts(mockData, candidateTkb);
  assert.equal(inspect.ok, false, "Must detect co-teacher clash");
  assert.ok(inspect.conflicts.some(c => c.type === "teacher_clash" && c.teacher === "gv_theduc_b"));

  const valRes = await ctx.validateFetCandidateHardConstraints(mockData, candidateTkb);
  assert.equal(valRes.ok, false);
  assert.equal(valRes.hardValid, false);
});

test("Challenger 1.3: Teacher Clash with case-insensitive teacher names", async () => {
  const mockData = {
    lop: [{ id: "8A", ten: "8A" }, { id: "8B", ten: "8B" }],
    tkb: {
      "8A": { "thu4": { "sang": ["Anh", "", "", "", ""] } },
      "8B": { "thu4": { "sang": ["Anh", "", "", "", ""] } }
    },
    tkbLessonTeachers: {
      "8A|Anh": "Nguyen Van A",
      "8B|Anh": "nguyen van a"
    }
  };

  const ctx = loadValidatorContext(mockData);
  const candidateTkb = {
    "8A": { "thu4": { "sang": ["Anh", "", "", "", ""] } },
    "8B": { "thu4": { "sang": ["Anh", "", "", "", ""] } }
  };

  const inspect = ctx.inspectTrueHardConflicts(mockData, candidateTkb);
  assert.equal(inspect.ok, false);
  assert.ok(inspect.conflicts.some(c => c.type === "teacher_clash"));
});

// --------------------------------------------------------------------------
// SECTION 2: Intentional Room Clash Injection (FAIL-CLOSED)
// --------------------------------------------------------------------------

test("Challenger 2.1: Intentional Room Clash across 2 classes is rejected fail-closed", async () => {
  const mockData = {
    lop: [{ id: "9A", ten: "9A" }, { id: "9B", ten: "9B" }],
    tkb: {
      "9A": { "thu5": { "sang": ["Tin", "", "", "", ""] } },
      "9B": { "thu5": { "sang": ["Tin", "", "", "", ""] } }
    },
    tkbLessonRooms: {
      "9A|Tin": "Lab_01",
      "9B|Tin": "LAB_01"
    }
  };

  const ctx = loadValidatorContext(mockData);
  const candidateTkb = {
    "9A": { "thu5": { "sang": ["Tin", "", "", "", ""] } },
    "9B": { "thu5": { "sang": ["Tin", "", "", "", ""] } }
  };

  const inspect = ctx.inspectTrueHardConflicts(mockData, candidateTkb);
  assert.equal(inspect.ok, false, "Must detect room clash");
  assert.ok(inspect.conflicts.some(c => c.type === "room_clash"));

  const valRes = await ctx.validateFetCandidateHardConstraints(mockData, candidateTkb);
  assert.equal(valRes.ok, false);
  assert.equal(valRes.hardValid, false);
  assert.match(valRes.error, /Trùng phòng học LAB_01|Trùng phòng học Lab_01/);
});

// --------------------------------------------------------------------------
// SECTION 3: Class & Teacher Fixed OFF (-2) Overwrite (FAIL-CLOSED)
// --------------------------------------------------------------------------

test("Challenger 3.1: Class Fixed OFF (-2) slot overwrite is rejected fail-closed", async () => {
  const mockData = {
    lop: [{ id: "6A", ten: "6A" }],
    tkb: {
      "6A": { "thu2": { "sang": ["", "", "", "OFF", "OFF"] } }
    },
    tkbConstraints: {
      fixedOff: {
        class: {
          "6A": { "thu2|sang|3": true, "thu2|sang|4": true }
        }
      }
    },
    tkbLessonTeachers: { "6A|Su": "GV_Su" }
  };

  const ctx = loadValidatorContext(mockData);

  // Candidate attempts to put "Su" into period 3 (which is fixed OFF)
  const candidateTkb = {
    "6A": { "thu2": { "sang": ["", "", "", "Su", "OFF"] } }
  };

  const inspect = ctx.inspectTrueHardConflicts(mockData, candidateTkb);
  assert.equal(inspect.ok, false);
  assert.ok(inspect.conflicts.some(c => c.type === "class_off" && c.ti === 3));

  const valRes = await ctx.validateFetCandidateHardConstraints(mockData, candidateTkb);
  assert.equal(valRes.ok, false);
  assert.equal(valRes.hardValid, false);
  assert.match(valRes.error, /được đặt vào ô nghỉ cố định/);
});

test("Challenger 3.2: Teacher Fixed OFF (-2) slot overwrite with case variation (Vulnerability Detection)", async () => {
  const mockData = {
    lop: [{ id: "7A", ten: "7A" }],
    tkb: {
      "7A": { "thu3": { "sang": ["", "", "", "", ""] } }
    },
    tkbConstraints: {
      fixedOff: {
        teacher: {
          "GV_Dia": { "thu3|sang|0": true }
        }
      }
    },
    tkbLessonTeachers: { "7A|Dia": "GV_Dia" }
  };

  const ctx = loadValidatorContext(mockData);

  // Candidate assigns GV_Dia to Tuesday Morning Period 0
  const candidateTkb = {
    "7A": { "thu3": { "sang": ["Dia", "", "", "", ""] } }
  };

  const inspect = ctx.inspectTrueHardConflicts(mockData, candidateTkb);
  // Empirically check if inspectTrueHardConflicts catches Teacher OFF when casing differs ("GV_Dia" vs "gv_dia")
  const teacherOffConflict = inspect.conflicts.find(c => c.type === "teacher_off");
  
  // Note: If teacherOffConflict is undefined, inspectTrueHardConflicts failed due to case mismatch between lowercased teacher and fixedOff dictionary keys.
  assert.ok(teacherOffConflict !== undefined, "FAIL-CLOSED VIOLATION: inspectTrueHardConflicts missed Teacher OFF due to case sensitivity bug in isTeacherOff");
});

test("Challenger 3.3: Class Fixed OFF (-2) with class ID vs class ten alias", async () => {
  const mockData = {
    lop: [{ id: "lop_01", ten: "6A", ten2: "6A" }],
    tkb: {
      "6A": { "thu2": { "sang": ["", "", "", "OFF", "OFF"] } }
    },
    tkbConstraints: {
      fixedOff: {
        class: {
          "lop_01": { "thu2|sang|3": true }
        }
      }
    },
    tkbLessonTeachers: { "6A|Su": "GV_Su" }
  };

  const ctx = loadValidatorContext(mockData);

  const candidateTkb = {
    "6A": { "thu2": { "sang": ["", "", "", "Su", "OFF"] } }
  };

  const inspect = ctx.inspectTrueHardConflicts(mockData, candidateTkb);
  const classOffConflict = inspect.conflicts.find(c => c.type === "class_off");
  assert.ok(classOffConflict !== undefined, "FAIL-CLOSED VIOLATION: inspectTrueHardConflicts missed Class OFF when stored by class ID lop_01 while schedule uses 6A");
});

// --------------------------------------------------------------------------
// SECTION 4: Fixed Cell (-3) Alteration / Tampering (FAIL-CLOSED)
// --------------------------------------------------------------------------

test("Challenger 4.1: Altering a Fixed Cell (-3) subject or moving it is rejected fail-closed", async () => {
  const mockData = {
    lop: [{ id: "8A", ten: "8A" }],
    tkb: {
      "8A": {
        "thu2": {
          "sang": [
            { mon: "Chào cờ", fixed: true, val: "Chào cờ" },
            "Toán",
            "Văn",
            "",
            ""
          ]
        }
      }
    },
    tkbLessonTeachers: { "8A|Chào cờ": "BGH", "8A|Toán": "GV_Toan", "8A|Văn": "GV_Van" }
  };

  const ctx = loadValidatorContext(mockData);

  // Candidate overwrites Fixed Cell Period 0 with "Toán" and moves "Chào cờ" to Period 1
  const candidateTkb = {
    "8A": {
      "thu2": {
        "sang": [
          "Toán",
          "Chào cờ",
          "Văn",
          "",
          ""
        ]
      }
    }
  };

  const inspect = ctx.inspectTrueHardConflicts(mockData, candidateTkb);
  assert.equal(inspect.ok, false);
  assert.ok(inspect.conflicts.some(c => c.type === "fixed_cell" && c.expected === "Chào cờ" && c.actual === "Toán"));

  const valRes = await ctx.validateFetCandidateHardConstraints(mockData, candidateTkb);
  assert.equal(valRes.ok, false);
  assert.equal(valRes.hardValid, false);
  assert.match(valRes.error, /Vi phạm ô cố định lớp 8A/);
});

test("Challenger 4.2: Fixed Cell string annotations (!, *, [cd], [fixed]) are detected and guarded", async () => {
  const mockData = {
    lop: [{ id: "8B", ten: "8B" }],
    tkb: {
      "8B": {
        "thu6": {
          "sang": [
            "!SHCN",
            "Toán*",
            "[cd]HĐTN",
            "",
            ""
          ]
        }
      }
    },
    tkbLessonTeachers: { "8B|SHCN": "GV_CN", "8B|Toán": "GV_Toan", "8B|HĐTN": "GV_HD" }
  };

  const ctx = loadValidatorContext(mockData);

  // Candidate drops !SHCN on Period 0
  const candidateTkb = {
    "8B": {
      "thu6": {
        "sang": [
          "",
          "Toán",
          "HĐTN",
          "",
          ""
        ]
      }
    }
  };

  const inspect = ctx.inspectTrueHardConflicts(mockData, candidateTkb);
  assert.equal(inspect.ok, false);
  assert.ok(inspect.conflicts.some(c => c.type === "fixed_cell" && c.ti === 0));
});

// --------------------------------------------------------------------------
// SECTION 5: Student Hole Injection (FAIL-CLOSED)
// --------------------------------------------------------------------------

test("Challenger 5.1: Student Hole (internal gap) is rejected fail-closed", async () => {
  const mockData = {
    lop: [{ id: "9A", ten: "9A" }],
    tkb: {
      "9A": { "thu3": { "sang": ["Toán", "Toán", "Văn", "", ""] } }
    },
    tkbLessonTeachers: { "9A|Toán": "GV_Toan", "9A|Văn": "GV_Van" }
  };

  const ctx = loadValidatorContext(mockData);

  // Candidate schedules Period 0 (Toán) and Period 2 (Văn), leaving Period 1 empty -> gap of 1
  const candidateWithHole = {
    "9A": { "thu3": { "sang": ["Toán", "", "Văn", "", ""] } }
  };

  const inspect = ctx.inspectTrueHardConflicts(mockData, candidateWithHole);
  assert.equal(inspect.ok, false);
  assert.equal(inspect.studentHoles, 1);
  assert.ok(inspect.conflicts.some(c => c.type === "student_hole" && c.gaps === 1));

  const valRes = await ctx.validateFetCandidateHardConstraints(mockData, candidateWithHole);
  assert.equal(valRes.ok, false);
  assert.equal(valRes.hardValid, false);
  assert.match(valRes.error, /Phát sinh 1 lỗ trống học sinh giữa buổi/);
});

test("Challenger 5.2: Multi-period Student Hole is accurately counted and rejected", async () => {
  const mockData = {
    lop: [{ id: "9B", ten: "9B" }],
    tkb: {
      "9B": { "thu4": { "sang": ["Toán", "Toán", "Văn", "Văn", "Sử"] } }
    },
    tkbLessonTeachers: { "9B|Toán": "GV_Toan", "9B|Văn": "GV_Van", "9B|Sử": "GV_Su" }
  };

  const ctx = loadValidatorContext(mockData);

  // Candidate schedules Period 0 and Period 4, leaving Periods 1, 2, 3 empty -> gap of 3
  const candidateWith3Holes = {
    "9B": { "thu4": { "sang": ["Toán", "", "", "", "Sử"] } }
  };

  const inspect = ctx.inspectTrueHardConflicts(mockData, candidateWith3Holes);
  assert.equal(inspect.ok, false);
  assert.equal(inspect.studentHoles, 3);

  const valRes = await ctx.validateFetCandidateHardConstraints(mockData, candidateWith3Holes);
  assert.equal(valRes.ok, false);
  assert.match(valRes.error, /Phát sinh 3 lỗ trống học sinh/);
});

// --------------------------------------------------------------------------
// SECTION 6: Malformed / Null / Boundary Inputs (FAIL-CLOSED)
// --------------------------------------------------------------------------

test("Challenger 6.1: Null or non-object candidateTkb fails safely without uncaught exception", async () => {
  const mockData = { lop: [{ id: "6A" }] };
  const ctx = loadValidatorContext(mockData);

  const inspectNull = ctx.inspectTrueHardConflicts(mockData, null);
  assert.equal(inspectNull.ok, false);
  assert.match(inspectNull.error, /không hợp lệ/);

  const valResNull = await ctx.validateFetCandidateHardConstraints(mockData, null);
  assert.equal(valResNull.ok, false);
  assert.equal(valResNull.hardValid, false);

  const inspectStr = ctx.inspectTrueHardConflicts(mockData, "corrupted_string");
  assert.equal(inspectStr.ok, false);

  const inspectEmpty = ctx.inspectTrueHardConflicts(mockData, {});
  assert.equal(inspectEmpty.ok, true, "Empty schedule contains 0 physical conflicts");
});

// --------------------------------------------------------------------------
// SECTION 7: Valid Incumbent & Optimized Timetable Verification (ZERO FALSE POSITIVES)
// --------------------------------------------------------------------------

test("Challenger 7.1: Live School (75 classes / 2202 periods) incumbent timetable has zero false-positive rejections", async () => {
  const liveData = JSON.parse(fs.readFileSync(LIVE_SCHOOL_PATH, "utf8"));
  const ctx = loadValidatorContext(liveData);

  const inspectIncumbent = ctx.inspectTrueHardConflicts(liveData, liveData.tkb);
  assert.equal(inspectIncumbent.ok, true, "Live school incumbent schedule must have 0 conflicts");
  assert.equal(inspectIncumbent.conflicts.length, 0);
  assert.equal(inspectIncumbent.studentHoles, 0);

  const valRes = await ctx.validateFetCandidateHardConstraints(liveData, liveData.tkb, {
    allowUnchangedIncumbentViolations: true
  });
  assert.equal(valRes.ok, true, "Incumbent must validate with ok: true");
  assert.equal(valRes.hardValid, true, "Incumbent must have hardValid: true");
  assert.equal(valRes.applied, true);
  assert.equal(valRes.executor, "fet_worker");
});

test("Challenger 7.2: Zero False-Positive Validation on Complete Solved & Optimized Schedule", async () => {
  const dongkhoiData = JSON.parse(fs.readFileSync(DONGKHOI_PATH, "utf8"));
  const { FetTimetableEngine } = require(path.join(ROOT, "web", "pages", "tkb-fet-engine.js"));

  const engine = new FetTimetableEngine(dongkhoiData, {
    seed: 101,
    uiBreathingMs: 0
  });

  const solveRes = engine.solve();
  assert.equal(solveRes.ok, true, "Solver must achieve 100% placement on Dong Khoi dataset");
  assert.equal(solveRes.unassigned, 0);

  const solvedTkb = engine.getSnapshotTKB();
  const ctx = loadValidatorContext(dongkhoiData);

  const inspectSolved = ctx.inspectTrueHardConflicts(dongkhoiData, solvedTkb);
  assert.equal(inspectSolved.ok, true, "Solved timetable must have 0 hard conflicts");
  assert.equal(inspectSolved.conflicts.length, 0);
  assert.equal(inspectSolved.studentHoles, 0);

  const valRes = await ctx.validateFetCandidateHardConstraints(dongkhoiData, solvedTkb, {
    allowUnchangedIncumbentViolations: true
  });
  assert.equal(valRes.ok, true, "Fully solved timetable MUST NOT be blocked by validator");
  assert.equal(valRes.hardValid, true);
  assert.equal(valRes.applied, true);
  assert.equal(valRes.executor, "fet_worker");
});

test("Challenger 7.3: Dong Khoi (54 classes / 1566 periods) incumbent & optimized pass zero false-positive check", async () => {
  const dongkhoiData = JSON.parse(fs.readFileSync(DONGKHOI_PATH, "utf8"));
  const ctx = loadValidatorContext(dongkhoiData);

  const inspectIncumbent = ctx.inspectTrueHardConflicts(dongkhoiData, dongkhoiData.tkb);
  assert.equal(inspectIncumbent.ok, true);
  assert.equal(inspectIncumbent.conflicts.length, 0);
  assert.equal(inspectIncumbent.studentHoles, 0);

  const valRes = await ctx.validateFetCandidateHardConstraints(dongkhoiData, dongkhoiData.tkb, {
    allowUnchangedIncumbentViolations: true
  });
  assert.equal(valRes.ok, true);
  assert.equal(valRes.hardValid, true);
  assert.equal(valRes.applied, true);
});

// --------------------------------------------------------------------------
// SECTION 8: Mirror Parity Between web/pages/phanmon.js and web/phanmon.js
// --------------------------------------------------------------------------

test("Challenger 8.1: web/pages/phanmon.js and web/phanmon.js are 100% byte-identical", () => {
  const f1 = fs.readFileSync(path.join(ROOT, "web", "pages", "phanmon.js"), "utf8");
  const f2 = fs.readFileSync(path.join(ROOT, "web", "phanmon.js"), "utf8");
  assert.equal(f1, f2, "web/pages/phanmon.js and web/phanmon.js must have exact mirror parity");
});
