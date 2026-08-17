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

// In solve(), disable Polish pass temporarily to see raw placement violations
engineCode = engineCode.replace(
  `        // 1. Consolidate 1-period sessions`,
  `        /* // 1. Consolidate 1-period sessions`
);
engineCode = engineCode.replace(
  `        // 4. Compact 1-period gaps\n        for(let r = 0; r < 5; r++){\n          const resGap1 = this.tryCrushTeacherGaps(polishMetrics, initialPolishMetrics, "optimize_gap1");\n          if(resGap1) polishMetrics = { ...resGap1 };\n          else break;\n        }\n      }`,
  `        // 4. Compact 1-period gaps\n        for(let r = 0; r < 5; r++){\n          const resGap1 = this.tryCrushTeacherGaps(polishMetrics, initialPolishMetrics, "optimize_gap1");\n          if(resGap1) polishMetrics = { ...resGap1 };\n          else break;\n        }\n      */ }`
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
console.log("evaluateLessonBlockViolations without polish pass:", violations);
