"use strict";

// 31/08: Dạy ghép dùng LUẬT của môn gốc (chủ dự án: "khi tôi phân dạy ghép thì cũng sẽ sử dụng môn học
// nên sẽ sử dụng yêu cầu môn học chứ không phải tạo ra một mớ môn học theo tên viết tắt"). Khoá dòng
// ghép ("AV-GT") là bí danh của môn gốc (row.mon[0] = "AVGT") trong bảng luật / bộ kiểm tra:
//  1. bộ chọn môn ở Yêu cầu không liệt kê khoá ghép, chỉ có môn gốc;
//  2. luật đặt cho môn gốc (tiết/ngày, nghỉ cố định môn, tiết đôi) áp cho ô ghép và ô ghép được
//     đếm cùng môn gốc; số tiết khả dụng cho "tiết đôi bất khả thi" gộp cả dòng ghép;
//  3. luật từng lưu dưới khoá ghép được chuyển sang môn gốc khi nạp.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const CONSTRAINTS_PATH = path.resolve(__dirname, "..", "web", "pages", "tkb-constraints.js");
const CONSTRAINTS_SOURCE = fs.readFileSync(CONSTRAINTS_PATH, "utf8");

function blankSession(values = []){
  return Array.from({length:5}, (_, index) => values[index] || "");
}

function loadConstraints(data){
  const head = {appendChild(){}};
  const body = {appendChild(){}};
  const document = {
    head, body, readyState:"complete",
    getElementById(){ return null; },
    querySelectorAll(){ return []; },
    addEventListener(){},
    createElement(){ return {id:"", textContent:"", style:{}, classList:{add(){}, remove(){}, toggle(){}}}; }
  };
  const window = {
    DATA:data, document, location:{search:""}, __TKB_E2E_EXPOSE_TEST_HOOKS:true,
    addEventListener(){}, removeEventListener(){}, setTimeout, clearTimeout
  };
  window.window = window;
  const context = {
    window, document, DATA:data, DAYS:["thu2", "thu3"], LABEL:{thu2:"Thu 2", thu3:"Thu 3"}, SANG:5, CHIEU:5,
    console, Date, Math, JSON, Object, Array, Set, Map, WeakMap, URLSearchParams, setTimeout, clearTimeout
  };
  vm.runInNewContext(CONSTRAINTS_SOURCE, context, {filename:CONSTRAINTS_PATH});
  return {api: window.TKBConstraints, hooks: window.__TKB_CONSTRAINTS_TEST_HOOKS};
}

// 6A1: môn thật AVGT (GV1, 1 tiết) + dòng ghép "AV-GT" (GV1, GV2 cùng dạy, 1 tiết) của môn AVGT.
function schoolData(opts = {}){
  const data = {
    lop:[{id:"L1", ten:"6A1"}],
    giaovien:[{magv:"GV1", ten:"Cương"}, {magv:"GV2", ten:"Gems"}, {magv:"GV3", ten:"Toán"}],
    monhoc:[{id:"AVGT", ma:"AVGT", ten:"Anh văn giao tiếp"}, {id:"TOAN", ma:"TOAN", ten:"Toán"}],
    mon:[{id:"M1", khoi:"6", ten:"AVGT", sotiet:"1", gioihan:"2"}, {id:"M2", khoi:"6", ten:"TOAN", sotiet:"4", gioihan:"2"}],
    dayGhep:[{id:"DG001", ten:"AV-GT", viettat:"AV-GT", lop:["6A1"], mon:["AVGT"], gv:["GV1", "GV2"], sotiet:"1", gioihan:"1"}],
    pccmMatrix:{"6A1|AVGT":"GV1", "6A1|AV-GT":"GV1, GV2", "6A1|TOAN":"GV3"},
    pccmTietMatrix:{"6A1|AVGT":"1", "6A1|AV-GT":"1", "6A1|TOAN":"4"},
    pccmGioihanMatrix:{"6A1|AVGT":"2", "6A1|AV-GT":"1", "6A1|TOAN":"2"},
    dayGhepProjected:["6A1|AV-GT"],
    tkb:{L1:{thu2:{sang:blankSession(opts.thu2 || []), chieu:blankSession()}, thu3:{sang:blankSession(opts.thu3 || []), chieu:blankSession()}}},
    tkbConstraints:opts.constraints || {}
  };
  if(opts.noMain){ delete data.pccmMatrix["6A1|AVGT"]; delete data.pccmTietMatrix["6A1|AVGT"]; delete data.pccmGioihanMatrix["6A1|AVGT"]; }
  return data;
}

