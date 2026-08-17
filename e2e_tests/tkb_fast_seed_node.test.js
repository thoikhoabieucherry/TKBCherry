"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const FAST_SEED_PATH = path.resolve(__dirname, "..", "web", "pages", "tkb-fast-seed.js");
const fastSeed = require(FAST_SEED_PATH);

function baseData(periods = 2){
  return {
    lop:[{id:"L1", ten:"7A", ten2:"7A", khoi:"Khá»‘i 7"}],
    giaovien:[{id:"G1", magv:"GV01", ten:"An"}],
    monhoc:[{id:"M1", ma:"TOAN", ten:"ToÃ¡n"}],
    mon:[{khoi:"7", ten:"ToÃ¡n", sotiet:periods, gioihan:2}],
    pccmMatrix:{"L1|TOAN":"GV01"},
    pccmTietMatrix:{"L1|TOAN":periods},
    pccmGioihanMatrix:{"L1|TOAN":2},
    pccmRoomMatrix:{},
    tkb:{},
    tkbUserOff:{},
    tkbConstraints:{}
  };
}

test("fast seed falls back to standard periods when PCCM period matrix is absent", () => {
  const data = baseData(2);
  delete data.pccmTietMatrix;
  const result = fastSeed.generate(data, {maxMs:500, attempts:4, seed:17});

  assert.equal(result.ok, true);
  assert.equal(result.expectedPeriods, 2);
  assert.equal(result.scheduledPeriods, 2);
  assert.equal(result.complete, true);
});

test("fast seed deduplicates assignment aliases instead of doubling demand", () => {
  const data = baseData(2);
  data.pccmMatrix["7A|ToÃ¡n"] = "GV01";
  data.pccmTietMatrix["7A|ToÃ¡n"] = 2;
  const model = fastSeed._buildModel(data);

  assert.equal(model.assignments.length, 1);
  assert.equal(model.expectedPeriods, 2);
});

test("fixed lesson overrides mirrored OFF but fixed demand overflow fails closed", () => {
  const data = baseData(1);
  data.tkb = {
    L1:{thu2:{sang:[{mon:"TOAN", fixed:true}, "", "", "", ""]}}
  };
  data.tkbUserOff = {L1:["thu2|sang|0"]};
  const fixed = fastSeed.generate(data, {maxMs:300, attempts:2, seed:17});

  assert.equal(fixed.ok, true);
  assert.equal(fixed.complete, true);
  assert.equal(fixed.lessons[0].day, 2);
  assert.equal(fixed.lessons[0].session, "AM");
  assert.equal(fixed.lessons[0].period, 1);

  data.tkb.L1.thu2.sang[1] = {mon:"TOAN", fixed:true};
  const overflow = fastSeed.generate(data, {maxMs:300, attempts:2, seed:17});
  assert.equal(overflow.ok, false);
  assert.match(overflow.invalidReasons.join("\n"), /fixed_demand_overflow/);
});

test("fast seed never gives one teacher or class two lessons in one slot", () => {
  const data = baseData(2);
  data.lop.push({id:"L2", ten:"7B", ten2:"7B", khoi:"Khá»‘i 7"});
  data.pccmMatrix["L2|TOAN"] = "GV01";
  data.pccmTietMatrix["L2|TOAN"] = 2;
  const result = fastSeed.generate(data, {maxMs:800, attempts:8, seed:29});
  const classSlots = new Set();
  const teacherSlots = new Set();
  for(const lesson of result.lessons){
    const slot = `${lesson.day}|${lesson.session}|${lesson.period}`;
    const classSlot = `${lesson.className}|${slot}`;
    const teacherSlot = `${lesson.teacher}|${slot}`;
    assert.equal(classSlots.has(classSlot), false);
    assert.equal(teacherSlots.has(teacherSlot), false);
    classSlots.add(classSlot);
    teacherSlots.add(teacherSlot);
  }
  assert.equal(result.expectedPeriods, 4);
  assert.equal(result.scheduledPeriods, 4);
});
