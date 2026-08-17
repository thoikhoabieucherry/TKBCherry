const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const teacherTotal = new Map();
const teacherClasses = new Map();

for(const [k, gv] of Object.entries(schoolData.pccmMatrix || {})){
  if(!gv) continue;
  const count = schoolData.pccmTietMatrix?.[k] || 1;
  teacherTotal.set(gv, (teacherTotal.get(gv) || 0) + count);
  if(!teacherClasses.has(gv)) teacherClasses.set(gv, []);
  teacherClasses.get(gv).push({ classMon: k, count });
}

console.log("=== TEACHERS WITH TOTAL PERIODS ===");
for(const [gv, total] of Array.from(teacherTotal.entries()).sort((a,b) => a[1] - b[1])){
  const off = schoolData.giaovien?.find(g => g.ten === gv || g.ten2 === gv || g.id === gv)?.off || {};
  console.log(`- ${gv}: ${total} periods | Off: ${JSON.stringify(off)} | Assignments: ${teacherClasses.get(gv).map(a => `${a.classMon}(${a.count})`).join(', ')}`);
}
