"use strict";

// 13/09 (chủ dự án): kéo tiết A thả lên ô đang có tiết khác ở bảng lớp / bảng GV — nếu tiết
// bị đè chuyển được sang ô cũ của A mà vẫn đúng luật thì ĐỔI CHỖ, không đưa về "Chưa phân".
// Lượt 4: "2 bên phải thật sự trống mới xanh" — không đổi chỗ được thì ô ĐỎ, không cho thả.
// Test chạy validateDrop + các hàm đổi chỗ thật của phanmon.js (cắt theo mốc) và luật Yêu
// cầu thật của tkb-constraints.js để bắt lỗi đếm trùng tiết khi chỉ mục lịch bị cũ.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const PHANMON_PATH = path.resolve(__dirname, "..", "web", "pages", "phanmon.js");
const PHANMON_SOURCE = fs.readFileSync(PHANMON_PATH, "utf8").replace(/\r\n/g, "\n");
const CONSTRAINTS_PATH = path.resolve(__dirname, "..", "web", "pages", "tkb-constraints.js");
const CONSTRAINTS_SOURCE = fs.readFileSync(CONSTRAINTS_PATH, "utf8");
const DAYS = ["thu2", "thu3"];

function slice(startMarker, endMarker){
  const start = PHANMON_SOURCE.indexOf(startMarker);
  const end = PHANMON_SOURCE.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `cannot extract ${startMarker}`);
  return PHANMON_SOURCE.slice(start, end);
}

const PLANNER_SOURCE = [
  slice("function findTeacherConflictAtSlot", "let __tkbStableSave"),
  slice("/* ======================= ĐỔI CHỖ KHI THẢ ĐÈ", "/* ======================= HẾT ĐỔI CHỖ KHI THẢ ĐÈ"),
  slice("function validateDrop", "function countMonInTKB"),
  slice("function countMonInTKB", "let REQUIRED_SUBJECTS_CACHE"),
  slice("function tkbAutoRepairCellStub", "function tkbAutoRepairSlotStub")
].join("\n");

function session(values = []){ return Array.from({length:5}, (_, i) => values[i] ?? ""); }
function week(spec = {}){
  const out = {};
  DAYS.forEach(d => { out[d] = {sang:session(spec[d]?.sang), chieu:session(spec[d]?.chieu)}; });
  return out;
}
function lessonValue(v){
  if(v === "OFF" || v === "" || v == null) return "";
  if(typeof v === "string") return v;
  return v && typeof v === "object" ? String(v.mon || "") : "";
}
function teacherList(raw){ return String(raw || "").split(",").map(s => s.trim()).filter(Boolean); }

function loadConstraints(data){
  const document = {
    head:{appendChild(){}}, body:{appendChild(){}}, readyState:"complete",
    getElementById(){ return null; }, querySelectorAll(){ return []; }, addEventListener(){},
    createElement(){ return {id:"", textContent:"", style:{}, classList:{add(){}, remove(){}, toggle(){}}}; }
  };
  const window = {DATA:data, document, location:{search:""}, addEventListener(){}, removeEventListener(){}, setTimeout, clearTimeout};
  window.window = window;
  const context = {
    window, document, DATA:data, DAYS, LABEL:{thu2:"Thu 2", thu3:"Thu 3"}, SANG:5, CHIEU:5,
    console, Date, Math, JSON, Object, Array, Set, Map, WeakMap, URLSearchParams, setTimeout, clearTimeout
  };
  vm.runInNewContext(CONSTRAINTS_SOURCE, context, {filename:CONSTRAINTS_PATH});
  assert.equal(typeof window.TKBConstraints?.canPlaceLesson, "function");
  return window.TKBConstraints;
}

