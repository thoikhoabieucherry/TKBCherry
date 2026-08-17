const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const engine = new FetTimetableEngine(schoolData);
engine.init();

// Find 7A4
const lop7A4 = schoolData.lop.find(l => (l.ten2 || l.ten || l.id) === '7A4' || l.id === 'L021');
console.log("7A4 lop info:", lop7A4);

const cid = lop7A4.id;
console.log(`\n=== OFF SLOTS for 7A4 (${cid}) ===`);
for(let s = 0; s < 60; s++){
  if(engine.offSlots.has(`${cid}|${s}`)){
    const d = Math.floor(s / 10);
    const b = Math.floor((s % 10) / 5);
    const p = s % 5;
    console.log(`  Slot ${s}: Thứ ${d+2} ${b===0?'Sáng':'Chiều'} T${p+1}`);
  }
}

console.log(`\n=== FIXED SLOTS for 7A4 (${cid}) ===`);
for(let s = 0; s < 60; s++){
  if(engine.fixedSlots.has(`${cid}|${s}`)){
    const d = Math.floor(s / 10);
    const b = Math.floor((s % 10) / 5);
    const p = s % 5;
    console.log(`  Slot ${s}: Thứ ${d+2} ${b===0?'Sáng':'Chiều'} T${p+1} ->`, engine.fixedSlots.get(`${cid}|${s}`));
  }
}

console.log(`\n=== ACTIVITIES for 7A4 (${cid}) ===`);
const acts7A4 = engine.activities.filter(a => a.classId === cid);
acts7A4.forEach(a => {
  console.log(`  Act ${a.id}: mon=${a.mon}, dur=${a.duration}, gv=${a.gv}`);
});
console.log("Total periods in 7A4 activities:", acts7A4.reduce((s, a) => s + a.duration, 0));
