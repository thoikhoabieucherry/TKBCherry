"use strict";

// 23/08 (chu du an: "dua kho default vao danh sach truong roi toi chinh cho de"):
// adoptDefaultStoreAsSchool tao ban ghi truong "default" trong registry, TKB so 1
// giu dung ma kho "default" (khong di tru), phien ban sau dung <shortId><n>;
// khong xoa duoc truong / TKB goc; sao chep TKB tao kho moi tu kho default.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const authSource = fs.readFileSync(
  path.resolve(__dirname, "..", "web", "shared", "auth.js"),
  "utf8"
);
const adminSource = fs.readFileSync(
  path.resolve(__dirname, "..", "web", "super-admin.js"),
  "utf8"
);
const adminHtml = fs.readFileSync(
  path.resolve(__dirname, "..", "web", "super-admin.html"),
  "utf8"
);
const appSource = fs.readFileSync(
  path.resolve(__dirname, "..", "web", "app.js"),
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

function loadAuthWithRemote(){
  const session = {userId:"suadmin", sessionToken:"tok-super", role:"superadmin"};
  const localStorage = memoryStorage({TKB_SESSION:JSON.stringify(session)});
  const sessionStorage = memoryStorage();
  let registry = {
    users:{suadmin:{id:"suadmin", role:"superadmin", email:"owner@example.test", active:true}},
    schools:{},
    deletedSchools:{},
    deletedUsers:{}
  };
  const saves = [];
  // Kho truong tren "VPS" gia lap: school_<sid> -> object
  const stores = new Map([["default", {tkb:{L1:{thu2:{sang:["Toán","","","",""]}}}, tkbConstraints:{meta:{}}}]]);
  const storeWrites = [];

  class FakeXHR {
    open(method, url){ this.method = method; this.url = String(url); }
    setRequestHeader(){}
    send(body){
      const match = this.url.match(/[?&]id=([^&]+)/);
      const id = match ? decodeURIComponent(match[1]) : "";
      if(this.method === "GET"){
        const data = stores.get(id);
        this.status = data ? 200 : 404;
        this.responseText = data ? JSON.stringify(data) : "";
        return;
      }
      const parsed = body ? JSON.parse(body) : {};
      stores.set(id, parsed);
      storeWrites.push({id, keys:Object.keys(parsed)});
      this.status = 200;
      this.responseText = "{\"ok\":true}";
    }
  }

  const api = {
    getSessionToken(){ return session.sessionToken; },
    apiFetchRegistrySync(){ return JSON.parse(JSON.stringify(registry)); },
    apiSaveRegistrySync(reg){ registry = JSON.parse(JSON.stringify(reg)); saves.push(registry); return true; },
    async apiSaveRegistry(reg){ registry = JSON.parse(JSON.stringify(reg)); saves.push(registry); return true; },
    getAuthHeaders(){ return {Authorization:"Bearer " + session.sessionToken}; }
  };
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
    XMLHttpRequest:FakeXHR,
    TextEncoder,
    URL,
    URLSearchParams,
    crypto:globalThis.crypto
  });
  vm.runInContext(authSource, context, {filename:"auth.js"});
  return {A:window.TKBAuth, registry:() => registry, stores, storeWrites, saves};
}

