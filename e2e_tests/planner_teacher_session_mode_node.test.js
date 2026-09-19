"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const CONSTRAINTS_PATH = path.resolve(__dirname, "..", "web", "pages", "tkb-constraints.js");
const CONSTRAINTS_SOURCE = fs.readFileSync(CONSTRAINTS_PATH, "utf8");

function json(value){
  return JSON.parse(JSON.stringify(value));
}

function teacherData(teacherRules){
  const ids = Object.keys(teacherRules || {});
  return {
    giaovien:ids.map(id => ({magv:id, ten:id})),
    pccmMatrix:{},
    pccmTietMatrix:{},
    tkb:{},
    tkbConstraints:{teacher:teacherRules || {}}
  };
}

function loadConstraints(data, dayKeys = ["thu2"]){
  const head = {appendChild(){}};
  const body = {appendChild(){}};
  const document = {
    head,
    body,
    readyState:"complete",
    getElementById(){ return null; },
    querySelectorAll(){ return []; },
    addEventListener(){},
    createElement(){
      return {
        id:"",
        textContent:"",
        style:{},
        classList:{add(){},remove(){},toggle(){}}
      };
    }
  };
  const window = {
    DATA:data,
    document,
    location:{search:""},
    __TKB_E2E_EXPOSE_TEST_HOOKS:true,
    addEventListener(){},
    removeEventListener(){},
    setTimeout,
    clearTimeout
  };
  window.window = window;
  const labels = Object.fromEntries(dayKeys.map((day,index) => [day, `Day ${index + 2}`]));
  const context = {
    window,
    document,
    DATA:data,
    DAYS:dayKeys,
    LABEL:labels,
    SANG:5,
    CHIEU:5,
    console,
    Date,
    Math,
    JSON,
    Object,
    Array,
    Set,
    Map,
    WeakMap,
    URLSearchParams,
    setTimeout,
    clearTimeout
  };
  vm.runInNewContext(CONSTRAINTS_SOURCE, context, {filename:CONSTRAINTS_PATH});
  const api = window.TKBConstraints;
  assert.ok(api, "constraints API must load");
  api.__testHooks = window.__TKB_CONSTRAINTS_TEST_HOOKS;
  assert.ok(api.__testHooks, "constraints test hooks must be exposed");
  return api;
}

function inputTags(html){
  return html.match(/<input\b[^>]*>/g) || [];
}

function rowModeInput(html, teacherId, mode){
  return inputTags(html).find(tag =>
    tag.includes(`data-tid="${teacherId}"`) &&
    tag.includes(`data-rb-one-session-mode="${mode}"`)
  );
}

// 13/09 (chủ dự án): "Chỉ dạy 1 buổi/1 ngày" đổi thành "Giới hạn buổi dạy", mỗi ngày 2 ô Sáng / Chiều:
// bỏ trống = tự do; tick Sáng = chỉ sáng; tick Chiều = chỉ chiều; tick cả hai = sáng HOẶC chiều (either).
// Dữ liệu lưu vẫn là MỘT cờ {morning|afternoon|either:true} nên các bộ giải không đổi.
test("one-session teacher rules normalize legacy and object values", () => {
  const api = loadConstraints(teacherData({
    Legacy:{oneSessionPerDay:{thu2:true}},
    Morning:{oneSessionPerDay:{thu2:{morning:true}}},
    Afternoon:{oneSessionPerDay:{thu2:{afternoon:true}}},
    Either:{oneSessionPerDay:{thu2:{either:true}}},
    BothBoxes:{oneSessionPerDay:{thu2:{morning:true,afternoon:true}}},
    Malformed:{oneSessionPerDay:{thu2:{morning:true,afternoon:true,either:true}}},
    UncheckedOverOld:{oneSessionPerDay:{thu2:{either:true,morning:false,afternoon:true}}},
    ClearedOverOld:{oneSessionPerDay:{thu2:{either:true,morning:false,afternoon:false}}},
    Empty:{oneSessionPerDay:{thu2:{morning:false,afternoon:false,either:false}}}
  }));
  const hooks = api.__testHooks;
  const model = json(api.get());

  assert.deepEqual(model.teacher.Legacy.oneSessionPerDay.thu2, {either:true});
  assert.deepEqual(model.teacher.Morning.oneSessionPerDay.thu2, {morning:true});
  assert.deepEqual(model.teacher.Afternoon.oneSessionPerDay.thu2, {afternoon:true});
  assert.deepEqual(model.teacher.Either.oneSessionPerDay.thu2, {either:true});
  assert.deepEqual(model.teacher.BothBoxes.oneSessionPerDay.thu2, {either:true}, "tick cả Sáng lẫn Chiều = sáng hoặc chiều");
  assert.deepEqual(model.teacher.Malformed.oneSessionPerDay.thu2, {either:true});
  assert.deepEqual(model.teacher.UncheckedOverOld.oneSessionPerDay.thu2, {afternoon:true}, "hai ô giao diện thắng cờ either cũ");
  assert.equal(model.teacher.ClearedOverOld, undefined, "bỏ cả hai ô = tự do, kể cả khi còn cờ either cũ");
  assert.equal(model.teacher.Empty, undefined, "an all-false mode object means no constraint");

  assert.equal(hooks.teacherOneSessionDayMode(true), "either");
  assert.equal(hooks.teacherOneSessionDayMode({morning:true}), "morning");
  assert.equal(hooks.teacherOneSessionDayMode({afternoon:true}), "afternoon");
  assert.equal(hooks.teacherOneSessionDayMode({either:true}), "either");
  assert.equal(hooks.teacherOneSessionDayMode({morning:true, afternoon:true}), "either");
  assert.equal(hooks.teacherOneSessionDayMode({morning:false, afternoon:false}), "");
  assert.equal(hooks.teacherOneSessionDayMode({}), "");

  const persisted = json(api.get());
  const reloaded = json(loadConstraints({
    ...teacherData({}),
    tkbConstraints:persisted
  }).get());
  assert.deepEqual(reloaded.teacher.Legacy.oneSessionPerDay.thu2, {either:true});
  assert.deepEqual(reloaded.teacher.Morning.oneSessionPerDay.thu2, {morning:true});
  assert.deepEqual(reloaded.teacher.Afternoon.oneSessionPerDay.thu2, {afternoon:true});
  assert.deepEqual(reloaded.teacher.Either.oneSessionPerDay.thu2, {either:true});
});