// data: {tkb, pccmMatrix, pccmGioihanMatrix, tkbConstraints?, joint?: ["L1|Mon"]}
function loadPlanner(data, {withConstraints = false} = {}){
  const calls = {saves:0, renders:0, toasts:[], invalidations:0};
  const api = withConstraints ? loadConstraints(data) : null;
  const window = {
    TKBConstraints:{
      invalidateConstraintCache(){
        calls.invalidations += 1;
        if(api) api.invalidateConstraintCache();
      },
      refreshScheduleIndexClasses(ids){
        calls.refreshes = (calls.refreshes || 0) + 1;
        return api ? api.refreshScheduleIndexClasses(ids) : false;
      },
      teacherCellsAfterPlace(teacher, ctx){
        calls.warmups = (calls.warmups || 0) + 1;
        return api ? api.teacherCellsAfterPlace(teacher, ctx) : [];
      }
    }
  };
  const context = {
    window, console, Object, Array, Map, Set, Number, String, JSON, Date,
    DATA:data, DAYS,
    currentLop:"L1", dragData:null, dragMon:"",
    CURRENT_MON_META:{},
    DRAG_SWAP_PLAN_CACHE:new Map(),
    getMonMeta(mon){ return context.CURRENT_MON_META[mon] || {sotiet:0, gioihan:1}; },
    countMon(mon){ return context.countMonInTKB(data.tkb[context.currentLop], mon); },
    monCanonicalKey(mon){ return String(mon || "").trim().toLowerCase(); },
    cellMon:lessonValue,
    isFixed(v){ return !!(v && typeof v === "object" && v.fixed); },
    getLopCanonById(id){ return String(id); },
    getTeacherForClassMon(lop, mon){ return data.pccmMatrix[`${lop}|${mon}`] || ""; },
    getRoomForClassMon(lop, mon){ return (data.pccmRoomMatrix || {})[`${lop}|${mon}`] || ""; },
    getGioiHanForClassMon(lop, mon){ return Number((data.pccmGioihanMatrix || {})[`${lop}|${mon}`] || 1); },
    teacherValueFromRaw(raw){ return teacherList(raw).join(", "); },
    teacherValuesIntersect(a, b){ const bb = new Set(teacherList(b).map(x => x.toLowerCase())); return teacherList(a).some(x => bb.has(x.toLowerCase())); },
    tkbIsJointGhepPair(){ return false; },
    tkbJointSiblingBlockers(){ return null; },
    tkbGhepJointRowAt(classId, mon){ return (data.joint || []).includes(`${classId}|${mon}`) ? {lop:["a", "b"]} : null; },
    flashLopItemConflict(){},
    getMonShort(mon){ return mon; },
    buildReplaceConfirmText(){ return "confirm"; },
    showDropToast(msg){ calls.toasts.push(msg); },
    _setStatus(){},
    saveStoreDeferred(){ calls.saves += 1; },
    renderCurrentView(){ calls.renders += 1; },
    loadMonList(){},
    clearDragVisual(){ context.DRAG_SWAP_PLAN_CACHE.clear(); }
  };
  vm.runInNewContext(PLANNER_SOURCE, context, {filename:PHANMON_PATH});
  if(api){
    // như bản bọc validateDrop thật trong tkb-constraints.js (hook cài lúc nạp trang)
    const base = context.validateDrop;
    context.validateDrop = function(targetTd, mon){
      const res = base(targetTd, mon);
      if(res && res.ok === false) return res;
      const ds = targetTd.dataset;
      const type = String(context.dragData?.type || "");
      const src = (type === "cell" || type === "pairTeacherCell") ? context.dragData.from?.dataset : null;
      const check = api.canPlaceLesson({lopId:String(context.currentLop), mon, thu:ds.thu, buoi:ds.buoi, ti:Number(ds.ti), src, mode:"drag"});
      if(!check.ok) return {ok:false, reason:"tkb-constraints", msg:(check.messages || []).join("\n")};
      return res;
    };
  }
  return {context, calls, api};
}

function cell(thu, buoi, ti){ return {dataset:{thu, buoi, ti:String(ti)}, classList:{contains(){ return false; }}}; }

function startDrag(context, classId, thu, buoi, ti, {teacherGrid = false} = {}){
  const from = cell(thu, buoi, ti);
  const mon = lessonValue(context.DATA.tkb[classId][thu][buoi][ti]);
  context.dragData = teacherGrid
    ? {type:"pairTeacherCell", classId, from, val:mon, mon}
    : {type:"cell", from, val:mon};
  context.dragMon = mon;
  return from;
}

const snapshot = data => JSON.stringify(data.tkb);

test("cùng lớp: thả Toán lên ô Văn -> đổi chỗ, không đưa Văn về Chưa phân", () => {
  const data = {
    tkb:{L1:week({thu2:{sang:["Toan", "Anh", "Van"]}})},
    pccmMatrix:{"L1|Toan":"GV1", "L1|Anh":"GV2", "L1|Van":"GV3"}
  };
  const {context, calls} = loadPlanner(data);
  startDrag(context, "L1", "thu2", "sang", 0);

  assert.equal(context.tkbTryDropSwap(cell("thu2", "sang", 2), "L1"), true);
  assert.deepEqual(data.tkb.L1.thu2.sang, ["Van", "Anh", "Toan", "", ""]);
  assert.equal(calls.saves, 1);
  assert.equal(calls.renders, 1);
  assert.match(calls.toasts[0], /Đã đổi chỗ Toan ↔ Van/);
  assert.equal(context.dragData, null);
  assert.equal(calls.invalidations, 1, "đổi trong lớp: không đặt thử, chỉ xoá bộ đệm luật một lần sau khi ghi");
});

