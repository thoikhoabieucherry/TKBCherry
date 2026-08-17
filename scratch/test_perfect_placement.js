const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

// Apply the updated logic
let engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');

// Update init block formation
const oldBlockLoop = `          for(const len of [5, 4, 3, 2]){
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
          }`;

const newBlockLoop = `          const sessionLimit = this.getSubjectSessionLimit(lop, item.mon);
          if(sessionLimit >= 2){
            for(const len of [5, 4, 3, 2]){
              if(len > sessionLimit) continue;
              const req = this.classSubjectLessonBlocks ? (
                this.classSubjectLessonBlocks.get(\`\${cid}|\${sCanon}|\${len}\`) ||
                this.classSubjectLessonBlocks.get(\`\${classCanon}|\${sCanon}|\${len}\`)
              ) : null;
              if(req){
                const minReq = req.min != null ? Number(req.min) : 0;
                const maxReq = (req.max != null && req.max !== "") ? Number(req.max) : Infinity;
                if(minReq > 0 && remain >= len){
                  const maxPairs = Number.isFinite(maxReq) ? maxReq : Math.floor(remain / len);
                  const count = Math.min(maxPairs, Math.floor(remain / len));
                  for(let k = 0; k < count; k++){
                    blockDurs.push(len);
                    remain -= len;
                  }
                }
              }
            }
          }`;

engineCode = engineCode.replace(oldBlockLoop, newBlockLoop);

// Update unplaceActivity to preserve -2 (OFF) and -3 (FIXED)
const oldUnplace = `    unplaceActivity(actId){
      const act = this.activities[actId];
      const oldSlot = this.actPlacement[actId];
      if(!act || oldSlot < 0) return;

      for(let d = 0; d < act.duration; d++){
        const s = oldSlot + d;
        if(this.classGrid.get(act.classId)[s] === actId){
          this.classGrid.get(act.classId)[s] = -1;
        }
        if(act.gv){
          const tList = parseTeacherList(act.gv);
          tList.forEach(t => {
            if(this.teacherGrid.has(t) && this.teacherGrid.get(t)[s] === actId){
              this.teacherGrid.get(t)[s] = -1;
            }
          });
        }
        if(act.room){
          const rKey = act.room.trim().toLowerCase();
          if(this.roomGrid.has(rKey) && this.roomGrid.get(rKey)[s] === actId){
            this.roomGrid.get(rKey)[s] = -1;
          }
        }
      }
      this.actPlacement[actId] = -1;
    }`;

const newUnplace = `    unplaceActivity(actId){
      const act = this.activities[actId];
      const oldSlot = this.actPlacement[actId];
      if(!act || oldSlot < 0) return;

      for(let d = 0; d < act.duration; d++){
        const s = oldSlot + d;
        if(this.classGrid.get(act.classId)[s] === actId){
          const cKey = \`\${act.classId}|\${s}\`;
          if(this.offSlots.has(cKey)) this.classGrid.get(act.classId)[s] = -2;
          else if(this.fixedSlots.has(cKey)) this.classGrid.get(act.classId)[s] = -3;
          else this.classGrid.get(act.classId)[s] = -1;
        }
        if(act.gv){
          const tList = parseTeacherList(act.gv);
          tList.forEach(t => {
            if(this.teacherGrid.has(t) && this.teacherGrid.get(t)[s] === actId){
              const tKey = \`\${t}|\${s}\`;
              if(this.teacherOffSlots.has(tKey)) this.teacherGrid.get(t)[s] = -2;
              else this.teacherGrid.get(t)[s] = -1;
            }
          });
        }
        if(act.room){
          const rKey = act.room.trim().toLowerCase();
          if(this.roomGrid.has(rKey) && this.roomGrid.get(rKey)[s] === actId){
            const rmKey = \`\${rKey}|\${s}\`;
            if(this.roomOffSlots.has(rmKey)) this.roomGrid.get(rKey)[s] = -2;
            else this.roomGrid.get(rKey)[s] = -1;
          }
        }
      }
      this.actPlacement[actId] = -1;
    }`;

engineCode = engineCode.replace(oldUnplace, newUnplace);

eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;
const engine = new FetTimetableEngine(schoolData);

console.log("Running solve()...");
const res = engine.solve();
console.log("Solve result:", res);

const snap = engine.getSnapshotTKB();
let totalPlaced = 0;
for(const cid of Object.keys(snap)){
  const cTkb = snap[cid];
  for(const thu of ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"]){
    for(const buoi of ["sang", "chieu"]){
      const arr = cTkb[thu]?.[buoi] || [];
      for(let p = 0; p < arr.length; p++){
        const cell = arr[p];
        if(cell && cell !== "OFF" && cell !== "Nghỉ" && !cell.off){
          totalPlaced++;
        }
      }
    }
  }
}

console.log(`Total placed in snapTkb: ${totalPlaced}/2193`);
console.log("Violations:", engine.evaluateLessonBlockViolations());
