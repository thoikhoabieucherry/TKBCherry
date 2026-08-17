const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const constraints = schoolData.tkbConstraints;
console.log("Subject constraints keys:", Object.keys(constraints?.subject || {}));

let totalRequiredBlocks = 0;
Object.entries(constraints?.subject || {}).forEach(([mon, subConf]) => {
  if(!subConf || !subConf.byClass) return;
  Object.entries(subConf.byClass).forEach(([cId, cConf]) => {
    if(!cConf || !cConf.lessonBlocks) return;
    Object.entries(cConf.lessonBlocks).forEach(([len, bConf]) => {
      if(bConf?.min > 0){
        totalRequiredBlocks += bConf.min;
        console.log(`Class ${cId}, mon ${mon}, len ${len}, min ${bConf.min}`);
      }
    });
  });
});

console.log("Total required block constraints:", totalRequiredBlocks);