test("Giới hạn buổi dạy: tên mới, bảng 2 ô Sáng/Chiều mỗi ngày, either = tick cả hai", () => {
  assert.match(CONSTRAINTS_SOURCE, /\['oneSessionPerDay', 'Giới hạn buổi dạy'\]/);
  assert.match(CONSTRAINTS_SOURCE, /menuRoute\('Giới hạn buổi dạy','teacher','oneSessionPerDay'\)/);
  assert.doesNotMatch(CONSTRAINTS_SOURCE, /Chỉ dạy 1 buổi\/1 ngày/);

  const rules = {
    Legacy:{oneSessionPerDay:{thu2:true}},
    Morning:{oneSessionPerDay:{thu2:{morning:true}}},
    Afternoon:{oneSessionPerDay:{thu2:{afternoon:true}}},
    Either:{oneSessionPerDay:{thu2:{either:true}}},
    Free:{}
  };
  const teacherIds = Object.keys(rules);
  const api = loadConstraints(teacherData(rules));
  const rows = teacherIds.map(id => ({id,name:id}));
  const html = api.__testHooks.teacherRuleTable("oneSessionPerDay", rows);

  assert.match(html, /class="table-wrap rb-desktop-wrap rb-teacher-one-session-wrap"/);
  assert.match(html, /class="rb-desktop-table rb-teacher-one-session-table"/);
  assert.match(html, /<th colspan="2" class="rb-one-session-day-head">/);
  assert.match(html, /rb-one-session-hint[\s\S]*Bỏ trống[\s\S]*cả hai/);
  assert.doesNotMatch(html, /Cả 2|data-rb-one-session-mode="either"/, "không còn cột Cả 2");
  assert.equal(
    inputTags(html).filter(tag => tag.includes("data-rb-one-session-mode=")).length,
    rows.length * 2,
    "mỗi GV/ngày chỉ có ô Sáng và ô Chiều"
  );
  ["morning","afternoon"].forEach(mode => {
    assert.match(html, new RegExp(`data-rb-check-filter="path:oneSessionPerDay\\.thu2\\.${mode}"`), `cột ${mode} cần ô chọn tất cả`);
  });

  const expected = {
    Legacy:{morning:true, afternoon:true},
    Morning:{morning:true, afternoon:false},
    Afternoon:{morning:false, afternoon:true},
    Either:{morning:true, afternoon:true},
    Free:{morning:false, afternoon:false}
  };
  Object.entries(expected).forEach(([teacherId, checks]) => {
    ["morning","afternoon"].forEach(mode => {
      const tag = rowModeInput(html, teacherId, mode);
      assert.ok(tag, `${teacherId}/${mode} checkbox is missing`);
      assert.equal(/\schecked(?:\s|>)/.test(tag), checks[mode], `${teacherId}/${mode}`);
      assert.match(tag, new RegExp(`data-path="oneSessionPerDay\\.thu2\\.${mode}"`));
      assert.match(tag, /data-rb-one-session-day="thu2"/);
    });
  });
});

