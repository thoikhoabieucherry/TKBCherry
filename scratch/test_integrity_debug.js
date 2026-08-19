const fs = require('fs');
global.self = global;
require('c:/Users/Love/Documents/Codex/TKBCherry/web/pages/tkb-fet-engine.js');
const Engine = global.FetTimetableEngine;

const data = JSON.parse(fs.readFileSync('c:/Users/Love/Documents/Codex/TKBCherry/scratch/live_default.json', 'utf8'));
const eng = new Engine(data, { uiBreathingMs: 0 });

// Verbose verifyPlacementIntegrity
eng.verifyPlacementIntegrityVerbose = function() {
  const teacherSeen = new Map();
  for(let id = 0; id < this.activities.length; id++){
    const act = this.activities[id];
    const slot = this.actPlacement[id];
    if(slot < 0) {
      console.log(`[VIOLATION] Unplaced activity: id=${id}, class=${act.classId}, mon=${act.mon}`);
      return false;
    }
    const cg = this.classGrid.get(act.classId);
    if(!cg) {
      console.log(`[VIOLATION] Missing classGrid for class=${act.classId}`);
      return false;
    }
    for(let d = 0; d < act.duration; d++){
      const s = slot + d;
      if(cg[s] !== id) {
        console.log(`[VIOLATION] Class slot mismatch: actId=${id}, cg[${s}]=${cg[s]}`);
        return false;
      }
      if(this.offSlots.has(`${act.classId}|${s}`)) {
        console.log(`[VIOLATION] Class off slot: class=${act.classId}, slot=${s}`);
        return false;
      }
      if(this.fixedSlots.has(`${act.classId}|${s}`)) {
        console.log(`[VIOLATION] Class fixed slot: class=${act.classId}, slot=${s}`);
        return false;
      }
      if(act.gv){
        const tList = global.parseTeacherList ? global.parseTeacherList(act.gv) : [act.gv];
        for(const t of tList){
          if(this.teacherOffSlots && this.teacherOffSlots.has(`${t}|${s}`)) {
            console.log(`[VIOLATION] Teacher OFF slot: teacher=${t}, slot=${s}`);
            return false;
          }
          const tk = `${t}|${s}`;
          if(teacherSeen.has(tk)){
            console.log(`[VIOLATION] Teacher collision: teacher=${t}, slot=${s}, act1=${teacherSeen.get(tk)}, act2=${id}`);
            return false;
          }
          teacherSeen.set(tk, id);
        }
      }
    }
  }
  return true;
};

eng.optimizeAll().then(res => {
  console.log('Integrity detailed check:');
  eng.verifyPlacementIntegrityVerbose();
});
