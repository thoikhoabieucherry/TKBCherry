"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const plannerHtml = fs.readFileSync(
  path.resolve(__dirname, "..", "web", "pages", "sapxep.html"),
  "utf8"
);
const plannerSource = fs.readFileSync(
  path.resolve(__dirname, "..", "web", "pages", "phanmon.js"),
  "utf8"
);
const bridgeSource = fs.readFileSync(
  path.resolve(__dirname, "..", "web", "pages", "tkb-rust-bridge.js"),
  "utf8"
);

function buttonMarkup(source, id){
  return (source.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) || [])
    .find(markup => markup.includes(`id="${id}"`)) || "";
}

function inlineSvgMarkup(source){
  return source.match(/<svg\b[^>]*>[\s\S]*?<\/svg>/)?.[0] || "";
}

test("schedule deletion invalidates derived solver state before saving", () => {
  const helperStart = plannerSource.indexOf("function invalidateSolverStateAfterScheduleDelete");
  const helperEnd = plannerSource.indexOf("\nfunction ", helperStart + 10);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "delete invalidation helper is missing");

  const staleFields = [
    "tkbSolverResult",
    "tkbRustSolverResult",
    "tkbSolverPayload",
    "solverResult",
    "solverMetrics",
    "tkbOptimizationPlateau"
  ];
  const data = {
    tkbLessonTeachers:{"L1|ToÃ¡n":"GV01"},
    tkbLessonRooms:{"L1|ToÃ¡n":"P101"},
    keepMe:{value:true}
  };
  staleFields.forEach(field => { data[field] = {stale:true}; });
  const context = {DATA:data};
  vm.runInNewContext(
    `${plannerSource.slice(helperStart, helperEnd)}\nthis.invalidateDeleteState = invalidateSolverStateAfterScheduleDelete;`,
    context
  );

  const originalTeachers = data.tkbLessonTeachers;
  const originalRooms = data.tkbLessonRooms;
  context.invalidateDeleteState(false);
  staleFields.forEach(field => {
    assert.equal(Object.prototype.hasOwnProperty.call(data, field), false, `${field} must be deleted`);
  });
  assert.equal(data.tkbLessonTeachers, originalTeachers, "class deletion must preserve teacher mappings");
  assert.equal(data.tkbLessonRooms, originalRooms, "class deletion must preserve room mappings");
  assert.equal(data.keepMe.value, true, "unrelated planner data must survive invalidation");

  staleFields.forEach(field => { data[field] = {stale:true}; });
  context.invalidateDeleteState(true);
  staleFields.forEach(field => {
    assert.equal(Object.prototype.hasOwnProperty.call(data, field), false, `${field} must stay deleted`);
  });
  assert.equal(typeof data.tkbLessonTeachers, "object");
  assert.equal(typeof data.tkbLessonRooms, "object");
  assert.equal(Object.keys(data.tkbLessonTeachers).length, 0, "school deletion must reset teacher mappings");
  assert.equal(Object.keys(data.tkbLessonRooms).length, 0, "school deletion must reset room mappings");

  const classDeleteBody = plannerSource.slice(
    plannerSource.indexOf("function deleteCurrentClassTKB"),
    plannerSource.indexOf("function deleteAllTKB")
  );
  const schoolDeleteBody = plannerSource.slice(
    plannerSource.indexOf("function deleteAllTKB"),
    plannerSource.indexOf("function toggleDeleteMenu")
  );
  assert.match(classDeleteBody, /invalidateSolverStateAfterScheduleDelete\(false\)/);
  assert.match(schoolDeleteBody, /invalidateSolverStateAfterScheduleDelete\(true\)/);
  assert.ok(
    classDeleteBody.indexOf("invalidateSolverStateAfterScheduleDelete(false)") < classDeleteBody.indexOf("saveStore()"),
    "class deletion must invalidate stale solver state before persistence"
  );
  assert.ok(
    schoolDeleteBody.indexOf("invalidateSolverStateAfterScheduleDelete(true)") < schoolDeleteBody.indexOf("saveStore()"),
    "school deletion must invalidate stale solver state and mappings before persistence"
  );
});

test("teacher pane counts each class-subject assignment once", () => {
  const start = plannerSource.indexOf("function pvTeacherStats(gvCode)");
  const end = plannerSource.indexOf("function pvEnsureRoomForTeacher", start);
  assert.ok(start >= 0 && end > start, "teacher pane statistics helper is missing");
  const source = plannerSource.slice(start, end);
  assert.doesNotMatch(source, /computeMonsForClass/);
  assert.match(source, /requiredSubjectsForClass/);

  const context = {
    DAYS:["thu2"],
    getFilteredLops(){ return [{id:"L1"}, {id:"L2"}]; },
    requiredSubjectsForClass(lop){
      return lop.id === "L1"
        ? [{gv:"GV1", required:10}]
        : [{gv:"GV1", required:8}];
    },
    teacherValueHas(value, code){ return String(value) === String(code); },
    buildTeacherSchedule(){
      return {thu2:{sang:[[{fixed:true}]], chieu:[]}};
    },
    isTeacherFixedOff(){ return false; }
  };
  vm.runInNewContext(`${source}\nthis.readTeacherStats = pvTeacherStats;`, context);

  assert.deepEqual(
    JSON.parse(JSON.stringify(context.readTeacherStats("GV1"))),
    {total:18, assigned:1, offAssigned:0}
  );
});

