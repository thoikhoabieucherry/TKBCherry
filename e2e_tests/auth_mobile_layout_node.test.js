import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "web", "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "web", "auth.css"), "utf8");

test("mobile login brand aligns logo, copy, and illustration on one center axis", () => {
  assert.match(html, /auth\.css\?v=20260724-mobile-brand-center-v1/);
  const start = css.indexOf("@media (max-width: 899px)");
  const end = css.indexOf("@media (max-width: 520px)", start);
  assert.ok(start >= 0, "mobile auth breakpoint is missing");
  const mobile = css.slice(start, end > start ? end : css.length);

  assert.match(mobile, /\.auth-home \.auth-brand-inner\s*\{[^}]*align-items:\s*center;[^}]*justify-items:\s*center;[^}]*text-align:\s*center;/s);
  assert.match(mobile, /\.auth-home \.auth-brand-copy\s*\{[^}]*width:\s*100%;[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*align-items:\s*center;/s);
  assert.match(mobile, /\.auth-home \.auth-logo-img\s*\{[^}]*margin-left:\s*auto;[^}]*margin-right:\s*auto;/s);
  assert.match(mobile, /\.auth-home \.auth-brand-visual\s*\{[^}]*margin-left:\s*auto;[^}]*margin-right:\s*auto;[^}]*transform:\s*none;/s);
});

test("desktop login illustration keeps its intentional offset", () => {
  const mobileStart = css.indexOf("@media (max-width: 899px)");
  assert.match(css.slice(0, mobileStart), /\.auth-home \.auth-brand-visual\s*\{[^}]*transform:\s*translateX\(50px\);/s);
});
