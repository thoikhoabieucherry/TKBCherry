const fs = require('fs');
const path = require('path');

const engineCode = fs.readFileSync(path.join(__dirname, '../web/pages/tkb-fet-engine.js'), 'utf8');

// Modify engine code in memory to test the fix
let fixedCode = engineCode.replace(
  `    solve(progressCallback = null){\n      this.init();`,
  `    solve(progressCallback = null){\n      this.initSubjectConstraints();\n      this.init();`
);

// In init(), add the lessonBlocks generation
const targetInitLoop = `        subjectMap.forEach((item, mKey) => {
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

const replacementInitLoop = `        subjectMap.forEach((item, mKey) => {
          let remain = item.remain || 0;
          const gv = item.gv;
          const room = item.room;

          if(!gv) return;

          const sCanon = item.canonKey || this.getCanonMonKey(item.mon);
          const blockReqs = [];
          for(const len of [5, 4, 3, 2]){
            const req = this.classSubjectLessonBlocks ? this.classSubjectLessonBlocks.get(\`\${cid}|\${sCanon}|\${len}\`) : null;
            const minReq = req ? req.min : (
              data.tkbConstraints?.subject?.[item.mon]?.byClass?.[cid]?.lessonBlocks?.[len]?.min ||
              data.tkbConstraints?.subject?.[sCanon]?.byClass?.[cid]?.lessonBlocks?.[len]?.min ||
              data.tkbConstraints?.subject?.[item.mon]?.byClass?.[classCanon]?.lessonBlocks?.[len]?.min ||
              data.tkbConstraints?.subject?.[sCanon]?.byClass?.[classCanon]?.lessonBlocks?.[len]?.min || 0
            );
            const minCount = Number(minReq) || 0;
            if(minCount > 0 && remain >= len){
              const numBlocks = Math.min(minCount, Math.floor(remain / len));
              for(let b = 0; b < numBlocks; b++){
                blockReqs.push(len);
                remain -= len;
              }
            }
          }

          for(const dur of blockReqs){
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

fixedCode = fixedCode.replace(targetInitLoop, replacementInitLoop);

eval(fixedCode);

const artifactPath = 'C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json';
const schoolData = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

const FetTimetableEngine = globalThis.FetTimetableEngine;
const engine = new FetTimetableEngine(schoolData);

console.log("Calling engine.solve()...");
const res = engine.solve();
console.log("Solve res:", res);

engine.initSubjectConstraints();
const violations = engine.evaluateLessonBlockViolations();
console.log("evaluateLessonBlockViolations after solve:", violations);
