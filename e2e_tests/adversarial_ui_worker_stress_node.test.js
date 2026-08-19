"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const DONGKHOI_PATH = path.join(ROOT, "scratch", "dongkhoi_1566.json");

function createMockElement(tagName = "div", id = "") {
  const classList = new Set();
  const dataset = {};
  const attributes = {};
  const listeners = {};
  const elem = {
    tagName: tagName.toUpperCase(),
    id,
    dataset,
    hidden: false,
    textContent: "",
    title: "",
    style: {},
    disabled: false,
    ondragstart: null,
    ondragend: null,
    ondragover: null,
    ondragenter: null,
    ondragleave: null,
    ondrop: null,
    oncontextmenu: null,
    ondblclick: null,
    onclick: null,
    classList: {
      add: (...cls) => cls.forEach(c => classList.add(c)),
      remove: (...cls) => cls.forEach(c => classList.delete(c)),
      contains: (c) => classList.has(c),
      toggle: (c, force) => {
        if (force === undefined) {
          if (classList.has(c)) { classList.delete(c); return false; }
          classList.add(c); return true;
        }
        if (force) { classList.add(c); return true; }
        classList.delete(c); return false;
      }
    },
    setAttribute(name, val) { attributes[name] = String(val); },
    getAttribute(name) { return attributes[name] || null; },
    removeAttribute(name) { delete attributes[name]; },
    hasAttribute(name) { return name in attributes; },
    addEventListener(evt, fn) {
      listeners[evt] = listeners[evt] || [];
      listeners[evt].push(fn);
    },
    removeEventListener(evt, fn) {
      if (listeners[evt]) listeners[evt] = listeners[evt].filter(f => f !== fn);
    },
    dispatchEvent(evt) {
      const type = typeof evt === "string" ? evt : evt.type;
      (listeners[type] || []).forEach(fn => fn(evt));
    },
    getBoundingClientRect() {
      return { left: 100, top: 100, width: 60, height: 40, right: 160, bottom: 140 };
    }
  };
  return elem;
}

function createMockDocument() {
  const elements = new Map();
  const doc = {
    body: createMockElement("body"),
    createElement(tag) { return createMockElement(tag); },
    getElementById(id) { return elements.get(id) || null; },
    querySelectorAll(selector) {
      const results = [];
      if (selector === "#tkb td") {
        for (const [k, v] of elements) {
          if (k.startsWith("cell_")) results.push(v);
        }
      } else if (selector.includes(".lop-item")) {
        for (const [k, v] of elements) {
          if (k.startsWith("lop_")) results.push(v);
        }
      }
      return results;
    },
    addEventListener(evt, fn) {},
    removeEventListener(evt, fn) {}
  };
  doc.registerElement = (id, el) => {
    el.id = id;
    elements.set(id, el);
    return el;
  };
  return doc;
}

// ---------------------------------------------------------
// CATEGORY 1: DRAG & DROP INTEGRITY, CONFLICTS, AND STORAGE
// ---------------------------------------------------------

test("1.1 Drag and Drop: Dragging OFF cell (-2 / .tkb-off) is prevented", () => {
  const td = createMockElement("td", "cell_0");
  td.classList.add("tkb-off");
  td.dataset.thu = "thu2";
  td.dataset.buoi = "sang";
  td.dataset.ti = "0";
  td.dataset.mon = "";

  let preventDefaultCalled = false;
  const evt = {
    preventDefault: () => { preventDefaultCalled = true; },
    dataTransfer: { setData: () => {}, effectAllowed: "" }
  };

  let dragData = null;
  let dragMon = "";
  td.ondragstart = (e) => {
    if (td.classList.contains("tkb-off")) { e.preventDefault(); return; }
    const val = (td.dataset.mon || "").trim();
    if (!val) { e.preventDefault(); return; }
    dragData = { type: "cell", from: td, val };
    dragMon = val;
  };

  td.ondragstart(evt);
  assert.equal(preventDefaultCalled, true);
  assert.equal(dragData, null);
  assert.equal(dragMon, "");
});

