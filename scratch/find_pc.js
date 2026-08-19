const fs = require('fs');
const content = fs.readFileSync('c:/Users/Love/Documents/Codex/TKBCherry/web/pages/tkb-fet-engine.js', 'utf8');

const lines = content.split('\n');
lines.forEach((l, i) => {
  if (l.includes('progressCallback(')) {
    console.log(`Line ${i + 1}: ${l.trim()}`);
  }
});
