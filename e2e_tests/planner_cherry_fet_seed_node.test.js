"use strict";

// 30/10: nut Cherry XEP MOI tren bo giai may nay (ban khong dang nhap / Cherry.exe) dung lich nhap
// bang FET trong trinh duyet (ban V3 day du luat Yeu cau) roi gui cho Cherry nhu lich nguoi dung ->
// engine bo vong 1 dung lich, vao thang toi uu. Kiem: chi bat khi xep moi + Cherry + may nay;
// chi nhan nhap DU tiet va 0 vi pham RB; con lai gui lich trong nhu cu.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const BRIDGE_PATH = path.resolve(__dirname, "..", "web", "pages", "tkb-rust-bridge.js");
const BRIDGE_SOURCE = fs.readFileSync(BRIDGE_PATH, "utf8");
const DAYS = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];

function memoryStorage(initial = {}){
  const values = new Map(Object.entries(initial));
  return {
    getItem(key){ return values.has(String(key)) ? values.get(String(key)) : null; },
    setItem(key, value){ values.set(String(key), String(value)); },
    removeItem(key){ values.delete(String(key)); },
    clear(){ values.clear(); }
  };
}

function emptyGrid(){
  const grid = {};
  DAYS.forEach(d => { grid[d] = {sang:["", "", "", "", ""], chieu:["", "", "", "", ""]}; });
  return grid;
}

function schoolData(){
  return {
    lop:[{id:"L1", ten:"6A1", khoi:"6"}, {id:"L2", ten:"6A2", khoi:"6"}],
    mon:[], monhoc:[], giaovien:[],
    pccmMatrix:{"L1|TOAN":"GV1", "L2|TOAN":"GV2", "L1|VAN":"GV3", "L2|VAN":"GV3"},
    pccmTietMatrix:{"L1|TOAN":30, "L2|TOAN":30, "L1|VAN":20, "L2|VAN":20},
    tkb:{L1:emptyGrid(), L2:emptyGrid()},
    tkbConstraints:{}
  };
}

function makeWorkerClass(script, created){
  return class FakeWorker{
    constructor(url){
      this.url = url;
      this.terminated = false;
      created.push(this);
    }
    postMessage(message){
      this.message = message;
      setTimeout(() => {
        for(const reply of script(message)){
          if(this.terminated) return;
          this.onmessage && this.onmessage({data:reply});
        }
      }, 0);
    }
    terminate(){ this.terminated = true; }
  };
}

function loadBridge({noServer = true, data = schoolData(), workerScript, inspect, storage, userAgent} = {}){
  const created = [];
  const window = {
    DATA:data,
    __TKB_E2E_EXPOSE_TEST_HOOKS:true,
    __TKB_FORCE_ENGINE:"cherry",
    TKBBrowserWasmExecutor:{isEnabled(){ return false; }},
    TKBAuth:noServer ? {isLocal:true, noServer:true} : undefined,
    document:{
      addEventListener(){}, getElementById(){ return null; }, querySelector(){ return null; },
      querySelectorAll(){ return []; }, createElement(){ return {setAttribute(){}, appendChild(){}, classList:{add(){}}}; },
      head:{appendChild(){}}, documentElement:{appendChild(){}}, body:{appendChild(){}}
    },
    localStorage:storage || memoryStorage(),
    sessionStorage:memoryStorage(),
    navigator:{hardwareConcurrency:8, userAgent:userAgent || "Mozilla/5.0 (Windows NT 10.0) Chrome/142"},
    location:{protocol:"https:", hostname:"tkbcherry.netlify.app", origin:"https://tkbcherry.netlify.app",
      href:"https://tkbcherry.netlify.app/pages/sapxep.html", pathname:"/pages/sapxep.html", search:""},
    setTimeout, clearTimeout,
    setInterval:() => 0, clearInterval(){},
    requestAnimationFrame(cb){ return setTimeout(cb, 0); },
    addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return true; },
    matchMedia:() => ({matches:false}),
    confirm:() => true, alert(){}, _setStatus(){},
    Worker:workerScript ? makeWorkerClass(workerScript, created) : undefined,
    inspectFetCandidateHardConstraints:inspect || (async () => ({available:true, violations:[]})),
    console
  };
  window.window = window;
  const context = vm.createContext({
    window, document:window.document, localStorage:window.localStorage, sessionStorage:window.sessionStorage,
    navigator:window.navigator, location:window.location, console, URLSearchParams, AbortController,
    Date, Math, setTimeout, clearTimeout, setInterval:window.setInterval, clearInterval:window.clearInterval,
    fetch:async () => { throw new Error("no network in this test"); },
    DAYS, SANG:5, CHIEU:5
  });
  vm.runInContext(BRIDGE_SOURCE, context, {filename:BRIDGE_PATH});
  const hooks = window.__TKB_RUST_BRIDGE_TEST_HOOKS;
  assert.ok(hooks && typeof hooks.cherryFetSeedEligible === "function", "test hooks must expose the FET seed helpers");
  return {window, hooks, created, data};
}

