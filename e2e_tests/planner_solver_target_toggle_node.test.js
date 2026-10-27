"use strict";

// 27/10: nut gat "May chu / May nay" (tkb-rust-bridge.js): "May nay" gui moi luot giai
// toi bo giai tren chinh may (tools/local-solver, http://127.0.0.1:2210), du lieu van
// luu tren may chu. Kiem: chon dung noi giai, khong gui the dang nhap sang may local,
// bao ro khi chua mo bo giai local, nut duoc gan canh nut Cherry, dien thoai luon may chu.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const BRIDGE_PATH = path.resolve(__dirname, "..", "web", "pages", "tkb-rust-bridge.js");
const BRIDGE_SOURCE = fs.readFileSync(BRIDGE_PATH, "utf8");
const PLANNER_HTML = fs.readFileSync(path.resolve(__dirname, "..", "web", "pages", "sapxep.html"), "utf8");
const LOCAL = "http://127.0.0.1:2211";
const SITE = "https://tkbcherry.com";

function memoryStorage(initial = {}){
  const values = new Map(Object.entries(initial));
  return {
    getItem(key){ return values.has(String(key)) ? values.get(String(key)) : null; },
    setItem(key, value){ values.set(String(key), String(value)); },
    removeItem(key){ values.delete(String(key)); },
    clear(){ values.clear(); }
  };
}

function makeNode(id){
  const listeners = {};
  return {
    id,
    dataset:{},
    attributes:{},
    textContent:"",
    title:"",
    classList:{add(){}, remove(){}, toggle(){}, contains(){ return false; }},
    setAttribute(name, value){ this.attributes[name] = String(value); },
    getAttribute(name){ return this.attributes[name]; },
    removeAttribute(name){ delete this.attributes[name]; },
    addEventListener(type, fn){ listeners[type] = fn; },
    click(){ return listeners.click && listeners.click(); },
    appendChild(child){ return child; },
    remove(){}
  };
}

function makeDocument(){
  const nodes = new Map();
  const cherry = makeNode("btnEngineCherry");
  const inserted = [];
  cherry.insertAdjacentElement = (where, el) => { inserted.push({where, el}); nodes.set(el.id, el); return el; };
  nodes.set("btnEngineCherry", cherry);
  const head = {appendChild(child){ if(child.id) nodes.set(child.id, child); return child; }};
  const frames = [];
  return {
    inserted,
    frames,
    getElementById(id){ return nodes.get(String(id)) || null; },
    querySelector(){ return null; },
    querySelectorAll(){ return []; },
    createElement(){ return makeNode(""); },
    head,
    documentElement:{appendChild(child){ return child; }},
    body:{appendChild(child){ frames.push(child); return child; }}
  };
}

function loadBridge({storage, fetchImpl, navigator, authHeaders} = {}){
  const localStorage = storage || memoryStorage();
  const document = makeDocument();
  const statuses = [];
  const window = {
    DATA:{lop:[], mon:[], monhoc:[], giaovien:[], pccmMatrix:{}, tkb:{}, tkbConstraints:{}},
    __TKB_E2E_EXPOSE_TEST_HOOKS:true,
    TKBBrowserWasmExecutor:{isEnabled(){ return false; }},
    TKBAuthApi: authHeaders ? {getAuthHeaders(extra){ return Object.assign({}, authHeaders, extra || {}); }} : undefined,
    document,
    localStorage,
    sessionStorage:memoryStorage(),
    navigator:Object.assign({hardwareConcurrency:8, userAgent:"Mozilla/5.0 (Windows NT 10.0) Chrome/142"}, navigator || {}),
    location:{protocol:"https:", hostname:"tkbcherry.com", origin:SITE, href:`${SITE}/pages/sapxep.html`, pathname:"/pages/sapxep.html", search:""},
    setTimeout, clearTimeout,
    setInterval:() => 0, clearInterval(){},
    requestAnimationFrame(cb){ return setTimeout(cb, 0); },
    addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return true; },
    matchMedia:() => ({matches:false}),
    confirm:() => true,
    alert(){},
    _setStatus(msg, type){ statuses.push({msg, type}); },
    console
  };
  window.window = window;
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({url:String(url), init:init || {}});
    return fetchImpl(String(url), init || {});
  };
  const context = vm.createContext({
    window, document, localStorage, sessionStorage:window.sessionStorage,
    navigator:window.navigator, location:window.location, console, URLSearchParams, AbortController,
    Date, Math, setTimeout, clearTimeout, setInterval:window.setInterval, clearInterval:window.clearInterval,
    fetch, DAYS:["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"], SANG:5, CHIEU:5
  });
  vm.runInContext(BRIDGE_SOURCE, context, {filename:BRIDGE_PATH});
  const hooks = window.__TKB_RUST_BRIDGE_TEST_HOOKS;
  assert.ok(hooks, "bridge test hooks must be exposed");
  return {window, hooks, calls, document, statuses};
}