test("planner keeps eight compact, accessible commands in the mobile toolbar", () => {
  const actionsStart = plannerHtml.indexOf('<div class="toolbar-actions"');
  const feedbackStart = plannerHtml.indexOf('<div class="toolbar-feedback"');
  const secondaryStart = plannerHtml.indexOf('<div class="toolbar-secondary-actions"', feedbackStart);

  assert.ok(actionsStart >= 0, "toolbar-actions wrapper is missing");
  assert.ok(feedbackStart > actionsStart, "toolbar feedback must follow the action row");

  const actions = plannerHtml.slice(actionsStart, feedbackStart);
  const orderedIds = [
    "btnRangBuoc",
    "btnUndoTKB",
    "btnRedoTKB",
    "solveDurationSeconds",
    "btnAutoSort",
    "btnStopAutoSort",
    "btnDeleteAll"
  ];
  let previousIndex = -1;
  for(const id of orderedIds){
    const currentIndex = actions.indexOf(`id="${id}"`);
    assert.ok(currentIndex > previousIndex, `${id} is outside the expected action order`);
    previousIndex = currentIndex;
  }
  const requirementsButton = buttonMarkup(actions, "btnRangBuoc");
  assert.ok(requirementsButton, "requirements button is missing");
  assert.match(requirementsButton, /title="Yêu cầu xếp thời khóa biểu"[^>]*aria-label="Yêu cầu xếp thời khóa biểu"/);
  assert.match(requirementsButton, /<svg class="toolbar-icon toolbar-requirement-icon"[^>]*stroke="currentColor"[^>]*>[\s\S]*?<path\b[^>]*\/>[\s\S]*?<\/svg>/);
  assert.match(requirementsButton, /<span class="toolbar-label-full"[^>]*>Yêu cầu<\/span>/);
  assert.doesNotMatch(requirementsButton, /toolbar-label-compact/);
  assert.doesNotMatch(requirementsButton, />\s*YC\s*</);
  assert.match(actions, /id="btnUndoTKB"[^>]*title="Hoàn tác"[^>]*aria-label="Hoàn tác"[^>]*>\s*<svg class="toolbar-icon"[^>]*>[\s\S]*?<\/svg><\/button>/);
  assert.match(actions, /id="btnRedoTKB"[^>]*title="Làm lại"[^>]*aria-label="Làm lại"[^>]*>\s*<svg class="toolbar-icon"[^>]*>[\s\S]*?<\/svg><\/button>/);
  assert.match(actions, /id="btnAutoSort"[^>]*class="primary icon-button"[^>]*title="Bắt đầu sắp xếp"[^>]*aria-label="Bắt đầu sắp xếp"[^>]*>\s*<svg class="toolbar-icon"[^>]*>[\s\S]*?<\/svg><\/button>/);
  assert.doesNotMatch(actions, /&larr;|&rarr;|&#9654;/);
  const deleteButton = buttonMarkup(actions, "btnDeleteAll");
  assert.ok(deleteButton, "Delete button is missing");
  assert.match(deleteButton, /class="danger icon-button"[^>]*title="Xóa toàn bộ thời khóa biểu"[^>]*aria-label="Xóa toàn bộ thời khóa biểu"/);
  assert.match(deleteButton, /<svg class="toolbar-icon"[^>]*stroke="currentColor"[^>]*>[\s\S]*?<path\b[\s\S]*?<\/svg>\s*<\/button>/);
  assert.doesNotMatch(deleteButton, />\s*X\s*<\/button>/);
  const stopButton = buttonMarkup(actions, "btnStopAutoSort");
  assert.ok(stopButton, "Stop button is missing");
  assert.match(stopButton, /class="[^"]*\bauto-sort-stop\b[^"]*\bicon-button\b[^"]*"/);
  assert.match(stopButton, /title="Dừng sắp xếp"[^>]*aria-label="Dừng sắp xếp"/);
  const stopSvg = inlineSvgMarkup(stopButton);
  assert.match(stopSvg, /<circle\b/);
  assert.match(stopSvg, /<rect\b[^>]*fill="currentColor"[^>]*stroke="none"[^>]*\/>/);
  assert.doesNotMatch(stopSvg, /<line\b|[Mm][^"]*[Vv][^"]*[Mm][^"]*[Vv]/);
  assert.doesNotMatch(stopButton, />\s*(?:Dừng|Đang dừng)\s*</);
  assert.doesNotMatch(actions, /<span[^>]*>s<\/span>/i);
  assert.doesNotMatch(actions, /id="autoSortProgress"|id="statusMsg"|id="statsToggle"|>Home<\/button>/);
  assert.match(plannerHtml, /#solveDurationSeconds\s*\{[^}]*text-align:\s*center;/s);
  const durationTag = actions.match(/<input\b[^>]*id="solveDurationSeconds"[^>]*>/)?.[0] || "";
  assert.ok(durationTag, "duration input is missing");
  assert.doesNotMatch(durationTag, /\bvalue=|\bplaceholder=|\btitle=/i);
  assert.doesNotMatch(actions, /<label class="solve-duration-control"[^>]+title=/i);
  assert.match(
    actions,
    /<label class="solve-duration-control">[\s\S]*?id="solveDurationSeconds"[\s\S]*?<\/label>\s*<button id="btnAutoSort"/,
    "duration input must be immediately adjacent to the left of Play"
  );

  const secondary = plannerHtml.slice(secondaryStart, plannerHtml.indexOf("\n  </div>\n\n</div>", secondaryStart));
  assert.match(secondary, /id="btnHome"[^>]*aria-label="Về trang chủ"[^>]*>Home<\/button>/);
  const statsButton = buttonMarkup(secondary, "statsToggle");
  assert.ok(statsButton, "statistics button is missing");
  assert.match(statsButton, /title="Thống kê thời khóa biểu"[^>]*aria-label="Thống kê thời khóa biểu"/);
  assert.match(statsButton, /<span class="toolbar-label-full"[^>]*>Thống kê<\/span>/);
  assert.match(statsButton, /<span class="toolbar-label-compact"[^>]*>\s*<svg class="toolbar-icon"[^>]*>[\s\S]*?<\/svg>\s*<\/span>/);
  assert.doesNotMatch(statsButton, />\s*TK\s*</);
  assert.notEqual(
    inlineSvgMarkup(requirementsButton),
    inlineSvgMarkup(statsButton),
    "requirements and statistics must use distinct clipboard-check and chart glyphs"
  );
  assert.match(plannerHtml, /\.toolbar-main\s*\{[^}]*grid-template-columns:\s*repeat\(8, minmax\(0, 1fr\)\);[^}]*grid-template-rows:\s*44px var\(--planner-mobile-feedback-h\);/s);
  assert.match(plannerHtml, /\.toolbar-actions\s*\{[^}]*display:\s*contents;/s);
  for(const [id, column] of [
    ["btnRangBuoc", "1"],
    ["btnUndoTKB", "2"],
    ["btnRedoTKB", "3"],
    ["btnAutoSort", "5"]
  ]){
    assert.match(
      plannerHtml,
      new RegExp(`#${id}\\s*\\{[^}]*grid-column:\\s*${column};[^}]*grid-row:\\s*1;`, "s")
    );
  }
  assert.match(plannerHtml, /\.solve-duration-control\s*\{[^}]*grid-column:\s*4;[^}]*grid-row:\s*1;/s);
  assert.match(plannerHtml, /\.toolbar-actions\s*>\s*\.solve-duration-control\s*\{[^}]*order:\s*initial;/s);
  assert.match(
    plannerHtml,
    /\.toolbar-actions\s*>\s*#btnRangBuoc,\s*body\.planner-shell \.toolbar-actions\s*>\s*#btnUndoTKB,\s*body\.planner-shell \.toolbar-actions\s*>\s*#btnRedoTKB,\s*body\.planner-shell \.toolbar-actions\s*>\s*\.solve-duration-control,\s*body\.planner-shell \.toolbar-actions\s*>\s*#btnAutoSort,\s*body\.planner-shell \.toolbar-actions\s*>\s*#btnStopAutoSort,\s*body\.planner-shell \.toolbar-actions\s*>\s*#btnDeleteAll\s*\{[^}]*order:\s*initial;/s,
    "all direct toolbar items must neutralize legacy order rules"
  );
  assert.match(plannerHtml, /#btnDeleteAll\s*\{[^}]*grid-column:\s*6 !important;[^}]*grid-row:\s*1 !important;/s);
  assert.match(plannerHtml, /\.stats-popover-wrap\s*>\s*\.save-button\s*\{[^}]*grid-column:\s*7;[^}]*grid-row:\s*1;/s);
  assert.match(plannerHtml, /\.stats-popover-wrap\s*>\s*\.stats-toggle\s*\{[^}]*grid-column:\s*8;[^}]*grid-row:\s*1;/s);
  assert.match(plannerHtml, /\.toolbar-icon\s*\{[^}]*width:\s*19px;[^}]*height:\s*19px;[^}]*transition:\s*transform \.16s ease;/s);
  assert.match(plannerHtml, /#btnAutoSort \.toolbar-icon\s*\{[^}]*width:\s*18px;[^}]*height:\s*18px;[^}]*transform:\s*translateX\(1px\);/s);
  assert.match(plannerHtml, /\.toolbar-label-compact\s*\{[^}]*display:\s*none;/s);
  assert.match(plannerHtml, /\.toolbar-label-full\s*\{[^}]*display:\s*none;/s);
  assert.match(plannerHtml, /\.toolbar-label-compact\s*\{[^}]*display:\s*inline-flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;/s);
  assert.match(plannerHtml, /\.toolbar-actions\s*>\s*button:focus-visible,[^}]*outline:\s*2px solid #2563eb;[^}]*outline-offset:\s*1px;/s);
  assert.match(plannerHtml, /#btnStopAutoSort\.is-active \+ #btnDeleteAll\s*\{[^}]*display:\s*none !important;/s);
  assert.doesNotMatch(plannerHtml, /#btnHome\[hidden\]\s*\{[^}]*display:\s*none !important;/s);
  assert.match(plannerHtml, /\.toolbar-main\s*\{[^}]*gap:\s*4px 2px;/s);
  assert.equal(
    (plannerHtml.match(/grid-template-columns:\s*repeat\(8, minmax\(0, 1fr\)\);/g) || []).length,
    1,
    "the mobile toolbar must use one inherited set of eight equal tracks"
  );
  assert.doesNotMatch(
    plannerHtml,
    /@media \(max-width:\s*(?:390|360)px\)[\s\S]*?body\.planner-shell \.toolbar-main\s*\{[^}]*grid-template-columns:/,
    "narrow breakpoints must not reintroduce unequal toolbar tracks"
  );
  assert.match(
    plannerHtml,
    /@media \(max-width:\s*900px\) and \(hover:\s*none\) and \(pointer:\s*coarse\),\s*\(max-width:\s*480px\)/
  );
  assert.match(plannerHtml, /phanmon\.js\?v=20260719-v140-cross-tab-agent-reattach-v1/);
  assert.match(plannerHtml, /tkb-rust-bridge\.js\?v=20260719-v140-cross-tab-agent-reattach-v1/);
});

test("desktop Agent sits beside Home, uses an AI icon, and stays out of mobile layouts", () => {
  const secondaryStart = plannerHtml.indexOf('<div class="toolbar-secondary-actions"');
  const secondaryEnd = plannerHtml.indexOf("\n  </div>\n\n</div>", secondaryStart);
  const secondary = plannerHtml.slice(secondaryStart, secondaryEnd);
  const homeIndex = secondary.indexOf('id="btnHome"');
  const helperIndex = secondary.indexOf('id="btnAgentHelper"');
  const statsIndex = secondary.indexOf('id="statsToggle"');
  const helperButton = buttonMarkup(secondary, "btnAgentHelper");

  assert.ok(homeIndex >= 0, "Home button is missing");
  assert.ok(helperIndex > homeIndex, "Agent must immediately follow Home");
  assert.ok(statsIndex > helperIndex, "Agent must stay before Statistics");
  assert.match(
    secondary,
    /id="btnHome"[\s\S]*?>Home<\/button>\s*<button id="btnAgentHelper"/,
    "Agent must be the next toolbar button after Home"
  );
  assert.match(helperButton, /class="agent-helper-button"[^>]*type="button"/);
  assert.match(helperButton, /title="Agent chưa kết nối · bấm để tải cho Windows"[^>]*aria-label="Agent chưa kết nối · bấm để tải cho Windows"/);
  assert.match(helperButton, /data-agent-online="0"/);
  assert.match(helperButton, /class="agent-status-dot"[^>]*aria-hidden="true"/);
  assert.match(helperButton, /onclick="downloadAgentHelper\(\)"[^>]*>[\s\S]*class="toolbar-icon agent-ai-icon"[\s\S]*<span>Agent<\/span><\/button>/);
  assert.match(helperButton, /\shidden(?:\s|>)/);
  assert.match(helperButton, /aria-hidden="true"/);
  assert.match(plannerSource, /async function downloadAgentHelper\(\)/);
  assert.match(plannerSource, /anchor\.href\s*=\s*"\/downloads\/TKBCherryAgent-Windows\.zip\?v=1\.6\.13"/);
  assert.match(plannerSource, /anchor\.download\s*=\s*"TKBCherryAgent-Windows\.zip"/);
  assert.match(plannerSource, /Giải nén ZIP rồi mở TKBCherryAgent\.exe để kết nối\./);
  assert.match(plannerSource, /async function approveAgentPairFromUrl\(\)/);
  assert.match(plannerSource, /fetch\("\/api\/agent-helper\/v1\/pair\/approve"/);
  assert.match(plannerSource, /function isAgentHelperSupportedDevice\(deviceNavigator\)/);
  assert.match(plannerSource, /function syncAgentHelperVisibility\(\)/);
  assert.match(plannerSource, /fetch\("\/api\/agent-helper\/v1\/status"/);
  assert.match(plannerSource, /async function maybeInviteAgentBeforeSort\(\)/);
  assert.match(
    bridgeSource,
    /manualAgentInvite[\s\S]*?maybeInviteAgentBeforeSort[\s\S]*?prepareManualSolveIntent\(\)/,
    "a manual Play click must invite an offline Windows user before sorting"
  );
  assert.match(
    bridgeSource,
    /window\.sapXepTuDongAll\(\{manualAgentInvite:true\}\)/,
    "the Play button must mark the sort as a manual Agent-invite opportunity"
  );
  assert.match(
    plannerHtml,
    /#btnAgentHelper \.agent-status-dot\s*\{[^}]*top:\s*3px;[^}]*left:\s*3px;[^}]*background:\s*#dc2626;/s
  );
  assert.match(
    plannerHtml,
    /#btnAgentHelper\[data-agent-online="1"\] \.agent-status-dot\s*\{[^}]*background:\s*#16a34a;/s
  );
  assert.doesNotMatch(plannerSource, /EncodedCommand|powershell\.exe|Cai-TKBCherry-Agent\.cmd/);

  const supportStart = plannerSource.indexOf("function isAgentHelperSupportedDevice");
  const supportEnd = plannerSource.indexOf("function syncAgentHelperVisibility", supportStart);
  const supportSource = plannerSource.slice(supportStart, supportEnd);
  const supportsAgent = Function(`${supportSource}; return isAgentHelperSupportedDevice;`)();
  assert.equal(supportsAgent({platform:"Win32", userAgent:"Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}), true);
  assert.equal(supportsAgent({userAgentData:{platform:"Windows", mobile:false}, userAgent:""}), true);
  assert.equal(supportsAgent({platform:"MacIntel", maxTouchPoints:0, userAgent:"Mozilla/5.0 (Macintosh)"}), false);
  assert.equal(supportsAgent({platform:"MacIntel", maxTouchPoints:5, userAgent:"Mozilla/5.0 (Macintosh)"}), false);
  assert.equal(supportsAgent({platform:"Linux armv8l", userAgent:"Mozilla/5.0 (Linux; Android 15; Tablet)"}), false);
  assert.equal(supportsAgent({platform:"iPhone", userAgent:"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)"}), false);
  assert.match(
    plannerHtml,
    /\.stats-popover-wrap\s*>\s*\.save-button,\s*body\.planner-shell \.toolbar-secondary-actions \.stats-popover-wrap\s*>\s*\.agent-helper-button,\s*body\.planner-shell \.toolbar-secondary-actions \.stats-popover-wrap\s*>\s*\.stats-toggle\s*\{[^}]*flex:\s*0 0 var\(--planner-toolbar-button-width\);[^}]*width:\s*var\(--planner-toolbar-button-width\);[^}]*min-width:\s*var\(--planner-toolbar-button-width\);[^}]*max-width:\s*var\(--planner-toolbar-button-width\);[^}]*height:\s*36px;[^}]*min-height:\s*36px;/s,
    "Agent must share the rectangular desktop toolbar dimensions"
  );
  assert.match(
    plannerHtml,
    /\.toolbar-actions\s*>\s*button:focus-visible,\s*body\.planner-shell \.toolbar-secondary-actions \.stats-popover-wrap\s*>\s*button:focus-visible\s*\{[^}]*outline:\s*2px solid #2563eb;/s,
    "Agent must inherit the visible keyboard focus ring"
  );

  const mobileStart = plannerHtml.indexOf("@media (max-width: 900px) and (hover: none) and (pointer: coarse)");
  const mobileEnd = plannerHtml.indexOf("@media (min-width: 481px)", mobileStart);
  const mobileCss = plannerHtml.slice(mobileStart, mobileEnd);
  assert.match(mobileCss, /#btnAgentHelper\s*\{[^}]*display:\s*none !important;/s);
  assert.match(
    plannerHtml,
    /@media \(min-width:\s*901px\) and \(hover:\s*none\) and \(pointer:\s*coarse\)\s*\{[\s\S]*?#btnAgentHelper\s*\{[^}]*display:\s*none !important;/s,
    "wide coarse-pointer devices must not expose the desktop-only helper button"
  );
});

test("Agent status state paints the owner-scoped VPS result green or red", () => {
  const start = plannerSource.indexOf("function setAgentHelperOnlineState");
  const end = plannerSource.indexOf("async function refreshAgentHelperStatus", start);
  assert.ok(start >= 0 && end > start, "Agent status renderer is missing");
  const button = {
    dataset:{},
    title:"",
    attributes:{},
    setAttribute(name, value){ this.attributes[name] = value; }
  };
  const context = {
    window:{},
    document:{getElementById(id){ return id === "btnAgentHelper" ? button : null; }}
  };
  vm.runInNewContext(
    `${plannerSource.slice(start, end)}\nthis.renderAgentState = setAgentHelperOnlineState;`,
    context
  );

  assert.equal(context.renderAgentState(true, {known:true, count:2}), true);
  assert.equal(button.dataset.agentOnline, "1");
  assert.equal(button.dataset.agentCount, "2");
  assert.match(button.title, /Agent đang ON/);
  assert.equal(context.window.__TKB_AGENT_STATUS_KNOWN, true);

  assert.equal(context.renderAgentState(false, {known:true, count:0}), false);
  assert.equal(button.dataset.agentOnline, "0");
  assert.match(button.title, /Agent chưa kết nối/);
});

test("Windows invite downloads only when an offline user accepts", async () => {
  const start = plannerSource.indexOf("async function maybeInviteAgentBeforeSort");
  const end = plannerSource.indexOf("function setAutoSortHomeHidden", start);
  assert.ok(start >= 0 && end > start, "Agent invitation helper is missing");
  const invitationSource = plannerSource.slice(start, end);

  const makeContext = ({supported=true, status=false, accepted=false} = {}) => {
    let prompts = 0;
    let downloads = 0;
    const context = {
      navigator:{platform:supported ? "Win32" : "MacIntel", userAgent:""},
      window:{
        __TKB_AGENT_INVITE_SHOWN:false,
        confirm(){ prompts += 1; return accepted; }
      },
      isAgentHelperSupportedDevice(){ return supported; },
      async refreshAgentHelperStatus(){ return status; },
      async downloadAgentHelper(){ downloads += 1; return true; },
      _setStatus(){},
    };
    context.window.window = context.window;
    vm.runInNewContext(
      `${invitationSource}\nthis.inviteBeforeSort = maybeInviteAgentBeforeSort;`,
      context
    );
    return {context, prompts:() => prompts, downloads:() => downloads};
  };

  const mobile = makeContext({supported:false});
  assert.equal(await mobile.context.inviteBeforeSort(), true);
  assert.equal(mobile.prompts(), 0);

  const online = makeContext({status:true});
  assert.equal(await online.context.inviteBeforeSort(), true);
  assert.equal(online.prompts(), 0);

  const declined = makeContext({status:false, accepted:false});
  assert.equal(await declined.context.inviteBeforeSort(), true);
  assert.equal(await declined.context.inviteBeforeSort(), true);
  assert.equal(declined.prompts(), 1, "the invitation must appear once per page session");
  assert.equal(declined.downloads(), 0);

  const acceptedInvite = makeContext({status:false, accepted:true});
  assert.equal(await acceptedInvite.context.inviteBeforeSort(), false);
  assert.equal(acceptedInvite.prompts(), 1);
  assert.equal(acceptedInvite.downloads(), 1);
  assert.equal(acceptedInvite.context.window.__TKB_AGENT_INVITE_SHOWN, false);
  assert.equal(await acceptedInvite.context.inviteBeforeSort(), false);
  assert.equal(acceptedInvite.prompts(), 2);
  assert.equal(acceptedInvite.downloads(), 2);
});

test("a hung Agent status check times out and lets VPS sorting continue", async () => {
  const start = plannerSource.indexOf("async function refreshAgentHelperStatus");
  const end = plannerSource.indexOf("function setAutoSortHomeHidden", start);
  assert.ok(start >= 0 && end > start, "Agent preflight helpers are missing");
  const preflightSource = plannerSource.slice(start, end);
  let timeoutMs = 0;
  let timeoutClears = 0;
  let prompts = 0;
  let signal = null;
  const context = {
    AbortController,
    navigator:{platform:"Win32", userAgent:""},
    window:{
      __TKB_AGENT_INVITE_SHOWN:false,
      confirm(){ prompts += 1; return false; },
      setTimeout(callback, delay){
        timeoutMs = Number(delay || 0);
        Promise.resolve().then(callback);
        return 1;
      },
      clearTimeout(){ timeoutClears += 1; }
    },
    Date,
    syncAgentHelperVisibility(){ return true; },
    setAgentHelperOnlineState(){ return false; },
    isAgentHelperSupportedDevice(){ return true; },
    async downloadAgentHelper(){ throw new Error("a failed status check must not download"); },
    _setStatus(){},
    fetch(_url, options){
      signal = options.signal;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("status timeout");
          error.name = "AbortError";
          reject(error);
        }, {once:true});
      });
    }
  };
  context.window.window = context.window;
  vm.runInNewContext(
    `${preflightSource}\nthis.inviteBeforeSort = maybeInviteAgentBeforeSort;`,
    context
  );

  assert.equal(await context.inviteBeforeSort(), true);
  assert.equal(timeoutMs, 2500);
  assert.equal(signal?.aborted, true);
  assert.equal(timeoutClears, 1);
  assert.equal(prompts, 0, "unknown Agent state must fall through to VPS without another modal");
  assert.equal(context.window.__TKB_AGENT_STATUS_INFLIGHT, null);
});