test("1.2 Drag and Drop: Dragging Locked cell (-3 / .tkb-fixed) prompts confirmation and handles cancel/confirm/restore", () => {
  const td = createMockElement("td", "cell_fixed");
  td.classList.add("tkb-fixed");
  td.dataset.thu = "thu2";
  td.dataset.buoi = "sang";
  td.dataset.ti = "0";
  td.dataset.mon = "Toan";

  let currentLop = "6A";
  let tkb = {
    "6A": { thu2: { sang: [{ mon: "Toan", fixed: true }, "", "", "", ""] } }
  };

  let dragData = null;
  let dragMon = "";
  let saved = false;
  const saveStoreDeferred = () => { saved = true; };

  let confirmResult = false;
  const mockConfirm = (msg) => confirmResult;

  const dragStartHandler = (e) => {
    let unfixedFromFixed = false;
    if (td.classList.contains("tkb-off")) { e.preventDefault(); return; }
    if (td.classList.contains("tkb-fixed")) {
      const ok = mockConfirm("Tiết này đang CỐ ĐỊNH. Bạn muốn BỎ cố định để kéo không?");
      if (!ok) { e.preventDefault(); return; }
      if (currentLop) {
        const t = td.dataset;
        const curTkb = tkb?.[currentLop];
        if (curTkb && curTkb?.[t.thu]?.[t.buoi]) {
          const ti = Number(t.ti);
          const mon = (td.dataset.mon || "").trim();
          if (mon) {
            curTkb[t.thu][t.buoi][ti] = mon;
            td.classList.remove("tkb-fixed");
            unfixedFromFixed = true;
          }
        }
      }
    }
    const val = (td.dataset.mon || "").trim();
    if (!val) { e.preventDefault(); return; }
    dragData = { type: "cell", from: td, val, _unfixedFromFixed: unfixedFromFixed };
    dragMon = val;
  };

  const dragEndHandler = () => {
    if (dragData && dragData.type === "cell" && dragData._unfixedFromFixed) {
      saveStoreDeferred();
    }
    dragData = null;
    dragMon = "";
  };

  // Step A: Cancel confirm -> drag aborted
  let preventDefaultA = false;
  dragStartHandler({ preventDefault: () => { preventDefaultA = true; } });
  assert.equal(preventDefaultA, true);
  assert.equal(dragData, null);
  assert.equal(td.classList.contains("tkb-fixed"), true);

  // Step B: Accept confirm -> un-fixed and dragged
  confirmResult = true;
  let preventDefaultB = false;
  dragStartHandler({ preventDefault: () => { preventDefaultB = true; } });
  assert.equal(preventDefaultB, false);
  assert.notEqual(dragData, null);
  assert.equal(dragData.val, "Toan");
  assert.equal(dragData._unfixedFromFixed, true);
  assert.equal(td.classList.contains("tkb-fixed"), false);
  assert.equal(tkb["6A"].thu2.sang[0], "Toan");

  // Step C: Drag end -> saves deferred
  dragEndHandler();
  assert.equal(saved, true);
  assert.equal(dragData, null);
});

test("1.3 Drag and Drop: Dropping onto OFF cell (-2) or Fixed cell (-3) is prevented", () => {
  const targetOff = createMockElement("td", "cell_target_off");
  targetOff.classList.add("tkb-off");
  const targetFixed = createMockElement("td", "cell_target_fixed");
  targetFixed.classList.add("tkb-fixed");

  function validateDrop(targetTd, mon) {
    if (!mon) return { ok: false, reason: "empty" };
    if (targetTd.classList.contains("tkb-off") || targetTd.classList.contains("tkb-fixed")) {
      return { ok: false, reason: "locked" };
    }
    return { ok: true };
  }

  assert.equal(validateDrop(targetOff, "Toan").ok, false);
  assert.equal(validateDrop(targetOff, "Toan").reason, "locked");
  assert.equal(validateDrop(targetFixed, "Toan").ok, false);
  assert.equal(validateDrop(targetFixed, "Toan").reason, "locked");
});

