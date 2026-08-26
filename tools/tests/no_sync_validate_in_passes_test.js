// 22/08: Cherry "giat / do" — nguyen nhan la TKBConstraints.validateAll()
// (quet toan truong 1-3 s, DONG BO) bi goi trong tung lan thu doi o cua cac
// pass hau kiem va trong handler ket thuc cua bridge. Test nay giu cho cac
// loi goi dong bo do khong quay lai. Chay: node tools/tests/no_sync_validate_in_passes_test.js
const fs = require('fs');

let pass = 0, fail = 0;
const check = (name, cond) => {
  console.log(`  ${cond ? 'OK  ' : 'SAI '} ${name}`);
  if (cond) pass++; else fail++;
};

const phanmon = fs.readFileSync('web/pages/phanmon.js', 'utf8');
const bridge = fs.readFileSync('web/pages/tkb-rust-bridge.js', 'utf8');
const constraints = fs.readFileSync('web/pages/tkb-constraints.js', 'utf8');

function fnBody(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  if (s < 0) return null;
  const e = src.indexOf(endMarker, s + startMarker.length);
  return e < 0 ? src.slice(s) : src.slice(s, e);
}

// 1) Cac pass hau kiem: khong con validateAll( dong bo.
const passes = [
  ['tkbAutoRepairEnsureLessonPairs', 'async function tkbAutoRepairEnsureLessonPairs', 'function tkbAutoPlaceUnassignedLessons'],
  ['tkbPairDeepFixCase', 'async function tkbPairDeepFixCase', 'async function tkbAutoRepairEnsureLessonPairs'],
  ['tkbAutoRepairTeacherQuality', 'async function tkbAutoRepairTeacherQuality', 'async function tkbAutoRepairConstraintViolations'],
  ['tkbAutoRepairConstraintViolations', 'async function tkbAutoRepairConstraintViolations', 'function tkbLoneSingleCases'],
  ['tkbAutoRepairAestheticPairs', 'async function tkbAutoRepairAestheticPairs', 'window.__tkbAutoRepairAestheticPairs'],
  ['tkbAutoRepairGap1Balance', 'async function tkbAutoRepairGap1Balance', 'function tkbConstraintAuditRows'],
];
for (const [name, start, end] of passes) {
  const body = fnBody(phanmon, start, end);
  check(`${name}: ton tai`, !!body);
  check(`${name}: khong goi validateAll( dong bo`, !!body && !/validateAll\(/.test(body));
}
check('co helper tkbVioScanAsync (validateAllAsync chia lat)', /async function tkbVioScanAsync[\s\S]*validateAllAsync\(/.test(phanmon));
check('co helper tkbVioScopedOk dung validateClasses', /function tkbVioScopedOk[\s\S]*validateClasses/.test(phanmon));
check('co xac nhan toan truong + hoan tac (tkbVioConfirmMove)', /async function tkbVioConfirmMove[\s\S]*tkbGridRestore\(snapshot\)/.test(phanmon));
check('tkbTryMoveCellWithFallback truyen classId cho acceptFn', /acceptFn\(classId\)\) return "swap"/.test(phanmon) && /acceptFn\(classId\)\) return "tri"/.test(phanmon));

// 2) tkb-constraints.js: co validateClasses va export.
check('tkb-constraints: dinh nghia validateClasses', /function validateClasses\(classIds, maxItems\)/.test(constraints));
check('tkb-constraints: export validateClasses', /validateAllAsync,validateClasses,/.test(constraints));

// 3) Bridge: handler ket thuc dung ban chia lat.
check('bridge: sau hau kiem dung currentConstraintViolationsAsync(500', /currentConstraintViolationsAsync\(500, \{allowSyncFallback:false, ignoreStop:true\}\)/.test(bridge));
check('bridge: khong con validateAll?.(500) dong bo sau hau kiem', !/validateAll\?\.\(500\)/.test(bridge));

console.log('');
console.log(fail === 0 ? 'TAT CA DAT' : fail + ' MUC SAI');
process.exit(fail === 0 ? 0 : 1);
