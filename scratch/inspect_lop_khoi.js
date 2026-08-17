const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

console.log("schoolData.lop:", schoolData.lop ? schoolData.lop.length : 'undefined');
console.log("schoolData.khoi:", schoolData.khoi ? schoolData.khoi.length : 'undefined');
if(schoolData.khoi){
  console.log("khoi sample:", schoolData.khoi[0]);
}
console.log("DATA.tkb sample keys:", Object.keys(schoolData.tkb || {}).slice(0, 10));