test("cùng lớp: tiết bị đè về ô cũ sẽ phạm luật (Văn tách cụm) -> ô đỏ, không cho thả, không đổi dữ liệu", () => {
  const data = {
    tkb:{L1:week({thu2:{sang:["Toan", "Anh", "Van", "Van"]}})},
    pccmMatrix:{"L1|Toan":"GV1", "L1|Anh":"GV2", "L1|Van":"GV3"},
    pccmGioihanMatrix:{"L1|Van":"2"}
  };
  const {context, calls} = loadPlanner(data);
  startDrag(context, "L1", "thu2", "sang", 0);
  const before = snapshot(data);
  // Toán tự nó đặt vào tiết 4 được (validateDrop ok) nhưng Văn không về tiết 1 được
  assert.equal(context.validateDrop(cell("thu2", "sang", 3), "Toan").ok, true);
  const res = context.tkbMainDropResult(cell("thu2", "sang", 3), "Toan");
  assert.equal(res.ok, false, "không đổi chỗ được thì không được tô xanh");
  assert.equal(res.reason, "swap-blocked");
  assert.equal(context.tkbTryDropSwap(cell("thu2", "sang", 3), "L1"), false);
  assert.equal(snapshot(data), before);
  assert.equal(calls.saves, 0);
  // ô trống vẫn xanh như cũ; kéo từ "Chưa phân" lên ô có tiết vẫn theo đường cũ
  assert.equal(context.tkbMainDropResult(cell("thu2", "sang", 4), "Toan").ok, true);
  data.tkb.L1.thu3.sang[0] = "Anh";
  context.dragData = {type:"mon", classId:"L1", mon:"Toan"};
  context.dragMon = "Toan";
  const fromList = context.tkbMainDropResult(cell("thu3", "sang", 0), "Toan");
  assert.equal(fromList.ok, true);
  assert.equal(fromList.reason, undefined);
});

test("khác lớp: trùng GV ở ô đích, ô cũ của lớp kia trống -> ô xanh, thả là đổi chỗ hai tiết của GV", () => {
  const data = {
    tkb:{
      L1:week({thu2:{sang:["Toan", "", "Anh"]}}),
      L2:week({thu2:{sang:["", "Ly", "Hoa"]}})
    },
    pccmMatrix:{"L1|Toan":"GV1", "L1|Anh":"GV2", "L2|Ly":"GV1", "L2|Hoa":"GV3"}
  };
  const {context, calls} = loadPlanner(data);
  startDrag(context, "L1", "thu2", "sang", 0);

  const res = context.tkbMainDropResult(cell("thu2", "sang", 1), "Toan");
  assert.equal(res.ok, true);
  assert.equal(res.warn, false, "ô trùng GV nhưng đổi chỗ được phải tô xanh");
  assert.equal(res.swap.moves.length, 1);
  assert.equal(res.swap.moves[0].classId, "L2");
  const planned = snapshot(data);
  assert.equal(planned, JSON.stringify({L1:week({thu2:{sang:["Toan", "", "Anh"]}}), L2:week({thu2:{sang:["", "Ly", "Hoa"]}})}), "đặt thử xong phải trả nguyên dữ liệu");
  assert.ok(calls.invalidations >= 2, "đặt thử khác lớp phải xoá bộ đệm luật trước và sau");

  assert.equal(context.tkbTryDropSwap(cell("thu2", "sang", 1), "L1"), true);
  assert.deepEqual(data.tkb.L1.thu2.sang, ["", "Toan", "Anh", "", ""]);
  assert.deepEqual(data.tkb.L2.thu2.sang, ["Ly", "", "Hoa", "", ""]);
  assert.match(calls.toasts.at(-1), /Toan ↔ Ly-L2/);
});

