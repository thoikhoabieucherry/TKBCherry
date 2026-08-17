const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.resolve(__dirname, "..", "web", "pages", "phanmon.js"),
  "utf8"
);

function checkpointValidationHelpers(){
  const start = source.indexOf("function fetHardViolationSignature(");
  const end = source.indexOf("function fetTelemetryNowMs()", start);
  assert.ok(start >= 0 && end > start, "checkpoint validator helpers must remain an isolated planner slice");
  return source.slice(start, end);
}

function loadHelpers(violationsForTkb){
  const window = {
    TKBConstraints:{
      async validateAllAsync(){
        return violationsForTkb(window.DATA.tkb);
      }
    }
  };
  const context = {
    window,
    JSON,
    Array,
    Map,
    Number,
    String,
    Object,
    Promise,
    console,
    cloneHybridScheduleState(data){
      return {
        tkb:JSON.parse(JSON.stringify(data.tkb || {})),
        tkbLessonTeachers:JSON.parse(JSON.stringify(data.tkbLessonTeachers || {})),
        tkbLessonRooms:JSON.parse(JSON.stringify(data.tkbLessonRooms || {}))
      };
    },
    restoreHybridScheduleState(data, snapshot){
      data.tkb = snapshot.tkb;
      data.tkbLessonTeachers = snapshot.tkbLessonTeachers;
      data.tkbLessonRooms = snapshot.tkbLessonRooms;
    }
  };
  vm.runInNewContext(checkpointValidationHelpers(), context, {filename:"planner-fet-checkpoint-validation.js"});
  return {window, context};
}

test("an improved checkpoint may retain only the exact hard violations already present in its incumbent", async () => {
  const sameLegacyBlock = marker => ({
    kind:"subject.lessonBlocks.min",
    lopId:"L1",
    mon:"Anh",
    message:`Anh has ${marker === "candidate" ? 1 : 0} contiguous blocks`
  });
  const {window, context} = loadHelpers(tkb => {
    if(tkb.marker === "candidate") return [sameLegacyBlock("candidate")];
    return [sameLegacyBlock("incumbent")];
  });
  const data = {tkb:{marker:"incumbent"}, tkbLessonTeachers:{}, tkbLessonRooms:{}};
  window.DATA = data;

  const baseline = await context.inspectFetCandidateHardConstraints(data, data.tkb);
  const result = await context.validateFetCandidateHardConstraints(data, {marker:"candidate"}, {
    allowUnchangedIncumbentViolations:true,
    incumbentBaseline:baseline
  });

  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.equal(result.hardValid, false);
  assert.equal(result.retainedLegacyViolations, 1);
  assert.equal(data.tkb.marker, "incumbent", "validation never mutates the current timetable");
});

test("a stopped checkpoint is rejected when it adds a new hard violation", async () => {
  const {window, context} = loadHelpers(tkb => {
    const legacy = {kind:"subject.lessonBlocks.min", lopId:"L1", mon:"Anh", message:"legacy block"};
    if(tkb.marker === "candidate"){
      return [legacy, {kind:"subject.lessonBlocks.min", lopId:"L1", mon:"KHTN", message:"new block"}];
    }
    return [legacy];
  });
  const data = {tkb:{marker:"incumbent"}, tkbLessonTeachers:{}, tkbLessonRooms:{}};
  window.DATA = data;

  const baseline = await context.inspectFetCandidateHardConstraints(data, data.tkb);
  const result = await context.validateFetCandidateHardConstraints(data, {marker:"candidate"}, {
    allowUnchangedIncumbentViolations:true,
    incumbentBaseline:baseline
  });

  assert.equal(result.ok, false);
  assert.equal(result.failureKind, "fet_candidate_hard_validation_failed");
  assert.equal(result.diagnostics.origin, "candidate_validation");
  assert.equal(result.diagnostics.introducedViolationCount, 1);
});

test("candidate-validation diagnostics do not masquerade as a zero-activity preflight", () => {
  assert.match(source, /const isCandidateValidation = diagnostics\.origin === "candidate_validation";/);
  assert.match(source, /Lịch mới chưa vượt qua kiểm tra ràng buộc/);
  assert.match(source, /Trạng thái", "Ràng buộc vi phạm/);
});
