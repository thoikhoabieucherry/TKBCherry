const fs = require("fs");
const path = require("path");

const ENGINE_PATH = path.resolve(__dirname, "../web/pages/tkb-fet-engine.js");
const engineSource = fs.readFileSync(ENGINE_PATH, "utf8");
eval(engineSource);

const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, "test_state_0917.json"), "utf8"));

const engine = new FetTimetableEngine(data, { seed: 101 });
engine.loadExistingSchedule();

let m = engine.evaluateMetrics();
console.log("Initial Metrics:", JSON.stringify(m));

const r1 = engine.tryConsolidateTeacherSingletons(m, m);
if(r1) m = r1;

console.log("After tryConsolidateTeacherSingletons:", JSON.stringify(m));
console.log("Remaining singletons:", JSON.stringify(engine.getResidualSingletons()));

