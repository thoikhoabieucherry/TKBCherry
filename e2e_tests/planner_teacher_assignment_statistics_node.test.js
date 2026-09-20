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

function loadTeacherStatisticsContext(){
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
  const teacherOrder = ["GV1", "GV2", "GV3"];
  const context = {
    console,
    setTimeout,
    clearTimeout,
    DATA:{
      lop:classes,
      monhoc,
      mon:standards,
      giaovien:[
        {magv:"GV1", hodem:"A", ten:"Một"},
        {magv:"GV2", hodem:"B", ten:"Hai"},
        {magv:"GV3", hodem:"C", ten:"Ba"}
      ],
      pccmMatrix:{
        "6A1|SHDC":"GV1, GV2",
        "6A1|TOAN":"GV1",
        "7A1|SHDC":"GV3",
        "7A1|TOAN":"GV1 + GV2",
        "7A1|VAN":"GV3"
      },
      pccmTietMatrix:{"6A1|TOAN":"5"},
      tkbLessonTeachers:{},
      tkb:{
        L1:{T2:{sang:["TOAN", "TOAN", "VAN", "VAN", "VAN"], chieu:[]}},
        L2:{T2:{sang:["TOAN", "TOAN", "TOAN", "TOAN", "VAN"], chieu:[]}}
      }
    },
    window:{},
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
    resolveTeacherCode(code){ return String(code || "").trim(); },
    getTeacherNameByCode(code){
      const row = context.DATA.giaovien.find(g => g.magv === code);
      return row ? `${row.hodem} ${row.ten}` : code;
    },
    compareTeacherCodeByDataOrder(a, b){
      const ia = teacherOrder.indexOf(String(a));
      const ib = teacherOrder.indexOf(String(b));
      if(ia >= 0 || ib >= 0) return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
      return String(a).localeCompare(String(b), "vi");
    },
    cellLegacyTeacher(){ return ""; },
    tkbIsNoTeacherGhep(){ return false; },
    cellMon(cell){ return typeof cell === "object" ? String(cell?.mon || "") : String(cell || ""); },
    compareMonByHiddenCode(a, b){ return String(a || "").localeCompare(String(b || ""), "vi"); },
    escapeHtml(value){
      return String(value == null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    },
    calcTeacherTKBStats(){
      return {
        soBuoiDay1:2,
        soBuoiTrong1:1,
        soBuoiTrong2:0,
        tsBuoiDay:5,
        onePeriodTeachers:[{code:"GV1", count:1, sessions:[{}]}],
        gap1Teachers:[{code:"GV3", count:1}],
        gap2Teachers:[]
      };
    },
    closeStatsPopover(){},
    closePrintTKBMenu(){}
  };
  context.window = context;
  vm.createContext(context);
  const start = plannerSource.indexOf('const CLASS_ASSIGNMENT_STATS_MODAL_ID = "classAssignmentStatsModal";');
  const end = plannerSource.indexOf("function renderStatsBox()", start);
  assert.ok(start >= 0 && end > start, "statistics source block must exist");
  vm.runInContext(plannerSource.slice(start, end), context, {filename:plannerPath});
  return context;
}

test("teacher assignment statistics aggregate PCCM periods and schedule placement", () => {
  const context = loadTeacherStatisticsContext();
  const model = JSON.parse(vm.runInContext("JSON.stringify(buildTeacherAssignmentStatistics())", context));

  assert.deepEqual(model.subjects.map(s => s.label), ["SHDC", "VAN", "TOAN"]);
  const byCode = Object.fromEntries(model.rows.map(row => [row.code, row]));
  assert.equal(byCode.GV1.totalPeriods, 1 + 5 + 4, "GV1: SHDC+TOAN 6A1 + TOAN 7A1");
  assert.equal(byCode.GV2.totalPeriods, 1 + 4, "GV2: SHDC 6A1 + TOAN 7A1");
  assert.equal(byCode.GV3.totalPeriods, 1 + 3, "GV3: SHDC+VAN 7A1");
  assert.equal(byCode.GV1.onePeriod, 1);
  assert.equal(byCode.GV3.gap1, 1);
  assert.ok(byCode.GV1.daXep >= 2, "placed TOAN cells for GV1 must count");
  assert.ok(byCode.GV1.chuaXep >= 0);
});

test("teacher assignment table exposes quality columns and menu wiring", () => {
  const context = loadTeacherStatisticsContext();
  const html = vm.runInContext(
    "renderTeacherAssignmentStatisticsTable(buildTeacherAssignmentStatistics())",
    context
  );
  assert.match(html, />Giáo viên<\/th>/);
  assert.match(html, />1 tiết\/buổi<\/th>/);
  assert.match(html, /data-teacher-code="GV1"/);
  assert.match(menuSource, /data-rb-statistics="teacher">Thống kê theo giáo viên/);
  assert.match(menuSource, /openTeacherAssignmentStatistics/);
  assert.match(plannerHtml, /tkb-constraints-menu\.js\?v=20260919-teacher-stats-v1/);
  assert.match(plannerHtml, /phanmon\.js\?v=20260920-soft-stop-visible-v1/);
  assert.match(plannerHtml, /tkb-rust-bridge\.js\?v=20260920-soft-stop-visible-v1/);
});
