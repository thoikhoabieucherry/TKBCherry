// Khoa hanh vi cua cong bo-qua vong quet rang buoc truoc khi xep (20/08).
// Vong validateAll() dong bo ngon ~3,9 giay tren truong 75 lop va khoa cung
// luong chinh -> chinh la "khung khi bat dau". No CHI dung de nhat vi pham o
// co dinh; ma fixedOff.teacher / fixedOff.class thi da duoc tha ra trong chinh
// ham do. Nen chi con can quet du khi truong co fixedOff cho PHONG / MON /
// NHOM MON. Test nay giu dung ranh gioi do.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '../..');
const noop = () => {};
const mkEl = () => {
  const el = {
    style: { setProperty: noop, removeProperty: noop },
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    dataset: {}, children: [], attributes: {},
    appendChild: c => { el.children.push(c); return c; }, removeChild: noop,
    insertBefore: c => c, remove: noop, setAttribute: noop, getAttribute: () => null,
    removeAttribute: noop, addEventListener: noop, removeEventListener: noop,
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    focus: noop, click: noop, textContent: '', innerHTML: '', value: '', hidden: false,
  };
  return el;
};
const store = new Map();
const sandbox = {
  document: {
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: noop, removeEventListener: noop,
    body: mkEl(), head: mkEl(), documentElement: mkEl(),
    createElement: () => mkEl(), createTextNode: () => mkEl(), createDocumentFragment: () => mkEl(),
    visibilityState: 'visible',
  },
  navigator: { userAgent: 'node', maxTouchPoints: 0 },
  location: { href: 'https://tkbcherry.com/pages/sapxep', search: '', origin: 'https://tkbcherry.com', pathname: '/pages/sapxep' },
  localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k), key: () => null, get length() { return store.size; } },
  sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  Promise, JSON, Math, Date, Object, Array, String, Number, Boolean, Map, Set, WeakMap, WeakSet,
  Error, RegExp, isNaN, parseInt, parseFloat, console: { log: noop, warn: noop, error: noop },
  performance: { now: () => Date.now() },
  TextEncoder, TextDecoder, URL, URLSearchParams,
};
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
sandbox.window.__TKB_E2E_EXPOSE_TEST_HOOKS = true;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'web/pages/tkb-rust-bridge.js'), 'utf8'), sandbox, { filename: 'tkb-rust-bridge.js' });

const api = sandbox.window.__TKB_RUST_BRIDGE_TEST_HOOKS || {};
const need = api.preSolveFullConstraintValidationNeeded;

let pass = 0, fail = 0;
const check = (name, got, want) => {
  if (got === want) { console.log('  OK   ', name); pass++; }
  else { console.log('  SAI  ', name, '| nhan:', got, '| can:', want); fail++; }
};

if (typeof need !== 'function') {
  console.log('SAI  khong lay duoc preSolveFullConstraintValidationNeeded');
  process.exit(1);
}

const slot = { 'thu2|sang|0': true };

check('khong co rang buoc -> bo qua', need({}), false);
check('tkbConstraints rong -> bo qua', need({ tkbConstraints: {} }), false);
check('chi fixedOff.teacher -> bo qua (da tha rieng)',
  need({ tkbConstraints: { fixedOff: { teacher: { 'GV1': slot } } } }), false);
check('chi fixedOff.class -> bo qua (collectOffLocks lo)',
  need({ tkbConstraints: { fixedOff: { class: { 'L001': slot } } } }), false);
check('teacher + class -> van bo qua',
  need({ tkbConstraints: { fixedOff: { teacher: { 'GV1': slot }, class: { 'L001': slot } } } }), false);
check('cac ho khac co key nhung slot deu tat -> bo qua',
  need({ tkbConstraints: { fixedOff: { subject: { 'Toan': { 'thu2|sang|0': false } } } } }), false);

check('co fixedOff.subject -> PHAI quet du',
  need({ tkbConstraints: { fixedOff: { subject: { 'Toan': slot } } } }), true);
check('co fixedOff.room -> PHAI quet du',
  need({ tkbConstraints: { fixedOff: { room: { 'P1': slot } } } }), true);
check('co fixedOff.subjectGroup -> PHAI quet du',
  need({ tkbConstraints: { fixedOff: { subjectGroup: { 'Nhom1': slot } } } }), true);
check('teacher + subject -> PHAI quet du',
  need({ tkbConstraints: { fixedOff: { teacher: { 'GV1': slot }, subject: { 'Toan': slot } } } }), true);

console.log(fail === 0 ? '\nTAT CA DAT' : `\nCO ${fail} MUC SAI`);
process.exit(fail === 0 ? 0 : 1);
