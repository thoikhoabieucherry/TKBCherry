const fs = require('fs');

const allSchools = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/all_vps_schools.json', 'utf8'));
const schoolData = allSchools['school_default'];

// Check how byClass keys look in tkbConstraints
const constraints = schoolData.tkbConstraints;
console.log("Subject constraint keys sample:");
for (const [sKey, sConf] of Object.entries(constraints?.subject || {})) {
  if (sConf?.byClass) {
    console.log("Subject:", sKey, "byClass keys sample:", Object.keys(sConf.byClass).slice(0, 5));
    break;
  }
}

console.log("Class IDs sample in schoolData.classes:", schoolData.classes?.slice(0, 5).map(c => ({ id: c.id, ten: c.ten, ten2: c.ten2 })));