test("bộ chọn môn ở Yêu cầu: khoá dạy ghép không xuất hiện, môn gốc có mặt (kể cả khi môn gốc chỉ có dòng ghép)", () => {
  const {hooks} = loadConstraints(schoolData());
  const ids = hooks.getSubjectList().map(x => String(x.id).toLowerCase());
  assert.ok(!ids.includes("av-gt"), "khoá ghép AV-GT không được liệt kê như một môn: " + ids.join(","));
  assert.ok(ids.includes("avgt"), "môn gốc AVGT phải có: " + ids.join(","));
  assert.ok(ids.includes("toan"));

  const only = loadConstraints(schoolData({noMain:true}));
  const ids2 = only.hooks.getSubjectList().map(x => String(x.id).toLowerCase());
  assert.ok(!ids2.includes("av-gt") && ids2.includes("avgt"), "chỉ có dòng ghép vẫn hiện môn gốc để đặt luật: " + ids2.join(","));
});

test("luật 'tối đa 1 tiết/ngày' của môn gốc: ô ghép được đếm cùng ô môn thật -> vi phạm", () => {
  const constraints = {subject:{AVGT:{byClass:{L1:{maxPeriods:{day:{thu2:1}}}}}}};
  const {api} = loadConstraints(schoolData({thu2:["AVGT", "", "AV-GT"], constraints}));
  const items = api.validateAll(100);
  const hit = items.filter(item => /AV-GT|AVGT|Anh văn/i.test(String(item.mon || "") + String(item.message || "")));
  assert.ok(hit.length >= 1, "phải báo vượt 1 tiết/ngày khi AVGT + AV-GT cùng ngày: " + JSON.stringify(items));

  // tách ra hai ngày -> hết vi phạm
  const ok = loadConstraints(schoolData({thu2:["AVGT"], thu3:["AV-GT"], constraints}));
  assert.equal(ok.api.validateAll(100).length, 0, "mỗi ngày một tiết thì hợp lệ");
});

test("nghỉ cố định theo môn gốc áp cho ô ghép", () => {
  const constraints = {fixedOff:{subject:{AVGT:{"thu2|sang|0":true}}}};
  const bad = loadConstraints(schoolData({thu2:["AV-GT"], constraints}));
  const items = bad.api.validateAll(100);
  assert.ok(items.some(item => item.thu === "thu2" && Number(item.ti) === 0), "ô ghép rơi vào tiết nghỉ cố định của môn gốc phải bị báo: " + JSON.stringify(items));
  const good = loadConstraints(schoolData({thu2:["", "AV-GT"], constraints}));
  assert.equal(good.api.validateAll(100).length, 0);
});

test("tiết đôi: số tiết khả dụng gộp môn thật + dòng ghép; ô ghép ghép cặp được với ô môn thật", () => {
  const constraints = {subject:{AVGT:{byClass:{L1:{lessonBlocks:{2:{min:1}}}}}}};
  // AVGT (1 tiết) + AV-GT (1 tiết) = 2 tiết -> Min 1 cụm đôi khả thi; xếp liền nhau -> đạt
  const paired = loadConstraints(schoolData({thu2:["AVGT", "AV-GT"], constraints}));
  assert.equal(paired.api.validateAll(100).filter(i => i.kind === "subject.lessonBlocks.min").length, 0, JSON.stringify(paired.api.validateAll(100)));
  // tách rời -> chưa đạt Min
  const split = loadConstraints(schoolData({thu2:["AVGT", "", "AV-GT"], constraints}));
  assert.equal(split.api.validateAll(100).filter(i => i.kind === "subject.lessonBlocks.min").length, 1);
  // chỉ có dòng ghép 1 tiết -> Min 1 cụm đôi bất khả thi -> bỏ qua, không báo
  const only = loadConstraints(schoolData({noMain:true, thu2:["AV-GT"], constraints}));
  assert.equal(only.api.validateAll(100).filter(i => i.kind === "subject.lessonBlocks.min").length, 0);
});

