"use strict";

// 31/08: BỘ CHẶN GHI ĐÈ KHO trong web/shared/storage.js (remoteSaveGuard).
// Bối cảnh: trang Sắp xếp mở đúng lúc máy chủ trả 503 → loadRemoteSchoolDataSync trả null → DATA = {}
// → planner vẫn lưu ngay khi mở → kho trường fiwemj2uyk1 (81 GV, 1266 tiết đã xếp) bị ghi rỗng.
// Test khoá: (1) nạp thất bại → không POST gì nữa; (2) kho đang có dữ liệu → bản trống bị từ chối,
// bản có dữ liệu vẫn lưu; (3) kho trống ("ok-empty") → lưu được cả bản trống lẫn bản có dữ liệu;
// (4) chưa nạp bao giờ → bản trống bị từ chối, bản có dữ liệu được phép; (5) phanmon.js gọi guard
// trước nhánh XHR đồng bộ (nhánh này không đi qua saveRemoteSchoolData).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const STORAGE_SRC = fs.readFileSync(path.resolve(__dirname, "..", "web", "shared", "storage.js"), "utf8");
const PHANMON_SRC = fs.readFileSync(path.resolve(__dirname, "..", "web", "pages", "phanmon.js"), "utf8");

const FULL = JSON.stringify({ lop: [{ id: "L001", ten: "6/1" }], giaovien: [{ magv: "TO.A" }], pccmMatrix: { "6/1|Toán": "TO.A" } });
const EMPTY = JSON.stringify({ _lastModified: 1, lop: [], mon: [], tkb: {}, tkbConstraints: { fixedOff: { teacher: {} } } });

// Môi trường giả: window/localStorage/document tối thiểu + fetch/XHR có thể lập trình từng lần gọi.
function load(){
  const calls = { get: [], post: [], banner: [] };
  const script = { getStatus: 200, getBody: "{}", getThrow: false, postStatus: 200, postThrow: false };
  const storage = new Map();
  const localStorage = {
    get length(){ return storage.size; },
    key(i){ return Array.from(storage.keys())[i] ?? null; },
    getItem(k){ return storage.has(k) ? storage.get(k) : null; },
    setItem(k, v){ storage.set(k, String(v)); },
    removeItem(k){ storage.delete(k); }
  };
  class XMLHttpRequest {
    open(method, url){ this.method = method; this.url = url; }
    setRequestHeader(){}
    send(){
      if(this.method === "GET"){
        calls.get.push(this.url);
        if(script.getThrow) throw new Error("network down");
        this.status = script.getStatus; this.responseText = script.getBody;
      }
    }
  }
  async function fetch(url, opts){
    const method = (opts && opts.method) || "GET";
    if(method === "POST"){
      calls.post.push({ url, body: opts.body });
      if(script.postThrow) throw new Error("network down");
      return { ok: script.postStatus >= 200 && script.postStatus < 300, status: script.postStatus, clone(){ return this; }, async json(){ return {}; } };
    }
    calls.get.push(url);
    if(script.getThrow) throw new Error("network down");
    const status = script.getStatus;
    return { ok: status >= 200 && status < 300, status, clone(){ return this; }, async json(){ return JSON.parse(script.getBody); } };
  }
  const el = () => ({ style: {}, children: [], setAttribute(){}, appendChild(c){ this.children.push(c); }, addEventListener(){}, querySelector(){ return { set textContent(v){ calls.banner.push(v); } }; } });
  const document = { body: el(), getElementById(){ return null; }, createElement(){ return el(); } };
  const window = { addEventListener(){}, dispatchEvent(){} };
  const ctx = {
    window, document, localStorage, fetch, XMLHttpRequest, console: { warn(){}, log(){}, error(){} },
    setTimeout, clearTimeout, AbortController, JSON, Object, Array, String, Number, Map, Set, Promise, Error, location: { pathname: "/pages/sapxep", search: "?sid=x" }
  };
  vm.createContext(ctx);
  vm.runInContext(STORAGE_SRC, ctx, { filename: "storage.js" });
  return { S: window.TKBStorage, window, calls, script };
}

test("nạp đồng bộ 503 → trạng thái failed → MỌI lần lưu bị chặn, không POST", async () => {
  const { S, window, calls, script } = load();
  script.getStatus = 503; script.getBody = "";
  assert.equal(S.loadRemoteSchoolDataSync("abc"), null);
  assert.equal(S.remoteLoadStateOf("abc"), "failed");
  assert.equal(await S.saveRemoteSchoolData("abc", EMPTY), false, "bản trống bị chặn");
  assert.equal(await S.saveRemoteSchoolData("abc", FULL), false, "bản có dữ liệu cũng bị chặn: không biết máy chủ đang giữ gì");
  assert.equal(calls.post.length, 0, "không được POST");
  assert.equal(window.TKBStorage_lastSaveError.kind, "remote_load_failed_guard");
  assert.ok(calls.banner.length >= 1, "phải hiện băng-rôn báo người dùng");
  assert.equal(S.remoteSaveGuard("abc", FULL).ok, false);
});

