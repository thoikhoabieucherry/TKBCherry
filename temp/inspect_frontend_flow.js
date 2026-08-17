const fs = require('fs');

const phanmonCode = fs.readFileSync("C:/Users/Love/Documents/Codex/TKBCherry/web/pages/phanmon.js", 'utf8');
const workerCode = fs.readFileSync("C:/Users/Love/Documents/Codex/TKBCherry/web/pages/tkb-fet-worker.js", 'utf8');

console.log("=== CHECKING WORKER CODE ===");
console.log(workerCode);

console.log("\n=== CHECKING PHANMON OPTIMIZE GAP2 HANDLER ===");
const lines = phanmonCode.split("\n");
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes("optimize_gap2") || lines[i].includes("Tối ưu 2 tiết trống") || lines[i].includes("btnOptimizeGap2")) {
    console.log(`\n--- Line ${i+1}: ${lines[i].trim()} ---`);
    for (let j = Math.max(0, i - 10); j < Math.min(lines.length, i + 40); j++) {
      console.log(`${(j+1).toString().padStart(4, ' ')}: ${lines[j]}`);
    }
  }
}
