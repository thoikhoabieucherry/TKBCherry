const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {TextEncoder, TextDecoder} = require("node:util");
const {webcrypto} = require("node:crypto");

const ROOT = path.resolve(__dirname, "..");
const EXECUTOR_PATH = path.join(ROOT, "web", "pages", "tkb-browser-wasm.js");
const WORKER_PATH = path.join(ROOT, "web", "pages", "tkb-browser-wasm-worker.js");
const BRIDGE_PATH = path.join(ROOT, "web", "pages", "tkb-rust-bridge.js");
const PAGE_PATH = path.join(ROOT, "web", "pages", "sapxep.html");
const SERVER_PATH = path.join(ROOT, "rust_api", "src", "main.rs");

const EXECUTOR_SOURCE = fs.readFileSync(EXECUTOR_PATH, "utf8");
const WORKER_SOURCE = fs.readFileSync(WORKER_PATH, "utf8");

function response(payload, status = 200){
  return {
    ok:status >= 200 && status < 300,
    status,
    async json(){ return payload; }
  };
}

function completeRefinementRequest(){
  return {
    data:{
      tkbSolverResult:{
        lessons:[
          {classId:"L1", subject:"Toan", teacherId:"GV1", day:"thu2", session:"sang", period:0},
          {classId:"L1", subject:"Van", teacherId:"GV2", day:"thu2", session:"sang", period:1}
        ],
        metrics:{
          scheduled_periods:2,
          expected_periods:2,
          unassigned_periods:0,
          hard_ok:true,
          app_constraint_violation_count:0
        },
        validation:{hard_ok:true},
        unassignedLessons:[]
      }
    },
    settings:{
      ui_unified_solve_kind:"refine_complete",
      ui_use_existing_complete_incumbent:true,
      ui_existing_incumbent_revalidated:true,
      optimize_existing_schedule:false,
      preserve_existing_tkb:false,
      preserve_fixed_lessons_only:false,
      best_effort_on_timeout:true
    }
  };
}

