"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const authSource = fs.readFileSync(path.join(root, "web", "shared", "auth.js"), "utf8");
const portalSource = fs.readFileSync(path.join(root, "web", "school-portal.js"), "utf8");
const portalHtml = fs.readFileSync(path.join(root, "web", "school-portal.html"), "utf8");
const portalCss = fs.readFileSync(path.join(root, "web", "auth.css"), "utf8");
const lightCss = fs.readFileSync(path.join(root, "web", "theme-light.css"), "utf8");
const superAdminSource = fs.readFileSync(path.join(root, "web", "super-admin.js"), "utf8");
const superAdminHtml = fs.readFileSync(path.join(root, "web", "super-admin.html"), "utf8");
const appHtml = fs.readFileSync(path.join(root, "web", "app.html"), "utf8");
const plannerHtml = fs.readFileSync(path.join(root, "web", "pages", "sapxep.html"), "utf8");

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

function loadAuth(api = null, options = {}){
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
  if(options.XMLHttpRequest) globals.XMLHttpRequest = options.XMLHttpRequest;
  const context = vm.createContext(globals);
  vm.runInContext(authSource, context, {filename:"auth.js"});
  return window.TKBAuth;
}

function registryFixture(plan = "free"){
  return {
    users:{admin:{id:"admin", role:"superadmin", active:true}},
    schools:{school1:{
      id:"school1",
      shortId:"abc",
      name:"Trường thử",
      ownerLoginId:"admin",
      ownerEmail:"admin@example.com",
      ownerPhone:"",
      plan,
      active:true,
      activeSchedule:1,
      schedules:[{number:1, sid:"abc1", original:true, effectiveDate:""}],
      scheduleNumber:"1",
      effectiveDate:""
    }},
    registeredIps:{},
    otpPending:{},
    deletedSchools:{},
    deletedUsers:{},
    blockedIps:{}
  };
}

function authForRegistry(registry, options = {}){
  let savedRegistry = null;
  const auth = loadAuth({
    getSessionToken(){ return "test-session"; },
    apiFetchRegistrySync(){ return registry; },
    apiSaveRegistrySync(value){ savedRegistry = value; return true; }
  }, options);
  return {auth, savedRegistry:() => savedRegistry};
}

test("service-plan contract prices Plus and separates Max 1 from Max 2", () => {
  const auth = loadAuth();

  assert.equal(auth.PLANS.free.solveLimit, 5);
  assert.equal(auth.PLANS.plus.price, 300_000);
  assert.equal(auth.PLANS.plus.durationDays, 30);
  assert.equal(auth.PLANS.plus.solveLimit, 100);

  assert.equal(auth.PLANS.max1.price, 1_000_000);
  assert.equal(auth.PLANS.max1.classLimit, 39);
  assert.equal(auth.PLANS.max1.unlimitedSolves, true);
  assert.equal(auth.PLANS.max2.price, 1_500_000);
  assert.equal(auth.PLANS.max2.unlimitedClasses, true);
  assert.equal(auth.PLANS.max2.unlimitedSolves, true);

  assert.equal(auth.MAX_PLAN_PRICING.dimension, "classes");
  assert.equal(auth.MAX_PLAN_PRICING.thresholdClasses, 40);
  assert.equal(auth.MAX_PLAN_PRICING.tiers.length, 2);
  assert.equal(auth.maxPlanIdForClasses(1), "max1");
  assert.equal(auth.maxPlanIdForClasses(39), "max1");
  assert.equal(auth.maxPlanIdForClasses(40), "max2");
  assert.equal(auth.maxPlanIdForClasses(50_000), "max2");
  assert.equal(auth.maxPlanPriceForClasses(39), 1_000_000);
  assert.equal(auth.maxPlanPriceForClasses(40), 1_500_000);
  assert.equal(auth.maxPlanTierForClasses(39).label, "Max 1 · Dưới 40 lớp");
  assert.equal(auth.maxPlanTierForClasses(40).label, "Max 2 · Từ 40 lớp");
});

test("legacy Max records map safely to an explicit plan", () => {
  const auth = loadAuth();
  assert.equal(auth.effectivePlan({plan:"max", maxPlanPricingTier:"under-40-classes"}).id, "max1");
  assert.equal(auth.effectivePlan({plan:"max", maxPlanPricingTier:"from-40-classes"}).id, "max2");
  assert.equal(auth.effectivePlan({plan:"max", classCount:39}).id, "max1");
  assert.equal(auth.effectivePlan({plan:"max", classCount:40}).id, "max2");
  assert.equal(
    auth.effectivePlan({plan:"max"}).id,
    "max2",
    "legacy Max without metadata must not unexpectedly lose class capacity"
  );
});