test("bảng GV: 2 tiết của cùng GV ở 2 lớp, ô cũ bên kia có tiết -> đổi chỗ KÉP", () => {
  // GV1 dạy Toán-L1 tiết 1 và Lý-L2 tiết 2. Kéo Toán sang tiết 2:
  // L1: Toán 1->2, Anh 2->1; L2: Lý 2->1, Hóa 1->2.
  const data = {
    tkb:{
      L1:week({thu2:{sang:["Toan", "Anh"]}}),
      L2:week({thu2:{sang:["Hoa", "Ly"]}})
    },
    pccmMatrix:{"L1|Toan":"GV1", "L1|Anh":"GV2", "L2|Ly":"GV1", "L2|Hoa":"GV3"}
  };
  const {context, calls} = loadPlanner(data);
  startDrag(context, "L1", "thu2", "sang", 0, {teacherGrid:true});
  const plan = context.tkbDropSwapPlanCached("L1", {thu:"thu2", buoi:"sang", ti:0}, {thu:"thu2", buoi:"sang", ti:1}, "Toan", {fresh:true});
  assert.ok(plan, "đổi chỗ kép phải được");
  assert.equal(JSON.stringify(plan.moves.map(mv => `${mv.classId}:${mv.mon}`).sort()), JSON.stringify(["L1:Anh", "L2:Hoa", "L2:Ly"]));
  assert.ok(calls.warmups >= 2, "sau mỗi lần xoá bộ đệm luật phải dựng lại ngay");

  context.tkbApplyDropSwap(plan, cell("thu2", "sang", 1));
  assert.deepEqual(data.tkb.L1.thu2.sang, session(["Anh", "Toan"]));
  assert.deepEqual(data.tkb.L2.thu2.sang, session(["Ly", "Hoa"]));
  assert.match(calls.toasts.at(-1), /Toan ↔ Anh, Ly-L2, Hoa-L2/);
});

test("đổi chỗ kép bị chặn khi tiết D sang ô đích trùng GV ở lớp thứ ba -> ô đỏ, không cho thả", () => {
  const data = {
    tkb:{
      L1:week({thu2:{sang:["Toan", ""]}}),
      L2:week({thu2:{sang:["Hoa", "Ly"]}}),
      L3:week({thu2:{sang:["", "Sinh"]}})
    },
    pccmMatrix:{"L1|Toan":"GV1", "L2|Ly":"GV1", "L2|Hoa":"GV3", "L3|Sinh":"GV3"}
  };
  const {context} = loadPlanner(data);
  startDrag(context, "L1", "thu2", "sang", 0);
  const base = context.validateDrop(cell("thu2", "sang", 1), "Toan");
  assert.equal(base.warn, true, "trước đây: hỏi thay thế, đưa Lý-L2 về Chưa phân");
  const res = context.tkbMainDropResult(cell("thu2", "sang", 1), "Toan");
  assert.equal(res.ok, false);
  assert.equal(res.reason, "swap-blocked");
  assert.equal(res.swap, undefined);
  assert.equal(context.tkbTryDropSwap(cell("thu2", "sang", 1), "L1"), false);
  assert.equal(JSON.stringify(data.tkb.L2.thu2.sang), JSON.stringify(session(["Hoa", "Ly"])));
  assert.match(context.tkbSwapBlockedNote(cell("thu2", "sang", 1), "L1", base), /^Không đổi chỗ được: Trùng GV GV1 .*tiết đó không đổi sang ô cũ được\.$/);
});

test("không đổi chỗ được thì câu báo nêu lý do", () => {
  const data = {
    tkb:{L1:week({thu2:{sang:["Toan", "Anh", "Van", "Van"]}})},
    pccmMatrix:{"L1|Toan":"GV1", "L1|Anh":"GV2", "L1|Van":"GV3"},
    pccmGioihanMatrix:{"L1|Van":"2"}
  };
  const {context} = loadPlanner(data);
  startDrag(context, "L1", "thu2", "sang", 0);
  const res = context.validateDrop(cell("thu2", "sang", 3), "Toan");
  const note = context.tkbSwapBlockedNote(cell("thu2", "sang", 3), "L1", res);
  assert.equal(note, "Không đổi chỗ được: Van về ô cũ thì các tiết cùng môn trong buổi sẽ không liền nhau.");
  assert.equal(context.tkbSwapBlockedNote(cell("thu2", "sang", 4), "L1", {ok:true}), "", "ô đích trống: không có gì để báo");

  const limitData = {
    tkb:{L1:week({thu2:{sang:["Toan", "Van"]}, thu3:{sang:["Van"]}})},
    pccmMatrix:{"L1|Toan":"GV1", "L1|Van":"GV3"}
  };
  const {context:c2} = loadPlanner(limitData);
  // kéo Toán (thứ 2 tiết 1) lên Văn thứ 3: Văn về thứ 2 tiết 1 thì buổi đó có 2 tiết Văn > giới hạn 1
  startDrag(c2, "L1", "thu2", "sang", 0);
  assert.match(c2.tkbSwapBlockedNote(cell("thu3", "sang", 0), "L1", {ok:true}), /vượt giới hạn 1 tiết\/buổi/);
});

