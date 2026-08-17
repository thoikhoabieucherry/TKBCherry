const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

// Check teacher constraints (e.g. bieuMau, nghi, maxBuoi, etc.)
console.log("Teacher constraints check:");
for(const gv of (schoolData.giaoVien || [])){
  const offCount = Object.keys(gv.offSlots || {}).length;
  const maxBuoi = gv.maxBuoi;
  // find total periods
  let totalP = 0;
  for(const k of Object.keys(schoolData.pccmMatrix || {})){
    if(schoolData.pccmMatrix[k] === gv.ten || schoolData.pccmMatrix[k] === gv.id){
      totalP += (schoolData.pccmTietMatrix?.[k] || 1);
    }
  }
  if(totalP % 2 !== 0){
    console.log(`Teacher ${gv.ten} (id: ${gv.id}): total periods = ${totalP} (ODD!), maxBuoi = ${maxBuoi}, offSlots = ${offCount}`);
  }
}
