"use strict";

// 01/10: chủ dự án (THCS Tân Phú Trung TKB 3): "trong tiết ghép đã phân giới hạn ví dụ là 2 ... tôi kéo 2 tiết
// liền thì báo là giới hạn môn này chỉ có 1 ... trong phân công không có phân môn này nhưng bạn lấy rule từ bên
// đó qua cho các tiết dạy ghép là chưa đúng". Tiết dạy ghép phải dùng Số tiết / Giới hạn tiết/buổi của CHÍNH dòng
// ghép (khoá "Lớp|<ten ghép>" hoặc row.gioihan), kể cả dòng KHÔNG GV mà CURRENT_MON_META không có.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const PHANMON_PATH = process.env.TKB_PHANMON_PATH
  ? path.resolve(process.env.TKB_PHANMON_PATH)
  : path.resolve(__dirname, "..", "web", "pages", "phanmon.js");
const SRC = fs.readFileSync(PHANMON_PATH, "utf8");

function slice(startMarker, endMarker){
  const start = SRC.indexOf(startMarker);
  const end = SRC.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `không tách được đoạn ${startMarker}`);
  return SRC.slice(start, end);
}

function blankSession(values = []){
  return Array.from({length:5}, (_, i) => values[i] || "");
}
function lessonValue(v){
  if(v === "OFF" || v === "" || v == null) return "";
  if(typeof v === "string") return v;
  return v && typeof v === "object" ? String(v.mon || "") : "";
}

// 6A1 (L001): Bản ngữ ghép KHÔNG GV, 2 tiết, giới hạn 2; Toán thường (giới hạn 1).
function schoolData(opts = {}){
  const data = {
    lop:[{id:"L001", ten:"6A1"}, {id:"L002", ten:"6A2"}],
    dayGhep:[
      {id:"DG010", ten:"Bản ngữ (ghép)", viettat:"Bản ngữ", lop:["6A1"], mon:["Bản ngữ"], gv:[], sotiet:"2", gioihan:"2"},
      {id:"DG011", ten:"THQT", viettat:"THQT", lop:["6A1", "6A2"], mon:["TIQT"], gv:[], sotiet:"2", gioihan:"2"}
    ],
    pccmMatrix:{"6A1|Toán":"T.An"},
    pccmTietMatrix:{"6A1|Toán":"4", "6A1|Bản ngữ (ghép)":"2", "6A1|THQT":"2", "6A2|THQT":"2"},
    pccmGioihanMatrix:{"6A1|Toán":"1", "6A1|Bản ngữ (ghép)":"2", "6A1|THQT":"2", "6A2|THQT":"2"},
    tkb:{L001:{thu2:{sang:blankSession(), chieu:blankSession(opts.chieu || [])}}}
  };
  if(opts.noProjection){ delete data.pccmGioihanMatrix["6A1|Bản ngữ (ghép)"]; delete data.pccmTietMatrix["6A1|Bản ngữ (ghép)"]; }
  return data;
}