test("không đổi tiết cố định, tiết học chung nhiều lớp, và không áp cho kéo từ Chưa phân", () => {
  const fixedData = {
    tkb:{L1:week({thu2:{sang:["Toan", {mon:"Van", fixed:true}]}})},
    pccmMatrix:{"L1|Toan":"GV1", "L1|Van":"GV3"}
  };
  let {context} = loadPlanner(fixedData);
  startDrag(context, "L1", "thu2", "sang", 0);
  assert.equal(context.tkbTryDropSwap(cell("thu2", "sang", 1), "L1"), false);

  const jointData = {
    tkb:{L1:week({thu2:{sang:["Toan", "AI-1"]}})},
    pccmMatrix:{"L1|Toan":"GV1", "L1|AI-1":"GV9"},
    joint:["L1|AI-1"]
  };
  ({context} = loadPlanner(jointData));
  startDrag(context, "L1", "thu2", "sang", 0);
  assert.equal(context.tkbTryDropSwap(cell("thu2", "sang", 1), "L1"), false);

  const listData = {tkb:{L1:week({thu2:{sang:["", "Van"]}})}, pccmMatrix:{"L1|Toan":"GV1", "L1|Van":"GV3"}};
  ({context} = loadPlanner(listData));
  context.dragData = {type:"mon", classId:"L1", mon:"Toan"};
  context.dragMon = "Toan";
  assert.equal(context.tkbTryDropSwap(cell("thu2", "sang", 1), "L1"), false);
});

test("bảng GV: kéo tiết của lớp khác lớp đang xem không đổi nhầm lớp", () => {
  const data = {
    tkb:{L1:week({thu2:{sang:["Van"]}}), L2:week({thu2:{sang:["Toan", "Anh"]}})},
    pccmMatrix:{"L1|Van":"GV3", "L2|Toan":"GV1", "L2|Anh":"GV2"}
  };
  const {context} = loadPlanner(data);
  startDrag(context, "L2", "thu2", "sang", 0, {teacherGrid:true});
  // thả lên bảng lớp đang là L1 -> không phải lớp của tiết đang kéo
  assert.equal(context.tkbDragSwapContext(cell("thu2", "sang", 1), "L1"), null);
  // bảng GV (pvValidateSupportDrop) gọi thẳng kế hoạch theo lớp của tiết
  const plan = context.tkbDropSwapPlanCached("L2", {thu:"thu2", buoi:"sang", ti:0}, {thu:"thu2", buoi:"sang", ti:1}, "Toan", {fresh:true});
  assert.ok(plan);
  assert.equal(plan.classId, "L2");
});

test("luật Yêu cầu thật: đổi cùng ngày không bị đếm trùng (Văn tối đa 1 tiết/ngày)", () => {
  const data = {
    lop:[{id:"L1", ten:"L1"}],
    monhoc:[{id:"Toan", ma:"Toan", ten:"Toan"}, {id:"Van", ma:"Van", ten:"Van"}, {id:"Anh", ma:"Anh", ten:"Anh"}],
    mon:[],
    tkb:{L1:week({thu2:{sang:["Toan", "Anh", "Van"]}})},
    pccmMatrix:{"L1|Toan":"GV1", "L1|Anh":"GV2", "L1|Van":"GV3"},
    tkbConstraints:{subject:{Van:{byClass:{L1:{maxPeriods:{day:{thu2:1, thu3:1}}}}}}}
  };
  const {context, api} = loadPlanner(data, {withConstraints:true});
  // chỉ mục lịch đã dựng từ trước (như lúc tô màu khi bắt đầu kéo)
  assert.equal(api.canPlaceLesson({lopId:"L1", mon:"Anh", thu:"thu2", buoi:"sang", ti:1, mode:"drag"}).ok, true);
  startDrag(context, "L1", "thu2", "sang", 0);
  assert.equal(context.tkbTryDropSwap(cell("thu2", "sang", 2), "L1"), true);
  assert.deepEqual(data.tkb.L1.thu2.sang, ["Van", "Anh", "Toan", "", ""]);
});

