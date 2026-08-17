const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

console.log("=== tkbConstraints ===");
console.log(JSON.stringify(schoolData.tkbConstraints || {}, null, 2));

console.log("=== tkbUserOff ===");
console.log(JSON.stringify(schoolData.tkbUserOff || {}, null, 2));

console.log("=== tkbConfig ===");
console.log(JSON.stringify(schoolData.tkbConfig || {}, null, 2));

console.log("=== teacher off in giaovien array ===");
for(const g of (schoolData.giaovien || [])){
  if(g.off && Object.keys(g.off).length > 0){
    console.log(`Teacher ${g.ten}:`, g.off);
  }
}
