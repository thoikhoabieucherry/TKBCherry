const fs = require('fs');

let engineCode = fs.readFileSync('c:/Users/Love/Documents/Codex/backup/TKBCherry/web/pages/tkb-fet-engine.js', 'utf8');

// 1. Add helper methods
const helperMethods = `
    initLessonBlockRules(){
      this.classSubjectLessonBlocks = new Map();
      const constraints = this.data.tkbConstraints;
      if(!constraints || !constraints.subject) return;

      Object.entries(constraints.subject).forEach(([sKey, subConf]) => {
        if(!subConf || !subConf.byClass) return;
        const sCanon = this.getCanonMonKey(sKey);

        Object.entries(subConf.byClass).forEach(([cId, cConf]) => {
          if(!cConf || !cConf.lessonBlocks) return;
          const classCanon = String(cId || "").trim();

          Object.entries(cConf.lessonBlocks).forEach(([lenStr, bConf]) => {
            const len = parseInt(lenStr, 10);
            if(!len || len < 2) return;
            const min = bConf?.min != null ? Number(bConf.min) : 0;
            const max = bConf?.max != null ? Number(bConf.max) : Infinity;
            if(min > 0 || max < Infinity){
              const entry = { cid: cId, classCanon, sCanon, mon: sKey, len, min, max };
              this.classSubjectLessonBlocks.set(\`\${cId}|\${sCanon}|\${len}\`, entry);
            }
          });
        });
      });
    }

    isLessonBlockSafe(...acts){
      if(!this.classSubjectLessonBlocks || this.classSubjectLessonBlocks.size === 0) return true;
      const checkedClasses = new Set();
      for(const act of acts){
        if(!act || !act.classId || checkedClasses.has(act.classId)) continue;
        checkedClasses.add(act.classId);

        const cid = act.classId;
        const cGrid = this.classGrid.get(cid);
        if(!cGrid) continue;

        for(const [key, req] of this.classSubjectLessonBlocks.entries()){
          if(req.cid !== cid && req.classCanon !== cid) continue;

          let blocks = 0;
          for(let d = 0; d < DAYS_LIST.length; d++){
            for(let b = 0; b < SESSIONS_LIST.length; b++){
              const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
              const idx = [];
              for(let p = 0; p < PERIODS_PER_SESSION; p++){
                const actId = cGrid[sStart + p];
                if(actId >= 0){
                  const a = this.activities[actId];
                  if(a && (a.canonKey === req.sCanon || this.getCanonMonKey(a.mon) === req.sCanon)){
                    idx.push(p + 1);
                  }
                }else if(actId === -3){
                  const fix = this.fixedSlots.get(\`\${cid}|\${sStart + p}\`);
                  if(fix && fix.mon && this.getCanonMonKey(fix.mon) === req.sCanon){
                    idx.push(p + 1);
                  }
                }
              }
              if(idx.length >= req.len){
                const sSet = new Set(idx);
                for(const i of idx){
                  let ok = true;
                  for(let k = 0; k < req.len; k++){
                    if(!sSet.has(i + k)) ok = false;
                  }
                  if(ok && !sSet.has(i - 1)) blocks++;
                }
              }
            }
          }
          if(blocks < req.min) return false;
        }
      }
      return true;
    }

    evaluateLessonBlockViolations(){
      if(!this.classSubjectLessonBlocks || this.classSubjectLessonBlocks.size === 0) return 0;
      let violations = 0;
      for(const [key, req] of this.classSubjectLessonBlocks.entries()){
        const cGrid = this.classGrid.get(req.cid);
        if(!cGrid) continue;

        let blocks = 0;
        for(let d = 0; d < DAYS_LIST.length; d++){
          for(let b = 0; b < SESSIONS_LIST.length; b++){
            const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
            const idx = [];
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const actId = cGrid[sStart + p];
              if(actId >= 0){
                const act = this.activities[actId];
                if(act && (act.canonKey === req.sCanon || this.getCanonMonKey(act.mon) === req.sCanon)){
                  idx.push(p + 1);
                }
              }else if(actId === -3){
                const fix = this.fixedSlots.get(\`\${req.cid}|\${sStart + p}\`);
                if(fix && fix.mon && this.getCanonMonKey(fix.mon) === req.sCanon){
                  idx.push(p + 1);
                }
              }
            }
            if(idx.length >= req.len){
              const sSet = new Set(idx);
              for(const i of idx){
                let ok = true;
                for(let k = 0; k < req.len; k++){
                  if(!sSet.has(i + k)) ok = false;
                }
                if(ok && !sSet.has(i - 1)) blocks++;
              }
            }
          }
        }
        if(blocks < req.min){
          violations += (req.min - blocks);
        }
      }
      return violations;
    }
`;

