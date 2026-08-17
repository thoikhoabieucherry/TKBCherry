const fs = require('fs');

const js = fs.readFileSync("C:/Users/Love/Documents/Codex/TKBCherry/web/pages/phanmon.js", 'utf8');
const lines = js.split("\n");

console.log("=== PHANMON.JS LINES 7000 TO 7250 ===");
for(let i = 7000; i < 7250; i++){
  if(i < lines.length){
    console.log(`${(i+1).toString().padStart(4, ' ')}: ${lines[i]}`);
  }
}
