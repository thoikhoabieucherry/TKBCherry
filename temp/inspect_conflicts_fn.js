const fs = require('fs');

const code = fs.readFileSync("C:/Users/Love/Documents/Codex/TKBCherry/web/tkb-fet-engine.js", 'utf8');
const lines = code.split("\n");

console.log("=== SEARCHING FOR getConflictsForSlot IN ENGINE ===");
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes("getConflictsForSlot(") || lines[i].includes("getConflictsForSlot =")) {
    console.log(`Found at line ${i+1}:`);
    for (let j = i; j < Math.min(lines.length, i + 80); j++) {
      console.log(`${(j+1).toString().padStart(4, ' ')}: ${lines[j]}`);
    }
    break;
  }
}
