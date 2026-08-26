// 22/08: hai loi tren duong Cherry (tai hien tren production):
//  (1) "Backend da xep du 2193/2193 nhung khi ap vao giao dien chi con 2003"
//      — engine v3 khong khoa O CO DINH vi bridge khong gui
//      preserve_fixed_lessons_only -> 378 tiet roi vao o co dinh cua mon khac.
//  (2) Dong ho dung o giay 02 roi ~25 s sau moi chay: bo quet "thieu o" cuc bo
//      (teacherFixedOffCapacityWarnings, dong bo) chay truoc khi gui.
// Test tinh giu cho hai sua chua nay khong quay lai.
const fs = require('fs');

let pass = 0, fail = 0;
const check = (name, cond) => {
  console.log(`  ${cond ? 'OK  ' : 'SAI '} ${name}`);
  if (cond) pass++; else fail++;
};

const bridge = fs.readFileSync('web/pages/tkb-rust-bridge.js', 'utf8');

// (1) Khoi "forcedEngine" trong solveWithRustApi phai dat preserve_fixed_lessons_only.
const forcedStart = bridge.indexOf('const forcedEngine = String(window.__TKB_FORCE_ENGINE || "").trim().toLowerCase();');
const forcedEnd = bridge.indexOf('delete effectiveSettings.engine;', forcedStart);
const forcedBlock = forcedStart > 0 && forcedEnd > forcedStart ? bridge.slice(forcedStart, forcedEnd) : '';
check('co khoi forcedEngine', !!forcedBlock);
check('Cherry: effectiveSettings.preserve_fixed_lessons_only = true', /effectiveSettings\.preserve_fixed_lessons_only\s*=\s*true/.test(forcedBlock));
check('Cherry: van tat tu retry (ui_disable_automatic_retry)', /effectiveSettings\.ui_disable_automatic_retry\s*=\s*true/.test(forcedBlock));

// (2) confirmCapacityPrecheckBeforeSolve bo qua quet cuc bo khi co engine ep.
const capStart = bridge.indexOf('async function confirmCapacityPrecheckBeforeSolve(settings)');
const capEnd = bridge.indexOf('function incompleteSolveMessage', capStart);
const capBlock = capStart > 0 && capEnd > capStart ? bridge.slice(capStart, capEnd) : '';
check('co confirmCapacityPrecheckBeforeSolve', !!capBlock);
check('Cherry: bo qua teacherCapacityPrecheckMessage (forcedEngineRun)', /forcedEngineRun/.test(capBlock) && /\|\|\s*forcedEngineRun/.test(capBlock));
check('forcedEngineRun doc tu __TKB_FORCE_ENGINE', /__TKB_FORCE_ENGINE/.test(capBlock));

// (3) applyCapacityShortageAcceptedSettings (chay cho Cherry vi Cherry chap nhan
//     lich thieu) cung khong duoc goi bo quet 57 s.
const accStart = bridge.indexOf('function applyCapacityShortageAcceptedSettings(settings)');
const accEnd = bridge.indexOf('async function confirmCapacityPrecheckBeforeSolve', accStart);
const accBlock = accStart > 0 && accEnd > accStart ? bridge.slice(accStart, accEnd) : '';
check('co applyCapacityShortageAcceptedSettings', !!accBlock);
check('Cherry: shortageTotal bo qua quet khi forcedEngineRun', /if\(forcedEngineRun\) return 0;/.test(accBlock));
check('Cherry: forcedEngineRun duoc tinh truoc khi quet', accBlock.indexOf('const forcedEngineRun') > 0 && accBlock.indexOf('const forcedEngineRun') < accBlock.indexOf('return teacherCapacityPrecheckWarnings().reduce'));

// (4) 23/08 (chu du an: "toi uu la KHONG duoc vang tiet"): applyPayload phai ap
//     tiet o dung o CO DINH truoc, vi moi o co dinh mon S "tieu thu" tiet S dau
//     tien gap trong payload -> 20-24 tiet dau tuan bi roi moi luot (do tren
//     truong default), roi va nhanh dat lai tuy tien.
const applyStart = bridge.indexOf('async function applyPayload(payload, solveSettings)');
const applyEnd = bridge.indexOf('async function postSolve(settings, dataOverride, conflictRetry)', applyStart);
const applyBlock = applyStart > 0 && applyEnd > applyStart ? bridge.slice(applyStart, applyEnd) : '';
check('co applyPayload', !!applyBlock);
const orderAt = applyBlock.indexOf('payloadLessons = orderPayloadLessonsFixedFirst(payloadLessons,');
const consumeAt = applyBlock.indexOf('if(!fixedLock && consumeFixedSubject(classId, subject)) continue;');
check('applyPayload: sap tiet o o co dinh len TRUOC vong ap (truoc consumeFixedSubject)', orderAt > 0 && consumeAt > orderAt);
check('co ham orderPayloadLessonsFixedFirst', /function orderPayloadLessonsFixedFirst\(lessons, isAtFixedCell\)\{/.test(bridge));

console.log('');
console.log(fail === 0 ? 'TAT CA DAT' : fail + ' MUC SAI');
process.exit(fail === 0 ? 0 : 1);
