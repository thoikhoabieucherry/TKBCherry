// 22/08 (khuya, chi dao chu du an): "nut Cherry khi xep cung KHONG duoc rot tiet
// ra Chua phan; cac nut toi uu khi da xep du thi hoan doi". Engine khong dua
// tiet ra nua; cong chap nhan cua bridge KHONG tinh tiet "da dua ra" la da xu
// ly (tiet thieu = thieu). Bo kiem nay chot hop dong do + cac co UI lien quan.
// Chay: node tools/tests/cherry_eject_gate_test.js
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
  console, JSON, Math, Date, Promise, Object, Array, String, Number, Boolean, Map, Set, Error, RegExp,
  performance: { now: () => Date.now() },
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
sandbox.window.__TKB_E2E_EXPOSE_TEST_HOOKS = true;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'tkb-rust-bridge.js' });

const api = sandbox.window.__TKB_RUST_BRIDGE_TEST_HOOKS || {};
let pass = 0, fail = 0;
const check = (name, got, want) => {
  if (got === want) { console.log('  OK  ', name); pass++; }
  else { console.log('  SAI ', name, '| nhan:', JSON.stringify(got), '| can:', JSON.stringify(want)); fail++; }
};
for (const fn of ['qualityEjectedPeriods', 'cherryCandidateStrictlyBetter', 'shouldKeepIncumbentForTeacherQuality', 'cherryIncompleteCandidatePreferred']) {
  check('bridge expose ' + fn, typeof api[fn], 'function');
}
if (fail) { console.log(fail + ' MUC SAI'); process.exit(1); }

const EXPECTED = 2000;
const lich = (o) => ({
  metrics: {
    expected_periods: EXPECTED,
    scheduled_periods: o.scheduled == null ? EXPECTED : o.scheduled,
    unassigned_periods: o.scheduled == null ? 0 : EXPECTED - o.scheduled,
    app_constraint_violation_count: 0,
    hard_ok: true,
    teacher_sessions: o.sessions,
    one_period_teacher_sessions: o.onePeriod,
    gap_distribution: { 0: 500, 1: o.gap1, 2: o.gap2 || 0 },
  },
  unassignedLessons: (o.ejected || []).map((x, i) => Object.assign({
    className: '6/1', subject: 'Toán', teacher: 'GV' + i, periods: 1,
    reason: 'teacher_quality_unreachable', message: 'GV chỉ có 1 tiết/tuần. Gợi ý: đổi GV.',
  }, x)),
});
const cherry = (o) => Object.assign(lich(o), {
  solver: { runtime_settings: { engine_requested: 'cherry', engine_route: 'cherry_engine_v3' } },
});
const S = { engine: 'cherry' };
const better = api.cherryCandidateStrictlyBetter;

// 1) Ke toan "tiet da dua ra" TAT: luon 0, ke ca khi du lieu cu con ma ly do
check('qualityEjectedPeriods luon 0 (ke toan tat)',
  api.qualityEjectedPeriods(cherry({ sessions: 700, onePeriod: 0, gap1: 100, scheduled: 1997, ejected: [{}, {}, {}] })), 0);
check('bridge: co CHERRY_QUALITY_EJECT_ACCOUNTING = false', /const CHERRY_QUALITY_EJECT_ACCOUNTING = false;/.test(src), true);

// 2) Thieu tiet = thieu: ung vien 1997 (du co "ly do") thua lich du 2000
{
  const cu = lich({ sessions: 751, onePeriod: 3, gap1: 140, gap2: 0 });
  const moi = cherry({ sessions: 748, onePeriod: 0, gap1: 142, gap2: 0, scheduled: 1997, ejected: [{}, {}, {}] });
  check('Cherry: 1997 (3 "dua ra") < 2000 -> LOAI (tiet thieu la thieu)', better(moi, cu, {}), false);
  check('  ly do loai nhac so tiet', /số tiết xếp được 2000 → 1997/.test(String(sandbox.window.__TKB_LAST_QUALITY_REJECTION?.text || '')), true);
  check('cherryIncompleteCandidatePreferred luon false', api.cherryIncompleteCandidatePreferred(moi, { tkb: {} }, {}), false);
  const guard = { complete: true, nearComplete: false, missing: 0, expected: EXPECTED, scheduled: EXPECTED, qualityEjected: 0 };
  check('shouldKeep: ung vien thieu tiet -> GIU lich cu', api.shouldKeepIncumbentForTeacherQuality(moi, cu, guard, S), true);
  // lich cu thieu 3 (du lieu cu), ung vien xep du 2000 -> DUA RA du them buoi le
  const cuThieu = cherry({ sessions: 748, onePeriod: 0, gap1: 142, gap2: 0, scheduled: 1997, ejected: [{}, {}, {}] });
  check('lich cu thieu 3 tiet, ung vien du 2000 (3 buoi le) -> DUA RA (du tiet truoc)',
    better(cherry({ sessions: 751, onePeriod: 3, gap1: 140, gap2: 0 }), cuThieu, { incumbentScheduled: 1997 }), true);
}

// 3) Lich du: so sanh chat luong tu dien nhu cu (khong bao gio xau hon)
{
  const cu = lich({ sessions: 751, onePeriod: 4, gap1: 140, gap2: 0 });
  check('Cherry: tot hon -> dua ra', better(cherry({ sessions: 742, onePeriod: 4, gap1: 120, gap2: 0 }), cu, S), true);
  check('Cherry: bang nhau -> giu', better(cherry({ sessions: 751, onePeriod: 4, gap1: 140, gap2: 0 }), cu, S), false);
  check('Cherry: buoi le tang -> loai', better(cherry({ sessions: 700, onePeriod: 5, gap1: 100, gap2: 0 }), cu, S), false);
  check('Cherry: trong >=2 tang -> loai', better(cherry({ sessions: 700, onePeriod: 4, gap1: 100, gap2: 3 }), cu, S), false);
  check('Cherry: it buoi day hon, trong 1 tang -> dua ra (buoi day uu tien hon)', better(cherry({ sessions: 745, onePeriod: 4, gap1: 165, gap2: 0 }), cu, S), true);
}

// 4) UI: va nhanh xep MOI tiet Chua phan (khong bo qua) tru khi goi ro; Cherry van khong va nhanh truoc khi giai
{
  const phanmon = fs.readFileSync('web/pages/phanmon.js', 'utf8');
  check('phanmon: va nhanh KHONG bo qua tiet "dua ra" theo mac dinh', /TKB_SKIP_QUALITY_EJECTED_TASKS = options\.excludeQualityEjected === true;/.test(phanmon), true);
  check('bridge: Cherry bo qua va nhanh truoc khi giai (engine tu xep lai tiet thieu)',
    /function maybeFinishLocalUnassignedRepairSolve\(settings\)\{[\s\S]{0,900}__TKB_FORCE_ENGINE[\s\S]{0,200}return null;/.test(src), true);
  check('bridge: tom tat Cherry bao buoi chua go duoc (khong rot tiet)', /Chưa gỡ được \$\{kept\.length\} buổi \(chỉ hoán đổi, không rớt tiết\)/.test(src), true);
}

console.log('');
console.log(fail === 0 ? 'TAT CA DAT' : fail + ' MUC SAI');
process.exit(fail === 0 ? 0 : 1);
