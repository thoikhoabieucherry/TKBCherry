const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

console.log("schoolData keys:", Object.keys(schoolData));
console.log("giaoVien sample:", (schoolData.giaoVien || []).slice(0, 3));
console.log("pccm sample:", Object.entries(schoolData.pccmMatrix || {}).slice(0, 5));