function health(url){
  if(url.endsWith("/api/health")){
    return {ok:true, status:200, json:async () => ({ok:true, api:"rust"})};
  }
  throw new Error("unexpected " + url);
}

test("mặc định là Máy chủ: dò chính trang web, không gọi 127.0.0.1", async () => {
  const {hooks, calls} = loadBridge({fetchImpl:health});
  assert.equal(hooks.solverTarget(), "server");
  assert.equal(await hooks.rustApiBase(), SITE);
  assert.ok(calls.every(c => !c.url.startsWith(LOCAL)), JSON.stringify(calls.map(c => c.url)));
});

test("Máy này: mọi lượt giải đi tới bộ giải local, không bao giờ rơi về máy chủ", async () => {
  const storage = memoryStorage({TKB_SOLVER_TARGET_V1:"local"});
  const {hooks, calls} = loadBridge({storage, fetchImpl:health});
  assert.equal(hooks.solverTarget(), "local");
  assert.equal(await hooks.rustApiBase(), LOCAL);
  assert.ok(calls.length >= 1);
  assert.ok(calls.every(c => c.url === `${LOCAL}/api/health`), JSON.stringify(calls.map(c => c.url)));
});

test("Máy này nhưng chưa mở bộ giải: trả rỗng + thông báo hướng dẫn, không dùng máy chủ", async () => {
  const storage = memoryStorage({TKB_SOLVER_TARGET_V1:"local"});
  const {hooks, calls, window} = loadBridge({
    storage,
    fetchImpl:async url => { if(url.startsWith(LOCAL)) throw new TypeError("Failed to fetch"); return health(url); }
  });
  assert.equal(await hooks.rustApiBase(), "");
  assert.equal(window.__TKB_LOCAL_SOLVER_ONLINE, false);
  assert.ok(calls.every(c => !c.url.startsWith(SITE)), "không được tự gửi lượt giải lên máy chủ");
  assert.match(hooks.noSolverBackendMessage(), /CherrySetup\.exe/);
  assert.match(hooks.noSolverBackendMessage(), /127\.0\.0\.1:2211/);
});

test("Máy này: không gửi thẻ đăng nhập sang bộ giải local; Máy chủ vẫn gửi", () => {
  const storage = memoryStorage();
  const {hooks} = loadBridge({storage, fetchImpl:health, authHeaders:{Authorization:"Bearer secret-token"}});
  assert.equal(hooks.solverRequestHeaders({"Content-Type":"application/json"}).Authorization, "Bearer secret-token");
  hooks.setSolverTarget("local");
  const localHeaders = hooks.solverRequestHeaders({"Content-Type":"application/json"});
  assert.equal(localHeaders.Authorization, undefined);
  assert.equal(localHeaders["Content-Type"], "application/json");
});