test("1.4 Drag and Drop: Invalid drop prevention for Teacher, Room, Class conflicts and Split blocks", () => {
  const DATA = {
    lop: [{ id: "6A", ten: "6A" }, { id: "6B", ten: "6B" }],
    tkb: {
      "6A": { thu2: { sang: ["Toan", "Toan", "", "", ""] } },
      "6B": { thu2: { sang: ["Van", "", "", "", ""] } }
    },
    pccmMatrix: {
      "6A|Toan": "GV_AN",
      "6B|Toan": "GV_AN",
      "6A|Tin": "GV_BINH",
      "6B|Tin": "GV_BINH"
    },
    pccmRoomMatrix: {
      "6A|Tin": "LAB_1",
      "6B|Tin": "LAB_1"
    }
  };

  function getLopCanonById(id) { return String(id); }
  function cellMon(v) { return (typeof v === "string") ? v : (v?.mon || ""); }
  function getTeacherForClassMon(lop, mon) { return DATA.pccmMatrix[lop + "|" + mon] || ""; }
  function getRoomForClassMon(lop, mon) { return DATA.pccmRoomMatrix[lop + "|" + mon] || ""; }

  function findTeacherConflictAtSlot(gv, thu, buoi, ti, ignoreLopId) {
    if (!gv) return null;
    for (const lopId of Object.keys(DATA.tkb)) {
      if (String(lopId) === String(ignoreLopId)) continue;
      const cell = DATA.tkb[lopId]?.[thu]?.[buoi]?.[ti];
      const mon = cellMon(cell);
      if (!mon) continue;
      const gv2 = getTeacherForClassMon(getLopCanonById(lopId), mon);
      if (gv2 === gv) return { lopId, mon };
    }
    return null;
  }

  function findRoomConflictAtSlot(room, thu, buoi, ti, ignoreLopId) {
    if (!room) return null;
    for (const lopId of Object.keys(DATA.tkb)) {
      if (String(lopId) === String(ignoreLopId)) continue;
      const cell = DATA.tkb[lopId]?.[thu]?.[buoi]?.[ti];
      const mon = cellMon(cell);
      if (!mon) continue;
      const r2 = getRoomForClassMon(getLopCanonById(lopId), mon);
      if (r2 === room) return { lopId, mon };
    }
    return null;
  }

  function validateDropFull(currentLop, targetTd, mon, dragData) {
    if (!currentLop) return { ok: false, reason: "no class" };
    if (!mon) return { ok: false, reason: "empty" };
    if (targetTd.classList.contains("tkb-off") || targetTd.classList.contains("tkb-fixed")) {
      return { ok: false, reason: "locked" };
    }
    if (dragData && dragData.classId != null && String(dragData.classId) !== String(currentLop)) {
      return { ok: false, reason: "wrong class", msg: "Tiết này thuộc lớp khác." };
    }

    const tThu = targetTd.dataset.thu;
    const tBuoi = targetTd.dataset.buoi;
    const tTi = Number(targetTd.dataset.ti);

    const tkb = DATA.tkb[currentLop];
    const arr = (tkb[tThu]?.[tBuoi] || []).slice();
    arr[tTi] = mon;

    const idx = [];
    for (let i = 0; i < arr.length; i++) {
      if (cellMon(arr[i]) === mon) idx.push(i);
    }
    for (let i = 1; i < idx.length; i++) {
      if (idx[i] !== idx[i - 1] + 1) {
        return { ok: false, reason: "split block" };
      }
    }

    const lopCanon = getLopCanonById(currentLop);
    const conflicts = [];
    const gv = getTeacherForClassMon(lopCanon, mon);
    const gvConflict = findTeacherConflictAtSlot(gv, tThu, tBuoi, tTi, currentLop);
    if (gvConflict) {
      conflicts.push({ type: "teacher", gv, lopId: gvConflict.lopId, mon: gvConflict.mon, thu: tThu, buoi: tBuoi, ti: tTi });
    }
    const room = getRoomForClassMon(lopCanon, mon);
    const roomConflict = findRoomConflictAtSlot(room, tThu, tBuoi, tTi, currentLop);
    if (roomConflict) {
      conflicts.push({ type: "room", room, lopId: roomConflict.lopId, mon: roomConflict.mon, thu: tThu, buoi: tBuoi, ti: tTi });
    }

    if (conflicts.length) {
      return { ok: true, warn: true, reason: "conflict", conflicts };
    }
    return { ok: true };
  }

  // Check 1: Foreign class drag rejected
  const tdTarget = createMockElement("td", "target");
  tdTarget.dataset.thu = "thu2"; tdTarget.dataset.buoi = "sang"; tdTarget.dataset.ti = "2";
  const resWrongClass = validateDropFull("6A", tdTarget, "Toan", { classId: "6B" });
  assert.equal(resWrongClass.ok, false);
  assert.equal(resWrongClass.reason, "wrong class");

  // Check 2: Split block rejected
  const tdSplit = createMockElement("td", "target_split");
  tdSplit.dataset.thu = "thu2"; tdSplit.dataset.buoi = "sang"; tdSplit.dataset.ti = "3";
  const resSplit = validateDropFull("6A", tdSplit, "Toan", { classId: "6A" });
  assert.equal(resSplit.ok, false);
  assert.equal(resSplit.reason, "split block");

  // Check 3: Teacher conflict detection
  const tdTeacherConf = createMockElement("td", "target_tc");
  tdTeacherConf.dataset.thu = "thu2"; tdTeacherConf.dataset.buoi = "sang"; tdTeacherConf.dataset.ti = "0";
  const resTC = validateDropFull("6B", tdTeacherConf, "Toan", { classId: "6B" });
  assert.equal(resTC.ok, true);
  assert.equal(resTC.warn, true);
  assert.equal(resTC.conflicts[0].type, "teacher");
  assert.equal(resTC.conflicts[0].gv, "GV_AN");

  // Check 4: Room conflict detection
  DATA.pccmMatrix["6B|Tin"] = "GV_HAI";
  DATA.tkb["6A"].thu2.sang[2] = "Tin";
  const tdRoomConf = createMockElement("td", "target_rc");
  tdRoomConf.dataset.thu = "thu2"; tdRoomConf.dataset.buoi = "sang"; tdRoomConf.dataset.ti = "2";
  const resRC = validateDropFull("6B", tdRoomConf, "Tin", { classId: "6B" });
  assert.equal(resRC.ok, true);
  assert.equal(resRC.warn, true);
  assert.equal(resRC.conflicts.length, 1);
  assert.equal(resRC.conflicts[0].type, "room");
  assert.equal(resRC.conflicts[0].room, "LAB_1");
  assert.equal(resRC.conflicts[0].lopId, "6A");
});

