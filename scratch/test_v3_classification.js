const fs = require('fs');
const path = require('path');
const vm = require('vm');

const mockElement = {
  appendChild: () => {},
  removeChild: () => {},
  style: {},
  setAttribute: () => {},
  getAttribute: () => '',
  classList: { add: () => {}, remove: () => {}, contains: () => false },
};

const windowObj = {
  console: console,
  Math: Math,
  Date: Date,
  Set: Set,
  Map: Map,
  Array: Array,
  Object: Object,
  parseInt: parseInt,
  parseFloat: parseFloat,
  isNaN: isNaN,
  isFinite: isFinite,
  String: String,
  Number: Number,
  Boolean: Boolean,
  RegExp: RegExp,
  JSON: JSON,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  document: {
    createElement: () => mockElement,
    head: mockElement,
    body: mockElement,
    getElementById: () => mockElement,
    querySelector: () => mockElement,
    querySelectorAll: () => [],
  },
};
windowObj.window = windowObj;
windowObj.global = windowObj;
windowObj.self = windowObj;

const ctx = vm.createContext(windowObj);

const constraintsCode = fs.readFileSync(path.join(__dirname, '../web/pages/tkb-constraints.js'), 'utf8');
vm.runInContext(constraintsCode, ctx);

const engineCode = fs.readFileSync(path.join(__dirname, '../web/pages/tkb-fet-engine.js'), 'utf8');
vm.runInContext(engineCode, ctx);

const brainScratchPath = 'C:\\Users\\Love\\.gemini\\antigravity\\brain\\e6e653cb-e567-476a-85f0-e418e6636dc4\\scratch\\school_default_vps.json';
const schoolData = JSON.parse(fs.readFileSync(brainScratchPath, 'utf8'));

async function testV3Classification(){
  console.log("=== TESTING V3 CLASSIFICATION ===");
  const engine = new windowObj.FetTimetableEngine(JSON.parse(JSON.stringify(schoolData)));
  
  // Attach v3 helper methods dynamically to test
  engine.getShiftBlock = function(classId){
    const cGrid = this.classGrid.get(classId);
    if(!cGrid) return 'S';
    let offMorning = 0, offAfternoon = 0;
    for(let d = 0; d < 6; d++){
      for(let p = 0; p < 5; p++){
        const sM = d * 10 + p;
        const sC = d * 10 + 5 + p;
        if(cGrid[sM] === -2 || this.offSlots.has(`${classId}|${sM}`)) offMorning++;
        if(cGrid[sC] === -2 || this.offSlots.has(`${classId}|${sC}`)) offAfternoon++;
      }
    }
    return (offMorning < offAfternoon) ? 'S' : 'C';
  };

  engine.classifySingleton = function(tKey, d, b, act){
    if(!act || !act.classId) return { type: 'STRUCTURAL', reason: 'no-activity' };
    const classId = act.classId;
    const mon = act.mon;
    const khoiLop = this.getShiftBlock(classId);
    const tGrid = this.teacherGrid.get(tKey);
    if(!tGrid) return { type: 'STRUCTURAL', reason: 'no-teacher-grid' };

    const candidates = [];
    for(let d2 = 0; d2 < 6; d2++){
      for(let b2 = 0; b2 < 2; b2++){
        if(d2 === d && b2 === b) continue;
        const sessKhoi = (b2 === 0) ? 'S' : 'C';
        if(sessKhoi !== khoiLop) continue;

        const sStart = d2 * 10 + b2 * 5;
        const taughtInSess = [];
        for(let p = 0; p < 5; p++){
          const actId2 = tGrid[sStart + p];
          if(actId2 >= 0){
            const a2 = this.activities[actId2];
            if(a2) taughtInSess.push(a2);
          }
        }

        if(taughtInSess.length >= 1 && taughtInSess.length < 5){
          candidates.push({ d: d2, b: b2, acts: taughtInSess });
        }
      }
    }

    if(candidates.length === 0){
      return { type: 'STRUCTURAL', reason: 'no-other-session-same-shift-block' };
    }

    const monLimit = this.getSubjectSessionLimit ? this.getSubjectSessionLimit(mon) : 2;

    for(const cand of candidates){
      if(cand.acts.some(a => a.classId !== classId)){
        return { type: 'FIXABLE', target: cand };
      }
      if(cand.acts.some(a => a.classId === classId && this.getCanonMonKey(a.mon) !== this.getCanonMonKey(mon))){
        return { type: 'FIXABLE', target: cand };
      }
      const sameSubjectCount = cand.acts.filter(a => a.classId === classId && this.getCanonMonKey(a.mon) === this.getCanonMonKey(mon)).length;
      if(sameSubjectCount < monLimit){
        return { type: 'FIXABLE', target: cand };
      }
    }

    return { type: 'STRUCTURAL', reason: 'same-subject-daily-cap-reached-everywhere' };
  };

  engine.classifyAllSingletons = function(){
    const fixable = [];
    const structural = [];

    this.teacherGrid.forEach((grid, tKey) => {
      if(!tKey) return;
      for(let d = 0; d < 6; d++){
        for(let b = 0; b < 2; b++){
          const sStart = d * 10 + b * 5;
          const taught = [];
          for(let p = 0; p < 5; p++){
            const actId = grid[sStart + p];
            if(actId >= 0){
              const act = this.activities[actId];
              if(act) taught.push({ slot: sStart + p, act });
            }else if(actId === -3){
              taught.push({ slot: sStart + p, act: { isFixed: true } });
            }
          }

          if(taught.length === 1){
            const item = taught[0];
            if(item.act.isFixed){
              structural.push({ teacher: tKey, day: d, session: b, reason: 'fixed-slot' });
            }else{
              const res = this.classifySingleton(tKey, d, b, item.act);
              if(res.type === 'FIXABLE'){
                fixable.push({ teacher: tKey, day: d, buoi: b, slot: item.slot, act: item.act, target: res.target });
              }else{
                structural.push({ teacher: tKey, day: d, session: b, reason: res.reason, classId: item.act.classId, mon: item.act.mon });
              }
            }
          }
        }
      }
    });
    return { fixable, structural };
  };

  // Test on loaded schedule
  engine.loadExistingSchedule();
  const cls = engine.classifyAllSingletons();
  console.log(`Baseline on existing schedule: Fixable = ${cls.fixable.length}, Structural = ${cls.structural.length}`);
  console.log("Structural Singletons:", cls.structural);
}

testV3Classification();
