// Khoa hanh vi cua nut "2 tiet trong" sau ban sua 20/08:
//   - co TRAN buoi-1-tiet (vay) -> gap2 la muc tieu tuyet doi, veto phai tat
//   - khong co tran -> giu nguyen luat cu (gap2 giam ma s1 tang thi tu choi)
//   - vuot tran -> luon thua
//   - pha tra no bi KHOA gap2 -> khong duoc lam gap2 phinh tro lai
//   - operator moi tryGap2EjectWithCompanion co ton tai va co hang rao toan ven
const path = require('path');
global.self = global;
require(path.resolve(__dirname, '../../web/pages/tkb-fet-engine.js'));
const Engine = global.FetTimetableEngine;

let pass = 0, fail = 0;
const check = (name, got, want) => {
  if (got === want) { console.log('  OK   ', name); pass++; }
  else { console.log('  SAI  ', name, '| nhan:', got, '| can:', want); fail++; }
};

const eng = Object.create(Engine.prototype);
const M = (s1, g2, extra) => Object.assign({
  soBuoiDay1: s1, soBuoiTrong2: g2, tsBuoiDay: 100, soBuoiTrong1: 5, tsNgayDay: 50, soNgayMotTiet: 0
}, extra || {});

const base = M(10, 3);
const cheaperGap2 = M(11, 2);   // gap2 -1 nhung s1 +1

eng.__stageLocks = null;
check('khong tran: gap2 giam ma s1 tang -> tu choi',
  eng.compareMetrics(cheaperGap2, base, 'optimize_gap2') > 0, true);

eng.__stageLocks = { soBuoiDay1: 11 };
check('co tran (vay 1): gap2 giam thang du s1 tang',
  eng.compareMetrics(cheaperGap2, base, 'optimize_gap2') < 0, true);
check('vuot tran thi luon thua du gap2 = 0',
  eng.compareMetrics(M(12, 0), base, 'optimize_gap2') > 0, true);
check('duoi tran, gap2 bang nhau thi s1 thap hon thang',
  eng.compareMetrics(M(9, 3), base, 'optimize_gap2') < 0, true);

eng.__stageLocks = { soBuoiTrong2: 3 };
check('pha tra no: giam s1 nhung lam phinh gap2 -> tu choi',
  eng.compareMetrics(M(5, 4), base, 'optimize_singletons') > 0, true);
check('pha tra no: giam s1 ma giu gap2 -> nhan',
  eng.compareMetrics(M(5, 3), base, 'optimize_singletons') < 0, true);

check('operator moi ton tai',
  typeof Engine.prototype.tryGap2EjectWithCompanion, 'function');

// Hang rao toan ven boc operator: qua han thi tra null, khong dung toi state
const guarded = Object.create(Engine.prototype);
guarded.opDeadlineMs = Date.now() - 1;
check('operator moi nam trong hang rao toan ven (qua han -> null)',
  guarded.tryGap2EjectWithCompanion({}, {}, 'optimize_gap2', null), null);

console.log(fail === 0 ? '\nTAT CA DAT' : `\nCO ${fail} MUC SAI`);
process.exit(fail === 0 ? 0 : 1);