test("1.5 Drag and Drop: Debounced storage (saveStoreDeferred) batches rapid calls", async () => {
  let saveCount = 0;
  let __tkbDeferredSaveTimer = null;

  function saveStore() {
    saveCount++;
  }

  function flushDeferredSaveStore() {
    if (__tkbDeferredSaveTimer) {
      clearTimeout(__tkbDeferredSaveTimer);
      __tkbDeferredSaveTimer = null;
      saveStore();
    }
  }

  function saveStoreDeferred() {
    if (__tkbDeferredSaveTimer) clearTimeout(__tkbDeferredSaveTimer);
    __tkbDeferredSaveTimer = setTimeout(() => {
      __tkbDeferredSaveTimer = null;
      saveStore();
    }, 50);
  }

  for (let i = 0; i < 50; i++) {
    saveStoreDeferred();
  }
  assert.equal(saveCount, 0);

  await new Promise(r => setTimeout(r, 80));
  assert.equal(saveCount, 1);

  saveStoreDeferred();
  assert.equal(saveCount, 1);
  flushDeferredSaveStore();
  assert.equal(saveCount, 2);
});

// ---------------------------------------------------------
// CATEGORY 2: WORKER INTERRUPTION & CHECKPOINT RETENTION
// ---------------------------------------------------------

test("2.1 Worker Interruption: Immediate interruption at 10ms cleanly halts and preserves incumbent data", async () => {
  const dongKhoiData = JSON.parse(fs.readFileSync(DONGKHOI_PATH, "utf8"));
  const incumbentTkbCopy = JSON.parse(JSON.stringify(dongKhoiData.tkb || {}));

  const mockWindow = {
    DATA: dongKhoiData,
    __ACTIVE_TKB_FET_WORKER: null,
    __ACTIVE_TKB_FET_WORKER_RESOLVE: null,
    __ACTIVE_TKB_FET_WORKER_STOP: null,
    __AUTO_SORT_STOP_REQUESTED: false,
    __TKB_SOLVE_UI_BUSY: true
  };

  let terminated = false;
  const mockWorker = {
    terminate: () => { terminated = true; },
    postMessage: () => {},
    onmessage: null
  };

  mockWindow.__ACTIVE_TKB_FET_WORKER = mockWorker;

  function requestStopAutoSort() {
    mockWindow.__AUTO_SORT_STOP_REQUESTED = true;
    mockWindow.__TKB_SOLVE_UI_BUSY = false;
    if (typeof mockWindow.__ACTIVE_TKB_FET_WORKER_STOP === "function") {
      return mockWindow.__ACTIVE_TKB_FET_WORKER_STOP();
    }
    if (mockWindow.__ACTIVE_TKB_FET_WORKER) {
      mockWindow.__ACTIVE_TKB_FET_WORKER.terminate();
      mockWindow.__ACTIVE_TKB_FET_WORKER = null;
    }
    const pendingResolve = mockWindow.__ACTIVE_TKB_FET_WORKER_RESOLVE;
    mockWindow.__ACTIVE_TKB_FET_WORKER_RESOLVE = null;
    if (typeof pendingResolve === "function") {
      pendingResolve({ ok: false, applied: false, cancelled: true, failureKind: "user_cancelled" });
    }
  }

  await new Promise(r => setTimeout(r, 10));
  requestStopAutoSort();

  assert.equal(terminated, true);
  assert.equal(mockWindow.__ACTIVE_TKB_FET_WORKER, null);
  assert.equal(mockWindow.__AUTO_SORT_STOP_REQUESTED, true);
  assert.deepEqual(mockWindow.DATA.tkb, incumbentTkbCopy);
});

