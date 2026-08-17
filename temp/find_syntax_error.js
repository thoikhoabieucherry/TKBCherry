const fs = require('fs');

const code = fs.readFileSync("C:/Users/Love/Documents/Codex/TKBCherry/web/tkb-fet-engine.js", 'utf8');
const lines = code.split("\n");

console.log("=== CHECKING LINES AROUND anyImproved ===");
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes("anyImproved") || lines[i].includes("tryRelaxAndRepairGapGaps") || lines[i].includes("tryCrushExtremeSpanGaps")) {
    console.log(`Line ${i+1}: ${lines[i]}`);
  }
}
