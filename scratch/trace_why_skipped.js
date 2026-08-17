const fs = require("fs");
const path = require("path");

const ENGINE_PATH = path.resolve(__dirname, "../web/pages/tkb-fet-engine.js");
eval(fs.readFileSync(ENGINE_PATH, "utf8"));

const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, "excel_data_parsed.json"), "utf8"));

const engine = new FetTimetableEngine(data, { seed: 101 });
engine.loadExistingSchedule();

console.log("=== TRACING THAY HUY IN EACH OPERATOR ===");
const m0 = engine.evaluateMetrics();
console.log("Initial Metrics:", JSON.stringify(m0));

// Operator 1: tryShareLessonFromRichSessionToSingleton
console.log("\n--- Testing tryShareLessonFromRichSessionToSingleton ---");
const res1 = engine.tryShareLessonFromRichSessionToSingleton(m0, m0, Infinity, (p) => {});
console.log("res1:", res1 ? JSON.stringify(res1) : "NO IMPROVEMENT");
console.log("Thay Huy metrics after op1:", JSON.stringify(engine.evaluateTeacherMetrics("t.huy")));

// Operator 2: tryConsolidatePairSingletons
console.log("\n--- Testing tryConsolidatePairSingletons ---");
const res2 = engine.tryConsolidatePairSingletons(res1 || m0, m0, Infinity, (p) => {});
console.log("res2:", res2 ? JSON.stringify(res2) : "NO IMPROVEMENT");
console.log("Thay Huy metrics after op2:", JSON.stringify(engine.evaluateTeacherMetrics("t.huy")));

// Operator 3: tryVacateTeacherSessions
console.log("\n--- Testing tryVacateTeacherSessions ---");
const res3 = engine.tryVacateTeacherSessions(res2 || res1 || m0, m0, Infinity, (p) => {});
console.log("res3:", res3 ? JSON.stringify(res3) : "NO IMPROVEMENT");
console.log("Thay Huy metrics after op3:", JSON.stringify(engine.evaluateTeacherMetrics("t.huy")));

// Operator 4: tryConsolidateTeacherSingletons
console.log("\n--- Testing tryConsolidateTeacherSingletons ---");
const res4 = engine.tryConsolidateTeacherSingletons(res3 || res2 || res1 || m0, m0, Infinity, (p) => {});
console.log("res4:", res4 ? JSON.stringify(res4) : "NO IMPROVEMENT");
console.log("Thay Huy metrics after op4:", JSON.stringify(engine.evaluateTeacherMetrics("t.huy")));
