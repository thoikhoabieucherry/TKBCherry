const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const engineCode = fs.readFileSync('c:/Users/Love/Documents/Codex/backup/TKBCherry/web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;
const engine = new FetTimetableEngine(schoolData);

console.log("Canon mon of 'Anh':", engine.getCanonMonKey('Anh'));
console.log("Canon mon of 'Tiếng Anh':", engine.getCanonMonKey('Tiếng Anh'));
console.log("Canon mon of 'Toán':", engine.getCanonMonKey('Toán'));
console.log("Canon mon of 'Văn':", engine.getCanonMonKey('Văn'));
console.log("Canon mon of 'Ngữ văn':", engine.getCanonMonKey('Ngữ văn'));
console.log("Canon mon of 'KHTN':", engine.getCanonMonKey('KHTN'));
console.log("Canon mon of 'LSĐL':", engine.getCanonMonKey('LSĐL'));

// Check sample activity mon names in subjectMap of class L001
engine.init();
const sampleActs = engine.activities.filter(a => a.classId === 'L001');
console.log("Class L001 activities:");
sampleActs.forEach(a => {
  console.log(`  mon: "${a.mon}", canonKey: "${engine.getCanonMonKey(a.mon)}"`);
});
