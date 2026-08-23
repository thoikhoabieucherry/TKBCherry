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
  const end = source.indexOf("function nextPlannerPaint()", start);
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
    clonePlannerScheduleState(data){
      return {
        tkb:JSON.parse(JSON.stringify(data.tkb || {})),
        tkbLessonTeachers:JSON.parse(JSON.stringify(data.tkbLessonTeachers || {})),
        tkbLessonRooms:JSON.parse(JSON.stringify(data.tkbLessonRooms || {}))
      };
    },
    restorePlannerScheduleState(data, snapshot){
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
  assert.doesNotMatch(source, /if\(!diagnostics \|\| diagnostics\.origin === "candidate_validation"/,
    "candidate diagnostics must be renderable instead of being discarded by the panel guard");
});

test("validator comparison rejects a new violation even when its total count is not larger", () => {
  const {context} = loadHelpers(() => []);
  const baseline = [{kind:"fixed_cell", lopId:"L1", mon:"Toán"}];
  const candidate = [{kind:"teacher_clash", lopId:"L2", mon:"Văn", teacher:"GV02"}];
  const result = context.compareFetCandidateViolationsToIncumbent(candidate, {violations:baseline});

  assert.equal(result.ok, false);
  assert.equal(result.addedRows.length, 1);
});

test("terminal messages distinguish plateau, regression, hard violation, and validator error", () => {
  const {context} = loadHelpers(() => []);
  const plateau = context.fetFailurePresentation({failureKind:"fet_worker_no_improvement"});
  const regression = context.fetFailurePresentation({failureKind:"fet_candidate_quality_regression_rejected"});
  const hard = context.fetFailurePresentation({
    failureKind:"fet_candidate_hard_validation_failed",
    error:"Trùng tiết giáo viên GV01"
  });
  const validator = context.fetFailurePresentation({
    failureKind:"fet_candidate_validation_error",
    error:"validator crashed"
  });

  assert.match(plateau.message, /chưa tìm được lịch tốt hơn/i);
  assert.doesNotMatch(plateau.message, /chạm giới hạn ràng buộc/i);
  assert.match(regression.message, /không tốt hơn lịch hiện tại/i);
  assert.match(hard.message, /Trùng tiết giáo viên GV01/);
  assert.equal(hard.level, "warning");
  assert.match(validator.message, /Bộ kiểm tra nghiệm gặp lỗi/);
  assert.equal(validator.level, "error");
  assert.doesNotMatch(source, /Không thể tối ưu thêm do chạm giới hạn ràng buộc/);
  assert.doesNotMatch(source, /diagnostics:validationDiagnostics/,
    "candidate settlement must never reference an undefined diagnostics variable");
});
