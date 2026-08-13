"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const appHtml = fs.readFileSync(path.join(root, "web", "app.html"), "utf8");
const appSource = fs.readFileSync(path.join(root, "web", "app.js"), "utf8");
const compactCss = fs.readFileSync(
  path.join(root, "web", "admin-mobile-compact.css"),
  "utf8"
);

test("admin loads the balanced data-column assets after legacy themes", () => {
  const themeIndex = appHtml.indexOf("theme-light.css");
  const runtimeIndex = appHtml.indexOf("runtime.css");
  const compactIndex = appHtml.indexOf(
    "admin-mobile-compact.css?v=20260730-v1148-admin-responsive-actions-v1"
  );

  assert.ok(themeIndex >= 0 && runtimeIndex > themeIndex);
  assert.ok(compactIndex > runtimeIndex, "compact overrides must load last");
  assert.match(appHtml, /style\.css\?v=20260725-v194-balanced-data-columns-v1/);
  assert.match(appHtml, /app\.js\?v=20260802-max1-class-limit-v1/);
});

test("mobile admin navigation exposes six compact icon tabs", () => {
  const start = appHtml.indexOf('<div class="app-nav-main">');
  const end = appHtml.indexOf('<div class="app-nav-side">', start);
  const nav = appHtml.slice(start, end);
  const buttons = nav.match(/<button\b[\s\S]*?<\/button>/g) || [];

  assert.equal(buttons.length, 6);
  for(const button of buttons){
    assert.match(button, /class="app-nav-icon"/);
    assert.match(button, /class="app-nav-label-full"/);
    assert.match(button, /class="app-nav-label-mobile"/);
    assert.match(button, /aria-label="[^"]+"/);
  }

  assert.match(compactCss, /grid-template-columns:\s*repeat\(6, minmax\(0, 1fr\)\)/);
  assert.match(compactCss, /body\.app-shell-body \.app-nav-side\s*\{[\s\S]*?order:\s*-1/);
  assert.match(compactCss, /height:\s*46px/);
  assert.match(appHtml, /data-page="giaovien"[\s\S]*?app-nav-label-mobile">Giáo viên<\/span>/);
});

test("mobile command row uses icons without hiding accessible names", () => {
  const start = appHtml.indexOf('<div class="app-nav-side">');
  const end = appHtml.indexOf("</div>\n  </div>", start);
  const commands = appHtml.slice(start, end);

  assert.match(commands, /btn-planner[\s\S]*?aria-label="Sắp xếp thời khóa biểu"[\s\S]*?app-command-icon/);
  assert.match(commands, /btn-portal[\s\S]*?aria-label="Quản lý tài khoản"[\s\S]*?app-command-icon/);
  assert.match(commands, /btn-logout[\s\S]*?aria-label="Đăng xuất"[\s\S]*?app-command-icon/);
  assert.match(compactCss, /flex-basis:\s*62px/);
  assert.match(compactCss, /--app-mobile-control:\s*40px/);
});

test("data actions reuse one responsive pair of direct delete buttons", () => {
  assert.match(appSource, /function appUiIcon\(name\)/);
  assert.match(appSource, /function appQuickAddDetails\(content\)/);
  assert.match(appSource, /appQuickAddDetails[\s\S]*?appUiIcon\("wand"\)/);
  assert.match(appSource, /app-quick-add-summary-label">Thêm nhanh/);
  assert.match(compactCss, /app-quick-add-summary-label\s*\{[\s\S]*?display:\s*none/);
  assert.match(compactCss, /\.app-quick-add-details\s*\{[\s\S]*?position:\s*relative[\s\S]*?display:\s*block/);
  assert.match(compactCss, /\.app-quick-add-details > summary\s*\{[\s\S]*?display:\s*flex/);
  assert.match(compactCss, /body\.app-shell-body \.app-quick-add-details:not\(\[open\]\) > \.quick-add-control\s*\{[\s\S]*?display:\s*none/);
  assert.match(compactCss, /body\.app-shell-body \.app-quick-add-details\[open\] > \.quick-add-control\s*\{[\s\S]*?position:\s*absolute[\s\S]*?display:\s*inline-flex/);
  assert.match(appSource, /class="action-bar action-bar-data\$\{quickAdd \? " has-quick-add" : ""\}"/);
  assert.match(appSource, /class="btn danger app-action-button app-delete-action"[\s\S]*?appUiIcon\("rowsDelete"\)[\s\S]*?class="app-action-label">Xóa đã chọn/);
  assert.match(appSource, /class="btn danger app-action-button app-delete-action"[\s\S]*?appUiIcon\("trash"\)[\s\S]*?class="app-action-label">Xóa mục này/);
  assert.match(appSource, /\$\{selCount \? "" : "disabled"\}/);
  const renderStart = appSource.indexOf("function renderSectionInto");
  const toolbarEnd = appSource.indexOf("// Thêm các column header", renderStart);
  const toolbarSource = appSource.slice(renderStart, toolbarEnd);
  assert.equal((toolbarSource.match(/deleteSelectedRows\('\$\{section\}'\)/g) || []).length, 1);
  assert.equal((toolbarSource.match(/deleteSection\('\$\{section\}'\)/g) || []).length, 1);
  assert.match(compactCss, /\.action-bar-data\.has-quick-add\s*\{[\s\S]*?repeat\(6, var\(--app-mobile-control\)\)/);
  assert.match(compactCss, /\.app-action-create\s*\{[\s\S]*?width:\s*var\(--app-mobile-control\)/);
  assert.match(compactCss, /\.app-delete-action\s*\{[\s\S]*?position:\s*relative/);
  assert.doesNotMatch(appSource, /appMobileDeleteActions|app-mobile-delete-action/);
  assert.doesNotMatch(compactCss, /app-mobile-delete-action/);
  assert.doesNotMatch(appSource, /app-mobile-actions-(?:menu|popover)/);
  assert.match(compactCss, /\.app-quick-add-details:not\(\[open\]\) > \.quick-add-control\s*\{[\s\S]*?display:\s*none/);
});

test("standard, lesson, and assignment tables stay usable on narrow screens", () => {
  assert.match(appSource, /action-bar action-bar-data action-bar-tietchuan/);
  assert.match(appSource, /class="tietchuan-filter-list"/);
  assert.match(appSource, /tietchuan-filter-label-mobile/);
  assert.match(appSource, /tabBtn\("giaovien","Giáo viên","GV"\)/);
  assert.match(appSource, /pccm-action-button[\s\S]*?appUiIcon\("upload"\)/);
  assert.match(appSource, /pccm-delete-btn[\s\S]*?appUiIcon\("trash"\)/);
  assert.match(compactCss, /\.pccm-action-bar\s*\{[\s\S]*?repeat\(3, minmax\(0, 1fr\)\) repeat\(4, var\(--app-mobile-control\)\)/);
  assert.match(compactCss, /\.pccm-tab-actions\s*\{[\s\S]*?display:\s*contents/);
  assert.match(compactCss, /\.pccm-main-actions\s*\{[\s\S]*?display:\s*contents/);
  assert.match(compactCss, /\.pccm-side-actions\s*\{[\s\S]*?display:\s*contents/);
  assert.match(appSource, /aria-label="Tổng tiết: \$\{pccmTotal\.assigned\}"[\s\S]*?class="pccm-total-prefix">Tổng: <\/span>[\s\S]*?class="pccm-total-value">\$\{pccmTotal\.assigned\}/);
  assert.match(appSource, /badge\.querySelector\("\.pccm-total-value"\)/);
  assert.match(compactCss, /\.pccm-total-badge\s*\{[\s\S]*?align-items:\s*center[\s\S]*?justify-content:\s*center/);
  assert.match(compactCss, /\.pccm-total-prefix\s*\{[\s\S]*?display:\s*none/);
  assert.match(compactCss, /\.tietchuan-filter-list \.btn\s*\{[\s\S]*?min-width:\s*40px/);
  assert.match(compactCss, /\.data-table-wrap-compact,[\s\S]*?overflow-x:\s*auto/);
  assert.match(compactCss, /\.data-table-giaovien\s*\{[\s\S]*?min-width:\s*100%[\s\S]*?table-layout:\s*fixed/);
  assert.match(compactCss, /\.data-table-giaovien :is\(th, td\):nth-child\(2\)\s*\{[\s\S]*?width:\s*34%/);
  assert.match(compactCss, /\.data-table-giaovien :is\(th, td\):nth-child\(3\)\s*\{[\s\S]*?width:\s*19%/);
  assert.match(compactCss, /\.data-empty-row td\s*\{[\s\S]*?height:\s*56px/);
  assert.match(appSource, /table class="tietchuan-table"/);
  assert.match(appSource, /class="tc-col-grade"/);
  assert.match(appSource, /class="pccm-col-main pccm-col-teacher"/);
  assert.match(compactCss, /\.tietchuan-table\s*\{[\s\S]*?min-width:\s*0[\s\S]*?table-layout:\s*fixed/);
  assert.match(compactCss, /\.tietchuan-table \.tc-col-subject\s*\{[\s\S]*?width:\s*36%/);
  assert.match(compactCss, /\.pccm-list-table\s*\{[\s\S]*?min-width:\s*0[\s\S]*?table-layout:\s*fixed/);
  assert.match(compactCss, /\.pccm-list-table \.pccm-col-main:nth-child\(3\)\s*\{[\s\S]*?width:\s*34%/);
  assert.match(compactCss, /\.pccm-list-table td\.pccm-cell-teacher\s*\{[\s\S]*?overflow:\s*visible/);
  assert.match(appSource, /function pccmPositionTeacherMultiMenu\(box\)/);
  assert.match(appSource, /roomBelow < 160 && roomAbove > roomBelow/);
  assert.match(appSource, /document\.body\.appendChild\(menu\)/);
  assert.match(appSource, /function pccmTeacherMultiMenuForBox\(box\)/);
  assert.match(compactCss, /> \.pccm-mobile-floating-menu\s*\{[\s\S]*?display:\s*block[\s\S]*?position:\s*fixed[\s\S]*?z-index:\s*1000[\s\S]*?white-space:\s*normal/);
  assert.match(compactCss, /> \.pccm-mobile-floating-menu \.pccm-multi-item\s*\{[\s\S]*?display:\s*block/);
  assert.doesNotMatch(compactCss, /body\.app-shell-body \.pccm-table\s*\{[\s\S]*?min-width:\s*0/);
  assert.match(compactCss, /\.pccm-side-list\s*\{[\s\S]*?max-height:\s*128px/);
});

test("mobile teacher menu escapes the table scrollport and resets cleanly", () => {
  const toggleStart = appSource.indexOf("function pccmTeacherMultiToggle");
  const toggleEnd = appSource.indexOf("function pccmTeacherMultiApply", toggleStart);
  const closeStart = appSource.indexOf("function pccmQuickMultiCloseAll");
  const closeEnd = appSource.indexOf("function pccmQuickMultiUpdateUI", closeStart);
  assert.ok(toggleStart >= 0 && toggleEnd > toggleStart);
  assert.ok(closeStart >= 0 && closeEnd > closeStart);

  const makeClassList = () => {
    const values = new Set();
    return {
      add(value){ values.add(value); },
      remove(value){ values.delete(value); },
      contains(value){ return values.has(value); }
    };
  };
  const style = {
    removeProperty(name){
      const key = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      delete this[key];
    }
  };
  const attributes = new Map();
  const menu = {
    classList: makeClassList(),
    style,
    parentElement: null,
    getAttribute(name){ return attributes.get(name) || null; },
    setAttribute(name, value){ attributes.set(name, String(value)); },
    removeAttribute(name){ attributes.delete(name); },
    querySelectorAll(){ return []; },
    remove(){ this.parentElement = null; }
  };
  const button = {
    getBoundingClientRect(){
      return {left:140, right:254, top:756, bottom:790, width:114, height:34};
    }
  };
  const box = {
    id:"pccm_gv_14_box",
    classList:makeClassList(),
    querySelector(selector){
      if (selector === ".pccm-multi-button") return button;
      if (selector === ".pccm-multi-menu" && menu.parentElement === this) return menu;
      return null;
    },
    appendChild(child){ child.parentElement = this; }
  };
  const body = {
    appendChild(child){ child.parentElement = this; }
  };
  menu.parentElement = box;

  const document = {
    body,
    documentElement:{clientWidth:390, clientHeight:844},
    getElementById(id){ return id === box.id ? box : null; },
    querySelectorAll(selector){
      if (selector === ".pccm-multi-select.open") return box.classList.contains("open") ? [box] : [];
      if (selector === ".pccm-mobile-floating-menu[data-pccm-menu-owner]") {
        return menu.classList.contains("pccm-mobile-floating-menu") && menu.getAttribute("data-pccm-menu-owner") ? [menu] : [];
      }
      if (selector === ".pccm-mobile-floating-menu") return menu.classList.contains("pccm-mobile-floating-menu") ? [menu] : [];
      return [];
    }
  };
  const context = {
    document,
    window:{innerWidth:390, innerHeight:844, matchMedia(){ return {matches:true}; }}
  };
  vm.runInNewContext(
    `${appSource.slice(toggleStart, toggleEnd)}\n${appSource.slice(closeStart, closeEnd)}`,
    context,
    {filename:"app-mobile-teacher-menu.js"}
  );

  context.pccmTeacherMultiToggle(null, "pccm_gv_14");
  assert.equal(box.classList.contains("open"), true);
  assert.equal(menu.parentElement, body, "menu must portal outside the clipped table wrapper");
  assert.equal(menu.classList.contains("pccm-mobile-floating-menu"), true);
  assert.equal(menu.getAttribute("data-pccm-menu-owner"), box.id);
  assert.equal(style.left, "140px");
  assert.equal(style.width, "220px");
  assert.ok(Number.parseFloat(style.bottom) >= 8, "bottom-row menu should open upward");
  assert.ok(Number.parseFloat(style.maxHeight) <= 240);

  context.pccmQuickMultiCloseAll();
  assert.equal(box.classList.contains("open"), false);
  assert.equal(menu.parentElement, box);
  assert.equal(menu.classList.contains("pccm-mobile-floating-menu"), false);
  assert.equal(menu.getAttribute("data-pccm-menu-owner"), null);
  assert.equal(style.left, undefined);
  assert.equal(style.bottom, undefined);
  assert.equal(style.maxHeight, undefined);
});