test("nạp được kho CÓ dữ liệu → bản trống bị chặn, bản có dữ liệu lưu bình thường", async () => {
  const { S, window, calls, script } = load();
  script.getBody = FULL;
  const data = S.loadRemoteSchoolDataSync("abc");
  assert.equal(data.lop.length, 1);
  assert.equal(S.remoteLoadStateOf("abc"), "ok");
  assert.equal(await S.saveRemoteSchoolData("abc", EMPTY), false);
  assert.equal(window.TKBStorage_lastSaveError.kind, "empty_payload_guard");
  assert.equal(calls.post.length, 0);
  assert.equal(await S.saveRemoteSchoolData("abc", FULL), true);
  assert.equal(calls.post.length, 1);
  assert.equal(window.TKBStorage_lastSaveError, null);
});

test("kho trống trên máy chủ (trường mới) → lưu được cả bản trống lẫn bản có dữ liệu; sau khi lưu có dữ liệu thì bản trống bị chặn", async () => {
  const { S, calls, script } = load();
  script.getBody = "{}";
  assert.equal(JSON.stringify(S.loadRemoteSchoolDataSync("moi")), "{}");
  assert.equal(S.remoteLoadStateOf("moi"), "ok-empty");
  assert.equal(await S.saveRemoteSchoolData("moi", EMPTY), true);
  assert.equal(await S.saveRemoteSchoolData("moi", FULL), true);
  assert.equal(S.remoteLoadStateOf("moi"), "ok", "sau khi lưu bản có dữ liệu, trạng thái chuyển sang ok");
  assert.equal(await S.saveRemoteSchoolData("moi", EMPTY), false, "giờ kho đã có dữ liệu → bản trống bị chặn");
  assert.equal(calls.post.length, 2);
});

test("chưa nạp bao giờ trong phiên → bản trống bị chặn, bản có dữ liệu được phép", async () => {
  const { S, calls } = load();
  assert.equal(S.remoteLoadStateOf("chua"), "");
  assert.equal(await S.saveRemoteSchoolData("chua", EMPTY), false);
  assert.equal(calls.post.length, 0);
  assert.equal(await S.saveRemoteSchoolData("chua", FULL), true);
  assert.equal(calls.post.length, 1);
});

test("nạp async: 200 có dữ liệu → ok; mất mạng → failed; 401 → failed", async () => {
  const a = load(); a.script.getBody = FULL;
  assert.equal((await a.S.loadRemoteSchoolData("abc")).lop.length, 1);
  assert.equal(a.S.remoteLoadStateOf("abc"), "ok");
  const b = load(); b.script.getThrow = true;
  assert.equal(await b.S.loadRemoteSchoolData("abc"), null);
  assert.equal(b.S.remoteLoadStateOf("abc"), "failed");
  const c = load(); c.script.getStatus = 401; c.script.getBody = JSON.stringify({ error: "unauthorized" });
  assert.equal(await c.S.loadRemoteSchoolData("abc"), null);
  assert.equal(c.S.remoteLoadStateOf("abc"), "failed");
  assert.equal(await c.S.saveRemoteSchoolData("abc", FULL), false);
  assert.equal(c.calls.post.length, 0);
});

test("loadSchoolData (đường app.js) qua nạp thất bại → trả data rỗng nhưng saveSchoolData sau đó bị chặn", async () => {
  const { S, calls, script } = load();
  script.getStatus = 503; script.getBody = "";
  const loaded = await S.loadSchoolData("abc", "tkb_abc");
  assert.equal(JSON.stringify(loaded.data), "{}", "khác realm vm -> so bằng JSON");
  assert.equal(await S.saveSchoolData(null, "abc", EMPTY), false);
  assert.equal(await S.saveSchoolData(null, "abc", FULL), false);
  assert.equal(calls.post.length, 0);
});

test("phanmon.js: cờ nạp thất bại + guard đứng TRƯỚC nhánh XHR đồng bộ trong saveStore", () => {
  const preload = PHANMON_SRC.indexOf('console.warn("Remote store preload failed", e);');
  const flag = PHANMON_SRC.indexOf("const __TKB_REMOTE_LOAD_FAILED");
  assert.ok(preload > 0 && flag > preload, "cờ __TKB_REMOTE_LOAD_FAILED phải nằm ngay sau khối preload");
  const saveStart = PHANMON_SRC.indexOf("function saveStore(options){");
  const guardAt = PHANMON_SRC.indexOf("window.TKBStorage.remoteSaveGuard(schoolParam, payload)", saveStart);
  const syncAt = PHANMON_SRC.indexOf('xhr.open("POST", url, false);', saveStart);
  assert.ok(saveStart > 0 && guardAt > saveStart && syncAt > guardAt, "guard phải chạy trước xhr.open(POST) đồng bộ");
  const exportBlock = STORAGE_SRC.slice(STORAGE_SRC.indexOf("  window.TKBStorage = {"));
  for(const name of ["remoteLoadStateOf", "remoteSaveGuard", "showStoreGuardBanner"]){
    assert.ok(exportBlock.includes(name + ","), name + " phải được xuất trong window.TKBStorage");
  }
});
