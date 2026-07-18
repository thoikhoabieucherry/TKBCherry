"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  app,
  createFixedWindowLimiter,
  originAllowed,
  parseAllowedOrigins,
  positiveInteger
} = require("./server");

test("origin allowlist normalizes trailing slashes and rejects unknown sites", () => {
  const allowed = parseAllowedOrigins("https://tkbcherry.com/, http://127.0.0.1:1010");
  assert.equal(originAllowed("https://tkbcherry.com", allowed), true);
  assert.equal(originAllowed("http://127.0.0.1:1010/", allowed), true);
  assert.equal(originAllowed("https://attacker.example", allowed), false);
  assert.equal(originAllowed(undefined, allowed), true);
});

test("wildcard CORS must be explicitly configured", () => {
  assert.equal(originAllowed("https://any.example", new Set(["*"])), true);
  assert.equal(originAllowed("https://any.example", new Set()), false);
});

test("fixed-window limiter blocks at the configured threshold and resets", () => {
  const limiter = createFixedWindowLimiter(1_000);
  assert.equal(limiter.consume("ip:one", 2, 10_000).allowed, true);
  assert.equal(limiter.consume("ip:one", 2, 10_100).allowed, true);
  const blocked = limiter.consume("ip:one", 2, 10_200);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterMs, 800);
  assert.equal(limiter.consume("ip:one", 2, 11_000).allowed, true);
});

test("positive integer configuration fails safely to defaults", () => {
  assert.equal(positiveInteger("12", 5), 12);
  assert.equal(positiveInteger("0", 5), 5);
  assert.equal(positiveInteger("not-a-number", 5), 5);
});

test("mail API rejects a disallowed browser origin before routing", async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/health`, {
      headers: { Origin: "https://attacker.example" }
    });
    assert.equal(response.status, 403);

    const allowed = await fetch(`http://127.0.0.1:${address.port}/api/health`, {
      headers: { Origin: "https://tkbcherry.com" }
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://tkbcherry.com");
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
