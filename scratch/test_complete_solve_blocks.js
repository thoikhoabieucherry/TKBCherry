const fs = require('fs');
const path = require('path');

let engineCode = fs.readFileSync(path.join(__dirname, '../web/pages/tkb-fet-engine.js'), 'utf8');

// In init(), add this.initSubjectConstraints() at top
engineCode = engineCode.replace(
  `    init(){\n      const data = this.data;`,
  `    init(){\n      this.initSubjectConstraints();\n      const data = this.data;`
);

// In init(), replace the activity creation loop with block-aware loop
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

// Also in solve(), in Intra-Session Permutations, check isLessonBlockSafe
const oldIntraPerm = `                  if(res1.possible && res1.conflicts.length === 0 && res2.possible && res2.conflicts.length === 0){
                    this.placeActivityDirect(actId1, s2);
                    this.placeActivityDirect(actId2, s1);`;

const newIntraPerm = `                  if(res1.possible && res1.conflicts.length === 0 && res2.possible && res2.conflicts.length === 0){
                    this.placeActivityDirect(actId1, s2);
                    this.placeActivityDirect(actId2, s1);
                    if(!this.isLessonBlockSafe(act1, act2)){
                      this.unplaceActivity(actId1);
                      this.unplaceActivity(actId2);
                      this.placeActivityDirect(actId1, s1);
                      this.placeActivityDirect(actId2, s2);
                      continue;
                    }`;

engineCode = engineCode.replace(oldIntraPerm, newIntraPerm);

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

const dur2Placed = engine.activities.filter(a => a.duration === 2 && engine.actPlacement[a.id] >= 0).length;
console.log("Duration 2 activities placed successfully:", dur2Placed);
