"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

const plannerHtml = read("web", "pages", "sapxep.html");
const plannerSource = read("web", "pages", "phanmon.js");
const workerSource = read("web", "pages", "tkb-fet-worker.js");
const serverSource = read("rust_api", "src", "main.rs");
const envExample = read(".env.example");

test("the planner owns timetable computation in a browser worker", () => {
  assert.match(plannerHtml, /src="tkb-fet-engine\.js\?v=20260823-web-fet-quick-v2"/);
  assert.match(plannerSource, /new Worker\("tkb-fet-worker\.js\?v=" \+ Date\.now\(\)\)/);
  assert.match(workerSource, /importScripts\('tkb-fet-engine\.js\?v=' \+ Date\.now\(\)\)/);
  assert.match(workerSource, /new self\.FetTimetableEngine/);
  assert.match(plannerSource, /options\?\.mode \|\| "solve_fast"/);
  assert.match(plannerSource, /action: isOptimizeMode \? "optimize" : "construct"/);
  assert.match(plannerHtml, /title="Xếp nhanh thời khóa biểu"/);
  assert.doesNotMatch(plannerHtml + plannerSource, /tkb-rust-bridge|tkb-fast-seed|\/api\/solve/);
});

test("the Rust process is only a web, auth, and school-store service", () => {
  assert.match(serverSource, /"engine": "fet-web-worker"/);
  assert.match(serverSource, /"capabilities": \["static-web", "auth", "school-store"\]/);
  assert.match(serverSource, /\("GET", "\/api\/school\/store"\)/);
  assert.match(serverSource, /\("POST", "\/api\/auth\/login"\)/);
  assert.doesNotMatch(serverSource, /\/api\/solve|native_solver|solver_pool|serverless|cloud_run/);
});

test("runtime configuration contains no retired scheduler settings", () => {
  assert.match(envExample, /TKB_RUST_HOST=127\.0\.0\.1/);
  assert.match(envExample, /TKB_RUST_PORT=1010/);
  assert.doesNotMatch(envExample, /TKB_SOLVER_|CP[-_ ]?SAT|CLOUD_RUN/i);
});
