// 23/08: cong Cherry (cherryCandidateStrictlyBetter) voi yeu cau DIA DIEM cua
// giao vien (co tiet trong giua 2 dia diem / khong di chuyen 2 lan/buoi).
// Engine v3 coi day la rang buoc CUNG; bridge doc so buoi vi pham qua
// TKBConstraints.teacherLocationRuleDebt() (luoi hien thi) hoac cham danh sach
// tiet cua ung vien. Quy tac cong:
//   * luoi hien thi con vi pham, ung vien het -> NHAN ke ca khi chi so chat
//     luong (1 tiet/buoi, trong 1...) tam xau di;
//   * ung vien tang vi pham -> TU CHOI (luoi an toan);
//   * ca hai 0 / khong xac dinh -> luat chat luong cu y nguyen.
// Chay: node tools/tests/cherry_location_gate_test.js
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
for (const fn of ['cherryCandidateStrictlyBetter', 'teacherQualitySummary', 'uiTeacherQualityMetrics']) {
  if (typeof api[fn] !== 'function') {
    console.log('SAI  khong lay duoc', fn, 'tu test hooks');
    process.exit(1);
  }
}

let pass = 0, fail = 0;
const check = (name, got, want) => {
  if (got === want) { console.log('  OK  ', name); pass++; }
  else { console.log('  SAI ', name, '| nhan:', got, '| can:', want); fail++; }
};

const DU = { expected_periods: 1903, scheduled_periods: 1903, unassigned_periods: 0, app_constraint_violation_count: 0, hard_ok: true, core_hard_ok: true };
// Luoi hien thi (truong 8fbda952091, 23/08): 1 buoi 1 tiet, 0 trong >=2, 561 buoi, 122 trong 1,
// nhung 93 buoi vi pham "co tiet trong giua 2 dia diem" + 36 "di chuyen 2 lan".
const CU = { teacher_sessions: 561, one_period_teacher_sessions: 1, teacher_gap2_sessions: 0, gap_distribution: { 0: 438, 1: 122 } };
// Ung vien engine v3 (rang buoc dia diem cung): het vi pham nhung 5 buoi 1 tiet, 12 trong >=2, 635 buoi.
const MOI = { teacher_sessions: 635, one_period_teacher_sessions: 5, teacher_gap2_sessions: 12, gap_distribution: { 0: 452, 1: 171, 2: 12 } };
const statsCua = q => ({
  tsBuoiDay: q.teacher_sessions,
  soBuoiDay1: q.one_period_teacher_sessions,
  soBuoiTrong1: (q.gap_distribution && q.gap_distribution[1]) || 0,
  soBuoiTrong2: (q.gap_distribution && q.gap_distribution[2]) || 0,
});
const clone = v => JSON.parse(JSON.stringify(v));

const win = sandbox.window;
win.__TKB_FORCE_ENGINE = 'cherry';
win.__TKB_ENGINE_FOCUS_MODE = '';
win.DATA = { tkb: {}, tkbSolverResult: { metrics: Object.assign({}, DU) } };
win.calcTeacherTKBStats = () => statsCua(CU);

// Gia lap bo kiem tra rang buoc cua giao dien: luoi hien thi 129 buoi vi pham,
// ung vien cham theo danh sach tiet (o day: __locDebt gan tren tung tiet).
let visibleDebt = 129;
win.TKBConstraints = {
  teacherLocationRuleDebt(opts) {
    if (opts && Array.isArray(opts.lessons)) {
      const n = opts.lessons.reduce((s, l) => s + (Number(l.__locDebt) || 0), 0);
      return { sessions: n, teachers: n ? 1 : 0, cases: [] };
    }
    return { sessions: visibleDebt, teachers: visibleDebt ? 41 : 0, cases: [] };
  },
};
const savedTKBConstraints = win.TKBConstraints;

const ungVien = {
  metrics: Object.assign({}, DU, MOI),
  lessons: [{ classId: 'L001', day: 2, session: 'AM', period: 1, subject: 'Toan', teacher: 'GV', __locDebt: 0 }],
  solver: { runtime_settings: { engine_route: 'cherry_engine_v3', engine_requested: 'cherry' } },
};

// 1) uiTeacherQualityMetrics doc so vi pham cua luoi hien thi.
const visible = api.uiTeacherQualityMetrics(win.DATA);
check('uiTeacherQualityMetrics co teacher_location_rule_debt = 129', visible.teacher_location_rule_debt, 129);
check('teacherQualitySummary(ung vien) cham lessons -> locationDebt = 0', api.teacherQualitySummary(ungVien).locationDebt, 0);
check('teacherQualitySummary ghi lai metrics.teacher_location_rule_debt cua ung vien', ungVien.metrics.teacher_location_rule_debt, 0);

// 2) Luoi hien thi vi pham, ung vien het vi pham nhung chat luong tam xau hon -> NHAN.
check('Luoi 129 vi pham -> ung vien 0 vi pham: NHAN du 1 tiet/buoi 1 -> 5',
  api.cherryCandidateStrictlyBetter(ungVien, { metrics: Object.assign({}, DU) }), true);

