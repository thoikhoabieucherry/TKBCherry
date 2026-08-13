"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "web", "super-admin.html"), "utf8");
const source = fs.readFileSync(path.join(root, "web", "super-admin.js"), "utf8");
const legacyCss = fs.readFileSync(path.join(root, "web", "super-admin.css"), "utf8");
const compactCss = fs.readFileSync(
  path.join(root, "web", "super-admin-mobile-compact.css"),
  "utf8"
);

test("super admin compact stylesheet loads last with a matching script cache marker", () => {
  const themeIndex = html.indexOf("theme-light.css");
  const legacyIndex = html.indexOf("super-admin.css");
  const compactIndex = html.indexOf(
    "super-admin-mobile-compact.css?v=20260725-v188-compact-super-admin-v2"
  );

  assert.ok(themeIndex >= 0);
  assert.ok(legacyIndex > themeIndex);
  assert.ok(compactIndex > legacyIndex);
  assert.match(html, /super-admin\.css\?v=20260802-user-usage-only-v9/);
  assert.match(html, /super-admin\.js\?v=20260803-max-plan-labels-v1/);
  assert.doesNotMatch(html, /solverInfrastructureBudget|solverInfrastructureEstimate|solverProfileBudget/);
});

test("the per-user request table stays usable on narrow Super Admin screens", () => {
  const tabletStart = legacyCss.indexOf("@media (max-width: 899px)");
  const narrowStart = legacyCss.indexOf("@media (max-width: 560px)");
  assert.ok(tabletStart >= 0);
  assert.ok(narrowStart >= 0);
  const tabletCss = legacyCss.slice(tabletStart, narrowStart);
  const narrowCss = legacyCss.slice(narrowStart);
  assert.match(
    tabletCss,
    /body\.portal-body\.portal-page-super\s*\{[\s\S]*?height:\s*auto;[\s\S]*?overflow-y:\s*auto/
  );
  assert.match(
    tabletCss,
    /\.portal-page-super \.portal-main > \.portal-card\s*\{[\s\S]*?flex:\s*0 0 auto;[\s\S]*?overflow:\s*visible/
  );
  assert.match(html, /id="solverAccountUsageBody"/);
  assert.match(legacyCss, /\.solver-account-usage-table\s*\{[\s\S]*?min-width:\s*760px/);
  assert.match(legacyCss, /\.solver-school-usage\s*\{[\s\S]*?margin-top:\s*14px/);
  assert.match(narrowCss, /\.solver-account-usage-table\s*\{[\s\S]*?min-width:\s*620px/);
  assert.doesNotMatch(html, /solverGoogleGrossCost|solverInfrastructureDetails|btnRefreshGoogleUsage/);
  assert.match(source, /if\(card\.dataset\?\.usageOnly !== "true"\) return;/);
});

test("top-level super admin commands keep text on desktop and accessible icons on mobile", () => {
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
  assert.match(source, /class="portal-ui-icon"[\s\S]*aria-hidden="true"/);
  assert.match(compactCss, /\.portal-button-icon\s*\{[\s\S]*?display:\s*none/);
  assert.match(compactCss, /@media \(max-width:\s*899px\)[\s\S]*?\.portal-button-label\s*\{[\s\S]*?display:\s*none/);
});

test("mobile school rows expose only open, schedule, and overflow controls", () => {
  assert.match(source, /class="portal-action-bar portal-action-desktop"/);
  assert.match(source, /class="portal-action-mobile"/);
  assert.match(source, /class="portal-row-menu"/);
  assert.match(source, /class="portal-more-trigger"[^>]*title="Thao tác khác"[^>]*aria-label="Thao tác khác"/);
  assert.match(source, /class="portal-action-menu" role="menu"/);
  assert.match(source, /class="portal-menu-close" data-menu-close title="Đóng" aria-label="Đóng"/);
  assert.match(source, /selectedScheduleNumber\(row, school, btn\)/);

  assert.match(compactCss, /\.portal-action-mobile\s*\{\s*display:\s*none/);
  assert.match(
    compactCss,
    /\.portal-table-schools \.portal-action-desktop\s*\{\s*display:\s*none/
  );
  assert.match(compactCss, /\.portal-action-mobile\s*\{[\s\S]*?grid-template-columns:\s*var\(--portal-mobile-control\) minmax\(92px, 1fr\) var\(--portal-mobile-control\)/);
  assert.match(compactCss, /\.portal-action-menu\s*\{[\s\S]*?position:\s*fixed[\s\S]*?bottom:\s*max\(8px, env\(safe-area-inset-bottom\)\)/);
});

test("mobile cards are compact while dangerous and secondary actions remain reachable", () => {
  assert.match(compactCss, /--portal-mobile-control:\s*44px/);
  assert.match(compactCss, /grid-template-areas:\s*\n\s*"school status"\s*\n\s*"email email"\s*\n\s*"plan expiry"\s*\n\s*"actions actions"/);
  assert.match(compactCss, /\.portal-table-schools tbody\s*\{\s*gap:\s*8px/);
  assert.match(compactCss, /\.portal-action-menu \.portal-btn-del\s*\{[\s\S]*?grid-column:\s*1 \/ -1/);
  assert.match(source, /data-act="del-tkb"[^>]*aria-label="Xóa TKB đang chọn"/);
  assert.match(source, /data-act="toggle"[^>]*aria-label="\$\{active \? "Khóa trường" : "Mở khóa trường"\}"/);
  assert.match(source, /data-act="pwd"[^>]*aria-label="Đổi mật khẩu admin"/);
  assert.match(source, /data-act="edit"[^>]*aria-label="Sửa tên trường"/);
  assert.match(source, /data-act="del"[^>]*aria-label="Xóa trường"/);
});
