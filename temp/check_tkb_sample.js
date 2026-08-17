const fs = require('fs');
const data = JSON.parse(fs.readFileSync("C:/Users/Love/Documents/Codex/temp/school_default_gap7.json", 'utf8'));
const tkb = data.tkb;
const firstKey = Object.keys(tkb)[0];
console.log("First key in tkb:", firstKey);
console.log("Sample tkb content for", firstKey, ":", JSON.stringify(tkb[firstKey], null, 2).slice(0, 500));
