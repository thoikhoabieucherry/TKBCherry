const fs = require("fs");
const path = require("path");

const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, "excel_data_parsed.json"), "utf8"));

console.log("=== INSPECTING CLASS 9/13 KHTN ===");
const days = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
for (const d of days) {
  for (const b of ["sang", "chieu"]) {
    for (let ti = 0; ti < 5; ti++) {
      const cell = data.tkb["9/13"]?.[d]?.[b]?.[ti];
      if (cell && cell.includes("KHTN")) {
        console.log(`Day: ${d} ${b} Tiết ${ti+1}: ${cell}`);
      }
    }
  }
}
