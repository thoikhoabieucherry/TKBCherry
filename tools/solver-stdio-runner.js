"use strict";

const {spawnSync} = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {TextDecoder} = require("node:util");

const REFERENCE_SOLVER_PROTOCOL = "tkb-reference-solver-stdio-v1";
const DEFAULT_TIMEOUT_MS = 31 * 60 * 1000;
const DEFAULT_MAX_BUFFER_BYTES = 256 * 1024 * 1024;

function strictUtf8(buffer, label = "UTF-8 data"){
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  try{
    return new TextDecoder("utf-8", {fatal:true}).decode(bytes);
  }catch(err){
    const wrapped = new Error(`${label} is not valid UTF-8: ${err.message}`);
    wrapped.cause = err;
    throw wrapped;
  }
}

function diagnosticUtf8(buffer){
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  return new TextDecoder("utf-8", {fatal:false}).decode(bytes);
}

function jsonBytes(value, pretty = false){
  return Buffer.from(`${JSON.stringify(value, null, pretty ? 2 : 0)}\n`, "utf8");
}

function readJsonFileUtf8(filePath){
  const resolved = path.resolve(filePath);
  const text = strictUtf8(fs.readFileSync(resolved), resolved).replace(/^\uFEFF/, "");
  try{
    return JSON.parse(text);
  }catch(err){
    const wrapped = new Error(`Cannot parse JSON from ${resolved}: ${err.message}`);
    wrapped.cause = err;
    throw wrapped;
  }
}

function writeJsonFileUtf8(filePath, value, options = {}){
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), {recursive:true});
  fs.writeFileSync(resolved, jsonBytes(value, options.pretty !== false));
  return resolved;
}

function parseProtocolFrame(stdout){
  const text = strictUtf8(stdout, "solver stdout").replace(/^\uFEFF/, "").trim();
  if(!text) throw new Error("Solver stdout was empty");
  let frame;
  try{
    frame = JSON.parse(text);
  }catch(err){
    const wrapped = new Error(`Solver stdout was not one JSON frame: ${err.message}`);
    wrapped.cause = err;
    throw wrapped;
  }
  if(!frame || typeof frame !== "object" || Array.isArray(frame)){
    throw new Error("Solver stdout frame must be an object");
  }
  if(frame.protocol !== REFERENCE_SOLVER_PROTOCOL){
    throw new Error(`Unexpected solver protocol: ${String(frame.protocol || "missing")}`);
  }
  if(!Number.isInteger(Number(frame.status))){
    throw new Error("Solver stdout frame is missing an integer status");
  }
  if(!frame.payload || typeof frame.payload !== "object" || Array.isArray(frame.payload)){
    throw new Error("Solver stdout frame is missing an object payload");
  }
  return frame;
}

function pythonCandidates(explicit, repositoryRoot){
  const names = process.platform === "win32" ? ["python.exe", "python"] : ["python3", "python"];
  return [
    explicit,
    process.env.TKB_BENCHMARK_PYTHON,
    process.platform === "win32"
      ? path.join(repositoryRoot, ".codex_tmp", "release-venv", "Scripts", "python.exe")
      : path.join(repositoryRoot, ".codex_tmp", "release-venv", "bin", "python"),
    process.platform === "win32"
      ? path.join(repositoryRoot, "agent_helper", ".build-windows", "venv", "Scripts", "python.exe")
      : path.join(repositoryRoot, "agent_helper", ".build-windows", "venv", "bin", "python"),
    ...names
  ].filter(Boolean).map(String);
}

