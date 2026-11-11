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

function loadPresenceContext(){
  const classes = [
    {id:"L1", ten:"6A1", ten2:"6A1", khoi:"Khối 6"},
    {id:"L2", ten:"7A1", ten2:"7A1", khoi:"Khối 7"}
  ];
  const monhoc = [
    {ten:"Toán", ma:"TOAN"},
    {ten:"Ngữ văn", ma:"VAN"}
  ];
  const standards = [
    {khoi:"Khối 6", ten:"TOAN", sotiet:"4"},
    {khoi:"Khối 6", ten:"VAN", sotiet:"3"},
    {khoi:"Khối 7", ten:"TOAN", sotiet:"4"},
    {khoi:"Khối 7", ten:"VAN", sotiet:"3"}
  ];
  const aliases = new Map([
    ["toán", "toan"], ["toan", "toan"],
    ["ngữ văn", "van"], ["van", "van"]
  ]);
  const canonical = value => aliases.get(String(value || "").trim().toLowerCase()) || String(value || "").trim().toLowerCase();
  const recordFor = value => {
    const key = canonical(value);
    return monhoc.find(record => [record.ten, record.ma].some(alias => canonical(alias) === key)) || null;
  };
  const classAliases = {"6A1":["6A1", "L1"], "7A1":["7A1", "L2"]};
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
        {magv:"GV2", hodem:"B", ten:"Hai"}
      ],
      pccmMatrix:{
        "6A1|TOAN":"GV1",
        "6A1|VAN":"GV2",
        "7A1|TOAN":"GV1",
        "7A1|VAN":"GV2"
      },
      pccmTietMatrix:{},
      tkbLessonTeachers:{},
      tkbConstraints:{fixedOff:{teacher:{}, class:{}, subject:{}, room:{}, subjectGroup:{}}},
      tkb:{
        L1:{
          thu2:{sang:["TOAN", "TOAN", "", "", ""], chieu:[]},
          thu3:{sang:["", "", "", "", ""], chieu:[]}
        },
        L2:{
          thu2:{sang:["VAN", "", "", "", ""], chieu:[]},
          thu3:{sang:["", "", "", "", ""], chieu:[]}
        }
      }
    },
    window:{},
    document:{
      addEventListener(){},
      getElementById(){ return null; },
      createElement(){ throw new Error("not used"); },
      body:{classList:{add(){}, remove(){}}}
    },
    DAYS:["thu2","thu3","thu4","thu5","thu6","thu7"],
    SANG:5,
    CHIEU:5,
    LABEL:{thu2:"Thứ 2", thu3:"Thứ 3", thu4:"Thứ 4", thu5:"Thứ 5", thu6:"Thứ 6", thu7:"Thứ 7"},
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
    getTeacherForClassMon(classCanon, mon){
      const aliases = classAliases[String(classCanon || "")] || [String(classCanon || "")];
      for(const cls of aliases){
        for(const alias of [mon, recordFor(mon)?.ma, recordFor(mon)?.ten].filter(Boolean)){
          const raw = context.DATA.pccmMatrix[cls + "|" + alias];
          if(raw) return raw;
        }
      }
      return "";
    },
    classAssignmentStatisticsSubjectMeta(value){
      const record = recordFor(value);
      if(!record) return null;
      return {key:canonical(record.ma || record.ten), label:record.ma || record.ten, fullName:record.ten, source:record.ten};
    },
    classAssignmentStatisticsPeriodForClassMon(lop, classCanon, mon, fallback){
      const override = context.getSoTietForClassMon(classCanon, mon);
      if(override > 0) return override;
      const grade = context.extractKhoiNumber(lop?.khoi);
      const row = context._findTietChuanRow(grade, mon);
      return Math.max(0, Number(row?.sotiet || fallback || 0) || 0);
    },
    classAssignmentStatisticsTeacherForClassMon(classCanon, mon){
      return context.getTeacherForClassMon(classCanon, mon);
    },
    compareTeacherCodeByDataOrder(a, b){ return String(a).localeCompare(String(b), "vi"); },
    cellLegacyTeacher(){ return ""; },
    tkbIsNoTeacherGhep(){ return false; },
    cellMon(cell){ return typeof cell === "object" ? String(cell?.mon || "") : String(cell || ""); },
    compareMonByHiddenCode(a, b){ return String(a || "").localeCompare(String(b || ""), "vi"); },
    isTeacherFixedOff(){ return false; },
    escapeHtml(value){
      return String(value == null ? "" : value)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    },
    calcSchoolTKBStats(){ return {daXepTiet:3, chuaXepTiet:11}; },
    closeStatsPopover(){},
    closePrintTKBMenu(){},
    closeClassAssignmentStatistics(){},
    closeTeacherAssignmentStatistics(){}
  };
  context.window = context;
  vm.createContext(context);
  const start = plannerSource.indexOf("const TEACHER_SLOT_PRESENCE_MODAL_ID");
  const end = plannerSource.indexOf("function renderStatsBox()", start);
  assert.ok(start >= 0 && end > start, "presence statistics source block must exist");
  // Need helpers from teacher assignment block too for classAssignmentStatistics*
  const helperStart = plannerSource.indexOf('const CLASS_ASSIGNMENT_STATS_MODAL_ID = "classAssignmentStatsModal";');
  assert.ok(helperStart >= 0);
  vm.runInContext(plannerSource.slice(helperStart, end), context, {filename:plannerPath});
  return context;
}

test("teacher slot presence counts actual TKB teachers per slot", () => {
  const context = loadPresenceContext();
  const model = JSON.parse(vm.runInContext("JSON.stringify(buildTeacherSlotPresenceStatistics())", context));
  assert.equal(model.actual.thu2.sang[0], 2, "thu2 sang tiet 1: GV1 TOAN + GV2 VAN");
  assert.equal(model.actual.thu2.sang[1], 1, "thu2 sang tiet 2: only GV1");
  assert.equal(model.teacherCount, 2);
  // GV1: 4+4, GV2: 3+3 → 14 tiết; Hamilton giữ tổng trên lưới tiên lượng.
  assert.equal(model.periodMass, 14);
  const forecastSum = model.days.reduce((sum, thu) => {
    return sum
      + model.forecast[thu].sang.reduce((a, b) => a + b, 0)
      + model.forecast[thu].chieu.reduce((a, b) => a + b, 0);
  }, 0);
  assert.equal(forecastSum, 14, "forecast grid mass equals PCCM teacher-periods");
  assert.ok(model.forecast.thu2.sang[0] > 0, "largest-remainder puts early mass on thu2 sang 1");
  assert.equal(model.available.thu2.sang[0], 2);
});

test("teacher slot presence menu and cache wiring", () => {
  const context = loadPresenceContext();
  const html = vm.runInContext(
    "renderTeacherSlotPresenceTable(buildTeacherSlotPresenceStatistics(), 'forecast')",
    context
  );
  assert.match(html, /THỨ 2/i);
  assert.match(html, /teacher-slot-presence-session-end/);
  assert.match(menuSource, /data-rb-statistics="presence">Tiên lượng GV \/ thời điểm/);
  assert.match(menuSource, /openTeacherSlotPresenceStatistics/);
  assert.match(plannerHtml, /tkb-constraints-menu\.js\?v=20260920-presence-forecast-v1/);
  assert.match(plannerHtml, /phanmon\.js\?v=20260920-presence-forecast-v1/);
});