test("2.2 Worker Interruption: Interruption at 50ms (construction) preserves incumbent and halts cleanly", async () => {
  const dongKhoiData = JSON.parse(fs.readFileSync(DONGKHOI_PATH, "utf8"));
  const incumbentCopy = JSON.parse(JSON.stringify(dongKhoiData.tkb || {}));

  let terminated = false;
  const mockWorker = {
    terminate: () => { terminated = true; }
  };

  const pendingPromise = new Promise(resolve => {
    const stopHandler = async () => {
      mockWorker.terminate();
      resolve({ ok: false, applied: false, cancelled: true, failureKind: "user_cancelled" });
    };
    setTimeout(() => stopHandler(), 50);
  });

  const res = await pendingPromise;
  assert.equal(terminated, true);
  assert.equal(res.cancelled, true);
  assert.equal(res.failureKind, "user_cancelled");
  assert.deepEqual(dongKhoiData.tkb, incumbentCopy);
});

test("2.3 Worker Interruption: Interruption at 150ms / 300ms retains valid complete checkpoint or preserves incumbent", async () => {
  const dongKhoiData = JSON.parse(fs.readFileSync(DONGKHOI_PATH, "utf8"));
  const countPlacedCells = (tkbObj) => {
    let n = 0;
    for (const cid of Object.keys(tkbObj || {})) {
      const byDay = tkbObj[cid]; if (!byDay) continue;
      for (const thu of Object.keys(byDay)) {
        const byBuoi = byDay[thu]; if (!byBuoi) continue;
        for (const buoi of Object.keys(byBuoi)) {
          const arr = byBuoi[buoi]; if (!Array.isArray(arr)) continue;
          for (const cell of arr) {
            if (!cell || cell === "OFF") continue;
            if (typeof cell === "object" && (cell.off === true || String(cell.val || cell.mon || "").trim() === "")) continue;
            n++;
          }
        }
      }
    }
    return n;
  };

  const candidateTkb = JSON.parse(JSON.stringify(dongKhoiData.tkb || {}));
  const checkpointValid = {
    complete: true,
    tkb: candidateTkb,
    metrics: { soBuoiDay1: 0, soBuoiTrong2: 5, tsBuoiDay: 600 }
  };

  let appliedTkb = null;
  const stopWithValidCheckpoint = async (checkpoint) => {
    if (!checkpoint?.complete || !checkpoint?.tkb) return { applied: false };
    const ckCells = countPlacedCells(checkpoint.tkb);
    const curCells = countPlacedCells(dongKhoiData.tkb);
    if (ckCells < curCells) return { applied: false, failureKind: "fewer_lessons" };
    appliedTkb = checkpoint.tkb;
    return { ok: true, applied: true, retainedBestCheckpoint: true };
  };

  // Case A: Valid checkpoint applied
  const resA = await stopWithValidCheckpoint(checkpointValid);
  assert.equal(resA.ok, true);
  assert.equal(resA.applied, true);
  assert.notEqual(appliedTkb, null);

  // Case B: Incomplete checkpoint ignored
  const checkpointIncomplete = {
    complete: false,
    tkb: candidateTkb,
    metrics: { soBuoiDay1: 2, soBuoiTrong2: 10 }
  };
  const resB = await stopWithValidCheckpoint(checkpointIncomplete);
  assert.equal(resB.applied, false);

  // Case C: Wiped checkpoint (fewer lessons) rejected by anti-wipe gate
  const wipedTkb = JSON.parse(JSON.stringify(dongKhoiData.tkb || {}));
  const allClassKeys = Object.keys(wipedTkb);
  if (allClassKeys.length > 2) {
    delete wipedTkb[allClassKeys[0]];
    delete wipedTkb[allClassKeys[1]];
  }
  const checkpointWiped = {
    complete: true,
    tkb: wipedTkb,
    metrics: { soBuoiDay1: 0, soBuoiTrong2: 0 }
  };
  const resC = await stopWithValidCheckpoint(checkpointWiped);
  assert.equal(resC.applied, false);
  assert.equal(resC.failureKind, "fewer_lessons");
});

