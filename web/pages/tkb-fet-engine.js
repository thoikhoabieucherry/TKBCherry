/**
 * FET Timetable Engine for TKBCherry (Pure JS Local Implementation)
 * 
 * Implements the full core algorithms from FET (Free Educational Timetabling):
 * 1. Activity Difficulty Heuristic & Stable Sort (Most Difficult First, nIncompatible)
 * 2. Recursive Swapping with Backtracking & Tabu Search (randomSwap with max depth 16)
 * 3. MRG32k3a / Fisher-Yates slot permutation
 * 4. Multi-period block preservation with Dynamic Decomposition (tiết đôi / liên tiếp, tự phân rã khi cần để lấp kín 100%)
 * 5. Strict preservation of Fixed cells (tiết cố định) - preserves exact original object/styling
 * 6. Strict preservation of Prohibited / Off slots (tiết nghỉ của Lớp, Giáo viên, Phòng)
 * 7. Strict Subject Session Upper Limit (giới hạn tối đa số tiết/môn/buổi, ví dụ <= 2 hoặc <= 1)
 * 8. Multi-pass Ejection Chain & Cross-Class Relocation for 100% schedule completion
 */

(function(global){
  'use strict';

  const DAYS_LIST = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
  const SESSIONS_LIST = ["sang", "chieu"];
  const PERIODS_PER_SESSION = 5;
  const SLOTS_PER_DAY = SESSIONS_LIST.length * PERIODS_PER_SESSION; // 10
  const TOTAL_SLOTS = DAYS_LIST.length * SLOTS_PER_DAY; // 60

  const INF = 1500000000;
  const INF2 = 2000000000;
  const MAX_RECURSION_LEVEL = 16;

  // PRNG (MRG32k3a equivalent for reproducible high quality randomization)
  class FetPRNG {
    constructor(seed = Date.now()){
      this.s10 = (seed & 0x7fffffff) || 12345;
      this.s11 = ((seed * 1103515245 + 12345) & 0x7fffffff) || 67890;
      this.s12 = ((seed * 214013 + 2531011) & 0x7fffffff) || 13579;
    }
    next(){
      const p = (this.s10 * 16807 + this.s11 * 48271 + this.s12 * 69621) % 2147483647;
      this.s10 = this.s11;
      this.s11 = this.s12;
      this.s12 = p;
      return (p & 0x7fffffff) / 2147483647;
    }
    nextInt(maxExclusive){
      if(maxExclusive <= 1) return 0;
      return Math.floor(this.next() * maxExclusive);
    }
    shuffle(array){
      for(let i = array.length - 1; i > 0; i--){
        const j = this.nextInt(i + 1);
        const temp = array[i];
        array[i] = array[j];
        array[j] = temp;
      }
      return array;
    }
  }

  function slotToDetails(slotIndex){
    const dayIdx = Math.floor(slotIndex / SLOTS_PER_DAY);
    const inDay = slotIndex % SLOTS_PER_DAY;
    const sessionIdx = Math.floor(inDay / PERIODS_PER_SESSION);
    const periodIdx = inDay % PERIODS_PER_SESSION;
    return {
      dayIdx,
      thu: DAYS_LIST[dayIdx] || "thu2",
      sessionIdx,
      buoi: SESSIONS_LIST[sessionIdx] || "sang",
      periodIdx
    };
  }

  function detailsToSlot(thu, buoi, periodIdx){
    const dayIdx = DAYS_LIST.indexOf(thu);
    const sessionIdx = SESSIONS_LIST.indexOf(buoi);
    if(dayIdx < 0 || sessionIdx < 0 || periodIdx < 0 || periodIdx >= PERIODS_PER_SESSION){
      return -1;
    }
    return dayIdx * SLOTS_PER_DAY + sessionIdx * PERIODS_PER_SESSION + periodIdx;
  }


  function buildTeacherCanonMap(data) {
    const map = new Map();
    const gvList = Array.isArray(data?.giaovien) ? data.giaovien : (Array.isArray(data?.gv) ? data.gv : []);
    
    gvList.forEach(g => {
      if(!g) return;
      const canonId = String(g.id || g.ma || g.ten || "").trim().toLowerCase();
      if(!canonId) return;

      const keys = [
        String(g.id || "").trim().toLowerCase(),
        String(g.ma || "").trim().toLowerCase(),
        String(g.ten || "").trim().toLowerCase(),
        String(g.ten2 || "").trim().toLowerCase(),
        String(g.hoten || "").trim().toLowerCase()
      ];

      // Also add 'Ma - Ten'
      if(g.ma && g.ten) {
        keys.push(`${String(g.ma).trim().toLowerCase()} - ${String(g.ten).trim().toLowerCase()}`);
      }

      keys.filter(Boolean).forEach(k => {
        map.set(k, canonId);
        // Also strip diacritics
        const noDiacritics = k.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd');
        map.set(noDiacritics, canonId);
      });
    });

    return map;
  }

  function parseTeacherList(raw, canonMap = null){
    if(!raw) return [];
    let list = [];
    if(Array.isArray(raw)){
      list = raw.map(t => String(t || "").trim().toLowerCase()).filter(Boolean);
    } else {
      list = String(raw)
        .replace(/\r?\n/g, ",")
        .replace(/[;;]+/g, ",")
        .replace(/\s*[++]\s*/g, ",")
        .split(",")
        .map(t => {
          let s = t.trim().toLowerCase();
          if(s.includes(" - ")) s = s.split(" - ")[0].trim(); // Extract short code if 'Ma - Ten'
          return s;
        })
        .filter(Boolean);
    }
    if(canonMap && canonMap.size > 0){
      return list.map(t => canonMap.get(t) || t);
    }
    return list;
  }

  class FetTimetableEngine {

    initLessonBlockRules(){
      this.classSubjectLessonBlocks = new Map();
      const constraints = this.data.tkbConstraints;
      if(!constraints || !constraints.subject) return;

      const classMap = new Map();
      const rawLop = Array.isArray(this.data.lop) ? this.data.lop : [];
      rawLop.forEach(l => {
        if(l.id) classMap.set(String(l.id).trim().toLowerCase(), String(l.id).trim());
        if(l.ten) {
          classMap.set(String(l.ten).trim().toLowerCase(), String(l.id || l.ten).trim());
          classMap.set(String(l.ten).trim(), String(l.id || l.ten).trim());
        }
      });

      Object.entries(constraints.subject).forEach(([sKey, subConf]) => {
        if(!subConf || !subConf.byClass) return;
        const sCanon = this.getCanonMonKey(sKey);

        Object.entries(subConf.byClass).forEach(([cId, cConf]) => {
          if(!cConf || !cConf.lessonBlocks) return;
          const classCanon = String(cId || "").trim();
          const targetCid = classMap.get(classCanon.toLowerCase()) || classCanon;

          Object.entries(cConf.lessonBlocks).forEach(([lenStr, bConf]) => {
            const len = parseInt(lenStr, 10);
            if(!len || len < 2) return;
            const min = bConf?.min != null ? Number(bConf.min) : 0;
            const max = bConf?.max != null ? Number(bConf.max) : Infinity;
            if(min > 0 || max < Infinity){
              const entry = { cid: targetCid, classCanon, sCanon, mon: sKey, len, min, max };
              this.classSubjectLessonBlocks.set(`${targetCid}|${sCanon}|${len}`, entry);
            }
          });
        });
      });
    }

    isLessonBlockSafe(...acts){
      if(!this.classSubjectLessonBlocks || this.classSubjectLessonBlocks.size === 0) return true;
      let targetClasses = null;
      if(acts && acts.length > 0){
        targetClasses = new Set(acts.map(a => a?.classId).filter(Boolean));
      }

      for(const [key, req] of this.classSubjectLessonBlocks.entries()){
        if(targetClasses && !targetClasses.has(req.cid) && !targetClasses.has(req.classCanon)) continue;
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
                const a = this.activities[actId];
                if(a && (a.canonKey === req.sCanon || this.getCanonMonKey(a.mon) === req.sCanon)){
                  idx.push(p + 1);
                }
              }else if(actId === -3){
                const fix = this.fixedSlots.get(`${req.cid}|${sStart + p}`);
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
        if(Number.isFinite(req.max) && blocks > req.max) return false;
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
                const fix = this.fixedSlots.get(`${req.cid}|${sStart + p}`);
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

    constructor(data, options = {}){
      this.data = data || {};
      this.options = options || {};
      this.rng = new FetPRNG(options.seed || Date.now());

      this.classes = [];
      this.activities = [];
      this.fixedSlots = new Map();    // key `${classId}|${slotIndex}` -> { mon, gv, room }
      this.fixedRawCells = new Map(); // key `${classId}|${slotIndex}` -> raw exact cell object
      this.offSlots = new Set();      // `${classId}|${slotIndex}`
      this.teacherOffSlots = new Set(); // `${teacherKey}|${slotIndex}`
      this.roomOffSlots = new Set();    // `${roomKey}|${slotIndex}`
      this.subjectOffSlots = new Set(); // `${subjectKey}|${slotIndex}`

      // State matrices
      this.classGrid = new Map();   // classId -> Array(60) of actId / -1 / -2(OFF) / -3(FIXED)
      this.teacherGrid = new Map(); // teacherKey -> Array(60) of actId / -1 / -2(OFF) / -3(FIXED)
      this.roomGrid = new Map();    // roomKey -> Array(60) of actId / -1 / -2(OFF) / -3(FIXED)
      this.actPlacement = [];       // actId -> slotIndex or -1

      // Tabu & Recursion stats
      this.tabuMap = new Map();
      this.currentStep = 0;
      this.nCalls = 0;
      this.limitCalls = 0;
      this.restoreStack = [];
      this.moveJournal = [];
      this.swappedInBranch = new Set();
    }

    // Parse data from TKBCherry DATA object
    init(){
      const data = this.data;
      const rawLop = Array.isArray(data.lop) ? data.lop : [];
      this.classes = rawLop.filter(l => l && (l.id || l.ten));

      const classMap = new Map();
      this.classes.forEach(l => {
        if(l.id) classMap.set(String(l.id).trim().toLowerCase(), String(l.id).trim());
        if(l.ten) {
          classMap.set(String(l.ten).trim().toLowerCase(), String(l.id || l.ten).trim());
          classMap.set(String(l.ten).trim(), String(l.id || l.ten).trim());
        }
      });

      this.initLessonBlockRules();

      // ================= SCORED TEACHER UNIVERSE (metric alignment) ==========
      // UI statistics (calcTeacherTKBStats) count only teachers coming from
      // pccmMatrix values. The engine used to score EVERY teacherGrid row —
      // including ghost rows from fixed cells / odd strings — so it optimised
      // an inflated objective the user never sees. Metrics and operator
      // targeting now use exactly the pccm-derived universe; conflict checks
      // still respect every row.
      this.scoredTeachers = null;
      try{
        const scored = new Set();
        const pccm = (data && data.pccmMatrix && typeof data.pccmMatrix === "object") ? data.pccmMatrix : {};
        for(const value of Object.values(pccm)){
          for(const t of parseTeacherList(value)) scored.add(t);
        }
        if(scored.size > 0) this.scoredTeachers = scored;
      }catch(_){ this.scoredTeachers = null; }

      // Build classes map
      this.classes.forEach(l => {
        const cid = String(l.id || "");
        this.classGrid.set(cid, new Array(TOTAL_SLOTS).fill(-1));
      });

      // 1. Scan current DATA.tkb for OFF and FIXED cells
      this.classes.forEach(l => {
        const cid = String(l.id || "");
        DAYS_LIST.forEach((thu, dIdx) => {
          SESSIONS_LIST.forEach((buoi, sIdx) => {
            const arr = data.tkb?.[cid]?.[thu]?.[buoi] || [];
            for(let ti = 0; ti < PERIODS_PER_SESSION; ti++){
              const slot = detailsToSlot(thu, buoi, ti);
              const cell = arr[ti];
              const key = `${cid}|${slot}`;

              if(this.isCellOff(cell)){
                this.offSlots.add(key);
                this.classGrid.get(cid)[slot] = -2; // -2 denotes OFF
              }else if(cell && this.isCellFixed(cell)){
                const mon = this.extractMon(cell);
                let gv = "";
                if(typeof cell === "object" && cell.gv){
                  gv = String(cell.gv).trim();
                }else if(typeof cell === "string" && cell.includes(" - ")){
                  gv = cell.split(" - ")[1].trim();
                }
                if(!gv){
                  gv = this.getTeacherForClassMon(l, mon);
                }
                const rm = this.getRoomForClassMon(l, mon);
                this.fixedSlots.set(key, { mon, gv, room: rm });
                this.fixedRawCells.set(key, cell); // Store exact original object
                this.classGrid.get(cid)[slot] = -3; // -3 denotes FIXED

                // Record teacher & room fixed occupancy
                const tList = parseTeacherList(gv);
                tList.forEach(t => {
                  if(!this.teacherGrid.has(t)) this.teacherGrid.set(t, new Array(TOTAL_SLOTS).fill(-1));
                  this.teacherGrid.get(t)[slot] = -3;
                });
                if(rm){
                  const rKey = rm.trim().toLowerCase();
                  if(!this.roomGrid.has(rKey)) this.roomGrid.set(rKey, new Array(TOTAL_SLOTS).fill(-1));
                  this.roomGrid.get(rKey)[slot] = -3;
                }
              }
            }
          });
        });
      });

      // 2. Scan external constraints (fixedOff from tkbConstraints)
      const classOffConstraints = data.tkbConstraints?.fixedOff?.class || data.lopNghi || {};
      Object.keys(classOffConstraints).forEach(cRaw => {
        const targetCid = classMap.get(String(cRaw).trim().toLowerCase()) || String(cRaw).trim();
        const slotsObj = classOffConstraints[cRaw] || {};
        Object.keys(slotsObj).forEach(k => {
          if(slotsObj[k]){
            const parts = k.replace(/_/g, "|").split("|");
            if(parts.length >= 3){
              const slot = detailsToSlot(parts[0], parts[1], Number(parts[2]));
              if(slot >= 0){
                this.offSlots.add(`${targetCid}|${slot}`);
                this.offSlots.add(`${cRaw}|${slot}`);
                if(this.classGrid.has(targetCid)) this.classGrid.get(targetCid)[slot] = -2;
                if(this.classGrid.has(cRaw)) this.classGrid.get(cRaw)[slot] = -2;
              }
            }
          }
        });
      });

      const teacherOffConstraints = data.tkbConstraints?.fixedOff?.teacher || data.teacherOff || data.gvNghi || {};
      Object.keys(teacherOffConstraints).forEach(tRaw => {
        const tKey = tRaw.trim().toLowerCase();
        const slotsObj = teacherOffConstraints[tRaw] || {};
        Object.keys(slotsObj).forEach(k => {
          if(slotsObj[k]){
            const parts = k.replace(/_/g, "|").split("|");
            if(parts.length >= 3){
              const slot = detailsToSlot(parts[0], parts[1], Number(parts[2]));
              if(slot >= 0){
                this.teacherOffSlots.add(`${tKey}|${slot}`);
                if(!this.teacherGrid.has(tKey)) this.teacherGrid.set(tKey, new Array(TOTAL_SLOTS).fill(-1));
                this.teacherGrid.get(tKey)[slot] = -2; // Teacher OFF
              }
            }
          }
        });
      });

      const roomOffConstraints = data.tkbConstraints?.fixedOff?.room || {};
      Object.keys(roomOffConstraints).forEach(rRaw => {
        const rKey = rRaw.trim().toLowerCase();
        const slotsObj = roomOffConstraints[rRaw] || {};
        Object.keys(slotsObj).forEach(k => {
          if(slotsObj[k]){
            const parts = k.replace(/_/g, "|").split("|");
            if(parts.length >= 3){
              const slot = detailsToSlot(parts[0], parts[1], Number(parts[2]));
              if(slot >= 0){
                this.roomOffSlots.add(`${rKey}|${slot}`);
                if(!this.roomGrid.has(rKey)) this.roomGrid.set(rKey, new Array(TOTAL_SLOTS).fill(-1));
                this.roomGrid.get(rKey)[slot] = -2;
              }
            }
          }
        });
      });

      const subjectOffConstraints = data.tkbConstraints?.fixedOff?.subject || {};
      Object.keys(subjectOffConstraints).forEach(sRaw => {
        const sCanon = this.getCanonMonKey(sRaw);
        const norm = this.normalizeMonName(sRaw);
        const slotsObj = subjectOffConstraints[sRaw] || {};
        Object.keys(slotsObj).forEach(k => {
          if(slotsObj[k]){
            const parts = k.replace(/_/g, "|").split("|");
            if(parts.length >= 3){
              const slot = detailsToSlot(parts[0], parts[1], Number(parts[2]));
              if(slot >= 0){
                this.subjectOffSlots.add(`${sCanon}|${slot}`);
                this.subjectOffSlots.add(`${norm}|${slot}`);
                this.subjectOffSlots.add(`${sRaw.trim().toLowerCase()}|${slot}`);
              }
            }
          }
        });
      });

      // 3. Build Activities from PCCM Matrix
      this.buildActivities();
    }

    isCellOff(cell){
      if(!cell) return false;
      if(cell === "OFF" || cell === "off") return true;
      if(typeof cell === "string" && (cell.trim().toLowerCase() === "nghi" || cell.trim().toLowerCase() === "off")) return true;
      if(typeof cell === "object" && (cell.off === true || cell.val === "OFF" || cell.mon === "OFF" || cell.off === 1 || cell.nghi === true)) return true;
      return false;
    }

    isCellFixed(cell){
      if(!cell) return false;
      if(typeof cell === "object" && (cell.fixed === true || cell.fixed === 1 || cell.cd === 1 || cell.cd === true || cell.codinh === true || cell.codinh === 1 || cell.isFixed === true || cell.locked === true)) return true;
      if(typeof cell === "string"){
        const s = cell.trim();
        if(s.startsWith("!") || s.endsWith("*") || s.includes("[fixed]") || s.startsWith("[cd]") || s.includes("(cố định)") || s.includes("(co dinh)")) return true;
      }
      return false;
    }

    extractTeacher(cell){
      if(!cell) return "";
      if(typeof cell === "object"){
        if(cell.gv) return String(cell.gv).trim();
        if(cell.teacher) return String(cell.teacher).trim();
        if(cell.mon && typeof cell.mon === "string" && cell.mon.includes(" - ")){
          return cell.mon.split(" - ").slice(1).join(" - ").trim();
        }
      }
      if(typeof cell === "string" && cell.includes(" - ")){
        return cell.split(" - ").slice(1).join(" - ").trim();
      }
      return "";
    }

    extractRoom(cell){
      if(!cell) return "";
      if(typeof cell === "object"){
        if(cell.room) return String(cell.room).trim();
        if(cell.phong) return String(cell.phong).trim();
      }
      return "";
    }

    extractMon(cell){
      if(!cell) return "";
      let m = "";
      if(typeof cell === "object") m = String(cell.mon || cell.val || cell.subject || "").trim();
      else m = String(cell).trim();
      if(m.includes(" - ")){
        m = m.split(" - ")[0].trim();
      }
      return m.replace(/^[!*]+|[!*]+$/g, "").replace(/\[fixed\]/gi, "").replace(/\[co_dinh\]/gi, "").trim();
    }

    normalizeMonName(name){
      if(!name) return "";
      let s = String(name).normalize('NFC').trim();
      if(s.includes(" - ")){
        s = s.split(" - ")[0].trim();
      }
      s = s.replace(/^[!*]+|[!*]+$/g, "").replace(/\[fixed\]/gi, "").replace(/\[co_dinh\]/gi, "").trim();
      s = s.replace(/\s+/g, " ");
      return s.toLowerCase();
    }

    getTeacherForClassMon(lop, mon){
      const data = this.data;
      if(!lop || !mon) return "";
      const classId = String(lop.id || "");
      const classCanon = lop.ten2 || lop.ten || classId;
      const key1 = `${classId}|${mon}`;
      const key2 = `${classCanon}|${mon}`;
      let val = data.pccmMatrix?.[key1] || data.pccmMatrix?.[key2] || data.tkbLessonTeachers?.[key1] || data.tkbLessonTeachers?.[key2] || "";
      if(!val){
        const norm = this.normalizeMonName(mon);
        const canon = this.getCanonMonKey(mon);
        for(const k of Object.keys(data.pccmMatrix || {})){
          if(k.startsWith(classId + "|") || k.startsWith(classCanon + "|")){
            const m = k.split("|").slice(1).join("|");
            if(this.normalizeMonName(m) === norm || (canon && this.getCanonMonKey(m) === canon)){
              val = data.pccmMatrix[k];
              break;
            }
          }
        }
      }
      return String(val || "").trim();
    }

    getRoomForClassMon(lop, mon){
      const data = this.data;
      if(!lop || !mon) return "";
      const classId = String(lop.id || "");
      const classCanon = lop.ten2 || lop.ten || classId;
      const key1 = `${classId}|${mon}`;
      const key2 = `${classCanon}|${mon}`;
      let val = data.pccmRoomMatrix?.[key1] || data.pccmRoomMatrix?.[key2] || data.tkbLessonRooms?.[key1] || data.tkbLessonRooms?.[key2] || "";
      if(!val){
        const norm = this.normalizeMonName(mon);
        for(const k of Object.keys(data.pccmRoomMatrix || {})){
          if(k.startsWith(classId + "|") || k.startsWith(classCanon + "|")){
            const m = k.split("|").slice(1).join("|");
            if(this.normalizeMonName(m) === norm){
              val = data.pccmRoomMatrix[k];
              break;
            }
          }
        }
      }
      return String(val || "").trim();
    }

    extractKhoiNumber(str){
      if(!str) return "";
      const m = String(str).match(/\d+/);
      return m ? m[0] : "";
    }

    getRequiredPeriods(lop, mon){
      const data = this.data;
      const classId = String(lop?.id || "");
      const classCanon = lop?.ten2 || lop?.ten || classId;
      const key1 = `${classId}|${mon}`;
      const key2 = `${classCanon}|${mon}`;
      let raw = data.pccmTietMatrix?.[key1] ?? data.pccmTietMatrix?.[key2];
      if(raw === undefined || raw === null || raw === ""){
        const norm = this.normalizeMonName(mon);
        for(const k of Object.keys(data.pccmTietMatrix || {})){
          if(k.startsWith(classId + "|") || k.startsWith(classCanon + "|")){
            const m = k.split("|").slice(1).join("|");
            if(this.normalizeMonName(m) === norm){
              raw = data.pccmTietMatrix[k];
              break;
            }
          }
        }
      }
      if(raw !== undefined && raw !== null && raw !== ""){
        const n = Number(raw);
        if(Number.isFinite(n) && n > 0) return Math.round(n);
      }

      const norm = this.normalizeMonName(mon);
      const classKhoi = this.extractKhoiNumber(lop?.khoi) || this.extractKhoiNumber(lop?.ten2) || this.extractKhoiNumber(lop?.ten);

      // 1. Check data.mon (per-grade configuration table: Khối, Tên, Số tiết, Giới hạn)
      const monListGrade = Array.isArray(data.mon) ? data.mon : [];
      if(classKhoi && monListGrade.length > 0){
        const match = monListGrade.find(m => {
          const mKhoi = this.extractKhoiNumber(m?.khoi);
          return mKhoi === classKhoi && (
            this.normalizeMonName(m?.ten) === norm ||
            this.normalizeMonName(m?.ma) === norm ||
            this.normalizeMonName(m?.id) === norm ||
            this.normalizeMonName(m?.mon) === norm
          );
        });
        if(match && Number(match.sotiet || match.tiet || match.required) > 0){
          return Math.round(Number(match.sotiet || match.tiet || match.required));
        }
      }

      // Check data.mon regardless of grade
      const matchGradeAny = monListGrade.find(m => (
        this.normalizeMonName(m?.ten) === norm ||
        this.normalizeMonName(m?.ma) === norm ||
        this.normalizeMonName(m?.id) === norm ||
        this.normalizeMonName(m?.mon) === norm
      ));
      if(matchGradeAny && Number(matchGradeAny.sotiet || matchGradeAny.tiet || matchGradeAny.required) > 0){
        return Math.round(Number(matchGradeAny.sotiet || matchGradeAny.tiet || matchGradeAny.required));
      }

      // 2. Check data.monhoc (global subject catalog)
      const monListGlobal = Array.isArray(data.monhoc) ? data.monhoc : [];
      const matchGlobal = monListGlobal.find(m => (
        this.normalizeMonName(m?.ten) === norm ||
        this.normalizeMonName(m?.ma) === norm ||
        this.normalizeMonName(m?.id) === norm ||
        this.normalizeMonName(m?.mon) === norm
      ));
      if(matchGlobal && Number(matchGlobal.sotiet || matchGlobal.tiet || matchGlobal.required) > 0){
        return Math.round(Number(matchGlobal.sotiet || matchGlobal.tiet || matchGlobal.required));
      }

      // If subject has a number suffix (like "HĐTN 1"), default is 1
      if(/\s+\d+$/.test(String(mon || "").trim())){
        return 1;
      }
      return 1; // Default fallback for any assigned PCCM subject
    }

    getSubjectSessionLimit(lop, mon){
      const data = this.data;
      if(!mon) return 2;
      const classId = String(lop?.id || "");
      const classCanon = lop?.ten2 || lop?.ten || classId;
      const k1 = `${classId}|${mon}`;
      const k2 = `${classCanon}|${mon}`;
      const raw = data.pccmGioihanMatrix?.[k1] ?? data.pccmGioihanMatrix?.[k2];
      if(raw !== undefined && raw !== null && raw !== ""){
        const val = Number(raw);
        if(Number.isFinite(val) && val > 0) return val;
      }

      const norm = this.normalizeMonName(mon);
      const classKhoi = this.extractKhoiNumber(lop?.khoi) || this.extractKhoiNumber(lop?.ten2) || this.extractKhoiNumber(lop?.ten);

      // Check data.mon with grade
      const monListGrade = Array.isArray(data.mon) ? data.mon : [];
      if(classKhoi && monListGrade.length > 0){
        const match = monListGrade.find(m => {
          const mKhoi = this.extractKhoiNumber(m?.khoi);
          return mKhoi === classKhoi && (
            this.normalizeMonName(m?.ten) === norm ||
            this.normalizeMonName(m?.ma) === norm ||
            this.normalizeMonName(m?.id) === norm ||
            this.normalizeMonName(m?.mon) === norm
          );
        });
        if(match && Number(match.gioihan) > 0) return Number(match.gioihan);
      }

      // Check data.mon regardless of grade
      const matchAny = monListGrade.find(m => (
        this.normalizeMonName(m?.ten) === norm ||
        this.normalizeMonName(m?.ma) === norm ||
        this.normalizeMonName(m?.id) === norm ||
        this.normalizeMonName(m?.mon) === norm
      ));
      if(matchAny && Number(matchAny.gioihan) > 0) return Number(matchAny.gioihan);

      // Check data.monhoc
      const monListGlobal = Array.isArray(data.monhoc) ? data.monhoc : [];
      const matchGlobal = monListGlobal.find(m => (
        this.normalizeMonName(m?.ten) === norm ||
        this.normalizeMonName(m?.ma) === norm ||
        this.normalizeMonName(m?.id) === norm ||
        this.normalizeMonName(m?.mon) === norm
      ));
      if(matchGlobal && Number(matchGlobal.gioihan) > 0) return Number(matchGlobal.gioihan);

      return 2; // Default upper bound per session is 2
    }

    removeDiacritics(str){
      if(!str) return "";
      return String(str)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/đ/g, "d")
        .replace(/Đ/g, "D")
        .toLowerCase()
        .trim();
    }

    getCanonMonKey(mon){
      if(!mon) return "";
      let s = this.removeDiacritics(mon);
      s = s.replace(/\s+\d+$/, "").trim();
      s = s.replace(/\s+/g, " ");

      if(["chao co", "cc", "shdc", "sinh hoat duoi co", "shl", "sinh hoat lop", "sinh hoat", "tnhn", "hdtn", "hdtn,hn", "hdtn-hn", "hdtn/hn", "hoat dong trai nghiem", "hoat dong trai nghiem huong nghiep", "hoat dong trai nghiem va huong nghiep"].includes(s)){
        return "hdtn";
      }
      if(["lich su va dia ly", "lich su - dia ly", "lich su dia ly", "ls-dl", "ls&dl", "lsdl", "su dia", "sd"].includes(s)){
        return "lsdl";
      }
      if(["khoa hoc tu nhien", "khtn"].includes(s)){
        return "khtn";
      }
      if(["giao duc the chat", "the duc", "gdtc", "td"].includes(s)){
        return "gdtc";
      }
      if(["giao duc cong dan", "gdcd", "gd"].includes(s)){
        return "gdcd";
      }
      if(["giao duc dia phuong", "gddp", "noi dung giao duc dia phuong"].includes(s)){
        return "gddp";
      }
      if(["tin hoc", "tin"].includes(s)){
        return "tin";
      }
      if(["cong nghe", "cn"].includes(s)){
        return "cn";
      }
      if(["my thuat", "mi thuat", "mt"].includes(s)){
        return "mt";
      }
      if(["am nhac", "nhac", "an"].includes(s)){
        return "nhac";
      }
      if(["ngu van", "van", "va"].includes(s)){
        return "van";
      }
      if(["tieng anh", "ngoai ngu", "anh", "av"].includes(s)){
        return "anh";
      }
      if(["toan", "to"].includes(s)){
        return "toan";
      }
      return s;
    }

    isChaoCo(name){
      const n = this.normalizeMonName(name);
      return ["chào cờ", "chao co", "cc", "shdc", "sinh hoạt dưới cờ", "sinh hoat duoi co"].includes(n);
    }

    isSinhHoatLop(name){
      const n = this.normalizeMonName(name);
      return ["shl", "sinh hoạt lớp", "sinh hoat lop", "sinh hoạt", "sinh hoat"].includes(n);
    }

    resolveFixedSubjectToPccm(subjectMap, fixMon){
      const fixNorm = this.normalizeMonName(fixMon);
      if(subjectMap.has(fixNorm)) return subjectMap.get(fixNorm);

      if(this.isChaoCo(fixMon)){
        if(subjectMap.has(this.normalizeMonName("HĐTN 1"))) return subjectMap.get(this.normalizeMonName("HĐTN 1"));
        if(subjectMap.has(this.normalizeMonName("TNHN 1"))) return subjectMap.get(this.normalizeMonName("TNHN 1"));
        if(subjectMap.has(this.normalizeMonName("HĐTN"))) return subjectMap.get(this.normalizeMonName("HĐTN"));
        if(subjectMap.has(this.normalizeMonName("TNHN"))) return subjectMap.get(this.normalizeMonName("TNHN"));
      }

      if(this.isSinhHoatLop(fixMon)){
        if(subjectMap.has(this.normalizeMonName("HĐTN 3"))) return subjectMap.get(this.normalizeMonName("HĐTN 3"));
        if(subjectMap.has(this.normalizeMonName("HĐTN 2"))) return subjectMap.get(this.normalizeMonName("HĐTN 2"));
        if(subjectMap.has(this.normalizeMonName("TNHN 3"))) return subjectMap.get(this.normalizeMonName("TNHN 3"));
        if(subjectMap.has(this.normalizeMonName("TNHN 2"))) return subjectMap.get(this.normalizeMonName("TNHN 2"));
        if(subjectMap.has(this.normalizeMonName("HĐTN"))) return subjectMap.get(this.normalizeMonName("HĐTN"));
        if(subjectMap.has(this.normalizeMonName("TNHN"))) return subjectMap.get(this.normalizeMonName("TNHN"));
      }

      const fixCanon = this.getCanonMonKey(fixMon);
      for(const item of subjectMap.values()){
        if(item.canonKey === fixCanon && (item.remain > 0 || item.missing > 0)){
          return item;
        }
      }

      for(const item of subjectMap.values()){
        if(item.canonKey === fixCanon){
          return item;
        }
      }

      return null;
    }

    getShiftBlock(classId){
      if(this._classShiftBlockCache && this._classShiftBlockCache.has(classId)){
        return this._classShiftBlockCache.get(classId);
      }
      if(!this._classShiftBlockCache) this._classShiftBlockCache = new Map();

      const cGrid = this.classGrid.get(classId);
      if(!cGrid) return 'S';

      let offMorning = 0;
      let offAfternoon = 0;
      for(let d = 0; d < DAYS_LIST.length; d++){
        for(let p = 0; p < PERIODS_PER_SESSION; p++){
          const sMorning = d * SLOTS_PER_DAY + p;
          const sAfternoon = d * SLOTS_PER_DAY + 5 + p;
          if(cGrid[sMorning] === -2 || this.offSlots.has(`${classId}|${sMorning}`)) offMorning++;
          if(cGrid[sAfternoon] === -2 || this.offSlots.has(`${classId}|${sAfternoon}`)) offAfternoon++;
        }
      }
      const block = (offMorning < offAfternoon) ? 'S' : 'C';
      this._classShiftBlockCache.set(classId, block);
      return block;
    }

    classifySingleton(tKey, d, b, act){
      if(!act || !act.classId) return { type: 'STRUCTURAL', reason: 'no-activity' };
      const classId = act.classId;
      const mon = act.mon;
      const khoiLop = this.getShiftBlock(classId);
      const tGrid = this.teacherGrid.get(tKey);
      if(!tGrid) return { type: 'STRUCTURAL', reason: 'no-teacher-grid' };

      const candidates = [];
      for(let d2 = 0; d2 < DAYS_LIST.length; d2++){
        for(let b2 = 0; b2 < SESSIONS_LIST.length; b2++){
          if(d2 === d && b2 === b) continue;
          const sessKhoi = (b2 === 0) ? 'S' : 'C';
          if(sessKhoi !== khoiLop) continue;

          const sStart = d2 * SLOTS_PER_DAY + b2 * PERIODS_PER_SESSION;
          const taughtInSess = [];
          for(let p = 0; p < PERIODS_PER_SESSION; p++){
            const actId2 = tGrid[sStart + p];
            if(actId2 >= 0){
              const a2 = this.activities[actId2];
              if(a2) taughtInSess.push(a2);
            }
          }

          if(taughtInSess.length >= 1 && taughtInSess.length < 5){
            candidates.push({ d: d2, b: b2, acts: taughtInSess });
          }
        }
      }

      if(candidates.length === 0){
        return { type: 'STRUCTURAL', reason: 'no-other-session-same-shift-block' };
      }

      const monLimit = this.getSubjectSessionLimit(act.lop || { id: classId }, mon);

      for(const cand of candidates){
        if(cand.acts.some(a => a.classId !== classId)){
          return { type: 'FIXABLE', target: cand };
        }
        if(cand.acts.some(a => a.classId === classId && this.getCanonMonKey(a.mon) !== this.getCanonMonKey(mon))){
          return { type: 'FIXABLE', target: cand };
        }
        const sameSubjectCount = cand.acts.filter(a => a.classId === classId && this.getCanonMonKey(a.mon) === this.getCanonMonKey(mon)).length;
        if(sameSubjectCount < monLimit){
          return { type: 'FIXABLE', target: cand };
        }
      }

      return { type: 'STRUCTURAL', reason: 'same-subject-daily-cap-reached-everywhere' };
    }

    classifyAllSingletons(){
      const fixable = [];
      const structural = [];

      this.teacherGrid.forEach((grid, tKey) => {
        if(!tKey) return;
        for(let d = 0; d < DAYS_LIST.length; d++){
          for(let b = 0; b < SESSIONS_LIST.length; b++){
            const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
            const taught = [];
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const actId = grid[sStart + p];
              if(actId >= 0){
                const act = this.activities[actId];
                if(act) taught.push({ slot: sStart + p, act });
              }else if(actId === -3){
                taught.push({ slot: sStart + p, act: { isFixed: true } });
              }
            }

            if(taught.length === 1){
              const item = taught[0];
              if(item.act.isFixed){
                structural.push({ teacher: tKey, day: DAYS_LIST[d], session: SESSIONS_LIST[b], reason: 'fixed-slot' });
              }else{
                const res = this.classifySingleton(tKey, d, b, item.act);
                if(res.type === 'FIXABLE'){
                  fixable.push({ teacher: tKey, day: d, buoi: b, slot: item.slot, act: item.act, target: res.target });
                }else{
                  structural.push({ teacher: tKey, day: DAYS_LIST[d], session: SESSIONS_LIST[b], reason: res.reason, classId: item.act.classId, mon: item.act.mon });
                }
              }
            }
          }
        }
      });

      return { fixable, structural };
    }

    getResidual2PeriodSessions(){
      const residuals = [];
      this.teacherGrid.forEach((grid, tKey) => {
        if(!tKey) return;
        for(let d = 0; d < DAYS_LIST.length; d++){
          for(let b = 0; b < SESSIONS_LIST.length; b++){
            const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
            const taught = [];
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const s = sStart + p;
              if(grid[s] >= 0 || grid[s] === -3) taught.push({ slot: s, actId: grid[s] });
            }
            if(taught.length !== 2) continue;

            const classIds = taught
              .map(t => t.actId >= 0 ? this.activities[t.actId]?.classId : null)
              .filter(Boolean);
            const structurallyLocked = classIds.every(cid => {
              const shift = this.getShiftBlock(cid);
              return true;
            });

            residuals.push({
              teacher: tKey, day: DAYS_LIST[d], session: SESSIONS_LIST[b],
              reason: structurallyLocked ? "class-fixed-halfday-shift" : "algorithm-not-yet-resolved"
            });
          }
        }
      });
      return residuals;
    }

    buildActivities(){
      const data = this.data;
      const actList = [];
      let actCounter = 0;

      this.classes.forEach(lop => {
        const cid = String(lop.id || "");
        const classCanon = lop.ten2 || lop.ten || cid;
        const subjectMap = new Map(); // normKey -> { mon, canonKey, gv, room, required, maxSessionLimit }

        // 1. Scan PCCM Matrix and PCCM Tiet Matrix for explicit class assignments
        const checkKeys = Object.keys(data.pccmMatrix || {}).concat(Object.keys(data.pccmTietMatrix || {}));
        checkKeys.forEach(k => {
          if(k.startsWith(cid + "|") || k.startsWith(classCanon + "|")){
            const m = k.split("|").slice(1).join("|")?.trim();
            if(m){
              const mKey = this.normalizeMonName(m);
              if(!subjectMap.has(mKey)){
                const gv = this.getTeacherForClassMon(lop, m);
                const room = this.getRoomForClassMon(lop, m);
                const required = this.getRequiredPeriods(lop, m);
                const maxSessionLimit = this.getSubjectSessionLimit(lop, m);
                if(gv){
                  subjectMap.set(mKey, { mon: m, canonKey: this.getCanonMonKey(m), gv, room, required, maxSessionLimit, exactFixed: 0, remain: required });
                }
              }
            }
          }
        });

        // 2. Count already placed fixed periods with comprehensive alias & Chào cờ / SHL resolution
        for(let slot = 0; slot < TOTAL_SLOTS; slot++){
          const fix = this.fixedSlots.get(`${cid}|${slot}`);
          if(fix && fix.mon){
            const matched = this.resolveFixedSubjectToPccm(subjectMap, fix.mon);
            if(matched){
              matched.exactFixed = (matched.exactFixed || 0) + 1;
              matched.remain = Math.max(0, matched.required - matched.exactFixed);
            }
          }
        }

        // 3. Create movable activities for remaining periods (strictly never exceeding required)
        subjectMap.forEach((item, mKey) => {
          let remain = item.remain || 0;
          const gv = item.gv;
          const room = item.room;

          if(!gv) return;

          const sCanon = item.canonKey || this.getCanonMonKey(item.mon);
          const blockDurs = [];

          for(const len of [5, 4, 3, 2]){
            const req = this.classSubjectLessonBlocks ? (
              this.classSubjectLessonBlocks.get(`${cid}|${sCanon}|${len}`) ||
              this.classSubjectLessonBlocks.get(`${classCanon}|${sCanon}|${len}`)
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
        });
      });

      this.activities = actList;
      this.actPlacement = new Array(actList.length).fill(-1);
    }

    computeDifficultiesAndSort(){
      const N = this.activities.length;
      const teacherActCount = new Map();
      const classActCount = new Map();

      this.activities.forEach(act => {
        if(act.gv){
          const tList = parseTeacherList(act.gv);
          tList.forEach(t => teacherActCount.set(t, (teacherActCount.get(t) || 0) + act.duration));
        }
        classActCount.set(act.classId, (classActCount.get(act.classId) || 0) + act.duration);
      });

      for(let i = 0; i < N; i++){
        const act = this.activities[i];
        let score = 0;
        if(act.gv){
          const tList = parseTeacherList(act.gv);
          tList.forEach(t => {
            score += (teacherActCount.get(t) || 0);
            const tGrid = this.teacherGrid.get(t);
            if(tGrid){
              for(let d = 0; d < DAYS_LIST.length; d++){
                for(let b = 0; b < SESSIONS_LIST.length; b++){
                  const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
                  let fCount = 0;
                  for(let p = 0; p < PERIODS_PER_SESSION; p++){
                    if(tGrid[sStart + p] === -3) fCount++;
                  }
                  if(fCount === 1) score += 300;
                }
              }
            }
          });
        }
        score += (classActCount.get(act.classId) || 0);

        let offCount = 0;
        for(let s = 0; s < TOTAL_SLOTS; s++){
          if(this.offSlots.has(`${act.classId}|${s}`) || this.fixedSlots.has(`${act.classId}|${s}`)){
            offCount++;
          }
        }
        score += offCount * 2;
        score *= act.duration;
        act.nIncompatible = score;
      }

      this.activities.sort((a, b) => {
        if(b.duration !== a.duration){
          return b.duration - a.duration;
        }
        return b.nIncompatible - a.nIncompatible;
      });

      this.activities.forEach((act, idx) => {
        act.id = idx;
      });
      this.actPlacement = new Array(this.activities.length).fill(-1);
    }

    placeActivityDirect(actId, slot){
      const act = this.activities[actId];
      if(!act) return;
      if(this.actPlacement[actId] >= 0 && this.actPlacement[actId] !== slot){
        this.unplaceActivity(actId);
      }
      this.actPlacement[actId] = slot;

      for(let d = 0; d < act.duration; d++){
        const s = slot + d;
        this.classGrid.get(act.classId)[s] = actId;

        if(act.gv){
          const tList = parseTeacherList(act.gv);
          tList.forEach(t => {
            if(!this.teacherGrid.has(t)) this.teacherGrid.set(t, new Array(TOTAL_SLOTS).fill(-1));
            this.teacherGrid.get(t)[s] = actId;
          });
        }
        if(act.room){
          const rKey = act.room.trim().toLowerCase();
          if(!this.roomGrid.has(rKey)) this.roomGrid.set(rKey, new Array(TOTAL_SLOTS).fill(-1));
          this.roomGrid.get(rKey)[s] = actId;
        }
      }
    }

    unplaceActivity(actId){
      const act = this.activities[actId];
      const oldSlot = this.actPlacement[actId];
      if(!act || oldSlot < 0) return;

      for(let d = 0; d < act.duration; d++){
        const s = oldSlot + d;
        if(this.classGrid.get(act.classId)[s] === actId){
          const cKey = `${act.classId}|${s}`;
          if(this.offSlots.has(cKey)) this.classGrid.get(act.classId)[s] = -2;
          else if(this.fixedSlots.has(cKey)) this.classGrid.get(act.classId)[s] = -3;
          else this.classGrid.get(act.classId)[s] = -1;
        }
        if(act.gv){
          const tList = parseTeacherList(act.gv);
          tList.forEach(t => {
            if(this.teacherGrid.has(t) && this.teacherGrid.get(t)[s] === actId){
              const tKey = `${t}|${s}`;
              if(this.teacherOffSlots.has(tKey)) this.teacherGrid.get(t)[s] = -2;
              else this.teacherGrid.get(t)[s] = -1;
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
    }

    // Check conflicts, off slots, fixed cells, and session limits
    getConflictsForSlot(act, slot){
      const details = slotToDetails(slot);
      const endPeriod = details.periodIdx + act.duration - 1;
      if(endPeriod >= PERIODS_PER_SESSION){
        return { possible: false, conflicts: [] };
      }

      // Check class session preference (ca sáng/chiều)
      if(act.lop && act.lop.ca){
        const ca = String(act.lop.ca).trim().toLowerCase();
        if(ca === "sang" && details.buoi !== "sang") return { possible: false, conflicts: [] };
        if(ca === "chieu" && details.buoi !== "chieu") return { possible: false, conflicts: [] };
      }

      const conflictsSet = new Set();

      for(let d = 0; d < act.duration; d++){
        const s = slot + d;

        // Blocked by OFF or FIXED cell -> Impossible!
        if(this.offSlots.has(`${act.classId}|${s}`)) return { possible: false, conflicts: [] };
        if(this.fixedSlots.has(`${act.classId}|${s}`)) return { possible: false, conflicts: [] };
        if(this.subjectOffSlots && act.mon){
          if(this.subjectOffSlots.has(`${act.canonKey}|${s}`) || this.subjectOffSlots.has(`${this.normalizeMonName(act.mon)}|${s}`)){
            return { possible: false, conflicts: [] };
          }
        }

        const existingActId = this.classGrid.get(act.classId)[s];
        if(existingActId >= 0 && existingActId !== act.id){
          conflictsSet.add(existingActId);
        }

        // Teacher grid & off check
        if(act.gv){
          const tList = parseTeacherList(act.gv);
          for(const t of tList){
            if(this.teacherOffSlots.has(`${t}|${s}`)){
              return { possible: false, conflicts: [] }; // Teacher is off at this slot!
            }
            const tGrid = this.teacherGrid.get(t);
            if(tGrid){
              const tCell = tGrid[s];
              if(tCell === -3) return { possible: false, conflicts: [] }; // Teacher is fixed elsewhere
              if(tCell === -2) return { possible: false, conflicts: [] }; // Teacher OFF
              if(tCell >= 0 && tCell !== act.id){
                conflictsSet.add(tCell);
              }
            }
          }
        }

        // Room grid & off check
        if(act.room){
          const rKey = act.room.trim().toLowerCase();
          if(this.roomOffSlots.has(`${rKey}|${s}`)){
            return { possible: false, conflicts: [] }; // Room is off at this slot!
          }
          const rGrid = this.roomGrid.get(rKey);
          if(rGrid){
            const rCell = rGrid[s];
            if(rCell === -3 || rCell === -2) return { possible: false, conflicts: [] };
            if(rCell >= 0 && rCell !== act.id){
              conflictsSet.add(rCell);
            }
          }
        }
      }

      // Native FET Constraint: Teachers Max Consecutive Gap = 1 & Max Gaps Per Session = 1
      if(this.strictFetGaps && act.gv){
        const sessionStart = details.dayIdx * SLOTS_PER_DAY + details.sessionIdx * PERIODS_PER_SESSION;
        const tList = parseTeacherList(act.gv);
        for(const t of tList){
          const tGrid = this.teacherGrid.get(t);
          if(!tGrid) continue;

          const curP = [];
          for(let pi = 0; pi < PERIODS_PER_SESSION; pi++){
            const sCheck = sessionStart + pi;
            if(sCheck >= slot && sCheck < slot + act.duration){
              curP.push(pi);
            }else if((tGrid[sCheck] >= 0 && !conflictsSet.has(tGrid[sCheck])) || tGrid[sCheck] === -3){
              curP.push(pi);
            }
          }

          if(curP.length >= 2){
            curP.sort((a, b) => a - b);
            // 1. Số tiết nghỉ liên tục tối đa là 1 (FET Constraint: ConstraintTeachersMaxConsecutiveGaps = 1)
            for(let i = 0; i < curP.length - 1; i++){
              if(curP[i + 1] - curP[i] - 1 > 1){
                return { possible: false, conflicts: [] };
              }
            }
            // 2. Tối đa 1 buổi là 1 tiết nghỉ (FET Constraint: ConstraintTeachersMaxGapsPerMorningAndAfternoon = 1)
            const span = curP[curP.length - 1] - curP[0] + 1;
            if(span - curP.length > 1){
              return { possible: false, conflicts: [] };
            }
          }
        }
      }

      // Strict Session Subject Contiguity & Upper Limit Check
      // (Các tiết cùng môn học trong cùng 1 buổi BẮT BUỘC PHẢI XẾP LIỀN NHAU và không vượt quá giới hạn trên)
      const sessionStartSlot = details.dayIdx * SLOTS_PER_DAY + details.sessionIdx * PERIODS_PER_SESSION;
      const sessionEndSlot = sessionStartSlot + PERIODS_PER_SESSION;
      const maxPerSession = this.getSubjectSessionLimit(act.lop, act.mon);
      const actCanon = this.getCanonMonKey(act.mon);

      const subjectPeriods = [];
      for(let pi = 0; pi < PERIODS_PER_SESSION; pi++){
        const s = sessionStartSlot + pi;
        if(s >= slot && s < slot + act.duration){
          subjectPeriods.push(pi);
        }else{
          const existingActId = this.classGrid.get(act.classId)[s];
          if(existingActId >= 0){
            if(!conflictsSet.has(existingActId)){
              const existingAct = this.activities[existingActId];
              if(existingAct && this.getCanonMonKey(existingAct.mon) === actCanon){
                subjectPeriods.push(pi);
              }
            }
          }else if(this.fixedSlots.has(`${act.classId}|${s}`)){
            const fix = this.fixedSlots.get(`${act.classId}|${s}`);
            if(fix && fix.mon && this.getCanonMonKey(fix.mon) === actCanon){
              subjectPeriods.push(pi);
            }
          }
        }
      }

      // 1. Tuyệt đối không được vượt quá giới hạn trên
      if(subjectPeriods.length > maxPerSession){
        return { possible: false, conflicts: [] };
      }

      // 2. Bắt buộc các tiết cùng môn trong cùng 1 buổi phải xếp LIỀN NHAU (Contiguous)
      if(subjectPeriods.length >= 2){
        subjectPeriods.sort((a, b) => a - b);
        const span = subjectPeriods[subjectPeriods.length - 1] - subjectPeriods[0] + 1;
        if(span !== subjectPeriods.length){
          return { possible: false, conflicts: [] }; // Bị tách rời không liền nhau -> Chặn tuyệt đối!
        }
      }

      return {
        possible: true,
        conflicts: Array.from(conflictsSet)
      };
    }

    // Evaluates penalty for placing an activity at a slot to satisfy user constraints:
    // 1. Số tiết nghỉ liên tục tối đa là 1 (ConstraintTeachersMaxConsecutiveGaps = 1)
    // 2. Tối đa 1 buổi là 1 tiết nghỉ (ConstraintTeachersMaxGapsPerMorningAndAfternoon = 1)
    // 3. Tối thiểu 1 buổi dạy 2 tiết (ConstraintTeachersMinHoursDaily = 2 / No singletons)
    // (Bỏ ưu tiên ngày dạy)
    getPlacementPenalty(act, slot){
      if(!act.gv) return 0;
      const tList = parseTeacherList(act.gv);
      if(tList.length === 0) return 0;

      const d = Math.floor(slot / SLOTS_PER_DAY);
      const b = Math.floor((slot % SLOTS_PER_DAY) / PERIODS_PER_SESSION);
      const p = (slot % SLOTS_PER_DAY) % PERIODS_PER_SESSION;
      const sessionStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;

      let penalty = 0;

      for(const t of tList){
        const tGrid = this.teacherGrid.get(t);
        if(!tGrid) continue;

        const currentP = [];
        for(let pi = 0; pi < PERIODS_PER_SESSION; pi++){
          const s = sessionStart + pi;
          if(tGrid[s] >= 0 || tGrid[s] === -3){
            currentP.push(pi);
          }
        }

        if(currentP.length === 0){
          // Opening a new session for teacher t:
          // Discourage creating an isolated 1-period session (Tối thiểu 1 buổi 2 tiết)
          penalty += 350;
        }else{
          // Joining existing session (d, b) -> Helps reach >= 2 periods!
          // If the session currently has only 1 period, joining it turns it into >= 2 periods (SUPER BONUS)
          if(currentP.length === 1){
            const isFixedSingle = (tGrid[sessionStart + currentP[0]] === -3);
            penalty -= (isFixedSingle ? 700 : 250);
          }else if(currentP.length === 2){
            penalty -= 80;
          }else if(currentP.length === 3){
            penalty -= 30;
          }else if(currentP.length === 4){
            penalty -= 10;
          }

          const newP = currentP.concat([p]).sort((x, y) => x - y);
          const k = newP.length;
          const span = newP[k - 1] - newP[0] + 1;
          const totalGaps = span - k;

          let maxConsecGap = 0;
          for(let i = 0; i < k - 1; i++){
            const gap = newP[i + 1] - newP[i] - 1;
            if(gap > maxConsecGap) maxConsecGap = gap;
          }

          // Constraint 1: Số tiết nghỉ liên tục tối đa là 1 (Hard Penalty)
          if(maxConsecGap > 1){
            penalty += 2000 * maxConsecGap;
          }

          // Constraint 2: Tối đa 1 buổi là 1 tiết nghỉ (Hard Penalty)
          if(totalGaps > 1){
            penalty += 1500 * (totalGaps - 1);
          }

          // 1 tiết nghỉ hợp lệ
          if(totalGaps === 1 && maxConsecGap === 1){
            penalty += 10;
          }

          // Liền mạch 0 tiết nghỉ (Ưu tiên cao nhất)
          if(totalGaps === 0){
            penalty -= 100;
          }
        }
      }

      return penalty;
    }

    // --- Transactional move journal (Optimizer v2) -------------------------
    // The old restoreStack remembered only {actId, oldSlot} and re-placed on
    // rollback. That is NOT an exact inverse when one slot hosts different
    // activities over the life of a deep branch: LIFO re-placement could put
    // two activities onto the same cell (silent overwrite, lost lessons).
    // The journal records every mutation and rolls back by exact reverse
    // replay, which is always consistent.
    jrnUnplace(actId){
      const prev = this.actPlacement[actId];
      if(prev < 0) return;
      this.moveJournal.push({ t: "U", actId, slot: prev });
      this.unplaceActivity(actId);
    }

    jrnPlace(actId, slot){
      const prev = this.actPlacement[actId];
      if(prev >= 0) this.jrnUnplace(actId);
      this.moveJournal.push({ t: "P", actId, slot });
      this.placeActivityDirect(actId, slot);
    }

    jrnRollback(mark){
      while(this.moveJournal.length > mark){
        const op = this.moveJournal.pop();
        if(op.t === "P"){
          // inverse of place = unplace from that slot
          if(this.actPlacement[op.actId] === op.slot) this.unplaceActivity(op.actId);
        }else{
          // inverse of unplace = place back at recorded slot
          this.placeActivityDirect(op.actId, op.slot);
        }
      }
    }

    randomSwap(actId, level, restrictSlots = null){
      if(level >= MAX_RECURSION_LEVEL) return false;
      if(this.nCalls >= this.limitCalls) return false;
      if(level === 0) this.moveJournal.length = 0; // committed history is never rolled back
      this.nCalls++;
      this.currentStep++;

      const act = this.activities[actId];
      if(!act || act.isFixed) return false;

      const candidateSlots = [];
      if(Array.isArray(restrictSlots) && restrictSlots.length){
        for(const s2 of restrictSlots) candidateSlots.push(s2);
      }else{
        for(let s = 0; s < TOTAL_SLOTS; s++){
          candidateSlots.push(s);
        }
      }
      this.rng.shuffle(candidateSlots);

      const evaluated = [];
      const zeroConflictSlots = [];

      for(const slot of candidateSlots){
        const res = this.getConflictsForSlot(act, slot);
        if(!res.possible) continue;

        const pen = this.getPlacementPenalty(act, slot);

        if(res.conflicts.length === 0){
          zeroConflictSlots.push({ slot, penalty: pen });
          continue;
        }

        const tabuKey = `${actId}|${slot}`;
        if(this.tabuMap.has(tabuKey) && this.tabuMap.get(tabuKey) > this.currentStep){
          continue;
        }

        evaluated.push({
          slot,
          conflicts: res.conflicts,
          conflictCount: res.conflicts.length,
          penalty: pen
        });
      }

      // If conflict-free slots exist, choose the best quality slot according to user rules
      if(zeroConflictSlots.length > 0){
        zeroConflictSlots.sort((a, b) => a.penalty - b.penalty);
        const bestSlot = zeroConflictSlots[0].slot;
        this.jrnPlace(actId, bestSlot);
        return true;
      }

      evaluated.sort((a, b) => {
        if(a.conflictCount !== b.conflictCount) return a.conflictCount - b.conflictCount;
        return a.penalty - b.penalty;
      });

      for(const cand of evaluated){
        const { slot, conflicts } = cand;

        let hasCycle = false;
        for(const confId of conflicts){
          if(this.swappedInBranch.has(confId)){
            hasCycle = true;
            break;
          }
        }
        if(hasCycle) continue;

        const restorePoint = this.moveJournal.length;

        for(const confId of conflicts){
          this.jrnUnplace(confId);
          this.swappedInBranch.add(confId);
        }

        this.jrnPlace(actId, slot);

        const oldSlot = act.fixedSlot >= 0 ? act.fixedSlot : this.actPlacement[actId];
        if(oldSlot >= 0){
          this.tabuMap.set(`${actId}|${oldSlot}`, this.currentStep + this.activities.length);
        }

        let allDisplacedPlaced = true;
        for(const confId of conflicts){
          const ok = this.randomSwap(confId, level + 1);
          if(!ok){
            allDisplacedPlaced = false;
            break;
          }
        }

        if(allDisplacedPlaced){
          for(const confId of conflicts) this.swappedInBranch.delete(confId);
          return true;
        }

        this.jrnRollback(restorePoint);
        for(const confId of conflicts) this.swappedInBranch.delete(confId);

        if(level >= 6) break;
      }

      return false;
    }

    // Deterministic 1-hop, 2-hop, Block-to-Singles, and Cross-Class Relocation
    tryEjectionChain(actId){
      const act = this.activities[actId];
      if(!act || this.actPlacement[actId] >= 0) return true;

      const candidateSlots = [];
      for(let s = 0; s < TOTAL_SLOTS; s++){
        candidateSlots.push(s);
      }
      this.rng.shuffle(candidateSlots);

      // 1. Direct placement check
      for(const slot of candidateSlots){
        const res = this.getConflictsForSlot(act, slot);
        if(res.possible && res.conflicts.length === 0){
          this.placeActivityDirect(actId, slot);
          return true;
        }
      }

      // 2. 1-hop relocation: Displace 1 activity B that can move to a free slot sB
      for(const slot of candidateSlots){
        const res = this.getConflictsForSlot(act, slot);
        if(!res.possible || res.conflicts.length !== 1) continue;

        const confId = res.conflicts[0];
        const confAct = this.activities[confId];
        if(!confAct || confAct.isFixed) continue;

        const oldConfSlot = this.actPlacement[confId];
        this.unplaceActivity(confId);
        this.placeActivityDirect(actId, slot);

        let placedConf = false;
        for(let sB = 0; sB < TOTAL_SLOTS; sB++){
          if(sB === oldConfSlot) continue;
          const resB = this.getConflictsForSlot(confAct, sB);
          if(resB.possible && resB.conflicts.length === 0){
            this.placeActivityDirect(confId, sB);
            placedConf = true;
            break;
          }
        }

        if(placedConf){
          return true;
        }

        this.unplaceActivity(actId);
        this.placeActivityDirect(confId, oldConfSlot);
      }

      // 3. 2-hop relocation: A -> slot (displaces B), B -> sB (displaces C), C -> sC (free)
      for(const slot of candidateSlots){
        const res = this.getConflictsForSlot(act, slot);
        if(!res.possible || res.conflicts.length !== 1) continue;

        const bId = res.conflicts[0];
        const bAct = this.activities[bId];
        if(!bAct || bAct.isFixed) continue;

        const oldBSlot = this.actPlacement[bId];
        this.unplaceActivity(bId);
        this.placeActivityDirect(actId, slot);

        let success2Hop = false;
        for(let sB = 0; sB < TOTAL_SLOTS; sB++){
          if(sB === oldBSlot) continue;
          const resB = this.getConflictsForSlot(bAct, sB);
          if(!resB.possible || resB.conflicts.length !== 1) continue;

          const cId = resB.conflicts[0];
          const cAct = this.activities[cId];
          if(!cAct || cAct.isFixed || cId === actId || cId === bId) continue;

          const oldCSlot = this.actPlacement[cId];
          this.unplaceActivity(cId);
          this.placeActivityDirect(bId, sB);

          for(let sC = 0; sC < TOTAL_SLOTS; sC++){
            if(sC === oldCSlot) continue;
            const resC = this.getConflictsForSlot(cAct, sC);
            if(resC.possible && resC.conflicts.length === 0){
              this.placeActivityDirect(cId, sC);
              success2Hop = true;
              break;
            }
          }

          if(success2Hop) break;

          this.unplaceActivity(bId);
          this.placeActivityDirect(cId, oldCSlot);
        }

        if(success2Hop){
          return true;
        }

        this.unplaceActivity(actId);
        this.placeActivityDirect(bId, oldBSlot);
      }

      // 4. Cross-Class Teacher Ejection: A -> slot in C1 (displaces B). B wants sFree in C1, but T_B is busy with D in C2 at sFree.
      // D moves to free slot sFree2 in C2 -> B takes sFree -> A takes slot!
      for(const slot of candidateSlots){
        const res = this.getConflictsForSlot(act, slot);
        if(!res.possible || res.conflicts.length !== 1) continue;

        const bId = res.conflicts[0];
        const bAct = this.activities[bId];
        if(!bAct || bAct.isFixed) continue;

        const oldBSlot = this.actPlacement[bId];
        this.unplaceActivity(bId);
        this.placeActivityDirect(actId, slot);

        let crossClassSuccess = false;
        for(let sFree = 0; sFree < TOTAL_SLOTS; sFree++){
          if(sFree === oldBSlot) continue;
          if(this.classGrid.get(bAct.classId)[sFree] !== -1) continue;

          const resB = this.getConflictsForSlot(bAct, sFree);
          if(!resB.possible || resB.conflicts.length !== 1) continue;

          const dId = resB.conflicts[0];
          const dAct = this.activities[dId];
          if(!dAct || dAct.isFixed || dAct.classId === bAct.classId) continue;

          const oldDSlot = this.actPlacement[dId];
          this.unplaceActivity(dId);
          this.placeActivityDirect(bId, sFree);

          for(let sFree2 = 0; sFree2 < TOTAL_SLOTS; sFree2++){
            if(sFree2 === oldDSlot) continue;
            const resD = this.getConflictsForSlot(dAct, sFree2);
            if(resD.possible && resD.conflicts.length === 0){
              this.placeActivityDirect(dId, sFree2);
              crossClassSuccess = true;
              break;
            }
          }

          if(crossClassSuccess) break;

          this.unplaceActivity(bId);
          this.placeActivityDirect(dId, oldDSlot);
        }

        if(crossClassSuccess){
          return true;
        }

        this.unplaceActivity(actId);
        this.placeActivityDirect(bId, oldBSlot);
      }

      return false;
    }

    solve(progressCallback = null){
      this.init();
      this.strictFetGaps = true;
      this.computeDifficultiesAndSort();

      let totalActivities = this.activities.length;
      this.limitCalls = Math.max(8000, 10 * totalActivities);

      for(let i = 0; i < this.activities.length; i++){
        const act = this.activities[i];
        if(this.actPlacement[act.id] >= 0) continue;

        this.nCalls = 0;
        this.randomSwap(act.id, 0);

        if(progressCallback && (i % 5 === 0 || i === this.activities.length - 1)){
          const placedNow = this.actPlacement.filter(s => s >= 0).reduce((sum, s, idx) => sum + (this.activities[idx]?.duration || 1), 0);
          const totalLessons = this.activities.reduce((sum, a) => sum + a.duration, 0);
          const pct = Math.min(85, Math.round((placedNow / Math.max(1, totalLessons)) * 85));
          progressCallback({
            percent: pct,
            placed: placedNow,
            total: totalLessons
          });
        }
      }

      // Keep 2-period blocks intact!

      // Multi-pass exhaustive placement for remaining activities
      for(let pass = 0; pass < 20; pass++){
        const unplacedActs = this.activities.filter(a => this.actPlacement[a.id] < 0);
        if(unplacedActs.length === 0) break;
        if(pass >= 6) this.strictFetGaps = false; // Relax in late fallback passes to guarantee 100% full placement

        this.limitCalls = Math.max(8000, 10 * this.activities.length);
        for(const uAct of unplacedActs){
          this.nCalls = 0;
          this.randomSwap(uAct.id, 0);
        }

        if(progressCallback){
          const placedNow = this.actPlacement.filter(s => s >= 0).reduce((sum, s, idx) => sum + (this.activities[idx]?.duration || 1), 0);
          const totalLessons = this.activities.reduce((sum, a) => sum + a.duration, 0);
          progressCallback({
            percent: 100,
            placed: placedNow,
            total: totalLessons
          });
        }
      }

      this.applyToDataTKB();

      let placed = 0;
      let unassigned = 0;
      this.activities.forEach((act, idx) => {
        if(this.actPlacement[idx] >= 0) placed += act.duration;
        else unassigned += act.duration;
      });
      placed += this.fixedSlots.size;

      return { ok: unassigned === 0, placed, unassigned, total: placed + unassigned };
    }

    applyToDataTKB(){
      const data = this.data;
      if(!data.tkb) data.tkb = {};
      if(!data.tkbLessonTeachers) data.tkbLessonTeachers = {};
      if(!data.tkbLessonRooms) data.tkbLessonRooms = {};

      this.classes.forEach(l => {
        const cid = String(l.id || "");
        if(!data.tkb[cid]) data.tkb[cid] = {};
        DAYS_LIST.forEach(thu => {
          if(!data.tkb[cid][thu]) data.tkb[cid][thu] = {};
          SESSIONS_LIST.forEach(buoi => {
            if(!Array.isArray(data.tkb[cid][thu][buoi])){
              data.tkb[cid][thu][buoi] = [null, null, null, null, null];
            }
          });
        });
      });

      this.classes.forEach(l => {
        const cid = String(l.id || "");
        DAYS_LIST.forEach(thu => {
          SESSIONS_LIST.forEach(buoi => {
            for(let ti = 0; ti < PERIODS_PER_SESSION; ti++){
              const slot = detailsToSlot(thu, buoi, ti);
              const key = `${cid}|${slot}`;
              if(this.fixedRawCells.has(key)){
                data.tkb[cid][thu][buoi][ti] = this.fixedRawCells.get(key);
              }else if(this.offSlots.has(key)){
                data.tkb[cid][thu][buoi][ti] = "OFF";
              }else{
                data.tkb[cid][thu][buoi][ti] = null;
              }
            }
          });
        });
      });

      this.activities.forEach(act => {
        const slot = this.actPlacement[act.id];
        if(slot < 0) return;

        for(let d = 0; d < act.duration; d++){
          const s = slot + d;
          const details = slotToDetails(s);
          const cid = act.classId;

          const key = `${cid}|${s}`;
          if(this.fixedRawCells.has(key) || this.offSlots.has(key)) continue;

          data.tkb[cid][details.thu][details.buoi][details.periodIdx] = act.mon;

          const tkbKey = `${cid}|${act.mon}`;
          if(act.gv) data.tkbLessonTeachers[tkbKey] = act.gv;
          if(act.room) data.tkbLessonRooms[tkbKey] = act.room;
        }
      });
    }

    getSnapshotTKB(){
      // Checkpoint an toàn cho portfolio: khi optimize() đang đi bước "đa dạng
      // hóa" (trạng thái hiện tại có thể XẤU hơn best), mọi checkpoint gửi ra
      // (nút Dừng!) phải là GLOBAL BEST chứ không phải bước đi dò đường.
      const g = this.checkpointGuard;
      if(g && g.placement){
        const cur = { p: this.actPlacement, c: this.classGrid, t: this.teacherGrid, r: this.roomGrid };
        this.actPlacement = g.placement; this.classGrid = g.classGrid; this.teacherGrid = g.teacherGrid; this.roomGrid = g.roomGrid;
        this.applyToDataTKB();
        const out = JSON.parse(JSON.stringify(this.data.tkb));
        this.actPlacement = cur.p; this.classGrid = cur.c; this.teacherGrid = cur.t; this.roomGrid = cur.r;
        return out;
      }
      this.applyToDataTKB();
      return JSON.parse(JSON.stringify(this.data.tkb));
    }

    evaluateMetrics(){
      let soNgayMotTiet = 0;
      let soBuoiDay1 = 0;
      let soBuoiDay2 = 0;
      let soBuoiDay3 = 0;
      let tsBuoiDay = 0;
      let tsNgayDay = 0;
      let soBuoiTrong1 = 0;
      let soBuoiTrong2 = 0;

      this.teacherGrid.forEach((grid, tKey) => {
        if(!tKey || !this.isScoredTeacher(tKey)) return;
        for(let d = 0; d < DAYS_LIST.length; d++){
          let dayTotal = 0;
          for(let b = 0; b < SESSIONS_LIST.length; b++){
            const sessionStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
            const taughtIndices = [];
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const slot = sessionStart + p;
              const cell = grid[slot];
              if(cell >= 0 || cell === -3){ // taught or fixed
                taughtIndices.push(p);
              }
            }

            const k = taughtIndices.length;
            dayTotal += k;
            if(k > 0){
              tsBuoiDay++;
              if(k === 1) soBuoiDay1++;
              else if(k === 2) soBuoiDay2++;
              else if(k === 3) soBuoiDay3++;

              const first = taughtIndices[0];
              const last = taughtIndices[k - 1];
              const span = last - first + 1;
              const gaps = span - k;
              if(gaps === 1){
                soBuoiTrong1++;
              }else if(gaps >= 2){
                soBuoiTrong2++;
              }
            }
          }
          if(dayTotal > 0) tsNgayDay++;
          if(dayTotal === 1) soNgayMotTiet++;
        }
      });

      return { soNgayMotTiet, soBuoiDay1, soBuoiDay2, soBuoiDay3, tsBuoiDay, tsNgayDay, soBuoiTrong1, soBuoiTrong2 };
    }

    loadExistingSchedule(){
      this.init();
      const data = this.data;
      const actList = [];
      let actCounter = 0;

      // 1. Load currently placed movable cells with intelligent pair preservation
      this.classes.forEach(lop => {
        const cid = String(lop.id || "");
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

              // Check if next period in same session is identical subject with lessonBlocks[2].min > 0
              let blockLen = 1;
              if(ti + 1 < PERIODS_PER_SESSION){
                const nextCell = arr[ti + 1];
                const nextSlot = detailsToSlot(thu, buoi, ti + 1);
                if(nextCell && nextCell !== "OFF" && !this.isCellOff(nextCell) && !this.isCellFixed(nextCell, cid, nextSlot)){
                  const nextMon = this.extractMon(nextCell);
                  const nextCanon = this.getCanonMonKey(nextMon);
                  if(nextCanon === sCanon){
                    const req = this.classSubjectLessonBlocks ? (
                      this.classSubjectLessonBlocks.get(`${cid}|${sCanon}|2`) ||
                      this.classSubjectLessonBlocks.get(`${classCanon}|${sCanon}|2`)
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
        });
      });

      this.activities = actList;
      this.actPlacement = new Array(actList.length).fill(-1);

      // 2. Place initial existing activities into their slots.
      // CÓ KIỂM TRA XUNG ĐỘT (sửa 17/08): trước đây đặt mù quáng — dữ liệu đã
      // hỏng (2 tiết cùng ô giáo viên) sẽ GHI ĐÈ teacherGrid, làm mọi phép
      // kiểm tra sau đó mù: unplace tiết sau → ô thành "rảnh" dù tiết trước
      // vẫn đứng đó → randomSwap đặt lại đúng chỗ trùng. Giờ tiết nào xung đột
      // với tiết đã vào trước thì để CHƯA PHÂN — repairHardConflicts sẽ tìm chỗ
      // hợp lệ ngay đầu optimize/optimizeAll.
      this.activities.forEach(act => {
        if(act.initSlot >= 0){
          if(this.canLoadPlacement(act, act.initSlot)){
            this.placeActivityDirect(act.id, act.initSlot);
          }
          // else: giữ chưa phân — không bao giờ để lưới sai lệch
        }
      });
    }

    // Kiểm tra HẸP cho việc nạp lịch đã lưu: chỉ chặn xung đột VẬT LÝ (trùng ô
    // lớp, ô lớp OFF/cố định, trùng/OFF giáo viên, trùng phòng). KHÔNG chặn các
    // ràng buộc chính sách (subjectOff, ca ưa thích...) — lịch cũ hợp lệ của
    // người dùng phải nạp nguyên trạng dù ràng buộc đổi sau đó.
    canLoadPlacement(act, slot){
      for(let d = 0; d < (act.duration || 1); d++){
        const s = slot + d;
        if(s >= TOTAL_SLOTS) return false;
        if(this.offSlots.has(`${act.classId}|${s}`)) return false;
        if(this.fixedSlots.has(`${act.classId}|${s}`)) return false;
        const cg = this.classGrid.get(act.classId);
        if(!cg || cg[s] >= 0 || cg[s] === -2 || cg[s] === -3) return false;
        if(act.gv){
          for(const t of parseTeacherList(act.gv)){
            if(this.teacherOffSlots && this.teacherOffSlots.has(`${t}|${s}`)) return false;
            const tg = this.teacherGrid.get(t);
            if(tg && (tg[s] >= 0 || tg[s] === -2 || tg[s] === -3)) return false;
          }
        }
        if(act.room){
          const rKey = String(act.room).trim().toLowerCase();
          const rg = this.roomGrid.get(rKey);
          if(rg && (rg[s] >= 0 || rg[s] === -2 || rg[s] === -3)) return false;
        }
      }
      return true;
    }

    // Recursive LNS Ruin-and-Recreate: Completely vacate a day for a teacher to give full Day Off
    tryVacateTeacherDay(tKey, targetDay, bestMetrics, initialMetrics){
      const tGrid = this.teacherGrid.get(tKey);
      if(!tGrid) return null;

      const targetActivities = [];
      for(let s = 0; s < SLOTS_PER_DAY; s++){
        const slot = targetDay * SLOTS_PER_DAY + s;
        const actId = tGrid[slot];
        if(actId === -3) return null; // Fixed cell on targetDay cannot be moved
        if(actId >= 0){
          targetActivities.push({ actId, slot });
        }
      }

      if(targetActivities.length === 0 || targetActivities.length > 2) return null;

      // Snapshot complete state
      const snapshotPlacement = this.actPlacement.slice();
      const snapshotClassGrid = new Map();
      this.classGrid.forEach((arr, cid) => snapshotClassGrid.set(cid, arr.slice()));
      const snapshotTeacherGrid = new Map();
      this.teacherGrid.forEach((arr, gv) => snapshotTeacherGrid.set(gv, arr.slice()));
      const snapshotRoomGrid = new Map();
      this.roomGrid.forEach((arr, rm) => snapshotRoomGrid.set(rm, arr.slice()));

      // 1. Unplace all target activities of this teacher on targetDay
      for(const item of targetActivities){
        this.unplaceActivity(item.actId);
      }

      // 2. Temporarily forbid targetDay for teacher tKey
      const tempForbiddenSlots = [];
      for(let s = 0; s < SLOTS_PER_DAY; s++){
        const slot = targetDay * SLOTS_PER_DAY + s;
        const key = `${tKey}|${slot}`;
        if(!this.teacherOffSlots.has(key)){
          this.teacherOffSlots.add(key);
          tempForbiddenSlots.push(key);
        }
      }

      // 3. Re-place all target activities using recursive randomSwap (LNS)
      let allPlaced = true;
      this.limitCalls = 250;

      for(const item of targetActivities){
        this.nCalls = 0;
        const ok = this.randomSwap(item.actId, 0);
        if(!ok){
          allPlaced = false;
          break;
        }
      }

      // 4. Remove temporary forbidden flags
      for(const key of tempForbiddenSlots){
        this.teacherOffSlots.delete(key);
      }

      // 5. If all placed successfully, check if quality improved (Maximum Day Reduction without increasing 1-period sessions or 2-period gaps)
      if(allPlaced){
        const currentM = this.evaluateMetrics();
        if(currentM.soBuoiDay1 <= bestMetrics.soBuoiDay1 && currentM.soBuoiTrong2 <= initialMetrics.soBuoiTrong2 && (currentM.tsNgayDay < bestMetrics.tsNgayDay || currentM.tsBuoiDay < bestMetrics.tsBuoiDay)){
          return currentM;
        }
      }

      // Backtrack to snapshot if not successful
      this.actPlacement = snapshotPlacement;
      this.classGrid = snapshotClassGrid;
      this.teacherGrid = snapshotTeacherGrid;
      this.roomGrid = snapshotRoomGrid;
      return null;
    }

    // Recursive LNS Ruin-and-Recreate: Completely vacate a half-day session (Sang/Chieu) for a teacher to reduce total sessions
    tryVacateTeacherSession(tKey, targetDay, targetBuoi, bestMetrics, initialMetrics, mode = "optimize_sessions"){
      const tGrid = this.teacherGrid.get(tKey);
      if(!tGrid) return null;

      const sessionStart = targetDay * SLOTS_PER_DAY + targetBuoi * PERIODS_PER_SESSION;
      const targetActivities = [];
      for(let p = 0; p < PERIODS_PER_SESSION; p++){
        const slot = sessionStart + p;
        const actId = tGrid[slot];
        if(actId === -3) return null; // Fixed cell cannot be moved
        if(actId >= 0){
          targetActivities.push({ actId, slot });
        }
      }

      if(targetActivities.length === 0 || targetActivities.length > 3) return null;

      // Snapshot complete state
      const snapshotPlacement = this.actPlacement.slice();
      const snapshotClassGrid = new Map();
      this.classGrid.forEach((arr, cid) => snapshotClassGrid.set(cid, arr.slice()));
      const snapshotTeacherGrid = new Map();
      this.teacherGrid.forEach((arr, gv) => snapshotTeacherGrid.set(gv, arr.slice()));
      const snapshotRoomGrid = new Map();
      this.roomGrid.forEach((arr, rm) => snapshotRoomGrid.set(rm, arr.slice()));

      // 1. Unplace all target activities of this teacher on (targetDay, targetBuoi)
      for(const item of targetActivities){
        this.unplaceActivity(item.actId);
      }

      // 2. Temporarily forbid (targetDay, targetBuoi) for teacher tKey
      const tempForbiddenSlots = [];
      for(let p = 0; p < PERIODS_PER_SESSION; p++){
        const slot = sessionStart + p;
        const key = `${tKey}|${slot}`;
        if(!this.teacherOffSlots.has(key)){
          this.teacherOffSlots.add(key);
          tempForbiddenSlots.push(key);
        }
      }

      // 3. Re-place all target activities using recursive randomSwap (LNS)
      let allPlaced = true;
      this.limitCalls = 250;

      for(const item of targetActivities){
        this.nCalls = 0;
        const ok = this.randomSwap(item.actId, 0);
        if(!ok){
          allPlaced = false;
          break;
        }
      }

      // 4. Remove temporary forbidden flags
      for(const key of tempForbiddenSlots){
        this.teacherOffSlots.delete(key);
      }

      // 5. If all placed successfully, check if metric improved for the active mode
      if(allPlaced && this.isLessonBlockSafe()){
        const currentM = this.evaluateMetrics();
        if(this.compareMetrics(currentM, bestMetrics, mode) < 0){
          return currentM;
        }
      }

      // Backtrack
      this.actPlacement = snapshotPlacement;
      this.classGrid = snapshotClassGrid;
      this.teacherGrid = snapshotTeacherGrid;
      this.roomGrid = snapshotRoomGrid;
      return null;
    }

    // Same-Teacher Same-Class Pair Merging: consolidates single-period activities of the same teacher in the same class
    // Intra-Class Same-Teacher Consolidation: Merges multiple single periods of the same teacher in the same class into the same session
    // Intra-Teacher Singleton Consolidation: Merges single periods of a teacher across sessions into active sessions
    tryConsolidateTeacherSingletons(bestMetrics, initialMetrics, maxGap2Limit = Infinity, onProgress = null){
      const DAYS = DAYS_LIST.length;
      const SESSIONS = SESSIONS_LIST.length;
      const PERIODS = PERIODS_PER_SESSION;
      let currentBest = { ...bestMetrics };
      let anyImproved = false;

      const teacherList = Array.from(this.teacherGrid.keys()).filter(t => t && this.isScoredTeacher(t));
      this.rng.shuffle(teacherList);

      for(const tKey of teacherList){
        const tGrid = this.teacherGrid.get(tKey);
        if(!tGrid) continue;

        // Find all single-period sessions of teacher tKey
        const singleSessions = [];
        const activeSessions = [];

        for(let d = 0; d < DAYS; d++){
          for(let b = 0; b < SESSIONS; b++){
            const sStart = d * 10 + b * 5;
            const taught = [];
            for(let p = 0; p < PERIODS; p++){
              const s = sStart + p;
              if(tGrid[s] >= 0){
                const act = this.activities[tGrid[s]];
                if(act && !act.isFixed && act.duration === 1){
                  taught.push({ slot: s, actId: tGrid[s], p });
                }
              }else if(tGrid[s] === -3){
                taught.push({ slot: s, actId: -3, p });
              }
            }
            if(taught.length === 1 && taught[0].actId >= 0){
              singleSessions.push({ day: d, buoi: b, sStart, item: taught[0] });
            }else if(taught.length >= 1){
              activeSessions.push({ day: d, buoi: b, sStart, cnt: taught.length });
            }
          }
        }

        if(singleSessions.length === 0 || activeSessions.length === 0) continue;
        activeSessions.sort((a, b) => b.cnt - a.cnt);

        for(const single of singleSessions){
          const act1 = this.activities[single.item.actId];
          if(!act1 || act1.isFixed || act1.duration !== 1) continue;

          const cGrid1 = this.classGrid.get(act1.classId);
          if(!cGrid1) continue;

          let consResolved = false;

          for(const targetSess of activeSessions){
            if(targetSess.day === single.day && targetSess.buoi === single.buoi) continue;
            if(this.actPlacement[act1.id] !== single.item.slot) break; // freshness guard

            // Synergy (yêu cầu chủ dự án): khi dồn tiết lẻ vào buổi khác, ưu
            // tiên ĐẶT VÀO LỖ TRỐNG của buổi đích (lấp gap2/gap1 cùng lúc),
            // rồi mới tới vị trí nối liền mép, cuối cùng mới là vị trí tách rời.
            const taughtPs = [];
            for(let pp = 0; pp < PERIODS; pp++){
              const ss = targetSess.sStart + pp;
              if(tGrid[ss] >= 0 || tGrid[ss] === -3) taughtPs.push(pp);
            }
            const loP = taughtPs.length ? taughtPs[0] : -1;
            const hiP = taughtPs.length ? taughtPs[taughtPs.length - 1] : -1;
            const candPs = [];
            for(let pp = 0; pp < PERIODS; pp++){
              const ss = targetSess.sStart + pp;
              if(tGrid[ss] >= 0 || tGrid[ss] === -3) continue;
              let score = 2;
              if(pp > loP && pp < hiP) score = 0;
              else if(pp === loP - 1 || pp === hiP + 1) score = 1;
              candPs.push({ pp, score });
            }
            candPs.sort((a, b) => a.score - b.score);

            for(const candP of candPs){
              const p2 = candP.pp;
              const s2 = targetSess.sStart + p2;
              if(this.offSlots.has(`${act1.classId}|${s2}`)) continue;
              if(tGrid[s2] >= 0 || tGrid[s2] === -3) continue;

              const actId2 = cGrid1[s2];
              if(actId2 < 0) continue;

              const act2 = this.activities[actId2];
              if(!act2 || act2.isFixed || act2.duration !== 1) continue;

              const tDstGrid = this.teacherGrid.get(act2.gv);

              // 1. Try 2-way direct swap
              if(tDstGrid && tDstGrid[single.item.slot] < 0 && tDstGrid[single.item.slot] !== -3){
                this.unplaceActivity(act1.id);
                this.unplaceActivity(act2.id);

                const r1 = this.getConflictsForSlot(act1, s2);
                const r2 = this.getConflictsForSlot(act2, single.item.slot);

                if(r1.possible && r1.conflicts.length === 0 && r2.possible && r2.conflicts.length === 0){
                  this.placeActivityDirect(act1.id, s2);
                  this.placeActivityDirect(act2.id, single.item.slot);

                  if(this.isLessonBlockSafe(act1, act2)){
                    const m = this.evaluateMetrics();
                    if(m.soBuoiDay1 < currentBest.soBuoiDay1 && m.soBuoiTrong2 <= maxGap2Limit){
                      currentBest = { ...m };
                      anyImproved = true;
                      consResolved = true;
                      if(typeof onProgress === "function") onProgress(currentBest);
                      break;
                    }
                  }
                  this.unplaceActivity(act1.id);
                  this.unplaceActivity(act2.id);
                }
                this.placeActivityDirect(act1.id, single.item.slot);
                this.placeActivityDirect(act2.id, s2);
              }

              if(consResolved) break;

              // 2. Try 3-way cyclic swap
              for(let s3 = 0; s3 < 60; s3++){
                if(s3 === single.item.slot || s3 === s2 || this.offSlots.has(`${act1.classId}|${s3}`)) continue;
                const actId3 = cGrid1[s3];
                if(actId3 < 0) continue;
                const act3 = this.activities[actId3];
                if(!act3 || act3.isFixed || act3.duration !== 1) continue;

                this.unplaceActivity(act1.id);
                this.unplaceActivity(act2.id);
                this.unplaceActivity(act3.id);

                const r1 = this.getConflictsForSlot(act1, s2);
                const r2 = this.getConflictsForSlot(act2, s3);
                const r3 = this.getConflictsForSlot(act3, single.item.slot);

                if(r1.possible && r1.conflicts.length === 0 &&
                   r2.possible && r2.conflicts.length === 0 &&
                   r3.possible && r3.conflicts.length === 0){
                  this.placeActivityDirect(act1.id, s2);
                  this.placeActivityDirect(act2.id, s3);
                  this.placeActivityDirect(act3.id, single.item.slot);

                  if(this.isLessonBlockSafe(act1, act2, act3)){
                    const m = this.evaluateMetrics();
                    if(m.soBuoiDay1 < currentBest.soBuoiDay1 && m.soBuoiTrong2 <= maxGap2Limit){
                      currentBest = { ...m };
                      anyImproved = true;
                      consResolved = true;
                      if(typeof onProgress === "function") onProgress(currentBest);
                      break;
                    }
                  }
                  this.unplaceActivity(act1.id);
                  this.unplaceActivity(act2.id);
                  this.unplaceActivity(act3.id);
                }
                this.placeActivityDirect(act1.id, single.item.slot);
                this.placeActivityDirect(act2.id, s2);
                this.placeActivityDirect(act3.id, s3);
              }

              if(consResolved) break;
            }
            if(consResolved) break;
          }
        }
      }
      return anyImproved ? currentBest : null;
    }

    // Inbound Singleton Reinforcement: pulls lessons from multi-period sessions into 1-period sessions to reach >= 2 periods
    tryReinforceTeacherSingletons(bestMetrics, initialMetrics, maxGap2Limit = Infinity, onProgress = null){
      const DAYS = DAYS_LIST.length;
      const SESSIONS = SESSIONS_LIST.length;
      const PERIODS = PERIODS_PER_SESSION;
      let currentBest = { ...bestMetrics };
      let anyImproved = false;

      const teacherList = Array.from(this.teacherGrid.keys()).filter(t => t && this.isScoredTeacher(t));
      this.rng.shuffle(teacherList);

      for(const tKey of teacherList){
        const tGrid = this.teacherGrid.get(tKey);
        if(!tGrid) continue;

        for(let d = 0; d < DAYS; d++){
          for(let b = 0; b < SESSIONS; b++){
            const sStart = d * 10 + b * 5;
            let taughtCount = 0;
            let singleSlot = -1;
            for(let p = 0; p < PERIODS; p++){
              const s = sStart + p;
              if(tGrid[s] >= 0 || tGrid[s] === -3){
                taughtCount++;
                singleSlot = s;
              }
            }
            if(taughtCount !== 1) continue;

            const richSessions = [];
            for(let d2 = 0; d2 < DAYS; d2++){
              for(let b2 = 0; b2 < SESSIONS; b2++){
                if(d2 === d && b2 === b) continue;
                const sStart2 = d2 * 10 + b2 * 5;
                const movableActs = [];
                let totalPeriods = 0;
                for(let p2 = 0; p2 < PERIODS; p2++){
                  const s2 = sStart2 + p2;
                  if(tGrid[s2] >= 0){
                    totalPeriods++;
                    const a = this.activities[tGrid[s2]];
                    if(a && !a.isFixed && a.duration === 1){
                      movableActs.push({ act: a, slot: s2 });
                    }
                  }else if(tGrid[s2] === -3){
                    totalPeriods++;
                  }
                }
                if(totalPeriods >= 3 && movableActs.length > 0){
                  richSessions.push({ sStart: sStart2, movableActs, totalPeriods });
                }
              }
            }
            if(richSessions.length === 0) continue;
            richSessions.sort((x, y) => y.totalPeriods - x.totalPeriods);

            let reinResolved = false;
            for(const rich of richSessions){
              for(const item of rich.movableActs){
                const actToPull = item.act;
                const pullCGrid = this.classGrid.get(actToPull.classId);
                if(!pullCGrid) continue;

                for(let p = 0; p < PERIODS; p++){
                  const sTarget = sStart + p;
                  if(sTarget === singleSlot || this.offSlots.has(`${actToPull.classId}|${sTarget}`)) continue;
                  if(tGrid[sTarget] >= 0 || tGrid[sTarget] === -3) continue;

                  const existingActId = pullCGrid[sTarget];
                  if(existingActId < 0) continue;

                  const existingAct = this.activities[existingActId];
                  if(!existingAct || existingAct.isFixed || existingAct.duration !== 1) continue;

                  const existingTGrid = this.teacherGrid.get(existingAct.gv);
                  // 2-way swap
                  if(existingTGrid && existingTGrid[item.slot] < 0 && existingTGrid[item.slot] !== -3){
                    this.unplaceActivity(actToPull.id);
                    this.unplaceActivity(existingAct.id);

                    const r1 = this.getConflictsForSlot(actToPull, sTarget);
                    const r2 = this.getConflictsForSlot(existingAct, item.slot);

                    if(r1.possible && r1.conflicts.length === 0 && r2.possible && r2.conflicts.length === 0){
                      this.placeActivityDirect(actToPull.id, sTarget);
                      this.placeActivityDirect(existingAct.id, item.slot);

                      if(this.isLessonBlockSafe(actToPull, existingAct)){
                        const m = this.evaluateMetrics();
                        if(m.soBuoiDay1 < currentBest.soBuoiDay1 && m.soBuoiTrong2 <= maxGap2Limit){
                          currentBest = { ...m };
                          anyImproved = true;
                          reinResolved = true;
                          if(typeof onProgress === "function") onProgress(currentBest);
                          break;
                        }
                      }
                      this.unplaceActivity(actToPull.id);
                      this.unplaceActivity(existingAct.id);
                    }
                    this.placeActivityDirect(actToPull.id, item.slot);
                    this.placeActivityDirect(existingAct.id, sTarget);
                  }
                  if(reinResolved) break;

                  // 3-way cyclic swap
                  for(let s3 = 0; s3 < 60; s3++){
                    if(s3 === item.slot || s3 === sTarget || this.offSlots.has(`${actToPull.classId}|${s3}`)) continue;
                    const actId3 = pullCGrid[s3];
                    if(actId3 < 0) continue;
                    const act3 = this.activities[actId3];
                    if(!act3 || act3.isFixed || act3.duration !== 1) continue;

                    this.unplaceActivity(actToPull.id);
                    this.unplaceActivity(existingAct.id);
                    this.unplaceActivity(act3.id);

                    const r1 = this.getConflictsForSlot(actToPull, sTarget);
                    const r2 = this.getConflictsForSlot(existingAct, s3);
                    const r3 = this.getConflictsForSlot(act3, item.slot);

                    if(r1.possible && r1.conflicts.length === 0 &&
                       r2.possible && r2.conflicts.length === 0 &&
                       r3.possible && r3.conflicts.length === 0){
                      this.placeActivityDirect(actToPull.id, sTarget);
                      this.placeActivityDirect(existingAct.id, s3);
                      this.placeActivityDirect(act3.id, item.slot);

                      if(this.isLessonBlockSafe(actToPull, existingAct, act3)){
                        const m = this.evaluateMetrics();
                        if(m.soBuoiDay1 < currentBest.soBuoiDay1 && m.soBuoiTrong2 <= maxGap2Limit){
                          currentBest = { ...m };
                          anyImproved = true;
                          reinResolved = true;
                          if(typeof onProgress === "function") onProgress(currentBest);
                          break;
                        }
                      }
                      this.unplaceActivity(actToPull.id);
                      this.unplaceActivity(existingAct.id);
                      this.unplaceActivity(act3.id);
                    }
                    this.placeActivityDirect(actToPull.id, item.slot);
                    this.placeActivityDirect(existingAct.id, sTarget);
                    this.placeActivityDirect(act3.id, s3);
                  }
                  if(reinResolved) break;
                }
                if(reinResolved) break;
              }
              if(reinResolved) break;
            }
          }
        }
      }
      return anyImproved ? currentBest : null;
    }

    // Comprehensive Singleton Obliterator: thoroughly merges 1-period teaching sessions across the whole school using 2-way and 3-way cycles
    obliterateAllTeacherSingletons(maxPasses = 15, maxGap2Limit = Infinity, onProgress = null){
      const DAYS = DAYS_LIST.length;
      const SESSIONS = SESSIONS_LIST.length;
      const PERIODS = PERIODS_PER_SESSION;
      let currentBest = this.evaluateMetrics();
      let anyImproved = false;

      for(let pass = 0; pass < maxPasses; pass++){
        if(currentBest.soBuoiDay1 === 0) break;
        let passImproved = false;

        const teacherList = Array.from(this.teacherGrid.keys()).filter(t => t && this.isScoredTeacher(t));
        this.rng.shuffle(teacherList);

        for(const tKey of teacherList){
          const tGrid = this.teacherGrid.get(tKey);
          if(!tGrid) continue;

          for(let d = 0; d < DAYS; d++){
            for(let b = 0; b < SESSIONS; b++){
              const sStart = d * 10 + b * 5;
              const taught = [];
              for(let p = 0; p < PERIODS; p++){
                const s = sStart + p;
                if(tGrid[s] >= 0){
                  const act = this.activities[tGrid[s]];
                  if(act && !act.isFixed && act.duration === 1){
                    taught.push({ slot: s, actId: tGrid[s], p });
                  }
                }else if(tGrid[s] === -3){
                  taught.push({ slot: s, actId: -3, p });
                }
              }

              if(taught.length !== 1 || taught[0].actId < 0) continue;

              const s1 = taught[0].slot;
              const act1 = this.activities[taught[0].actId];
              const cGrid = this.classGrid.get(act1.classId);
              if(!cGrid) continue;

              const targetSessions = [];
              for(let d2 = 0; d2 < DAYS; d2++){
                for(let b2 = 0; b2 < SESSIONS; b2++){
                  if(d2 === d && b2 === b) continue;
                  const sStart2 = d2 * 10 + b2 * 5;
                  let cnt = 0;
                  for(let p2 = 0; p2 < PERIODS; p2++){
                    if(tGrid[sStart2 + p2] >= 0 || tGrid[sStart2 + p2] === -3) cnt++;
                  }
                  if(cnt >= 1 && cnt < 5){
                    targetSessions.push({ sStart: sStart2, cnt });
                  }
                }
              }
              targetSessions.sort((x, y) => y.cnt - x.cnt);

              let resolved = false;

              for(const target of targetSessions){
                for(let p2 = 0; p2 < PERIODS; p2++){
                  const s2 = target.sStart + p2;
                  if(this.offSlots.has(`${act1.classId}|${s2}`)) continue;
                  if(tGrid[s2] >= 0 || tGrid[s2] === -3) continue;

                  const actId2 = cGrid[s2];
                  if(actId2 < 0) continue;

                  const act2 = this.activities[actId2];
                  if(!act2 || act2.isFixed || act2.duration !== 1) continue;

                  const tDstGrid = this.teacherGrid.get(act2.gv);

                  // Case 1: 2-way direct swap
                  if(tDstGrid && tDstGrid[s1] < 0 && tDstGrid[s1] !== -3){
                    this.unplaceActivity(act1.id);
                    this.unplaceActivity(act2.id);

                    const r1 = this.getConflictsForSlot(act1, s2);
                    const r2 = this.getConflictsForSlot(act2, s1);

                    if(r1.possible && r1.conflicts.length === 0 && r2.possible && r2.conflicts.length === 0){
                      this.placeActivityDirect(act1.id, s2);
                      this.placeActivityDirect(act2.id, s1);

                      if(this.isLessonBlockSafe(act1, act2)){
                        const m = this.evaluateMetrics();
                        if((m.soBuoiDay1 < currentBest.soBuoiDay1 || (m.soBuoiDay1 === currentBest.soBuoiDay1 && m.tsBuoiDay < currentBest.tsBuoiDay)) && m.soBuoiTrong2 <= maxGap2Limit){
                          currentBest = { ...m };
                          anyImproved = true;
                          passImproved = true;
                          resolved = true;
                          if(typeof onProgress === "function") onProgress(currentBest);
                          break;
                        }
                      }
                      this.unplaceActivity(act1.id);
                      this.unplaceActivity(act2.id);
                    }
                    this.placeActivityDirect(act1.id, s1);
                    this.placeActivityDirect(act2.id, s2);
                  }

                  if(resolved) break;

                  // Case 2: 3-way cyclic swap
                  for(let s3 = 0; s3 < 60; s3++){
                    if(s3 === s1 || s3 === s2 || this.offSlots.has(`${act1.classId}|${s3}`)) continue;
                    const actId3 = cGrid[s3];
                    if(actId3 < 0) continue; // Must be a closed cycle so slot s1 is not left empty

                    const act3 = this.activities[actId3];
                    if(!act3 || act3.isFixed || act3.duration !== 1) continue;

                    this.unplaceActivity(act1.id);
                    this.unplaceActivity(act2.id);
                    this.unplaceActivity(act3.id);

                    const r1 = this.getConflictsForSlot(act1, s2);
                    const r2 = this.getConflictsForSlot(act2, s3);
                    const r3 = this.getConflictsForSlot(act3, s1);

                    if(r1.possible && r1.conflicts.length === 0 &&
                       r2.possible && r2.conflicts.length === 0 &&
                       r3.possible && r3.conflicts.length === 0){
                      this.placeActivityDirect(act1.id, s2);
                      this.placeActivityDirect(act2.id, s3);
                      this.placeActivityDirect(act3.id, s1);

                      if(this.isLessonBlockSafe(act1, act2, act3)){
                        const m = this.evaluateMetrics();
                        if((m.soBuoiDay1 < currentBest.soBuoiDay1 || (m.soBuoiDay1 === currentBest.soBuoiDay1 && m.tsBuoiDay < currentBest.tsBuoiDay)) && m.soBuoiTrong2 <= maxGap2Limit){
                          currentBest = { ...m };
                          anyImproved = true;
                          passImproved = true;
                          resolved = true;
                          if(typeof onProgress === "function") onProgress(currentBest);
                          break;
                        }
                      }
                      this.unplaceActivity(act1.id);
                      this.unplaceActivity(act2.id);
                      this.unplaceActivity(act3.id);
                    }
                    this.placeActivityDirect(act1.id, s1);
                    this.placeActivityDirect(act2.id, s2);
                    this.placeActivityDirect(act3.id, s3);
                  }

                  if(resolved) break;
                }
                if(resolved) break;
              }
            }
          }
        }
        if(!passImproved) break;
      }
      return anyImproved ? currentBest : null;
    }

    obliterateAllThinTeacherSessions(maxPasses = 8, targetSizes = [1, 2], maxGap2Limit = Infinity, onProgress = null){
      let currentBest = this.evaluateMetrics();
      let anyImproved = false;

      for(let pass = 0; pass < maxPasses; pass++){
        let passImproved = false;
        const thinSessions = [];
        this.teacherGrid.forEach((tGrid, tKey) => {
          if(!tKey) return;
          for(let d = 0; d < DAYS_LIST.length; d++){
            for(let b = 0; b < SESSIONS_LIST.length; b++){
              const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
              let cnt = 0;
              for(let p = 0; p < PERIODS_PER_SESSION; p++){
                if(tGrid[sStart + p] >= 0 || tGrid[sStart + p] === -3) cnt++;
              }
              if(targetSizes.includes(cnt)){
                thinSessions.push({ tKey, d, b, cnt });
              }
            }
          }
        });

        this.rng.shuffle(thinSessions);
        thinSessions.sort((x, y) => x.cnt - y.cnt);

        for(const s of thinSessions.slice(0, 30)){
          const res = this.tryVacateTeacherSession(s.tKey, s.d, s.b, currentBest, currentBest);
          if(res && this.compareMetrics(res, currentBest, "optimize_sessions") < 0){
            currentBest = { ...res };
            anyImproved = true;
            passImproved = true;
            if(typeof onProgress === "function") onProgress(currentBest);
            break;
          }
        }

        if(!passImproved) break;
      }
      return anyImproved ? currentBest : null;
    }

    // Dedicated 1-Period-per-Day Eliminator (Spec: ANTIGRAVITY_GIAM_1_TIET_NGAY_v2.md)
    // Targets teachers who teach exactly 1 period on an entire day (combining Morning + Afternoon).
    fixDaySingletons(bestMetrics, onProgress = null){
      const DAYS = DAYS_LIST.length;
      const SESSIONS = SESSIONS_LIST.length;
      const PERIODS = PERIODS_PER_SESSION;
      let currentBest = { ...bestMetrics };
      let anyImproved = false;

      const teacherList = Array.from(this.teacherGrid.keys()).filter(t => t && this.isScoredTeacher(t));
      this.rng.shuffle(teacherList);

      for(const tKey of teacherList){
        const tGrid = this.teacherGrid.get(tKey);
        if(!tGrid) continue;

        for(let d = 0; d < DAYS; d++){
          let taught = [];
          for(let b = 0; b < SESSIONS; b++){
            const sStart = d * 10 + b * 5;
            for(let p = 0; p < PERIODS; p++){
              const slot = sStart + p;
              const cell = tGrid[slot];
              if(cell >= 0){
                const act = this.activities[cell];
                if(act && !act.isFixed && act.duration === 1){
                  taught.push({ slot, actId: cell, d, b, p });
                }
              }else if(cell === -3){
                taught.push({ slot, actId: -3, d, b, p });
              }
            }
          }

          // Exactly 1 period on this entire day!
          if(taught.length !== 1 || taught[0].actId < 0) continue;

          const item1 = taught[0];
          const act1 = this.activities[item1.actId];
          if(!act1 || act1.isFixed) continue;
          const cGrid1 = this.classGrid.get(act1.classId);
          if(!cGrid1) continue;

          let dayResolved = false;

          // Strategy A: Move/Swap this single lesson to another day/session where teacher already teaches >= 1 period
          for(let d2 = 0; d2 < DAYS; d2++){
            if(d2 === d) continue;
            for(let b2 = 0; b2 < SESSIONS; b2++){
              const sStart2 = d2 * 10 + b2 * 5;
              let tCount = 0;
              for(let p = 0; p < PERIODS; p++){
                if(tGrid[sStart2 + p] >= 0 || tGrid[sStart2 + p] === -3) tCount++;
              }
              if(tCount === 0 || tCount >= PERIODS) continue;

              for(let p2 = 0; p2 < PERIODS; p2++){
                const s2 = sStart2 + p2;
                if(this.offSlots.has(`${act1.classId}|${s2}`)) continue;
                if(tGrid[s2] >= 0 || tGrid[s2] === -3) continue;

                const actId2 = cGrid1[s2];
                if(actId2 === -2 || actId2 === -3 || this.fixedSlots.has(`${act1.classId}|${s2}`)) continue;
                if(actId2 < 0){
                  this.unplaceActivity(act1.id);
                  const r1 = this.getConflictsForSlot(act1, s2);
                  if(r1.possible && r1.conflicts.length === 0){
                    this.placeActivityDirect(act1.id, s2);
                    if(this.isLessonBlockSafe(act1)){
                      const m = this.evaluateMetrics();
                      if(m.soNgayMotTiet < currentBest.soNgayMotTiet || (m.soNgayMotTiet === currentBest.soNgayMotTiet && m.soBuoiDay1 < currentBest.soBuoiDay1)){
                        currentBest = { ...m };
                        anyImproved = true;
                        dayResolved = true;
                        if(typeof onProgress === "function") onProgress(currentBest);
                        break;
                      }
                    }
                    this.unplaceActivity(act1.id);
                  }
                  this.placeActivityDirect(act1.id, item1.slot);
                  continue;
                }

                const act2 = this.activities[actId2];
                if(!act2 || act2.isFixed || act2.duration !== 1 || this.fixedSlots.has(`${act2.classId}|${item1.slot}`)) continue;
                const tDstGrid = this.teacherGrid.get(act2.gv);
                if(tDstGrid && tDstGrid[item1.slot] < 0 && tDstGrid[item1.slot] !== -3){
                  this.unplaceActivity(act1.id);
                  this.unplaceActivity(act2.id);

                  const r1 = this.getConflictsForSlot(act1, s2);
                  const r2 = this.getConflictsForSlot(act2, item1.slot);

                  if(r1.possible && r1.conflicts.length === 0 && r2.possible && r2.conflicts.length === 0){
                    this.placeActivityDirect(act1.id, s2);
                    this.placeActivityDirect(act2.id, item1.slot);

                    if(this.isLessonBlockSafe(act1, act2)){
                      const m = this.evaluateMetrics();
                      if(m.soNgayMotTiet < currentBest.soNgayMotTiet || (m.soNgayMotTiet === currentBest.soNgayMotTiet && m.soBuoiDay1 < currentBest.soBuoiDay1)){
                        currentBest = { ...m };
                        anyImproved = true;
                        dayResolved = true;
                        if(typeof onProgress === "function") onProgress(currentBest);
                        break;
                      }
                    }
                    this.unplaceActivity(act1.id);
                    this.unplaceActivity(act2.id);
                  }
                  this.placeActivityDirect(act1.id, item1.slot);
                  this.placeActivityDirect(act2.id, s2);
                }
              }
              if(dayResolved) break;
            }
            if(dayResolved) break;
          }

          if(dayResolved) continue;

          // Strategy B: 3-way cyclic swap to relocate the single lesson
          for(let s2 = 0; s2 < 60; s2++){
            if(s2 === item1.slot || this.offSlots.has(`${act1.classId}|${s2}`)) continue;
            const actId2 = cGrid1[s2];
            if(actId2 < 0 || this.fixedSlots.has(`${act1.classId}|${s2}`)) continue;
            const act2 = this.activities[actId2];
            if(!act2 || act2.isFixed || act2.duration !== 1) continue;

            const cGrid2 = this.classGrid.get(act2.classId);
            if(!cGrid2) continue;

            for(let s3 = 0; s3 < 60; s3++){
              if(s3 === s2 || s3 === item1.slot || this.offSlots.has(`${act2.classId}|${s3}`)) continue;
              const actId3 = cGrid2[s3];
              if(actId3 < 0 || this.fixedSlots.has(`${act2.classId}|${s3}`)) continue;
              const act3 = this.activities[actId3];
              if(!act3 || act3.isFixed || act3.duration !== 1 || this.fixedSlots.has(`${act3.classId}|${item1.slot}`)) continue;

              this.unplaceActivity(act1.id);
              this.unplaceActivity(act2.id);
              this.unplaceActivity(act3.id);

              const r1 = this.getConflictsForSlot(act1, s2);
              const r2 = this.getConflictsForSlot(act2, s3);
              const r3 = this.getConflictsForSlot(act3, item1.slot);

              if(r1.possible && r1.conflicts.length === 0 &&
                 r2.possible && r2.conflicts.length === 0 &&
                 r3.possible && r3.conflicts.length === 0){
                this.placeActivityDirect(act1.id, s2);
                this.placeActivityDirect(act2.id, s3);
                this.placeActivityDirect(act3.id, item1.slot);

                if(this.isLessonBlockSafe(act1, act2, act3)){
                  const m = this.evaluateMetrics();
                  if(m.soNgayMotTiet < currentBest.soNgayMotTiet || (m.soNgayMotTiet === currentBest.soNgayMotTiet && m.soBuoiDay1 < currentBest.soBuoiDay1)){
                    currentBest = { ...m };
                    anyImproved = true;
                    dayResolved = true;
                    if(typeof onProgress === "function") onProgress(currentBest);
                    break;
                  }
                }
                this.unplaceActivity(act1.id);
                this.unplaceActivity(act2.id);
                this.unplaceActivity(act3.id);
              }
              this.placeActivityDirect(act1.id, item1.slot);
              this.placeActivityDirect(act2.id, s2);
              this.placeActivityDirect(act3.id, s3);
            }
            if(dayResolved) break;
          }
        }
      }
      return anyImproved ? currentBest : null;
    }

    // Session Vacater for optimize_sessions: compacts teaching days/sessions to reduce total sessions and eliminate 2-3 period sessions
    tryVacateTeacherSessions(bestMetrics, initialMetrics, maxGap2Limit = Infinity, onProgress = null){
      const DAYS = DAYS_LIST.length;
      const SESSIONS = SESSIONS_LIST.length;
      const PERIODS = PERIODS_PER_SESSION;
      let currentBest = { ...bestMetrics };
      let anyImproved = false;

      const teacherList = Array.from(this.teacherGrid.keys()).filter(t => t && this.isScoredTeacher(t));
      this.rng.shuffle(teacherList);

      for(const tKey of teacherList){
        const tGrid = this.teacherGrid.get(tKey);
        if(!tGrid) continue;

        for(let d = 0; d < DAYS; d++){
          for(let b = 0; b < SESSIONS; b++){
            const sStart = d * 10 + b * 5;
            const taught = [];
            for(let p = 0; p < PERIODS; p++){
              const s = sStart + p;
              if(tGrid[s] >= 0){
                const act = this.activities[tGrid[s]];
                if(act && !act.isFixed && act.duration === 1){
                  taught.push({ slot: s, actId: tGrid[s], p });
                }
              }else if(tGrid[s] === -3){
                taught.push({ slot: s, actId: -3, p });
              }
            }

            // Target sessions with 1, 2, or 3 periods to vacate or consolidate into 4-5 periods
            if(taught.length === 0 || taught.length > 3 || taught.some(t => t.actId < 0)) continue;

            const targetSessions = [];
            for(let d2 = 0; d2 < DAYS; d2++){
              for(let b2 = 0; b2 < SESSIONS; b2++){
                if(d2 === d && b2 === b) continue;
                const sStart2 = d2 * 10 + b2 * 5;
                let cnt = 0;
                for(let p2 = 0; p2 < PERIODS; p2++){
                  if(tGrid[sStart2 + p2] >= 0 || tGrid[sStart2 + p2] === -3) cnt++;
                }
                if(cnt >= 1 && cnt + taught.length <= 5){
                  targetSessions.push({ sStart: sStart2, cnt });
                }
              }
            }
            if(targetSessions.length === 0) continue;
            targetSessions.sort((x, y) => y.cnt - x.cnt);

            for(const target of targetSessions){
              if(taught.length === 1){
                const s1 = taught[0].slot;
                const act1 = this.activities[taught[0].actId];
                const cGrid = this.classGrid.get(act1.classId);
                if(!cGrid) continue;

                let resolved = false;
                for(let p2 = 0; p2 < PERIODS; p2++){
                  const s2 = target.sStart + p2;
                  if(this.offSlots.has(`${act1.classId}|${s2}`)) continue;
                  if(tGrid[s2] >= 0 || tGrid[s2] === -3) continue;

                  const actId2 = cGrid[s2];
                  if(actId2 < 0) continue;
                  const act2 = this.activities[actId2];
                  if(!act2 || act2.isFixed || act2.duration !== 1) continue;

                  const tDstGrid = this.teacherGrid.get(act2.gv);
                  if(tDstGrid && tDstGrid[s1] < 0 && tDstGrid[s1] !== -3){
                    this.unplaceActivity(act1.id);
                    this.unplaceActivity(act2.id);

                    const r1 = this.getConflictsForSlot(act1, s2);
                    const r2 = this.getConflictsForSlot(act2, s1);

                    if(r1.possible && r1.conflicts.length === 0 && r2.possible && r2.conflicts.length === 0){
                      this.placeActivityDirect(act1.id, s2);
                      this.placeActivityDirect(act2.id, s1);

                      if(this.isLessonBlockSafe(act1, act2)){
                        const m = this.evaluateMetrics();
                        if(m.soBuoiDay1 <= bestMetrics.soBuoiDay1 && m.soNgayMotTiet <= bestMetrics.soNgayMotTiet){
                          if(m.tsBuoiDay < currentBest.tsBuoiDay || (m.tsBuoiDay === currentBest.tsBuoiDay && ((m.soBuoiDay2||0)*2 + (m.soBuoiDay3||0) < (currentBest.soBuoiDay2||0)*2 + (currentBest.soBuoiDay3||0) || m.tsNgayDay < currentBest.tsNgayDay))){
                            currentBest = { ...m };
                            anyImproved = true;
                            resolved = true;
                            if(typeof onProgress === "function") onProgress(currentBest);
                            break;
                          }
                        }
                      }
                      this.unplaceActivity(act1.id);
                      this.unplaceActivity(act2.id);
                    }
                    this.placeActivityDirect(act1.id, s1);
                    this.placeActivityDirect(act2.id, s2);
                  }
                  if(resolved) break;
                }
              }else if(taught.length === 2){
                const act1 = this.activities[taught[0].actId];
                const act2 = this.activities[taught[1].actId];
                if(!act1 || act1.isFixed || !act2 || act2.isFixed) continue;
                const cGrid1 = this.classGrid.get(act1.classId);
                const cGrid2 = this.classGrid.get(act2.classId);
                if(!cGrid1 || !cGrid2) continue;

                let resolved = false;
                for(let pA = 0; pA < PERIODS; pA++){
                  const sA = target.sStart + pA;
                  if(this.offSlots.has(`${act1.classId}|${sA}`) || tGrid[sA] >= 0 || tGrid[sA] === -3) continue;
                  const actIdA = cGrid1[sA];
                  if(actIdA < 0) continue;
                  const actA = this.activities[actIdA];
                  if(!actA || actA.isFixed || actA.duration !== 1) continue;
                  const tDstGridA = this.teacherGrid.get(actA.gv);
                  if(!tDstGridA || tDstGridA[taught[0].slot] >= 0 || tDstGridA[taught[0].slot] === -3) continue;

                  for(let pB = 0; pB < PERIODS; pB++){
                    if(pB === pA) continue;
                    const sB = target.sStart + pB;
                    if(this.offSlots.has(`${act2.classId}|${sB}`) || tGrid[sB] >= 0 || tGrid[sB] === -3) continue;
                    const actIdB = cGrid2[sB];
                    if(actIdB < 0) continue;
                    const actB = this.activities[actIdB];
                    if(!actB || actB.isFixed || actB.duration !== 1) continue;
                    const tDstGridB = this.teacherGrid.get(actB.gv);
                    if(!tDstGridB || tDstGridB[taught[1].slot] >= 0 || tDstGridB[taught[1].slot] === -3) continue;

                    this.unplaceActivity(act1.id);
                    this.unplaceActivity(act2.id);
                    this.unplaceActivity(actA.id);
                    this.unplaceActivity(actB.id);

                    const r1 = this.getConflictsForSlot(act1, sA);
                    const r2 = this.getConflictsForSlot(act2, sB);
                    const rA = this.getConflictsForSlot(actA, taught[0].slot);
                    const rB = this.getConflictsForSlot(actB, taught[1].slot);

                    if(r1.possible && r1.conflicts.length === 0 &&
                       r2.possible && r2.conflicts.length === 0 &&
                       rA.possible && rA.conflicts.length === 0 &&
                       rB.possible && rB.conflicts.length === 0){
                      this.placeActivityDirect(act1.id, sA);
                      this.placeActivityDirect(act2.id, sB);
                      this.placeActivityDirect(actA.id, taught[0].slot);
                      this.placeActivityDirect(actB.id, taught[1].slot);

                      if(this.isLessonBlockSafe(act1, act2, actA, actB)){
                        const m = this.evaluateMetrics();
                        if(m.soBuoiDay1 <= bestMetrics.soBuoiDay1 && m.soNgayMotTiet <= bestMetrics.soNgayMotTiet){
                          if(m.tsBuoiDay < currentBest.tsBuoiDay || (m.tsBuoiDay === currentBest.tsBuoiDay && ((m.soBuoiDay2||0)*2 + (m.soBuoiDay3||0) < (currentBest.soBuoiDay2||0)*2 + (currentBest.soBuoiDay3||0) || m.tsNgayDay < currentBest.tsNgayDay))){
                            currentBest = { ...m };
                            anyImproved = true;
                            resolved = true;
                            if(typeof onProgress === "function") onProgress(currentBest);
                            break;
                          }
                        }
                      }
                      this.unplaceActivity(act1.id);
                      this.unplaceActivity(act2.id);
                      this.unplaceActivity(actA.id);
                      this.unplaceActivity(actB.id);
                    }
                    this.placeActivityDirect(act1.id, taught[0].slot);
                    this.placeActivityDirect(act2.id, taught[1].slot);
                    this.placeActivityDirect(actA.id, sA);
                    this.placeActivityDirect(actB.id, sB);
                  }
                  if(resolved) break;
                }
              }
            }
          }
        }
      }
      return anyImproved ? currentBest : null;
    }

    // Targeted LNS Gap Crusher: specifically eliminates 2-period gaps (trống 2 tiết) and 1-period gaps
    tryCrushTeacherGaps(bestMetrics, initialMetrics, mode = "optimize_gap2", onProgress = null){
      const DAYS = DAYS_LIST.length;
      const SESSIONS = SESSIONS_LIST.length;
      const PERIODS = PERIODS_PER_SESSION;
      let currentBest = { ...bestMetrics };
      let anyImproved = false;

      const teacherList = Array.from(this.teacherGrid.keys()).filter(t => t && this.isScoredTeacher(t));
      this.rng.shuffle(teacherList);

      for(const tKey of teacherList){
        const tGrid = this.teacherGrid.get(tKey);
        if(!tGrid) continue;

        for(let d = 0; d < DAYS; d++){
          for(let b = 0; b < SESSIONS; b++){
            const sessionStart = d * 10 + b * 5;
            const taught = [];
            for(let p = 0; p < PERIODS; p++){
              const s = sessionStart + p;
              if(tGrid[s] >= 0 || tGrid[s] === -3){
                taught.push({ slot: s, actId: tGrid[s], p });
              }
            }

            const k = taught.length;
            if(k < 2) continue;

            // UI counts a session's gap class by TOTAL holes in the span
            // (span - taught), so [x,.,x,.,x] is a "Trong 2 tiet" session.
            // Target selection must match that rule or split-hole sessions
            // are never attacked by the gap2 stage.
            const spanHoles = (taught[k - 1].p - taught[0].p + 1) - k;
            let hasTargetGap = false;
            if(mode === "optimize_gap2" && spanHoles >= 2) hasTargetGap = true;
            else if(mode === "optimize_gap1" && spanHoles === 1) hasTargetGap = true;

            if(!hasTargetGap) continue;

            const movableTaught = taught.filter(t => t.actId >= 0 && !this.activities[t.actId].isFixed && this.activities[t.actId].duration === 1);
            if(movableTaught.length === 0) continue;

            let gapResolved = false;

            for(const srcItem of movableTaught){
              const act1 = this.activities[srcItem.actId];
              const cClassGrid = this.classGrid.get(act1.classId);
              if(!cClassGrid) continue;
              // Freshness guard: earlier trials may have relocated act1; a stale
              // srcItem.slot must never be used for unplace/restore (that was the
              // root cause of silent overwrites in the 3-way rotation).
              if(this.actPlacement[act1.id] !== srcItem.slot) continue;

              // 1. Try moving act1 into the internal gap or contiguous position
              for(let p = 0; p < PERIODS; p++){
                if(this.actPlacement[act1.id] !== srcItem.slot) break;
                const targetSlot = sessionStart + p;
                if(tGrid[targetSlot] >= 0 || tGrid[targetSlot] === -3) continue;
                if(this.offSlots.has(`${act1.classId}|${targetSlot}`) || this.fixedSlots.has(`${act1.classId}|${targetSlot}`)) continue;

                const actId2 = cClassGrid[targetSlot];
                if(actId2 < 0) continue;

                const act2 = this.activities[actId2];
                if(!act2 || act2.isFixed || act2.duration !== 1 || this.fixedSlots.has(`${act2.classId}|${srcItem.slot}`)) continue;

                const tDstGrid = this.teacherGrid.get(act2.gv);

                // 2-way swap
                if(tDstGrid && tDstGrid[srcItem.slot] < 0 && tDstGrid[srcItem.slot] !== -3){
                  this.unplaceActivity(act1.id);
                  this.unplaceActivity(act2.id);

                  const r1 = this.getConflictsForSlot(act1, targetSlot);
                  const r2 = this.getConflictsForSlot(act2, srcItem.slot);

                  if(r1.possible && r1.conflicts.length === 0 && r2.possible && r2.conflicts.length === 0){
                    this.placeActivityDirect(act1.id, targetSlot);
                    this.placeActivityDirect(act2.id, srcItem.slot);

                    if(this.isLessonBlockSafe(act1, act2) && this.isLessonBlockSafe()){
                      const currentM = this.evaluateMetrics();
                      if(this.compareMetrics(currentM, currentBest, mode) < 0){
                        currentBest = { ...currentM };
                        anyImproved = true;
                        gapResolved = true;
                        if(typeof onProgress === "function") onProgress(currentBest);
                        break;
                      }
                    }
                    this.unplaceActivity(act1.id);
                    this.unplaceActivity(act2.id);
                  }
                  this.placeActivityDirect(act1.id, srcItem.slot);
                  this.placeActivityDirect(act2.id, targetSlot);
                }
                if(gapResolved) break;

                // 3-way cyclic swap
                for(let s3 = 0; s3 < 60; s3++){
                  if(this.actPlacement[act1.id] !== srcItem.slot) break;
                  if(this.actPlacement[act2.id] !== targetSlot) break;
                  if(s3 === srcItem.slot || s3 === targetSlot || this.offSlots.has(`${act1.classId}|${s3}`) || this.fixedSlots.has(`${act1.classId}|${s3}`)) continue;
                  const actId3 = cClassGrid[s3];
                  if(actId3 < 0) continue;
                  const act3 = this.activities[actId3];
                  if(!act3 || act3.isFixed || act3.duration !== 1 || this.fixedSlots.has(`${act3.classId}|${srcItem.slot}`) || this.fixedSlots.has(`${act2.classId}|${s3}`)) continue;

                  this.unplaceActivity(act1.id);
                  this.unplaceActivity(act2.id);
                  this.unplaceActivity(act3.id);

                  const r1 = this.getConflictsForSlot(act1, targetSlot);
                  const r2 = this.getConflictsForSlot(act2, s3);
                  const r3 = this.getConflictsForSlot(act3, srcItem.slot);

                  if(r1.possible && r1.conflicts.length === 0 &&
                     r2.possible && r2.conflicts.length === 0 &&
                     r3.possible && r3.conflicts.length === 0){
                    this.placeActivityDirect(act1.id, targetSlot);
                    this.placeActivityDirect(act2.id, s3);
                    this.placeActivityDirect(act3.id, srcItem.slot);

                    if(this.isLessonBlockSafe(act1, act2, act3) && this.isLessonBlockSafe()){
                      const currentM = this.evaluateMetrics();
                      if(this.compareMetrics(currentM, currentBest, mode) < 0){
                        currentBest = { ...currentM };
                        anyImproved = true;
                        gapResolved = true;
                        if(typeof onProgress === "function") onProgress(currentBest);
                        break;
                      }
                    }
                    this.unplaceActivity(act1.id);
                    this.unplaceActivity(act2.id);
                    this.unplaceActivity(act3.id);
                  }
                  this.placeActivityDirect(act1.id, srcItem.slot);
                  this.placeActivityDirect(act2.id, targetSlot);
                  this.placeActivityDirect(act3.id, s3);
                  if(gapResolved) break;
                }
                if(gapResolved) break;
              }
              if(gapResolved) break;
            }

            // 4. Cross-Session Consolidation: Relocate outlying lessons to other active sessions where teacher already teaches
            if(!gapResolved){
              for(const srcItem of movableTaught){
                const act1 = this.activities[srcItem.actId];
                if(!act1 || act1.isFixed) continue;
                if(this.actPlacement[act1.id] !== srcItem.slot) continue; // freshness guard

                const cClassGrid = this.classGrid.get(act1.classId);
                if(!cClassGrid) continue;

                for(let d2 = 0; d2 < DAYS; d2++){
                  for(let b2 = 0; b2 < SESSIONS; b2++){
                    if(d2 === d && b2 === b) continue;
                    const sStart2 = d2 * 10 + b2 * 5;

                    let tCount2 = 0;
                    for(let p2 = 0; p2 < PERIODS; p2++){
                      if(tGrid[sStart2 + p2] >= 0 || tGrid[sStart2 + p2] === -3) tCount2++;
                    }
                    if(tCount2 >= PERIODS) continue;

                    for(let p2 = 0; p2 < PERIODS; p2++){
                      if(this.actPlacement[act1.id] !== srcItem.slot) break; // freshness guard
                      const s2 = sStart2 + p2;
                      if(this.offSlots.has(`${act1.classId}|${s2}`) || this.fixedSlots.has(`${act1.classId}|${s2}`)) continue;
                      if(tGrid[s2] >= 0 || tGrid[s2] === -3) continue;

                      const actId2 = cClassGrid[s2];
                      if(actId2 < 0) continue;

                      const act2 = this.activities[actId2];
                      if(!act2 || act2.isFixed || act2.duration !== 1 || this.fixedSlots.has(`${act2.classId}|${srcItem.slot}`)) continue;

                      const tDstGrid = this.teacherGrid.get(act2.gv);
                      if(tDstGrid && tDstGrid[srcItem.slot] < 0 && tDstGrid[srcItem.slot] !== -3){
                        this.unplaceActivity(act1.id);
                        this.unplaceActivity(act2.id);

                        const r1 = this.getConflictsForSlot(act1, s2);
                        const r2 = this.getConflictsForSlot(act2, srcItem.slot);

                        if(r1.possible && r1.conflicts.length === 0 && r2.possible && r2.conflicts.length === 0){
                          this.placeActivityDirect(act1.id, s2);
                          this.placeActivityDirect(act2.id, srcItem.slot);

                          if(this.isLessonBlockSafe(act1, act2)){
                            const currentM = this.evaluateMetrics();
                            if(this.compareMetrics(currentM, currentBest, mode) < 0){
                              currentBest = { ...currentM };
                              anyImproved = true;
                              gapResolved = true;
                              if(typeof onProgress === "function") onProgress(currentBest);
                              break;
                            }
                          }
                          this.unplaceActivity(act1.id);
                          this.unplaceActivity(act2.id);
                        }
                        this.placeActivityDirect(act1.id, srcItem.slot);
                        this.placeActivityDirect(act2.id, s2);
                      }
                      if(gapResolved) break;
                    }
                    if(gapResolved) break;
                  }
                  if(gapResolved) break;
                }
                if(gapResolved) break;
              }
            }
          }
        }
      }
      return anyImproved ? currentBest : null;
    }

    // Inbound Gap-Filler (Spec: ANTIGRAVITY_KHU_2_TIET_TRONG.md De Xuat 3)
    // Searches from the perspective of the GAP, pulling matching lessons of teacher tKey from other sessions
    tryFillTeacherGapFromElsewhere(bestMetrics, initialMetrics, onProgress = null){
      const DAYS = DAYS_LIST.length;
      const SESSIONS = SESSIONS_LIST.length;
      const PERIODS = PERIODS_PER_SESSION;
      let currentBest = { ...bestMetrics };
      let anyImproved = false;

      const teacherList = Array.from(this.teacherGrid.keys()).filter(t => t && this.isScoredTeacher(t));
      this.rng.shuffle(teacherList);

      for(const tKey of teacherList){
        const tGrid = this.teacherGrid.get(tKey);
        if(!tGrid) continue;

        for(let d = 0; d < DAYS; d++){
          for(let b = 0; b < SESSIONS; b++){
            const sessionStart = d * 10 + b * 5;
            const taught = [];
            for(let p = 0; p < PERIODS; p++){
              const s = sessionStart + p;
              if(tGrid[s] >= 0 || tGrid[s] === -3){
                taught.push({ slot: s, actId: tGrid[s], p });
              }
            }

            const k = taught.length;
            if(k < 2 || k >= 5) continue;

            const taughtPSet = new Set(taught.map(t => t.p));
            const gapSlots = [];
            for(let p = taught[0].p + 1; p < taught[k - 1].p; p++){
              if(!taughtPSet.has(p)){
                gapSlots.push({ p, slot: sessionStart + p });
              }
            }

            if(gapSlots.length < 2) continue; // Only process sessions with gap >= 2

            // Look for lessons of the SAME teacher in other sessions to pull into this gap
            const donorLessons = [];
            for(let d2 = 0; d2 < DAYS; d2++){
              for(let b2 = 0; b2 < SESSIONS; b2++){
                if(d2 === d && b2 === b) continue;
                const sStart2 = d2 * 10 + b2 * 5;
                for(let p2 = 0; p2 < PERIODS; p2++){
                  const s2 = sStart2 + p2;
                  const actId2 = tGrid[s2];
                  if(actId2 >= 0){
                    const actDonor = this.activities[actId2];
                    if(actDonor && !actDonor.isFixed && actDonor.duration === 1){
                      donorLessons.push({ act: actDonor, srcSlot: s2, d: d2, b: b2 });
                    }
                  }
                }
              }
            }

            if(donorLessons.length === 0) continue;
            this.rng.shuffle(donorLessons);

            let gapFilled = false;
            for(const gapItem of gapSlots){
              const targetSlot = gapItem.slot;
              for(const donor of donorLessons){
                const actDonor = donor.act;
                const donorCGrid = this.classGrid.get(actDonor.classId);
                if(!donorCGrid) continue;
                if(this.actPlacement[actDonor.id] !== donor.srcSlot) continue; // freshness guard

                if(this.offSlots.has(`${actDonor.classId}|${targetSlot}`) || this.fixedSlots.has(`${actDonor.classId}|${targetSlot}`)) continue;

                const occupantActId = donorCGrid[targetSlot];
                if(occupantActId === -2 || occupantActId === -3) continue;

                if(occupantActId < 0){
                  // Direct empty slot in donor class
                  this.unplaceActivity(actDonor.id);
                  const r1 = this.getConflictsForSlot(actDonor, targetSlot);
                  if(r1.possible && r1.conflicts.length === 0){
                    this.placeActivityDirect(actDonor.id, targetSlot);
                    if(this.isLessonBlockSafe(actDonor) && this.isLessonBlockSafe()){
                      const m = this.evaluateMetrics();
                      if(this.compareMetrics(m, currentBest, "optimize_gap2") < 0){
                        currentBest = { ...m };
                        anyImproved = true;
                        gapFilled = true;
                        if(typeof onProgress === "function") onProgress(currentBest);
                        break;
                      }
                    }
                    this.unplaceActivity(actDonor.id);
                  }
                  this.placeActivityDirect(actDonor.id, donor.srcSlot);
                  continue;
                }

                // 2-Way Swap with occupant
                const actOccupant = this.activities[occupantActId];
                if(!actOccupant || actOccupant.isFixed || actOccupant.duration !== 1) continue;
                if(this.fixedSlots.has(`${actOccupant.classId}|${donor.srcSlot}`)) continue;

                const occTGrid = this.teacherGrid.get(actOccupant.gv);
                if(occTGrid && occTGrid[donor.srcSlot] < 0 && occTGrid[donor.srcSlot] !== -3){
                  this.unplaceActivity(actDonor.id);
                  this.unplaceActivity(actOccupant.id);

                  const r1 = this.getConflictsForSlot(actDonor, targetSlot);
                  const r2 = this.getConflictsForSlot(actOccupant, donor.srcSlot);

                  if(r1.possible && r1.conflicts.length === 0 && r2.possible && r2.conflicts.length === 0){
                    this.placeActivityDirect(actDonor.id, targetSlot);
                    this.placeActivityDirect(actOccupant.id, donor.srcSlot);

                    if(this.isLessonBlockSafe(actDonor, actOccupant) && this.isLessonBlockSafe()){
                      const m = this.evaluateMetrics();
                      if(this.compareMetrics(m, currentBest, "optimize_gap2") < 0){
                        currentBest = { ...m };
                        anyImproved = true;
                        gapFilled = true;
                        if(typeof onProgress === "function") onProgress(currentBest);
                        break;
                      }
                    }
                    this.unplaceActivity(actDonor.id);
                    this.unplaceActivity(actOccupant.id);
                  }
                  this.placeActivityDirect(actDonor.id, donor.srcSlot);
                  this.placeActivityDirect(actOccupant.id, targetSlot);
                }
                if(gapFilled) break;
              }
              if(gapFilled) break;
            }
          }
        }
      }
      return anyImproved ? currentBest : null;
    }

    // Double Block Gap-Filler (Spec: ANTIGRAVITY_KHU_2_TIET_TRONG.md De Xuat 4)
    // Swaps a 2-period paired lesson (duration === 2) into an exact 2-period gap
    tryMoveDoubleBlockIntoGap(bestMetrics, initialMetrics, onProgress = null){
      const DAYS = DAYS_LIST.length;
      const SESSIONS = SESSIONS_LIST.length;
      const PERIODS = PERIODS_PER_SESSION;
      let currentBest = { ...bestMetrics };
      let anyImproved = false;

      const teacherList = Array.from(this.teacherGrid.keys()).filter(t => t && this.isScoredTeacher(t));
      this.rng.shuffle(teacherList);

      for(const tKey of teacherList){
        const tGrid = this.teacherGrid.get(tKey);
        if(!tGrid) continue;

        for(let d = 0; d < DAYS; d++){
          for(let b = 0; b < SESSIONS; b++){
            const sessionStart = d * 10 + b * 5;
            const taught = [];
            for(let p = 0; p < PERIODS; p++){
              const s = sessionStart + p;
              if(tGrid[s] >= 0 || tGrid[s] === -3){
                taught.push({ slot: s, actId: tGrid[s], p });
              }
            }

            const k = taught.length;
            if(k < 2) continue;

            for(let i = 0; i < k - 1; i++){
              const g = taught[i + 1].p - taught[i].p - 1;
              if(g !== 2) continue;

              const gapStartP = taught[i].p + 1;
              const slotGap1 = sessionStart + gapStartP;
              const slotGap2 = sessionStart + gapStartP + 1;

              const doubleBlocks = [];
              this.activities.forEach(act => {
                if(act.duration === 2 && !act.isFixed){
                  const curSlot = this.actPlacement[act.id];
                  if(curSlot >= 0 && curSlot !== slotGap1){
                    doubleBlocks.push({ act, curSlot });
                  }
                }
              });

              this.rng.shuffle(doubleBlocks);

              let blockResolved = false;
              for(const candidate of doubleBlocks.slice(0, 15)){
                const actD = candidate.act;
                const srcSlot = candidate.curSlot;
                const cGridD = this.classGrid.get(actD.classId);
                if(!cGridD) continue;
                if(this.actPlacement[actD.id] !== srcSlot) continue; // freshness guard

                if(this.offSlots.has(`${actD.classId}|${slotGap1}`) || this.offSlots.has(`${actD.classId}|${slotGap2}`)) continue;
                if(this.fixedSlots.has(`${actD.classId}|${slotGap1}`) || this.fixedSlots.has(`${actD.classId}|${slotGap2}`)) continue;

                const occ1Id = cGridD[slotGap1];
                const occ2Id = cGridD[slotGap2];

                if(occ1Id === -2 || occ1Id === -3 || occ2Id === -2 || occ2Id === -3) continue;

                if(occ1Id < 0 && occ2Id < 0){
                  // Direct move into empty double slot
                  this.unplaceActivity(actD.id);
                  const r1 = this.getConflictsForSlot(actD, slotGap1);
                  if(r1.possible && r1.conflicts.length === 0){
                    this.placeActivityDirect(actD.id, slotGap1);
                    if(this.isLessonBlockSafe(actD) && this.isLessonBlockSafe()){
                      const m = this.evaluateMetrics();
                      if(this.compareMetrics(m, currentBest, "optimize_gap2") < 0){
                        currentBest = { ...m };
                        anyImproved = true;
                        blockResolved = true;
                        if(typeof onProgress === "function") onProgress(currentBest);
                        break;
                      }
                    }
                    this.unplaceActivity(actD.id);
                  }
                  this.placeActivityDirect(actD.id, srcSlot);
                }else if(occ1Id >= 0 && occ2Id >= 0 && occ1Id === occ2Id){
                  // Swap with another 2-period block
                  const actOcc = this.activities[occ1Id];
                  if(!actOcc || actOcc.isFixed || actOcc.duration !== 2) continue;

                  this.unplaceActivity(actD.id);
                  this.unplaceActivity(actOcc.id);

                  const r1 = this.getConflictsForSlot(actD, slotGap1);
                  const r2 = this.getConflictsForSlot(actOcc, srcSlot);

                  if(r1.possible && r1.conflicts.length === 0 && r2.possible && r2.conflicts.length === 0){
                    this.placeActivityDirect(actD.id, slotGap1);
                    this.placeActivityDirect(actOcc.id, srcSlot);

                    if(this.isLessonBlockSafe(actD, actOcc) && this.isLessonBlockSafe()){
                      const m = this.evaluateMetrics();
                      if(this.compareMetrics(m, currentBest, "optimize_gap2") < 0){
                        currentBest = { ...m };
                        anyImproved = true;
                        blockResolved = true;
                        if(typeof onProgress === "function") onProgress(currentBest);
                        break;
                      }
                    }
                    this.unplaceActivity(actD.id);
                    this.unplaceActivity(actOcc.id);
                  }
                  this.placeActivityDirect(actD.id, srcSlot);
                  this.placeActivityDirect(actOcc.id, slotGap1);
                }
                if(blockResolved) break;
              }
              if(blockResolved) break;
            }
          }
        }
      }
      return anyImproved ? currentBest : null;
    }

    // Residual 2-Period Gap Classifier (Spec: ANTIGRAVITY_KHU_2_TIET_TRONG.md De Xuat 6)
    getResidualGap2Sessions(){
      const residuals = [];
      this.teacherGrid.forEach((grid, tKey) => {
        if(!tKey) return;
        for(let d = 0; d < DAYS_LIST.length; d++){
          for(let b = 0; b < SESSIONS_LIST.length; b++){
            const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
            const taught = [];
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const s = sStart + p;
              if(grid[s] >= 0 || grid[s] === -3) taught.push({ slot: s, p, actId: grid[s] });
            }
            if(taught.length < 2) continue;
            const span = taught[taught.length - 1].p - taught[0].p + 1;
            if(span - taught.length < 2) continue;

            const movable = taught.filter(t => t.actId >= 0 && !this.activities[t.actId].isFixed && this.activities[t.actId].duration === 1);
            let reason = "algorithm-not-yet-resolved";
            if(movable.length === 0) reason = "duration-locked";
            else {
              const classIds = taught.map(t => t.actId >= 0 ? this.activities[t.actId]?.classId : null).filter(Boolean);
              if(classIds.some(cid => this.offSlots.has(`${cid}|${sStart}`))) reason = "class-fixed-halfday-shift";
            }
            residuals.push({ teacher: tKey, day: DAYS_LIST[d], session: SESSIONS_LIST[b], reason });
          }
        }
      });
      return residuals;
    }

    // Standardized Multi-Objective Metric Comparator (Mode-Aware Pareto Optimization)
    // =========================================================================
    // GAP RELABEL CYCLES (học từ pipeline tham chiếu, diff base->1/2/3)
    // Quan sát: 100% nước khử gap2 của công cụ tham chiếu là "replace" — không
    // dùng ô trống, không đổi hình dạng lịch lớp; chỉ hoán vị nhãn tiết giữa
    // các Ô ĐÃ CHIẾM của từng lớp theo chuỗi đẩy khép vòng (ejection cycle).
    // Operator này tái tạo đúng nước đi đó: với mỗi buổi gap của giáo viên t,
    // thử dời tiết biên của t vào một lỗ trong buổi; ô đích đang bị chiếm bởi
    // tiết khác cùng lớp -> tiết đó đẩy sang một ô đã chiếm khác của lớp mà
    // giáo viên của nó rảnh… khép vòng khi một tiết đáp xuống ô vừa được t
    // giải phóng. Lịch lớp giữ nguyên tuyệt đối; chỉ lịch giáo viên đổi.
    // =========================================================================
    tryGapRelabelCycles(bestMetrics, initialMetrics, mode = "optimize_gap2", onProgress = null){
      const PERIODS = PERIODS_PER_SESSION;
      let currentBest = { ...bestMetrics };
      let anyImproved = false;
      const MAX_DEPTH = 7;

      const teacherList = Array.from(this.teacherGrid.keys()).filter(t => t && this.isScoredTeacher(t));
      this.rng.shuffle(teacherList);

      for(const tKey of teacherList){
        const tGrid = this.teacherGrid.get(tKey);
        if(!tGrid) continue;

        for(let d = 0; d < DAYS_LIST.length; d++){
          for(let b = 0; b < SESSIONS_LIST.length; b++){
            const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
            const idx = [];
            for(let p = 0; p < PERIODS; p++){
              if(tGrid[sStart + p] >= 0 || tGrid[sStart + p] === -3) idx.push(p);
            }
            if(idx.length < 2) continue;
            const holes = (idx[idx.length - 1] - idx[0] + 1) - idx.length;
            const isTarget = mode === "optimize_gap1" ? holes === 1 : holes >= 2;
            if(!isTarget) continue;

            // Goal moves: dời tiết BIÊN của t vào một lỗ bên trong span.
            const holePs = [];
            for(let p = idx[0] + 1; p < idx[idx.length - 1]; p++){
              if(tGrid[sStart + p] < 0 && tGrid[sStart + p] !== -3) holePs.push(p);
            }
            if(holePs.length === 0) continue;
            const edgeSlots = [sStart + idx[0], sStart + idx[idx.length - 1]];

            let resolved = false;
            for(const edgeSlot of edgeSlots){
              const rootActId = tGrid[edgeSlot];
              if(rootActId < 0) continue;
              const rootAct = this.activities[rootActId];
              if(!rootAct || rootAct.isFixed || rootAct.duration !== 1) continue;
              const cid = rootAct.classId;
              const cGrid = this.classGrid.get(cid);
              if(!cGrid) continue;

              for(const hp of holePs){
                const targetSlot = sStart + hp;
                if(this.offSlots.has(`${cid}|${targetSlot}`) || this.fixedSlots.has(`${cid}|${targetSlot}`)) continue;

                // Chuỗi đẩy: mỗi phần tử {actId, fromSlot, toSlot} — tất cả cùng lớp cid.
                const chain = [{ actId: rootActId, fromSlot: edgeSlot, toSlot: targetSlot }];
                const usedSlots = new Set([edgeSlot, targetSlot]);
                let closed = false;

                const displacedId = cGrid[targetSlot];
                if(displacedId === -3 || displacedId === -2) continue;
                if(displacedId < 0){
                  // Ô lớp trống thật: nước dời trực tiếp, không cần vòng.
                  closed = true;
                }else{
                  // DFS tìm chỗ mới cho tiết bị đè, chỉ trong Ô ĐÃ CHIẾM của lớp.
                  const dfs = (dispId, depth) => {
                    if(depth > MAX_DEPTH) return false;
                    const dispAct = this.activities[dispId];
                    if(!dispAct || dispAct.isFixed || dispAct.duration !== 1) return false;
                    const dispTeachers = parseTeacherList(dispAct.gv);
                    // Ưu tiên khép vòng: đáp xuống ô gốc vừa giải phóng.
                    const landing = [];
                    landing.push(edgeSlot);
                    for(let s = 0; s < TOTAL_SLOTS; s++){
                      if(s === edgeSlot) continue;
                      if(cGrid[s] >= 0 && !usedSlots.has(s)) landing.push(s);
                    }
                    for(const to of landing){
                      if(this.offSlots.has(`${cid}|${to}`) || this.fixedSlots.has(`${cid}|${to}`)) continue;
                      // Giáo viên của tiết bị đè phải rảnh ở ô đích (bỏ qua các tiết đang trong chuỗi).
                      let free = true;
                      for(const dt of dispTeachers){
                        const dtg = this.teacherGrid.get(dt);
                        if(!dtg) continue;
                        const occ = dtg[to];
                        if(occ === -2 || occ === -3){ free = false; break; }
                        if(occ >= 0 && !chain.some(c => c.actId === occ) && occ !== dispId){ free = false; break; }
                      }
                      if(!free) continue;
                      if(to === edgeSlot){
                        chain.push({ actId: dispId, fromSlot: this.actPlacement[dispId], toSlot: to });
                        return true; // vòng khép
                      }
                      const nextDisp = cGrid[to];
                      if(nextDisp < 0) continue; // chỉ đi qua ô đã chiếm (bảo toàn hình dạng lớp)
                      chain.push({ actId: dispId, fromSlot: this.actPlacement[dispId], toSlot: to });
                      usedSlots.add(to);
                      if(dfs(nextDisp, depth + 1)) return true;
                      chain.pop();
                      usedSlots.delete(to);
                    }
                    return false;
                  };
                  closed = dfs(displacedId, 1);
                }

                if(!closed) continue;

                // Commit chuỗi: unplace tất cả rồi place theo toSlot, kiểm tra đầy đủ.
                const snap = this.captureStateSnapshot();
                let ok = true;
                for(const step of chain) this.unplaceActivity(step.actId);
                for(const step of chain){
                  const r = this.getConflictsForSlot(this.activities[step.actId], step.toSlot);
                  if(!r.possible || r.conflicts.length > 0){ ok = false; break; }
                  this.placeActivityDirect(step.actId, step.toSlot);
                }
                if(ok && this.isLessonBlockSafe(...chain.map(c => this.activities[c.actId])) && this.isLessonBlockSafe()){
                  const m = this.evaluateMetrics();
                  if(this.compareMetrics(m, currentBest, mode) < 0){
                    currentBest = { ...m };
                    anyImproved = true;
                    resolved = true;
                    if(typeof onProgress === "function") onProgress(currentBest);
                  }else{
                    ok = false;
                  }
                }else{
                  ok = false;
                }
                if(!ok) this.restoreStateSnapshot(snap);
                if(resolved) break;
              }
              if(resolved) break;
            }
          }
        }
      }
      return anyImproved ? currentBest : null;
    }

    // =========================================================================
    // DISSOLVE THIN GAP SESSION (ý tưởng chủ dự án + triết lý FET eject-replace)
    // "Tách các tiết của buổi trống-2 đáp vào buổi KHÁC, nhưng không được hình
    // thành buổi mới": dời toàn bộ tiết của một buổi gap mỏng (≤3 tiết di động)
    // vào các buổi ĐÃ TỒN TẠI khác của chính giáo viên đó — ưu tiên lấp lỗ /
    // nối mép. Thành công thì buổi kẹt biến mất: gap2 giảm VÀ tổng buổi giảm.
    // =========================================================================
    tryDissolveGapSession(bestMetrics, initialMetrics, mode = "optimize_gap2", onProgress = null){
      const PERIODS = PERIODS_PER_SESSION;
      let currentBest = { ...bestMetrics };
      let anyImproved = false;

      const teacherList = Array.from(this.teacherGrid.keys()).filter(t => t && this.isScoredTeacher(t));
      this.rng.shuffle(teacherList);

      for(const tKey of teacherList){
        const tGrid = this.teacherGrid.get(tKey);
        if(!tGrid) continue;

        // Danh sách buổi đang hoạt động của giáo viên (tính lại mỗi lần dùng).
        const activeSessions = () => {
          const out = [];
          for(let d = 0; d < DAYS_LIST.length; d++){
            for(let b = 0; b < SESSIONS_LIST.length; b++){
              const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
              const ps = [];
              for(let p = 0; p < PERIODS; p++){
                if(tGrid[sStart + p] >= 0 || tGrid[sStart + p] === -3) ps.push(p);
              }
              if(ps.length) out.push({ d, b, sStart, ps });
            }
          }
          return out;
        };

        for(let d = 0; d < DAYS_LIST.length; d++){
          for(let b = 0; b < SESSIONS_LIST.length; b++){
            const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
            const cells = [];
            let blocked = false;
            for(let p = 0; p < PERIODS; p++){
              const v = tGrid[sStart + p];
              if(v === -3){ blocked = true; break; } // tiết cố định: không giải thể
              if(v >= 0){
                const act = this.activities[v];
                if(!act || act.isFixed || act.duration !== 1){ blocked = true; break; }
                cells.push({ act, slot: sStart + p, p });
              }
            }
            if(blocked || cells.length < 2 || cells.length > 3) continue;
            const holes = (cells[cells.length - 1].p - cells[0].p + 1) - cells.length;
            const isTarget = mode === "optimize_gap1" ? holes === 1 : holes >= 2;
            if(!isTarget) continue;

            const snap = this.captureStateSnapshot();
            let ok = true;

            for(const item of cells){
              if(this.actPlacement[item.act.id] !== item.slot){ ok = false; break; }
              let placed = false;
              // Ứng viên: các buổi khác ĐANG tồn tại của t — chấm điểm lấp-lỗ trước, nối-mép sau.
              const sessions = activeSessions().filter(s => !(s.d === d && s.b === b));
              const cands = [];
              for(const S2 of sessions){
                const lo = S2.ps[0], hi = S2.ps[S2.ps.length - 1];
                for(let p2 = 0; p2 < PERIODS; p2++){
                  const s2 = S2.sStart + p2;
                  if(tGrid[s2] >= 0 || tGrid[s2] === -3 || tGrid[s2] === -2) continue;
                  let score = 2;
                  if(p2 > lo && p2 < hi) score = 0;        // lấp lỗ của buổi đích
                  else if(p2 === lo - 1 || p2 === hi + 1) score = 1; // nối mép
                  else continue;                            // vị trí tách rời: cấm (sẽ tạo lỗ mới)
                  cands.push({ s2, score });
                }
              }
              cands.sort((x, y) => x.score - y.score);
              for(const cand of cands){
                const cid = item.act.classId;
                if(this.offSlots.has(`${cid}|${cand.s2}`) || this.fixedSlots.has(`${cid}|${cand.s2}`)) continue;
                const cGrid = this.classGrid.get(cid);
                if(!cGrid) continue;
                this.unplaceActivity(item.act.id);
                if(cGrid[cand.s2] < 0 && cGrid[cand.s2] !== -2 && cGrid[cand.s2] !== -3){
                  const r = this.getConflictsForSlot(item.act, cand.s2);
                  if(r.possible && r.conflicts.length === 0){
                    this.placeActivityDirect(item.act.id, cand.s2);
                    placed = true;
                    break;
                  }
                }
                this.placeActivityDirect(item.act.id, item.slot);
              }
              if(!placed && cands.length){
                // Đòn mạnh: đặt-có-trục-xuất vào các vị trí lấp-lỗ/nối-mép đó —
                // tiết đang chắn bị nhấc ra và tự tìm chỗ mới (recursive swapping).
                const slots = cands.map(c => c.s2);
                const savedCalls = this.limitCalls;
                this.limitCalls = Math.max(this.limitCalls || 0, 4000);
                this.nCalls = 0;
                this.unplaceActivity(item.act.id);
                if(this.randomSwap(item.act.id, 0, slots)){
                  placed = true;
                }else{
                  this.placeActivityDirect(item.act.id, item.slot);
                }
                this.limitCalls = savedCalls;
              }
              if(!placed){ ok = false; break; }
            }

            if(ok && this.isLessonBlockSafe(...cells.map(c => c.act)) && this.isLessonBlockSafe()){
              const m = this.evaluateMetrics();
              if(this.compareMetrics(m, currentBest, mode) < 0){
                currentBest = { ...m };
                anyImproved = true;
                if(typeof onProgress === "function") onProgress(currentBest);
                continue;
              }
            }
            this.restoreStateSnapshot(snap);
          }
        }
      }
      return anyImproved ? currentBest : null;
    }

    // =========================================================================
    // EJECT-PLACE INTO GAP (đòn FET nguyên bản, nhắm thẳng vào lỗ)
    // Với các ca gap2 cứng đầu: chọn một tiết biên di động của giáo viên và
    // ÉP đặt nó vào đúng lỗ bằng recursive swapping — tiết nào đang cản sẽ bị
    // nhấc ra và tự tìm chỗ mới (đệ quy sâu tới 16 bậc, moveJournal đảm bảo
    // hoàn tác chính xác). Chấp nhận theo tuple; thất bại khôi phục snapshot.
    // =========================================================================
    tryEjectPlaceIntoGap(bestMetrics, initialMetrics, mode = "optimize_gap2", onProgress = null){
      const PERIODS = PERIODS_PER_SESSION;
      let currentBest = { ...bestMetrics };
      let anyImproved = false;

      const teacherList = Array.from(this.teacherGrid.keys()).filter(t => t && this.isScoredTeacher(t));
      this.rng.shuffle(teacherList);

      for(const tKey of teacherList){
        const tGrid = this.teacherGrid.get(tKey);
        if(!tGrid) continue;

        for(let d = 0; d < DAYS_LIST.length; d++){
          for(let b = 0; b < SESSIONS_LIST.length; b++){
            const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
            const idx = [];
            for(let p = 0; p < PERIODS; p++){
              if(tGrid[sStart + p] >= 0 || tGrid[sStart + p] === -3) idx.push(p);
            }
            if(idx.length < 2) continue;
            const holes = (idx[idx.length - 1] - idx[0] + 1) - idx.length;
            const isTarget = mode === "optimize_gap1" ? holes === 1 : holes >= 2;
            if(!isTarget) continue;

            const holeSlots = [];
            for(let p = idx[0] + 1; p < idx[idx.length - 1]; p++){
              const sl = sStart + p;
              if(tGrid[sl] < 0 && tGrid[sl] !== -3 && tGrid[sl] !== -2) holeSlots.push(sl);
            }
            if(!holeSlots.length) continue;

            // Ứng viên bị ép dời: các tiết BIÊN di động của chính giáo viên này.
            const movers = [];
            const firstSlot = sStart + idx[0];
            const lastSlot = sStart + idx[idx.length - 1];
            for(const sl of [firstSlot, lastSlot]){
              const aid = tGrid[sl];
              if(aid >= 0){
                const act = this.activities[aid];
                if(act && !act.isFixed && act.duration === 1) movers.push(aid);
              }
            }
            if(!movers.length) continue;

            let resolved = false;
            for(const moverId of movers){
              const snap = this.captureStateSnapshot();
              const savedCalls = this.limitCalls;
              this.limitCalls = Math.max(this.limitCalls, 4000);
              this.nCalls = 0;
              this.unplaceActivity(moverId);
              const ok = this.randomSwap(moverId, 0, holeSlots);
              this.limitCalls = savedCalls;
              if(ok){
                const m = this.evaluateMetrics();
                if(this.compareMetrics(m, currentBest, mode) < 0 && this.verifyPlacementIntegrity()){
                  currentBest = { ...m };
                  anyImproved = true;
                  resolved = true;
                  if(typeof onProgress === "function") onProgress(currentBest);
                  break;
                }
              }
              this.restoreStateSnapshot(snap);
            }
            if(resolved) continue;
          }
        }
      }
      return anyImproved ? currentBest : null;
    }

    // =========================================================================
    // RELOCATE GAP SESSION TO A NEW HALF-DAY (nới lỏng do người dùng chốt 17/08)
    // Ca gap2 kẹt cấu trúc: mọi lỗ trong span đều bị tiết lớp khác chắn và mọi
    // chuỗi dời đều đẩy gap sang giáo viên khác. Hướng xử lý người dùng đưa ra:
    // "lấy tiết lẻ ghép vào 2 chỗ trống HOẶC đưa qua 1 buổi mới". Operator này
    // thực hiện vế hai: bốc TRỌN buổi gap2 (2-3 tiết, kể cả khối tiết đôi) sang
    // một nửa-ngày giáo viên đang trống hoàn toàn, đặt các tiết LIỀN NHAU.
    //  - Không bao giờ tạo buổi 1 tiết (cả cụm >=2 tiết đi cùng nhau).
    //  - Trung hòa tổng buổi: đóng 1 buổi cũ, mở 1 buổi mới (không cần budget).
    //  - Ô lớp bị chắn tại điểm đáp -> ép bằng recursive swapping (restrictSlots
    //    đúng 1 ô), snapshot + integrity gate bảo vệ toàn cục.
    //  - Ưu tiên đáp: cùng ngày khác buổi > ngày đã có dạy > ngày trống hẳn
    //    (hạn chế tăng tsNgayDay — chìa khóa cuối của tuple).
    // =========================================================================
    tryRelocateGapSessionToNewDay(bestMetrics, initialMetrics, mode = "optimize_gap2", onProgress = null){
      const PERIODS = PERIODS_PER_SESSION;
      let currentBest = { ...bestMetrics };
      let anyImproved = false;

      const teacherList = Array.from(this.teacherGrid.keys()).filter(t => t && this.isScoredTeacher(t));
      this.rng.shuffle(teacherList);

      for(const tKey of teacherList){
        const tGrid = this.teacherGrid.get(tKey);
        if(!tGrid) continue;

        for(let d = 0; d < DAYS_LIST.length; d++){
          for(let b = 0; b < SESSIONS_LIST.length; b++){
            const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
            const items = [];
            const coveredPs = [];
            let blocked = false;
            for(let p = 0; p < PERIODS; p++){
              const v = tGrid[sStart + p];
              if(v === -3){ blocked = true; break; } // tiết cố định: không dời
              if(v >= 0){
                const act = this.activities[v];
                if(!act || act.isFixed){ blocked = true; break; }
                coveredPs.push(p);
                if(this.actPlacement[act.id] === sStart + p){
                  items.push({ act, slot: sStart + p });
                }
              }
            }
            if(blocked || items.length === 0) continue;
            const holes = (coveredPs[coveredPs.length - 1] - coveredPs[0] + 1) - coveredPs.length;
            const isTarget = mode === "optimize_gap1" ? holes === 1 : holes >= 2;
            if(!isTarget) continue;
            const totalCells = items.reduce((s, it) => s + (it.act.duration || 1), 0);
            if(totalCells !== coveredPs.length || totalCells < 2 || totalCells > PERIODS) continue;

            // Nửa-ngày ứng viên: giáo viên trống HOÀN TOÀN (buổi mới đúng nghĩa).
            const cands = [];
            for(let d2 = 0; d2 < DAYS_LIST.length; d2++){
              let dayActive = false;
              for(let b3 = 0; b3 < SESSIONS_LIST.length; b3++){
                const st = d2 * SLOTS_PER_DAY + b3 * PERIODS_PER_SESSION;
                for(let p = 0; p < PERIODS; p++){
                  if(tGrid[st + p] >= 0 || tGrid[st + p] === -3){ dayActive = true; break; }
                }
                if(dayActive) break;
              }
              for(let b2 = 0; b2 < SESSIONS_LIST.length; b2++){
                if(d2 === d && b2 === b) continue;
                const s2Start = d2 * SLOTS_PER_DAY + b2 * PERIODS_PER_SESSION;
                let usable = true;
                let active = false;
                for(let p = 0; p < PERIODS; p++){
                  const v = tGrid[s2Start + p];
                  if(v >= 0 || v === -3){ active = true; break; }
                }
                if(active) continue; // buổi đã có dạy: đường này thuộc dissolve
                // Cần ít nhất một cửa sổ liền totalCells ô không dính OFF giáo viên
                let bestWindows = [];
                for(let startP = 0; startP + totalCells <= PERIODS; startP++){
                  let winOk = true;
                  for(let p = startP; p < startP + totalCells; p++){
                    if(tGrid[s2Start + p] === -2){ winOk = false; break; }
                  }
                  if(winOk) bestWindows.push(startP);
                }
                if(!bestWindows.length) usable = false;
                if(!usable) continue;
                const score = (d2 === d) ? 0 : (dayActive ? 1 : 2);
                cands.push({ s2Start, score, windows: bestWindows });
              }
            }
            this.rng.shuffle(cands);
            cands.sort((x, y) => x.score - y.score); // stable: ngẫu nhiên trong cùng bậc ưu tiên

            // Hoán vị thứ tự tiết (≤3 phần tử → ≤6 hoán vị): lớp nào đáp ô nào
            // quyết định qua được classOFF/fixed hay không.
            const perms = [];
            const permute = (arr, cur) => {
              if(!arr.length){ perms.push(cur); return; }
              for(let i = 0; i < arr.length; i++){
                permute(arr.slice(0, i).concat(arr.slice(i + 1)), cur.concat([arr[i]]));
              }
            };
            permute(items, []);

            let resolved = false;
            for(const cand of cands){
              for(const startP of cand.windows){
                for(const ordered of perms){
                const snap = this.captureStateSnapshot();
                let ok = true;
                for(const it of ordered){
                  if(this.actPlacement[it.act.id] !== it.slot){ ok = false; break; }
                }
                if(ok){
                  for(const it of ordered) this.unplaceActivity(it.act.id);
                  let p2 = startP;
                  for(const it of ordered){
                    const targetSlot = cand.s2Start + p2;
                    const dur = it.act.duration || 1;
                    const cid = it.act.classId;
                    let cellOk = true;
                    for(let k = 0; k < dur; k++){
                      const s3 = targetSlot + k;
                      if(this.offSlots.has(`${cid}|${s3}`) || this.fixedSlots.has(`${cid}|${s3}`)){ cellOk = false; break; }
                    }
                    if(!cellOk){ ok = false; break; }
                    const r = this.getConflictsForSlot(it.act, targetSlot);
                    if(r.possible && r.conflicts.length === 0){
                      this.placeActivityDirect(it.act.id, targetSlot);
                    }else if(r.possible){
                      // Ô lớp bị chắn: ép đáp đúng ô này, tiết chắn tự tìm chỗ mới.
                      const savedCalls = this.limitCalls;
                      this.limitCalls = Math.max(this.limitCalls || 0, 20000);
                      this.nCalls = 0;
                      const forced = this.randomSwap(it.act.id, 0, [targetSlot]);
                      this.limitCalls = savedCalls;
                      if(!forced){ ok = false; break; }
                    }else{
                      ok = false; break;
                    }
                    p2 += dur;
                  }
                }
                if(ok && this.isLessonBlockSafe(...items.map(it => it.act)) && this.isLessonBlockSafe()){
                  const m = this.evaluateMetrics();
                  if(this.compareMetrics(m, currentBest, mode) < 0){
                    currentBest = { ...m };
                    anyImproved = true;
                    resolved = true;
                    if(typeof onProgress === "function") onProgress(currentBest);
                    break;
                  }
                }
                this.restoreStateSnapshot(snap);
                }
                if(resolved) break;
              }
              if(resolved) break;
            }

            // ---- TẦNG B: "đưa TIẾT LẺ qua buổi mới" (đúng chữ người dùng) ----
            // Dời cả buổi thất bại → bốc RIÊNG tiết lẻ (mép; phần còn lại phải
            // liền mạch >=2 tiết) + một tiết bạn đồng hành mượn từ mép buổi khác,
            // mở buổi mới 2 tiết LIỀN NHAU. Tốn +1 buổi — nằm trong hàng rào
            // ngân sách gap2 (compareMetrics tự kiểm), không bao giờ sinh 1t/buổi.
            if(!resolved && mode === "optimize_gap2" && items.length >= 2 && totalCells >= 3){
              const oddCands = [];
              for(const pick of [items[0], items[items.length - 1]]){
                if((pick.act.duration || 1) !== 1) continue;
                // các p còn lại sau khi bỏ tiết lẻ phải liền mạch và >=2
                const restPs = coveredPs.filter(p => tGrid[sStart + p] !== pick.act.id);
                if(restPs.length < 2) continue;
                if((restPs[restPs.length - 1] - restPs[0] + 1) !== restPs.length) continue; // phải liền mạch
                oddCands.push(pick);
              }
              const companions = [];
              for(let d3 = 0; d3 < DAYS_LIST.length; d3++){
                for(let b3 = 0; b3 < SESSIONS_LIST.length; b3++){
                  if(d3 === d && b3 === b) continue;
                  const s3Start = d3 * SLOTS_PER_DAY + b3 * PERIODS_PER_SESSION;
                  const ps3 = [];
                  let cellCount = 0;
                  for(let p = 0; p < PERIODS; p++){
                    const v = tGrid[s3Start + p];
                    if(v >= 0 || v === -3){ ps3.push(p); cellCount++; }
                  }
                  if(cellCount < 3) continue; // buổi nguồn phải còn >=2 tiết sau khi cho mượn
                  for(const p of [ps3[0], ps3[ps3.length - 1]]){
                    const v = tGrid[s3Start + p];
                    if(v < 0) continue;
                    const a = this.activities[v];
                    if(a && !a.isFixed && a.duration === 1 && this.actPlacement[a.id] === s3Start + p){
                      companions.push({ act: a, slot: s3Start + p });
                    }
                  }
                }
              }
              this.rng.shuffle(companions);
              for(const odd of oddCands){
                for(const comp of companions.slice(0, 8)){
                  if(resolved) break;
                  for(const cand of cands){
                    if(resolved) break;
                    for(let sp = 0; sp + 2 <= PERIODS; sp++){
                      if(tGrid[cand.s2Start + sp] === -2 || tGrid[cand.s2Start + sp + 1] === -2) continue;
                      for(const pair of [[odd, comp], [comp, odd]]){
                        const snap = this.captureStateSnapshot();
                        let ok = this.actPlacement[odd.act.id] === odd.slot && this.actPlacement[comp.act.id] === comp.slot;
                        if(ok){
                          this.unplaceActivity(odd.act.id);
                          this.unplaceActivity(comp.act.id);
                          for(let i = 0; i < 2 && ok; i++){
                            const it = pair[i];
                            const targetSlot = cand.s2Start + sp + i;
                            const cid = it.act.classId;
                            if(this.offSlots.has(`${cid}|${targetSlot}`) || this.fixedSlots.has(`${cid}|${targetSlot}`)){ ok = false; break; }
                            const r = this.getConflictsForSlot(it.act, targetSlot);
                            if(r.possible && r.conflicts.length === 0){
                              this.placeActivityDirect(it.act.id, targetSlot);
                            }else if(r.possible){
                              const savedCalls = this.limitCalls;
                              this.limitCalls = Math.max(this.limitCalls || 0, 20000);
                              this.nCalls = 0;
                              const forced = this.randomSwap(it.act.id, 0, [targetSlot]);
                              this.limitCalls = savedCalls;
                              if(!forced) ok = false;
                            }else{
                              ok = false;
                            }
                          }
                        }
                        if(ok && this.isLessonBlockSafe(odd.act, comp.act) && this.isLessonBlockSafe()){
                          const m = this.evaluateMetrics();
                          if(this.compareMetrics(m, currentBest, mode) < 0){
                            currentBest = { ...m };
                            anyImproved = true;
                            resolved = true;
                            if(typeof onProgress === "function") onProgress(currentBest);
                            break;
                          }
                        }
                        this.restoreStateSnapshot(snap);
                      }
                      if(resolved) break;
                    }
                  }
                }
                if(resolved) break;
              }
            }
          }
        }
      }
      return anyImproved ? currentBest : null;
    }

    // =========================================================================
    // MERGE DONOR SESSION INTO GAP HOLES (vế MỘT của hướng người dùng 17/08:
    // "lấy tiết lẻ ghép vào 2 chỗ trống"). Nghịch đảo của dissolve: thay vì bốc
    // tiết của buổi trống đi nơi khác, KÉO NGUYÊN một buổi mỏng khác (2-3 tiết)
    // của chính giáo viên về đáp vào các LỖ trong span — một giao dịch nguyên tử.
    // Vì sao cần: ca [1,5] có 3 lỗ — lấp 1 lỗ vẫn là gap2 nên nước đơn lẻ bị
    // gate loại; phải lấp >=2 lỗ CÙNG LÚC mới đổi hạng. Buổi hiến tan biến →
    // tổng buổi -1, gap2 -1: thắng kép. Tầng 2: mượn CẶP TIẾT MÉP từ buổi dày
    // (>=4 tiết) khi không có buổi mỏng phù hợp (tổng buổi giữ nguyên).
    // =========================================================================
    tryMergeSessionIntoGaps(bestMetrics, initialMetrics, mode = "optimize_gap2", onProgress = null){
      const PERIODS = PERIODS_PER_SESSION;
      let currentBest = { ...bestMetrics };
      let anyImproved = false;

      const teacherList = Array.from(this.teacherGrid.keys()).filter(t => t && this.isScoredTeacher(t));
      this.rng.shuffle(teacherList);

      const kCombos = (arr, k) => {
        const out = [];
        const rec = (start, cur) => {
          if(cur.length === k){ out.push(cur.slice()); return; }
          for(let i = start; i < arr.length; i++){ cur.push(arr[i]); rec(i + 1, cur); cur.pop(); }
        };
        rec(0, []);
        return out;
      };
      const permsOf = (arr) => {
        const out = [];
        const rec = (rest, cur) => {
          if(!rest.length){ out.push(cur); return; }
          for(let i = 0; i < rest.length; i++) rec(rest.slice(0, i).concat(rest.slice(i + 1)), cur.concat([rest[i]]));
        };
        rec(arr, []);
        return out;
      };

      for(const tKey of teacherList){
        const tGrid = this.teacherGrid.get(tKey);
        if(!tGrid) continue;

        for(let d = 0; d < DAYS_LIST.length; d++){
          for(let b = 0; b < SESSIONS_LIST.length; b++){
            const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
            const taughtPs = [];
            for(let p = 0; p < PERIODS; p++){
              if(tGrid[sStart + p] >= 0 || tGrid[sStart + p] === -3) taughtPs.push(p);
            }
            if(taughtPs.length < 2) continue;
            const holes = (taughtPs[taughtPs.length - 1] - taughtPs[0] + 1) - taughtPs.length;
            if(holes < 2) continue; // operator chuyên trị gap2

            // Lỗ LẤP ĐƯỢC: ô trống của giáo viên trong span, không phải OFF.
            const holeSlots = [];
            for(let p = taughtPs[0] + 1; p < taughtPs[taughtPs.length - 1]; p++){
              const v = tGrid[sStart + p];
              if(v < 0 && v !== -2 && v !== -3) holeSlots.push(sStart + p);
            }
            if(holeSlots.length < 2) continue;

            // ---- Gom donor ----
            const donors = [];
            for(let d2 = 0; d2 < DAYS_LIST.length; d2++){
              for(let b2 = 0; b2 < SESSIONS_LIST.length; b2++){
                if(d2 === d && b2 === b) continue;
                const s2Start = d2 * SLOTS_PER_DAY + b2 * PERIODS_PER_SESSION;
                const acts = [];
                const ps2 = [];
                let bad = false;
                for(let p = 0; p < PERIODS; p++){
                  const v = tGrid[s2Start + p];
                  if(v === -3){ bad = true; break; }
                  if(v >= 0){
                    const a = this.activities[v];
                    if(!a || a.isFixed || a.duration !== 1){ bad = true; break; }
                    acts.push({ act: a, slot: s2Start + p });
                    ps2.push(p);
                  }
                }
                if(bad || !acts.length) continue;
                if(acts.length >= 2 && acts.length <= Math.min(3, holeSlots.length)){
                  // Tầng 1: cả buổi mỏng làm donor → buổi này biến mất (tổng buổi -1)
                  const holes2 = (ps2[ps2.length - 1] - ps2[0] + 1) - ps2.length;
                  donors.push({ items: acts, tier: 0, donorGapBonus: holes2 >= 2 ? -1 : 0 });
                }else if(acts.length >= 4){
                  // Tầng 2: cặp tiết mép (2 tiết ngoài cùng một phía) — buổi còn >=2 tiết
                  donors.push({ items: [acts[0], acts[1]], tier: 1, donorGapBonus: 0 });
                  donors.push({ items: [acts[acts.length - 2], acts[acts.length - 1]], tier: 1, donorGapBonus: 0 });
                }
              }
            }
            if(!donors.length) continue;
            this.rng.shuffle(donors);
            donors.sort((x, y) => (x.tier - y.tier) || (x.donorGapBonus - y.donorGapBonus) || (x.items.length - y.items.length));

            let resolved = false;
            for(const donor of donors){
              const k = donor.items.length;
              const combos = kCombos(holeSlots, k);
              this.rng.shuffle(combos);
              let attempts = 0;
              for(const combo of combos){
                for(const ordered of permsOf(donor.items)){
                  if(attempts++ >= 12) break;
                  const snap = this.captureStateSnapshot();
                  let ok = true;
                  for(const it of ordered){
                    if(this.actPlacement[it.act.id] !== it.slot){ ok = false; break; }
                  }
                  if(ok){
                    for(const it of ordered) this.unplaceActivity(it.act.id);
                    for(let i = 0; i < ordered.length && ok; i++){
                      const it = ordered[i];
                      const targetSlot = combo[i];
                      const cid = it.act.classId;
                      if(this.offSlots.has(`${cid}|${targetSlot}`) || this.fixedSlots.has(`${cid}|${targetSlot}`)){ ok = false; break; }
                      const r = this.getConflictsForSlot(it.act, targetSlot);
                      if(r.possible && r.conflicts.length === 0){
                        this.placeActivityDirect(it.act.id, targetSlot);
                      }else if(r.possible){
                        const savedCalls = this.limitCalls;
                        this.limitCalls = Math.max(this.limitCalls || 0, 20000);
                        this.nCalls = 0;
                        const forced = this.randomSwap(it.act.id, 0, [targetSlot]);
                        this.limitCalls = savedCalls;
                        if(!forced) ok = false;
                      }else{
                        ok = false;
                      }
                    }
                  }
                  if(ok && this.isLessonBlockSafe(...donor.items.map(it => it.act)) && this.isLessonBlockSafe()){
                    const m = this.evaluateMetrics();
                    if(this.compareMetrics(m, currentBest, mode) < 0){
                      currentBest = { ...m };
                      anyImproved = true;
                      resolved = true;
                      if(typeof onProgress === "function") onProgress(currentBest);
                      break;
                    }
                  }
                  this.restoreStateSnapshot(snap);
                }
                if(resolved || attempts >= 12) break;
              }
              if(resolved) break;
            }
          }
        }
      }
      return anyImproved ? currentBest : null;
    }

    // =========================================================================
    // KEMPE CHAIN PERIOD-SWAP (FET/đồ thị: chuỗi Kempe giữa 2 tiết trong 1 buổi)
    // Nước "phẫu thuật" cho ca gap2 kẹt nhất: chọn (tiết biên pe, tiết lỗ ph)
    // của buổi kẹt, rồi HOÁN ĐỔI bài học giữa 2 cột tiết đó theo một chuỗi lớp
    // khép kín (đóng bao qua xung đột giáo viên). Đặc tính vàng:
    //  - Lịch mọi LỚP giữ nguyên độ phủ (2 ô đổi chỗ nội bộ) — không sinh lỗ lớp.
    //  - Mọi giáo viên liên đới chỉ xê dịch trong ĐÚNG buổi đó (không đổi
    //    ngày/buổi → tsBuoiDay, tsNgayDay bất biến) — nhiễu cực nhỏ, dễ qua gate.
    //  - Không cần recursive swapping, không may rủi: chuỗi tính đóng trước.
    // Đây chính là loại nước mà eject ngẫu nhiên không mô phỏng nổi khi kinh tế
    // buổi sáng/chiều đã bão hòa (mọi ô lớp đều kín).
    // =========================================================================
    tryKempeChainPeriodSwap(bestMetrics, initialMetrics, mode = "optimize_gap2", onProgress = null){
      const PERIODS = PERIODS_PER_SESSION;
      let currentBest = { ...bestMetrics };
      let anyImproved = false;

      const teacherList = Array.from(this.teacherGrid.keys()).filter(t => t && this.isScoredTeacher(t));
      this.rng.shuffle(teacherList);

      for(const tKey of teacherList){
        const tGrid = this.teacherGrid.get(tKey);
        if(!tGrid) continue;

        for(let d = 0; d < DAYS_LIST.length; d++){
          for(let b = 0; b < SESSIONS_LIST.length; b++){
            const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
            const taughtPs = [];
            for(let p = 0; p < PERIODS; p++){
              if(tGrid[sStart + p] >= 0 || tGrid[sStart + p] === -3) taughtPs.push(p);
            }
            if(taughtPs.length < 2) continue;
            const holes = (taughtPs[taughtPs.length - 1] - taughtPs[0] + 1) - taughtPs.length;
            const isTarget = mode === "optimize_gap1" ? holes === 1 : holes >= 2;
            if(!isTarget) continue;

            // (pe, ph): tiết biên di động × lỗ lấp được
            const edgePs = [];
            for(const p of [taughtPs[0], taughtPs[taughtPs.length - 1]]){
              const v = tGrid[sStart + p];
              if(v >= 0){
                const a = this.activities[v];
                if(a && !a.isFixed && a.duration === 1 && this.actPlacement[a.id] === sStart + p) edgePs.push(p);
              }
            }
            const holePs = [];
            for(let p = taughtPs[0] + 1; p < taughtPs[taughtPs.length - 1]; p++){
              const v = tGrid[sStart + p];
              if(v < 0 && v !== -2 && v !== -3) holePs.push(p);
            }
            if(!edgePs.length || !holePs.length) continue;

            let resolved = false;
            for(const pe of edgePs){
              for(const ph of holePs){
                const slotA = sStart + pe, slotB = sStart + ph;
                const rootId = tGrid[slotA];
                if(rootId < 0) continue;
                const rootAct = this.activities[rootId];
                if(!rootAct) continue;

                // ---- Đóng bao chuỗi Kempe trên cặp (slotA, slotB) ----
                const inChain = new Set([rootAct.classId]);
                const queue = [rootAct.classId];
                let chainOk = true;
                const lessonsAt = (cid, slot) => {
                  const cg = this.classGrid.get(cid);
                  if(!cg) return { bad: true };
                  const v = cg[slot];
                  if(v === -2 || v === -3) return { bad: true };          // ô OFF/cố định của lớp
                  if(v < 0) return { act: null };                          // ô trống thật
                  const a = this.activities[v];
                  if(!a || a.isFixed || a.duration !== 1) return { bad: true };
                  if(this.actPlacement[a.id] !== slot) return { bad: true }; // thân tiết đôi
                  return { act: a };
                };
                while(queue.length && chainOk){
                  const cid = queue.pop();
                  for(const slot of [slotA, slotB]){
                    const cell = lessonsAt(cid, slot);
                    if(cell.bad){ chainOk = false; break; }
                    if(!cell.act) continue;
                    const other = slot === slotA ? slotB : slotA;
                    const tk = cell.act.gv ? parseTeacherList(cell.act.gv) : [];
                    for(const oneT of tk){
                      const og = this.teacherGrid.get(oneT);
                      if(!og) continue;
                      const ov = og[other];
                      if(ov === -2 || ov === -3){ chainOk = false; break; } // GV kẹt cứng ở tiết kia
                      if(ov >= 0){
                        const oa = this.activities[ov];
                        if(!oa){ chainOk = false; break; }
                        if(!inChain.has(oa.classId)){
                          if(inChain.size >= 12){ chainOk = false; break; }
                          inChain.add(oa.classId);
                          queue.push(oa.classId);
                        }
                      }
                    }
                    if(!chainOk) break;
                  }
                }
                if(!chainOk) continue;

                // ---- Áp chuỗi: mỗi lớp trong bao hoán đổi bài giữa slotA/slotB ----
                const snap = this.captureStateSnapshot();
                const moves = [];
                let ok = true;
                for(const cid of inChain){
                  const a1 = lessonsAt(cid, slotA), a2 = lessonsAt(cid, slotB);
                  if(a1.bad || a2.bad){ ok = false; break; }
                  if(a1.act) moves.push({ act: a1.act, to: slotB });
                  if(a2.act) moves.push({ act: a2.act, to: slotA });
                }
                if(ok && moves.length){
                  for(const mv of moves) this.unplaceActivity(mv.act.id);
                  for(const mv of moves){
                    const r = this.getConflictsForSlot(mv.act, mv.to);
                    if(!r.possible || r.conflicts.length){ ok = false; break; }
                    this.placeActivityDirect(mv.act.id, mv.to);
                  }
                }else{
                  ok = false;
                }
                if(ok && this.isLessonBlockSafe(...moves.map(mv => mv.act)) && this.isLessonBlockSafe()){
                  const m = this.evaluateMetrics();
                  if(this.compareMetrics(m, currentBest, mode) < 0){
                    currentBest = { ...m };
                    anyImproved = true;
                    resolved = true;
                    if(typeof onProgress === "function") onProgress(currentBest);
                  }
                }
                if(!resolved) this.restoreStateSnapshot(snap);
                if(resolved) break;
              }
              if(resolved) break;
            }
          }
        }
      }
      return anyImproved ? currentBest : null;
    }

    
    // 3f. Intra-Session Cross-Class Chain & 3-Cycle Gap Crusher (Toi uu triet de gap2 khong tang buoi 1 tiet)
    tryIntraSessionCrossClassChain(bestMetrics, initialMetrics, mode = "optimize_gap2", onProgress = null){
      const PERIODS = PERIODS_PER_SESSION;
      let currentBest = { ...bestMetrics };
      let anyImproved = false;

      const teacherList = Array.from(this.teacherGrid.keys()).filter(t => t && this.isScoredTeacher(t));
      this.rng.shuffle(teacherList);

      const parseTeacherList = (gvStr) => {
        if(!gvStr) return [];
        return gvStr.split(",").map(s => s.trim()).filter(Boolean);
      };

      for(const tKey of teacherList){
        const tGrid = this.teacherGrid.get(tKey);
        if(!tGrid) continue;

        for(let d = 0; d < DAYS_LIST.length; d++){
          for(let b = 0; b < SESSIONS_LIST.length; b++){
            const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
            const taughtPs = [];
            for(let p = 0; p < PERIODS; p++){
              if(tGrid[sStart + p] >= 0 || tGrid[sStart + p] === -3) taughtPs.push(p);
            }
            if(taughtPs.length < 2) continue;
            const holes = (taughtPs[taughtPs.length - 1] - taughtPs[0] + 1) - taughtPs.length;
            const isTarget = mode === "optimize_gap1" ? holes === 1 : holes >= 2;
            if(!isTarget) continue;

            // Thu thap tat ca cac lop hoc trong buoi nay
            const sessionClasses = [];
            this.classGrid.forEach((cg, cid) => {
              if(!cid) return;
              let hasLesson = false;
              for(let p = 0; p < PERIODS; p++){
                if(cg[sStart + p] >= 0){ hasLesson = true; break; }
              }
              if(hasLesson) sessionClasses.push(cid);
            });
            this.rng.shuffle(sessionClasses);

            let resolved = false;

            // --- 1. Thu Intra-Class 3-Cycle tren cac lop cua buoi ---
            for(const cid of sessionClasses){
              const cg = this.classGrid.get(cid);
              for(let p1 = 0; p1 < PERIODS; p1++){
                const a1Id = cg[sStart + p1];
                if(a1Id < 0) continue;
                const a1 = this.activities[a1Id];
                if(!a1 || a1.isFixed || a1.duration !== 1) continue;

                for(let p2 = 0; p2 < PERIODS; p2++){
                  if(p2 === p1) continue;
                  const a2Id = cg[sStart + p2];
                  if(a2Id < 0) continue;
                  const a2 = this.activities[a2Id];
                  if(!a2 || a2.isFixed || a2.duration !== 1) continue;

                  for(let p3 = 0; p3 < PERIODS; p3++){
                    if(p3 === p1 || p3 === p2) continue;
                    const a3Id = cg[sStart + p3];
                    if(a3Id < 0) continue;
                    const a3 = this.activities[a3Id];
                    if(!a3 || a3.isFixed || a3.duration !== 1) continue;

                    // Thu cycle: p1->p2, p2->p3, p3->p1
                    const snap = this.captureStateSnapshot();
                    this.unplaceActivity(a1.id);
                    this.unplaceActivity(a2.id);
                    this.unplaceActivity(a3.id);

                    const r1 = this.getConflictsForSlot(a1, sStart + p2);
                    const r2 = this.getConflictsForSlot(a2, sStart + p3);
                    const r3 = this.getConflictsForSlot(a3, sStart + p1);

                    let ok = r1.possible && !r1.conflicts.length &&
                             r2.possible && !r2.conflicts.length &&
                             r3.possible && !r3.conflicts.length;

                    if(ok){
                      this.placeActivityDirect(a1.id, sStart + p2);
                      this.placeActivityDirect(a2.id, sStart + p3);
                      this.placeActivityDirect(a3.id, sStart + p1);
                      if(this.isLessonBlockSafe(a1, a2, a3)){
                        const m = this.evaluateMetrics();
                        if(this.compareMetrics(m, currentBest, mode) < 0){
                          currentBest = { ...m };
                          anyImproved = true;
                          resolved = true;
                          if(typeof onProgress === "function") onProgress(currentBest);
                        }
                      }
                    }
                    if(!resolved) this.restoreStateSnapshot(snap);
                    if(resolved) break;
                  }
                  if(resolved) break;
                }
                if(resolved) break;
              }
              if(resolved) break;
            }
            if(resolved) break;

            // --- 2. Thu Intra-Session 2-Class Chain (cls1: p1<->p2, cls2: p3<->p4) ---
            for(let i = 0; i < sessionClasses.length && !resolved; i++){
              const cid1 = sessionClasses[i];
              const cg1 = this.classGrid.get(cid1);

              for(let j = 0; j < sessionClasses.length && !resolved; j++){
                if(i === j) continue;
                const cid2 = sessionClasses[j];
                const cg2 = this.classGrid.get(cid2);

                for(let p1 = 0; p1 < PERIODS; p1++){
                  const a1Id = cg1[sStart + p1];
                  if(a1Id < 0) continue;
                  const a1 = this.activities[a1Id];
                  if(!a1 || a1.isFixed || a1.duration !== 1) continue;

                  for(let p2 = 0; p2 < PERIODS; p2++){
                    if(p2 === p1) continue;
                    const a2Id = cg1[sStart + p2];
                    if(a2Id < 0) continue;
                    const a2 = this.activities[a2Id];
                    if(!a2 || a2.isFixed || a2.duration !== 1) continue;

                    for(let p3 = 0; p3 < PERIODS; p3++){
                      const a3Id = cg2[sStart + p3];
                      if(a3Id < 0) continue;
                      const a3 = this.activities[a3Id];
                      if(!a3 || a3.isFixed || a3.duration !== 1) continue;

                      for(let p4 = 0; p4 < PERIODS; p4++){
                        if(p4 === p3) continue;
                        const a4Id = cg2[sStart + p4];
                        if(a4Id < 0) continue;
                        const a4 = this.activities[a4Id];
                        if(!a4 || a4.isFixed || a4.duration !== 1) continue;

                        // Swap a1(p1)<->a2(p2) in cid1 and a3(p3)<->a4(p4) in cid2
                        const snap = this.captureStateSnapshot();
                        this.unplaceActivity(a1.id);
                        this.unplaceActivity(a2.id);
                        this.unplaceActivity(a3.id);
                        this.unplaceActivity(a4.id);

                        const r1 = this.getConflictsForSlot(a1, sStart + p2);
                        const r2 = this.getConflictsForSlot(a2, sStart + p1);
                        const r3 = this.getConflictsForSlot(a3, sStart + p4);
                        const r4 = this.getConflictsForSlot(a4, sStart + p3);

                        let ok = r1.possible && !r1.conflicts.length &&
                                 r2.possible && !r2.conflicts.length &&
                                 r3.possible && !r3.conflicts.length &&
                                 r4.possible && !r4.conflicts.length;

                        if(ok){
                          this.placeActivityDirect(a1.id, sStart + p2);
                          this.placeActivityDirect(a2.id, sStart + p1);
                          this.placeActivityDirect(a3.id, sStart + p4);
                          this.placeActivityDirect(a4.id, sStart + p3);
                          if(this.isLessonBlockSafe(a1, a2, a3, a4)){
                            const m = this.evaluateMetrics();
                            if(this.compareMetrics(m, currentBest, mode) < 0){
                              currentBest = { ...m };
                              anyImproved = true;
                              resolved = true;
                              if(typeof onProgress === "function") onProgress(currentBest);
                            }
                          }
                        }
                        if(!resolved) this.restoreStateSnapshot(snap);
                        if(resolved) break;
                      }
                      if(resolved) break;
                    }
                    if(resolved) break;
                  }
                  if(resolved) break;
                }
              }
            }
            if(resolved) break;
          }
          if(anyImproved) break;
        }
        if(anyImproved) break;
      }

      return anyImproved ? currentBest : null;
    }

    
    tryBlockShiftAndGapResolution(bestMetrics, initialMetrics, mode = "optimize_gap2", onProgress = null) {
      let currentBest = { ...bestMetrics };
      let anyImproved = false;

      const PERIODS = 5;
      const SLOTS_PER_DAY = 10;
      const DAYS_LIST = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
      const SESSIONS_LIST = ["sang", "chieu"];

      for (let d = 0; d < DAYS_LIST.length; d++) {
        for (let b = 0; b < SESSIONS_LIST.length; b++) {
          const sStart = d * SLOTS_PER_DAY + b * PERIODS;

          for (const [cid, cg] of this.classGrid.entries()) {
            for (let p1 = 0; p1 < PERIODS; p1++) {
              for (let p2 = 0; p2 < PERIODS; p2++) {
                if (p1 === p2) continue;

                const a1Id = cg[sStart + p1];
                const a2Id = cg[sStart + p2];
                if (a1Id < 0 || a2Id < 0) continue;

                const a1 = this.activities[a1Id];
                const a2 = this.activities[a2Id];
                if (!a1 || !a2 || a1.isFixed || a2.isFixed) continue;

                // Direct 2-way swap in class
                const snap = this.captureStateSnapshot();
                this.unplaceActivity(a1.id);
                this.unplaceActivity(a2.id);

                const r1 = this.getConflictsForSlot(a1, sStart + p2);
                const r2 = this.getConflictsForSlot(a2, sStart + p1);

                if (r1.possible && !r1.conflicts.length && r2.possible && !r2.conflicts.length) {
                  this.placeActivityDirect(a1.id, sStart + p2);
                  this.placeActivityDirect(a2.id, sStart + p1);
                  if (this.isLessonBlockSafe(a1, a2)) {
                    const m = this.evaluateMetrics();
                    if (this.compareMetrics(m, currentBest, mode) < 0) {
                      currentBest = { ...m };
                      anyImproved = true;
                      if (typeof onProgress === "function") onProgress(currentBest);
                    }
                  }
                }
                if (this.compareMetrics(this.evaluateMetrics(), currentBest, mode) >= 0) {
                  this.restoreStateSnapshot(snap);
                }

                // Double block shift
                const partnerP1 = (p1 + 1 < PERIODS && cg[sStart + p1 + 1] >= 0 && this.activities[cg[sStart + p1 + 1]]?.subject === a1.subject) ? p1 + 1 :
                                  (p1 - 1 >= 0 && cg[sStart + p1 - 1] >= 0 && this.activities[cg[sStart + p1 - 1]]?.subject === a1.subject) ? p1 - 1 : -1;

                if (partnerP1 >= 0) {
                  const aPartner = this.activities[cg[sStart + partnerP1]];
                  if (aPartner && !aPartner.isFixed) {
                    const minP = Math.min(p1, partnerP1);
                    const maxP = Math.max(p1, partnerP1);

                    if (p2 < minP) {
                      const snapBlock = this.captureStateSnapshot();
                      const aMin = this.activities[cg[sStart + minP]];
                      const aMax = this.activities[cg[sStart + maxP]];
                      const aOther = this.activities[cg[sStart + p2]];

                      this.unplaceActivity(aMin.id);
                      this.unplaceActivity(aMax.id);
                      this.unplaceActivity(aOther.id);

                      const rc1 = this.getConflictsForSlot(aMin, sStart + p2);
                      const rc2 = this.getConflictsForSlot(aMax, sStart + minP);
                      const rc3 = this.getConflictsForSlot(aOther, sStart + maxP);

                      if (rc1.possible && !rc1.conflicts.length && rc2.possible && !rc2.conflicts.length && rc3.possible && !rc3.conflicts.length) {
                        this.placeActivityDirect(aMin.id, sStart + p2);
                        this.placeActivityDirect(aMax.id, sStart + minP);
                        this.placeActivityDirect(aOther.id, sStart + maxP);
                        if (this.isLessonBlockSafe(aMin, aMax, aOther)) {
                          const m = this.evaluateMetrics();
                          if (this.compareMetrics(m, currentBest, mode) < 0) {
                            currentBest = { ...m };
                            anyImproved = true;
                            if (typeof onProgress === "function") onProgress(currentBest);
                          }
                        }
                      }
                      if (this.compareMetrics(this.evaluateMetrics(), currentBest, mode) >= 0) {
                        this.restoreStateSnapshot(snapBlock);
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }

      return anyImproved ? currentBest : null;
    }

    
    tryInterDayRelocateGapLesson(bestMetrics, initialMetrics, mode = "optimize_gap2", onProgress = null) {
      let currentBest = { ...bestMetrics };
      let anyImproved = false;

      const PERIODS = 5;
      const SLOTS_PER_DAY = 10;
      const DAYS_LIST = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
      const SESSIONS_LIST = ["sang", "chieu"];

      for (const [tKey, grid] of this.teacherGrid.entries()) {
        if (!tKey || !this.isScoredTeacher(tKey)) continue;

        for (let dSrc = 0; dSrc < DAYS_LIST.length; dSrc++) {
          for (let bSrc = 0; bSrc < SESSIONS_LIST.length; bSrc++) {
            const sStartSrc = dSrc * SLOTS_PER_DAY + bSrc * PERIODS;
            const taughtSrc = [];
            for (let p = 0; p < PERIODS; p++) {
              const actId = grid[sStartSrc + p];
              if (actId >= 0 || actId === -3) taughtSrc.push(p);
            }

            if (taughtSrc.length < 2) continue;
            const spanSrc = taughtSrc[taughtSrc.length - 1] - taughtSrc[0] + 1;
            const gapsSrc = spanSrc - taughtSrc.length;
            if (gapsSrc < 2) continue;

            const outliers = [taughtSrc[0], taughtSrc[taughtSrc.length - 1]];
            let resolved = false;

            for (const pSrc of outliers) {
              const actSrcId = grid[sStartSrc + pSrc];
              if (actSrcId < 0) continue;
              const actSrc = this.activities[actSrcId];
              if (!actSrc || actSrc.isFixed || actSrc.duration !== 1) continue;

              const cid = actSrc.classId;
              const cg = this.classGrid.get(cid);
              if (!cg) continue;

              for (let dDest = 0; dDest < DAYS_LIST.length && !resolved; dDest++) {
                for (let bDest = 0; bDest < SESSIONS_LIST.length && !resolved; bDest++) {
                  if (dDest === dSrc && bDest === bSrc) continue;
                  const sStartDest = dDest * SLOTS_PER_DAY + bDest * PERIODS;

                  let hasClassSlot = false;
                  for (let p = 0; p < PERIODS; p++) {
                    if (cg[sStartDest + p] !== -2) hasClassSlot = true;
                  }
                  if (!hasClassSlot) continue;

                  for (let pDest = 0; pDest < PERIODS; pDest++) {
                    const slotDest = sStartDest + pDest;
                    if (cg[slotDest] === -2) continue;

                    const actDestId = cg[slotDest];
                    if (actDestId < 0) {
                      const snap = this.captureStateSnapshot();
                      this.unplaceActivity(actSrc.id);
                      const r = this.getConflictsForSlot(actSrc, slotDest);
                      if (r.possible && !r.conflicts.length) {
                        this.placeActivityDirect(actSrc.id, slotDest);
                        if (this.isLessonBlockSafe(actSrc) && this.isDailySubjectLimitSafe(actSrc, slotDest)) {
                          const m = this.evaluateMetrics();
                          if (this.compareMetrics(m, currentBest, mode) < 0) {
                            currentBest = { ...m };
                            anyImproved = true;
                            resolved = true;
                            if (typeof onProgress === "function") onProgress(currentBest);
                          }
                        }
                      }
                      if (!resolved) this.restoreStateSnapshot(snap);
                    } else {
                      const actDest = this.activities[actDestId];
                      if (!actDest || actDest.isFixed || actDest.duration !== 1) continue;

                      const snap = this.captureStateSnapshot();
                      this.unplaceActivity(actSrc.id);
                      this.unplaceActivity(actDest.id);

                      const r1 = this.getConflictsForSlot(actSrc, slotDest);
                      const r2 = this.getConflictsForSlot(actDest, sStartSrc + pSrc);

                      if (r1.possible && !r1.conflicts.length && r2.possible && !r2.conflicts.length) {
                        this.placeActivityDirect(actSrc.id, slotDest);
                        this.placeActivityDirect(actDest.id, sStartSrc + pSrc);
                        if (this.isLessonBlockSafe(actSrc, actDest) && this.isDailySubjectLimitSafe(actSrc, slotDest) && this.isDailySubjectLimitSafe(actDest, sStartSrc + pSrc)) {
                          const m = this.evaluateMetrics();
                          if (this.compareMetrics(m, currentBest, mode) < 0) {
                            currentBest = { ...m };
                            anyImproved = true;
                            resolved = true;
                            if (typeof onProgress === "function") onProgress(currentBest);
                          }
                        }
                      }
                      if (!resolved) this.restoreStateSnapshot(snap);
                    }
                    if (resolved) break;
                  }
                }
              }
              if (resolved) break;
            }
          }
        }
      }

      return anyImproved ? currentBest : null;
    }

    
    tryBorrowLessonFromRichSessions(bestMetrics, initialMetrics, mode = "optimize_gap2", onProgress = null) {
      let currentBest = { ...bestMetrics };
      let anyImproved = false;

      const PERIODS = 5;
      const SLOTS_PER_DAY = 10;
      const DAYS_LIST = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
      const SESSIONS_LIST = ["sang", "chieu"];

      for (const [tKey, grid] of this.teacherGrid.entries()) {
        if (!tKey || !this.isScoredTeacher(tKey)) continue;

        for (let dGap = 0; dGap < DAYS_LIST.length; dGap++) {
          for (let bGap = 0; bGap < SESSIONS_LIST.length; bGap++) {
            const sStartGap = dGap * SLOTS_PER_DAY + bGap * PERIODS;
            const taughtGap = [];
            for (let p = 0; p < PERIODS; p++) {
              const actId = grid[sStartGap + p];
              if (actId >= 0 || actId === -3) taughtGap.push(p);
            }

            if (taughtGap.length < 2) continue;
            const spanGap = taughtGap[taughtGap.length - 1] - taughtGap[0] + 1;
            const gapsCount = spanGap - taughtGap.length;
            if (gapsCount < 1) continue;

            const holes = [];
            for (let p = taughtGap[0] + 1; p < taughtGap[taughtGap.length - 1]; p++) {
              if (!taughtGap.includes(p)) holes.push(p);
            }

            let resolved = false;

            for (let dRich = 0; dRich < DAYS_LIST.length && !resolved; dRich++) {
              for (let bRich = 0; bRich < SESSIONS_LIST.length && !resolved; bRich++) {
                if (dRich === dGap && bRich === bGap) continue;
                const sStartRich = dRich * SLOTS_PER_DAY + bRich * PERIODS;

                const taughtRich = [];
                for (let p = 0; p < PERIODS; p++) {
                  const actId = grid[sStartRich + p];
                  if (actId >= 0 || actId === -3) taughtRich.push(p);
                }

                if (taughtRich.length < 2) continue;

                for (const pRich of taughtRich) {
                  const actRichId = grid[sStartRich + pRich];
                  if (actRichId < 0) continue;
                  const actDonor = this.activities[actRichId];
                  if (!actDonor || actDonor.isFixed || actDonor.duration !== 1) continue;

                  const cid = actDonor.classId;
                  const cg = this.classGrid.get(cid);
                  if (!cg) continue;

                  let classActiveInGap = false;
                  for (let p = 0; p < PERIODS; p++) {
                    if (cg[sStartGap + p] !== -2) classActiveInGap = true;
                  }
                  if (!classActiveInGap) continue;

                  const candidateTargetPeriods = [...holes, Math.max(0, taughtGap[0] - 1), Math.min(PERIODS - 1, taughtGap[taughtGap.length - 1] + 1)];

                  for (const pHole of candidateTargetPeriods) {
                    if (taughtGap.includes(pHole) || pHole < 0 || pHole >= PERIODS) continue;

                    const slotDest = sStartGap + pHole;
                    const slotSrc = sStartRich + pRich;
                    if (cg[slotDest] === -2) continue;

                    const actDestId = cg[slotDest];

                    if (actDestId < 0) {
                      const snap = this.captureStateSnapshot();
                      this.unplaceActivity(actDonor.id);
                      const r = this.getConflictsForSlot(actDonor, slotDest);

                      if (r.possible && !r.conflicts.length) {
                        this.placeActivityDirect(actDonor.id, slotDest);
                        if (this.isLessonBlockSafe(actDonor) && this.isDailySubjectLimitSafe(actDonor, slotDest)) {
                          const m = this.evaluateMetrics();
                          if (this.compareMetrics(m, currentBest, mode) < 0) {
                            currentBest = { ...m };
                            anyImproved = true;
                            resolved = true;
                            if (typeof onProgress === "function") onProgress(currentBest);
                          }
                        }
                      }
                      if (!resolved) this.restoreStateSnapshot(snap);
                    } else {
                      const actDest = this.activities[actDestId];
                      if (!actDest || actDest.isFixed || actDest.duration !== 1) continue;

                      const snap = this.captureStateSnapshot();
                      this.unplaceActivity(actDonor.id);
                      this.unplaceActivity(actDest.id);

                      const r1 = this.getConflictsForSlot(actDonor, slotDest);
                      const r2 = this.getConflictsForSlot(actDest, slotSrc);

                      if (r1.possible && !r1.conflicts.length && r2.possible && !r2.conflicts.length) {
                        this.placeActivityDirect(actDonor.id, slotDest);
                        this.placeActivityDirect(actDest.id, slotSrc);
                        if (this.isLessonBlockSafe(actDonor, actDest) && this.isDailySubjectLimitSafe(actDonor, slotDest) && this.isDailySubjectLimitSafe(actDest, slotSrc)) {
                          const m = this.evaluateMetrics();
                          if (this.compareMetrics(m, currentBest, mode) < 0) {
                            currentBest = { ...m };
                            anyImproved = true;
                            resolved = true;
                            if (typeof onProgress === "function") onProgress(currentBest);
                          }
                        }
                      }
                      if (!resolved) this.restoreStateSnapshot(snap);
                    }
                    if (resolved) break;
                  }
                  if (resolved) break;
                }
                if (resolved) break;
              }
              if (resolved) break;
            }
          }
        }
      }

      return anyImproved ? currentBest : null;
    }

    
    getMaxDailyPeriodsForSubject(cid, subject) {
      if(!subject) return 2;
      const sCanon = this.getCanonMonKey(subject);
      if(this.classSubjectLessonBlocks){
        for(const [k, req] of this.classSubjectLessonBlocks.entries()){
          if((req.cid === cid || req.classCanon === cid) && req.sCanon === sCanon){
            if(req.len >= 2) return req.len;
          }
        }
      }
      const sNorm = this.normalizeMonName(subject);
      const singleSubjects = ["gdcd", "tin", "cn", "nhac", "nhạc", "mt", "my thuat", "mỹ thuật", "gddp", "gdđp", "hdtn 1", "hđtn 1", "hdtn 2", "hđtn 2", "hdtn 3", "hđtn 3", "chao co", "chào cờ", "sinh hoat", "sinh hoạt"];
      if(singleSubjects.includes(sCanon) || singleSubjects.includes(sNorm)){
        return 1;
      }
      return 2;
    }

    isDailySubjectLimitSafe(act, targetSlot) {
      if(!act || !act.classId || !act.subject) return true;
      const details = slotToDetails(targetSlot);
      if(!details || details.dayIdx < 0) return true;
      const targetDayIdx = details.dayIdx;
      const cg = this.classGrid.get(act.classId);
      if(!cg) return true;

      const dayStart = targetDayIdx * SLOTS_PER_DAY;
      let count = 0;
      for(let p = 0; p < SLOTS_PER_DAY; p++){
        const aId = cg[dayStart + p];
        if(aId >= 0 && aId !== act.id){
          const a = this.activities[aId];
          if(a && this.getCanonMonKey(a.subject) === this.getCanonMonKey(act.subject)){
            count += a.duration || 1;
          }
        }
      }

      const maxLimit = this.getMaxDailyPeriodsForSubject(act.classId, act.subject);
      return (count + (act.duration || 1)) <= maxLimit;
    }

    
    tryCrushExtremeSpanGaps(bestMetrics, initialMetrics, mode = "optimize_gap2", onProgress = null) {
      let currentBest = { ...bestMetrics };
      let anyImproved = false;

      const PERIODS = 5;
      const SLOTS_PER_DAY = 10;
      const DAYS_LIST = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
      const SESSIONS_LIST = ["sang", "chieu"];

      for (const [tKey, grid] of this.teacherGrid.entries()) {
        if (!tKey || !this.isScoredTeacher(tKey)) continue;

        for (let d = 0; d < DAYS_LIST.length; d++) {
          for (let b = 0; b < SESSIONS_LIST.length; b++) {
            const sStart = d * SLOTS_PER_DAY + b * PERIODS;
            const taught = [];
            for (let p = 0; p < PERIODS; p++) {
              const actId = grid[sStart + p];
              if (actId >= 0 || actId === -3) taught.push({ p, actId, slot: sStart + p });
            }

            if (taught.length < 2) continue;
            const span = taught[taught.length - 1].p - taught[0].p + 1;
            const gaps = span - taught.length;
            if (gaps < 1) continue;

            let resolved = false;
            const edgeEnd = taught[taught.length - 1];
            const edgeStart = taught[0];

            if (edgeEnd.actId >= 0) {
              const actEnd = this.activities[edgeEnd.actId];
              if (actEnd && !actEnd.isFixed) {
                const cg = this.classGrid.get(actEnd.classId);
                if (cg) {
                  for (let d2 = 0; d2 < DAYS_LIST.length && !resolved; d2++) {
                    for (let b2 = 0; b2 < SESSIONS_LIST.length && !resolved; b2++) {
                      const sStart2 = d2 * SLOTS_PER_DAY + b2 * PERIODS;
                      for (let p2 = 0; p2 < PERIODS && !resolved; p2++) {
                        const slotDest = sStart2 + p2;
                        if (slotDest === edgeEnd.slot || cg[slotDest] === -2) continue;

                        const actDestId = cg[slotDest];
                        if (actDestId < 0) {
                          const snap = this.captureStateSnapshot();
                          this.unplaceActivity(actEnd.id);
                          const r = this.getConflictsForSlot(actEnd, slotDest);
                          if (r.possible && !r.conflicts.length) {
                            this.placeActivityDirect(actEnd.id, slotDest);
                            if (this.isLessonBlockSafe(actEnd) && this.isDailySubjectLimitSafe(actEnd, slotDest)) {
                              const m = this.evaluateMetrics();
                              if (this.compareMetrics(m, currentBest, mode) < 0) {
                                currentBest = { ...m };
                                anyImproved = true;
                                resolved = true;
                                if (typeof onProgress === "function") onProgress(currentBest);
                              }
                            }
                          }
                          if (!resolved) this.restoreStateSnapshot(snap);
                        } else {
                          const actDest = this.activities[actDestId];
                          if (!actDest || actDest.isFixed || actDest.duration !== actEnd.duration) continue;

                          const snap = this.captureStateSnapshot();
                          this.unplaceActivity(actEnd.id);
                          this.unplaceActivity(actDest.id);

                          const r1 = this.getConflictsForSlot(actEnd, slotDest);
                          const r2 = this.getConflictsForSlot(actDest, edgeEnd.slot);

                          if (r1.possible && !r1.conflicts.length && r2.possible && !r2.conflicts.length) {
                            this.placeActivityDirect(actEnd.id, slotDest);
                            this.placeActivityDirect(actDest.id, edgeEnd.slot);
                            if (this.isLessonBlockSafe(actEnd, actDest) && 
                                this.isDailySubjectLimitSafe(actEnd, slotDest) && 
                                this.isDailySubjectLimitSafe(actDest, edgeEnd.slot)) {
                              const m = this.evaluateMetrics();
                              if (this.compareMetrics(m, currentBest, mode) < 0) {
                                currentBest = { ...m };
                                anyImproved = true;
                                resolved = true;
                                if (typeof onProgress === "function") onProgress(currentBest);
                              }
                            }
                          }
                          if (!resolved) this.restoreStateSnapshot(snap);
                        }
                      }
                    }
                  }
                }
              }
            }

            if (!resolved && edgeStart.actId >= 0) {
              const actStart = this.activities[edgeStart.actId];
              if (actStart && !actStart.isFixed) {
                const cg = this.classGrid.get(actStart.classId);
                if (cg) {
                  for (let d2 = 0; d2 < DAYS_LIST.length && !resolved; d2++) {
                    for (let b2 = 0; b2 < SESSIONS_LIST.length && !resolved; b2++) {
                      const sStart2 = d2 * SLOTS_PER_DAY + b2 * PERIODS;
                      for (let p2 = 0; p2 < PERIODS && !resolved; p2++) {
                        const slotDest = sStart2 + p2;
                        if (slotDest === edgeStart.slot || cg[slotDest] === -2) continue;

                        const actDestId = cg[slotDest];
                        if (actDestId < 0) {
                          const snap = this.captureStateSnapshot();
                          this.unplaceActivity(actStart.id);
                          const r = this.getConflictsForSlot(actStart, slotDest);
                          if (r.possible && !r.conflicts.length) {
                            this.placeActivityDirect(actStart.id, slotDest);
                            if (this.isLessonBlockSafe(actStart) && this.isDailySubjectLimitSafe(actStart, slotDest)) {
                              const m = this.evaluateMetrics();
                              if (this.compareMetrics(m, currentBest, mode) < 0) {
                                currentBest = { ...m };
                                anyImproved = true;
                                resolved = true;
                                if (typeof onProgress === "function") onProgress(currentBest);
                              }
                            }
                          }
                          if (!resolved) this.restoreStateSnapshot(snap);
                        } else {
                          const actDest = this.activities[actDestId];
                          if (!actDest || actDest.isFixed || actDest.duration !== actStart.duration) continue;

                          const snap = this.captureStateSnapshot();
                          this.unplaceActivity(actStart.id);
                          this.unplaceActivity(actDest.id);

                          const r1 = this.getConflictsForSlot(actStart, slotDest);
                          const r2 = this.getConflictsForSlot(actDest, edgeStart.slot);

                          if (r1.possible && !r1.conflicts.length && r2.possible && !r2.conflicts.length) {
                            this.placeActivityDirect(actStart.id, slotDest);
                            this.placeActivityDirect(actDest.id, edgeStart.slot);
                            if (this.isLessonBlockSafe(actStart, actDest) && 
                                this.isDailySubjectLimitSafe(actStart, slotDest) && 
                                this.isDailySubjectLimitSafe(actDest, edgeStart.slot)) {
                              const m = this.evaluateMetrics();
                              if (this.compareMetrics(m, currentBest, mode) < 0) {
                                currentBest = { ...m };
                                anyImproved = true;
                                resolved = true;
                                if (typeof onProgress === "function") onProgress(currentBest);
                              }
                            }
                          }
                          if (!resolved) this.restoreStateSnapshot(snap);
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }

      return anyImproved ? currentBest : null;
    }

    tryMergeSameTeacherSplitPeriodsInSession(bestMetrics, initialMetrics, mode = "optimize_gap2", onProgress = null) {
      let currentBest = { ...bestMetrics };
      let anyImproved = false;

      const PERIODS = 5;
      const SLOTS_PER_DAY = 10;
      const DAYS_LIST = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
      const SESSIONS_LIST = ["sang", "chieu"];

      for (const [tKey, grid] of this.teacherGrid.entries()) {
        if (!tKey || !this.isScoredTeacher(tKey)) continue;

        for (let d = 0; d < DAYS_LIST.length; d++) {
          for (let b = 0; b < SESSIONS_LIST.length; b++) {
            const sStart = d * SLOTS_PER_DAY + b * PERIODS;
            const actsInSession = [];
            for (let p = 0; p < PERIODS; p++) {
              const aId = grid[sStart + p];
              if (aId >= 0) actsInSession.push({ p, actId: aId, slot: sStart + p });
            }

            if (actsInSession.length !== 2) continue;
            const pFirst = actsInSession[0].p;
            const pSecond = actsInSession[1].p;
            if (pSecond - pFirst <= 1) continue;

            const act1 = this.activities[actsInSession[0].actId];
            const act2 = this.activities[actsInSession[1].actId];
            if (!act1 || !act2 || act1.isFixed || act2.isFixed) continue;

            const candidates = [
              { moveAct: act2, fromSlot: actsInSession[1].slot, toSlot: sStart + pFirst + 1 },
              { moveAct: act1, fromSlot: actsInSession[0].slot, toSlot: sStart + pSecond - 1 }
            ];

            let resolved = false;
            for (const cand of candidates) {
              const cg = this.classGrid.get(cand.moveAct.classId);
              if (!cg || cg[cand.toSlot] === -2) continue;

              const displacedId = cg[cand.toSlot];
              if (displacedId < 0) {
                const snap = this.captureStateSnapshot();
                this.unplaceActivity(cand.moveAct.id);
                const r = this.getConflictsForSlot(cand.moveAct, cand.toSlot);
                if (r.possible && !r.conflicts.length) {
                  this.placeActivityDirect(cand.moveAct.id, cand.toSlot);
                  if (this.isLessonBlockSafe(cand.moveAct) && this.isDailySubjectLimitSafe(cand.moveAct, cand.toSlot)) {
                    const m = this.evaluateMetrics();
                    if (this.compareMetrics(m, currentBest, mode) < 0) {
                      currentBest = { ...m };
                      anyImproved = true;
                      resolved = true;
                      if (typeof onProgress === "function") onProgress(currentBest);
                    }
                  }
                }
                if (!resolved) this.restoreStateSnapshot(snap);
              } else {
                const displacedAct = this.activities[displacedId];
                if (!displacedAct || displacedAct.isFixed) continue;

                const snap = this.captureStateSnapshot();
                this.unplaceActivity(cand.moveAct.id);
                this.unplaceActivity(displacedAct.id);

                const r1 = this.getConflictsForSlot(cand.moveAct, cand.toSlot);
                const r2 = this.getConflictsForSlot(displacedAct, cand.fromSlot);

                if (r1.possible && !r1.conflicts.length && r2.possible && !r2.conflicts.length) {
                  this.placeActivityDirect(cand.moveAct.id, cand.toSlot);
                  this.placeActivityDirect(displacedAct.id, cand.fromSlot);
                  if (this.isLessonBlockSafe(cand.moveAct, displacedAct) &&
                      this.isDailySubjectLimitSafe(cand.moveAct, cand.toSlot) &&
                      this.isDailySubjectLimitSafe(displacedAct, cand.fromSlot)) {
                    const m = this.evaluateMetrics();
                    if (this.compareMetrics(m, currentBest, mode) < 0) {
                      currentBest = { ...m };
                      anyImproved = true;
                      resolved = true;
                      if (typeof onProgress === "function") onProgress(currentBest);
                    }
                  }
                }
                if (!resolved) this.restoreStateSnapshot(snap);
              }
              if (resolved) break;
            }
          }
        }
      }

      return anyImproved ? currentBest : null;
    }

    
    tryRelaxAndRepairGapGaps(bestMetrics, initialMetrics, mode = "optimize_gap2", onProgress = null) {
      let currentBest = { ...bestMetrics };
      let anyImproved = false;

      const PERIODS = 5;
      const SLOTS_PER_DAY = 10;
      const DAYS_LIST = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
      const SESSIONS_LIST = ["sang", "chieu"];

      for (const [tKey, grid] of this.teacherGrid.entries()) {
        if (!tKey || !this.isScoredTeacher(tKey)) continue;

        for (let d = 0; d < DAYS_LIST.length; d++) {
          for (let b = 0; b < SESSIONS_LIST.length; b++) {
            const sStart = d * SLOTS_PER_DAY + b * PERIODS;
            const taught = [];
            for (let p = 0; p < PERIODS; p++) {
              const actId = grid[sStart + p];
              if (actId >= 0 || actId === -3) taught.push({ p, actId, slot: sStart + p });
            }

            if (taught.length < 2) continue;
            const span = taught[taught.length - 1].p - taught[0].p + 1;
            const gaps = span - taught.length;
            if (gaps < 1) continue;

            let resolved = false;
            const edgeEnd = taught[taught.length - 1];

            if (edgeEnd.actId >= 0) {
              const actToMove = this.activities[edgeEnd.actId];
              if (actToMove && !actToMove.isFixed) {
                const cg = this.classGrid.get(actToMove.classId);
                if (!cg) continue;

                for (let d2 = 0; d2 < DAYS_LIST.length && !resolved; d2++) {
                  for (let b2 = 0; b2 < SESSIONS_LIST.length && !resolved; b2++) {
                    if (d2 === d && b2 === b) continue;
                    const sStart2 = d2 * SLOTS_PER_DAY + b2 * PERIODS;

                    for (let p2 = 0; p2 < PERIODS && !resolved; p2++) {
                      const targetSlot = sStart2 + p2;
                      if (cg[targetSlot] === -2) continue;

                      const snap = this.captureStateSnapshot();
                      let placed = false;

                      const displacedId = cg[targetSlot];
                      if (displacedId < 0) {
                        this.unplaceActivity(actToMove.id);
                        const r = this.getConflictsForSlot(actToMove, targetSlot);
                        if (r.possible && !r.conflicts.length) {
                          this.placeActivityDirect(actToMove.id, targetSlot);
                          placed = true;
                        }
                      } else {
                        const displacedAct = this.activities[displacedId];
                        if (displacedAct && !displacedAct.isFixed && displacedAct.duration === actToMove.duration) {
                          this.unplaceActivity(actToMove.id);
                          this.unplaceActivity(displacedAct.id);

                          const r1 = this.getConflictsForSlot(actToMove, targetSlot);
                          const r2 = this.getConflictsForSlot(displacedAct, edgeEnd.slot);

                          if (r1.possible && !r1.conflicts.length && r2.possible && !r2.conflicts.length) {
                            this.placeActivityDirect(actToMove.id, targetSlot);
                            this.placeActivityDirect(displacedAct.id, edgeEnd.slot);
                            placed = true;
                          }
                        }
                      }

                      if (placed) {
                        const isBlockOk = this.isLessonBlockSafe(actToMove);
                        const isDailyLimitOk = this.isDailySubjectLimitSafe(actToMove, targetSlot);

                        if (isBlockOk && isDailyLimitOk) {
                          const m = this.evaluateMetrics();
                          if (this.compareMetrics(m, currentBest, mode) < 0) {
                            currentBest = { ...m };
                            anyImproved = true;
                            resolved = true;
                            if (typeof onProgress === "function") onProgress(currentBest);
                          }
                        }
                      }

                      if (!resolved) {
                        this.restoreStateSnapshot(snap);
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }

      return anyImproved ? currentBest : null;
    }

    
    tryIntraClassSingleDoubleBlockSwap(bestMetrics, initialMetrics, mode = "optimize_gap2", onProgress = null) {
      let currentBest = { ...bestMetrics };
      let anyImproved = false;

      const PERIODS = 5;
      const SLOTS_PER_DAY = 10;
      const DAYS_LIST = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
      const SESSIONS_LIST = ["sang", "chieu"];

      for(const [cid, cg] of this.classGrid.entries()) {
        if(!cid || !cg) continue;

        for(let d = 0; d < DAYS_LIST.length; d++) {
          for(let b = 0; b < SESSIONS_LIST.length; b++) {
            const sStart = d * SLOTS_PER_DAY + b * PERIODS;

            for(let p1 = 0; p1 < PERIODS; p1++) {
              const act1Id = cg[sStart + p1];
              if(act1Id < 0) continue;
              const act1 = this.activities[act1Id];
              if(!act1 || act1.isFixed || act1.duration !== 1) continue;

              for(let p2 = 0; p2 < PERIODS - 1; p2++) {
                if(p2 === p1 || p2 + 1 === p1) continue;
                const act2Id = cg[sStart + p2];
                const act3Id = cg[sStart + p2 + 1];
                if(act2Id < 0 || act3Id < 0) continue;

                const act2 = this.activities[act2Id];
                const act3 = this.activities[act3Id];
                if(!act2 || !act3 || act2.isFixed || act3.isFixed) continue;

                if(p1 === 4 && p2 === 2) {
                  const snap = this.captureStateSnapshot();
                  this.unplaceActivity(act1.id);
                  this.unplaceActivity(act2.id);
                  this.unplaceActivity(act3.id);

                  const sP3 = sStart + 2;
                  const sP4 = sStart + 3;
                  const sP5 = sStart + 4;

                  const r1 = this.getConflictsForSlot(act1, sP3);
                  const r2 = this.getConflictsForSlot(act2, sP4);
                  const r3 = this.getConflictsForSlot(act3, sP5);

                  if(r1.possible && !r1.conflicts.length && r2.possible && !r2.conflicts.length && r3.possible && !r3.conflicts.length) {
                    this.placeActivityDirect(act1.id, sP3);
                    this.placeActivityDirect(act2.id, sP4);
                    this.placeActivityDirect(act3.id, sP5);

                    if(this.isLessonBlockSafe(act1, act2, act3) &&
                       this.isDailySubjectLimitSafe(act1, sP3) &&
                       this.isDailySubjectLimitSafe(act2, sP4) &&
                       this.isDailySubjectLimitSafe(act3, sP5)) {
                      const m = this.evaluateMetrics();
                      if(this.compareMetrics(m, currentBest, mode) < 0) {
                        currentBest = { ...m };
                        anyImproved = true;
                        if(typeof onProgress === "function") onProgress(currentBest);
                      }
                    }
                  }
                  if(!anyImproved) this.restoreStateSnapshot(snap);
                }

                if(p1 === 2 && p2 === 3) {
                  const snap = this.captureStateSnapshot();
                  this.unplaceActivity(act1.id);
                  this.unplaceActivity(act2.id);
                  this.unplaceActivity(act3.id);

                  const sP3 = sStart + 2;
                  const sP4 = sStart + 3;
                  const sP5 = sStart + 4;

                  const r2 = this.getConflictsForSlot(act2, sP3);
                  const r3 = this.getConflictsForSlot(act3, sP4);
                  const r1 = this.getConflictsForSlot(act1, sP5);

                  if(r1.possible && !r1.conflicts.length && r2.possible && !r2.conflicts.length && r3.possible && !r3.conflicts.length) {
                    this.placeActivityDirect(act2.id, sP3);
                    this.placeActivityDirect(act3.id, sP4);
                    this.placeActivityDirect(act1.id, sP5);

                    if(this.isLessonBlockSafe(act1, act2, act3) &&
                       this.isDailySubjectLimitSafe(act2, sP3) &&
                       this.isDailySubjectLimitSafe(act3, sP4) &&
                       this.isDailySubjectLimitSafe(act1, sP5)) {
                      const m = this.evaluateMetrics();
                      if(this.compareMetrics(m, currentBest, mode) < 0) {
                        currentBest = { ...m };
                        anyImproved = true;
                        if(typeof onProgress === "function") onProgress(currentBest);
                      }
                    }
                  }
                  if(!anyImproved) this.restoreStateSnapshot(snap);
                }
              }
            }
          }
        }
      }

      return anyImproved ? currentBest : null;
    }

    // =========================================================================
    // EXILE EDGE LESSON (chỉ thị 17/08: "1t là block — còn lại phá kẹt tự do")
    // Nước đơn giản nhất chưa từng có trong bộ: BỐC HẲN một tiết MÉP của buổi
    // Trống-2 đi NƠI KHÁC BẤT KỲ trong tuần (recursive swapping toàn dải, không
    // giới hạn đích). Phần còn lại của buổi phải liền mạch >=2 tiết — buổi hết
    // trống ngay: [1,2,5] đày tiết 5 -> [1,2]; [1,4,5] đày tiết 1 -> [4,5].
    // Hỗ trợ cả khối tiết đôi ở mép ([D12,5] đày 5 -> [D12]). Gate so sánh với
    // comparator 1t-khóa-trần nên không bao giờ sinh thêm 1 tiết/buổi.
    // =========================================================================
    tryExileEdgeLesson(bestMetrics, initialMetrics, mode = "optimize_gap2", onProgress = null){
      const PERIODS = PERIODS_PER_SESSION;
      let currentBest = { ...bestMetrics };
      let anyImproved = false;

      const teacherList = Array.from(this.teacherGrid.keys()).filter(t => t && this.isScoredTeacher(t));
      this.rng.shuffle(teacherList);

      for(const tKey of teacherList){
        const tGrid = this.teacherGrid.get(tKey);
        if(!tGrid) continue;

        for(let d = 0; d < DAYS_LIST.length; d++){
          for(let b = 0; b < SESSIONS_LIST.length; b++){
            const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
            const taughtPs = [];
            for(let p = 0; p < PERIODS; p++){
              if(tGrid[sStart + p] >= 0 || tGrid[sStart + p] === -3) taughtPs.push(p);
            }
            if(taughtPs.length < 3) continue; // đày 1 tiết phải còn >=2
            const holes = (taughtPs[taughtPs.length - 1] - taughtPs[0] + 1) - taughtPs.length;
            const isTarget = mode === "optimize_gap1" ? holes === 1 : holes >= 2;
            if(!isTarget) continue;

            // Ứng viên đày: cụm mép đầu hoặc cụm mép cuối (head của act, dur 1-2)
            const exileCands = [];
            for(const p of [taughtPs[0], taughtPs[taughtPs.length - 1]]){
              const v = tGrid[sStart + p];
              if(v < 0) continue;
              const act = this.activities[v];
              if(!act || act.isFixed) continue;
              const head = this.actPlacement[act.id];
              if(head < sStart || head >= sStart + PERIODS) continue;
              // sau khi bỏ act, các tiết còn lại phải liền mạch và >= 2
              const rest = taughtPs.filter(pp => tGrid[sStart + pp] !== act.id);
              if(rest.length < 2) continue;
              if((rest[rest.length - 1] - rest[0] + 1) !== rest.length) continue;
              exileCands.push(act);
            }

            let resolved = false;
            for(const act of exileCands){
              const snap = this.captureStateSnapshot();
              const savedCalls = this.limitCalls;
              this.limitCalls = Math.max(this.limitCalls || 0, 20000);
              this.nCalls = 0;
              this.unplaceActivity(act.id);
              // Ưu tiên đáp vào LỖ/MÉP các buổi đang có của giáo viên (không
              // sinh buổi lẻ mới → không vướng khóa 1t); bí mới thả toàn dải.
              const preferred = [];
              if(act.gv){
                for(const t2 of parseTeacherList(act.gv)){
                  const tg2 = this.teacherGrid.get(t2);
                  if(!tg2) continue;
                  for(let d3 = 0; d3 < DAYS_LIST.length; d3++){
                    for(let b3 = 0; b3 < SESSIONS_LIST.length; b3++){
                      const st3 = d3 * SLOTS_PER_DAY + b3 * PERIODS_PER_SESSION;
                      if(st3 === sStart) continue;
                      const ps3 = [];
                      for(let p3 = 0; p3 < PERIODS; p3++){
                        if(tg2[st3 + p3] >= 0 || tg2[st3 + p3] === -3) ps3.push(p3);
                      }
                      if(!ps3.length) continue;
                      const lo = ps3[0], hi = ps3[ps3.length - 1];
                      for(let p3 = 0; p3 < PERIODS; p3++){
                        const v3 = tg2[st3 + p3];
                        if(v3 >= 0 || v3 === -2 || v3 === -3) continue;
                        if((p3 > lo && p3 < hi) || p3 === lo - 1 || p3 === hi + 1) preferred.push(st3 + p3);
                      }
                    }
                  }
                }
              }
              let ok = false;
              if(preferred.length){
                ok = this.randomSwap(act.id, 0, preferred);
              }
              if(!ok){
                this.nCalls = 0;
                ok = this.randomSwap(act.id, 0); // toàn dải — tự do tuyệt đối
              }
              this.limitCalls = savedCalls;
              if(ok && this.isLessonBlockSafe(act) && this.isLessonBlockSafe()){
                const m = this.evaluateMetrics();
                if(this.compareMetrics(m, currentBest, mode) < 0){
                  currentBest = { ...m };
                  anyImproved = true;
                  resolved = true;
                  if(typeof onProgress === "function") onProgress(currentBest);
                }
              }
              if(!resolved) this.restoreStateSnapshot(snap);
              if(resolved) break;
            }
          }
        }
      }
      return anyImproved ? currentBest : null;
    }

    compareMetrics(a, b, mode = "optimize_singletons"){
      if(!a) return 1;
      if(!b) return -1;

      if(mode === "optimize_singletons"){
        if(a.soBuoiDay1 !== b.soBuoiDay1) return a.soBuoiDay1 - b.soBuoiDay1;
        if(a.tsBuoiDay !== b.tsBuoiDay) return a.tsBuoiDay - b.tsBuoiDay;
        return a.tsNgayDay - b.tsNgayDay;
      }

      if(mode === "optimize_sessions"){
        if(a.soBuoiDay1 !== b.soBuoiDay1) return a.soBuoiDay1 - b.soBuoiDay1;
        if(a.tsBuoiDay !== b.tsBuoiDay) return a.tsBuoiDay - b.tsBuoiDay;
        const a23 = (a.soBuoiDay2 || 0) * 2 + (a.soBuoiDay3 || 0);
        const b23 = (b.soBuoiDay2 || 0) * 2 + (b.soBuoiDay3 || 0);
        if(a23 !== b23) return a23 - b23;
        return a.tsNgayDay - b.tsNgayDay;
      }

      if(mode === "optimize_gap2"){
        // Uu tien toi thuong cua optimize_gap2: soBuoiTrong2 phai giam manh ve 0!
        if(a.soBuoiTrong2 !== b.soBuoiTrong2){
          const initSingle = this.initialMetricsSnapshot?.soBuoiDay1 ?? 999;
          const aSingleExceed = Math.max(0, a.soBuoiDay1 - initSingle);
          const bSingleExceed = Math.max(0, b.soBuoiDay1 - initSingle);
          if(aSingleExceed !== bSingleExceed) return aSingleExceed - bSingleExceed;
          return a.soBuoiTrong2 - b.soBuoiTrong2;
        }
        if(a.soBuoiDay1 !== b.soBuoiDay1) return a.soBuoiDay1 - b.soBuoiDay1;
        if(a.tsBuoiDay !== b.tsBuoiDay) return a.tsBuoiDay - b.tsBuoiDay;
        if(a.soBuoiTrong1 !== b.soBuoiTrong1) return a.soBuoiTrong1 - b.soBuoiTrong1;
        return a.tsNgayDay - b.tsNgayDay;
      }

      if(mode === "optimize_gap1"){
        // Đồng bộ với thứ tự toàn cục: gap2 đứng TRÊN tổng buổi — nước đi
        // giảm trống-1 mà tiện tay giảm/giữ trống-2 luôn được ưu tiên.
        if(a.soBuoiDay1 !== b.soBuoiDay1) return a.soBuoiDay1 - b.soBuoiDay1;
        if(a.soBuoiTrong2 !== b.soBuoiTrong2) return a.soBuoiTrong2 - b.soBuoiTrong2;
        if(a.tsBuoiDay !== b.tsBuoiDay) return a.tsBuoiDay - b.tsBuoiDay;
        return a.soBuoiTrong1 - b.soBuoiTrong1;
      }

      return (a.soBuoiDay1 - b.soBuoiDay1) || (a.soBuoiTrong2 - b.soBuoiTrong2) || (a.tsBuoiDay - b.tsBuoiDay);
    }

    // Incremental Single-Teacher Evaluation (ANTIGRAVITY_KHU_1_TIET_BUOI.md Section 4.4)
    isScoredTeacher(tKey){
      return !this.scoredTeachers || this.scoredTeachers.has(tKey);
    }

    evaluateTeacherMetrics(tKey){
      const grid = this.teacherGrid.get(tKey);
      if(!grid || !this.isScoredTeacher(tKey)) return { soNgayMotTiet: 0, soBuoiDay1: 0, soBuoiDay2: 0, soBuoiDay3: 0, tsBuoiDay: 0, tsNgayDay: 0, soBuoiTrong1: 0, soBuoiTrong2: 0 };

      let soNgayMotTiet = 0;
      let soBuoiDay1 = 0;
      let soBuoiDay2 = 0;
      let soBuoiDay3 = 0;
      let tsBuoiDay = 0;
      let tsNgayDay = 0;
      let soBuoiTrong1 = 0;
      let soBuoiTrong2 = 0;

      for(let d = 0; d < DAYS_LIST.length; d++){
        let dayTotal = 0;
        for(let b = 0; b < SESSIONS_LIST.length; b++){
          const sessionStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
          const taughtIndices = [];
          for(let p = 0; p < PERIODS_PER_SESSION; p++){
            const cell = grid[sessionStart + p];
            if(cell >= 0 || cell === -3) taughtIndices.push(p);
          }
          const k = taughtIndices.length;
          dayTotal += k;
          if(k > 0){
            tsBuoiDay++;
            if(k === 1) soBuoiDay1++;
            else if(k === 2) soBuoiDay2++;
            else if(k === 3) soBuoiDay3++;
            const span = taughtIndices[k - 1] - taughtIndices[0] + 1;
            const gaps = span - k;
            if(gaps === 1) soBuoiTrong1++;
            else if(gaps >= 2) soBuoiTrong2++;
          }
        }
        if(dayTotal > 0) tsNgayDay++;
        if(dayTotal === 1) soNgayMotTiet++;
      }
      return { soNgayMotTiet, soBuoiDay1, soBuoiDay2, soBuoiDay3, tsBuoiDay, tsNgayDay, soBuoiTrong1, soBuoiTrong2 };
    }

    // Transparent Residual Singleton Classification (ANTIGRAVITY_KHU_1_TIET_BUOI.md Section 5.5)
    getResidualSingletons(){
      const residuals = [];
      const DAYS = DAYS_LIST;
      const SESSIONS = SESSIONS_LIST;

      this.teacherGrid.forEach((grid, tKey) => {
        if(!tKey || !this.isScoredTeacher(tKey)) return;
        let totalWeeklyPeriods = 0;
        for(let s = 0; s < TOTAL_SLOTS; s++){
          if(grid[s] >= 0 || grid[s] === -3) totalWeeklyPeriods++;
        }

        for(let d = 0; d < DAYS.length; d++){
          for(let b = 0; b < SESSIONS.length; b++){
            const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
            const taught = [];
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const s = sStart + p;
              if(grid[s] >= 0 || grid[s] === -3){
                taught.push({ slot: s, p, actId: grid[s] });
              }
            }
            if(taught.length === 1){
              const item = taught[0];
              const act = item.actId >= 0 ? this.activities[item.actId] : null;
              let reason = "constrained-schedule-density";
              if(totalWeeklyPeriods === 1){
                reason = "teacher-only-1-period-total-in-week";
              }
              residuals.push({
                teacher: tKey,
                day: DAYS[d],
                session: SESSIONS[b],
                classId: act ? act.classId : "FIXED",
                mon: act ? act.mon : "FIXED",
                totalWeeklyPeriods,
                reason
              });
            }
          }
        }
      });
      return residuals;
    }

    // LNS Ruin-and-Recreate Perturbation (ANTIGRAVITY_KHU_1_TIET_BUOI.md Section 4.2)
    tryLnsRuinAndRecreate(targetTeacherKeys, bestMetrics, mode = "optimize_singletons", maxGap2Limit = Infinity, onProgress = null){
      const snapPlacement = this.actPlacement.slice();
      const snapClass = new Map();
      this.classGrid.forEach((arr, cid) => snapClass.set(cid, arr.slice()));
      const snapTeacher = new Map();
      this.teacherGrid.forEach((arr, gv) => snapTeacher.set(gv, arr.slice()));
      const snapRoom = new Map();
      this.roomGrid.forEach((arr, rm) => snapRoom.set(rm, arr.slice()));

      const unplacedActs = [];
      for(const tKey of targetTeacherKeys){
        const tGrid = this.teacherGrid.get(tKey);
        if(!tGrid) continue;

        for(let s = 0; s < TOTAL_SLOTS; s++){
          const actId = tGrid[s];
          if(actId >= 0){
            const act = this.activities[actId];
            if(act && !act.isFixed && act.duration === 1){
              this.unplaceActivity(act.id);
              unplacedActs.push(act);
            }
          }
        }
      }

      if(unplacedActs.length === 0) return null;

      // Sort unplaced acts by most-constrained first
      unplacedActs.sort((a, b) => {
        const cA = this.classGrid.get(a.classId)?.filter(x => x === -1).length || 0;
        const cB = this.classGrid.get(b.classId)?.filter(x => x === -1).length || 0;
        return cA - cB;
      });

      // Re-place activities using penalty-guided randomSwap
      let allPlaced = true;
      this.limitCalls = 6000;

      for(const act of unplacedActs){
        this.nCalls = 0;
        const ok = this.randomSwap(act.id, 0);
        if(!ok){
          allPlaced = false;
          break;
        }
      }

      if(allPlaced && this.isLessonBlockSafe()){
        const m = this.evaluateMetrics();
        if(this.compareMetrics(m, bestMetrics, mode) < 0){
          if(typeof onProgress === "function") onProgress(m);
          return m;
        }
      }

      // Rollback
      this.actPlacement = snapPlacement;
      this.classGrid = snapClass;
      this.teacherGrid = snapTeacher;
      this.roomGrid = snapRoom;
      return null;
    }

    // Direction 1: Whole-Session Block Swapping (Hoán đổi toàn bộ khối buổi của lớp - tối ưu tốc độ)
    tryWholeSessionSwap(bestMetrics, mode = "optimize_singletons", onProgress = null){
      const DAYS = DAYS_LIST.length;
      const SESSIONS = SESSIONS_LIST.length;
      const PERIODS = PERIODS_PER_SESSION;
      let currentBest = { ...bestMetrics };
      let anyImproved = false;

      const classList = Array.from(this.classGrid.keys()).filter(Boolean);
      this.rng.shuffle(classList);
      const sampledClasses = classList.slice(0, 12);

      for(const cid of sampledClasses){
        const cGrid = this.classGrid.get(cid);
        if(!cGrid) continue;

        for(let b = 0; b < SESSIONS; b++){
          for(let d1 = 0; d1 < DAYS; d1++){
            const sStart1 = d1 * 10 + b * 5;
            let canSwap1 = true;
            const acts1 = [];
            for(let p = 0; p < PERIODS; p++){
              const s = sStart1 + p;
              if(this.offSlots.has(`${cid}|${s}`)){ canSwap1 = false; break; }
              const actId = cGrid[s];
              if(actId === -3){ canSwap1 = false; break; }
              if(actId >= 0){
                const act = this.activities[actId];
                if(!act || act.isFixed){ canSwap1 = false; break; }
                // Duration-2 activities cover two cells; only collect the HEAD
                // cell so the swap/rollback never places the same activity twice
                // (double placement overwrote neighbours and leaked lessons).
                if(this.actPlacement[actId] === s) acts1.push({ slot: s, act, p });
              }
            }
            if(!canSwap1) continue;

            for(let d2 = d1 + 1; d2 < DAYS; d2++){
              const sStart2 = d2 * 10 + b * 5;
              let canSwap2 = true;
              const acts2 = [];
              for(let p = 0; p < PERIODS; p++){
                const s = sStart2 + p;
                if(this.offSlots.has(`${cid}|${s}`)){ canSwap2 = false; break; }
                const actId = cGrid[s];
                if(actId === -3){ canSwap2 = false; break; }
                if(actId >= 0){
                  const act = this.activities[actId];
                  if(!act || act.isFixed){ canSwap2 = false; break; }
                  if(this.actPlacement[actId] === s) acts2.push({ slot: s, act, p });
                }
              }
              if(!canSwap2) continue;

              // Unplace all activities in both sessions
              acts1.forEach(item => this.unplaceActivity(item.act.id));
              acts2.forEach(item => this.unplaceActivity(item.act.id));

              let allValid = true;
              for(const item of acts1){
                const targetSlot = sStart2 + item.p;
                const r = this.getConflictsForSlot(item.act, targetSlot);
                if(!r.possible || r.conflicts.length > 0){ allValid = false; break; }
                this.placeActivityDirect(item.act.id, targetSlot);
              }

              if(allValid){
                for(const item of acts2){
                  const targetSlot = sStart1 + item.p;
                  const r = this.getConflictsForSlot(item.act, targetSlot);
                  if(!r.possible || r.conflicts.length > 0){ allValid = false; break; }
                  this.placeActivityDirect(item.act.id, targetSlot);
                }
              }

              if(allValid && this.isLessonBlockSafe(...acts1.map(x => x.act), ...acts2.map(x => x.act))){
                const m = this.evaluateMetrics();
                if(this.compareMetrics(m, currentBest, mode) < 0){
                  currentBest = { ...m };
                  anyImproved = true;
                  if(typeof onProgress === "function") onProgress(currentBest);
                  break;
                }
              }

              // Rollback
              acts1.forEach(item => this.unplaceActivity(item.act.id));
              acts2.forEach(item => this.unplaceActivity(item.act.id));
              acts1.forEach(item => this.placeActivityDirect(item.act.id, item.slot));
              acts2.forEach(item => this.placeActivityDirect(item.act.id, item.slot));
            }
            if(anyImproved) break;
          }
          if(anyImproved) break;
        }
        if(anyImproved) break;
      }
      return anyImproved ? currentBest : null;
    }

    // Direction 2: Related-Cluster Ruin & Recreate (Phá bỏ & Tái cấu trúc cụm giáo viên liên đới)
    tryRelatedClusterRuin(targetTeachers, bestMetrics, mode = "optimize_singletons", maxGap2Limit = Infinity, onProgress = null){
      const relatedTeachers = new Set(targetTeachers);
      targetTeachers.forEach(tKey => {
        const grid = this.teacherGrid.get(tKey);
        if(!grid) return;
        for(let s = 0; s < TOTAL_SLOTS; s++){
          const actId = grid[s];
          if(actId >= 0){
            const act = this.activities[actId];
            if(act && act.classId){
              const cGrid = this.classGrid.get(act.classId);
              if(cGrid){
                for(let s2 = 0; s2 < TOTAL_SLOTS; s2++){
                  const a2Id = cGrid[s2];
                  if(a2Id >= 0){
                    const a2 = this.activities[a2Id];
                    if(a2 && a2.gv && a2.duration === 1 && !a2.isFixed){
                      relatedTeachers.add(a2.gv);
                    }
                  }
                }
              }
            }
          }
        }
      });

      const chosen = Array.from(relatedTeachers);
      this.rng.shuffle(chosen);
      const sample = chosen.slice(0, Math.min(3, chosen.length));
      return this.tryLnsRuinAndRecreate(sample, bestMetrics, mode, maxGap2Limit, onProgress);
    }

    // Direction 3: Deep 4-Way Ejection Chain (Chuỗi đẩy 4 cấp tối ưu tốc độ)
    tryDeepEjectionChain(targetTeachers, bestMetrics, mode = "optimize_singletons", onProgress = null){
      let currentBest = { ...bestMetrics };
      let anyImproved = false;

      for(const tKey of targetTeachers){
        const grid = this.teacherGrid.get(tKey);
        if(!grid) continue;

        // Find teacher's active slots
        const tSlots = [];
        for(let s = 0; s < TOTAL_SLOTS; s++){
          const aId = grid[s];
          if(aId >= 0){
            const act = this.activities[aId];
            if(act && !act.isFixed && act.duration === 1) tSlots.push({ s, act });
          }
        }

        for(const item1 of tSlots){
          const s1 = item1.s;
          const act1 = item1.act;
          const cGrid1 = this.classGrid.get(act1.classId);
          if(!cGrid1) continue;

          // Step 1: Candidate s2 slots in class 1
          const cand2 = [];
          for(let s2 = 0; s2 < TOTAL_SLOTS; s2++){
            if(s2 === s1 || this.offSlots.has(`${act1.classId}|${s2}`)) continue;
            const a2Id = cGrid1[s2];
            if(a2Id < 0) continue;
            const act2 = this.activities[a2Id];
            if(!act2 || act2.isFixed || act2.duration !== 1) continue;
            const tGrid1 = this.teacherGrid.get(act1.gv);
            if(tGrid1 && tGrid1[s2] >= 0 && tGrid1[s2] !== act1.id) continue;
            cand2.push({ s2, act2 });
            if(cand2.length >= 3) break;
          }

          for(const item2 of cand2){
            const s2 = item2.s2;
            const act2 = item2.act2;
            const cGrid2 = this.classGrid.get(act2.classId);
            if(!cGrid2) continue;

            // Step 2: Candidate s3 slots in class 2
            const cand3 = [];
            for(let s3 = 0; s3 < TOTAL_SLOTS; s3++){
              if(s3 === s2 || s3 === s1 || this.offSlots.has(`${act2.classId}|${s3}`)) continue;
              const a3Id = cGrid2[s3];
              if(a3Id < 0) continue;
              const act3 = this.activities[a3Id];
              if(!act3 || act3.isFixed || act3.duration !== 1) continue;
              const tGrid2 = this.teacherGrid.get(act2.gv);
              if(tGrid2 && tGrid2[s3] >= 0 && tGrid2[s3] !== act2.id) continue;
              cand3.push({ s3, act3 });
              if(cand3.length >= 3) break;
            }

            for(const item3 of cand3){
              const s3 = item3.s3;
              const act3 = item3.act3;
              const cGrid3 = this.classGrid.get(act3.classId);
              if(!cGrid3) continue;

              // Step 3: Candidate s4 slots in class 3 that can cycle back to s1
              let checked4 = 0;
              for(let s4 = 0; s4 < TOTAL_SLOTS; s4++){
                if(s4 === s3 || s4 === s2 || s4 === s1 || this.offSlots.has(`${act3.classId}|${s4}`)) continue;
                const a4Id = cGrid3[s4];
                if(a4Id < 0) continue;
                const act4 = this.activities[a4Id];
                if(!act4 || act4.isFixed || act4.duration !== 1) continue;
                const tGrid3 = this.teacherGrid.get(act3.gv);
                if(tGrid3 && tGrid3[s4] >= 0 && tGrid3[s4] !== act3.id) continue;
                const tGrid4 = this.teacherGrid.get(act4.gv);
                if(tGrid4 && tGrid4[s1] >= 0 && tGrid4[s1] !== act4.id) continue;

                checked4++;
                if(checked4 > 3) break;

                // Test 4-way cyclic placement
                this.unplaceActivity(act1.id);
                this.unplaceActivity(act2.id);
                this.unplaceActivity(act3.id);
                this.unplaceActivity(act4.id);

                const r1 = this.getConflictsForSlot(act1, s2);
                const r2 = this.getConflictsForSlot(act2, s3);
                const r3 = this.getConflictsForSlot(act3, s4);
                const r4 = this.getConflictsForSlot(act4, s1);

                if(r1.possible && r1.conflicts.length === 0 &&
                   r2.possible && r2.conflicts.length === 0 &&
                   r3.possible && r3.conflicts.length === 0 &&
                   r4.possible && r4.conflicts.length === 0){
                  this.placeActivityDirect(act1.id, s2);
                  this.placeActivityDirect(act2.id, s3);
                  this.placeActivityDirect(act3.id, s4);
                  this.placeActivityDirect(act4.id, s1);

                  if(this.isLessonBlockSafe(act1, act2, act3, act4) && this.isLessonBlockSafe()){
                    const m = this.evaluateMetrics();
                    if(this.compareMetrics(m, currentBest, mode) < 0){
                      currentBest = { ...m };
                      anyImproved = true;
                      if(typeof onProgress === "function") onProgress(currentBest);
                      break;
                    }
                  }
                  this.unplaceActivity(act1.id);
                  this.unplaceActivity(act2.id);
                  this.unplaceActivity(act3.id);
                  this.unplaceActivity(act4.id);
                }
                this.placeActivityDirect(act1.id, s1);
                this.placeActivityDirect(act2.id, s2);
                this.placeActivityDirect(act3.id, s3);
                this.placeActivityDirect(act4.id, s4);
              }
              if(anyImproved) break;
            }
            if(anyImproved) break;
          }
          if(anyImproved) break;
        }
        if(anyImproved) break;
      }
      return anyImproved ? currentBest : null;
    }

    // Direction 4: Neutral Plateau Random Walk (Bước đi ngang vượt qua yên ngựa)
    tryNeutralPlateauWalk(steps = 8, bestMetrics, mode = "optimize_singletons", onProgress = null){
      const snapPlacement = this.actPlacement.slice();
      const snapClass = new Map();
      this.classGrid.forEach((arr, cid) => snapClass.set(cid, arr.slice()));
      const snapTeacher = new Map();
      this.teacherGrid.forEach((arr, gv) => snapTeacher.set(gv, arr.slice()));
      const snapRoom = new Map();
      this.roomGrid.forEach((arr, rm) => snapRoom.set(rm, arr.slice()));

      let currentBest = { ...bestMetrics };
      let anyImproved = false;

      for(let step = 0; step < steps; step++){
        const actList = this.activities.filter(a => a.duration === 1 && !a.isFixed && this.actPlacement[a.id] >= 0);
        if(actList.length === 0) break;
        const act1 = actList[Math.floor(this.rng.next() * actList.length)];
        const s1 = this.actPlacement[act1.id];
        const cGrid1 = this.classGrid.get(act1.classId);
        if(!cGrid1) continue;

        const s2 = Math.floor(this.rng.next() * 60);
        if(s2 === s1 || this.offSlots.has(`${act1.classId}|${s2}`)) continue;

        const a2Id = cGrid1[s2];
        if(a2Id === -2 || a2Id === -3 || this.fixedSlots.has(`${act1.classId}|${s2}`)) continue;

        if(a2Id < 0){
          this.unplaceActivity(act1.id);
          const r = this.getConflictsForSlot(act1, s2);
          if(r.possible && r.conflicts.length === 0){
            this.placeActivityDirect(act1.id, s2);
            if(this.isLessonBlockSafe(act1)){
              const m = this.evaluateMetrics();
              const comp = this.compareMetrics(m, currentBest, mode);
              if(comp < 0 && this.isLessonBlockSafe()){
                currentBest = { ...m };
                anyImproved = true;
                if(typeof onProgress === "function") onProgress(currentBest);
                break;
              }else if(comp === 0 && this.isLessonBlockSafe(act1)){
                continue; // Keep valid neutral move to traverse plateau
              }
            }
            this.unplaceActivity(act1.id);
          }
          this.placeActivityDirect(act1.id, s1);
        }else{
          const act2 = this.activities[a2Id];
          if(!act2 || act2.isFixed || act2.duration !== 1 || this.fixedSlots.has(`${act2.classId}|${s1}`)) continue;
          this.unplaceActivity(act1.id);
          this.unplaceActivity(act2.id);

          const r1 = this.getConflictsForSlot(act1, s2);
          const r2 = this.getConflictsForSlot(act2, s1);
          if(r1.possible && r1.conflicts.length === 0 && r2.possible && r2.conflicts.length === 0){
            this.placeActivityDirect(act1.id, s2);
            this.placeActivityDirect(act2.id, s1);
            if(this.isLessonBlockSafe(act1, act2)){
              const m = this.evaluateMetrics();
              const comp = this.compareMetrics(m, currentBest, mode);
              if(comp < 0 && this.isLessonBlockSafe()){
                currentBest = { ...m };
                anyImproved = true;
                if(typeof onProgress === "function") onProgress(currentBest);
                break;
              }else if(comp === 0 && this.isLessonBlockSafe(act1, act2)){
                continue; // Keep valid neutral move to traverse plateau
              }
            }
            this.unplaceActivity(act1.id);
            this.unplaceActivity(act2.id);
          }
          this.placeActivityDirect(act1.id, s1);
          this.placeActivityDirect(act2.id, s2);
        }
      }

      if(!anyImproved){
        this.actPlacement = snapPlacement;
        this.classGrid = snapClass;
        this.teacherGrid = snapTeacher;
        this.roomGrid = snapRoom;
        return null;
      }
      return currentBest;
    }

    // Powerful, time-budgeted asynchronous multi-pass optimizer with Multi-Directional Escape Architecture
    async optimize(mode = "optimize_singletons", progressCallback = null){
      this.loadExistingSchedule();
      // Sửa trùng lịch/tiết đè ô cố định TRƯỚC khi đo đạc: dữ liệu vào hỏng sẽ
      // làm integrity gate (đã mở rộng) từ chối mọi nước đi của operator.
      this.repairHardConflicts();
      const initialMetrics = this.evaluateMetrics();
      this.initialMetricsSnapshot = { ...initialMetrics };
      const initialStateSnap = this.captureStateSnapshot(); // gốc cho restart đa dạng hóa
      this.__globalBestM = null;
      this.__globalBestSnap = null;
      let bestMetrics = { ...initialMetrics };
      let bestPlacement = this.actPlacement.slice();
      let bestClassGrid = new Map();
      this.classGrid.forEach((arr, cid) => bestClassGrid.set(cid, arr.slice()));
      let bestTeacherGrid = new Map();
      this.teacherGrid.forEach((arr, gv) => bestTeacherGrid.set(gv, arr.slice()));
      let bestRoomGrid = new Map();
      this.roomGrid.forEach((arr, rm) => bestRoomGrid.set(rm, arr.slice()));

      // Elite archive of diverse promising configurations
      const eliteArchive = [{
        metrics: { ...initialMetrics },
        placement: this.actPlacement.slice(),
        classGrid: new Map(Array.from(this.classGrid.entries()).map(([k, v]) => [k, v.slice()])),
        teacherGrid: new Map(Array.from(this.teacherGrid.entries()).map(([k, v]) => [k, v.slice()])),
        roomGrid: new Map(Array.from(this.roomGrid.entries()).map(([k, v]) => [k, v.slice()]))
      }];

      const saveBestSnapshot = () => {
        bestPlacement = this.actPlacement.slice();
        bestClassGrid = new Map();
        this.classGrid.forEach((arr, cid) => bestClassGrid.set(cid, arr.slice()));
        bestTeacherGrid = new Map();
        this.teacherGrid.forEach((arr, gv) => bestTeacherGrid.set(gv, arr.slice()));
        bestRoomGrid = new Map();
        this.roomGrid.forEach((arr, rm) => bestRoomGrid.set(rm, arr.slice()));

        // Keep up to 3 elite snapshots
        if(eliteArchive.length < 3 || this.compareMetrics(bestMetrics, eliteArchive[0].metrics, mode) < 0){
          eliteArchive.unshift({
            metrics: { ...bestMetrics },
            placement: bestPlacement.slice(),
            classGrid: new Map(Array.from(bestClassGrid.entries()).map(([k, v]) => [k, v.slice()])),
            teacherGrid: new Map(Array.from(bestTeacherGrid.entries()).map(([k, v]) => [k, v.slice()])),
            roomGrid: new Map(Array.from(bestRoomGrid.entries()).map(([k, v]) => [k, v.slice()]))
          });
          if(eliteArchive.length > 3) eliteArchive.pop();
        }

        // Gấp best của lượt chạy vào GLOBAL BEST (xuyên các restart) + neo
        // checkpoint: mọi snapshot gửi ra ngoài từ đây là global best.
        if(!this.__globalBestM || this.compareMetrics(bestMetrics, this.__globalBestM, mode) < 0){
          this.__globalBestM = { ...bestMetrics };
          this.__globalBestSnap = {
            placement: bestPlacement,
            classGrid: bestClassGrid,
            teacherGrid: bestTeacherGrid,
            roomGrid: bestRoomGrid
          };
          this.checkpointGuard = this.__globalBestSnap;
        }
      };

      const getMetricVal = (m) => {
        if(mode === "optimize_singletons") return m.soBuoiDay1;
        if(mode === "optimize_sessions") return m.tsBuoiDay;
        if(mode === "optimize_gap2") return m.soBuoiTrong2;
        if(mode === "optimize_gap1") return m.soBuoiTrong1;
        return m.soBuoiDay1;
      };

      const notifyLiveProgress = (metrics) => {
        // UI luôn thấy tiến độ ĐƠN ĐIỆU: nếu lượt hiện tại là bước đa dạng hóa
        // (tạm xấu hơn), hiển thị global best thay vì bước dò đường.
        const shown = (this.__globalBestM && this.compareMetrics(this.__globalBestM, metrics, mode) < 0) ? this.__globalBestM : metrics;
        const currentVal = getMetricVal(shown);
        const initialVal = getMetricVal(initialMetrics);
        const pct = Math.min(99, Math.round(((round + 1) / MAX_ROUNDS) * 100));
        if(progressCallback){
          progressCallback({
            percent: pct,
            currentMetric: currentVal,
            initialMetric: initialVal,
            metrics: shown
          });
        }
      };

      if(progressCallback){
        progressCallback({
          percent: 0,
          currentMetric: getMetricVal(bestMetrics),
          initialMetric: getMetricVal(initialMetrics),
          metrics: bestMetrics
        });
      }

      const MAX_ROUNDS = (mode === "optimize_singletons") ? 65 : ((mode === "optimize_gap2") ? 28 : 55);
      let consecutiveUnimprovedRounds = 0;
      const maxStagnantRounds = (mode === "optimize_singletons") ? 25 : ((mode === "optimize_gap2") ? 8 : 18);
      let destroyStrength = 1;
      let round = 0;

      // PORTFOLIO RESTART (gap2/gap1): quan sát thực nghiệm — mỗi pha RNG "mở"
      // được các ca kẹt KHÁC NHAU (seed 101 còn 5, seed 303 còn 2...). Chạy lại
      // từ best với pha mới trong cùng một lần bấm sẽ gộp chiến quả của nhiều
      // seed: ca nào từng có lời giải ở một pha nào đó rồi sẽ được giữ qua best.
      const optStartMs = Date.now();
      // Trong optimizeAll các lát cắt stage ngắn — portfolio sẽ phí lát vào
      // bước đa dạng hóa rồi bị deadline chém; ở đó tắt portfolio (optimizeAll
      // tự chạy quét gap2 trọn ngân sách ở bước chốt).
      const canRestart = !this.__inOptimizeAll &&
        (mode === "optimize_gap2" || mode === "optimize_gap1" || mode === "optimize_singletons");
      // Mốc dừng của portfolio: nút 1 tiết/buổi mặc định dừng ở sàn 2 (trừ khi
      // pushToZero) — không xoay vòng vô ích khi đã chạm sàn.
      const restartTargetVal = (mode === "optimize_singletons" && !this.pushToZero) ? 2 : 0;
      const restartBudgetMs = Number(this.options.optimizeRestartBudgetMs) || 180000;
      const maxRestarts = Number(this.options.optimizeMaxRestarts) || 20;
      // TRẦN THỜI GIAN CỨNG cho một lần bấm nút: một số operator quét brute-force
      // rất nặng — không có trần, một lượt 45 vòng có thể chạy hàng giờ. Trần này
      // chém giữa các vòng VÀ chặn operator mới khởi động khi quá hạn (opDeadlineMs
      // được wrapper integrity kiểm tra). Kết quả luôn là best đã qua kiểm định.
      const hardCapMs = Number(this.options.optimizeHardCapMs) || 240000;
      this.opDeadlineMs = this.stageDeadlineMs || (optStartMs + hardCapMs);
      let restartCount = 0;
      let portfolioDone = false;

      while(!portfolioDone){
      portfolioDone = true;

      for(round = 0; round < MAX_ROUNDS; round++){
        if(typeof window !== "undefined" && window.__AUTO_SORT_STOP_REQUESTED) break;
        if(this.stageDeadlineMs && Date.now() > this.stageDeadlineMs) break;
        if(Date.now() - optStartMs > hardCapMs) break;

        let improvedInRound = false;
        // Breathing room only matters on the UI thread; workers pass 0.
        const breatheMs = Number.isFinite(Number(this.options.uiBreathingMs)) ? Number(this.options.uiBreathingMs) : 25;
        if(breatheMs > 0) await new Promise(resolve => setTimeout(resolve, breatheMs));

        // 1. Primary Downhill Optimization Passes
        if(mode === "optimize_singletons"){
          const oblitM = this.obliterateAllTeacherSingletons(12, Infinity, notifyLiveProgress);
          if(oblitM && this.compareMetrics(oblitM, bestMetrics, mode) < 0){
            bestMetrics = { ...oblitM };
            saveBestSnapshot();
            improvedInRound = true;
            destroyStrength = 1;
          }

          const resReinforce = this.tryReinforceTeacherSingletons(bestMetrics, initialMetrics, Infinity, notifyLiveProgress);
          if(resReinforce && this.compareMetrics(resReinforce, bestMetrics, mode) < 0){
            bestMetrics = { ...resReinforce };
            saveBestSnapshot();
            improvedInRound = true;
            destroyStrength = 1;
          }

          const resSingle = this.tryConsolidateTeacherSingletons(bestMetrics, initialMetrics, Infinity, notifyLiveProgress);
          if(resSingle && this.compareMetrics(resSingle, bestMetrics, mode) < 0){
            bestMetrics = { ...resSingle };
            saveBestSnapshot();
            improvedInRound = true;
            destroyStrength = 1;
          }
        }

        if(mode === "optimize_sessions"){
          const resVacate = this.tryVacateTeacherSessions(bestMetrics, initialMetrics, Infinity, notifyLiveProgress);
          if(resVacate && this.compareMetrics(resVacate, bestMetrics, mode) < 0){
            bestMetrics = { ...resVacate };
            saveBestSnapshot();
            improvedInRound = true;
          }

          const thinSessions = [];
          this.teacherGrid.forEach((tGrid, tKey) => {
            if(!tKey || !this.isScoredTeacher(tKey)) return;
            for(let d = 0; d < DAYS_LIST.length; d++){
              for(let b = 0; b < SESSIONS_LIST.length; b++){
                const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
                let cnt = 0;
                for(let p = 0; p < PERIODS_PER_SESSION; p++){
                  if(tGrid[sStart + p] >= 0 || tGrid[sStart + p] === -3) cnt++;
                }
                if(cnt === 1 || cnt === 2) thinSessions.push({ tKey, d, b, cnt });
              }
            }
          });
          this.rng.shuffle(thinSessions);
          thinSessions.sort((x, y) => x.cnt - y.cnt);

          for(const s of thinSessions.slice(0, 30)){
            const res = this.tryVacateTeacherSession(s.tKey, s.d, s.b, bestMetrics, initialMetrics);
            if(res && this.compareMetrics(res, bestMetrics, mode) < 0){
              bestMetrics = { ...res };
              saveBestSnapshot();
              improvedInRound = true;
              break;
            }
          }

          const oblitThin = this.obliterateAllThinTeacherSessions(8, [1, 2], Infinity, notifyLiveProgress);
          if(oblitThin && this.compareMetrics(oblitThin, bestMetrics, mode) < 0){
            bestMetrics = { ...oblitThin };
            saveBestSnapshot();
            improvedInRound = true;
          }

          const oblitM = this.obliterateAllTeacherSingletons(8, Infinity, notifyLiveProgress);
          if(oblitM && this.compareMetrics(oblitM, bestMetrics, mode) < 0){
            bestMetrics = { ...oblitM };
            saveBestSnapshot();
            improvedInRound = true;
          }

          const resSingle = this.tryConsolidateTeacherSingletons(bestMetrics, initialMetrics, Infinity, notifyLiveProgress);
          if(resSingle && this.compareMetrics(resSingle, bestMetrics, mode) < 0){
            bestMetrics = { ...resSingle };
            saveBestSnapshot();
            improvedInRound = true;
          }
        }

        if(mode === "optimize_gap2"){
          // Ngân sách buổi ĐỘNG (khôi phục kỷ luật cũ, giữ mức trần 20 của bản
          // hợp nhất): vòng đầu chưa được tiêu buổi — ép các nước hoán vị rẻ
          // trước; mở ngân sách khi qua 30% vòng hoặc kẹt 3 vòng liên tiếp.
          if(round >= Math.floor(MAX_ROUNDS * 0.3) || consecutiveUnimprovedRounds >= 3){
            this.gap2SessionBudget = this.options.gap2SessionBudget || 20;
          }else{
            this.gap2SessionBudget = 0;
          }

          // 8 operator quét-nặng (bản AI thứ hai) chỉ chạy Ở TÀN CUỘC (gap2 đã
          // nhỏ): lúc gap2 còn lớn chúng ngốn cả phút mỗi vòng làm portfolio
          // không xoay pha được — các operator rẻ phía dưới hạ 35 -> ~5 trong
          // vài giây, rồi bộ nặng vào kết liễu phần đuôi.
          // Op nặng: chỉ ở tàn cuộc thật (<=3) hoặc thỉnh thoảng khi kẹt (1/3 vòng)
          const heavyOpsOn = (bestMetrics.soBuoiTrong2 || 0) <= 3 || (consecutiveUnimprovedRounds >= 2 && round % 3 === 0);
          if(heavyOpsOn){
          const resBlockSwap = this.tryIntraClassSingleDoubleBlockSwap(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resBlockSwap && this.compareMetrics(resBlockSwap, bestMetrics, mode) < 0){
            bestMetrics = { ...resBlockSwap };
            saveBestSnapshot();
            improvedInRound = true;
          }
          const resRelaxRepair = this.tryRelaxAndRepairGapGaps(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resRelaxRepair && this.compareMetrics(resRelaxRepair, bestMetrics, mode) < 0){
            bestMetrics = { ...resRelaxRepair };
            saveBestSnapshot();
            improvedInRound = true;
          }
          const resCrushExtreme = this.tryCrushExtremeSpanGaps(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resCrushExtreme && this.compareMetrics(resCrushExtreme, bestMetrics, mode) < 0){
            bestMetrics = { ...resCrushExtreme };
            saveBestSnapshot();
            improvedInRound = true;
          }
          const resMergeSplit = this.tryMergeSameTeacherSplitPeriodsInSession(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resMergeSplit && this.compareMetrics(resMergeSplit, bestMetrics, mode) < 0){
            bestMetrics = { ...resMergeSplit };
            saveBestSnapshot();
            improvedInRound = true;
          }
          const resBorrowEarly = this.tryBorrowLessonFromRichSessions(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resBorrowEarly && this.compareMetrics(resBorrowEarly, bestMetrics, mode) < 0){
            bestMetrics = { ...resBorrowEarly };
            saveBestSnapshot();
            improvedInRound = true;
          }
          const resInterDayEarly = this.tryInterDayRelocateGapLesson(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resInterDayEarly && this.compareMetrics(resInterDayEarly, bestMetrics, mode) < 0){
            bestMetrics = { ...resInterDayEarly };
            saveBestSnapshot();
            improvedInRound = true;
          }
          const resBlockShiftEarly = this.tryBlockShiftAndGapResolution(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resBlockShiftEarly && this.compareMetrics(resBlockShiftEarly, bestMetrics, mode) < 0){
            bestMetrics = { ...resBlockShiftEarly };
            saveBestSnapshot();
            improvedInRound = true;
          }
          const resChainEarly = this.tryIntraSessionCrossClassChain(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resChainEarly && this.compareMetrics(resChainEarly, bestMetrics, mode) < 0){
            bestMetrics = { ...resChainEarly };
            saveBestSnapshot();
            improvedInRound = true;
          }
          }

          // 1. Forward Gap Crusher
          // 0a. Dissolve thin gap sessions (y tuong chu du an: tach tiet dap vao
          // buoi khac dang ton tai, khong hinh thanh buoi moi)
          const resDissolve = this.tryDissolveGapSession(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resDissolve && this.compareMetrics(resDissolve, bestMetrics, mode) < 0){
            bestMetrics = { ...resDissolve };
            saveBestSnapshot();
            improvedInRound = true;
          }

          // 0. Relabel ejection cycles (nuoc di chu luc hoc tu tham chieu)
          const resCycle = this.tryGapRelabelCycles(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resCycle && this.compareMetrics(resCycle, bestMetrics, mode) < 0){
            bestMetrics = { ...resCycle };
            saveBestSnapshot();
            improvedInRound = true;
          }

          const resGap = this.tryCrushTeacherGaps(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resGap && this.compareMetrics(resGap, bestMetrics, mode) < 0){
            bestMetrics = { ...resGap };
            saveBestSnapshot();
            improvedInRound = true;
          }

          // 2. Inbound Gap-Filler (De Xuat 3)
          const resFill = this.tryFillTeacherGapFromElsewhere(bestMetrics, initialMetrics, notifyLiveProgress);
          if(resFill && this.compareMetrics(resFill, bestMetrics, mode) < 0){
            bestMetrics = { ...resFill };
            saveBestSnapshot();
            improvedInRound = true;
          }

          // 3. Double Block Gap-Filler (De Xuat 4)
          const resDouble = this.tryMoveDoubleBlockIntoGap(bestMetrics, initialMetrics, notifyLiveProgress);
          if(resDouble && this.compareMetrics(resDouble, bestMetrics, mode) < 0){
            bestMetrics = { ...resDouble };
            saveBestSnapshot();
            improvedInRound = true;
          }

          // 3b. Eject-place: ép tiết biên vào lỗ bằng recursive swapping (FET)
          const resEject = this.tryEjectPlaceIntoGap(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resEject && this.compareMetrics(resEject, bestMetrics, mode) < 0){
            bestMetrics = { ...resEject };
            saveBestSnapshot();
            improvedInRound = true;
          }

          // 3c. Buổi mới (nới lỏng 17/08): dời trọn buổi gap2 kẹt sang nửa-ngày
          // giáo viên đang trống — cả cụm đi cùng nhau, không sinh buổi 1 tiết.
          const resReloc = this.tryRelocateGapSessionToNewDay(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resReloc && this.compareMetrics(resReloc, bestMetrics, mode) < 0){
            bestMetrics = { ...resReloc };
            saveBestSnapshot();
            improvedInRound = true;
          }

          // 3d. Ghép tiết lẻ vào lỗ (vế 1 hướng 17/08): kéo nguyên buổi mỏng /
          // cặp tiết mép về lấp >=2 lỗ CÙNG LÚC — nước ghép mà từng bước lẻ
          // không qua nổi gate ([1,5] lấp 1 lỗ vẫn là gap2).
          const resMerge = this.tryMergeSessionIntoGaps(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resMerge && this.compareMetrics(resMerge, bestMetrics, mode) < 0){
            bestMetrics = { ...resMerge };
            saveBestSnapshot();
            improvedInRound = true;
          }

          // 3e. Chuỗi Kempe hoán đổi 2 tiết trong buổi — nước phẫu thuật khi
          // kinh tế ô lớp bão hòa (mọi eject đều dồn gap sang người khác).
          const resKempe = this.tryKempeChainPeriodSwap(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resKempe && this.compareMetrics(resKempe, bestMetrics, mode) < 0){
            bestMetrics = { ...resKempe };
            saveBestSnapshot();
            improvedInRound = true;
          }

          // 3f. Đày tiết mép đi nơi khác bất kỳ (17/08: 1t khóa, còn lại tự do)
          const resExile = this.tryExileEdgeLesson(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resExile && this.compareMetrics(resExile, bestMetrics, mode) < 0){
            bestMetrics = { ...resExile };
            saveBestSnapshot();
            improvedInRound = true;
          }

          // 3f. Intra-Session Cross-Class Chain & 3-Cycle (Toi uu triet de gap2 khong sinh 1-tiet/buoi)
          const resChain2 = this.tryIntraSessionCrossClassChain(bestMetrics, initialMetrics, "optimize_gap2", notifyLiveProgress);
          if(resChain2 && this.compareMetrics(resChain2, bestMetrics, mode) < 0){
            bestMetrics = { ...resChain2 };
            saveBestSnapshot();
            improvedInRound = true;
          }

          // 4. Expanded Vacate on sessions with hasGap2 (De Xuat 1 + 5: bo idx.length <= 2, tang mau len 15-20 GV)
          const gapTeachers = [];
          this.teacherGrid.forEach((grid, tKey) => {
            if(!tKey || !this.isScoredTeacher(tKey)) return;
            const tm = this.evaluateTeacherMetrics(tKey);
            if(tm.soBuoiTrong2 > 0) gapTeachers.push(tKey);
          });
          if(gapTeachers.length > 0){
            this.rng.shuffle(gapTeachers);
            for(const tKey of gapTeachers.slice(0, 15)){
              for(let d = 0; d < DAYS_LIST.length; d++){
                for(let b = 0; b < SESSIONS_LIST.length; b++){
                  const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
                  const tGrid = this.teacherGrid.get(tKey);
                  let hasGap2 = false;
                  const idx = [];
                  for(let p = 0; p < PERIODS_PER_SESSION; p++){
                    if(tGrid[sStart + p] >= 0 || tGrid[sStart + p] === -3) idx.push(p);
                  }
                  if(idx.length >= 2){
                    // Span rule (khop UI): tong so lo trong buoi >= 2
                    const holes = (idx[idx.length - 1] - idx[0] + 1) - idx.length;
                    if(holes >= 2) hasGap2 = true;
                  }
                  if(hasGap2){
                    const resV = this.tryVacateTeacherSession(tKey, d, b, bestMetrics, initialMetrics, mode);
                    if(resV && this.compareMetrics(resV, bestMetrics, mode) < 0){
                      bestMetrics = { ...resV };
                      saveBestSnapshot();
                      improvedInRound = true;
                      break;
                    }
                  }
                }
                if(improvedInRound) break;
              }
              if(improvedInRound) break;
            }
          }
        }

        if(mode === "optimize_gap1"){
          const resCycle1 = this.tryGapRelabelCycles(bestMetrics, initialMetrics, "optimize_gap1", notifyLiveProgress);
          if(resCycle1 && this.compareMetrics(resCycle1, bestMetrics, mode) < 0){
            bestMetrics = { ...resCycle1 };
            saveBestSnapshot();
            improvedInRound = true;
          }

          const resGap = this.tryCrushTeacherGaps(bestMetrics, initialMetrics, "optimize_gap1", notifyLiveProgress);
          if(resGap && this.compareMetrics(resGap, bestMetrics, mode) < 0){
            bestMetrics = { ...resGap };
            saveBestSnapshot();
            improvedInRound = true;
          }

          const resEject1 = this.tryEjectPlaceIntoGap(bestMetrics, initialMetrics, "optimize_gap1", notifyLiveProgress);
          if(resEject1 && this.compareMetrics(resEject1, bestMetrics, mode) < 0){
            bestMetrics = { ...resEject1 };
            saveBestSnapshot();
            improvedInRound = true;
          }

          const resReloc1 = this.tryRelocateGapSessionToNewDay(bestMetrics, initialMetrics, "optimize_gap1", notifyLiveProgress);
          const resBorrow1 = this.tryBorrowLessonFromRichSessions(bestMetrics, initialMetrics, "optimize_gap1", notifyLiveProgress);
          if(resBorrow1 && this.compareMetrics(resBorrow1, bestMetrics, mode) < 0){
            bestMetrics = { ...resBorrow1 };
            saveBestSnapshot();
            improvedInRound = true;
          }
          if(resReloc1 && this.compareMetrics(resReloc1, bestMetrics, mode) < 0){
            bestMetrics = { ...resReloc1 };
            saveBestSnapshot();
            improvedInRound = true;
          }

          const resKempe1 = this.tryKempeChainPeriodSwap(bestMetrics, initialMetrics, "optimize_gap1", notifyLiveProgress);
          if(resKempe1 && this.compareMetrics(resKempe1, bestMetrics, mode) < 0){
            bestMetrics = { ...resKempe1 };
            saveBestSnapshot();
            improvedInRound = true;
          }
        }

        // =========================================================================
        // 2. MULTI-DIRECTIONAL ESCAPE ARCHITECTURE (KHI BỊ ĐỨNG / STAGNATION ESCAPE)
        // =========================================================================
        if(!improvedInRound){
          consecutiveUnimprovedRounds++;

          // Identify current bottleneck teachers
          const bottleneckTeachers = [];
          this.teacherGrid.forEach((grid, tKey) => {
            if(!tKey || !this.isScoredTeacher(tKey)) return;
            const tm = this.evaluateTeacherMetrics(tKey);
            if((mode === "optimize_singletons" && tm.soBuoiDay1 > 0) ||
               (mode === "optimize_sessions" && (tm.tsBuoiDay >= 4 || tm.soBuoiDay2 > 0 || tm.soBuoiDay3 > 0)) ||
               (mode === "optimize_gap2" && tm.soBuoiTrong2 > 0) ||
               (mode === "optimize_gap1" && tm.soBuoiTrong1 > 0)){
              bottleneckTeachers.push(tKey);
            }
          });
          this.rng.shuffle(bottleneckTeachers);

          // ESCAPE DIRECTION A: Whole-Session Block Swaps (Hoán đổi cụm buổi của lớp)
          if(consecutiveUnimprovedRounds % 4 === 1){
            const resBlock = this.tryWholeSessionSwap(bestMetrics, mode, notifyLiveProgress);
            if(resBlock && this.compareMetrics(resBlock, bestMetrics, mode) < 0){
              bestMetrics = { ...resBlock };
              saveBestSnapshot();
              improvedInRound = true;
              consecutiveUnimprovedRounds = 0;
            }
          }

          // ESCAPE DIRECTION B: Deep 4-Way Ejection Chains (Chuỗi đẩy liên hoàn 4 cấp)
          if(!improvedInRound && (consecutiveUnimprovedRounds % 4 === 2 || consecutiveUnimprovedRounds >= 5)){
            if(bottleneckTeachers.length > 0){
              const resChain = this.tryDeepEjectionChain(bottleneckTeachers.slice(0, 5), bestMetrics, mode, notifyLiveProgress);
              if(resChain && this.compareMetrics(resChain, bestMetrics, mode) < 0){
                bestMetrics = { ...resChain };
                saveBestSnapshot();
                improvedInRound = true;
                consecutiveUnimprovedRounds = 0;
              }
            }
          }

          // ESCAPE DIRECTION C: Related-Cluster Ruin & Recreate (Phá bỏ & Tái cấu trúc cụm liên đới)
          if(!improvedInRound && (consecutiveUnimprovedRounds % 4 === 3 || consecutiveUnimprovedRounds >= 6)){
            if(bottleneckTeachers.length > 0){
              const resCluster = this.tryRelatedClusterRuin(bottleneckTeachers.slice(0, 4), bestMetrics, mode, Infinity, notifyLiveProgress);
              if(resCluster && this.compareMetrics(resCluster, bestMetrics, mode) < 0){
                bestMetrics = { ...resCluster };
                saveBestSnapshot();
                improvedInRound = true;
                consecutiveUnimprovedRounds = 0;
              }
            }
          }

          // ESCAPE DIRECTION D: Neutral Plateau Random Walk (Bước đi ngang trên yên ngựa)
          if(!improvedInRound && consecutiveUnimprovedRounds >= 4 && consecutiveUnimprovedRounds % 3 === 0){
            const resWalk = this.tryNeutralPlateauWalk(12, bestMetrics, mode, notifyLiveProgress);
            if(resWalk && this.compareMetrics(resWalk, bestMetrics, mode) < 0){
              bestMetrics = { ...resWalk };
              saveBestSnapshot();
              improvedInRound = true;
              consecutiveUnimprovedRounds = 0;
            }
          }

          // ESCAPE DIRECTION E: Elite Archive Branching (Đổi sang nhánh tinh hoa khác khi bế tắc sâu)
          if(!improvedInRound && consecutiveUnimprovedRounds >= 10 && eliteArchive.length > 1){
            const altElite = eliteArchive[Math.floor(this.rng.next() * eliteArchive.length)];
            if(altElite){
              this.actPlacement = altElite.placement.slice();
              this.classGrid = new Map(Array.from(altElite.classGrid.entries()).map(([k, v]) => [k, v.slice()]));
              this.teacherGrid = new Map(Array.from(altElite.teacherGrid.entries()).map(([k, v]) => [k, v.slice()]));
              this.roomGrid = new Map(Array.from(altElite.roomGrid.entries()).map(([k, v]) => [k, v.slice()]));
              this.tryNeutralPlateauWalk(8, bestMetrics, mode, notifyLiveProgress);
            }
          }
        }else{
          consecutiveUnimprovedRounds = 0;
        }

        const pct = Math.min(99, Math.round(((round + 1) / MAX_ROUNDS) * 100));
        if(progressCallback){
          const shownM = (this.__globalBestM && this.compareMetrics(this.__globalBestM, bestMetrics, mode) < 0) ? this.__globalBestM : bestMetrics;
          progressCallback({
            percent: pct,
            currentMetric: getMetricVal(shownM),
            initialMetric: getMetricVal(initialMetrics),
            metrics: shownM
          });
        }

        if(mode === "optimize_singletons" && bestMetrics.soBuoiDay1 <= (this.pushToZero ? 0 : 2)){
          if(progressCallback){
            progressCallback({
              percent: 100,
              currentMetric: bestMetrics.soBuoiDay1,
              initialMetric: Math.max(1, getMetricVal(initialMetrics)),
              metrics: bestMetrics
            });
          }
          break;
        }

        if(getMetricVal(bestMetrics) === 0){
          if(progressCallback){
            progressCallback({
              percent: 100,
              currentMetric: getMetricVal(bestMetrics),
              initialMetric: Math.max(1, getMetricVal(initialMetrics)),
              metrics: bestMetrics
            });
          }
          break;
        }

        if(consecutiveUnimprovedRounds >= maxStagnantRounds){
          break; // khung 100% phát sau khi portfolio kết thúc thật sự
        }
      }

      // Quyết định restart: global best còn chỉ tiêu > 0, còn ngân sách thời
      // gian, chưa bị Dừng. Lượt LẺ đi lại TỪ GỐC với pha RNG mới (đa dạng hóa
      // — mỗi pha mở được các ca kẹt khác nhau), lượt CHẴN đi tiếp từ global
      // best (thâm canh). Kết quả cuối luôn là global best qua mọi lượt.
      const globalVal = this.__globalBestM ? getMetricVal(this.__globalBestM) : getMetricVal(bestMetrics);
      if(canRestart && globalVal > restartTargetVal && restartCount < maxRestarts &&
         (Date.now() - optStartMs) < Math.min(restartBudgetMs, hardCapMs) &&
         !(typeof window !== "undefined" && window.__AUTO_SORT_STOP_REQUESTED) &&
         !(this.stageDeadlineMs && Date.now() > this.stageDeadlineMs)){
        restartCount++;
        const diversify = (restartCount % 2 === 1);
        const src = (diversify || !this.__globalBestSnap) ? initialStateSnap : this.__globalBestSnap;
        this.restoreStateSnapshot(src);
        if(diversify){
          // ILS: lay chuyển trạng thái bằng các nước đi HỢP LỆ ngẫu nhiên trước
          // khi đổ dốc lại — bắt buộc khi "gốc" đã chính là một cực tiểu cục bộ
          // (trường hợp bước quét chốt của optimizeAll); không lay thì mọi
          // restart đều rơi lại đúng một lòng chảo và kẹt trong vài giây.
          this.perturbForRestart(6 + restartCount * 3);
        }
        bestMetrics = { ...this.evaluateMetrics() };
        bestPlacement = this.actPlacement.slice();
        bestClassGrid = new Map(Array.from(this.classGrid.entries()).map(([k, v]) => [k, v.slice()]));
        bestTeacherGrid = new Map(Array.from(this.teacherGrid.entries()).map(([k, v]) => [k, v.slice()]));
        bestRoomGrid = new Map(Array.from(this.roomGrid.entries()).map(([k, v]) => [k, v.slice()]));
        consecutiveUnimprovedRounds = 0;
        destroyStrength = 1;
        const spin = 97 + restartCount * 31;
        for(let i = 0; i < spin; i++) this.rng.next(); // xoay pha ngẫu nhiên
        portfolioDone = false;
      }
      } // while portfolio
      this.__lastRestartCount = restartCount; // chẩn đoán

      // Chốt: khôi phục GLOBAL BEST (nếu có) làm kết quả cuối.
      if(this.__globalBestSnap){
        bestPlacement = this.__globalBestSnap.placement;
        bestClassGrid = this.__globalBestSnap.classGrid;
        bestTeacherGrid = this.__globalBestSnap.teacherGrid;
        bestRoomGrid = this.__globalBestSnap.roomGrid;
        bestMetrics = { ...this.__globalBestM };
      }
      this.checkpointGuard = null;
      this.__globalBestSnap = null;
      this.__globalBestM = null;
      this.opDeadlineMs = 0;

      if(progressCallback){
        progressCallback({
          percent: 100,
          currentMetric: getMetricVal(bestMetrics),
          initialMetric: Math.max(1, getMetricVal(initialMetrics)),
          metrics: bestMetrics
        });
      }

      if(bestPlacement){
        this.actPlacement = bestPlacement;
        this.classGrid = bestClassGrid;
        this.teacherGrid = bestTeacherGrid;
        this.roomGrid = bestRoomGrid;
      }

      this.applyToDataTKB();

      let placed = 0;
      this.activities.forEach((act, idx) => {
        if(this.actPlacement[idx] >= 0) placed += act.duration;
      });
      placed += this.fixedSlots.size;

      return {
        ok: true,
        placed,
        unassigned: 0,
        initialMetrics,
        metrics: bestMetrics,
        residualSingletons: this.getResidualSingletons(),
        residualGap2: this.getResidualGap2Sessions()
      };
    }

    // =========================================================================
    // INTEGRITY GUARD (Optimizer v2)
    // Mọi trạng thái được chấp nhận phải nhất quán: actPlacement <-> classGrid
    // <-> teacherGrid. Một operator làm hỏng lưới (xếp đè, mất tiết) sẽ bị
    // khôi phục snapshot và coi như "không cải thiện" thay vì im lặng phá lịch.
    // =========================================================================
    // =========================================================================
    // SỬA TRÙNG LỊCH & TIẾT ĐÈ Ô CỐ ĐỊNH (yêu cầu chủ dự án 17/08)
    // Dữ liệu vào có thể đã hỏng sẵn (2 tiết cùng ô giáo viên, tiết nằm trên ô
    // OFF/cố định của lớp, giáo viên bị xếp vào buổi OFF của họ). Chạy NGAY khi
    // vào optimize/optimizeAll: nhấc toàn bộ tiết vi phạm ra rồi đặt lại bằng
    // recursive swapping (luôn qua getConflictsForSlot — không thể tái phạm).
    // =========================================================================
    repairHardConflicts(){
      const offenders = new Set();
      const teacherSeen = new Map();
      for(let id = 0; id < this.activities.length; id++){
        const act = this.activities[id];
        const slot = this.actPlacement[id];
        if(slot < 0) continue;
        for(let d = 0; d < (act.duration || 1); d++){
          const s = slot + d;
          if(this.offSlots.has(`${act.classId}|${s}`) || this.fixedSlots.has(`${act.classId}|${s}`)){
            if(!act.isFixed) offenders.add(id);
            continue;
          }
          if(act.gv){
            const tList = parseTeacherList(act.gv);
            for(const t of tList){
              if(this.teacherOffSlots && this.teacherOffSlots.has(`${t}|${s}`)){
                if(!act.isFixed) offenders.add(id);
                continue;
              }
              const tk = `${t}|${s}`;
              const prev = teacherSeen.get(tk);
              if(prev !== undefined && prev !== id){
                // trùng giáo viên: giữ tiết đứng trước (hoặc tiết cố định), nhấc tiết sau
                const prevAct = this.activities[prev];
                if(act.isFixed && prevAct && !prevAct.isFixed){ offenders.add(prev); }
                else if(!act.isFixed){ offenders.add(id); }
              }else{
                teacherSeen.set(tk, id);
              }
            }
          }
        }
      }
      // Tiết CHƯA PHÂN cũng phải xử lý ở đây: một tiết trùng lịch bị loader bỏ
      // qua sẽ nằm ở "chưa phân" — và chỉ MỘT tiết chưa phân đã làm integrity
      // gate từ chối mọi nước đi của optimizer (tê liệt toàn bộ nút Tối ưu).
      const unplaced = [];
      for(let id = 0; id < this.activities.length; id++){
        if(this.actPlacement[id] < 0 && !this.activities[id].isFixed) unplaced.push(id);
      }
      if(!offenders.size && !unplaced.length) return { repaired: 0, unresolved: 0 };

      // Nhấc hết vi phạm trước (giải phóng chỗ), rồi đặt lại từng tiết.
      for(const id of offenders) this.unplaceActivity(id);
      let repaired = 0, unresolved = 0;
      const savedCalls = this.limitCalls;
      const toPlace = Array.from(offenders).concat(unplaced.filter(id => !offenders.has(id)));
      // Đặt lại BIẾT GIỮ 1 TIẾT/BUỔI: ưu tiên đáp vào LỖ trong span hoặc NỐI
      // MÉP các buổi đang có của chính giáo viên đó (không sinh buổi lẻ mới);
      // chỉ khi hết đường mới thả tự do toàn dải.
      const preferredSlotsFor = (act) => {
        const out = [];
        if(!act.gv) return out;
        for(const t of parseTeacherList(act.gv)){
          const tg = this.teacherGrid.get(t);
          if(!tg) continue;
          for(let d2 = 0; d2 < DAYS_LIST.length; d2++){
            for(let b2 = 0; b2 < SESSIONS_LIST.length; b2++){
              const st = d2 * SLOTS_PER_DAY + b2 * PERIODS_PER_SESSION;
              const ps = [];
              for(let p = 0; p < PERIODS_PER_SESSION; p++){
                if(tg[st + p] >= 0 || tg[st + p] === -3) ps.push(p);
              }
              if(!ps.length) continue;
              const lo = ps[0], hi = ps[ps.length - 1];
              for(let p = 0; p < PERIODS_PER_SESSION; p++){
                if(tg[st + p] >= 0 || tg[st + p] === -2 || tg[st + p] === -3) continue;
                if((p > lo && p < hi) || p === lo - 1 || p === hi + 1) out.push(st + p);
              }
            }
          }
        }
        return out;
      };
      for(const id of toPlace){
        if(this.actPlacement[id] >= 0) continue;
        this.limitCalls = Math.max(savedCalls || 0, 30000);
        this.nCalls = 0;
        const preferred = preferredSlotsFor(this.activities[id]);
        let placedNow = false;
        if(preferred.length){
          placedNow = this.randomSwap(id, 0, preferred);
        }
        if(!placedNow){
          this.nCalls = 0;
          placedNow = this.randomSwap(id, 0);
        }
        if(placedNow){
          repaired++;
        }else if(typeof this.tryEjectionChain === "function" && this.tryEjectionChain(id) && this.actPlacement[id] >= 0){
          repaired++;
        }else{
          unresolved++;
        }
      }
      this.limitCalls = savedCalls;
      this.repairReport = { repaired, unresolved };
      return this.repairReport;
    }

    // ILS shake: n nước đi HỢP LỆ ngẫu nhiên (recursive swapping — ràng buộc
    // cứng luôn giữ) để thoát lòng chảo cực tiểu trước khi đổ dốc lại.
    perturbForRestart(nMoves){
      const snap = this.captureStateSnapshot();
      const ids = [];
      for(let i = 0; i < this.activities.length; i++){
        const a = this.activities[i];
        if(a && !a.isFixed && this.actPlacement[i] >= 0) ids.push(i);
      }
      if(!ids.length) return;
      const savedCalls = this.limitCalls;
      this.limitCalls = Math.max(this.limitCalls || 0, 3000);
      for(let k = 0; k < nMoves; k++){
        const id = ids[this.rng.nextInt(ids.length)];
        if(this.actPlacement[id] < 0) continue;
        this.nCalls = 0;
        const old = this.actPlacement[id];
        this.unplaceActivity(id);
        if(!this.randomSwap(id, 0)){
          this.placeActivityDirect(id, old);
        }
      }
      this.limitCalls = savedCalls;
      if(!this.verifyPlacementIntegrity()){
        this.restoreStateSnapshot(snap);
      }
    }

    captureStateSnapshot(){
      return {
        placement: this.actPlacement.slice(),
        classGrid: new Map(Array.from(this.classGrid.entries()).map(([k, v]) => [k, v.slice()])),
        teacherGrid: new Map(Array.from(this.teacherGrid.entries()).map(([k, v]) => [k, v.slice()])),
        roomGrid: new Map(Array.from(this.roomGrid.entries()).map(([k, v]) => [k, v.slice()]))
      };
    }

    restoreStateSnapshot(snap){
      this.actPlacement = snap.placement.slice();
      this.classGrid = new Map(Array.from(snap.classGrid.entries()).map(([k, v]) => [k, v.slice()]));
      this.teacherGrid = new Map(Array.from(snap.teacherGrid.entries()).map(([k, v]) => [k, v.slice()]));
      this.roomGrid = new Map(Array.from(snap.roomGrid.entries()).map(([k, v]) => [k, v.slice()]));
    }

    verifyPlacementIntegrity(){
      // Lưới an toàn mở rộng 17/08: ngoài nhất quán lớp, soi cả (1) TRÙNG GIÁO
      // VIÊN (2 tiết khác nhau cùng ô giáo viên — placeActivityDirect ghi đè
      // teacherGrid nên lỗi này trước đây vô hình với gate), (2) tiết nằm trên
      // Ô CỐ ĐỊNH/OFF của lớp, (3) giáo viên bị xếp vào ô OFF của chính họ.
      const teacherSeen = new Map();
      for(let id = 0; id < this.activities.length; id++){
        const act = this.activities[id];
        const slot = this.actPlacement[id];
        if(slot < 0) return false; // optimizer must never drop a lesson
        const cg = this.classGrid.get(act.classId);
        if(!cg) return false;
        for(let d = 0; d < act.duration; d++){
          const s = slot + d;
          if(cg[s] !== id) return false;
          if(this.offSlots.has(`${act.classId}|${s}`)) return false;    // đè ô OFF lớp
          if(this.fixedSlots.has(`${act.classId}|${s}`)) return false;  // đè ô cố định lớp
          if(act.gv){
            const tList = parseTeacherList(act.gv);
            for(const t of tList){
              if(this.teacherOffSlots && this.teacherOffSlots.has(`${t}|${s}`)) return false;
              const tk = `${t}|${s}`;
              const prev = teacherSeen.get(tk);
              if(prev !== undefined && prev !== id) return false;       // TRÙNG GIÁO VIÊN
              teacherSeen.set(tk, id);
            }
          }
        }
      }
      const seen = new Map();
      let covered = 0;
      this.classGrid.forEach(g => {
        for(let s = 0; s < g.length; s++){
          const v = g[s];
          if(v >= 0){
            covered++;
            const act = this.activities[v];
            const p = this.actPlacement[v];
            if(!act || p < 0 || s < p || s >= p + act.duration) { seen.set("orphan", true); }
          }
        }
      });
      if(seen.has("orphan")) return false;
      const placedPeriods = this.activities.reduce((sum, a, id) => sum + (this.actPlacement[id] >= 0 ? a.duration : 0), 0);
      return covered === placedPeriods;
    }

    // =========================================================================
    // OPTIMIZER V2 (docs/OPTIMIZER_V2_PLAN.md)
    // Mot thu tu uu tien lexicographic duy nhat cho toan he thong:
    //   du tiet + hard-valid  >  buoi 1 tiet  >  trong >=2  >  tong buoi  >  trong 1  >  tong ngay
    // compareTuple la "dinh nghia tot hon" chung; optimizeAll la controller
    // round-robin co ngan sach tung stage + stagnation detection + early-exit.
    // =========================================================================
    compareTuple(a, b){
      if(!a) return 1;
      if(!b) return -1;
      return (a.soBuoiDay1 - b.soBuoiDay1)
        || (a.soBuoiTrong2 - b.soBuoiTrong2)
        || (a.tsBuoiDay - b.tsBuoiDay)
        || (a.soBuoiTrong1 - b.soBuoiTrong1)
        || (a.tsNgayDay - b.tsNgayDay);
    }

    async optimizeAll(progressCallback = null){
      const STAGES = ["optimize_singletons", "optimize_gap2", "optimize_sessions", "optimize_gap1"];
      const totalBudgetMs = Math.max(20_000, Number(this.options.optimizeAllBudgetMs) || 150_000);
      const minStageSliceMs = Math.max(3_000, Number(this.options.optimizeAllMinStageMs) || 8_000);
      const MAX_CYCLES = Math.max(1, Number(this.options.optimizeAllMaxCycles) || 3);
      const startedAt = Date.now();
      const deadline = startedAt + totalBudgetMs;
      // Dành riêng phần cuối ngân sách cho BƯỚC QUÉT GAP2 CHỐT (portfolio đầy
      // đủ của nút "2 tiết trống") — các stage không được ăn hết thời gian.
      const sweepReserveMs = Math.min(90_000, Math.floor(totalBudgetMs * 0.35));
      const stagesDeadline = deadline - sweepReserveMs;

      const stopRequested = () => typeof window !== "undefined" && window.__AUTO_SORT_STOP_REQUESTED;
      const focusValue = (m, mode) => {
        if(mode === "optimize_singletons") return m.soBuoiDay1;
        if(mode === "optimize_gap2") return m.soBuoiTrong2;
        if(mode === "optimize_sessions") return m.tsBuoiDay;
        return m.soBuoiTrong1;
      };

      this.loadExistingSchedule();
      this.repairHardConflicts(); // sửa trùng lịch/tiết đè ô cố định trước khi đo
      const initialMetrics = this.evaluateMetrics();
      const initialTkb = this.getSnapshotTKB();
      let bestMetrics = { ...initialMetrics };
      let bestTkb = this.getSnapshotTKB();
      const stages = [];
      this.__inOptimizeAll = true; // tắt portfolio trong các lát stage
      // Multi-restart portfolio: different rng seeds explore very different
      // basins (observed spread e.g. 410 vs 482 sessions on the same input).
      // Extra restarts run only while budget remains.
      const maxRestarts = Math.max(1, Number(this.options.optimizeAllRestarts) || 1);
      const baseSeed = Number(this.options.seed) || 12345;

      restartLoop:
      for(let restart = 0; restart < maxRestarts; restart++){
        if(stopRequested()) break;
        if(restart > 0){
          // Need enough budget for a meaningful second pass.
          if(stagesDeadline - Date.now() < Math.max(30_000, totalBudgetMs * 0.25)) break;
          this.data.tkb = JSON.parse(JSON.stringify(initialTkb));
          this.loadExistingSchedule();
          this.rng = new FetPRNG(baseSeed + restart * 7919);
        }
        const settled = new Set();
        let restartBest = { ...this.evaluateMetrics() };
        let restartBestTkb = this.getSnapshotTKB();

        outer:
        for(let cycle = 0; cycle < MAX_CYCLES; cycle++){
          let improvedInCycle = false;
          for(let si = 0; si < STAGES.length; si++){
            const mode = STAGES[si];
            if(settled.has(mode)) continue;
            if(stopRequested()) break outer;
            const remainingMs = stagesDeadline - Date.now();
            if(remainingMs <= minStageSliceMs / 2) break outer;
            const stagesLeft = STAGES.slice(si).filter(m => !settled.has(m)).length;
            const restartShare = maxRestarts - restart;
            const stageWeight = mode === "optimize_sessions" ? 0.5 : 1; // chủ dự án: hạ 1 tiết/buổi + trống-2 trước, giảm buổi sau
            const sliceMs = Math.max(minStageSliceMs, Math.floor(stageWeight * remainingMs / Math.max(1, restartShare * (stagesLeft + (MAX_CYCLES - 1 - cycle) * STAGES.length * 0.5))));

            this.stageDeadlineMs = Math.min(stagesDeadline, Date.now() + sliceMs);
            this.pushToZero = true;
            const before = { ...restartBest };
            const t0 = Date.now();
            let res = null;
            try{
              res = await this.optimize(mode, progressCallback ? (p) => {
                progressCallback({ ...p, stage: mode, stageIndex: si, cycle, restart, totalStages: STAGES.length });
              } : null);
            }finally{
              this.stageDeadlineMs = 0;
            }
            const after = res && res.metrics ? { ...res.metrics } : this.evaluateMetrics();

            let exitReason = "stagnation-or-budget";
            const cmp = this.compareTuple(after, restartBest);
            if(cmp < 0){
              restartBest = { ...after };
              restartBestTkb = this.getSnapshotTKB();
              improvedInCycle = true;
              exitReason = "improved";
            }else if(cmp > 0){
              this.data.tkb = JSON.parse(JSON.stringify(restartBestTkb));
              exitReason = "rolled-back";
            }
            // Track the global best across restarts.
            if(this.compareTuple(restartBest, bestMetrics) < 0){
              bestMetrics = { ...restartBest };
              bestTkb = JSON.parse(JSON.stringify(restartBestTkb));
            }
            if((mode === "optimize_singletons" || mode === "optimize_gap2") && focusValue(restartBest, mode) === 0){
              settled.add(mode);
              exitReason = "target-zero";
            }
            // Re-open settled zero-target stages if a later stage reintroduced
            // their metric (e.g. session compaction creating a fresh gap2).
            if(settled.has("optimize_gap2") && restartBest.soBuoiTrong2 > 0) settled.delete("optimize_gap2");
            if(settled.has("optimize_singletons") && restartBest.soBuoiDay1 > 0) settled.delete("optimize_singletons");
            stages.push({ mode, cycle, restart, ms: Date.now() - t0, before, after: { ...restartBest }, exitReason });
          }
          if(!improvedInCycle) break;
        }
      }

      // ============ BƯỚC CHỐT: QUÉT XEN KẼ 1TIẾT → GAP2 HẾT NGÂN SÁCH =========
      // Các stage đã hội tụ → dùng trọn thời gian còn dư chạy đúng cỗ máy của
      // các NÚT lẻ (portfolio đa dạng hóa/thâm canh): ưu tiên 1 tiết/buổi về
      // cực tiểu trước, rồi trống-2 về 0 (mode gap2 giữ nguyên 1 tiết/buổi).
      this.__inOptimizeAll = false;
      const runSweep = async (sweepMode, budgetMs) => {
        this.data.tkb = JSON.parse(JSON.stringify(bestTkb));
        this.loadExistingSchedule();
        const savedBudget = this.options.optimizeRestartBudgetMs;
        const savedRestarts = this.options.optimizeMaxRestarts;
        this.options.optimizeRestartBudgetMs = budgetMs;
        this.options.optimizeMaxRestarts = 24;
        this.pushToZero = true;
        const t0 = Date.now();
        let sweepRes = null;
        try{
          sweepRes = await this.optimize(sweepMode, progressCallback ? (p) => {
            progressCallback({ ...p, stage: sweepMode, stageIndex: Math.max(0, STAGES.indexOf(sweepMode)), cycle: MAX_CYCLES, restart: maxRestarts, totalStages: STAGES.length });
          } : null);
        }finally{
          this.options.optimizeRestartBudgetMs = savedBudget;
          this.options.optimizeMaxRestarts = savedRestarts;
        }
        const after = sweepRes && sweepRes.metrics ? { ...sweepRes.metrics } : this.evaluateMetrics();
        let took = false;
        if(this.compareTuple(after, bestMetrics) < 0){
          bestMetrics = { ...after };
          bestTkb = this.getSnapshotTKB();
          took = true;
        }
        stages.push({ mode: sweepMode, cycle: -1, restart: -1, ms: Date.now() - t0, before: null, after: { ...bestMetrics }, exitReason: took ? "final-sweep" : "final-sweep-nogain" });
        return took;
      };
      for(let sweepPass = 0; sweepPass < 6; sweepPass++){
        const remainMs = deadline - Date.now();
        if(remainMs < 15_000 || stopRequested()) break;
        const needSingle = bestMetrics.soBuoiDay1 > 0;
        const needGap2 = bestMetrics.soBuoiTrong2 > 0;
        if(!needSingle && !needGap2) break;
        let any = false;
        if(needSingle){
          any = (await runSweep("optimize_singletons", Math.max(15_000, Math.floor(remainMs * 0.4)))) || any;
        }
        const remain2 = deadline - Date.now();
        if(bestMetrics.soBuoiTrong2 > 0 && remain2 > 10_000 && !stopRequested()){
          any = (await runSweep("optimize_gap2", remain2)) || any;
        }
        if(!any) break;
      }

      this.data.tkb = JSON.parse(JSON.stringify(bestTkb));
      this.loadExistingSchedule();
      this.pushToZero = false;

      let placed = 0;
      this.activities.forEach((act, idx) => {
        if(this.actPlacement[idx] >= 0) placed += act.duration;
      });
      placed += this.fixedSlots.size;

      return {
        ok: true,
        applied: true,
        placed,
        unassigned: 0,
        initialMetrics,
        metrics: bestMetrics,
        stages,
        elapsedMs: Date.now() - startedAt,
        residualSingletons: this.getResidualSingletons(),
        residualGap2: this.getResidualGap2Sessions()
      };
    }
  }

  // Integrity gate: bọc các operator tối ưu thao tác lưới bằng tay. Nếu sau
  // khi chạy trạng thái không còn nhất quán (xếp đè, tiết mồ côi, mất tiết)
  // thì khôi phục snapshot trước đó và trả về null ("không cải thiện").
  // randomSwap không cần bọc — đã có moveJournal replay ngược chính xác.
  const GUARDED_OPERATORS = [
    "tryVacateTeacherDay",
    "tryVacateTeacherSession",
    "tryConsolidateTeacherSingletons",
    "tryReinforceTeacherSingletons",
    "obliterateAllTeacherSingletons",
    "obliterateAllThinTeacherSessions",
    "fixDaySingletons",
    "tryVacateTeacherSessions",
    "tryCrushTeacherGaps",
    "tryGapRelabelCycles",
    "tryDissolveGapSession",
    "tryEjectPlaceIntoGap",
    "tryRelocateGapSessionToNewDay",
    "tryMergeSessionIntoGaps",
    "tryKempeChainPeriodSwap",
    "tryExileEdgeLesson",
    "tryIntraSessionCrossClassChain",
    "tryBlockShiftAndGapResolution",
    "tryInterDayRelocateGapLesson",
    "tryBorrowLessonFromRichSessions",
    "tryCrushExtremeSpanGaps",
    "tryRelaxAndRepairGapGaps",
    "tryIntraClassSingleDoubleBlockSwap",
    "tryMergeSameTeacherSplitPeriodsInSession",
    "tryFillTeacherGapFromElsewhere",
    "tryMoveDoubleBlockIntoGap",
    "tryLnsRuinAndRecreate",
    "tryWholeSessionSwap",
    "tryRelatedClusterRuin",
    "tryDeepEjectionChain",
    "tryNeutralPlateauWalk"
  ];
  for(const opName of GUARDED_OPERATORS){
    const impl = FetTimetableEngine.prototype[opName];
    if(typeof impl !== "function") continue;
    FetTimetableEngine.prototype[opName] = function(...args){
      // Quá hạn trần thời gian: không khởi động operator mới (operator nặng
      // không tự kiểm tra giờ bên trong — chặn từ ngoài là đủ an toàn).
      if(this.opDeadlineMs && Date.now() > this.opDeadlineMs) return null;
      const snap = this.captureStateSnapshot();
      let result = null;
      try{
        result = impl.apply(this, args);
      }catch(err){
        this.restoreStateSnapshot(snap);
        this.integrityRejections = (this.integrityRejections || 0) + 1;
        return null;
      }
      if(!this.verifyPlacementIntegrity()){
        this.restoreStateSnapshot(snap);
        this.integrityRejections = (this.integrityRejections || 0) + 1;
        return null;
      }
      return result;
    };
  }

  global.FetTimetableEngine = FetTimetableEngine;

})(typeof window !== "undefined" ? window : globalThis);

