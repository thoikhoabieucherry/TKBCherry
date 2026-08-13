import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(ROOT, "solver_runtime", "fixtures", "model_plan_v1");
const PLAN_PROTOCOL = "tkb-model-plan-v1";
const DIGEST_PROTOCOL = "tkb-model-plan-sha256-v1";

function readJson(file){
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function canonicalValue(value){
  if(Array.isArray(value)) return value.map(canonicalValue);
  if(value && typeof value === "object"){
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonicalValue(value[key])])
    );
  }
  if(typeof value === "number" && !Number.isFinite(value)){
    throw new TypeError("non-finite canonical JSON number");
  }
  return value;
}

function canonicalBytes(value){
  return Buffer.from(JSON.stringify(canonicalValue(value)), "utf8");
}

function sha256(bytes){
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function modelDigest(bytes){
  const size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(bytes.length));
  return sha256(Buffer.concat([
    Buffer.from("tkb-external-cp-sat-model-v1\0", "ascii"),
    size,
    bytes
  ]));
}

function planDigest(plan){
  return sha256(Buffer.concat([
    Buffer.from(`${DIGEST_PROTOCOL}\0`, "ascii"),
    canonicalBytes(plan)
  ]));
}

function exactKeys(value, expected, name){
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${name} schema drift`);
}

function assertPlan(plan){
  exactKeys(plan, [
    "protocol", "schemaVersion", "fixtureId", "phase", "request", "model",
    "variableMap", "result"
  ], "model plan");
  assert.equal(plan.protocol, PLAN_PROTOCOL);
  assert.equal(plan.schemaVersion, 1);
  assert.match(plan.request.sha256, /^[0-9a-f]{64}$/);
  assert.match(plan.model.digest, /^[0-9a-f]{64}$/);
  assert.match(plan.variableMap.sha256, /^[0-9a-f]{64}$/);
  assert.match(plan.result.sha256, /^[0-9a-f]{64}$/);
  assert.equal(plan.variableMap.entries, plan.model.statistics.variables);
}

function qualityMeetsEnvelope(quality, envelope){
  if(envelope.requireHardValid && !quality.hardValid) return false;
  if(quality.scheduledPeriods < envelope.minimumScheduledPeriods) return false;
  for(const [metric, maximum] of [
    ["violations", "maximumViolations"],
    ["unassignedPeriods", "maximumUnassignedPeriods"],
    ["teacherSessions", "maximumTeacherSessions"],
    ["onePeriodTeacherSessions", "maximumOnePeriodTeacherSessions"],
    ["gap1", "maximumGap1"],
    ["gap2", "maximumGap2"]
  ]){
    if(quality[metric] > envelope[maximum]) return false;
  }
  return true;
}

test("Browser canonical model-plan digests match the golden index", () => {
  const index = readJson(path.join(FIXTURES, "golden-index.json"));
  assert.equal(index.digestProtocol, DIGEST_PROTOCOL);
  for(const entry of index.fixtures){
    const value = readJson(path.join(FIXTURES, entry.path));
    const plan = entry.artifactsCommitted ? value.plan : value;
    assertPlan(plan);
    assert.equal(plan.fixtureId, entry.fixtureId);
    assert.equal(planDigest(plan), entry.planSha256);
    assert.equal(qualityMeetsEnvelope(
      plan.result.quality,
      plan.result.qualityEnvelope
    ), true);
  }
});

test("Browser verifies every committed small model-plan artifact", () => {
  const bundle = readJson(path.join(FIXTURES, "small-cp-sat.bundle.json"));
  const {plan, artifacts} = bundle;
  const request = canonicalBytes(artifacts.request);
  const model = Buffer.from(artifacts.modelBase64, "base64");
  const parameters = Buffer.from(artifacts.parameterBase64, "base64");
  const variableMap = canonicalBytes(artifacts.variableMap);
  const result = canonicalBytes(artifacts.result);

  assert.equal(request.length, plan.request.bytes);
  assert.equal(sha256(request), plan.request.sha256);
  assert.equal(model.length, plan.model.bytes);
  assert.equal(sha256(model), plan.model.sha256);
  assert.equal(modelDigest(model), plan.model.digest);
  assert.equal(parameters.length, plan.model.parameters.bytes);
  assert.equal(sha256(parameters), plan.model.parameters.sha256);
  assert.equal(variableMap.length, plan.variableMap.bytes);
  assert.equal(sha256(variableMap), plan.variableMap.sha256);
  assert.equal(artifacts.variableMap.length, plan.variableMap.entries);
  assert.equal(result.length, plan.result.bytes);
  assert.equal(sha256(result), plan.result.sha256);
});

test("Browser quality gate rejects a 1,566-period regression", () => {
  const plan = readJson(path.join(FIXTURES, "automatic-1566.plan.json"));
  const regressed = structuredClone(plan.result.quality);
  regressed.gap1 = plan.result.qualityEnvelope.maximumGap1 + 1;
  assert.equal(qualityMeetsEnvelope(
    regressed,
    plan.result.qualityEnvelope
  ), false);
});
