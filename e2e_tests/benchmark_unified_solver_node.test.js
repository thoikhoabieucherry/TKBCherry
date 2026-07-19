"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildBenchmarkScenario,
  referenceSolverRequest,
  simulateFailedTransactionRestore
} = require("../tools/benchmark-unified-solver");
const {
  REFERENCE_SOLVER_PROTOCOL,
  readJsonFileUtf8,
  runProtocolCommand,
  writeJsonFileUtf8
} = require("../tools/solver-stdio-runner");

function benchmarkFixture(){
  const subject = "Ngữ văn";
  const teacher = "Cô Thắm";
  const lessons = [];
  for(const day of [2, 3, 4, 5]){
    for(const period of [1, 2]){
      lessons.push({
        classId:"L1",
        className:"8/1",
        grade:"Khối 8",
        subject,
        teacher,
        room:"Phòng Âm nhạc",
        day,
        session:"AM",
        period
      });
    }
  }
  const base = {
    data:{
      giaovien:[{ma:teacher, ten:teacher}],
      khoi:[{ten:"Khối 8"}],
      lop:[{id:"L1", ten:"8/1", ten2:"8/1", khoi:"Khối 8"}],
      mon:[{ten:subject, khoi:"Khối 8", sotiet:8}],
      monhoc:[{ma:subject, ten:subject}],
      phong:[{id:"R1", ten:"Phòng Âm nhạc"}],
      pccmMatrix:{[`L1|${subject}`]:teacher},
      pccmTietMatrix:{[`L1|${subject}`]:8},
      pccmRoomMatrix:{[`L1|${subject}`]:"Phòng Âm nhạc"},
      pccmGioihanMatrix:{},
      tkb:{
        L1:{
          thu2:{
            sang:[{mon:subject, fixed:true}, "", "", "", ""],
            chieu:["", "", "", "", ""]
          }
        }
      },
      tkbLessonTeachers:{[`L1|${subject}`]:teacher},
      tkbLessonRooms:{[`L1|${subject}`]:"Phòng Âm nhạc"},
      tkbConstraints:{},
      tkbUserOff:{}
    }
  };
  const incumbent = {
    payload:{
      ok:true,
      classes:[{id:"L1", name:"8/1"}],
      lessons,
      metrics:{
        scheduled_periods:8,
        expected_periods:8,
        unassigned_periods:0,
        hard_ok:true,
        core_hard_ok:true
      },
      validation:{hard_ok:true, violations:[]},
      solver:{runtime_settings:{elapsed_seconds:1}},
      warnings:[],
      unassignedLessons:[]
    }
  };
  return {base, incumbent, subject, teacher};
}

function withFixture(callback){
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkb-benchmark-"));
  try{
    const fixture = benchmarkFixture();
    const basePath = writeJsonFileUtf8(path.join(dir, "base.json"), fixture.base);
    const incumbentPath = writeJsonFileUtf8(path.join(dir, "incumbent.json"), fixture.incumbent);
    return callback(Object.assign({dir, basePath, incumbentPath}, fixture));
  }finally{
    fs.rmSync(dir, {recursive:true, force:true});
  }
}

