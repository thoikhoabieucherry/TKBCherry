use std::mem;
use std::path::Path;
use std::slice;

use serde_json::{json, Value};

#[path = "../../rust_api/src/native_solver.rs"]
mod native_solver;

const SOLVER_PROTOCOL: &str = "tkb-reference-solver-stdio-v1";

fn response_bytes(input: &[u8]) -> Vec<u8> {
    let frame = match native_solver::solve_native_hint_json(Path::new("."), input, None) {
        Ok(Some(result)) => match serde_json::from_str::<Value>(&result.payload) {
            Ok(payload) => json!({
                "protocol": SOLVER_PROTOCOL,
                "status": result.status,
                "payload": payload,
            }),
            Err(error) => json!({
                "protocol": SOLVER_PROTOCOL,
                "status": 500,
                "payload": {
                    "ok": false,
                    "kind": "wasm_solver_payload_invalid",
                    "error": format!("WASM solver returned invalid JSON: {error}"),
                },
            }),
        },
        Ok(None) => json!({
            "protocol": SOLVER_PROTOCOL,
            "status": 503,
            "payload": {
                "ok": false,
                "kind": "wasm_solver_unavailable",
                "error": "WASM solver did not return a candidate.",
            },
        }),
        Err(error) => json!({
            "protocol": SOLVER_PROTOCOL,
            "status": 422,
            "payload": {
                "ok": false,
                "kind": "wasm_solver_failed",
                "error": error,
            },
        }),
    };
    serde_json::to_vec(&frame).unwrap_or_else(|_| {
        br#"{"protocol":"tkb-reference-solver-stdio-v1","status":500,"payload":{"ok":false,"kind":"wasm_solver_serialize_failed"}}"#.to_vec()
    })
}

#[no_mangle]
pub extern "C" fn tkb_alloc(length: u32) -> u32 {
    let length = length as usize;
    let mut bytes = vec![0_u8; length];
    let pointer = bytes.as_mut_ptr() as usize as u32;
    mem::forget(bytes);
    pointer
}

#[no_mangle]
pub unsafe extern "C" fn tkb_free(pointer: u32, length: u32) {
    if pointer == 0 || length == 0 {
        return;
    }
    drop(Vec::from_raw_parts(
        pointer as usize as *mut u8,
        length as usize,
        length as usize,
    ));
}

#[no_mangle]
pub unsafe extern "C" fn tkb_solve(pointer: u32, length: u32) -> u64 {
    if pointer == 0 || length == 0 {
        return 0;
    }
    let input = slice::from_raw_parts(pointer as usize as *const u8, length as usize);
    let mut output = response_bytes(input);
    if output.is_empty() || output.len() > u32::MAX as usize {
        return 0;
    }
    let output_pointer = output.as_mut_ptr() as usize as u32;
    let output_length = output.len() as u64;
    mem::forget(output);
    (output_length << 32) | output_pointer as u64
}

