"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "web", "super-admin.html"), "utf8");
const source = fs.readFileSync(path.join(root, "web", "super-admin.js"), "utf8");
const pageCss = fs.readFileSync(path.join(root, "web", "super-admin.css"), "utf8");
const compactCss = fs.readFileSync(
  path.join(root, "web", "super-admin-mobile-compact.css"),
  "utf8"
);

test("Super Admin loads the school-management styles and script", () => {
  const themeIndex = html.indexOf("theme-light.css");
  const pageIndex = html.indexOf("super-admin.css?v=20260823-web-fet-v1");
  const compactIndex = html.indexOf("super-admin-mobile-compact.css");

  assert.ok(themeIndex >= 0);
  assert.ok(pageIndex > themeIndex);
  assert.ok(compactIndex > pageIndex);
  assert.match(html, /super-admin\.js\?v=20260823-web-fet-v1/);
  assert.doesNotMatch(
    html + source + pageCss,
    /solverInfrastructure|solverAccountUsage|solver-school-usage|Cloud Run|VPS/
  );
});

test("the school table becomes cards on narrow screens", () => {
  const tabletStart = pageCss.indexOf("@media (max-width: 899px)");
  assert.ok(tabletStart >= 0);
  const tabletCss = pageCss.slice(tabletStart);
  assert.match(
    tabletCss,
    /body\.portal-body\.portal-page-super\s*\{[\s\S]*?height:\s*auto;[\s\S]*?overflow-y:\s*auto/
  );
  assert.match(
    tabletCss,
    /\.portal-table-schools tr\.portal-school-row\s*\{[\s\S]*?grid-template-areas:/
  );
  assert.match(compactCss, /--portal-mobile-control:\s*44px/);
  assert.match(compactCss, /grid-template-areas:\s*\n\s*"school status"/);
});

test("top-level commands keep labels on desktop and accessible icons on mobile", () => {
  for(const [id, label, icon] of [
    ["btnChangePassword", "Đổi mật khẩu", "key"],
    ["btnOpenApp", "Mở phần mềm", "layout"],
    ["btnLogout", "Đăng xuất", "logout"],
    ["btnAddSchool", "Thêm trường mới", "plus"],
    ["btnReloadSchools", "Tải lại danh sách", "refresh"]
  ]){
    const start = html.indexOf(`id="${id}"`);
    const end = html.indexOf("</button>", start);
    const button = html.slice(start, end);
    assert.ok(start >= 0, `${id} is missing`);
    assert.match(button, new RegExp(`title="${label}"`));
    assert.match(button, new RegExp(`aria-label="${label}"`));
    assert.match(button, new RegExp(`data-portal-icon="${icon}"`));
    assert.match(button, /portal-button-label/);
  }

  assert.match(source, /function portalIcon\(name\)/);
  assert.match(compactCss, /\.portal-button-icon\s*\{[\s\S]*?display:\s*none/);
  assert.match(compactCss, /@media \(max-width:\s*899px\)[\s\S]*?\.portal-button-label\s*\{[\s\S]*?display:\s*none/);
});

test("mobile school rows keep primary and overflow actions reachable", () => {
  assert.match(source, /class="portal-action-bar portal-action-desktop"/);
  assert.match(source, /class="portal-action-mobile"/);
  assert.match(source, /class="portal-row-menu"/);
  assert.match(source, /class="portal-action-menu" role="menu"/);
  assert.match(compactCss, /\.portal-table-schools \.portal-action-desktop\s*\{\s*display:\s*none/);
  assert.match(compactCss, /\.portal-action-menu\s*\{[\s\S]*?position:\s*fixed/);
  assert.match(compactCss, /\.portal-action-menu \.portal-btn-del\s*\{[\s\S]*?grid-column:\s*1 \/ -1/);
});