test("explicit Max activation records the assigned plan and exact amount", () => {
  const max1Registry = registryFixture();
  const max1Harness = authForRegistry(max1Registry);
  const max1 = max1Harness.auth.activatePlan("school1", "max1", true, {classCount:39});
  assert.equal(max1.ok, true);
  assert.equal(max1.plan, "max1");
  assert.equal(max1.paymentAmount, 1_000_000);
  assert.equal(max1.classCount, 39);
  assert.equal(max1Registry.schools.school1.plan, "max1");
  assert.equal(max1Registry.schools.school1.maxPlanPricingTier, "under-40-classes");

  const max2Registry = registryFixture();
  const max2Harness = authForRegistry(max2Registry);
  const max2 = max2Harness.auth.activatePlan("school1", "max2", true, {classCount:40});
  assert.equal(max2.ok, true);
  assert.equal(max2.plan, "max2");
  assert.equal(max2.paymentAmount, 1_500_000);
  assert.equal(max2.classCount, 40);
  assert.equal(max2Registry.schools.school1.plan, "max2");
  assert.equal(max2Registry.schools.school1.maxPlanPricingTier, "from-40-classes");
});

test("Super Admin can reassign explicit Max tiers without stale class metadata", () => {
  const registry = registryFixture("max2");
  registry.schools.school1.classCount = 80;
  registry.schools.school1.maxPlanPricingTier = "from-40-classes";
  const {auth} = authForRegistry(registry);

  const max1 = auth.activatePlan("school1", "max1", true);
  assert.equal(max1.ok, true);
  assert.equal(max1.plan, "max1");
  assert.equal(max1.classCount, 39);
  assert.equal(registry.schools.school1.plan, "max1");

  const max2 = auth.activatePlan("school1", "max2", true);
  assert.equal(max2.ok, true);
  assert.equal(max2.plan, "max2");
  assert.equal(max2.classCount, 40);
});

test("Max 1 activation refuses class metadata at or above 40 atomically", () => {
  const registry = registryFixture();
  const harness = authForRegistry(registry);
  const result = harness.auth.activatePlan("school1", "max1", true, {classCount:40});

  assert.equal(result.ok, false);
  assert.equal(result.kind, "max1_class_limit_exceeded");
  assert.match(result.message, /Max 2/);
  assert.equal(registry.schools.school1.plan, "free");
  assert.equal(harness.savedRegistry(), null);
});

test("legacy Max activation input still selects the corresponding explicit tier", () => {
  const registry = registryFixture();
  const harness = authForRegistry(registry);
  const result = harness.auth.activatePlan("school1", "max", true, {classCount:40});

  assert.equal(result.ok, true);
  assert.equal(result.plan, "max2");
  assert.equal(result.paymentAmount, 1_500_000);
  assert.equal(registry.schools.school1.plan, "max2");
});

test("each Plus activation creates a fresh shared 100-request billing cycle", () => {
  const registry = registryFixture();
  const {auth} = authForRegistry(registry);
  const first = auth.activatePlan("school1", "plus", true);
  const firstCycle = registry.schools.school1.plusQuotaCycleId;
  const second = auth.activatePlan("school1", "plus", true);
  const secondCycle = registry.schools.school1.plusQuotaCycleId;

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.paymentAmount, 300_000);
  assert.equal(second.paymentAmount, 300_000);
  assert.ok(firstCycle);
  assert.ok(secondCycle);
  assert.notEqual(secondCycle, firstCycle);
});

test("failed remote schedule copy never appends registry metadata", () => {
  const registry = registryFixture();
  const requests = [];
  class FakeXHR {
    open(method, url){ this.method = method; this.url = url; }
    setRequestHeader(){}
    send(body){
      requests.push({method:this.method, url:this.url, body});
      if(this.method === "GET"){
        this.status = 200;
        this.responseText = JSON.stringify({lop:[{id:"L1"}], tkb:{}});
      }else{
        this.status = 409;
        this.responseText = JSON.stringify({ok:false, kind:"max1_class_limit_exceeded"});
      }
    }
  }
  const harness = authForRegistry(registry, {XMLHttpRequest:FakeXHR});
  const result = harness.auth.copySchoolSchedule("school1", 1);

  assert.equal(result.ok, false);
  assert.match(result.message, /TKB nguồn vẫn được giữ nguyên/);
  assert.equal(registry.schools.school1.schedules.length, 1);
  assert.equal(registry.schools.school1.schedules[0].sid, "abc1");
  assert.equal(harness.savedRegistry(), null);
  assert.deepEqual(requests.map(row => [row.method, row.url]), [
    ["GET", "/api/school/store?id=abc1"],
    ["POST", "/api/school/store?id=abc2"]
  ]);
});

