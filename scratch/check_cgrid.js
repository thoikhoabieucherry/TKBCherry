const fs = require("fs");
const path = require("path");

const ENGINE_PATH = path.resolve(__dirname, "../web/pages/tkb-fet-engine.js");
eval(fs.readFileSync(ENGINE_PATH, "utf8"));

const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, "test_state_0917.json"), "utf8"));

const engine = new FetTimetableEngine(data, { seed: 101 });
engine.loadExistingSchedule();

const cGrid = engine.classGrid.get("7A17");
console.log("7A17 cGrid values across all 60 slots:");
for(let s = 0; s < 60; s++){
  if(cGrid[s] < 0 || cGrid[s] === -2 || cGrid[s] === -3){
    console.log(`Slot ${s} (Thu ${Math.floor(s/10)+2} ${Math.floor((s%10)/5)===0?'Sang':'Chieu'} Tiet ${(s%5)+1}): val = ${cGrid[s]}`);
  }
}
