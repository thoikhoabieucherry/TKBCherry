const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

let engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');

// Replace loadExistingSchedule with intelligent pair reconstruction
const oldLoadSnippet = `        const cid = String(lop.id || "");
        DAYS_LIST.forEach(thu => {
          SESSIONS_LIST.forEach(buoi => {
            const arr = data.tkb?.[cid]?.[thu]?.[buoi] || [];
            for(let ti = 0; ti < PERIODS_PER_SESSION; ti++){
              const slot = detailsToSlot(thu, buoi, ti);
              const cell = arr[ti];
              if(cell && cell !== "OFF" && !this.isCellOff(cell) && !this.isCellFixed(cell, cid, slot)){
                const mon = this.extractMon(cell);
                const gv = this.getTeacherForClassMon(lop, mon);
                const rm = this.getRoomForClassMon(lop, mon);
                const act = {
                  id: actCounter++,
                  classId: cid,
                  classCanon: lop.ten2 || lop.ten || cid,
                  lop,
                  mon,
                  gv,
                  room: rm,
                  duration: 1,
                  isFixed: false,
                  fixedSlot: -1,
                  nIncompatible: 0
                };
                actList.push(act);
              }
            }
          });
        });`;

const newLoadSnippet = `        const cid = String(lop.id || "");
        const classCanon = lop.ten2 || lop.ten || cid;
        DAYS_LIST.forEach(thu => {
          SESSIONS_LIST.forEach(buoi => {
            const arr = data.tkb?.[cid]?.[thu]?.[buoi] || [];
            let ti = 0;
            while(ti < PERIODS_PER_SESSION){
              const slot = detailsToSlot(thu, buoi, ti);
              const cell = arr[ti];
              if(!cell || cell === "OFF" || this.isCellOff(cell) || this.isCellFixed(cell, cid, slot)){
                ti++;
                continue;
              }

              const mon = this.extractMon(cell);
              const sCanon = this.getCanonMonKey(mon);
              const gv = this.getTeacherForClassMon(lop, mon);
              const rm = this.getRoomForClassMon(lop, mon);

              // Check if consecutive block exists and matches lessonBlocks requirements
              let blockLen = 1;
              if(ti + 1 < PERIODS_PER_SESSION){
                const nextCell = arr[ti + 1];
                const nextSlot = detailsToSlot(thu, buoi, ti + 1);
                if(nextCell && nextCell !== "OFF" && !this.isCellOff(nextCell) && !this.isCellFixed(nextCell, cid, nextSlot)){
                  const nextMon = this.extractMon(nextCell);
                  const nextCanon = this.getCanonMonKey(nextMon);
                  if(nextCanon === sCanon){
                    const req = this.classSubjectLessonBlocks ? (
                      this.classSubjectLessonBlocks.get(\`\${cid}|\${sCanon}|2\`) ||
                      this.classSubjectLessonBlocks.get(\`\${classCanon}|\${sCanon}|2\`)
                    ) : null;
                    if(req && req.min > 0){
                      blockLen = 2;
                    }
                  }
                }
              }

              const act = {
                id: actCounter++,
                classId: cid,
                classCanon,
                lop,
                mon,
                canonKey: sCanon,
                gv,
                room: rm,
                duration: blockLen,
                isFixed: false,
                fixedSlot: -1,
                initSlot: slot,
                nIncompatible: 0
              };
              actList.push(act);
              ti += blockLen;
            }
          });
        });`;

engineCode = engineCode.replace(oldLoadSnippet, newLoadSnippet);

// Update step 3 of loadExistingSchedule to use act.initSlot
const oldStep3 = `      let idx = 0;
      this.classes.forEach(lop => {
        const cid = String(lop.id || "");
        DAYS_LIST.forEach(thu => {
          SESSIONS_LIST.forEach(buoi => {
            const arr = data.tkb?.[cid]?.[thu]?.[buoi] || [];
            for(let ti = 0; ti < PERIODS_PER_SESSION; ti++){
              const slot = detailsToSlot(thu, buoi, ti);
              const cell = arr[ti];
              if(cell && cell !== "OFF" && !this.isCellOff(cell) && !this.isCellFixed(cell, cid, slot)){
                const act = this.activities[idx++];
                if(act){
                  this.placeActivityDirect(act.id, slot);
                }
              }
            }
          });
        });
      });`;

const newStep3 = `      this.activities.forEach(act => {
        if(act.initSlot >= 0){
          this.placeActivityDirect(act.id, act.initSlot);
        }
      });`;

engineCode = engineCode.replace(oldStep3, newStep3);

eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;

// 1. Solve initial schedule
const solver = new FetTimetableEngine(schoolData);
solver.solve();
schoolData.tkb = solver.getSnapshotTKB();

console.log("Initial schedule lesson block violations:", solver.evaluateLessonBlockViolations());
console.log("Initial schedule metrics:", solver.evaluateMetrics());

// 2. Load schedule in optimizer
const optimizer = new FetTimetableEngine(schoolData);
optimizer.loadExistingSchedule();

console.log("Loaded activities count:", optimizer.activities.length);
const dur2Acts = optimizer.activities.filter(a => a.duration === 2);
console.log("Duration 2 activities in loaded schedule:", dur2Acts.length);

// 3. Run optimizer
console.log("\nRunning optimizer.optimize('optimize_singletons')...");
const t0 = Date.now();
optimizer.optimize('optimize_singletons').then(res => {
  const t1 = Date.now();
  console.log(`Optimize finished in ${t1 - t0}ms:`, res);
  console.log("Post-optimize lesson block violations:", optimizer.evaluateLessonBlockViolations());
  console.log("Post-optimize metrics:", optimizer.evaluateMetrics());
  
  // Verify snapTkb
  const snap = optimizer.getSnapshotTKB();
  let placedCount = 0;
  for(const cid of Object.keys(snap)){
    const cTkb = snap[cid] || {};
    for(const d of ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"]){
      for(const b of ["sang", "chieu"]){
        const arr = cTkb[d]?.[b] || [];
        for(let p = 0; p < arr.length; p++){
          const c = arr[p];
          if(c && c !== "OFF" && c !== "Nghỉ" && !c.off) placedCount++;
        }
      }
    }
  }
  console.log(`Placed in snapTkb after optimize: ${placedCount} / 2193`);
});
