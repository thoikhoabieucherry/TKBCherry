// 22/08 (chi dao chu du an): nut ▶ "Sap xep tu dong" CHI chay FET trong trinh
// duyet de kiem tra xep du hay khong — khong doi sang solve_optimize_all,
// khong goi backend CP-SAT/Cloud Run, khong noi chuoi hau ky. Test nay giu
// cho hanh vi do khong quay lai. Chay: node tools/tests/play_fet_only_test.js
const fs = require('fs');

let pass = 0, fail = 0;
const check = (name, cond) => {
  console.log(`  ${cond ? 'OK  ' : 'SAI '} ${name}`);
  if (cond) pass++; else fail++;
};

const src = fs.readFileSync('web/pages/phanmon.js', 'utf8');
const html = fs.readFileSync('web/pages/sapxep.html', 'utf8');

// 1) Ham window.sapXepTuDongAll: chi goi executeDirectFastSchedule voi mode auto.
const start = src.indexOf('window.sapXepTuDongAll = async function');
check('co window.sapXepTuDongAll', start > 0);
const end = src.indexOf('window.sapXepTheoCheDo = async function', start);
const body = start > 0 && end > start ? src.slice(start, end) : '';
check('▶ goi executeDirectFastSchedule voi mode "auto"', /executeDirectFastSchedule\(\{\s*mode:\s*options\?\.mode\s*\|\|\s*"auto"\s*\}\)/.test(body));
check('▶ khong doi sang solve_optimize_all', !/solve_optimize_all/.test(body));
check('▶ khong goi bridgeSapXepTuDongAll (backend)', !/bridgeSapXepTuDongAll/.test(body));
check('▶ khong goi chuoi hau ky', !/tkbPostFetQualityChain\s*\(/.test(body));

// 2) Chuoi hau ky da go han (khong con dinh nghia, khong con loi goi).
check('khong con dinh nghia tkbPostFetQualityChain', !/async function tkbPostFetQualityChain/.test(src));
check('khong con loi goi tkbPostFetQualityChain()', !/tkbPostFetQualityChain\s*\(\s*\)/.test(src));

// 3) Nut ▶ trong HTML van goi sapXepTuDongAll() va xoa co engine.
check('sapxep.html: nut ▶ goi sapXepTuDongAll()', /id="btnAutoSort"[^>]*onclick="[^"]*sapXepTuDongAll\(\)"/.test(html));

console.log('');
console.log(fail === 0 ? 'TAT CA DAT' : fail + ' MUC SAI');
process.exit(fail === 0 ? 0 : 1);
