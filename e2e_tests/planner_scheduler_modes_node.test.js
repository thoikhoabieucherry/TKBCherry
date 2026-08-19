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
const bridgeSource = fs.readFileSync(
  path.resolve(__dirname, "..", "web", "pages", "tkb-rust-bridge.js"),
  "utf8"
);

function buttonMarkup(source, id){
  return (source.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) || [])
    .find(markup => markup.includes(`id="${id}"`)) || "";
}

test("Unified Play button invokes sapXepTuDongAll and Stop button invokes requestStopAutoSort", () => {
  const play = buttonMarkup(plannerHtml, "btnAutoSort");
  assert.ok(play, "automatic Play button is missing");
  assert.match(play, /onclick="sapXepTuDongAll\(\)"/);

  const stop = buttonMarkup(plannerHtml, "btnStopAutoSort");
  assert.ok(stop, "stop button is missing");
  assert.match(stop, /onclick="requestStopAutoSort\(\)"/);

  // Deleted pipeline buttons must not exist
  assert.doesNotMatch(plannerHtml, /id="btnTrialFullPipeline"/);
  assert.doesNotMatch(plannerHtml, /id="btnNewLockedPipeline"/);
  assert.doesNotMatch(plannerHtml, /id="plannerOptimizeWrap"/);
  assert.doesNotMatch(plannerHtml, /id="plannerOptimizeMenu"/);
});

test("portrait and landscape retain responsive toolbar slots for the optimize control", () => {
  assert.match(
    plannerHtml,
    /grid-template-columns:\s*repeat\(8, minmax\(0, 1fr\)\);/,
    "portrait touch geometry must include Optimize"
  );
  assert.match(
    plannerHtml,
    /grid-template-columns:\s*repeat\(9, minmax\(0, 1fr\)\);/,
    "landscape touch geometry must include Optimize"
  );
  assert.match(plannerHtml, /\.toolbar-actions\s*>\s*\.planner-optimize-wrap\s*\{[^}]*grid-column:\s*4;/s);
  assert.match(plannerHtml, /\.toolbar-actions\s*>\s*\.planner-optimize-wrap\s*\{[^}]*grid-column:\s*5;/s);
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
