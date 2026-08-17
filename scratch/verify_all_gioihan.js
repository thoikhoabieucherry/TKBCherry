const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;
const engine = new FetTimetableEngine(schoolData);
engine.solve();

const snap = engine.getSnapshotTKB();
const DAYS = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
const SESSIONS = ["sang", "chieu"];

let gioihanViolations = [];

for(const lop of schoolData.lop || []){
  const cid = String(lop.id || "");
  const classCanon = lop.ten2 || lop.ten || cid;
  const cTkb = snap[cid] || {};

  for(const d of DAYS){
    for(const b of SESSIONS){
      const arr = cTkb[d]?.[b] || [];
      const countByMon = {};
      for(let p = 0; p < arr.length; p++){
        const cell = arr[p];
        const m = (cell && typeof cell === 'object') ? (cell.mon || '') : (cell || '');
        if(m && m !== "OFF" && m !== "Nghỉ"){
          countByMon[m] = (countByMon[m] || 0) + 1;
        }
      }

      for(const [mon, cnt] of Object.entries(countByMon)){
        const limit = engine.getSubjectSessionLimit(lop, mon);
        if(cnt > limit){
          gioihanViolations.push(`${classCanon} ${d} ${b}: môn ${mon} có ${cnt} tiết (giới hạn ${limit})`);
        }
      }
    }
  }
}

console.log(`\n=== KIỂM TRA GIỚI HẠN SỐ TIẾT / BUỔI (GIOIHAN TỪ PCCM) ===`);
console.log(`Tổng số vi phạm giới hạn buổi: ${gioihanViolations.length}`);
if(gioihanViolations.length > 0){
  gioihanViolations.slice(0, 10).forEach(v => console.log("  Vi phạm:", v));
}else{
  console.log("HOÀN HẢO: 100% tất cả các môn trong mọi buổi đều tuân thủ chính xác giới hạn gioihan!");
}