const okWorker = message => [
  {type:"progress", placed:40, total:100},
  {type:"done", ok:true, tkb:{L1:{thu2:{sang:["TOAN"]}}, L2:{thu2:{sang:["VAN"]}}}, placed:100, unassigned:0}
];
const settings = () => ({overall_time_limit_seconds:120, optimization_focus:"automatic"});

test("xếp mới bằng Cherry trên máy này: được dựng nháp FET", () => {
  const {hooks, data} = loadBridge({workerScript:okWorker});
  assert.equal(hooks.cherryFetSeedEligible(data, data, settings()), true);
});

test("lịch đã có tiết (bấm lại để tối ưu tiếp): KHÔNG dựng nháp", () => {
  const {hooks, data} = loadBridge({workerScript:okWorker});
  data.tkb.L1.thu2.sang = ["TOAN", "TOAN", "VAN", "VAN", "TOAN"];
  data.tkb.L2.thu2.sang = ["VAN", "TOAN", "TOAN", "VAN", "VAN"];
  assert.equal(hooks.cherryFetSeedEligible(data, data, settings()), false);
});

test("ô cố định / tiết ghép ghim tạm không tính là lịch đã xếp", () => {
  const {hooks, data} = loadBridge({workerScript:okWorker});
  data.tkb.L1.thu2.sang = [{mon:"Chào cờ", fixed:true}, {mon:"KNS (ghép)", fixed:true, jointPin:true}, "", "", ""];
  data.tkb.L2.thu2.sang = [{mon:"Chào cờ", fixed:true}, {mon:"KNS (ghép)", fixed:true, jointPin:true}, "OFF", "", ""];
  assert.equal(hooks.cherryFetSeedEligible(data, data, settings()), true);
});

test("tkbcherry.com: Agent BẬT (Cherry.exe) thì dựng nháp FET như bản Netlify", () => {
  const agent = loadBridge({noServer:false, workerScript:okWorker});
  assert.equal(agent.hooks.cherryFetSeedEligible(agent.data, agent.data, settings()), true);
});

test("không dựng nháp: xếp trên máy chủ (Agent tắt / máy Mac), mục Tối ưu riêng, nút khác Cherry, hoặc tắt bằng cờ", () => {
  const server = loadBridge({noServer:false, workerScript:okWorker, storage:memoryStorage({TKB_AGENT_MODE_V1:"off"})});
  assert.equal(server.hooks.cherryFetSeedEligible(server.data, server.data, settings()), false, "Agent tắt: máy chủ tự dựng");
  const mac = loadBridge({noServer:false, workerScript:okWorker, userAgent:"Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/142"});
  assert.equal(mac.hooks.cherryFetSeedEligible(mac.data, mac.data, settings()), false, "Mac luôn xếp trên máy chủ");

  const focus = loadBridge({workerScript:okWorker});
  assert.equal(focus.hooks.cherryFetSeedEligible(focus.data, focus.data, {overall_time_limit_seconds:120, optimization_focus:"singletons"}), false);
  focus.window.__TKB_ENGINE_FOCUS_MODE = "gap1";
  assert.equal(focus.hooks.cherryFetSeedEligible(focus.data, focus.data, settings()), false);

  const other = loadBridge({workerScript:okWorker});
  other.window.__TKB_FORCE_ENGINE = "";
  assert.equal(other.hooks.cherryFetSeedEligible(other.data, other.data, settings()), false);

  const off = loadBridge({workerScript:okWorker});
  off.window.__TKB_CHERRY_FET_SEED = false;
  assert.equal(off.hooks.cherryFetSeedEligible(off.data, off.data, settings()), false);

  const noWorker = loadBridge({});
  assert.equal(noWorker.hooks.cherryFetSeedEligible(noWorker.data, noWorker.data, settings()), false);
});

