const fs = require('fs');
const code = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
const data = JSON.parse(fs.readFileSync('scratch/school_95671c41791.json', 'utf8'));

eval(code);

FetTimetableEngine.prototype.getCanonMonKey = function(mon){
  if(!mon) return '';
  let s = this.removeDiacritics(mon).toLowerCase();
  s = s.replace(/\s+\d+$/, '').trim();
  s = s.replace(/[\s\-_,]+/g, ' ');

  if(['tin hoc quoc te', 'tin quoc te', 'tin hoc qt', 'tin qt', 'tinqt', 'tinhocquocte', 'tin-qt', 'tin_qt'].includes(s)) return 'tinqt';
  if(['tieng anh tang cuong', 'anh tang cuong', 'tieng anh tc', 'anh tc', 'ta tc', 'tatc', 'tienganhtangcuong'].includes(s)) return 'tatc';
  if(['tieng anh ban ngu', 'anh ban ngu', 'tieng anh bn', 'anh bn', 'ta bn', 'tabn', 'tienganhbanngu'].includes(s)) return 'tabn';
  if(['tieng anh tai nang', 'tieng anh tk', 'anh tk', 'ta tk', 'tatk', 'anh tai nang', 'tienganhtk'].includes(s)) return 'tatk';
  if(['ky nang song', 'kynangsong', 'kn song', 'kns'].includes(s)) return 'kns';
  if(['giao duc stem', 'gd stem', 'stem', 'giaoducstem'].includes(s)) return 'stem';
  if(['chao co', 'cc', 'shdc', 'sinh hoat duoi co', 'shl', 'sinh hoat lop', 'sinh hoat', 'tnhn', 'hdtn', 'hdtn hn', 'hdtn/hn', 'hoat dong trai nghiem', 'hoat dong trai nghiem huong nghiep', 'hoat dong trai nghiem va huong nghiep', 'trai nghiem', 'huong nghiep', 'tn hn', 'tnhn,hn'].includes(s)) return 'hdtn';
  if(['lich su va dia ly', 'lich su va dia li', 'lich su dia ly', 'ls dl', 'ls&dl', 'lsdl', 'su dia', 'sd'].includes(s)) return 'lsdl';
  if(['khoa hoc tu nhien', 'khtn', 'khoahoctunhien'].includes(s)) return 'khtn';
  if(['giao duc the chat', 'the duc', 'gdtc', 'td', 'giaoducthechat'].includes(s)) return 'gdtc';
  if(['giao duc cong dan', 'gdcd', 'gd', 'giaoduccongdan', 'cong dan'].includes(s)) return 'gdcd';
  if(['giao duc dia phuong', 'gddp', 'noi dung giao duc dia phuong', 'dia phuong', 'dp', 'giaoducdiaphuong'].includes(s)) return 'gddp';
  if(['tin hoc', 'tin', 'tinhoc'].includes(s)) return 'tin';
  if(['cong nghe', 'cn', 'congnghe', 'cnghe'].includes(s)) return 'cn';
  if(['my thuat', 'mi thuat', 'mt', 'mythuat', 'mithuat', 'nghe thuat mi thuat', 'nghe thuat my thuat'].includes(s)) return 'mt';
  if(['am nhac', 'nhac', 'an', 'amnhac', 'nghe thuat am nhac'].includes(s)) return 'nhac';
  if(['ngu van', 'van', 'va', 'nguvan'].includes(s)) return 'van';
  if(['tieng anh', 'ngoai ngu 1', 'ngoai ngu', 'nngu', 'nn', 'anh', 'av', 'ta', 'tienganh', 'ngoaingu'].includes(s)) return 'anh';
  if(['toan', 'to', 'toanhoc'].includes(s)) return 'toan';

  return s;
};

const engine = new FetTimetableEngine(data);
engine.solve();

const u = engine.activities.find(a => engine.actPlacement[a.id] < 0 && a.classCanon === '9/10');

// Debug getConflictsForSlot for slot 30
const slot = 30;
const dIdx = Math.floor(slot/10);
const sIdx = Math.floor((slot%10)/5);
const pIdx = (slot%10)%5;
const buoi = sIdx === 0 ? 'sang' : 'chieu';

console.log('Class ca:', u.lop?.ca, 'buoi:', buoi);

// Step by step
const conflictsSet = new Set();
for(let d = 0; d < u.duration; d++){
  const s = slot + d;
  console.log('offSlots:', engine.offSlots.has(`${u.classId}|${s}`));
  console.log('fixedSlots:', engine.fixedSlots.has(`${u.classId}|${s}`));
  const existingActId = engine.classGrid.get(u.classId)[s];
  console.log('existingActId:', existingActId);
  if(existingActId >= 0 && existingActId !== u.id){
    conflictsSet.add(existingActId);
  }
}
console.log('conflictsSet:', Array.from(conflictsSet));

// Check subjectOffSlots
console.log('subjectOffSlots count:', engine.subjectOffSlots.size);
for(const k of engine.subjectOffSlots) {
  if(k.startsWith('tin') || k.includes('30')) console.log('subjectOffSlot:', k);
}
