/**
 * FET Timetable Engine for TKBCherry — High-Performance Core & Parity with FET C++ v7.9.5
 * 
 * Performance & Architecture Optimizations:
 * 1. Fast Flat Bitmasks & Typed Arrays (Int32Array grids, bitwise operations)
 * 2. Multi-Attribute MRV Activity Difficulty Ordering (O(N) difficulty compilation)
 * 3. Min-Conflicts Recursive RandomSwap with Tabu queue & Transactional Delta Rollback
 * 4. Precomputed Gap Penalty & Session Stats Lookup Tables (32-entry LUTs)
 * 5. Comprehensive Constraint Compiler & Structural Floor Diagnostics
 * 6. Multi-Pass Lexicographic Local Search & Closed Push-Cycles / Singleton Crusher:
 *    - Stage 1: Singletons Elimination (soBuoiDay1 -> 0) via Relocation, Rich-Sharing, Relabel Push Cycles, Kempe chains, ILS
 *    - Stage 2: Gap >= 2 Elimination (soBuoiTrong2 -> 0) via Kempe Swaps & Gap Compression
 *    - Stage 3: Total Sessions Reduction (tsBuoiDay min) via Session Vacating
 *    - Stage 4: 1-Period Gap Polish (soBuoiTrong1 min)
 * 7. Student Continuous Class Block Invariant (Zero Internal Holes)
 */

