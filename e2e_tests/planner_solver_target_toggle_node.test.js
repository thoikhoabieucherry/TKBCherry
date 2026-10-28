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

function registerTree(nodes, node){
  if(node && node.id) nodes.set(node.id, node);
  for(const child of (node && node.children) || []) registerTree(nodes, child);
}

function makeNode(id, nodes, tag = ""){
  const listeners = {};
  return {
    id,
    tagName:String(tag).toUpperCase(),
    hidden:false,
    children:[],
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
    appendChild(child){ this.children.push(child); if(nodes) registerTree(nodes, child); return child; },
    remove(){}
  };
}

function makeDocument(){
  const nodes = new Map();
  const cherry = makeNode("btnEngineCherry", nodes, "button");
  const inserted = [];
  cherry.insertAdjacentElement = (where, el) => { inserted.push({where, el}); nodes.set(el.id, el); return el; };
  nodes.set("btnEngineCherry", cherry);
  const head = {appendChild(child){ if(child.id) nodes.set(child.id, child); return child; }};
  const frames = [];
  const docListeners = [];
  return {
    inserted,
    frames,
    docListeners,
    addEventListener(type, fn, capture){ docListeners.push({type, fn, capture}); },
    getElementById(id){ return nodes.get(String(id)) || null; },
    querySelector(){ return null; },
    querySelectorAll(){ return []; },
    createElement(tag){ return makeNode("", nodes, tag); },
    head,
    documentElement:{appendChild(child){ return child; }},
    body:{appendChild(child){ frames.push(child); registerTree(nodes, child); return child; }}
  };
}

