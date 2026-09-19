"use strict";

// 01/09 (chủ dự án, trường fiwemj2uyk1): "tôi chỉ cần hiển thị đúng như tôi đã
// thực hiện bên trong phần môn học" — nhãn ô TKB phải là ĐÚNG "Mã môn học" người
// dùng đặt trong bảng Môn học. Trước đây getMonShort tự chọn alias NGẮN NHẤT
// trong {ma, ma2, ten} khi mã không "giống mã" (có dấu/cách), nên mã "HĐTN-HN 1"
// bị hiện thành tên "Chào cờ" và đổi mã trong app không làm TKB đổi theo.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const PHANMON_PATH = path.resolve(__dirname, "..", "web", "pages", "phanmon.js");
const PHANMON_SOURCE = fs.readFileSync(PHANMON_PATH, "utf8");

function loadGetMonShort(records){
  const start = PHANMON_SOURCE.indexOf("function getMonShort");
  const end = PHANMON_SOURCE.indexOf("\nfunction ", start + 10);
  assert.ok(start >= 0 && end > start, "getMonShort source must be extractable");
  const context = {
    findMonHoc(mon){
      const low = String(mon || "").trim().toLowerCase();
      return records.find(r => [r.ma, r.ten, r.ma2, r.id]
        .some(v => String(v || "").trim().toLowerCase() === low)) || null;
    }
  };
  vm.runInNewContext(PHANMON_SOURCE.slice(start, end), context, {filename:PHANMON_PATH});
  return context.getMonShort;
}

const CHAO_CO = {id:"MH001", ma:"HĐTN-HN 1", ma2:"", ten:"Chào cờ"};

test("nhãn = đúng Mã môn học kể cả khi tên ngắn hơn mã", () => {
  const getMonShort = loadGetMonShort([CHAO_CO]);
  assert.equal(getMonShort("HĐTN-HN 1"), "HĐTN-HN 1");
});

test("ô lưu theo TÊN môn vẫn hiện Mã môn học của môn đó", () => {
  const getMonShort = loadGetMonShort([CHAO_CO]);
  assert.equal(getMonShort("Chào cờ"), "HĐTN-HN 1");
});

test("mã trống -> dùng mã 2, rồi mới tới tên", () => {
  const getMonShort = loadGetMonShort([{id:"MH002", ma:"", ma2:"SHDC", ten:"Chào cờ"}]);
  assert.equal(getMonShort("Chào cờ"), "SHDC");
  const tenOnly = loadGetMonShort([{id:"MH003", ma:"", ma2:"", ten:"Tự học"}]);
  assert.equal(tenOnly("Tự học"), "Tự học");
});

test("không có trong bảng Môn học -> trả nguyên chuỗi", () => {
  const getMonShort = loadGetMonShort([]);
  assert.equal(getMonShort("Môn lạ"), "Môn lạ");
});
