const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

// 1. Analyze PCCM for each teacher: total periods assigned across all classes
const teacherTotalPeriods = new Map();
const teacherAssignments = new Map();

for(const k of Object.keys(schoolData.pccmMatrix || {})){
  const gv = schoolData.pccmMatrix[k];
  if(!gv) continue;
  const [cid, mon] = k.split('|');
  const count = schoolData.pccmTietMatrix?.[k] || 1;
  
  teacherTotalPeriods.set(gv, (teacherTotalPeriods.get(gv) || 0) + count);
  if(!teacherAssignments.has(gv)) teacherAssignments.set(gv, []);
  teacherAssignments.get(gv).push({ cid, mon, count });
}

console.log(`Total teachers in PCCM: ${teacherTotalPeriods.size}`);

// Check which teachers have total periods = 1 or odd periods with constraints
for(const [gv, total] of teacherTotalPeriods.entries()){
  if(total === 1){
    console.log(`Teacher ${gv} has ONLY 1 total period in whole school! Assignment:`, teacherAssignments.get(gv));
  }
}

// Let's check constraints (off, fixed, etc.) for each teacher
console.log("\nFixed slots count:", Object.keys(schoolData.fixedCells || schoolData.tkbCoDinh || {}).length);
