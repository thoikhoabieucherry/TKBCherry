"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, "web", file), "utf8");
const superHtml = read("super-admin.html");
const schoolHtml = read("school-portal.html");
const superSource = read("super-admin.js");
const schoolSource = read("school-portal.js");

function countHtmlId(html, id){
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (html.match(new RegExp(`id="${escaped}"`, "g")) || []).length;
}

test("Super Admin shows request counts plus aggregate-only solver operations", () => {
  assert.match(superHtml, /id="solverInfrastructureCard"[^>]*data-usage-only="true"/);
  assert.doesNotMatch(superHtml, /solverInfrastructureTitle|Theo dõi số lần từng tài khoản/);
  assert.match(superHtml, /id="solverAccountUsageTitle">Lượt gọi theo người dùng<\/h3>/);
  assert.match(superHtml, /id="solverAccountUsageBody"/);
  assert.match(superHtml, /<th>Trường<\/th>/);
  assert.match(superHtml, /<th>Tài khoản<\/th>/);
  assert.match(superHtml, /<th>Tổng lượt<\/th>/);
  assert.match(superHtml, /<th>Cloud Run<\/th>/);
  assert.match(superHtml, /<th>VPS<\/th>/);
  assert.equal(countHtmlId(superHtml, "solverAccountUsageBody"), 1);
  assert.match(superHtml, /id="solverTelemetryCard"[^>]*data-aggregate-only="true"/);
  assert.match(superHtml, /id="solverTelemetryTitle">Vận hành solver<\/h2>/);
  assert.match(superHtml, /id="solverTelemetryWindow"/);
  assert.match(superHtml, /id="solverTelemetryBody"/);
  assert.match(superHtml, /id="solverTelemetryProvenanceBody"/);
  assert.match(superHtml, /Không hiển thị thời khóa biểu, mã job, trường, tài khoản hay lỗi thô/);
  assert.match(superHtml, /super-admin\.css\?v=20260816-solver-telemetry-v1/);
  assert.match(superHtml, /super-admin\.js\?v=20260816-solver-telemetry-v1/);
});

test("cost, Google telemetry, and routing configuration are absent from Super Admin markup", () => {
  for(const id of [
    "btnRefreshGoogleUsage",
    "solverGoogleConnection",
    "solverGoogleGrossCost",
    "solverGoogleUpdatedAt",
    "solverGoogleCreditsApplied",
    "solverGoogleNetCost",
    "solverGoogleWarning",
    "solverGoogleLive",
    "solverInfrastructureForm",
    "solverInfrastructureDetails",
    "solverInfrastructureMode",
    "solverProfileBundle",
    "solverProfileProjectId"
  ]){
    assert.equal(countHtmlId(superHtml, id), 0, `${id} must not be rendered`);
  }
  assert.doesNotMatch(superHtml, /Chi phí xếp thời khóa biểu|Google đã tính|Đồng bộ chi phí|Credit\/ưu đãi|Chi phí sau credit/);
  assert.doesNotMatch(superHtml, /TKB_CLOUD_PROFILE=|Google Cloud gần thời gian thực|Service URL|Solver digest/);
});