function loadBridge({storage, fetchImpl, navigator, authHeaders, noServer} = {}){
  const localStorage = storage || memoryStorage();
  const document = makeDocument();
  const statuses = [];
  const window = {
    DATA:{lop:[], mon:[], monhoc:[], giaovien:[], pccmMatrix:{}, tkb:{}, tkbConstraints:{}},
    __TKB_E2E_EXPOSE_TEST_HOOKS:true,
    TKBBrowserWasmExecutor:{isEnabled(){ return false; }},
    TKBAuth: noServer ? {isLocal:true, noServer:true} : undefined,
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

test("bản web không đăng nhập (Netlify): chỉ một nút Cherry + chấm trạng thái, luôn giải ở máy này", async () => {
  const storage = memoryStorage({TKB_SOLVER_TARGET_V1:"server"});
  const {hooks, document, calls} = loadBridge({
    storage,
    noServer:true,
    fetchImpl:async url => {
      if(url.startsWith(LOCAL)) throw new TypeError("Failed to fetch");
      return health(url);
    }
  });
  assert.equal(hooks.solverTarget(), "local", "trang không có máy chủ thì bỏ qua lựa chọn Máy chủ đã lưu");
  assert.match(hooks.noSolverBackendMessage(), /CherrySetup\.exe/);
  assert.doesNotMatch(hooks.noSolverBackendMessage(), /nút ▶/, "máy Windows không mời xếp trên trình duyệt");
  hooks.initSolverTargetUi();
  assert.equal(document.getElementById("btnSolverTarget"), null, "không còn viên Máy chủ / Máy này");
  assert.equal(document.inserted.length, 0);
  await new Promise(r => setTimeout(r, 20));
  const dot = document.getElementById("tkbCherryLocalDot");
  assert.ok(dot, "chấm trạng thái gắn trên nút Cherry");
  assert.equal(dot.dataset.state, "offline");
  assert.ok(calls.every(c => !c.url.startsWith(SITE)), "không gọi máy chủ");
});

test("bản không đăng nhập: chưa có bộ giải -> hộp tải CherrySetup.exe, cài xong tự báo sẵn sàng", async () => {
  let online = false;
  const {hooks, document, statuses} = loadBridge({
    noServer:true,
    fetchImpl:async url => {
      if(url.startsWith(LOCAL) && !online) throw new TypeError("Failed to fetch");
      return health(url);
    }
  });
  const modal = hooks.showLocalSolverDialog();
  assert.ok(modal && modal.hidden === false);
  const link = document.getElementById("tkbLocalSolverDownload");
  assert.equal(link.href, "/download/CherrySetup.exe");
  assert.equal(link.getAttribute("download"), "CherrySetup.exe");
  link.click();
  assert.match(document.getElementById("tkbLocalSolverInstallStatus").textContent, /Đang chờ cài đặt/);
  online = true;  // người dùng vừa cài xong
  await new Promise(r => setTimeout(r, 3400));
  assert.match(document.getElementById("tkbLocalSolverInstallStatus").textContent, /Đã sẵn sàng/);
  assert.equal(document.getElementById("tkbCherryLocalDot").dataset.state, "online");
  assert.equal(statuses.at(-1).type, "success");
  hooks.stopLocalInstallPolling();
});

test("bản không đăng nhập trên máy không phải Windows: không mời tải bộ cài", () => {
  const {hooks, document} = loadBridge({
    noServer:true,
    navigator:{userAgent:"Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari/605"},
    fetchImpl:async () => { throw new TypeError("Failed to fetch"); }
  });
  hooks.showLocalSolverDialog();
  assert.equal(document.getElementById("tkbLocalSolverDownload"), null);
  assert.equal(document.getElementById("tkbLocalSolverBrowser"), null, "không còn nút chọn xếp trên trình duyệt");
  assert.match(hooks.noSolverBackendMessage(), /xếp ngay trên trình duyệt/);
  hooks.stopLocalInstallPolling();
});

test("bản không đăng nhập: tự bật không lên với máy từng có bộ giải -> hộp Thử bật lại, bật xong tự chạy Cherry", async () => {
  const storage = memoryStorage({TKB_LOCAL_SOLVER_SEEN_V1:"1793000000000"});
  let online = false;
  const {hooks, document, window} = loadBridge({
    storage,
    noServer:true,
    fetchImpl:async url => {
      if(url.startsWith(LOCAL) && !online) throw new TypeError("Failed to fetch");
      return health(url);
    }
  });
  const runs = [];
  window.tkbRunEngine = (...args) => runs.push(args);
  const modal = hooks.showLocalSolverDialog();
  assert.equal(modal.dataset.mode, "failed");
  const title = modal.children[0].children.find(n => n.tagName === "H3").textContent;
  assert.doesNotMatch(title, /từng có/, "dấu “từng thấy” không chứng minh máy đã cài");
  const dl = document.getElementById("tkbLocalSolverDownload");
  assert.equal(dl.textContent, "Tải về CherrySetup.exe");
  assert.equal(dl.className, "lsi-primary", "Tải về là nút chính khi bật không được");
  const on = document.getElementById("tkbLocalSolverTurnOn");
  assert.equal(on.textContent, "Thử bật lại");
  const pending = on.click();
  await new Promise(r => setTimeout(r, 50));
  assert.equal(document.frames.filter(f => f.src === "cherry-local://start").length, 1, "bấm Thử bật lại thì gọi mở bộ giải");
  online = true;
  await pending;
  await new Promise(r => setTimeout(r, 900));
  assert.equal(modal.hidden, true);
  assert.equal(runs.length, 1);
  assert.equal(runs[0][0], "cherry");
  assert.equal(document.getElementById("tkbCherryLocalDot").dataset.state, "online");
  hooks.stopLocalInstallPolling();
});

test("bản không đăng nhập: chưa từng thấy bộ giải -> hộp cài hiện NGAY, không đánh thức trước", () => {
  const {hooks, document} = loadBridge({noServer:true, fetchImpl:async () => { throw new TypeError("Failed to fetch"); }});
  const modal = hooks.showLocalSolverDialog();
  assert.equal(modal.dataset.mode, "missing");
  assert.equal(document.frames.filter(f => f.src === "cherry-local://start").length, 0);
  assert.equal(document.getElementById("tkbLocalSolverDownload").textContent, "Tải về CherrySetup.exe");
  assert.equal(document.getElementById("tkbLocalSolverTurnOn"), null, "không còn bắt người dùng tự bật");
  assert.equal(document.getElementById("tkbLocalSolverBrowser"), null, "máy Windows không mời xếp trên trình duyệt");
  hooks.stopLocalInstallPolling();
});

test("bấm Cherry khi bộ giải chưa chạy: gọi mở theo đường dẫn cài (cherry-local://) ngay trong cú bấm; đang chạy thì không", () => {
  const {hooks, document, window} = loadBridge({noServer:true, fetchImpl:async () => { throw new TypeError("Failed to fetch"); }});
  window.__TKB_LOCAL_SOLVER_ONLINE = false;
  hooks.launchLocalSolverOnGesture();
  assert.equal(document.frames.filter(f => f.src === "cherry-local://start").length, 1);
  assert.equal(document.getElementById("tkbLocalSolverInstall").dataset.mode, "missing", "chưa từng thấy bộ giải: hộp cài hiện ngay");
  hooks.stopLocalInstallPolling();
  window.__TKB_LOCAL_SOLVER_ONLINE = true;
  hooks.launchLocalSolverOnGesture();
  assert.equal(document.frames.filter(f => f.src === "cherry-local://start").length, 1, "đang chạy thì không gọi mở");
});

test("sau cú bấm: chờ bộ giải lên rồi xếp tiếp; không lên thì trả rỗng (để hiện hộp cài)", async () => {
  let online = false;
  const {hooks, document, window} = loadBridge({
    noServer:true,
    fetchImpl:async url => {
      if(url.startsWith(LOCAL) && !online) throw new TypeError("Failed to fetch");
      return health(url);
    }
  });
  window.__TKB_LOCAL_SOLVER_START_WAIT_MS = 1500;
  assert.equal(await hooks.awaitLocalSolverStart(), "", "máy chưa cài: hết chờ thì trả rỗng");
  setTimeout(() => { online = true; }, 300);
  assert.equal(await hooks.awaitLocalSolverStart(), LOCAL, "bộ giải lên trong lúc chờ: xếp tiếp");
  assert.equal(document.getElementById("tkbCherryLocalDot").dataset.state, "online");
});

test("hộp cài mở từ cú bấm Cherry: bộ giải lên muộn (vừa bấm Mở / vừa cài) thì tự chạy Cherry", async () => {
  let online = false;
  const {hooks, window} = loadBridge({
    noServer:true,
    fetchImpl:async url => {
      if(url.startsWith(LOCAL) && !online) throw new TypeError("Failed to fetch");
      return health(url);
    }
  });
  const runs = [];
  window.tkbRunEngine = (...args) => runs.push(args);
  hooks.showLocalSolverDialog({runCherryWhenReady:true});
  online = true;
  await new Promise(r => setTimeout(r, 3400));
  assert.equal(runs.length, 1);
  assert.equal(runs[0][0], "cherry");
  hooks.stopLocalInstallPolling();
});

function cherryClick(document){
  const cherry = document.getElementById("btnEngineCherry");
  const event = {
    target:{closest:sel => (sel === "#btnEngineCherry" ? cherry : null)},
    stopped:false,
    prevented:false,
    preventDefault(){ this.prevented = true; },
    stopImmediatePropagation(){ this.stopped = true; },
    stopPropagation(){ this.stopped = true; }
  };
  for(const l of document.docListeners) if(l.type === "click" && l.capture === true) l.fn(event);
  return event;
}

test("chấm cam + máy từng có bộ giải: bấm Cherry KHÔNG vào lượt xếp, hộp “Đang bật…” hiện ngay, bộ giải lên thì tự xếp", async () => {
  const storage = memoryStorage({TKB_LOCAL_SOLVER_SEEN_V1:"1793000000000"});
  let online = false;
  const {hooks, document, window} = loadBridge({
    storage,
    noServer:true,
    fetchImpl:async url => {
      if(url.startsWith(LOCAL) && !online) throw new TypeError("Failed to fetch");
      return health(url);
    }
  });
  const runs = [];
  window.tkbRunEngine = (...args) => runs.push(args);
  hooks.initSolverTargetUi();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(document.getElementById("tkbCherryLocalDot").dataset.state, "offline");
  const event = cherryClick(document);
  assert.equal(event.stopped, true, "onclick của nút Cherry không chạy (không vào lượt xếp)");
  assert.equal(document.frames.filter(f => f.src === "cherry-local://start").length, 1, "gọi mở bộ giải đã cài");
  const modal = document.getElementById("tkbLocalSolverInstall");
  assert.equal(modal.dataset.mode, "starting");
  assert.equal(modal.hidden, false);
  assert.equal(document.getElementById("tkbLocalSolverDownload").textContent, "Chưa cài? Tải về", "đang bật vẫn có đường tải");
  assert.equal(runs.length, 0);
  online = true;
  await new Promise(r => setTimeout(r, 1400));
  assert.equal(runs.length, 1);
  assert.equal(runs[0][0], "cherry");
  assert.equal(modal.hidden, true);
  hooks.stopLocalInstallPolling();
});

test("hộp “Đang bật…” hết giờ chờ mà bộ giải không lên -> đổi sang Thử bật lại / Tải lại", async () => {
  const storage = memoryStorage({TKB_LOCAL_SOLVER_SEEN_V1:"1793000000000"});
  const {hooks, document, window} = loadBridge({storage, noServer:true, fetchImpl:async () => { throw new TypeError("Failed to fetch"); }});
  window.__TKB_LOCAL_SOLVER_START_WAIT_MS = 600;
  window.__TKB_LOCAL_SOLVER_ONLINE = false;
  hooks.launchLocalSolverOnGesture();
  assert.equal(document.getElementById("tkbLocalSolverInstall").dataset.mode, "starting");
  await new Promise(r => setTimeout(r, 1300));
  assert.equal(document.getElementById("tkbLocalSolverInstall").dataset.mode, "failed");
  assert.equal(document.getElementById("tkbLocalSolverTurnOn").textContent, "Thử bật lại");
  hooks.stopLocalInstallPolling();
});

test("Đóng hộp “Đang bật…” = thôi xếp: bộ giải lên sau đó không tự chạy Cherry", async () => {
  const storage = memoryStorage({TKB_LOCAL_SOLVER_SEEN_V1:"1793000000000"});
  let online = false;
  const {hooks, document, window} = loadBridge({
    storage,
    noServer:true,
    fetchImpl:async url => {
      if(url.startsWith(LOCAL) && !online) throw new TypeError("Failed to fetch");
      return health(url);
    }
  });
  const runs = [];
  window.tkbRunEngine = (...args) => runs.push(args);
  window.__TKB_LOCAL_SOLVER_ONLINE = false;
  hooks.launchLocalSolverOnGesture();
  document.getElementById("tkbLocalSolverClose").click();
  online = true;
  await new Promise(r => setTimeout(r, 1400));
  assert.equal(runs.length, 0);
  assert.equal(document.getElementById("tkbCherryLocalDot").dataset.state, "online");
  hooks.stopLocalInstallPolling();
});

test("chấm xanh: bấm Cherry đi thẳng vào lượt xếp, không chặn, không gọi mở", async () => {
  const {hooks, document} = loadBridge({noServer:true, fetchImpl:health});
  hooks.initSolverTargetUi();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(document.getElementById("tkbCherryLocalDot").dataset.state, "online");
  const event = cherryClick(document);
  assert.equal(event.stopped, false);
  assert.equal(document.frames.filter(f => f.src === "cherry-local://start").length, 0);
  assert.equal(document.getElementById("tkbLocalSolverInstall"), null);
});

test("vừa mở trang chưa dò xong: bấm Cherry đợi lần dò, bộ giải đang chạy thì xếp luôn không hiện hộp", async () => {
  const {hooks, document, window} = loadBridge({noServer:true, fetchImpl:health});
  const runs = [];
  window.tkbRunEngine = (...args) => runs.push(args);
  hooks.launchLocalSolverOnGesture();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(runs.length, 1);
  assert.equal(document.getElementById("tkbLocalSolverInstall"), null);
});

function addPlayButton(document){
  const clicks = [];
  const play = {id:"btnAutoSort", children:[], click(){ clicks.push(Date.now()); }};
  document.body.appendChild(play);
  return clicks;
}

for(const [label, userAgent] of [
  ["Mac", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/142 Safari/537.36"],
  ["điện thoại", "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/142 Mobile Safari/537.36"]
]){
  test(`${label}: bấm Cherry xếp ngay trên trình duyệt (như ▶), không hộp, không lựa chọn, không gọi 127.0.0.1`, async () => {
    const {hooks, document, calls} = loadBridge({
      noServer:true,
      navigator:{userAgent},
      fetchImpl:async () => { throw new TypeError("Failed to fetch"); }
    });
    const clicks = addPlayButton(document);
    hooks.initSolverTargetUi();
    await new Promise(r => setTimeout(r, 20));
    assert.equal(document.getElementById("tkbCherryLocalDot").dataset.state, "browser", "ẩn chấm cài đặt");
    const event = cherryClick(document);
    assert.equal(event.stopped, true, "không vào lượt Cherry cần bộ giải");
    assert.equal(clicks.length, 1, "chạy bộ giải trên trình duyệt");
    assert.equal(document.getElementById("tkbLocalSolverInstall"), null, "không hiện hộp");
    assert.equal(document.frames.filter(f => f.src === "cherry-local://start").length, 0);
    assert.ok(calls.every(c => !c.url.startsWith(LOCAL)), "không dò bộ giải trên máy");
  });
}
