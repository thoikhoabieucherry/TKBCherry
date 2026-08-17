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

// Load constraints
const constraintsCode = fs.readFileSync(path.join(__dirname, '../web/pages/tkb-constraints.js'), 'utf8');
vm.runInContext(constraintsCode, ctx);

// Load engine
const engineCode = fs.readFileSync(path.join(__dirname, '../web/pages/tkb-fet-engine.js'), 'utf8');
vm.runInContext(engineCode, ctx);

const brainScratchPath = 'C:\\Users\\Love\\.gemini\\antigravity\\brain\\e6e653cb-e567-476a-85f0-e418e6636dc4\\scratch\\school_default_vps.json';
const schoolData = JSON.parse(fs.readFileSync(brainScratchPath, 'utf8'));
windowObj.DATA = schoolData;

const engine = new windowObj.FetTimetableEngine(schoolData);
engine.solve();
console.log('Initial metrics:', engine.evaluateMetrics());

// Add prototype methods for multi-directional escape
vm.runInContext(`
  FetTimetableEngine.prototype.tryWholeSessionSwap = function(bestMetrics, mode, onProgress){
    const DAYS = 6;
    const SESSIONS = 2;
    const PERIODS = 5;
    let currentBest = { ...bestMetrics };
    let anyImproved = false;

    const classList = Array.from(this.classGrid.keys()).filter(Boolean);
    this.rng.shuffle(classList);

    for(const cid of classList){
      const cGrid = this.classGrid.get(cid);
      if(!cGrid) continue;

      for(let b = 0; b < SESSIONS; b++){
        for(let d1 = 0; d1 < DAYS; d1++){
          const sStart1 = d1 * 10 + b * 5;
          let canSwap1 = true;
          const acts1 = [];
          for(let p = 0; p < PERIODS; p++){
            const s = sStart1 + p;
            if(this.offSlots.has(cid + "|" + s)){ canSwap1 = false; break; }
            const actId = cGrid[s];
            if(actId === -3){ canSwap1 = false; break; }
            if(actId >= 0){
              const act = this.activities[actId];
              if(!act || act.isFixed){ canSwap1 = false; break; }
              acts1.push({ slot: s, act, p });
            }
          }
          if(!canSwap1) continue;

          for(let d2 = d1 + 1; d2 < DAYS; d2++){
            const sStart2 = d2 * 10 + b * 5;
            let canSwap2 = true;
            const acts2 = [];
            for(let p = 0; p < PERIODS; p++){
              const s = sStart2 + p;
              if(this.offSlots.has(cid + "|" + s)){ canSwap2 = false; break; }
              const actId = cGrid[s];
              if(actId === -3){ canSwap2 = false; break; }
              if(actId >= 0){
                const act = this.activities[actId];
                if(!act || act.isFixed){ canSwap2 = false; break; }
                acts2.push({ slot: s, act, p });
              }
            }
            if(!canSwap2) continue;

            // Test unplacing all acts in both sessions
            acts1.forEach(item => this.unplaceActivity(item.act.id));
            acts2.forEach(item => this.unplaceActivity(item.act.id));

            let allValid = true;
            // Place acts1 in session 2
            for(const item of acts1){
              const targetSlot = sStart2 + item.p;
              const r = this.getConflictsForSlot(item.act, targetSlot);
              if(!r.possible || r.conflicts.length > 0){ allValid = false; break; }
              this.placeActivityDirect(item.act.id, targetSlot);
            }

            if(allValid){
              // Place acts2 in session 1
              for(const item of acts2){
                const targetSlot = sStart1 + item.p;
                const r = this.getConflictsForSlot(item.act, targetSlot);
                if(!r.possible || r.conflicts.length > 0){ allValid = false; break; }
                this.placeActivityDirect(item.act.id, targetSlot);
              }
            }

            if(allValid && this.isLessonBlockSafe(...acts1.map(x => x.act), ...acts2.map(x => x.act))){
              const m = this.evaluateMetrics();
              if(this.compareMetrics(m, currentBest, mode) < 0){
                currentBest = { ...m };
                anyImproved = true;
                if(typeof onProgress === "function") onProgress(currentBest);
                break;
              }
            }

            // Rollback
            acts1.forEach(item => this.unplaceActivity(item.act.id));
            acts2.forEach(item => this.unplaceActivity(item.act.id));
            acts1.forEach(item => this.placeActivityDirect(item.act.id, item.slot));
            acts2.forEach(item => this.placeActivityDirect(item.act.id, item.slot));
          }
          if(anyImproved) break;
        }
        if(anyImproved) break;
      }
      if(anyImproved) break;
    }
    return anyImproved ? currentBest : null;
  };

  FetTimetableEngine.prototype.tryRelatedClusterRuin = function(targetTeachers, bestMetrics, mode, onProgress){
    const relatedTeachers = new Set(targetTeachers);
    targetTeachers.forEach(tKey => {
      const grid = this.teacherGrid.get(tKey);
      if(!grid) return;
      for(let s = 0; s < 60; s++){
        const actId = grid[s];
        if(actId >= 0){
          const act = this.activities[actId];
          if(act && act.classId){
            const cGrid = this.classGrid.get(act.classId);
            if(cGrid){
              for(let s2 = 0; s2 < 60; s2++){
                const a2Id = cGrid[s2];
                if(a2Id >= 0){
                  const a2 = this.activities[a2Id];
                  if(a2 && a2.gv && a2.duration === 1 && !a2.isFixed){
                    relatedTeachers.add(a2.gv);
                  }
                }
              }
            }
          }
        }
      }
    });

    const chosenTeachers = Array.from(relatedTeachers);
    this.rng.shuffle(chosenTeachers);
    const sample = chosenTeachers.slice(0, Math.min(6, chosenTeachers.length));
    return this.tryLnsRuinAndRecreate(sample, bestMetrics, Infinity, onProgress);
  };
`, ctx);

console.log('Testing prototype multi-directional escape methods on singletons...');
const t0 = Date.now();
engine.optimize('optimize_singletons', (p) => {
  if(p.percent % 25 === 0) console.log(`Progress: ${p.percent}% - Metric: ${p.currentMetric}`);
}).then(res => {
  const t1 = Date.now();
  console.log(`Finished in ${(t1 - t0) / 1000}s:`, res.metrics);
  console.log('Residuals count:', res.residualSingletons.length);
});
