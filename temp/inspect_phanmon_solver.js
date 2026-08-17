const fs = require('fs');

const js = fs.readFileSync("C:/Users/Love/Documents/Codex/TKBCherry/web/pages/phanmon.js", 'utf8');
const lines = js.split("\n");

console.log("=== PHANMON.JS LINES 6550 TO 7000 ===");
for(let i = 6550; i < 7000; i++){
  if(i < lines.length){
    console.log(`${(i+1).toString().padStart(4, ' ')}: ${lines[i]}`);
  }
}