function modeBox(teacherId, day, mode, checked, row){
  const box = {
    checked:!!checked,
    dataset:{
      tid:String(teacherId),
      path:`oneSessionPerDay.${day}.${mode}`,
      rbOneSessionDay:String(day),
      rbOneSessionMode:String(mode)
    },
    matches(selector){ return selector === 'input[type="checkbox"][data-tid][data-path]'; },
    closest(){ return row; }
  };
  row.boxes.push(box);
  return box;
}

function sessionRow(){
  const row = {boxes:[]};
  row.querySelector = (selector) => row.boxes.find(box => selector.includes(`data-rb-one-session-mode="${box.dataset.rbOneSessionMode}"`) && selector.includes(`data-rb-one-session-day="${box.dataset.rbOneSessionDay}"`)) || null;
  return row;
}

test("hai ô Sáng/Chiều không còn loại trừ nhau", () => {
  const api = loadConstraints(teacherData({GV1:{}}), ["thu2","thu3"]);
  const row = sessionRow();
  const morning = modeBox("GV1","thu2","morning",true,row);
  const afternoon = modeBox("GV1","thu2","afternoon",true,row);
  const root = {querySelectorAll(){ return row.boxes; }};
  assert.equal(api.__testHooks.enforceTeacherOneSessionInputs(root, morning).length, 0);
  assert.equal(morning.checked, true);
  assert.equal(afternoon.checked, true);
});

test("lưu nhanh một ô ghi trạng thái cả hai ô của ngày rồi chuẩn hoá về một cờ", () => {
  const api = loadConstraints(teacherData({GV1:{oneSessionPerDay:{thu2:{either:true}}}, GV2:{}}), ["thu2","thu3"]);
  const save = api.__testHooks.fastSaveCheckboxTargets;
  const rowGv1 = sessionRow();
  const gv1Morning = modeBox("GV1","thu2","morning",true,rowGv1);
  const gv1Afternoon = modeBox("GV1","thu2","afternoon",true,rowGv1);

  // đang "sáng hoặc chiều" -> bỏ ô Sáng = chỉ chiều
  gv1Morning.checked = false;
  save([gv1Morning]);
  assert.deepEqual(json(api.get()).teacher.GV1.oneSessionPerDay.thu2, {afternoon:true});

  // bỏ nốt ô Chiều = tự do
  gv1Afternoon.checked = false;
  save([gv1Afternoon]);
  assert.equal(json(api.get()).teacher.GV1, undefined);

  // tick cả hai = sáng hoặc chiều; tick một = chỉ buổi đó
  gv1Morning.checked = true;
  save([gv1Morning]);
  assert.deepEqual(json(api.get()).teacher.GV1.oneSessionPerDay.thu2, {morning:true});
  gv1Afternoon.checked = true;
  save([gv1Afternoon]);
  assert.deepEqual(json(api.get()).teacher.GV1.oneSessionPerDay.thu2, {either:true});

  // ô chọn tất cả của cột Chiều (nhiều GV cùng lúc)
  const rowGv2 = sessionRow();
  modeBox("GV2","thu2","morning",false,rowGv2);
  const gv2Afternoon = modeBox("GV2","thu2","afternoon",true,rowGv2);
  gv1Afternoon.checked = false;
  save([gv1Afternoon, gv2Afternoon]);
  const after = json(api.get()).teacher;
  assert.deepEqual(after.GV1.oneSessionPerDay.thu2, {morning:true});
  assert.deepEqual(after.GV2.oneSessionPerDay.thu2, {afternoon:true});
});

test("regular and bulk saves canonicalize a mode to one true key", () => {
  const fastSaveStart = CONSTRAINTS_SOURCE.indexOf("function fastSaveCheckboxTargets");
  const fastSaveEnd = CONSTRAINTS_SOURCE.indexOf("function autoSaveGroupFromUI", fastSaveStart);
  const fastSaveSource = CONSTRAINTS_SOURCE.slice(fastSaveStart, fastSaveEnd);
  assert.ok(fastSaveStart >= 0 && fastSaveEnd > fastSaveStart);
  assert.match(fastSaveSource, /normalizeTeacherOneSessionRule\(c\.teacher\[tid\]\)/);

  const regularSaveStart = CONSTRAINTS_SOURCE.indexOf("function saveCurrentFromUI");
  const regularTeacherEnd = CONSTRAINTS_SOURCE.indexOf("// subject / subjectGroup by class", regularSaveStart);
  const regularTeacherSaveSource = CONSTRAINTS_SOURCE.slice(regularSaveStart, regularTeacherEnd);
  assert.ok(regularSaveStart >= 0 && regularTeacherEnd > regularSaveStart);
  assert.match(
    regularTeacherSaveSource,
    /normalizeTeacherOneSessionRule\(c\.teacher\[[^\]]+\]\)/,
    "a normal row click must persist the same canonical object as a bulk header click"
  );
});

