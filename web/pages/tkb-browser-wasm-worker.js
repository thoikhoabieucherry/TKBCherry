(function(){
  "use strict";

  const VERSION = "tkb-browser-wasm-worker-v2";
  const SOLVER_PROTOCOL = "tkb-reference-solver-stdio-v1";
  const MAX_WASM_BYTES = 64 * 1024 * 1024;
  const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
  const MAX_RESULT_BYTES = 64 * 1024 * 1024;

  let runtime = null;
  let runtimeUrl = "";

  async function instantiateRuntime(url){
    const response = await fetch(url, {
      method:"GET",
      cache:"force-cache",
      credentials:"same-origin"
    });
    if(!response.ok) throw new Error(`wasm_http_${response.status}`);
    const bytes = await response.arrayBuffer();
    if(bytes.byteLength < 100000 || bytes.byteLength > MAX_WASM_BYTES){
      throw new Error("wasm_size_invalid");
    }
    const built = await WebAssembly.instantiate(bytes, {
      env:{tkb_now_ms:() => Date.now()}
    });
    const instance = built && built.instance ? built.instance : built;
    const api = instance && instance.exports;
    if(
      !api
      || !(api.memory instanceof WebAssembly.Memory)
      || typeof api.tkb_alloc !== "function"
      || typeof api.tkb_free !== "function"
      || typeof api.tkb_solve !== "function"
    ){
      throw new Error("wasm_exports_invalid");
    }
    return api;
  }

  async function ensureRuntime(url){
    const nextUrl = String(url || "").trim();
    if(!nextUrl) throw new Error("wasm_url_missing");
    if(runtime && runtimeUrl === nextUrl) return runtime;
    runtime = await instantiateRuntime(nextUrl);
    runtimeUrl = nextUrl;
    return runtime;
  }

  function solve(api, payload){
    const input = new TextEncoder().encode(JSON.stringify(payload));
    if(!input.byteLength || input.byteLength > MAX_REQUEST_BYTES){
      throw new Error("wasm_request_size_invalid");
    }
    const inputPointer = Number(api.tkb_alloc(input.byteLength));
    if(!inputPointer) throw new Error("wasm_input_allocation_failed");
    new Uint8Array(api.memory.buffer, inputPointer, input.byteLength).set(input);
    let packed;
    try{
      packed = BigInt.asUintN(64, BigInt(api.tkb_solve(inputPointer, input.byteLength)));
    }finally{
      api.tkb_free(inputPointer, input.byteLength);
    }
    const outputPointer = Number(packed & 0xffffffffn);
    const outputLength = Number(packed >> 32n);
    if(!outputPointer || !outputLength || outputLength > MAX_RESULT_BYTES){
      throw new Error("wasm_result_size_invalid");
    }
    const output = new Uint8Array(outputLength);
    output.set(new Uint8Array(api.memory.buffer, outputPointer, outputLength));
    api.tkb_free(outputPointer, outputLength);
    const frame = JSON.parse(new TextDecoder("utf-8", {fatal:true}).decode(output));
    if(
      !frame
      || frame.protocol !== SOLVER_PROTOCOL
      || !Number.isInteger(frame.status)
      || !frame.payload
      || typeof frame.payload !== "object"
      || Array.isArray(frame.payload)
    ){
      throw new Error("wasm_result_protocol_invalid");
    }
    return frame;
  }

  self.onmessage = async event => {
    const message = event && event.data && typeof event.data === "object"
      ? event.data
      : {};
    const requestId = String(message.requestId || "");
    try{
      if(message.type === "probe"){
        await ensureRuntime(message.wasmUrl);
        self.postMessage({type:"ready", requestId, version:VERSION});
        return;
      }
      if(message.type !== "solve") return;
      const api = await ensureRuntime(message.wasmUrl);
      const frame = solve(api, message.payload);
      self.postMessage({type:"result", requestId, frame});
    }catch(error){
      self.postMessage({
        type:"error",
        requestId,
        error:String(error && error.message || error || "browser_wasm_failed").slice(0, 300)
      });
    }
  };
})();