function resolvePythonExecutable(explicit, repositoryRoot = path.resolve(__dirname, "..")){
  if(explicit){
    const requested = String(explicit);
    if(path.isAbsolute(requested)){
      if(fs.existsSync(requested)) return requested;
      throw new Error(`Configured Python executable does not exist: ${requested}`);
    }
    const repositoryRelative = path.resolve(repositoryRoot, requested);
    if(fs.existsSync(repositoryRelative)) return repositoryRelative;
    if(requested.includes("/") || requested.includes("\\")){
      throw new Error(`Configured Python executable does not exist: ${repositoryRelative}`);
    }
    return requested;
  }
  for(const candidate of pythonCandidates(explicit, repositoryRoot)){
    if(path.isAbsolute(candidate)){
      if(fs.existsSync(candidate)) return candidate;
      continue;
    }
    const repositoryRelative = path.resolve(repositoryRoot, candidate);
    if(fs.existsSync(repositoryRelative)) return repositoryRelative;
    if(candidate.includes("/") || candidate.includes("\\")) continue;
    return candidate;
  }
  return process.platform === "win32" ? "python.exe" : "python3";
}

function runProtocolCommand(input, options = {}){
  const repositoryRoot = path.resolve(options.repositoryRoot || path.resolve(__dirname, ".."));
  const mode = String(options.mode || "solve");
  const command = String(options.command || resolvePythonExecutable(options.python, repositoryRoot));
  const script = path.resolve(
    options.script || path.join(repositoryRoot, "solver_runtime", "scripts", "solve_stdio.py")
  );
  const args = Array.isArray(options.args)
    ? options.args.map(String)
    : [script, mode];
  const startedAt = Date.now();
  const completed = spawnSync(command, args, {
    cwd:path.resolve(options.cwd || path.join(repositoryRoot, "solver_runtime")),
    input:jsonBytes(input),
    encoding:null,
    shell:false,
    windowsHide:true,
    timeout:Math.max(1, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS),
    maxBuffer:Math.max(
      1024 * 1024,
      Number(options.maxBufferBytes || DEFAULT_MAX_BUFFER_BYTES) || DEFAULT_MAX_BUFFER_BYTES
    ),
    env:Object.assign({}, process.env, {
      PYTHONUTF8:"1",
      PYTHONIOENCODING:"utf-8",
      TKB_NO_LOGS:"1"
    }, options.env || {})
  });
  const stdout = Buffer.isBuffer(completed.stdout) ? completed.stdout : Buffer.from(completed.stdout || []);
  const stderr = Buffer.isBuffer(completed.stderr) ? completed.stderr : Buffer.from(completed.stderr || []);
  if(completed.error){
    const err = new Error(`Solver process failed to start or timed out: ${completed.error.message}`);
    err.cause = completed.error;
    err.command = command;
    err.args = args;
    err.stderr = diagnosticUtf8(stderr);
    throw err;
  }
  if(completed.signal){
    const err = new Error(`Solver process ended from signal ${completed.signal}`);
    err.command = command;
    err.args = args;
    err.stderr = diagnosticUtf8(stderr);
    throw err;
  }
  if(Number(completed.status || 0) !== 0){
    const err = new Error(`Solver process exited with code ${completed.status}`);
    err.command = command;
    err.args = args;
    err.stderr = diagnosticUtf8(stderr);
    throw err;
  }
  const frame = parseProtocolFrame(stdout);
  return {
    command,
    args,
    elapsedMs:Date.now() - startedAt,
    frame,
    status:Number(frame.status),
    payload:frame.payload,
    stdout,
    stderr,
    stderrText:diagnosticUtf8(stderr)
  };
}

function runSolverRequest(request, options = {}){
  return runProtocolCommand(request, Object.assign({}, options, {mode:"solve"}));
}

function validateCandidate(request, candidate, options = {}){
  return runProtocolCommand(
    {request, candidate},
    Object.assign({}, options, {mode:"validate-candidate"})
  );
}

module.exports = {
  DEFAULT_MAX_BUFFER_BYTES,
  DEFAULT_TIMEOUT_MS,
  REFERENCE_SOLVER_PROTOCOL,
  diagnosticUtf8,
  jsonBytes,
  parseProtocolFrame,
  readJsonFileUtf8,
  resolvePythonExecutable,
  runProtocolCommand,
  runSolverRequest,
  strictUtf8,
  validateCandidate,
  writeJsonFileUtf8
};