test("a connected green Agent never downloads the ZIP again", async () => {
  const start = plannerSource.indexOf("async function downloadAgentHelper");
  const end = plannerSource.indexOf("async function approveAgentPairFromUrl", start);
  assert.ok(start >= 0 && end > start, "Agent download helper is missing");
  let created = 0;
  const statuses = [];
  const button = {dataset:{agentOnline:"1"}};
  const context = {
    window:{__TKB_AGENT_ONLINE:true},
    document:{
      getElementById(){ return button; },
      createElement(){ created += 1; return {}; },
      body:{appendChild(){}}
    },
    syncAgentHelperVisibility(){ return true; },
    _setStatus(message, kind){ statuses.push([message, kind]); }
  };
  vm.runInNewContext(
    `${plannerSource.slice(start, end)}\nthis.downloadConnectedAgent = downloadAgentHelper;`,
    context
  );
  assert.equal(await context.downloadConnectedAgent(), false);
  assert.equal(created, 0);
  assert.deepEqual(statuses, [["Agent đang ON và đã kết nối với VPS.", "ok"]]);
});

test("toolbar status messages hide after five seconds", () => {
  const statusStart = plannerSource.indexOf("function fitPlannerMobileStatusMessage");
  const statusEnd = plannerSource.indexOf("function _autoSortProgressYield", statusStart);
  assert.ok(statusStart >= 0 && statusEnd > statusStart, "status helper is missing");
  const element = {
    textContent:"",
    style:{display:"", color:""},
    classList:{remove(name){ this.removed = String(name); }}
  };
  let callback = null;
  let delay = 0;
  const cleared = [];
  const context = {
    document:{getElementById(id){ return id === "statusMsg" ? element : null; }},
    window:{
      __TKB_STATUS_HIDE_TIMER:0,
      clearTimeout(id){ cleared.push(id); },
      setTimeout(next, milliseconds){ callback = next; delay = milliseconds; return 41; }
    }
  };
  vm.runInNewContext(
    `${plannerSource.slice(statusStart, statusEnd)}\nthis.setPlannerStatus = _setStatus;`,
    context
  );
  context.setPlannerStatus("Đã tải Agent.", "ok");
  assert.equal(element.textContent, "Đã tải Agent.");
  assert.equal(element.style.display, "inline-block");
  assert.equal(delay, 5000);
  assert.equal(context.window.__TKB_STATUS_HIDE_TIMER, 41);
  assert.equal(typeof callback, "function");
  callback();
  assert.equal(element.textContent, "");
  assert.equal(element.style.display, "none");
  assert.equal(element.classList.removed, "is-auto-sort-running-label");
  assert.equal(context.window.__TKB_STATUS_HIDE_TIMER, 0);
  assert.deepEqual(cleared, [0]);

  callback = null;
  delay = 0;
  context.setPlannerStatus("Đã xếp xong!", "ok");
  assert.equal(element.textContent, "Đã xếp xong!");
  assert.equal(element.style.display, "inline-block");
  assert.equal(callback, null, "the final success notice must not receive a hide timer");
  assert.equal(delay, 0);
  assert.equal(context.window.__TKB_STATUS_HIDE_TIMER, 0);
});

