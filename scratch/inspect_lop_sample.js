const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

console.log("schoolData.lop[0]:", schoolData.lop[0]);
console.log("pccmMatrix keys sample:", Object.keys(schoolData.pccmMatrix).slice(0, 5));