test("luật Yêu cầu thật: Văn về ô cũ làm ngày đó có 2 tiết Văn -> không đổi", () => {
  const data = {
    lop:[{id:"L1", ten:"L1"}],
    monhoc:[{id:"Toan", ma:"Toan", ten:"Toan"}, {id:"Van", ma:"Van", ten:"Van"}],
    mon:[],
    tkb:{L1:week({thu2:{sang:["Van"]}, thu3:{sang:["Toan"], chieu:["Van"]}})},
    pccmMatrix:{"L1|Toan":"GV1", "L1|Van":"GV3"},
    tkbConstraints:{subject:{Van:{byClass:{L1:{maxPeriods:{day:{thu2:1, thu3:1}}}}}}}
  };
  const {context} = loadPlanner(data, {withConstraints:true});
  startDrag(context, "L1", "thu3", "sang", 0);
  const before = snapshot(data);
  assert.equal(context.tkbTryDropSwap(cell("thu2", "sang", 0), "L1"), false);
  assert.equal(snapshot(data), before);
});

test("luật Yêu cầu thật: đổi khác lớp kiểm trên lịch SAU khi đổi (GV1 tối đa 2 tiết sáng thứ 2)", () => {
  const data = {
    lop:[{id:"L1", ten:"L1"}, {id:"L2", ten:"L2"}],
    monhoc:[{id:"Toan", ma:"Toan", ten:"Toan"}, {id:"Ly", ma:"Ly", ten:"Ly"}],
    mon:[],
    tkb:{
      L1:week({thu2:{sang:["Toan", ""]}}),
      L2:week({thu2:{sang:["", "Ly"]}})
    },
    pccmMatrix:{"L1|Toan":"GV1", "L2|Ly":"GV1"},
    tkbConstraints:{teacher:{GV1:{maxPeriods:{sang:{thu2:2}}}}}
  };
  const {context, api, calls} = loadPlanner(data, {withConstraints:true});
  assert.equal(api.canPlaceLesson({lopId:"L1", mon:"Toan", thu:"thu2", buoi:"sang", ti:0, mode:"drag"}).ok, true);
  startDrag(context, "L1", "thu2", "sang", 0);
  const res = context.tkbMainDropResult(cell("thu2", "sang", 1), "Toan");
  assert.equal(calls.invalidations, 0, "lượt 7: chỉ mục đã có thì làm tươi từng lớp, không dựng lại cả trường");
  assert.ok(calls.refreshes >= 2);
  assert.equal(res.ok, true);
  assert.equal(res.warn, false, "chỉ mục lịch cũ sẽ đếm GV1 3 tiết và chặn nhầm");
  assert.ok(res.swap);
  // đặt thử xong: dữ liệu và chỉ mục luật trở về lịch thật
  assert.deepEqual(data.tkb.L2.thu2.sang, session(["", "Ly"]));
  assert.equal(api.canPlaceLesson({lopId:"L2", mon:"Ly", thu:"thu2", buoi:"sang", ti:1, mode:"drag"}).ok, true);
});

