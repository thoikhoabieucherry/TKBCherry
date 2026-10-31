"use strict";

// 29/08 (chủ dự án): môn dạy ghép KHÔNG có ngoại lệ trùng lịch. Cùng một GV ở
// hai lớp cùng giờ — kể cả hai lớp cùng một dòng dạy ghép (vd "AI-1" gán cho
// 25 lớp) — vẫn là trùng lịch GV như mọi môn khác. Test khoá hàm kiểm tra lúc
// kéo/xếp trong planner (findTeacherConflictAtSlot) để cơ chế "tiết học chung
// nhiều lớp" 28-29/08 (đã gỡ) không quay lại.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const PHANMON_PATH = path.resolve(__dirname, "..", "web", "pages", "phanmon.js");
const PHANMON_SOURCE = fs.readFileSync(PHANMON_PATH, "utf8");

function blankSession(values = []){
  return Array.from({length:5}, (_, index) => values[index] || "");
}

function same(a, b){ assert.equal(JSON.stringify(a), JSON.stringify(b)); }

function splitTeachers(raw){
  return String(raw || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

function loadFinder(data){
  const start = PHANMON_SOURCE.indexOf("function findTeacherConflictAtSlot");
  const end = PHANMON_SOURCE.indexOf("\nfunction ", start + 10);
  assert.ok(start >= 0 && end > start, "findTeacherConflictAtSlot source must be extractable");
  const context = {
    DATA:data,
    cellMon(v){ if(v === "OFF" || v == null || v === "") return ""; return typeof v === "string" ? v : String(v.mon || ""); },
    getLopCanonById(id){ return String(id); },
    getTeacherForClassMon(lop, mon){ return data.pccmMatrix[`${lop}|${mon}`] || ""; },
    teacherValueFromRaw(raw){ return splitTeachers(raw).join(", "); },
    teacherValuesIntersect(a, b){ const bb = new Set(splitTeachers(b)); return splitTeachers(a).some(x => bb.has(x)); },
    tkbIsJointGhepPair(monA, lopA, monB, lopB){
      if(String(lopA) === String(lopB)) return false;
      const name = id => (data.lop.find(l => l.id === id) || {}).ten;
      const rowOf = (mon, lop) => (data.dayGhep || []).find(r => r.lop.length >= 2 && r.ten === mon && r.lop.includes(name(lop))) || null;
      const ra = rowOf(monA, lopA); return !!ra && ra === rowOf(monB, lopB);
    }
  };
  vm.runInNewContext(PHANMON_SOURCE.slice(start, end), context, {filename:PHANMON_PATH});
  return context.findTeacherConflictAtSlot;
}

function school(){
  return {
    lop:[{id:"L1", ten:"6.1"}, {id:"L2", ten:"6.2"}, {id:"L3", ten:"6.3"}],
    giaovien:[{magv:"GV.AI", ten:"AI"}, {magv:"GV1", ten:"Trâm"}, {magv:"GV2", ten:"Vân"}],
    dayGhep:[
      {id:"DG1", lop:["6.1", "6.2", "6.3"], mon:["Tin"], gv:["GV.AI"], sotiet:1, gioihan:1, viettat:"AI-1", ten:"AI-1"},
      {id:"DG2", lop:["6.1"], mon:["HĐTN"], gv:["GV1", "GV2"], sotiet:1, gioihan:1, viettat:"CLB", ten:"CLB"}
    ],
    pccmMatrix:{"L1|AI-1":"GV.AI", "L2|AI-1":"GV.AI", "L3|AI-1":"GV.AI", "L1|CLB":"GV1, GV2", "L2|KHTN":"GV2"},
    tkb:{
      L1:{thu2:{sang:blankSession(["AI-1", "CLB"]), chieu:blankSession()}},
      L2:{thu2:{sang:blankSession(), chieu:blankSession()}},
      L3:{thu2:{sang:blankSession(), chieu:blankSession()}}
    }
  };
}

test("cung mot dong day ghep nhieu lop = MOT tiet hoc chung: dat vao lop thu hai cung gio KHONG trung; khong biet mon (duong cu) van coi la trung", () => {
  const data = school();
  const find = loadFinder(data);
  // 6.1 đã có AI-1 (GV.AI) thứ 2 tiết 1 → đặt AI-1 cho 6.2 cùng giờ là cùng tiết chung (hội trường)
  assert.equal(find("GV.AI", "thu2", "sang", 0, "L2", "AI-1"), null);
  // đường cũ không truyền môn đang đặt -> vẫn báo trùng
  same(find("GV.AI", "thu2", "sang", 0, "L2"), {lopId:"L1", mon:"AI-1"});
  // giờ khác thì được
  assert.equal(find("GV.AI", "thu2", "sang", 2, "L2", "AI-1"), null);
});

test("mon ghep nhieu GV: tung thanh vien deu bi tinh trung lich", () => {
  const data = school();
  const find = loadFinder(data);
  // 6.1 có CLB (GV1, GV2) tiết 2 → KHTN của GV2 ở 6.2 cùng giờ bị chặn
  same(find("GV2", "thu2", "sang", 1, "L2"), {lopId:"L1", mon:"CLB"});
  // và ngược lại: đặt CLB (GV1, GV2) vào lớp khác trùng giờ AI-1? không trùng (GV.AI khác) → null
  assert.equal(find("GV1, GV2", "thu2", "sang", 0, "L3"), null);
  same(find("GV1, GV2", "thu2", "sang", 1, "L3"), {lopId:"L1", mon:"CLB"});
});

function loadTeacherSchedule(data){
  const a = PHANMON_SOURCE.indexOf("function buildTeacherSchedule(");
  const b = PHANMON_SOURCE.indexOf("\nfunction ", a + 10);
  const c = PHANMON_SOURCE.indexOf("function cellLegacyTeacher(");
  const d = PHANMON_SOURCE.indexOf("\nfunction ", c + 10);
  assert.ok(a >= 0 && b > a && c >= 0 && d > c, "buildTeacherSchedule/cellLegacyTeacher must be extractable");
  const context = {
    DATA:data, DAYS:["thu2"], SANG:5, CHIEU:5,
    getFilteredLops(){ return data.lop; },
    classCanonFromLop(l){ return l.ten; },
    getLopCanonById(id){ const l = data.lop.find(x => x.id === id); return l ? l.ten : String(id); },
    cellMon(v){ if(v === "OFF" || v == null || v === "") return ""; return typeof v === "string" ? v : String(v.mon || ""); },
    isFixed(v){ return !!(v && typeof v === "object" && v.fixed); },
    isShownFixed(v){ return !!(v && typeof v === "object" && v.fixed) && !v.jointPin; },
    getTeacherForClassMon(lop, mon){ return data.pccmMatrix[`${lop}|${mon}`] || ""; },
    getRoomForClassMon(){ return ""; },
    teacherValueHas(raw, code){ return splitTeachers(raw).includes(String(code).toLowerCase()); }
  };
  vm.runInNewContext(PHANMON_SOURCE.slice(c, d) + "\n" + PHANMON_SOURCE.slice(a, b), context, {filename:PHANMON_PATH});
  return context.buildTeacherSchedule;
}

test("TKB giao vien: ten mon ghep chua ' - ' (AI - 1) khong bi doc thanh 'Mon - GV' dang cu", () => {
  const data = {
    lop:[{id:"L1", ten:"6.1"}, {id:"L2", ten:"6.2"}],
    pccmMatrix:{"6.1|AI - 1":"GV.AI", "6.2|AI - 1":"GV.AI", "6.2|Toán":"GV1"},
    tkb:{
      L1:{thu2:{sang:blankSession(["AI - 1"]), chieu:blankSession()}},
      L2:{thu2:{sang:blankSession(["", {mon:"AI - 1", fixed:true}, "Toán - GV1"]), chieu:blankSession()}}
    }
  };
  const build = loadTeacherSchedule(data);
  const ai = build("GV.AI");
  same(ai.thu2.sang.map(l => l.map(e => e.classId + ":" + e.mon + (e.fixed ? "*" : ""))), [["L1:AI - 1"], ["L2:AI - 1*"], [], [], []]);
  const gv1 = build("GV1");
  same(gv1.thu2.sang.map(l => l.length), [0, 0, 1, 0, 0], "dang cu 'Mon - GV' van doc duoc khi ca chuoi khong phai mon da phan cong");
  const one = build("1");
  same(one.thu2.sang.map(l => l.length), [0, 0, 0, 0, 0], "'1' khong phai giao vien");
});

test("phanmon.js co khoi TIET HOC CHUNG NHIEU LOP (dong bo tai diem luu, ghim tam truoc khi giai) va khong con co che nhan o cu", () => {
  assert.equal(/tkbMirrorGhepPlacement|tkbPinJointGhepGroups/.test(PHANMON_SOURCE), false);
  ["function tkbJointReconcile(", "function tkbJointPinForSolve(", "function tkbJointUnpin(", "function tkbIsJointGhepPair("].forEach(fn => assert.ok(PHANMON_SOURCE.includes(fn), fn));
});