test("mobile status text keeps a readable size and wraps instead of scaling", () => {
  const fitStart = plannerSource.indexOf("function fitPlannerMobileStatusMessage");
  const fitEnd = plannerSource.indexOf("\ntry{", fitStart);
  assert.ok(fitStart >= 0 && fitEnd > fitStart, "mobile status fitting helper is missing");
  const style = {display:"inline-block", fontSize:"", transform:"", transformOrigin:"", letterSpacing:""};
  const element = {
    textContent:"A deliberately long mobile scheduler status message that must remain complete",
    style,
    title:""
  };
  const context = {
    window:{
      innerWidth:440,
      innerHeight:956,
      matchMedia(query){ return {matches:query.includes("pointer: coarse")}; }
    }
  };
  vm.runInNewContext(
    `${plannerSource.slice(fitStart, fitEnd)}\nthis.fitStatus = fitPlannerMobileStatusMessage;`,
    context
  );

  assert.equal(context.fitStatus(element), true);
  assert.equal(style.fontSize, "");
  assert.equal(style.transform, "");
  assert.equal(style.transformOrigin, "");
  assert.equal(style.letterSpacing, "0");
  assert.equal(element.title, element.textContent);
});

test("mobile support timetable wraps long class and subject labels at readable boundaries", () => {
  assert.match(plannerHtml, /\.tkb-support-table td\s*\{[^}]*padding-inline:\s*2px;/s);
  assert.match(
    plannerHtml,
    /\.tkb-support-table \.tkb-gv-cell,\s*body\.planner-shell \.tkb-support-table \.tkb-cell-line\s*\{[^}]*font-size:\s*clamp\(9px, 2\.6vw, 10px\);[^}]*line-height:\s*1\.05;[^}]*white-space:\s*normal;[^}]*word-break:\s*normal;[^}]*overflow-wrap:\s*normal;/s
  );
});

test("mobile timetable cells stack the requested labels without a dash", () => {
  const helperStart = plannerSource.indexOf("function mobileStackCellLineHTML");
  const helperEnd = plannerSource.indexOf("function getTeacherListForCurrentFilter", helperStart);
  const helperSource = plannerSource.slice(helperStart, helperEnd);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "mobile cell-line helper is missing");
  assert.match(helperSource, /tkb-cell-primary/);
  assert.match(helperSource, /tkb-cell-separator/);
  assert.match(helperSource, /tkb-cell-secondary/);
  assert.match(
    plannerSource,
    /function cellHTML\([\s\S]*?mobileStackCellLineHTML\(monShort, teacherShort, "tkb-class-line tkb-lesson-line"\)/
  );
  assert.equal(
    (plannerSource.match(/mobileStackCellLineHTML\(e\.classDisplay, monShort, "tkb-class-line tkb-class-subject-line"\)/g) || []).length,
    2,
    "both teacher timetable renderers must put class above abbreviated subject"
  );
  assert.equal(
    (plannerSource.match(/tkb-teacher-line tkb-room-line/g) || []).length,
    2,
    "teacher timetable room lines must be marked so mobile can hide them"
  );
  assert.match(
    plannerHtml,
    /\.tkb-mobile-stack-line\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*text-align:\s*center;/s
  );
  assert.match(
    plannerHtml,
    /\.tkb-mobile-stack-line\s*>\s*\.tkb-cell-separator,[^}]*\.tkb-support-table \.tkb-room-line\s*\{[^}]*display:\s*none;/s
  );
});

