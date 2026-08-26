// 23/08: bam Cherry tren lich DA DU. Sau khi solveWithRustApi da AP lich tot hon
// (cong cherryCandidateStrictlyBetter so voi luoi dang hien thi = lich cu), buoc
// hau kiem refinementStatisticsImproved (nhanh refine_complete trong
// bridgeSapXepTuDongAll) phai CONG NHAN cai thien. Truoc 23/08 no goi lai cung
// cong do khi luoi hien thi DA LA ung vien -> so ung vien voi chinh no -> "khong
// tot hon" -> restoreUnimprovedRefinementSnapshot hoan tac lich vua ap.
// Chay: node tools/tests/cherry_reclick_keep_test.js
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
for (const fn of ['refinementStatisticsImproved', 'cherryCandidateStrictlyBetter', 'payloadStrictlyBetterTeacherQuality']) {
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

// So lieu kieu THCS Dong Den (xem cherry_quality_gate_test.js).
const CU = { teacher_sessions: 817, one_period_teacher_sessions: 152, teacher_gap2_sessions: 23, gap_distribution: { 0: 522, 1: 120, 2: 23 } };
const MOI = { teacher_sessions: 753, one_period_teacher_sessions: 4, teacher_gap2_sessions: 0, gap_distribution: { 0: 572, 1: 181 } };
const DU = { expected_periods: 2103, scheduled_periods: 2103, unassigned_periods: 0, app_constraint_violation_count: 0, hard_ok: true, core_hard_ok: true };
// calcTeacherTKBStats cua phanmon.js tinh tu LUOI SONG (DATA.tkb).
const statsCua = q => ({
  tsBuoiDay: q.teacher_sessions,
  soBuoiDay1: q.one_period_teacher_sessions,
  soBuoiTrong1: (q.gap_distribution && q.gap_distribution[1]) || 0,
  soBuoiTrong2: (q.gap_distribution && q.gap_distribution[2]) || 0,
});
const clone = v => JSON.parse(JSON.stringify(v));

// incumbentPayloadBeforeAutoSort: visibleCompleteIncumbentQualityPayload da chup
// so lieu lich cu TRUOC luot giai.
const lichCu = { metrics: Object.assign({}, DU, CU), solver: { runtime_settings: {} } };
// Ung vien Cherry da duoc ap (DATA.tkbSolverResult), metrics do may chu tinh.
const ungVien = {
  metrics: Object.assign({}, DU, MOI),
  solver: { runtime_settings: { engine_route: 'cherry_engine_v3', engine_requested: 'cherry' } },
};

const win = sandbox.window;
win.__TKB_FORCE_ENGINE = 'cherry';

// 1) SAU KHI AP: luoi hien thi = ung vien. Hau kiem phai cong nhan cai thien.
win.DATA = { tkb: {}, tkbSolverResult: ungVien };
win.calcTeacherTKBStats = () => statsCua(MOI);
check('Sau khi ap lich tot hon: hau kiem CONG NHAN (khong hoan tac)',
  api.refinementStatisticsImproved(ungVien, lichCu, true, { optimization_focus: 'automatic' }), true);

// 2) May chu khong cai thien (ung vien = lich cu) -> khong cong nhan -> giu lich cu.
const ungVienBang = clone(ungVien);
ungVienBang.metrics = Object.assign({}, DU, CU);
win.DATA = { tkb: {}, tkbSolverResult: ungVienBang };
win.calcTeacherTKBStats = () => statsCua(CU);
check('Ung vien bang lich cu -> khong cong nhan',
  api.refinementStatisticsImproved(ungVienBang, lichCu, true, {}), false);

// 3) Ung vien xau hon (neu lot qua cong) -> hau kiem van tu choi de hoan tac.
const ungVienXau = clone(ungVien);
ungVienXau.metrics.one_period_teacher_sessions = 200;
win.DATA = { tkb: {}, tkbSolverResult: ungVienXau };
win.calcTeacherTKBStats = () => statsCua(ungVienXau.metrics);
check('Ung vien xau hon (buoi 1 tiet 152 -> 200) -> khong cong nhan',
  api.refinementStatisticsImproved(ungVienXau, lichCu, true, {}), false);

// 4) Cong TRUOC khi ap (solveWithRustApi) van phai doc LUOI DANG HIEN THI (lich
//    cu), ke ca khi payload cu thieu so lieu chat luong.
win.DATA = { tkb: {}, tkbSolverResult: { metrics: Object.assign({}, DU) } };
win.calcTeacherTKBStats = () => statsCua(CU);
check('Truoc khi ap: ung vien tot hon luoi hien thi -> nhan',
  api.cherryCandidateStrictlyBetter(ungVien, { metrics: Object.assign({}, DU) }), true);
const ungVienNhuLuoi = { metrics: Object.assign({}, DU, CU), solver: ungVien.solver };
check('Truoc khi ap: ung vien y het luoi hien thi -> tu choi',
  api.cherryCandidateStrictlyBetter(ungVienNhuLuoi, { metrics: Object.assign({}, DU) }), false);

// 5) Nut thuong (khong phai Cherry): luat cu giu nguyen.
win.__TKB_FORCE_ENGINE = '';
win.__TKB_LAST_REQUESTED_ENGINE = '';
const thuong = clone(ungVien);
delete thuong.solver;
win.DATA = { tkb: {}, tkbSolverResult: thuong };
win.calcTeacherTKBStats = () => statsCua(MOI);
check('Nut thuong: gap1 tang 120 -> 181 van bi tu choi nhu cu',
  api.refinementStatisticsImproved(thuong, lichCu, true, {}), false);
const thuongTot = clone(thuong);
thuongTot.metrics.gap_distribution = { 0: 650, 1: 100 };
win.DATA = { tkb: {}, tkbSolverResult: thuongTot };
win.calcTeacherTKBStats = () => statsCua(thuongTot.metrics);
check('Nut thuong: moi chi so tot hon -> cong nhan',
  api.refinementStatisticsImproved(thuongTot, lichCu, true, {}), true);

// 6) (23/08, muc B) Luot engine v3: vong % theo THOI GIAN ngan sach (khong theo
//    muc tieu 0), so lieu thuc o nhan metricLabel engine gui.
if (typeof api.progressUsesWorkMetrics === 'function') {
  win.__TKB_FORCE_ENGINE = 'cherry';
  check('Luot engine v3: progressUsesWorkMetrics=false du ui_progress_mode=work',
    api.progressUsesWorkMetrics({ ui_progress_mode: 'work', ui_requested_solve_mode: 'gap1' }), false);
  win.__TKB_FORCE_ENGINE = '';
  check('Nut thuong: ui_progress_mode=work van dung so lieu (work)',
    api.progressUsesWorkMetrics({ ui_progress_mode: 'work', ui_requested_solve_mode: 'gap1' }), true);
} else {
  console.log('  SAI  khong lay duoc progressUsesWorkMetrics tu test hooks');
  fail++;
}

// 7) (23/08, "khong duoc vang tiet") orderPayloadLessonsFixedFirst: tiet o o co
//    dinh len truoc, thu tu con lai giu nguyen, khong mat tiet nao.
if (typeof api.orderPayloadLessonsFixedFirst === 'function') {
  const lessons = [
    { id: 'a', subject: 'KHTN', period: 3 },   // dau tuan, o thuong
    { id: 'b', subject: 'Văn', period: 1 },
    { id: 'c', subject: 'KHTN', period: 5, fixed: true },  // o co dinh
    { id: 'd', subject: 'Anh', period: 2 },
  ];
  const ordered = api.orderPayloadLessonsFixedFirst(lessons, l => l.fixed === true);
  check('tiet o o co dinh duoc ap truoc', ordered[0] && ordered[0].id === 'c', true);
  check('khong mat tiet, thu tu con lai giu nguyen',
    ordered.map(l => l.id).join(','), 'c,a,b,d');
  check('khong co callback -> giu nguyen thu tu',
    api.orderPayloadLessonsFixedFirst(lessons).map(l => l.id).join(','), 'a,b,c,d');
} else {
  console.log('  SAI  khong lay duoc orderPayloadLessonsFixedFirst tu test hooks');
  fail++;
}

// 8) (23/08, chu du an: "nut v3 phai tap trung giam dung noi dung no phu trach")
//    Luot mot muc tieu: chi AP khi chi so phu trach giam; chi so uu tien cao hon
//    khong duoc xau di; chi so thap hon duoc phep doi. Thong bao neu ro muc tieu.
{
  win.DATA = { tkb: {}, tkbSolverResult: { metrics: Object.assign({}, DU) } };
  win.calcTeacherTKBStats = () => statsCua(CU);   // luoi hien thi = lich cu
  const cu = { metrics: Object.assign({}, DU) };
  const mk = q => ({ metrics: Object.assign({}, DU, q), solver: ungVien.solver });
  win.__TKB_ENGINE_FOCUS_MODE = 'optimize_singletons';
  check('1 tiet/buoi: chi bot buoi day (152 -> 152, buoi 817 -> 700) -> KHONG ap',
    api.cherryCandidateStrictlyBetter(mk({ teacher_sessions: 700, one_period_teacher_sessions: 152, teacher_gap2_sessions: 23, gap_distribution: { 0: 522, 1: 120, 2: 23 } }), cu), false);
  check('1 tiet/buoi: giam 152 -> 140 du trong 1 tang -> AP',
    api.cherryCandidateStrictlyBetter(mk({ teacher_sessions: 817, one_period_teacher_sessions: 140, teacher_gap2_sessions: 23, gap_distribution: { 0: 500, 1: 200, 2: 23 } }), cu), true);
  const msg = api.noBetterScheduleStatus({ solver: { engine_v3: { quality_unavoidable: [
    { kind: 'one_period', teacher: 'Nhạc.Dương', day: 3, session: 'PM', why_label: 'GV Nhạc.Dương chỉ dạy 1 tiết. Buổi chỉ còn đúng 1 ô hợp lệ.' },
  ] } } });
  console.log('     thong bao:', msg);
  check('Thong bao nut 1 tiet/buoi neu ro muc tieu + hien trang + ly do',
    /^1 tiết\/buổi: không giảm được thêm \(hiện 152\)\. Không gỡ được: Nhạc\.Dương Thứ 3 chiều: GV Nhạc\.Dương chỉ dạy 1 tiết\. Buổi chỉ còn đúng 1 ô hợp lệ\./.test(msg)
    && /Lịch giữ nguyên\.$/.test(msg), true);
  win.__TKB_ENGINE_FOCUS_MODE = 'optimize_gap1';
  check('1 tiet trong: giam trong 1 nhung tang buoi day -> KHONG ap',
    api.cherryCandidateStrictlyBetter(mk({ teacher_sessions: 900, one_period_teacher_sessions: 152, teacher_gap2_sessions: 23, gap_distribution: { 0: 600, 1: 100, 2: 23 } }), cu), false);
  check('1 tiet trong: giam trong 1, buoi/buoi le/trong 2 giu nguyen -> AP',
    api.cherryCandidateStrictlyBetter(mk({ teacher_sessions: 817, one_period_teacher_sessions: 152, teacher_gap2_sessions: 23, gap_distribution: { 0: 542, 1: 100, 2: 23 } }), cu), true);
  win.__TKB_ENGINE_FOCUS_MODE = '';
  check('Khong co focus (Cherry): tot deu -> van ap nhu cu',
    api.cherryCandidateStrictlyBetter(mk({ teacher_sessions: 700, one_period_teacher_sessions: 152, teacher_gap2_sessions: 23, gap_distribution: { 0: 522, 1: 120, 2: 23 } }), cu), true);
}

console.log('');
console.log(fail === 0 ? 'TAT CA DAT' : fail + ' MUC SAI');
process.exit(fail === 0 ? 0 : 1);
