"use strict";

// 01/09 (trường fiwemj2uyk1): TKB lớp có "Chào cờ - SĐ.Liên" nhưng TKB GV của cô
// Liên trống tiết đó ("Chưa phân: 1"). Nguyên nhân: buildTeacherSchedule bỏ qua
// tra GV cho MỌI ô mang đúng chữ "Chào cờ" — ngoại lệ cho bản rất cũ tự chèn ô
// chào cờ toàn trường không có GV. Trường mới định nghĩa Chào cờ là môn thật
// (HĐTN-HN 1, tên "Chào cờ", GVCN dạy) nên ô lưu theo tên môn bị mất khỏi TKB GV.
// Bản vá: chỉ bỏ qua khi "Chào cờ" KHÔNG phải alias của môn thật (findMonHoc null).

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

function loadBuilder(data, monhocRecords, calls){
  const start = PHANMON_SOURCE.indexOf("function buildTeacherSchedule");
  const end = PHANMON_SOURCE.indexOf("\nfunction ", start + 10);
  assert.ok(start >= 0 && end > start, "buildTeacherSchedule source must be extractable");
  const aliasOf = (mon)=>{
    const low = String(mon || "").trim().toLowerCase();
    return monhocRecords.find(r => [r.ma, r.ten, r.ma2, r.id]
      .some(v => String(v || "").trim().toLowerCase() === low)) || null;
  };
  const context = {
    DAYS:["thu2","thu3","thu4","thu5","thu6","thu7"],
    SANG:5, CHIEU:5,
    DATA:data,
    getFilteredLops(){ return data.lop; },
    classCanonFromLop(l){ return l.ten; },
    getLopCanonById(id){ return (data.lop.find(l => l.id === id) || {}).ten || String(id); },
    cellMon(v){ if(v === "OFF" || v == null || v === "") return ""; return typeof v === "string" ? v : String(v.mon || ""); },
    isFixed(v){ return !!(v && typeof v === "object" && v.fixed === true); },
    cellLegacyTeacher(){ return ""; },
    findMonHoc(mon){ return aliasOf(mon); },
    getTeacherForClassMon(lop, mon){
      calls.push(`${lop}|${mon}`);
      const direct = data.pccmMatrix[`${lop}|${mon}`];
      if(direct) return direct;
      const rec = aliasOf(mon);
      if(!rec) return "";
      for(const alias of [rec.ma, rec.ten, rec.ma2, rec.id]){
        const v = alias && data.pccmMatrix[`${lop}|${alias}`];
        if(v) return v;
      }
      return "";
    },
    getRoomForClassMon(){ return ""; },
    teacherValueHas(raw, code){
      const target = String(code || "").trim().toLowerCase();
      return String(raw || "").split(",").map(s => s.trim().toLowerCase()).includes(target);
    }
  };
  vm.runInNewContext(PHANMON_SOURCE.slice(start, end), context, {filename:PHANMON_PATH});
  return context.buildTeacherSchedule;
}

function schoolWithRealChaoCoSubject(cellValue){
  return {
    lop:[{id:"L001", ten:"6/1"}],
    pccmMatrix:{"6/1|HĐTN-HN 1":"SĐ.Liên", "6/1|Toán":"TO.Thảo"},
    tkb:{L001:{thu2:{sang:blankSession([cellValue, "Toán"]), chieu:blankSession()}}}
  };
}

const CHAO_CO_MONHOC = [{id:"MH001", ma:"HĐTN-HN 1", ma2:"", ten:"Chào cờ"}];

test("ô 'Chào cờ' là alias của môn thật -> vẫn vào TKB GV của GVCN", () => {
  const calls = [];
  const data = schoolWithRealChaoCoSubject({mon:"Chào cờ", fixed:true});
  const sched = loadBuilder(data, CHAO_CO_MONHOC, calls)("SĐ.Liên");
  const entries = sched.thu2.sang[0];
  assert.equal(entries.length, 1, "tiết chào cờ phải có trong TKB GV");
  assert.equal(entries[0].classDisplay, "6/1");
  assert.equal(entries[0].fixed, true);
});

test("ô lưu theo mã 'HĐTN-HN 1' vẫn vào TKB GV (hành vi cũ giữ nguyên)", () => {
  const calls = [];
  const data = schoolWithRealChaoCoSubject({mon:"HĐTN-HN 1", fixed:true});
  const sched = loadBuilder(data, CHAO_CO_MONHOC, calls)("SĐ.Liên");
  assert.equal(sched.thu2.sang[0].length, 1);
});

test("bản cũ: 'Chào cờ' không phải môn nào -> vẫn bỏ qua, không tra GV", () => {
  const calls = [];
  const data = {
    lop:[{id:"L001", ten:"6/1"}],
    pccmMatrix:{"6/1|Toán":"TO.Thảo"},
    tkb:{L001:{thu2:{sang:blankSession(["Chào cờ", "Toán"]), chieu:blankSession()}}}
  };
  const sched = loadBuilder(data, [], calls)("TO.Thảo");
  assert.equal(sched.thu2.sang[0].length, 0, "ô chào cờ di sản không thuộc TKB GV nào");
  assert.ok(!calls.some(k => k.endsWith("|Chào cờ")), "không được tra GV cho ô chào cờ di sản");
  assert.equal(sched.thu2.sang[1].length, 1, "tiết Toán bình thường vẫn hiện");
});
