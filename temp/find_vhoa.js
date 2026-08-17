const fs = require('fs');

const data = JSON.parse(fs.readFileSync("C:/Users/Love/Documents/Codex/temp/school_default.json", 'utf8'));
const tkb = data.tkb;
const pccm = data.pccmMatrix || {};
const lopList = data.lop || [];

const classIdToName = {};
const classNameToId = {};
for(const l of lopList){
  const cid = (l.id || "").toString().trim();
  const ten = (l.ten || "").toString().trim();
  if(cid && ten){
    classIdToName[cid] = ten;
    classNameToId[ten] = cid;
  }
}

function getTeacher(cid, mon){
  const ten = classIdToName[cid] || cid;
  return pccm[`${ten}|${mon}`] || pccm[`${cid}|${mon}`] || "";
}

// Find V.Hoa in gv list or pccm
console.log("=== SEARCHING FOR TEACHER V.HOA ===");
const gvList = data.giaovien || [];
let hoaKey = "";
for(const g of gvList){
  const name = (g.ten || g.name || g.id || "").toString();
  if(name.toLowerCase().includes("hoa") || name.toLowerCase().includes("v.hoa")){
    console.log("Found GV:", g);
    hoaKey = name.toLowerCase();
  }
}

// Print full week schedule of V.Hoa
const days = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
const sessions = ["sang", "chieu"];

console.log(`\n=== FULL SCHEDULE OF ${hoaKey.toUpperCase()} ===`);
for(const d of days){
  for(const s of sessions){
    const lessons = [];
    for(const [cid, cData] of Object.entries(tkb)){
      const cells = (cData[d] && cData[d][s]) || [];
      for(let p = 0; p < cells.length; p++){
        const cell = cells[p];
        if(!cell || cell === "OFF") continue;
        const mon = typeof cell === "object" ? cell.mon : cell;
        let gv = typeof cell === "object" ? (cell.gv || getTeacher(cid, mon)) : getTeacher(cid, mon);
        if(gv.toLowerCase().includes("v.hoa") || (hoaKey && gv.toLowerCase().includes(hoaKey))){
          lessons.push({ period: p + 1, class: classIdToName[cid] || cid, mon, fixed: typeof cell === "object" ? !!cell.fixed : false });
        }
      }
    }
    if(lessons.length > 0){
      lessons.sort((a,b) => a.period - b.period);
      const periods = lessons.map(l => l.period);
      const span = periods[periods.length - 1] - periods[0] + 1;
      const gaps = span - periods.length;
      console.log(`  ${d.toUpperCase()} ${s}: Periods ${JSON.stringify(periods)} (gap=${gaps}) |`, lessons);
    }
  }
}
