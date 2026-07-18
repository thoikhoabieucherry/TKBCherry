"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const plannerHtml = fs.readFileSync(
  path.resolve(__dirname, "..", "web", "pages", "sapxep.html"),
  "utf8"
);
const manifestPath = path.resolve(
  __dirname,
  "..",
  "web",
  "pages",
  "planner.webmanifest"
);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

test("planner opts into the iPhone edge-to-edge standalone viewport", () => {
  assert.match(
    plannerHtml,
    /<meta name="viewport" content="width=device-width, initial-scale=1\.0, viewport-fit=cover">/
  );
  assert.match(plannerHtml, /<meta name="apple-mobile-web-app-capable" content="yes">/);
  assert.match(plannerHtml, /<meta name="mobile-web-app-capable" content="yes">/);
  assert.match(
    plannerHtml,
    /<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">/
  );
  assert.match(plannerHtml, /<link rel="manifest" href="planner\.webmanifest\?v=[^"]+">/);
  assert.match(
    plannerHtml,
    /<link rel="apple-touch-icon"[^>]*href="\.\.\/assets\/favicon-cherry\.png\?v=3">/
  );
  assert.match(plannerHtml, /<title>TKB Cherry<\/title>/);
  assert.match(plannerHtml, /<meta name="application-name" content="TKB Cherry">/);
  assert.match(
    plannerHtml,
    /body\.planner-shell\s*\{[^}]*padding-top:\s*env\(safe-area-inset-top\);[^}]*padding-bottom:\s*env\(safe-area-inset-bottom\);/s
  );
});

test("mobile reuses the bottom safe-area band for a stable progress row", () => {
  const start = plannerHtml.indexOf(
    "@media (max-width: 900px) and (hover: none) and (pointer: coarse)"
  );
  const css = plannerHtml.slice(
    start,
    plannerHtml.indexOf("@media (min-width: 481px)", start)
  );

  assert.ok(start >= 0, "mobile planner CSS is missing");
  assert.match(css, /body\.planner-shell\s*\{[^}]*--planner-mobile-feedback-h:\s*46px;[^}]*padding-bottom:\s*0;/s);
  assert.match(css, /\.toolbar-main\s*\{[^}]*grid-template-rows:\s*44px var\(--planner-mobile-feedback-h\);/s);
  assert.match(css, /\.toolbar-feedback\s*\{[^}]*display:\s*grid;[^}]*height:\s*var\(--planner-mobile-feedback-h\);/s);
  assert.doesNotMatch(css, /\.toolbar-feedback:has\(/);
});

test("planner manifest launches the scheduler as a standalone app", () => {
  assert.equal(manifest.name, "TKB Cherry");
  assert.equal(manifest.short_name, "TKB Cherry");
  assert.equal(manifest.id, "./sapxep");
  assert.equal(manifest.start_url, "./sapxep");
  assert.equal(manifest.scope, "../");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.orientation, "any");
  assert.ok(
    manifest.icons.some((icon) => icon.src === "../assets/favicon-cherry.png"),
    "manifest must expose the Cherry app icon"
  );
});

test("landscape layout covers the viewport while keeping toolbar controls notch-safe", () => {
  const start = plannerHtml.indexOf(
    "@media (orientation: landscape) and (max-height: 540px) and (any-pointer: coarse)"
  );
  const css = plannerHtml.slice(start, plannerHtml.indexOf("</style>", start));

  assert.ok(start >= 0, "phone-landscape CSS is missing");
  assert.match(
    css,
    /body\.planner-shell\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*none;[^}]*height:\s*var\(--tkb-mobile-viewport-h, 100dvh\);[^}]*min-height:\s*var\(--tkb-mobile-viewport-h, 100dvh\);[^}]*max-height:\s*var\(--tkb-mobile-viewport-h, 100dvh\);/s
  );
  assert.match(
    css,
    /\.toolbar\s*\{[^}]*padding-left:\s*max\(5px, env\(safe-area-inset-left\)\);[^}]*padding-right:\s*max\(5px, env\(safe-area-inset-right\)\);/s
  );
  assert.match(
    css,
    /\.center\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*none;[^}]*padding-left:\s*2px;[^}]*padding-right:\s*2px;/s
  );
});