test("adoptDefaultStoreAsSchool registers default with TKB 1 bound to the existing store", () => {
  const env = loadAuthWithRemote();
  const A = env.A;
  assert.equal(typeof A.adoptDefaultStoreAsSchool, "function");

  const res = A.adoptDefaultStoreAsSchool({name:"  Trường   THCS Thử  ", effectiveDate:"2026-09-01"});
  assert.equal(res.ok, true, JSON.stringify(res));
  const school = env.registry().schools.default;
  assert.ok(school, "registry must contain school default");
  assert.equal(school.id, "default");
  assert.equal(school.name, "Trường THCS Thử");
  assert.equal(school.effectiveDate, "2026-09-01");
  assert.equal(school.ownerLoginId, "suadmin");
  assert.equal(school.plan, "max2");
  assert.equal(school.activeSchedule, 1);
  assert.ok(school.shortId && school.shortId !== "default", "shortId generated for later versions");
  assert.deepEqual(
    school.schedules.map(s => [s.number, s.sid, s.original]),
    [[1, "default", true]]
  );
  // TKB so 1 giu ma "default"; phien ban 2 dung <shortId>2 (khong bao gio di tru kho default)
  assert.equal(A.scheduleEntrySid(school, 1), "default");
  assert.equal(A.scheduleEntrySid(school, 2), `${school.shortId}2`);
  // meta duoc gieo vao dung kho default, du lieu TKB con nguyen
  const store = env.stores.get("default");
  assert.equal(store.tkbConstraints.meta.schoolName, "Trường THCS Thử");
  assert.equal(store.tkbConstraints.meta.effectiveDate, "2026-09-01");
  assert.equal(store.tkbConstraints.meta.scheduleNumber, "1");
  assert.equal(store.tkb.L1.thu2.sang[0], "Toán");
  // goi lai -> idempotent
  const again = A.adoptDefaultStoreAsSchool({name:"Khac"});
  assert.equal(again.ok, true);
  assert.equal(again.existed, true);
  assert.equal(env.registry().schools.default.name, "Trường THCS Thử");
  // xuat hien trong danh sach truong nhu moi truong khac — va LUON DUNG DAU
  // (chu du an: "dua TKB cua suadmin len dau danh sach"), du ten xep sau.
  assert.ok(A.listSchools().some(s => s.id === "default"));
  assert.equal(A.activeScheduleEntry("default").sid, "default");
  A.persistSchoolRecord({id:"aaa1", name:"A Trường đầu bảng", schedules:[{number:1, sid:"aaa11", original:true}]});
  A.persistSchoolRecord({id:"bbb2", name:"B Trường thứ hai", schedules:[{number:1, sid:"bbb21", original:true}]});
  const ordered = A.listSchools().map(s => String(s.id));
  assert.equal(ordered[0], "default");
  // (mang tu vm context khac -> so sanh chuoi thay vi deepEqual tham chieu)
  assert.equal(ordered.slice(1).join(","), "aaa1,bbb2");
});

test("default school cannot be deleted and its original schedule is protected", () => {
  const env = loadAuthWithRemote();
  const A = env.A;
  assert.equal(A.adoptDefaultStoreAsSchool({name:"Trường X", effectiveDate:"2026-09-01"}).ok, true);
  const del = A.deleteSchool("default");
  assert.equal(del.ok, false);
  assert.match(del.message, /default/);
  assert.ok(env.registry().schools.default, "school default must survive");

  // tao phien ban 2 bang sao chep, roi thu xoa TKB goc
  const copy = A.copySchoolSchedule("default", 1);
  assert.equal(copy.ok, true, JSON.stringify(copy));
  const school = env.registry().schools.default;
  const second = school.schedules.find(s => Number(s.number) === 2);
  assert.ok(second, "schedule 2 created");
  assert.notEqual(second.sid, "default");
  assert.equal(second.sid, `${school.shortId}2`);
  const copied = env.stores.get(second.sid);
  assert.ok(copied && copied.tkb && copied.tkb.L1, "store copied to the new sid");
  assert.equal(env.stores.get("default").tkb.L1.thu2.sang[0], "Toán", "source store untouched");

  const delOriginal = A.deleteSchoolSchedule("default", 1);
  assert.equal(delOriginal.ok, false);
  assert.match(delOriginal.message, /gốc/);
  assert.ok(env.stores.get("default").tkb, "store default not wiped");
  assert.equal(env.registry().schools.default.schedules.length, 2);

  // xoa phien ban 2 thi duoc
  const delSecond = A.deleteSchoolSchedule("default", 2);
  assert.equal(delSecond.ok, true, JSON.stringify(delSecond));
  assert.equal(env.registry().schools.default.schedules.length, 1);
});

test("super admin page exposes the adopt-default control and hides destructive actions for default", () => {
  assert.match(adminHtml, /id="btnAdoptDefault"[^>]*hidden/);
  assert.match(adminSource, /A\.adoptDefaultStoreAsSchool\(\{ name, effectiveDate: String\(date \|\| ""\)\.trim\(\) \}\)/);
  assert.match(adminSource, /const isDefault = String\(s\.id\) === "default";/);
  assert.match(adminSource, /\$\{isDefault \? "" : `<button type="button" class="portal-btn portal-btn-sm portal-btn-slot portal-btn-del danger" data-act="del"/);
  assert.match(adminSource, /syncAdoptDefaultButton\(\);/);
  // app.js: khong con hang "mac dinh" cung khi registry da co truong default
  assert.match(appSource, /const rows = defaultInRegistry \? \[\] : \[\{/);
});