function load(data, extra = {}){
  const context = {
    DATA:data,
    currentLop:"L001",
    // như trang thật: danh sách môn của lớp chỉ có môn đã phân công GV, khoá theo tên hiển thị
    CURRENT_MON_META:{"Toán":{sotiet:4, gioihan:1}, "Bản ngữ":{sotiet:2, gioihan:1}},
    CURRENT_MONS:[],
    dragData:extra.dragData || null,
    getLopCanonById(id){ const l = data.lop.find(x => x.id === String(id)); return l ? l.ten : String(id); },
    classKeyCandidates(cls){ return [String(cls)]; },
    getSoTietForClassMon(cls, mon){ return Number(data.pccmTietMatrix[`${cls}|${mon}`] || 0); },
    getGioiHanForClassMon(cls, mon){ return Number(data.pccmGioihanMatrix[`${cls}|${mon}`] || 0); },
    countMon(mon){
      let n = 0;
      Object.values(data.tkb.L001).forEach(day => ["sang", "chieu"].forEach(b => (day[b] || []).forEach(v => { if(lessonValue(v) === mon) n += 1; })));
      return n;
    },
    cellMon:lessonValue,
    getTeacherForClassMon(){ return ""; },
    findTeacherConflictAtSlot(){ return null; },
    tkbJointSiblingBlockers(){ return null; },
    getRoomForClassMon(){ return ""; },
    findRoomConflictAtSlot(){ return null; },
    flashLopItemConflict(){},
    getMonShort(mon){ return mon; },
    buildReplaceConfirmText(){ return ""; },
    monPrimaryStorageKey(mon){ return String(mon); },
    monMatches(a, b){ return a === b; },
    saveStoreDeferred(){},
    Map, Number, String, Math, Array, Object
  };
  const code = [
    slice("function tkbGhepRowFor", "// Dòng dạy ghép có khoá `ten`"),
    slice("let GHEP_META_CACHE", "/* [REMOVED] Section: heuristic_optimize */"),
    slice("function invalidatePccmNumCaches", "function getPccmNumCached"),
    slice("function setClassSubjectSessionLimit", "function cellMon"),
    slice("function validateDrop", "function countMonInTKB"),
    "this.__api = {getMonMeta, validateDrop, setClassSubjectSessionLimit, tkbGhepMetaForClass};"
  ].join("\n");
  vm.runInNewContext(code.replace(/\blet GHEP_META_CACHE\b/, "var GHEP_META_CACHE")
    .replace(/try\{ if\(DATA\.pccmTietMatrix\) PCCM_NUM_CACHE[^\n]*\n/g, "")
    .replace(/try\{ if\(DATA\.pccmGioihanMatrix\) PCCM_NUM_CACHE[^\n]*\n/g, ""),
    context, {filename:PHANMON_PATH});
  return context.__api;
}

function td(buoi, ti){ return {dataset:{thu:"thu2", buoi, ti:String(ti)}, classList:{contains(){ return false; }}}; }

test("getMonMeta: tiết ghép không GV lấy giới hạn của dòng ghép (2), không lấy môn gốc / mặc định 1", () => {
  const api = load(schoolData());
  assert.deepEqual(JSON.parse(JSON.stringify(api.getMonMeta("Bản ngữ (ghép)"))), {sotiet:2, gioihan:2});
  assert.equal(api.getMonMeta("THQT").gioihan, 2);
  // môn thường vẫn theo danh sách môn của lớp
  assert.deepEqual(JSON.parse(JSON.stringify(api.getMonMeta("Toán"))), {sotiet:4, gioihan:1});
});

test("thiếu khoá chiếu 'Lớp|ten ghép' thì lấy row.gioihan / row.sotiet", () => {
  const api = load(schoolData({noProjection:true}));
  assert.deepEqual(JSON.parse(JSON.stringify(api.getMonMeta("Bản ngữ (ghép)"))), {sotiet:2, gioihan:2});
});

test("kéo tiết Bản ngữ thứ 2 liền tiết đầu: được thả (trước đây báo vượt giới hạn 1)", () => {
  const data = schoolData({chieu:["", "Bản ngữ (ghép)", "", "", ""]});
  const api = load(data, {dragData:{type:"mon", classId:"L001", mon:"Bản ngữ (ghép)"}});
  const res = api.validateDrop(td("chieu", 2), "Bản ngữ (ghép)");
  assert.notEqual(res.reason, "exceed session limit", JSON.stringify(res));
  assert.ok(res.ok !== false || res.reason !== "exceed session limit");
});

test("tiết ghép thứ 3 trong buổi vẫn bị chặn theo đúng giới hạn 2 của dòng ghép", () => {
  const data = schoolData({chieu:["", "Bản ngữ (ghép)", "Bản ngữ (ghép)", "", ""]});
  data.dayGhep[0].sotiet = "3"; data.pccmTietMatrix["6A1|Bản ngữ (ghép)"] = "3";
  const api = load(data, {dragData:{type:"mon", classId:"L001", mon:"Bản ngữ (ghép)"}});
  const res = api.validateDrop(td("chieu", 3), "Bản ngữ (ghép)");
  assert.equal(res.reason, "exceed session limit");
  assert.equal(res.limit, 2);
});

test("nâng giới hạn khi thả tiết ghép ghi vào DÒNG ghép + khoá chiếu của mọi lớp trong dòng", () => {
  const data = schoolData();
  const api = load(data);
  assert.equal(api.getMonMeta("THQT").gioihan, 2);
  api.setClassSubjectSessionLimit("6A1", "THQT", 3);
  assert.equal(data.dayGhep[1].gioihan, "3");
  assert.equal(data.pccmGioihanMatrix["6A1|THQT"], "3");
  assert.equal(data.pccmGioihanMatrix["6A2|THQT"], "3");
  assert.equal(api.getMonMeta("THQT").gioihan, 3, "bộ đệm phải được làm mới");
});
