// 22/08: tiet khong xep duoc vi rang buoc -> "Chua phan" KEM LY DO + HUONG XU LY.
// Kiem tra (1) bang ma ly do trong phanmon.js, (2) bridge gom unassignedLessons
// theo ly do cho dong trang thai / nhat ky Loi.
// Chay: node tools/tests/unassigned_reason_test.js
const fs = require('fs');
const vm = require('vm');

const noop = () => {};
function sandboxFor() {
  const sb = {
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
  sb.window = sb; sb.self = sb; sb.globalThis = sb;
  return sb;
}

let pass = 0, fail = 0;
const check = (name, got, want) => {
  if (got === want) { console.log('  OK  ', name); pass++; }
  else { console.log('  SAI ', name, '| nhan:', JSON.stringify(got), '| can:', JSON.stringify(want)); fail++; }
};

// (1) Bang ma ly do: trich phan khai bao tu phanmon.js (file qua lon va phu
//     thuoc DOM de nap nguyen ven trong vm).
const phanmon = fs.readFileSync('web/pages/phanmon.js', 'utf8');
const start = phanmon.indexOf('window.TKB_UNASSIGNED_REASON_INFO = {');
const end = phanmon.indexOf('window.tkbUnassignedReasonInfo = tkbUnassignedReasonInfo;');
check('phanmon.js co bang ly do + ham tkbUnassignedReasonInfo', start > 0 && end > start, true);
const reasonSb = sandboxFor();
vm.createContext(reasonSb);
vm.runInContext(phanmon.slice(start, end + 'window.tkbUnassignedReasonInfo = tkbUnassignedReasonInfo;'.length), reasonSb, { filename: 'phanmon-reasons.js' });
const infoFn = reasonSb.window.tkbUnassignedReasonInfo;
check('not_enough_available_slots (GV) -> Thieu cho xep (GV het o trong)',
  infoFn('not_enough_available_slots', 'Khong du o day cua giao vien sau khi ap dung tiet nghi/rang buoc.').label,
  'Thiếu chỗ xếp (GV hết ô trống)');
check('not_enough_available_slots (lop) -> Thieu cho xep (lop het o hoc)',
  infoFn('not_enough_available_slots', 'Khong du o hoc sau khi ap dung tiet nghi/rang buoc cua lop.').label,
  'Thiếu chỗ xếp (lớp hết ô học)');
check('engine_v3_best_effort co huong xu ly nhac bam Cherry', /Cherry/.test(infoFn('engine_v3_best_effort', '').hint), true);
check('ma la -> nhan mac dinh kem ma', infoFn('weird_code', '').label, 'Chưa xếp được (weird_code)');
check('khong co ma -> nhan mac dinh', infoFn('', '').label, 'Chưa xếp được');
// 22/08 (toi): Cherry bac 4 — tiet dua ra de GV het buoi 1 tiet / trong >= 2,
// goi y cu the cua bo giai di TRUOC huong xu ly chung.
const ejectMsg = 'GV T.Trung chỉ dạy 1 tiết (Toán 7A3) trong buổi Thứ 3 chiều. Gợi ý: bớt tiết nghỉ của GV T.Trung (đang nghỉ 14 ô).';
const ejectInfo = infoFn('teacher_quality_unreachable', ejectMsg);
check('teacher_quality_unreachable -> nhan "Đưa ra để GV không còn buổi 1 tiết / trống ≥2"',
  ejectInfo.label, 'Đưa ra để GV không còn buổi 1 tiết / trống ≥2');
check('teacher_quality_unreachable: goi y cu the cua bo giai dung dau hint', ejectInfo.hint.startsWith(ejectMsg), true);
check('teacher_quality_unreachable: van co huong xu ly chung (Cố định)', /Cố định/.test(ejectInfo.hint), true);
check('teacher_quality_unreachable khong co message -> hint chung', /Cherry đã thử hết cách/.test(infoFn('teacher_quality_unreachable', '').hint), true);

// (2) Bridge gom theo ly do.
const bridgeSb = sandboxFor();
bridgeSb.window.__TKB_E2E_EXPOSE_TEST_HOOKS = true;
bridgeSb.window.tkbUnassignedReasonInfo = infoFn;
vm.createContext(bridgeSb);
vm.runInContext(fs.readFileSync('web/pages/tkb-rust-bridge.js', 'utf8'), bridgeSb, { filename: 'tkb-rust-bridge.js' });
const breakdown = (bridgeSb.window.__TKB_RUST_BRIDGE_TEST_HOOKS || {}).unassignedReasonBreakdown;
check('bridge expose unassignedReasonBreakdown', typeof breakdown, 'function');
const payload = {
  unassignedLessons: [
    { className: '8A18', subject: 'Ngữ văn', teacher: 'V.Bình', periods: 1, reason: 'not_enough_available_slots', message: 'Khong du o day cua giao vien sau khi ap dung tiet nghi/rang buoc.' },
    { className: '7A3', subject: 'Toán', teacher: 'T.Trung', periods: 2, reason: 'not_enough_available_slots', message: 'Khong du o day cua giao vien sau khi ap dung tiet nghi/rang buoc.' },
    { className: '6A1', subject: 'Anh', teacher: 'A.Ngân', periods: 3, reason: 'engine_v3_best_effort', message: 'Engine v3 chua xep duoc mot so tiet trong ngan sach thoi gian' },
  ],
};
const out = breakdown(payload);
check('gom dung so tiet theo nhom', /3 tiết thiếu chỗ xếp \(GV hết ô trống\) \(V\.Bình, T\.Trung\)/.test(out.text), true);
check('nhom het thoi gian co mat', /3 tiết hết thời gian/.test(out.text), true);
check('huong xu ly lay tu nhom dau tien', /bớt tiết nghỉ/.test(out.hint), true);
check('payload khong co unassigned -> rong', breakdown({}).text, '');

console.log('');
console.log(fail === 0 ? 'TAT CA DAT' : fail + ' MUC SAI');
process.exit(fail === 0 ? 0 : 1);
