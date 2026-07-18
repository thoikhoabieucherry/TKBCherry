use std::env;
use std::fs;

use serde_json::Value;

mod native_solver {
    include!("../native_solver.rs");
}

fn main() {
    let mut args = env::args().skip(1);
    let request_path = args.next().expect("request path");
    let response_path = args.next().expect("response path");
    let request = fs::read(request_path).expect("read request");
    let response: Value = serde_json::from_slice(
        &fs::read(response_path).expect("read response"),
    )
    .expect("parse response");
    let candidate = response.get("payload").unwrap_or(&response);
    match native_solver::validate_agent_candidate(&request, candidate) {
        Ok(validated) => println!("OK quality={:?}", validated.quality),
        Err(error) => println!("ERR {error}"),
    }
}
