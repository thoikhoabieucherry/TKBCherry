const fs = require('fs');

let engineCode = fs.readFileSync("C:/Users/Love/Documents/Codex/TKBCherry/web/tkb-fet-engine.js", 'utf8');

try {
  eval(engineCode);
  console.log("FINAL ENGINE SYNTAX CHECK: 100% PERFECT!");
} catch(e) {
  console.error("SYNTAX ERROR:", e);
}