test("mobile Play matches the other controls and centers its white glyph", () => {
  const mobileStart = plannerHtml.indexOf("@media (max-width: 900px) and (hover: none) and (pointer: coarse)");
  const mobileEnd = plannerHtml.indexOf("@media (min-width: 481px)", mobileStart);
  const mobileCss = plannerHtml.slice(mobileStart, mobileEnd);

  assert.ok(mobileStart >= 0 && mobileEnd > mobileStart, "mobile toolbar media query is missing");
  assert.match(
    mobileCss,
    /#btnAutoSort\s*\{[^}]*grid-column:\s*5;[^}]*grid-row:\s*1;/s
  );
  assert.match(
    mobileCss,
    /\.toolbar-actions\s*>\s*button\.icon-button\s*\{[^}]*flex:\s*0 1 auto;[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*max-width:\s*none;[^}]*height:\s*44px;[^}]*min-height:\s*44px;[^}]*padding:\s*0;/s
  );
  assert.match(mobileCss, /#btnAutoSort\s*\{[^}]*padding:\s*0 !important;/s);
  assert.match(
    mobileCss,
    /#btnAutoSort \.toolbar-icon\s*\{[^}]*margin:\s*0;[^}]*transform:\s*translateX\(1px\);/s
  );
  assert.match(
    mobileCss,
    /#btnAutoSort:hover:not\(:disabled\) \.toolbar-icon\s*\{[^}]*transform:\s*translateX\(1px\) scale\(1\.06\);/s
  );
  assert.equal(
    (mobileCss.match(/grid-template-columns:\s*repeat\(8, minmax\(0, 1fr\)\);/g) || []).length,
    1
  );
  assert.doesNotMatch(mobileCss, /#btnAutoSort\s*\{[^}]*(?:border-radius:\s*50%|aspect-ratio|width:\s*min\(42px)/s);
});

test("Undo, Redo, and Play reuse one SVG glyph across desktop and mobile", () => {
  for(const id of ["btnUndoTKB", "btnRedoTKB", "btnAutoSort"]){
    const button = buttonMarkup(plannerHtml, id);
    assert.ok(button, `${id} is missing`);
    assert.equal(
      (button.match(/<svg\b/g) || []).length,
      1,
      `${id} must have one shared inline SVG instead of breakpoint-specific glyphs`
    );
  }

  const mobileStart = plannerHtml.indexOf("@media (max-width: 900px) and (hover: none) and (pointer: coarse)");
  const mobileEnd = plannerHtml.indexOf("@media (min-width: 481px)", mobileStart);
  const mobileCss = plannerHtml.slice(mobileStart, mobileEnd);
  assert.doesNotMatch(
    mobileCss,
    /#(?:btnUndoTKB|btnRedoTKB|btnAutoSort)(?::before|::before|:after|::after)\s*\{[^}]*content:/s
  );
});

test("Stop state changes preserve the inline stop-circle and square markup", () => {
  const stopStateStart = plannerSource.indexOf("function setAutoSortStopVisible");
  const stopStateEnd = plannerSource.indexOf("function finishAutoSortProgress", stopStateStart);
  const stopStateSource = plannerSource.slice(stopStateStart, stopStateEnd);

  assert.ok(stopStateStart >= 0 && stopStateEnd > stopStateStart, "Stop state helpers are missing");
  assert.doesNotMatch(stopStateSource, /\bbtn\.(?:textContent|innerHTML|outerHTML)\s*=/);
  assert.doesNotMatch(stopStateSource, /\bbtn\.replaceChildren\s*\(/);
});

test("mobile progress keeps its row reserved but hides idle content", () => {
  const idleStart = plannerSource.indexOf("function hideAutoSortProgress");
  const progressStart = plannerSource.indexOf("function setAutoSortProgress", idleStart);
  const finishStart = plannerSource.indexOf("function finishAutoSortProgress", progressStart);
  const finishEnd = plannerSource.indexOf("function invalidateSolverStateAfterScheduleDelete", finishStart);
  const idleSource = plannerSource.slice(idleStart, progressStart);
  const finishSource = plannerSource.slice(finishStart, finishEnd);

  assert.ok(idleStart >= 0 && progressStart > idleStart && finishStart > progressStart && finishEnd > finishStart);
  assert.match(idleSource, /classList\.add\("is-idle"\)/);
  assert.match(idleSource, /wrap\.hidden\s*=\s*true/);
  assert.match(idleSource, /setAttribute\("aria-hidden",\s*"true"\)/);
  assert.match(idleSource, /pct\.textContent\s*=\s*"0%"/);
  assert.match(idleSource, /text\.textContent\s*=\s*"Sẵn sàng"/);
  assert.doesNotMatch(finishSource, /setTimeout\s*\(/);
  assert.match(finishSource, /hideAutoSortProgress\(\)/);
  assert.doesNotMatch(finishSource, /setAutoSortProgress\(100,\s*"Hoàn tất"\)/);
});

test("cross-device observer progress locks Play and exposes the owner cancel action", () => {
  const progressStart = plannerSource.indexOf("function setAutoSortProgress");
  const progressEnd = plannerSource.indexOf("\nfunction ", progressStart + 10);
  const body = plannerSource.slice(progressStart, progressEnd);
  assert.match(body, /setAutoSortStopVisible\(true\)/);
  assert.match(body, /if\(!window\.__AUTO_SORT_STOP_REQUESTED && n < 100\)/);
  assert.doesNotMatch(body, /__TKB_BACKEND_JOB_OBSERVER_ONLY|observingOnly/);
});

test("mobile viewport follows iOS visualViewport through orientation changes", () => {
  const syncStart = plannerSource.indexOf("function syncPlannerMobileViewportHeight");
  const syncEnd = plannerSource.indexOf("/* =======================", syncStart);
  const syncSource = plannerSource.slice(syncStart, syncEnd);

  assert.ok(syncStart >= 0 && syncEnd > syncStart, "mobile viewport synchronization is missing");
  assert.match(syncSource, /window\.visualViewport\?\.height/);
  assert.match(syncSource, /Math\.max\(visualHeight, innerHeight, layoutHeight\)/);
  assert.match(syncSource, /standaloneMobileScreenHeight\(measuredHeight\)/);
  assert.match(syncSource, /--tkb-mobile-viewport-h/);
  assert.match(syncSource, /orientationchange/);
  assert.match(syncSource, /\[120, 360, 900\]/);
  assert.match(plannerHtml, /height:\s*var\(--tkb-mobile-viewport-h, 100dvh\)/);
});

test("mobile viewport does not double-subtract iPhone standalone safe areas", () => {
  const syncStart = plannerSource.indexOf("(function installPlannerMobileViewportSync");
  const syncEnd = plannerSource.indexOf("/* =======================", syncStart);
  const values = new Map();
  const context = {
    document: {
      documentElement: {
        clientHeight: 956,
        style: {setProperty: (name, value) => values.set(name, value)}
      }
    },
    window: {
      innerHeight: 956,
      visualViewport: {height: 862, addEventListener(){}},
      requestAnimationFrame(callback){ callback(); return 1; },
      cancelAnimationFrame(){},
      addEventListener(){},
      setTimeout(){},
      screen: {orientation: {addEventListener(){}}}
    }
  };

  vm.runInNewContext(plannerSource.slice(syncStart, syncEnd), context);
  assert.equal(values.get("--tkb-mobile-viewport-h"), "956px");

  context.window.innerHeight = 440;
  context.window.visualViewport.height = 393;
  context.document.documentElement.clientHeight = 440;
  context.window.syncPlannerMobileViewportHeight();
  assert.equal(values.get("--tkb-mobile-viewport-h"), "440px");
});

test("standalone mobile uses the oriented screen height while browser tabs keep the dynamic viewport", () => {
  const syncStart = plannerSource.indexOf("(function installPlannerMobileViewportSync");
  const syncEnd = plannerSource.indexOf("/* =======================", syncStart);

  function measuredHeightFor({
    innerHeight,
    innerWidth,
    visualHeight,
    layoutHeight,
    screenWidth,
    screenHeight,
    standalone,
    displayModeStandalone,
    portrait,
    maxTouchPoints
  }){
    const values = new Map();
    const context = {
      document:{
        documentElement:{
          clientHeight:layoutHeight,
          style:{setProperty:(name, value) => values.set(name, value)}
        }
      },
      window:{
        innerHeight,
        innerWidth,
        navigator:{standalone, maxTouchPoints},
        screen:{
          width:screenWidth,
          height:screenHeight,
          orientation:{addEventListener(){}}
        },
        visualViewport:{height:visualHeight, addEventListener(){}},
        matchMedia(query){
          return {
            matches:query.includes("display-mode") ? displayModeStandalone : portrait
          };
        },
        requestAnimationFrame(callback){ callback(); return 1; },
        cancelAnimationFrame(){},
        addEventListener(){},
        setTimeout(){}
      }
    };
    vm.runInNewContext(plannerSource.slice(syncStart, syncEnd), context);
    return values.get("--tkb-mobile-viewport-h");
  }

  assert.equal(measuredHeightFor({
    innerHeight:862,
    innerWidth:440,
    visualHeight:862,
    layoutHeight:862,
    screenWidth:440,
    screenHeight:956,
    standalone:true,
    displayModeStandalone:true,
    portrait:true,
    maxTouchPoints:5
  }), "956px");
  assert.equal(measuredHeightFor({
    innerHeight:393,
    innerWidth:956,
    visualHeight:393,
    layoutHeight:393,
    screenWidth:440,
    screenHeight:956,
    standalone:true,
    displayModeStandalone:true,
    portrait:false,
    maxTouchPoints:5
  }), "440px");
  assert.equal(measuredHeightFor({
    innerHeight:780,
    innerWidth:412,
    visualHeight:720,
    layoutHeight:780,
    screenWidth:412,
    screenHeight:915,
    standalone:false,
    displayModeStandalone:false,
    portrait:true,
    maxTouchPoints:5
  }), "780px");
  assert.equal(measuredHeightFor({
    innerHeight:840,
    innerWidth:412,
    visualHeight:840,
    layoutHeight:840,
    screenWidth:412,
    screenHeight:915,
    standalone:false,
    displayModeStandalone:true,
    portrait:true,
    maxTouchPoints:5
  }), "915px");
});

test("paired class and teacher headers retain assigned totals for desktop", () => {
  const classStatsStart = plannerSource.indexOf("function pvClassStatsHTML");
  const teacherStatsStart = plannerSource.indexOf("function pvTeacherStatsHTML");
  const statsEnd = plannerSource.indexOf("function pvSetPairStack", teacherStatsStart);
  const classStatsSource = plannerSource.slice(classStatsStart, teacherStatsStart);
  const teacherStatsSource = plannerSource.slice(teacherStatsStart, statsEnd);

  assert.ok(classStatsStart >= 0 && teacherStatsStart > classStatsStart && statsEnd > teacherStatsStart);
  assert.match(classStatsSource, /Đã xếp:<b>/);
  assert.match(classStatsSource, /Chưa phân:<b>/);
  assert.match(teacherStatsSource, /Đã xếp:<b>/);
  assert.match(teacherStatsSource, /Chưa phân:<b>/);
  assert.match(
    teacherStatsSource,
    /return `<div class="tkb-pair-class-stats tkb-pair-teacher-stats">`\+[\s\S]*?Đã xếp:<b>[\s\S]*?Chưa phân:<b>[\s\S]*?offAssignedHTML\+/
  );
  assert.match(
    plannerHtml,
    /#tkb\.tkb-pair-stack \.tkb-pair-class-stats\s*\{[^}]*display:\s*none !important;/s
  );
});

test("portrait phones fit the complete class and teacher timetable panes", () => {
  const portraitStart = plannerHtml.indexOf("@media (max-width: 480px) and (orientation: portrait)");
  const portraitCss = plannerHtml.slice(portraitStart, plannerHtml.indexOf("</style>", portraitStart));

  assert.ok(portraitStart >= 0, "portrait timetable breakpoint is missing");
  assert.match(portraitCss, /--tkb-pair-toolbar-h:\s*28px/);
  assert.match(portraitCss, /--tkb-pair-head-h:\s*20px/);
  assert.match(portraitCss, /--tkb-pair-row-h:\s*clamp\(21px, calc\(\(var\(--tkb-mobile-viewport-h, 100dvh\) - 198px\) \/ 22\), 32px\)/);
  assert.match(portraitCss, /grid-template-rows:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(portraitCss, /\.tkb-pair-body\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/s);
  assert.match(portraitCss, /\.tkb-pair-toolbar\s*\{[^}]*grid-template-rows:\s*26px;/s);
  assert.match(portraitCss, /\.table\s*\{[^}]*width:\s*100% !important;[^}]*min-width:\s*0 !important;[^}]*height:\s*100% !important;[^}]*table-layout:\s*fixed !important;/s);
  assert.match(portraitCss, /\.table th,\s*body\.planner-shell #tkb\.tkb-pair-stack \.table td\s*\{[^}]*width:\s*auto !important;[^}]*padding:\s*0 1px !important;/s);
  assert.match(portraitCss, /\.table td\s*\{[^}]*height:\s*var\(--tkb-pair-row-h\);[^}]*font-size:\s*clamp\(8px, 2\.35vw, 9\.5px\);/s);
  assert.match(plannerSource, /function pvTeacherTableHTML[\s\S]*?<table class='table tkb-support-table'>[\s\S]*?DAYS\.forEach/);
});

