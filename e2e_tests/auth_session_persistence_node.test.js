"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const authSource = fs.readFileSync(
  path.resolve(__dirname, "..", "web", "shared", "auth.js"),
  "utf8"
);
const authApiSource = fs.readFileSync(
  path.resolve(__dirname, "..", "web", "shared", "auth-api.js"),
  "utf8"
);

function memoryStorage(initial = {}){
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, String(value)]));
  return {
    get length(){ return values.size; },
    getItem(key){ return values.has(String(key)) ? values.get(String(key)) : null; },
    setItem(key, value){ values.set(String(key), String(value)); },
    removeItem(key){ values.delete(String(key)); },
    key(index){ return Array.from(values.keys())[index] ?? null; }
  };
}

function loadAuth({local = {}, session = {}, api = null} = {}){
  const localStorage = memoryStorage(local);
  const sessionStorage = memoryStorage(session);
  const window = {
    localStorage,
    sessionStorage,
    indexedDB:{deleteDatabase(){}},
    location:{protocol:"https:", hostname:"tkbcherry.com", origin:"https://tkbcherry.com"},
    TKBAuthApi:api
  };
  window.window = window;
  const context = vm.createContext({
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
    crypto:globalThis.crypto
  });
  vm.runInContext(authSource, context, {filename:"auth.js"});
  return {window, localStorage, sessionStorage};
}

function loadAuthApi({local = {}, session = {}} = {}){
  const localStorage = memoryStorage(local);
  const sessionStorage = memoryStorage(session);
  const window = {localStorage, sessionStorage};
  window.window = window;
  const context = vm.createContext({
    window,
    localStorage,
    sessionStorage,
    console,
    fetch:async () => ({ok:true, status:200, json:async () => ({ok:true})}),
    TextEncoder,
    URL,
    crypto:globalThis.crypto
  });
  vm.runInContext(authApiSource, context, {filename:"auth-api.js"});
  return {window, localStorage, sessionStorage};
}

test("auth migrates an old tab session into persistent local storage", () => {
  const saved = {userId:"school1", sessionToken:"legacy-token", role:"school_admin"};
  const runtime = loadAuth({session:{TKB_SESSION:JSON.stringify(saved)}});

  assert.deepEqual(JSON.parse(JSON.stringify(runtime.window.TKBAuth.getSession())), saved);
  assert.deepEqual(JSON.parse(runtime.localStorage.getItem("TKB_SESSION")), saved);
  assert.equal(runtime.sessionStorage.getItem("TKB_SESSION"), null);
});

test("auth API reads the persistent session after the original tab closes", () => {
  const saved = {userId:"school1", sessionToken:"persistent-token"};
  const runtime = loadAuthApi({local:{TKB_SESSION:JSON.stringify(saved)}});

  assert.equal(runtime.window.TKBAuthApi.getSessionToken(), "persistent-token");
});

test("logout releases the server session then clears both browser stores", async () => {
  const saved = {userId:"school1", sessionToken:"logout-token"};
  let logoutCalls = 0;
  const runtime = loadAuth({
    local:{TKB_SESSION:JSON.stringify(saved)},
    session:{TKB_SESSION:JSON.stringify(saved)},
    api:{async apiLogout(){ logoutCalls += 1; return true; }}
  });

  await runtime.window.TKBAuth.logout();
  assert.equal(logoutCalls, 1);
  assert.equal(runtime.localStorage.getItem("TKB_SESSION"), null);
  assert.equal(runtime.sessionStorage.getItem("TKB_SESSION"), null);
});

test("registration IP history blocks only while its school or account still exists", () => {
  const start = authSource.indexOf("function registeredIpHit");
  const end = authSource.indexOf("function migrateRegisteredIps", start);
  assert.ok(start >= 0 && end > start, "registeredIpHit helper is missing");
  const helper = authSource.slice(start, end);

  assert.match(helper, /const schoolExists\s*=\s*!!\(schoolId && reg\.schools && reg\.schools\[schoolId\]\)/);
  assert.match(helper, /const userExists\s*=\s*!!\(userId && reg\.users/);
  assert.match(helper, /if\(schoolExists \|\| userExists\) return hit/);
  assert.match(helper, /const legacySchool = Object\.values\(reg\.schools \|\| \{\}\)\.find/);
  assert.match(helper, /const firstIp = Array\.isArray\(school\?\.ips\)/);
  assert.doesNotMatch(helper, /return reg\.registeredIps\[addr\] \|\| null/);
});

test("renaming a school updates its admin label while preserving schedule identities", () => {
  const registry = {
    version:1,
    users:{owner:{id:"owner", role:"school_admin", schoolId:"school-1", displayName:"Old Name"}},
    schools:{
      "school-1":{
        id:"school-1",
        shortId:"stable",
        name:"Old Name",
        ownerLoginId:"owner",
        schedules:[
          {number:1, sid:"stable1", original:true},
          {number:2, sid:"stable2", original:false}
        ]
      }
    },
    registeredIps:{},
    deletedSchools:{},
    deletedUsers:{},
    blockedIps:{},
    otpPending:{}
  };
  let saved = null;
  const runtime = loadAuth({api:{
    getSessionToken(){ return "test-token"; },
    apiFetchRegistrySync(){ return structuredClone(registry); },
    apiSaveRegistrySync(next){ saved = structuredClone(next); return true; }
  }});

  const beforeSchedules = JSON.stringify(registry.schools["school-1"].schedules);
  const result = runtime.window.TKBAuth.updateSchoolMeta("school-1", {name:"  New   School  "});

  assert.equal(result.ok, true);
  assert.equal(result.name, "New School");
  assert.equal(saved.schools["school-1"].name, "New School");
  assert.equal(saved.users.owner.displayName, "New School");
  assert.equal(JSON.stringify(saved.schools["school-1"].schedules), beforeSchedules);
});

test("deleting a school releases only IP blocks owned by that school", () => {
  const registry = {
    version:1,
    users:{owner:{id:"owner", role:"school_admin", schoolId:"school-1"}},
    schools:{"school-1":{id:"school-1", name:"School", ownerLoginId:"owner"}},
    registeredIps:{"203.0.113.10":{schoolId:"school-1", loginId:"owner"}},
    deletedSchools:{},
    deletedUsers:{},
    blockedIps:{
      "203.0.113.10":{schoolId:"school-1"},
      "203.0.113.11":{schoolId:"another-school"}
    },
    otpPending:{}
  };
  let saved = null;
  const runtime = loadAuth({api:{
    getSessionToken(){ return "test-token"; },
    apiFetchRegistrySync(){ return structuredClone(registry); },
    apiSaveRegistrySync(next){ saved = structuredClone(next); return true; }
  }});

  const result = runtime.window.TKBAuth.deleteSchool("school-1");

  assert.equal(result.ok, true);
  assert.equal(saved.schools["school-1"], undefined);
  assert.equal(saved.users.owner, undefined);
  assert.equal(saved.blockedIps["203.0.113.10"], undefined);
  assert.deepEqual(saved.blockedIps["203.0.113.11"], {schoolId:"another-school"});
});
