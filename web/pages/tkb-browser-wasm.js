(function(root){
  "use strict";

  const VERSION = "tkb-browser-wasm-executor-v3-ios-foreground";
  const AGENT_PROTOCOL = "tkb-agent-helper-v1";
  const AGENT_VERSION = "1.6.29";
  const SOLVER_PROTOCOL = "tkb-reference-solver-stdio-v1";
  const DIGEST_PROTOCOL = "tkb-json-tree-sha256-v1";
  const WORKER_URL = `tkb-browser-wasm-worker.js?v=${encodeURIComponent(VERSION)}`;
  const WASM_URL = `tkb_native_solver.wasm?v=${encodeURIComponent(VERSION)}`;
  const HEARTBEAT_MS = 8000;
  const MAX_DIGEST_BYTES = 96 * 1024 * 1024;

  const state = {
    active:false,
    apiBase:"",
    authHeaders:{},
    worker:null,
    workerToken:"",
    agentId:"",
    jobId:"",
    leaseMs:30000,
    lease:null,
    generation:0,
    requestCounter:0,
    waiters:new Map(),
    heartbeatTimer:0,
    leaseWatchdogTimer:0,
    heartbeatInflight:false,
    probed:false,
    probePromise:null,
    activationPromise:null,
    closePromise:null,
    loopPromise:null,
    pendingFetches:new Set()
  };

  const encoder = new TextEncoder();

  function isSupportedNavigator(deviceNavigator){
    const nav = deviceNavigator || {};
    const uaData = nav.userAgentData && typeof nav.userAgentData === "object"
      ? nav.userAgentData
      : {};
    const platform = String(uaData.platform || nav.platform || "");
    const userAgent = String(nav.userAgent || "");
    const touchPoints = Number(nav.maxTouchPoints || 0);
    const iPadDesktopMode = /MacIntel/i.test(platform) && touchPoints > 1;
    const isiOS = /iPhone|iPad|iPod/i.test(userAgent) || iPadDesktopMode;
    const windows = /Windows/i.test(platform) || /Windows NT/i.test(userAgent);
    const android = uaData.platform === "Android" || /Android/i.test(userAgent);
    const macOS = (/Mac/i.test(platform) || /Macintosh|Mac OS X/i.test(userAgent))
      && !iPadDesktopMode;
    return windows || android || macOS || isiOS;
  }

  function runtimeSupported(){
    return isSupportedNavigator(root.navigator)
      && root.document?.visibilityState !== "hidden"
      && typeof root.Worker === "function"
      && typeof root.WebAssembly === "object"
      && typeof root.BigInt === "function"
      && typeof root.TextEncoder === "function"
      && !!root.crypto?.subtle
      && typeof root.fetch === "function";
  }

  function isCompleteRefinementRequest(request){
    if(!request || typeof request !== "object" || Array.isArray(request)) return false;
    const data = request.data;
    const settings = request.settings;
    if(
      !data
      || typeof data !== "object"
      || Array.isArray(data)
      || !settings
      || typeof settings !== "object"
      || Array.isArray(settings)
    ) return false;
    const solveKind = String(settings.ui_unified_solve_kind || "")
      .trim()
      .toLowerCase()
      .replace(/-/g, "_");
    if(
      solveKind !== "refine_complete"
      || settings.ui_use_existing_complete_incumbent !== true
      || settings.ui_existing_incumbent_revalidated !== true
    ) return false;
    const incumbent = data.tkbSolverResult;
    const metrics = incumbent?.metrics;
    const lessons = incumbent?.lessons;
    if(
      !incumbent
      || typeof incumbent !== "object"
      || Array.isArray(incumbent)
      || !metrics
      || typeof metrics !== "object"
      || Array.isArray(metrics)
      || !Array.isArray(lessons)
    ) return false;
    const expected = metrics.expected_periods;
    const scheduled = metrics.scheduled_periods;
    const unassigned = metrics.unassigned_periods;
    const violations = metrics.app_constraint_violation_count;
    return Number.isSafeInteger(expected)
      && expected > 0
      && Number.isSafeInteger(scheduled)
      && scheduled === expected
      && lessons.length === expected
      && unassigned === 0
      && metrics.hard_ok === true
      && violations === 0;
  }

  function browserRefinementRequest(request){
    if(!isCompleteRefinementRequest(request)) return null;
    let cloned;
    try{
      cloned = JSON.parse(JSON.stringify(request));
    }catch(_){
      return null;
    }
    if(!isCompleteRefinementRequest(cloned)) return null;
    cloned.settings.optimize_existing_schedule = true;
    cloned.settings.existing_fill_missing_schedule = false;
    cloned.settings.preserve_existing_tkb = true;
    cloned.settings.preserve_existing_min_ratio = 1;
    cloned.settings.preserve_fixed_lessons_only = true;
    cloned.settings.partial_existing_rebuild = false;
    cloned.settings.repair_fill_first = false;
    cloned.settings.repair_partial_existing = false;
    cloned.settings.require_complete_schedule = true;
    cloned.settings.best_effort_on_timeout = false;
    cloned.settings.ui_return_complete_incumbent_on_existing_optimize_failure = true;
    return cloned;
  }

  function sameOriginApiBase(value){
    try{
      const current = new URL(String(root.location?.href || "http://localhost/"));
      const target = new URL(String(value || current.origin), current.origin);
      return target.origin === current.origin ? target.origin : "";
    }catch(_){
      return "";
    }
  }

  function authHeaders(){
    try{
      const headers = root.TKBAuthApi?.getAuthHeaders?.({"Accept":"application/json"}) || {};
      const authorization = headers.Authorization || headers.authorization || "";
      return authorization
        ? {"Accept":"application/json", "Authorization":String(authorization)}
        : {"Accept":"application/json"};
    }catch(_){
      return {"Accept":"application/json"};
    }
  }

  function randomId(prefix){
    try{
      if(typeof root.crypto?.randomUUID === "function"){
        return `${prefix}${root.crypto.randomUUID().replace(/-/g, "")}`;
      }
      const bytes = new Uint8Array(16);
      root.crypto.getRandomValues(bytes);
      return prefix + Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
    }catch(_){
      return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    }
  }

  function browserAgentId(){
    if(state.agentId) return state.agentId;
    const key = "TKB_BROWSER_WASM_AGENT_ID_V1";
    try{
      const stored = String(root.sessionStorage?.getItem(key) || "");
      if(/^web-[a-z0-9]{12,64}$/.test(stored)) state.agentId = stored;
      if(!state.agentId){
        state.agentId = randomId("web-").slice(0, 68);
        root.sessionStorage?.setItem(key, state.agentId);
      }
    }catch(_){
      state.agentId = randomId("web-").slice(0, 68);
    }
    return state.agentId;
  }

  function agentWire(){
    return {
      agentId:browserAgentId(),
      version:AGENT_VERSION,
      platform:"web-wasm"
    };
  }

  async function fetchJson(path, body, options){
    const opts = options && typeof options === "object" ? options : {};
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const pendingFetch = {controller, timeout:0};
    const externalSignal = opts.signal && typeof opts.signal === "object" ? opts.signal : null;
    const abortFromExternal = () => controller?.abort();
    if(externalSignal?.aborted){
      const error = new Error("browser_wasm_aborted");
      error.name = "AbortError";
      throw error;
    }
    externalSignal?.addEventListener?.("abort", abortFromExternal, {once:true});
    if(controller) state.pendingFetches.add(pendingFetch);
    const timeout = controller
      ? root.setTimeout(() => controller.abort(), Math.max(500, Number(opts.timeoutMs || 5000)))
      : 0;
    pendingFetch.timeout = timeout;
    try{
      const response = await root.fetch(`${state.apiBase}${path}`, {
        method:body == null ? "GET" : "POST",
        headers:body == null
          ? Object.assign({}, state.authHeaders)
          : Object.assign({}, state.authHeaders, {"Content-Type":"application/json"}),
        ...(body == null ? {} : {body:JSON.stringify(body)}),
        cache:"no-store",
        keepalive:opts.keepalive === true,
        ...(controller ? {signal:controller.signal} : (externalSignal ? {signal:externalSignal} : {}))
      });
      const payload = await response.json().catch(() => ({}));
      if(!response.ok || payload?.ok !== true){
        const error = new Error(String(payload?.kind || payload?.error || `http_${response.status}`));
        error.status = response.status;
        throw error;
      }
      return payload;
    }finally{
      if(timeout) root.clearTimeout(timeout);
      if(controller) state.pendingFetches.delete(pendingFetch);
      externalSignal?.removeEventListener?.("abort", abortFromExternal);
    }
  }

  function abortPendingFetches(){
    for(const pending of Array.from(state.pendingFetches)){
      if(pending.timeout) root.clearTimeout(pending.timeout);
      try{ pending.controller?.abort(); }catch(_){ }
    }
    state.pendingFetches.clear();
  }

  function workerRequest(type, payload, timeoutMs, signal){
    if(!state.worker) return Promise.reject(new Error("browser_wasm_worker_missing"));
    const requestId = `${Date.now().toString(36)}-${++state.requestCounter}`;
    return new Promise((resolve, reject) => {
      if(signal?.aborted){
        const error = new Error("browser_wasm_aborted");
        error.name = "AbortError";
        reject(error);
        return;
      }
      const timer = root.setTimeout(() => {
        state.waiters.delete(requestId);
        signal?.removeEventListener?.("abort", onAbort);
        reject(new Error("browser_wasm_worker_timeout"));
      }, Math.max(1000, Number(timeoutMs || 8000)));
      const onAbort = () => {
        const waiter = state.waiters.get(requestId);
        if(!waiter) return;
        state.waiters.delete(requestId);
        root.clearTimeout(timer);
        const error = new Error("browser_wasm_aborted");
        error.name = "AbortError";
        reject(error);
      };
      signal?.addEventListener?.("abort", onAbort, {once:true});
      state.waiters.set(requestId, {resolve, reject, timer, signal, onAbort});
      state.worker.postMessage(Object.assign({type, requestId, wasmUrl:WASM_URL}, payload || {}));
    });
  }

  function settleWorkerMessage(message){
    const requestId = String(message?.requestId || "");
    const waiter = state.waiters.get(requestId);
    if(!waiter) return;
    state.waiters.delete(requestId);
    root.clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener?.("abort", waiter.onAbort);
    if(message.type === "error") waiter.reject(new Error(String(message.error || "browser_wasm_failed")));
    else waiter.resolve(message);
  }

  function rejectWorkerWaiters(error){
    for(const waiter of state.waiters.values()){
      root.clearTimeout(waiter.timer);
      waiter.signal?.removeEventListener?.("abort", waiter.onAbort);
      try{ waiter.reject(error); }catch(_){ }
    }
    state.waiters.clear();
  }

  async function startComputeWorker(signal){
    if(state.worker) return true;
    const worker = new root.Worker(WORKER_URL);
    state.worker = worker;
    worker.onmessage = event => settleWorkerMessage(event?.data || {});
    worker.onerror = () => rejectWorkerWaiters(new Error("browser_wasm_worker_crashed"));
    await workerRequest("probe", {}, 8000, signal);
    return true;
  }

  function writeU64(view, offset, value){
    const safe = Math.max(0, Number(value || 0));
    const high = Math.floor(safe / 0x100000000);
    const low = safe >>> 0;
    view.setUint32(offset, high >>> 0, false);
    view.setUint32(offset + 4, low, false);
  }

  function utf8Compare(left, right){
    const a = encoder.encode(left);
    const b = encoder.encode(right);
    const length = Math.min(a.length, b.length);
    for(let index = 0; index < length; index++){
      if(a[index] !== b[index]) return a[index] - b[index];
    }
    return a.length - b.length;
  }

  function numberKind(value){
    const encoded = JSON.stringify(value);
    if(!encoded || encoded === "null") throw new Error("browser_wasm_digest_number_invalid");
    return /^-?(?:0|[1-9][0-9]*)$/.test(encoded) ? ["I", encoded] : ["D", encoded];
  }

  function digestSize(value){
    if(value == null || value === true || value === false) return 1;
    if(typeof value === "string") return 9 + encoder.encode(value).length;
    if(typeof value === "number"){
      const [kind, encoded] = numberKind(value);
      return kind === "I" ? 9 + encoded.length : 9;
    }
    if(Array.isArray(value)){
      return 9 + value.reduce((total, item) => total + digestSize(item), 0);
    }
    if(typeof value === "object"){
      return 9 + Object.keys(value).reduce(
        (total, key) => total + digestSize(key) + digestSize(value[key]),
        0
      );
    }
    throw new Error("browser_wasm_digest_value_invalid");
  }

  function writeDigestValue(target, view, offset, value){
    if(value == null){ target[offset] = 78; return offset + 1; }
    if(value === true){ target[offset] = 84; return offset + 1; }
    if(value === false){ target[offset] = 70; return offset + 1; }
    if(typeof value === "string"){
      const bytes = encoder.encode(value);
      target[offset++] = 83;
      writeU64(view, offset, bytes.length);
      offset += 8;
      target.set(bytes, offset);
      return offset + bytes.length;
    }
    if(typeof value === "number"){
      const [kind, encoded] = numberKind(value);
      target[offset++] = kind.charCodeAt(0);
      if(kind === "I"){
        const bytes = encoder.encode(encoded);
        writeU64(view, offset, bytes.length);
        offset += 8;
        target.set(bytes, offset);
        return offset + bytes.length;
      }
      view.setFloat64(offset, value, false);
      return offset + 8;
    }
    if(Array.isArray(value)){
      target[offset++] = 76;
      writeU64(view, offset, value.length);
      offset += 8;
      for(const item of value) offset = writeDigestValue(target, view, offset, item);
      return offset;
    }
    if(typeof value === "object"){
      const keys = Object.keys(value).sort(utf8Compare);
      target[offset++] = 79;
      writeU64(view, offset, keys.length);
      offset += 8;
      for(const key of keys){
        offset = writeDigestValue(target, view, offset, key);
        offset = writeDigestValue(target, view, offset, value[key]);
      }
      return offset;
    }
    throw new Error("browser_wasm_digest_value_invalid");
  }

  async function resultDigest(result){
    const prefix = encoder.encode(`${DIGEST_PROTOCOL}\0`);
    const treeSize = digestSize(result);
    if(treeSize <= 0 || treeSize + prefix.length > MAX_DIGEST_BYTES){
      throw new Error("browser_wasm_digest_size_invalid");
    }
    const bytes = new Uint8Array(prefix.length + treeSize);
    bytes.set(prefix, 0);
    const view = new DataView(bytes.buffer);
    const end = writeDigestValue(bytes, view, prefix.length, result);
    if(end !== bytes.length) throw new Error("browser_wasm_digest_length_mismatch");
    const digest = new Uint8Array(await root.crypto.subtle.digest("SHA-256", bytes));
    return Array.from(digest, value => value.toString(16).padStart(2, "0")).join("");
  }

  function clearHeartbeat(){
    if(state.heartbeatTimer) root.clearInterval(state.heartbeatTimer);
    if(state.leaseWatchdogTimer) root.clearInterval(state.leaseWatchdogTimer);
    state.heartbeatTimer = 0;
    state.leaseWatchdogTimer = 0;
    state.heartbeatInflight = false;
  }

  function leaseDeadlineReached(generation){
    if(!state.active || state.generation !== generation || !state.lease) return false;
    const expiresAt = Number(state.lease.localExpiresAtMs || 0);
    if(!expiresAt || Date.now() < expiresAt - 500) return false;
    void closeExecutor("lease_expired", {failLease:false});
    return true;
  }

  async function heartbeatLease(generation){
    if(
      !state.active
      || state.generation !== generation
      || !state.lease
      || state.heartbeatInflight
    ) return;
    state.heartbeatInflight = true;
    const lease = state.lease;
    try{
      const payload = await fetchJson(
        `/api/agent-helper/v1/leases/${encodeURIComponent(lease.leaseId)}/heartbeat`,
        {
          protocol:AGENT_PROTOCOL,
          agentId:browserAgentId(),
          workerToken:state.workerToken,
          jobId:lease.jobId,
          leaseId:lease.leaseId,
          phase:"solving"
        },
        {timeoutMs:5000}
      );
      if(payload.cancel === true || payload.renewed !== true){
        void closeExecutor("lease_lost", {failLease:false});
      }else if(state.lease === lease){
        lease.localExpiresAtMs = Date.now() + state.leaseMs;
      }
    }catch(error){
      const status = Number(error?.status || 0);
      if(status >= 400 && status < 500){
        void closeExecutor("lease_rejected", {failLease:false});
      }else{
        leaseDeadlineReached(generation);
      }
      // A transient network error does not create a second executor. The
      // server lease expires and its generation fence decides ownership.
    }finally{
      state.heartbeatInflight = false;
    }
  }

  function startHeartbeat(generation){
    clearHeartbeat();
    state.heartbeatTimer = root.setInterval(() => {
      void heartbeatLease(generation);
    }, HEARTBEAT_MS);
    state.leaseWatchdogTimer = root.setInterval(() => {
      leaseDeadlineReached(generation);
    }, 500);
  }

  async function failLease(lease, token, kind, keepalive){
    if(!lease || !token) return false;
    try{
      await fetchJson(
        `/api/agent-helper/v1/leases/${encodeURIComponent(lease.leaseId)}/fail`,
        {
          protocol:AGENT_PROTOCOL,
          agentId:browserAgentId(),
          workerToken:token,
          jobId:lease.jobId,
          leaseId:lease.leaseId,
          kind:String(kind || "browser_wasm_stopped").slice(0, 64),
          message:"Browser WASM executor stopped; VPS may resume."
        },
        {timeoutMs:3000, keepalive:keepalive === true}
      );
      return true;
    }catch(_){
      return false;
    }
  }

  async function disconnectToken(token, keepalive){
    if(!token) return false;
    try{
      await fetchJson("/api/agent-helper/v1/disconnect", {
        protocol:AGENT_PROTOCOL,
        agentId:browserAgentId(),
        workerToken:token
      }, {timeoutMs:3000, keepalive:keepalive === true});
      return true;
    }catch(_){
      return false;
    }
  }

  async function runLease(lease, generation, signal){
    lease.localExpiresAtMs = Date.now() + state.leaseMs;
    state.lease = lease;
    startHeartbeat(generation);
    try{
      const refinementRequest = browserRefinementRequest(lease.payload);
      if(!refinementRequest){
        await failLease(lease, state.workerToken, "browser_wasm_ineligible_request", false);
        return false;
      }
      const resultMessage = await workerRequest(
        "solve",
        {payload:refinementRequest},
        31 * 60 * 1000,
        signal
      );
      if(!state.active || state.generation !== generation || state.lease !== lease){
        return false;
      }
      const frame = resultMessage?.frame;
      const status = Number(frame?.status || 0);
      const result = frame?.payload;
      if(
        frame?.protocol !== SOLVER_PROTOCOL
        || !Number.isInteger(status)
        || status < 200
        || status >= 300
        || !result
        || typeof result !== "object"
        || Array.isArray(result)
      ){
        await failLease(lease, state.workerToken, "browser_wasm_no_candidate", false);
        return false;
      }
      const digest = await resultDigest(result);
      const candidate = await fetchJson(
        `/api/agent-helper/v1/leases/${encodeURIComponent(lease.leaseId)}/candidate`,
        {
          protocol:AGENT_PROTOCOL,
          agentId:browserAgentId(),
          workerToken:state.workerToken,
          jobId:lease.jobId,
          leaseId:lease.leaseId,
          sha256:digest,
          digestProtocol:DIGEST_PROTOCOL,
          solverProtocol:SOLVER_PROTOCOL,
          solverStatus:status,
          result
        },
        {timeoutMs:30000}
      );
      await fetchJson(
        `/api/agent-helper/v1/leases/${encodeURIComponent(lease.leaseId)}/complete`,
        {
          protocol:AGENT_PROTOCOL,
          agentId:browserAgentId(),
          workerToken:state.workerToken,
          jobId:lease.jobId,
          leaseId:lease.leaseId,
          candidateId:candidate.candidateId,
          sha256:candidate.sha256,
          solverStatus:status
        },
        {timeoutMs:5000}
      );
      return true;
    }catch(_){
      if(state.active && state.generation === generation){
        await failLease(lease, state.workerToken, "browser_wasm_failed", false);
      }
      return false;
    }finally{
      clearHeartbeat();
      if(state.lease === lease) state.lease = null;
    }
  }

  async function claimLoop(generation, signal){
    try{
      while(
        state.active
        && state.generation === generation
        && !signal?.aborted
        && root.document?.visibilityState !== "hidden"
      ){
        const requestId = randomId("lease-").slice(0, 96);
        const payload = await fetchJson("/api/agent-helper/v1/lease", {
          protocol:AGENT_PROTOCOL,
          workerToken:state.workerToken,
          jobId:state.jobId,
          leaseRequestId:requestId,
          agent:agentWire(),
          capacity:{cpuWorkers:1, maxConcurrentJobs:1},
          waitSeconds:5
        }, {timeoutMs:11000, signal});
        const lease = payload?.lease;
        if(lease && lease.leaseId && lease.jobId && lease.payload){
          await runLease(lease, generation, signal);
          break;
        }
        const delay = Math.max(200, Math.min(3000, Number(payload?.retryAfterMs || 700) || 700));
        await new Promise(resolve => root.setTimeout(resolve, delay));
      }
    }catch(_){
      // Registration or transport failed. Disconnecting immediately lets the
      // canonical coordinator use VPS without waiting for the worker TTL.
    }finally{
      if(state.active && state.generation === generation){
        void closeExecutor("claim_loop_ended", {failLease:true});
      }
    }
  }

  async function probeExecutor(options){
    const opts = options && typeof options === "object" ? options : {};
    if(!isCompleteRefinementRequest(opts.request) || opts.signal?.aborted) return false;
    if(state.probed && state.worker) return true;
    if(state.probePromise) return state.probePromise;
    state.probePromise = (async () => {
      if(state.closePromise) await state.closePromise.catch(() => null);
      if(!runtimeSupported()) return false;
      const apiBase = sameOriginApiBase(opts.apiBase);
      if(!apiBase) return false;
      state.apiBase = apiBase;
      state.authHeaders = authHeaders();
      if(!state.authHeaders.Authorization) return false;
      if(opts.preferNativeAgent !== false){
        try{
          const status = await fetchJson("/api/agent-helper/v1/status", null, {
            timeoutMs:1800,
            signal:opts.signal
          });
          if(status.online === true) return false;
        }catch(_){ }
      }
      if(opts.signal?.aborted || root.document?.visibilityState === "hidden") return false;
      await startComputeWorker(opts.signal);
      state.probed = true;
      return true;
    })().catch(() => {
      try{ state.worker?.terminate?.(); }catch(_){ }
      state.worker = null;
      state.probed = false;
      return false;
    }).finally(() => {
      state.probePromise = null;
    });
    return state.probePromise;
  }

  async function activateExecutor(options){
    const opts = options && typeof options === "object" ? options : {};
    if(!isCompleteRefinementRequest(opts.request) || opts.signal?.aborted) return false;
    const jobId = String(opts.jobId || "").trim();
    if(!jobId || jobId.length > 256) return false;
    if(state.active && state.workerToken) return state.jobId === jobId;
    if(state.activationPromise) return state.activationPromise;
    state.activationPromise = (async () => {
      const activationFence = state.generation;
      if(!state.probed || !state.worker){
        const probed = await probeExecutor(opts);
        if(!probed) return false;
      }
      if(root.document?.visibilityState === "hidden") return false;
      const hello = await fetchJson("/api/agent-helper/v1/hello", {
        protocol:AGENT_PROTOCOL,
        jobId,
        agent:agentWire(),
        capacity:{cpuWorkers:1, maxConcurrentJobs:1}
      }, {timeoutMs:4000, signal:opts.signal});
      const workerToken = String(hello?.workerToken || "");
      if(workerToken.length < 32 || workerToken.length > 512){
        throw new Error("browser_wasm_worker_token_invalid");
      }
      if(
        state.generation !== activationFence
        || !state.worker
        || root.document?.visibilityState === "hidden"
      ){
        // pagehide may race the hello response. Revoke the just-issued token
        // instead of resurrecting a worker after the page already yielded to
        // VPS fallback.
        await disconnectToken(workerToken, true);
        return false;
      }
      state.workerToken = workerToken;
      state.jobId = jobId;
      state.leaseMs = Math.max(5000, Math.min(120000, Number(hello?.leaseMs || 30000) || 30000));
      state.active = true;
      const generation = ++state.generation;
      state.loopPromise = claimLoop(generation, opts.signal);
      return true;
    })().catch(() => {
      try{ state.worker?.terminate?.(); }catch(_){ }
      state.worker = null;
      state.workerToken = "";
      state.active = false;
      return false;
    }).finally(() => {
      state.activationPromise = null;
    });
    return state.activationPromise;
  }

  async function prepareExecutor(options){
    const probed = await probeExecutor(options);
    return probed ? activateExecutor(options) : false;
  }

  async function closeExecutor(reason, options){
    const opts = options && typeof options === "object" ? options : {};
    if(state.closePromise) return state.closePromise;
    const lease = state.lease;
    const token = state.workerToken;
    const keepalive = opts.keepalive === true;
    state.active = false;
    state.probed = false;
    state.generation += 1;
    state.lease = null;
    clearHeartbeat();
    abortPendingFetches();
    rejectWorkerWaiters(new Error(String(reason || "browser_wasm_closed")));
    try{ state.worker?.terminate?.(); }catch(_){ }
    state.worker = null;
    state.workerToken = "";
    state.jobId = "";
    state.closePromise = (async () => {
      if(opts.failLease !== false) await failLease(lease, token, reason, keepalive);
      await disconnectToken(token, keepalive);
      return true;
    })().finally(() => {
      state.closePromise = null;
    });
    return state.closePromise;
  }

  function stopForBackground(){
    if(
      !state.active
      && !state.workerToken
      && !state.worker
      && !state.probed
      && state.pendingFetches.size === 0
    ) return false;
    void closeExecutor("browser_hidden", {failLease:true, keepalive:true});
    return true;
  }

  try{
    root.document?.addEventListener?.("visibilitychange", () => {
      if(root.document.visibilityState === "hidden") stopForBackground();
    });
    root.addEventListener?.("pagehide", stopForBackground);
  }catch(_){ }

  root.TKBBrowserWasmExecutor = {
    version:VERSION,
    isSupportedNavigator,
    canHandleRequest:isCompleteRefinementRequest,
    refinementRequestClone:browserRefinementRequest,
    probe:probeExecutor,
    activate:activateExecutor,
    prepare:prepareExecutor,
    close:closeExecutor,
    stopForBackground,
    resultDigest,
    state:() => ({
      active:state.active,
      probed:state.probed,
      hasWorker:!!state.worker,
      hasLease:!!state.lease,
      jobId:state.jobId
    })
  };
})(typeof window !== "undefined" ? window : globalThis);
