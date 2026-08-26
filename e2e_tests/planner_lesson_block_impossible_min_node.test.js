"use strict";

// 25/08: mon chi co 1 tiet/tuan (vd Tin hoc) nhung nguoi dung quick-fill "all"
// yeu cau "min 1 buoi co 2 tiet xep lien" -> khong lich nao dat duoc. Bang
// "Kiem tra rang buoc" (nut RB) tung bao "Tiet doi >= 1 ✗ thieu 1 cum" va bo
// tu sua (tkbPairListShortfallCases) cu co gang ghep cap mai. Gio yeu cau bat
// kha thi (min > floor(soTiet/2)) duoc bo qua — cung nguong voi
// TKBConstraints.impossibleLessonBlockMinimum — va bang RB ghi ro ly do.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const PHANMON_PATH = process.env.TKB_PHANMON_PATH
  ? path.resolve(process.env.TKB_PHANMON_PATH)
  : path.resolve(__dirname, "..", "web", "pages", "phanmon.js");
const PHANMON_SOURCE = fs.readFileSync(PHANMON_PATH, "utf8");

const DAYS = ["thu2", "thu3"];

function sliceSource(startMarker, endMarker){
  const start = PHANMON_SOURCE.indexOf(startMarker);
  assert.ok(start >= 0, `khong tim thay "${startMarker}" trong phanmon.js`);
  const end = PHANMON_SOURCE.indexOf(endMarker, start);
  assert.ok(end > start, `khong tim thay "${endMarker}" sau "${startMarker}"`);
  return PHANMON_SOURCE.slice(start, end);
}

function loadAudit(data, periodsByClassMon){
  const source = [
    sliceSource("function tkbAutoRepairLessonBlockPairShortfall(task){", "\nfunction tkbAutoRepairValidateAtSlot("),
    sliceSource("function tkbConstraintAuditClassLive(cid){", "\ntry{\n  window.__tkbToggleConstraintAudit")
  ].join("\n");
  const context = {
    DATA: data,
    DAYS,
    console,
    monMatches(a, b){
      const norm = v => String(v == null ? "" : v).trim().toLowerCase();
      return !!norm(a) && norm(a) === norm(b);
    },
    cellMon(v){
      if(v === "OFF" || v === "" || v == null) return "";
      if(typeof v === "string") return v;
      return v && typeof v === "object" ? String(v.mon || "") : "";
    },
    getLopCanonById(id){ return String(id); }
  };
  if(periodsByClassMon){
    context.getSoTietForClassMon = (canon, mon) => periodsByClassMon[`${canon}|${mon}`] ?? 0;
  }
  vm.runInNewContext(source, context, {filename: PHANMON_PATH});
  return context;
}

function blank(){ return ["", "", "", "", ""]; }

function grid(cells){
  const out = {};
  DAYS.forEach(thu => { out[thu] = {sang: blank(), chieu: blank()}; });
  (cells || []).forEach(([thu, buoi, ti, mon]) => { out[thu][buoi][ti] = mon; });
  return out;
}

function schoolData(){
  return {
    lop: [{id: "L001", ten: "6/1"}],
    tkb: {
      // Tin: 1 tiet le; Toan: 3 tiet nhung chua co cum doi.
      L001: grid([
        ["thu2", "sang", 0, "Tin"],
        ["thu2", "sang", 2, "Toán"],
        ["thu3", "sang", 0, "Toán"],
        ["thu3", "chieu", 1, "Toán"]
      ])
    },
    tkbConstraints: {
      subject: {
        "Tin": {byClass: {L001: {lessonBlocks: {2: {min: 1, max: 0}}}}},
        "Toán": {byClass: {L001: {lessonBlocks: {2: {min: 1, max: 0}}}}}
      }
    }
  };
}

test("mon 1 tiet/tuan voi min=1 cum doi: khong tinh la vi pham, bang RB ghi 'bo qua'", () => {
  const ctx = loadAudit(schoolData(), {"L001|Tin": 1, "L001|Toán": 3});

  assert.equal(ctx.tkbAutoRepairLessonBlockPairShortfall({classId: "L001", mon: "Tin"}), 0);
  const rows = ctx.tkbConstraintAuditRows();
  const tin = rows.find(r => r.mon === "Tin");
  assert.ok(tin, "van liet ke luat de nguoi dung biet no bi bo qua");
  assert.equal(tin.ok, true);
  assert.match(tin.note, /bỏ qua/);
  assert.match(tin.note, /1 tiết\/tuần/);
});

test("mon du tiet ma chua co cum doi van bi bao thieu", () => {
  const ctx = loadAudit(schoolData(), {"L001|Tin": 1, "L001|Toán": 3});

  assert.equal(ctx.tkbAutoRepairLessonBlockPairShortfall({classId: "L001", mon: "Toán"}), 1);
  const toan = ctx.tkbConstraintAuditRows().find(r => r.mon === "Toán");
  assert.equal(toan.ok, false);
  assert.equal(toan.note, "thiếu 1 cụm");
});

test("min lon hon floor(soTiet/2) cung la bat kha thi (3 tiet, min 2)", () => {
  const data = schoolData();
  data.tkbConstraints.subject["Toán"].byClass.L001.lessonBlocks[2].min = 2;
  const ctx = loadAudit(data, {"L001|Tin": 1, "L001|Toán": 3});

  assert.equal(ctx.tkbAutoRepairLessonBlockPairShortfall({classId: "L001", mon: "Toán"}), 0);
  const toan = ctx.tkbConstraintAuditRows().find(r => r.mon === "Toán");
  assert.equal(toan.ok, true);
  assert.match(toan.note, /không thể xếp 2 cụm đôi/);
});

test("chua biet so tiet (khong co ham tra cuu) thi giu nguyen cach do cu", () => {
  const ctx = loadAudit(schoolData(), null);

  assert.equal(ctx.tkbAutoRepairLessonBlockPairShortfall({classId: "L001", mon: "Tin"}), 1);
  const tin = ctx.tkbConstraintAuditRows().find(r => r.mon === "Tin");
  assert.equal(tin.ok, false);
  assert.equal(tin.note, "thiếu 1 cụm");
});
