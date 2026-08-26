"use strict";

// 25/08: xuat Excel "Yeu cau co dinh" (sheet ma tran CoDinhGV/CoDinhLop/CoDinhMon)
// ghi chu "Nghỉ" (co dau) vao o nghi, nhung ham nhap chi nhan 1/x/nghi/off sau
// khi ha chu thuong KHONG bo dau -> "nghỉ" != "nghi" -> nhap lai coi moi o la
// trong va xoa sach o nghi. Test vong xuat -> nhap phai giu nguyen o nghi.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const CONSTRAINTS_PATH = path.resolve(__dirname, "..", "web", "pages", "tkb-constraints.js");
const CONSTRAINTS_SOURCE = fs.readFileSync(CONSTRAINTS_PATH, "utf8");

function loadConstraints(data){
  const head = {appendChild(){}};
  const body = {appendChild(){}};
  const document = {
    head, body, readyState:"complete",
    getElementById(){ return null; },
    querySelectorAll(){ return []; },
    querySelector(){ return null; },
    addEventListener(){},
    createElement(){ return {id:"", textContent:"", style:{}, classList:{add(){}, remove(){}, toggle(){}}}; }
  };
  const window = {
    DATA:data, document, location:{search:""}, __TKB_E2E_EXPOSE_TEST_HOOKS:true,
    addEventListener(){}, removeEventListener(){}, setTimeout, clearTimeout
  };
  window.window = window;
  const context = {
    window, document, DATA:data, DAYS:["thu2", "thu3"], LABEL:{thu2:"Thứ 2", thu3:"Thứ 3"}, SANG:5, CHIEU:5,
    console, Date, Math, JSON, Object, Array, Set, Map, WeakMap, URLSearchParams, setTimeout, clearTimeout
  };
  vm.runInNewContext(CONSTRAINTS_SOURCE, context, {filename:CONSTRAINTS_PATH});
  return {hooks:window.__TKB_CONSTRAINTS_TEST_HOOKS, api:window.TKBConstraints, data};
}

function schoolData(){
  return {
    lop:[{id:"L1", ten:"6A"}, {id:"L2", ten:"6B"}],
    giaovien:[{magv:"GV1", hodem:"Nguyễn", ten:"Trâm"}, {magv:"GV2", hodem:"Trần", ten:"Vân"}],
    monhoc:[{id:"Toan", ma:"Toan", ten:"Toán"}],
    mon:[{id:"Toan", khoi:"6", ten:"Toán", sotiet:"4", gioihan:"2"}],
    pccmMatrix:{"L1|Toan":"GV1", "L2|Toan":"GV2"},
    pccmTietMatrix:{}, pccmGioihanMatrix:{},
    tkb:{L1:{thu2:{sang:["", "", "", "", ""], chieu:["", "", "", "", ""]}}},
    tkbConstraints:{
      fixedOff:{
        teacher:{GV1:{"thu2|sang|0":true, "thu3|chieu|4":true}, GV2:{"thu2|chieu|1":true}}
      }
    }
  };
}

test("chu 'Nghỉ' (co dau) va cac bien the deu duoc coi la o nghi khi nhap", () => {
  const {hooks} = loadConstraints(schoolData());
  for(const v of ["Nghỉ", "NGHỈ", "nghi", "x", "X", "1", 1, "OFF", "Có", true]) assert.equal(hooks.fixedOffImportTruthy(v), true, String(v));
  for(const v of ["", " ", 0, "0", null, undefined, false, "Dạy"]) assert.equal(hooks.fixedOffImportTruthy(v), false, String(v));
});

test("xuat sheet ma tran co dinh GV roi nhap lai: o nghi giu nguyen", () => {
  const {hooks, api} = loadConstraints(schoolData());
  const matrix = hooks.fixedOffMatrixData("teacher");
  const flat = matrix.rows.flat().map(String);
  assert.equal(flat.filter(v => v === "Nghỉ").length, 3, "sheet xuat phai co dung 3 o Nghỉ");
  // mo phong nguoi dung nhap lai chinh sheet do sau khi da xoa het o nghi
  const c = api.get();
  c.fixedOff.teacher = {};
  const result = hooks.importFixedOffMatrixRows("teacher", matrix.rows, {render:false, notify:false});
  assert.ok(result && result.format === "matrix", JSON.stringify(result));
  assert.equal(result.offTotal, 3);
  // (object tu vm context khac realm -> so bang JSON)
  assert.equal(JSON.stringify(api.get().fixedOff.teacher), JSON.stringify({GV1:{"thu2|sang|0":true, "thu3|chieu|4":true}, GV2:{"thu2|chieu|1":true}}));
});
