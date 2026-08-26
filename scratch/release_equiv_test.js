// KIEM DINH TUONG DUONG: bo qua vong validateAll (ban moi) co tra ve DUNG so
// tiet nhu ban luon quet du (ban cu) khong, tren nhieu bo du lieu.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const BRIDGE = fs.readFileSync(path.join(ROOT, 'web/pages/tkb-rust-bridge.js'), 'utf8');
const CONSTRAINTS = fs.readFileSync(path.join(ROOT, 'web/pages/tkb-constraints.js'), 'utf8');

// "Ban cu" = ep predicate luon true -> luon chay validateAll nhu truoc khi sua
const NEEDLE = 'function preSolveFullConstraintValidationNeeded(data){';
if (!BRIDGE.includes(NEEDLE)) { console.log('KHONG TIM THAY predicate — dung lai'); process.exit(1); }
const BRIDGE_ALWAYS = BRIDGE.replace(NEEDLE, NEEDLE + ' if(data) return true;');

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

function makeSandbox() {
  const store = new Map();
  const s = {
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
    performance: { now: () => Number(process.hrtime.bigint()) / 1e6 },
    TextEncoder, TextDecoder, URL, URLSearchParams,
  };
  s.window = s; s.self = s; s.globalThis = s;
  s.window.__TKB_E2E_EXPOSE_TEST_HOOKS = true;
  vm.createContext(s);
  return s;
}

function runOne(bridgeSrc, data) {
  const s = makeSandbox();
  s.DATA = data;
  vm.runInContext(CONSTRAINTS, s, { filename: 'tkb-constraints.js' });
  vm.runInContext(bridgeSrc, s, { filename: 'tkb-rust-bridge.js' });
  const api = s.window.__TKB_RUST_BRIDGE_TEST_HOOKS || {};
  const fn = api.releaseConstraintViolatingLessons;
  if (typeof fn !== 'function') return { err: 'khong lay duoc ham' };
  const t = process.hrtime.bigint();
  const released = fn(data, { persist: false, refresh: false, silent: true });
  return { released, ms: Number(process.hrtime.bigint() - t) / 1e6, tkb: JSON.stringify(data.tkb) };
}

const files = process.argv.slice(2);
let fail = 0;
for (const f of files) {
  const raw = fs.readFileSync(f, 'utf8');
  const a = runOne(BRIDGE_ALWAYS, JSON.parse(raw));   // ban cu
  const b = runOne(BRIDGE, JSON.parse(raw));          // ban moi
  if (a.err || b.err) { console.log(path.basename(f), 'LOI', a.err || b.err); fail++; continue; }
  const same = a.released === b.released && a.tkb === b.tkb;
  if (!same) fail++;
  console.log(
    path.basename(f).padEnd(32),
    'cu: ' + String(a.released).padStart(4) + ' tiet /' + a.ms.toFixed(0).padStart(6) + 'ms  |',
    'moi: ' + String(b.released).padStart(4) + ' tiet /' + b.ms.toFixed(0).padStart(6) + 'ms  |',
    same ? 'GIONG HET' : '*** KHAC NHAU ***'
  );
}
console.log(fail === 0 ? '\nTAT CA GIONG NHAU' : `\nCO ${fail} BO KHAC NHAU`);
process.exit(fail === 0 ? 0 : 1);
