const fs = require('fs');

const phanmonCode = fs.readFileSync("C:/Users/Love/Documents/Codex/TKBCherry/web/pages/phanmon.js", 'utf8');

console.log("=== SEARCHING FOR inspectFetCandidateHardConstraints ===");
const lines = phanmonCode.split("\n");
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes("function inspectFetCandidateHardConstraints") || lines[i].includes("inspectFetCandidateHardConstraints =")) {
    console.log(`Found at line ${i+1}:`);
    for (let j = i; j < Math.min(lines.length, i + 80); j++) {
      console.log(`${(j+1).toString().padStart(4, ' ')}: ${lines[j]}`);
    }
  }
}
