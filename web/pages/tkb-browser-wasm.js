(function(root){
  "use strict";

  const VERSION = "tkb-browser-wasm-executor-v18-session-gap-quality";
  const AGENT_PROTOCOL = "tkb-agent-helper-v1";
  const AGENT_VERSION = "1.6.31";
  const SOLVER_PROTOCOL = "tkb-reference-solver-stdio-v1";
  const DIGEST_PROTOCOL = "tkb-json-tree-sha256-v1";
  const WORKER_URL = `tkb-browser-wasm-worker.js?v=${encodeURIComponent(VERSION)}`;
  const WASM_URL = `tkb_native_solver.wasm?v=${encodeURIComponent(VERSION)}`;
  const HEARTBEAT_MS = 8000;
  const MAX_DIGEST_BYTES = 96 * 1024 * 1024;
  const ENABLED_STORAGE_KEY = "TKB_BROWSER_WASM_ENABLED_V1";
  const QUICK_LOCAL_ATTEMPT_MS = 12000;
  const QUICK_LOCAL_RESERVE_MS = 750;
  const FOCUSED_LOCAL_ATTEMPT_MS = 60000;
  const DEEP_SESSION_LOCAL_ATTEMPT_MS = 180000;
  const DEEP_SESSION_WAVE_MS = 15000;
  const DEEP_SESSION_MAX_WAVES = 16;
  const SINGLETON_WAVE_MS = 10000;
  const SINGLETON_MAX_WAVES = 6;
  const GAP_WAVE_MS = 15000;
  const GAP_MAX_WAVES = 4;
  const QUICK_WORKER_SETTLE_RESERVE_MS = 3000;
  const FOCUSED_WORKER_SETTLE_RESERVE_MS = 15000;

  const state = {
    active:false,
    apiBase:"",
    authHeaders:{},
    worker:null,
    workers:[],
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
    leaseRun:null,
    pendingFetches:new Set(),
    enabledOverride:null,
    computeActive:false,
    localComputeRuns:0,
    localAcceptedResults:0,
    workerCeiling:0,
    plannedWorkerCount:0,
    lastComputeWorkerCount:0,
    lastComputeStartedAtMs:0,
    lastComputeFinishedAtMs:0,
    lastAcceptedResultAtMs:0
  };

  const encoder = new TextEncoder();

  function isIOSNavigator(deviceNavigator){
    const nav = deviceNavigator || {};
    const platform = String(nav.userAgentData?.platform || nav.platform || "");
    const userAgent = String(nav.userAgent || "");
    return /iPhone|iPad|iPod/i.test(userAgent)
      || (/MacIntel/i.test(platform) && Number(nav.maxTouchPoints || 0) > 1);
  }

  function browserAgentEnabled(){
    if(typeof state.enabledOverride === "boolean") return state.enabledOverride;
    try{ return root.localStorage?.getItem(ENABLED_STORAGE_KEY) !== "0"; }
    catch(_){ return true; }
  }

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
    const linux = /Linux/i.test(platform) || /Linux|X11/i.test(userAgent);
    const macOS = (/Mac/i.test(platform) || /Macintosh|Mac OS X/i.test(userAgent))
      && !iPadDesktopMode;
    return windows || android || macOS || isiOS || (linux && !android);
  }

  function runtimeCapable(){
    return isSupportedNavigator(root.navigator)
      && root.document?.visibilityState !== "hidden"
      && typeof root.Worker === "function"
      && typeof root.WebAssembly === "object"
      && typeof root.BigInt === "function"
      && typeof root.TextEncoder === "function"
      && !!root.crypto?.subtle
      && typeof root.fetch === "function";
  }

  function runtimeSupported(){
    return browserAgentEnabled() && runtimeCapable();
  }

  function portfolioWorkerCount(deviceNavigator){
    const nav = deviceNavigator || {};
    const reported = Number(nav.hardwareConcurrency);
    return Number.isFinite(reported) && reported > 0
      ? Math.max(1, Math.floor(reported))
      : 1;
  }

  function finiteWorkloadValue(value){
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0
      ? Math.max(1, Math.floor(numeric))
      : 0;
  }

  function requestWorkloadPeriods(request){
    const envelope = requestEnvelope(request);
    if(!envelope) return 0;
    const {data, settings} = envelope;
    const incumbent = data.tkbSolverResult;
    const metrics = incumbent?.metrics;
    const candidates = [
      settings.expected_scheduled_periods,
      metrics?.expected_periods,
      Array.isArray(incumbent?.lessons) ? incumbent.lessons.length : 0
    ];
    if(String(settings.ui_progress_metric_focus || "") === "scheduled_periods"){
      candidates.push(
        settings.ui_progress_metric_target,
        settings.ui_progress_metric_baseline,
        settings.ui_progress_metric_current
      );
    }
    const scheduled = finiteWorkloadValue(metrics?.scheduled_periods);
    const unassigned = finiteWorkloadValue(metrics?.unassigned_periods);
    if(scheduled || unassigned) candidates.push(scheduled + unassigned);
    return candidates.reduce(
      (maximum, value) => Math.max(maximum, finiteWorkloadValue(value)),
      0
    );
  }

  function adaptivePortfolioWorkerCount(request, deviceNavigator){
    const ceiling = portfolioWorkerCount(deviceNavigator);
    if(normalizedOptimizationFocus(request?.settings) !== "quick_complete"){
      // Quality search benefits from independent seeds. Keep the whole device
      // available for singleton, session, gap and coordinated refinement.
      return ceiling;
    }
    const periods = requestWorkloadPeriods(request);
    if(periods <= 0) return Math.min(4, ceiling);
    if(periods <= 128) return 1;
    if(periods <= 512) return Math.min(2, ceiling);
    if(periods <= 2000) return Math.min(4, ceiling);
    return Math.min(8, ceiling);
  }

  function requestEnvelope(request){
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
    return {data, settings};
  }

  function isQuickCompletionRequest(request){
    const envelope = requestEnvelope(request);
    return !!envelope && normalizedOptimizationFocus(envelope.settings) === "quick_complete";
  }

  function isCompleteRefinementRequest(request){
    const envelope = requestEnvelope(request);
    if(!envelope || normalizedOptimizationFocus(envelope.settings) === "quick_complete") return false;
    const {data, settings} = envelope;
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
      || incumbent?.validation?.hard_ok !== true
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

  function isBrowserAgentRequest(request){
    return isQuickCompletionRequest(request) || isCompleteRefinementRequest(request);
  }

  function capLocalDeadline(settings, key, maximum){
    const current = Number(settings[key]);
    settings[key] = Number.isFinite(current) && current > 0
      ? Math.min(Math.round(current), maximum)
      : maximum;
  }

  function browserRefinementRequest(request){
    if(!isBrowserAgentRequest(request)) return null;
    let cloned;
    try{
      cloned = JSON.parse(JSON.stringify(request));
    }catch(_){
      return null;
    }
    if(isQuickCompletionRequest(cloned)){
      const settings = cloned.settings;
      settings.require_complete_schedule = true;
      settings.best_effort_on_timeout = false;
      settings.native_skip_teacher_optimization = true;
      settings.browser_wasm_quick_attempt = true;
      capLocalDeadline(settings, "backend_deadline_ms", QUICK_LOCAL_ATTEMPT_MS);
      capLocalDeadline(settings, "native_global_deadline_ms", QUICK_LOCAL_ATTEMPT_MS);
      const requestedReserve = Number(settings.native_deadline_reserve_ms);
      settings.native_deadline_reserve_ms = Math.min(
        Number.isFinite(requestedReserve) && requestedReserve > 0
          ? Math.round(requestedReserve)
          : QUICK_LOCAL_RESERVE_MS,
        QUICK_LOCAL_RESERVE_MS
      );
      return isQuickCompletionRequest(cloned) ? cloned : null;
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
    const deepSessionSearch = normalizedOptimizationFocus(cloned.settings) === "sessions"
      && cloned.settings.browser_wasm_session_deep_search === true;
    const focusedMaximum = deepSessionSearch
      ? DEEP_SESSION_LOCAL_ATTEMPT_MS
      : FOCUSED_LOCAL_ATTEMPT_MS;
    capLocalDeadline(cloned.settings, "backend_deadline_ms", focusedMaximum);
    capLocalDeadline(cloned.settings, "native_global_deadline_ms", focusedMaximum);
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

  function workerRequestOn(worker, type, payload, timeoutMs, signal){
    if(!worker) return Promise.reject(new Error("browser_wasm_worker_missing"));
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
      state.waiters.set(requestId, {resolve, reject, timer, signal, onAbort, worker});
      try{
        worker.postMessage(Object.assign({type, requestId, wasmUrl:WASM_URL}, payload || {}));
      }catch(error){
        state.waiters.delete(requestId);
        root.clearTimeout(timer);
        signal?.removeEventListener?.("abort", onAbort);
        reject(error);
      }
    });
  }

  function workerRequest(type, payload, timeoutMs, signal){
    return workerRequestOn(state.worker, type, payload, timeoutMs, signal);
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

  function rejectWorkerWaiters(error, targetWorker){
    for(const [requestId, waiter] of Array.from(state.waiters.entries())){
      if(targetWorker && waiter.worker !== targetWorker) continue;
      state.waiters.delete(requestId);
      root.clearTimeout(waiter.timer);
      waiter.signal?.removeEventListener?.("abort", waiter.onAbort);
      try{ waiter.reject(error); }catch(_){ }
    }
    if(!targetWorker) state.waiters.clear();
  }

  function terminateComputeWorkers(){
    for(const worker of state.workers){
      try{ worker?.terminate?.(); }catch(_){ }
    }
    state.workers = [];
    state.worker = null;
  }

  function retireComputeWorker(worker, error){
    rejectWorkerWaiters(error || new Error("browser_wasm_worker_retired"), worker);
    state.workers = state.workers.filter(candidate => candidate !== worker);
    if(state.worker === worker) state.worker = state.workers[0] || null;
    try{ worker?.terminate?.(); }catch(_){ }
    publishRuntimeState();
  }

  function publicRuntimeState(){
    return {
      active:state.active,
      probed:state.probed,
      hasWorker:!!state.worker,
      workerCount:state.workers.length,
      hasLease:!!state.lease,
      computeActive:state.computeActive,
      localComputeRuns:state.localComputeRuns,
      localAcceptedResults:state.localAcceptedResults,
      workerCeiling:state.workerCeiling || portfolioWorkerCount(root.navigator),
      plannedWorkerCount:state.plannedWorkerCount,
      lastComputeWorkerCount:state.lastComputeWorkerCount,
      lastComputeStartedAtMs:state.lastComputeStartedAtMs,
      lastComputeFinishedAtMs:state.lastComputeFinishedAtMs,
      lastAcceptedResultAtMs:state.lastAcceptedResultAtMs,
      jobId:state.jobId,
      enabled:browserAgentEnabled(),
      available:runtimeCapable()
    };
  }

  function publishRuntimeState(){
    try{
      if(typeof root.CustomEvent !== "function" || typeof root.dispatchEvent !== "function") return;
      root.dispatchEvent(new root.CustomEvent("tkb-browser-agent-state", {
        detail:publicRuntimeState()
      }));
    }catch(_){ }
  }

  async function startComputeWorker(plannedWorkerCount, signal){
    if(state.workers.length) return true;
    const ceiling = portfolioWorkerCount(root.navigator);
    const count = Math.max(1, Math.min(
      ceiling,
      Math.floor(Number(plannedWorkerCount) || 1)
    ));
    state.workerCeiling = ceiling;
    state.plannedWorkerCount = count;
    const workers = [];
    state.workers = workers;
    try{
      for(let index = 0; index < count; index++){
        let worker;
        try{
          worker = new root.Worker(WORKER_URL);
        }catch(error){
          if(!workers.length) throw error;
          break;
        }
        workers.push(worker);
        worker.onmessage = event => settleWorkerMessage(event?.data || {});
        worker.onerror = () => rejectWorkerWaiters(
          new Error("browser_wasm_worker_crashed"),
          worker
        );
      }
      state.worker = workers[0] || null;
      const probes = await Promise.allSettled(workers.map(worker => (
        workerRequestOn(worker, "probe", {}, 8000, signal)
      )));
      const readyWorkers = workers.filter((worker, index) => {
        const ready = probes[index]?.status === "fulfilled";
        if(!ready){
          rejectWorkerWaiters(new Error("browser_wasm_worker_probe_failed"), worker);
          try{ worker.terminate(); }catch(_){ }
        }
        return ready;
      });
      if(!readyWorkers.length) throw new Error("browser_wasm_worker_probe_failed");
      state.workers = readyWorkers;
      state.worker = readyWorkers[0];
      publishRuntimeState();
    }catch(error){
      terminateComputeWorkers();
      rejectWorkerWaiters(error);
      throw error;
    }
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

  function nonnegativeMetric(metrics, key){
    const value = Number(metrics?.[key]);
    return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
  }

  function completeHardResult(result){
    const metrics = result?.metrics;
    const lessons = result?.lessons;
    if(
      !result
      || typeof result !== "object"
      || Array.isArray(result)
      || result.ok !== true
      || !metrics
      || typeof metrics !== "object"
      || Array.isArray(metrics)
      || !Array.isArray(lessons)
      || !Array.isArray(result.unassignedLessons)
      || result.unassignedLessons.length !== 0
      || result?.validation?.hard_ok !== true
    ) return false;
    const expected = Number(metrics.expected_periods);
    return Number.isSafeInteger(expected)
      && expected > 0
      && Number(metrics.scheduled_periods) === expected
      && lessons.length === expected
      && Number(metrics.unassigned_periods) === 0
      && metrics.hard_ok === true
      && Number(metrics.app_constraint_violation_count) === 0;
  }

  function qualityTupleFromResult(result){
    const metrics = result?.metrics;
    if(!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return null;
    const onePeriod = nonnegativeMetric(metrics, "one_period_teacher_sessions");
    let gap2 = nonnegativeMetric(metrics, "teacher_gap2_sessions");
    const teacherSessions = nonnegativeMetric(metrics, "teacher_sessions");
    const distribution = metrics.gap_distribution;
    if(!distribution || typeof distribution !== "object" || Array.isArray(distribution)) return null;
    const gap1 = Object.prototype.hasOwnProperty.call(distribution, "1")
      ? nonnegativeMetric(distribution, "1")
      : 0;
    let totalGap = nonnegativeMetric(metrics, "gap_total");
    if(gap2 == null){
      gap2 = Object.entries(distribution).reduce((total, [gap, count]) => {
        const numericGap = Number(gap);
        const numericCount = Number(count);
        return numericGap >= 2 && Number.isFinite(numericCount) && numericCount > 0
          ? total + Math.trunc(numericCount)
          : total;
      }, 0);
    }
    if(totalGap == null){
      totalGap = Object.entries(distribution).reduce((total, [gap, count]) => {
        const numericGap = Number(gap);
        const numericCount = Number(count);
        return numericGap >= 0 && Number.isFinite(numericCount) && numericCount > 0
          ? total + Math.trunc(numericGap) * Math.trunc(numericCount)
          : total;
      }, 0);
    }
    if([onePeriod, gap2, teacherSessions, gap1, totalGap].some(value => value == null)) return null;
    return [onePeriod, gap2, teacherSessions, gap1, totalGap];
  }

  function portfolioQualityFromResult(result, settings){
    if(normalizedOptimizationFocus(settings) !== "quick_complete"){
      return qualityTupleFromResult(result);
    }
    const metrics = result?.metrics;
    const scheduled = nonnegativeMetric(metrics, "scheduled_periods");
    const expected = nonnegativeMetric(metrics, "expected_periods");
    const unassigned = nonnegativeMetric(metrics, "unassigned_periods");
    const requestedTarget = nonnegativeMetric(settings, "ui_progress_metric_target");
    if(
      scheduled == null
      || expected == null
      || unassigned == null
      || scheduled !== expected
      || unassigned !== 0
      || (requestedTarget != null && requestedTarget > 0 && scheduled !== requestedTarget)
    ) return null;
    return [unassigned, -scheduled];
  }

  function normalizedOptimizationFocus(settings){
    const raw = String(settings?.optimization_focus || "automatic")
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_");
    if(["quick", "complete", "quick_complete"].includes(raw)) return "quick_complete";
    if(["singleton", "singletons", "one_period_teacher_sessions"].includes(raw)) return "singletons";
    if(["session", "sessions", "teacher_sessions"].includes(raw)) return "sessions";
    if(["gap", "gaps", "teacher_gaps"].includes(raw)) return "gaps";
    return "automatic";
  }

  function portfolioWorkerTimeoutMs(settings){
    const focus = normalizedOptimizationFocus(settings);
    const deepSessionSearch = focus === "sessions"
      && settings?.browser_wasm_session_deep_search === true;
    const maximum = focus === "quick_complete"
      ? QUICK_LOCAL_ATTEMPT_MS
      : (deepSessionSearch ? DEEP_SESSION_LOCAL_ATTEMPT_MS : FOCUSED_LOCAL_ATTEMPT_MS);
    const deadlines = ["native_global_deadline_ms", "backend_deadline_ms"]
      .map(key => Number(settings?.[key]))
      .filter(value => Number.isFinite(value) && value > 0);
    const requested = deadlines.length ? Math.min(...deadlines) : maximum;
    const budget = Math.max(1000, Math.min(maximum, Math.round(requested)));
    return budget + (focus === "quick_complete"
      ? QUICK_WORKER_SETTLE_RESERVE_MS
      : FOCUSED_WORKER_SETTLE_RESERVE_MS);
  }

  function candidateSaturatesFocus(candidate, settings){
    const focus = normalizedOptimizationFocus(settings);
    if(!Array.isArray(candidate?.quality)) return false;
    if(focus === "singletons") return Number(candidate.quality[0]) === 0;
    if(focus === "gaps"){
      return Number(candidate.quality[1]) === 0
        && Number(candidate.quality[3]) === 0
        && Number(candidate.quality[4]) === 0;
    }
    if(focus !== "sessions") return false;
    const target = nonnegativeMetric(settings, "ui_progress_metric_target");
    return target != null
      && Number(candidate.quality[0]) === 0
      && Number(candidate.quality[2]) <= target;
  }

  function qualityComparisonOrder(settings){
    const focus = normalizedOptimizationFocus(settings);
    if(["singletons", "sessions"].includes(focus)){
      return [0, 2, 1, 3, 4];
    }
    if(focus === "gaps") return [0, 1, 3, 4, 2];
    return [0, 2, 1, 3, 4];
  }

  function compareQuality(left, right, settings){
    if(!left && !right) return 0;
    if(!left) return 1;
    if(!right) return -1;
    const order = qualityComparisonOrder(settings);
    for(const index of order){
      if(index >= left.length || index >= right.length) continue;
      if(left[index] !== right[index]) return left[index] - right[index];
    }
    return left.length - right.length;
  }

  function portfolioRequest(request, index, count, lease, options){
    const cloned = JSON.parse(JSON.stringify(request));
    const settings = cloned.settings && typeof cloned.settings === "object"
      ? cloned.settings
      : (cloned.settings = {});
    const opts = options && typeof options === "object" ? options : {};
    const wave = Math.max(0, Math.trunc(Number(opts.wave || 0) || 0));
    // One Web Worker owns one single-threaded WASM solver. The outer portfolio
    // is the CPU parallelism, so nested solver workers must stay at one.
    settings.num_workers = 1;
    settings.browser_portfolio_index = index;
    settings.browser_portfolio_count = count;
    settings.browser_portfolio_wave = wave;
    if(opts.incumbent && cloned.data && typeof cloned.data === "object"){
      cloned.data.tkbSolverResult = JSON.parse(JSON.stringify(opts.incumbent));
    }
    const waveDeadlineMs = Math.max(0, Math.round(Number(opts.deadlineMs || 0) || 0));
    if(waveDeadlineMs > 0){
      capLocalDeadline(settings, "backend_deadline_ms", waveDeadlineMs);
      capLocalDeadline(settings, "native_global_deadline_ms", waveDeadlineMs);
      settings.browser_wasm_session_wave_deadline_ms = waveDeadlineMs;
    }
    const baseSeed = settings.random_seed == null ? "" : String(settings.random_seed);
    settings.random_seed = `${baseSeed}|web-portfolio-v3:${index}:${wave}|${String(lease?.jobId || "")}`;
    settings.quality_variant_seed = (
      ((index + 1) * 1000003 + (wave + 1) * 9176) % 2147483646
    ) + 1;
    return cloned;
  }

  function qualityWithinEnvelope(candidate, incumbent, settings){
    if(!candidate || !incumbent || candidate.length !== incumbent.length) return false;
    const focus = normalizedOptimizationFocus(settings);
    if(focus === "quick_complete") return false;
    if(["singletons", "sessions"].includes(focus)){
      if(candidate[0] > incumbent[0] || candidate[2] > incumbent[2]) return false;
      // Singleton/session phases may create temporary gap debt only when they
      // actually improve the dimension they own. Equal primary metrics keep
      // the normal lexicographic gap envelope.
      if(candidate[0] < incumbent[0] || candidate[2] < incumbent[2]) return true;
      return compareQuality(candidate, incumbent, settings) <= 0;
    }
    if(focus === "gaps"){
      return candidate[0] <= incumbent[0]
        && candidate[2] === incumbent[2]
        && compareQuality(candidate, incumbent, settings) <= 0;
    }
    // Automatic keeps the coordinated Phase-S/Phase-G envelope: no singleton,
    // teacher-session, or gap-2 regression, while gap-1 may move only behind
    // a strict improvement in an earlier lexicographic dimension.
    return candidate[0] <= incumbent[0]
      && candidate[2] <= incumbent[2]
      && candidate[1] <= incumbent[1]
      && compareQuality(candidate, incumbent, settings) <= 0;
  }

  async function runPortfolio(refinementRequest, lease, signal, onBestCandidate){
    const workers = state.workers.length ? state.workers.slice() : [state.worker].filter(Boolean);
    if(!workers.length) throw new Error("browser_wasm_worker_missing");
    const incumbent = refinementRequest?.data?.tkbSolverResult;
    const settings = refinementRequest?.settings || {};
    const focus = normalizedOptimizationFocus(settings);
    const quickCompletion = focus === "quick_complete";
    const workerTimeoutMs = portfolioWorkerTimeoutMs(settings);
    const workerSettleReserveMs = focus === "quick_complete"
      ? QUICK_WORKER_SETTLE_RESERVE_MS
      : FOCUSED_WORKER_SETTLE_RESERVE_MS;
    const deepSessionSearch = focus === "sessions"
      && settings.browser_wasm_session_deep_search === true;
    const progressiveSingletonSearch = focus === "singletons"
      && settings.browser_wasm_singleton_progressive_search === true;
    const progressiveGapSearch = focus === "gaps"
      && settings.browser_wasm_gap_progressive_search === true;
    const progressiveSearch = deepSessionSearch
      || progressiveSingletonSearch
      || progressiveGapSearch;
    const progressiveMaxWaves = deepSessionSearch
      ? Math.max(2, Math.min(32, Math.round(
          Number(settings.browser_wasm_session_deep_max_waves || DEEP_SESSION_MAX_WAVES)
        ) || DEEP_SESSION_MAX_WAVES))
      : (progressiveSingletonSearch
          ? Math.max(2, Math.min(16, Math.round(
              Number(settings.browser_wasm_singleton_max_waves || SINGLETON_MAX_WAVES)
            ) || SINGLETON_MAX_WAVES))
          : (progressiveGapSearch
              ? Math.max(2, Math.min(12, Math.round(
                  Number(settings.browser_wasm_gap_max_waves || GAP_MAX_WAVES)
                ) || GAP_MAX_WAVES))
              : 1));
    const progressiveWaveMs = deepSessionSearch
      ? Math.max(1000, Math.min(DEEP_SESSION_WAVE_MS, Math.round(
          Number(settings.browser_wasm_session_wave_deadline_ms || DEEP_SESSION_WAVE_MS)
        ) || DEEP_SESSION_WAVE_MS))
      : (progressiveSingletonSearch
          ? Math.max(1000, Math.min(SINGLETON_WAVE_MS, Math.round(
              Number(settings.browser_wasm_singleton_wave_deadline_ms || SINGLETON_WAVE_MS)
            ) || SINGLETON_WAVE_MS))
          : (progressiveGapSearch
              ? Math.max(1000, Math.min(GAP_WAVE_MS, Math.round(
                  Number(settings.browser_wasm_gap_wave_deadline_ms || GAP_WAVE_MS)
                ) || GAP_WAVE_MS))
              : 0));
    const computeBudgetMs = Math.max(1000, workerTimeoutMs - workerSettleReserveMs);
    const incumbentQuality = quickCompletion ? null : qualityTupleFromResult(incumbent);
    let best = null;
    let validCandidateCount = 0;
    const solveWorker = async (worker, index) => {
      const workerStartedAt = Date.now();
      let localIncumbent = incumbent;
      let localIncumbentQuality = incumbentQuality;
      let localBest = null;
      for(let wave = 0; wave < progressiveMaxWaves; wave += 1){
        const remainingMs = Math.max(0, computeBudgetMs - (Date.now() - workerStartedAt));
        if(remainingMs < 1000) break;
        const waveDeadlineMs = progressiveSearch
          ? Math.min(progressiveWaveMs, remainingMs)
          : 0;
        let candidate;
        const sharedBestIsBetter = wave > 0
          && best?.result
          && Array.isArray(best.quality)
          && (
            !localIncumbentQuality
            || compareQuality(best.quality, localIncumbentQuality, settings) < 0
          );
        const waveIncumbent = sharedBestIsBetter ? best.result : localIncumbent;
        try{
          const message = await workerRequestOn(
            worker,
            "solve",
            {payload:portfolioRequest(refinementRequest, index, workers.length, lease, {
              wave,
              deadlineMs:waveDeadlineMs,
              incumbent:wave > 0 ? waveIncumbent : null
            })},
            progressiveSearch
              ? waveDeadlineMs + workerSettleReserveMs
              : workerTimeoutMs,
            signal
          );
          const frame = message?.frame;
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
            || !completeHardResult(result)
          ){
            if(!progressiveSearch) break;
            continue;
          }
          candidate = {
            frame,
            status,
            result,
            quality:portfolioQualityFromResult(result, settings),
            index,
            wave
          };
          if(!candidate.quality){
            if(!progressiveSearch) break;
            continue;
          }
        }catch(err){
          if(signal?.aborted) throw err;
          const kind = String(err?.message || "");
          if(kind === "browser_wasm_worker_timeout" || kind === "browser_wasm_worker_crashed"){
            // A synchronous WASM call cannot be interrupted from the main
            // thread. Retiring the whole Worker is the only way to guarantee
            // that an over-budget trajectory stops consuming local CPU.
            retireComputeWorker(worker, err);
            break;
          }
          if(!progressiveSearch) break;
          continue;
        }
        validCandidateCount += 1;
        if(incumbentQuality && !qualityWithinEnvelope(candidate.quality, incumbentQuality, settings)){
          if(!progressiveSearch) return null;
          continue;
        }
        if(!localBest || compareQuality(candidate.quality, localBest.quality, settings) < 0){
          localBest = candidate;
        }
        const improvedOriginal = !incumbentQuality
          || compareQuality(candidate.quality, incumbentQuality, settings) < 0;
        if(!best || compareQuality(candidate.quality, best.quality, settings) < 0){
          best = candidate;
          if(
            !quickCompletion
            && improvedOriginal
            && typeof onBestCandidate === "function"
          ) await onBestCandidate(candidate);
        }
        if(
          !localIncumbentQuality
          || compareQuality(candidate.quality, localIncumbentQuality, settings) < 0
        ){
          localIncumbent = candidate.result;
          localIncumbentQuality = candidate.quality;
        }
        if(!progressiveSearch || candidateSaturatesFocus(candidate, settings)) break;
      }
      return localBest;
    };
    const pending = workers.map((worker, index) => solveWorker(worker, index));
    if(quickCompletion){
      const firstComplete = await new Promise((resolve, reject) => {
        let remaining = pending.length;
        for(const promise of pending){
          promise.then(candidate => {
            if(candidate){
              resolve(candidate);
              return;
            }
            remaining -= 1;
            if(remaining === 0) reject(new Error("browser_wasm_no_candidate"));
          }, () => {
            remaining -= 1;
            if(remaining === 0) reject(new Error("browser_wasm_no_candidate"));
          });
        }
      });
      // Quick owns completeness only. Once one worker succeeds, extra seeds
      // cannot improve the accepted result and must stop consuming CPU.
      terminateComputeWorkers();
      rejectWorkerWaiters(new Error("browser_wasm_quick_winner_selected"));
      return firstComplete;
    }
    if(focus === "singletons" || focus === "gaps"){
      const saturated = await new Promise(resolve => {
        let remaining = pending.length;
        for(const promise of pending){
          promise.then(candidate => {
            if(candidateSaturatesFocus(candidate, settings)){
              resolve(candidate);
              return;
            }
            remaining -= 1;
            if(remaining === 0) resolve(null);
          }, () => {
            remaining -= 1;
            if(remaining === 0) resolve(null);
          });
        }
      });
      if(saturated){
        // Zero one-period sessions is the exact terminal target. The first
        // validated checkpoint that reaches it wins; slower seeds add no value.
        terminateComputeWorkers();
        rejectWorkerWaiters(new Error(`browser_wasm_${focus}_target_reached`));
        return saturated;
      }
    }
    await Promise.all(pending);
    if(best) return best;
    if(validCandidateCount > 0 && completeHardResult(incumbent) && incumbentQuality){
      return {status:200, result:incumbent, quality:incumbentQuality, index:workers.length};
    }
    throw new Error("browser_wasm_no_candidate");
  }

  async function submitLeaseCandidate(lease, portfolio, action){
    const {status, result} = portfolio;
    const digest = await resultDigest(result);
    const candidate = await fetchJson(
      `/api/agent-helper/v1/leases/${encodeURIComponent(lease.leaseId)}/${action}`,
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
    state.localAcceptedResults += 1;
    state.lastAcceptedResultAtMs = Date.now();
    publishRuntimeState();
    return {
      candidateId:String(candidate?.candidateId || ""),
      sha256:String(candidate?.sha256 || digest),
      becameBest:candidate?.becameBest === true
    };
  }

  async function runLease(lease, generation, signal){
    lease.localExpiresAtMs = Date.now() + state.leaseMs;
    state.lease = lease;
    const portfolioController = typeof AbortController === "function" ? new AbortController() : null;
    const abortPortfolio = () => portfolioController?.abort();
    if(signal?.aborted) abortPortfolio();
    else signal?.addEventListener?.("abort", abortPortfolio, {once:true});
    let settleLeaseRun;
    const leaseRun = {
      lease,
      generation,
      controller:portfolioController,
      settled:false,
      stopRequested:false,
      checkpointSubmitted:false,
      checkpointCandidateId:"",
      checkpointQuality:null,
      completion:new Promise(resolve => { settleLeaseRun = resolve; })
    };
    leaseRun.settle = outcome => {
      if(leaseRun.settled) return;
      leaseRun.settled = true;
      settleLeaseRun(Object.assign({handled:true, submitted:false, jobId:String(lease.jobId || "")}, outcome || {}));
    };
    state.leaseRun = leaseRun;
    startHeartbeat(generation);
    try{
      const refinementRequest = browserRefinementRequest(lease.payload);
      if(!refinementRequest){
        await failLease(lease, state.workerToken, "browser_wasm_ineligible_request", false);
        return false;
      }
      state.computeActive = true;
      state.localComputeRuns += 1;
      state.lastComputeWorkerCount = Math.max(1, state.workers.length);
      state.lastComputeStartedAtMs = Date.now();
      state.lastComputeFinishedAtMs = 0;
      publishRuntimeState();
      let checkpointTail = Promise.resolve();
      const queueCheckpoint = portfolio => {
        checkpointTail = checkpointTail.then(async () => {
          if(
            leaseRun.checkpointQuality
            && compareQuality(
              portfolio.quality,
              leaseRun.checkpointQuality,
              refinementRequest.settings
            ) >= 0
          ) return null;
          const checkpoint = await submitLeaseCandidate(lease, portfolio, "checkpoint");
          leaseRun.checkpointSubmitted = true;
          leaseRun.checkpointCandidateId = checkpoint.candidateId;
          leaseRun.checkpointQuality = portfolio.quality;
          return checkpoint;
        }).catch(() => null);
        return checkpointTail;
      };
      const portfolio = await runPortfolio(
        refinementRequest,
        lease,
        portfolioController?.signal || signal,
        queueCheckpoint
      );
      await checkpointTail;
      if(leaseRun.stopRequested){
        leaseRun.settle({
          submitted:leaseRun.checkpointSubmitted,
          candidateId:leaseRun.checkpointCandidateId
        });
        return leaseRun.checkpointSubmitted;
      }
      if(!state.active || state.generation !== generation || state.lease !== lease){
        return false;
      }
      const {status} = portfolio;
      const candidate = await submitLeaseCandidate(lease, portfolio, "candidate");
      leaseRun.settle({submitted:true, candidateId:candidate.candidateId});
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
      leaseRun.settle({
        submitted:leaseRun.checkpointSubmitted,
        candidateId:leaseRun.checkpointCandidateId
      });
      if(!leaseRun.stopRequested && state.active && state.generation === generation){
        await failLease(lease, state.workerToken, "browser_wasm_failed", false);
      }
      return false;
    }finally{
      if(state.computeActive){
        state.computeActive = false;
        state.lastComputeFinishedAtMs = Date.now();
        publishRuntimeState();
      }
      signal?.removeEventListener?.("abort", abortPortfolio);
      leaseRun.settle({submitted:false});
      if(state.leaseRun === leaseRun) state.leaseRun = null;
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
          capacity:{cpuWorkers:Math.max(1, state.workers.length), maxConcurrentJobs:1},
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
    if(!isBrowserAgentRequest(opts.request) || opts.signal?.aborted) return false;
    const workerCeiling = portfolioWorkerCount(root.navigator);
    const plannedWorkerCount = adaptivePortfolioWorkerCount(opts.request, root.navigator);
    const samePlan = state.plannedWorkerCount === plannedWorkerCount
      && state.workerCeiling === workerCeiling;
    if(state.probed && state.worker && state.workers.length && samePlan) return true;
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
      if(state.workers.length) terminateComputeWorkers();
      state.workerCeiling = workerCeiling;
      state.plannedWorkerCount = plannedWorkerCount;
      await startComputeWorker(plannedWorkerCount, opts.signal);
      state.probed = true;
      return true;
    })().catch(() => {
      terminateComputeWorkers();
      state.probed = false;
      return false;
    }).finally(() => {
      state.probePromise = null;
    });
    return state.probePromise;
  }

  async function activateExecutor(options){
    const opts = options && typeof options === "object" ? options : {};
    if(
      !browserAgentEnabled()
      || !isBrowserAgentRequest(opts.request)
      || opts.signal?.aborted
    ) return false;
    const jobId = String(opts.jobId || "").trim();
    if(!jobId || jobId.length > 256) return false;
    if(state.active && state.workerToken) return state.jobId === jobId;
    if(state.activationPromise) return state.activationPromise;
    state.activationPromise = (async () => {
      const activationFence = state.generation;
      if(!state.probed || !state.worker || !state.workers.length){
        const probed = await probeExecutor(opts);
        if(!probed) return false;
      }
      if(root.document?.visibilityState === "hidden") return false;
      const hello = await fetchJson("/api/agent-helper/v1/hello", {
        protocol:AGENT_PROTOCOL,
        jobId,
        agent:agentWire(),
        capacity:{cpuWorkers:Math.max(1, state.workers.length), maxConcurrentJobs:1}
      }, {timeoutMs:4000, signal:opts.signal});
      const workerToken = String(hello?.workerToken || "");
      if(workerToken.length < 32 || workerToken.length > 512){
        throw new Error("browser_wasm_worker_token_invalid");
      }
      if(
        state.generation !== activationFence
        || !state.worker
        || !state.workers.length
        || !browserAgentEnabled()
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
      publishRuntimeState();
      return true;
    })().catch(() => {
      terminateComputeWorkers();
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

  function stopAndSubmitBest(options){
    const opts = options && typeof options === "object" ? options : {};
    const expectedJobId = String(opts.jobId || "").trim();
    const leaseRun = state.leaseRun;
    if(
      !leaseRun
      || leaseRun.settled
      || !state.active
      || state.lease !== leaseRun.lease
      || state.generation !== leaseRun.generation
      || (expectedJobId && String(leaseRun.lease?.jobId || "") !== expectedJobId)
    ){
      return {handled:false, submitted:false, jobId:expectedJobId};
    }
    leaseRun.stopRequested = true;
    if(state.computeActive){
      state.computeActive = false;
      state.lastComputeFinishedAtMs = Date.now();
      publishRuntimeState();
    }
    try{ leaseRun.controller?.abort(); }catch(_){ }
    rejectWorkerWaiters(new Error("browser_wasm_best_effort_stop"));
    terminateComputeWorkers();
    return {
      handled:true,
      submitted:leaseRun.checkpointSubmitted,
      candidateId:leaseRun.checkpointCandidateId,
      jobId:String(leaseRun.lease?.jobId || expectedJobId)
    };
  }

  async function closeExecutor(reason, options){
    const opts = options && typeof options === "object" ? options : {};
    if(state.closePromise) return state.closePromise;
    const lease = state.lease;
    const token = state.workerToken;
    const keepalive = opts.keepalive === true;
    state.active = false;
    state.probed = false;
    if(state.computeActive){
      state.computeActive = false;
      state.lastComputeFinishedAtMs = Date.now();
    }
    state.generation += 1;
    state.lease = null;
    clearHeartbeat();
    abortPendingFetches();
    rejectWorkerWaiters(new Error(String(reason || "browser_wasm_closed")));
    terminateComputeWorkers();
    state.workerToken = "";
    state.jobId = "";
    state.plannedWorkerCount = 0;
    publishRuntimeState();
    state.closePromise = (async () => {
      if(opts.failLease !== false) await failLease(lease, token, reason, keepalive);
      await disconnectToken(token, keepalive);
      return true;
    })().finally(() => {
      state.closePromise = null;
    });
    return state.closePromise;
  }

  async function setBrowserAgentEnabled(enabled){
    const next = enabled !== false;
    state.enabledOverride = next;
    try{ root.localStorage?.setItem(ENABLED_STORAGE_KEY, next ? "1" : "0"); }
    catch(_){ }
    if(!next){
      await closeExecutor("browser_agent_disabled", {failLease:true, keepalive:true});
    }
    publishRuntimeState();
    return next;
  }

  function stopForBackground(){
    if(
      !state.active
      && !state.workerToken
      && !state.worker
      && state.workers.length === 0
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
    isEnabled:browserAgentEnabled,
    setEnabled:setBrowserAgentEnabled,
    portfolioWorkerCount,
    adaptivePortfolioWorkerCount,
    requestWorkloadPeriods,
    portfolioWorkerTimeoutMs,
    canHandleRequest:isBrowserAgentRequest,
    refinementRequestClone:browserRefinementRequest,
    probe:probeExecutor,
    activate:activateExecutor,
    prepare:prepareExecutor,
    stopAndSubmitBest,
    close:closeExecutor,
    stopForBackground,
    resultDigest,
    state:publicRuntimeState
  };
})(typeof window !== "undefined" ? window : globalThis);
