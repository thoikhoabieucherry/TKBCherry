/**
 * Kiem tra 3 chot chan cua may xep FET (chay bang Node, khong can trinh duyet):
 *   1. Yeu cau "cap tiet doi" vuot Gioi han tiet/buoi  -> bo ghep doi, xep du tiet
 *   2. Gioi han du rong                                -> van giu cap tiet doi
 *   3. Nhu cau nhieu hon so o trong                    -> bao thieu bao nhieu o, khong treo
 *
 *   node tools/tests/fet_guards_test.js
 */
require("../../web/pages/tkb-fet-engine.js");
const Engine = globalThis.FetTimetableEngine;

const DAYS = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];

function makeTkb(freeMorningPeriods){
  const t = {};
  for(const d of DAYS){
    t[d] = {
      sang: Array.from({length: 5}, (_, i) => (i < freeMorningPeriods ? null : "OFF")),
      chieu: ["OFF", "OFF", "OFF", "OFF", "OFF"]
    };
  }
  return t;
}

function baseData({limit, periods = 3, blockLen = 2, freeMorningPeriods = 5}){
  return {
    lop: [{id: "L1", ten: "8/1", khoi: "Khối 8"}],
    monhoc: [{id: "MH1", ma: "NNgữ", ten: "Ngoại ngữ"}],
    mon: [{ten: "NNgữ", khoi: "Khối 8", sotiet: String(periods), gioihan: String(limit)}],
    giaovien: [{id: "GV1", magv: "Thúy.A", ten: "Thúy"}],
    pccmMatrix: {"8/1|NNgữ": "Thúy.A"},
    pccmTietMatrix: {"8/1|NNgữ": String(periods)},
    pccmGioihanMatrix: {"8/1|NNgữ": String(limit)},
    tkb: {L1: makeTkb(freeMorningPeriods)},
    tkbConstraints: {
      subject: {"NNgữ": {byClass: {"8/1": {lessonBlocks: {[String(blockLen)]: {min: 1, max: 1}}}}}}
    }
  };
}

let failures = 0;
function check(name, cond, detail){
  if(cond){
    console.log("  OK   " + name);
  }else{
    failures += 1;
    console.log("  FAIL " + name + " -> " + JSON.stringify(detail));
  }
}

async function run(){
  // 1. Gioi han 1 tiet/buoi nhung yeu cau cap doi 2 tiet
  {
    const e = new Engine(baseData({limit: 1}), {solveBudgetMs: 8000});
    const res = await e.solve(null);
    check("gioi han 1: xep du 3 tiet", res.placed === 3 && res.unassigned === 0, res);
    check("gioi han 1: bao mau thuan cap doi",
      (res.blockLimitConflicts || []).some(c => c.blockLen === 2 && c.sessionLimit === 1),
      res.blockLimitConflicts);
    check("gioi han 1: khong con khoi 2 tiet",
      e.activities.every(a => a.duration === 1),
      e.activities.map(a => a.duration));
  }

  // 2. Gioi han 2: van phai giu cap tiet doi
  {
    const data = baseData({limit: 2});
    const e = new Engine(data, {solveBudgetMs: 8000});
    const res = await e.solve(null);
    check("gioi han 2: xep du 3 tiet", res.placed === 3 && res.unassigned === 0, res);
    // 30/10 (FET V3): cap doi co the la 1 hoat dong dai 2 tiet HOAC 2 tiet le dat lien nhau
    // (luat lessonBlocks ap luc xep) -> kiem KET QUA tren luoi: co 2 tiet lien nhau trong mot buoi.
    const runs = [];
    for(const d of DAYS){
      let run = 0;
      for(const cell of data.tkb.L1[d].sang){
        if(cell && cell !== "OFF"){ run += 1; }else{ if(run) runs.push(run); run = 0; }
      }
      if(run) runs.push(run);
    }
    check("gioi han 2: giu cap tiet doi", runs.includes(2), runs);
    check("gioi han 2: khong bao mau thuan",
      (res.blockLimitConflicts || []).length === 0,
      res.blockLimitConflicts);
  }

  // 3. Thieu o that su: 8 tiet nhung chi mo 6 o
  {
    const data = baseData({limit: 2, periods: 8, freeMorningPeriods: 1});
    const e = new Engine(data, {solveBudgetMs: 8000});
    const started = Date.now();
    const res = await e.solve(null);
    const elapsed = Date.now() - started;
    check("thieu o: bao dung so o con thieu", res.capacityDeficit === 2, res);
    check("thieu o: van xep het o co the", res.placed === 6, res);
    check("thieu o: khong treo (< 15s)", elapsed < 15000, elapsed);
  }

  // 4. Giao vien qua tai: 1 GV day 2 lop, moi lop 20 tiet, nhung ca hai lop
  //    chi mo chung 1 buoi/ngay (30 o) -> 40 tiet / 30 o, thua 10.
  {
    const data = {
      lop: [{id: "L1", ten: "8/1", khoi: "Khối 8"}, {id: "L2", ten: "8/2", khoi: "Khối 8"}],
      monhoc: [{id: "MH1", ma: "CN", ten: "Công nghệ"}],
      mon: [{ten: "CN", khoi: "Khối 8", sotiet: "20", gioihan: "5"}],
      giaovien: [{id: "GV1", magv: "CN.Nga", ten: "Nga"}],
      pccmMatrix: {"8/1|CN": "CN.Nga", "8/2|CN": "CN.Nga"},
      pccmTietMatrix: {"8/1|CN": "20", "8/2|CN": "20"},
      pccmGioihanMatrix: {"8/1|CN": "5", "8/2|CN": "5"},
      tkb: {L1: makeTkb(5), L2: makeTkb(5)},
      tkbConstraints: {}
    };
    const e = new Engine(data, {solveBudgetMs: 8000});
    const res = await e.solve(null);
    check("gv qua tai: bao dung so tiet thua", res.teacherDeficit === 10, res.teacherDeficit);
    check("gv qua tai: chi ro giao vien",
      (res.teacherRows || []).some(r => String(r.teacher).toLowerCase() === "cn.nga" && r.need === 40 && r.slots === 30),
      res.teacherRows);
  }

  console.log(failures === 0 ? "\nTAT CA DAT" : `\n${failures} MUC KHONG DAT`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch(err => { console.error(err); process.exit(1); });
