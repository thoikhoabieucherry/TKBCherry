const fs = require('fs');
const path = require('path');

let engineCode = fs.readFileSync(path.join(__dirname, '../web/pages/tkb-fet-engine.js'), 'utf8');

engineCode = engineCode.replace(
  `    init(){\n      const data = this.data;`,
  `    init(){\n      this.initSubjectConstraints();\n      const data = this.data;`
);

const oldInitLoop = `        subjectMap.forEach((item, mKey) => {
          let remain = item.remain || 0;
          const gv = item.gv;
          const room = item.room;

          if(!gv) return;

          while(remain > 0){
            let dur = 1;
            remain -= 1;

            actList.push({
              id: actCounter++,
              classId: cid,
              classCanon,
              lop,
              mon: item.mon,
              canonKey: this.getCanonMonKey(item.mon),
              gv,
              room,
              duration: dur,
              isFixed: false,
              fixedSlot: -1,
              nIncompatible: 0
            });
          }
        });`;

const newInitLoop = `        subjectMap.forEach((item, mKey) => {
          let remain = item.remain || 0;
          const gv = item.gv;
          const room = item.room;

          if(!gv) return;

          const sCanon = item.canonKey || this.getCanonMonKey(item.mon);
          const blockDurs = [];

          for(const len of [5, 4, 3, 2]){
            const req = this.classSubjectLessonBlocks ? (
              this.classSubjectLessonBlocks.get(\`\${cid}|\${sCanon}|\${len}\`) ||
              this.classSubjectLessonBlocks.get(\`\${classCanon}|\${sCanon}|\${len}\`)
            ) : null;
            const minReq = req ? req.min : 0;
            if(minReq > 0 && remain >= len){
              const count = Math.min(minReq, Math.floor(remain / len));
              for(let k = 0; k < count; k++){
                blockDurs.push(len);
                remain -= len;
              }
            }
          }

          for(const dur of blockDurs){
            actList.push({
              id: actCounter++,
              classId: cid,
              classCanon,
              lop,
              mon: item.mon,
              canonKey: sCanon,
              gv,
              room,
              duration: dur,
              isFixed: false,
              fixedSlot: -1,
              nIncompatible: 0
            });
          }

          while(remain > 0){
            let dur = 1;
            remain -= 1;

            actList.push({
              id: actCounter++,
              classId: cid,
              classCanon,
              lop,
              mon: item.mon,
              canonKey: sCanon,
              gv,
              room,
              duration: dur,
              isFixed: false,
              fixedSlot: -1,
              nIncompatible: 0
            });
          }
        });`;

engineCode = engineCode.replace(oldInitLoop, newInitLoop);

eval(engineCode);

const artifactPath = 'C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json';
const schoolData = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

const FetTimetableEngine = globalThis.FetTimetableEngine;
const engine = new FetTimetableEngine(schoolData);
engine.solve();

console.log("\nInspecting class L008, subject Anh:");
const cGrid = engine.classGrid.get("L008");
console.log("Class L008 grid:");
for(let d = 0; d < 6; d++){
  const sang = [];
  const chieu = [];
  for(let p = 0; p < 5; p++){
    const aSang = cGrid[d*10 + p];
    const aChieu = cGrid[d*10 + 5 + p];
    sang.push(aSang >= 0 ? `${engine.activities[aSang]?.mon}(dur=${engine.activities[aSang]?.duration},id=${aSang})` : (aSang === -2 ? 'OFF' : (aSang === -3 ? 'FIX' : '---')));
    chieu.push(aChieu >= 0 ? `${engine.activities[aChieu]?.mon}(dur=${engine.activities[aChieu]?.duration},id=${aChieu})` : (aChieu === -2 ? 'OFF' : (aChieu === -3 ? 'FIX' : '---')));
  }
  console.log(`Day ${d+2} SANG:`, sang.join(" | "));
  console.log(`Day ${d+2} CHIEU:`, chieu.join(" | "));
}

// Let's see all activities for class L008, subject Anh
console.log("\nActivities for L008 Anh:");
engine.activities.filter(a => a.classId === "L008" && (a.canonKey === "anh" || a.mon.toLowerCase().includes("anh"))).forEach(a => {
  console.log(`Act id ${a.id}, mon ${a.mon}, dur ${a.duration}, slot ${engine.actPlacement[a.id]}`);
});
