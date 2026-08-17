const fs = require('fs');

const html = fs.readFileSync("C:/Users/Love/Documents/Codex/TKBCherry/web/pages/sapxep.html", 'utf8');
const js = fs.readFileSync("C:/Users/Love/Documents/Codex/TKBCherry/web/pages/phanmon.js", 'utf8');

console.log("=== SEARCHING IN SAPXEP.HTML ===");
const htmlLines = html.split("\n");
htmlLines.forEach((l, idx) => {
  if (l.includes("2 tiết") || l.includes("gap2") || l.includes("optimize") || l.includes("btnOptimize")) {
    console.log(`HTML Line ${idx+1}: ${l.trim()}`);
  }
});

console.log("\n=== SEARCHING FOR OPTIMIZE_GAP2 CALLERS IN PHANMON.JS ===");
const jsLines = js.split("\n");
jsLines.forEach((l, idx) => {
  if (l.includes("optimize_gap2") || l.includes("teacher_gap2_sessions") || l.includes("Tối ưu 2 tiết trống")) {
    console.log(`JS Line ${idx+1}: ${l.trim()}`);
  }
});
