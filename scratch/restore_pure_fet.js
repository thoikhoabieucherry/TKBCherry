const fs = require('fs');

const backupCode = fs.readFileSync('c:/Users/Love/Documents/Codex/backup/TKBCherry/web/pages/tkb-fet-engine.js', 'utf8');
fs.writeFileSync('c:/Users/Love/Documents/Codex/TKBCherry/web/pages/tkb-fet-engine.js', backupCode, 'utf8');

console.log("Restored pure FET engine from backup successfully!");