test("school portal never exposes solver statistics or admin infrastructure APIs", () => {
  for(const id of [
    "solverInfrastructureCard",
    "solverInfrastructureForm",
    "solverInfrastructureMode",
    "solverProfileId",
    "solverInfrastructureStatus",
    "solverAccountUsageBody",
    "solverTelemetryCard",
    "solverTelemetryBody"
  ]){
    assert.equal(countHtmlId(schoolHtml, id), 0, `${id} must not be rendered for school users`);
  }
  assert.doesNotMatch(schoolHtml, /super-admin\.css(?:\?|\")/);
  assert.doesNotMatch(schoolSource, /initSolverInfrastructureCard/);
  assert.doesNotMatch(schoolSource, /\/api\/admin\/solver-(?:infrastructure|usage|telemetry)/);
});

function elementStub(id){
  const classes = new Set();
  return {
    id,
    dataset:{},
    textContent:"",
    innerHTML:"",
    classList:{
      toggle(name, enabled){
        if(enabled) classes.add(name);
        else classes.delete(name);
      },
      contains(name){ return classes.has(name); }
    },
    addEventListener(){}
  };
}

test("usage-only runtime refreshes from solver-route events without polling", async () => {
  const card = elementStub("solverInfrastructureCard");
  card.dataset.usageOnly = "true";
  const body = elementStub("solverAccountUsageBody");
  const status = elementStub("solverInfrastructureStatus");
  const elements = {
    solverInfrastructureCard:card,
    solverAccountUsageBody:body,
    solverInfrastructureStatus:status
  };
  const fetchCalls = [];
  const windowListeners = new Map();
  const documentListeners = new Map();
  const window = {
    fetch:async (url, options={}) => {
      fetchCalls.push({url, options});
      return {
        ok:true,
        status:200,
        json:async () => ({
          ok:true,
          usage:{
            accountRequests:[{
              schoolId:"school-a",
              accountId:"alice@example.com",
              totalRequests:7,
              cloudRun:{requests:5},
              vps:{requests:2}
            },{
              schoolId:"school-b",
              accountId:"bob@example.com",
              totalRequests:3,
              cloudRun:{requests:3},
              vps:{requests:0}
            }]
          },
          googleCloud:{
            billing:{grossCost:999999},
            monitoring:{metrics:{requestCount:999}}
          }
        })
      };
    },
    TKBAuthApi:{
      getAuthHeaders(){ return {Authorization:"Bearer test-session"}; }
    },
    addEventListener(name, handler){
      windowListeners.set(String(name), handler);
    }
  };
  const document = {
    visibilityState:"visible",
    getElementById(id){ return elements[id] || null; },
    addEventListener(name, handler){
      documentListeners.set(String(name), handler);
    }
  };
  window.window = window;
  window.document = document;

  const start = superSource.indexOf("function initSolverInfrastructureCard(){");
  const end = superSource.indexOf("\n  initSolverInfrastructureCard();", start);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(
    `${superSource.slice(start, end)}\ninitSolverInfrastructureCard();`,
    {window, document, console, Number, String, Object, Array, Math, JSON, Error},
    {filename:"solver-usage-card.js"}
  );
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "/api/admin/solver-usage");
  assert.equal(fetchCalls[0].options.headers.Authorization, "Bearer test-session");
  assert.doesNotMatch(superSource, /setInterval\(loadUserUsage/);
  assert.match(body.innerHTML, /school-a/);
  assert.match(body.innerHTML, /alice@example\.com/);
  assert.match(body.innerHTML, />7<\/td>/);
  assert.match(body.innerHTML, />5<\/td>/);
  assert.match(body.innerHTML, />2<\/td>/);
  assert.match(body.innerHTML, /school-b/);
  assert.doesNotMatch(body.innerHTML, /999999|grossCost|requestCount/);
  assert.match(status.textContent, /luồng xếp/);

  windowListeners.get("tkb:solver-usage-route")({detail:{executor:"cloud_run"}});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetchCalls.length, 2);
  windowListeners.get("storage")({key:"TKB_SOLVER_USAGE_ROUTE_V1"});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetchCalls.length, 3);
  windowListeners.get("focus")();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetchCalls.length, 4);
  documentListeners.get("visibilitychange")();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetchCalls.length, 5);
  assert.ok(fetchCalls.every(call => call.url === "/api/admin/solver-usage"));
});

