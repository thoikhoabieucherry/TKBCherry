const fs = require('fs');

const artifactPath = 'C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json';
const schoolData = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

console.log("Subject constraints in default school:");
const subjConstraints = schoolData.tkbConstraints?.subject || {};
for(const [sk, sobj] of Object.entries(subjConstraints)){
  console.log(`Subject: ${sk}`);
  if(sobj.byClass){
    for(const [cid, r] of Object.entries(sobj.byClass)){
      if(r.lessonBlocks){
        console.log(`  Class ${cid}: lessonBlocks =`, JSON.stringify(r.lessonBlocks));
      }
    }
  }
}