test("constraint tables keep desktop proportions and mobile horizontal work space", () => {
  assert.match(
    CONSTRAINTS_SOURCE,
    /\.rb-desktop-wrap\{[^}]*width:100%;max-width:100%;[^}]*touch-action:pan-x pan-y;/
  );
  assert.match(
    CONSTRAINTS_SOURCE,
    /\.rb-desktop-table\{table-layout:fixed;width:100%;min-width:0;/
  );
  assert.match(CONSTRAINTS_SOURCE, /\.rb-teacher-simple-table col\.rb-teacher-tt-col\{width:48px\}/);
  assert.match(CONSTRAINTS_SOURCE, /\.rb-teacher-simple-table col\.rb-teacher-name-col\{width:190px\}/);
  assert.match(CONSTRAINTS_SOURCE, /\.rb-teacher-one-session-table col\.rb-teacher-name-col\{width:170px\}/);
  assert.match(
    CONSTRAINTS_SOURCE,
    /\.rb-subject-full-table\{width:100%;min-width:720px\}[\s\S]*?\.rb-subject-full-table\{table-layout:fixed\}/
  );
  assert.match(
    CONSTRAINTS_SOURCE,
    /\.rb-subject-full-table th:first-child,#\$\{PANEL_ID\} \.rb-subject-full-table td:first-child\{width:96px\}/
  );
  assert.match(
    CONSTRAINTS_SOURCE,
    /\.rb-subject-full-table th:nth-child\(2\),#\$\{PANEL_ID\} \.rb-subject-full-table td:nth-child\(2\)\{width:82px\}/
  );

  const mobileStart = CONSTRAINTS_SOURCE.indexOf("@media (max-width:860px){");
  const mobileEnd = CONSTRAINTS_SOURCE.indexOf("@media (max-width:860px) and (orientation:portrait)", mobileStart);
  assert.ok(mobileStart >= 0 && mobileEnd > mobileStart, "mobile constraints CSS must be extractable");
  const mobileCss = CONSTRAINTS_SOURCE.slice(mobileStart, mobileEnd);
  assert.match(
    mobileCss,
    /\.table-wrap\{[^}]*max-width:100%;overflow:auto;[^}]*touch-action:pan-x pan-y;/,
    "mobile tables must scroll instead of crushing their controls"
  );
  assert.match(mobileCss, /\.rb-teacher-simple-table\{min-width:720px\}/);
  assert.match(mobileCss, /\.rb-teacher-session-check-table\{min-width:900px\}/);
  assert.match(mobileCss, /\.rb-teacher-one-session-table\{min-width:900px\}/);
  assert.match(mobileCss, /\.rb-teacher-period-table\{min-width:1280px\}/);
});

test("all requirement checkboxes use compact square styling", () => {
  const checkboxStart = CONSTRAINTS_SOURCE.indexOf("#${PANEL_ID} input[type=checkbox]{");
  const checkboxEnd = CONSTRAINTS_SOURCE.indexOf("#${PANEL_ID} .rb-check-all input", checkboxStart);
  assert.ok(checkboxStart >= 0 && checkboxEnd > checkboxStart, "global checkbox CSS must be extractable");
  const checkboxCss = CONSTRAINTS_SOURCE.slice(checkboxStart, checkboxEnd);

  assert.match(checkboxCss, /display:inline-grid;place-items:center;/);
  assert.match(checkboxCss, /width:18px!important;[^}]*height:18px!important;/);
  assert.match(checkboxCss, /border:1px solid #96a4ba;border-radius:4px;background:#fff;/);
  assert.match(checkboxCss, /:checked\{background:#2458d8;border-color:#2458d8;/);
  assert.match(checkboxCss, /:checked::before\{border-color:#fff;transform:rotate\(45deg\) scale\(1\)\}/);
  assert.doesNotMatch(checkboxCss, /border-radius:999px|translateX\(/, "checkboxes must not regress to switch pills");
});