test("aggregate solver telemetry uses the admin route and escapes provenance", async () => {
  const card = elementStub("solverTelemetryCard");
  card.dataset.aggregateOnly = "true";
  const select = elementStub("solverTelemetryWindow");
  select.value = "7d";
  const reload = elementStub("btnReloadSolverTelemetry");
  const summary = elementStub("solverTelemetrySummary");
  const body = elementStub("solverTelemetryBody");
  const provenance = elementStub("solverTelemetryProvenanceBody");
  const status = elementStub("solverTelemetryStatus");
  const elements = {
    solverTelemetryCard:card,
    solverTelemetryWindow:select,
    btnReloadSolverTelemetry:reload,
    solverTelemetrySummary:summary,
    solverTelemetryBody:body,
    solverTelemetryProvenanceBody:provenance,
    solverTelemetryStatus:status
  };
  const fetchCalls = [];
  const window = {
    fetch:async (url, options={}) => {
      fetchCalls.push({url, options});
      return {
        ok:true,
        status:200,
        json:async () => ({
          ok:true,
          events:{total:2, browser:1, server:1},
          deepRunRate:50,
          overall:{
            total:2,
            successRate:50,
            hardValidRate:100,
            targetReachedRate:50,
            runtimeMs:{p50:1200, p95:3200},
            metric:{deltaAverage:3},
            estimatedCostUsd:0.0123
          },
          byExecutorFocusBudget:[{
            executor:"<img src=x onerror=bad>",
            focus:"gaps",
            gapTarget:"gap2",
            budgetKind:"deep",
            budgetSeconds:180,
            aggregate:{
              total:1,
              successRate:100,
              noImprovement:0,
              failed:0,
              cancelled:0,
              targetReachedRate:100,
              runtimeMs:{p50:1200,p95:1200},
              metric:{deltaAverage:3},
              estimatedCostUsd:0.0123
            }
          }],
          cloud:[{
            profile:"primary",
            revision:"<script>revision</script>",
            digest:"abcdef0123456789abcdef0123456789"
          }]
        })
      };
    },
    TKBAuthApi:{getAuthHeaders(){ return {Authorization:"Bearer telemetry-test"}; }}
  };
  const document = { getElementById(id){ return elements[id] || null; } };
  window.window = window;
  window.document = document;
  const start = superSource.indexOf("function initSolverTelemetryCard(){");
  const end = superSource.indexOf("\n  initSolverTelemetryCard();", start);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(
    `${superSource.slice(start, end)}\ninitSolverTelemetryCard();`,
    {window, document, console, Number, String, Object, Array, Math, JSON, Error, Promise, encodeURIComponent, Intl, setTimeout},
    {filename:"solver-telemetry-card.js"}
  );
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "/api/admin/solver-telemetry?window=7d");
  assert.equal(fetchCalls[0].options.headers.Authorization, "Bearer telemetry-test");
  assert.match(summary.innerHTML, /50%/);
  assert.match(body.innerHTML, /2 tiết trống/);
  assert.match(body.innerHTML, /Deep Optimize/);
  assert.doesNotMatch(body.innerHTML, /<img|<script>/);
  assert.doesNotMatch(provenance.innerHTML, /<script>/);
  assert.match(provenance.innerHTML, /&lt;script&gt;revision/);
  assert.match(status.textContent, /7d/);
});

test("a card without the usage-only contract cannot revive legacy cost or routing calls", () => {
  const card = elementStub("solverInfrastructureCard");
  let fetchCount = 0;
  const window = {
    fetch:async () => {
      fetchCount += 1;
      throw new Error("legacy request must not run");
    },
    TKBAuthApi:{getAuthHeaders(){ return {}; }}
  };
  const document = {
    getElementById(id){ return id === "solverInfrastructureCard" ? card : null; }
  };
  window.window = window;
  window.document = document;
  const start = superSource.indexOf("function initSolverInfrastructureCard(){");
  const end = superSource.indexOf("\n  initSolverInfrastructureCard();", start);
  vm.runInNewContext(
    `${superSource.slice(start, end)}\ninitSolverInfrastructureCard();`,
    {window, document, console, Number, String, Object, Array, Math, JSON, Error},
    {filename:"solver-usage-card-guard.js"}
  );

  assert.equal(fetchCount, 0);
  assert.match(superSource, /if\(card\.dataset\?\.usageOnly !== "true"\) return;/);
});

test("usage table escapes account and school identifiers", async () => {
  const card = elementStub("solverInfrastructureCard");
  card.dataset.usageOnly = "true";
  const body = elementStub("solverAccountUsageBody");
  const status = elementStub("solverInfrastructureStatus");
  const window = {
    fetch:async () => ({
      ok:true,
      status:200,
      json:async () => ({
        ok:true,
        usage:{accountRequests:[{
          schoolId:'<img src=x onerror="school">',
          accountId:'<script>account<\/script>',
          totalRequests:1,
          cloudRun:{requests:1},
          vps:{requests:0}
        }]}
      })
    }),
    TKBAuthApi:{getAuthHeaders(){ return {}; }},
    setInterval(){ return 1; },
    clearInterval(){},
    addEventListener(){}
  };
  const document = {
    getElementById(id){
      return {
        solverInfrastructureCard:card,
        solverAccountUsageBody:body,
        solverInfrastructureStatus:status
      }[id] || null;
    }
  };
  window.window = window;
  window.document = document;
  const start = superSource.indexOf("function initSolverInfrastructureCard(){");
  const end = superSource.indexOf("\n  initSolverInfrastructureCard();", start);
  vm.runInNewContext(
    `${superSource.slice(start, end)}\ninitSolverInfrastructureCard();`,
    {window, document, console, Number, String, Object, Array, Math, JSON, Error},
    {filename:"solver-usage-card-escaping.js"}
  );
  await new Promise(resolve => setImmediate(resolve));

  assert.doesNotMatch(body.innerHTML, /<script>|<img/);
  assert.match(body.innerHTML, /&lt;script&gt;account&lt;\/script&gt;/);
  assert.match(body.innerHTML, /&lt;img src=x onerror=&quot;school&quot;&gt;/);
});
