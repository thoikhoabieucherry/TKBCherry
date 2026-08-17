"use strict";

(function(root, factory){
  "use strict";
  const api = factory();
  if(typeof module === "object" && module.exports) module.exports = api;
  if(root) root.TKBQuickFill = api;
})(typeof window !== "undefined" ? window : globalThis, function(){
  "use strict";

  const FAST_SEED_VERSION = "tkb-fast-seed-v1";

  function number(value, fallback = 0){
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function getFastSeedModule(){
    if(typeof window !== "undefined" && window.TKBFastSeed) return window.TKBFastSeed;
    if(typeof globalThis !== "undefined" && globalThis.TKBFastSeed) return globalThis.TKBFastSeed;
    return null;
  }

  function runInWorker(data, options = {}){
    const maxMs = Math.max(4000, Math.min(20000, number(options.maxMs, 15000)));
    const attempts = Math.max(1, Math.min(24, Math.round(number(options.attempts, 24))));
    const seed = Math.max(1, Math.round(number(options.seed, Date.now() & 0x7fffffff)));
    const workerUrl = "tkb-fast-seed-worker.js?v=20260811-hybrid-fast-seed-v1";

    return new Promise((resolve, reject) => {
      if(typeof Worker === "undefined"){
        const TKBFastSeed = getFastSeedModule();
        if(!TKBFastSeed || typeof TKBFastSeed.generate !== "function"){
          reject(new Error("FastSeed module not available"));
          return;
        }
        try{
          const result = TKBFastSeed.generate(data, {maxMs, attempts, seed});
          resolve(result);
        }catch(err){
          reject(err);
        }
        return;
      }

      let settled = false;
      let worker = null;
      let timer = null;

      const cleanup = () => {
        if(timer) clearTimeout(timer);
        if(worker) try{ worker.terminate(); }catch(_){}
      };

      const finish = (value) => {
        if(settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      const fail = (err) => {
        if(settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      try{
        worker = new Worker(workerUrl);
        worker.onmessage = (event) => {
          const msg = event?.data;
          if(msg?.ok === true && msg?.result){
            finish(msg.result);
          }else{
            fail(new Error(msg?.error || "Worker returned no result"));
          }
        };
        worker.onerror = (err) => {
          fail(new Error("Worker error: " + (err?.message || "unknown")));
        };
        timer = setTimeout(() => fail(new Error("Worker timeout")), maxMs + 3000);
        worker.postMessage({
          data,
          options: {maxMs, attempts, seed}
        });
      }catch(err){
        fail(err);
      }
    });
  }

  function formatUnassignedMessage(unassignedAssignments){
    if(!unassignedAssignments || unassignedAssignments.length === 0) return "";
    const lines = [];
    lines.push("Các phân công chưa xếp đủ tiết:");
    const grouped = {};
    for(const item of unassignedAssignments){
      const key = `${item.className || item.classId}|${item.subject}`;
      if(!grouped[key]) grouped[key] = {className: item.className, classId: item.classId, subject: item.subject, teacher: item.teacher, total: 0};
      grouped[key].total += item.periods;
    }
    for(const item of Object.values(grouped)){
      lines.push(`- ${item.className}: ${item.subject} (${item.teacher}) còn thiếu ${item.total} tiết`);
    }
    return lines.join("\n");
  }

  async function runClientOnlyQuickFill(data, options = {}){
    const expected = number(options.expected, 0);
    const maxMs = Math.max(8000, Math.min(20000, number(options.maxMs,
      expected >= 2000 ? 18000 : (expected >= 1000 ? 15000 : 12000)
    )));
    const attempts = 24;
    const seed = number(options.seed, Date.now() & 0x7fffffff);

    const startTime = Date.now();

    let result;
    try{
      result = await runInWorker(data, {maxMs, attempts, seed});
    }catch(err){
      return {
        ok: false,
        error: "fast_seed_failed",
        message: "Thuật toán xếp nhanh gặp lỗi: " + (err?.message || "unknown"),
        elapsedMs: Date.now() - startTime,
        complete: false,
        lessons: [],
        unassignedAssignments: []
      };
    }

    const elapsedMs = Date.now() - startTime;
    const scheduled = result?.lessons?.length || 0;
    const expectedPeriods = result?.expectedPeriods || expected;
    const unassignedPeriods = Math.max(0, expectedPeriods - scheduled);
    const complete = expectedPeriods > 0 && unassignedPeriods === 0;

    if(complete){
      return {
        ok: true,
        complete: true,
        lessons: result.lessons || [],
        unassignedAssignments: [],
        scheduledPeriods: scheduled,
        expectedPeriods: expectedPeriods,
        unassignedPeriods: 0,
        quality: result.quality || {singleton: 0, gap2: 0, gap1: 0},
        elapsedMs,
        attempts: result.attempts || 1
      };
    }else{
      return {
        ok: true,
        complete: false,
        lessons: result.lessons || [],
        unassignedAssignments: result.unassignedAssignments || [],
        scheduledPeriods: scheduled,
        expectedPeriods: expectedPeriods,
        unassignedPeriods: unassignedPeriods,
        quality: result.quality || {singleton: 0, gap2: 0, gap1: 0},
        elapsedMs,
        attempts: result.attempts || 1,
        unassignedMessage: formatUnassignedMessage(result?.unassignedAssignments)
      };
    }
  }

  return {
    runClientOnlyQuickFill,
    runInWorker,
    FAST_SEED_VERSION
  };
});