test("failed SID migration keeps the registry on its source and never clears it", () => {
  const registry = registryFixture();
  registry.schools.school1.schedules[0].sid = "legacy1";
  const requests = [];
  class FakeXHR {
    open(method, url){ this.method = method; this.url = url; }
    setRequestHeader(){}
    send(body){
      requests.push({method:this.method, url:this.url, body});
      if(this.method === "GET"){
        this.status = 200;
        this.responseText = JSON.stringify({lop:[{id:"L1"}], tkb:{}});
      }else{
        this.status = 409;
        this.responseText = JSON.stringify({ok:false});
      }
    }
  }
  const {auth} = authForRegistry(registry, {XMLHttpRequest:FakeXHR});
  const schedules = auth.listSchoolSchedules("school1");

  assert.equal(schedules[0].sid, "legacy1");
  assert.equal(registry.schools.school1.schedules[0].sid, "legacy1");
  assert.deepEqual(requests.map(row => [row.method, row.url]), [
    ["GET", "/api/school/store?id=legacy1"],
    ["POST", "/api/school/store?id=abc1"]
  ]);
});

test("school portal shows Plus quota, both Max choices and equal-height desktop cards", () => {
  assert.match(portalSource, /MAX_PLAN_PRICING_FALLBACK/);
  assert.match(portalSource, /planId:"max1"/);
  assert.match(portalSource, /planId:"max2"/);
  assert.match(portalSource, /data-max-plan/);
  assert.match(portalSource, /p\.solveLimit/);
  assert.match(portalSource, /Không giới hạn lượt Xếp \/ Tối ưu/);
  assert.match(portalSource, /Hỗ trợ xếp TKB đầu tiên/);
  assert.match(portalSource, /data-plan-card="managed-service"/);
  assert.doesNotMatch(portalSource, /Liên hệ trực tiếp để đặt dịch vụ xếp hộ TKB\./);
  assert.doesNotMatch(portalSource, /data-max-students/);

  assert.match(portalCss, /\.plan-cards\s*\{[\s\S]*?grid-auto-rows:\s*1fr;[\s\S]*?align-items:\s*stretch;/);
  assert.match(portalCss, /\.plan-cards\.has-plan-banner\s*\{[\s\S]*?grid-template-rows:\s*auto;/);
  assert.match(portalSource, /root\.classList\.toggle\("has-plan-banner", Boolean\(banner\)\)/);
  assert.match(portalCss, /\.portal-trial-banner\s*\{[\s\S]*?height:\s*auto;[\s\S]*?padding:\s*9px 14px;/);
  assert.match(lightCss, /\.portal-account-modal-sub \.tkb-plan-badge\s*\{[\s\S]*?background:\s*#ffffff;[\s\S]*?border-color:\s*var\(--plan-color\);/);
  assert.match(portalCss, /\.plan-card\s*\{[\s\S]*?height:\s*100%;/);
  assert.match(portalCss, /\.plan-card \.portal-btn\.primary\s*\{[\s\S]*?margin-top:\s*auto;/);
  assert.match(portalCss, /@media \(max-width:\s*899px\)[\s\S]*?\.plan-card\s*\{[\s\S]*?height:\s*auto;/);

  assert.match(portalHtml, /auth\.css\?v=20260803-trial-banner-v8/);
  assert.match(portalHtml, /theme-light\.css\?v=20260803-trial-banner-v8/);
  assert.match(portalHtml, /shared\/auth\.js\?v=20260803-free-5-solve-quota-v1/);
  assert.match(portalHtml, /school-portal\.js\?v=20260803-trial-banner-v8/);
  assert.match(lightCss, /\.portal-trial-banner\.is-active\s*\{[\s\S]*?background:\s*#ffffff;/);
  assert.match(lightCss, /\.plan-card\[data-plan-card="plus"\],[\s\S]*?\.plan-card\[data-plan-card="max"\][\s\S]*?border-color:\s*color-mix\(in srgb, var\(--plan-color/);
});

test("Super Admin assigns Max 1 and Max 2 with concise selector labels", () => {
  assert.match(superAdminSource, /\["max1", "Max 1"\]/);
  assert.match(superAdminSource, /\["max2", "Max 2"\]/);
  assert.doesNotMatch(superAdminSource, /Max 1 · tối đa 39 lớp|Max 2 · không giới hạn lớp/);
  assert.match(superAdminSource, /const plan = A\.effectivePlan\(s\)/);
  assert.match(superAdminSource, /A\.activatePlan\(id, planId/);
  assert.doesNotMatch(superAdminSource, /Số lớp của trường để tính giá gói Max/);
  assert.doesNotMatch(superAdminSource, /activationOptions = \{classCount\}/);
  assert.match(superAdminHtml, /shared\/auth\.js\?v=20260803-free-5-solve-quota-v1/);
  assert.match(superAdminHtml, /super-admin\.js\?v=20260803-max-plan-labels-v1/);
});

test("class-limit and storage guards are cache-busted on editor and planner", () => {
  assert.match(appHtml, /shared\/auth\.js\?v=20260803-free-5-solve-quota-v1/);
  assert.match(appHtml, /shared\/storage\.js\?v=20260802-max1-store-guard-v2/);
  assert.match(appHtml, /app\.js\?v=20260802-max1-class-limit-v1/);
  assert.match(plannerHtml, /shared\/auth\.js\?v=20260803-free-5-solve-quota-v1/);
  assert.match(plannerHtml, /shared\/storage\.js\?v=20260802-max1-store-guard-v2/);
});
