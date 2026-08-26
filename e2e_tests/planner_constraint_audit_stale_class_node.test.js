"use strict";

// 24/08: bang "Kiem tra rang buoc" (nut RB, chi superadmin) tung dem ca cac
// muc `tkbConstraints.subject[*].byClass` cua LOP DA XOA. Truong
// v2mjxf2tbt1 rut tu 31 xuong 21 lop nhung con L022..L031 trong yeu cau mon
// hoc => bang bao "281 luat, 50 chua dat" (5 mon x 10 lop ma) trong khi
// TKBConstraints.validateAll() bao 0 vi pham: shortfall cua mot lop khong co
// luoi luon bang dung `min`. Bang chi duoc do luat cua lop CON TON TAI, va
// phai bao rieng so muc rac de chu du an tu don.

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

function loadAudit(data){
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

function subjectRule(){
  return {
    lessonBlocks: {2: {min: 1, max: 0}},
    sessionAllowed: {oneSessionPerDay: true}
  };
}

function schoolData(){
  return {
    // L001/L002 la lop that; L099 la lop DA XOA nhung yeu cau mon hoc con sot.
    lop: [{id: "L001", ten: "6/1"}, {id: "L002", ten: "6/2"}],
    tkb: {
      // L001: Toan co cum doi (dat) nhung day ca sang lan chieu thu2 (vi pham
      // "1 buoi/ngay").
      L001: grid([
        ["thu2", "sang", 0, "Toán"],
        ["thu2", "sang", 1, "Toán"],
        ["thu2", "chieu", 0, "Toán"]
      ]),
      // L002: Toan chi co tiet le (thieu 1 cum) nhung dung 1 buoi/ngay.
      L002: grid([
        ["thu2", "sang", 0, "Toán"],
        ["thu3", "sang", 2, "Toán"]
      ])
    },
    tkbConstraints: {
      subject: {
        "Toán": {
          byClass: {
            L001: subjectRule(),
            L002: subjectRule(),
            L099: subjectRule()
          }
        }
      }
    }
  };
}

test("bang RB bo qua yeu cau cua lop da xoa", () => {
  const ctx = loadAudit(schoolData());
  const rows = ctx.tkbConstraintAuditRows();

  assert.equal(rows.length, 4, "chi 2 lop that x 2 loai luat");
  assert.equal(rows.some(r => String(r.lop) === "L099"), false, "khong duoc liet ke lop da xoa");
});

test("luat that van bi bat, khong bi loc nham", () => {
  const ctx = loadAudit(schoolData());
  const bad = ctx.tkbConstraintAuditRows().filter(r => !r.ok);

  assert.equal(bad.length, 2);
  const pair = bad.find(r => r.rb.startsWith("Tiết đôi"));
  assert.ok(pair, "L002 thieu cum tiet doi phai bi bao");
  assert.equal(pair.lop, "L002");
  assert.equal(pair.note, "thiếu 1 cụm");
  const session = bad.find(r => r.rb === "1 buổi/ngày");
  assert.ok(session, "L001 day ca 2 buoi trong 1 ngay phai bi bao");
  assert.equal(session.lop, "L001");
  assert.equal(session.note, "1 ngày vi phạm");
});

test("so muc rac duoc bao rieng chu khong am tham nuot", () => {
  const ctx = loadAudit(schoolData());
  const stale = ctx.tkbConstraintAuditStaleSummary();

  assert.deepEqual([...stale.classes], ["L099"]);
  assert.equal(stale.rules, 2, "1 luat tiet doi + 1 luat 1 buoi/ngay cua lop da xoa");
});

test("lop con luoi hoac trung ten/ma van duoc coi la con ton tai", () => {
  const data = schoolData();
  // L003 khong nam trong DATA.lop nhung con luoi TKB -> van la lop that.
  data.tkb.L003 = grid([["thu2", "sang", 0, "Toán"], ["thu2", "sang", 1, "Toán"]]);
  data.tkbConstraints.subject["Toán"].byClass.L003 = subjectRule();
  // Du lieu cu co the khoa byClass bang TEN lop thay vi id.
  data.tkbConstraints.subject["Toán"].byClass["6/1"] = subjectRule();

  const ctx = loadAudit(data);
  assert.deepEqual([...ctx.tkbConstraintAuditStaleSummary().classes], ["L099"]);
  assert.equal(ctx.tkbConstraintAuditClassLive("L003"), true);
  assert.equal(ctx.tkbConstraintAuditClassLive("6/1"), true);
  assert.equal(ctx.tkbConstraintAuditClassLive("L099"), false);
});

test("danh muc lop chua nap thi khong loc gi ca", () => {
  const data = schoolData();
  data.lop = [];
  delete data.tkb.L001;
  delete data.tkb.L002;

  const ctx = loadAudit(data);
  assert.equal(ctx.tkbConstraintAuditRows().length, 6, "khong co du lieu de ket luan -> giu nguyen 3 lop");
  assert.equal(ctx.tkbConstraintAuditStaleSummary().rules, 0);
});
