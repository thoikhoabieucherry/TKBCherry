// Cong chat luong cua nut Cherry phai chay dung cho MOI TRUONG, khong phai
// chi mot bo du lieu. Bo kiem thu nay dung nhieu dang truong khac nhau:
//   - nut Cherry (22/08): KHONG BAO GIO XAU HON lich dang co, so sanh tu dien
//     du tiet > buoi 1 tiet > trong >=2 > buoi day > trong 1
//   - cac nut con lai: giu nguyen luat doi chieu cu
//   - chay dung cho moi quy mo truong, khong gan cung bo du lieu nao
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync('web/pages/tkb-rust-bridge.js', 'utf8');
const noop = () => {};
const sandbox = {
  document: {
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: noop, body: { appendChild: noop },
    createElement: () => ({ style: {}, classList: { add: noop, remove: noop, toggle: noop }, appendChild: noop }),
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
vm.runInContext(src, sandbox, { filename: 'tkb-rust-bridge.js' });

const api = sandbox.window.__TKB_RUST_BRIDGE_TEST_HOOKS || {};
const better = api.payloadStrictlyBetterTeacherQuality;
if (typeof better !== 'function') {
  console.log('SAI  khong lay duoc payloadStrictlyBetterTeacherQuality');
  process.exit(1);
}

let pass = 0, fail = 0;
const check = (name, got, want) => {
  if (got === want) { console.log('  OK  ', name); pass++; }
  else { console.log('  SAI ', name, '| nhan:', got, '| can:', want); fail++; }
};

// Bang chung "san toan hoc": moi giao vien day N tiet/tuan voi toi da M tiet/buoi
// bi ep it nhat (2*ceil(N/M) - N) buoi le. Day la rang buoc so hoc, khong the pha.
const forcedSingleton = (teacher, part, periods, maxPerSession) => {
  const minimumSessions = Math.ceil(periods / maxPerSession);
  return {
    teacher, part, class: '6/1', subject: 'Toán',
    periods_per_week: periods, max_periods_per_session: maxPerSession,
    minimum_sessions: minimumSessions,
    forced_singletons: Math.max(0, 2 * minimumSessions - periods),
  };
};
const evidenceFor = (count) => {
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push(forcedSingleton('GV' + i, i % 2 ? 'PM' : 'AM', 3, 2)); // 3 tiet, toi da 2/buoi -> 1 buoi le
  }
  return rows;
};

const lich = (o) => ({
  metrics: Object.assign({
    expected_periods: 2000, scheduled_periods: 2000,
    app_constraint_violation_count: 0,
  }, {
    teacher_sessions: o.sessions,
    one_period_teacher_sessions: o.onePeriod,
    gap_distribution: { 0: 500, 1: o.gap1, 2: o.gap2 || 0 },
  }, o.floor == null ? {} : {
    one_period_teacher_sessions_lower_bound: o.floor,
    one_period_teacher_sessions_lower_bound_evidence: evidenceFor(o.floor),
  }),
});
const cherry = (o) => Object.assign(lich(o), {
  solver: { runtime_settings: { engine_requested: 'cherry', engine_route: 'cherry_engine_v3' } },
});
const S = { engine: 'cherry' };

// ---- Cherry (22/08, thay quyet dinh 20/08): KHONG BAO GIO XAU HON, so sanh
//      TU DIEN theo thu tu: du tiet > buoi 1 tiet > trong >=2 > buoi day > trong 1
{
  const cu = lich({ sessions: 751, onePeriod: 4, gap1: 140, gap2: 0, floor: 4 });
  check('Cherry: lich moi tot hon -> dua ra',
    better(cherry({ sessions: 742, onePeriod: 4, gap1: 120, gap2: 0, floor: 4 }), cu, S), true);
  check('Cherry: it buoi day hon du trong-1 tang -> dua ra (buoi day uu tien hon trong 1)',
    better(cherry({ sessions: 745, onePeriod: 4, gap1: 165, gap2: 0, floor: 4 }), cu, S), true);
  check('Cherry: cung buoi day nhung trong-1 tang -> LOAI',
    better(cherry({ sessions: 751, onePeriod: 4, gap1: 165, gap2: 0, floor: 4 }), cu, S), false);
  check('Cherry: buoi le tang (4 -> 40) -> LOAI du buoi day it hon',
    better(cherry({ sessions: 700, onePeriod: 40, gap1: 100, gap2: 0 }), cu, S), false);
  check('Cherry: trong >=2 tang -> LOAI du buoi day it hon',
    better(cherry({ sessions: 700, onePeriod: 4, gap1: 100, gap2: 3 }), cu, S), false);
  check('Cherry: bang nhau moi mat -> giu lich cu',
    better(cherry({ sessions: 751, onePeriod: 4, gap1: 140, gap2: 0, floor: 4 }), cu, S), false);

  const thieuTiet = cherry({ sessions: 746, onePeriod: 15, gap1: 125, gap2: 5 });
  thieuTiet.metrics.scheduled_periods = 1996;
  check('Cherry: lich moi THIEU tiet hon lich cu -> LOAI',
    better(thieuTiet, cu, S), false);

  const cuThieu = lich({ sessions: 751, onePeriod: 4, gap1: 140, gap2: 0 });
  cuThieu.metrics.scheduled_periods = 1990;
  check('Cherry: lich moi xep duoc NHIEU tiet hon -> dua ra du chat luong GV xau hon',
    better(cherry({ sessions: 790, onePeriod: 30, gap1: 200, gap2: 6 }), cuThieu, S), true);

  const nhoLai = lich({ sessions: 40, onePeriod: 9, gap1: 6, gap2: 2 });
  check('Cherry: truong nho, giam buoi le va trong >=2 -> dua ra',
    better(cherry({ sessions: 36, onePeriod: 2, gap1: 11, gap2: 0 }), nhoLai, S), true);
}

// ---- Cac nut khac KHONG bi anh huong, van doi chieu nhu cu -----------------
{
  const cu = lich({ sessions: 817, onePeriod: 152, gap1: 120, gap2: 23 });
  const khongPhaiCherry = lich({ sessions: 753, onePeriod: 4, gap1: 181, gap2: 0 });
  sandbox.window.__TKB_LAST_REQUESTED_ENGINE = '';
  check('Nut thuong: trong-1-tiet tang van bi tu choi',
    better(khongPhaiCherry, cu, {}), false);
  check('Nut "buoi le": chi doi buoi le, khong duoc lam xau muc khac',
    better(khongPhaiCherry, cu, { optimization_focus: 'singletons' }), false);
  const totMoiMat = lich({ sessions: 800, onePeriod: 140, gap1: 110, gap2: 20 });
  check('Nut thuong: tot deu moi mat thi van chap nhan',
    better(totMoiMat, cu, {}), true);
}

console.log('');
console.log(fail === 0 ? 'TAT CA DAT' : fail + ' MUC SAI');
process.exit(fail === 0 ? 0 : 1);