test("landscape phones show a full session in both panes and scroll the remainder", () => {
  const landscapeStart = plannerHtml.indexOf("@media (orientation: landscape) and (max-height: 540px)");
  const landscapeCss = plannerHtml.slice(landscapeStart, plannerHtml.indexOf("</style>", landscapeStart));

  assert.ok(landscapeStart >= 0, "phone landscape breakpoint is missing");
  assert.match(landscapeCss, /body\.planner-shell\s*\{[^}]*--planner-mobile-feedback-h:\s*34px;/s);
  assert.match(landscapeCss, /\.toolbar-main\s*\{[^}]*grid-template-rows:\s*44px var\(--planner-mobile-feedback-h\);[^}]*row-gap:\s*2px;/s);
  assert.match(
    landscapeCss,
    /\.toolbar-feedback\s*\{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*var\(--planner-mobile-feedback-h\);[^}]*height:\s*var\(--planner-mobile-feedback-h\);[^}]*min-height:\s*var\(--planner-mobile-feedback-h\);[^}]*max-height:\s*var\(--planner-mobile-feedback-h\);/s
  );
  assert.match(landscapeCss, /\.toolbar-feedback \.auto-sort-track\s*\{[^}]*width:\s*18px;[^}]*height:\s*18px;[^}]*flex-basis:\s*18px;/s);
  assert.match(
    landscapeCss,
    /#tkb\.tkb-pair-lop-gv\s*\{[^}]*--tkb-pair-head-h:\s*18px;[^}]*--tkb-pair-row-h:\s*clamp\(20px, calc\(\(var\(--tkb-mobile-viewport-h, 100dvh\) - 160px\) \/ 10\), 28px\);[^}]*display:\s*grid;[^}]*grid-template-rows:\s*repeat\(2, minmax\(0, 1fr\)\);[^}]*height:\s*100%;[^}]*overflow:\s*hidden;/s
  );
  assert.match(
    landscapeCss,
    /\.tkb-pair-body\s*\{[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain;[^}]*touch-action:\s*pan-y;[^}]*-webkit-overflow-scrolling:\s*touch;/s
  );
  assert.match(landscapeCss, /\.table\s*\{[^}]*height:\s*auto !important;[^}]*table-layout:\s*fixed !important;/s);
  assert.match(landscapeCss, /\.table th\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;[^}]*z-index:\s*3;/s);
  assert.match(landscapeCss, /\.tkb-pair-summary\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*nowrap;/s);
  assert.doesNotMatch(landscapeCss, /\.tkb-pair-class-stats\s*\{[^}]*display:\s*flex;/s);
  assert.match(
    landscapeCss,
    /@media \(orientation:\s*landscape\) and \(max-height:\s*370px\)[^{]*\{[\s\S]*?\.table td\s*\{[^}]*font-size:\s*9px;[^}]*line-height:\s*1;/s
  );
  assert.doesNotMatch(landscapeCss, /data-landscape-pane|tkb-landscape-pane-switch/);

  // At the shortest supported landscape viewport, each half still fits the
  // weekday header plus five periods before its independent vertical scroll.
  const shortestLandscapeHeight = 360;
  const compactToolbarHeight = 70;
  const centerPaddingAndPaneGap = 3;
  const paneToolbarHeight = 25;
  const paneBodyHeight = (
    shortestLandscapeHeight - compactToolbarHeight - centerPaddingAndPaneGap
  ) / 2 - paneToolbarHeight;
  assert.ok(paneBodyHeight >= 18 + (5 * 20));
});

