"use strict";

// 30/10 THCS Đồng Đen 7/6: ô cố định ghi MÃ môn ("TNHN") còn tiết thường ghi TÊN
// ("Hoạt động trải nghiệm hướng nghiệp"). validateDrop so chuỗi thô nên không thấy
// cùng môn: cho thả TNHN vào tiết 5 sau 2 tiết TNHN cố định (vượt giới hạn 2/buổi,
// tách cụm). Kiểm bằng chính bảng bí danh môn của phanmon.js.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const PHANMON_PATH = path.resolve(__dirname, "..", "web", "pages", "phanmon.js");
const SRC = fs.readFileSync(PHANMON_PATH, "utf8");

function slice(from, to){
  const start = SRC.indexOf(from);
  const end = SRC.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `cannot slice ${from}`);
  return SRC.slice(start, end);
}

const TNHN_NAME = "Hoạt động trải nghiệm hướng nghiệp";

function load(sang, gioihan){
  const DATA = {
    monhoc:[
      {id:"MH001", ma:"TNHN", ten:TNHN_NAME},
      {id:"MH003", ma:"Toán", ten:"Toán"},
      {id:"MH006", ma:"LSĐL", ten:"Lịch sử và Địa lý"}
    ],
    mon:[],
    tkb:{L1:{thu2:{sang, chieu:["", "", "", "", ""]}}}
  };
  const context = {
    DATA, currentLop:"L1", dragData:{type:"mon", classId:"L1"}, Map, String, Number,
    normText(s){ return String(s == null ? "" : s).normalize("NFC").trim(); },
    cellMon(v){ if(v === "OFF" || v === "" || v == null) return ""; return typeof v === "string" ? v : String(v.mon || ""); },
    getMonMeta(){ return {sotiet:3, gioihan}; },
    getLopCanonById(id){ return String(id); },
    getTeacherForClassMon(){ return ""; },
    findTeacherConflictAtSlot(){ return null; },
    tkbJointSiblingBlockers(){ return null; },
    getRoomForClassMon(){ return ""; },
    findRoomConflictAtSlot(){ return null; },
    flashLopItemConflict(){},
    getMonShort(mon){ return mon; },
    buildReplaceConfirmText(){ return ""; }
  };
  const code = [
    slice("function normKey(", "function looksLikeCode("),
    slice("function allMonRecords(", "function findMonHoc("),
    slice("function validateDrop(", "function countMonInTKB(")
  ].join("\n").replace(/\blet MON_ALIAS_INDEX\b/, "var MON_ALIAS_INDEX");
  vm.runInNewContext(code, context, {filename:PHANMON_PATH});
  context.countMon = mon => {
    let n = 0;
    Object.values(DATA.tkb.L1).forEach(day => ["sang", "chieu"].forEach(b => day[b].forEach(v => {
      if(context.monMatches(context.cellMon(v), mon)) n += 1;
    })));
    return n;
  };
  return context;
}

function cell(ti){
  return {dataset:{thu:"thu2", buoi:"sang", ti:String(ti)}, classList:{contains(){ return false; }}};
}

const FIXED = {fixed:true, mon:"TNHN"};

test("fixed TNHN code and TNHN name count as one subject in the session limit", () => {
  const ctx = load([FIXED, FIXED, "Lịch sử và Địa lý", "Lịch sử và Địa lý", ""], 2);
  const res = ctx.validateDrop(cell(4), TNHN_NAME);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "exceed session limit");
  assert.equal(res.used, 3);
});

test("a third TNHN apart from the fixed pair is a split block even when the limit allows 3", () => {
  const ctx = load([FIXED, FIXED, "Lịch sử và Địa lý", "Lịch sử và Địa lý", ""], 3);
  const res = ctx.validateDrop(cell(4), TNHN_NAME);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "split block");
});

test("TNHN right after the fixed pair stays allowed when the limit allows 3", () => {
  const ctx = load([FIXED, FIXED, "", "Toán", "Toán"], 3);
  const res = ctx.validateDrop(cell(2), TNHN_NAME);
  assert.equal(res.ok, true);
});

test("other subjects are not mistaken for TNHN", () => {
  const ctx = load([FIXED, FIXED, "Lịch sử và Địa lý", "Lịch sử và Địa lý", ""], 2);
  const res = ctx.validateDrop(cell(4), "Toán");
  assert.equal(res.ok, true);
});
