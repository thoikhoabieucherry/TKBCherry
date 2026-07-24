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
const constraintsMenuSource = fs.readFileSync(
  path.resolve(__dirname, "..", "web", "pages", "tkb-constraints-menu.js"),
  "utf8"
);

function buttonMarkup(source, id){
  return (source.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) || [])
    .find(markup => markup.includes(`id="${id}"`)) || "";
}

function inlineSvgMarkup(source){
  return source.match(/<svg\b[^>]*>[\s\S]*?<\/svg>/)?.[0] || "";
}

test("requirements submenus toggle only by click", () => {
  assert.doesNotMatch(
    constraintsMenuSource,
    /addEventListener\(['"](?:pointerover|mouseover|mousemove|focusin)['"]/,
    "hover and focus movement must not open or switch requirement groups"
  );
  assert.match(constraintsMenuSource, /aria-expanded', 'false'/);
  assert.match(constraintsMenuSource, /window\.__TKB_CONSTRAINTS_MENU_VERSION = VERSION/);
  assert.match(constraintsMenuSource, /addEventListener\('scroll', onWindowScroll, true\)/);
  assert.doesNotMatch(constraintsMenuSource, /addEventListener\('scroll', closeMenu, true\)/);

  const start = constraintsMenuSource.indexOf("  function setSubmenuOpen");
  const end = constraintsMenuSource.indexOf("  function positionSubmenu", start);
  assert.ok(start >= 0 && end > start, "click accordion helpers must be extractable");

  function makeItem(hasSubmenu = true){
    const classes = new Set();
    const attributes = {};
    const item = {
      classList:{
        add(name){ classes.add(name); },
        remove(name){ classes.delete(name); },
        contains(name){ return classes.has(name); }
      },
      button:{setAttribute(name, value){ attributes[name] = value; }},
      attributes,
      descendants:[],
      querySelector(selector){
        if(selector === ':scope > .rb-menu-sub') return hasSubmenu ? {} : null;
        if(selector === ':scope > button') return this.button;
        return null;
      },
      querySelectorAll(selector){
        if(selector !== 'li.is-open') return [];
        return this.descendants.filter(child => child.classList.contains('is-open'));
      }
    };
    return item;
  }

  let positioned = 0;
  const context = {positionSubmenu(){ positioned += 1; }};
  vm.runInNewContext(
    `${constraintsMenuSource.slice(start, end)}\nthis.toggleRequirementSubmenu = toggleSubmenu;`,
    context
  );
  const first = makeItem();
  const second = makeItem();
  const leaf = makeItem(false);
  const root = {children:[first, second, leaf]};
  first.parentNode = root;
  second.parentNode = root;
  leaf.parentNode = root;

  assert.equal(context.toggleRequirementSubmenu({}, first), true);
  assert.equal(first.classList.contains('is-open'), true);
  assert.equal(first.attributes['aria-expanded'], 'true');
  assert.equal(positioned, 1);

  assert.equal(context.toggleRequirementSubmenu({}, first), true);
  assert.equal(first.classList.contains('is-open'), false);
  assert.equal(first.attributes['aria-expanded'], 'false');
  assert.equal(positioned, 1, "closing the same group must not reposition it");

  context.toggleRequirementSubmenu({}, first);
  context.toggleRequirementSubmenu({}, second);
  assert.equal(first.classList.contains('is-open'), false, "opening a group closes its sibling");
  assert.equal(second.classList.contains('is-open'), true);
  assert.equal(second.attributes['aria-expanded'], 'true');
  assert.equal(context.toggleRequirementSubmenu({}, leaf), false, "leaf actions remain outside accordion handling");
  assert.equal('aria-expanded' in leaf.attributes, false, "leaf actions must not get accordion state");

  const outsideStart = constraintsMenuSource.indexOf("  function onOutsideClick");
  const outsideEnd = constraintsMenuSource.indexOf("\n\n  window.toggleRangBuoc", outsideStart);
  assert.ok(outsideStart >= 0 && outsideEnd > outsideStart, "outside-click handler must be extractable");
  let closed = 0;
  const anchorChild = {};
  const anchor = {contains(target){ return target === anchorChild; }};
  const outsideContext = {
    anchor,
    MENU_ID:'tkbConstraintsDropdownMenu',
    document:{getElementById(){ return {contains(){ return false; }}; }},
    closeMenu(){ closed += 1; }
  };
  vm.runInNewContext(
    `let activeAnchor = this.anchor;${constraintsMenuSource.slice(outsideStart, outsideEnd)}\nthis.handleRequirementOutsideClick = onOutsideClick;`,
    outsideContext
  );
  outsideContext.handleRequirementOutsideClick({target:anchorChild});
  assert.equal(closed, 0, "the capture listener must let the anchor's own click close the open menu");
  outsideContext.handleRequirementOutsideClick({target:{}});
  assert.equal(closed, 1, "a real outside click must still close the menu");

  const scrollStart = constraintsMenuSource.indexOf("  function onWindowScroll");
  const scrollEnd = constraintsMenuSource.indexOf("\n\n  function onOutsideClick", scrollStart);
  assert.ok(scrollStart >= 0 && scrollEnd > scrollStart, "scroll handler must be extractable");
  let scrollClosed = 0;
  const internalScroller = {};
  const scrollContext = {
    MENU_ID:'tkbConstraintsDropdownMenu',
    document:{getElementById(){ return {contains(target){ return target === internalScroller; }}; }},
    closeMenu(){ scrollClosed += 1; }
  };
  vm.runInNewContext(
    `${constraintsMenuSource.slice(scrollStart, scrollEnd)}\nthis.handleRequirementScroll = onWindowScroll;`,
    scrollContext
  );
  scrollContext.handleRequirementScroll({target:internalScroller});
  assert.equal(scrollClosed, 0, "scrolling inside a long mobile menu must keep it open");
  scrollContext.handleRequirementScroll({target:{}});
  assert.equal(scrollClosed, 1, "scrolling the page must still close the fixed menu");
});

test("every schedule deletion invalidates solver state and force-saves remotely", () => {
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
  const bridgeInvalidations = [];
  const context = {
    DATA:data,
    window:{
      TKBRustAPI:{
        invalidatePendingSolveForScheduleMutation(){
          bridgeInvalidations.push("invalidated");
        }
      }
    }
  };
  vm.runInNewContext(
    `${plannerSource.slice(helperStart, helperEnd)}\nthis.invalidateDeleteState = invalidateSolverStateAfterScheduleDelete;`,
    context
  );

  const originalTeachers = data.tkbLessonTeachers;
  const originalRooms = data.tkbLessonRooms;
  const initialRevision = Number(data.tkbScheduleRevision || 0);
  context.invalidateDeleteState(false);
  staleFields.forEach(field => {
    assert.equal(Object.prototype.hasOwnProperty.call(data, field), false, `${field} must be deleted`);
  });
  assert.equal(data.tkbLessonTeachers, originalTeachers, "class deletion must preserve teacher mappings");
  assert.equal(data.tkbLessonRooms, originalRooms, "class deletion must preserve room mappings");
  assert.equal(data.keepMe.value, true, "unrelated planner data must survive invalidation");
  assert.ok(data.tkbScheduleRevision > initialRevision, "class deletion must advance the schedule revision");
  assert.equal(bridgeInvalidations.length, 1, "class deletion must notify the solver bridge");

  staleFields.forEach(field => { data[field] = {stale:true}; });
  const classDeleteRevision = data.tkbScheduleRevision;
  context.invalidateDeleteState(true);
  staleFields.forEach(field => {
    assert.equal(Object.prototype.hasOwnProperty.call(data, field), false, `${field} must stay deleted`);
  });
  assert.equal(typeof data.tkbLessonTeachers, "object");
  assert.equal(typeof data.tkbLessonRooms, "object");
  assert.equal(Object.keys(data.tkbLessonTeachers).length, 0, "school deletion must reset teacher mappings");
  assert.equal(Object.keys(data.tkbLessonRooms).length, 0, "school deletion must reset room mappings");
  assert.ok(data.tkbScheduleRevision > classDeleteRevision, "school deletion must advance the schedule revision");
  assert.equal(bridgeInvalidations.length, 2, "school deletion must notify the solver bridge");

  const classDeleteBody = plannerSource.slice(
    plannerSource.indexOf("function deleteCurrentClassTKB"),
    plannerSource.indexOf("function deleteAllTKB")
  );
  const schoolDeleteBody = plannerSource.slice(
    plannerSource.indexOf("function deleteAllTKB"),
    plannerSource.indexOf("function toggleDeleteMenu")
  );
  const confirmDeleteBody = plannerSource.slice(
    plannerSource.indexOf("function confirmDeleteMenu"),
    plannerSource.indexOf("/* [MOVED -> phanmon-ops.js] Section: xep_lai */")
  );
  const menuClassDeleteBody = confirmDeleteBody.slice(
    confirmDeleteBody.indexOf('if(choice === "class"){'),
    confirmDeleteBody.indexOf('if(choice === "school"){')
  );
  const menuSchoolDeleteBody = confirmDeleteBody.slice(
    confirmDeleteBody.indexOf('if(choice === "school"){')
  );
  const persistenceHelperBody = plannerSource.slice(
    plannerSource.indexOf("function persistScheduleDelete"),
    plannerSource.indexOf("function deleteCurrentClassTKB")
  );
  assert.match(
    persistenceHelperBody,
    /saveStore\(\{\s*force\s*:\s*true\s*,\s*awaitRemote\s*:\s*true\s*\}\)/,
    "delete persistence must force an awaited remote save"
  );
  assert.match(
    persistenceHelperBody,
    /__TKB_SCHEDULE_MUTATION_SAVE_PROMISE\s*=\s*persistence/,
    "delete persistence must expose the barrier to the solver bridge"
  );
  assert.match(
    persistenceHelperBody,
    /Promise\.resolve\(previousSave\)/,
    "delete persistence must wait for an older in-flight save"
  );

  function assertDeleteContract(source, resetMappings, label){
    const invalidateCall = `invalidateSolverStateAfterScheduleDelete(${resetMappings})`;
    const persistCall = "persistScheduleDelete()";
    assert.ok(source.includes(invalidateCall), `${label} must invalidate solver state`);
    assert.ok(source.includes(persistCall), `${label} must start the remote persistence barrier`);
    assert.ok(
      source.indexOf(invalidateCall) < source.indexOf(persistCall),
      `${label} must invalidate solver state before persistence`
    );
  }

  assertDeleteContract(classDeleteBody, false, "direct class deletion");
  assertDeleteContract(schoolDeleteBody, true, "direct school deletion");
  assertDeleteContract(menuClassDeleteBody, false, "menu class deletion");
  assertDeleteContract(menuSchoolDeleteBody, true, "menu school deletion");
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

test("portrait planner keeps seven compact mobile slots with stacked history and automatic timing", () => {
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
  assert.doesNotMatch(actions, /solveDurationSeconds|solve-duration-control/);

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
  assert.match(plannerHtml, /\.toolbar-main\s*\{[^}]*grid-template-columns:\s*repeat\(7, minmax\(0, 1fr\)\);[^}]*grid-template-rows:\s*44px var\(--planner-mobile-feedback-h\);/s);
  assert.match(plannerHtml, /\.toolbar-actions\s*\{[^}]*display:\s*contents;/s);
  for(const [id, column] of [
    ["btnRangBuoc", "1"],
    ["btnUndoTKB", "2"],
    ["btnRedoTKB", "2"],
    ["btnAutoSort", "3"]
  ]){
    assert.match(
      plannerHtml,
      new RegExp(`#${id}\\s*\\{[^}]*grid-column:\\s*${column};[^}]*grid-row:\\s*1;`, "s")
    );
  }
  assert.match(plannerHtml, /#btnRedoTKB\s*\{[^}]*grid-column:\s*2;[^}]*align-self:\s*start;/s);
  assert.match(plannerHtml, /#btnUndoTKB\s*\{[^}]*grid-column:\s*2;[^}]*align-self:\s*end;/s);
  assert.match(plannerHtml, /#btnUndoTKB,[^}]*#btnRedoTKB\s*\{[^}]*height:\s*22px;[^}]*min-height:\s*22px;/s);
  assert.match(
    plannerHtml,
    /\.toolbar-actions\s*>\s*#btnRangBuoc,\s*body\.planner-shell \.toolbar-actions\s*>\s*#btnUndoTKB,\s*body\.planner-shell \.toolbar-actions\s*>\s*#btnRedoTKB,\s*body\.planner-shell \.toolbar-actions\s*>\s*#btnAutoSort,\s*body\.planner-shell \.toolbar-actions\s*>\s*#btnStopAutoSort,\s*body\.planner-shell \.toolbar-actions\s*>\s*#btnDeleteAll\s*\{[^}]*order:\s*initial;/s,
    "all direct toolbar items must neutralize legacy order rules"
  );
  assert.match(plannerHtml, /#btnDeleteAll\s*\{[^}]*grid-column:\s*4 !important;[^}]*grid-row:\s*1 !important;/s);
  assert.match(plannerHtml, /#btnAgentHelper\s*\{[^}]*grid-column:\s*5;[^}]*grid-row:\s*1;[^}]*height:\s*44px;/s);
  assert.match(plannerHtml, /\.stats-popover-wrap\s*>\s*\.save-button\s*\{[^}]*grid-column:\s*6;[^}]*grid-row:\s*1;/s);
  assert.match(plannerHtml, /\.stats-popover-wrap\s*>\s*\.stats-toggle\s*\{[^}]*grid-column:\s*7;[^}]*grid-row:\s*1;/s);
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
    (plannerHtml.match(/grid-template-columns:\s*repeat\(7, minmax\(0, 1fr\)\);/g) || []).length,
    1,
    "the mobile toolbar must use one inherited set of seven equal tracks"
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
  assert.match(plannerHtml, /shared\/storage\.js\?v=20260724-v180-durable-store-save-v1/);
  assert.match(plannerHtml, /phanmon\.js\?v=20260724-v181-adaptive-browser-workers-v1/);
  assert.match(plannerHtml, /tkb-rust-bridge\.js\?v=20260724-v180-durable-store-save-v1/);
});

test("landscape phones separate Undo and Redo into eight full-height slots", () => {
  const start = plannerHtml.indexOf("@media (orientation: landscape) and (max-height: 540px) and (any-pointer: coarse)");
  const end = plannerHtml.indexOf("@media (min-width: 481px)", start);
  assert.ok(start >= 0 && end > start, "landscape toolbar override is missing");
  const landscapeCss = plannerHtml.slice(start, end);

  assert.match(landscapeCss, /\.toolbar-main\s*\{[^}]*grid-template-columns:\s*repeat\(8, minmax\(0, 1fr\)\);/s);
  assert.match(landscapeCss, /#btnUndoTKB\s*\{[^}]*grid-column:\s*2;[^}]*align-self:\s*stretch;/s);
  assert.match(landscapeCss, /#btnRedoTKB\s*\{[^}]*grid-column:\s*3;[^}]*align-self:\s*stretch;/s);
  assert.match(landscapeCss, /#btnUndoTKB,[^}]*#btnRedoTKB\s*\{[^}]*height:\s*44px;[^}]*min-height:\s*44px;[^}]*border-radius:\s*var\(--tkb-radius, 10px\);/s);
  assert.match(landscapeCss, /#btnAutoSort\s*\{[^}]*grid-column:\s*4;/s);
  assert.match(landscapeCss, /#btnStopAutoSort,[^}]*#btnDeleteAll\s*\{[^}]*grid-column:\s*5 !important;/s);
  assert.match(landscapeCss, /#btnAgentHelper\s*\{[^}]*grid-column:\s*6;/s);
  assert.match(landscapeCss, /\.stats-popover-wrap\s*>\s*\.save-button\s*\{[^}]*grid-column:\s*7;/s);
  assert.match(landscapeCss, /\.stats-popover-wrap\s*>\s*\.stats-toggle\s*\{[^}]*grid-column:\s*8;/s);
});

test("browser Agent toggle is cross-platform and sits before Home on desktop and mobile", () => {
  const secondaryStart = plannerHtml.indexOf('<div class="toolbar-secondary-actions"');
  const secondaryEnd = plannerHtml.indexOf("\n  </div>\n\n</div>", secondaryStart);
  const secondary = plannerHtml.slice(secondaryStart, secondaryEnd);
  const homeIndex = secondary.indexOf('id="btnHome"');
  const helperIndex = secondary.indexOf('id="btnAgentHelper"');
  const statsIndex = secondary.indexOf('id="statsToggle"');
  const helperButton = buttonMarkup(secondary, "btnAgentHelper");

  assert.ok(helperIndex >= 0, "Agent button is missing");
  assert.ok(homeIndex > helperIndex, "Agent must sit immediately before Home");
  assert.ok(statsIndex > homeIndex, "Statistics must stay after Home");
  assert.match(
    secondary,
    /id="btnAgentHelper"[\s\S]*?<\/button>\s*<button id="btnHome"[\s\S]*?>Home<\/button>/,
    "Agent must be the toolbar button immediately before Home"
  );
  assert.match(helperButton, /class="agent-helper-button"[^>]*type="button"/);
  assert.match(helperButton, /title="Agent [^"]+VPS\."/);
  assert.match(helperButton, /aria-label="Agent [^"]+VPS\."/);
  assert.match(helperButton, /data-agent-state="unavailable"/);
  assert.match(helperButton, /class="agent-status-dot"[^>]*aria-hidden="true"/);
  assert.match(helperButton, /onclick="toggleBrowserAgent\(\)"/);
  assert.match(helperButton, /aria-pressed="true"/);
  assert.match(helperButton, /\sdisabled(?:\s|>)/);
  assert.match(helperButton, /aria-disabled="true"/);
  assert.match(helperButton, /class="toolbar-icon agent-ai-icon"[\s\S]*<span>Agent<\/span><\/button>/);
  assert.match(helperButton, /\shidden(?:\s|>)/);
  assert.match(helperButton, /aria-hidden="true"/);
  assert.match(plannerSource, /async function downloadAgentHelper\(\)/);
  assert.doesNotMatch(plannerSource, /anchor\.href\s*=\s*"\/downloads\/TKBCherryAgent-Windows\.zip/);
  assert.doesNotMatch(plannerSource, /anchor\.download\s*=\s*"TKBCherryAgent-Windows\.zip"/);
  assert.doesNotMatch(plannerSource, /Giải nén ZIP rồi mở TKBCherryAgent\.exe/);
  assert.match(plannerSource, /async function approveAgentPairFromUrl\(\)/);
  assert.match(plannerSource, /fetch\("\/api\/agent-helper\/v1\/pair\/approve"/);
  assert.match(plannerSource, /function isAgentHelperSupportedDevice\(deviceNavigator\)/);
  assert.match(plannerSource, /function browserAgentRuntimeState\(deviceNavigator\)/);
  assert.match(plannerSource, /window\.TKBBrowserWasmExecutor/);
  assert.match(plannerSource, /function syncAgentHelperVisibility\(\)/);
  assert.match(plannerSource, /async function maybeInviteAgentBeforeSort\(options\)/);
  assert.match(
    bridgeSource,
    /manualAgentInvite[\s\S]*?maybeInviteAgentBeforeSort[\s\S]*?prepareManualSolveIntent\(\)/,
    "manual Play keeps the non-blocking compatibility hook before sorting"
  );
  assert.match(
    bridgeSource,
    /window\.sapXepTuDongAll\(\{manualAgentInvite:true\}\)/,
    "the Play button must mark the sort as a manual Agent-invite opportunity"
  );
  assert.match(
    bridgeSource,
    /maybeInviteAgentBeforeSort\(\{\s*preferVpsFallback:true\s*\}\)/,
    "manual Play must start through the VPS without a blocking Agent dialog"
  );
  assert.match(
    plannerHtml,
    /#btnAgentHelper \.agent-status-dot\s*\{[^}]*top:\s*3px;[^}]*left:\s*3px;[^}]*background:\s*#94a3b8;/s
  );
  assert.match(
    plannerHtml,
    /#btnAgentHelper\[data-agent-state="enabled"\] \.agent-status-dot,[\s\S]*?#btnAgentHelper\[data-agent-state="prepared"\] \.agent-status-dot\s*\{[^}]*background:\s*#16a34a;/s
  );
  assert.match(
    plannerHtml,
    /#btnAgentHelper\[data-agent-state="active"\] \.agent-status-dot,[\s\S]*?#btnAgentHelper\[data-agent-state="working"\] \.agent-status-dot\s*\{[^}]*background:\s*#22c55e;/s
  );
  assert.match(
    plannerHtml,
    /#btnAgentHelper\[data-agent-state="working"\] \.agent-status-dot\s*\{[^}]*animation:\s*planner-agent-working-pulse 1\.2s ease-in-out infinite;/s
  );
  assert.match(plannerHtml, /@keyframes planner-agent-working-pulse\s*\{/);
  assert.match(
    plannerHtml,
    /#btnAgentHelper\[data-agent-state="error"\] \.agent-status-dot\s*\{[^}]*background:\s*#dc2626;/s
  );
  assert.match(plannerHtml, /#btnAgentHelper:disabled\s*\{[^}]*opacity:\s*1;[^}]*cursor:\s*default;/s);
  assert.doesNotMatch(plannerSource, /EncodedCommand|powershell\.exe|Cai-TKBCherry-Agent\.cmd/);

  const supportStart = plannerSource.indexOf("function isAgentHelperSupportedDevice");
  const supportEnd = plannerSource.indexOf("function syncAgentHelperVisibility", supportStart);
  const supportSource = plannerSource.slice(supportStart, supportEnd);
  const supportsAgent = Function(`${supportSource}; return isAgentHelperSupportedDevice;`)();
  assert.equal(supportsAgent({platform:"Win32", userAgent:"Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}), true);
  assert.equal(supportsAgent({userAgentData:{platform:"Windows", mobile:false}, userAgent:""}), true);
  assert.equal(supportsAgent({platform:"MacIntel", maxTouchPoints:0, userAgent:"Mozilla/5.0 (Macintosh)"}), true);
  assert.equal(supportsAgent({platform:"MacIntel", maxTouchPoints:5, userAgent:"Mozilla/5.0 (Macintosh)"}), true);
  assert.equal(supportsAgent({platform:"Linux armv8l", userAgent:"Mozilla/5.0 (Linux; Android 15; Tablet)"}), true);
  assert.equal(supportsAgent({platform:"Linux x86_64", userAgent:"Mozilla/5.0 (X11; Linux x86_64)"}), true);
  assert.equal(supportsAgent({platform:"iPhone", userAgent:"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)"}), true);
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
  assert.match(
    mobileCss,
    /#btnAgentHelper\s*\{[^}]*grid-column:\s*5;[^}]*grid-row:\s*1;[^}]*display:\s*inline-flex !important;[^}]*height:\s*44px;/s
  );
  assert.match(
    mobileCss,
    /\.stats-popover-wrap\s*>\s*\.save-button\s*\{[^}]*grid-column:\s*6;[^}]*grid-row:\s*1;/s
  );
  assert.match(
    mobileCss,
    /\.stats-popover-wrap\s*>\s*\.stats-toggle\s*\{[^}]*grid-column:\s*7;[^}]*grid-row:\s*1;[^}]*height:\s*44px;/s
  );
  assert.match(
    plannerHtml,
    /\.stats-popover-wrap\s*>\s*\.agent-helper-button\[hidden\]\s*\{[^}]*display:\s*none !important;/s,
    "the initial hidden attribute must beat the mobile inline-flex rule before JavaScript hydrates"
  );
});

test("browser Agent indicator shows enabled readiness and reports real compute", async () => {
  const start = plannerSource.indexOf("function isAgentHelperSupportedDevice");
  const end = plannerSource.indexOf("function startAgentHelperStatusPolling", start);
  assert.ok(start >= 0 && end > start, "browser Agent status renderer is missing");
  const indicatorSource = plannerSource.slice(start, end);
  assert.doesNotMatch(indicatorSource, /\/api\/agent-helper\/v1\/status|\bfetch\s*\(/);
  const button = {
    dataset:{agentState:"unavailable"},
    hidden:true,
    disabled:false,
    title:"",
    attributes:{},
    setAttribute(name, value){ this.attributes[name] = value; }
  };
  const executorState = {
    active:false,
    probed:false,
    hasWorker:false,
    hasLease:false,
    computeActive:false,
    workerCount:0,
    localComputeRuns:0,
    localAcceptedResults:0,
    workerCeiling:4,
    plannedWorkerCount:0,
    lastComputeWorkerCount:0
  };
  let agentEnabled = true;
  const statusEvents = [];
  const windowsNavigator = {
    platform:"Win32",
    userAgent:"Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
  };
  const context = {
    navigator:windowsNavigator,
    window:{
      Worker:function Worker(){},
      WebAssembly:{},
      BigInt,
      TextEncoder,
      crypto:{subtle:{}},
      fetch:async () => { throw new Error("status indicator must stay local"); },
      TKBBrowserWasmExecutor:{
        isSupportedNavigator(){ return true; },
        isEnabled(){ return agentEnabled; },
        async setEnabled(next){ agentEnabled = next !== false; return agentEnabled; },
        portfolioWorkerCount(){ return 4; },
        prepare(){},
        state(){ return executorState; }
      }
    },
    document:{getElementById(id){ return id === "btnAgentHelper" ? button : null; }},
    _setStatus(message, kind){ statusEvents.push([message, kind]); }
  };
  vm.runInNewContext(
    `${indicatorSource}\nthis.syncIndicator = syncAgentHelperVisibility; this.refreshIndicator = refreshAgentHelperStatus; this.toggleIndicator = toggleBrowserAgent;`,
    context
  );

  assert.equal(context.syncIndicator(), true);
  assert.equal(button.hidden, false);
  assert.equal(button.disabled, false);
  assert.equal(button.attributes["aria-hidden"], "false");
  assert.equal(button.dataset.agentState, "enabled");
  assert.equal(button.title, "Agent đã bật, tự điều chỉnh tối đa 4 Worker theo lượt xếp. Bấm để dùng VPS.");
  assert.equal(button.attributes["aria-label"], button.title);
  assert.equal(button.attributes["aria-pressed"], "true");
  assert.equal(button.attributes["aria-disabled"], "false");
  assert.equal(context.window.__TKB_BROWSER_AGENT_READY, false);
  assert.equal(context.window.__TKB_BROWSER_AGENT_WORKING, false);

  executorState.active = true;
  executorState.probed = true;
  executorState.hasWorker = true;
  executorState.hasLease = true;
  executorState.computeActive = true;
  executorState.localComputeRuns = 1;
  executorState.workerCount = 1;
  executorState.plannedWorkerCount = 1;
  assert.equal(await context.refreshIndicator(true), true);
  assert.equal(button.dataset.agentState, "working");
  assert.equal(button.title, "Agent đang tối ưu bằng 1 Worker (tối đa 4 Worker) trên thiết bị. Bấm để chuyển về VPS.");
  assert.equal(context.window.__TKB_BROWSER_AGENT_ACTIVE, true);
  assert.equal(context.window.__TKB_BROWSER_AGENT_WORKING, true);
  assert.equal(context.window.__TKB_BROWSER_AGENT_READY, true);

  executorState.active = false;
  executorState.probed = false;
  executorState.hasWorker = false;
  executorState.hasLease = false;
  executorState.computeActive = false;
  executorState.workerCount = 0;
  executorState.plannedWorkerCount = 0;
  executorState.localAcceptedResults = 1;
  executorState.lastComputeWorkerCount = 1;
  assert.equal(await context.refreshIndicator(true), true);
  assert.equal(button.dataset.agentState, "enabled");
  assert.equal(button.title, "Agent đã bật, tự điều chỉnh tối đa 4 Worker; lượt gần nhất dùng 1 Worker. Bấm để dùng VPS.");
  assert.equal(context.window.__TKB_BROWSER_AGENT_ACTIVE, false);
  assert.equal(context.window.__TKB_BROWSER_AGENT_WORKING, false);

  assert.equal(await context.toggleIndicator(), false);
  assert.equal(agentEnabled, false);
  assert.equal(button.disabled, false);
  assert.equal(button.dataset.agentState, "off");
  assert.equal(button.attributes["aria-pressed"], "false");
  assert.equal(button.title, "Agent đã tắt; lượt xếp sẽ dùng VPS. Bấm để bật Agent.");
  assert.deepEqual(statusEvents.at(-1), ["Agent đã tắt; các lượt xếp sẽ dùng VPS.", "info"]);
});

test("manual Play never prompts or downloads a native Agent", async () => {
  const start = plannerSource.indexOf("async function maybeInviteAgentBeforeSort");
  const end = plannerSource.indexOf("function setAutoSortHomeHidden", start);
  assert.ok(start >= 0 && end > start, "Agent invitation helper is missing");
  const invitationSource = plannerSource.slice(start, end);
  let prompts = 0;
  let downloads = 0;
  let statusChecks = 0;
  const context = {
    window:{confirm(){ prompts += 1; return true; }},
    async refreshAgentHelperStatus(){ statusChecks += 1; return false; },
    async downloadAgentHelper(){ downloads += 1; return true; }
  };
  vm.runInNewContext(
    `${invitationSource}\nthis.inviteBeforeSort = maybeInviteAgentBeforeSort;`,
    context
  );

  assert.equal(await context.inviteBeforeSort({preferVpsFallback:true}), true);
  assert.equal(await context.inviteBeforeSort(), true);
  assert.equal(prompts, 0);
  assert.equal(downloads, 0);
  assert.equal(statusChecks, 0);
});

test("manual Play bypasses native Agent status checks entirely", async () => {
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
  assert.equal(timeoutMs, 0);
  assert.equal(signal, null);
  assert.equal(timeoutClears, 0);
  assert.equal(prompts, 0);
});

test("legacy Agent action delegates to the integrated browser toggle without downloading", async () => {
  const start = plannerSource.indexOf("async function downloadAgentHelper");
  const end = plannerSource.indexOf("async function approveAgentPairFromUrl", start);
  assert.ok(start >= 0 && end > start, "Agent download helper is missing");
  let toggles = 0;
  const context = {
    async toggleBrowserAgent(){ toggles += 1; return true; }
  };
  vm.runInNewContext(
    `${plannerSource.slice(start, end)}\nthis.downloadConnectedAgent = downloadAgentHelper;`,
    context
  );
  assert.equal(await context.downloadConnectedAgent(), true);
  assert.equal(toggles, 1);
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
    /#btnAutoSort\s*\{[^}]*grid-column:\s*3;[^}]*grid-row:\s*1;/s
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
    (mobileCss.match(/grid-template-columns:\s*repeat\(7, minmax\(0, 1fr\)\);/g) || []).length,
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

test("sorting keeps Home and the browser Agent indicator in stable slots", () => {
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
  assert.match(homeControl, /const agentVisible\s*=\s*syncAgentHelperVisibility\(\)/);
  assert.match(homeControl, /agentBtn\.hidden\s*=\s*!agentVisible/);
  assert.match(homeControl, /agentBtn\.setAttribute\("aria-hidden",\s*agentVisible \? "false" : "true"\)/);
  assert.doesNotMatch(homeControl, /agentBtn\.disabled\s*=\s*true/);
  assert.match(homeControl, /agentBtn\.classList\.remove\("is-auto-sort-disabled"\)/);
  assert.match(
    plannerHtml,
    /#btnHome\.is-auto-sort-disabled\s*\{[^}]*opacity:\s*\.45;[^}]*filter:\s*saturate\(\.6\);/s
  );
  assert.doesNotMatch(plannerHtml, /#btnAgentHelper\.is-auto-sort-disabled/);
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
    btnAgentHelper:makeControl(false),
    btnUndoTKB:makeControl(false),
    btnRedoTKB:makeControl(true),
    btnDeleteAll:makeControl(false),
    btnRangBuoc:makeControl(false),
    solveDurationSeconds:makeControl(false)
  };
  let historyRefreshes = 0;
  const context = {
    navigator:{platform:"Win32", userAgent:"Mozilla/5.0 (Windows NT 10.0; Win64; x64)"},
    window:{
      __TKB_RUST_SOLVER_RUNNING:false,
      __TKB_SOLVE_UI_BUSY:false,
      Worker:function Worker(){},
      WebAssembly:{},
      BigInt,
      TextEncoder,
      crypto:{subtle:{}},
      fetch:async () => ({}),
      TKBBrowserWasmExecutor:{
        isSupportedNavigator(){ return true; },
        prepare(){},
        state(){ return {active:false, hasLease:false, probed:false}; }
      }
    },
    document:{
      getElementById(id){ return controls[id] || null; },
      querySelectorAll(){ return []; }
    },
    syncAgentHelperVisibility(){ return true; },
    __tkbUpdateHistoryButtons(){ historyRefreshes += 1; }
  };
  vm.runInNewContext(`${plannerSource.slice(
    plannerSource.indexOf("function setAutoSortControlLocked"),
    plannerSource.indexOf("function setAutoSortStopVisible")
  )}\nthis.lockBusyControls = setAutoSortBusyControls;`, context);

  context.lockBusyControls(true);
  assert.equal(controls.btnHome.hidden, false);
  assert.equal(controls.btnHome.disabled, true);
  assert.equal(controls.btnAgentHelper.hidden, false);
  assert.equal(controls.btnAgentHelper.disabled, false);
  assert.equal(controls.btnAgentHelper.getAttribute("aria-hidden"), "false");
  assert.equal(controls.btnUndoTKB.disabled, true);
  assert.equal(controls.btnRedoTKB.disabled, true);
  assert.equal(controls.solveDurationSeconds.disabled, true);

  context.lockBusyControls(false);
  assert.equal(controls.btnHome.hidden, false);
  assert.equal(controls.btnHome.disabled, false);
  assert.equal(controls.btnAgentHelper.hidden, false);
  assert.equal(controls.btnAgentHelper.disabled, false);
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
  assert.doesNotMatch(plannerHtml, /solveDurationSeconds|solve-duration-control/);
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
  assert.match(plannerHtml, /\.toolbar-main\s*\{[^}]*grid-template-columns:\s*repeat\(7, minmax\(0, 1fr\)\);[^}]*grid-template-rows:\s*44px var\(--planner-mobile-feedback-h\);/s);
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

test("Agent, Home, and Statistics occupy mobile columns five through seven", () => {
  const feedbackStart = plannerHtml.indexOf('<div class="toolbar-feedback"');
  const secondaryStart = plannerHtml.indexOf('<div class="toolbar-secondary-actions"');
  const secondary = plannerHtml.slice(secondaryStart, plannerHtml.indexOf("\n  </div>\n\n</div>", secondaryStart));

  assert.ok(secondaryStart > feedbackStart);
  assert.match(secondary, /id="btnHome"[^>]*>Home<\/button>/);
  assert.match(secondary, /id="statsToggle"[^>]*>[\s\S]*?toolbar-label-compact[^>]*>\s*<svg class="toolbar-icon"[^>]*>[\s\S]*?<\/svg>\s*<\/span><\/button>/);
  assert.match(plannerHtml, /\.toolbar-secondary-actions\s*\{[^}]*display:\s*contents;/s);
  assert.match(plannerHtml, /\.toolbar-secondary-actions \.stats-popover-wrap\s*\{[^}]*display:\s*contents;/s);
  assert.match(plannerHtml, /#btnAgentHelper\s*\{[^}]*grid-column:\s*5;[^}]*height:\s*44px;/s);
  assert.match(plannerHtml, /\.stats-popover-wrap\s*>\s*\.save-button\s*\{[^}]*grid-column:\s*6;/s);
  assert.match(plannerHtml, /\.stats-popover-wrap\s*>\s*\.stats-toggle\s*\{[^}]*grid-column:\s*7;[^}]*height:\s*44px;/s);
});