test("sorting keeps Home and a supported Windows Agent locked in stable toolbar slots", () => {
  const homeControl = plannerSource.slice(
    plannerSource.indexOf("function setAutoSortHomeHidden"),
    plannerSource.indexOf("function setAutoSortBusyControls")
  );
  const busyControls = plannerSource.slice(
    plannerSource.indexOf("function setAutoSortBusyControls"),
    plannerSource.indexOf("function setAutoSortStopVisible")
  );

  assert.match(homeControl, /btn\.hidden\s*=\s*false/);
  assert.match(homeControl, /setAutoSortControlLocked\(btn,\s*shouldLock\)/);
  assert.doesNotMatch(homeControl, /btn\.hidden\s*=\s*!!hidden/);
  assert.match(homeControl, /getElementById\("btnAgentHelper"\)/);
  assert.match(homeControl, /agentBtn\.hidden\s*=\s*!agentSupported/);
  assert.match(homeControl, /agentBtn\.setAttribute\("aria-hidden",\s*agentSupported\s*\?\s*"false"\s*:\s*"true"\)/);
  assert.match(homeControl, /setAutoSortControlLocked\(agentBtn,\s*shouldLock\)/);
  assert.doesNotMatch(homeControl, /agentBtn\.hidden\s*=\s*shouldLock/);
  assert.match(
    plannerHtml,
    /#btnHome\.is-auto-sort-disabled,\s*body\.planner-shell #btnAgentHelper\.is-auto-sort-disabled\s*\{[^}]*opacity:\s*\.45;[^}]*filter:\s*saturate\(\.6\);/s
  );
  assert.match(busyControls, /getElementById\("btnUndoTKB"\)/);
  assert.match(busyControls, /getElementById\("btnRedoTKB"\)/);
  assert.match(busyControls, /getElementById\("solveDurationSeconds"\)/);
  assert.match(busyControls, /setAutoSortControlLocked\(el,\s*shouldLock\)/);

  function makeControl(disabled = false){
    const attributes = new Map();
    const classes = new Set();
    return {
      hidden:false,
      disabled,
      dataset:{},
      classList:{
        add(name){ classes.add(String(name)); },
        remove(name){ classes.delete(String(name)); },
        contains(name){ return classes.has(String(name)); }
      },
      setAttribute(name, value){ attributes.set(String(name), String(value)); },
      removeAttribute(name){ attributes.delete(String(name)); },
      getAttribute(name){ return attributes.get(String(name)) ?? null; }
    };
  }

  const controls = {
    btnHome:makeControl(false),
    btnUndoTKB:makeControl(false),
    btnRedoTKB:makeControl(true),
    btnDeleteAll:makeControl(false),
    btnRangBuoc:makeControl(false),
    solveDurationSeconds:makeControl(false)
  };
  let historyRefreshes = 0;
  const context = {
    window:{__TKB_RUST_SOLVER_RUNNING:false, __TKB_SOLVE_UI_BUSY:false},
    document:{
      getElementById(id){ return controls[id] || null; },
      querySelectorAll(){ return []; }
    },
    __tkbUpdateHistoryButtons(){ historyRefreshes += 1; }
  };
  vm.runInNewContext(`${plannerSource.slice(
    plannerSource.indexOf("function setAutoSortControlLocked"),
    plannerSource.indexOf("function setAutoSortStopVisible")
  )}\nthis.lockBusyControls = setAutoSortBusyControls;`, context);

  context.lockBusyControls(true);
  assert.equal(controls.btnHome.hidden, false);
  assert.equal(controls.btnHome.disabled, true);
  assert.equal(controls.btnUndoTKB.disabled, true);
  assert.equal(controls.btnRedoTKB.disabled, true);
  assert.equal(controls.solveDurationSeconds.disabled, true);

  context.lockBusyControls(false);
  assert.equal(controls.btnHome.hidden, false);
  assert.equal(controls.btnHome.disabled, false);
  assert.equal(controls.btnUndoTKB.disabled, false);
  assert.equal(controls.btnRedoTKB.disabled, true);
  assert.equal(controls.solveDurationSeconds.disabled, false);
  assert.equal(historyRefreshes, 1);
});

test("desktop keeps controls, feedback, and navigation in one toolbar row", () => {
  assert.match(plannerHtml, /\.toolbar-main\s*\{[^}]*--planner-toolbar-button-width:\s*clamp\(96px, 7\.2vw, 104px\);[^}]*grid-template-columns:\s*max-content minmax\(0, 1fr\) auto;/s);
  assert.match(plannerHtml, /\.toolbar-feedback\s*\{[^}]*grid-column:\s*2;[^}]*grid-row:\s*1;[^}]*display:\s*flex;[^}]*flex-flow:\s*row nowrap;/s);
  assert.match(plannerHtml, /\.toolbar-secondary-actions\s*\{[^}]*grid-column:\s*3;[^}]*grid-row:\s*1;/s);
  assert.match(plannerHtml, /\.toolbar-feedback\s*>\s*#statusMsg\s*\{[^}]*white-space:\s*nowrap;/s);
  assert.match(
    plannerHtml,
    /\.toolbar-actions\s*>\s*button\s*\{[^}]*flex:\s*0 0 var\(--planner-toolbar-button-width\);[^}]*width:\s*var\(--planner-toolbar-button-width\);[^}]*min-width:\s*var\(--planner-toolbar-button-width\);[^}]*max-width:\s*var\(--planner-toolbar-button-width\);[^}]*height:\s*36px;[^}]*min-height:\s*36px;[^}]*border-radius:\s*8px;/s
  );
  assert.match(
    plannerHtml,
    /#btnRangBuoc\s*\{[^}]*display:\s*inline-flex;[^}]*background:\s*#58ad32;[^}]*color:\s*#fff;/s
  );
  assert.match(plannerHtml, /#btnRangBuoc \.toolbar-requirement-icon\s*\{[^}]*width:\s*18px;[^}]*height:\s*18px;[^}]*stroke-width:\s*2\.8;/s);
  assert.match(plannerHtml, /#btnDeleteAll\s*\{[^}]*border-color:\s*#dc2626;[^}]*background:\s*#dc2626;[^}]*color:\s*#fff;/s);
  assert.match(plannerHtml, /#btnStopAutoSort\.is-active\s*\{[^}]*background:\s*#fff5f5(?:\s*!important)?;[^}]*color:\s*#c62828(?:\s*!important)?;/s);
  assert.match(
    plannerHtml,
    /#btnUndoTKB,\s*body\.planner-shell \.toolbar-actions\s*>\s*#btnRedoTKB\s*\{[^}]*display:\s*inline-flex;[^}]*flex:\s*0 0 var\(--planner-toolbar-button-width\);[^}]*width:\s*var\(--planner-toolbar-button-width\);[^}]*min-width:\s*var\(--planner-toolbar-button-width\);[^}]*max-width:\s*var\(--planner-toolbar-button-width\);[^}]*height:\s*36px;[^}]*min-height:\s*36px;[^}]*border-radius:\s*8px;/s
  );
  assert.match(
    plannerHtml,
    /\.toolbar-actions\s*>\s*button\.icon-button\s*\{[^}]*display:\s*inline-flex;[^}]*flex:\s*0 0 var\(--planner-toolbar-button-width\);[^}]*width:\s*var\(--planner-toolbar-button-width\);[^}]*min-width:\s*var\(--planner-toolbar-button-width\);[^}]*max-width:\s*var\(--planner-toolbar-button-width\);[^}]*height:\s*36px;[^}]*min-height:\s*36px;[^}]*padding:\s*0;[^}]*border-radius:\s*8px;/s
  );
  assert.match(
    plannerHtml,
    /\.toolbar-secondary-actions \.stats-popover-wrap\s*>\s*\.save-button,\s*body\.planner-shell \.toolbar-secondary-actions \.stats-popover-wrap\s*>\s*\.agent-helper-button,\s*body\.planner-shell \.toolbar-secondary-actions \.stats-popover-wrap\s*>\s*\.stats-toggle\s*\{[^}]*flex:\s*0 0 var\(--planner-toolbar-button-width\);[^}]*width:\s*var\(--planner-toolbar-button-width\);[^}]*min-width:\s*var\(--planner-toolbar-button-width\);[^}]*max-width:\s*var\(--planner-toolbar-button-width\);[^}]*height:\s*36px;/s
  );
  assert.match(
    plannerHtml,
    /\.toolbar-actions\s*>\s*\.solve-duration-control\s*\{[^}]*flex:\s*0 0 auto;[^}]*height:\s*36px;/s
  );
  assert.match(plannerHtml, /#solveDurationSeconds\s*\{[^}]*width:\s*42px;[^}]*min-width:\s*0;/s);
  assert.match(plannerHtml, /toolbar-label-full"[^>]*>Yêu cầu<\/span>/);
  assert.match(plannerHtml, /toolbar-label-full"[^>]*>Thống kê<\/span>/);
});

test("fine-pointer desktop remains one compact row at 606px", () => {
  const finePointerStart = plannerHtml.indexOf("@media (min-width: 481px) and (max-width: 900px) and (hover: hover) and (pointer: fine)");
  const finePointerEnd = plannerHtml.indexOf("@media (max-width: 410px)", finePointerStart);
  const finePointerCss = plannerHtml.slice(finePointerStart, finePointerEnd);

  assert.ok(finePointerStart >= 0 && finePointerEnd > finePointerStart, "fine-pointer toolbar media query is missing");
  assert.doesNotMatch(plannerHtml, /@media \(max-width:\s*900px\)\s*\{/);
  assert.match(finePointerCss, /\.toolbar-main\s*\{[^}]*--planner-toolbar-button-width:\s*64px;[^}]*grid-template-columns:\s*max-content minmax\(0, 1fr\) auto;/s);
  assert.match(
    finePointerCss,
    /\.toolbar-actions\s*>\s*button,\s*body\.planner-shell \.toolbar-secondary-actions[^{]*\{[^}]*flex:\s*0 0 var\(--planner-toolbar-button-width\);[^}]*width:\s*var\(--planner-toolbar-button-width\);[^}]*min-width:\s*var\(--planner-toolbar-button-width\);[^}]*max-width:\s*var\(--planner-toolbar-button-width\);[^}]*height:\s*34px;/s
  );
  assert.match(
    finePointerCss,
    /\.toolbar-actions\s*>\s*button\.icon-button\s*\{[^}]*width:\s*var\(--planner-toolbar-button-width\);[^}]*min-width:\s*var\(--planner-toolbar-button-width\);[^}]*max-width:\s*var\(--planner-toolbar-button-width\);/s
  );
  assert.match(finePointerCss, /\.toolbar-label-full\s*\{[^}]*display:\s*none;/s);
  assert.match(finePointerCss, /\.toolbar-label-compact\s*\{[^}]*display:\s*inline-flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;/s);
  assert.match(
    finePointerCss,
    /\.toolbar-feedback\s*\{[^}]*overflow:\s*hidden;/s,
    "narrow fine-pointer feedback must not paint over Agent Helper"
  );
  assert.match(
    finePointerCss,
    /\.toolbar-feedback\s*>\s*#autoSortProgress\s*\{[^}]*flex:\s*0 0 auto;[^}]*width:\s*auto;[^}]*min-width:\s*0;[^}]*max-width:\s*none;[^}]*overflow:\s*hidden;/s
  );
  assert.match(
    finePointerCss,
    /#autoSortProgress \.auto-sort-label\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s,
    "the running label must shrink and ellipsize inside its grid track"
  );
  assert.doesNotMatch(
    finePointerCss,
    /\.toolbar-feedback\s*>\s*#statusMsg\.is-auto-sort-running-label\s*\{[^}]*display:\s*none !important;/s,
    "the running status must remain visible immediately after the compact time label"
  );
});

