const fs = require('fs');
const lines = fs.readFileSync("C:/Users/Love/Documents/Codex/TKBCherry/web/tkb-fet-engine.js", 'utf8').split("\n");
lines.forEach((l, idx) => {
  if (l.includes("constructor(") || l.includes("this.options =") || l.includes("gap2SessionBudget")) {
    console.log(`Line ${idx+1}: ${l.trim()}`);
  }
});
