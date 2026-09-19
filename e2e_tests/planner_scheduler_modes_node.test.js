"use strict";

// 03/09 (chu du an: "nut do hoi phe"): menu "Toi uu" chay bo toi uu FET trong
// trinh duyet (btnOptimizeMenu / plannerOptimizeMenu / runPlannerSchedulerMode /
// sapXepTheoCheDo) da GO HAN khoi trang Sap xep. Con lai: nut ▶ (FET xep nhanh,
// mode auto) va menu "Toi uu v3" (engine v3 tren may chu, tung muc tieu).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

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

const FET_OPTIMIZE_MARKERS = [
  "btnOptimizeMenu", "plannerOptimizeMenu", "plannerOptimizeWrap", "togglePlannerOptimizeMenu",
  "runPlannerSchedulerMode", "setPlannerOptimizeMenuOpen", "syncPlannerOptimizeRoleAccess",
  "sapXepTheoCheDo", "deepOptimizeTheoCheDo", "data-scheduler-mode="
];

function buttonMarkup(source, id){
  return (source.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) || [])
    .find(markup => markup.includes(`id="${id}"`)) || "";
}

test("Play stays the browser FET quick check and the FET optimize menu is gone", () => {
  const play = buttonMarkup(plannerHtml, "btnAutoSort");
  assert.ok(play, "automatic Play button is missing");
  assert.match(play, /onclick="[^"]*sapXepTuDongAll\(\)"/);

  for(const marker of FET_OPTIMIZE_MARKERS){
    assert.equal(plannerHtml.includes(marker), false, `sapxep.html van con ${marker}`);
    assert.equal(plannerSource.includes(marker), false, `phanmon.js van con ${marker}`);
    assert.equal(bridgeSource.includes(marker), false, `tkb-rust-bridge.js van con ${marker}`);
  }
  assert.doesNotMatch(plannerHtml, /runPlannerDeepOptimize|Tối ưu sâu/);
  // Nut ▶ trong phanmon.js van la FET thuan (mode auto), khong lien quan menu da go.
  assert.match(plannerSource, /window\.sapXepTuDongAll = async function\(options = \{\}\)\{[\s\S]*?executeDirectFastSchedule\(\{ mode: options\?\.mode \|\| "auto" \}\);/);
});

test("Toi uu v3 menu keeps its four engine goals", () => {
  const menuStart = plannerHtml.indexOf('<div id="plannerTestMenu"');
  const menuEnd = plannerHtml.indexOf("</div>", menuStart);
  assert.ok(menuStart >= 0 && menuEnd > menuStart, "v3 menu is missing");
  const items = plannerHtml.slice(menuStart, menuEnd).match(/<button\b[^>]*role="menuitem"[^>]*>[\s\S]*?<\/button>/g) || [];
  assert.equal(items.length, 4);
  assert.deepEqual(
    items.map(item => item.match(/data-test-mode="([^"]+)"/)?.[1]),
    ["optimize_singletons", "optimize_sessions", "optimize_gap2", "optimize_gap1"]
  );
  assert.deepEqual(
    items.map(item => item.replace(/<[^>]+>/g, "").trim()),
    ["1 tiết/buổi", "Buổi dạy", "2 tiết trống", "1 tiết trống"]
  );
  for(const item of items) assert.match(item, /runPlannerV3Mode\('optimize_[a-z0-9]+', event\)/);
  assert.match(
    plannerHtml,
    /\.planner-optimize-menu\s*>\s*button\[hidden\]\s*\{[^}]*display:\s*none !important;/s
  );
});

test("portrait and landscape retain responsive toolbar slots for the v3 control", () => {
  assert.match(
    plannerHtml,
    /grid-template-columns:\s*repeat\(8, minmax\(0, 1fr\)\);/,
    "portrait touch geometry must include Toi uu v3"
  );
  assert.match(
    plannerHtml,
    /grid-template-columns:\s*repeat\(9, minmax\(0, 1fr\)\);/,
    "landscape touch geometry must include Toi uu v3"
  );
  // 23/08: dien thoai an ▶ FET; Toi uu v3 chiem o 4 (doc) / 5 (ngang). 03/09: khong con khoi CSS an menu Toi uu FET.
  assert.match(plannerHtml, /\.toolbar-actions\s*>\s*#btnAutoSort\s*\{[^}]*display:\s*none !important;/s);
  assert.match(plannerHtml, /\.toolbar-actions\s*>\s*#plannerTestWrap\s*\{[^}]*grid-column:\s*4;/s);
  assert.match(plannerHtml, /\.toolbar-actions\s*>\s*#plannerTestWrap\s*\{[^}]*grid-column:\s*5;/s);
});

test("one-click Automatic still carries the internal quality-optimization contract", () => {
  assert.match(bridgeSource, /settings\.optimization_focus\s*=\s*"automatic"/);
  assert.match(bridgeSource, /settings\.optimization_continue_quality_search\s*=\s*true/);
  assert.match(bridgeSource, /settings\.optimization_first_click_strict_quality_gate\s*=\s*true/);
  assert.match(bridgeSource, /settings\.optimization_accept_gap1_sessions/);
});

test("retired Hybrid callers cannot route a planner action to Cloud Run", () => {
  assert.match(bridgeSource, /failureKind:\s*["']hybrid_retired["']/);
  assert.match(
    bridgeSource,
    /function hybridCloudRunInvocationSettings\(options\)[\s\S]*?return null;/
  );
  assert.match(bridgeSource, /executor:\s*["']fet_worker["']/);
});