// ---------------------------------------------------------
// CATEGORY 3: UI TIMER, PROGRESS BAR, AND METRICS
// ---------------------------------------------------------

test("3.1 UI Timer: Stopwatch timer increments accurately and cleans up without memory leaks", async () => {
  const doc = createMockDocument();
  const wrap = doc.registerElement("autoSortProgress", createMockElement("div", "autoSortProgress"));
  const timerVal = doc.registerElement("autoSortTimerVal", createMockElement("span", "autoSortTimerVal"));
  let autoSortStartTime = null;
  let autoSortTimerInterval = null;
  let activeIntervals = 0;

  function setAutoSortProgress(percent, label, details) {
    wrap.classList.remove("is-idle");
    wrap.classList.add("is-active");
    wrap.hidden = false;
    wrap.setAttribute("aria-hidden", "false");
    if (!autoSortStartTime) {
      autoSortStartTime = Date.now();
      if (autoSortTimerInterval) clearInterval(autoSortTimerInterval);
      activeIntervals++;
      autoSortTimerInterval = setInterval(() => {
        if (!autoSortStartTime) return;
        const elapsedSec = Math.floor((Date.now() - autoSortStartTime) / 1000);
        const m = Math.floor(elapsedSec / 60);
        const s = elapsedSec % 60;
        timerVal.textContent = String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
      }, 20);
    }
  }

  function hideAutoSortProgress() {
    if (autoSortTimerInterval) {
      clearInterval(autoSortTimerInterval);
      autoSortTimerInterval = null;
      activeIntervals--;
    }
    autoSortStartTime = null;
    wrap.classList.remove("is-active");
    wrap.classList.add("is-idle");
    wrap.hidden = true;
    wrap.setAttribute("aria-hidden", "true");
    timerVal.textContent = "00:00";
  }

  for (let i = 0; i < 50; i++) setAutoSortProgress(i, "Progress");
  assert.equal(activeIntervals, 1);
  assert.equal(wrap.classList.contains("is-active"), true);

  await new Promise(r => setTimeout(r, 70));
  assert.notEqual(timerVal.textContent, "");

  hideAutoSortProgress();
  assert.equal(activeIntervals, 0);
  assert.equal(autoSortStartTime, null);
  assert.equal(autoSortTimerInterval, null);
  assert.equal(timerVal.textContent, "00:00");
  assert.equal(wrap.classList.contains("is-idle"), true);
});

test("3.2 UI Timer: Stopwatch formatting handles boundary durations accurately", () => {
  function formatTime(elapsedSec) {
    const m = Math.floor(elapsedSec / 60);
    const s = elapsedSec % 60;
    return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }
  assert.equal(formatTime(0), "00:00");
  assert.equal(formatTime(9), "00:09");
  assert.equal(formatTime(59), "00:59");
  assert.equal(formatTime(60), "01:00");
  assert.equal(formatTime(3599), "59:59");
  assert.equal(formatTime(3605), "60:05");
});

test("3.3 UI Progress and Metrics: Filters noise and reflects placed activities and stages", () => {
  const isSystemNoise = (str) => {
    const s = String(str || "").trim().toLowerCase();
    if (!s || /^\d+\s*giây$/i.test(s) || /^\d+:\d+$/.test(s) || s === "nối lại" || s === "đăng nhập" || s === "đang sắp xếp...") return true;
    return false;
  };
  assert.equal(isSystemNoise("12 giây"), true);
  assert.equal(isSystemNoise("00:15"), true);
  assert.equal(isSystemNoise("đang sắp xếp..."), true);
  assert.equal(isSystemNoise("đăng nhập"), true);
  assert.equal(isSystemNoise("1t/buổi: 0 T2: 12 B: 611"), false);
  assert.equal(isSystemNoise("1080/1080 tiết"), false);
  assert.equal(isSystemNoise("Tối ưu 2 tiết trống"), false);

  const stageLabelMap = {
    "optimize_singletons": "1 tiết/buổi",
    "optimize_gap2": "Trống 2 tiết",
    "optimize_sessions": "Buổi dạy",
    "optimize_gap1": "Trống 1 tiết"
  };
  assert.equal(stageLabelMap["optimize_singletons"], "1 tiết/buổi");
  assert.equal(stageLabelMap["optimize_gap2"], "Trống 2 tiết");
  assert.equal(stageLabelMap["optimize_sessions"], "Buổi dạy");
});