(function(global){
  "use strict";

  const DAYS_LIST = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
  const SESSIONS_LIST = ["sang", "chieu"];
  const PERIODS_PER_SESSION = 5;
  const SLOTS_PER_DAY = SESSIONS_LIST.length * PERIODS_PER_SESSION; // 10
  const TOTAL_SLOTS = DAYS_LIST.length * SLOTS_PER_DAY; // 60
  const SANG_SLOTS = [
    0, 1, 2, 3, 4,
    10, 11, 12, 13, 14,
    20, 21, 22, 23, 24,
    30, 31, 32, 33, 34,
    40, 41, 42, 43, 44,
    50, 51, 52, 53, 54
  ];
  const CHIEU_SLOTS = [
    5, 6, 7, 8, 9,
    15, 16, 17, 18, 19,
    25, 26, 27, 28, 29,
    35, 36, 37, 38, 39,
    45, 46, 47, 48, 49,
    55, 56, 57, 58, 59
  ];
  const ALL_60_SLOTS = Array.from({ length: 60 }, (_, i) => i);

  const INF = 1500000000;
  const INF2 = 2000000000;
  const MAX_RECURSION_LEVEL = 16;
  const DEFAULT_LIMIT_CALLS = 2000;

  // Precomputed 32-entry lookup tables for 5-period sessions (bitmask 0..31)
  const GAP_PENALTY_LUT = new Int32Array(32);
  const SESSION_STATS_LUT = new Array(32);

  for(let mask = 0; mask < 32; mask++){
    const taught = [];
    for(let p = 0; p < 5; p++){
      if((mask & (1 << p)) !== 0) taught.push(p);
    }
    const k = taught.length;
    let gaps = 0;
    let penalty = 0;
    if(k >= 2){
      const span = taught[k - 1] - taught[0] + 1;
      gaps = span - k;
      if(gaps >= 2) penalty = 10 * gaps;
      else if(gaps === 1) penalty = 1;
    }
    GAP_PENALTY_LUT[mask] = penalty;
    SESSION_STATS_LUT[mask] = { k, gaps };
  }

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
    if(canonMap){
      list = list.map(t => canonMap[t] || t);
    }
    return Array.from(new Set(list));
  }

  function isCheckedValue(v){
    return v === true || v === 1 || v === "1" || v === "true" || v === "on";
  }

  function findRuleForTeacher(tRules, t){
    if(!tRules || !t) return {};
    if(tRules[t]) return tRules[t];
    const tLower = t.toLowerCase();
    for(const k of Object.keys(tRules)){
      if(k.toLowerCase() === tLower) return tRules[k];
    }
    return {};
  }

  function findRuleForSubject(sRules, mon){
    if(!sRules || !mon) return {};
    if(sRules[mon]) return sRules[mon];
    const mLower = mon.toLowerCase();
    for(const k of Object.keys(sRules)){
      if(k.toLowerCase() === mLower) return sRules[k];
    }
    return {};
  }

  class FetTimetableEngine {
    constructor(data, options = {}){
      this.data = data || {};
      this.options = options || {};
      this.rng = new FetPRNG(options.seed || Date.now());
      this.timeBudgetMs = Number(options.timeBudgetMs) || 12000;
      this.optimizeTimeBudgetMs = Number(options.optimizeTimeBudgetMs) || 20000;

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
      this.classGridList = [];
      this.teacherGridList = [];
      this.roomGridList = [];
      this.classIndexMap = new Map();
      this.teacherIndexMap = new Map();
      this.roomIndexMap = new Map();
      this.teachers = [];
      this.rooms = [];
      this.actPlacement = [];

      this.tabuMap = new Map();
      this.swapStep = 0;
      this.triedRemovals = new Map();
      this.swappedInBranch = new Set();
      this.restoreStack = [];
      this.currentStep = 0;
      this.nCalls = 0;
      this.limitCalls = DEFAULT_LIMIT_CALLS;
      this.strictFetGaps = true;

      this.constraintPreflight = {
        zeroDomainActivities: [],
        capacityShortages: [],
        minDomainSize: TOTAL_SLOTS,
        structuralFloor: {
          provenInfeasible: false,
          minimumUnplacedPeriods: 0,
          metricLowerBounds: { soBuoiDay1: 0, tsBuoiDay: 0, tsNgayDay: 0, soBuoiTrong1: 0, soBuoiTrong2: 0 },
          metricLowerBoundEvidence: []
        }
      };

      this.init();
    }

    removeDiacritics(str){
      if(!str) return "";
      return String(str)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/đ/g, "d")
        .replace(/Đ/g, "d")
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
      let s = String(name).normalize("NFC").trim();
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
      let val = data.pccmMatrix?.[classId + "|" + mon] || data.pccmMatrix?.[classCanon + "|" + mon] || "";
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
      let val = data.pccmRoomMatrix?.[classId + "|" + mon] || data.pccmRoomMatrix?.[classCanon + "|" + mon] || "";
      return String(val || "").trim();
    }

    getRequiredPeriods(lop, mon){
      const data = this.data;
      const classId = String(lop?.id || "");
      const classCanon = lop?.ten2 || lop?.ten || classId;
      let raw = data.pccmTietMatrix?.[classId + "|" + mon] ?? data.pccmTietMatrix?.[classCanon + "|" + mon];
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
      const raw = data.pccmGioihanMatrix?.[classId + "|" + mon] ?? data.pccmGioihanMatrix?.[classCanon + "|" + mon];
      if(raw !== undefined && raw !== null && raw !== ""){
        const val = Number(raw);
        if(Number.isFinite(val) && val > 0) return val;
      }
      return 2;
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
      this.classGridList = [];
      this.teacherGridList = [];
      this.roomGridList = [];
      this.classIndexMap = new Map();
      this.teacherIndexMap = new Map();
      this.roomIndexMap = new Map();
      this.teachers = [];
      this.rooms = [];
      this.actPlacement = [];
      this.tabuMap = new Map();
      this.swapStep = 0;
      this.triedRemovals = new Map();
      this.swappedInBranch = new Set();
      this.restoreStack = [];

      const data = this.data;
      const rawLop = Array.isArray(data.lop) ? data.lop : (Array.isArray(data.dslop) ? data.dslop : []);
      this.classes = rawLop.filter(l => l && (l.id || l.ten));

      this.scoredTeachers = new Set();
      const pccm = (data && data.pccmMatrix && typeof data.pccmMatrix === "object") ? data.pccmMatrix : {};
      for(const value of Object.values(pccm)){
        for(const t of parseTeacherList(value)) this.scoredTeachers.add(t);
      }

      this.classes.forEach((l, idx) => {
        const cid = String(l.id || "");
        this.classIndexMap.set(cid, idx);
        const grid = new Int32Array(TOTAL_SLOTS).fill(-1);
        const fixedOffClass = data?.tkbConstraints?.fixedOff?.class || {};
        const hasExplicitClassFixedOff = Boolean(
          (cid && fixedOffClass[cid] && Object.keys(fixedOffClass[cid]).length > 0) ||
          (l.ten && fixedOffClass[l.ten] && Object.keys(fixedOffClass[l.ten]).length > 0) ||
          (l.ten2 && fixedOffClass[l.ten2] && Object.keys(fixedOffClass[l.ten2]).length > 0)
        );

        let ca = String(l.ca || l.buoi || l.buoiday || "").trim().toLowerCase();
        if(!ca && !hasExplicitClassFixedOff){
          const idStr = String(l.id || l.ten || l.name || "").trim().toLowerCase();
          const m = idStr.match(/^k?(\d+)/i) || idStr.match(/(\d+)/);
          if(m){
            const grade = parseInt(m[1], 10);
            if(grade === 6 || grade === 9 || grade === 10 || grade === 12){
              ca = "sang";
            } else if(grade === 7 || grade === 8 || grade === 11){
              ca = "chieu";
            }
          }
        }
        if(ca === "sang" || ca === "morning"){
          for(let d = 0; d < DAYS_LIST.length; d++){
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const slot = d * SLOTS_PER_DAY + 1 * PERIODS_PER_SESSION + p;
              grid[slot] = -2;
              this.offSlots.add(cid + "|" + slot);
            }
          }
        } else if(ca === "chieu" || ca === "afternoon"){
          for(let d = 0; d < DAYS_LIST.length; d++){
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const slot = d * SLOTS_PER_DAY + 0 * PERIODS_PER_SESSION + p;
              grid[slot] = -2;
              this.offSlots.add(cid + "|" + slot);
            }
          }
        }
        this.classGrid.set(cid, grid);
        this.classGridList.push(grid);
      });

      this.roomLocationMap = new Map();
      const rawRooms = Array.isArray(data.phong) ? data.phong : (Array.isArray(data.phonghoc) ? data.phonghoc : []);
      rawRooms.forEach(r => {
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

      this.classes.forEach(l => {
        const cid = String(l.id || "");
        DAYS_LIST.forEach((thu) => {
          SESSIONS_LIST.forEach((buoi) => {
            const arr = data.tkb?.[cid]?.[thu]?.[buoi] || [];
            for(let ti = 0; ti < PERIODS_PER_SESSION; ti++){
              const slot = detailsToSlot(thu, buoi, ti);
              const cell = arr[ti];
              const key = cid + "|" + slot;

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
                  if(!this.teacherGrid.has(t)){
                    const tGrid = new Int32Array(TOTAL_SLOTS).fill(-1);
                    this.teacherGrid.set(t, tGrid);
                    this.teacherIndexMap.set(t, this.teachers.length);
                    this.teachers.push(t);
                    this.teacherGridList.push(tGrid);
                  }
                  this.teacherGrid.get(t)[slot] = -3;
                });
                if(rm){
                  const rKey = rm.trim().toLowerCase();
                  if(!this.roomGrid.has(rKey)){
                    const rGrid = new Int32Array(TOTAL_SLOTS).fill(-1);
                    this.roomGrid.set(rKey, rGrid);
                    this.roomIndexMap.set(rKey, this.rooms.length);
                    this.rooms.push(rKey);
                    this.roomGridList.push(rGrid);
                  }
                  this.roomGrid.get(rKey)[slot] = -3;
                }
              }
            }
          });
        });
      });

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
                this.offSlots.add(targetCid + "|" + slot);
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
                this.teacherOffSlots.add(tKey + "|" + slot);
                if(!this.teacherGrid.has(tKey)){
                  const tGrid = new Int32Array(TOTAL_SLOTS).fill(-1);
                  this.teacherGrid.set(tKey, tGrid);
                  this.teacherIndexMap.set(tKey, this.teachers.length);
                  this.teachers.push(tKey);
                  this.teacherGridList.push(tGrid);
                }
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
                this.roomOffSlots.add(rKey + "|" + slot);
                if(!this.roomGrid.has(rKey)){
                  const rGrid = new Int32Array(TOTAL_SLOTS).fill(-1);
                  this.roomGrid.set(rKey, rGrid);
                  this.roomIndexMap.set(rKey, this.rooms.length);
                  this.rooms.push(rKey);
                  this.roomGridList.push(rGrid);
                }
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
                this.subjectOffSlots.add(sCanon + "|" + slot);
                this.subjectOffSlots.add(sRaw.trim().toLowerCase() + "|" + slot);
              }
            }
          }
        });
      });

      this.buildActivities();

      this.teacherSessionCounts = new Int8Array(this.teachers.length * 12);
      for(let tIdx = 0; tIdx < this.teachers.length; tIdx++){
        const tg = this.teacherGridList[tIdx];
        if(!tg) continue;
        for(let s = 0; s < TOTAL_SLOTS; s++){
          if(tg[s] === -3){
            this.teacherSessionCounts[tIdx * 12 + Math.floor(s / PERIODS_PER_SESSION)]++;
          }
        }
      }

      this.hasSubjectOff = this.subjectOffSlots.size > 0;
      this.hasSubjectConstraints = Boolean(data?.tkbConstraints?.subject && Object.keys(data.tkbConstraints.subject).length > 0);
      this.hasNoSameSession = Boolean(data?.tkbConstraints?.subjectNoSameSession?.byClass);
      this.hasTeacherConstraints = Boolean(data?.tkbConstraints?.teacher && Object.keys(data.tkbConstraints.teacher).length > 0);
      this.hasSubjectGroupConstraints = Boolean(data?.tkbConstraints?.subjectGroup || data?.tkbConstraints?.groups);
      this.hasTimeLimitConstraints = Boolean(Array.isArray(data?.tkbConstraints?.timeLimit) && data.tkbConstraints.timeLimit.length > 0);
      this.hasAnyComplexConstraint = this.hasSubjectOff || this.hasSubjectConstraints || this.hasNoSameSession || this.hasTeacherConstraints || this.hasSubjectGroupConstraints || this.hasTimeLimitConstraints;
    }

    getSubjectRules(mon, lop){
      const data = this.data;
      if(!mon) return {};
      const monNorm = this.normalizeMonName(mon);
      let sobj = data.tkbConstraints?.subject?.[mon] || data.tkbConstraints?.subject?.[monNorm];
      if(!sobj && data.tkbConstraints?.subject){
        for(const [k, v] of Object.entries(data.tkbConstraints.subject)){
          if(this.normalizeMonName(k) === monNorm){
            sobj = v;
            break;
          }
        }
      }
      if(!sobj) return {};
      if(!lop) return sobj;
      const cid = String(lop.id || "");
      const classCanon = lop.ten2 || lop.ten || cid;
      const cTen = lop.ten || "";
      const cTen2 = lop.ten2 || "";
      const byClass = sobj.byClass || {};
      const r = byClass[cid] || byClass[classCanon] || byClass[cTen] || byClass[cTen2] || {};
      return Object.assign({}, sobj, r);
    }

    buildActivities(){
      this.activities = [];
      const data = this.data;
      let actIdCounter = 0;

      this.classes.forEach(lop => {
        const cid = String(lop.id || "");
        const classCanon = lop.ten2 || lop.ten || cid;

        const assignedSubjects = new Set();
        Object.keys(data.pccmMatrix || {}).forEach(k => {
          if(k.startsWith(cid + "|") || k.startsWith(classCanon + "|")){
            assignedSubjects.add(k.split("|").slice(1).join("|"));
          }
        });

        const fixedCountBySub = new Map();
        for(let s = 0; s < TOTAL_SLOTS; s++){
          const fix = this.fixedSlots.get(cid + "|" + s);
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
          const tIndices = [];
          tList.forEach(t => {
            if(!this.teacherGrid.has(t)){
              const tGrid = new Int32Array(TOTAL_SLOTS).fill(-1);
              this.teacherGrid.set(t, tGrid);
              this.teacherIndexMap.set(t, this.teachers.length);
              this.teachers.push(t);
              this.teacherGridList.push(tGrid);
            }
            tIndices.push(this.teacherIndexMap.get(t));
          });

          let roomIdx = -1;
          if(roomRaw){
            const rKey = roomRaw.trim().toLowerCase();
            if(!this.roomGrid.has(rKey)){
              const rGrid = new Int32Array(TOTAL_SLOTS).fill(-1);
              this.roomGrid.set(rKey, rGrid);
              this.roomIndexMap.set(rKey, this.rooms.length);
              this.rooms.push(rKey);
              this.roomGridList.push(rGrid);
            }
            roomIdx = this.roomIndexMap.get(rKey);
          }

          const loc = (roomRaw && this.roomLocationMap.get(roomRaw.toLowerCase())) || this.classLocationMap.get(cid.toLowerCase()) || "";

          const subRules = this.getSubjectRules(mon, lop);
          const lessonBlocks = subRules.lessonBlocks || {};
          let hasExplicitBlocks = false;
          for(const K of [5, 4, 3, 2]){
            const b = lessonBlocks[String(K)] || lessonBlocks[K] || {};
            if((Number(b.min) || 0) > 0 || (Number(b.max) || 0) > 0){
              hasExplicitBlocks = true;
              break;
            }
          }

          const subSessionAllowed = subRules.sessionAllowed || "";
          const classCa = lop.ca ? String(lop.ca).toLowerCase() : "";
          let sessionAllowed = "ca_ngay";
          if(subSessionAllowed === "sang" || subSessionAllowed === "chieu"){
            sessionAllowed = subSessionAllowed;
          } else if(classCa === "sang" || classCa === "chieu"){
            sessionAllowed = classCa;
          }

          const cIdx = this.classIndexMap.get(cid);

          let rem = needed;
          const blocksMax = {};
          for(const K of [5, 4, 3, 2]){
            const blockConfig = lessonBlocks[String(K)] || lessonBlocks[K] || {};
            if(blockConfig.max !== undefined && blockConfig.max !== "" && blockConfig.max !== null){
              const val = Number(blockConfig.max);
              if(!isNaN(val) && val >= 0){
                blocksMax[K] = val;
              }
            }
          }
          const lessonBlocksMax = Object.keys(blocksMax).length > 0 ? blocksMax : null;

          for(const K of [5, 4, 3, 2]){
            const blockConfig = lessonBlocks[String(K)] || lessonBlocks[K] || {};
            const kMin = Number(blockConfig.min) || 0;
            const kMax = Number(blockConfig.max) || 0;
            let validMin = kMin;
            if(kMax > 0 && validMin > kMax) validMin = kMax;
            const count = Math.min(validMin, Math.floor(rem / K));
            for(let b = 0; b < count; b++){
              this.activities.push({
                id: actIdCounter++,
                classId: cid,
                classIdx: cIdx,
                mon,
                canonKey,
                gv: teacherRaw,
                gvList: tList,
                teacherIdxs: new Int32Array(tIndices),
                room: roomRaw,
                roomIdx,
                location: loc,
                duration: K,
                maxDaily: Math.max(maxDaily, K),
                mustKeepBlock: true,
                lessonBlockLen: K,
                lessonBlocksMax,
                isFixed: false,
                sessionAllowed
              });
              rem -= K;
            }
          }

          while(rem > 0){
            this.activities.push({
              id: actIdCounter++,
              classId: cid,
              classIdx: cIdx,
              mon,
              canonKey,
              gv: teacherRaw,
              gvList: tList,
              teacherIdxs: new Int32Array(tIndices),
              room: roomRaw,
              roomIdx,
              location: loc,
              duration: 1,
              maxDaily,
              mustKeepBlock: false,
              lessonBlockLen: 1,
              lessonBlocksMax,
              isFixed: false,
              sessionAllowed
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
      const teacherSessionCounts = this.teacherSessionCounts ? new Int8Array(this.teacherSessionCounts) : null;
      return { placement, classGrid, teacherGrid, roomGrid, teacherSessionCounts };
    }

    restoreStateSnapshot(snap){
      if(!snap) return;
      this.actPlacement = snap.placement.slice();
      snap.classGrid.forEach((v, k) => {
        const g = this.classGrid.get(k);
        if(g) g.set(v);
      });
      snap.teacherGrid.forEach((v, k) => {
        const g = this.teacherGrid.get(k);
        if(g) g.set(v);
      });
      snap.roomGrid.forEach((v, k) => {
        const g = this.roomGrid.get(k);
        if(g) g.set(v);
      });
      if(snap.teacherSessionCounts && this.teacherSessionCounts){
        this.teacherSessionCounts.set(snap.teacherSessionCounts);
      }
    }

    placeActivityDirect(actId, slot){
      const act = this.activities[actId];
      if(!act) return false;
      if(act.lockedByLessonBlock && act.isFixed){
        const cur = this.actPlacement[actId];
        if(cur >= 0 && cur !== slot) return false;
      }
      if(act.isFixed && this.actPlacement[actId] >= 0 && this.actPlacement[actId] !== slot) return false;

      this.actPlacement[actId] = slot;
      const dur = act.duration;
      const cGrid = this.classGridList[act.classIdx];

      if(this.teacherSessionCounts){
        const sessIdx = Math.floor(slot / PERIODS_PER_SESSION);
        for(let i = 0; i < act.teacherIdxs.length; i++){
          this.teacherSessionCounts[act.teacherIdxs[i] * 12 + sessIdx] += dur;
        }
      }

      for(let d = 0; d < dur; d++){
        const s = slot + d;
        if(cGrid) cGrid[s] = actId;
        for(let i = 0; i < act.teacherIdxs.length; i++){
          const tg = this.teacherGridList[act.teacherIdxs[i]];
          if(tg) tg[s] = actId;
        }
        if(act.roomIdx >= 0){
          const rg = this.roomGridList[act.roomIdx];
          if(rg) rg[s] = actId;
        }
      }
      return true;
    }

    unplaceActivity(actId){
      const act = this.activities[actId];
      if(!act) return false;
      if(act.lockedByLessonBlock && act.isFixed) return false;
      if(act.isFixed) return false;
      const slot = this.actPlacement[actId];
      if(slot < 0) return false;
      this.actPlacement[actId] = -1;

      const dur = act.duration;
      const cGrid = this.classGridList[act.classIdx];

      if(this.teacherSessionCounts){
        const sessIdx = Math.floor(slot / PERIODS_PER_SESSION);
        for(let i = 0; i < act.teacherIdxs.length; i++){
          this.teacherSessionCounts[act.teacherIdxs[i] * 12 + sessIdx] -= dur;
        }
      }

      for(let d = 0; d < dur; d++){
        const s = slot + d;
        if(cGrid && cGrid[s] === actId) cGrid[s] = -1;
        for(let i = 0; i < act.teacherIdxs.length; i++){
          const tg = this.teacherGridList[act.teacherIdxs[i]];
          if(tg && tg[s] === actId) tg[s] = -1;
        }
        if(act.roomIdx >= 0){
          const rg = this.roomGridList[act.roomIdx];
          if(rg && rg[s] === actId) rg[s] = -1;
        }
      }
      return true;
    }

    isSlotFeasible(act, slot, ignoreActIdOrSet = -1){
      const dur = act.duration;
      const startInDay = slot % SLOTS_PER_DAY;
      const sessionIdx = Math.floor(startInDay / PERIODS_PER_SESSION);
      const endInDay = startInDay + dur - 1;
      const endSessionIdx = Math.floor(endInDay / PERIODS_PER_SESSION);

      if(sessionIdx !== endSessionIdx) return false;

      const cGrid = this.classGridList[act.classIdx];
      if(!cGrid) return false;

      if(ignoreActIdOrSet === "domain_only"){
        for(let d = 0; d < dur; d++){
          const s = slot + d;
          const occ = cGrid[s];
          if(occ === -2 || occ === -3) return false;

          for(let i = 0; i < act.teacherIdxs.length; i++){
            const tg = this.teacherGridList[act.teacherIdxs[i]];
            if(tg && (tg[s] === -2 || tg[s] === -3)) return false;
          }
          if(act.roomIdx >= 0){
            const rg = this.roomGridList[act.roomIdx];
            if(rg && (rg[s] === -2 || rg[s] === -3)) return false;
          }
        }
        const conf = this.constraintConflictForSlot(act, slot, "domain_only");
        if(conf) return false;
        return true;
      }

      const isIgnored = (id) => {
        if(id < 0) return false;
        if(id === act.id) return true;
        if(typeof ignoreActIdOrSet === "number") return id === ignoreActIdOrSet;
        if(ignoreActIdOrSet instanceof Set) return ignoreActIdOrSet.has(id);
        return false;
      };

      for(let d = 0; d < dur; d++){
        const s = slot + d;
        const occ = cGrid[s];
        if(occ === -2 || occ === -3) return false;
        if(occ >= 0 && !isIgnored(occ)) return false;

        for(let i = 0; i < act.teacherIdxs.length; i++){
          const tIdx = act.teacherIdxs[i];
          const tg = this.teacherGridList[tIdx];
          if(tg){
            const tocc = tg[s];
            if(tocc === -2 || tocc === -3) return false;
            if(tocc >= 0 && !isIgnored(tocc)) return false;
          }
        }

        if(act.roomIdx >= 0){
          const rg = this.roomGridList[act.roomIdx];
          if(rg){
            const rocc = rg[s];
            if(rocc === -2 || rocc === -3) return false;
            if(rocc >= 0 && !isIgnored(rocc)) return false;
          }
        }
      }

      // Session limit and consecutive check for the same subject in this session
      const dayIdx = Math.floor(slot / SLOTS_PER_DAY);
      const sessionStart = dayIdx * SLOTS_PER_DAY + sessionIdx * PERIODS_PER_SESSION;
      let sessionCount = 0;
      let minPeriod = 999;
      let maxPeriod = -1;

      for(let d = 0; d < dur; d++){
        const p = (slot + d) - sessionStart;
        if(p < minPeriod) minPeriod = p;
        if(p > maxPeriod) maxPeriod = p;
        sessionCount++;
      }

      for(let p = 0; p < PERIODS_PER_SESSION; p++){
        const s = sessionStart + p;
        if(s >= slot && s < slot + dur) continue;
        const occ = cGrid[s];
        if(occ >= 0 && !isIgnored(occ)){
          const otherAct = this.activities[occ];
          if(otherAct && (otherAct.canonKey === act.canonKey || this.getCanonMonKey(otherAct.mon) === act.canonKey)){
            sessionCount++;
            if(p < minPeriod) minPeriod = p;
            if(p > maxPeriod) maxPeriod = p;
          }
        }else if(occ === -3){
          const fix = this.fixedSlots.get(act.classId + "|" + s);
          if(fix && this.getCanonMonKey(fix.mon) === act.canonKey){
            sessionCount++;
            if(p < minPeriod) minPeriod = p;
            if(p > maxPeriod) maxPeriod = p;
          }
        }
      }

      const effectiveMaxDaily = (act.maxDaily !== undefined && act.maxDaily !== null && act.maxDaily > 0) ? act.maxDaily : 2;
      if(sessionCount > effectiveMaxDaily) return false;
      if(sessionCount >= 2 && (maxPeriod - minPeriod + 1 !== sessionCount)) return false;

      if(act.lessonBlocksMax){
        for(const [kStr, kMax] of Object.entries(act.lessonBlocksMax)){
          const K = Number(kStr);
          let kCount = (sessionCount === K) ? 1 : 0;
          for(let d = 0; d < DAYS_LIST.length; d++){
            for(let b = 0; b < SESSIONS_LIST.length; b++){
              if(d === dayIdx && b === sessionIdx) continue;
              const otherSessionStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
              let otherCount = 0;
              for(let p = 0; p < PERIODS_PER_SESSION; p++){
                const s = otherSessionStart + p;
                const occ = cGrid[s];
                if(occ >= 0 && !isIgnored(occ)){
                  const otherAct = this.activities[occ];
                  if(otherAct && (otherAct.canonKey === act.canonKey || this.getCanonMonKey(otherAct.mon) === act.canonKey)){
                    otherCount++;
                  }
                }else if(occ === -3){
                  const fix = this.fixedSlots.get(act.classId + "|" + s);
                  if(fix && this.getCanonMonKey(fix.mon) === act.canonKey){
                    otherCount++;
                  }
                }
              }
              if(otherCount === K) kCount++;
            }
          }
          if(kCount > kMax) return false;
        }
      }

      // Student session contiguity guard (Strict Zero Student Holes Invariant)
      if(cGrid){
        const sStart = dayIdx * SLOTS_PER_DAY + sessionIdx * PERIODS_PER_SESSION;
        let origMask = 0;
        let newMask = 0;
        for(let p = 0; p < PERIODS_PER_SESSION; p++){
          const s = sStart + p;
          const occ = cGrid[s];
          if(occ === -3 || (occ >= 0 && !isIgnored(occ))){
            origMask |= (1 << p);
          }
          if(s >= slot && s < slot + dur){
            newMask |= (1 << p);
          } else if(occ === -3 || (occ >= 0 && !isIgnored(occ))){
            newMask |= (1 << p);
          }
        }
        let origMin = 99, origMax = -1, newMin = 99, newMax = -1;
        for(let p = 0; p < PERIODS_PER_SESSION; p++){
          if((origMask & (1 << p)) !== 0){ if(p < origMin) origMin = p; if(p > origMax) origMax = p; }
          if((newMask & (1 << p)) !== 0){ if(p < newMin) newMin = p; if(p > newMax) newMax = p; }
        }
        let origHoles = 0, newHoles = 0;
        if(origMin < origMax){
          for(let p = origMin + 1; p < origMax; p++){
            if((origMask & (1 << p)) === 0 && cGrid[sStart + p] === -1) origHoles++;
          }
        }
        if(newMin < newMax){
          for(let p = newMin + 1; p < newMax; p++){
            if((newMask & (1 << p)) === 0 && cGrid[sStart + p] === -1) newHoles++;
          }
        }
        if(newHoles > 0 && newHoles > origHoles){
          return false;
        }
      }

      // Teacher gap-2 guard in session: Disallow creating a gap >= 2 for teachers in the same session (MaxGapPerSession <= 1)
      if(this.strictTeacherGaps !== false && this.strictFetGaps !== false){
        const sStart = dayIdx * SLOTS_PER_DAY + sessionIdx * PERIODS_PER_SESSION;
        for(let i = 0; i < act.teacherIdxs.length; i++){
          const tg = this.teacherGridList[act.teacherIdxs[i]];
          if(!tg) continue;
          let mask = 0;
          for(let p = 0; p < PERIODS_PER_SESSION; p++){
            const s = sStart + p;
            if(s >= slot && s < slot + dur){
              mask |= (1 << p);
            } else {
              const tocc = tg[s];
              if(tocc === -3 || (tocc >= 0 && !isIgnored(tocc))){
                mask |= (1 << p);
              }
            }
          }
          if(SESSION_STATS_LUT[mask].gaps >= 2){
            return false;
          }
        }
      }

      const conf = this.constraintConflictForSlot(act, slot, ignoreActIdOrSet);
      if(conf) return false;

      return true;
    }

    hasTeacherSessionGap2(tIdx, sessIdx){
      const tg = this.teacherGridList[tIdx];
      if(!tg) return false;
      const sStart = sessIdx * PERIODS_PER_SESSION;
      let mask = 0;
      for(let p = 0; p < PERIODS_PER_SESSION; p++){
        const occ = tg[sStart + p];
        if(occ >= 0 || occ === -3) mask |= (1 << p);
      }
      return SESSION_STATS_LUT[mask].gaps >= 2;
    }

    computeTeacherWeeklyLoad(){
      this.teacherWeeklyLoad = new Map();
      this.activities.forEach(a => {
        a.gvList.forEach(t => {
          this.teacherWeeklyLoad.set(t, (this.teacherWeeklyLoad.get(t) || 0) + a.duration);
        });
      });
      for(let tIdx = 0; tIdx < this.teachers.length; tIdx++){
        const t = this.teachers[tIdx];
        let fixedCount = 0;
        const tg = this.teacherGridList[tIdx];
        if(tg){
          for(let s = 0; s < TOTAL_SLOTS; s++){
            if(tg[s] === -3) fixedCount++;
          }
        }
        if(fixedCount > 0){
          this.teacherWeeklyLoad.set(t, (this.teacherWeeklyLoad.get(t) || 0) + fixedCount);
        }
      }
    }

    opensUnaffordableSession(act, slot){
      if(!this.minTwoGuardActive || !this.teacherSessionCounts) return false;
      const sessIdx = Math.floor(slot / PERIODS_PER_SESSION);
      const dayIdx = Math.floor(slot / SLOTS_PER_DAY);
      const dur = act.duration;

      for(let i = 0; i < act.teacherIdxs.length; i++){
        const tIdx = act.teacherIdxs[i];
        const tBase = tIdx * 12;
        const tKey = this.teachers[tIdx];
        const totalLoad = this.teacherWeeklyLoad?.get(tKey) || 0;

        if(totalLoad <= 1) continue;

        let totalPlaced = 0;
        const dayLoads = new Int32Array(6);
        for(let d = 0; d < 6; d++){
          const load = this.teacherSessionCounts[tBase + 2 * d] + this.teacherSessionCounts[tBase + 2 * d + 1];
          dayLoads[d] = load;
          totalPlaced += load;
        }

        // simulate placing act on dayIdx
        dayLoads[dayIdx] += dur;

        let openedDays = 0;
        let totalDeficit = 0;
        for(let d = 0; d < 6; d++){
          const hd = dayLoads[d];
          if(hd > 0){
            openedDays++;
            if(hd < 2){
              totalDeficit += (2 - hd);
            }
          }
        }

        const oddRemainder = totalLoad % 2;
        if(2 * openedDays - oddRemainder > totalLoad){
          return true;
        }

        const adjDeficit = Math.max(0, totalDeficit - oddRemainder);
        const remainingUnplaced = totalLoad - (totalPlaced + dur);
        if(adjDeficit > remainingUnplaced){
          return true;
        }

        const countInSession = this.teacherSessionCounts[tBase + sessIdx];
        if(countInSession === 0 && dur === 1){
          let otherActiveSessions = 0;
          let roomInExisting = false;
          for(let s2 = 0; s2 < 12; s2++){
            if(s2 === sessIdx) continue;
            const c2 = this.teacherSessionCounts[tBase + s2];
            if(c2 > 0) otherActiveSessions++;
            if(c2 >= 1 && c2 < PERIODS_PER_SESSION) roomInExisting = true;
          }
          if(otherActiveSessions > 0 && roomInExisting && remainingUnplaced < 2 * otherActiveSessions){
            return true;
          }
        }
      }
      return false;
    }

    computeActivityMRV(){
      this.computeTeacherWeeklyLoad();
      const nActs = this.activities.length;
      const classDur = new Float64Array(this.classes.length);
      const teacherDur = new Float64Array(this.teachers.length);
      const roomDur = new Float64Array(this.rooms.length);

      for(let i = 0; i < nActs; i++){
        const act = this.activities[i];
        classDur[act.classIdx] += act.duration;
        for(let j = 0; j < act.teacherIdxs.length; j++){
          teacherDur[act.teacherIdxs[j]] += act.duration;
        }
        if(act.roomIdx >= 0) roomDur[act.roomIdx] += act.duration;
      }

      for(let i = 0; i < nActs; i++){
        const act = this.activities[i];
        let confl = classDur[act.classIdx];
        for(let j = 0; j < act.teacherIdxs.length; j++){
          confl += teacherDur[act.teacherIdxs[j]];
        }
        if(act.roomIdx >= 0) confl += roomDur[act.roomIdx];
        let diff = confl * act.duration;
        if(act.isFixed) diff += INF;
        act.difficulty = diff;
      }
    }

    computeDifficultiesAndSort(){
      this.computeActivityMRV();
      for(const act of this.activities){
        const allowed = this.allowedSlotsByActivity?.get(act) || [];
        act.baseDomainSize = allowed.length;
      }

      this.activities.sort((a, b) => {
        if(a.baseDomainSize !== b.baseDomainSize) return a.baseDomainSize - b.baseDomainSize;
        if(b.duration !== a.duration) return b.duration - a.duration;
        if(b.difficulty !== a.difficulty) return b.difficulty - a.difficulty;
        return a.id - b.id;
      });

      this.activities.forEach((a, idx) => a.id = idx);
      this.actPlacement = new Array(this.activities.length).fill(-1);
    }

    slotTeacherGapPenalty(act, slot){
      let penalty = 0;
      const dIdx = Math.floor(slot / SLOTS_PER_DAY);
      const sIdx = Math.floor((slot % SLOTS_PER_DAY) / PERIODS_PER_SESSION);
      const sStart = dIdx * SLOTS_PER_DAY + sIdx * PERIODS_PER_SESSION;
      const pIdx = slot % PERIODS_PER_SESSION;

      for(let i = 0; i < act.teacherIdxs.length; i++){
        const tg = this.teacherGridList[act.teacherIdxs[i]];
        if(!tg) continue;
        let mask = 0;
        for(let p = 0; p < PERIODS_PER_SESSION; p++){
          if(p >= pIdx && p < pIdx + act.duration) mask |= (1 << p);
          else if(tg[sStart + p] >= 0 || tg[sStart + p] === -3) mask |= (1 << p);
        }
        penalty += GAP_PENALTY_LUT[mask];
      }
      return penalty;
    }

    slotTeacherAffinityScore(act, slot){
      let score = this.slotTeacherGapPenalty(act, slot) * 100;
      if(!this.teacherSessionCounts) return score;

      const dIdx = Math.floor(slot / SLOTS_PER_DAY);
      const sIdx = Math.floor((slot % SLOTS_PER_DAY) / PERIODS_PER_SESSION);
      const sessOffset = dIdx * 2 + sIdx;
      const otherOffset = dIdx * 2 + (1 - sIdx);

      for(let i = 0; i < act.teacherIdxs.length; i++){
        const tIdx = act.teacherIdxs[i];
        const tBase = tIdx * 12;

        const cntInSess = this.teacherSessionCounts[tBase + sessOffset];
        if(cntInSess === 1){
          score -= 150;
        } else if(cntInSess === 2){
          score -= 80;
        } else if(cntInSess === 3){
          score -= 40;
        } else if(cntInSess === 0){
          const otherCnt = this.teacherSessionCounts[tBase + otherOffset];
          if(otherCnt > 0){
            score += 10;
          } else {
            score += 60;
          }
        }
      }
      return score;
    }

    getUnassignedCount(){
      let count = 0;
      for(let i = 0; i < this.activities.length; i++){
        if(this.actPlacement[i] < 0) count++;
      }
      return count;
    }

    randomSwap(actId, level = 0){
      if(this.nCalls++ >= this.limitCalls) return false;
      if(this.deadlineAtMs && (this.nCalls & 15) === 0 && Date.now() >= this.deadlineAtMs) return false;
      if(level >= MAX_RECURSION_LEVEL) return false;

      const act = this.activities[actId];
      if(!act) return false;

      // Phase 1: Free slots
      let allFeasible = [];
      if(act.mustTeachTargetSlot !== undefined && act.mustTeachTargetSlot >= 0){
        if(this.isSlotFeasible(act, act.mustTeachTargetSlot)) allFeasible.push(act.mustTeachTargetSlot);
      } else {
        const allowedSlots = this.allowedSlotsByActivity?.get(act) || [];
        for(let i = 0; i < allowedSlots.length; i++){
          const s = allowedSlots[i];
          if(this.isSlotFeasible(act, s)) allFeasible.push(s);
        }
      }

      if(allFeasible.length > 0){
        let candidateSlots = allFeasible;
        if(level < 6 && this.minTwoGuardActive){
          const filtered = allFeasible.filter(s => !this.opensUnaffordableSession(act, s));
          if(filtered.length > 0) candidateSlots = filtered;
        }
        this.rng.shuffle(candidateSlots);

        const sampleSize = Math.min(candidateSlots.length, 4);
        let bestSlot = candidateSlots[0];
        let bestScore = this.slotTeacherAffinityScore(act, bestSlot);
        for(let i = 1; i < sampleSize; i++){
          const s = candidateSlots[i];
          const sc = this.slotTeacherAffinityScore(act, s);
          if(sc < bestScore){
            bestScore = sc;
            bestSlot = s;
          }
        }
        this.placeActivityDirect(actId, bestSlot);
        return true;
      }

      const allowedSlots = this.allowedSlotsByActivity?.get(act) || [];
      let candidateSlots = allowedSlots.slice();
      if(candidateSlots.length === 0) return false;
      this.rng.shuffle(candidateSlots);

      // Phase 2: Speculative Ejection (Min-Conflicts with Persistent Tabu & Aspiration)
      const cGrid = this.classGridList[act.classIdx];
      const candidateInfo = [];
      for(let i = 0; i < candidateSlots.length; i++){
        const slot = candidateSlots[i];

        let hardBlocked = false;
        for(let d = 0; d < act.duration; d++){
          const s = slot + d;
          if(cGrid[s] === -2 || cGrid[s] === -3){ hardBlocked = true; break; }
          for(let t = 0; t < act.teacherIdxs.length; t++){
            const tg = this.teacherGridList[act.teacherIdxs[t]];
            if(tg && (tg[s] === -2 || tg[s] === -3)){ hardBlocked = true; break; }
          }
          if(act.roomIdx >= 0){
            const rg = this.roomGridList[act.roomIdx];
            if(rg && (rg[s] === -2 || rg[s] === -3)){ hardBlocked = true; break; }
          }
        }
        if(hardBlocked) continue;

        // Check if actId at slot is currently Tabu
        const actTabuKey = actId + '@' + slot;
        const actExp = this.tabuMap.get(actTabuKey);
        if(actExp !== undefined && actExp > this.swapStep){
          continue;
        }

        const displacedActIds = new Set();
        for(let d = 0; d < act.duration; d++){
          const s = slot + d;
          const cOcc = cGrid[s];
          if(cOcc >= 0 && cOcc !== actId) displacedActIds.add(cOcc);
          for(let t = 0; t < act.teacherIdxs.length; t++){
            const tg = this.teacherGridList[act.teacherIdxs[t]];
            if(tg){
              const tocc = tg[s];
              if(tocc >= 0 && tocc !== actId) displacedActIds.add(tocc);
            }
          }
          if(act.roomIdx >= 0){
            const rg = this.roomGridList[act.roomIdx];
            if(rg){
              const rocc = rg[s];
              if(rocc >= 0 && rocc !== actId) displacedActIds.add(rocc);
            }
          }
        }

        if(displacedActIds.size === 0) continue;

        let hasFixed = false;
        for(const dispId of displacedActIds){
          const dispAct = this.activities[dispId];
          if(!dispAct || dispAct.isFixed || dispAct.lockedByLessonBlock){
            hasFixed = true; break;
          }
          if(this.swappedInBranch.has(dispId)){
            hasFixed = true; break;
          }
        }
        if(hasFixed) continue;

        let totalWrong = 0;
        let minIndexAct = -1;
        let domainTightnessPenalty = 0;
        displacedActIds.forEach(id => {
          totalWrong += (this.triedRemovals.get(id) || 0);
          if(id > minIndexAct) minIndexAct = id;
          const dAct = this.activities[id];
          if(dAct){
            const dom = this.allowedSlotsByActivity?.get(dAct);
            const domLen = dom ? dom.length : 30;
            domainTightnessPenalty += Math.round(50 / Math.max(1, domLen));
          }
        });

        const sessionAffinityScore = this.slotTeacherAffinityScore(act, slot);

        candidateInfo.push({
          slot,
          displacedActIds: Array.from(displacedActIds),
          nConflActs: displacedActIds.size,
          totalWrong: totalWrong + domainTightnessPenalty,
          sessionAffinityScore,
          minIndexAct
        });
      }

      candidateInfo.sort((a, b) => {
        if(a.nConflActs !== b.nConflActs) return a.nConflActs - b.nConflActs;
        if(a.totalWrong !== b.totalWrong) return a.totalWrong - b.totalWrong;
        return (this.rng.next() - 0.5);
      });

      for(let i = 0; i < candidateInfo.length; i++){
        const cand = candidateInfo[i];
        const slot = cand.slot;
        const displaced = cand.displacedActIds;

        const affectedTeacherSessions = [];
        for(let j = 0; j < displaced.length; j++){
          const dId = displaced[j];
          const dAct = this.activities[dId];
          const dSlot = this.actPlacement[dId];
          if(dSlot >= 0 && dAct){
            const sessIdx = Math.floor(dSlot / PERIODS_PER_SESSION);
            for(let t = 0; t < dAct.teacherIdxs.length; t++){
              const tIdx = dAct.teacherIdxs[t];
              const origHadGap2 = this.hasTeacherSessionGap2(tIdx, sessIdx);
              affectedTeacherSessions.push({ tIdx, sessIdx, origHadGap2 });
            }
          }
        }

        const snap = this.captureStateSnapshot();
        this.swapStep = (this.swapStep || 0) + 1;
        const tenure = 5 + (Math.abs(this.rng.next()) % 8); // tenure in [5, 12]

        for(let j = 0; j < displaced.length; j++){
          const dId = displaced[j];
          const dSlot = this.actPlacement[dId];
          if(dSlot >= 0){
            this.tabuMap.set(dId + '@' + dSlot, this.swapStep + tenure);
          }
          this.triedRemovals.set(dId, (this.triedRemovals.get(dId) || 0) + 1);
          this.unplaceActivity(dId);
          this.swappedInBranch.add(dId);
        }

        if(!this.isSlotFeasible(act, slot)){
          this.restoreStateSnapshot(snap);
          for(let j = 0; j < displaced.length; j++) this.swappedInBranch.delete(displaced[j]);
          continue;
        }

        this.placeActivityDirect(actId, slot);
        this.tabuMap.set(actId + '@' + slot, this.swapStep + tenure);
        this.swappedInBranch.add(actId);

        if(this.tabuMap.size > 20000){
          for(const [k, exp] of this.tabuMap.entries()){
            if(exp <= this.swapStep) this.tabuMap.delete(k);
          }
        }

        let allResolved = true;
        for(let j = 0; j < displaced.length; j++){
          if(!this.randomSwap(displaced[j], level + 1)){
            allResolved = false;
            break;
          }
        }

        if(allResolved){
          if(this.strictTeacherGaps !== false && this.strictFetGaps !== false){
            for(let k = 0; k < affectedTeacherSessions.length; k++){
              const { tIdx, sessIdx, origHadGap2 } = affectedTeacherSessions[k];
              if(!origHadGap2 && this.hasTeacherSessionGap2(tIdx, sessIdx)){
                allResolved = false;
                break;
              }
            }
          }
        }

        if(allResolved){
          if(level === 0){
            this.swappedInBranch.clear();
          }
          return true;
        }

        this.restoreStateSnapshot(snap);
        for(let j = 0; j < displaced.length; j++) this.swappedInBranch.delete(displaced[j]);
        this.swappedInBranch.delete(actId);
      }

      if(level === 0){
        this.swappedInBranch.clear();
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
            const oneLoc = isCheckedValue(rule.oneLocationPerSession?.[buoi]?.[thu]);
            if(!oneLoc) continue;

            const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
            const sessionLocations = [];
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const s = sStart + p;
              for(const [k, fix] of this.fixedSlots.entries()){
                if(k.endsWith("|" + s)){
                  const fixTeachers = parseTeacherList(fix.gv);
                  if(fixTeachers.includes(t) && fix.location){
                    sessionLocations.push({ period: p, loc: fix.location });
                  }
                }
              }
            }
            const u = new Set(sessionLocations.map(x => x.loc).filter(Boolean));
            if(u.size > 1) violations.push("fixed_location_violation:" + t + ":" + thu + "|" + buoi);
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
            const oneLoc = isCheckedValue(rule.oneLocationPerSession?.[buoi]?.[thu]);
            if(!oneLoc) continue;

            const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
            const sessionLocations = [];
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const s = sStart + p;
              for(const act of this.activities){
                const placedSlot = this.actPlacement[act.id];
                if(placedSlot >= 0 && s >= placedSlot && s < placedSlot + act.duration && act.gvList.includes(t) && act.location){
                  sessionLocations.push({ period: p, loc: act.location });
                }
              }
              for(const [k, fix] of this.fixedSlots.entries()){
                if(k.endsWith("|" + s)){
                  const fixTeachers = parseTeacherList(fix.gv);
                  if(fixTeachers.includes(t) && fix.location){
                    sessionLocations.push({ period: p, loc: fix.location });
                  }
                }
              }
            }
            const u = new Set(sessionLocations.map(x => x.loc).filter(Boolean));
            if(u.size > 1) violations.push("incumbent_location_violation:" + t + ":" + thu + "|" + buoi);
          }
        }
      }
      return violations;
    }

    missingMustTeachSlots(){
      const data = this.data;
      const tRules = data?.tkbConstraints?.teacher || {};
      const missing = [];

      for(const [tRaw, rule] of Object.entries(tRules)){
        const t = tRaw.toLowerCase();
        const must = rule.mustTeach || {};
        for(const [slotKey, val] of Object.entries(must)){
          if(isCheckedValue(val)){
            const p = slotKey.replace(/_/g, "|").split("|");
            if(p.length >= 3){
              const s = detailsToSlot(p[0], p[1], Number(p[2]));
              if(s >= 0){
                const tg = this.teacherGrid.get(t);
                if(!tg || (tg[s] < 0 && tg[s] !== -3)){
                  missing.push("must_teach_missing:" + t + ":" + slotKey);
                }
              }
            }
          }
        }
      }
      return missing;
    }

    checkMissingMustTeach(){
      return this.missingMustTeachSlots();
    }

    constraintLimitValue(rule, limitField, entityType, ctx = {}){
      if(!rule) return 0;
      if(ctx.buoi && ctx.thu && rule.perSlotBySession?.[entityType]?.[ctx.buoi]?.[ctx.thu] !== undefined){
        const val = Number(rule.perSlotBySession[entityType][ctx.buoi][ctx.thu]);
        if(val > 0) return val;
      }
      return Number(rule[limitField]?.[entityType] || 0);
    }

    scheduleCellsForConstraintTarget(rule, slot, ignoreSet = null){
      if(!rule) return 0;
      let count = 0;
      const isIgnored = (id) => {
        if(id < 0) return false;
        if(typeof ignoreSet === "number") return id === ignoreSet;
        if(ignoreSet instanceof Set) return ignoreSet.has(id);
        return false;
      };

      if(rule.targetType === "subject"){
        const targetMon = this.normalizeMonName(rule.targetId);
        for(const [cid, grid] of this.classGrid.entries()){
          const occ = grid[slot];
          if(occ >= 0 && !isIgnored(occ)){
            const act = this.activities[occ];
            if(act && this.normalizeMonName(act.mon) === targetMon) count++;
          }else if(occ === -3){
            const fix = this.fixedSlots.get(cid + "|" + slot);
            if(fix && this.normalizeMonName(fix.mon) === targetMon) count++;
          }
        }
      }else if(rule.targetType === "classGroup"){
        const groupItems = (this.data.tkbConstraints?.groups?.class?.[rule.targetId]?.items || []).map(String);
        for(const cid of groupItems){
          const grid = this.classGrid.get(cid);
          if(!grid) continue;
          const occ = grid[slot];
          if((occ >= 0 && !isIgnored(occ)) || occ === -3) count++;
        }
      }else if(rule.targetType === "teacherGroup"){
        const groupItems = (this.data.tkbConstraints?.groups?.teacher?.[rule.targetId]?.items || []).map(t => String(t).trim().toLowerCase());
        for(const t of groupItems){
          const tg = this.teacherGrid.get(t);
          if(!tg) continue;
          const occ = tg[slot];
          if((occ >= 0 && !isIgnored(occ)) || occ === -3) count++;
        }
      }
      return count;
    }

    compileConstraints(){
      this.allowedSlotsByActivity = new Map();
      this.mustTeachTargetSlotsByActivity = new Map();
      this.restoreStack = [];
      this.constraintIndex = {
        timeLimit: Array.isArray(this.data?.tkbConstraints?.timeLimit) ? this.data.tkbConstraints.timeLimit : []
      };

      const isAlreadyPlaced = this.actPlacement && this.actPlacement.some(p => p >= 0);
      if(!isAlreadyPlaced){
        for(let i = this.activities.length - 1; i >= 0; i--){
          const act = this.activities[i];
          if(act.duration === 2 && !act.mustKeepBlock){
            let hasSlot = false;
            for(let s = 0; s < TOTAL_SLOTS; s++){
              if(this.getConflictsForSlot(act, s).possible){
                hasSlot = true;
                break;
              }
            }
            if(!hasSlot){
              this.activities.splice(i, 1);
              const act1 = Object.assign({}, act, { id: this.activities.length, duration: 1, mustKeepBlock: false });
              const act2 = Object.assign({}, act, { id: this.activities.length + 1, duration: 1, mustKeepBlock: false });
              this.activities.push(act1, act2);
            }
          }
        }
        this.activities.forEach((a, idx) => a.id = idx);
        if(!this.actPlacement || this.actPlacement.length !== this.activities.length){
          this.actPlacement = new Array(this.activities.length).fill(-1);
        }
      }

      const tRules = this.data?.tkbConstraints?.teacher || {};
      for(const [tRaw, rule] of Object.entries(tRules)){
        const t = tRaw.toLowerCase();
        const must = rule.mustTeach || {};
        for(const [slotKey, val] of Object.entries(must)){
          if(isCheckedValue(val)){
            const p = slotKey.replace(/_/g, "|").split("|");
            if(p.length >= 3){
              const anchorSlot = detailsToSlot(p[0], p[1], Number(p[2]));
              if(anchorSlot >= 0){
                const compatActs = this.activities.filter(a => a.gvList.includes(t));
                if(compatActs.length > 0){
                  compatActs.sort((a, b) => a.duration - b.duration || a.id - b.id);
                  const chosen = compatActs[0];
                  chosen.mustTeachTargetSlot = anchorSlot;
                  this.mustTeachTargetSlotsByActivity.set(chosen.id, [anchorSlot]);
                }
              }
            }
          }
        }
      }

      let minDomain = TOTAL_SLOTS;
      const zeroDomains = [];

      for(const act of this.activities){
        const anchored = act.mustTeachTargetSlot !== undefined ? [act.mustTeachTargetSlot] : this.mustTeachTargetSlotsByActivity.get(act.id);
        const allowed = [];
        if(anchored && anchored.length > 0){
          for(let i = 0; i < anchored.length; i++){
            const s = anchored[i];
            if(this.isSlotFeasible(act, s, "domain_only")) allowed.push(s);
          }
        }else{
          const candidateIndices = act.sessionAllowed === "sang" ? SANG_SLOTS : (act.sessionAllowed === "chieu" ? CHIEU_SLOTS : ALL_60_SLOTS);
          for(let i = 0; i < candidateIndices.length; i++){
            const s = candidateIndices[i];
            if(this.isSlotFeasible(act, s, "domain_only")){
              allowed.push(s);
            }
          }
        }
        this.allowedSlotsByActivity.set(act, allowed);
        if(allowed.length < minDomain) minDomain = allowed.length;
        if(allowed.length === 0) zeroDomains.push(act);
      }

      const shortages = [];
      for(const lop of this.classes){
        const cid = String(lop.id || "");
        let availableSlots = 0;
        const grid = this.classGrid.get(cid) || [];
        for(let s = 0; s < TOTAL_SLOTS; s++){
          if(grid[s] !== -2 && !this.offSlots.has(cid + "|" + s)) availableSlots++;
        }
        let reqPeriods = 0;
        for(const act of this.activities){
          if(act.classId === cid) reqPeriods += act.duration;
        }
        for(let s = 0; s < TOTAL_SLOTS; s++){
          if(this.fixedSlots.has(cid + "|" + s)) reqPeriods++;
        }
        if(reqPeriods > availableSlots){
          shortages.push({ classId: cid, shortage: reqPeriods - availableSlots });
        }
      }

      const metricLowerBounds = { soBuoiDay1: 0, tsBuoiDay: 0, tsNgayDay: 0, soBuoiTrong1: 0, soBuoiTrong2: 0 };
      const metricLowerBoundEvidence = [];

      this.teacherGrid.forEach((grid, tKey) => {
        if(!tKey) return;
        for(let d = 0; d < DAYS_LIST.length; d++){
          let dayFixedCount = 0;
          for(let b = 0; b < SESSIONS_LIST.length; b++){
            const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
            const fixedIndices = [];
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              if(grid[sStart + p] === -3) fixedIndices.push(p);
            }
            if(fixedIndices.length >= 2){
              const span = fixedIndices[fixedIndices.length - 1] - fixedIndices[0] + 1;
              const gaps = span - fixedIndices.length;
              if(gaps >= 2){
                metricLowerBounds.soBuoiTrong2++;
                metricLowerBoundEvidence.push({
                  metric: "soBuoiTrong2",
                  teacher: tKey,
                  reason: "fixed_gap_cannot_be_reduced_by_compiled_domains"
                });
              }
            }
            if(fixedIndices.length > 0){
              metricLowerBounds.tsBuoiDay++;
              dayFixedCount += fixedIndices.length;
            }
          }
          if(dayFixedCount > 0) metricLowerBounds.tsNgayDay++;
        }
      });

      this.constraintPreflight = {
        zeroDomainActivities: zeroDomains,
        capacityShortages: shortages,
        minDomainSize: minDomain,
        structuralFloor: {
          provenInfeasible: zeroDomains.length > 0 || shortages.length > 0,
          minimumUnplacedPeriods: shortages.reduce((sum, x) => sum + x.shortage, 0) + zeroDomains.reduce((sum, a) => sum + a.duration, 0),
          metricLowerBounds,
          metricLowerBoundEvidence
        }
      };

      return this.constraintPreflight;
    }

    buildConstraintIndex(){
      return this.compileConstraints();
    }

    constraintConflictForSlot(act, slot, ignoreActIdOrSet = -1){
      if(!this.hasAnyComplexConstraint) return null;
      const dur = act.duration || 1;
      const monNorm = this.normalizeMonName(act.mon);
      const canonKey = act.canonKey || this.getCanonMonKey(act.mon);
      const cid = act.classId;
      const data = this.data;

      const isIgnored = (id) => {
        if(id < 0) return false;
        if(ignoreActIdOrSet === "domain_only") return true;
        if(id === act.id) return true;
        if(typeof ignoreActIdOrSet === "number") return id === ignoreActIdOrSet;
        if(ignoreActIdOrSet instanceof Set) return ignoreActIdOrSet.has(id);
        return false;
      };

      for(let d = 0; d < dur; d++){
        const s = slot + d;
        if(this.subjectOffSlots.has(canonKey + "|" + s) ||
           this.subjectOffSlots.has(act.mon + "|" + s) ||
           this.subjectOffSlots.has(monNorm + "|" + s)){
          return "subject_fixed_off";
        }
      }

      const dIdx = Math.floor(slot / SLOTS_PER_DAY);
      const inDay = slot % SLOTS_PER_DAY;
      const sIdx = Math.floor(inDay / PERIODS_PER_SESSION);
      const thu = DAYS_LIST[dIdx];
      const buoi = SESSIONS_LIST[sIdx];
      const sStart = dIdx * SLOTS_PER_DAY + sIdx * PERIODS_PER_SESSION;

      const subRule = data?.tkbConstraints?.subject?.[act.mon] || data?.tkbConstraints?.subject?.[monNorm] || {};
      if(subRule.sessionAllowed){
        if(buoi === "sang" && subRule.sessionAllowed.allowMorning === false) return "subject_session_allowed";
        if(buoi === "chieu" && subRule.sessionAllowed.allowAfternoon === false) return "subject_session_allowed";
      }

      const noSameSessionRules = data?.tkbConstraints?.subjectNoSameSession?.byClass?.[cid]?.sameSession?.groups || {};
      for(const grp of Object.values(noSameSessionRules)){
        if(Array.isArray(grp) && grp.some(m => this.normalizeMonName(m) === monNorm)){
          const otherNorms = grp.map(m => this.normalizeMonName(m)).filter(m => m !== monNorm);
          const cGrid = this.classGridList[act.classIdx];
          for(let p = 0; p < PERIODS_PER_SESSION; p++){
            const s = sStart + p;
            const occ = cGrid ? cGrid[s] : -1;
            if(occ >= 0 && !isIgnored(occ)){
              const otherAct = this.activities[occ];
              if(otherAct && otherNorms.includes(this.normalizeMonName(otherAct.mon))) return "no_same_session";
            }else if(occ === -3){
              const fix = this.fixedSlots.get(cid + "|" + s);
              if(fix && otherNorms.includes(this.normalizeMonName(fix.mon))) return "no_same_session";
            }
          }
        }
      }

      const noSameDayRules = data?.tkbConstraints?.subjectNoSameSession?.byClass?.[cid]?.sameDay?.groups || {};
      for(const grp of Object.values(noSameDayRules)){
        if(Array.isArray(grp) && grp.some(m => this.normalizeMonName(m) === monNorm)){
          const otherNorms = grp.map(m => this.normalizeMonName(m)).filter(m => m !== monNorm);
          const cGrid = this.classGridList[act.classIdx];
          for(let p = 0; p < SLOTS_PER_DAY; p++){
            const s = dIdx * SLOTS_PER_DAY + p;
            const occ = cGrid ? cGrid[s] : -1;
            if(occ >= 0 && !isIgnored(occ)){
              const otherAct = this.activities[occ];
              if(otherAct && otherNorms.includes(this.normalizeMonName(otherAct.mon))) return "no_same_day";
            }else if(occ === -3){
              const fix = this.fixedSlots.get(cid + "|" + s);
              if(fix && otherNorms.includes(this.normalizeMonName(fix.mon))) return "no_same_day";
            }
          }
        }
      }

      if(subRule.spacingDays && subRule.spacingDays.days > 0){
        const minGap = Number(subRule.spacingDays.days);
        const cGrid = this.classGridList[act.classIdx];
        for(let d = 0; d < DAYS_LIST.length; d++){
          if(d === dIdx) continue;
          let hasOcc = false;
          for(let p = 0; p < SLOTS_PER_DAY; p++){
            const s = d * SLOTS_PER_DAY + p;
            const occ = cGrid ? cGrid[s] : -1;
            if(occ >= 0 && !isIgnored(occ)){
              const otherAct = this.activities[occ];
              if(otherAct && this.normalizeMonName(otherAct.mon) === monNorm){ hasOcc = true; break; }
            }else if(occ === -3){
              const fix = this.fixedSlots.get(cid + "|" + s);
              if(fix && this.normalizeMonName(fix.mon) === monNorm){ hasOcc = true; break; }
            }
          }
          if(hasOcc){
            const dayDist = Math.abs(d - dIdx);
            if(dayDist <= minGap) return "spacing_days";
          }
        }
      }

      const tRules = data?.tkbConstraints?.teacher || {};
      for(const t of act.gvList){
        const rule = findRuleForTeacher(tRules, t);
        const maxDays = Number(rule.maxDaysSessions?.maxDays || 0);
        const maxSessions = Number(rule.maxDaysSessions?.maxSessions || 0);

        if(maxDays > 0 || maxSessions > 0){
          const tg = this.teacherGrid.get(t);
          const activeDays = new Set();
          const activeSessions = new Set();

          for(let d = 0; d < DAYS_LIST.length; d++){
            for(let b = 0; b < SESSIONS_LIST.length; b++){
              const start = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
              for(let p = 0; p < PERIODS_PER_SESSION; p++){
                const s = start + p;
                const occ = tg ? tg[s] : -1;
                if((occ >= 0 && !isIgnored(occ)) || occ === -3){
                  activeDays.add(d);
                  activeSessions.add(d + "|" + b);
                  break;
                }
              }
            }
          }

          if(maxDays > 0 && !activeDays.has(dIdx) && activeDays.size >= maxDays){
            return "teacher_max_days";
          }
          if(maxSessions > 0 && !activeSessions.has(dIdx + "|" + sIdx) && activeSessions.size >= maxSessions){
            return "teacher_max_sessions";
          }
        }
      }

      const subGroups = data?.tkbConstraints?.groups?.subject || {};
      for(const [gName, grp] of Object.entries(subGroups)){
        const items = (grp.items || []).map(m => this.normalizeMonName(m));
        if(!items.includes(monNorm)) continue;

        const grpRule = data?.tkbConstraints?.subjectGroup?.[gName]?.byClass?.[cid];
        if(grpRule){
          if(grpRule.sessionAllowed){
            if(buoi === "sang" && grpRule.sessionAllowed.allowMorning === false) return "subject_group_session_allowed";
            if(buoi === "chieu" && grpRule.sessionAllowed.allowAfternoon === false) return "subject_group_session_allowed";
          }

          if(grpRule.maxPeriods && grpRule.maxPeriods[buoi] !== undefined){
            const maxP = Number(grpRule.maxPeriods[buoi]);
            let countP = 0;
            const cGrid = this.classGridList[act.classIdx];
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const s = sStart + p;
              const occ = cGrid ? cGrid[s] : -1;
              if(occ >= 0 && !isIgnored(occ)){
                const otherAct = this.activities[occ];
                if(otherAct && items.includes(this.normalizeMonName(otherAct.mon))) countP++;
              }else if(occ === -3){
                const fix = this.fixedSlots.get(cid + "|" + s);
                if(fix && items.includes(this.normalizeMonName(fix.mon))) countP++;
              }
            }
            if(countP + dur > maxP) return "subject_group_max_periods_session";
          }

          if(grpRule.maxSubjects && grpRule.maxSubjects[buoi] !== undefined){
            const maxSub = Number(grpRule.maxSubjects[buoi]);
            const distinct = new Set();
            const cGrid = this.classGridList[act.classIdx];
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const s = sStart + p;
              const occ = cGrid ? cGrid[s] : -1;
              if(occ >= 0 && !isIgnored(occ)){
                const otherAct = this.activities[occ];
                if(otherAct && items.includes(this.normalizeMonName(otherAct.mon))) distinct.add(this.normalizeMonName(otherAct.mon));
              }else if(occ === -3){
                const fix = this.fixedSlots.get(cid + "|" + s);
                if(fix && items.includes(this.normalizeMonName(fix.mon))) distinct.add(this.normalizeMonName(fix.mon));
              }
            }
            distinct.add(monNorm);
            if(distinct.size > maxSub) return "subject_group_max_subjects_session";
          }
        }

        const groupLimit = data?.tkbConstraints?.subjectGroup?.[gName]?.groupLimit?.perSlot?.classes;
        if(groupLimit !== undefined && Number(groupLimit) > 0){
          const maxCls = Number(groupLimit);
          let classCount = 0;
          for(const [c, grid] of this.classGrid.entries()){
            if(c === cid) continue;
            const occ = grid[slot];
            if(occ >= 0 && !isIgnored(occ)){
              const otherAct = this.activities[occ];
              if(otherAct && items.includes(this.normalizeMonName(otherAct.mon))) classCount++;
            }else if(occ === -3){
              const fix = this.fixedSlots.get(c + "|" + slot);
              if(fix && items.includes(this.normalizeMonName(fix.mon))) classCount++;
            }
          }
          if(classCount + 1 > maxCls) return "subject_group_global_limit";
        }
      }

      const subGlobalLimit = subRule.globalLimit?.perSlot?.classes;
      const subGrpLimit = subRule.groupLimit?.perSlot?.classes;
      let activeSubLimit = 0;
      if(subGlobalLimit !== undefined && Number(subGlobalLimit) > 0) activeSubLimit = Number(subGlobalLimit);
      if(subGrpLimit !== undefined && Number(subGrpLimit) > 0){
        if(activeSubLimit === 0 || Number(subGrpLimit) < activeSubLimit) activeSubLimit = Number(subGrpLimit);
      }

      if(activeSubLimit > 0){
        let classCount = 0;
        for(const [c, grid] of this.classGrid.entries()){
          if(c === cid) continue;
          const occ = grid[slot];
          if(occ >= 0 && !isIgnored(occ)){
            const otherAct = this.activities[occ];
            if(otherAct && this.normalizeMonName(otherAct.mon) === monNorm) classCount++;
          }else if(occ === -3){
            const fix = this.fixedSlots.get(c + "|" + slot);
            if(fix && this.normalizeMonName(fix.mon) === monNorm) classCount++;
          }
        }
        if(classCount + 1 > activeSubLimit) return "subject_global_limit";
      }

      const timeLimits = this.constraintIndex?.timeLimit || data?.tkbConstraints?.timeLimit || [];
      for(const tl of timeLimits){
        const limitVal = this.constraintLimitValue(tl, "perSlot", tl.targetType === "teacherGroup" ? "teachers" : "classes", { buoi, thu });
        if(limitVal > 0){
          let currentOcc = 0;
          if(tl.targetType === "teacherGroup"){
            const groupTeachers = (data?.tkbConstraints?.groups?.teacher?.[tl.targetId]?.items || []).map(t => String(t).trim().toLowerCase());
            const relevant = act.gvList.some(t => groupTeachers.includes(t));
            if(relevant){
              for(const t of groupTeachers){
                const tg = this.teacherGrid.get(t);
                if(!tg) continue;
                const occ = tg[slot];
                if((occ >= 0 && !isIgnored(occ)) || occ === -3) currentOcc++;
              }
              if(currentOcc + 1 > limitVal) return "time_limit";
            }
          }else if(tl.targetType === "classGroup"){
            const groupClasses = (data?.tkbConstraints?.groups?.class?.[tl.targetId]?.items || []).map(String);
            if(groupClasses.includes(cid)){
              for(const c of groupClasses){
                if(c === cid) continue;
                const cg = this.classGrid.get(c);
                if(!cg) continue;
                const occ = cg[slot];
                if((occ >= 0 && !isIgnored(occ)) || occ === -3) currentOcc++;
              }
              if(currentOcc + 1 > limitVal) return "time_limit";
            }
          }
        }
      }

      const actLoc = act.location;
      if(actLoc){
        for(const t of act.gvList){
          const rule = findRuleForTeacher(tRules, t);
          const oneLoc = isCheckedValue(rule.oneLocationPerSession?.[buoi]?.[thu]);
          const gapLoc = isCheckedValue(rule.gapBetweenLocations?.[buoi]?.[thu]);
          const maxOneMove = isCheckedValue(rule.maxOneMovePerSession?.[buoi]?.[thu]);

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
            if(occ >= 0 && !isIgnored(occ)){
              const otherAct = this.activities[occ];
              if(otherAct && otherAct.location) sessionLocations.push({ period: p, loc: otherAct.location });
            }else if(occ === -3){
              for(const [k, fix] of this.fixedSlots.entries()){
                if(k.endsWith("|" + s)){
                  const fixTeachers = parseTeacherList(fix.gv);
                  if(fixTeachers.includes(t) && fix.location){
                    sessionLocations.push({ period: p, loc: fix.location });
                    break;
                  }
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
      }

      return null;
    }

    getConflictsForSlot(act, slot, ignoreActIdOrSet = -1){
      const feasible = this.isSlotFeasible(act, slot, ignoreActIdOrSet);
      return { possible: feasible };
    }

    solve(onProgress = null){
      this.deadlineAtMs = Date.now() + (Number(this.timeBudgetMs) || 12000);

      if(this.activities.length === 0){
        this.init();
      }

      const fixedLocationViolations = this.validateFixedLocationConstraints();
      if(fixedLocationViolations.length > 0){
        return {
          ok: false,
          applied: false,
          failureKind: "fet_fixed_location_constraint_violation",
          diagnostics: { fixedLocationViolations }
        };
      }

      this.compileConstraints();
      if(this.constraintPreflight.zeroDomainActivities.length > 0){
        return {
          ok: false,
          applied: false,
          failureKind: "fet_zero_domain",
          diagnostics: this.constraintPreflight
        };
      }

      const totalActivities = this.activities.length;
      if(totalActivities === 0){
        return {
          ok: true,
          applied: true,
          placed: 0,
          unassigned: 0,
          total: 0,
          diagnostics: {}
        };
      }

      this.computeDifficultiesAndSort();

      if(typeof onProgress === "function"){
        onProgress({
          percent: 0,
          placed: 0,
          total: totalActivities,
          preflight: { activityCount: totalActivities, minDomainSize: this.constraintPreflight.minDomainSize },
          message: "Bắt đầu xếp lịch FET"
        });
      }

      this.minTwoGuardActive = true;
      let placedCount = 0;
      this.swapStep = 0;
      this.tabuMap.clear();
      this.limitCalls = Math.max(this.limitCalls || DEFAULT_LIMIT_CALLS, 2000);
      for(let i = 0; i < this.activities.length; i++){
        if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) break;
        this.nCalls = 0;
        this.triedRemovals.clear();
        this.swappedInBranch.clear();
        const success = this.randomSwap(i, 0);
        if(success) placedCount++;

        if(typeof onProgress === "function" && (i % 50 === 0 || i === this.activities.length - 1)){
          onProgress({
            percent: Math.round(((i + 1) / totalActivities) * 100),
            placed: placedCount,
            total: totalActivities,
            message: "Đã xếp " + placedCount + "/" + totalActivities + " hoạt động"
          });
        }
      }

      // Multi-pass fallback for any unplaced activities
      for(let pass = 0; pass < 8 && placedCount < totalActivities; pass++){
        if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) break;
        this.minTwoGuardActive = false;
        this.limitCalls = Math.min(10000, 2000 + pass * 1000);
        for(let i = 0; i < this.activities.length; i++){
          if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) break;
          if(this.actPlacement[i] < 0){
            this.nCalls = 0;
            this.triedRemovals.clear();
            this.swappedInBranch.clear();
            if(this.randomSwap(i, 0)){
              placedCount++;
            }
          }
        }

        // ILS Perturbation Kick: If plateau encountered (unplaced activities remain after pass 1)
        if(pass >= 1 && placedCount < totalActivities){
          for(let i = 0; i < this.activities.length; i++){
            if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) break;
            if(this.actPlacement[i] < 0){
              const unplacedAct = this.activities[i];
              const kickCandidates = [];
              const allowed = this.allowedSlotsByActivity?.get(unplacedAct) || [];
              const sampleSlots = allowed.slice();
              this.rng.shuffle(sampleSlots);

              const cGrid = this.classGridList[unplacedAct.classIdx];
              for(let sIdx = 0; sIdx < sampleSlots.length && kickCandidates.length < 3; sIdx++){
                const s = sampleSlots[sIdx];
                const occId = cGrid ? cGrid[s] : -1;
                if(occId >= 0 && occId !== i){
                  const oAct = this.activities[occId];
                  if(oAct && !oAct.isFixed && !oAct.lockedByLessonBlock && !kickCandidates.includes(occId)){
                    kickCandidates.push(occId);
                  }
                }
                for(let t = 0; t < unplacedAct.teacherIdxs.length && kickCandidates.length < 3; t++){
                  const tg = this.teacherGridList[unplacedAct.teacherIdxs[t]];
                  const tOcc = tg ? tg[s] : -1;
                  if(tOcc >= 0 && tOcc !== i){
                    const oAct = this.activities[tOcc];
                    if(oAct && !oAct.isFixed && !oAct.lockedByLessonBlock && !kickCandidates.includes(tOcc)){
                      kickCandidates.push(tOcc);
                    }
                  }
                }
              }

              if(kickCandidates.length > 0){
                const kickSnap = this.captureStateSnapshot();
                for(let k = 0; k < kickCandidates.length; k++){
                  const kId = kickCandidates[k];
                  const oldSlot = this.actPlacement[kId];
                  this.unplaceActivity(kId);
                  this.swapStep = (this.swapStep || 0) + 1;
                  const tenure = 8 + (Math.abs(this.rng.next()) % 5);
                  if(oldSlot >= 0) this.tabuMap.set(kId + '@' + oldSlot, this.swapStep + tenure);
                }

                this.nCalls = 0;
                this.limitCalls = 10000;
                this.triedRemovals.clear();
                this.swappedInBranch.clear();
                const kickSuccess = this.randomSwap(i, 0);

                let allKickedRestored = kickSuccess;
                if(kickSuccess){
                  for(let k = 0; k < kickCandidates.length; k++){
                    const kId = kickCandidates[k];
                    this.nCalls = 0;
                    this.limitCalls = 10000;
                    this.swappedInBranch.clear();
                    if(!this.randomSwap(kId, 0)){
                      allKickedRestored = false;
                      break;
                    }
                  }
                }

                if(allKickedRestored){
                  let newPlaced = 0;
                  for(let a = 0; a < this.activities.length; a++){
                    if(this.actPlacement[a] >= 0) newPlaced++;
                  }
                  if(newPlaced > placedCount){
                    placedCount = newPlaced;
                  } else if(newPlaced < placedCount){
                    this.restoreStateSnapshot(kickSnap);
                  }
                } else {
                  this.restoreStateSnapshot(kickSnap);
                }
              }
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
          diagnostics: { missingMustTeach, structuralFloor: this.constraintPreflight.structuralFloor }
        };
      }

      this.compactAllStudentSessions();
      this.applyToDataTKB();
      const unassigned = totalActivities - placedCount;
      return {
        ok: unassigned === 0,
        applied: unassigned === 0,
        placed: placedCount,
        unassigned,
        total: totalActivities,
        diagnostics: unassigned > 0 ? { unassigned } : {}
      };
    }

    compactAllStudentSessions(){
      let anyShifted = false;
      for(let cIdx = 0; cIdx < this.classes.length; cIdx++){
        const cid = String(this.classes[cIdx].id || "");
        const cGrid = this.classGridList[cIdx];
        if(!cGrid) continue;

        for(let d = 0; d < DAYS_LIST.length; d++){
          for(let b = 0; b < SESSIONS_LIST.length; b++){
            const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
            let mask = 0;
            const dynActs = [];
            const fixedPeriods = [];

            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const s = sStart + p;
              const cell = cGrid[s];
              if(cell === -3){
                mask |= (1 << p);
                fixedPeriods.push(p);
              } else if(cell >= 0){
                mask |= (1 << p);
                const a = this.activities[cell];
                if(a && !dynActs.some(x => x.id === a.id)){
                  if(a.isFixed || a.lockedByLessonBlock){
                    fixedPeriods.push(p);
                  } else {
                    dynActs.push(a);
                  }
                }
              }
            }

            if(SESSION_STATS_LUT[mask].gaps === 0) continue;
            if(dynActs.length === 0) continue;

            const snap = this.captureStateSnapshot();
            for(const a of dynActs) this.unplaceActivity(a.id);

            const openPeriods = [];
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              if(!fixedPeriods.includes(p)) openPeriods.push(p);
            }

            const totalDur = dynActs.reduce((acc, a) => acc + a.duration, 0);
            if(totalDur > openPeriods.length){
              this.restoreStateSnapshot(snap);
              continue;
            }

            let placed = false;
            const getCombos = (arr, k) => {
              if(k === 0) return [[]];
              if(arr.length < k) return [];
              const head = arr[0];
              const tail = arr.slice(1);
              const withHead = getCombos(tail, k - 1).map(c => [head, ...c]);
              const withoutHead = getCombos(tail, k);
              return [...withHead, ...withoutHead];
            };

            const combos = getCombos(openPeriods, totalDur);
            for(const combo of combos){
              let testMask = 0;
              for(const p of fixedPeriods) testMask |= (1 << p);
              for(const p of combo) testMask |= (1 << p);
              if(SESSION_STATS_LUT[testMask].gaps !== 0) continue;

              let curIdx = 0;
              let feasible = true;
              for(const a of dynActs){
                const targetSlot = sStart + combo[curIdx];
                if(!this.isSlotFeasible(a, targetSlot)){
                  feasible = false; break;
                }
                this.placeActivityDirect(a.id, targetSlot);
                curIdx += a.duration;
              }

              if(feasible && this.countStudentHoles(cid) === 0){
                placed = true;
                anyShifted = true;
                break;
              }
              for(const a of dynActs) this.unplaceActivity(a.id);
            }

            if(!placed){
              this.restoreStateSnapshot(snap);
            }
          }
        }
      }
      return anyShifted;
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
      let unplacedCount = 0;
      for(let i = 0; i < this.activities.length; i++){
        if(this.actPlacement[i] < 0) unplacedCount++;
      }

      for(let tIdx = 0; tIdx < this.teachers.length; tIdx++){
        const tKey = this.teachers[tIdx];
        if(!tKey || !this.isScoredTeacher(tKey)) continue;
        const tg = this.teacherGridList[tIdx];
        if(!tg) continue;

        for(let d = 0; d < DAYS_LIST.length; d++){
          let dayTotal = 0;
          for(let b = 0; b < SESSIONS_LIST.length; b++){
            const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
            let mask = 0;
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const cell = tg[sStart + p];
              if(cell >= 0 || cell === -3) mask |= (1 << p);
            }

            const stats = SESSION_STATS_LUT[mask];
            const k = stats.k;
            dayTotal += k;
            if(k > 0){
              tsBuoiDay++;
              if(k === 1) soBuoiDay1++;
              else if(k === 2) soBuoiDay2++;
              else if(k === 3) soBuoiDay3++;

              if(stats.gaps === 1) soBuoiTrong1++;
              else if(stats.gaps >= 2) soBuoiTrong2++;
            }
          }
          if(dayTotal > 0) tsNgayDay++;
          if(dayTotal === 1) soNgayMotTiet++;
        }
      }

      return { soNgayMotTiet, soBuoiDay1, soBuoiDay2, soBuoiDay3, tsBuoiDay, tsNgayDay, soBuoiTrong1, soBuoiTrong2, unplacedCount };
    }

    countStudentHoles(classId){
      const grid = this.classGrid.get(classId);
      if(!grid) return 0;
      let holes = 0;
      for(let d = 0; d < DAYS_LIST.length; d++){
        for(let b = 0; b < SESSIONS_LIST.length; b++){
          const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
          let mask = 0;
          for(let p = 0; p < PERIODS_PER_SESSION; p++){
            const occ = grid[sStart + p];
            if(occ >= 0 || occ === -3) mask |= (1 << p);
          }
          holes += SESSION_STATS_LUT[mask].gaps;
        }
      }
      return holes;
    }

    countTotalStudentHoles(){
      let holes = 0;
      for(let cIdx = 0; cIdx < this.classes.length; cIdx++){
        holes += this.countStudentHoles(String(this.classes[cIdx].id || ""));
      }
      return holes;
    }

    compareMetrics(a, b, arg3 = "optimize_all", arg4 = null){
      const mode = typeof arg4 === "string" ? arg4 : (typeof arg3 === "string" ? arg3 : "optimize_all");
      const initial = typeof arg3 === "object" && arg3 !== null ? arg3 : (b || a);

      const aUnplaced = Number(a?.unplacedCount || 0);
      const bUnplaced = Number(b?.unplacedCount || 0);
      if(aUnplaced !== bUnplaced) return aUnplaced - bUnplaced;

      if(mode === "optimize_singletons"){
        if(a.soBuoiTrong2 > initial.soBuoiTrong2) return 1;
        if(a.soBuoiDay1 !== b.soBuoiDay1) return a.soBuoiDay1 - b.soBuoiDay1;
        if(a.soNgayMotTiet !== b.soNgayMotTiet) return a.soNgayMotTiet - b.soNgayMotTiet;
        if(a.soBuoiTrong2 !== b.soBuoiTrong2) return a.soBuoiTrong2 - b.soBuoiTrong2;
        if(a.tsBuoiDay !== b.tsBuoiDay) return a.tsBuoiDay - b.tsBuoiDay;
        return a.soBuoiTrong1 - b.soBuoiTrong1;
      }
      if(mode === "optimize_gap2"){
        if(a.soBuoiDay1 > initial.soBuoiDay1) return 1;
        if(a.soBuoiTrong2 !== b.soBuoiTrong2) return a.soBuoiTrong2 - b.soBuoiTrong2;
        if(a.soBuoiDay1 !== b.soBuoiDay1) return a.soBuoiDay1 - b.soBuoiDay1;
        return a.tsBuoiDay - b.tsBuoiDay;
      }
      if(mode === "optimize_gap1"){
        if(a.soBuoiDay1 > initial.soBuoiDay1) return 1;
        if(a.soBuoiTrong2 > b.soBuoiTrong2) return 1;
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
      if(a.soBuoiTrong2 > initial.soBuoiTrong2) return 1;
      if(a.soBuoiDay1 !== b.soBuoiDay1) return a.soBuoiDay1 - b.soBuoiDay1;
      if(a.soNgayMotTiet !== b.soNgayMotTiet) return a.soNgayMotTiet - b.soNgayMotTiet;
      if(a.soBuoiTrong2 !== b.soBuoiTrong2) return a.soBuoiTrong2 - b.soBuoiTrong2;
      if(a.tsBuoiDay !== b.tsBuoiDay) return a.tsBuoiDay - b.tsBuoiDay;
      if(a.soBuoiTrong1 !== b.soBuoiTrong1) return a.soBuoiTrong1 - b.soBuoiTrong1;
      return a.tsNgayDay - b.tsNgayDay;
    }

    async tryRelocateSingletons(bestMetrics, onProgress = null){
      let currentBest = { ...bestMetrics };
      let improved = false;
      let evalSteps = 0;
      let lastYieldAt = Date.now();

      const scoredList = Array.from(this.scoredTeachers || this.teacherGrid.keys());
      this.rng.shuffle(scoredList);

      for(const tKey of scoredList){
        if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) break;
        const tIdx = this.teacherIndexMap.get(tKey);
        if(tIdx === undefined) continue;
        const tg = this.teacherGridList[tIdx];
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
            if(!act || act.isFixed || act.lockedByLessonBlock) continue;

            const targetSlots = [];
            for(let d2 = 0; d2 < DAYS_LIST.length; d2++){
              for(let b2 = 0; b2 < SESSIONS_LIST.length; b2++){
                const s2SessionStart = d2 * SLOTS_PER_DAY + b2 * PERIODS_PER_SESSION;
                if(s2SessionStart === sStart) continue;

                let cntInSess = 0;
                for(let p = 0; p < PERIODS_PER_SESSION; p++){
                  if(tg[s2SessionStart + p] >= 0 || tg[s2SessionStart + p] === -3) cntInSess++;
                }

                if(cntInSess >= 1 && cntInSess < PERIODS_PER_SESSION){
                  for(let p = 0; p < PERIODS_PER_SESSION; p++){
                    const s2 = s2SessionStart + p;
                    if(tg[s2] === -1) targetSlots.push(s2);
                  }
                }
              }
            }
            if(targetSlots.length === 0){
              for(let s2 = 0; s2 < TOTAL_SLOTS; s2++){
                if(s2 === singleSlot) continue;
                const s2SessionStart = Math.floor(s2 / PERIODS_PER_SESSION) * PERIODS_PER_SESSION;
                if(s2SessionStart === sStart) continue;
                if(tg[s2] === -1) targetSlots.push(s2);
              }
            }
            this.rng.shuffle(targetSlots);

            for(let idx = 0; idx < targetSlots.length; idx++){
              if((++evalSteps % 64) === 0 && Date.now() - lastYieldAt >= 16){
                await new Promise(resolve => setTimeout(resolve, 0));
                lastYieldAt = Date.now();
              }

              const dst = targetSlots[idx];
              const cid = act.classId;
              const cGrid = this.classGridList[act.classIdx];
              const occId = cGrid[dst];

              if(occId >= 0){
                const occAct = this.activities[occId];
                if(occAct && !occAct.isFixed && !occAct.lockedByLessonBlock && occAct.duration === 1){
                  const snap = this.captureStateSnapshot();
                  this.unplaceActivity(actId);
                  this.unplaceActivity(occId);

                  let feasibleMove = false;
                  if(this.isSlotFeasible(act, dst) && this.isSlotFeasible(occAct, singleSlot)){
                    this.placeActivityDirect(actId, dst);
                    this.placeActivityDirect(occAct.id, singleSlot);
                    feasibleMove = true;
                  } else if(this.isSlotFeasible(act, dst)){
                    this.placeActivityDirect(actId, dst);
                    this.nCalls = 0;
                    this.tabuMap.clear();
                    this.triedRemovals.clear();
                    this.swappedInBranch.clear();
                    this.limitCalls = 1000;
                    feasibleMove = this.randomSwap(occAct.id, 0);
                  }

                  if(feasibleMove && this.countTotalStudentHoles() === 0){
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
              } else if(occId === -1){
                const snap = this.captureStateSnapshot();
                this.unplaceActivity(actId);
                if(this.isSlotFeasible(act, dst)){
                  this.placeActivityDirect(actId, dst);
                  if(this.countTotalStudentHoles() === 0){
                    const m = this.evaluateMetrics();
                    if(this.compareMetrics(m, currentBest, "optimize_singletons") < 0){
                      currentBest = { ...m };
                      improved = true;
                      if(typeof onProgress === "function") onProgress(currentBest);
                      break;
                    }
                  }
                }
                this.restoreStateSnapshot(snap);
              }
            }
          }
        }
      }
      return improved ? currentBest : null;
    }

    async tryShareRichToSingleton(bestMetrics, onProgress = null){
      let currentBest = { ...bestMetrics };
      let improved = false;
      let evalSteps = 0;
      let lastYieldAt = Date.now();

      const scoredList = Array.from(this.scoredTeachers || this.teacherGrid.keys());
      this.rng.shuffle(scoredList);

      for(const tKey of scoredList){
        if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) break;
        const tIdx = this.teacherIndexMap.get(tKey);
        if(tIdx === undefined) continue;
        const tg = this.teacherGridList[tIdx];
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
            else if(actsInSession.length >= 2) richSessions.push({ sStart, items: actsInSession });
          }
        }

        if(singleSessions.length === 0 || richSessions.length === 0) continue;

        for(const single of singleSessions){
          for(const rich of richSessions){
            if((++evalSteps % 32) === 0 && Date.now() - lastYieldAt >= 16){
              await new Promise(resolve => setTimeout(resolve, 0));
              lastYieldAt = Date.now();
            }

            // Direction 1: Transfer from rich to single (when rich has >= 2 periods)
            if(rich.items.length >= 2){
              for(const richItem of rich.items){
                const donorAct = this.activities[richItem.actId];
                if(!donorAct || donorAct.isFixed || donorAct.lockedByLessonBlock || donorAct.duration !== 1) continue;
                const cid = donorAct.classId;
                const oldHoles = this.countStudentHoles(cid);

                for(let p = 0; p < PERIODS_PER_SESSION; p++){
                  const targetSlot = single.sStart + p;
                  if(targetSlot === single.item.slot) continue;
                  if(tg[targetSlot] >= 0 || tg[targetSlot] === -3) continue;

                  const cGrid = this.classGridList[donorAct.classIdx];
                  const occId = cGrid[targetSlot];

                  if(occId === -1){
                    const snap = this.captureStateSnapshot();
                    this.unplaceActivity(donorAct.id);
                    if(this.isSlotFeasible(donorAct, targetSlot)){
                      this.placeActivityDirect(donorAct.id, targetSlot);
                      if(this.countTotalStudentHoles() === 0){
                        const m = this.evaluateMetrics();
                        if(this.compareMetrics(m, currentBest, "optimize_singletons") < 0){
                          currentBest = { ...m };
                          improved = true;
                          if(typeof onProgress === "function") onProgress(currentBest);
                          break;
                        }
                      }
                    }
                    this.restoreStateSnapshot(snap);
                  } else if(occId >= 0 && occId !== donorAct.id){
                    const occAct = this.activities[occId];
                    if(occAct && !occAct.isFixed && !occAct.lockedByLessonBlock && occAct.duration === 1){
                      const snap = this.captureStateSnapshot();
                      this.unplaceActivity(donorAct.id);
                      this.unplaceActivity(occId);

                      let ok = false;
                      if(this.isSlotFeasible(donorAct, targetSlot) && this.isSlotFeasible(occAct, richItem.slot)){
                        this.placeActivityDirect(donorAct.id, targetSlot);
                        this.placeActivityDirect(occAct.id, richItem.slot);
                        ok = true;
                      } else if(this.isSlotFeasible(donorAct, targetSlot)){
                        this.placeActivityDirect(donorAct.id, targetSlot);
                        this.nCalls = 0;
                        this.tabuMap.clear();
                        this.triedRemovals.clear();
                        this.swappedInBranch.clear();
                        this.limitCalls = 1000;
                        ok = this.randomSwap(occAct.id, 0);
                      }

                      if(ok && this.countTotalStudentHoles() === 0){
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
                if(improved) break;
              }
            }
            if(improved) break;

            // Direction 2: Transfer single into rich (vacate single session completely: 1 -> 0, <= 4 -> <= 5)
            const singleAct = this.activities[single.item.actId];
            if(singleAct && !singleAct.isFixed && !singleAct.lockedByLessonBlock && singleAct.duration === 1 && rich.items.length <= 4){
              const cid = singleAct.classId;

              for(let p = 0; p < PERIODS_PER_SESSION; p++){
                const targetSlot = rich.sStart + p;
                if(tg[targetSlot] >= 0 || tg[targetSlot] === -3) continue;

                const cGrid = this.classGridList[singleAct.classIdx];
                const occId = cGrid[targetSlot];

                if(occId === -1){
                  const snap = this.captureStateSnapshot();
                  this.unplaceActivity(singleAct.id);
                  if(this.isSlotFeasible(singleAct, targetSlot)){
                    this.placeActivityDirect(singleAct.id, targetSlot);
                    if(this.countTotalStudentHoles() === 0){
                      const m = this.evaluateMetrics();
                      if(this.compareMetrics(m, currentBest, "optimize_singletons") < 0){
                        currentBest = { ...m };
                        improved = true;
                        if(typeof onProgress === "function") onProgress(currentBest);
                        break;
                      }
                    }
                  }
                  this.restoreStateSnapshot(snap);
                } else if(occId >= 0 && occId !== singleAct.id){
                  const occAct = this.activities[occId];
                  if(occAct && !occAct.isFixed && !occAct.lockedByLessonBlock && occAct.duration === 1){
                    const snap = this.captureStateSnapshot();
                    this.unplaceActivity(singleAct.id);
                    this.unplaceActivity(occId);

                    let ok = false;
                    if(this.isSlotFeasible(singleAct, targetSlot) && this.isSlotFeasible(occAct, single.item.slot)){
                      this.placeActivityDirect(singleAct.id, targetSlot);
                      this.placeActivityDirect(occAct.id, single.item.slot);
                      ok = true;
                    } else if(this.isSlotFeasible(singleAct, targetSlot)){
                      this.placeActivityDirect(singleAct.id, targetSlot);
                      this.nCalls = 0;
                      this.tabuMap.clear();
                      this.triedRemovals.clear();
                      this.swappedInBranch.clear();
                      this.limitCalls = 1000;
                      ok = this.randomSwap(occAct.id, 0);
                    }

                    if(ok && this.countTotalStudentHoles() === 0){
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
          }
        }
      }
      return improved ? currentBest : null;
    }

    async trySingletonRelabelCycles(bestMetrics, onProgress = null){
      let currentBest = { ...bestMetrics };
      let improved = false;
      let evalSteps = 0;
      let lastYieldAt = Date.now();

      const scoredList = Array.from(this.scoredTeachers || this.teacherGrid.keys());
      this.rng.shuffle(scoredList);

      for(const tKey of scoredList){
        if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) break;
        const tIdx = this.teacherIndexMap.get(tKey);
        if(tIdx === undefined) continue;
        const tg = this.teacherGridList[tIdx];
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

            const sOrig = singleSlots[0];
            const actOrig = this.activities[tg[sOrig]];
            if(!actOrig || actOrig.isFixed || actOrig.lockedByLessonBlock || actOrig.duration !== 1) continue;

            const cid = actOrig.classId;
            const cGrid = this.classGridList[actOrig.classIdx];
            if(!cGrid) continue;

            for(let sTarget = 0; sTarget < TOTAL_SLOTS; sTarget++){
              if((++evalSteps % 64) === 0 && Date.now() - lastYieldAt >= 16){
                await new Promise(resolve => setTimeout(resolve, 0));
                lastYieldAt = Date.now();
              }

              if(sTarget === sOrig) continue;
              const occId = cGrid[sTarget];
              if(occId < 0) continue;
              const occAct = this.activities[occId];
              if(!occAct || occAct.isFixed || occAct.lockedByLessonBlock || occAct.duration !== 1) continue;

              const snap = this.captureStateSnapshot();
              this.unplaceActivity(actOrig.id);
              this.unplaceActivity(occAct.id);
              let ok = false;
              if(this.isSlotFeasible(actOrig, sTarget) && this.isSlotFeasible(occAct, sOrig)){
                this.placeActivityDirect(actOrig.id, sTarget);
                this.placeActivityDirect(occAct.id, sOrig);
                ok = true;
              } else if(this.isSlotFeasible(actOrig, sTarget)){
                this.placeActivityDirect(actOrig.id, sTarget);
                this.nCalls = 0;
                this.tabuMap.clear();
                this.triedRemovals.clear();
                this.swappedInBranch.clear();
                this.limitCalls = 1000;
                ok = this.randomSwap(occAct.id, 0);
              }

              if(ok && this.countTotalStudentHoles() === 0){
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

    async tryIntraClassSingletonSwap(bestMetrics, onProgress = null){
      let currentBest = { ...bestMetrics };
      let improved = false;
      let evalSteps = 0;
      let lastYieldAt = Date.now();

      for(let cIdx = 0; cIdx < this.classes.length; cIdx++){
        if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) break;
        const cid = String(this.classes[cIdx].id || "");
        const cGrid = this.classGridList[cIdx];
        if(!cGrid) continue;

        for(let s1 = 0; s1 < TOTAL_SLOTS; s1++){
          const actId1 = cGrid[s1];
          if(actId1 < 0) continue;
          const act1 = this.activities[actId1];
          if(!act1 || act1.isFixed || act1.lockedByLessonBlock || act1.duration !== 1) continue;

          for(let s2 = s1 + 1; s2 < TOTAL_SLOTS; s2++){
            if((++evalSteps % 64) === 0 && Date.now() - lastYieldAt >= 16){
              await new Promise(resolve => setTimeout(resolve, 0));
              lastYieldAt = Date.now();
            }

            const actId2 = cGrid[s2];
            if(actId2 < 0 || actId2 === actId1) continue;
            const act2 = this.activities[actId2];
            if(!act2 || act2.isFixed || act2.lockedByLessonBlock || act2.duration !== 1) continue;

            const snap = this.captureStateSnapshot();
            this.unplaceActivity(actId1);
            this.unplaceActivity(actId2);
            let ok = false;
            if(this.isSlotFeasible(act1, s2) && this.isSlotFeasible(act2, s1)){
              this.placeActivityDirect(act1.id, s2);
              this.placeActivityDirect(act2.id, s1);
              ok = true;
            } else if(this.isSlotFeasible(act1, s2)){
              this.placeActivityDirect(act1.id, s2);
              this.nCalls = 0;
              this.tabuMap.clear();
              this.triedRemovals.clear();
              this.swappedInBranch.clear();
              this.limitCalls = 1000;
              ok = this.randomSwap(act2.id, 0);
            }

            if(ok && this.countTotalStudentHoles() === 0){
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
      return improved ? currentBest : null;
    }

    async tryClosedPushCycles(bestMetrics, onProgress = null, maxDepth = 2){
      let currentBest = { ...bestMetrics };
      let improved = false;
      let evalSteps = 0;
      let lastYieldAt = Date.now();

      const scoredList = Array.from(this.scoredTeachers || this.teacherGrid.keys());
      this.rng.shuffle(scoredList);

      for(const tKey of scoredList){
        const tIdx = this.teacherIndexMap.get(tKey);
        if(tIdx === undefined) continue;
        const tg = this.teacherGridList[tIdx];
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

            const sStartSingleton = singleSlots[0];
            const startAct = this.activities[tg[sStartSingleton]];
            if(!startAct || startAct.isFixed || startAct.lockedByLessonBlock || startAct.duration !== 1) continue;

            const visitedActs = new Set([startAct.id]);
            const snap = this.captureStateSnapshot();

            const dfsPush = (curAct, curFromSlot, depth) => {
              if(depth > maxDepth) return false;

              const candidateSlots = [];
              for(let i = 0; i < curAct.teacherIdxs.length; i++){
                const curTg = this.teacherGridList[curAct.teacherIdxs[i]];
                if(!curTg) continue;
                for(let d2 = 0; d2 < DAYS_LIST.length; d2++){
                  for(let b2 = 0; b2 < SESSIONS_LIST.length; b2++){
                    const s2Start = d2 * SLOTS_PER_DAY + b2 * PERIODS_PER_SESSION;
                    if(s2Start === Math.floor(curFromSlot / PERIODS_PER_SESSION) * PERIODS_PER_SESSION) continue;
                    let hasT = false;
                    for(let p2 = 0; p2 < PERIODS_PER_SESSION; p2++){
                      if(curTg[s2Start + p2] >= 0 || curTg[s2Start + p2] === -3){ hasT = true; break; }
                    }
                    if(hasT){
                      for(let p2 = 0; p2 < PERIODS_PER_SESSION; p2++){
                        const sDst = s2Start + p2;
                        if(sDst !== curFromSlot) candidateSlots.push(sDst);
                      }
                    }
                  }
                }
              }

              this.rng.shuffle(candidateSlots);
              const curCGrid = this.classGridList[curAct.classIdx];

              // Pass 1: Try immediate 1-step displacement with randomSwap
              for(let idx = 0; idx < candidateSlots.length; idx++){
                const sDst = candidateSlots[idx];
                const occId = curCGrid[sDst];

                // Free slot
                if(occId === -1 && this.isSlotFeasible(curAct, sDst)){
                  this.unplaceActivity(curAct.id);
                  this.placeActivityDirect(curAct.id, sDst);
                  return true;
                }

                if(occId >= 0 && occId !== curAct.id){
                  const occAct = this.activities[occId];
                  if(!occAct || occAct.isFixed || occAct.lockedByLessonBlock || occAct.duration !== 1) continue;
                  if(visitedActs.has(occAct.id)) continue;

                  if(this.isSlotFeasible(curAct, sDst, occId)){
                    const innerSnap = this.captureStateSnapshot();
                    this.unplaceActivity(curAct.id);
                    this.unplaceActivity(occId);
                    this.placeActivityDirect(curAct.id, sDst);

                    visitedActs.add(occAct.id);

                    // Try closing cycle by placing occAct at sStartSingleton if it improves metrics
                    if(this.isSlotFeasible(occAct, sStartSingleton)){
                      this.placeActivityDirect(occAct.id, sStartSingleton);
                      const m = this.evaluateMetrics();
                      if(this.countTotalStudentHoles() === 0 && this.compareMetrics(m, currentBest, "optimize_singletons") < 0){
                        return true;
                      }
                      this.unplaceActivity(occAct.id);
                    }

                    // Try absorbing occAct into any open session of occAct's teacher that already has periods
                    let absorbed = false;
                    for(let t = 0; t < occAct.teacherIdxs.length; t++){
                      const occTg = this.teacherGridList[occAct.teacherIdxs[t]];
                      if(!occTg) continue;
                      for(let dAbs = 0; dAbs < DAYS_LIST.length; dAbs++){
                        for(let bAbs = 0; bAbs < SESSIONS_LIST.length; bAbs++){
                          const sAbsStart = dAbs * SLOTS_PER_DAY + bAbs * PERIODS_PER_SESSION;
                          let hasOccT = false;
                          for(let pAbs = 0; pAbs < PERIODS_PER_SESSION; pAbs++){
                            if(occTg[sAbsStart + pAbs] >= 0 || occTg[sAbsStart + pAbs] === -3){ hasOccT = true; break; }
                          }
                          if(hasOccT){
                            for(let pAbs = 0; pAbs < PERIODS_PER_SESSION; pAbs++){
                              const sAbs = sAbsStart + pAbs;
                              if(curCGrid[sAbs] === -1 && this.isSlotFeasible(occAct, sAbs)){
                                this.placeActivityDirect(occAct.id, sAbs);
                                const m = this.evaluateMetrics();
                                if(this.countTotalStudentHoles() === 0 && this.compareMetrics(m, currentBest, "optimize_singletons") < 0){
                                  absorbed = true;
                                  break;
                                }
                                this.unplaceActivity(occAct.id);
                              }
                            }
                          }
                          if(absorbed) break;
                        }
                        if(absorbed) break;
                      }
                      if(absorbed) break;
                    }
                    if(absorbed) return true;

                    // Try placing occAct with randomSwap
                    this.tabuMap.clear();
                    this.triedRemovals.clear();
                    this.swappedInBranch.clear();
                    this.nCalls = 0;
                    this.limitCalls = 200;
                    if(this.randomSwap(occAct.id, 0)){
                      const m = this.evaluateMetrics();
                      if(this.countTotalStudentHoles() === 0 && this.compareMetrics(m, currentBest, "optimize_singletons") < 0){
                        return true;
                      }
                    }

                    // Backtrack
                    visitedActs.delete(occAct.id);
                    this.restoreStateSnapshot(innerSnap);
                  }
                }
              }

              // Pass 2: Deeper recursion if depth < maxDepth
              if(depth < maxDepth){
                for(let idx = 0; idx < candidateSlots.length; idx++){
                  const sDst = candidateSlots[idx];
                  const occId = curCGrid[sDst];
                  if(occId >= 0 && occId !== curAct.id){
                    const occAct = this.activities[occId];
                    if(!occAct || occAct.isFixed || occAct.lockedByLessonBlock || occAct.duration !== 1) continue;
                    if(visitedActs.has(occAct.id)) continue;

                    if(this.isSlotFeasible(curAct, sDst, occId)){
                      const innerSnap = this.captureStateSnapshot();
                      this.unplaceActivity(curAct.id);
                      this.unplaceActivity(occId);
                      this.placeActivityDirect(curAct.id, sDst);

                      visitedActs.add(occAct.id);

                      if(dfsPush(occAct, sDst, depth + 1)){
                        return true;
                      }

                      visitedActs.delete(occAct.id);
                      this.restoreStateSnapshot(innerSnap);
                    }
                  }
                }
              }
              return false;
            };

            if(dfsPush(startAct, sStartSingleton, 1)){
              const m = this.evaluateMetrics();
              if(this.countTotalStudentHoles() === 0 && this.compareMetrics(m, currentBest, "optimize_singletons") < 0){
                currentBest = { ...m };
                improved = true;
                if(typeof onProgress === "function") onProgress(currentBest);
                break;
              } else {
                this.restoreStateSnapshot(snap);
              }
            } else {
              this.restoreStateSnapshot(snap);
            }
          }
        }
      }
      return improved ? currentBest : null;
    }

    async tryCrossClassSingletonKempeSwap(bestMetrics, onProgress = null){
      let currentBest = { ...bestMetrics };
      let improved = false;
      let evalSteps = 0;
      let lastYieldAt = Date.now();

      const scoredList = Array.from(this.scoredTeachers || this.teacherGrid.keys());
      this.rng.shuffle(scoredList);

      for(const tKey of scoredList){
        if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) break;
        const tIdx = this.teacherIndexMap.get(tKey);
        if(tIdx === undefined) continue;
        const tg = this.teacherGridList[tIdx];
        if(!tg) continue;

        for(let d1 = 0; d1 < DAYS_LIST.length; d1++){
          for(let b1 = 0; b1 < SESSIONS_LIST.length; b1++){
            const s1Start = d1 * SLOTS_PER_DAY + b1 * PERIODS_PER_SESSION;
            const singleSlots = [];
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const s = s1Start + p;
              if(tg[s] >= 0) singleSlots.push(s);
            }
            if(singleSlots.length !== 1) continue;

            const s1 = singleSlots[0];
            const act1Id = tg[s1];
            const act1 = this.activities[act1Id];
            if(!act1 || act1.isFixed || act1.lockedByLessonBlock || act1.duration !== 1) continue;

            const cGrid = this.classGridList[act1.classIdx];
            if(!cGrid) continue;

            for(let s2 = 0; s2 < TOTAL_SLOTS; s2++){
              if((++evalSteps % 64) === 0 && Date.now() - lastYieldAt >= 16){
                await new Promise(resolve => setTimeout(resolve, 0));
                lastYieldAt = Date.now();
              }

              if(Math.floor(s2 / PERIODS_PER_SESSION) === Math.floor(s1 / PERIODS_PER_SESSION)) continue;
              const act2Id = cGrid[s2];
              if(act2Id < 0) continue;
              const act2 = this.activities[act2Id];
              if(!act2 || act2.isFixed || act2.lockedByLessonBlock || act2.duration !== 1) continue;

              const snap = this.captureStateSnapshot();
              this.unplaceActivity(act1.id);
              this.unplaceActivity(act2.id);

              if(this.isSlotFeasible(act1, s2) && this.isSlotFeasible(act2, s1)){
                this.placeActivityDirect(act1.id, s2);
                this.placeActivityDirect(act2.id, s1);

                if(this.countTotalStudentHoles() === 0){
                  const m = this.evaluateMetrics();
                  if(this.compareMetrics(m, currentBest, "optimize_singletons") < 0){
                    currentBest = { ...m };
                    improved = true;
                    if(typeof onProgress === "function") onProgress(currentBest);
                    break;
                  }
                }
              }
              this.restoreStateSnapshot(snap);
            }
          }
        }
      }
      return improved ? currentBest : null;
    }

    async tryVacateTeacherSessions(bestMetrics, onProgress = null){
      let currentBest = { ...bestMetrics };
      let improved = false;
      let evalSteps = 0;
      let lastYieldAt = Date.now();

      const scoredList = Array.from(this.scoredTeachers || this.teacherGrid.keys());
      this.rng.shuffle(scoredList);

      for(const tKey of scoredList){
        if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) break;
        const tIdx = this.teacherIndexMap.get(tKey);
        if(tIdx === undefined) continue;
        const tg = this.teacherGridList[tIdx];
        if(!tg) continue;

        for(let d = 0; d < DAYS_LIST.length; d++){
          for(let b = 0; b < SESSIONS_LIST.length; b++){
            if((++evalSteps % 32) === 0 && Date.now() - lastYieldAt >= 16){
              await new Promise(resolve => setTimeout(resolve, 0));
              lastYieldAt = Date.now();
            }

            const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
            const sessionActs = [];
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const s = sStart + p;
              if(tg[s] >= 0) sessionActs.push({ actId: tg[s], slot: s });
            }
            if(sessionActs.length !== 2) continue;

            const snap = this.captureStateSnapshot();
            let allMoved = true;

            for(const item of sessionActs){
              const act = this.activities[item.actId];
              if(!act || act.isFixed || act.lockedByLessonBlock || act.duration !== 1){ allMoved = false; break; }
              this.unplaceActivity(act.id);
              this.nCalls = 0;
              this.tabuMap.clear();
              this.triedRemovals.clear();
              this.swappedInBranch.clear();
              if(!this.randomSwap(act.id, 0)){ allMoved = false; break; }
            }

            if(allMoved && this.countTotalStudentHoles() === 0){
              const m = this.evaluateMetrics();
              if(this.compareMetrics(m, currentBest, "optimize_sessions") < 0){
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
      return improved ? currentBest : null;
    }

    async tryCrushGaps(bestMetrics, onProgress = null){
      let currentBest = { ...bestMetrics };
      let improved = false;
      let evalSteps = 0;
      let lastYieldAt = Date.now();

      const scoredList = Array.from(this.scoredTeachers || this.teacherGrid.keys());
      this.rng.shuffle(scoredList);

      for(const tKey of scoredList){
        if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) break;
        const tIdx = this.teacherIndexMap.get(tKey);
        if(tIdx === undefined) continue;
        const tg = this.teacherGridList[tIdx];
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
              if(!act || act.isFixed || act.lockedByLessonBlock || act.duration !== 1) continue;

              for(let pTarget = 0; pTarget < PERIODS_PER_SESSION; pTarget++){
                if((++evalSteps % 64) === 0 && Date.now() - lastYieldAt >= 16){
                  await new Promise(resolve => setTimeout(resolve, 0));
                  lastYieldAt = Date.now();
                }

                if(taught.includes(pTarget)) continue;
                const sTarget = sStart + pTarget;

                const cGrid = this.classGridList[act.classIdx];
                const occId = cGrid[sTarget];
                const cid = act.classId;

                if(occId >= 0){
                  const occAct = this.activities[occId];
                  if(occAct && !occAct.isFixed && !occAct.lockedByLessonBlock && occAct.duration === 1){
                    const snap = this.captureStateSnapshot();
                    this.unplaceActivity(actId);
                    this.unplaceActivity(occId);

                    let ok = false;
                    if(this.isSlotFeasible(act, sTarget) && this.isSlotFeasible(occAct, sOrig)){
                      this.placeActivityDirect(act.id, sTarget);
                      this.placeActivityDirect(occAct.id, sOrig);
                      ok = true;
                    } else if(this.isSlotFeasible(act, sTarget)){
                      this.placeActivityDirect(act.id, sTarget);
                      this.nCalls = 0;
                      this.tabuMap.clear();
                      this.triedRemovals.clear();
                      this.swappedInBranch.clear();
                      ok = this.randomSwap(occAct.id, 0);
                    }

                    if(ok && this.countTotalStudentHoles() === 0){
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
                } else if(occId === -1){
                  const snap = this.captureStateSnapshot();
                  this.unplaceActivity(actId);
                  if(this.isSlotFeasible(act, sTarget)){
                    this.placeActivityDirect(act.id, sTarget);
                    if(this.countTotalStudentHoles() === 0){
                      const m = this.evaluateMetrics();
                      if(this.compareMetrics(m, currentBest, "optimize_gap2") < 0){
                        currentBest = { ...m };
                        improved = true;
                        if(typeof onProgress === "function") onProgress(currentBest);
                        break;
                      }
                    }
                  }
                  this.restoreStateSnapshot(snap);
                }
              }
              if(improved) break;
            }
          }
        }
      }
      return improved ? currentBest : null;
    }

    async tryIntraClassGapCrush(bestMetrics, onProgress = null){
      let currentBest = { ...bestMetrics };
      let improved = false;
      let evalSteps = 0;
      let lastYieldAt = Date.now();

      const teacherList = Array.from(this.scoredTeachers || this.teacherGrid.keys());
      this.rng.shuffle(teacherList);

      for(const tKey of teacherList){
        if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) break;
        const tIdx = this.teacherIndexMap.get(tKey);
        if(tIdx === undefined) continue;
        const tg = this.teacherGridList[tIdx];
        if(!tg) continue;

        for(let d = 0; d < DAYS_LIST.length; d++){
          for(let b = 0; b < SESSIONS_LIST.length; b++){
            const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
            const taught = [];
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              if(tg[sStart + p] >= 0 || tg[sStart + p] === -3) taught.push(p);
            }
            if(taught.length < 2) continue;

            for(let i = 0; i < taught.length - 1; i++){
              const p1 = taught[i];
              const p2 = taught[i + 1];
              if(p2 - p1 - 1 >= 1){
                const s2 = sStart + p2;
                const act2Id = tg[s2];
                if(act2Id < 0) continue;
                const act2 = this.activities[act2Id];
                if(!act2 || act2.isFixed || act2.lockedByLessonBlock || act2.duration !== 1) continue;

                for(let targetP = p1 + 1; targetP < p2; targetP++){
                  if((++evalSteps % 64) === 0 && Date.now() - lastYieldAt >= 16){
                    await new Promise(resolve => setTimeout(resolve, 0));
                    lastYieldAt = Date.now();
                  }

                  const sTarget = sStart + targetP;
                  const cGrid2 = this.classGridList[act2.classIdx];
                  const occId = cGrid2[sTarget];
                  if(occId === undefined) continue;

                  if(occId >= 0){
                    const occAct = this.activities[occId];
                    if(occAct && !occAct.isFixed && !occAct.lockedByLessonBlock && occAct.duration === 1){
                      const snap = this.captureStateSnapshot();
                      this.unplaceActivity(act2.id);
                      this.unplaceActivity(occAct.id);

                      if(this.isSlotFeasible(act2, sTarget) && this.isSlotFeasible(occAct, s2)){
                        this.placeActivityDirect(act2.id, sTarget);
                        this.placeActivityDirect(occAct.id, s2);

                        if(this.countTotalStudentHoles() === 0){
                          const m = this.evaluateMetrics();
                          if(this.compareMetrics(m, currentBest, "optimize_gap2") < 0){
                            currentBest = { ...m };
                            improved = true;
                            if(typeof onProgress === "function") onProgress(currentBest);
                            break;
                          }
                        }
                      }
                      this.restoreStateSnapshot(snap);
                    }
                  }
                }
                if(improved) break;
              }
            }
            if(improved) break;
          }
          if(improved) break;
        }
      }
      return improved ? currentBest : null;
    }

    async tryCrossDayClassSwap(bestMetrics, onProgress = null){
      let currentBest = { ...bestMetrics };
      let improved = false;
      let evalSteps = 0;
      let lastYieldAt = Date.now();

      const teacherList = Array.from(this.scoredTeachers || this.teacherGrid.keys());
      this.rng.shuffle(teacherList);

      for(const tKey of teacherList){
        if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) break;
        const tIdx = this.teacherIndexMap.get(tKey);
        if(tIdx === undefined) continue;
        const tg = this.teacherGridList[tIdx];
        if(!tg) continue;

        for(let d = 0; d < DAYS_LIST.length; d++){
          for(let b = 0; b < SESSIONS_LIST.length; b++){
            const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
            const taught = [];
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              if(tg[sStart + p] >= 0 || tg[sStart + p] === -3) taught.push(p);
            }
            if(taught.length < 2) continue;

            let hasGap2 = false;
            for(let i = 0; i < taught.length - 1; i++){
              if(taught[i+1] - taught[i] - 1 >= 1){ hasGap2 = true; break; }
            }
            if(!hasGap2) continue;

            for(const p1 of taught){
              const s1 = sStart + p1;
              const act1Id = tg[s1];
              if(act1Id < 0) continue;
              const act1 = this.activities[act1Id];
              if(!act1 || act1.isFixed || act1.lockedByLessonBlock || act1.duration !== 1) continue;

              const cGrid = this.classGridList[act1.classIdx];

              for(let s2 = 0; s2 < TOTAL_SLOTS; s2++){
                if((++evalSteps % 64) === 0 && Date.now() - lastYieldAt >= 16){
                  await new Promise(resolve => setTimeout(resolve, 0));
                  lastYieldAt = Date.now();
                }

                if(Math.floor(s2 / PERIODS_PER_SESSION) === Math.floor(s1 / PERIODS_PER_SESSION)) continue;
                const act2Id = cGrid[s2];
                if(act2Id < 0) continue;
                const act2 = this.activities[act2Id];
                if(!act2 || act2.isFixed || act2.lockedByLessonBlock || act2.duration !== 1) continue;

                const snap = this.captureStateSnapshot();
                this.unplaceActivity(act1.id);
                this.unplaceActivity(act2.id);

                if(this.isSlotFeasible(act1, s2) && this.isSlotFeasible(act2, s1)){
                  this.placeActivityDirect(act1.id, s2);
                  this.placeActivityDirect(act2.id, s1);

                  if(this.countTotalStudentHoles() === 0){
                    const mNew = this.evaluateMetrics();
                    if(this.compareMetrics(mNew, currentBest, "optimize_gap2") < 0){
                      currentBest = { ...mNew };
                      improved = true;
                      if(typeof onProgress === "function") onProgress(currentBest);
                      break;
                    }
                  }
                }
                this.restoreStateSnapshot(snap);
              }
              if(improved) break;
            }
            if(improved) break;
          }
          if(improved) break;
        }
      }
      return improved ? currentBest : null;
    }

    async tryIntraSessionBlockPermutations(bestMetrics, onProgress = null){
      let currentBest = { ...bestMetrics };
      let improved = false;
      let evalSteps = 0;
      let lastYieldAt = Date.now();

      const permute = (arr) => {
        if (arr.length <= 1) return [arr];
        const res = [];
        for (let i = 0; i < arr.length; i++) {
          const current = arr[i];
          const remaining = arr.slice(0, i).concat(arr.slice(i + 1));
          for (const p of permute(remaining)) {
            res.push([current].concat(p));
          }
        }
        return res;
      };

      for(let d = 0; d < DAYS_LIST.length; d++){
        if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) break;
        for(let b = 0; b < SESSIONS_LIST.length; b++){
          const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;

          for(let cIdx = 0; cIdx < this.classes.length; cIdx++){
            const cid = String(this.classes[cIdx].id || "");
            const cGrid = this.classGridList[cIdx];
            if(!cGrid) continue;

            const sessionActIds = [];
            const actSet = new Set();
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const actId = cGrid[sStart + p];
              if(actId >= 0 && !actSet.has(actId)){
                actSet.add(actId);
                sessionActIds.push(actId);
              }
            }
            if(sessionActIds.length < 2 || sessionActIds.length > 4) continue;

            const acts = sessionActIds.map(id => this.activities[id]);
            if(acts.some(a => !a || a.isFixed || a.lockedByLessonBlock)) continue;

            const totalDuration = acts.reduce((sum, a) => sum + a.duration, 0);
            if(totalDuration > PERIODS_PER_SESSION) continue;

            const allPerms = permute(acts);

            const currentMinOffset = Math.min(...acts.map(a => this.actPlacement[a.id] - sStart));
            const candidateStartOffsets = [currentMinOffset];
            if(currentMinOffset !== 0 && totalDuration <= PERIODS_PER_SESSION){
              candidateStartOffsets.push(0);
            }

            for(const startOffset of candidateStartOffsets){
              if(startOffset + totalDuration > PERIODS_PER_SESSION) continue;

              for(const perm of allPerms){
                if((++evalSteps % 32) === 0 && Date.now() - lastYieldAt >= 16){
                  await new Promise(resolve => setTimeout(resolve, 0));
                  lastYieldAt = Date.now();
                }

                const targetSlots = [];
                let currentOffset = startOffset;
                for(const a of perm){
                  targetSlots.push(sStart + currentOffset);
                  currentOffset += a.duration;
                }

                const isSame = perm.every((a, idx) => this.actPlacement[a.id] === targetSlots[idx]);
                if(isSame) continue;

                let hardCollision = false;
                for(let i = 0; i < perm.length; i++){
                  for(let d = 0; d < perm[i].duration; d++){
                    const s = targetSlots[i] + d;
                    const occ = cGrid[s];
                    if(occ === -2 || occ === -3 || (occ >= 0 && !actSet.has(occ))){
                      hardCollision = true; break;
                    }
                  }
                  if(hardCollision) break;
                }
                if(hardCollision) continue;

                const snap = this.captureStateSnapshot();
                for(const a of acts) this.unplaceActivity(a.id);

                let allFeasible = true;
                for(let i = 0; i < perm.length; i++){
                  if(!this.isSlotFeasible(perm[i], targetSlots[i])){
                    allFeasible = false;
                    break;
                  }
                  this.placeActivityDirect(perm[i].id, targetSlots[i]);
                }

                if(allFeasible && this.countTotalStudentHoles() === 0){
                  const mNew = this.evaluateMetrics();
                  if(this.compareMetrics(mNew, currentBest, "optimize_gap2") < 0){
                    currentBest = { ...mNew };
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
          if(improved) break;
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
        const cIdx = this.classIndexMap.get(cid);

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
              const tIndices = [];
              tList.forEach(t => {
                if(!this.teacherGrid.has(t)){
                  const tGrid = new Int32Array(TOTAL_SLOTS).fill(-1);
                  this.teacherGrid.set(t, tGrid);
                  this.teacherIndexMap.set(t, this.teachers.length);
                  this.teachers.push(t);
                  this.teacherGridList.push(tGrid);
                }
                tIndices.push(this.teacherIndexMap.get(t));
              });

              let roomIdx = -1;
              if(rm){
                const rKey = rm.trim().toLowerCase();
                if(!this.roomGrid.has(rKey)){
                  const rGrid = new Int32Array(TOTAL_SLOTS).fill(-1);
                  this.roomGrid.set(rKey, rGrid);
                  this.roomIndexMap.set(rKey, this.rooms.length);
                  this.rooms.push(rKey);
                  this.roomGridList.push(rGrid);
                }
                roomIdx = this.roomIndexMap.get(rKey);
              }

              const loc = (rm && this.roomLocationMap.get(rm.toLowerCase())) || this.classLocationMap.get(cid.toLowerCase()) || "";

              const subRules = this.getSubjectRules(mon, lop);
              const lessonBlocks = subRules.lessonBlocks || {};
              const blocksMax = {};
              for(const K of [5, 4, 3, 2]){
                const blockConfig = lessonBlocks[String(K)] || lessonBlocks[K] || {};
                if(blockConfig.max !== undefined && blockConfig.max !== "" && blockConfig.max !== null){
                  const val = Number(blockConfig.max);
                  if(!isNaN(val) && val >= 0){
                    blocksMax[K] = val;
                  }
                }
              }
              const lessonBlocksMax = Object.keys(blocksMax).length > 0 ? blocksMax : null;

              let runLen = 1;
              while(p + runLen < PERIODS_PER_SESSION){
                const nextCell = arr[p + runLen];
                if(!nextCell || this.isCellOff(nextCell) || this.isCellFixed(nextCell)) break;
                const nextMon = this.extractMon(nextCell);
                if(nextMon !== mon) break;
                runLen++;
              }

              let lockedK = 0;
              for(const K of [5, 4, 3, 2]){
                const bMin = Number(lessonBlocks[String(K)]?.min) || Number(lessonBlocks[K]?.min) || 0;
                if(bMin > 0 && runLen >= K){
                  lockedK = K;
                  break;
                }
              }

              if(lockedK > 0){
                for(let k = 0; k < lockedK; k++){
                  const actId = actIdCounter++;
                  const act = {
                    id: actId,
                    classId: cid,
                    classIdx: cIdx,
                    mon,
                    canonKey,
                    gv,
                    gvList: tList,
                    teacherIdxs: new Int32Array(tIndices),
                    room: rm,
                    roomIdx,
                    location: loc,
                    duration: 1,
                    maxDaily,
                    lessonBlocksMax,
                    isFixed: true,
                    lockedByLessonBlock: true
                  };
                  this.activities.push(act);
                  this.actPlacement.push(slot + k);
                  this.placeActivityDirect(actId, slot + k);
                }
                p += lockedK;
                continue;
              }

              const actId = actIdCounter++;
              const act = {
                id: actId,
                classId: cid,
                classIdx: cIdx,
                mon,
                canonKey,
                gv,
                gvList: tList,
                teacherIdxs: new Int32Array(tIndices),
                room: rm,
                roomIdx,
                location: loc,
                duration: 1,
                maxDaily,
                mustKeepBlock: false,
                lessonBlocksMax,
                isFixed: false
              };
              this.activities.push(act);
              this.actPlacement.push(slot);
              this.placeActivityDirect(actId, slot);

              p += 1;
            }
          });
        });
      });
    }

    async optimize(mode = "optimize_all", onProgress = null){
      if(this.activities.length === 0 || this.actPlacement.every(p => p < 0)){
        this.loadExistingSchedule();
      }
      this.compileConstraints();
      const locViolations = this.validateIncumbentLocationConstraints();
      if(locViolations.length > 0){
        return {
          ok: false,
          applied: false,
          failureKind: "fet_location_constraint_violation",
          diagnostics: { locationConstraintViolations: locViolations }
        };
      }

      let totalRequired = 0;
      this.classes.forEach(l => {
        const cid = String(l.id || "");
        const classCanon = l.ten2 || l.ten || cid;
        Object.keys(this.data.pccmMatrix || {}).forEach(k => {
          if(k.startsWith(cid + "|") || k.startsWith(classCanon + "|")){
            const mon = k.split("|").slice(1).join("|");
            totalRequired += this.getRequiredPeriods(l, mon);
          } 
        });
      });
      let placedTotal = 0;
      this.classes.forEach(l => {
        const cid = String(l.id || "");
        const grid = this.classGrid.get(cid);
        if(grid){
          for(let s = 0; s < TOTAL_SLOTS; s++){
            if(grid[s] >= 0 || grid[s] === -3) placedTotal++;
          }
        }
      });

      if(totalRequired > 0 && placedTotal < totalRequired){
        return {
          ok: false,
          applied: false,
          failureKind: "fet_optimize_requires_complete_schedule",
          diagnostics: this.constraintPreflight
        };
      }

      const initialMetrics = this.evaluateMetrics();
      let bestMetrics = { ...initialMetrics };

      const targetMetricKey = mode === "optimize_gap2" ? "soBuoiTrong2" : (mode === "optimize_singletons" ? "soBuoiDay1" : (mode === "optimize_gap1" ? "soBuoiTrong1" : (mode === "optimize_sessions" ? "tsBuoiDay" : "soBuoiDay1")));
      const targetMetricLowerBound = Number(this.constraintPreflight?.structuralFloor?.metricLowerBounds?.[targetMetricKey] || 0);

      this.deadlineAtMs = Date.now() + (Number(this.timeBudgetMs) || 10000);
      const MAX_ROUNDS = mode === "optimize_all" ? 6 : 5;
      for(let r = 0; r < MAX_ROUNDS; r++){
        if(Date.now() >= this.deadlineAtMs) break;
        let anyRoundImprovement = false;

        if(mode === "optimize_all" || mode === "optimize_singletons"){
          const res1 = await this.tryRelocateSingletons(bestMetrics, onProgress);
          if(res1){ bestMetrics = res1; anyRoundImprovement = true; }
          const res2 = await this.tryShareRichToSingleton(bestMetrics, onProgress);
          if(res2){ bestMetrics = res2; anyRoundImprovement = true; }
          const res3 = await this.trySingletonRelabelCycles(bestMetrics, onProgress);
          if(res3){ bestMetrics = res3; anyRoundImprovement = true; }
          const res3b = await this.tryClosedPushCycles(bestMetrics, onProgress);
          if(res3b){ bestMetrics = res3b; anyRoundImprovement = true; }
          const res3c = await this.tryIntraClassSingletonSwap(bestMetrics, onProgress);
          if(res3c){ bestMetrics = res3c; anyRoundImprovement = true; }
          const res3d = await this.tryCrossClassSingletonKempeSwap(bestMetrics, onProgress);
          if(res3d){ bestMetrics = res3d; anyRoundImprovement = true; }
        }

        if(mode === "optimize_all" || mode === "optimize_gap2" || mode === "optimize_gap1"){
          const res4 = await this.tryCrushGaps(bestMetrics, onProgress);
          if(res4){ bestMetrics = res4; anyRoundImprovement = true; }
          const res4b = await this.tryIntraClassGapCrush(bestMetrics, onProgress);
          if(res4b){ bestMetrics = res4b; anyRoundImprovement = true; }
          const res4c = await this.tryCrossDayClassSwap(bestMetrics, onProgress);
          if(res4c){ bestMetrics = res4c; anyRoundImprovement = true; }
          const res4d = await this.tryIntraSessionBlockPermutations(bestMetrics, onProgress);
          if(res4d){ bestMetrics = res4d; anyRoundImprovement = true; }
        }

        if(mode === "optimize_all" || mode === "optimize_sessions"){
          const res5 = await this.tryVacateTeacherSessions(bestMetrics, onProgress);
          if(res5){ bestMetrics = res5; anyRoundImprovement = true; }
        }

        this.compactAllStudentSessions();

        if(typeof onProgress === "function"){
          onProgress({
            percent: Math.round(((r + 1) / MAX_ROUNDS) * 100),
            currentMetric: bestMetrics[targetMetricKey],
            initialMetric: initialMetrics[targetMetricKey],
            stage: mode,
            metrics: bestMetrics
          });
        }

        await new Promise(resolve => setTimeout(resolve, 0));

        if(bestMetrics[targetMetricKey] <= targetMetricLowerBound && bestMetrics.soBuoiDay1 === 0){
          break;
        }

        if(!anyRoundImprovement){
          // If still have singletons, do an ILS push cycle with higher depth
          if((mode === "optimize_all" || mode === "optimize_singletons") && bestMetrics.soBuoiDay1 > 0 && r < MAX_ROUNDS - 1){
            const deepRes = await this.tryClosedPushCycles(bestMetrics, onProgress, 4);
            if(deepRes){
              bestMetrics = deepRes;
              anyRoundImprovement = true;
            }
          }
          if(!anyRoundImprovement) break;
        }
      }

      this.applyToDataTKB();
      const currentVal = bestMetrics[targetMetricKey];
      const targetReached = currentVal === 0 || currentVal <= targetMetricLowerBound;
      const floorReached = currentVal <= targetMetricLowerBound;

      return {
        ok: true,
        applied: true,
        targetMetric: targetMetricKey,
        targetMetricKey,
        targetMetricLowerBound,
        targetReached,
        floorReached,
        initialMetrics,
        metrics: bestMetrics,
        placed: this.activities.length,
        unassigned: 0,
        diagnostics: this.constraintPreflight
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
              const key = cid + "|" + slot;
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
          const key = cid + "|" + s;

          if(this.fixedRawCells.has(key) || this.offSlots.has(key)) continue;

          data.tkb[cid][details.thu][details.buoi][details.periodIdx] = act.mon;
          const tkbKey = cid + "|" + act.mon;
          if(act.gv) data.tkbLessonTeachers[tkbKey] = act.gv;
          if(act.room) data.tkbLessonRooms[tkbKey] = act.room;
        }
      });
    }

    getSnapshotTKB(){
      this.applyToDataTKB();
      return JSON.parse(JSON.stringify(this.data.tkb));
    }

    getRetainedOptimizationSnapshotTKB(){
      return this.getSnapshotTKB();
    }
  }

  // Export to environment
  if(typeof module !== "undefined" && module.exports){
    module.exports = { FetTimetableEngine, FetPRNG, slotToDetails, detailsToSlot, DAYS_LIST, SESSIONS_LIST };
  }
  if(typeof self !== "undefined"){
    self.FetTimetableEngine = FetTimetableEngine;
    self.FetPRNG = FetPRNG;
  }
  if(typeof window !== "undefined"){
    window.FetTimetableEngine = FetTimetableEngine;
    window.FetPRNG = FetPRNG;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
