// Do thoi gian TUNG BUOC cua giai doan CHUAN BI truoc khi POST (nguyen nhan
// "khung khi bat dau"). Chay tren du lieu truong that, khong can trinh duyet.
//   node scratch/prep_profile.js scratch/school_e3d7a3b21e1.json
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const LOG = path.join(__dirname, 'prep_profile.log');
try { fs.unlinkSync(LOG); } catch (_) {}
const NL = String.fromCharCode(10);
const say = (t) => { fs.appendFileSync(LOG, t + NL); process.stdout.write(t + NL); };
const dataFile = process.argv[2] || 'scratch/school_e3d7a3b21e1.json';
const DATA = JSON.parse(fs.readFileSync(dataFile, 'utf8'));

const noop = () => {};
const store = new Map();
const mkEl = () => {
  const el = {
    style: { setProperty: noop, removeProperty: noop },
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    dataset: {}, children: [], attributes: {},
    appendChild: c => { el.children.push(c); return c; },
    removeChild: noop, insertBefore: c => c, remove: noop,
    setAttribute: (k, v) => { el.attributes[k] = v; }, getAttribute: k => el.attributes[k] ?? null,
    removeAttribute: k => { delete el.attributes[k]; },
    addEventListener: noop, removeEventListener: noop, querySelector: () => null,
    querySelectorAll: () => [], closest: () => null, focus: noop, click: noop,
    textContent: '', innerHTML: '', innerText: '', value: '', hidden: false,
  };
  return el;
};
const sandbox = {
  document: {
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: noop, removeEventListener: noop,
    body: mkEl(), head: mkEl(), documentElement: mkEl(),
    createElement: () => mkEl(), createTextNode: () => mkEl(),
    createDocumentFragment: () => mkEl(),
    visibilityState: 'visible',
  },
  navigator: { userAgent: 'node', maxTouchPoints: 0 },
  location: { href: 'https://tkbcherry.com/pages/sapxep', search: '', origin: 'https://tkbcherry.com', pathname: '/pages/sapxep' },
  localStorage: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k), key: i => Array.from(store.keys())[i] || null,
    get length() { return store.size; },
  },
  sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  fetch: () => Promise.reject(new Error('no network')),
  XMLHttpRequest: function () { this.open = noop; this.send = noop; this.setRequestHeader = noop; },
  setTimeout, clearTimeout, setInterval, clearInterval,
  queueMicrotask, Promise, JSON, Math, Date, Object, Array, String, Number, Boolean,
  Map, Set, WeakMap, WeakSet, Error, RegExp, isNaN, parseInt, parseFloat, console,
  performance: { now: () => Number(process.hrtime.bigint() / 1000n) / 1000 },
  crypto: { randomUUID: () => 'x'.repeat(32) },
  TextEncoder, TextDecoder, URL, URLSearchParams,
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
sandbox.window.__TKB_E2E_EXPOSE_TEST_HOOKS = true;
sandbox.DATA = DATA;
vm.createContext(sandbox);

const files = (process.env.PREP_FILES || 'web/pages/tkb-constraints.js,web/pages/tkb-rust-bridge.js').split(',').filter(Boolean);
for (const f of files) {
  say('dang nap ' + f + ' ...');
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const t = process.hrtime.bigint();
  try {
    vm.runInContext(src, sandbox, { filename: path.basename(f), timeout: 60000 });
    process.stdout.write('OK ' + (Number(process.hrtime.bigint() - t) / 1e6).toFixed(0) + 'ms\n');
  } catch (e) {
    process.stdout.write('LOI sau ' + (Number(process.hrtime.bigint() - t) / 1e6).toFixed(0) + 'ms: ' + String(e.message).slice(0, 200) + '\n');
  }
}

const api = sandbox.window.__TKB_RUST_BRIDGE_TEST_HOOKS || {};
say('so hook lay duoc: ' + Object.keys(api).length);

const ms = (fn) => {
  const t = process.hrtime.bigint();
  let out;
  try { out = fn(); } catch (e) { return { err: String(e.message).slice(0, 160) }; }
  return { ms: Number(process.hrtime.bigint() - t) / 1e6, out };
};

const summarize = (name, r) => {
  if (r.err) { console.log(`  ${name.padEnd(38)} LOI: ${r.err}`); return; }
  let tail = '';
  if (typeof r.out === 'number') tail = '-> ' + r.out;
  else if (typeof r.out === 'string') tail = '-> ' + r.out.slice(0, 40);
  say(`  ${name.padEnd(38)} ${r.ms.toFixed(0).padStart(7)} ms  ${tail}`);
};

console.log('\n=== THOI GIAN TUNG BUOC CHUAN BI ===');
const clone = () => JSON.parse(JSON.stringify(DATA));

if (typeof api.releaseConstraintViolatingLessons === 'function') {
  const d = clone();
  summarize('releaseConstraintViolatingLessons', ms(() => api.releaseConstraintViolatingLessons(d)));
}
for (const name of ['durableScheduleFingerprint', 'uiTeacherQualityMetrics', 'currentScheduleAppearsComplete',
                    'expectedLessonCount', 'countScheduledLessons', 'collectOffLocks', 'backendScheduleScope']) {
  if (typeof api[name] === 'function') {
    const d = clone();
    summarize(name, ms(() => api[name](d)));
  } else {
    console.log(`  ${name.padEnd(38)} (khong export)`);
  }
}
if (typeof api.dataForSolverRequest === 'function') {
  const d = clone();
  summarize('dataForSolverRequest', ms(() => api.dataForSolverRequest(d, {})));
}
summarize('JSON.stringify(toan bo data)', ms(() => JSON.stringify(DATA).length));