test("các đường thả: thử đổi chỗ trước, không đổi được thì chặn (không đưa về Chưa phân), vẫn giữ hỏi nâng giới hạn buổi", () => {
  const classDropStart = PHANMON_SOURCE.indexOf("td.ondrop = (e)=>", PHANMON_SOURCE.indexOf("function bindCells"));
  const classDrop = PHANMON_SOURCE.slice(classDropStart, PHANMON_SOURCE.indexOf("td.oncontextmenu", classDropStart));
  assert.match(classDrop, /tkbTryDropSwap\(td,\s*currentLop\)\)\s*return;[\s\S]*let res = validateDrop\(td, dragMon\)/);
  assert.match(classDrop, /const blockedNote = tkbSwapBlockedNote\(td, currentLop, res\);\s*if\(blockedNote\)\{[\s\S]*?return;\s*\}[\s\S]*onDrop\(td\)/);
  assert.ok(classDrop.indexOf("blockedNote") < classDrop.indexOf("clearConflictSlots"), "chặn trước khi hỏi thay thế");
  assert.doesNotMatch(PHANMON_SOURCE, /tkbSwapKickNote/);

  const teacherDropStart = PHANMON_SOURCE.indexOf("function pvApplySupportDrop");
  const teacherDrop = PHANMON_SOURCE.slice(teacherDropStart, PHANMON_SOURCE.indexOf("function pvBindTeacherSupportDrag", teacherDropStart));
  assert.match(teacherDrop, /if\(res\.swap\)\{\s*tkbApplyDropSwap\(res\.swap, td\);\s*return;/);
  assert.match(teacherDrop, /pvValidateSupportDrop\(td, \{fresh:true\}\)/);
  assert.match(teacherDrop, /maybeRaiseSessionLimitForDrop\(td,\s*info\.mon,\s*res\)/);

  const validateStart = PHANMON_SOURCE.indexOf("function pvValidateSupportDrop");
  const validate = PHANMON_SOURCE.slice(validateStart, PHANMON_SOURCE.indexOf("function pvApplySupportDrop", validateStart));
  assert.match(validate, /info\.type === "cell"[\s\S]*tkbSwapAwareResult\(res, info\.classId/);
  assert.match(validate, /swapRes\.msg = tkbSwapBlockedNote\(td, info\.classId, res\)/);
  assert.ok(validate.indexOf("tkbSwapAwareResult") < validate.indexOf("sẽ được đưa về \"Chưa phân\""), "tiết đang có không bao giờ tới cảnh báo đưa về Chưa phân");
});

test("kéo thả không đứng: tô màu theo lát + nhả luồng, rê chuột không tự tính kế hoạch đổi chỗ, làm ấm chỉ dựng chỉ mục", () => {
  const paintStart = PHANMON_SOURCE.indexOf("function paintDropTargets");
  const paint = PHANMON_SOURCE.slice(paintStart, PHANMON_SOURCE.indexOf("function applyDragVisual", paintStart));
  assert.match(paint, /DRAG_PAINT_SLICE_MS/);
  assert.match(paint, /setTimeout\(run, 0\)/);
  assert.match(paint, /if\(res && res\.swapDeferred\) queue\.push\(item\)/);
  assert.doesNotMatch(paint, /requestAnimationFrame/, "rAF không chạy khi tab nền và dồn cả bảng vào một khung");

  const classOver = PHANMON_SOURCE.slice(PHANMON_SOURCE.indexOf("td.ondragover = (e)=>", PHANMON_SOURCE.indexOf("function bindCells")), PHANMON_SOURCE.indexOf("td.ondragenter", PHANMON_SOURCE.indexOf("function bindCells")));
  assert.match(classOver, /tkbMainDropResult\(td, dragMon, \{deadline: Date\.now\(\) - 1\}\)/);
  assert.doesNotMatch(classOver, /swapDeferred/);

  const pvBind = PHANMON_SOURCE.slice(PHANMON_SOURCE.indexOf("function pvBindTeacherSupportDrag"));
  const pvOver = pvBind.slice(pvBind.indexOf("td.ondragover"), pvBind.indexOf("td.ondragenter"));
  assert.match(pvOver, /pvValidateSupportDrop\(td, \{deadline: Date\.now\(\) - 1\}\)/);

  const block = PHANMON_SOURCE.slice(PHANMON_SOURCE.indexOf("function tkbSwapInvalidateRules"), PHANMON_SOURCE.indexOf("function tkbSwapWarmCtx"));
  assert.match(block, /teacherCellsAfterPlace/);
  assert.doesNotMatch(block, /full:true/);
});

test("hết giờ lát tô màu thì kế hoạch đổi chỗ được hoãn (không tính đồng bộ)", () => {
  const data = {
    tkb:{L1:week({thu2:{sang:["Toan", "Anh", "Van"]}})},
    pccmMatrix:{"L1|Toan":"GV1", "L1|Anh":"GV2", "L1|Van":"GV3"}
  };
  const {context} = loadPlanner(data);
  startDrag(context, "L1", "thu2", "sang", 0);
  const deferred = context.tkbMainDropResult(cell("thu2", "sang", 2), "Toan", {deadline: Date.now() - 1});
  assert.equal(deferred.ok, false);
  assert.equal(deferred.swapDeferred, true);
  const computed = context.tkbMainDropResult(cell("thu2", "sang", 2), "Toan", {deadline: Date.now() + 1000});
  assert.equal(computed.ok, true);
  assert.ok(computed.swap);
});

test("lượt 7: làm tươi chỉ mục luật theo lớp = dựng lại cả trường; chưa có chỉ mục thì báo false", () => {
  const data = {
    lop:[{id:"L1", ten:"L1"}, {id:"L2", ten:"L2"}, {id:"L3", ten:"L3"}],
    monhoc:[{id:"Toan", ma:"Toan", ten:"Toan"}, {id:"Ly", ma:"Ly", ten:"Ly"}, {id:"Anh", ma:"Anh", ten:"Anh"}],
    mon:[],
    tkb:{
      L1:week({thu2:{sang:["Toan", "Anh", ""]}, thu3:{chieu:["Toan"]}}),
      L2:week({thu2:{sang:["Ly", "", "Toan"]}}),
      L3:week({thu3:{sang:["Anh", "Ly"]}})
    },
    pccmMatrix:{"L1|Toan":"GV1", "L1|Anh":"GV2", "L2|Ly":"GV1", "L2|Toan":"GV3", "L3|Anh":"GV2", "L3|Ly":"GV1, GV3"},
    tkbConstraints:{teacher:{GV1:{maxPeriods:{sang:{thu2:3}}}}}
  };
  const api = loadConstraints(data);
  assert.equal(api.refreshScheduleIndexClasses(["L1"]), false, "chưa dựng chỉ mục");
  const cellsOf = () => JSON.stringify(["GV1", "GV2", "GV3"].map(gv => api.teacherCellsAfterPlace(gv, {})));
  cellsOf();
  // đổi chỗ 2 lớp như một lần thử đổi chỗ khác lớp
  data.tkb.L1.thu2.sang = session(["Anh", "Toan", ""]);
  data.tkb.L2.thu2.sang = session(["", "Ly", "Toan"]);
  assert.equal(api.refreshScheduleIndexClasses(["L1", "L2"]), true);
  const refreshed = cellsOf();
  api.invalidateConstraintCache();
  assert.equal(refreshed, cellsOf());
});

test("lượt 8: ô bảng lớp và bảng GV huỷ cả dragenter (Chrome từ chối thả khi con trỏ đổi phần tử con)", () => {
  const bind = PHANMON_SOURCE.slice(PHANMON_SOURCE.indexOf("function bindCells"));
  const classEnter = bind.slice(bind.indexOf("td.ondragenter"), bind.indexOf("td.ondrop"));
  assert.match(classEnter, /td\.ondragenter = \(e\)=>\{[\s\S]*?e\.preventDefault\(\)[\s\S]*?classList\.add\("drag-over"\)/);
  assert.match(classEnter, /td\.ondragleave = \(e\)=>\{[\s\S]*?if\(e && e\.relatedTarget && td\.contains\(e\.relatedTarget\)\) return;[\s\S]*?releaseDragOver\(td\)/);
  const pvBind = PHANMON_SOURCE.slice(PHANMON_SOURCE.indexOf("function pvBindTeacherSupportDrag"));
  const pvEnter = pvBind.slice(pvBind.indexOf("td.ondragenter"), pvBind.indexOf("td.ondrop"));
  assert.match(pvEnter, /td\.ondragenter = \(e\)=>\{[\s\S]*?e\.preventDefault\(\)[\s\S]*?classList\.add\("drag-over"\)/);
  assert.match(pvEnter, /td\.contains\(e\.relatedTarget\)/);
});

test("lượt 9: kéo thả bằng cảm ứng (điện thoại) phát lại đúng chuỗi sự kiện kéo lên ô, chặn chuột phải khi giữ ngón tay", () => {
  const start = PHANMON_SOURCE.indexOf("/* ======================= KÉO THẢ BẰNG CẢM ỨNG");
  const end = PHANMON_SOURCE.indexOf("/* ======================= HẾT KÉO THẢ BẰNG CẢM ỨNG", start);
  assert.ok(start > 0 && end > start, "có khối kéo thả cảm ứng");
  const block = PHANMON_SOURCE.slice(start, end);
  for(const type of ["dragstart", "dragenter", "dragover", "dragleave", "drop", "dragend"]){
    assert.ok(block.includes(`"${type}"`), `phát ${type}`);
  }
  assert.ok(block.includes('document.addEventListener("touchmove", tkbTouchDragOnMove, {passive:false, capture:true})'), "touchmove không passive để chặn cuộn khi đang kéo");
  assert.ok(block.includes('window.addEventListener("contextmenu"'), "giữ ngón tay không thành chuột phải đưa tiết về Chưa phân");
  assert.ok(block.includes("TKB_TOUCH_DRAG_HOLD_MS = 300"));
  assert.ok(block.includes('if(target && allowed) tkbTouchDragFire(target, "drop")'), "chỉ thả khi dragover được nhận");
});
