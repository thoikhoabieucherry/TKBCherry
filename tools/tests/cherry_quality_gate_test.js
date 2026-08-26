// Kiem tra cong chat luong bang SO LIEU THAT cua THCS Dong Den (20/08).
// Nap tkb-rust-bridge.js trong mot moi truong gia lap toi thieu roi goi thang
// payloadStrictlyBetterTeacherQuality qua cua so debug ma file da expose.
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync('web/pages/tkb-rust-bridge.js', 'utf8');

const noop = () => {};
const win = {};
const sandbox = {
  window: win,
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
  console, JSON, Math, Date, Promise, Object, Array, String, Number, Boolean, Map, Set, Error,
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
const fn = api.payloadStrictlyBetterTeacherQuality || api.noBetterScheduleStatus;
if (typeof api.payloadStrictlyBetterTeacherQuality !== 'function') {
  console.log('SAI  khong lay duoc payloadStrictlyBetterTeacherQuality tu TKBRustAPI');
  console.log('     cac khoa co san:', Object.keys(api).slice(0, 40).join(', '));
  process.exit(1);
}

const better = api.payloadStrictlyBetterTeacherQuality;

// So lieu THAT doc tu /api/solve-result va DATA.tkbSolverResult ngay 20/08.
const lichHienTai = {
  metrics: {
    expected_periods: 2103, scheduled_periods: 2103,
    teacher_sessions: 817, one_period_teacher_sessions: 152,
    gap_distribution: { 0: 522, 1: 120, 2: 23 },
    app_constraint_violation_count: 0,
  },
};
const cherryMoi = {
  solver: { runtime_settings: { engine_route: 'cherry_engine_v3', engine_requested: 'cherry' } },
  metrics: {
    expected_periods: 2103, scheduled_periods: 2103,
    teacher_sessions: 753, one_period_teacher_sessions: 4,
    gap_distribution: { 0: 572, 1: 181 },
    app_constraint_violation_count: 0,
  },
};

let pass = 0, fail = 0;
const check = (name, got, want) => {
  if (got === want) { console.log('  OK  ', name); pass++; }
  else { console.log('  SAI ', name, '| nhan:', got, '| can:', want); fail++; }
};

// 1) Ket qua Cherry that phai duoc CHAP NHAN
check('Cherry 152->4 buoi le, 23->0 trong2+, gap1 120->181 duoc chap nhan',
  better(cherryMoi, lichHienTai, { engine: 'cherry' }), true);

// 2) Nut khac (khong phai Cherry) van giu luat cu: gap1 tang => tu choi
const nhuCu = JSON.parse(JSON.stringify(cherryMoi));
delete nhuCu.solver;
sandbox.window.__TKB_LAST_REQUESTED_ENGINE = '';
check('Nut thuong: gap1 tang van bi tu choi (luat cu giu nguyen)',
  better(nhuCu, lichHienTai, {}), false);

// 3) 22/08 (thay chi dao 20/08 "dua ra luon"): Cherry phai DAM BAO khong xau
//    hon theo thu tu uu tien; xau hon o chi so cao hon thi LOAI, giu lich cu.
//    Xem them tools/tests/cherry_all_schools_test.js.
const cherryXau = JSON.parse(JSON.stringify(cherryMoi));
cherryXau.metrics.one_period_teacher_sessions = 200;   // xau hon 152
check('Cherry lam xau buoi-1-tiet -> LOAI, giu lich cu',
  better(cherryXau, lichHienTai, { engine: 'cherry' }), false);

const cherryXau2 = JSON.parse(JSON.stringify(cherryMoi));
cherryXau2.metrics.one_period_teacher_sessions = 152;  // bang
cherryXau2.metrics.gap_distribution = { 0: 522, 1: 120, 2: 23 }; // bang
cherryXau2.metrics.teacher_sessions = 900;             // xau hon 817
check('Cherry bang buoi le/trong-2 nhung tang tong buoi day -> LOAI',
  better(cherryXau2, lichHienTai, { engine: 'cherry' }), false);

// 4) Thong bao phai noi ro chi so nao xau di
const msg = api.noBetterScheduleStatus ? api.noBetterScheduleStatus(lichHienTai) : '';
check('Thong bao khong con trung "Da xep xong!"', msg !== 'Đã xếp xong!', true);
console.log('     thong bao:', msg);

// 5) Canh bao "may chu khong nhan dien engine" chi duoc bao cho ket qua cua
//    CHINH luot vua chay. Lich cu duoc giu lai (payload cu, khong co
//    engine_requested) khong duoc bao nham la loi anh Cloud Run.
const notice = api.engineFallbackNotice;
if (typeof notice === 'function') {
  const clickAt = Date.now();
  sandbox.window.__TKB_LAST_REQUESTED_ENGINE = 'cherry';
  sandbox.window.__TKB_LAST_ENGINE_CLICK_AT = clickAt;

  const lichCuGiuLai = { startedAtMs: clickAt - 600000, solver: { runtime_settings: {} } };
  check('Giu lich cu -> KHONG bao nham "build lai anh Cloud Run"',
    notice(lichCuGiuLai) === '', true);

  const anhCuThat = { startedAtMs: clickAt + 1000, solver: { runtime_settings: {} } };
  check('Anh Cloud Run cu that -> VAN canh bao',
    /Cloud Run/.test(notice(anhCuThat)), true);

  const cherryThat = {
    startedAtMs: clickAt + 1000,
    solver: { runtime_settings: { engine_requested: 'cherry', engine_route: 'cherry_engine_v3' } }
  };
  check('Cherry chay dung -> khong canh bao',
    /Cloud Run/.test(notice(cherryThat)), false);
} else {
  console.log('  SAI  khong lay duoc engineFallbackNotice');
  fail++;
}

// 6) 22/08: __TKB_LAST_REQUESTED_ENGINE duoc GIU LAI sau luot Cherry (cho
//    engineFallbackNotice). No KHONG duoc lam cac luot backend sau do (menu
//    TEST, khong bam nut engine) bi coi la Cherry va bo qua cong chat luong.
{
  sandbox.window.__TKB_LAST_REQUESTED_ENGINE = 'cherry';
  sandbox.window.__TKB_LAST_ENGINE_CLICK_AT = Date.now() - 60000;
  sandbox.window.__TKB_FORCE_ENGINE = '';

  // Anh moi: may chu echo engine_route="legacy", engine_requested=null.
  const testSauCherry = JSON.parse(JSON.stringify(cherryMoi));
  testSauCherry.solver = { runtime_settings: { engine_route: 'legacy', engine_requested: null } };
  check('Sau Cherry, luot TEST (anh moi, route=legacy) van bi cong chat luong tu choi',
    better(testSauCherry, lichHienTai, {}), false);

  // Anh cu: khong echo gi ca — chi duoc tin __TKB_FORCE_ENGINE (luot DANG chay).
  const testAnhCu = JSON.parse(JSON.stringify(cherryMoi));
  testAnhCu.solver = { runtime_settings: {} };
  check('Sau Cherry, luot TEST (anh cu, khong echo) van bi cong chat luong tu choi',
    better(testAnhCu, lichHienTai, {}), false);

  // Dang trong luot Cherry tren anh cu: __TKB_FORCE_ENGINE con dat -> la Cherry.
  sandbox.window.__TKB_FORCE_ENGINE = 'cherry';
  check('Dang chay Cherry tren anh cu (khong echo) van duoc nhan la Cherry',
    better(testAnhCu, lichHienTai, {}), true);
  sandbox.window.__TKB_FORCE_ENGINE = '';

  // Cherry roi ve bo giai cu (cherry_fallback_legacy) van la luot Cherry.
  const cherryFallback = JSON.parse(JSON.stringify(cherryMoi));
  cherryFallback.solver = { runtime_settings: { engine_route: 'cherry_fallback_legacy', engine_requested: 'cherry' } };
  check('Cherry roi ve bo giai cu (fallback) van la luot Cherry -> dua ra luon',
    better(cherryFallback, lichHienTai, {}), true);

  sandbox.window.__TKB_LAST_REQUESTED_ENGINE = '';
  sandbox.window.__TKB_LAST_ENGINE_CLICK_AT = 0;
}

console.log('');
console.log(fail === 0 ? 'TAT CA DAT' : fail + ' MUC SAI');
process.exit(fail === 0 ? 0 : 1);