function executorContext(overrides = {}){
  const documentListeners = new Map();
  const windowListeners = new Map();
  const context = {
    console,
    URL,
    TextEncoder,
    TextDecoder,
    AbortController,
    Uint8Array,
    DataView,
    WebAssembly,
    BigInt,
    crypto:webcrypto,
    navigator:{
      platform:"Win32",
      userAgent:"Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      maxTouchPoints:0
    },
    location:{href:"https://tkbcherry.com/pages/sapxep?sid=default"},
    document:{
      visibilityState:"visible",
      addEventListener(name, handler){ documentListeners.set(name, handler); }
    },
    sessionStorage:{
      values:new Map(),
      getItem(key){ return this.values.get(key) || null; },
      setItem(key, value){ this.values.set(key, String(value)); }
    },
    TKBAuthApi:{
      getAuthHeaders(extra){
        return Object.assign({}, extra, {Authorization:"Bearer browser-session"});
      }
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    addEventListener(name, handler){ windowListeners.set(name, handler); },
    ...overrides
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(EXECUTOR_SOURCE, context, {filename:EXECUTOR_PATH});
  return {context, documentListeners, windowListeners};
}

test("browser WASM enables Windows, macOS and Android but excludes every iOS/iPadOS form", () => {
  const {context} = executorContext({fetch:async () => response({ok:false}, 503), Worker:function(){}});
  const supported = context.TKBBrowserWasmExecutor.isSupportedNavigator;
  assert.equal(supported({platform:"Win32", userAgent:"Windows NT 10.0", maxTouchPoints:0}), true);
  assert.equal(supported({platform:"MacIntel", userAgent:"Macintosh; Intel Mac OS X 14_5", maxTouchPoints:0}), true);
  assert.equal(supported({platform:"Linux armv8l", userAgent:"Android 15; Mobile", maxTouchPoints:5}), true);
  assert.equal(supported({platform:"iPhone", userAgent:"iPhone; CPU iPhone OS 18_0", maxTouchPoints:5}), false);
  assert.equal(supported({platform:"MacIntel", userAgent:"Macintosh", maxTouchPoints:5}), false);
  assert.equal(supported({platform:"Linux x86_64", userAgent:"X11; Linux x86_64", maxTouchPoints:0}), false);
});

test("browser tree digest matches the server wire value after JSON serialization", async () => {
  const {context} = executorContext({fetch:async () => response({ok:false}, 503), Worker:function(){}});
  const wireValue = JSON.parse(JSON.stringify({a:1, b:[1e-7, -0], c:"\u0111"}));
  assert.equal(
    await context.TKBBrowserWasmExecutor.resultDigest(wireValue),
    "66f61a2c9267534e15bd65549589dfb2b8a1eafc97e6e78c6a7e200c89e39500"
  );
  assert.equal(
    await context.TKBBrowserWasmExecutor.resultDigest({c:"\u0111", b:[1e-7, 0], a:1}),
    "66f61a2c9267534e15bd65549589dfb2b8a1eafc97e6e78c6a7e200c89e39500"
  );
});

test("foreground executor probes WASM before hello and disconnects without an install prompt", async () => {
  const calls = [];
  const request = completeRefinementRequest();
  class FakeWorker {
    constructor(url){
      calls.push(`worker:${url}`);
      this.onmessage = null;
      this.onerror = null;
    }
    postMessage(message){
      calls.push(`worker-message:${message.type}`);
      if(message.type === "probe"){
        queueMicrotask(() => this.onmessage({data:{type:"ready", requestId:message.requestId}}));
      }
    }
    terminate(){ calls.push("worker:terminate"); }
  }
  const fetch = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    calls.push(`${options.method || "GET"}:${pathname}`);
    if(pathname.endsWith("/status")) return response({ok:true, online:false, agentCount:0});
    if(pathname.endsWith("/hello")){
      return response({ok:true, protocol:"tkb-agent-helper-v1", workerToken:"w".repeat(48)});
    }
    if(pathname.endsWith("/lease")) return new Promise(() => {});
    if(pathname.endsWith("/disconnect")) return response({ok:true, disconnected:true});
    throw new Error(`unexpected request ${pathname}`);
  };
  const {context} = executorContext({fetch, Worker:FakeWorker});
  assert.equal(await context.TKBBrowserWasmExecutor.probe({
    apiBase:"https://tkbcherry.com",
    request
  }), true);
  assert.equal(context.TKBBrowserWasmExecutor.state().active, false);
  calls.push("POST:/api/solve-data");
  assert.equal(await context.TKBBrowserWasmExecutor.activate({
    apiBase:"https://tkbcherry.com",
    jobId:"job-browser-order",
    request
  }), true);
  assert.equal(context.TKBBrowserWasmExecutor.state().active, true);
  await context.TKBBrowserWasmExecutor.close("test_finished", {failLease:true});
  assert.equal(context.TKBBrowserWasmExecutor.state().active, false);
  assert.deepEqual(calls.slice(0, 5), [
    "GET:/api/agent-helper/v1/status",
    "worker:tkb-browser-wasm-worker.js?v=tkb-browser-wasm-executor-v2",
    "worker-message:probe",
    "POST:/api/solve-data",
    "POST:/api/agent-helper/v1/hello",
  ]);
  assert.ok(calls.indexOf("POST:/api/agent-helper/v1/lease") > calls.indexOf("POST:/api/agent-helper/v1/hello"));
  assert.ok(calls.includes("POST:/api/agent-helper/v1/disconnect"));
  assert.doesNotMatch(EXECUTOR_SOURCE, /\bconfirm\s*\(|\balert\s*\(|downloadAgent/i);
});

test("backgrounding terminates compute, fails the exact lease, then disconnects", async () => {
  const calls = [];
  const request = completeRefinementRequest();
  let leaseIssued = false;
  class FakeWorker {
    constructor(){ this.onmessage = null; this.onerror = null; }
    postMessage(message){
      calls.push(`worker-message:${message.type}`);
      if(message.type === "probe"){
        queueMicrotask(() => this.onmessage({data:{type:"ready", requestId:message.requestId}}));
      }
    }
    terminate(){ calls.push("worker:terminate"); }
  }
  const fetch = async (url) => {
    const pathname = new URL(url).pathname;
    calls.push(pathname);
    if(pathname.endsWith("/status")) return response({ok:true, online:false});
    if(pathname.endsWith("/hello")) return response({ok:true, workerToken:"x".repeat(48)});
    if(pathname.endsWith("/lease") && !leaseIssued){
      leaseIssued = true;
      return response({
        ok:true,
        lease:{
          jobId:"job-browser-1",
          leaseId:"lease-browser-1",
          payload:request
        }
      });
    }
    if(pathname.endsWith("/fail")) return response({ok:true, requeued:true});
    if(pathname.endsWith("/disconnect")) return response({ok:true, disconnected:true});
    if(pathname.endsWith("/lease")) return new Promise(() => {});
    throw new Error(`unexpected request ${pathname}`);
  };
  const {context} = executorContext({fetch, Worker:FakeWorker});
  assert.equal(await context.TKBBrowserWasmExecutor.probe({
    apiBase:"https://tkbcherry.com",
    request
  }), true);
  assert.equal(await context.TKBBrowserWasmExecutor.activate({
    apiBase:"https://tkbcherry.com",
    jobId:"job-browser-1",
    request
  }), true);
  for(let index = 0; index < 20 && !context.TKBBrowserWasmExecutor.state().hasLease; index++){
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal(context.TKBBrowserWasmExecutor.state().hasLease, true);
  assert.equal(context.TKBBrowserWasmExecutor.stopForBackground(), true);
  await context.TKBBrowserWasmExecutor.close("browser_hidden", {failLease:true, keepalive:true});
  const failIndex = calls.findIndex(value => value.endsWith("/leases/lease-browser-1/fail"));
  const disconnectIndex = calls.findIndex(value => value.endsWith("/disconnect"));
  assert.ok(calls.includes("worker:terminate"));
  assert.ok(failIndex >= 0, "the exact active lease must be failed");
  assert.ok(disconnectIndex > failIndex, "worker disconnect must follow lease release");
});

test("pagehide racing hello revokes the late token without resurrecting compute", async () => {
  let resolveHello;
  let disconnects = 0;
  const request = completeRefinementRequest();
  class FakeWorker {
    postMessage(message){
      if(message.type === "probe"){
        queueMicrotask(() => this.onmessage({data:{type:"ready", requestId:message.requestId}}));
      }
    }
    terminate(){}
  }
  const fetch = async (url) => {
    const pathname = new URL(url).pathname;
    if(pathname.endsWith("/status")) return response({ok:true, online:false});
    if(pathname.endsWith("/hello")){
      return new Promise(resolve => { resolveHello = resolve; });
    }
    if(pathname.endsWith("/disconnect")){
      disconnects += 1;
      return response({ok:true, disconnected:true});
    }
    throw new Error(`unexpected request ${pathname}`);
  };
  const {context} = executorContext({fetch, Worker:FakeWorker});
  assert.equal(await context.TKBBrowserWasmExecutor.probe({
    apiBase:"https://tkbcherry.com",
    request
  }), true);
  const activation = context.TKBBrowserWasmExecutor.activate({
    apiBase:"https://tkbcherry.com",
    jobId:"job-browser-race",
    request
  });
  for(let index = 0; index < 20 && typeof resolveHello !== "function"; index++){
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal(typeof resolveHello, "function");
  context.document.visibilityState = "hidden";
  context.TKBBrowserWasmExecutor.stopForBackground();
  resolveHello(response({ok:true, workerToken:"z".repeat(48)}));
  assert.equal(await activation, false);
  for(let index = 0; index < 20 && disconnects < 1; index++){
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal(disconnects, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(context.TKBBrowserWasmExecutor.state())), {
    active:false,
    probed:false,
    hasWorker:false,
    hasLease:false,
    jobId:""
  });
});

test("terminal heartbeat loss kills WASM immediately instead of overlapping VPS", async () => {
  const intervalCallbacks = [];
  const calls = [];
  const request = completeRefinementRequest();
  class FakeWorker {
    postMessage(message){
      if(message.type === "probe"){
        queueMicrotask(() => this.onmessage({data:{type:"ready", requestId:message.requestId}}));
      }
    }
    terminate(){ calls.push("worker:terminate"); }
  }
  let leaseIssued = false;
  const fetch = async (url) => {
    const pathname = new URL(url).pathname;
    calls.push(pathname);
    if(pathname.endsWith("/status")) return response({ok:true, online:false});
    if(pathname.endsWith("/hello")) return response({ok:true, workerToken:"h".repeat(48), leaseMs:30000});
    if(pathname.endsWith("/lease") && !leaseIssued){
      leaseIssued = true;
      return response({ok:true, lease:{
        jobId:"job-heartbeat",
        leaseId:"lease-heartbeat",
        payload:request
      }});
    }
    if(pathname.endsWith("/heartbeat")){
      return response({ok:false, kind:"agent_lease_expired"}, 410);
    }
    if(pathname.endsWith("/disconnect")) return response({ok:true, disconnected:true});
    throw new Error(`unexpected request ${pathname}`);
  };
  const {context} = executorContext({
    fetch,
    Worker:FakeWorker,
    setInterval(callback){ intervalCallbacks.push(callback); return intervalCallbacks.length; },
    clearInterval(){}
  });
  assert.equal(await context.TKBBrowserWasmExecutor.probe({
    apiBase:"https://tkbcherry.com",
    request
  }), true);
  assert.equal(await context.TKBBrowserWasmExecutor.activate({
    apiBase:"https://tkbcherry.com",
    jobId:"job-heartbeat",
    request
  }), true);
  for(let index = 0; index < 20 && !context.TKBBrowserWasmExecutor.state().hasLease; index++){
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal(intervalCallbacks.length, 2);
  intervalCallbacks[0]();
  for(let index = 0; index < 20 && context.TKBBrowserWasmExecutor.state().active; index++){
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal(context.TKBBrowserWasmExecutor.state().active, false);
  assert.ok(calls.includes("worker:terminate"));
  assert.ok(calls.some(value => value.endsWith("/disconnect")));
});

test("local lease watchdog terminates compute before an unrenewed lease expires", async () => {
  const intervalCallbacks = [];
  let nowMs = 100000;
  const request = completeRefinementRequest();
  class FakeDate extends Date {
    static now(){ return nowMs; }
  }
  class FakeWorker {
    postMessage(message){
      if(message.type === "probe"){
        queueMicrotask(() => this.onmessage({data:{type:"ready", requestId:message.requestId}}));
      }
    }
    terminate(){}
  }
  let leaseIssued = false;
  const fetch = async (url) => {
    const pathname = new URL(url).pathname;
    if(pathname.endsWith("/status")) return response({ok:true, online:false});
    if(pathname.endsWith("/hello")) return response({ok:true, workerToken:"q".repeat(48), leaseMs:30000});
    if(pathname.endsWith("/lease") && !leaseIssued){
      leaseIssued = true;
      return response({ok:true, lease:{
        jobId:"job-watchdog",
        leaseId:"lease-watchdog",
        payload:request
      }});
    }
    if(pathname.endsWith("/disconnect")) return response({ok:true, disconnected:true});
    throw new Error(`unexpected request ${pathname}`);
  };
  const {context} = executorContext({
    Date:FakeDate,
    fetch,
    Worker:FakeWorker,
    setInterval(callback){ intervalCallbacks.push(callback); return intervalCallbacks.length; },
    clearInterval(){}
  });
  assert.equal(await context.TKBBrowserWasmExecutor.probe({
    apiBase:"https://tkbcherry.com",
    request
  }), true);
  assert.equal(await context.TKBBrowserWasmExecutor.activate({
    apiBase:"https://tkbcherry.com",
    jobId:"job-watchdog",
    request
  }), true);
  for(let index = 0; index < 20 && !context.TKBBrowserWasmExecutor.state().hasLease; index++){
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal(intervalCallbacks.length, 2);
  nowMs += 29500;
  intervalCallbacks[1]();
  for(let index = 0; index < 20 && context.TKBBrowserWasmExecutor.state().active; index++){
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal(context.TKBBrowserWasmExecutor.state().active, false);
});

test("fresh and incomplete requests bypass browser WASM without probing or activating", async () => {
  let fetchCalls = 0;
  let workerStarts = 0;
  class FakeWorker {
    constructor(){ workerStarts += 1; }
  }
  const {context} = executorContext({
    fetch:async () => {
      fetchCalls += 1;
      return response({ok:true, online:false});
    },
    Worker:FakeWorker
  });
  const fresh = {data:{}, settings:{ui_unified_solve_kind:"fresh"}};
  const incomplete = completeRefinementRequest();
  incomplete.data.tkbSolverResult.lessons.pop();
  incomplete.data.tkbSolverResult.metrics.scheduled_periods = 1;
  incomplete.data.tkbSolverResult.metrics.unassigned_periods = 1;
  const hardInvalid = completeRefinementRequest();
  hardInvalid.data.tkbSolverResult.metrics.hard_ok = false;
  const constraintInvalid = completeRefinementRequest();
  constraintInvalid.data.tkbSolverResult.metrics.app_constraint_violation_count = 1;
  const missingIncumbentLessons = completeRefinementRequest();
  delete missingIncumbentLessons.data.tkbSolverResult.lessons;

  for(const request of [
    fresh,
    incomplete,
    hardInvalid,
    constraintInvalid,
    missingIncumbentLessons
  ]){
    assert.equal(context.TKBBrowserWasmExecutor.canHandleRequest(request), false);
    assert.equal(await context.TKBBrowserWasmExecutor.probe({
      apiBase:"https://tkbcherry.com",
      request
    }), false);
    assert.equal(await context.TKBBrowserWasmExecutor.activate({
      apiBase:"https://tkbcherry.com",
      jobId:"job-must-stay-on-vps",
      request
    }), false);
  }
  assert.equal(fetchCalls, 0, "VPS-only requests must not even query Agent status");
  assert.equal(workerStarts, 0, "VPS-only requests must not compile or start WASM");
});

test("complete refinement sends an overridden clone to WASM without mutating the canonical lease", async () => {
  const canonical = completeRefinementRequest();
  const originalWire = JSON.stringify(canonical);
  let leaseIssued = false;
  let workerPayload = null;
  class FakeWorker {
    constructor(){ this.onmessage = null; }
    postMessage(message){
      if(message.type === "probe"){
        queueMicrotask(() => this.onmessage({data:{type:"ready", requestId:message.requestId}}));
      }else if(message.type === "solve"){
        workerPayload = message.payload;
        queueMicrotask(() => this.onmessage({
          data:{type:"error", requestId:message.requestId, error:"test_complete"}
        }));
      }
    }
    terminate(){}
  }
  const fetch = async (url) => {
    const pathname = new URL(url).pathname;
    if(pathname.endsWith("/status")) return response({ok:true, online:false});
    if(pathname.endsWith("/hello")) return response({ok:true, workerToken:"r".repeat(48)});
    if(pathname.endsWith("/lease") && !leaseIssued){
      leaseIssued = true;
      return response({ok:true, lease:{
        jobId:"job-refine-clone",
        leaseId:"lease-refine-clone",
        payload:canonical
      }});
    }
    if(pathname.endsWith("/fail")) return response({ok:true, requeued:true});
    if(pathname.endsWith("/disconnect")) return response({ok:true, disconnected:true});
    if(pathname.endsWith("/lease")) return new Promise(() => {});
    throw new Error(`unexpected request ${pathname}`);
  };
  const {context} = executorContext({fetch, Worker:FakeWorker});
  assert.equal(context.TKBBrowserWasmExecutor.canHandleRequest(canonical), true);
  assert.equal(await context.TKBBrowserWasmExecutor.probe({
    apiBase:"https://tkbcherry.com",
    request:canonical
  }), true);
  assert.equal(await context.TKBBrowserWasmExecutor.activate({
    apiBase:"https://tkbcherry.com",
    jobId:"job-refine-clone",
    request:canonical
  }), true);
  for(let index = 0; index < 30 && !workerPayload; index++){
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.ok(workerPayload, "eligible refinement must reach the WASM worker");
  assert.notStrictEqual(workerPayload, canonical);
  assert.equal(workerPayload.settings.optimize_existing_schedule, true);
  assert.equal(workerPayload.settings.existing_fill_missing_schedule, false);
  assert.equal(workerPayload.settings.preserve_existing_tkb, true);
  assert.equal(workerPayload.settings.preserve_existing_min_ratio, 1);
  assert.equal(workerPayload.settings.preserve_fixed_lessons_only, true);
  assert.equal(workerPayload.settings.partial_existing_rebuild, false);
  assert.equal(workerPayload.settings.repair_fill_first, false);
  assert.equal(workerPayload.settings.repair_partial_existing, false);
  assert.equal(workerPayload.settings.require_complete_schedule, true);
  assert.equal(workerPayload.settings.best_effort_on_timeout, false);
  assert.equal(JSON.stringify(canonical), originalWire, "canonical server request must remain byte-stable");
  await context.TKBBrowserWasmExecutor.close("test_finished", {failLease:true});
});

test("closing the executor aborts its outstanding lease long-poll immediately", async () => {
  const request = completeRefinementRequest();
  let leaseSignal = null;
  class FakeWorker {
    postMessage(message){
      if(message.type === "probe"){
        queueMicrotask(() => this.onmessage({data:{type:"ready", requestId:message.requestId}}));
      }
    }
    terminate(){}
  }
  const fetch = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if(pathname.endsWith("/status")) return response({ok:true, online:false});
    if(pathname.endsWith("/hello")) return response({ok:true, workerToken:"a".repeat(48)});
    if(pathname.endsWith("/lease")){
      leaseSignal = options.signal;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, {once:true});
      });
    }
    if(pathname.endsWith("/disconnect")) return response({ok:true, disconnected:true});
    throw new Error(`unexpected request ${pathname}`);
  };
  const {context} = executorContext({fetch, Worker:FakeWorker});
  assert.equal(await context.TKBBrowserWasmExecutor.probe({
    apiBase:"https://tkbcherry.com",
    request
  }), true);
  assert.equal(await context.TKBBrowserWasmExecutor.activate({
    apiBase:"https://tkbcherry.com",
    jobId:"job-abort-long-poll",
    request
  }), true);
  for(let index = 0; index < 20 && !leaseSignal; index++){
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.ok(leaseSignal);
  assert.equal(leaseSignal.aborted, false);
  await context.TKBBrowserWasmExecutor.close("test_finished", {failLease:true});
  assert.equal(leaseSignal.aborted, true);
});

test("planner wires the browser worker only around a new canonical solve", () => {
  const bridge = fs.readFileSync(BRIDGE_PATH, "utf8");
  const page = fs.readFileSync(PAGE_PATH, "utf8");
  const server = fs.readFileSync(SERVER_PATH, "utf8");
  assert.match(page, /tkb-browser-wasm\.js\?v=20260723-v164-browser-compute-v1/);
  assert.ok(page.indexOf("tkb-browser-wasm.js") < page.indexOf("tkb-rust-bridge.js"));
  assert.match(bridge, /TKBBrowserWasmExecutor\.canHandleRequest\(browserWasmRequest\)/);
  assert.match(bridge, /!resumeExistingServerJobOnly[\s\S]*browserWasmEligible[\s\S]*TKBBrowserWasmExecutor\.probe/);
  assert.match(bridge, /if\(serverOwnedJob\)[\s\S]*TKBBrowserWasmExecutor\.activate/);
  assert.match(bridge, /TKBBrowserWasmExecutor\.probe\(\{[\s\S]*request:browserWasmRequest,[\s\S]*signal:controller\.signal/);
  assert.match(bridge, /TKBBrowserWasmExecutor\.activate\(\{[\s\S]*request:browserWasmRequest,[\s\S]*signal:controller\.signal/);
  assert.ok(
    bridge.indexOf("/api/solve-data") < bridge.indexOf("TKBBrowserWasmExecutor.activate"),
    "hello/lease activation must happen only after the canonical job POST"
  );
  assert.match(bridge, /TKBBrowserWasmExecutor\.close\("solve_finished"/);
  assert.match(server, /POST", "\/api\/agent-helper\/v1\/disconnect/);
  assert.match(server, /revoke_worker_token/);
  assert.match(WORKER_SOURCE, /WebAssembly\.instantiate/);
  assert.match(WORKER_SOURCE, /tkb_now_ms:\(\) => Date\.now\(\)/);
  assert.doesNotMatch(WORKER_SOURCE, /agent-helper|Authorization|localStorage|sessionStorage/);
});
