"use strict";

// 30/10: ban web khong dang nhap (Netlify) co nut gat Cherry.exe / May chu (chu du an: "mac dinh
// local thi bam Cherry chay = Cherry.exe, tat di thi chay ve cloud run"). shared/auth-local.js:
// mac dinh TKBAuth.noServer = true; chi khi gat May chu VA dang nhap tkbcherry.com thi cac duong
// giai di ra mang (Netlify chuyen tiep) kem the Bearer. Kho truong LUON o trinh duyet.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const SRC = fs.readFileSync(
  path.resolve(__dirname, "..", "tools", "netlify-local", "overlay", "shared", "auth-local.js"), "utf8");

function load({serverReply} = {}){
  const values = new Map();
  const localStorage = {
    getItem(k){ return values.has(k) ? values.get(k) : null; },
    setItem(k, v){ values.set(k, String(v)); },
    removeItem(k){ values.delete(k); }
  };
  const calls = [];
  const events = [];
  const origFetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({url, method:String(init?.method || "GET"), headers:init?.headers || {}, body:init?.body});
    const reply = serverReply ? serverReply(url, init) : {status:200, body:{ok:true, api:"rust"}};
    return new Response(JSON.stringify(reply.body), {status:reply.status, headers:{"Content-Type":"application/json"}});
  };
  const window = {
    fetch:origFetch,
    localStorage,
    location:{href:"https://tkbcherry.netlify.app/pages/sapxep.html", origin:"https://tkbcherry.netlify.app"},
    dispatchEvent(evt){ events.push(evt); return true; }
  };
  const context = vm.createContext({
    window, localStorage, location:window.location, URL, Response, CustomEvent, JSON, console,
    setTimeout, clearTimeout
  });
  vm.runInContext(SRC, context, {filename:"auth-local.js"});
  const api = window.__cherryServerMode;
  const fetchJson = async (url, init) => {
    const res = await window.fetch(url, init);
    return {status:res.status, body:await res.json()};
  };
  return {window, api, calls, events, values, fetchJson};
}

const loginOk = (url) => url === "/api/auth/login"
  ? {status:200, body:{ok:true, sessionToken:"tok-123", role:"superadmin", user:{displayName:"An"}}}
  : {status:200, body:{ok:true, api:"rust"}};

test("mặc định: không có máy chủ, mọi /api/* trả lời tại chỗ, không gửi thẻ", async () => {
  const {window, calls, fetchJson} = load();
  assert.equal(window.TKBAuth.noServer, true);
  assert.equal(window.TKBAuth.serverSwitch, true);
  const health = await fetchJson("/api/health");
  assert.equal(health.body.api, "browser-store");
  const solve = await fetchJson("/api/solve-data", {method:"POST", body:"{}"});
  assert.equal(solve.status, 404);
  assert.equal(calls.length, 0, "không có gì ra mạng");
  assert.equal(window.TKBAuthApi.getAuthHeaders({}).Authorization, undefined);
});

test("gạt Máy chủ nhưng chưa đăng nhập: vẫn xếp trên máy này", async () => {
  const {window, api, calls, fetchJson} = load();
  api.setMode("server");
  assert.equal(api.wanted(), true);
  assert.equal(api.active(), false);
  assert.equal(window.TKBAuth.noServer, true);
  await fetchJson("/api/solve-data", {method:"POST", body:"{}"});
  assert.equal(calls.length, 0);
});

test("đăng nhập + gạt Máy chủ: đường giải ra mạng kèm Bearer; kho trường vẫn tại chỗ", async () => {
  const {window, api, calls, events, fetchJson} = load({serverReply:loginOk});
  const res = await api.login(" an ", "pw");
  assert.equal(res.ok, true);
  assert.equal(calls[0].url, "/api/auth/login");
  assert.deepEqual(JSON.parse(calls[0].body), {loginId:"an", password:"pw"});
  assert.equal(api.session().token, "tok-123");
  assert.equal(window.TKBAuth.noServer, true, "chưa gạt thì vẫn máy này");

  assert.equal(api.setMode("server"), "server");
  assert.equal(window.TKBAuth.noServer, false);
  assert.ok(events.some(e => e.type === "cherry:solver-mode"));
  assert.equal(window.TKBAuthApi.getAuthHeaders({"Content-Type":"application/json"}).Authorization, "Bearer tok-123");
  assert.equal(window.TKBAuthApi.getSessionToken(), "tok-123");

  const before = calls.length;
  const health = await fetchJson("/api/health");
  assert.equal(health.body.api, "rust", "health đi qua Netlify sang máy chủ");
  await fetchJson("/api/solve-data", {method:"POST", body:"{}"});
  await fetchJson("/api/solve-result?jobId=abc");
  assert.deepEqual(calls.slice(before).map(c => c.url), ["/api/health", "/api/solve-data", "/api/solve-result?jobId=abc"]);

  const n = calls.length;
  const store = await fetchJson("/api/school/store?id=kkhg52etp93", {method:"POST", body:JSON.stringify({lop:[]})});
  assert.equal(store.body.ok, true);
  await fetchJson("/api/local/schools");
  await fetchJson("/api/auth/registry");
  assert.equal(calls.length, n, "kho trường / registry KHÔNG BAO GIỜ ra mạng");

  api.setMode("local");
  assert.equal(window.TKBAuth.noServer, true);
  assert.equal(window.TKBAuthApi.getAuthHeaders({}).Authorization, undefined, "máy này không gửi thẻ");
  assert.equal(api.session().token, "tok-123", "gạt về máy này vẫn giữ phiên để gạt lại");
});

test("máy chủ trả 401: bỏ phiên, về máy này, báo trang", async () => {
  const {window, api, events, fetchJson} = load({serverReply:(url) => url === "/api/auth/login"
    ? loginOk(url)
    : {status:401, body:{ok:false, error:"unauthorized"}}});
  await api.login("an", "pw");
  api.setMode("server");
  const res = await fetchJson("/api/solve-data", {method:"POST", body:"{}"});
  assert.equal(res.status, 401);
  assert.equal(api.session(), null);
  assert.equal(api.wanted(), false);
  assert.equal(window.TKBAuth.noServer, true);
  assert.ok(events.some(e => e.type === "cherry:solver-mode" && e.detail.reason === "expired"));
});

test("đăng nhập sai: báo lỗi của máy chủ, không lưu phiên", async () => {
  const {api} = load({serverReply:() => ({status:401, body:{ok:false, message:"Sai mật khẩu."}})});
  const res = await api.login("an", "x");
  assert.equal(res.ok, false);
  assert.equal(res.message, "Sai mật khẩu.");
  assert.equal(api.session(), null);
  const empty = await api.login("", "");
  assert.equal(empty.ok, false);
});

test("đăng xuất: gọi /api/auth/logout với thẻ cũ, bỏ phiên, về máy này", async () => {
  const {window, api, calls} = load({serverReply:loginOk});
  await api.login("an", "pw");
  api.setMode("server");
  await api.logout();
  const last = calls[calls.length - 1];
  assert.equal(last.url, "/api/auth/logout");
  assert.equal(last.headers.Authorization, "Bearer tok-123");
  assert.equal(api.session(), null);
  assert.equal(window.TKBAuth.noServer, true);
});
