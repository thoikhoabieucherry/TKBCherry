const fs = require('fs');

const data = JSON.parse(fs.readFileSync("C:/Users/Love/Documents/Codex/temp/school_default_gap7.json", 'utf8'));
const tkb = data.tkb;
const pccm = data.pccmMatrix || {};

const targetGvs = ["t.phương", "t.phát", "tn.nữ", "ti.hào"];

console.log("=== INSPECTING RESIDUAL TEACHERS IN TKB SNAPSHOT ===");
for(const gv of targetGvs){
  console.log(`\n--- GV: ${gv} ---`);
  const days = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
  const sessions = ["sang", "chieu"];
  for(const d of days){
    for(const s of sessions){
      const lessons = [];
      for(const [cid, cData] of Object.entries(tkb)){
        const cells = (cData[d] && cData[d][s]) || [];
        for(let p = 0; p < cells.length; p++){
          const cell = cells[p];
          if(!cell) continue;
          let cellGv = typeof cell === "object" ? (cell.gv || "") : "";
          const mon = typeof cell === "object" ? (cell.mon || "") : cell;
          if(!cellGv && mon){
            cellGv = pccm[`${cid}|${mon}`] || "";
          }
          if(cellGv.toLowerCase().includes(gv)){
            lessons.push({ period: p + 1, class: cid, mon, fixed: cell.fixed, duration: cell.duration || 1 });
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
}
