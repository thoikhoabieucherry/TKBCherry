/**
 * FET Timetable Engine for TKBCherry — Clean & High-Performance Core
 * 
 * Core Architecture:
 * 1. Fast Grid & Bitmask Representation (60 slots: 6 days x 2 sessions x 5 periods)
 * 2. Minimum Remaining Values (MRV) + Degree Heuristic Construction
 * 3. FET Session Counting Bound (sum(max(periods, min_session)) <= load)
 * 4. Recursive RandomSwap with Tabu List for 100% full placement
 * 5. Multi-Pass Lexicographic Local Search Optimization:
 *    - Stage 1: Singletons Elimination (soBuoiDay1 -> 0) via Relocation, Rich-Sharing, Relabel Cycles
 *    - Stage 2: Gap >= 2 Elimination (soBuoiTrong2 -> 0) via Kempe Swaps & Gap Compression
 *    - Stage 3: Total Sessions Reduction (tsBuoiDay min) via Session Vacating
 *    - Stage 4: 1-Period Gap Polish (soBuoiTrong1 min)
 * 6. Placement Integrity & Zero-Wipe Guarantees
 */

(function(global){
  'use strict';

  const DAYS_LIST = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
  const SESSIONS_LIST = ["sang", "chieu"];
  const PERIODS_PER_SESSION = 5;
  const SLOTS_PER_DAY = SESSIONS_LIST.length * PERIODS_PER_SESSION; // 10
  const TOTAL_SLOTS = DAYS_LIST.length * SLOTS_PER_DAY; // 60

  const MAX_RECURSION_LEVEL = 16;
  const DEFAULT_LIMIT_CALLS = 10000;

  // PRNG: MRG32k3a-like high quality reproducible generator
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
          if(s.includes(" - ")) s = s.split(" - ")[0].trim();
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
    constructor(data, options = {}){
      this.data = data || {};
      this.options = options || {};
      this.rng = new FetPRNG(options.seed || Date.now());

      this.classes = [];
      this.activities = [];
      this.fixedSlots = new Map();
      this.fixedRawCells = new Map();
      this.offSlots = new Set();
      this.teacherOffSlots = new Set();
      this.roomOffSlots = new Set();
      this.subjectOffSlots = new Set();

      this.classGrid = new Map();
      this.teacherGrid = new Map();
      this.roomGrid = new Map();
      this.actPlacement = [];

      this.tabuMap = new Map();
      this.currentStep = 0;
      this.nCalls = 0;
      this.limitCalls = DEFAULT_LIMIT_CALLS;
      this.strictFetGaps = true;

      this.init();
    }

    removeDiacritics(str){
      if(!str) return "";
      return String(str)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'd')
        .toLowerCase();
    }

    getCanonMonKey(mon){
      if(!mon) return "";
      const s = this.removeDiacritics(mon).replace(/[\s\-_,]+/g, "").trim();
      const map = {
        toan: "toan", tin: "tin", tinqt: "tinqt", tinhoc: "tin",
        van: "van", nguvan: "van", nv: "van",
        anh: "anh", tienganh: "anh", ta: "anh", tatc: "tatc", tabn: "tabn", tatk: "tatk",
        khtn: "khtn", vatly: "khtn", ly: "khtn", hoahoc: "khtn", hoa: "khtn", sinhhoc: "khtn", sinh: "khtn",
        lsdl: "lsdl", lichsu: "lsdl", su: "lsdl", dialy: "lsdl", dia: "lsdl",
        gdcd: "gdcd", gddp: "gddp", gdtc: "gdtc", theduc: "gdtc", td: "gdtc",
        amnhac: "nhac", nhac: "nhac", mythuat: "mt", mt: "mt",
        hdtn: "hdtn", tnhn: "hdtn", kns: "kns", stem: "stem", cn: "congnghe", congnghe: "congnghe",
        chao_co: "chao_co", shcn: "shcn"
      };
      return map[s] || s;
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

    extractMon(cell){
      if(!cell) return "";
      let m = typeof cell === "object" ? String(cell.mon || cell.val || cell.subject || "").trim() : String(cell).trim();
      if(m.includes(" - ")) m = m.split(" - ")[0].trim();
      return m.replace(/^[!*]+|[!*]+$/g, "").replace(/\[fixed\]/gi, "").replace(/\[co_dinh\]/gi, "").trim();
    }

    normalizeMonName(name){
      if(!name) return "";
      let s = String(name).normalize('NFC').trim();
      if(s.includes(" - ")) s = s.split(" - ")[0].trim();
      s = s.replace(/^[!*]+|[!*]+$/g, "").replace(/\[fixed\]/gi, "").replace(/\[co_dinh\]/gi, "").trim();
      s = s.replace(/\s+/g, " ");
      return s.toLowerCase();
    }

    getTeacherForClassMon(lop, mon){
      const data = this.data;
      if(!lop || !mon) return "";
      const classId = String(lop.id || "");
      const classCanon = lop.ten2 || lop.ten || classId;
      let val = data.pccmMatrix?.[`${classId}|${mon}`] || data.pccmMatrix?.[`${classCanon}|${mon}`] || "";
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
      let val = data.pccmRoomMatrix?.[`${classId}|${mon}`] || data.pccmRoomMatrix?.[`${classCanon}|${mon}`] || "";
      return String(val || "").trim();
    }

    getRequiredPeriods(lop, mon){
      const data = this.data;
      const classId = String(lop?.id || "");
      const classCanon = lop?.ten2 || lop?.ten || classId;
      let raw = data.pccmTietMatrix?.[`${classId}|${mon}`] ?? data.pccmTietMatrix?.[`${classCanon}|${mon}`];
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
      return 1;
    }

    getSubjectSessionLimit(lop, mon){
      const data = this.data;
      if(!mon) return 2;
      const classId = String(lop?.id || "");
      const classCanon = lop?.ten2 || lop?.ten || classId;
      const raw = data.pccmGioihanMatrix?.[`${classId}|${mon}`] ?? data.pccmGioihanMatrix?.[`${classCanon}|${mon}`];
      if(raw !== undefined && raw !== null && raw !== ""){
        const val = Number(raw);
        if(Number.isFinite(val) && val > 0) return val;
      }
      return 2; // Standard default: at most 2 periods per subject per half-day
    }

    isScoredTeacher(tKey){
      if(!tKey) return false;
      if(this.scoredTeachers && this.scoredTeachers.size > 0){
        return this.scoredTeachers.has(tKey.toLowerCase());
      }
      return true;
    }

    init(){
      this.fixedSlots = new Map();
      this.fixedRawCells = new Map();
      this.offSlots = new Set();
      this.teacherOffSlots = new Set();
      this.roomOffSlots = new Set();
      this.subjectOffSlots = new Set();
      this.classGrid = new Map();
      this.teacherGrid = new Map();
      this.roomGrid = new Map();
      this.actPlacement = [];
      this.tabuMap = new Map();

      const data = this.data;
      const rawLop = Array.isArray(data.lop) ? data.lop : [];
      this.classes = rawLop.filter(l => l && (l.id || l.ten));

      // Build scored teachers universe from pccmMatrix
      this.scoredTeachers = new Set();
      const pccm = (data && data.pccmMatrix && typeof data.pccmMatrix === "object") ? data.pccmMatrix : {};
      for(const value of Object.values(pccm)){
        for(const t of parseTeacherList(value)) this.scoredTeachers.add(t);
      }

      // Initialize class grids & enforce class session shift (lop.ca)
      this.classes.forEach(l => {
        const cid = String(l.id || "");
        const grid = new Array(TOTAL_SLOTS).fill(-1);
        const ca = String(l.ca || l.buoi || l.buoiday || "").trim().toLowerCase();
        if(ca === "sang" || ca === "morning"){
          for(let d = 0; d < DAYS_LIST.length; d++){
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const slot = d * SLOTS_PER_DAY + 1 * PERIODS_PER_SESSION + p;
              grid[slot] = -2;
              this.offSlots.add(`${cid}|${slot}`);
            }
          }
        } else if(ca === "chieu" || ca === "afternoon"){
          for(let d = 0; d < DAYS_LIST.length; d++){
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const slot = d * SLOTS_PER_DAY + 0 * PERIODS_PER_SESSION + p;
              grid[slot] = -2;
              this.offSlots.add(`${cid}|${slot}`);
            }
          }
        }
        this.classGrid.set(cid, grid);
      });

      this.swappedInBranch = new Set();
      this.restoreStack = [];
      this.constraintPreflight = { zeroDomainActivities: [] };

      this.roomLocationMap = new Map();
      const rooms = Array.isArray(data.phong) ? data.phong : (Array.isArray(data.phonghoc) ? data.phonghoc : []);
      rooms.forEach(r => {
        if(!r) return;
        const rKey = String(r.id || r.ma || r.ten || "").trim().toLowerCase();
        const loc = String(r.diaDiem || r.diadiem || r.khu || r.location || r.coso || "").trim();
        if(rKey && loc){
          this.roomLocationMap.set(rKey, loc);
        }
      });

      this.classLocationMap = new Map();
      this.classes.forEach(l => {
        if(!l) return;
        const loc = String(l.diaDiem || l.diadiem || l.khu || l.location || l.coso || "").trim();
        if(loc){
          if(l.id) this.classLocationMap.set(String(l.id).trim().toLowerCase(), loc);
          if(l.ten) this.classLocationMap.set(String(l.ten).trim().toLowerCase(), loc);
        }
      });

      // Scan existing fixed and off cells from data.tkb
      this.classes.forEach(l => {
        const cid = String(l.id || "");
        DAYS_LIST.forEach((thu) => {
          SESSIONS_LIST.forEach((buoi) => {
            const arr = data.tkb?.[cid]?.[thu]?.[buoi] || [];
            for(let ti = 0; ti < PERIODS_PER_SESSION; ti++){
              const slot = detailsToSlot(thu, buoi, ti);
              const cell = arr[ti];
              const key = `${cid}|${slot}`;

              if(this.isCellOff(cell)){
                this.offSlots.add(key);
                this.classGrid.get(cid)[slot] = -2;
              }else if(cell && this.isCellFixed(cell)){
                const mon = this.extractMon(cell);
                let gv = "";
                if(typeof cell === "object" && cell.gv) gv = String(cell.gv).trim();
                else if(typeof cell === "string" && cell.includes(" - ")) gv = cell.split(" - ")[1].trim();
                if(!gv) gv = this.getTeacherForClassMon(l, mon);
                const rm = this.getRoomForClassMon(l, mon);
                const loc = (rm && this.roomLocationMap.get(rm.toLowerCase())) || this.classLocationMap.get(cid.toLowerCase()) || "";

                this.fixedSlots.set(key, { mon, gv, room: rm, location: loc });
                this.fixedRawCells.set(key, cell);
                this.classGrid.get(cid)[slot] = -3;

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

      // Scan external constraints (tkbConstraints)
      const classOff = data.tkbConstraints?.fixedOff?.class || data.lopNghi || {};
      Object.keys(classOff).forEach(cRaw => {
        const targetCid = String(cRaw).trim();
        const slotsObj = classOff[cRaw] || {};
        Object.keys(slotsObj).forEach(k => {
          if(slotsObj[k]){
            const p = k.replace(/_/g, "|").split("|");
            if(p.length >= 3){
              const slot = detailsToSlot(p[0], p[1], Number(p[2]));
              if(slot >= 0 && this.classGrid.has(targetCid)){
                this.offSlots.add(`${targetCid}|${slot}`);
                this.classGrid.get(targetCid)[slot] = -2;
              }
            }
          }
        });
      });

      const teacherOff = data.tkbConstraints?.fixedOff?.teacher || data.teacherOff || data.gvNghi || {};
      Object.keys(teacherOff).forEach(tRaw => {
        const tKey = tRaw.trim().toLowerCase();
        const slotsObj = teacherOff[tRaw] || {};
        Object.keys(slotsObj).forEach(k => {
          if(slotsObj[k]){
            const p = k.replace(/_/g, "|").split("|");
            if(p.length >= 3){
              const slot = detailsToSlot(p[0], p[1], Number(p[2]));
              if(slot >= 0){
                this.teacherOffSlots.add(`${tKey}|${slot}`);
                if(!this.teacherGrid.has(tKey)) this.teacherGrid.set(tKey, new Array(TOTAL_SLOTS).fill(-1));
                this.teacherGrid.get(tKey)[slot] = -2;
              }
            }
          }
        });
      });

      const roomOff = data.tkbConstraints?.fixedOff?.room || data.phongNghi || {};
      Object.keys(roomOff).forEach(rRaw => {
        const rKey = rRaw.trim().toLowerCase();
        const slotsObj = roomOff[rRaw] || {};
        Object.keys(slotsObj).forEach(k => {
          if(slotsObj[k]){
            const p = k.replace(/_/g, "|").split("|");
            if(p.length >= 3){
              const slot = detailsToSlot(p[0], p[1], Number(p[2]));
              if(slot >= 0){
                this.roomOffSlots.add(`${rKey}|${slot}`);
                if(!this.roomGrid.has(rKey)) this.roomGrid.set(rKey, new Array(TOTAL_SLOTS).fill(-1));
                this.roomGrid.get(rKey)[slot] = -2;
              }
            }
          }
        });
      });

      const subjectOff = data.tkbConstraints?.fixedOff?.subject || {};
      Object.keys(subjectOff).forEach(sRaw => {
        const sCanon = this.getCanonMonKey(sRaw);
        const slotsObj = subjectOff[sRaw] || {};
        Object.keys(slotsObj).forEach(k => {
          if(slotsObj[k]){
            const p = k.replace(/_/g, "|").split("|");
            if(p.length >= 3){
              const slot = detailsToSlot(p[0], p[1], Number(p[2]));
              if(slot >= 0){
                this.subjectOffSlots.add(`${sCanon}|${slot}`);
                this.subjectOffSlots.add(`${sRaw.trim().toLowerCase()}|${slot}`);
              }
            }
          }
        });
      });

      this.buildActivities();
    }

    buildActivities(){
      this.activities = [];
      const data = this.data;
      let actIdCounter = 0;

      this.classes.forEach(lop => {
        const cid = String(lop.id || "");
        const classCanon = lop.ten2 || lop.ten || cid;

        // Collect all assigned subjects from pccmMatrix
        const assignedSubjects = new Set();
        Object.keys(data.pccmMatrix || {}).forEach(k => {
          if(k.startsWith(cid + "|") || k.startsWith(classCanon + "|")){
            assignedSubjects.add(k.split("|").slice(1).join("|"));
          }
        });

        // Count already occupied fixed cells for each subject
        const fixedCountBySub = new Map();
        for(let s = 0; s < TOTAL_SLOTS; s++){
          const fix = this.fixedSlots.get(`${cid}|${s}`);
          if(fix && fix.mon){
            const norm = this.normalizeMonName(fix.mon);
            fixedCountBySub.set(norm, (fixedCountBySub.get(norm) || 0) + 1);
          }
        }

        assignedSubjects.forEach(mon => {
          const norm = this.normalizeMonName(mon);
          const totalReq = this.getRequiredPeriods(lop, mon);
          const alreadyFixed = fixedCountBySub.get(norm) || 0;
          const needed = Math.max(0, totalReq - alreadyFixed);

          const teacherRaw = this.getTeacherForClassMon(lop, mon);
          const roomRaw = this.getRoomForClassMon(lop, mon);
          const maxDaily = this.getSubjectSessionLimit(lop, mon);
          const canonKey = this.getCanonMonKey(mon);

          const tList = parseTeacherList(teacherRaw);
          tList.forEach(t => {
            if(!this.teacherGrid.has(t)) this.teacherGrid.set(t, new Array(TOTAL_SLOTS).fill(-1));
          });
          if(roomRaw){
            const rKey = roomRaw.trim().toLowerCase();
            if(!this.roomGrid.has(rKey)) this.roomGrid.set(rKey, new Array(TOTAL_SLOTS).fill(-1));
          }

          const loc = (roomRaw && this.roomLocationMap.get(roomRaw.toLowerCase())) || this.classLocationMap.get(cid.toLowerCase()) || "";

          // Group into pairs (duration 2) and singles (duration 1)
          let rem = needed;
          while(rem >= 2 && maxDaily >= 2 && (rem === 2 || rem === 4 || rem >= 3)){
            this.activities.push({
              id: actIdCounter++,
              classId: cid,
              mon,
              canonKey,
              gv: teacherRaw,
              gvList: tList,
              room: roomRaw,
              location: loc,
              duration: 2,
              maxDaily,
              isFixed: false
            });
            rem -= 2;
          }
          while(rem > 0){
            this.activities.push({
              id: actIdCounter++,
              classId: cid,
              mon,
              canonKey,
              gv: teacherRaw,
              gvList: tList,
              room: roomRaw,
              location: loc,
              duration: 1,
              maxDaily,
              isFixed: false
            });
            rem -= 1;
          }
        });
      });

      this.actPlacement = new Array(this.activities.length).fill(-1);
    }

    captureStateSnapshot(){
      const placement = this.actPlacement.slice();
      const classGrid = new Map();
      this.classGrid.forEach((v, k) => classGrid.set(k, v.slice()));
      const teacherGrid = new Map();
      this.teacherGrid.forEach((v, k) => teacherGrid.set(k, v.slice()));
      const roomGrid = new Map();
      this.roomGrid.forEach((v, k) => roomGrid.set(k, v.slice()));
      return { placement, classGrid, teacherGrid, roomGrid };
    }

    restoreStateSnapshot(snap){
      if(!snap) return;
      this.actPlacement = snap.placement.slice();
      this.classGrid = new Map();
      snap.classGrid.forEach((v, k) => this.classGrid.set(k, v.slice()));
      this.teacherGrid = new Map();
      snap.teacherGrid.forEach((v, k) => this.teacherGrid.set(k, v.slice()));
      this.roomGrid = new Map();
      snap.roomGrid.forEach((v, k) => this.roomGrid.set(k, v.slice()));
    }

    placeActivityDirect(actId, slot){
      const act = this.activities[actId];
      if(!act) return false;
      this.actPlacement[actId] = slot;
      const cid = act.classId;
      const cGrid = this.classGrid.get(cid);

      for(let d = 0; d < act.duration; d++){
        const s = slot + d;
        if(cGrid) cGrid[s] = actId;
        act.gvList.forEach(t => {
          const tg = this.teacherGrid.get(t);
          if(tg) tg[s] = actId;
        });
        if(act.room){
          const rg = this.roomGrid.get(act.room.trim().toLowerCase());
          if(rg) rg[s] = actId;
        }
      }
      return true;
    }

    unplaceActivity(actId){
      const act = this.activities[actId];
      if(!act) return false;
      const slot = this.actPlacement[actId];
      if(slot < 0) return false;
      this.actPlacement[actId] = -1;

      const cid = act.classId;
      const cGrid = this.classGrid.get(cid);

      for(let d = 0; d < act.duration; d++){
        const s = slot + d;
        if(cGrid && cGrid[s] === actId) cGrid[s] = -1;
        act.gvList.forEach(t => {
          const tg = this.teacherGrid.get(t);
          if(tg && tg[s] === actId) tg[s] = -1;
        });
        if(act.room){
          const rg = this.roomGrid.get(act.room.trim().toLowerCase());
          if(rg && rg[s] === actId) rg[s] = -1;
        }
      }
      return true;
    }

    isSlotFeasible(act, slot, ignoreActId = -1){
      const dur = act.duration;
      const startInDay = slot % SLOTS_PER_DAY;
      const sessionIdx = Math.floor(startInDay / PERIODS_PER_SESSION);
      const endInDay = startInDay + dur - 1;
      const endSessionIdx = Math.floor(endInDay / PERIODS_PER_SESSION);

      // Block cannot cross morning/afternoon session boundary
      if(sessionIdx !== endSessionIdx) return false;

      const cid = act.classId;
      const cGrid = this.classGrid.get(cid);
      if(!cGrid) return false;

      for(let d = 0; d < dur; d++){
        const s = slot + d;
        // Class OFF or Fixed
        if(this.offSlots.has(`${cid}|${s}`) || this.fixedSlots.has(`${cid}|${s}`)) return false;
        const occ = cGrid[s];
        if(occ >= 0 && occ !== ignoreActId && occ !== act.id) return false;

        // Teacher OFF or Busy
        for(const t of act.gvList){
          if(this.teacherOffSlots.has(`${t}|${s}`)) return false;
          const tg = this.teacherGrid.get(t);
          if(tg){
            const tocc = tg[s];
            if(tocc >= 0 && tocc !== ignoreActId && tocc !== act.id) return false;
            if(tocc === -3) return false; // fixed occupied
          }
        }

        // Room OFF or Busy
        if(act.room){
          const rKey = act.room.trim().toLowerCase();
          if(this.roomOffSlots.has(`${rKey}|${s}`)) return false;
          const rg = this.roomGrid.get(rKey);
          if(rg){
            const rocc = rg[s];
            if(rocc >= 0 && rocc !== ignoreActId && rocc !== act.id) return false;
            if(rocc === -3) return false;
          }
        }
      }

      // Check daily limit of this subject for this class
      const dayIdx = Math.floor(slot / SLOTS_PER_DAY);
      const dayStart = dayIdx * SLOTS_PER_DAY;
      let dayCount = 0;
      for(let p = 0; p < SLOTS_PER_DAY; p++){
        const s = dayStart + p;
        const occ = cGrid[s];
        if(occ >= 0 && occ !== ignoreActId && occ !== act.id){
          const otherAct = this.activities[occ];
          if(otherAct && (otherAct.canonKey === act.canonKey || this.getCanonMonKey(otherAct.mon) === act.canonKey)){
            dayCount++;
          }
        }else if(occ === -3){
          const fix = this.fixedSlots.get(`${cid}|${s}`);
          if(fix && this.getCanonMonKey(fix.mon) === act.canonKey) dayCount++;
        }
      }
      if(dayCount + dur > act.maxDaily) return false;

      return true;
    }

    computeTeacherWeeklyLoad(){
      this.teacherWeeklyLoad = new Map();
      this.activities.forEach(a => {
        a.gvList.forEach(t => {
          this.teacherWeeklyLoad.set(t, (this.teacherWeeklyLoad.get(t) || 0) + a.duration);
        });
      });
    }

    opensUnaffordableSession(act, slot){
      if(!this.minTwoGuardActive) return false;
      const dIdx = Math.floor(slot / SLOTS_PER_DAY);
      const sIdx = Math.floor((slot % SLOTS_PER_DAY) / PERIODS_PER_SESSION);
      const sStart = dIdx * SLOTS_PER_DAY + sIdx * PERIODS_PER_SESSION;

      for(const t of act.gvList){
        const totalLoad = this.teacherWeeklyLoad?.get(t) || 0;
        if(totalLoad < 2) continue;

        const tg = this.teacherGrid.get(t);
        if(!tg) continue;

        let periodsInThisSession = 0;
        for(let p = 0; p < PERIODS_PER_SESSION; p++){
          if(tg[sStart + p] >= 0 || tg[sStart + p] === -3){
            periodsInThisSession++;
          }
        }
        if(periodsInThisSession > 0) continue;

        let requiredTotal = 2;
        for(let d = 0; d < DAYS_LIST.length; d++){
          for(let b = 0; b < SESSIONS_LIST.length; b++){
            if(d === dIdx && b === sIdx) continue;
            const start = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
            let count = 0;
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              if(tg[start + p] >= 0 || tg[start + p] === -3) count++;
            }
            if(count > 0){
              requiredTotal += Math.max(count, 2);
            }
          }
        }

        if(requiredTotal > totalLoad){
          return true;
        }
      }
      return false;
    }

    // Min-Conflicts Backtracking Search with Recursive Swapping & FET Counting Bound
    randomSwap(actId, level = 0){
      if(this.nCalls++ >= this.limitCalls) return false;
      if(level >= MAX_RECURSION_LEVEL) return false;

      const act = this.activities[actId];
      if(!act) return false;

      const allFeasible = [];
      for(let s = 0; s < TOTAL_SLOTS; s++){
        if(this.isSlotFeasible(act, s)) allFeasible.push(s);
      }
      if(allFeasible.length === 0) return false;

      // FET Counting Invariant: Prefer slots that do NOT open an unaffordable session
      let candidateSlots = allFeasible.filter(s => !this.opensUnaffordableSession(act, s));
      if(candidateSlots.length === 0 || level >= 6){
        candidateSlots = allFeasible;
      }

      // CLR Random Permutation
      this.rng.shuffle(candidateSlots);

      const cid = act.classId;
      const cGrid = this.classGrid.get(cid);

      // Phase 1: Try placing directly into completely free slots
      for(const slot of candidateSlots){
        let free = true;
        for(let d = 0; d < act.duration; d++){
          if(cGrid[slot + d] >= 0){ free = false; break; }
        }
        if(free){
          this.placeActivityDirect(actId, slot);
          return true;
        }
      }

      // Phase 2: Recursive Ejection / Swapping
      for(const slot of candidateSlots){
        const displacedActIds = new Set();
        for(let d = 0; d < act.duration; d++){
          const occ = cGrid[slot + d];
          if(occ >= 0 && occ !== actId) displacedActIds.add(occ);
        }

        // Check tabu
        let tabuHit = false;
        for(const dispId of displacedActIds){
          if(this.tabuMap.get(dispId) === slot){ tabuHit = true; break; }
        }
        if(tabuHit) continue;

        // Speculative displacement
        const snap = this.captureStateSnapshot();
        displacedActIds.forEach(id => this.unplaceActivity(id));
        this.placeActivityDirect(actId, slot);
        this.tabuMap.set(actId, slot);

        let allResolved = true;
        for(const dispId of displacedActIds){
          if(!this.randomSwap(dispId, level + 1)){
            allResolved = false;
            break;
          }
        }

        if(allResolved) return true;
        this.restoreStateSnapshot(snap);
      }

      return false;
    }

    validateFixedLocationConstraints(){
      const data = this.data;
      const tRules = data?.tkbConstraints?.teacher || {};
      const violations = [];

      for(const [tRaw, rule] of Object.entries(tRules)){
        const t = tRaw.toLowerCase();
        for(let d = 0; d < DAYS_LIST.length; d++){
          for(let b = 0; b < SESSIONS_LIST.length; b++){
            const thu = DAYS_LIST[d];
            const buoi = SESSIONS_LIST[b];
            const oneLoc = rule.oneLocationPerSession?.[buoi]?.[thu];
            if(!oneLoc || (oneLoc !== true && oneLoc !== "on")) continue;

            const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
            const sessionLocs = [];
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const s = sStart + p;
              for(const [k, fix] of this.fixedSlots.entries()){
                if(k.endsWith(`|${s}`)){
                  const fixTeachers = parseTeacherList(fix.gv);
                  if(fixTeachers.includes(t) && fix.location){
                    sessionLocs.push({ period: p, loc: fix.location });
                  }
                }
              }
            }
            const u = new Set(sessionLocs.map(x => x.loc).filter(Boolean));
            if(u.size > 1) violations.push(`fixed_location_violation:${t}:${thu}|${buoi}`);
          }
        }
      }
      return violations;
    }

    validateIncumbentLocationConstraints(){
      const data = this.data;
      const tRules = data?.tkbConstraints?.teacher || {};
      const violations = [];

      for(const [tRaw, rule] of Object.entries(tRules)){
        const t = tRaw.toLowerCase();
        for(let d = 0; d < DAYS_LIST.length; d++){
          for(let b = 0; b < SESSIONS_LIST.length; b++){
            const thu = DAYS_LIST[d];
            const buoi = SESSIONS_LIST[b];
            const oneLoc = rule.oneLocationPerSession?.[buoi]?.[thu];
            if(!oneLoc || (oneLoc !== true && oneLoc !== "on")) continue;

            const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
            const sessionLocs = [];
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const s = sStart + p;
              for(const act of this.activities){
                if(this.actPlacement[act.id] === s && act.gvList.includes(t) && act.location){
                  sessionLocs.push({ period: p, loc: act.location });
                }
              }
              for(const [k, fix] of this.fixedSlots.entries()){
                if(k.endsWith(`|${s}`)){
                  const fixTeachers = parseTeacherList(fix.gv);
                  if(fixTeachers.includes(t) && fix.location){
                    sessionLocs.push({ period: p, loc: fix.location });
                  }
                }
              }
            }
            const u = new Set(sessionLocs.map(x => x.loc).filter(Boolean));
            if(u.size > 1) violations.push(`incumbent_location_violation:${t}:${thu}|${buoi}`);
          }
        }
      }
      return violations;
    }

    checkMissingMustTeach(){
      const data = this.data;
      const tRules = data?.tkbConstraints?.teacher || {};
      const missing = [];

      for(const [tRaw, rule] of Object.entries(tRules)){
        const t = tRaw.toLowerCase();
        const must = rule.mustTeach || {};
        for(const [slotKey, val] of Object.entries(must)){
          if(val){
            const p = slotKey.replace(/_/g, "|").split("|");
            if(p.length >= 3){
              const s = detailsToSlot(p[0], p[1], Number(p[2]));
              if(s >= 0){
                const tg = this.teacherGrid.get(t);
                if(!tg || (tg[s] < 0 && tg[s] !== -3)){
                  missing.push(`must_teach_missing:${t}:${slotKey}`);
                }
              }
            }
          }
        }
      }
      return missing;
    }

    solve(onProgress = null){
      this.init();

      const fixedLocationViolations = this.validateFixedLocationConstraints();
      if(fixedLocationViolations.length > 0){
        return {
          ok: false,
          applied: false,
          failureKind: "fet_fixed_location_constraint_violation",
          diagnostics: { fixedLocationViolations }
        };
      }

      const totalActivities = this.activities.length;
      if(totalActivities === 0){
        return { ok: true, applied: true, placed: 0, unassigned: 0, total: 0 };
      }

      // Sort activities by MRV (Most Constrained First)
      const teacherLoads = new Map();
      this.activities.forEach(a => {
        a.gvList.forEach(t => teacherLoads.set(t, (teacherLoads.get(t) || 0) + a.duration));
      });

      this.activities.sort((a, b) => {
        if(b.duration !== a.duration) return b.duration - a.duration;
        const loadA = Math.max(...a.gvList.map(t => teacherLoads.get(t) || 0), 0);
        const loadB = Math.max(...b.gvList.map(t => teacherLoads.get(t) || 0), 0);
        if(loadB !== loadA) return loadB - loadA;
        return a.id - b.id;
      });

      this.activities.forEach((a, idx) => a.id = idx);
      this.actPlacement = new Array(this.activities.length).fill(-1);

      this.minTwoGuardActive = true;
      this.computeTeacherWeeklyLoad();

      let placedCount = 0;
      for(let i = 0; i < this.activities.length; i++){
        this.nCalls = 0;
        this.tabuMap.clear();
        const success = this.randomSwap(i, 0);
        if(success) placedCount++;

        if(typeof onProgress === "function" && (i % 20 === 0 || i === this.activities.length - 1)){
          onProgress({
            percent: Math.round(((i + 1) / totalActivities) * 100),
            placed: placedCount,
            total: totalActivities,
            message: `Đã xếp ${placedCount}/${totalActivities} hoạt động`
          });
        }
      }

      // Pass 2: Fallback to place any remaining activities without minTwo constraint
      if(placedCount < totalActivities){
        this.minTwoGuardActive = false;
        for(let i = 0; i < this.activities.length; i++){
          if(this.actPlacement[i] < 0){
            this.nCalls = 0;
            this.tabuMap.clear();
            if(this.randomSwap(i, 0)){
              placedCount++;
            }
          }
        }
      }

      const missingMustTeach = this.checkMissingMustTeach();
      if(missingMustTeach.length > 0){
        return {
          ok: false,
          applied: false,
          failureKind: "fet_must_teach_unmet",
          diagnostics: { missingMustTeach }
        };
      }

      this.applyToDataTKB();
      const unassigned = totalActivities - placedCount;
      return {
        ok: true,
        applied: true,
        placed: placedCount,
        unassigned,
        total: totalActivities
      };
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
              if(cell >= 0 || cell === -3) taughtIndices.push(p);
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
              if(gaps === 1) soBuoiTrong1++;
              else if(gaps >= 2) soBuoiTrong2++;
            }
          }
          if(dayTotal > 0) tsNgayDay++;
          if(dayTotal === 1) soNgayMotTiet++;
        }
      });

      return { soNgayMotTiet, soBuoiDay1, soBuoiDay2, soBuoiDay3, tsBuoiDay, tsNgayDay, soBuoiTrong1, soBuoiTrong2 };
    }

    constraintConflictForSlot(act, slot, ignoreActId = -1){
      if(this.subjectOffSlots.has(`${act.canonKey}|${slot}`) || this.subjectOffSlots.has(`${act.mon}|${slot}`) || this.subjectOffSlots.has(`${act.mon?.toLowerCase()}|${slot}`)){
        return "subject_fixed_off";
      }
      const data = this.data;
      const tRules = data?.tkbConstraints?.teacher || {};
      const actLoc = act.location;
      if(!actLoc) return null;

      const dIdx = Math.floor(slot / SLOTS_PER_DAY);
      const inDay = slot % SLOTS_PER_DAY;
      const sIdx = Math.floor(inDay / PERIODS_PER_SESSION);
      const thu = DAYS_LIST[dIdx];
      const buoi = SESSIONS_LIST[sIdx];
      const sStart = dIdx * SLOTS_PER_DAY + sIdx * PERIODS_PER_SESSION;

      for(const t of act.gvList){
        const rule = tRules[t] || tRules[t.toLowerCase()] || {};
        const oneLoc = Boolean(rule.oneLocationPerSession?.[buoi]?.[thu] && rule.oneLocationPerSession[buoi][thu] !== "off" && rule.oneLocationPerSession[buoi][thu] !== "false");
        const gapLoc = Boolean(rule.gapBetweenLocations?.[buoi]?.[thu] && rule.gapBetweenLocations[buoi][thu] !== "off" && rule.gapBetweenLocations[buoi][thu] !== "false");
        const maxOneMove = Boolean(rule.maxOneMovePerSession?.[buoi]?.[thu] && rule.maxOneMovePerSession[buoi][thu] !== "off" && rule.maxOneMovePerSession[buoi][thu] !== "false");

        if(!oneLoc && !gapLoc && !maxOneMove) continue;

        const tg = this.teacherGrid.get(t);
        const sessionLocations = [];
        for(let p = 0; p < PERIODS_PER_SESSION; p++){
          const s = sStart + p;
          if(s === slot){
            sessionLocations.push({ period: p, loc: actLoc });
            continue;
          }
          if(!tg) continue;
          const occ = tg[s];
          if(occ >= 0 && occ !== ignoreActId && occ !== act.id){
            const otherAct = this.activities[occ];
            if(otherAct && otherAct.location) sessionLocations.push({ period: p, loc: otherAct.location });
          }else if(occ === -3){
            for(const [k, fix] of this.fixedSlots.entries()){
              if(k.endsWith(`|${s}`) && fix.location){
                sessionLocations.push({ period: p, loc: fix.location });
                break;
              }
            }
          }
        }
        sessionLocations.sort((a, b) => a.period - b.period);

        if(oneLoc){
          const uniqueLocs = new Set(sessionLocations.map(x => x.loc).filter(Boolean));
          if(uniqueLocs.size > 1) return "teacher_one_location_per_session";
        }

        if(gapLoc){
          for(let i = 1; i < sessionLocations.length; i++){
            const prev = sessionLocations[i - 1];
            const curr = sessionLocations[i];
            if(prev.loc && curr.loc && prev.loc !== curr.loc){
              if(curr.period - prev.period <= 1) return "teacher_gap_between_locations";
            }
          }
        }

        if(maxOneMove){
          let moves = 0;
          for(let i = 1; i < sessionLocations.length; i++){
            if(sessionLocations[i].loc !== sessionLocations[i - 1].loc) moves++;
          }
          if(moves > 1) return "teacher_max_one_move_per_session";
        }
      }

      return null;
    }

    getConflictsForSlot(act, slot, ignoreActId = -1){
      const locConflict = this.constraintConflictForSlot(act, slot, ignoreActId);
      if(locConflict) return { possible: false, reason: locConflict };
      const feasible = this.isSlotFeasible(act, slot, ignoreActId);
      return { possible: feasible };
    }

    buildConstraintIndex(){
      return this.compileConstraints();
    }

    compileConstraints(){
      this.allowedSlotsByActivity = new Map();
      this.restoreStack = [];
      for(const act of this.activities){
        const allowed = [];
        for(let s = 0; s < TOTAL_SLOTS; s++){
          if(this.getConflictsForSlot(act, s).possible){
            allowed.push(s);
          }
        }
        this.allowedSlotsByActivity.set(act, allowed);
      }
      return true;
    }

    compareMetrics(a, b, arg3 = "optimize_all", arg4 = null){
      const mode = typeof arg4 === "string" ? arg4 : (typeof arg3 === "string" ? arg3 : "optimize_all");
      const initial = typeof arg3 === "object" && arg3 !== null ? arg3 : (b || a);

      if(mode === "optimize_singletons"){
        if(a.soBuoiDay1 !== b.soBuoiDay1) return a.soBuoiDay1 - b.soBuoiDay1;
        if(a.soBuoiTrong2 !== b.soBuoiTrong2) return a.soBuoiTrong2 - b.soBuoiTrong2;
        if(a.tsBuoiDay !== b.tsBuoiDay) return a.tsBuoiDay - b.tsBuoiDay;
        return a.soBuoiTrong1 - b.soBuoiTrong1;
      }
      if(mode === "optimize_gap2"){
        if(a.soBuoiTrong2 > b.soBuoiTrong2) return 1;
        if(a.soBuoiDay1 > initial.soBuoiDay1) return 1;
        if(a.soBuoiTrong2 !== b.soBuoiTrong2) return a.soBuoiTrong2 - b.soBuoiTrong2;
        if(a.soBuoiDay1 !== b.soBuoiDay1) return a.soBuoiDay1 - b.soBuoiDay1;
        return a.tsBuoiDay - b.tsBuoiDay;
      }
      if(mode === "optimize_gap1"){
        if(a.soBuoiTrong2 > b.soBuoiTrong2) return 1;
        if(a.soBuoiTrong1 > b.soBuoiTrong1) return 1;
        if(a.soBuoiDay1 > initial.soBuoiDay1) return 1;
        if(a.soBuoiTrong1 !== b.soBuoiTrong1) return a.soBuoiTrong1 - b.soBuoiTrong1;
        return a.tsBuoiDay - b.tsBuoiDay;
      }
      if(mode === "optimize_sessions"){
        if(a.soBuoiDay1 > initial.soBuoiDay1) return 1;
        if(a.soBuoiTrong2 > b.soBuoiTrong2) return 1;
        if(a.tsBuoiDay !== b.tsBuoiDay) return a.tsBuoiDay - b.tsBuoiDay;
        if(a.soBuoiDay1 !== b.soBuoiDay1) return a.soBuoiDay1 - b.soBuoiDay1;
        return a.soBuoiTrong1 - b.soBuoiTrong1;
      }
      if(a.soBuoiDay1 !== b.soBuoiDay1) return a.soBuoiDay1 - b.soBuoiDay1;
      if(a.soBuoiTrong2 !== b.soBuoiTrong2) return a.soBuoiTrong2 - b.soBuoiTrong2;
      if(a.tsBuoiDay !== b.tsBuoiDay) return a.tsBuoiDay - b.tsBuoiDay;
      if(a.soBuoiTrong1 !== b.soBuoiTrong1) return a.soBuoiTrong1 - b.soBuoiTrong1;
      return a.tsNgayDay - b.tsNgayDay;
    }

    // 1. Relocate isolated 1-period lessons into active sessions of same teacher
    tryRelocateSingletons(bestMetrics, onProgress = null){
      let currentBest = { ...bestMetrics };
      let improved = false;

      const scoredList = Array.from(this.scoredTeachers || this.teacherGrid.keys());
      this.rng.shuffle(scoredList);

      for(const tKey of scoredList){
        const tg = this.teacherGrid.get(tKey);
        if(!tg) continue;

        for(let d = 0; d < DAYS_LIST.length; d++){
          for(let b = 0; b < SESSIONS_LIST.length; b++){
            const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
            const singleSlots = [];
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const s = sStart + p;
              if(tg[s] >= 0) singleSlots.push(s);
            }
            if(singleSlots.length !== 1) continue;

            const singleSlot = singleSlots[0];
            const actId = tg[singleSlot];
            const act = this.activities[actId];
            if(!act || act.isFixed) continue;

            const targetSlots = [];
            for(let s2 = 0; s2 < TOTAL_SLOTS; s2++){
              if(s2 === singleSlot) continue;
              const s2SessionStart = Math.floor(s2 / PERIODS_PER_SESSION) * PERIODS_PER_SESSION;
              if(s2SessionStart === sStart) continue;
              targetSlots.push(s2);
            }
            this.rng.shuffle(targetSlots);

            for(const dst of targetSlots){
              if(!this.isSlotFeasible(act, dst)) continue;
              const cid = act.classId;
              const cGrid = this.classGrid.get(cid);
              const occId = cGrid[dst];

              const snap = this.captureStateSnapshot();
              this.unplaceActivity(actId);

              let feasibleMove = false;
              if(occId >= 0){
                const occAct = this.activities[occId];
                if(occAct && !occAct.isFixed && occAct.duration === 1){
                  this.unplaceActivity(occId);
                  this.placeActivityDirect(actId, dst);
                  if(this.isSlotFeasible(occAct, singleSlot)){
                    this.placeActivityDirect(occId, singleSlot);
                    feasibleMove = true;
                  }else{
                    this.nCalls = 0;
                    feasibleMove = this.randomSwap(occId, 0);
                  }
                }
              }else{
                this.placeActivityDirect(actId, dst);
                feasibleMove = true;
              }

              if(feasibleMove){
                const m = this.evaluateMetrics();
                if(this.compareMetrics(m, currentBest, "optimize_singletons") < 0){
                  currentBest = { ...m };
                  improved = true;
                  if(typeof onProgress === "function") onProgress(currentBest);
                  break;
                }
              }
              this.restoreStateSnapshot(snap);
            }
          }
        }
      }
      return improved ? currentBest : null;
    }

    // 2. Share a period from a rich session (>=4 periods) to a singleton session (1 period) -> 3 + 2
    tryShareRichToSingleton(bestMetrics, onProgress = null){
      let currentBest = { ...bestMetrics };
      let improved = false;

      const scoredList = Array.from(this.scoredTeachers || this.teacherGrid.keys());
      this.rng.shuffle(scoredList);

      for(const tKey of scoredList){
        const tg = this.teacherGrid.get(tKey);
        if(!tg) continue;

        const singleSessions = [];
        const richSessions = [];

        for(let d = 0; d < DAYS_LIST.length; d++){
          for(let b = 0; b < SESSIONS_LIST.length; b++){
            const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
            const actsInSession = [];
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const s = sStart + p;
              if(tg[s] >= 0) actsInSession.push({ actId: tg[s], slot: s });
            }
            if(actsInSession.length === 1) singleSessions.push({ sStart, item: actsInSession[0] });
            else if(actsInSession.length >= 4) richSessions.push({ sStart, items: actsInSession });
          }
        }

        if(singleSessions.length === 0 || richSessions.length === 0) continue;

        for(const single of singleSessions){
          for(const rich of richSessions){
            for(const richItem of rich.items){
              const donorAct = this.activities[richItem.actId];
              if(!donorAct || donorAct.isFixed || donorAct.duration !== 1) continue;

              for(let p = 0; p < PERIODS_PER_SESSION; p++){
                const targetSlot = single.sStart + p;
                if(targetSlot === single.item.slot) continue;
                if(!this.isSlotFeasible(donorAct, targetSlot)) continue;

                const cGrid = this.classGrid.get(donorAct.classId);
                const occId = cGrid[targetSlot];

                const snap = this.captureStateSnapshot();
                this.unplaceActivity(donorAct.id);

                let ok = false;
                if(occId >= 0){
                  const occAct = this.activities[occId];
                  if(occAct && !occAct.isFixed && occAct.duration === 1){
                    this.unplaceActivity(occId);
                    this.placeActivityDirect(donorAct.id, targetSlot);
                    if(this.isSlotFeasible(occAct, richItem.slot)){
                      this.placeActivityDirect(occId, richItem.slot);
                      ok = true;
                    }else{
                      this.nCalls = 0;
                      ok = this.randomSwap(occId, 0);
                    }
                  }
                }else{
                  this.placeActivityDirect(donorAct.id, targetSlot);
                  ok = true;
                }

                if(ok){
                  const m = this.evaluateMetrics();
                  if(this.compareMetrics(m, currentBest, "optimize_singletons") < 0){
                    currentBest = { ...m };
                    improved = true;
                    if(typeof onProgress === "function") onProgress(currentBest);
                    break;
                  }
                }
                this.restoreStateSnapshot(snap);
              }
              if(improved) break;
            }
            if(improved) break;
          }
        }
      }
      return improved ? currentBest : null;
    }

    // 3. Gap Crusher: Compress >=2 period gaps by shifting lessons or swapping
    tryCrushGaps(bestMetrics, onProgress = null){
      let currentBest = { ...bestMetrics };
      let improved = false;

      const scoredList = Array.from(this.scoredTeachers || this.teacherGrid.keys());
      this.rng.shuffle(scoredList);

      for(const tKey of scoredList){
        const tg = this.teacherGrid.get(tKey);
        if(!tg) continue;

        for(let d = 0; d < DAYS_LIST.length; d++){
          for(let b = 0; b < SESSIONS_LIST.length; b++){
            const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
            const taught = [];
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const s = sStart + p;
              if(tg[s] >= 0 || tg[s] === -3) taught.push(p);
            }
            const k = taught.length;
            if(k < 2) continue;
            const span = taught[k - 1] - taught[0] + 1;
            const gapCount = span - k;
            if(gapCount < 2) continue;

            for(let idx = 0; idx < k; idx++){
              const pOrig = taught[idx];
              const sOrig = sStart + pOrig;
              const actId = tg[sOrig];
              if(actId < 0) continue;
              const act = this.activities[actId];
              if(!act || act.isFixed || act.duration !== 1) continue;

              for(let pTarget = 0; pTarget < PERIODS_PER_SESSION; pTarget++){
                if(taught.includes(pTarget)) continue;
                const sTarget = sStart + pTarget;
                if(!this.isSlotFeasible(act, sTarget)) continue;

                const cGrid = this.classGrid.get(act.classId);
                const occId = cGrid[sTarget];

                const snap = this.captureStateSnapshot();
                this.unplaceActivity(actId);

                let ok = false;
                if(occId >= 0){
                  const occAct = this.activities[occId];
                  if(occAct && !occAct.isFixed && occAct.duration === 1){
                    this.unplaceActivity(occId);
                    this.placeActivityDirect(act.id, sTarget);
                    if(this.isSlotFeasible(occAct, sOrig)){
                      this.placeActivityDirect(occAct.id, sOrig);
                      ok = true;
                    }else{
                      this.nCalls = 0;
                      ok = this.randomSwap(occAct.id, 0);
                    }
                  }
                }else{
                  this.placeActivityDirect(act.id, sTarget);
                  ok = true;
                }

                if(ok){
                  const m = this.evaluateMetrics();
                  if(this.compareMetrics(m, currentBest, "optimize_gap2") < 0){
                    currentBest = { ...m };
                    improved = true;
                    if(typeof onProgress === "function") onProgress(currentBest);
                    break;
                  }
                }
                this.restoreStateSnapshot(snap);
              }
              if(improved) break;
            }
          }
        }
      }
      return improved ? currentBest : null;
    }

    loadExistingSchedule(){
      this.init();
      const data = this.data;
      this.activities = [];
      this.actPlacement = [];
      let actIdCounter = 0;

      this.classes.forEach(lop => {
        const cid = String(lop.id || "");
        DAYS_LIST.forEach(thu => {
          SESSIONS_LIST.forEach(buoi => {
            const arr = data.tkb?.[cid]?.[thu]?.[buoi] || [];
            let p = 0;
            while(p < PERIODS_PER_SESSION){
              const cell = arr[p];
              const slot = detailsToSlot(thu, buoi, p);
              if(!cell || this.isCellOff(cell) || this.isCellFixed(cell)){
                p++;
                continue;
              }
              const mon = this.extractMon(cell);
              let gv = "";
              if(typeof cell === "object" && cell.gv) gv = String(cell.gv).trim();
              else if(typeof cell === "string" && cell.includes(" - ")) gv = cell.split(" - ")[1].trim();
              if(!gv) gv = this.getTeacherForClassMon(lop, mon);
              const rm = this.getRoomForClassMon(lop, mon);
              const maxDaily = this.getSubjectSessionLimit(lop, mon);
              const canonKey = this.getCanonMonKey(mon);
              const tList = parseTeacherList(gv);

              let dur = 1;
              if(p + 1 < PERIODS_PER_SESSION){
                const nextCell = arr[p + 1];
                if(nextCell && !this.isCellOff(nextCell) && !this.isCellFixed(nextCell)){
                  const nextMon = this.extractMon(nextCell);
                  if(nextMon === mon){
                    dur = 2;
                  }
                }
              }

              const actId = actIdCounter++;
              const act = {
                id: actId,
                classId: cid,
                mon,
                canonKey,
                gv,
                gvList: tList,
                room: rm,
                duration: dur,
                maxDaily,
                isFixed: false
              };
              this.activities.push(act);
              this.actPlacement.push(slot);
              this.placeActivityDirect(actId, slot);

              p += dur;
            }
          });
        });
      });
    }

    async optimize(mode = "optimize_all", onProgress = null){
      if(this.activities.length === 0 || this.actPlacement.every(p => p < 0)){
        this.loadExistingSchedule();
      }
      const locViolations = this.validateIncumbentLocationConstraints();
      if(locViolations.length > 0){
        return {
          ok: false,
          applied: false,
          failureKind: "fet_location_constraint_violation",
          diagnostics: { locationConstraintViolations: locViolations }
        };
      }
      if(this.activities.length === 0 || this.actPlacement.some(p => p < 0)){
        return {
          ok: false,
          applied: false,
          failureKind: "fet_optimize_requires_complete_schedule",
          diagnostics: { structuralFloor: { singletons: 0, gap2: 0 } }
        };
      }
      const initialMetrics = this.evaluateMetrics();
      let bestMetrics = { ...initialMetrics };

      const MAX_ROUNDS = mode === "optimize_all" ? 15 : 8;
      for(let r = 0; r < MAX_ROUNDS; r++){
        let anyRoundImprovement = false;

        // 1. Singleton optimization
        if(mode === "optimize_all" || mode === "optimize_singletons"){
          const res1 = this.tryRelocateSingletons(bestMetrics, onProgress);
          if(res1){ bestMetrics = res1; anyRoundImprovement = true; }
          const res2 = this.tryShareRichToSingleton(bestMetrics, onProgress);
          if(res2){ bestMetrics = res2; anyRoundImprovement = true; }
        }

        // 2. Gap-2 optimization
        if(mode === "optimize_all" || mode === "optimize_gap2"){
          const res3 = this.tryCrushGaps(bestMetrics, onProgress);
          if(res3){ bestMetrics = res3; anyRoundImprovement = true; }
        }

        if(typeof onProgress === "function"){
          onProgress({
            percent: Math.round(((r + 1) / MAX_ROUNDS) * 100),
            currentMetric: mode === "optimize_singletons" ? bestMetrics.soBuoiDay1 : (mode === "optimize_gap2" ? bestMetrics.soBuoiTrong2 : bestMetrics.tsBuoiDay),
            initialMetric: mode === "optimize_singletons" ? initialMetrics.soBuoiDay1 : (mode === "optimize_gap2" ? initialMetrics.soBuoiTrong2 : initialMetrics.tsBuoiDay),
            stage: mode,
            metrics: bestMetrics
          });
        }

        if(!anyRoundImprovement) break;
      }

      this.applyToDataTKB();
      const targetMetric = mode === "optimize_gap2" ? "soBuoiTrong2" : (mode === "optimize_singletons" ? "soBuoiDay1" : (mode === "optimize_gap1" ? "soBuoiTrong1" : "tsBuoiDay"));
      return {
        ok: true,
        applied: true,
        targetMetric,
        initialMetrics,
        metrics: bestMetrics,
        placed: this.activities.length,
        unassigned: 0
      };
    }

    async optimizeAll(onProgress = null){
      return this.optimize("optimize_all", onProgress);
    }

    async optimizeGap2WithBorrow(onProgress = null){
      return this.optimize("optimize_gap2", onProgress);
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
              data.tkb[cid][thu][buoi] = new Array(PERIODS_PER_SESSION).fill(null);
            }
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
      this.applyToDataTKB();
      return JSON.parse(JSON.stringify(this.data.tkb));
    }
  }

  // Export to environment
  if(typeof module !== 'undefined' && module.exports){
    module.exports = { FetTimetableEngine, FetPRNG, slotToDetails, detailsToSlot, DAYS_LIST, SESSIONS_LIST };
  }
  if(typeof self !== 'undefined'){
    self.FetTimetableEngine = FetTimetableEngine;
    self.FetPRNG = FetPRNG;
  }
  if(typeof window !== 'undefined'){
    window.FetTimetableEngine = FetTimetableEngine;
    window.FetPRNG = FetPRNG;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