test("mobile reserves one stable feedback row so sorting never shifts the timetable", () => {
  const feedbackStart = plannerHtml.indexOf('<div class="toolbar-feedback"');
  const secondaryStart = plannerHtml.indexOf('<div class="toolbar-secondary-actions"', feedbackStart);
  const feedback = plannerHtml.slice(feedbackStart, secondaryStart);

  assert.ok(feedbackStart >= 0 && secondaryStart > feedbackStart);
  assert.doesNotMatch(feedback, /id="btnStopAutoSort"|id="btnDeleteAll"/);
  assert.match(feedback, /id="autoSortProgress"/);
  assert.match(feedback, /id="statusMsg"/);
  assert.ok(feedback.indexOf('id="autoSortProgress"') < feedback.indexOf('id="statusMsg"'));
  assert.match(feedback, /id="autoSortProgress" class="auto-sort-progress is-idle"[^>]*aria-hidden="true"[^>]*\shidden(?:\s|>)/);
  assert.match(plannerHtml, /body\.planner-shell\s*\{[^}]*--planner-mobile-feedback-h:\s*46px;[^}]*padding-bottom:\s*0;[^}]*overflow:\s*hidden;/s);
  assert.match(plannerHtml, /\.toolbar-main\s*\{[^}]*grid-template-columns:\s*repeat\(8, minmax\(0, 1fr\)\);[^}]*grid-template-rows:\s*44px var\(--planner-mobile-feedback-h\);/s);
  assert.match(plannerHtml, /\.toolbar-feedback\s*\{[^}]*grid-column:\s*1 \/ -1;[^}]*grid-row:\s*2;[^}]*display:\s*grid;[^}]*grid-template-rows:\s*var\(--planner-mobile-feedback-h\);[^}]*height:\s*var\(--planner-mobile-feedback-h\);[^}]*min-height:\s*var\(--planner-mobile-feedback-h\);[^}]*max-height:\s*var\(--planner-mobile-feedback-h\);[^}]*overflow:\s*hidden;/s);
  assert.doesNotMatch(plannerHtml, /\.toolbar-feedback:has\(> #autoSortProgress\.is-active\)/);
  assert.match(plannerHtml, /\.toolbar-feedback\s*>\s*#autoSortProgress\s*\{[^}]*grid-row:\s*1;/s);
  assert.match(plannerHtml, /\.toolbar-feedback\s*>\s*#autoSortProgress\.is-idle\s*\{[^}]*display:\s*none;/s);
  assert.match(plannerHtml, /\.toolbar-feedback\s*>\s*#statusMsg\s*\{[^}]*grid-column:\s*2;[^}]*grid-row:\s*1;[^}]*max-height:\s*2\.4em;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*clip;[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;[^}]*transform:\s*none !important;/s);
  assert.match(plannerHtml, /\.toolbar-feedback\s*>\s*#statusMsg\s*\{[^}]*font-size:\s*12px;[^}]*line-height:\s*1\.2;[^}]*letter-spacing:\s*0;/s);
  assert.doesNotMatch(plannerSource, /function fitPlannerMobileStatusMessage[\s\S]*?scaleX/);
  assert.match(plannerSource, /function _setStatus[\s\S]*?fitPlannerMobileStatusMessage\(el\)/);
  assert.doesNotMatch(plannerHtml, /--mobile-progress-text-offset|#statusMsg\s*\{[^}]*grid-row:\s*2;/s);
  assert.match(plannerHtml, /\.toolbar-actions\s*>\s*button,[^}]*flex:\s*0 1 auto;[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*max-width:\s*none;[^}]*height:\s*44px;[^}]*min-height:\s*44px;[^}]*touch-action:\s*manipulation;/s);
  assert.match(plannerHtml, /#autoSortProgress \.auto-sort-label\s*\{[^}]*font-variant-numeric:\s*tabular-nums;/s);
  assert.match(plannerHtml, /\.toolbar-actions\s*>\s*button,[^}]*border:\s*1px solid var\(--tkb-border, #e2e8f0\);[^}]*border-radius:\s*var\(--tkb-radius, 10px\);[^}]*box-shadow:\s*var\(--tkb-shadow,[^;]+\);[^}]*font-size:\s*clamp\(11px, 3\.05vw, 13px\);[^}]*font-weight:\s*600;/s);
  assert.match(plannerHtml, /\.toolbar-actions\s*>\s*button:active:not\(:disabled\),[^}]*transform:\s*translateY\(1px\);[^}]*box-shadow:\s*0 1px 1px rgb\(15 23 42 \/ 8%\);/s);
  assert.match(plannerHtml, /#btnStopAutoSort\s*\{[^}]*padding:\s*0;/s);
  assert.match(plannerHtml, /#btnStopAutoSort \.toolbar-icon\s*\{[^}]*width:\s*20px;[^}]*height:\s*20px;/s);
  assert.doesNotMatch(plannerHtml, /#btnStopAutoSort::before/);
  assert.doesNotMatch(
    plannerHtml,
    /\.toolbar-feedback\s*>\s*#statusMsg\.is-auto-sort-running-label\s*\{[^}]*display:\s*none !important;/s
  );
});

test("Home and statistics occupy columns seven and eight before mobile feedback", () => {
  const feedbackStart = plannerHtml.indexOf('<div class="toolbar-feedback"');
  const secondaryStart = plannerHtml.indexOf('<div class="toolbar-secondary-actions"');
  const secondary = plannerHtml.slice(secondaryStart, plannerHtml.indexOf("\n  </div>\n\n</div>", secondaryStart));

  assert.ok(secondaryStart > feedbackStart);
  assert.match(secondary, /id="btnHome"[^>]*>Home<\/button>/);
  assert.match(secondary, /id="statsToggle"[^>]*>[\s\S]*?toolbar-label-compact[^>]*>\s*<svg class="toolbar-icon"[^>]*>[\s\S]*?<\/svg>\s*<\/span><\/button>/);
  assert.match(plannerHtml, /\.toolbar-secondary-actions\s*\{[^}]*display:\s*contents;/s);
  assert.match(plannerHtml, /\.toolbar-secondary-actions \.stats-popover-wrap\s*\{[^}]*display:\s*contents;/s);
  assert.match(plannerHtml, /\.stats-popover-wrap\s*>\s*\.save-button\s*\{[^}]*grid-column:\s*7;/s);
  assert.match(plannerHtml, /\.stats-popover-wrap\s*>\s*\.stats-toggle\s*\{[^}]*grid-column:\s*8;/s);
});