// 3) Ung vien TANG vi pham (khong bao gio xay ra voi engine v3, luoi an toan) -> TU CHOI.
visibleDebt = 0;
const ungVienXau = clone(ungVien);
ungVienXau.metrics = Object.assign({}, DU, CU);
delete ungVienXau.metrics.teacher_location_rule_debt;
ungVienXau.lessons = [{ classId: 'L001', day: 2, session: 'AM', period: 1, subject: 'Toan', teacher: 'GV', __locDebt: 3 }];
check('Luoi 0 vi pham -> ung vien 3 vi pham (chat luong y het): TU CHOI',
  api.cherryCandidateStrictlyBetter(ungVienXau, { metrics: Object.assign({}, DU) }), false);
check('Ly do tu choi neu ro vi pham dia diem',
  /vi phạm yêu cầu địa điểm 0 → 3/.test(String(win.__TKB_LAST_QUALITY_REJECTION && win.__TKB_LAST_QUALITY_REJECTION.text || '')), true);

// 4) Ca hai 0 vi pham -> luat chat luong cu: ung vien xau hon bi tu choi, tot hon duoc nhan.
const ungVienSach = clone(ungVien);
ungVienSach.metrics = Object.assign({}, DU, MOI, { teacher_location_rule_debt: 0 });
check('Ca hai 0 vi pham, ung vien xau hon ve chat luong -> TU CHOI (luat cu)',
  api.cherryCandidateStrictlyBetter(ungVienSach, { metrics: Object.assign({}, DU) }), false);
const ungVienTot = clone(ungVien);
ungVienTot.metrics = Object.assign({}, DU, CU, { one_period_teacher_sessions: 0, teacher_location_rule_debt: 0 });
check('Ca hai 0 vi pham, ung vien tot hon (1 tiet/buoi 1 -> 0) -> NHAN',
  api.cherryCandidateStrictlyBetter(ungVienTot, { metrics: Object.assign({}, DU) }), true);

// 5) Khong co API kiem tra (trang cu) -> bo qua chieu dia diem, luat cu y nguyen.
delete win.TKBConstraints;
win.DATA = { tkb: {}, tkbSolverResult: { metrics: Object.assign({}, DU) } };
const ungVienKhongApi = clone(ungVien);
delete ungVienKhongApi.metrics.teacher_location_rule_debt;
check('Khong co TKBConstraints -> locationDebt NaN', Number.isNaN(api.teacherQualitySummary(ungVienKhongApi).locationDebt), true);
check('Khong co API: ung vien xau hon ve chat luong -> TU CHOI nhu cu',
  api.cherryCandidateStrictlyBetter(ungVienKhongApi, { metrics: Object.assign({}, DU) }), false);

// 6) Nut Toi uu v3 (mot muc tieu): sua duoc vi pham dia diem cung la tien bo.
win.TKBConstraints = { teacherLocationRuleDebt: (opts) => (opts && opts.lessons ? { sessions: 0, teachers: 0, cases: [] } : { sessions: 7, teachers: 3, cases: [] }) };
win.__TKB_ENGINE_FOCUS_MODE = 'optimize_gap1';
const ungVienFocus = clone(ungVien);
ungVienFocus.metrics = Object.assign({}, DU, CU); // chi so phu trach (trong 1) KHONG giam
delete ungVienFocus.metrics.teacher_location_rule_debt;
check('Toi uu v3 (trong 1): muc tieu khong giam nhung het 7 buoi vi pham dia diem -> NHAN',
  api.cherryCandidateStrictlyBetter(ungVienFocus, { metrics: Object.assign({}, DU) }), true);
win.__TKB_ENGINE_FOCUS_MODE = '';

// ---------------------------------------------------------------------------
// 26/08: hai lo hong da lam VO rang buoc dia diem cua truong 2kkn7c6y7l1
// (38 lop / 2 co so). Bam Cherry mot luot: 35 -> 45 buoi vi pham, mat 4 tiet,
// va ket qua VAN duoc ap + luu len server. Nguyen nhan: khoi kiem dia diem
// nam SAU hai nhanh thoat som cua cong.
// ---------------------------------------------------------------------------
win.TKBConstraints = savedTKBConstraints;
win.DATA = { tkb: {}, tkbSolverResult: { metrics: Object.assign({}, DU) } };
win.calcTeacherTKBStats = () => statsCua(CU);

