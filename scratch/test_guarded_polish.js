const fs = require('fs');
const path = require('path');

let engineCode = fs.readFileSync(path.join(__dirname, '../web/pages/tkb-fet-engine.js'), 'utf8');

// In init(), add this.initSubjectConstraints() at top
engineCode = engineCode.replace(
  `    init(){\n      const data = this.data;`,
  `    init(){\n      this.initSubjectConstraints();\n      const data = this.data;`
);

// In init(), create duration 2 activities for subjects that have lessonBlocks
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

// Add duration === 1 check in Intra-Session Permutations
const oldPermCheck = `                  const act1 = this.activities[actId1];
                  const act2 = this.activities[actId2];
                  if(!act1 || !act2 || act1.isFixed || act2.isFixed) continue;`;

const newPermCheck = `                  const act1 = this.activities[actId1];
                  const act2 = this.activities[actId2];
                  if(!act1 || !act2 || act1.isFixed || act2.isFixed || act1.duration !== 1 || act2.duration !== 1) continue;`;

engineCode = engineCode.replace(oldPermCheck, newPermCheck);

// Add duration === 1 check in obliterateAllTeacherSingletons
engineCode = engineCode.replace(
  `            const act1 = this.activities[single.item.actId];\n            if(!act1 || act1.isFixed) continue;`,
  `            const act1 = this.activities[single.item.actId];\n            if(!act1 || act1.isFixed || act1.duration !== 1) continue;`
);
engineCode = engineCode.replace(
  `              const act2 = this.activities[actId2];\n              if(!act2 || act2.isFixed || act2.id === act1.id) continue;`,
  `              const act2 = this.activities[actId2];\n              if(!act2 || act2.isFixed || act2.id === act1.id || act2.duration !== 1) continue;`
);

eval(engineCode);

const artifactPath = 'C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json';
const schoolData = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

const FetTimetableEngine = globalThis.FetTimetableEngine;
const engine = new FetTimetableEngine(schoolData);

console.log("Calling solve()...");
const res = engine.solve();
console.log("Solve res:", res);

const violations = engine.evaluateLessonBlockViolations();
console.log("evaluateLessonBlockViolations after solve:", violations);
const metrics = engine.evaluateMetrics();
console.log("Metrics after solve:", metrics);
