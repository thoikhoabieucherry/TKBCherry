"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const appHtml = fs.readFileSync(path.join(root, "web", "app.html"), "utf8");
const appSource = fs.readFileSync(path.join(root, "web", "app.js"), "utf8");
const compactCss = fs.readFileSync(
  path.join(root, "web", "admin-mobile-compact.css"),
  "utf8"
);

test("admin loads the v187 compact stylesheet after legacy themes", () => {
  const themeIndex = appHtml.indexOf("theme-light.css");
  const runtimeIndex = appHtml.indexOf("runtime.css");
  const compactIndex = appHtml.indexOf(
    "admin-mobile-compact.css?v=20260725-v187-deep-session-admin-ui-v1"
  );

  assert.ok(themeIndex >= 0 && runtimeIndex > themeIndex);
  assert.ok(compactIndex > runtimeIndex, "compact overrides must load last");
  assert.match(appHtml, /app\.js\?v=20260725-v187-deep-session-admin-ui-v1/);
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

test("data actions collapse to one icon toolbar and safe overflow menus", () => {
  assert.match(appSource, /function appUiIcon\(name\)/);
  assert.match(appSource, /function appQuickAddDetails\(content\)/);
  assert.match(appSource, /function appMobileDeleteMenu\(section, selectedCount\)/);
  assert.match(appSource, /class="action-bar action-bar-data\$\{quickAdd \? " has-quick-add" : ""\}"/);
  assert.match(appSource, /class="app-mobile-actions-popover"/);
  assert.match(appSource, /\$\{count \? "" : "disabled"\}/);
  assert.match(compactCss, /\.action-bar-data\.has-quick-add\s*\{[\s\S]*?repeat\(4, var\(--app-mobile-control\)\)/);
  assert.match(compactCss, /\.app-quick-add-details:not\(\[open\]\) > \.quick-add-control\s*\{[\s\S]*?display:\s*none/);
  assert.match(compactCss, /\.app-mobile-actions-popover\s*\{[\s\S]*?position:\s*absolute/);
});

test("standard, lesson, and assignment tables stay usable on narrow screens", () => {
  assert.match(appSource, /action-bar action-bar-data action-bar-tietchuan/);
  assert.match(appSource, /class="tietchuan-filter-list"/);
  assert.match(appSource, /pccm-action-button[\s\S]*?appUiIcon\("upload"\)/);
  assert.match(appSource, /pccm-delete-btn[\s\S]*?appUiIcon\("trash"\)/);
  assert.match(compactCss, /\.pccm-tab-actions\s*\{[\s\S]*?repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(compactCss, /\.data-table-wrap-compact,[\s\S]*?overflow-x:\s*auto/);
  assert.match(compactCss, /\.data-table-giaovien\s*\{[\s\S]*?min-width:\s*100%[\s\S]*?table-layout:\s*fixed/);
  assert.match(compactCss, /\.data-table-giaovien :is\(th, td\):nth-child\(2\)\s*\{[\s\S]*?width:\s*34%/);
  assert.match(compactCss, /\.data-table-giaovien :is\(th, td\):nth-child\(3\)\s*\{[\s\S]*?width:\s*19%/);
  assert.match(compactCss, /\.data-empty-row td\s*\{[\s\S]*?height:\s*56px/);
});
