"use strict";

// 25/08 (sau review): so tiet cua (lop, mon) thuong chi nam o TIET CHUAN cua
// khoi (DATA.mon[].sotiet) chu khong co dong rieng trong pccmTietMatrix. Bang
// RB / bo tu sua phai suy ra so tiet tu Tiet chuan (nhu computeMonsForClass va
// TKBConstraints.assignedPeriodsForConstraint) de bo qua yeu cau tiet doi bat
// kha thi cua mon 1 tiet/tuan.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const PHANMON_PATH = path.resolve(__dirname, "..", "web", "pages", "phanmon.js");
const PHANMON_SOURCE = fs.readFileSync(PHANMON_PATH, "utf8");
const DAYS = ["thu2", "thu3"];

function sliceSource(startMarker, endMarker){
  const start = PHANMON_SOURCE.indexOf(startMarker);
  assert.ok(start >= 0, `khong tim thay "${startMarker}"`);
  const end = PHANMON_SOURCE.indexOf(endMarker, start);
  assert.ok(end > start, `khong tim thay "${endMarker}"`);
  return PHANMON_SOURCE.slice(start, end);
}

function loadAudit(data){
  const source = [
    sliceSource("function tkbAutoRepairLessonBlockPairShortfall(task){", "\nfunction tkbAutoRepairValidateAtSlot("),
    sliceSource("function tkbConstraintAuditClassLive(cid){", "\ntry{\n  window.__tkbToggleConstraintAudit")
  ].join("\n");
  const norm = v => String(v == null ? "" : v).trim().toLowerCase();
  const context = {
    DATA: data, DAYS, console,
    monMatches(a, b){ return !!norm(a) && norm(a) === norm(b); },
    cellMon(v){ return v === "OFF" || v === "" || v == null ? "" : (typeof v === "string" ? v : String(v.mon || "")); },
    getLopCanonById(id){ const l = (data.lop || []).find(x => String(x.id) === String(id)); return String(l?.ten || id); },
    // pccmTietMatrix khong co dong nao -> 0 (nhu getPccmNumCached that)
    getSoTietForClassMon(canon, mon){ return Number(data.pccmTietMatrix?.[`${canon}|${mon}`] || 0); },
    extractKhoiNumber(s){ const m = String(s || "").match(/\d+/); return m ? m[0] : ""; },
    _findTietChuanRow(k, mon){ return (data.mon || []).find(r => String(r.khoi).replace(/\D/g, "") === String(k) && norm(r.ten) === norm(mon)) || null; }
  };
  vm.runInNewContext(source, context, {filename: PHANMON_PATH});
  return context;
}

function grid(cells){
  const out = {};
  DAYS.forEach(thu => { out[thu] = {sang: ["", "", "", "", ""], chieu: ["", "", "", "", ""]}; });
  cells.forEach(([thu, buoi, ti, mon]) => { out[thu][buoi][ti] = mon; });
  return out;
}

test("so tiet lay tu Tiet chuan khi Phan cong khong ghi so tiet rieng", () => {
  const data = {
    lop: [{id: "L001", ten: "6/1", khoi: "Khối 6"}],
    mon: [{khoi: "Khối 6", ten: "Tin", sotiet: 1, gioihan: 1}, {khoi: "Khối 6", ten: "Toán", sotiet: 4, gioihan: 2}],
    pccmMatrix: {"6/1|Tin": "GV1", "6/1|Toán": "GV2"},
    pccmTietMatrix: {},
    tkb: {L001: grid([["thu2", "sang", 0, "Tin"], ["thu2", "sang", 2, "Toán"], ["thu3", "chieu", 1, "Toán"]])},
    tkbConstraints: {subject: {
      "Tin": {byClass: {L001: {lessonBlocks: {2: {min: 1}}}}},
      "Toán": {byClass: {L001: {lessonBlocks: {2: {min: 1}}}}}
    }}
  };
  const ctx = loadAudit(data);
  assert.equal(ctx.tkbLessonBlockPeriodsForClassMon("L001", "Tin"), 1);
  assert.equal(ctx.tkbLessonBlockPeriodsForClassMon("L001", "Toán"), 4);
  assert.equal(ctx.tkbAutoRepairLessonBlockPairShortfall({classId: "L001", mon: "Tin"}), 0);
  assert.equal(ctx.tkbAutoRepairLessonBlockPairShortfall({classId: "L001", mon: "Toán"}), 1);
  const rows = ctx.tkbConstraintAuditRows();
  assert.equal(rows.find(r => r.mon === "Tin").ok, true);
  assert.match(rows.find(r => r.mon === "Tin").note, /bỏ qua/);
  assert.equal(rows.find(r => r.mon === "Toán").ok, false);
});
