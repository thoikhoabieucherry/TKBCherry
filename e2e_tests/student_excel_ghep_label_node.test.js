"use strict";

// 29/09 (chủ dự án, TH Tân An Hội l3dlfwrpne1): file Excel tổng theo lớp (tonghs) in ô tiết
// Tiếng Anh người nước ngoài là "TANN-TANN1.Nguyệt TA" — dài, tràn ô. Ô dạy ghép NHIỀU GV
// chỉ in tên tắt ("TANN"), giống bảng lớp trên trang Sắp xếp; ô thường và dạy ghép 1 GV
// vẫn in "Môn-GV" như cũ.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const EXPORT_PATH = path.join(ROOT, "web", "pages", "tkb-student-excel-export.js");
const PHANMON_SOURCE = fs.readFileSync(path.join(ROOT, "web", "pages", "phanmon.js"), "utf8");

function extract(name){
  const start = PHANMON_SOURCE.indexOf(`function ${name}(`);
  const end = PHANMON_SOURCE.indexOf("\nfunction ", start + 10);
  assert.ok(start >= 0 && end > start, `${name} must be extractable from phanmon.js`);
  return PHANMON_SOURCE.slice(start, end);
}

function loadModule(){
  const DATA = {
    lop: [{id: "L001", ten: "1/1"}, {id: "L002", ten: "1/2"}],
    dayGhep: [
      {id: "DG001", lop: ["1/1"], mon: ["TANN"], gv: ["TANN1", "Nguyệt TA"], sotiet: "1", gioihan: "1", viettat: "TANN", ten: "TANN (ghép)"},
      {id: "DG002", lop: ["1/1"], mon: ["TNXH"], gv: ["Phương ÂN"], sotiet: "1", gioihan: "1", viettat: "TNXH", ten: "TNXH (ghép)"},
    ],
    pccmMatrix: {
      "1/1|Toán": "Duyên",
      "1/1|TANN (ghép)": "TANN1, Nguyệt TA",
      "1/1|TNXH (ghép)": "Phương ÂN",
    },
  };
  const window = {};
  const context = {
    window, DATA, console,
    cellMon: v => (v && typeof v === "object") ? v.mon : v,
    getMonShort: mon => String(mon).replace(/ \(ghép\)$/, ""),
    getLopCanonById: id => (DATA.lop.find(l => l.id === id) || {}).ten || id,
    getTeacherForClassMon: (cls, mon) => DATA.pccmMatrix[`${cls}|${mon}`] || "",
    getTeacherShort: code => code,
  };
  vm.createContext(context);
  vm.runInContext([extract("tkbGhepRowFor"), extract("tkbGhepRowByIdentity"), extract("tkbGhepLabelOf"),
    extract("tkbMonLabel")].join("\n"), context);
  vm.runInContext(fs.readFileSync(EXPORT_PATH, "utf8"), context, {filename: EXPORT_PATH});
  return {api: window.__tkbStudentExcelInternals, lop: DATA.lop[0]};
}

test("ô dạy ghép nhiều GV chỉ in tên tắt (bản toàn trường theo lớp, không classRef)", () => {
  const {api, lop} = loadModule();
  assert.equal(api.lessonTeacherText(lop, "TANN (ghép)"), "TANN");
});

test("ô dạy ghép nhiều GV chỉ in tên tắt (phiếu học sinh, có classRef)", () => {
  const {api, lop} = loadModule();
  assert.equal(api.lessonTeacherText(lop, "TANN (ghép)", "L001"), "TANN");
});

test("ô thường vẫn in Môn-GV", () => {
  const {api, lop} = loadModule();
  assert.equal(api.lessonTeacherText(lop, "Toán"), "Toán-Duyên");
  assert.equal(api.lessonTeacherText(lop, {mon: "Toán", fixed: true}, "L001"), "Toán-Duyên");
});

test("dạy ghép 1 GV giữ Môn-GV như cũ", () => {
  const {api, lop} = loadModule();
  assert.equal(api.lessonTeacherText(lop, "TNXH (ghép)", "L001"), "TNXH-Phương ÂN");
});

test("ô nghỉ / trống vẫn rỗng", () => {
  const {api, lop} = loadModule();
  assert.equal(api.lessonTeacherText(lop, "OFF"), "");
  assert.equal(api.lessonTeacherText(lop, ""), "");
});
