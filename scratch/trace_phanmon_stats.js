const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

globalThis.window = globalThis;
globalThis.location = { search: '', href: '' };
globalThis.localStorage = { getItem: () => '', setItem: () => {}, removeItem: () => {} };
globalThis.addEventListener = () => {};
globalThis.document = {
  documentElement: { clientHeight: 800, style: { setProperty: () => {} } },
  addEventListener: () => {},
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => []
};
globalThis.DATA = schoolData;
globalThis.DAYS = ["thu2","thu3","thu4","thu5","thu6","thu7"];
globalThis.SANG = 5;
globalThis.CHIEU = 5;

const phanmonCode = fs.readFileSync('web/pages/phanmon.js', 'utf8');
eval(phanmonCode + `
console.log("teacherCodes count:", _getAssignedTeacherCodes().size);
console.log("teacherCodes sample:", Array.from(_getAssignedTeacherCodes()).slice(0, 10));

const lops = Array.isArray(DATA.lop) ? DATA.lop : [];
console.log("lops count:", lops.length);

const classCanon = getLopCanonById(lops[0].id);
console.log("lops[0] id:", lops[0].id, "classCanon:", classCanon);

const gv = classAssignmentStatisticsTeacherForClassMon(classCanon, "Văn");
console.log("Teacher for 6A1 Văn:", gv);
`);
