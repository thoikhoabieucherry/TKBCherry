"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const plannerPath = path.join(root, "web", "pages", "phanmon.js");
const plannerSource = fs.readFileSync(plannerPath, "utf8");
const menuSource = fs.readFileSync(path.join(root, "web", "pages", "tkb-constraints-menu.js"), "utf8");
const plannerHtml = fs.readFileSync(path.join(root, "web", "pages", "sapxep.html"), "utf8");
const plannerCss = fs.readFileSync(path.join(root, "web", "pages", "phanmon.css"), "utf8");

function loadStatisticsContext(){
  const classes = [
    {id:"L1", ten:"6A1", ten2:"6A1", khoi:"Khối 6"},
    {id:"L2", ten:"7A1", ten2:"7A1", khoi:"Khối 7"}
  ];
  const monhoc = [
    {ten:"Sinh hoạt dưới cờ", ma:"SHDC"},
    {ten:"Ngữ văn", ma:"VAN"},
    {ten:"Toán", ma:"TOAN"}
  ];
  const standards = [
    {khoi:"Khối 6", ten:"SHDC", sotiet:"1"},
    {khoi:"Khối 6", ten:"TOAN", sotiet:"4"},
    {khoi:"Khối 6", ten:"VAN", sotiet:"3"},
    {khoi:"Khối 7", ten:"SHDC", sotiet:"1"},
    {khoi:"Khối 7", ten:"TOAN", sotiet:"4"},
    {khoi:"Khối 7", ten:"VAN", sotiet:"3"}
  ];
  const aliases = new Map([
    ["sinh hoạt dưới cờ", "shdc"],
    ["shdc", "shdc"],
    ["ngữ văn", "van"],
    ["van", "van"],
    ["toán", "toan"],
    ["toan", "toan"]
  ]);
  const canonical = value => aliases.get(String(value || "").trim().toLowerCase()) || String(value || "").trim().toLowerCase();
  const recordFor = value => {
    const key = canonical(value);
    return monhoc.find(record => [record.ten, record.ma].some(alias => canonical(alias) === key)) || null;
  };
  const classAliases = {
    "6A1":["6A1", "L1"],
    "7A1":["7A1", "L2"]
  };
  const context = {
    console,
    setTimeout,
    clearTimeout,
    DATA:{
      lop:classes,
      monhoc,
      mon:standards,
      pccmMatrix:{
        "6A1|SHDC":"GV1, GV2",
        "6A1|TOAN":"GV1",
        "7A1|SHDC":"GV3",
        "7A1|TOAN":"GV1 + GV2",
        "7A1|VAN":"GV3"
      },
      pccmTietMatrix:{"6A1|TOAN":"5"},
      tkbLessonTeachers:{"6A1|SHDC":"GV9", "6A1|VAN":"GV-STALE"},
      tkb:{
        L1:{T2:{sang:["TOAN", "TOAN", "VAN", "VAN", "VAN"], chieu:[]}},
        L2:{T2:{sang:["TOAN", "TOAN", "TOAN", "TOAN", "VAN"], chieu:[]}}
      }
    },
    window:null,
    document:{
      addEventListener(){},
      getElementById(){ return null; },
      createElement(){ throw new Error("not used by the pure model test"); },
      body:{classList:{add(){}, remove(){}}}
    },
    DAYS:["T2"],
    normKey:canonical,
    monCanonicalKey:canonical,
    findMonHoc:recordFor,
    getMonShort(value){ return recordFor(value)?.ma || String(value || ""); },
    classKeyCandidates(value){ return classAliases[String(value || "")] || [String(value || "")]; },
    getSoTietForClassMon(className, subject){
      const keys = classAliases[String(className || "")] || [String(className || "")];
      for(const cls of keys){
        for(const alias of [subject, recordFor(subject)?.ma, recordFor(subject)?.ten].filter(Boolean)){
          const raw = context.DATA.pccmTietMatrix[cls + "|" + alias];
          if(Number(raw) > 0) return Number(raw);
        }
      }
      return 0;
    },
    extractKhoiNumber(value){ return String(value || "").match(/\d+/)?.[0] || ""; },
    _findTietChuanRow(grade, subject){
      const key = canonical(subject);
      return standards.find(row => context.extractKhoiNumber(row.khoi) === String(grade) && canonical(row.ten) === key) || null;
    },
    _collectPCCMSubjectKeysForClass(className){
      const keys = new Set();
      const aliasesForClass = classAliases[String(className || "")] || [String(className || "")];
      Object.keys(context.DATA.pccmMatrix).forEach(rawKey => {
        const separator = rawKey.indexOf("|");
        if(separator < 0) return;
        if(aliasesForClass.includes(rawKey.slice(0, separator))) keys.add(rawKey.slice(separator + 1));
      });
      return keys;
    },
    classCanonFromLop(lop){ return lop?.ten2 || lop?.ten || lop?.id || ""; },
    getLopCanonById(id){ return classes.find(lop => lop.id === id)?.ten2 || id; },
    teacherListFromValue(raw){
      return String(raw || "").split(/[,+;]/).map(value => value.trim()).filter(Boolean);
    },
    requiredSubjectsForClass(lop){
      const grade = context.extractKhoiNumber(lop?.khoi || lop?.ten2 || lop?.ten);
      return standards
        .filter(row => context.extractKhoiNumber(row.khoi) === grade)
        .map(row => ({
          mon:row.ten,
          required:context.getSoTietForClassMon(context.getLopCanonById(lop?.id), row.ten) || Number(row.sotiet),
          gv:"GV-STALE"
        }));
    },
    buildTkbMonCountMap(tkb){
      const counts = new Map();
      context.DAYS.forEach(day => ["sang", "chieu"].forEach(session => {
        (tkb?.[day]?.[session] || []).forEach(cell => {
          const mon = context.cellMon(cell);
          if(!mon || mon === "OFF") return;
          const key = canonical(mon);
          counts.set(key, (counts.get(key) || 0) + 1);
        });
      }));
      return counts;
    },
    countMonFromTkbCountMap(counts, mon){ return Number(counts.get(canonical(mon)) || 0); },
    cellMon(cell){ return typeof cell === "object" ? String(cell?.mon || "") : String(cell || ""); },
    isFixed(){ return false; },
    getRoomForClassMon(){ return ""; },
    compareMonByHiddenCode(a, b){ return String(a || "").localeCompare(String(b || ""), "vi"); },
    escapeHtml(value){
      return String(value == null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }
  };
  context.window = context;
  vm.createContext(context);
  const start = plannerSource.indexOf('const CLASS_ASSIGNMENT_STATS_MODAL_ID = "classAssignmentStatsModal";');
  const end = plannerSource.indexOf("function renderStatsBox()", start);
  assert.ok(start >= 0 && end > start, "class statistics source block must exist");
  vm.runInContext(plannerSource.slice(start, end), context, {filename:plannerPath});

  const collectStart = plannerSource.indexOf("function collectUnassignedTasks(");
  const collectEnd = plannerSource.indexOf("function tkbAutoRepairCellStub(", collectStart);
  vm.runInContext(plannerSource.slice(collectStart, collectEnd), context, {filename:plannerPath});

  const classPeriodStart = plannerSource.indexOf("function calcClassTKBPeriodStats(");
  const classPeriodEnd = plannerSource.indexOf("function goToUnassignedItem(", classPeriodStart);
  vm.runInContext(plannerSource.slice(classPeriodStart, classPeriodEnd), context, {filename:plannerPath});

  const schoolStatsStart = plannerSource.indexOf("let SCHOOL_TKB_STATS_CACHE =");
  const schoolStatsEnd = plannerSource.indexOf("try{ window.renderStatsBox", schoolStatsStart);
  vm.runInContext(plannerSource.slice(schoolStatsStart, schoolStatsEnd), context, {filename:plannerPath});
  return context;
}

test("class assignment statistics preserve subject order and split single versus combined periods", () => {
  const context = loadStatisticsContext();
  const model = JSON.parse(vm.runInContext("JSON.stringify(buildClassAssignmentStatistics())", context));

  assert.deepEqual(model.subjects.map(subject => subject.label), ["SHDC", "VAN", "TOAN"]);
  assert.deepEqual(
    model.rows.map(row => ({
      className:row.className,
      single:row.singlePeriods,
      combined:row.combinedPeriods,
      total:row.totalPeriods
    })),
    [
      {className:"6A1", single:5, combined:1, total:6},
      {className:"7A1", single:4, combined:4, total:8}
    ]
  );
  assert.equal(model.rows[0].subjectPeriods.toan, 5, "class override must beat the grade standard");
  assert.equal(model.rows[0].subjectPeriods.van || 0, 0, "unassigned standard subjects must not be counted");
  assert.equal(Object.prototype.hasOwnProperty.call(model.rows[0].subjectPeriods, "van"), false,
    "unassigned subjects must not be added to a class row");
  assert.equal(model.rows[0].combinedPeriods, 1, "tkbLessonTeachers must not override PCCM classification");
  model.rows.forEach(row => {
    const subjectTotal = Object.values(row.subjectPeriods).reduce((sum, value) => sum + Number(value || 0), 0);
    assert.equal(row.singlePeriods + row.combinedPeriods, row.totalPeriods);
    assert.equal(row.totalPeriods, subjectTotal);
  });
});

test("class assignment table follows the grouped-header layout without unassigned periods", () => {
  const context = loadStatisticsContext();
  const html = vm.runInContext("renderClassAssignmentStatisticsTable(buildClassAssignmentStatistics())", context);

  assert.match(html, /rowspan="2"[^>]*>TT<\/th>/);
  assert.match(html, /colspan="3"[^>]*>Tổng số<\/th>/);
  assert.match(html, />Tiết đơn<\/th><th[^>]*>Tiết ghép<\/th>/);
  assert.match(html, /class="class-stats-total-col"[^>]*>Cộng<\/th>/);
  assert.match(html, /data-class-id="L2"[^>]*class-stats-grade-start|class="class-stats-grade-start"[^>]*data-class-id="L2"/);
  assert.doesNotMatch(html, /class="class-stats-missing"/);
  assert.doesNotMatch(html, /title="Chưa phân công giáo viên"/);
  assert.match(plannerCss, /\.class-assignment-stats-table \.class-stats-subject-col[\s\S]*?min-width:\s*68px/);
});

test("external school, class and unassigned statistics ignore subjects without PCCM teachers", () => {
  const context = loadStatisticsContext();
  const school = JSON.parse(vm.runInContext("JSON.stringify(calcSchoolTKBStats())", context));
  assert.deepEqual(
    {total:school.soTiet, missing:school.chuaXepTiet, teachers:school.soGV},
    {total:14, missing:7, teachers:3},
    "the 3-period VAN demand with no 6A1 PCCM teacher must be excluded"
  );

  const classStats = JSON.parse(vm.runInContext("JSON.stringify(calcClassTKBPeriodStats('L1'))", context));
  assert.deepEqual(classStats, {total:6, assigned:2, missing:4});

  const tasks = JSON.parse(vm.runInContext("JSON.stringify(collectUnassignedTasks())", context));
  assert.deepEqual(
    tasks.map(task => [task.classId, task.mon, task.remain]),
    [["L1", "SHDC", 1], ["L1", "TOAN", 3], ["L2", "SHDC", 1], ["L2", "VAN", 2]],
    "unassigned drilldown must not resurrect 6A1 VAN"
  );
  assert.equal(tasks.some(task => task.classId === "L1" && task.mon === "VAN"), false);
});

test("PCCM teacher statistics memoize repeated class-subject lookups and reset on data replacement", () => {
  const context = loadStatisticsContext();
  let aliasCalls = 0;
  const originalClassKeyCandidates = context.classKeyCandidates;
  context.classKeyCandidates = (...args) => {
    aliasCalls += 1;
    return originalClassKeyCandidates(...args);
  };

  const first = vm.runInContext(
    "classAssignmentStatisticsTeacherForClassMon('6A1', 'TOAN')",
    context
  );
  for(let i = 0; i < 200; i += 1){
    assert.equal(
      vm.runInContext("classAssignmentStatisticsTeacherForClassMon('6A1', 'TOAN')", context),
      first
    );
  }
  assert.equal(aliasCalls, 1, "the same cell should be resolved once per PCCM snapshot");

  context.DATA.pccmMatrix = Object.assign({}, context.DATA.pccmMatrix, {"6A1|TOAN":"GV9"});
  const replaced = vm.runInContext(
    "classAssignmentStatisticsTeacherForClassMon('6A1', 'TOAN')",
    context
  );
  assert.equal(replaced, "GV9");
  assert.equal(aliasCalls, 2, "replacing PCCM data must invalidate the memoized lookup");
});

test("requirements menu puts Statistics by class immediately above Print TKB", () => {
  const buildStart = menuSource.indexOf("function buildMenu()");
  const buildEnd = menuSource.indexOf("function closeMenu()", buildStart);
  const menuBlock = menuSource.slice(buildStart, buildEnd);
  const statisticsIndex = menuBlock.indexOf(">Thống kê <");
  const printIndex = menuBlock.indexOf(">In TKB <");

  assert.ok(statisticsIndex >= 0 && printIndex > statisticsIndex);
  assert.match(menuSource, /data-rb-statistics="class">Thống kê theo lớp/);
  assert.match(menuSource, /openClassAssignmentStatistics/);
  assert.match(plannerCss, /\.class-assignment-stats-table-wrap[\s\S]*?overflow:\s*auto/);
  assert.match(plannerHtml, /phanmon\.css\?v=20260808-v1192-assigned-only-all-statistics-v1/);
  assert.match(plannerHtml, /phanmon\.js\?v=20260808-v1192-assigned-only-all-statistics-v1/);
  assert.match(plannerHtml, /tkb-constraints-menu\.js\?v=20260808-v1192-assigned-only-all-statistics-v1/);
});
