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

function memoryStorage(initial = {}){
  const values = new Map(Object.entries(initial).map(([key, value]) => [String(key), String(value)]));
  return {
    getItem(key){ return values.has(String(key)) ? values.get(String(key)) : null; },
    setItem(key, value){ values.set(String(key), String(value)); },
    removeItem(key){ values.delete(String(key)); }
  };
}

function completeRefinementRequest(){
  return {
    data:{
      tkbSolverResult:{
        ok:true,
        lessons:[
          {classId:"L1", subject:"Toan", teacherId:"GV1", day:"thu2", session:"sang", period:0},
          {classId:"L1", subject:"Van", teacherId:"GV2", day:"thu2", session:"sang", period:1}
        ],
        metrics:{
          scheduled_periods:2,
          expected_periods:2,
          unassigned_periods:0,
          hard_ok:true,
          app_constraint_violation_count:0,
          teacher_sessions:460,
          one_period_teacher_sessions:0,
          teacher_gap2_sessions:0,
          gap_distribution:{"0":420, "1":40},
          gap_total:40
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
    localStorage:memoryStorage(),
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

function completePortfolioCandidate(canonical, marker, metrics = {}){
  return {
    ok:true,
    candidateMarker:marker,
    lessons:JSON.parse(JSON.stringify(canonical.data.tkbSolverResult.lessons)),
    metrics:Object.assign({
      scheduled_periods:2,
      expected_periods:2,
      unassigned_periods:0,
      hard_ok:true,
      app_constraint_violation_count:0,
      one_period_teacher_sessions:0,
      teacher_gap2_sessions:0,
      teacher_sessions:460,
      gap_distribution:{"0":420, "1":40},
      gap_total:40
    }, metrics),
    validation:{hard_ok:true},
    unassignedLessons:[]
  };
}

async function exercisePortfolioCandidates(canonical, candidates, navigator){
  const workerPayloads = [];
  const failures = [];
  let workerIndex = 0;
  let leaseIssued = false;
  let submittedResult = null;
  let completeSeen = false;
  class FakeWorker {
    constructor(){ this.index = workerIndex++; }
    postMessage(message){
      if(message.type === "probe"){
        queueMicrotask(() => this.onmessage({data:{type:"ready", requestId:message.requestId}}));
        return;
      }
      if(message.type === "solve"){
        workerPayloads[this.index] = message.payload;
        queueMicrotask(() => this.onmessage({data:{
          type:"result",
          requestId:message.requestId,
          frame:{
            protocol:"tkb-reference-solver-stdio-v1",
            status:200,
            payload:candidates[this.index]
          }
        }}));
      }
    }
    terminate(){}
  }
  const fetch = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if(pathname.endsWith("/status")) return response({ok:true, online:false});
    if(pathname.endsWith("/hello")){
      assert.equal(JSON.parse(options.body).capacity.cpuWorkers, candidates.length);
      return response({ok:true, workerToken:"s".repeat(48)});
    }
    if(pathname.endsWith("/lease") && !leaseIssued){
      leaseIssued = true;
      return response({ok:true, lease:{
        jobId:"job-portfolio-contract",
        leaseId:"lease-portfolio-contract",
        payload:canonical
      }});
    }
    if(pathname.endsWith("/candidate") || pathname.endsWith("/checkpoint")){
      const candidate = JSON.parse(options.body);
      submittedResult = candidate.result;
      return response({ok:true, candidateId:"candidate-contract", sha256:candidate.sha256});
    }
    if(pathname.endsWith("/complete")){
      completeSeen = true;
      return response({ok:true, completed:true});
    }
    if(pathname.endsWith("/fail")){
      failures.push(JSON.parse(options.body));
      return response({ok:true, requeued:true});
    }
    if(pathname.endsWith("/disconnect")) return response({ok:true, disconnected:true});
    if(pathname.endsWith("/lease")) return new Promise(() => {});
    throw new Error(`unexpected request ${pathname}`);
  };
  const {context} = executorContext({navigator, fetch, Worker:FakeWorker});
  assert.equal(await context.TKBBrowserWasmExecutor.probe({
    apiBase:"https://tkbcherry.com",
    request:canonical
  }), true);
  assert.equal(context.TKBBrowserWasmExecutor.state().workerCount, candidates.length);
  assert.equal(await context.TKBBrowserWasmExecutor.activate({
    apiBase:"https://tkbcherry.com",
    jobId:"job-portfolio-contract",
    request:canonical
  }), true);
  for(let index = 0; index < 50 && !completeSeen; index += 1){
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal(completeSeen, true, "the portfolio must publish its final best after checkpoints");
  await context.TKBBrowserWasmExecutor.close("test_finished", {failLease:true});
  return {submittedResult, workerPayloads, failures};
}

test("browser WASM enables Windows, macOS, Linux, Android, iPhone and every iPadOS navigator form", () => {
  const {context} = executorContext({fetch:async () => response({ok:false}, 503), Worker:function(){}});
  const supported = context.TKBBrowserWasmExecutor.isSupportedNavigator;
  assert.equal(supported({platform:"Win32", userAgent:"Windows NT 10.0", maxTouchPoints:0}), true);
  assert.equal(supported({platform:"MacIntel", userAgent:"Macintosh; Intel Mac OS X 14_5", maxTouchPoints:0}), true);
  assert.equal(supported({platform:"Linux armv8l", userAgent:"Android 15; Mobile", maxTouchPoints:5}), true);
  assert.equal(supported({platform:"iPhone", userAgent:"iPhone; CPU iPhone OS 18_0", maxTouchPoints:5}), true);
  assert.equal(supported({platform:"iPad", userAgent:"iPad; CPU OS 18_0 like Mac OS X", maxTouchPoints:5}), true);
  assert.equal(supported({platform:"MacIntel", userAgent:"Macintosh", maxTouchPoints:5}), true);
  assert.equal(supported({platform:"Linux x86_64", userAgent:"X11; Linux x86_64", maxTouchPoints:0}), true);
});

test("browser Agent is enabled by default and persists an explicit VPS-only toggle", async () => {
  const storage = memoryStorage();
  const first = executorContext({
    localStorage:storage,
    fetch:async () => response({ok:false}, 503),
    Worker:function Worker(){}
  }).context;
  assert.equal(first.TKBBrowserWasmExecutor.isEnabled(), true);
  assert.equal(first.TKBBrowserWasmExecutor.state().enabled, true);

  assert.equal(await first.TKBBrowserWasmExecutor.setEnabled(false), false);
  assert.equal(storage.getItem("TKB_BROWSER_WASM_ENABLED_V1"), "0");
  assert.equal(first.TKBBrowserWasmExecutor.state().enabled, false);

  const reloaded = executorContext({
    localStorage:storage,
    fetch:async () => response({ok:false}, 503),
    Worker:function Worker(){}
  }).context;
  assert.equal(reloaded.TKBBrowserWasmExecutor.isEnabled(), false);
  assert.equal(await reloaded.TKBBrowserWasmExecutor.probe({
    apiBase:"https://tkbcherry.com",
    request:completeRefinementRequest()
  }), false);

  assert.equal(await reloaded.TKBBrowserWasmExecutor.setEnabled(true), true);
  assert.equal(storage.getItem("TKB_BROWSER_WASM_ENABLED_V1"), "1");
  assert.equal(reloaded.TKBBrowserWasmExecutor.isEnabled(), true);
});

test("browser portfolio reserves one core and caps workers by platform and memory", () => {
  const {context} = executorContext({fetch:async () => response({ok:false}, 503), Worker:function Worker(){}});
  const workerCount = context.TKBBrowserWasmExecutor.portfolioWorkerCount;
  assert.equal(workerCount({platform:"Win32", userAgent:"Windows NT 10.0", hardwareConcurrency:16}), 8);
  assert.equal(workerCount({platform:"Linux x86_64", userAgent:"X11; Linux x86_64", hardwareConcurrency:8}), 7);
  assert.equal(workerCount({platform:"MacIntel", userAgent:"Macintosh", hardwareConcurrency:4}), 3);
  assert.equal(workerCount({platform:"iPhone", userAgent:"iPhone", hardwareConcurrency:8, maxTouchPoints:5}), 2);
  assert.equal(workerCount({platform:"Linux armv8l", userAgent:"Android 15; Mobile", hardwareConcurrency:8}), 2);
  assert.equal(workerCount({platform:"Win32", userAgent:"Windows NT 10.0", hardwareConcurrency:16, deviceMemory:2}), 1);
  assert.equal(workerCount({platform:"Win32", userAgent:"Windows NT 10.0", hardwareConcurrency:16, deviceMemory:4}), 2);
  assert.equal(workerCount({platform:"Win32", userAgent:"Windows NT 10.0", hardwareConcurrency:1}), 1);
});

test("browser portfolio keeps healthy probes and cleans up partial worker startup", async () => {
  const request = completeRefinementRequest();
  let created = 0;
  let terminated = 0;
  class PartialWorker {
    constructor(){ this.index = created++; }
    postMessage(message){
      if(message.type !== "probe") return;
      queueMicrotask(() => this.onmessage({data:this.index === 1
        ? {type:"error", requestId:message.requestId, error:"probe_failed"}
        : {type:"ready", requestId:message.requestId}
      }));
    }
    terminate(){ terminated += 1; }
  }
  const partial = executorContext({
    navigator:{
      platform:"Win32",
      userAgent:"Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      hardwareConcurrency:5,
      maxTouchPoints:0
    },
    fetch:async url => new URL(url).pathname.endsWith("/status")
      ? response({ok:true, online:false})
      : response({ok:false}, 404),
    Worker:PartialWorker
  }).context;
  assert.equal(await partial.TKBBrowserWasmExecutor.probe({
    apiBase:"https://tkbcherry.com",
    request
  }), true);
  assert.equal(partial.TKBBrowserWasmExecutor.state().workerCount, 3);
  assert.equal(terminated, 1);
  await partial.TKBBrowserWasmExecutor.close("test_finished", {failLease:false});
  assert.equal(terminated, 4);

  let constructorCalls = 0;
  let constructorCleanup = 0;
  class ConstructorFailureWorker {
    constructor(){
      constructorCalls += 1;
      if(constructorCalls === 2) throw new Error("constructor_failed");
    }
    terminate(){ constructorCleanup += 1; }
  }
  const failed = executorContext({
    navigator:{
      platform:"Win32",
      userAgent:"Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      hardwareConcurrency:5,
      maxTouchPoints:0
    },
    fetch:async url => new URL(url).pathname.endsWith("/status")
      ? response({ok:true, online:false})
      : response({ok:false}, 404),
    Worker:ConstructorFailureWorker
  }).context;
  assert.equal(await failed.TKBBrowserWasmExecutor.probe({
    apiBase:"https://tkbcherry.com",
    request
  }), false);
  assert.equal(constructorCleanup, 1);
  assert.equal(failed.TKBBrowserWasmExecutor.state().workerCount, 0);
});

test("iPhone and iPad browser compute can probe only while the page is foreground", async () => {
  for(const navigator of [
    {platform:"iPhone", userAgent:"iPhone; CPU iPhone OS 18_0", maxTouchPoints:5},
    {platform:"iPad", userAgent:"iPad; CPU OS 18_0 like Mac OS X", maxTouchPoints:5},
    {platform:"MacIntel", userAgent:"Macintosh", maxTouchPoints:5}
  ]){
    let workerStarts = 0;
    class FakeWorker {
      constructor(){
        workerStarts += 1;
        this.onmessage = null;
      }
      postMessage(message){
        if(message.type === "probe"){
          queueMicrotask(() => this.onmessage({data:{type:"ready", requestId:message.requestId}}));
        }
      }
      terminate(){}
    }
    const visible = executorContext({
      navigator,
      fetch:async () => response({ok:true, online:false}),
      Worker:FakeWorker
    }).context;
    assert.equal(await visible.TKBBrowserWasmExecutor.probe({
      apiBase:"https://tkbcherry.com",
      request:completeRefinementRequest()
    }), true);
    assert.equal(workerStarts, 1);
    await visible.TKBBrowserWasmExecutor.close("test_finished", {failLease:true});

    workerStarts = 0;
    const hiddenDocument = {
      visibilityState:"hidden",
      addEventListener(){}
    };
    const hidden = executorContext({
      navigator,
      document:hiddenDocument,
      fetch:async () => response({ok:true, online:false}),
      Worker:FakeWorker
    }).context;
    assert.equal(await hidden.TKBBrowserWasmExecutor.probe({
      apiBase:"https://tkbcherry.com",
      request:completeRefinementRequest()
    }), false);
    assert.equal(workerStarts, 0);
  }
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
    "worker:tkb-browser-wasm-worker.js?v=tkb-browser-wasm-executor-v8-checkpoint-stop",
    "worker-message:probe",
    "POST:/api/solve-data",
    "POST:/api/agent-helper/v1/hello",
  ]);
  assert.ok(calls.indexOf("POST:/api/agent-helper/v1/lease") > calls.indexOf("POST:/api/agent-helper/v1/hello"));
  assert.ok(calls.includes("POST:/api/agent-helper/v1/disconnect"));
  assert.doesNotMatch(EXECUTOR_SOURCE, /\bconfirm\s*\(|\balert\s*\(|downloadAgent/i);
});

test("iPhone visibilitychange terminates compute, fails the exact lease, then returns it to VPS", async () => {
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
  const {context, documentListeners} = executorContext({
    navigator:{
      platform:"iPhone",
      userAgent:"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
      maxTouchPoints:5
    },
    fetch,
    Worker:FakeWorker
  });
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
  context.document.visibilityState = "hidden";
  documentListeners.get("visibilitychange")();
  await context.TKBBrowserWasmExecutor.close("browser_hidden", {failLease:true, keepalive:true});
  const failIndex = calls.findIndex(value => value.endsWith("/leases/lease-browser-1/fail"));
  const disconnectIndex = calls.findIndex(value => value.endsWith("/disconnect"));
  assert.ok(calls.includes("worker:terminate"));
  assert.ok(failIndex >= 0, "the exact active lease must be failed");
  assert.ok(disconnectIndex > failIndex, "worker disconnect must follow lease release");
});

test("turning Agent off during compute terminates every worker and hands the lease to VPS", async () => {
  const calls = [];
  let leaseIssued = false;
  let terminated = 0;
  const request = completeRefinementRequest();
  class FakeWorker {
    postMessage(message){
      if(message.type === "probe"){
        queueMicrotask(() => this.onmessage({data:{type:"ready", requestId:message.requestId}}));
      }
    }
    terminate(){ terminated += 1; }
  }
  const fetch = async (url) => {
    const pathname = new URL(url).pathname;
    calls.push(pathname);
    if(pathname.endsWith("/status")) return response({ok:true, online:false});
    if(pathname.endsWith("/hello")) return response({ok:true, workerToken:"t".repeat(48)});
    if(pathname.endsWith("/lease") && !leaseIssued){
      leaseIssued = true;
      return response({ok:true, lease:{
        jobId:"job-toggle-off",
        leaseId:"lease-toggle-off",
        payload:request
      }});
    }
    if(pathname.endsWith("/fail")) return response({ok:true, requeued:true});
    if(pathname.endsWith("/disconnect")) return response({ok:true, disconnected:true});
    if(pathname.endsWith("/lease")) return new Promise(() => {});
    throw new Error(`unexpected request ${pathname}`);
  };
  const storage = memoryStorage();
  const {context} = executorContext({
    navigator:{
      platform:"Win32",
      userAgent:"Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      hardwareConcurrency:5,
      maxTouchPoints:0
    },
    localStorage:storage,
    fetch,
    Worker:FakeWorker
  });
  assert.equal(await context.TKBBrowserWasmExecutor.probe({
    apiBase:"https://tkbcherry.com",
    request
  }), true);
  assert.equal(context.TKBBrowserWasmExecutor.state().workerCount, 4);
  assert.equal(await context.TKBBrowserWasmExecutor.activate({
    apiBase:"https://tkbcherry.com",
    jobId:"job-toggle-off",
    request
  }), true);
  for(let index = 0; index < 30 && !context.TKBBrowserWasmExecutor.state().hasLease; index += 1){
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal(context.TKBBrowserWasmExecutor.state().hasLease, true);

  assert.equal(await context.TKBBrowserWasmExecutor.setEnabled(false), false);
  assert.equal(storage.getItem("TKB_BROWSER_WASM_ENABLED_V1"), "0");
  assert.equal(terminated, 4);
  assert.ok(calls.some(value => value.endsWith("/leases/lease-toggle-off/fail")));
  assert.ok(calls.some(value => value.endsWith("/disconnect")));
  assert.deepEqual(JSON.parse(JSON.stringify(context.TKBBrowserWasmExecutor.state())), {
    active:false,
    probed:false,
    hasWorker:false,
    workerCount:0,
    hasLease:false,
    jobId:"",
    enabled:false,
    available:true
  });
});

test("iPad desktop-mode pagehide racing hello revokes the late token and leaves VPS canonical", async () => {
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
  const {context, windowListeners} = executorContext({
    navigator:{
      platform:"MacIntel",
      userAgent:"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)",
      maxTouchPoints:5
    },
    fetch,
    Worker:FakeWorker
  });
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
  windowListeners.get("pagehide")();
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
    workerCount:0,
    hasLease:false,
    jobId:"",
    enabled:true,
    available:true
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

test("four-worker portfolio uses distinct seeds and submits the best non-regressing candidate", async () => {
  const canonical = completeRefinementRequest();
  canonical.settings.random_seed = "base-seed";
  const originalWire = JSON.stringify(canonical);
  const workerPayloads = [];
  let workerIndex = 0;
  let leaseIssued = false;
  let submittedResult = null;
  const qualities = [
    {id:"fewer-sessions-but-worse-gap1", one:0, gap2:0, sessions:459, gap1:41, total:41},
    {id:"best-within-envelope", one:0, gap2:0, sessions:460, gap1:39, total:39},
    {id:"malformed-hard-candidate", one:0, gap2:0, sessions:430, gap1:10, total:10, appViolations:1},
    {id:"gap2-regression", one:0, gap2:1, sessions:440, gap1:15, total:17}
  ];
  class FakeWorker {
    constructor(){ this.index = workerIndex++; }
    postMessage(message){
      if(message.type === "probe"){
        queueMicrotask(() => this.onmessage({data:{type:"ready", requestId:message.requestId}}));
        return;
      }
      if(message.type === "solve"){
        workerPayloads[this.index] = message.payload;
        const quality = qualities[this.index];
        queueMicrotask(() => this.onmessage({data:{
          type:"result",
          requestId:message.requestId,
          frame:{
            protocol:"tkb-reference-solver-stdio-v1",
            status:200,
            payload:{
              ok:true,
              candidateMarker:quality.id,
              lessons:canonical.data.tkbSolverResult.lessons,
              metrics:{
                scheduled_periods:2,
                expected_periods:2,
                unassigned_periods:0,
                hard_ok:true,
                app_constraint_violation_count:quality.appViolations || 0,
                one_period_teacher_sessions:quality.one,
                teacher_gap2_sessions:quality.gap2,
                teacher_sessions:quality.sessions,
                gap_distribution:{"0":Math.max(0, quality.sessions - quality.gap1), "1":quality.gap1},
                gap_total:quality.total
              },
              validation:{hard_ok:true},
              unassignedLessons:[]
            }
          }
        }}));
      }
    }
    terminate(){}
  }
  const fetch = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if(pathname.endsWith("/status")) return response({ok:true, online:false});
    if(pathname.endsWith("/hello")){
      const hello = JSON.parse(options.body);
      assert.equal(hello.capacity.cpuWorkers, 4);
      return response({ok:true, workerToken:"p".repeat(48)});
    }
    if(pathname.endsWith("/lease") && !leaseIssued){
      leaseIssued = true;
      return response({ok:true, lease:{
        jobId:"job-portfolio",
        leaseId:"lease-portfolio",
        payload:canonical
      }});
    }
    if(pathname.endsWith("/candidate") || pathname.endsWith("/checkpoint")){
      const candidate = JSON.parse(options.body);
      submittedResult = candidate.result;
      return response({ok:true, candidateId:"candidate-portfolio", sha256:candidate.sha256});
    }
    if(pathname.endsWith("/complete")) return response({ok:true, completed:true});
    if(pathname.endsWith("/disconnect")) return response({ok:true, disconnected:true});
    if(pathname.endsWith("/lease")) return new Promise(() => {});
    throw new Error(`unexpected request ${pathname}`);
  };
  const {context} = executorContext({
    navigator:{
      platform:"Linux x86_64",
      userAgent:"Mozilla/5.0 (X11; Linux x86_64)",
      hardwareConcurrency:5,
      maxTouchPoints:0
    },
    fetch,
    Worker:FakeWorker
  });
  assert.equal(await context.TKBBrowserWasmExecutor.probe({
    apiBase:"https://tkbcherry.com",
    request:canonical
  }), true);
  assert.equal(context.TKBBrowserWasmExecutor.state().workerCount, 4);
  assert.equal(await context.TKBBrowserWasmExecutor.activate({
    apiBase:"https://tkbcherry.com",
    jobId:"job-portfolio",
    request:canonical
  }), true);
  for(let index = 0; index < 50 && !submittedResult; index += 1){
    await new Promise(resolve => setTimeout(resolve, 1));
  }

  assert.equal(workerPayloads.length, 4);
  assert.equal(new Set(workerPayloads.map(payload => payload.settings.random_seed)).size, 4);
  assert.deepEqual(
    workerPayloads.map(payload => payload.settings.browser_portfolio_index),
    [0, 1, 2, 3]
  );
  assert.ok(workerPayloads.every(payload => payload.settings.browser_portfolio_count === 4));
  assert.equal(workerPayloads[0].settings.random_seed, "base-seed");
  assert.ok(workerPayloads.slice(1).every(payload => payload.settings.random_seed.includes("job-portfolio")));
  assert.equal(submittedResult?.candidateMarker, "fewer-sessions-but-worse-gap1");
  assert.equal(JSON.stringify(canonical), originalWire, "portfolio seeds must not mutate the canonical lease");
  await context.TKBBrowserWasmExecutor.close("test_finished", {failLease:true});
});

test("soft Stop submits the best completed Browser Agent candidate without waiting for slower workers", async () => {
  const canonical = completeRefinementRequest();
  canonical.settings.optimization_focus = "sessions";
  const improved = completePortfolioCandidate(canonical, "fast-improvement", {
    teacher_sessions:459,
    one_period_teacher_sessions:0,
    teacher_gap2_sessions:1,
    gap_distribution:{"0":458, "2":1},
    gap_total:2
  });
  let workerIndex = 0;
  let leaseIssued = false;
  let submittedResult = null;
  let completeSeen = false;
  const submissionPaths = [];
  let fastCandidateDelivered = false;
  let terminated = 0;

  class StaggeredWorker {
    constructor(){ this.index = workerIndex++; }
    postMessage(message){
      if(message.type === "probe"){
        queueMicrotask(() => this.onmessage({data:{type:"ready", requestId:message.requestId}}));
        return;
      }
      if(message.type === "solve" && this.index === 0){
        queueMicrotask(() => {
          fastCandidateDelivered = true;
          this.onmessage({data:{
            type:"result",
            requestId:message.requestId,
            frame:{
              protocol:"tkb-reference-solver-stdio-v1",
              status:200,
              payload:improved
            }
          }});
        });
      }
      // Worker 1 intentionally never responds. The soft Stop must not wait for it.
    }
    terminate(){ terminated += 1; }
  }

  const fetch = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if(pathname.endsWith("/status")) return response({ok:true, online:false});
    if(pathname.endsWith("/hello")) return response({ok:true, workerToken:"q".repeat(48)});
    if(pathname.endsWith("/lease") && !leaseIssued){
      leaseIssued = true;
      return response({ok:true, lease:{
        jobId:"job-soft-stop-portfolio",
        leaseId:"lease-soft-stop-portfolio",
        payload:canonical
      }});
    }
    if(pathname.endsWith("/candidate") || pathname.endsWith("/checkpoint")){
      submissionPaths.push(pathname);
      submittedResult = JSON.parse(options.body).result;
      return response({ok:true, candidateId:"candidate-soft-stop", sha256:"digest-soft-stop"});
    }
    if(pathname.endsWith("/complete")){
      completeSeen = true;
      return response({ok:true, completed:true});
    }
    if(pathname.endsWith("/fail")) return response({ok:true, requeued:true});
    if(pathname.endsWith("/disconnect")) return response({ok:true, disconnected:true});
    if(pathname.endsWith("/lease")) return new Promise(() => {});
    throw new Error(`unexpected request ${pathname}`);
  };

  const {context} = executorContext({
    navigator:{
      platform:"Win32",
      userAgent:"Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      hardwareConcurrency:3,
      maxTouchPoints:0
    },
    fetch,
    Worker:StaggeredWorker
  });
  assert.equal(await context.TKBBrowserWasmExecutor.probe({
    apiBase:"https://tkbcherry.com",
    request:canonical
  }), true);
  assert.equal(await context.TKBBrowserWasmExecutor.activate({
    apiBase:"https://tkbcherry.com",
    jobId:"job-soft-stop-portfolio",
    request:canonical
  }), true);
  for(let index = 0; index < 50 && !fastCandidateDelivered; index += 1){
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal(fastCandidateDelivered, true);
  for(let index = 0; index < 20 && !submittedResult; index += 1){
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal(
    submittedResult?.candidateMarker,
    "fast-improvement",
    "each completed strict-best worker must checkpoint before slower workers finish"
  );
  assert.deepEqual(
    submissionPaths,
    ["/api/agent-helper/v1/leases/lease-soft-stop-portfolio/checkpoint"]
  );

  const stopStartedAt = Date.now();
  const stopped = await context.TKBBrowserWasmExecutor.stopAndSubmitBest({
    jobId:"job-soft-stop-portfolio"
  });
  assert.ok(Date.now() - stopStartedAt < 100, "Stop must not wait for a hanging worker");
  assert.equal(stopped.handled, true);
  assert.equal(stopped.submitted, true);
  assert.equal(submittedResult?.candidateMarker, "fast-improvement");
  assert.equal(terminated, 2, "all portfolio workers must stop consuming CPU");
  assert.equal(completeSeen, false, "the canonical server Stop owns terminal completion");
  await context.TKBBrowserWasmExecutor.close("test_finished", {failLease:false});
});

test("quick completion bypasses browser quality portfolios", () => {
  const canonical = completeRefinementRequest();
  Object.assign(canonical.settings, {
    optimization_focus:"quick_complete",
    max_one_period_sessions:"off",
    strict_one_period_sessions_cap:false,
    enforce_max_one_period_sessions:false,
    period_max_teacher_gap:"off"
  });
  const {context} = executorContext();
  assert.equal(context.TKBBrowserWasmExecutor.canHandleRequest(canonical), false);
  assert.equal(context.TKBBrowserWasmExecutor.refinementRequestClone(canonical), null);
});

test("temporary session gap debt does not relax automatic or gap-only envelopes", async () => {
  for(const focus of ["automatic", "gaps"]){
    const canonical = completeRefinementRequest();
    canonical.settings.optimization_focus = focus;
    const incumbentWire = JSON.stringify(canonical.data.tkbSolverResult);
    const gap2Regression = completePortfolioCandidate(canonical, `${focus}-gap2-regression`, {
      teacher_sessions:459,
      one_period_teacher_sessions:0,
      teacher_gap2_sessions:1,
      gap_distribution:{"0":458, "2":1},
      gap_total:2
    });
    const {submittedResult, failures} = await exercisePortfolioCandidates(
      canonical,
      [gap2Regression],
      {
        platform:"Linux armv8l",
        userAgent:"Mozilla/5.0 (Linux; Android 15; Mobile)",
        hardwareConcurrency:2,
        maxTouchPoints:5
      }
    );
    assert.equal(JSON.stringify(submittedResult), incumbentWire, `${focus}: ${JSON.stringify(failures)}`);
  }
});

test("sessions portfolio accepts temporary gap debt only for a real session reduction", async () => {
  const canonical = completeRefinementRequest();
  canonical.settings.optimization_focus = "sessions";
  const reducedSessions = completePortfolioCandidate(canonical, "sessions-reduced", {
    teacher_sessions:459,
    one_period_teacher_sessions:0,
    teacher_gap2_sessions:2,
    gap_distribution:{"0":457, "2":2},
    gap_total:4
  });
  const equalSessions = completePortfolioCandidate(canonical, "sessions-equal", {
    teacher_sessions:460,
    one_period_teacher_sessions:0,
    teacher_gap2_sessions:1,
    gap_distribution:{"0":459, "2":1},
    gap_total:2
  });

  const {submittedResult, failures} = await exercisePortfolioCandidates(
    canonical,
    [equalSessions, reducedSessions],
    {
      platform:"Linux x86_64",
      userAgent:"Mozilla/5.0 (X11; Linux x86_64)",
      hardwareConcurrency:3,
      maxTouchPoints:0
    }
  );

  assert.equal(submittedResult?.candidateMarker, "sessions-reduced", JSON.stringify(failures));
  assert.equal(submittedResult?.metrics?.teacher_gap2_sessions, 2);
});

test("singleton portfolio may add gap debt only when it removes singleton debt", async () => {
  const canonical = completeRefinementRequest();
  Object.assign(canonical.settings, {
    optimization_focus:"singletons",
    max_one_period_sessions:0,
    strict_one_period_sessions_cap:true,
    period_max_teacher_gap:"off"
  });
  Object.assign(canonical.data.tkbSolverResult.metrics, {
    teacher_sessions:460,
    one_period_teacher_sessions:1,
    teacher_gap2_sessions:0,
    gap_distribution:{"0":460},
    gap_total:0
  });
  const cleaned = completePortfolioCandidate(canonical, "singletons-cleaned", {
    teacher_sessions:460,
    one_period_teacher_sessions:0,
    teacher_gap2_sessions:1,
    gap_distribution:{"0":459, "2":1},
    gap_total:2
  });
  const cleanedWithFewerSessions = completePortfolioCandidate(canonical, "singletons-cleaned-fewer-sessions", {
    teacher_sessions:459,
    one_period_teacher_sessions:0,
    teacher_gap2_sessions:2,
    gap_distribution:{"0":457, "2":2},
    gap_total:4
  });

  const {submittedResult, failures} = await exercisePortfolioCandidates(
    canonical,
    [cleaned, cleanedWithFewerSessions],
    {
      platform:"Linux armv8l",
      userAgent:"Mozilla/5.0 (Linux; Android 15; Mobile)",
      hardwareConcurrency:3,
      maxTouchPoints:5
    }
  );

  assert.equal(submittedResult?.candidateMarker, "singletons-cleaned-fewer-sessions", JSON.stringify(failures));
});

test("portfolio treats an omitted gap-1 bucket as zero and derives total gap", async () => {
  const canonical = completeRefinementRequest();
  const derivedZero = completePortfolioCandidate(canonical, "derived-zero-gap", {
    teacher_gap2_sessions:undefined,
    gap_distribution:{"0":460},
    gap_total:undefined
  });
  const explicitOne = completePortfolioCandidate(canonical, "explicit-one-gap", {
    gap_distribution:{"0":459, "1":1},
    gap_total:1
  });
  const {submittedResult, failures} = await exercisePortfolioCandidates(
    canonical,
    [derivedZero, explicitOne],
    {
      platform:"iPhone",
      userAgent:"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
      hardwareConcurrency:3,
      maxTouchPoints:5
    }
  );
  assert.equal(submittedResult?.candidateMarker, "derived-zero-gap", JSON.stringify(failures));
});

test("portfolio submits the incumbent when every hard-valid candidate regresses a visible metric", async () => {
  const canonical = completeRefinementRequest();
  const incumbentWire = JSON.stringify(canonical.data.tkbSolverResult);
  const worseGap = completePortfolioCandidate(canonical, "worse-gap", {
    gap_distribution:{"0":419, "1":41},
    gap_total:41
  });
  const worseSessions = completePortfolioCandidate(canonical, "worse-sessions", {
    teacher_sessions:461,
    gap_distribution:{"0":422, "1":39},
    gap_total:39
  });
  const {submittedResult, failures} = await exercisePortfolioCandidates(
    canonical,
    [worseGap, worseSessions],
    {
      platform:"Linux armv8l",
      userAgent:"Mozilla/5.0 (Linux; Android 15; Mobile)",
      hardwareConcurrency:3,
      maxTouchPoints:5
    }
  );
  assert.equal(JSON.stringify(submittedResult), incumbentWire, JSON.stringify(failures));
  assert.equal(submittedResult?.candidateMarker, undefined);
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
  assert.match(page, /tkb-browser-wasm\.js\?v=20260724-v174-responsive-stop-preflight-v5/);
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
