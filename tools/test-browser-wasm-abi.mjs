import fs from "node:fs";

const runtimePath = process.argv[2];
if(!runtimePath) throw new Error("WASM runtime path is required");
const runtime = fs.readFileSync(runtimePath);
if(runtime.byteLength < 100000) throw new Error("WASM runtime is unexpectedly small");

const request = {
  data:{
    lop:[{id:"6A", ten:"6A", khoi:"6"}],
    monhoc:[{id:"math", ten:"Math"}],
    mon:[{khoi:"6", ten:"Math", sotiet:1, gioihan:1}],
    pccmMatrix:{"6A|Math":"Teacher 1"},
    pccmTietMatrix:{"6A|Math":1}
  },
  settings:{
    require_complete_schedule:true,
    native_skip_teacher_optimization:true,
    backend_deadline_ms:5000,
    native_global_deadline_ms:5000
  }
};

const built = await WebAssembly.instantiate(runtime, {
  env:{tkb_now_ms:() => Date.now()}
});
const api = built.instance.exports;
const input = new TextEncoder().encode(JSON.stringify(request));
const inputPointer = Number(api.tkb_alloc(input.length));
if(!inputPointer) throw new Error("WASM input allocation failed");
new Uint8Array(api.memory.buffer, inputPointer, input.length).set(input);
let packed;
try{
  packed = BigInt.asUintN(64, BigInt(api.tkb_solve(inputPointer, input.length)));
}finally{
  api.tkb_free(inputPointer, input.length);
}
const outputPointer = Number(packed & 0xffffffffn);
const outputLength = Number(packed >> 32n);
if(!outputPointer || !outputLength || outputLength > 64 * 1024 * 1024){
  throw new Error("WASM output frame is invalid");
}
const output = new Uint8Array(outputLength);
output.set(new Uint8Array(api.memory.buffer, outputPointer, outputLength));
// This exact free caught the first ABI regression: a Vec capacity was rebuilt
// from its length, which traps in the WASM allocator after every solved frame.
api.tkb_free(outputPointer, outputLength);
const frame = JSON.parse(new TextDecoder().decode(output));
if(
  frame.protocol !== "tkb-reference-solver-stdio-v1"
  || frame.status !== 200
  || frame.payload?.ok !== true
  || frame.payload?.metrics?.scheduled_periods !== 1
  || frame.payload?.metrics?.unassigned_periods !== 0
){
  throw new Error(`WASM solver smoke failed: ${JSON.stringify(frame).slice(0, 1000)}`);
}
process.stdout.write("BROWSER_WASM_ABI_OK\n");
