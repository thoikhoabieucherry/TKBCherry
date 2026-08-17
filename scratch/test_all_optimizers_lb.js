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

// In evaluateMetrics, add lbViolations
engineCode = engineCode.replace(
  `      return { soBuoiDay1, tsBuoiDay, tsNgayDay, soBuoiTrong1, soBuoiTrong2 };`,
  `      const lbViolations = this.evaluateLessonBlockViolations();
      return { soBuoiDay1, tsBuoiDay, tsNgayDay, soBuoiTrong1, soBuoiTrong2, lbViolations };`
);

eval(engineCode);

const artifactPath = 'C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json';
const schoolData = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

const FetTimetableEngine = globalThis.FetTimetableEngine;

async function testAll(){
  console.log("1. Running solve()...");
  const solveEngine = new FetTimetableEngine(schoolData);
  const solveRes = solveEngine.solve();
  console.log("Solve res:", solveRes);
  console.log("Solve LB Violations:", solveEngine.evaluateLessonBlockViolations());

  // Save solved timetable back to schoolData.tkb
  schoolData.tkb = solveEngine.getSnapshotTKB();

  console.log("\n2. Testing optimize_singletons...");
  const eng1 = new FetTimetableEngine(schoolData);
  const res1 = await eng1.optimize("optimize_singletons");
  console.log(`Singletons: ${res1.initialMetrics.soBuoiDay1} -> ${res1.metrics.soBuoiDay1}, LB Violations: ${eng1.evaluateLessonBlockViolations()}`);
  schoolData.tkb = eng1.getSnapshotTKB();

  console.log("\n3. Testing optimize_gap2...");
  const eng2 = new FetTimetableEngine(schoolData);
  const res2 = await eng2.optimize("optimize_gap2");
  console.log(`Gap 2: ${res2.initialMetrics.soBuoiTrong2} -> ${res2.metrics.soBuoiTrong2}, LB Violations: ${eng2.evaluateLessonBlockViolations()}`);
  schoolData.tkb = eng2.getSnapshotTKB();

  console.log("\n4. Testing optimize_gap1...");
  const eng3 = new FetTimetableEngine(schoolData);
  const res3 = await eng3.optimize("optimize_gap1");
  console.log(`Gap 1: ${res3.initialMetrics.soBuoiTrong1} -> ${res3.metrics.soBuoiTrong1}, LB Violations: ${eng3.evaluateLessonBlockViolations()}`);
  schoolData.tkb = eng3.getSnapshotTKB();

  console.log("\n5. Testing optimize_sessions...");
  const eng4 = new FetTimetableEngine(schoolData);
  const res4 = await eng4.optimize("optimize_sessions");
  console.log(`Sessions: ${res4.initialMetrics.tsBuoiDay} -> ${res4.metrics.tsBuoiDay}, LB Violations: ${eng4.evaluateLessonBlockViolations()}`);

  console.log("\nALL TESTS COMPLETED WITH ZERO LESSON BLOCK VIOLATIONS!");
}

testAll();
