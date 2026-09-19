"use strict";

// 04/09 (chủ dự án): kích hoạt (xác thực email) cấp gói Max 2 dùng thử 1 NĂM
// (365 ngày) thay vì 1 tháng. Kiểm 3 tầng: hằng client, luồng verifyAccountEmail,
// banner portal, trần server Rust (366 ngày) và cache-bust ở các HTML.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = rel => fs.readFileSync(path.join(root, ...rel.split("/")), "utf8");
const authSource = read("web/shared/auth.js");
const portalSource = read("web/school-portal.js");
const rustSource = read("rust_api/src/main.rs");

const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_VERSION = "20260904-grant-1year-v1";

function storage(){
  const values = new Map();
  return {
    get length(){ return values.size; },
    getItem(key){ return values.has(String(key)) ? values.get(String(key)) : null; },
    setItem(key, value){ values.set(String(key), String(value)); },
    removeItem(key){ values.delete(String(key)); },
    key(index){ return Array.from(values.keys())[index] ?? null; }
  };
}

function loadAuth(api){
  const localStorage = storage();
  const sessionStorage = storage();
  const window = {
    localStorage,
    sessionStorage,
    indexedDB:{deleteDatabase(){}},
    location:{protocol:"https:", hostname:"tkbcherry.com", origin:"https://tkbcherry.com"},
    TKBAuthApi:api,
    TKBSchool:{
      sanitizeSchoolId(value){ return String(value || "").trim().toLowerCase(); },
      lsKey(value){ return `TKB_STORE::${String(value || "").trim().toLowerCase()}`; },
      setSchoolName(){}
    }
  };
  window.window = window;
  const globals = {
    window,
    localStorage,
    sessionStorage,
    indexedDB:window.indexedDB,
    location:window.location,
    console,
    fetch:async () => ({ok:false, status:503, json:async () => ({})}),
    TextEncoder,
    URL,
    URLSearchParams,
    crypto:globalThis.crypto,
    setTimeout,
    clearTimeout
  };
  const context = vm.createContext(globals);
  vm.runInContext(authSource, context, {filename:"auth.js"});
  return window.TKBAuth;
}

function registryFixture(overrides = {}){
  const email = "admin@example.com";
  return {
    users:{
      admina:{
        id:"admina", role:"school_admin", schoolId:"school1", active:true,
        email, emailVerified:false
      }
    },
    schools:{school1:Object.assign({
      id:"school1",
      shortId:"abc",
      name:"Trường thử",
      ownerLoginId:"admina",
      ownerEmail:email,
      ownerPhone:"",
      plan:"free",
      expiresAt:"",
      trialUsed:false,
      active:true,
      activeSchedule:1,
      schedules:[{number:1, sid:"abc1", original:true, effectiveDate:""}],
      scheduleNumber:"1",
      effectiveDate:""
    }, overrides)},
    registeredIps:{},
    otpPending:{
      "email:admina":{code:"123456", expiresAt:Date.now() + 10 * 60 * 1000, type:"email_verify", userId:"admina", email}
    },
    deletedSchools:{},
    deletedUsers:{},
    blockedIps:{}
  };
}

function authForRegistry(registry){
  let savedRegistry = null;
  const auth = loadAuth({
    getSessionToken(){ return "test-session"; },
    apiFetchRegistrySync(){ return savedRegistry || registry; },
    apiSaveRegistrySync(value){ savedRegistry = JSON.parse(JSON.stringify(value)); return true; }
  });
  return {auth, savedRegistry:() => savedRegistry};
}

test("ACTIVATION_GRANT is Max 2 for one year (365 days)", () => {
  const auth = loadAuth(null);
  assert.equal(auth.ACTIVATION_GRANT.planId, "max2");
  assert.equal(auth.ACTIVATION_GRANT.durationDays, 365);
  assert.match(authSource, /ACTIVATION_GRANT\.durationDays \|\| 365/);
  assert.doesNotMatch(authSource, /ACTIVATION_GRANT\.durationDays \|\| 30\b/);
});

test("verifyAccountEmail grants Max 2 that expires ~365 days later, once per school", async () => {
  const {auth, savedRegistry} = authForRegistry(registryFixture());
  const before = Date.now();
  const res = await auth.verifyAccountEmail("admina", "123456");
  const after = Date.now();

  assert.equal(res.ok, true, res.message);
  assert.equal(res.trialGranted, true);
  assert.equal(res.grantedPlan, "max2");
  assert.match(res.message, /Max 2 dùng thử 365 ngày/);

  const reg = savedRegistry();
  assert.ok(reg, "registry saved");
  const school = reg.schools.school1;
  assert.equal(school.plan, "max2");
  assert.equal(school.trialUsed, true);
  assert.equal(school.maxPlanPricingTier, "from-40-classes");
  assert.equal(reg.users.admina.emailVerified, true);
  assert.equal(reg.otpPending["email:admina"], undefined);

  const exp = Date.parse(school.expiresAt);
  assert.ok(Number.isFinite(exp), "expiresAt is ISO");
  const days = (exp - before) / DAY_MS;
  assert.ok(days >= 364 && days <= 366, `expected ~365 days, got ${days.toFixed(2)}`);
  assert.ok(exp - after >= 364 * DAY_MS, "expiry is relative to now");
  assert.equal(auth.effectivePlan(school).id, "max2");

  // Trường đã dùng thử (trialUsed) thì xác thực lại không cấp thêm lần nữa.
  const used = authForRegistry(registryFixture({trialUsed:true}));
  const again = await used.auth.verifyAccountEmail("admina", "123456");
  assert.equal(again.ok, true, again.message);
  assert.equal(again.trialGranted, false);
  assert.equal(used.savedRegistry().schools.school1.plan, "free");
  assert.equal(used.savedRegistry().schools.school1.expiresAt, "");
});

test("portal banner and Rust server cap agree on the one-year grant", () => {
  assert.match(portalSource, /A\.ACTIVATION_GRANT \|\| \{planId: "max2", durationDays: 365\}/);
  assert.match(portalSource, /grant\.durationDays \|\| 365/);
  assert.doesNotMatch(portalSource, /durationDays: 30\b|durationDays \|\| 30\b/);

  // merge_school_admin_registry: nhận max2/trial với hạn ≤366 ngày (trước 04/09 là 31).
  assert.match(rustSource, /\*expiry <= now\.saturating_add\(366 \* 24 \* 60 \* 60 \* 1_000\)/);
  assert.doesNotMatch(rustSource, /saturating_add\(31 \* 24 \* 60 \* 60 \* 1_000\)/);
  assert.match(rustSource, /fn email_verification_grants_max2_trial_once_for_free_schools[\s\S]*?iso_date_days_from_now\(365\)[\s\S]*?iso_date_days_from_now\(400\)/);
});

test("auth.js and school-portal.js are cache-busted for the one-year grant", () => {
  for(const rel of ["web/app.html", "web/index.html", "web/pages/sapxep.html", "web/school-portal.html", "web/super-admin.html"]){
    assert.ok(read(rel).includes("shared/auth.js?v=" + CACHE_VERSION), rel + " must load auth.js?v=" + CACHE_VERSION);
  }
  assert.ok(read("web/school-portal.html").includes("school-portal.js?v=" + CACHE_VERSION), "school-portal.js cache-bust");
});
