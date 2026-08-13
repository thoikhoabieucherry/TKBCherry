"use strict";

importScripts("tkb-fast-seed.js?v=20260811-hybrid-fast-seed-v1");

self.onmessage = event => {
  const request = event?.data && typeof event.data === "object" ? event.data : {};
  try{
    if(!self.TKBFastSeed || typeof self.TKBFastSeed.generate !== "function"){
      throw new Error("fast_seed_module_unavailable");
    }
    const result = self.TKBFastSeed.generate(request.data || {}, request.options || {});
    self.postMessage({ok:true, result});
  }catch(error){
    self.postMessage({
      ok:false,
      error:String(error?.message || error || "fast_seed_failed")
    });
  }
};