test("địa chỉ local chỉ nhận loopback (không gửi dữ liệu trường sang máy khác)", async () => {
  const storage = memoryStorage({TKB_SOLVER_TARGET_V1:"local", TKB_LOCAL_SOLVER_ORIGIN_V1:"http://evil.example.com:2210"});
  const {hooks, calls} = loadBridge({storage, fetchImpl:health});
  assert.equal(await hooks.rustApiBase(), LOCAL);
  assert.ok(calls.every(c => c.url.startsWith(LOCAL)));
  storage.setItem("TKB_LOCAL_SOLVER_ORIGIN_V1", "http://127.0.0.1:2300/");
  assert.equal(await hooks.rustApiBase(), "http://127.0.0.1:2300");
});

test("điện thoại luôn giải trên Máy chủ dù trình duyệt lưu 'Máy này'", async () => {
  const storage = memoryStorage({TKB_SOLVER_TARGET_V1:"local"});
  const {hooks} = loadBridge({storage, fetchImpl:health, navigator:{userAgent:"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Mobile Safari", maxTouchPoints:5}});
  assert.equal(hooks.solverTarget(), "server");
  assert.equal(await hooks.rustApiBase(), SITE);
});

test("nút gạt gắn ngay sau nút Cherry, đổi nhãn và nhớ lựa chọn", async () => {
  const storage = memoryStorage();
  const {hooks, document, statuses} = loadBridge({storage, fetchImpl:health});
  hooks.initSolverTargetUi();
  assert.equal(document.inserted.length, 1);
  assert.equal(document.inserted[0].where, "afterend");
  const btn = document.getElementById("btnSolverTarget");
  assert.ok(btn);
  assert.equal(btn.textContent, "Máy chủ");
  assert.equal(btn.dataset.target, "server");
  await btn.click();
  assert.equal(storage.getItem("TKB_SOLVER_TARGET_V1"), "local");
  assert.equal(btn.textContent, "Máy này");
  assert.equal(btn.dataset.target, "local");
  assert.equal(statuses.at(-1).type, "success");
  await btn.click();
  assert.equal(storage.getItem("TKB_SOLVER_TARGET_V1"), "server");
  assert.equal(btn.textContent, "Máy chủ");
  hooks.initSolverTargetUi();
  assert.equal(document.inserted.length, 1, "không gắn nút hai lần");
});

test("đang xếp lịch thì không cho đổi nơi giải", async () => {
  const storage = memoryStorage();
  const {hooks, document, window, statuses} = loadBridge({storage, fetchImpl:health});
  hooks.initSolverTargetUi();
  window.__TKB_RUST_SOLVER_RUNNING = true;
  await document.getElementById("btnSolverTarget").click();
  assert.equal(hooks.solverTarget(), "server");
  assert.equal(statuses.at(-1).type, "warning");
});

test("sapxep.html nạp bridge bản mới (?v) để trình duyệt không giữ bản cũ", () => {
  assert.match(PLANNER_HTML, /tkb-rust-bridge\.js\?v=20261027-solver-target-toggle-v1/);
});

test("bộ giải đang tắt: chỉ thao tác của người dùng mới đánh thức qua cherry-local://", async () => {
  const storage = memoryStorage({TKB_SOLVER_TARGET_V1:"local"});
  let online = false;
  const {hooks, document, window} = loadBridge({
    storage,
    fetchImpl:async url => {
      if(url.startsWith(LOCAL) && !online) throw new TypeError("Failed to fetch");
      return health(url);
    }
  });
  // vong kiem tra banner / goi thuong: KHONG mo ung dung ngoai
  assert.equal(await hooks.rustApiBase(), "");
  assert.equal(document.frames.length, 0);
  // bam Cherry / gat nut: mo cherry-local://start roi cho bo giai len
  const pending = hooks.rustApiBase({wakeLocal:true});
  await new Promise(r => setTimeout(r, 50));
  assert.equal(document.frames.length, 1);
  assert.equal(document.frames[0].src, "cherry-local://start");
  online = true;
  assert.equal(await pending, LOCAL);
  assert.equal(window.__TKB_LOCAL_SOLVER_ONLINE, true);
});
