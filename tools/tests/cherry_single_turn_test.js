// 22/08: nut Cherry = MOT LUOT (xep + toi uu trong cung luot), KHONG noi bac
// thang tu tinh chinh (maybeScheduleAutoRefine) sau khi ap ket qua. Nut Sap
// xep (▶) van giu bac thang nhu cu. Chay: node tools/tests/cherry_single_turn_test.js
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync('web/pages/tkb-rust-bridge.js', 'utf8');

const noop = () => {};
const sandbox = {
  document: {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: noop,
    createElement: () => ({ style: {}, classList: { add: noop, remove: noop, toggle: noop }, appendChild: noop }),
    body: { appendChild: noop },
    documentElement: { style: { setProperty: noop } },
  },
  navigator: { userAgent: 'node' },
  location: { href: 'https://tkbcherry.com/pages/sapxep', search: '', origin: 'https://tkbcherry.com' },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop, key: () => null, length: 0 },
  sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  fetch: () => Promise.reject(new Error('no network in test')),
  XMLHttpRequest: function () { this.open = noop; this.send = noop; this.setRequestHeader = noop; },
  setTimeout, clearTimeout, setInterval, clearInterval,
  console, JSON, Math, Date, Promise, Object, Array, String, Number, Boolean, Map, Set, Error, RegExp,
  performance: { now: () => Date.now() },
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
sandbox.window.__TKB_E2E_EXPOSE_TEST_HOOKS = true;
vm.createContext(sandbox);
try {
  vm.runInContext(src, sandbox, { filename: 'tkb-rust-bridge.js' });
} catch (e) {
  console.log('SAI  nap file that bai:', String(e.message).slice(0, 200));
  process.exit(1);
}

const api = sandbox.window.__TKB_RUST_BRIDGE_TEST_HOOKS || {};
const refine = api.maybeScheduleAutoRefine;
const isCherry = api.isCherryEngineRun;
if (typeof refine !== 'function' || typeof isCherry !== 'function') {
  console.log('SAI  khong lay duoc maybeScheduleAutoRefine/isCherryEngineRun tu test hooks');
  process.exit(1);
}

let pass = 0, fail = 0;
const check = (name, got, want) => {
  if (got === want) { console.log('  OK  ', name); pass++; }
  else { console.log('  SAI ', name, '| nhan:', got, '| can:', want); fail++; }
};

// Lich gia: con no chat luong (3 buoi trong >=2, 2 buoi 1 tiet) -> bac thang
// binh thuong se muon chay lane optimize_gap2.
const win = sandbox.window;
win.DATA = { tkb: { L1: {} }, tkbLessonTeachers: {}, tkbLessonRooms: {}, tkbSolverResult: { metrics: {} } };
win.__tkbTeacherQualitySnapshot = () => ({
  onePeriod: 2, gap2Plus: 3, gap1: 5, excess: 3, bad: 5,
  sessions: new Map([['T1', new Map([['thu2|sang', []], ['thu3|sang', []]])]]),
});

// 1) Luot Cherry (co __TKB_FORCE_ENGINE) -> KHONG noi bac thang, co tom tat.
win.__TKB_FORCE_ENGINE = 'cherry';
win.__TKB_AUTO_REFINE_STATE = null;
win.__TKB_AUTO_REFINE_PENDING = false;
win.__TKB_SOLVER_LAST_COMPLETION_MESSAGE = 'Đã xếp xong!';
refine();
check('Cherry: khong bat co __TKB_AUTO_REFINE_PENDING', !!win.__TKB_AUTO_REFINE_PENDING, false);
check('Cherry: khong tao __TKB_AUTO_REFINE_STATE', win.__TKB_AUTO_REFINE_STATE, null);
check('Cherry: co tom tat "Cherry xong (1 lượt)"', /Cherry xong \(1 lượt\)/.test(String(win.__TKB_CHERRY_LAST_SUMMARY || '')), true);
check('Cherry: tom tat neu du 4 chi so', /2 buổi 1 tiết, 3 trống ≥2, 5 trống 1 tiết, 2 buổi dạy/.test(String(win.__TKB_CHERRY_LAST_SUMMARY || '')), true);
win.__TKB_FORCE_ENGINE = '';

// 2) Luot Cherry nhan dien qua payload (server echo), co FORCE_ENGINE da xoa.
win.__TKB_CHERRY_LAST_SUMMARY = '';
refine({ cherryTurn: isCherry({ solver: { runtime_settings: { engine_route: 'cherry_engine_v3', engine_requested: 'cherry' } } }, {}) });
check('Cherry (echo server): khong noi bac thang', !!win.__TKB_AUTO_REFINE_PENDING, false);
check('Cherry (echo server): van co tom tat', /Cherry xong/.test(String(win.__TKB_CHERRY_LAST_SUMMARY || '')), true);

// 3) Luot thuong (nut ▶ / lane mac dinh): bac thang van chay nhu cu.
win.__TKB_CHERRY_LAST_SUMMARY = '';
win.__TKB_AUTO_REFINE_STATE = null;
win.__TKB_AUTO_REFINE_PENDING = false;
win.__TKB_SOLVE_UI_BUSY = true; // de refineKick khong goi bridgeSapXepTuDongAll that
refine({ cherryTurn: isCherry({ solver: { runtime_settings: { engine_route: 'legacy', engine_requested: null } } }, {}) });
check('Nut thuong: bac thang van duoc bat', win.__TKB_AUTO_REFINE_PENDING, true);
check('Nut thuong: lane dau tien la optimize_gap2', win.__TKB_AUTO_REFINE_STATE && win.__TKB_AUTO_REFINE_STATE.lastMode, 'optimize_gap2');
check('Nut thuong: khong co tom tat Cherry', String(win.__TKB_CHERRY_LAST_SUMMARY || ''), '');

console.log('');
console.log(fail === 0 ? 'TAT CA DAT' : fail + ' MUC SAI');
process.exit(fail === 0 ? 0 : 1);
