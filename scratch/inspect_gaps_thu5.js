const fs = require("fs");
const path = require("path");

const ENGINE_PATH = path.resolve(__dirname, "../web/pages/tkb-fet-engine.js");
eval(fs.readFileSync(ENGINE_PATH, "utf8"));

const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, "excel_data_parsed.json"), "utf8"));

const engine = new FetTimetableEngine(data, { seed: 101 });
engine.loadExistingSchedule();

console.log("=== INSPECTING ALL TEACHERS WITH GAPS ON THU 5 CHIEU (Day 3, buoi 1) ===");
const d = 3;
const b = 1;
const sStart = d * 10 + b * 5;

for (const [tKey, grid] of engine.teacherGrid.entries()) {
  const periods = [];
  for (let p = 0; p < 5; p++) {
    const aId = grid[sStart + p];
    if (aId >= 0) {
      const a = engine.activities[aId];
      periods.push({ p, label: `${a.classId} - ${a.mon}` });
    }
  }
  if (periods.length >= 2) {
    const span = periods[periods.length - 1].p - periods[0].p + 1;
    const gaps = span - periods.length;
    if (gaps > 0) {
      console.log(`Teacher "${tKey}" has ${gaps} gaps on Thu 5 chieu:`, periods.map(x => `T${x.p+1}: ${x.label}`).join(", "));
    }
  }
}

console.log("\n=== ALL CLASSES ON THU 5 CHIEU ===");
for (const [cKey, grid] of engine.classGrid.entries()) {
  const periods = [];
  for (let p = 0; p < 5; p++) {
    const aId = grid[sStart + p];
    if (aId >= 0) {
      const a = engine.activities[aId];
      periods.push(`T${p+1}: ${a.mon} (${a.gv})`);
    } else {
      periods.push(`T${p+1}: [Trống]`);
    }
  }
  if (cKey === "9/13" || cKey === "9/14" || cKey === "6/13" || periods.some(x => !x.includes("[Trống]"))) {
    if (cKey.startsWith("9/") || cKey.startsWith("6/")) {
      console.log(`Class ${cKey}: ${periods.join(", ")}`);
    }
  }
}