engineCode = engineCode.replace(
  `class FetTimetableEngine {`,
  `class FetTimetableEngine {\n${helperMethods}`
);

// 2. Call this.initLessonBlockRules() in init()
engineCode = engineCode.replace(
  `    init(){\n      const data = this.data;`,
  `    init(){\n      this.initLessonBlockRules();\n      const data = this.data;`
);

// 3. Create duration: 2 activities in init()
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

// 4. Sort duration >= 2 first in computeDifficultiesAndSort()
engineCode = engineCode.replace(
  `      this.activities.sort((a, b) => {
        if(b.nIncompatible !== a.nIncompatible){
          return b.nIncompatible - a.nIncompatible;
        }
        return b.duration - a.duration;
      });`,
  `      this.activities.sort((a, b) => {
        if(b.duration !== a.duration){
          return b.duration - a.duration;
        }
        return b.nIncompatible - a.nIncompatible;
      });`
);

// 5. In placeActivityDirect, clean unplace if already placed
const oldPlace = `    placeActivityDirect(actId, slot){
      const act = this.activities[actId];
      if(!act) return;
      this.actPlacement[actId] = slot;`;

const newPlace = `    placeActivityDirect(actId, slot){
      const act = this.activities[actId];
      if(!act) return;
      if(this.actPlacement[actId] >= 0 && this.actPlacement[actId] !== slot){
        this.unplaceActivity(actId);
      }
      this.actPlacement[actId] = slot;`;

engineCode = engineCode.replace(oldPlace, newPlace);

// 6. Protect Polish pass intra-session loop
const oldPermute = `                  const act1 = this.activities[actId1];
                  const act2 = this.activities[actId2];
                  if(!act1 || !act2 || act1.isFixed || act2.isFixed) continue;`;

const newPermute = `                  const act1 = this.activities[actId1];
                  const act2 = this.activities[actId2];
                  if(!act1 || !act2 || act1.isFixed || act2.isFixed) continue;
                  if(act1.duration !== 1 || act2.duration !== 1) continue;
                  if(!this.isLessonBlockSafe(act1, act2)) continue;`;

engineCode = engineCode.replace(oldPermute, newPermute);

// 7. Remove decompSingles in solve()
const oldDecomp = `      const decompSingles = [];
      const initialActCount = this.activities.length;
      for(let i = 0; i < initialActCount; i++){
        const act = this.activities[i];
        if(this.actPlacement[act.id] < 0 && act.duration >= 2){
          act.duration = 1;
          const extraSingle = {
            id: this.activities.length,
            classId: act.classId,
            classCanon: act.classCanon,
            lop: act.lop,
            mon: act.mon,
            gv: act.gv,
            room: act.room,
            duration: 1,
            isFixed: false,
            fixedSlot: -1,
            nIncompatible: act.nIncompatible
          };
          this.activities.push(extraSingle);
          this.actPlacement.push(-1);
          decompSingles.push(act);
          decompSingles.push(extraSingle);
        }
      }`;

const newDecomp = `      // Keep 2-period blocks intact!`;

engineCode = engineCode.replace(oldDecomp, newDecomp);

fs.writeFileSync('web/pages/tkb-fet-engine.js', engineCode, 'utf8');
console.log("Successfully wrote updated engine to web/pages/tkb-fet-engine.js");
