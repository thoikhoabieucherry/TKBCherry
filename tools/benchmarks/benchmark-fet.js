"use strict";

/**
 * Stand-alone benchmark for the browser FET engine.
 *
 * Examples (PowerShell):
 *
 *   node tools/benchmarks/benchmark-fet.js --seeds=101,202 --modes=auto
 *   node tools/benchmarks/benchmark-fet.js --seeds=101,202,303 --out=docs/benchmarks/fet-latest.json
 *
 * The harness deliberately loads the same browser source through a VM rather
 * than importing a second implementation.  Every run receives a fresh,
 * anonymised fixture, so no production DATA singleton or network service is
 * touched.  Optimizer records always include the Auto/FET incumbent metrics;
 * this makes a failed optimization distinguishable from a failed first pass.
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {performance} = require("node:perf_hooks");
const {
  createFixture,
  createPressureFixture,
  createMediumFixture,
  createStressFixture,
  DAYS,
  SESSIONS,
  PERIODS
} = require("./fet-fixture-anonymized.js");

const ROOT = path.resolve(__dirname, "..", "..");
const ENGINE_PATH = path.join(ROOT, "web", "pages", "tkb-fet-engine.js");
const ENGINE_SOURCE = fs.readFileSync(ENGINE_PATH, "utf8");
const MODES = ["auto", "optimize_singletons", "optimize_sessions", "optimize_gap2", "optimize_gap1", "optimize_all"];
const MODE_METRICS = {
  optimize_singletons:"soBuoiDay1",
  optimize_sessions:"tsBuoiDay",
  optimize_gap2:"soBuoiTrong2",
  optimize_gap1:"soBuoiTrong1",
  optimize_all:"soBuoiDay1"
};

function fixtureFactoryFor(variant){
  if(variant === "pressure") return createPressureFixture;
  if(variant === "medium") return createMediumFixture;
  if(variant === "stress") return createStressFixture;
  if(variant && variant.startsWith("file:")){
    const filePath = path.resolve(process.cwd(), variant.slice(5));
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return () => {
      const data = JSON.parse(JSON.stringify(raw));
      if(!data.__benchmark){
        data.__benchmark = {
          name:"file:" + path.basename(filePath),
          anonymized:false,
          synthetic:false,
          requiredPeriods:0,
          activityCountEstimate:0,
          classes:Array.isArray(data.lop) ? data.lop.length : 0,
          teachers:Array.isArray(data.giaovien) ? data.giaovien.length : 0,
          rooms:Array.isArray(data.phonghoc) ? data.phonghoc.length : 0,
          structuralFloors:{},
          rules:{}
        };
      }
      return data;
    };
  }
  return createFixture;
}

function loadEngine(){
  const window = {};
  const context = vm.createContext({
    window,
    globalThis:window,
    console,
    Date,
    Math,
    JSON,
    Map,
    Set,
    Array,
    String,
    Number,
    Object,
    RegExp,
    Promise,
    setTimeout,
    clearTimeout,
    Uint8Array
  });
  vm.runInContext(ENGINE_SOURCE, context, {filename:ENGINE_PATH});
  if(typeof window.FetTimetableEngine !== "function"){
    throw new Error("tkb-fet-engine.js did not expose FetTimetableEngine");
  }
  return {Engine:window.FetTimetableEngine, window};
}

function clone(value){
  return JSON.parse(JSON.stringify(value));
}

function parseArgs(argv){
  const args = {
    seeds:[101, 202, 303],
    modes:MODES.slice(),
    autoBudgetMs:12_000,
    optimizerTimeoutMs:20_000,
    fixture:"smoke",
    out:null,
    quiet:false,
    strict:false
  };
  for(const raw of argv){
    if(raw === "--quiet"){
      args.quiet = true;
      continue;
    }
    if(raw === "--strict"){
      args.strict = true;
      continue;
    }
    const m = raw.match(/^--([^=]+)=(.*)$/);
    if(!m) continue;
    const key = m[1];
    const value = m[2];
    if(key === "seeds"){
      args.seeds = value.split(",").map(Number).filter(Number.isFinite).map(n => Math.trunc(n));
    }else if(key === "modes"){
      args.modes = value.split(",").map(s => s.trim()).filter(s => MODES.includes(s));
    }else if(key === "auto-budget-ms"){
      args.autoBudgetMs = Math.max(1_000, Math.min(30_000, Number(value) || args.autoBudgetMs));
    }else if(key === "optimizer-timeout-ms"){
      args.optimizerTimeoutMs = Math.max(1_000, Math.min(120_000, Number(value) || args.optimizerTimeoutMs));
    }else if(key === "fixture"){
      args.fixture = (["smoke", "pressure", "medium", "stress"].includes(value) || value.startsWith("file:")) ? value : "smoke";
    }else if(key === "out" || key === "json"){
      args.out = value;
    }
  }
  if(args.seeds.length === 0) args.seeds = [101];
  if(args.modes.length === 0) args.modes = ["auto"];
  return args;
}

function printHelp(){
  console.log([
    "Usage: node tools/benchmarks/benchmark-fet.js [options]",
    "",
    "  --fixture=smoke|pressure|medium|stress",
    "  --seeds=101,202,303",
    "  --modes=auto,optimize_singletons,optimize_sessions,optimize_gap2,optimize_gap1",
    "  --auto-budget-ms=12000       FET construction budget (1,000–30,000)",
    "  --optimizer-timeout-ms=20000 Harness stop request (1,000–120,000)",
    "  --out=path.json              Write a JSON report",
    "  --quiet                      Suppress per-run/table output",
    "  --strict                     Exit 1 when any run is not complete-valid"
  ].join("\n"));
}

function cellSubject(cell){
  if(!cell || cell === "OFF") return "";
  if(typeof cell === "object") return String(cell.mon || cell.val || cell.subject || "").trim();
  const raw = String(cell).trim();
  return raw.includes(" - ") ? raw.split(" - ")[0].trim() : raw;
}

function cellTeacher(cell, data, classId, subject){
  if(cell && typeof cell === "object" && (cell.gv || cell.teacher)){
    return String(cell.gv || cell.teacher).trim();
  }
  return String(data.pccmMatrix?.[`${classId}|${subject}`] || "").trim();
}

function cellRoom(cell, data, classId, subject){
  if(cell && typeof cell === "object" && (cell.room || cell.phong)){
    return String(cell.room || cell.phong).trim();
  }
  return String(data.pccmRoomMatrix?.[`${classId}|${subject}`] || "").trim();
}

function slotKey(thu, buoi, period){
  return `${thu}|${buoi}|${period}`;
}

function countLessons(data){
  let count = 0;
  for(const lop of data.lop || []){
    const cid = String(lop.id || "");
    for(const thu of DAYS){
      for(const buoi of SESSIONS){
        for(const cell of data.tkb?.[cid]?.[thu]?.[buoi] || []){
          if(cellSubject(cell)) count++;
        }
      }
    }
  }
  return count;
}

function validateSchedule(data, engine){
  const meta = data.__benchmark || {};
  const violations = [];
  const counts = new Map();
  const teacherAtSlot = new Map();
  const roomAtSlot = new Map();

  for(const lop of data.lop || []){
    const cid = String(lop.id || "");
    for(const thu of DAYS){
      for(const buoi of SESSIONS){
        const arr = data.tkb?.[cid]?.[thu]?.[buoi] || [];
        for(let period = 0; period < PERIODS; period++){
          const cell = arr[period];
          const subject = cellSubject(cell);
          if(!subject) continue;
          if(lop.ca && String(lop.ca).toLowerCase() !== String(buoi).toLowerCase()){
            violations.push(`class_session_violation:${cid}:${buoi}:${thu}:${period}`);
          }
          const key = `${cid}|${subject}`;
          counts.set(key, (counts.get(key) || 0) + 1);
          const teacher = cellTeacher(cell, data, cid, subject).toLowerCase();
          const room = cellRoom(cell, data, cid, subject).toLowerCase();
          const sk = slotKey(thu, buoi, period);
          if(teacher){
            const owner = teacherAtSlot.get(`${teacher}|${sk}`);
            if(owner && owner !== cid) violations.push(`teacher_collision:${teacher}:${sk}:${owner}/${cid}`);
            teacherAtSlot.set(`${teacher}|${sk}`, cid);
          }
          if(room){
            const owner = roomAtSlot.get(`${room}|${sk}`);
            if(owner && owner !== cid) violations.push(`room_collision:${room}:${sk}:${owner}/${cid}`);
            roomAtSlot.set(`${room}|${sk}`, cid);
          }
        }
      }
    }
  }

  // Subject maximum periods per half-day is a hard rule in the browser
  // engine.  Recompute it from the rendered TKB so optimizer output is
  // checked independently of the engine's internal grids.
  for(const lop of data.lop || []){
    const cid = String(lop.id || "");
    for(const thu of DAYS){
      for(const buoi of SESSIONS){
        const sessionCounts = new Map();
        for(const cell of data.tkb?.[cid]?.[thu]?.[buoi] || []){
          const subject = cellSubject(cell);
          if(subject) sessionCounts.set(subject, (sessionCounts.get(subject) || 0) + 1);
        }
        for(const [subject, count] of sessionCounts){
          const max = Number(data.pccmGioihanMatrix?.[`${cid}|${subject}`] || 0);
          if(max > 0 && count > max){
            violations.push(`subject_session_limit:${cid}|${subject}:${thu}|${buoi}:${count}/${max}`);
          }
        }
      }
    }
  }

  const countBlocks = (classId, subject, length) => {
    let blocks = 0;
    for(const thu of DAYS){
      for(const buoi of SESSIONS){
        const arr = data.tkb?.[classId]?.[thu]?.[buoi] || [];
        let run = 0;
        for(let period = 0; period <= PERIODS; period++){
          const same = period < PERIODS && cellSubject(arr[period]) === subject;
          if(same){
            run++;
          }else if(run >= length){
            blocks++;
            run = 0;
          }else{
            run = 0;
          }
        }
      }
    }
    return blocks;
  };

  for(const entry of meta.rules?.lessonBlocks || []){
    const rule = entry.rule || {};
    const blocks = countBlocks(entry.classId, entry.subject, Number(entry.length || 2));
    const min = Number(rule.lessonBlocks?.[entry.length || 2]?.min || 0);
    const max = Number(rule.lessonBlocks?.[entry.length || 2]?.max || 0);
    if(min > 0 && blocks < min) violations.push(`lesson_block_min:${entry.classId}|${entry.subject}:${blocks}/${min}`);
    if(max > 0 && blocks > max) violations.push(`lesson_block_max:${entry.classId}|${entry.subject}:${blocks}/${max}`);
  }

  // Optional metadata rules are intentionally separate from the engine's
  // current domain compiler.  If a fixture enables them, the benchmark marks
  // violations rather than silently treating the candidate as valid.
  for(const entry of meta.rules?.spacingDays || []){
    const days = new Set();
    for(let day = 0; day < DAYS.length; day++){
      const thu = DAYS[day];
      for(const buoi of SESSIONS){
        if((data.tkb?.[entry.classId]?.[thu]?.[buoi] || []).some(cell => cellSubject(cell) === entry.subject)) days.add(day);
      }
    }
    const sorted = Array.from(days).sort((a, b) => a - b);
    for(let i = 1; i < sorted.length; i++){
      if(sorted[i] - sorted[i - 1] <= Number(entry.days || 0)){
        violations.push(`spacing_days:${entry.classId}|${entry.subject}:${sorted[i - 1]}-${sorted[i]}/${entry.days}`);
        break;
      }
    }
  }
  for(const entry of meta.rules?.noSameSession || []){
    const groups = new Map();
    for(const thu of DAYS){
      for(const buoi of SESSIONS){
        const subjects = new Set((data.tkb?.[entry.classId]?.[thu]?.[buoi] || []).map(cellSubject).filter(Boolean));
        const matched = (entry.subjects || []).filter(subject => subjects.has(subject));
        if(matched.length > 1) violations.push(`no_same_session:${entry.classId}:${thu}|${buoi}:${matched.join(",")}`);
      }
    }
  }
  for(const entry of meta.rules?.noSameDay || []){
    for(const thu of DAYS){
      const subjects = new Set();
      for(const buoi of SESSIONS){
        for(const subject of (data.tkb?.[entry.classId]?.[thu]?.[buoi] || []).map(cellSubject)){
          if(subject) subjects.add(subject);
        }
      }
      const matched = (entry.subjects || []).filter(subject => subjects.has(subject));
      if(matched.length > 1) violations.push(`no_same_day:${entry.classId}:${thu}:${matched.join(",")}`);
    }
  }

  for(const [key, required] of Object.entries(meta.expectedByClassSubject || {})){
    const got = counts.get(key) || 0;
    if(got !== Number(required)) violations.push(`lesson_count:${key}:${got}/${required}`);
  }

  // Fixed cells must survive an engine pass byte-for-byte (including teacher
  // and room annotations), and class/teacher/room OFF slots stay empty.
  for(const fixed of meta.fixedCells || []){
    const cell = data.tkb?.[fixed.classId]?.[fixed.thu]?.[fixed.buoi]?.[fixed.period];
    if(!cell || cell.fixed !== true) violations.push(`fixed_lost:${fixed.classId}:${slotKey(fixed.thu, fixed.buoi, fixed.period)}`);
  }
  const checkOffMap = (map, kind) => {
    for(const [owner, slots] of Object.entries(map || {})){
      for(const sk of Object.keys(slots || {})){
        const [thu, buoi, periodRaw] = sk.replace(/_/g, "|").split("|");
        const period = Number(periodRaw);
        if(kind === "class"){
          const cell = data.tkb?.[owner]?.[thu]?.[buoi]?.[period];
          if(cellSubject(cell)) violations.push(`class_off_violation:${owner}:${sk}`);
        }else if(kind === "teacher" || kind === "room"){
          const registry = kind === "teacher" ? teacherAtSlot : roomAtSlot;
          if(registry.has(`${String(owner).toLowerCase()}|${slotKey(thu, buoi, period)}`)){
            violations.push(`${kind}_off_violation:${owner}:${sk}`);
          }
        }
      }
    }
  };
  checkOffMap(data.tkbConstraints?.fixedOff?.class, "class");
  checkOffMap(data.tkbConstraints?.fixedOff?.teacher, "teacher");
  checkOffMap(data.tkbConstraints?.fixedOff?.room, "room");

  // Engine state catches block splitting and dynamic occupancy violations that
  // cannot be inferred from a flat TKB cell alone.
  if(engine){
    const unplaced = (engine.activities || []).filter(act => engine.actPlacement?.[act.id] < 0);
    if(unplaced.length) violations.push(`unplaced_activities:${unplaced.length}`);
    for(const act of engine.activities || []){
      const start = engine.actPlacement?.[act.id];
      if(start == null || start < 0) continue;
      if(act.duration > 1 && (start % PERIODS) + act.duration > PERIODS){
        violations.push(`block_crosses_session:${act.id}`);
      }
      if(act.mustKeepBlock){
        for(let offset = 1; offset < act.duration; offset++){
          if(engine.classGrid.get(act.classId)?.[start + offset] !== act.id){
            violations.push(`paired_block_split:${act.id}`);
            break;
          }
        }
      }
    }
    for(const key of engine.offSlots || []){
      const [cid, rawSlot] = String(key).split("|");
      if((engine.classGrid.get(cid) || [])[Number(rawSlot)] >= 0){
        violations.push(`engine_off_overwritten:${key}`);
      }
    }
    for(const key of engine.fixedSlots?.keys?.() || []){
      const [cid, rawSlot] = String(key).split("|");
      if((engine.classGrid.get(cid) || [])[Number(rawSlot)] !== -3){
        violations.push(`engine_fixed_overwritten:${key}`);
      }
    }
  }

  return {
    valid:violations.length === 0,
    violationCount:violations.length,
    violations:violations.slice(0, 40),
    lessonCount:countLessons(data),
    expectedLessonCount:Number(meta.requiredPeriods || 0)
  };
}

function percentile(values, p){
  const nums = values.filter(Number.isFinite).sort((a, b) => a - b);
  if(nums.length === 0) return null;
  const index = Math.min(nums.length - 1, Math.max(0, Math.ceil((p / 100) * nums.length) - 1));
  return nums[index];
}

function average(values){
  const nums = values.filter(Number.isFinite);
  return nums.length ? nums.reduce((sum, value) => sum + value, 0) / nums.length : null;
}

async function runOne({Engine, window}, mode, seed, options){
  const fixtureFactory = fixtureFactoryFor(options.fixture);
  const fixture = fixtureFactory();
  const originalTkb = clone(fixture.tkb);
  const started = performance.now();
  let autoResult = null;
  let result = null;
  let engine = null;
  let data = fixture;
  let optimizationTimedOut = false;

  try{
    engine = new Engine(fixture, {seed, timeBudgetMs:options.autoBudgetMs});
    autoResult = engine.solve();
    if(!Number(fixture.__benchmark.requiredPeriods) && Number.isFinite(autoResult?.total)){
      fixture.__benchmark.requiredPeriods = autoResult.total;
    }
    if(mode === "auto"){
      result = autoResult;
    }else if(!autoResult.ok || autoResult.applied === false){
      result = {
        ok:false,
        applied:false,
        executor:"fet_worker",
        failureKind:"auto_incumbent_unavailable",
        initialMetrics:null,
        metrics:null,
        diagnostics:autoResult.diagnostics
      };
    }else{
      // Optimization starts from a clean copy of the complete FET incumbent.
      data = clone(fixture);
      engine = new Engine(data, {
        seed,
        timeBudgetMs:options.autoBudgetMs,
        optimizeTimeBudgetMs:options.optimizerTimeoutMs
      });
      window.__AUTO_SORT_STOP_REQUESTED = false;
      const timeoutHandle = setTimeout(() => {
        optimizationTimedOut = true;
        window.__AUTO_SORT_STOP_REQUESTED = true;
      }, options.optimizerTimeoutMs);
      try{
        result = mode === "optimize_all" && typeof engine.optimizeAll === "function"
          ? await engine.optimizeAll()
          : await engine.optimize(mode);
      }finally{
        clearTimeout(timeoutHandle);
        window.__AUTO_SORT_STOP_REQUESTED = false;
      }
    }
  }catch(error){
    result = {
      ok:false,
      applied:false,
      executor:"fet_worker",
      failureKind:"benchmark_exception",
      error:String(error?.stack || error)
    };
  }

  const elapsedMs = performance.now() - started;
  const metrics = result?.metrics || (result?.ok && engine ? engine.evaluateMetrics() : null);
  const validation = result?.ok && result?.applied !== false
    ? validateSchedule(data, engine)
    : {valid:false, violationCount:0, violations:[], lessonCount:countLessons(data), expectedLessonCount:fixture.__benchmark.requiredPeriods};
  const targetMetric = MODE_METRICS[mode] || null;
  const initialMetric = targetMetric && result?.initialMetrics ? Number(result.initialMetrics[targetMetric]) : null;
  const finalMetric = targetMetric && metrics ? Number(metrics[targetMetric]) : null;
  const knownLowerBound = targetMetric
    ? Number(fixture.__benchmark?.structuralFloors?.[targetMetric] || 0)
    : null;
  const complete = Boolean(result?.ok && result?.applied !== false && Number(result?.unassigned || 0) === 0 && validation.lessonCount === validation.expectedLessonCount);

  return {
    fixture:fixture.__benchmark.name,
    seed,
    mode,
    runtimeMs:Number(elapsedMs.toFixed(2)),
    executor:result?.executor || "fet_worker",
    ok:Boolean(result?.ok),
    applied:result?.applied !== false,
    complete,
    valid:Boolean(validation.valid),
    completeValid:Boolean(complete && validation.valid),
    unassigned:Number(result?.unassigned || 0),
    placed:Number(result?.placed || 0),
    lessonCount:validation.lessonCount,
    expectedLessonCount:validation.expectedLessonCount,
    initialMetrics:result?.initialMetrics || (mode === "auto" && autoResult?.ok && engine ? engine.evaluateMetrics() : null),
    metrics,
    targetMetric,
    initialTarget:initialMetric,
    finalTarget:finalMetric,
    targetDelta:(initialMetric != null && finalMetric != null) ? finalMetric - initialMetric : null,
    targetReached:targetMetric ? finalMetric === 0 : null,
    knownLowerBound,
    floorReached:targetMetric ? finalMetric != null && finalMetric <= knownLowerBound : null,
    stagnated:Boolean(result?.stagnated),
    optimizationTimedOut,
    failureKind:result?.failureKind || null,
    validationViolationCount:validation.violationCount,
    validationViolations:validation.violations,
    preflight:autoResult?.diagnostics || null,
    originalTimetablePreservedOnFailure:!result?.ok ? JSON.stringify(fixture.tkb) === JSON.stringify(originalTkb) : null
  };
}

function aggregate(records){
  const byMode = {};
  for(const mode of MODES){
    const rows = records.filter(row => row.mode === mode);
    if(!rows.length) continue;
    const completeValid = rows.filter(row => row.completeValid).length;
    const valid = rows.filter(row => row.valid).length;
    const targets = rows.filter(row => row.targetReached === true).length;
    const floors = rows.filter(row => row.floorReached === true).length;
    const metricRows = rows.filter(row => row.metrics);
    const metricKeys = ["soBuoiDay1", "tsBuoiDay", "tsNgayDay", "soBuoiTrong1", "soBuoiTrong2", "unplacedCount"];
    const metricAverage = {};
    for(const key of metricKeys) metricAverage[key] = average(metricRows.map(row => Number(row.metrics?.[key])));
    byMode[mode] = {
      runs:rows.length,
      completeValidRate:Number((completeValid / rows.length).toFixed(4)),
      hardValidRate:Number((valid / rows.length).toFixed(4)),
      targetReachedRate:mode === "auto" ? null : Number((targets / rows.length).toFixed(4)),
      structuralFloorReachedRate:mode === "auto" ? null : Number((floors / rows.length).toFixed(4)),
      runtimeMs:{
        avg:average(rows.map(row => row.runtimeMs)),
        p50:percentile(rows.map(row => row.runtimeMs), 50),
        p95:percentile(rows.map(row => row.runtimeMs), 95)
      },
      metricAverage,
      validationRejections:rows.filter(row => row.validationViolationCount > 0).length,
      failureKinds:rows.reduce((out, row) => {
        if(row.failureKind) out[row.failureKind] = (out[row.failureKind] || 0) + 1;
        return out;
      }, {})
    };
  }
  return byMode;
}

function printSummary(report){
  console.log(`FET benchmark: ${report.fixture.name} (${report.fixture.classes} classes, ${report.fixture.requiredPeriods} required periods)`);
  console.log(`Seeds: ${report.seeds.join(", ")} | generated: ${report.generatedAt}`);
  console.log("");
  console.log("mode\truns\tcomplete-valid\thard-valid\ttarget-0\tfloor\truntime p50/p95 (ms)\tavg target delta");
  for(const [mode, summary] of Object.entries(report.summary)){
    const deltas = report.records.filter(row => row.mode === mode).map(row => row.targetDelta).filter(Number.isFinite);
    console.log([
      mode,
      summary.runs,
      `${(summary.completeValidRate * 100).toFixed(1)}%`,
      `${(summary.hardValidRate * 100).toFixed(1)}%`,
      summary.targetReachedRate == null ? "—" : `${(summary.targetReachedRate * 100).toFixed(1)}%`,
      summary.structuralFloorReachedRate == null ? "—" : `${(summary.structuralFloorReachedRate * 100).toFixed(1)}%`,
      `${summary.runtimeMs.p50 ?? "—"}/${summary.runtimeMs.p95 ?? "—"}`,
      deltas.length ? average(deltas).toFixed(2) : "—"
    ].join("\t"));
  }
  const failures = report.records.filter(row => !row.completeValid);
  if(failures.length){
    console.log("");
    console.log(`Non-complete/invalid runs: ${failures.length}`);
    for(const row of failures.slice(0, 12)){
      console.log(`- ${row.mode} seed=${row.seed}: ${row.failureKind || "validation_failed"}; violations=${row.validationViolationCount}`);
    }
  }
}

async function main(){
  if(process.argv.includes("--help") || process.argv.includes("-h")){
    printHelp();
    return null;
  }
  const options = parseArgs(process.argv.slice(2));
  const loaded = loadEngine();
  const fixtureSample = fixtureFactoryFor(options.fixture)().__benchmark;
  const records = [];
  for(const seed of options.seeds){
    for(const mode of options.modes){
      if(!options.quiet) process.stdout.write(`running ${mode} seed=${seed}...`);
      const row = await runOne(loaded, mode, seed, options);
      records.push(row);
      if(!options.quiet) process.stdout.write(` ${row.runtimeMs}ms ${row.completeValid ? "OK" : "FAIL"}\n`);
    }
  }
  const report = {
    schemaVersion:1,
    generatedAt:new Date().toISOString(),
    fixture:{
      name:fixtureSample.name,
      classes:fixtureSample.classes,
      teachers:fixtureSample.teachers,
      rooms:fixtureSample.rooms,
      requiredPeriods:fixtureSample.requiredPeriods,
      activityCountEstimate:fixtureSample.activityCountEstimate,
      anonymized:true,
      synthetic:Boolean(fixtureSample.synthetic),
      structuralFloors:fixtureSample.structuralFloors || {},
      activeConstraintCounts:fixtureSample.activeConstraintCounts || {}
    },
    seeds:options.seeds,
    modes:options.modes,
    fixtureVariant:options.fixture,
    budgets:{autoBudgetMs:options.autoBudgetMs, optimizerTimeoutMs:options.optimizerTimeoutMs},
    summary:aggregate(records),
    records
  };
  if(!options.quiet) printSummary(report);
  if(options.out){
    const outPath = path.resolve(process.cwd(), options.out);
    fs.mkdirSync(path.dirname(outPath), {recursive:true});
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");
    console.log(`JSON report: ${outPath}`);
  }
  if(options.strict && records.some(row => !row.completeValid)) process.exitCode = 1;
  return report;
}

if(require.main === module){
  main().catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}

module.exports = {
  loadEngine,
  createFixture,
  createPressureFixture,
  createMediumFixture,
  createStressFixture,
  validateSchedule,
  runOne,
  aggregate,
  parseArgs,
  printHelp
};
