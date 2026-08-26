// So sanh validateAll (dong bo) va validateAllAsync (nhuong luong):
// cung ket qua khong, va lat dai nhat bao lau (do la do dai cu "khung").
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const DATA = JSON.parse(fs.readFileSync(process.argv[2] || 'scratch/school_e3d7a3b21e1.json', 'utf8'));
const LOG = path.join(__dirname, 'validate_compare.log');
try { fs.unlinkSync(LOG); } catch (_) {}
const NL = String.fromCharCode(10);
const say = t => { fs.appendFileSync(LOG, t + NL); process.stdout.write(t + NL); };

const noop = () => {};
const mkEl = () => {
  const el = {
    style: { setProperty: noop, removeProperty: noop },
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    dataset: {}, children: [], attributes: {},
    appendChild: c => { el.children.push(c); return c; },
    removeChild: noop, insertBefore: c => c, remove: noop,
    setAttribute: (k, v) => { el.attributes[k] = v; }, getAttribute: k => el.attributes[k] ?? null,
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
  Error, RegExp, isNaN, parseInt, parseFloat, console,
  performance: { now: () => Number(process.hrtime.bigint()) / 1e6 },
  TextEncoder, TextDecoder, URL, URLSearchParams,
};
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
sandbox.DATA = DATA;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'web/pages/tkb-constraints.js'), 'utf8'), sandbox, { filename: 'tkb-constraints.js' });

const api = sandbox.window.TKBConstraints;
say('API: ' + (api ? api.version : 'KHONG CO'));

(async () => {
  let t = process.hrtime.bigint();
  const sync = api.validateAll(3000) || [];
  const syncMs = Number(process.hrtime.bigint() - t) / 1e6;
  say('validateAll (dong bo)   : ' + syncMs.toFixed(0) + ' ms, ' + sync.length + ' thong bao  <-- khoa luong chinh lien tuc');

  // Do lat dai nhat cua ban async: chinh la do dai "khung" ma nguoi dung cam nhan
  let maxSlice = 0, slices = 0, lastTick = process.hrtime.bigint();
  const origST = sandbox.setTimeout;
  sandbox.setTimeout = (fn, ms) => origST(() => {
    const gap = Number(process.hrtime.bigint() - lastTick) / 1e6;
    if (gap > maxSlice) maxSlice = gap;
    slices++;
    lastTick = process.hrtime.bigint();
    fn();
  }, ms);

  t = process.hrtime.bigint();
  lastTick = t;
  const asy = (await api.validateAllAsync(3000, { sliceBudgetMs: 8 })) || [];
  const asyncMs = Number(process.hrtime.bigint() - t) / 1e6;
  say('validateAllAsync        : ' + asyncMs.toFixed(0) + ' ms, ' + asy.length + ' thong bao');
  say('  so lat nhuong luong   : ' + slices);
  say('  LAT DAI NHAT          : ' + maxSlice.toFixed(0) + ' ms  <-- do dai khung toi da');

  const key = x => [x.lopId || '', x.mon || '', x.thu || '', x.buoi || '', x.ti, x.message || ''].join('|');
  const a = new Set(sync.map(key)), b = new Set(asy.map(key));
  const onlyA = [...a].filter(k => !b.has(k)), onlyB = [...b].filter(k => !a.has(k));
  say('KET QUA GIONG NHAU      : ' + (onlyA.length === 0 && onlyB.length === 0));
  if (onlyA.length) say('  chi co o ban dong bo: ' + onlyA.length);
  if (onlyB.length) say('  chi co o ban async  : ' + onlyB.length);
  process.exit(0);
})();