test("binary-safe runner preserves a UTF-8 JSON fixture without a shell", () => {
  const probe = [
    "const chunks=[];",
    "process.stdin.on('data', chunk => chunks.push(chunk));",
    "process.stdin.on('end', () => {",
    "  const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));",
    `  const frame={protocol:${JSON.stringify(REFERENCE_SOLVER_PROTOCOL)},status:200,payload:{ok:true,echo:value}};`,
    "  process.stdout.write(Buffer.from(JSON.stringify(frame)+'\\n','utf8'));",
    "});"
  ].join("\n");
  const input = {teacher:"K.Phát", grade:"Khối 8", room:"Phòng Âm nhạc"};
  const result = runProtocolCommand(input, {
    command:process.execPath,
    args:["-e", probe],
    cwd:path.resolve(__dirname, "..")
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.payload.echo, input);
});

test("reference runner adapts only executor selectors on a cloned request", () => {
  const request = {
    data:{grade:"Khối 8"},
    settings:{solver_mode:"native", native_force_rust_solver:true, backend_deadline_ms:10_000}
  };
  const adapted = referenceSolverRequest(request);

  assert.notEqual(adapted, request);
  assert.deepEqual(adapted.data, request.data);
  assert.equal(adapted.settings.solver_mode, "auto");
  assert.equal(adapted.settings.native_force_rust_solver, false);
  assert.equal(adapted.settings.disable_reference_solver, false);
  assert.equal(adapted.settings.disable_hybrid_reference_solver, false);
  assert.equal(adapted.settings.backend_deadline_ms, 10_000);
  assert.equal(request.settings.solver_mode, "native");
});

test("constraint benchmark keeps the complete violating incumbent until backend staged repair", () => {
  withFixture(({basePath, incumbentPath, teacher}) => {
    const scenario = buildBenchmarkScenario({
      base:basePath,
      incumbent:incumbentPath,
      lane:"constraint-repair",
      teacher,
      "max-days":3,
      workers:2
    });
    const request = scenario.primary.request;

    assert.equal(scenario.violations.length, 1);
    assert.equal(scenario.released, 0);
    assert.equal(scenario.fingerprintBefore, scenario.fingerprintAfterPlanning);
    assert.equal(scenario.scheduleHashBefore, scenario.scheduleHashAfterPlanning);
    assert.equal(scenario.bridge.internals.countScheduledLessons(request.data), 8);
    assert.equal(fixedCount(request.data), 1);
    assert.equal(request.settings.ui_preflight_constraint_violation_count, 1);
    assert.equal(request.settings.ui_skip_pre_solve_constraint_release, true);
    assert.equal(request.settings.ui_staged_existing_repair, true);
    assert.equal(request.settings.ui_staged_existing_phase, "fill");
    assert.equal(request.settings.repair_existing_missing_periods, 0);
    assert.equal(request.settings.preserve_existing_tkb, true);
    assert.equal(request.data.tkbConstraints.teacher[teacher].maxDaysSessions.maxDays, 3);

    assert.ok(scenario.fresh, "constraint repair must prepare one bounded fresh fallback");
    assert.equal(scenario.bridge.internals.countScheduledLessons(scenario.fresh.request.data), 1);
    assert.equal(fixedCount(scenario.fresh.request.data), 1);
    assert.equal(scenario.fresh.request.data.__tkbRequestStrippedSchedule, true);
    assert.equal(scenario.fresh.request.data.__tkbRequestFixedScheduleOnly, true);
    assert.equal(scenario.fresh.request.settings.ui_constraint_change_fresh_retry, true);
    assert.equal(scenario.fresh.request.settings.ui_constraint_change_rebuild_from_empty, true);
    assert.equal(scenario.fresh.request.settings.overall_time_limit_seconds, 110);
  });
});

test("four deterministic UTF-8 lessons become one staged partial-repair request", () => {
  withFixture(({basePath, incumbentPath}) => {
    const fixedPressureBase = readJsonFileUtf8(basePath);
    fixedPressureBase.data.tkbConstraints.fixedOff = {
      class:{L1:{"thu7|chieu|4":true}}
    };
    writeJsonFileUtf8(basePath, fixedPressureBase);
    const scenario = buildBenchmarkScenario({
      base:basePath,
      incumbent:incumbentPath,
      lane:"repair",
      missing:4,
      "missing-class":"L1",
      "missing-cells":"3:AM:1,3:AM:2,4:AM:1,4:AM:2",
      seconds:10
    });
    const request = scenario.primary.request;

    assert.equal(scenario.incumbentState.removed.length, 4);
    assert.ok(scenario.incumbentState.removed.every(item => item.grade === "Khối 8"));
    assert.equal(scenario.bridge.internals.countScheduledLessons(request.data), 4);
    assert.equal(fixedCount(request.data), 1);
    assert.equal(request.settings.ui_unified_solve_kind, "repair_partial");
    assert.equal(request.settings.ui_unified_partial_repair, true);
    assert.equal(request.settings.ui_staged_existing_repair, true);
    assert.equal(request.settings.repair_existing_missing_periods, 4);
    assert.equal(request.settings.existing_scheduled_periods, 4);
    assert.equal(request.settings.existing_flexible_scheduled_periods, 3);
    assert.equal(request.settings.expected_scheduled_periods, 8);
    assert.equal(request.settings.preserve_existing_tkb, true);
    assert.ok(scenario.fresh, "a hard partial repair must prepare one fresh fallback");
    assert.equal(scenario.fresh.request.settings.overall_time_limit_seconds, 110);
    assert.equal(scenario.fresh.request.settings.optimization_time_limit_seconds, 110);
    assert.equal(scenario.fresh.request.settings.integrated_time_limit, 110);
    assert.equal(scenario.fresh.request.settings.backend_deadline_ms, 110_000);
    assert.equal(scenario.fresh.request.settings.ui_allow_short_backend_deadline, true);
    assert.equal(scenario.fresh.request.settings.ui_unified_auto_sort, true);
    assert.equal(scenario.fresh.request.settings.ui_constraint_change_fresh_ceiling_seconds, 110);
    assert.equal(scenario.fresh.request.data.__tkbRequestStrippedSchedule, true);
    assert.equal(scenario.fresh.request.data.__tkbRequestFixedScheduleOnly, true);
  });
});

test("failed staged and fresh transaction restores all schedule fields exactly", () => {
  withFixture(({basePath, incumbentPath, teacher}) => {
    const scenario = buildBenchmarkScenario({
      base:basePath,
      incumbent:incumbentPath,
      lane:"constraint-repair",
      teacher,
      "max-days":3
    });
    const rollback = simulateFailedTransactionRestore(scenario);

    assert.ok(rollback.cleared > 0);
    assert.equal(rollback.exact, true);
    assert.equal(rollback.beforeHash, rollback.afterHash);
    assert.equal(rollback.constraintRetained, true);
    assert.equal(rollback.retainedMaxDays, 3);
  });
});

test("UTF-8 JSON file helper round-trips fixture bytes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkb-utf8-"));
  try{
    const file = path.join(dir, "fixture.json");
    const value = {teacher:"K.Phát", grade:"Khối 8", subject:"Ngữ văn"};
    writeJsonFileUtf8(file, value);
    assert.deepEqual(readJsonFileUtf8(file), value);
    assert.equal(fs.readFileSync(file).includes(Buffer.from("Khối 8", "utf8")), true);
  }finally{
    fs.rmSync(dir, {recursive:true, force:true});
  }
});

function fixedCount(data){
  let count = 0;
  for(const classTkb of Object.values(data?.tkb || {})){
    for(const dayValue of Object.values(classTkb || {})){
      for(const cells of Object.values(dayValue || {})){
        if(!Array.isArray(cells)) continue;
        count += cells.filter(cell => cell && typeof cell === "object" && cell.fixed === true).length;
      }
    }
  }
  return count;
}
