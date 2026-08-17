const fs = require("fs");
const path = require("path");

const ENGINE_PATH = path.resolve(__dirname, "../web/pages/tkb-fet-engine.js");
const engineSource = fs.readFileSync(ENGINE_PATH, "utf8");
eval(engineSource);

const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, "test_state_0917.json"), "utf8"));

const engine = new FetTimetableEngine(data, { seed: 101 });
engine.loadExistingSchedule();

console.log("=== INSPECTING T.Huy ACTIVITIES & SLOTS ===");
const huyActs = engine.activities.filter(a => a.gv === "T.Huy");
for(const a of huyActs){
  const s = engine.actPlacement[a.id];
  console.log(`Act ${a.id}: ${a.classId} - ${a.mon} (duration: ${a.duration}, isFixed: ${a.isFixed}) at slot ${s} (Thu: ${Math.floor(s/10)+2}, Buoi: ${Math.floor((s%10)/5)===0?'Sang':'Chieu'}, Tiet: ${(s%5)+1})`);
}

console.log("\n=== RUNNING tryConsolidatePairSingletons WITH DETAILED LOGS ===");

const tGrid = engine.teacherGrid.get("T.Huy");
const DAYS = 6, SESSIONS = 2, PERIODS = 5;
const singletons = [];
for(let d = 0; d < DAYS; d++){
  for(let b = 0; b < SESSIONS; b++){
    const sStart = d * 10 + b * 5;
    const taught = [];
    for(let p = 0; p < PERIODS; p++){
      const s = sStart + p;
      if(tGrid[s] >= 0){
        const act = engine.activities[tGrid[s]];
        if(act && !act.isFixed && act.duration === 1){
          taught.push({ slot: s, actId: tGrid[s], p });
        }
      }
    }
    if(taught.length === 1){
      singletons.push({ slot: taught[0].slot, actId: taught[0].actId, d, b });
    }
  }
}
console.log("Singletons found for T.Huy:", singletons);

