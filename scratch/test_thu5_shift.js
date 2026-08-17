const fs = require("fs");
const path = require("path");

const ENGINE_PATH = path.resolve(__dirname, "../web/pages/tkb-fet-engine.js");
eval(fs.readFileSync(ENGINE_PATH, "utf8"));

const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, "excel_data_parsed.json"), "utf8"));

const engine = new FetTimetableEngine(data, { seed: 101 });
engine.loadExistingSchedule();

console.log("=== METRICS BEFORE MANUAL SHIFT ===");
const m0 = engine.evaluateMetrics();
console.log("Initial Metrics:", JSON.stringify(m0));

// Find act for 9/13 KHTN at slot 39 (thu 5 chieu tiet 5 = 3*10 + 1*5 + 4 = 39)
const act9_13 = engine.activities.find(a => a.classId === "9/13" && a.mon.includes("KHTN") && engine.actPlacement[a.id] === 39);
console.log("Act 9/13 KHTN:", act9_13?.id, "placement:", engine.actPlacement[act9_13?.id]);

// Find act for 6/13 CNghe at slot 39
const act6_13 = engine.activities.find(a => a.classId === "6/13" && a.mon.includes("CNghệ") && engine.actPlacement[a.id] === 39);
console.log("Act 6/13 CNghe:", act6_13?.id, "placement:", engine.actPlacement[act6_13?.id]);

// Check if act9_13 can be placed at slot 35 (thu 5 chieu tiet 1 = 35)
console.log("Can place 9/13 KHTN at 35:", engine.getConflictsForSlot(act9_13, 35));
engine.unplaceActivity(act9_13.id);
engine.placeActivityDirect(act9_13.id, 35);

// Check if act6_13 can be placed at slot 36 (thu 5 chieu tiet 2 = 36)
console.log("Can place 6/13 CNghe at 36:", engine.getConflictsForSlot(act6_13, 36));
engine.unplaceActivity(act6_13.id);
engine.placeActivityDirect(act6_13.id, 36);

console.log("\n=== METRICS AFTER MANUAL SHIFT ===");
const m1 = engine.evaluateMetrics();
console.log("Metrics After:", JSON.stringify(m1));
console.log("BuoiTrong1 delta:", m0.soBuoiTrong1, "->", m1.soBuoiTrong1);
console.log("Integrity OK:", engine.verifyPlacementIntegrity());
