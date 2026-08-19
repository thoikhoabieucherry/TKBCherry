const fs = require('fs');

const dataStr = fs.readFileSync('../solver_runtime/src/tkb_optimizer_ref/base_179_session_hint.json', 'utf8');
const data = JSON.parse(dataStr);

let singletons = 0;
const tkb = data.tkb;
const GV = new Set();
for(const thu in tkb) {
  for(const buoi of ["sang", "chieu"]) {
    if(!tkb[thu][buoi]) continue;
    // Gộp tiết
    const slots = tkb[thu][buoi];
    const teachers_in_session = {};
    slots.forEach((tiet, tietIdx) => {
      if(!tiet) return;
      tiet.forEach(cell => {
         if(cell.gv) {
             GV.add(cell.gv);
             if(!teachers_in_session[cell.gv]) teachers_in_session[cell.gv] = [];
             teachers_in_session[cell.gv].push(tietIdx);
         }
      });
    });
    for(const gv in teachers_in_session) {
       if(teachers_in_session[gv].length === 1) singletons++;
    }
  }
}
console.log("Total 1 tiet/buoi:", singletons);
