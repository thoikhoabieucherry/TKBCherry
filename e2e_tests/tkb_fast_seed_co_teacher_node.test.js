"use strict";

// 25/08: tiet DAY GHEP (1 mon, 1 lop, 2 giao vien "GV01, GV02"). Bo gieo
// nhanh (tkb-fast-seed) tung tra ca chuoi qua bang alias mot lan -> khong khop ->
// "GV01, GV02" thanh mot GV moi: o nghi co dinh cua GV01/GV02 bi bo qua va
// GV01 co the bi xep tiet khac trung gio tiet ghep. Gio tung thanh vien duoc
// tra alias rieng, tiet ghep chiem cho va ton trong o nghi cua MOI thanh vien.

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const FAST_SEED_PATH = path.resolve(__dirname, "..", "web", "pages", "tkb-fast-seed.js");
const fastSeed = require(FAST_SEED_PATH);

const DAYS = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];

function offAll(filter){
  const slots = {};
  for(const thu of DAYS){
    for(const buoi of ["sang", "chieu"]){
      for(let ti = 0; ti < 5; ti++){
        if(filter(thu, buoi, ti)) slots[`${thu}|${buoi}|${ti}`] = true;
      }
    }
  }
  return slots;
}

function schoolData(){
  return {
    lop:[
      {id:"L1", ten:"6A", ten2:"6A", khoi:"Khối 6"},
      {id:"L2", ten:"6B", ten2:"6B", khoi:"Khối 6"}
    ],
    giaovien:[
      {id:"G1", magv:"GV01", ten:"Trâm"},
      {id:"G2", magv:"GV02", ten:"Vân"},
      {id:"G3", magv:"GV03", ten:"Toán"}
    ],
    monhoc:[
      {id:"M1", ma:"KHTN", ten:"KHTN"},
      {id:"M2", ma:"TNHN", ten:"TNHN"},
      {id:"M3", ma:"TOAN", ten:"Toán"}
    ],
    mon:[
      {khoi:"6", ten:"KHTN", sotiet:4, gioihan:2},
      {khoi:"6", ten:"TNHN", sotiet:3, gioihan:2},
      {khoi:"6", ten:"Toán", sotiet:4, gioihan:2}
    ],
    pccmMatrix:{
      "L1|KHTN":"GV01", "L2|KHTN":"GV01",
      // tiet ghep o lop 6A: co Tram (ten rieng) + GV02 (ma) cung day
      "L1|TNHN":"Trâm, GV02",
      "L1|TOAN":"GV03", "L2|TOAN":"GV03"
    },
    pccmTietMatrix:{"L1|KHTN":4, "L2|KHTN":4, "L1|TNHN":3, "L1|TOAN":4, "L2|TOAN":4},
    pccmGioihanMatrix:{},
    pccmRoomMatrix:{},
    tkb:{},
    tkbUserOff:{},
    tkbConstraints:{
      fixedOff:{
        teacher:{
          // GV02 chi ranh sang thu 2 + thu 3; GV01 nghi ca thu 4
          GV02: offAll((thu, buoi) => !((thu === "thu2" || thu === "thu3") && buoi === "sang")),
          GV01: offAll(thu => thu === "thu4")
        }
      }
    }
  };
}

test("model: tiet ghep tach thanh tung GV thanh vien (co tra alias ten rieng -> ma)", () => {
  const model = fastSeed._buildModel(schoolData());
  const co = model.assignments.find(a => a.subject === "TNHN");
  assert.ok(co, "phai co phan cong TNHN");
  assert.deepEqual(co.teachers, ["GV01", "GV02"]);
  assert.equal(co.teacher, "GV01, GV02");
  assert.ok(co.teacherAliases.includes("GV01") && co.teacherAliases.includes("GV02"));
  assert.ok(co.offRules.length >= 2, "o nghi cua CA HAI giao vien phai duoc gom vao offRules");
});

test("seed: tiet ghep tranh o nghi cua moi thanh vien va khong GV nao bi trung gio", () => {
  const result = fastSeed.generate(schoolData(), {maxMs:1500, attempts:8, seed:23});
  assert.equal(result.ok, true, JSON.stringify(result.invalidReasons || []));
  const co = result.lessons.filter(l => l.subject === "TNHN");
  assert.equal(co.length, 3, "du 3 tiet ghep");
  for(const lesson of co){
    assert.equal(lesson.teacher, "GV01, GV02");
    // GV02 chi ranh sang thu 2/3 -> tiet ghep chi duoc nam o do
    assert.ok([2, 3].includes(lesson.day) && lesson.session === "AM", `tiet ghep roi vao o nghi GV02: ${JSON.stringify(lesson)}`);
  }
  // moi thanh vien: khong co 2 tiet cung (day, session, period)
  const seen = new Map();
  for(const lesson of result.lessons){
    const members = String(lesson.teacher).split(",").map(x => x.trim());
    for(const member of members){
      const key = `${member}|${lesson.day}|${lesson.session}|${lesson.period}`;
      assert.equal(seen.has(key), false, `GV ${member} bi trung gio: ${JSON.stringify([seen.get(key), lesson])}`);
      seen.set(key, lesson);
    }
    if(members.includes("GV01")) assert.notEqual(lesson.day, 4, `GV01 nghi thu 4: ${JSON.stringify(lesson)}`);
  }
});

test("co dinh: tiet ghep va tiet rieng cua mot thanh vien cung gio la xung dot co dinh", () => {
  const data = schoolData();
  data.tkb = {
    L1:{thu2:{sang:[{mon:"TNHN", fixed:true}, "", "", "", ""]}},
    L2:{thu2:{sang:[{mon:"KHTN", fixed:true}, "", "", "", ""]}}
  };
  const result = fastSeed.generate(data, {maxMs:300, attempts:2, seed:5});
  assert.equal(result.ok, false);
  assert.match(result.invalidReasons.join("\n"), /fixed_teacher_collision:GV01\|thu2\|sang\|0/);
});