test("nháp ĐỦ tiết + 0 vi phạm: trả lưới FET, worker chạy chế độ dựng lịch rồi bị đóng", async () => {
  const {hooks, data, created} = loadBridge({workerScript:okWorker});
  const seed = await hooks.buildCherryFetSeed(data, data, settings(), null);
  assert.ok(seed, "phải nhận nháp");
  assert.equal(seed.placed, 100);
  assert.deepEqual(JSON.parse(JSON.stringify(seed.tkb.L1.thu2.sang)), ["TOAN"]);
  assert.ok(seed.elapsedMs >= 0);
  assert.equal(created.length, 1);
  assert.equal(created[0].message.action, "solve", "chỉ dựng lịch, không tối ưu bằng FET");
  assert.ok(created[0].message.options.solveBudgetMs >= 10_000 && created[0].message.options.solveBudgetMs <= 25_000);
  assert.notEqual(created[0].message.data, data, "gửi bản sao, không đưa DATA đang hiển thị cho worker");
  assert.equal(created[0].terminated, true);
});

test("ô cố định / tiết ghép ghim tạm giữ NGUYÊN dạng trong nháp (FET V3 ghi lại thành chữ thường)", async () => {
  const pin = {mon:"KNS (ghép)", fixed:true, jointPin:true};
  const {hooks, data} = loadBridge({workerScript:() => [{
    type:"done", ok:true, placed:100, unassigned:0,
    tkb:{
      L1:{thu2:{sang:["KNS (ghép)", "TOAN", "", "", ""], chieu:["", "", "", "", ""]}},
      L2:{thu2:{sang:["KNS (ghép)", "VAN", "", "", ""], chieu:["", "", "", "", ""]}}
    }
  }]});
  data.tkb.L1.thu2.sang[0] = Object.assign({}, pin);
  data.tkb.L2.thu2.sang[0] = Object.assign({}, pin);
  const seed = await hooks.buildCherryFetSeed(data, data, settings(), null);
  assert.ok(seed);
  assert.equal(seed.restoredFixed, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(seed.tkb.L1.thu2.sang[0])), pin);
  assert.deepEqual(JSON.parse(JSON.stringify(seed.tkb.L2.thu2.sang[0])), pin);
  assert.equal(seed.tkb.L1.thu2.sang[1], "TOAN", "tiết FET xếp giữ nguyên");
});

test("nháp thiếu <= 1% tiết vẫn nhận (Cherry xếp nốt); thiếu nhiều hơn hoặc còn vi phạm RB: bỏ", async () => {
  const almost = loadBridge({workerScript:() => [{type:"done", ok:true, tkb:{L1:{}}, placed:2190, unassigned:3}]});
  const seed = await almost.hooks.buildCherryFetSeed(almost.data, almost.data, settings(), null);
  assert.ok(seed, "Tân Phú Trung 2190/2193: nhận nháp");
  assert.equal(seed.missing, 3);

  const short = loadBridge({workerScript:() => [{type:"done", ok:true, tkb:{}, placed:90, unassigned:10}]});
  assert.equal(await short.hooks.buildCherryFetSeed(short.data, short.data, settings(), null), null);

  const dirty = loadBridge({
    workerScript:okWorker,
    inspect:async () => ({available:true, violations:[{message:"GV dạy 2 địa điểm trong buổi"}]})
  });
  assert.equal(await dirty.hooks.buildCherryFetSeed(dirty.data, dirty.data, settings(), null), null);

  const failed = loadBridge({workerScript:() => [{type:"error", error:"boom"}]});
  assert.equal(await failed.hooks.buildCherryFetSeed(failed.data, failed.data, settings(), null), null);
});

test("bấm Dừng khi đang dựng nháp: đóng worker, không trả nháp", async () => {
  const {hooks, data, created} = loadBridge({workerScript:() => []});
  const controller = new AbortController();
  const pending = hooks.buildCherryFetSeed(data, data, settings(), controller.signal);
  setTimeout(() => controller.abort(), 5);
  assert.equal(await pending, null);
  assert.equal(created[0].terminated, true);
});