// 7) Ung vien xep THEM tiet nhung TANG vi pham dia diem -> phai TU CHOI.
//    Truoc day nhanh `nextHandled > currentHandled` return true ngay.
visibleDebt = 35;
const lichCuThieuTiet = Object.assign({}, DU, CU, { scheduled_periods: 1900, unassigned_periods: 3 });
const ungVienThemTiet = clone(ungVien);
ungVienThemTiet.metrics = Object.assign({}, DU, CU, { scheduled_periods: 1903, unassigned_periods: 0 });
delete ungVienThemTiet.metrics.teacher_location_rule_debt;
ungVienThemTiet.lessons = [{ classId: 'L001', day: 2, session: 'AM', period: 1, subject: 'Toan', teacher: 'GV', __locDebt: 45 }];
check('Xep them 3 tiet nhung dia diem 35 -> 45: TU CHOI',
  api.cherryCandidateStrictlyBetter(ungVienThemTiet, { metrics: lichCuThieuTiet }), false);

// 8) Hau kiem (ignoreVisibleMetrics = luoi hien thi DA la ung vien): metrics
//    cua payload cu khong co so dia diem -> lay moc da chup ngay truoc luot
//    giai (__TKB_LOCATION_DEBT_BEFORE) thay vi im lang bo qua chieu nay.
win.TKBConstraints = {
  teacherLocationRuleDebt(opts) {
    if (opts && Array.isArray(opts.lessons)) {
      const n = opts.lessons.reduce((s, l) => s + (Number(l.__locDebt) || 0), 0);
      return { sessions: n, teachers: n ? 1 : 0, cases: [] };
    }
    return { sessions: 45, teachers: 21, cases: [] }; // luoi hien thi = ung vien
  },
};
win.__TKB_LOCATION_DEBT_BEFORE = 35;
const ungVienHauKiem = clone(ungVien);
ungVienHauKiem.metrics = Object.assign({}, DU, CU);
delete ungVienHauKiem.metrics.teacher_location_rule_debt;
ungVienHauKiem.lessons = [{ classId: 'L001', day: 2, session: 'AM', period: 1, subject: 'Toan', teacher: 'GV', __locDebt: 45 }];
check('Hau kiem: metrics cu thieu so dia diem -> dung moc 35 truoc luot giai, 45 > 35: TU CHOI',
  api.cherryCandidateStrictlyBetter(ungVienHauKiem, { metrics: Object.assign({}, DU, CU) }, { ignoreVisibleMetrics: true }), false);
check('visibleLocationRuleDebt roi ve moc truoc luot giai khi payload khong co so',
  api.visibleLocationRuleDebt({ metrics: Object.assign({}, DU, CU) }), 45);
win.__TKB_LOCATION_DEBT_BEFORE = NaN;

// 9) Cac nut NGOAI Cherry (Xep thuong / Toi uu / buoi le) cung khong duoc lam
//    tang vi pham dia diem — bo tu dien cua chung khong co chieu nay.
win.TKBConstraints = {
  teacherLocationRuleDebt(opts) {
    if (opts && Array.isArray(opts.lessons)) {
      const n = opts.lessons.reduce((s, l) => s + (Number(l.__locDebt) || 0), 0);
      return { sessions: n, teachers: n ? 1 : 0, cases: [] };
    }
    return { sessions: 35, teachers: 21, cases: [] };
  },
};
win.__TKB_FORCE_ENGINE = '';
const ungVienThuong = clone(ungVien);
ungVienThuong.metrics = Object.assign({}, DU, CU, { one_period_teacher_sessions: 0 });
delete ungVienThuong.metrics.teacher_location_rule_debt;
ungVienThuong.solver = { runtime_settings: {} };
ungVienThuong.lessons = [{ classId: 'L001', day: 2, session: 'AM', period: 1, subject: 'Toan', teacher: 'GV', __locDebt: 45 }];
check('candidateWorsensLocationRuleDebt: 35 -> 45 la xau di',
  api.candidateWorsensLocationRuleDebt(ungVienThuong, { metrics: Object.assign({}, DU, CU) }), true);
check('Nut khong phai Cherry: bot 1 tiet/buoi nhung dia diem 35 -> 45: TU CHOI',
  api.payloadStrictlyBetterTeacherQuality(ungVienThuong, { metrics: Object.assign({}, DU, CU) }, { optimization_focus: 'singletons' }), false);
const ungVienThuongSach = clone(ungVienThuong);
// teacherLocationRuleDebtOf() da ghi lai so cua luot truoc vao metrics — xoa di
// de ban sao nay duoc cham lai theo danh sach tiet cua chinh no.
delete ungVienThuongSach.metrics.teacher_location_rule_debt;
ungVienThuongSach.lessons = [{ classId: 'L001', day: 2, session: 'AM', period: 1, subject: 'Toan', teacher: 'GV', __locDebt: 35 }];
check('Nut khong phai Cherry: dia diem khong doi + bot 1 tiet/buoi: NHAN',
  api.payloadStrictlyBetterTeacherQuality(ungVienThuongSach, { metrics: Object.assign({}, DU, CU) }, { optimization_focus: 'singletons' }), true);
win.__TKB_FORCE_ENGINE = 'cherry';

console.log(`\n${pass} OK, ${fail} SAI`);
process.exit(fail ? 1 : 0);
