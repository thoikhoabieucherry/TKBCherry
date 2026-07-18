"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const adminSource = fs.readFileSync(
  path.resolve(__dirname, "..", "web", "super-admin.js"),
  "utf8"
);
const adminCss = fs.readFileSync(
  path.resolve(__dirname, "..", "web", "super-admin.css"),
  "utf8"
);

function elementStub(){
  const listeners = {};
  return {
    hidden:true,
    innerHTML:"",
    value:"",
    listeners,
    addEventListener(type, handler){ listeners[type] = handler; },
    querySelector(){ return null; },
    reset(){},
    focus(){}
  };
}

function loadSuperAdmin(){
  const school = {
    id:"school-stable",
    shortId:"tkbstable1",
    name:"Tên trường cũ",
    ownerEmail:"admin@example.test",
    ownerPhone:"0900000000",
    ownerLoginId:"adminschool",
    plan:"ultra",
    active:true,
    expiresAt:"",
    activeSchedule:1,
    schedules:[{number:1, sid:"tkbstable11", original:true}]
  };
  const registry = {
    schools:{[school.id]:school},
    users:{adminschool:{id:"adminschool", role:"school_admin", schoolId:school.id}}
  };
  const elements = Object.fromEntries([
    "btnLogout",
    "btnChangePassword",
    "btnOpenApp",
    "btnAddSchool",
    "btnCloseAddSchool",
    "btnCancelAddSchool",
    "addSchoolModal",
    "addSchoolForm",
    "schoolsBody",
    "btnReloadSchools"
  ].map(id => [id, elementStub()]));
  const updateCalls = [];
  const alerts = [];
  let promptValue = null;

  const auth = {
    MAX_SCHOOL_USERS:5,
    requireAuth(){ return {ok:true}; },
    currentUser(){ return {user:{id:"suadmin"}}; },
    loadRegistry(){ return registry; },
    listSchools(){ return Object.values(registry.schools); },
    listSchoolUsers(){ return []; },
    countSchoolSubUsers(){ return 0; },
    effectivePlan(){ return {unlimited:true}; },
    planBadgeHtml(){ return "Ultra"; },
    formatDate(){ return "-"; },
    formatPhone(value){ return value; },
    updateSchoolMeta(id, patch){
      updateCalls.push({id, patch:Object.assign({}, patch)});
      if(!registry.schools[id]) return {ok:false, message:"Không tìm thấy trường."};
      registry.schools[id].name = patch.name;
      return {ok:true};
    }
  };
  const document = {
    getElementById(id){ return elements[id] || null; },
    addEventListener(){}
  };
  const window = {
    TKBAuth:auth,
    location:{href:"", replace(){}},
    document
  };
  window.window = window;
  const context = vm.createContext({
    window,
    document,
    console,
    setTimeout,
    clearTimeout,
    prompt(){ return promptValue; },
    alert(message){ alerts.push(String(message)); },
    confirm(){ return false; },
    FormData:function(){}
  });
  vm.runInContext(adminSource, context, {filename:"super-admin.js"});

  function clickAction(action){
    const row = {dataset:{id:school.id}};
    const button = {
      dataset:{act:action},
      closest(selector){
        if(selector === "button[data-act]") return this;
        if(selector === "tr[data-id]") return row;
        return null;
      }
    };
    elements.schoolsBody.listeners.click({target:button});
  }

  return {
    school,
    elements,
    updateCalls,
    alerts,
    clickAction,
    setPromptValue(value){ promptValue = value; }
  };
}

test("super admin school rows expose Edit before Delete in a stable action order", () => {
  const runtime = loadSuperAdmin();
  const html = runtime.elements.schoolsBody.innerHTML;
  const actions = [
    "open-tkb",
    "schedule-select",
    "del-tkb",
    "toggle",
    "plan-select",
    "expiry",
    "pwd",
    "edit",
    "del"
  ];
  let previous = -1;
  for(const action of actions){
    const index = html.indexOf(`data-act="${action}"`);
    assert.ok(index > previous, `${action} is missing or outside the expected order`);
    previous = index;
  }
  assert.match(html, /data-act="edit"[^>]*title="Sửa tên trường"[^>]*>Sửa<\/button>/);
  assert.match(html, /data-act="del"[^>]*>Xóa<\/button>/);
});

test("editing a school changes only its normalized name and preserves identity", () => {
  const runtime = loadSuperAdmin();
  const identityBefore = {
    id:runtime.school.id,
    shortId:runtime.school.shortId,
    schedules:JSON.stringify(runtime.school.schedules)
  };
  runtime.setPromptValue("  Trường   Trung học A\u0301  ");
  runtime.clickAction("edit");

  assert.deepEqual(runtime.updateCalls, [{
    id:"school-stable",
    patch:{name:"Trường Trung học Á"}
  }]);
  assert.equal(runtime.school.id, identityBefore.id);
  assert.equal(runtime.school.shortId, identityBefore.shortId);
  assert.equal(JSON.stringify(runtime.school.schedules), identityBefore.schedules);
  assert.match(runtime.elements.schoolsBody.innerHTML, /Trường Trung học Á/);
});

test("editing a school rejects an empty name without saving", () => {
  const runtime = loadSuperAdmin();
  runtime.setPromptValue(" \n\t ");
  runtime.clickAction("edit");

  assert.equal(runtime.updateCalls.length, 0);
  assert.deepEqual(runtime.alerts, ["Tên trường không được để trống."]);
});

test("super admin action controls share equal desktop tracks and consistent heights", () => {
  const desktop = adminCss.slice(0, adminCss.indexOf("@media (max-width: 899px)"));
  const mobile = adminCss.slice(adminCss.indexOf("@media (max-width: 899px)"));

  assert.match(desktop, /grid-template-columns:\s*repeat\(9, minmax\(0, 1fr\)\)/);
  assert.match(desktop, /\.portal-tkb-select\s*\{[^}]*max-width:\s*none;/s);
  assert.match(desktop, /\.portal-action-bar > \.portal-btn-sm,[\s\S]*height:\s*32px;[\s\S]*min-height:\s*32px;/);

  assert.match(mobile, /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(mobile, /height:\s*38px;\s*min-height:\s*38px;/);
  assert.match(mobile, /\.portal-btn-del\s*\{[^}]*grid-column:\s*1 \/ -1;/s);
  assert.doesNotMatch(mobile, /\.portal-btn-pwd\s*,[\s\S]{0,120}grid-column:\s*1 \/ -1/);
});