test("luật từng lưu dưới khoá ghép được chuyển sang môn gốc khi nạp (không đè luật đã có của môn gốc)", () => {
  const constraints = {
    subject:{"AV-GT":{byClass:{L1:{maxPeriods:{day:{thu2:1}}}}}, AVGT:{byClass:{}}},
    fixedOff:{subject:{"AV-GT":{"thu3|sang|0":true}}},
    groups:{subject:{g1:{name:"Nhóm", items:["AV-GT", "TOAN"]}}},
    timeLimit:[{name:"x", targetType:"subject", targetId:"AV-GT", perSlot:{}, perSession:{}}]
  };
  const {api} = loadConstraints(schoolData({thu2:["AVGT", "", "AV-GT"], constraints}));
  const model = api.get();
  assert.equal(model.subject["AV-GT"], undefined, "khoá ghép không còn là khoá luật");
  assert.deepEqual(JSON.parse(JSON.stringify(model.subject.AVGT.byClass.L1.maxPeriods)), {day:{thu2:1}});
  assert.equal(model.fixedOff.subject["AV-GT"], undefined);
  assert.equal(model.fixedOff.subject.AVGT["thu3|sang|0"], true);
  assert.deepEqual([...model.groups.subject.g1.items], ["AVGT", "TOAN"]);
  assert.equal(model.timeLimit[0].targetId, "AVGT");
  // luật đã chuyển vẫn có hiệu lực: AVGT + AV-GT cùng thứ 2 -> vượt 1 tiết/ngày
  assert.ok(api.validateAll(100).length >= 1);
});

// 02/09: dòng ghép KHÔNG giáo viên (gv:[]) — không có khoá pccmMatrix, chỉ bảng Tiết/Giới hạn.
test("02/09 dòng ghép không GV vẫn là tiết của lớp trong bộ kiểm tra: gộp số tiết khả dụng với môn gốc, luật môn gốc áp cho ô", () => {
  const constraints = {subject:{AVGT:{byClass:{L1:{lessonBlocks:{2:{min:1}}}}}}};
  const make = (opts) => {
    const data = schoolData(opts);
    data.dayGhep[0].gv = [];
    delete data.pccmMatrix["6A1|AV-GT"];
    return data;
  };
  // AVGT (1 tiết, GV1) + AV-GT không GV (1 tiết) = 2 tiết -> Min 1 cụm đôi khả thi; tách rời -> chưa đạt
  const split = loadConstraints(make({thu2:["AVGT", "", "AV-GT"], constraints}));
  assert.equal(split.api.validateAll(100).filter(i => i.kind === "subject.lessonBlocks.min").length, 1,
    "dòng không GV phải được cộng vào số tiết khả dụng của môn gốc: " + JSON.stringify(split.api.validateAll(100)));
  const paired = loadConstraints(make({thu2:["AVGT", "AV-GT"], constraints}));
  assert.equal(paired.api.validateAll(100).filter(i => i.kind === "subject.lessonBlocks.min").length, 0);
  // luật 'tối đa 1 tiết/ngày' của môn gốc: ô không GV đếm cùng ô môn thật -> vi phạm
  const dayCap = {subject:{AVGT:{byClass:{L1:{maxPeriods:{day:{thu2:1}}}}}}};
  const capped = loadConstraints(make({thu2:["AVGT", "", "AV-GT"], constraints:dayCap}));
  const cappedItems = capped.api.validateAll(100);
  assert.ok(cappedItems.some(i => /vượt giới hạn/.test(String(i.message || ""))), JSON.stringify(cappedItems));
  // không có GV nào bị coi là trùng giờ / bận vì ô không GV
  const {hooks} = loadConstraints(make({thu2:["AV-GT"], constraints:{}}));
  assert.equal(hooks.isNoTeacherGhepAssignment("6A1", "AV-GT"), true);
  assert.equal(hooks.isNoTeacherGhepAssignment("L1", "AV-GT"), true, "nhận mã lớp");
  assert.equal(hooks.isNoTeacherGhepAssignment("6A1", "AVGT"), false);
});
