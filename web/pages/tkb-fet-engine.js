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

  // The timetable is stored interleaved by day (morning, afternoon).  The
  // singleton optimizer reasons in the simpler 12-bin layout proposed by the
  // scheduling model: bins 0..5 are Monday..Saturday morning and bins 6..11
  // are Monday..Saturday afternoon.
  function sessionIndexToBin(sessionIdx){
    return (sessionIdx % 2 === 0) ? (sessionIdx / 2) : (6 + Math.floor(sessionIdx / 2));
  }

  function sessionBinToIndex(bin){
    return bin < 6 ? bin * 2 : ((bin - 6) * 2 + 1);
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
      const isDeep = Boolean(options.deepCycles || options.deepLocalFet);
      this.timeBudgetMs = Number(options.timeBudgetMs) || (isDeep ? 30000 : 12000);
      this.optimizeTimeBudgetMs = Number(options.optimizeTimeBudgetMs) || (isDeep ? 35000 : 20000);

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

      // Khoa "1 tiet/buoi" theo tinh than FET: mot rang buoc dat trong so 100%
      // se tro thanh CONG CUNG luc dat tiet, dat roi thi khong nuoc di nao duoc
      // pha (generate.cpp: okteachersminhoursdaily -> nConflActivities=MAX).
      //   singletonLock === null  -> chua cham muc tieu, chua khoa.
      //   singletonLock === k     -> khong nuoc di nao duoc de soBuoiDay1 > k.
      // singletonRushActive: giai doan CHUA cham muc tieu, 1 tiet/buoi la doc
      // quyen — duoc phep tang buoi day / tiet trong de thoat ket nhanh.
      this.singletonLock = null;
      this.singletonRushActive = false;

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

    getAdaptiveLimitCalls(base = 2000, deep = 3500){
      if(this.options?.limitCalls && Number(this.options.limitCalls) > 0) return Number(this.options.limitCalls);
      if(this.options?.deepLimitCalls && Number(this.options.deepLimitCalls) > 0) return Number(this.options.deepLimitCalls);
      if(this.options?.deepCycles || this.options?.deepLocalFet) return deep;
      return base;
    }

    getTabuTenure(){
      const isDeep = Boolean(this.options?.deepCycles || this.options?.deepLocalFet);
      return isDeep ? 7 + this.rng.nextInt(10) : 5 + this.rng.nextInt(8);
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
      const monObj = (data.mon || []).find(m => m.ten === mon || m.ma === mon) || (data.monhoc || []).find(m => m.ten === mon || m.ma === mon);
      if(monObj && monObj.gioihan !== undefined && monObj.gioihan !== null && monObj.gioihan !== ""){
        const val = Number(monObj.gioihan);
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
      this.computeTeacherWeeklyLoad();

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
        if(!this.suspendStudentHoleGuard && newHoles > 0 && newHoles > origHoles){
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
      for(let i = 0; i < this.activities.length; i++){
        const a = this.activities[i];
        for(let j = 0; j < a.teacherIdxs.length; j++){
          const tIdx = a.teacherIdxs[j];
          const t = this.teachers[tIdx];
          this.teacherWeeklyLoad.set(t, (this.teacherWeeklyLoad.get(t) || 0) + a.duration);
        }
      }
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

    // Bat bien dem cua FET cho "moi buoi day it nhat 2 tiet"
    // (ConstraintTeachersMinHoursDaily, generate.cpp: okteachersminhoursdaily).
    //
    // FET kiem tra  Sum_{buoi co day} max(H_buoi, minHoursDaily) <= tong tai GV.
    // Dang tuong duong dang dung o day la  totalDeficit <= remainingUnplaced.
    //
    // Khi bat `gapAwareSessionGuard`, cong them ve tiet trong dung nhu FET lam
    // khi ca MinHoursDaily lan MaxGapsPerDay cung bat (generate.cpp dong
    // 30972-30976):  max(H_buoi + max(0, gaps_buoi - maxGaps), minHoursDaily).
    // Voi hop dong cua du an nay minHoursDaily = 2 va maxGaps = 1 ("mot buoi
    // khong qua 1 tiet trong"), nen pha dung lich nhin thay truoc ca no gap-2
    // chu khong chi no tiet. Mac dinh TAT vi day la duong nong cua isSlotFeasible
    // va can benchmark truoc khi doi hanh vi dung lich.
    opensUnaffordableSession(act, slot){
      if(!this.minTwoGuardActive || !this.teacherSessionCounts) return false;
      const sessIdx = Math.floor(slot / PERIODS_PER_SESSION);
      const dur = act.duration;
      const isAlreadyPlaced = (this.actPlacement && this.actPlacement[act.id] !== undefined && this.actPlacement[act.id] >= 0);
      const oldSlot = isAlreadyPlaced ? this.actPlacement[act.id] : -1;
      const oldSessIdx = isAlreadyPlaced ? Math.floor(oldSlot / PERIODS_PER_SESSION) : -1;
      const gapAware = this.options?.gapAwareSessionGuard === true;

      for(let i = 0; i < act.teacherIdxs.length; i++){
        const tIdx = act.teacherIdxs[i];
        const tBase = tIdx * 12;
        const tKey = this.teachers[tIdx];
        const totalLoad = this.teacherWeeklyLoad?.get(tKey) || 0;

        if(totalLoad <= 1) continue;

        const tg = gapAware ? this.teacherGridList[tIdx] : null;
        let totalPlaced = 0;
        let openedSessions = 0;
        let totalDeficit = 0;
        let reqHours = 0;

        for(let s = 0; s < 12; s++){
          let current = this.teacherSessionCounts[tBase + s];
          if(isAlreadyPlaced && s === oldSessIdx){
            current -= dur;
          }
          totalPlaced += current;
          const sim = current + (s === sessIdx ? dur : 0);
          if(sim > 0){
            openedSessions++;
            if(sim < 2){
              totalDeficit += (2 - sim);
            }
            if(tg){
              const base = s * PERIODS_PER_SESSION;
              let mask = 0;
              for(let p = 0; p < PERIODS_PER_SESSION; p++){
                const cell = tg[base + p];
                if(cell >= 0 || cell === -3) mask |= (1 << p);
              }
              if(isAlreadyPlaced && s === oldSessIdx){
                for(let o = 0; o < dur; o++){
                  const bit = (oldSlot - base) + o;
                  if(bit >= 0 && bit < PERIODS_PER_SESSION) mask &= ~(1 << bit);
                }
              }
              if(s === sessIdx){
                for(let o = 0; o < dur; o++){
                  const bit = (slot - base) + o;
                  if(bit >= 0 && bit < PERIODS_PER_SESSION) mask |= (1 << bit);
                }
              }
              const extraGaps = Math.max(0, SESSION_STATS_LUT[mask].gaps - 1);
              reqHours += Math.max(sim + extraGaps, 2);
            }
          }
        }

        const maxAllowedSessions = Math.floor(totalLoad / 2);
        if(openedSessions > maxAllowedSessions){
          return true;
        }

        const remainingUnplaced = totalLoad - (totalPlaced + dur);
        if(totalDeficit > remainingUnplaced){
          return true;
        }

        if(tg && reqHours > totalLoad){
          return true;
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

    buildConstructionSessionHints(){
      // Build a soft 12-bin plan before period coloring. It never becomes a
      // hard constraint: if the period-level FET checks reject the hinted bin,
      // randomSwap may still use any legal session. The plan only prevents the
      // greedy constructor from opening a fresh singleton session when a
      // compatible teacher/class bin is still available.
      const teacherCapacity = new Int16Array(this.teachers.length * 12);
      const classCapacity = new Int16Array(this.classes.length * 12);
      const teacherFixedLoad = new Int16Array(this.teachers.length * 12);
      const classFixedLoad = new Int16Array(this.classes.length * 12);
      for(let tIdx = 0; tIdx < this.teacherGridList.length; tIdx++){
        const grid = this.teacherGridList[tIdx];
        if(!grid) continue;
        for(let session = 0; session < 12; session++){
          for(let p = 0; p < PERIODS_PER_SESSION; p++){
            const value = grid[session * PERIODS_PER_SESSION + p];
            if(value !== -2) teacherCapacity[tIdx * 12 + session]++;
            if(value === -3) teacherFixedLoad[tIdx * 12 + session]++;
          }
        }
      }
      for(let classIdx = 0; classIdx < this.classGridList.length; classIdx++){
        const grid = this.classGridList[classIdx];
        if(!grid) continue;
        for(let session = 0; session < 12; session++){
          for(let p = 0; p < PERIODS_PER_SESSION; p++){
            const value = grid[session * PERIODS_PER_SESSION + p];
            if(value !== -2) classCapacity[classIdx * 12 + session]++;
            if(value === -3) classFixedLoad[classIdx * 12 + session]++;
          }
        }
      }

      const sessionDomains = this.activities.map(act => Array.from(new Set(
        (this.allowedSlotsByActivity?.get(act) || []).map(slot => Math.floor(slot / PERIODS_PER_SESSION))
      )));
      let bestPlan = null;
      let bestPlanScore = Infinity;
      const restarts = Math.max(1, Math.min(16, Number(this.options?.initialSessionPlanRestarts) || 8));

      for(let restart = 0; restart < restarts; restart++){
        const teacherLoad = new Int16Array(teacherFixedLoad);
        const classLoad = new Int16Array(classFixedLoad);
        const plan = new Map();

        for(const act of this.activities){
          const sessions = sessionDomains[act.id] || [];
          if(sessions.length === 0) continue;
          const dur = act.duration || 1;
          let bestSession = null;
          let bestScore = Infinity;
          for(const session of sessions){
            let score = 0;
            for(const tIdx of act.teacherIdxs || []){
              const offset = tIdx * 12 + session;
              const before = teacherLoad[offset] || 0;
              const after = before + dur;
              const overflow = Math.max(0, after - teacherCapacity[offset]);
              if(overflow > 0) score += 100000 + overflow * 10000;
              if(dur === 1 && before === 0) score += 10000;
              if(dur === 1 && before === 1) score -= 10000;
              score += after * 5;
            }
            const classOffset = act.classIdx * 12 + session;
            const classBefore = classLoad[classOffset] || 0;
            const classOverflow = Math.max(0, classBefore + dur - classCapacity[classOffset]);
            if(classOverflow > 0) score += 100000 + classOverflow * 10000;
            score += classBefore * 20;
            // Different restarts explore equal-cost bins while retaining a
            // deterministic result for the same public seed.
            score += this.rng.next() * 0.1;
            if(score < bestScore){
              bestScore = score;
              bestSession = session;
            }
          }

          plan.set(act.id, bestSession);
          for(const tIdx of act.teacherIdxs || []){
            teacherLoad[tIdx * 12 + bestSession] += dur;
          }
          classLoad[act.classIdx * 12 + bestSession] += dur;
        }

        // Repair predicted singleton bins without constraining period-level
        // placement. Only zero-overflow moves that lower the plan's singleton
        // count are accepted.
        for(let pass = 0; pass < 5; pass++){
          let changed = false;
          for(const act of this.activities){
            const source = plan.get(act.id);
            if(source === undefined) continue;
            const dur = act.duration || 1;
            let target = source;
            let bestDelta = 0;
            for(const destination of sessionDomains[act.id] || []){
              if(destination === source) continue;
              const classOffset = act.classIdx * 12 + destination;
              if(classLoad[classOffset] + dur > classCapacity[classOffset]) continue;
              let delta = 0;
              let valid = true;
              for(const tIdx of act.teacherIdxs || []){
                const sourceCount = teacherLoad[tIdx * 12 + source];
                const targetOffset = tIdx * 12 + destination;
                const targetCount = teacherLoad[targetOffset];
                if(targetCount + dur > teacherCapacity[targetOffset]){
                  valid = false;
                  break;
                }
                delta += ((sourceCount - dur === 1 ? 1 : 0) + (targetCount + dur === 1 ? 1 : 0))
                  - ((sourceCount === 1 ? 1 : 0) + (targetCount === 1 ? 1 : 0));
              }
              if(valid && delta < bestDelta){
                bestDelta = delta;
                target = destination;
              }
            }
            if(target !== source){
              for(const tIdx of act.teacherIdxs || []){
                teacherLoad[tIdx * 12 + source] -= dur;
                teacherLoad[tIdx * 12 + target] += dur;
              }
              classLoad[act.classIdx * 12 + source] -= dur;
              classLoad[act.classIdx * 12 + target] += dur;
              plan.set(act.id, target);
              changed = true;
            }
          }
          if(!changed) break;
        }

        let predictedSingletons = 0;
        let overflow = 0;
        for(let i = 0; i < teacherLoad.length; i++){
          if(teacherLoad[i] === 1) predictedSingletons++;
          overflow += Math.max(0, teacherLoad[i] - teacherCapacity[i]);
        }
        for(let i = 0; i < classLoad.length; i++){
          overflow += Math.max(0, classLoad[i] - classCapacity[i]);
        }
        const planScore = overflow * 100000 + predictedSingletons;
        if(planScore < bestPlanScore){
          bestPlanScore = planScore;
          bestPlan = plan;
        }
      }

      this.constructionSessionHints = bestPlan || new Map();
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
      const hintedSession = this.constructionSessionHints?.get(act.id);
      if(hintedSession !== undefined){
        score += Math.floor(slot / PERIODS_PER_SESSION) === hintedSession ? -500 : 500;
      }
      if(!this.teacherSessionCounts) return score;

      const dIdx = Math.floor(slot / SLOTS_PER_DAY);
      const sIdx = Math.floor((slot % SLOTS_PER_DAY) / PERIODS_PER_SESSION);
      const sessOffset = dIdx * 2 + sIdx;
      const otherOffset = dIdx * 2 + (1 - sIdx);

      for(let i = 0; i < act.teacherIdxs.length; i++){
        const tIdx = act.teacherIdxs[i];
        const tBase = tIdx * 12;

        const cntInSess = this.teacherSessionCounts[tBase + sessOffset];
        const duration = act.duration || 1;
        const projectedCount = cntInSess + duration;
        score += ((projectedCount === 1 ? 1 : 0) - (cntInSess === 1 ? 1 : 0)) * 5000;
        if(duration === 1 && cntInSess === 0) score += 300;
        if(cntInSess === 1){
          score -= 350;
        } else if(cntInSess === 2){
          score -= 150;
        } else if(cntInSess === 3){
          score -= 80;
        } else if(cntInSess === 0){
          const otherCnt = this.teacherSessionCounts[tBase + otherOffset];
          if(otherCnt > 0){
            score += 30;
          } else {
            score += 180;
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
        if(this.minTwoGuardActive && this.constructionSessionHints){
          candidateSlots.sort((a, b) => this.slotTeacherAffinityScore(act, a) - this.slotTeacherAffinityScore(act, b));
        }else{
          this.rng.shuffle(candidateSlots);
        }

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
        const isUnaffordable = (level < 6 && this.minTwoGuardActive) ? this.opensUnaffordableSession(act, slot) : false;
        candidateInfo.push({
          slot,
          displacedActIds: Array.from(displacedActIds),
          nConflActs: displacedActIds.size,
          totalWrong: totalWrong + domainTightnessPenalty,
          sessionAffinityScore,
          isUnaffordable,
          minIndexAct,
          tieBreaker: this.rng.next()
        });
      }

      candidateInfo.sort((a, b) => {
        if(a.isUnaffordable !== b.isUnaffordable) return a.isUnaffordable ? 1 : -1;
        if(a.nConflActs !== b.nConflActs) return a.nConflActs - b.nConflActs;
        if(a.totalWrong !== b.totalWrong) return a.totalWrong - b.totalWrong;
        if(this.minTwoGuardActive && a.sessionAffinityScore !== b.sessionAffinityScore){
          return a.sessionAffinityScore - b.sessionAffinityScore;
        }
        return a.tieBreaker - b.tieBreaker;
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
        const tenure = this.getTabuTenure();

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

    computeTeacherSingletonLowerBound(){
      const evidence = [];
      let lowerBound = 0;
      const teacherActivities = Array.from({ length: this.teachers.length }, () => []);

      for(const act of this.activities){
        for(const tIdx of act.teacherIdxs || []){
          if(teacherActivities[tIdx]) teacherActivities[tIdx].push(act);
        }
      }

      for(let tIdx = 0; tIdx < teacherActivities.length; tIdx++){
        const teacher = this.teachers[tIdx];
        if(!teacher || !this.isScoredTeacher(teacher)) continue;

        const parent = new Int32Array(12);
        for(let s = 0; s < 12; s++) parent[s] = s;
        const find = (x) => {
          let root = x;
          while(parent[root] !== root) root = parent[root];
          while(parent[x] !== x){
            const next = parent[x];
            parent[x] = root;
            x = next;
          }
          return root;
        };
        const union = (a, b) => {
          const ra = find(a);
          const rb = find(b);
          if(ra !== rb) parent[rb] = ra;
        };
        const activitySessions = new Map();

        for(const act of teacherActivities[tIdx]){
          const allowed = this.allowedSlotsByActivity?.get(act) || [];
          const sessions = new Set();
          for(const slot of allowed){
            const session = Math.floor(slot / PERIODS_PER_SESSION);
            if(session >= 0 && session < 12) sessions.add(session);
          }
          if(sessions.size === 0) continue;
          const list = Array.from(sessions);
          for(let i = 1; i < list.length; i++) union(list[0], list[i]);
          activitySessions.set(act, list);
        }

        const components = new Map();
        const ensureComponent = (root) => {
          if(!components.has(root)) components.set(root, { sessions: [], load: 0 });
          return components.get(root);
        };

        for(const [act, sessions] of activitySessions){
          const component = ensureComponent(find(sessions[0]));
          component.load += Math.max(1, Number(act.duration) || 1);
          for(const session of sessions){
            if(!component.sessions.includes(session)) component.sessions.push(session);
          }
        }

        const tg = this.teacherGridList[tIdx];
        if(tg){
          for(let session = 0; session < 12; session++){
            let fixedCount = 0;
            const start = session * PERIODS_PER_SESSION;
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              if(tg[start + p] === -3) fixedCount++;
            }
            if(fixedCount > 0) ensureComponent(find(session)).load += fixedCount;
          }
        }

        for(const component of components.values()){
          if(component.load !== 1) continue;
          lowerBound++;
          evidence.push({
            metric: "soBuoiDay1",
            teacher,
            reason: "teacher_session_domain_component_has_one_period",
            sessions: component.sessions.slice().sort((a, b) => a - b)
          });
        }
      }

      return { lowerBound, evidence };
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

      const singletonFloor = this.computeTeacherSingletonLowerBound();
      metricLowerBounds.soBuoiDay1 = singletonFloor.lowerBound;
      metricLowerBoundEvidence.push(...singletonFloor.evidence);

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

    initialSingletonPacking(options = {}){
      if(this.getUnassignedCount() > 0) return { attempts: 0, accepted: 0, elapsedMs: 0 };

      const startedAt = Date.now();
      const configuredBudget = Number(options.timeBudgetMs ?? this.options?.initialSingletonPackingBudgetMs);
      const budgetMs = Math.max(0, Math.min(
        Number.isFinite(configuredBudget) && configuredBudget >= 0 ? configuredBudget : 2500,
        15000
      ));
      const configuredAttempts = Number(options.maxAttempts ?? this.options?.initialSingletonPackingMaxAttempts);
      const maxAttempts = Math.max(1, Math.min(
        Number.isFinite(configuredAttempts) && configuredAttempts > 0 ? Math.floor(configuredAttempts) : 12000,
        50000
      ));
      const deadline = Math.min(
        startedAt + budgetMs,
        this.deadlineAtMs || (startedAt + budgetMs)
      );
      let attempts = 0;
      let accepted = 0;

      const hasTime = () => attempts < maxAttempts && Date.now() < deadline;
      const currentMetrics = () => this.evaluateMetrics();
      const acceptIfBetter = before => {
        const after = currentMetrics();
        return after.unplacedCount === 0
          && after.soBuoiDay1 < before.soBuoiDay1
          && after.soBuoiTrong2 <= before.soBuoiTrong2
          && this.countTotalStudentHoles() === 0;
      };
      const teacherSessionCount = (tIdx, session) => {
        const tg = this.teacherGridList[tIdx];
        if(!tg) return 0;
        let count = 0;
        for(let p = 0; p < PERIODS_PER_SESSION; p++){
          if(tg[session * PERIODS_PER_SESSION + p] >= 0) count++;
        }
        return count;
      };
      const targetWorksForAllTeachers = (act, session, slot) => {
        for(const tIdx of act.teacherIdxs || []){
          const tg = this.teacherGridList[tIdx];
          if(!tg || tg[slot] !== -1) return false;
          if(teacherSessionCount(tIdx, session) < 1) return false;
        }
        return true;
      };

      const tryDirectMove = (act, sourceSlot, targetSession, before) => {
        const classGrid = this.classGridList[act.classIdx];
        for(let p = 0; p < PERIODS_PER_SESSION && hasTime(); p++){
          const targetSlot = targetSession * PERIODS_PER_SESSION + p;
          if(!targetWorksForAllTeachers(act, targetSession, targetSlot)) continue;
          if(!classGrid || classGrid[targetSlot] !== -1) continue;

          attempts++;
          const snapshot = this.captureStateSnapshot();
          this.unplaceActivity(act.id);
          let ok = this.isSlotFeasible(act, targetSlot);
          if(ok) this.placeActivityDirect(act.id, targetSlot);
          if(ok && acceptIfBetter(before)){
            accepted++;
            return true;
          }
          this.restoreStateSnapshot(snapshot);
        }
        return false;
      };

      const tryThreeStepChain = (act, sourceSlot, targetSession, before) => {
        const classGrid = this.classGridList[act.classIdx];
        for(let p = 0; p < PERIODS_PER_SESSION && hasTime(); p++){
          const targetSlot = targetSession * PERIODS_PER_SESSION + p;
          if(!targetWorksForAllTeachers(act, targetSession, targetSlot)) continue;
          const displacedId = classGrid ? classGrid[targetSlot] : -1;
          const displaced = displacedId >= 0 ? this.activities[displacedId] : null;
          if(!displaced || displaced.isFixed || displaced.lockedByLessonBlock || displaced.duration !== 1) continue;

          const displacedClassGrid = this.classGridList[displaced.classIdx];
          const displacedDomain = this.allowedSlotsByActivity?.get(displaced) || [];
          for(const nextSlot of displacedDomain){
            if(!hasTime()) break;
            if(nextSlot === sourceSlot || nextSlot === targetSlot) continue;
            const nextId = displacedClassGrid ? displacedClassGrid[nextSlot] : -1;
            const next = nextId >= 0 ? this.activities[nextId] : null;
            if(nextId === -2 || nextId === -3) continue;
            if(next && (next.isFixed || next.lockedByLessonBlock || next.duration !== 1 || next.id === act.id || next.id === displaced.id)) continue;

            const ids = [act.id, displaced.id];
            if(next) ids.push(next.id);
            const snapshot = this.captureStateSnapshot();
            for(const id of ids) this.unplaceActivity(id);

            let ok = this.isSlotFeasible(act, targetSlot);
            if(ok) this.placeActivityDirect(act.id, targetSlot);
            ok = ok && this.isSlotFeasible(displaced, nextSlot);
            if(ok) this.placeActivityDirect(displaced.id, nextSlot);
            if(ok && next){
              ok = this.isSlotFeasible(next, sourceSlot);
              if(ok) this.placeActivityDirect(next.id, sourceSlot);
            }

            attempts++;
            if(ok && acceptIfBetter(before)){
              accepted++;
              return true;
            }
            this.restoreStateSnapshot(snapshot);
          }
        }
        return false;
      };

      for(let pass = 0; pass < 3 && hasTime(); pass++){
        let changed = false;
        for(let tIdx = 0; tIdx < this.teacherGridList.length && hasTime(); tIdx++){
          const tg = this.teacherGridList[tIdx];
          if(!tg) continue;
          for(let session = 0; session < 12 && hasTime(); session++){
            const ids = [];
            let sourceSlot = -1;
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const slot = session * PERIODS_PER_SESSION + p;
              const id = tg[slot];
              if(id >= 0){
                ids.push(id);
                sourceSlot = slot;
              }
            }
            if(ids.length !== 1) continue;
            const act = this.activities[ids[0]];
            if(!act || act.isFixed || act.lockedByLessonBlock || act.duration !== 1) continue;

            const before = currentMetrics();
            const targets = [];
            for(let targetSession = 0; targetSession < 12; targetSession++){
              if(targetSession === session) continue;
              let allTeachersHaveSession = true;
              let richness = 0;
              for(const teacherIdx of act.teacherIdxs || []){
                const count = teacherSessionCount(teacherIdx, targetSession);
                if(count < 1) allTeachersHaveSession = false;
                richness += count;
              }
              if(allTeachersHaveSession) targets.push({ targetSession, richness });
            }
            targets.sort((a, b) => b.richness - a.richness);

            for(const target of targets){
              if(tryDirectMove(act, sourceSlot, target.targetSession, before)
                || tryThreeStepChain(act, sourceSlot, target.targetSession, before)){
                changed = true;
                break;
              }
            }
          }
        }
        if(!changed) break;
      }

      return { attempts, accepted, elapsedMs: Date.now() - startedAt, metrics: currentMetrics() };
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
      this.buildConstructionSessionHints();

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
                  const tenure = 8 + this.rng.nextInt(5);
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
      this.repairStudentHoles();
      this.compactAllStudentSessions();
      if(this.options?.initialSingletonPacking !== false && placedCount === totalActivities){
        this.initialSingletonPacking();
        this.compactAllStudentSessions();
      }
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

    repairStudentHoles(){
      if(this.countTotalStudentHoles() === 0) return true;
      for(let pass = 0; pass < 5; pass++){
        if(this.countTotalStudentHoles() === 0) return true;

        for(let cIdx = 0; cIdx < this.classes.length; cIdx++){
          const cid = String(this.classes[cIdx].id || "");
          if(this.countStudentHoles(cid) === 0) continue;
          const cGrid = this.classGridList[cIdx];
          if(!cGrid) continue;

          for(let d1 = 0; d1 < DAYS_LIST.length; d1++){
            for(let b1 = 0; b1 < SESSIONS_LIST.length; b1++){
              const s1Start = d1 * SLOTS_PER_DAY + b1 * PERIODS_PER_SESSION;
              for(let p1 = 0; p1 < PERIODS_PER_SESSION; p1++){
                const act1Id = cGrid[s1Start + p1];
                if(act1Id < 0) continue;
                const act1 = this.activities[act1Id];
                if(!act1 || act1.isFixed || act1.lockedByLessonBlock) continue;

                for(let s2 = 0; s2 < TOTAL_SLOTS; s2++){
                  const sess2 = Math.floor(s2 / PERIODS_PER_SESSION);
                  const sess1 = Math.floor((s1Start + p1) / PERIODS_PER_SESSION);
                  if(sess2 === sess1) continue;

                  const act2Id = cGrid[s2];
                  if(act2Id < 0) continue;
                  const act2 = this.activities[act2Id];
                  if(!act2 || act2.isFixed || act2.lockedByLessonBlock) continue;
                  if(act1.duration !== act2.duration) continue;

                  const snap = this.captureStateSnapshot();
                  const prevHoles = this.countTotalStudentHoles();
                  this.unplaceActivity(act1.id);
                  this.unplaceActivity(act2.id);

                  if(this.isSlotFeasible(act1, s2) && this.isSlotFeasible(act2, s1Start + p1)){
                    this.placeActivityDirect(act1.id, s2);
                    this.placeActivityDirect(act2.id, s1Start + p1);
                    this.compactAllStudentSessions();

                    if(this.countTotalStudentHoles() < prevHoles){
                      break;
                    }
                  }
                  this.restoreStateSnapshot(snap);
                }
                if(this.countStudentHoles(cid) === 0) break;
              }
              if(this.countStudentHoles(cid) === 0) break;
            }
            if(this.countStudentHoles(cid) === 0) break;
          }
        }
      }
      return this.countTotalStudentHoles() === 0;
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

            const getPermutations = (arr) => {
              if(arr.length <= 1) return [arr];
              const res = [];
              for(let i = 0; i < arr.length; i++){
                const head = arr[i];
                const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
                for(const p of getPermutations(rest)){
                  res.push([head, ...p]);
                }
              }
              return res;
            };

            const dynPerms = (dynActs.length <= 5) ? getPermutations(dynActs) : [dynActs];
            const combos = getCombos(openPeriods, totalDur);
            for(const combo of combos){
              let testMask = 0;
              for(const p of fixedPeriods) testMask |= (1 << p);
              for(const p of combo) testMask |= (1 << p);
              if(SESSION_STATS_LUT[testMask].gaps !== 0) continue;

              for(const perm of dynPerms){
                let curIdx = 0;
                let feasible = true;
                for(const a of perm){
                  if(curIdx >= combo.length || curIdx + a.duration > combo.length){
                    feasible = false; break;
                  }
                  const targetSlot = sStart + combo[curIdx];
                  for(let durOffset = 0; durOffset < a.duration; durOffset++){
                    if(combo[curIdx + durOffset] !== combo[curIdx] + durOffset){
                      feasible = false; break;
                    }
                  }
                  if(!feasible) break;

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
              if(placed) break;
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

    // Sau mot nuoc di, lich lop co the con lo — va cac operator truoc gio LOAI
    // NGAY nuoc di do (`countTotalStudentHoles() === 0`), mac du engine co san
    // bo nen lich hoc sinh se vá dung cai lo vua tao ra.
    //
    // Nen lich chi dich tiet TRONG cung mot buoi cua lop (do tren fixture that:
    // 4 tiet bi doi, 0 tiet sang buoi khac), nghia la so tiet moi buoi cua moi
    // giao vien khong doi -> soBuoiDay1 va tsBuoiDay BAT BIEN qua buoc nen.
    // Vi vay hay thu nen truoc khi loai. Neu nen van khong het lo thi khoi phuc
    // dung trang thai truoc khi nen va tra false nhu cu.
    studentHolesClearedAfterCompaction(){
      if(this.countTotalStudentHoles() === 0) return true;
      const beforeCompaction = this.captureStateSnapshot();
      this.compactAllStudentSessions();
      if(this.countTotalStudentHoles() === 0) return true;
      this.restoreStateSnapshot(beforeCompaction);
      return false;
    }

    // Chung chi san cho tung buoi 1 tiet con sot: giai thich VI SAO no khong go
    // duoc, bang cac phep kiem tra tinh (khong tim kiem), de nguoi dung biet nen
    // noi rang buoc nao thay vi de may hu c mai vao tuong.
    //
    // Ba nhom nguyen nhan do duoc tren du lieu that:
    //  - o co dinh / tiet bi khoa;
    //  - LOP cua tiet le nghi (OFF) o moi buoi khac ma giao vien co the day
    //    -> khong the don tiet le di dau, cung khong the keo ban dong hanh toi;
    //  - moi lop co the CHO tiet deu nghi dung buoi do.
    explainResidualSingletons(limit = 8){
      const rows = [];
      const sessionsPerWeek = DAYS_LIST.length * SESSIONS_LIST.length;

      for(let tIdx = 0; tIdx < this.teachers.length && rows.length < limit; tIdx++){
        const tKey = this.teachers[tIdx];
        if(!tKey || !this.isScoredTeacher(tKey)) continue;
        const tg = this.teacherGridList[tIdx];
        if(!tg) continue;

        const sessions = [];
        for(let s = 0; s < sessionsPerWeek; s++){
          const base = s * PERIODS_PER_SESSION;
          const acts = [];
          let fixedCells = 0;
          for(let p = 0; p < PERIODS_PER_SESSION; p++){
            const cell = tg[base + p];
            if(cell >= 0) acts.push(cell);
            else if(cell === -3) fixedCells++;
          }
          sessions.push({ s, base, acts, fixedCells, k: acts.length + fixedCells });
        }

        for(const sess of sessions){
          if(sess.k !== 1 || rows.length >= limit) continue;

          if(sess.acts.length === 0){
            rows.push({ teacher: tKey, reason: "buổi chỉ có một ô cố định, không thể dời" });
            continue;
          }
          const act = this.activities[sess.acts[0]];
          if(!act){ continue; }
          if(act.isFixed || act.lockedByLessonBlock){
            rows.push({ teacher: tKey, classId: act.classId, reason: "tiết lẻ bị khóa cố định" });
            continue;
          }

          // Buoi le co the bien mat neu tiet le di sang mot buoi giao vien DA day.
          const classGrid = this.classGridList[act.classIdx];
          let landingSlots = 0;
          for(const other of sessions){
            if(other.s === sess.s || other.k === 0) continue;
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const slot = other.base + p;
              if(tg[slot] !== -1) continue;
              const cell = classGrid ? classGrid[slot] : -2;
              if(cell === -2 || cell === -3) continue;
              landingSlots++;
            }
          }

          // Hoac buoi le tro thanh 2 tiet neu mot buoi >= 3 tiet cho sang mot tiet.
          let donorSlots = 0;
          for(const donor of sessions){
            if(donor.s === sess.s || donor.k < 3) continue;
            for(const donorId of donor.acts){
              const donorAct = this.activities[donorId];
              if(!donorAct || donorAct.isFixed || donorAct.lockedByLessonBlock) continue;
              const donorGrid = this.classGridList[donorAct.classIdx];
              for(let p = 0; p < PERIODS_PER_SESSION; p++){
                const slot = sess.base + p;
                if(tg[slot] !== -1) continue;
                const cell = donorGrid ? donorGrid[slot] : -2;
                if(cell === -2 || cell === -3) continue;
                donorSlots++;
              }
            }
          }

          let reason;
          if(landingSlots === 0 && donorSlots === 0){
            reason = `lớp ${act.classId} nghỉ ở mọi buổi khác của giáo viên, và mọi lớp có thể cho tiết đều nghỉ đúng buổi này`;
          }else if(landingSlots === 0){
            reason = `lớp ${act.classId} nghỉ ở mọi buổi khác mà giáo viên còn trống`;
          }else if(donorSlots === 0){
            reason = `không lớp nào có thể cho tiết vào buổi này (đều nghỉ hoặc kín chỗ)`;
          }else{
            reason = "còn đường đi hợp lệ nhưng chưa tìm ra trong ngân sách thời gian";
          }
          rows.push({ teacher: tKey, classId: act.classId, reason });
        }
      }
      return rows;
    }

    compareMetrics(a, b, arg3 = "optimize_all", arg4 = null){
      const mode = typeof arg4 === "string" ? arg4 : (typeof arg3 === "string" ? arg3 : "optimize_all");
      const initial = typeof arg3 === "object" && arg3 !== null ? arg3 : (b || a);

      const aUnplaced = Number(a?.unplacedCount || 0);
      const bUnplaced = Number(b?.unplacedCount || 0);
      if(aUnplaced !== bUnplaced) return aUnplaced - bUnplaced;

      // KHOA 1 TIET/BUOI (ap cho MOI mode).
      // Khi soBuoiDay1 da cham muc tieu (0, hoac san cau truc da chung minh),
      // no tro thanh cong cung: cac pha sau (giam buoi, 2 tiet trong, 1 tiet
      // trong) khong bao gio duoc mua cai tien cua minh bang cach de sinh lai
      // mot buoi giao vien chi day 1 tiet.
      if(this.singletonLock !== null && a.soBuoiDay1 > this.singletonLock) return 1;

      if(mode === "optimize_singletons"){
        // Giai doan bam ve 0: 1 tiet/buoi la muc tieu DOC QUYEN.
        // FET khong chia pha — no de rang buoc 100% chan thang tai cho dat tiet
        // va day cac hoat dong xung dot ra de xep lai. Tuong duong o day: cho
        // phep tang tong buoi day va tiet trong mien la khong vi pham rang buoc
        // cung cua nguoi dung, doi lay toc do ha soBuoiDay1. Cac chi so mem con
        // lai tut xuong vai tro tie-break, khong duoc phep phu quyet mot nuoc
        // di lam giam singleton.
        if(this.singletonRushActive){
          if(a.soBuoiDay1 !== b.soBuoiDay1) return a.soBuoiDay1 - b.soBuoiDay1;
          if(a.soNgayMotTiet !== b.soNgayMotTiet) return a.soNgayMotTiet - b.soNgayMotTiet;
          if(a.soBuoiTrong2 !== b.soBuoiTrong2) return a.soBuoiTrong2 - b.soBuoiTrong2;
          if(a.tsBuoiDay !== b.tsBuoiDay) return a.tsBuoiDay - b.tsBuoiDay;
          return a.soBuoiTrong1 - b.soBuoiTrong1;
        }
        if(!this.options?.allowSingletonGap2Tradeoff && a.soBuoiTrong2 > initial.soBuoiTrong2) return 1;
        if(a.soBuoiDay1 !== b.soBuoiDay1) return a.soBuoiDay1 - b.soBuoiDay1;
        if(a.soNgayMotTiet !== b.soNgayMotTiet) return a.soNgayMotTiet - b.soNgayMotTiet;
        if(a.soBuoiTrong2 !== b.soBuoiTrong2) return a.soBuoiTrong2 - b.soBuoiTrong2;
        if(a.tsBuoiDay !== b.tsBuoiDay) return a.tsBuoiDay - b.tsBuoiDay;
        return a.soBuoiTrong1 - b.soBuoiTrong1;
      }
      if(mode === "optimize_gap2"){
        if(!this.options?.allowGap2SingletonTradeoff && a.soBuoiDay1 > initial.soBuoiDay1) return 1;
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
              if((++evalSteps % 32) === 0 && (Date.now() - lastYieldAt >= 16)){
                await new Promise(resolve => setTimeout(resolve, 0));
                lastYieldAt = Date.now();
              }

              const dst = targetSlots[idx];
              const cid = act.classId;
              const cGrid = this.classGridList[act.classIdx];
              const occId = cGrid[dst];

              if(occId >= 0){
                const occAct = this.activities[occId];
                if(occAct && !occAct.isFixed && !occAct.lockedByLessonBlock){
                  const snap = this.captureStateSnapshot();
                  this.unplaceActivity(actId);
                  this.unplaceActivity(occId);

                  let feasibleMove = false;
                  if(occAct.duration === act.duration && this.isSlotFeasible(act, dst) && this.isSlotFeasible(occAct, singleSlot)){
                    this.placeActivityDirect(actId, dst);
                    this.placeActivityDirect(occAct.id, singleSlot);
                    feasibleMove = true;
                  } else if(this.isSlotFeasible(act, dst)){
                    this.placeActivityDirect(actId, dst);
                    this.nCalls = 0;
                    this.tabuMap.clear();
                    this.triedRemovals.clear();
                    this.swappedInBranch.clear();
                    this.limitCalls = this.getAdaptiveLimitCalls(2000, 3500);
                    feasibleMove = this.randomSwap(occAct.id, 0);
                  }

                  if(feasibleMove && this.studentHolesClearedAfterCompaction()){
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
                  if(this.studentHolesClearedAfterCompaction()){
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

            // Direction 1: cho mot tiet tu buoi nhieu tiet sang buoi le.
            // Buoi cho phai co >= 3 tiet: neu no chi co 2, cho di mot tiet lam
            // chinh no thanh buoi 1 tiet — tong soBuoiDay1 khong doi nen nuoc di
            // luon bi comparator loai. Truoc day nguong la >= 2 nen ca nhanh nay
            // quet vo ich tren moi buoi 2 tiet cua moi giao vien.
            if(rich.items.length >= 3){
              for(const richItem of rich.items){
                const donorAct = this.activities[richItem.actId];
                if(!donorAct || donorAct.isFixed || donorAct.lockedByLessonBlock) continue;
                const cid = donorAct.classId;

                for(let p = 0; p <= PERIODS_PER_SESSION - donorAct.duration; p++){
                  const targetSlot = single.sStart + p;
                  if(targetSlot === single.item.slot) continue;
                  let tBusy = false;
                  for(let d = 0; d < donorAct.duration; d++){
                    if(tg[targetSlot + d] >= 0 || tg[targetSlot + d] === -3){ tBusy = true; break; }
                  }
                  if(tBusy) continue;

                  const cGrid = this.classGridList[donorAct.classIdx];
                  const occId = cGrid[targetSlot];

                  if(occId === -1){
                    const snap = this.captureStateSnapshot();
                    this.unplaceActivity(donorAct.id);
                    if(this.isSlotFeasible(donorAct, targetSlot)){
                      this.placeActivityDirect(donorAct.id, targetSlot);
                      if(this.studentHolesClearedAfterCompaction()){
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
                    if(occAct && !occAct.isFixed && !occAct.lockedByLessonBlock){
                      const snap = this.captureStateSnapshot();
                      this.unplaceActivity(donorAct.id);
                      this.unplaceActivity(occId);

                      let ok = false;
                      if(occAct.duration === donorAct.duration && this.isSlotFeasible(donorAct, targetSlot) && this.isSlotFeasible(occAct, richItem.slot)){
                        this.placeActivityDirect(donorAct.id, targetSlot);
                        this.placeActivityDirect(occAct.id, richItem.slot);
                        ok = true;
                      } else if(this.isSlotFeasible(donorAct, targetSlot)){
                        this.placeActivityDirect(donorAct.id, targetSlot);
                        this.nCalls = 0;
                        this.tabuMap.clear();
                        this.triedRemovals.clear();
                        this.swappedInBranch.clear();
                        this.limitCalls = this.getAdaptiveLimitCalls(2000, 3500);
                        ok = this.randomSwap(occAct.id, 0);
                      }

                      if(ok && this.studentHolesClearedAfterCompaction()){
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
            if(singleAct && !singleAct.isFixed && !singleAct.lockedByLessonBlock && rich.items.length + singleAct.duration <= PERIODS_PER_SESSION){
              const cid = singleAct.classId;
              const cGrid = this.classGridList[singleAct.classIdx];

              for(let p = 0; p <= PERIODS_PER_SESSION - singleAct.duration; p++){
                const targetSlot = rich.sStart + p;
                let tBusy = false;
                for(let d = 0; d < singleAct.duration; d++){
                  if(tg[targetSlot + d] >= 0 || tg[targetSlot + d] === -3){ tBusy = true; break; }
                }
                if(tBusy) continue;

                const occId = cGrid[targetSlot];

                if(occId === -1){
                  const snap = this.captureStateSnapshot();
                  this.unplaceActivity(singleAct.id);
                  if(this.isSlotFeasible(singleAct, targetSlot)){
                    this.placeActivityDirect(singleAct.id, targetSlot);
                    if(this.studentHolesClearedAfterCompaction()){
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
                  if(occAct && !occAct.isFixed && !occAct.lockedByLessonBlock){
                    const snap = this.captureStateSnapshot();
                    this.unplaceActivity(singleAct.id);
                    this.unplaceActivity(occId);

                    let ok = false;
                    if(occAct.duration === singleAct.duration && this.isSlotFeasible(singleAct, targetSlot) && this.isSlotFeasible(occAct, single.item.slot)){
                      this.placeActivityDirect(singleAct.id, targetSlot);
                      this.placeActivityDirect(occAct.id, single.item.slot);
                      ok = true;
                    } else if(this.isSlotFeasible(singleAct, targetSlot)){
                      this.placeActivityDirect(singleAct.id, targetSlot);
                      this.nCalls = 0;
                      this.tabuMap.clear();
                      this.triedRemovals.clear();
                      this.swappedInBranch.clear();
                      this.limitCalls = this.getAdaptiveLimitCalls(2000, 3500);
                      ok = this.randomSwap(occAct.id, 0);
                    }

                    if(ok && this.studentHolesClearedAfterCompaction()){
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
            if(!actOrig || actOrig.isFixed || actOrig.lockedByLessonBlock) continue;

            const cid = actOrig.classId;
            const cGrid = this.classGridList[actOrig.classIdx];
            if(!cGrid) continue;

            for(let sTarget = 0; sTarget < TOTAL_SLOTS; sTarget++){
              if((++evalSteps % 32) === 0 && (Date.now() - lastYieldAt >= 16)){
                await new Promise(resolve => setTimeout(resolve, 0));
                lastYieldAt = Date.now();
              }

              if(sTarget === sOrig) continue;
              const occId = cGrid[sTarget];
              if(occId < 0) continue;
              const occAct = this.activities[occId];
              if(!occAct || occAct.isFixed || occAct.lockedByLessonBlock) continue;

              const snap = this.captureStateSnapshot();
              this.unplaceActivity(actOrig.id);
              this.unplaceActivity(occAct.id);
              let ok = false;
              if(occAct.duration === actOrig.duration && this.isSlotFeasible(actOrig, sTarget) && this.isSlotFeasible(occAct, sOrig)){
                this.placeActivityDirect(actOrig.id, sTarget);
                this.placeActivityDirect(occAct.id, sOrig);
                ok = true;
              } else if(this.isSlotFeasible(actOrig, sTarget)){
                this.placeActivityDirect(actOrig.id, sTarget);
                this.nCalls = 0;
                this.tabuMap.clear();
                this.triedRemovals.clear();
                this.swappedInBranch.clear();
                this.limitCalls = this.getAdaptiveLimitCalls(2000, 3500);
                ok = this.randomSwap(occAct.id, 0);
              }

              if(ok && this.countTotalStudentHoles() > 0){
                this.compactAllStudentSessions();
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
      const singletonClassIdxs = new Set();

      const collectSingletonClasses = () => {
        for(let tIdx = 0; tIdx < this.teacherGridList.length; tIdx++){
          const teacher = this.teachers[tIdx];
          if(!teacher || !this.isScoredTeacher(teacher)) continue;
          const tg = this.teacherGridList[tIdx];
          if(!tg) continue;
          for(let sessIdx = 0; sessIdx < 12; sessIdx++){
            const start = sessIdx * PERIODS_PER_SESSION;
            let count = 0;
            let onlyActId = -1;
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const id = tg[start + p];
              if(id >= 0){ count++; onlyActId = id; }
            }
            if(count === 1 && onlyActId >= 0){
              const act = this.activities[onlyActId];
              if(act && act.classIdx >= 0) singletonClassIdxs.add(act.classIdx);
            }
          }
        }
      };
      collectSingletonClasses();
      if(singletonClassIdxs.size === 0) return null;

      for(let cIdx = 0; cIdx < this.classes.length; cIdx++){
        if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) break;
        const cid = String(this.classes[cIdx].id || "");
        const cGrid = this.classGridList[cIdx];
        if(!cGrid) continue;

        for(let s1 = 0; s1 < TOTAL_SLOTS; s1++){
          const actId1 = cGrid[s1];
          if(actId1 < 0) continue;
          const act1 = this.activities[actId1];
          if(!act1 || act1.isFixed || act1.lockedByLessonBlock) continue;

          for(let s2 = s1 + 1; s2 < TOTAL_SLOTS; s2++){
            if((++evalSteps % 32) === 0){
              if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) break;
              if(Date.now() - lastYieldAt >= 16){
                await new Promise(resolve => setTimeout(resolve, 0));
                lastYieldAt = Date.now();
              }
            }

            const actId2 = cGrid[s2];
            if(actId2 < 0 || actId2 === actId1) continue;
            const act2 = this.activities[actId2];
            if(!act2 || act2.isFixed || act2.lockedByLessonBlock) continue;

            const pairIgnore = new Set([actId1, actId2]);
            if(!this.isSlotFeasible(act1, s2, pairIgnore)) continue;
            const directPair = act2.duration === act1.duration
              && this.isSlotFeasible(act2, s1, pairIgnore);

            const snap = this.captureStateSnapshot();
            this.unplaceActivity(actId1);
            this.unplaceActivity(actId2);
            let ok = false;
            if(directPair){
              this.placeActivityDirect(act1.id, s2);
              this.placeActivityDirect(act2.id, s1);
              ok = true;
            } else if(this.isSlotFeasible(act1, s2)){
              this.placeActivityDirect(act1.id, s2);
              this.nCalls = 0;
              this.tabuMap.clear();
              this.triedRemovals.clear();
              this.swappedInBranch.clear();
              this.limitCalls = this.getAdaptiveLimitCalls(2000, 3500);
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
        if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) break;
        const tIdx = this.teacherIndexMap.get(tKey);
        if(tIdx === undefined) continue;
        const tg = this.teacherGridList[tIdx];
        if(!tg) continue;

        for(let d = 0; d < DAYS_LIST.length; d++){
          for(let b = 0; b < SESSIONS_LIST.length; b++){
            if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) break;
            if((++evalSteps % 32) === 0 && (Date.now() - lastYieldAt >= 16)){
              await new Promise(resolve => setTimeout(resolve, 0));
              lastYieldAt = Date.now();
            }

            const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
            const singleSlots = [];
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const s = sStart + p;
              if(tg[s] >= 0) singleSlots.push(s);
            }
            if(singleSlots.length !== 1) continue;

            const sStartSingleton = singleSlots[0];
            const startAct = this.activities[tg[sStartSingleton]];
            if(!startAct || startAct.isFixed || startAct.lockedByLessonBlock) continue;

            const visitedActs = new Set([startAct.id]);
            const snap = this.captureStateSnapshot();

            const dfsPush = (curAct, curFromSlot, depth) => {
              if(depth > maxDepth || (this.deadlineAtMs && Date.now() >= this.deadlineAtMs)) return false;

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
                      for(let p2 = 0; p2 <= PERIODS_PER_SESSION - curAct.duration; p2++){
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
                if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) return false;
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
                  if(!occAct || occAct.isFixed || occAct.lockedByLessonBlock) continue;
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
                      if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) break;
                      const occTg = this.teacherGridList[occAct.teacherIdxs[t]];
                      if(!occTg) continue;
                      for(let dAbs = 0; dAbs < DAYS_LIST.length; dAbs++){
                        for(let bAbs = 0; bAbs < SESSIONS_LIST.length; bAbs++){
                          if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) break;
                          const sAbsStart = dAbs * SLOTS_PER_DAY + bAbs * PERIODS_PER_SESSION;
                          let hasOccT = false;
                          for(let pAbs = 0; pAbs < PERIODS_PER_SESSION; pAbs++){
                            if(occTg[sAbsStart + pAbs] >= 0 || occTg[sAbsStart + pAbs] === -3){ hasOccT = true; break; }
                          }
                          if(hasOccT){
                            for(let pAbs = 0; pAbs <= PERIODS_PER_SESSION - occAct.duration; pAbs++){
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
                    this.limitCalls = this.getAdaptiveLimitCalls(2000, 3500);
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
                  if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) return false;
                  const sDst = candidateSlots[idx];
                  const occId = curCGrid[sDst];
                  if(occId >= 0 && occId !== curAct.id){
                    const occAct = this.activities[occId];
                    if(!occAct || occAct.isFixed || occAct.lockedByLessonBlock) continue;
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
            if(!act1 || act1.isFixed || act1.lockedByLessonBlock) continue;

            const cGrid = this.classGridList[act1.classIdx];
            if(!cGrid) continue;

            for(let s2 = 0; s2 < TOTAL_SLOTS; s2++){
              if((++evalSteps % 32) === 0 && (Date.now() - lastYieldAt >= 16)){
                await new Promise(resolve => setTimeout(resolve, 0));
                lastYieldAt = Date.now();
              }

              if(Math.floor(s2 / PERIODS_PER_SESSION) === Math.floor(s1 / PERIODS_PER_SESSION)) continue;
              const act2Id = cGrid[s2];
              if(act2Id < 0) continue;
              const act2 = this.activities[act2Id];
              if(!act2 || act2.isFixed || act2.lockedByLessonBlock) continue;

              const snap = this.captureStateSnapshot();
              this.unplaceActivity(act1.id);
              this.unplaceActivity(act2.id);

              let ok = false;
              if(act2.duration === act1.duration && this.isSlotFeasible(act1, s2) && this.isSlotFeasible(act2, s1)){
                this.placeActivityDirect(act1.id, s2);
                this.placeActivityDirect(act2.id, s1);
                ok = true;
              } else if(this.isSlotFeasible(act1, s2)){
                this.placeActivityDirect(act1.id, s2);
                this.nCalls = 0;
                this.tabuMap.clear();
                this.triedRemovals.clear();
                this.swappedInBranch.clear();
                this.limitCalls = this.getAdaptiveLimitCalls(2000, 3500);
                ok = this.randomSwap(act2.id, 0);
              }

              if(ok && this.countTotalStudentHoles() > 0){
                this.compactAllStudentSessions();
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

    async tryPairClassSingletons(bestMetrics, onProgress = null){
      let currentBest = { ...bestMetrics };
      let improved = false;
      let evalSteps = 0;
      let lastYieldAt = Date.now();

      const classIndices = Array.from({ length: this.classes.length }, (_, i) => i);
      this.rng.shuffle(classIndices);

      for(const cIdx of classIndices){
        if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) break;
        const lop = this.classes[cIdx];
        if(!lop) continue;
        const cid = String(lop.id || "");
        const cGrid = this.classGridList[cIdx];
        if(!cGrid) continue;

        // 1. Group placed 1-period activities in this class by subject canon key and teacher
        const singletonsBySubject = new Map();
        for(let s = 0; s < TOTAL_SLOTS; s++){
          const actId = cGrid[s];
          if(actId < 0) continue;
          const act = this.activities[actId];
          if(!act || act.duration !== 1 || act.isFixed || act.lockedByLessonBlock) continue;

          const groupKey = (act.canonKey || this.getCanonMonKey(act.mon)) + "::" + (act.gv || "UNKNOWN");
          if(!singletonsBySubject.has(groupKey)){
            singletonsBySubject.set(groupKey, []);
          }
          singletonsBySubject.get(groupKey).push({ actId, act, slot: s });
        }

        // 2. Identify subject groups with >= 2 singletons on distinct half-day sessions
        for(const [groupKey, items] of singletonsBySubject.entries()){
          if(items.length < 2) continue;

          for(let i = 0; i < items.length; i++){
            for(let j = i + 1; j < items.length; j++){
              const itemA = items[i];
              const itemB = items[j];
              const sessA = Math.floor(itemA.slot / PERIODS_PER_SESSION);
              const sessB = Math.floor(itemB.slot / PERIODS_PER_SESSION);
              if(sessA === sessB) continue; // Already in same session

              const actA = itemA.act;
              const actB = itemB.act;
              const tIndices = actA.teacherIdxs;

              // Check subject max daily / session limits
              const effectiveMaxDaily = (actA.maxDaily !== undefined && actA.maxDaily !== null && actA.maxDaily > 0) ? actA.maxDaily : 2;
              if(effectiveMaxDaily < 2) continue;

              // Target session candidates: sessA or sessB
              const targetSessionStarts = [
                sessA * PERIODS_PER_SESSION,
                sessB * PERIODS_PER_SESSION
              ];

              for(const sTargetStart of targetSessionStarts){
                const isTargetA = (sTargetStart === sessA * PERIODS_PER_SESSION);
                const sDonorSlot = isTargetA ? itemB.slot : itemA.slot;

                // Try candidate consecutive slot pairs (p, p+1) in target session
                for(let p = 0; p <= PERIODS_PER_SESSION - 2; p++){
                  if((++evalSteps % 32) === 0 && (Date.now() - lastYieldAt >= 16)){
                    await new Promise(resolve => setTimeout(resolve, 0));
                    lastYieldAt = Date.now();
                  }

                  const slot1 = sTargetStart + p;
                  const slot2 = sTargetStart + p + 1;

                  // Check Teacher and Class OFF / Fixed constraints at slot1 and slot2
                  let blocked = false;
                  if(cGrid[slot1] === -2 || cGrid[slot1] === -3 || cGrid[slot2] === -2 || cGrid[slot2] === -3){
                    blocked = true;
                  }
                  if(!blocked && tIndices){
                    for(let t = 0; t < tIndices.length; t++){
                      const tg = this.teacherGridList[tIndices[t]];
                      if(tg){
                        const c1 = tg[slot1], c2 = tg[slot2];
                        if(c1 === -2 || c1 === -3 || c2 === -2 || c2 === -3){ blocked = true; break; }
                        // If slot is occupied by another class (not actA and not actB)
                        if(c1 >= 0 && c1 !== actA.id && c1 !== actB.id){ blocked = true; break; }
                        if(c2 >= 0 && c2 !== actA.id && c2 !== actB.id){ blocked = true; break; }
                      }
                    }
                  }
                  if(!blocked && actA.roomIdx >= 0){
                    const rg = this.roomGridList[actA.roomIdx];
                    if(rg){
                      const r1 = rg[slot1], r2 = rg[slot2];
                      if(r1 === -2 || r1 === -3 || r2 === -2 || r2 === -3){ blocked = true; }
                      if(r1 >= 0 && r1 !== actA.id && r1 !== actB.id){ blocked = true; }
                      if(r2 >= 0 && r2 !== actA.id && r2 !== actB.id){ blocked = true; }
                    }
                  }
                  if(blocked) continue;

                  // Capture snapshot
                  const snap = this.captureStateSnapshot();

                  // Unplace actA and actB
                  this.unplaceActivity(actA.id);
                  this.unplaceActivity(actB.id);

                  // Identify occupants at slot1 and slot2
                  const occId1 = cGrid[slot1];
                  const occId2 = cGrid[slot2];
                  const displacedIds = [];

                  if(occId1 >= 0 && occId1 !== actA.id && occId1 !== actB.id){
                    const o1 = this.activities[occId1];
                    if(!o1 || o1.isFixed || o1.lockedByLessonBlock){
                      this.restoreStateSnapshot(snap);
                      continue;
                    }
                    displacedIds.push(occId1);
                  }
                  if(occId2 >= 0 && occId2 !== actA.id && occId2 !== actB.id && occId2 !== occId1){
                    const o2 = this.activities[occId2];
                    if(!o2 || o2.isFixed || o2.lockedByLessonBlock){
                      this.restoreStateSnapshot(snap);
                      continue;
                    }
                    displacedIds.push(occId2);
                  }

                  // Unplace displaced occupants
                  for(const dId of displacedIds){
                    this.unplaceActivity(dId);
                  }

                  // Verify placement feasibility for actA at slot1
                  if(!this.isSlotFeasible(actA, slot1)){
                    this.restoreStateSnapshot(snap);
                    continue;
                  }
                  this.placeActivityDirect(actA.id, slot1);

                  // Verify placement feasibility for actB at slot2
                  if(!this.isSlotFeasible(actB, slot2)){
                    this.restoreStateSnapshot(snap);
                    continue;
                  }
                  this.placeActivityDirect(actB.id, slot2);

                  // Re-place displaced activities with multi-step recursive push chains
                  let allResolved = true;
                  let donorSlotUsed = false;

                  for(let d = 0; d < displacedIds.length; d++){
                    const dId = displacedIds[d];
                    const dAct = this.activities[dId];
                    if(!donorSlotUsed && dAct && dAct.duration === 1 && this.isSlotFeasible(dAct, sDonorSlot)){
                      this.placeActivityDirect(dAct.id, sDonorSlot);
                      donorSlotUsed = true;
                    } else {
                      this.nCalls = 0;
                      this.tabuMap.clear();
                      this.triedRemovals.clear();
                      this.swappedInBranch.clear();
                      this.limitCalls = this.getAdaptiveLimitCalls(2000, 3500);
                      const ok = this.randomSwap(dId, 0);
                      if(!ok){
                        allResolved = false;
                        break;
                      }
                    }
                  }

                  // Evaluate Invariants and Quality
                  if(allResolved){
                    if(this.countTotalStudentHoles() > 0){
                      this.compactAllStudentSessions();
                    }
                    if(this.countTotalStudentHoles() === 0){
                      const m = this.evaluateMetrics();
                      if(this.compareMetrics(m, currentBest, "optimize_singletons") < 0){
                        currentBest = { ...m };
                        improved = true;
                        if(typeof onProgress === "function") onProgress(currentBest);
                        break; // Move accepted for this pair
                      }
                    }
                  }

                  // Rollback if not accepted
                  this.restoreStateSnapshot(snap);
                }
                if(improved) break;
              }
              if(improved) break;
            }
            if(improved) break;
          }
        }
      }
      return improved ? currentBest : false;
    }

    async tryCrossDayPairShift(bestMetrics, onProgress = null){
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

        // Collect single sessions (k = 1) and candidate donor sessions across the 12 sessions
        const singleSessions = [];
        const donorSessions = [];
        for(let d = 0; d < DAYS_LIST.length; d++){
          for(let b = 0; b < SESSIONS_LIST.length; b++){
            const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
            const actsInSess = [];
            let totalPeriods = 0;
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const s = sStart + p;
              const cell = tg[s];
              if(cell >= 0){
                totalPeriods++;
                if(!actsInSess.some(a => a.actId === cell)){
                  const aObj = this.activities[cell];
                  actsInSess.push({ actId: cell, slot: s, pIdx: p, duration: aObj ? aObj.duration : 1 });
                }
              }
            }
            if(totalPeriods === 1 && actsInSess.length === 1){
              singleSessions.push({ sStart, day: d, session: b, item: actsInSess[0] });
            }
            if(totalPeriods >= 1 && actsInSess.length >= 1){
              donorSessions.push({ sStart, day: d, session: b, totalPeriods, acts: actsInSess });
            }
          }
        }

        if(singleSessions.length === 0) continue;

        // Path A: Relocate a 1-period or 2-period activity block from donor session on D2 into D1 session (s1Start)
        for(const single of singleSessions){
          if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) break;
          const d1 = single.day;
          const s1Start = single.sStart;
          const singleAct = this.activities[single.item.actId];
          if(!singleAct) continue;

          for(const donorSess of donorSessions){
            if(donorSess.day === d1) continue; // Cross-day: D2 != D1
            const s2Start = donorSess.sStart;

            for(const donorItem of donorSess.acts){
              const donorAct = this.activities[donorItem.actId];
              if(!donorAct || donorAct.isFixed || donorAct.lockedByLessonBlock) continue;
              const dDur = donorAct.duration;
              if(dDur !== 1 && dDur !== 2) continue;

              const donorCGrid = this.classGridList[donorAct.classIdx];
              if(!donorCGrid) continue;

              // Check subject max daily / session limits in target session
              const effectiveMaxDaily = (donorAct.maxDaily !== undefined && donorAct.maxDaily !== null && donorAct.maxDaily > 0) ? donorAct.maxDaily : 2;
              if(effectiveMaxDaily < dDur) continue;

              for(let p = 0; p <= PERIODS_PER_SESSION - dDur; p++){
                if((++evalSteps % 32) === 0 && (Date.now() - lastYieldAt >= 16)){
                  await new Promise(resolve => setTimeout(resolve, 0));
                  lastYieldAt = Date.now();
                }

                const targetSlot = s1Start + p;

                // Check teacher busy / OFF / Fixed in target slots
                let tBlocked = false;
                for(let offset = 0; offset < dDur; offset++){
                  const sCheck = targetSlot + offset;
                  const tVal = tg[sCheck];
                  if(tVal === -2 || tVal === -3 || (tVal >= 0 && tVal !== donorAct.id)){
                    tBlocked = true;
                    break;
                  }
                }
                if(tBlocked) continue;

                // Check class OFF / Fixed for donorAct's class in target slots
                let cBlocked = false;
                for(let offset = 0; offset < dDur; offset++){
                  const sCheck = targetSlot + offset;
                  const cVal = donorCGrid[sCheck];
                  if(cVal === -2 || cVal === -3){
                    cBlocked = true;
                    break;
                  }
                }
                if(cBlocked) continue;

                // Check room if applicable
                if(donorAct.roomIdx >= 0){
                  const rg = this.roomGridList[donorAct.roomIdx];
                  if(rg){
                    let rBlocked = false;
                    for(let offset = 0; offset < dDur; offset++){
                      const sCheck = targetSlot + offset;
                      const rVal = rg[sCheck];
                      if(rVal === -2 || rVal === -3 || (rVal >= 0 && rVal !== donorAct.id)){
                        rBlocked = true;
                        break;
                      }
                    }
                    if(rBlocked) continue;
                  }
                }

                // Capture snapshot for ACID rollback
                const snap = this.captureStateSnapshot();

                // Unplace donorAct
                this.unplaceActivity(donorAct.id);

                // Identify occupants in donorAct's class at [targetSlot .. targetSlot + dDur - 1]
                const displacedIds = [];
                let unmovableOccupant = false;

                for(let offset = 0; offset < dDur; offset++){
                  const sCheck = targetSlot + offset;
                  const occId = donorCGrid[sCheck];
                  if(occId >= 0 && occId !== donorAct.id){
                    if(!displacedIds.includes(occId)){
                      const occAct = this.activities[occId];
                      if(!occAct || occAct.isFixed || occAct.lockedByLessonBlock){
                        unmovableOccupant = true;
                        break;
                      }
                      displacedIds.push(occId);
                    }
                  }
                }

                if(unmovableOccupant){
                  this.restoreStateSnapshot(snap);
                  continue;
                }

                // Unplace displaced occupants
                for(const dId of displacedIds){
                  this.unplaceActivity(dId);
                }

                // Verify feasibility of placing donorAct at targetSlot
                if(!this.isSlotFeasible(donorAct, targetSlot)){
                  this.restoreStateSnapshot(snap);
                  continue;
                }

                // Place donorAct at targetSlot
                this.placeActivityDirect(donorAct.id, targetSlot);

                // Resolve displaced occupants
                let allResolved = true;
                let donorSlotUsed = false;

                for(let d = 0; d < displacedIds.length; d++){
                  const dId = displacedIds[d];
                  const dAct = this.activities[dId];
                  if(!donorSlotUsed && dAct && dAct.duration === dDur && this.isSlotFeasible(dAct, donorItem.slot)){
                    this.placeActivityDirect(dAct.id, donorItem.slot);
                    donorSlotUsed = true;
                  } else {
                    this.nCalls = 0;
                    this.tabuMap.clear();
                    this.triedRemovals.clear();
                    this.swappedInBranch.clear();
                    this.limitCalls = this.getAdaptiveLimitCalls(2000, 3500);
                    const ok = this.randomSwap(dId, 0);
                    if(!ok){
                      allResolved = false;
                      break;
                    }
                  }
                }

                if(allResolved){
                  if(this.countTotalStudentHoles() > 0){
                    this.compactAllStudentSessions();
                  }
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

                // Transactional rollback on failure
                this.restoreStateSnapshot(snap);
              }
              if(improved) break;
            }
            if(improved) break;
          }
          if(improved) break;
        }

        if(improved) continue;

        // Path B: Shift singleAct (duration 1) from Day D1 into donor session on D2
        for(const single of singleSessions){
          if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) break;
          const d1 = single.day;
          const singleAct = this.activities[single.item.actId];
          if(!singleAct || singleAct.isFixed || singleAct.lockedByLessonBlock) continue;
          const singleCGrid = this.classGridList[singleAct.classIdx];
          if(!singleCGrid) continue;

          for(const donorSess of donorSessions){
            if(donorSess.day === d1) continue; // Cross-day: D2 != D1
            const s2Start = donorSess.sStart;

            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              if((++evalSteps % 32) === 0 && (Date.now() - lastYieldAt >= 16)){
                await new Promise(resolve => setTimeout(resolve, 0));
                lastYieldAt = Date.now();
              }

              const targetSlot = s2Start + p;

              // Check teacher
              const tVal = tg[targetSlot];
              if(tVal === -2 || tVal === -3 || (tVal >= 0 && tVal !== singleAct.id)) continue;

              // Check class
              const cVal = singleCGrid[targetSlot];
              if(cVal === -2 || cVal === -3) continue;

              // Check room
              if(singleAct.roomIdx >= 0){
                const rg = this.roomGridList[singleAct.roomIdx];
                if(rg){
                  const rVal = rg[targetSlot];
                  if(rVal === -2 || rVal === -3 || (rVal >= 0 && rVal !== singleAct.id)) continue;
                }
              }

              const snap = this.captureStateSnapshot();
              this.unplaceActivity(singleAct.id);

              const occId = singleCGrid[targetSlot];
              let occAct = null;
              if(occId >= 0 && occId !== singleAct.id){
                occAct = this.activities[occId];
                if(!occAct || occAct.isFixed || occAct.lockedByLessonBlock){
                  this.restoreStateSnapshot(snap);
                  continue;
                }
                this.unplaceActivity(occId);
              }

              if(!this.isSlotFeasible(singleAct, targetSlot)){
                this.restoreStateSnapshot(snap);
                continue;
              }

              this.placeActivityDirect(singleAct.id, targetSlot);

              let allResolved = true;
              if(occAct){
                if(occAct.duration === 1 && this.isSlotFeasible(occAct, single.item.slot)){
                  this.placeActivityDirect(occAct.id, single.item.slot);
                } else {
                  this.nCalls = 0;
                  this.tabuMap.clear();
                  this.triedRemovals.clear();
                  this.swappedInBranch.clear();
                  this.limitCalls = this.getAdaptiveLimitCalls(2000, 3500);
                  allResolved = this.randomSwap(occAct.id, 0);
                }
              }

              if(allResolved){
                if(this.countTotalStudentHoles() > 0){
                  this.compactAllStudentSessions();
                }
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
            if(improved) break;
          }
          if(improved) break;
        }
      }
      return improved ? currentBest : false;
    }

    async tryClosedAugmentingChain(rootAct, rootTarget, rootSource, bestMetrics, onProgress = null){
      if(!rootAct || rootAct.isFixed || rootAct.lockedByLessonBlock || rootAct.duration !== 1) return null;
      const cGrid = this.classGridList[rootAct.classIdx];
      if(!cGrid || rootTarget === rootSource) return null;
      const rootOcc = cGrid[rootTarget];
      if(rootOcc < 0) return null;
      const rootOther = this.activities[rootOcc];
      if(!rootOther || rootOther.isFixed || rootOther.lockedByLessonBlock || rootOther.duration !== 1) return null;

      const queue = [{ id: rootOther, acts: [rootAct.id, rootOther], destinations: [rootTarget] }];
      const seen = new Set([rootAct.id, rootOther]);
      let expansions = 0;
      while(queue.length && expansions++ < 6000){
        if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) break;
        const node = queue.shift();
        const current = this.activities[node.id];
        const allowed = this.allowedSlotsByActivity?.get(current) || [];
        if(allowed.includes(rootSource)){
          const snap = this.captureStateSnapshot();
          for(const id of node.acts) this.unplaceActivity(id);
          let ok = true;
          for(let i = 0; i < node.acts.length; i++){
            const moving = this.activities[node.acts[i]];
            if(!this.isSlotFeasible(moving, i === node.acts.length - 1 ? rootSource : node.destinations[i])){ ok = false; break; }
            this.placeActivityDirect(moving.id, i === node.acts.length - 1 ? rootSource : node.destinations[i]);
          }
          if(ok && this.countTotalStudentHoles() > 0) this.compactAllStudentSessions();
          if(ok && this.countTotalStudentHoles() === 0){
            const metrics = this.evaluateMetrics();
            if(this.compareMetrics(metrics, bestMetrics, "optimize_singletons") < 0){
              if(typeof onProgress === "function") onProgress(metrics);
              return metrics;
            }
          }
          this.restoreStateSnapshot(snap);
        }
        for(const nextSlot of allowed){
          if(nextSlot === rootSource || nextSlot === rootTarget) continue;
          const nextId = cGrid[nextSlot];
          const next = this.activities[nextId];
          if(!next || seen.has(nextId) || next.isFixed || next.lockedByLessonBlock || next.duration !== 1) continue;
          seen.add(nextId);
          queue.push({ id: nextId, acts: node.acts.concat(nextId), destinations: node.destinations.concat(nextSlot) });
        }
      }
      return null;
    }

    async tryTargetedIntraClassSingletonCrusher(bestMetrics, onProgress = null){
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
        const targetSessions = [];
        for(let d = 0; d < DAYS_LIST.length; d++){
          for(let b = 0; b < SESSIONS_LIST.length; b++){
            const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
            const acts = [];
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const s = sStart + p;
              if(tg[s] >= 0) acts.push({ actId: tg[s], slot: s, pIdx: p });
            }
            if(acts.length === 1){
              singleSessions.push({ sStart, item: acts[0], d, b });
              targetSessions.push({ sStart, k: 1, acts, d, b });
            } else if(acts.length >= 2 && acts.length <= 4){
              targetSessions.push({ sStart, k: acts.length, acts, d, b });
            }
          }
        }
        if(singleSessions.length === 0 || targetSessions.length === 0) continue;

        for(const single of singleSessions){
          const singleAct = this.activities[single.item.actId];
          if(!singleAct || singleAct.isFixed || singleAct.lockedByLessonBlock) continue;
          const cGrid = this.classGridList[singleAct.classIdx];
          if(!cGrid) continue;

          const s1 = single.item.slot;
          const dA = singleAct.duration;

          // Search a complete augmenting chain before the cheaper one/two-step
          // operators. The final moved activity must occupy s1, so the chain
          // is a permutation and cannot leave an unassigned lesson behind.
          for(const targetSess of targetSessions){
            if(targetSess.sStart === single.sStart) continue;
            for(let p = 0; p <= PERIODS_PER_SESSION - dA; p++){
              const s2 = targetSess.sStart + p;
              if(s2 === s1 || tg[s2] >= 0 || tg[s2] === -2 || tg[s2] === -3) continue;
              if(!this.isSlotFeasible(singleAct, s2, new Set([singleAct.id, cGrid[s2]]))) continue;
              const chainMetrics = await this.tryClosedAugmentingChain(singleAct, s2, s1, currentBest, onProgress);
              if(chainMetrics){ currentBest = chainMetrics; improved = true; break; }
            }
            if(improved) break;
          }
          if(improved) break;

          for(const targetSess of targetSessions){
            if(targetSess.sStart === single.sStart) continue;
            const s2Start = targetSess.sStart;

            for(let p = 0; p <= PERIODS_PER_SESSION - dA; p++){
              if((++evalSteps % 32) === 0 && Date.now() - lastYieldAt >= 16){
                await new Promise(resolve => setTimeout(resolve, 0));
                lastYieldAt = Date.now();
              }

              const s2 = s2Start + p;
              if(s2 === s1) continue;

              let tBusy = false;
              for(let d = 0; d < dA; d++){
                const cell = tg[s2 + d];
                if(cell >= 0 || cell === -2 || cell === -3){ tBusy = true; break; }
              }
              if(tBusy) continue;

              const occId = cGrid[s2];
              if(occId === -2 || occId === -3) continue;

              const snap = this.captureStateSnapshot();
              this.unplaceActivity(singleAct.id);

              let ok = false;
              if(occId === -1){
                if(this.isSlotFeasible(singleAct, s2)){
                  this.placeActivityDirect(singleAct.id, s2);
                  ok = true;
                }
              } else if(occId >= 0 && occId !== singleAct.id){
                const occAct = this.activities[occId];
                if(occAct && !occAct.isFixed && !occAct.lockedByLessonBlock){
                  this.unplaceActivity(occAct.id);
                  const dB = occAct.duration;

                  if(dA === dB && this.isSlotFeasible(singleAct, s2) && this.isSlotFeasible(occAct, s1)){
                    this.placeActivityDirect(singleAct.id, s2);
                    this.placeActivityDirect(occAct.id, s1);
                    ok = true;
                  } else if(this.isSlotFeasible(singleAct, s2)){
                    this.placeActivityDirect(singleAct.id, s2);
                    this.nCalls = 0;
                    this.tabuMap.clear();
                    this.triedRemovals.clear();
                    this.swappedInBranch.clear();
                    this.limitCalls = this.getAdaptiveLimitCalls(2000, 3500);
                    ok = this.randomSwap(occAct.id, 0);
                  }
                }
              }

              if(ok && this.countTotalStudentHoles() > 0){
                this.compactAllStudentSessions();
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
            if(improved) break;
          }
          if(improved) break;
        }
      }
      return improved ? currentBest : null;
    }

    // Session-bin augmenting chains.  At this stage the problem is viewed as
    // twelve horizontal rows of five cells: first choose a donor from a row
    // with at least three teacher periods and put it into a singleton row;
    // then resolve every class/teacher/room occupant recursively.  A logical
    // lesson block is moved as one unit, so the chain never leaves an activity
    // unplaced and never splits an existing minimum block.
    async trySessionBinAugmentingChains(bestMetrics, onProgress = null){
      let currentBest = { ...bestMetrics };
      let improved = false;
      let nodes = 0;
      const deepSessionBinSearch = Boolean(this.options?.deepLocalFet || this.options?.deepCycles);
      const reformLessonBlocks = Boolean(this.options?.reformLessonBlocks && deepSessionBinSearch);
      const maxNodesPerChain = deepSessionBinSearch ? 100000 : 7000;
      const maxDepth = deepSessionBinSearch ? 24 : 10;
      const unitCache = new Map();
      const gap2Ceiling = Number(bestMetrics?.soBuoiTrong2 || 0) + (deepSessionBinSearch ? 6 : 2);
      const acceptedSingletonSignatures = new Set();
      let protectedIds = new Set();

      const unitDuration = (unit) => unit.ids.reduce((sum, id) => sum + (this.activities[id]?.duration || 1), 0);

      const getUnit = (actId) => {
        if(unitCache.has(actId)) return unitCache.get(actId);
        const act = this.activities[actId];
        if(!act) return null;
        let ids = [act.id];
        if(!reformLessonBlocks && act.lockedByLessonBlock && act.duration === 1){
          const siblings = this.activities.filter(other =>
            other.lockedByLessonBlock && other.duration === 1 &&
            other.classId === act.classId && other.mon === act.mon &&
            other.gvList.join("|") === act.gvList.join("|")
          );
          const positions = new Map(siblings.map(other => [this.actPlacement[other.id], other]));
          const run = [act];
          let left = this.actPlacement[act.id] - 1;
          while(positions.has(left)){ run.unshift(positions.get(left)); left--; }
          let right = this.actPlacement[act.id] + 1;
          while(positions.has(right)){ run.push(positions.get(right)); right++; }
          if(run.length >= 2) ids = run.map(item => item.id);
        }
        ids.sort((a, b) => (this.actPlacement[a] - this.actPlacement[b]) || (a - b));
        const unit = { ids, originalStart: this.actPlacement[ids[0]] };
        for(const id of ids) unitCache.set(id, unit);
        return unit;
      };

      const canMoveUnit = (unit) => unit && unit.ids.every(id => {
        const act = this.activities[id];
        return act && (!act.isFixed || act.lockedByLessonBlock);
      });

      const unplaceUnit = (unit) => {
        if(!unit) return;
        for(const id of unit.ids){
          const act = this.activities[id];
          const slot = this.actPlacement[id];
          if(!act || slot < 0) continue;
          this.actPlacement[id] = -1;
          for(let d = 0; d < act.duration; d++){
            const s = slot + d;
            const cGrid = this.classGridList[act.classIdx];
            if(cGrid && cGrid[s] === id) cGrid[s] = -1;
            for(const tIdx of act.teacherIdxs || []){
              const tg = this.teacherGridList[tIdx];
              if(tg && tg[s] === id) tg[s] = -1;
            }
            if(act.roomIdx >= 0){
              const rg = this.roomGridList[act.roomIdx];
              if(rg && rg[s] === id) rg[s] = -1;
            }
          }
          if(this.teacherSessionCounts){
            const session = Math.floor(slot / PERIODS_PER_SESSION);
            for(const tIdx of act.teacherIdxs || []){
              this.teacherSessionCounts[tIdx * 12 + session] -= act.duration;
            }
          }
        }
      };

      const unitStarts = (unit) => {
        const first = this.activities[unit.ids[0]];
        const allowed = this.allowedSlotsByActivity?.get(first) || [];
        const length = unitDuration(unit);
        const starts = [];
        for(const start of allowed){
          if(start % PERIODS_PER_SESSION + length > PERIODS_PER_SESSION) continue;
          let offset = 0;
          let okay = true;
          for(const id of unit.ids){
            const member = this.activities[id];
            const memberAllowed = this.allowedSlotsByActivity?.get(member) || [];
            if(!memberAllowed.includes(start + offset)){
              okay = false;
              break;
            }
            offset += member.duration;
          }
          if(okay) starts.push(start);
        }
        if(deepSessionBinSearch) this.rng.shuffle(starts);
        return starts;
      };

      const collectOccupantUnits = (act, start, unplacedIds) => {
        const units = new Map();
        let blocked = false;
        const addCell = (cell) => {
          if(cell === -2 || cell === -3){
            blocked = true;
            return;
          }
          if(protectedIds.has(cell)){
            blocked = true;
            return;
          }
          if(cell < 0 || unplacedIds.has(cell)) return;
          const unit = getUnit(cell);
          if(!unit) return;
          if(unit.ids.every(id => unplacedIds.has(id))) return;
          units.set(unit.ids[0], unit);
        };
        for(let d = 0; d < act.duration; d++){
          const s = start + d;
          const cGrid = this.classGridList[act.classIdx];
          addCell(cGrid ? cGrid[s] : -2);
          for(const tIdx of act.teacherIdxs || []){
            const tg = this.teacherGridList[tIdx];
            addCell(tg ? tg[s] : -2);
          }
          if(act.roomIdx >= 0){
            const rg = this.roomGridList[act.roomIdx];
            addCell(rg ? rg[s] : -2);
          }
        }
        return { units: [...units.values()], blocked };
      };

      const findSingletonRows = () => {
        const rows = [];
        for(let tIdx = 0; tIdx < this.teachers.length; tIdx++){
          const teacher = this.teachers[tIdx];
          const tg = this.teacherGridList[tIdx];
          if(!this.isScoredTeacher(teacher) || !tg) continue;
          for(let session = 0; session < DAYS_LIST.length * SESSIONS_LIST.length; session++){
            let load = 0;
            let id = -1;
            let slot = -1;
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const cell = tg[session * PERIODS_PER_SESSION + p];
              if(cell >= 0 || cell === -3) load++;
              if(cell >= 0){ id = cell; slot = session * PERIODS_PER_SESSION + p; }
            }
            if(load === 1 && id >= 0){
              rows.push({ teacherIdx: tIdx, teacher, session, bin: sessionIndexToBin(session), id, slot });
            }
          }
        }
        return rows;
      };

      const getSessionLoad = (tg, session) => {
        let load = 0;
        for(let p = 0; p < PERIODS_PER_SESSION; p++){
          const cell = tg[session * PERIODS_PER_SESSION + p];
          if(cell >= 0 || cell === -3) load++;
        }
        return load;
      };

      const countTeacherSingletons = (tIdx) => {
        const tg = this.teacherGridList[tIdx];
        if(!tg) return 0;
        let count = 0;
        for(let session = 0; session < DAYS_LIST.length * SESSIONS_LIST.length; session++){
          let load = 0;
          for(let p = 0; p < PERIODS_PER_SESSION; p++){
            const cell = tg[session * PERIODS_PER_SESSION + p];
            if(cell >= 0 || cell === -3) load++;
          }
          if(load === 1) count++;
        }
        return count;
      };

      const singletonSignature = () => {
        const rows = [];
        for(let tIdx = 0; tIdx < this.teachers.length; tIdx++){
          const tg = this.teacherGridList[tIdx];
          if(!tg || !this.isScoredTeacher(this.teachers[tIdx])) continue;
          for(let session = 0; session < DAYS_LIST.length * SESSIONS_LIST.length; session++){
            let load = 0;
            let id = -1;
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const cell = tg[session * PERIODS_PER_SESSION + p];
              if(cell >= 0 || cell === -3) load++;
              if(cell >= 0) id = cell;
            }
            if(load === 1) rows.push(`${tIdx}@${session}@${id}`);
          }
        }
        return rows.sort().join(",");
      };

      const lessonBlocksRemainValid = () => {
        const groups = new Map();
        const addPeriod = (classId, mon, session) => {
          const key = `${classId}|${this.getCanonMonKey(mon)}`;
          if(!groups.has(key)) groups.set(key, { classId, mon, counts: new Int16Array(12) });
          groups.get(key).counts[session]++;
        };
        for(const act of this.activities){
          const slot = this.actPlacement[act.id];
          if(slot < 0) continue;
          for(let d = 0; d < act.duration; d++) addPeriod(act.classId, act.mon, Math.floor((slot + d) / PERIODS_PER_SESSION));
        }
        for(const [key, fix] of this.fixedSlots.entries()){
          const sep = key.lastIndexOf("|");
          if(sep < 0 || !fix?.mon) continue;
          addPeriod(key.slice(0, sep), fix.mon, Math.floor(Number(key.slice(sep + 1)) / PERIODS_PER_SESSION));
        }
        for(const group of groups.values()){
          const lop = this.classes.find(item => String(item.id || "") === String(group.classId));
          const rules = this.getSubjectRules(group.mon, lop)?.lessonBlocks || {};
          for(const K of [5, 4, 3, 2]){
            const config = rules[String(K)] || rules[K] || {};
            const min = Number(config.min) || 0;
            if(min <= 0) continue;
            let blocks = 0;
            for(const count of group.counts) if(count === K) blocks++;
            if(blocks < min) return false;
          }
        }
        return true;
      };

      const placeChain = async (unit, start, unplacedIds, depth, acceptComplete = null, restrictedSession = null) => {
        if(++nodes > maxNodesPerChain || depth > maxDepth) return false;
        if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) return false;
        if((nodes & 255) === 0) await new Promise(resolve => setTimeout(resolve, 0));

        const occupants = collectOccupantUnits(this.activities[unit.ids[0]], start, unplacedIds);
        if(occupants.blocked) return false;
        if(occupants.units.some(other => !canMoveUnit(other))) return false;

        const branch = this.captureStateSnapshot();
        const nextUnplaced = new Set(unplacedIds);
        for(const other of occupants.units){
          unplaceUnit(other);
          for(const id of other.ids) nextUnplaced.add(id);
        }

        const ignore = new Set(nextUnplaced);
        for(const id of unit.ids) ignore.add(id);
        let offset = 0;
        let okay = true;
        for(const id of unit.ids){
          const act = this.activities[id];
          if(!this.isSlotFeasible(act, start + offset, ignore)){
            okay = false;
            break;
          }
          offset += act.duration;
        }
        if(!okay){
          this.restoreStateSnapshot(branch);
          return false;
        }

        offset = 0;
        for(const id of unit.ids){
          if(!this.placeActivityDirect(id, start + offset)){
            this.restoreStateSnapshot(branch);
            return false;
          }
          offset += this.activities[id].duration;
        }
        for(const id of unit.ids) nextUnplaced.delete(id);
        if(occupants.units.length === 0){
          if(nextUnplaced.size === 0 && typeof acceptComplete === "function") return Boolean(acceptComplete());
          return true;
        }

        const ordered = occupants.units.slice().sort((a, b) => unitStarts(a).length - unitStarts(b).length);
        for(const other of ordered){
          let resolved = false;
          const starts = unitStarts(other).filter(nextStart =>
            restrictedSession === null || Math.floor(nextStart / PERIODS_PER_SESSION) === restrictedSession
          );
          starts.sort((a, b) => {
            const da = Math.abs(a - (other.originalStart >= 0 ? other.originalStart : a));
            const db = Math.abs(b - (other.originalStart >= 0 ? other.originalStart : b));
            return da - db;
          });
          for(const nextStart of starts){
            if(nextStart === start) continue;
            const branchBeforeOther = this.captureStateSnapshot();
            if(await placeChain(other, nextStart, nextUnplaced, depth + 1, acceptComplete, restrictedSession)){
              resolved = true;
              for(const pendingId of [...nextUnplaced]){
                if(this.actPlacement[pendingId] >= 0) nextUnplaced.delete(pendingId);
              }
              break;
            }
            this.restoreStateSnapshot(branchBeforeOther);
            if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) break;
          }
          if(!resolved){
            this.restoreStateSnapshot(branch);
            return false;
          }
        }
        if(nextUnplaced.size === 0 && typeof acceptComplete === "function") return Boolean(acceptComplete());
        return true;
      };

      const maxRounds = deepSessionBinSearch ? 20 : 5;
      for(let round = 0; round < maxRounds && currentBest.soBuoiDay1 > 0; round++){
        if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) break;
        let roundImproved = false;
        const singletonRows = findSingletonRows();
        if(deepSessionBinSearch) this.rng.shuffle(singletonRows);
        for(const row of singletonRows){
          if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) break;
          const singleton = this.activities[row.id];
          if(!singleton || !canMoveUnit(getUnit(singleton.id))) continue;
          const tg = this.teacherGridList[row.teacherIdx];
          const donorUnits = new Map();
          for(const act of this.activities){
            if(!act.teacherIdxs.includes(row.teacherIdx) || this.actPlacement[act.id] < 0) continue;
            const unit = getUnit(act.id);
            if(!canMoveUnit(unit) || donorUnits.has(unit.ids[0])) continue;
            const source = Math.floor(unit.originalStart / PERIODS_PER_SESSION);
            if(source === row.session) continue;
            const sourceLoad = getSessionLoad(tg, source);
            if(sourceLoad - unitDuration(unit) < 2) continue;
            donorUnits.set(unit.ids[0], unit);
          }

          const donors = [...donorUnits.values()];
          if(deepSessionBinSearch) this.rng.shuffle(donors);
          donors.sort((a, b) => unitDuration(b) - unitDuration(a));
          for(const donor of donors){
            if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) break;
            const donorStart = donor.originalStart;
            if(donor.ids.includes(row.id)) continue;
            const targetPeriods = [0, 1, 2, 3, 4];
            if(deepSessionBinSearch) this.rng.shuffle(targetPeriods);
            for(const p of targetPeriods){
              const target = row.session * PERIODS_PER_SESSION + p;
              if(target === row.slot || tg[target] !== -1) continue;
              const snapshot = this.captureStateSnapshot();
              const previousStudentGuard = this.suspendStudentHoleGuard;
              const previousTeacherGaps = this.strictTeacherGaps;
              const previousFetGaps = this.strictFetGaps;
              const beforeSignature = singletonSignature();
              this.suspendStudentHoleGuard = true;
              this.strictTeacherGaps = false;
              this.strictFetGaps = false;
              unplaceUnit(donor);
              protectedIds = new Set(donor.ids);
              nodes = 0;
              const focalBefore = countTeacherSingletons(row.teacherIdx);
              const ok = await placeChain(donor, target, new Set(donor.ids), 0);
              this.suspendStudentHoleGuard = previousStudentGuard;
              this.strictTeacherGaps = previousTeacherGaps;
              this.strictFetGaps = previousFetGaps;

              if(ok && this.countTotalStudentHoles() > 0) this.compactAllStudentSessions();
              const metrics = this.evaluateMetrics();
              const focalImproved = countTeacherSingletons(row.teacherIdx) < focalBefore;
              const strictGlobalImprovement = metrics.soBuoiDay1 < currentBest.soBuoiDay1;
              const nonWorseningGlobal = metrics.soBuoiDay1 <= currentBest.soBuoiDay1;
              const afterSignature = singletonSignature();
              const signatureChanged = afterSignature !== beforeSignature && !acceptedSingletonSignatures.has(afterSignature);
              const gap2Allowed = metrics.soBuoiTrong2 === 0 ||
                (this.options?.allowSingletonGap2Tradeoff && metrics.soBuoiTrong2 <= gap2Ceiling);
              const lessonBlocksOk = !reformLessonBlocks || lessonBlocksRemainValid();
              if(ok && metrics.unplacedCount === 0 && gap2Allowed && lessonBlocksOk && this.countTotalStudentHoles() === 0 &&
                 nonWorseningGlobal && (strictGlobalImprovement || focalImproved || signatureChanged) &&
                 (strictGlobalImprovement ? this.compareMetrics(metrics, currentBest, "optimize_singletons") < 0 : true)){
                currentBest = { ...metrics };
                acceptedSingletonSignatures.add(afterSignature);
                improved = true;
                roundImproved = true;
                if(typeof onProgress === "function") onProgress(currentBest);
                break;
              }
              this.restoreStateSnapshot(snapshot);
              protectedIds = new Set();
            }
            if(roundImproved) break;
          }
          if(roundImproved) break;
        }
        if(!roundImproved) break;
      }

      // Once the singleton rows have been merged, the same chain machinery is
      // reused to close the long holes that the merge may have created.  This
      // is deliberately a second objective pass: every accepted move keeps
      // singleton count at zero and strictly reduces total gap-2 rows.
      // A donor is protected only for the singleton transaction that placed
      // it.  Leaving that transaction's protection set alive would make a
      // perfectly movable occupant look like a fixed blocker in this later
      // gap phase, silently preventing the vacancy from travelling onward.
      protectedIds = new Set();
      if(deepSessionBinSearch && currentBest.soBuoiDay1 === 0 && currentBest.soBuoiTrong2 > 0){
        const findGapRows = () => {
          const rows = [];
          for(let tIdx = 0; tIdx < this.teachers.length; tIdx++){
            const teacher = this.teachers[tIdx];
            const tg = this.teacherGridList[tIdx];
            if(!this.isScoredTeacher(teacher) || !tg) continue;
            for(let session = 0; session < 12; session++){
              const periods = [];
              for(let p = 0; p < PERIODS_PER_SESSION; p++){
                const cell = tg[session * PERIODS_PER_SESSION + p];
                if(cell >= 0 || cell === -3) periods.push(p);
              }
              if(periods.length < 2) continue;
              const gap = periods.at(-1) - periods[0] + 1 - periods.length;
              if(gap >= 2) rows.push({ teacherIdx: tIdx, teacher, session, periods, gap });
            }
          }
          return rows;
        };

        // A gap repair is often not a two-cell swap.  Moving the teacher's
        // period into the hole can displace a class activity whose original
        // slot is not legal for it.  In that case let the normal FET ejection
        // search carry the displaced activity to a free slot (and possibly
        // eject another activity).  This is the bounded augmenting-path form
        // of the 12-bin model: the root stays in the teacher's row, while the
        // vacancy travels through class/teacher/room edges until it closes.
        const tryGapEjection = async (rootUnit, targetSlot, retry = 0, baselineMetrics = currentBest) => {
          const snapshot = this.captureStateSnapshot();
          const previousRng = this.rng;
          const deterministicSeed = ((rootUnit.ids[0] + 1) * 2654435761 +
            (targetSlot + 1) * 2246822519 + (retry + 1) * 3266489917) >>> 0;
          // Ejection is a local transaction.  Give each retry an independent
          // reproducible trajectory and restore the outer search stream after
          // it, so unrelated bins do not change merely because one retry
          // failed.
          this.rng = new FetPRNG(deterministicSeed);
          const previousStudentGuard = this.suspendStudentHoleGuard;
          const previousTeacherGaps = this.strictTeacherGaps;
          const previousFetGaps = this.strictFetGaps;
          let ok = false;
          this.suspendStudentHoleGuard = true;
          this.strictTeacherGaps = false;
          this.strictFetGaps = false;
          try {
            const rootIds = new Set(rootUnit.ids);
            unplaceUnit(rootUnit);
            const occupants = collectOccupantUnits(this.activities[rootUnit.ids[0]], targetSlot, rootIds);
            if(occupants.blocked || occupants.units.some(unit =>
              !canMoveUnit(unit) || unit.ids.length !== 1 || this.activities[unit.ids[0]]?.duration !== 1
            )){
              this.restoreStateSnapshot(snapshot);
              return { ok: false };
            }

            const displacedIds = occupants.units.flatMap(unit => unit.ids);
            for(const unit of occupants.units) unplaceUnit(unit);

            const ignore = new Set([...rootIds, ...displacedIds]);
            let offset = 0;
            for(const id of rootUnit.ids){
              const act = this.activities[id];
              if(!this.isSlotFeasible(act, targetSlot + offset, ignore)){
                this.restoreStateSnapshot(snapshot);
                return { ok: false };
              }
              offset += act.duration;
            }
            offset = 0;
            for(const id of rootUnit.ids){
              if(!this.placeActivityDirect(id, targetSlot + offset)){
                this.restoreStateSnapshot(snapshot);
                return { ok: false };
              }
              offset += this.activities[id].duration;
            }

            const directState = this.captureStateSnapshot();
            const directMetricsOkay = () => {
              if(this.countTotalStudentHoles() > 0) this.compactAllStudentSessions();
              const metrics = this.evaluateMetrics();
              return metrics.unplacedCount === 0 && metrics.soBuoiDay1 === 0 &&
                metrics.soBuoiTrong2 < Number(baselineMetrics?.soBuoiTrong2 ?? 0) &&
                (!reformLessonBlocks || lessonBlocksRemainValid()) &&
                this.countTotalStudentHoles() === 0;
            };
            const resolveToFreeSlots = (index) => {
              if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) return false;
              if(index >= displacedIds.length) return directMetricsOkay();
              const id = displacedIds[index];
              const act = this.activities[id];
              if(!act) return false;
              const originalSession = Math.floor((this.actPlacement[id] >= 0 ? this.actPlacement[id] : targetSlot) / PERIODS_PER_SESSION);
              const candidates = (this.allowedSlotsByActivity?.get(act) || []).filter(start => {
                if(start === targetSlot) return false;
                for(let d = 0; d < act.duration; d++){
                  const s = start + d;
                  if(this.classGridList[act.classIdx]?.[s] >= 0) return false;
                  for(const tIdx of act.teacherIdxs || []) if(this.teacherGridList[tIdx]?.[s] >= 0) return false;
                  if(act.roomIdx >= 0 && this.roomGridList[act.roomIdx]?.[s] >= 0) return false;
                }
                return true;
              });
              candidates.sort((a, b) => {
                const sa = Math.abs(Math.floor(a / PERIODS_PER_SESSION) - originalSession);
                const sb = Math.abs(Math.floor(b / PERIODS_PER_SESSION) - originalSession);
                return (sa - sb) || (this.slotTeacherAffinityScore(act, a) - this.slotTeacherAffinityScore(act, b));
              });
              const bounded = candidates.slice(0, 96);
              for(const start of bounded){
                const branch = this.captureStateSnapshot();
                if(this.isSlotFeasible(act, start) && this.placeActivityDirect(id, start) && resolveToFreeSlots(index + 1)) return true;
                this.restoreStateSnapshot(branch);
              }
              return false;
            };

            // First enumerate genuinely free legal cells.  This is cheap for
            // the usual one-occupant case and removes the random choice from
            // the critical final edge of the augmenting path.
            if(resolveToFreeSlots(0)){
              ok = true;
            } else {
              this.restoreStateSnapshot(directState);
              // If no direct free-cell closure exists, keep the root at the
              // destination while FET relocates each displaced one-period
              // activity.  A failed later relocation rolls back the whole
              // transaction, so no activity can be lost.
              this.nCalls = 0;
              this.limitCalls = Math.max(12000, Number(this.limitCalls) || 0);
              this.tabuMap.clear();
              this.triedRemovals.clear();
              this.swappedInBranch.clear();
              this.swapStep = 0;
              for(const id of displacedIds){
                this.swappedInBranch.add(rootUnit.ids[0]);
                const moved = this.randomSwap(id, 0);
                if(!moved){
                  this.restoreStateSnapshot(snapshot);
                  return { ok: false };
                }
              }
              ok = true;
            }
          } finally {
            this.suspendStudentHoleGuard = previousStudentGuard;
            this.strictTeacherGaps = previousTeacherGaps;
            this.strictFetGaps = previousFetGaps;
            this.swappedInBranch.clear();
            this.rng = previousRng;
          }
          if(!ok){
            this.restoreStateSnapshot(snapshot);
            return { ok: false };
          }
          return { ok: true, snapshot };
        };

        const gapRounds = deepSessionBinSearch ? 12 : 4;
        for(let round = 0; round < gapRounds && currentBest.soBuoiTrong2 > 0; round++){
          if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) break;
          let gapImproved = false;
          const gapRows = findGapRows();
          if(deepSessionBinSearch) this.rng.shuffle(gapRows);
          for(const row of gapRows){
            const tg = this.teacherGridList[row.teacherIdx];
            const targetPeriods = [];
            for(let p = row.periods[0]; p <= row.periods.at(-1); p++){
              if(!row.periods.includes(p) && tg[row.session * PERIODS_PER_SESSION + p] === -1) targetPeriods.push(p);
            }
            if(deepSessionBinSearch) this.rng.shuffle(targetPeriods);
            for(const sourcePeriod of row.periods){
              const sourceSlot = row.session * PERIODS_PER_SESSION + sourcePeriod;
              const rootId = tg[sourceSlot];
              if(rootId < 0) continue;
              const rootUnit = getUnit(rootId);
              if(!canMoveUnit(rootUnit)) continue;
              for(const targetPeriod of targetPeriods){
                if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) break;

                const maxEjectionRetries = deepSessionBinSearch ? 8 : 1;
                let acceptedEjection = false;
                for(let retry = 0; retry < maxEjectionRetries; retry++){
                  const ejected = await tryGapEjection(rootUnit, row.session * PERIODS_PER_SESSION + targetPeriod, retry, currentBest);
                  if(!ejected.ok) continue;
                  if(this.countTotalStudentHoles() > 0) this.compactAllStudentSessions();
                  const ejectedMetrics = this.evaluateMetrics();
                  const ejectedLessonBlocksOk = !reformLessonBlocks || lessonBlocksRemainValid();
                  if(ejectedMetrics.unplacedCount === 0 && ejectedMetrics.soBuoiDay1 === 0 &&
                     ejectedMetrics.soBuoiTrong2 < currentBest.soBuoiTrong2 &&
                     ejectedLessonBlocksOk && this.countTotalStudentHoles() === 0){
                    currentBest = { ...ejectedMetrics };
                    improved = true;
                    gapImproved = true;
                    acceptedEjection = true;
                    if(typeof onProgress === "function") onProgress(currentBest);
                    break;
                  }
                  this.restoreStateSnapshot(ejected.snapshot);
                }
                if(acceptedEjection) break;

                const targetSlot = row.session * PERIODS_PER_SESSION + targetPeriod;
                const snapshot = this.captureStateSnapshot();
                const previousStudentGuard = this.suspendStudentHoleGuard;
                const previousTeacherGaps = this.strictTeacherGaps;
                const previousFetGaps = this.strictFetGaps;
                this.suspendStudentHoleGuard = true;
                this.strictTeacherGaps = false;
                this.strictFetGaps = false;
                protectedIds = new Set(rootUnit.ids);
                unplaceUnit(rootUnit);
                nodes = 0;
                const acceptGapClosure = () => {
                  if(this.countTotalStudentHoles() > 0) this.compactAllStudentSessions();
                  const candidate = this.evaluateMetrics();
                  return candidate.unplacedCount === 0 && candidate.soBuoiDay1 === 0 &&
                    candidate.soBuoiTrong2 < currentBest.soBuoiTrong2 &&
                    (!reformLessonBlocks || lessonBlocksRemainValid()) &&
                    this.countTotalStudentHoles() === 0;
                };
                const ok = await placeChain(rootUnit, targetSlot, new Set(rootUnit.ids), 0, acceptGapClosure, row.session);
                this.suspendStudentHoleGuard = previousStudentGuard;
                this.strictTeacherGaps = previousTeacherGaps;
                this.strictFetGaps = previousFetGaps;
                protectedIds = new Set();
                if(ok && this.countTotalStudentHoles() > 0) this.compactAllStudentSessions();
                const metrics = this.evaluateMetrics();
                const lessonBlocksOk = !reformLessonBlocks || lessonBlocksRemainValid();
                if(ok && metrics.unplacedCount === 0 && metrics.soBuoiDay1 === 0 &&
                   metrics.soBuoiTrong2 < currentBest.soBuoiTrong2 &&
                   lessonBlocksOk && this.countTotalStudentHoles() === 0){
                  currentBest = { ...metrics };
                  improved = true;
                  gapImproved = true;
                  if(typeof onProgress === "function") onProgress(currentBest);
                  break;
                }
                this.restoreStateSnapshot(snapshot);
              }
              if(gapImproved) break;
            }
            if(gapImproved) break;
          }
          if(!gapImproved) break;
        }
      }
      return improved ? currentBest : null;
    }

    // Move one period from a genuinely rich session (>= 3 periods) of the
    // same teacher into a singleton session.  The destination may be
    // occupied by another class/room activity, so this is an augmenting
    // chain rather than a single move: every displaced activity is moved to
    // another legal slot until the chain reaches a free slot.  The whole
    // attempt is transactional; a failed chain restores the incumbent.
    async tryTeacherDonorAugmentingChains(bestMetrics, onProgress = null){
      let currentBest = { ...bestMetrics };
      let improved = false;
      let nodes = 0;
      const MAX_NODES_PER_CHAIN = 2400;
      const MAX_DEPTH = 7;

      const collectOccupants = (act, slot, unplacedIds) => {
        const ids = new Set();
        const blocked = { fixed: false };
        const addCell = (cell) => {
          if(cell === -2 || cell === -3) blocked.fixed = true;
          else if(cell >= 0 && cell !== act.id && !unplacedIds.has(cell)) ids.add(cell);
        };
        const cGrid = this.classGridList[act.classIdx];
        for(let d = 0; d < act.duration; d++){
          const s = slot + d;
          addCell(cGrid ? cGrid[s] : -2);
          for(const tIdx of act.teacherIdxs || []){
            const tg = this.teacherGridList[tIdx];
            addCell(tg ? tg[s] : -2);
          }
          if(act.roomIdx >= 0){
            const rg = this.roomGridList[act.roomIdx];
            addCell(rg ? rg[s] : -2);
          }
        }
        return { ids: Array.from(ids), blocked: blocked.fixed };
      };

      const scoredList = Array.from(this.scoredTeachers || this.teacherGrid.keys());
      this.rng.shuffle(scoredList);

      for(const tKey of scoredList){
        if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) break;
        const tIdx = this.teacherIndexMap.get(tKey);
        if(tIdx === undefined) continue;
        const tg = this.teacherGridList[tIdx];
        if(!tg) continue;

        const singleSessions = [];
        const donorSessions = [];
        for(let d = 0; d < DAYS_LIST.length; d++){
          for(let b = 0; b < SESSIONS_LIST.length; b++){
            const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
            const acts = [];
            let periods = 0;
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const s = sStart + p;
              const id = tg[s];
              if(id >= 0){
                periods++;
                if(!acts.some(item => item.actId === id)) acts.push({ actId: id, slot: s });
              }
            }
            if(periods === 1 && acts.length === 1) singleSessions.push({ sStart, item: acts[0] });
            // A one-period donor is deliberately excluded: removing it from
            // a 2-period session would merely create another singleton.
            if(periods >= 3 && acts.length > 0) donorSessions.push({ sStart, periods, acts });
          }
        }
        if(singleSessions.length === 0 || donorSessions.length === 0) continue;

        for(const single of singleSessions){
          if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) break;
          const singletonAct = this.activities[single.item.actId];
          if(!singletonAct || singletonAct.isFixed || singletonAct.lockedByLessonBlock) continue;

          for(const donorSess of donorSessions){
            if(donorSess.sStart === single.sStart) continue;
            for(const donorItem of donorSess.acts){
              const donorAct = this.activities[donorItem.actId];
              if(!donorAct || donorAct.isFixed || donorAct.lockedByLessonBlock || donorAct.duration !== 1) continue;

              // The donor source session is guaranteed to remain >= 2 after
              // removing this one-period activity because periods >= 3.
              for(let p = 0; p < PERIODS_PER_SESSION; p++){
                const targetSlot = single.sStart + p;
                if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) break;

                const snap = this.captureStateSnapshot();
                const rootUnplaced = new Set([donorAct.id]);
                this.unplaceActivity(donorAct.id);
                nodes = 0;

                const placeChain = (act, slot, unplacedIds, depth) => {
                  if(++nodes > MAX_NODES_PER_CHAIN || depth > MAX_DEPTH) return false;
                  if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) return false;
                  const occ = collectOccupants(act, slot, unplacedIds);
                  if(occ.blocked) return false;
                  for(const id of occ.ids){
                    const other = this.activities[id];
                    if(!other || other.isFixed || other.lockedByLessonBlock) return false;
                  }

                  const branchSnap = this.captureStateSnapshot();
                  for(const id of occ.ids) this.unplaceActivity(id);
                  const ignore = new Set(unplacedIds);
                  ignore.add(act.id);
                  for(const id of occ.ids) ignore.add(id);
                  if(!this.isSlotFeasible(act, slot, ignore)){
                    this.restoreStateSnapshot(branchSnap);
                    return false;
                  }
                  this.placeActivityDirect(act.id, slot);

                  const nextUnplaced = new Set(unplacedIds);
                  nextUnplaced.delete(act.id);
                  for(const id of occ.ids) nextUnplaced.add(id);
                  for(const id of occ.ids){
                    const other = this.activities[id];
                    const allowed = this.allowedSlotsByActivity?.get(other) || [];
                    let resolved = false;
                    for(const nextSlot of allowed){
                      if(nextSlot === slot) continue;
                      if(placeChain(other, nextSlot, nextUnplaced, depth + 1)){
                        resolved = true;
                        nextUnplaced.delete(id);
                        break;
                      }
                    }
                    if(!resolved){
                      this.restoreStateSnapshot(branchSnap);
                      return false;
                    }
                  }
                  return true;
                };

                const ok = placeChain(donorAct, targetSlot, rootUnplaced, 0);
                if(ok && this.countTotalStudentHoles() > 0) this.compactAllStudentSessions();
                if(ok && this.countTotalStudentHoles() === 0){
                  const metrics = this.evaluateMetrics();
                  if(metrics.unplacedCount === 0 && this.compareMetrics(metrics, currentBest, "optimize_singletons") < 0){
                    currentBest = { ...metrics };
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
        if(improved) break;
      }
      return improved ? currentBest : null;
    }

    // Session-first large-neighborhood search.  The old repair operators branch
    // directly on 60 period cells, so many expensive branches differ only in
    // the horizontal position of a lesson inside the same session.  This
    // operator first searches assignments to the 12 session bins, then solves
    // the five horizontal periods only for a promising session plan.
    async trySessionFirstSingletonSearch(bestMetrics, onProgress = null){
      const singletonFloor = Number(this.constraintPreflight?.structuralFloor?.metricLowerBounds?.soBuoiDay1 || 0);
      if(Number(bestMetrics?.soBuoiDay1 || 0) <= singletonFloor) return null;

      const deepSearch = Boolean(this.options?.deepLocalFet || this.options?.deepCycles);
      const requestedBudget = Number(this.options?.sessionFirstStateBudget);
      const stateBudget = Math.max(10, Math.min(1_000_000_000,
        Number.isFinite(requestedBudget) && requestedBudget > 0 ? Math.floor(requestedBudget) : (deepSearch ? 1_000_000 : 10_000)
      ));
      const maxMovedUnits = Math.max(1, Math.min(16, Number(this.options?.sessionFirstMaxMovedUnits) || (deepSearch ? 10 : 5)));
      const maxNeighborhoodUnits = Math.max(6, Math.min(48, Number(this.options?.sessionFirstMaxNeighborhoodUnits) || (deepSearch ? 48 : 18)));
      const gap2Headroom = this.options?.allowSingletonGap2Tradeoff ? (deepSearch ? 6 : 2) : 0;
      const sessionFirstTimeBudgetMs = Math.max(1_000, Math.min(60_000,
        Number.isFinite(Number(this.options?.sessionFirstTimeBudgetMs)) && Number(this.options.sessionFirstTimeBudgetMs) > 0
          ? Math.floor(Number(this.options.sessionFirstTimeBudgetMs))
          : 8_000
      ));
      const searchStartedAt = Date.now();
      const deadlineAt = Math.min(
        this.deadlineAtMs || Infinity,
        searchStartedAt + sessionFirstTimeBudgetMs
      );
      const originalStrictTeacherGaps = this.strictTeacherGaps;
      const originalStrictFetGaps = this.strictFetGaps;
      const originalStudentHoleGuard = this.suspendStudentHoleGuard;
      let currentBest = { ...bestMetrics };
      let improved = false;
      let sessionStates = 0;
      let periodStates = 0;
      let duplicatePlans = 0;
      const seenPlans = new Set();
      let lastHeartbeatAt = searchStartedAt;
      let lastHeartbeatStates = 0;
      const emitHeartbeat = (force = false) => {
        if(typeof onProgress !== "function") return;
        const now = Date.now();
        const totalStates = sessionStates + periodStates;
        if(!force && now - lastHeartbeatAt < 500 && totalStates - lastHeartbeatStates < 4096) return;
        lastHeartbeatAt = now;
        lastHeartbeatStates = totalStates;
        onProgress({
          stage: "session_first",
          currentMetric: currentBest.soBuoiDay1,
          initialMetric: bestMetrics.soBuoiDay1,
          metrics: currentBest,
          sessionStates,
          periodStates,
          stateBudget,
          elapsedMs: now - searchStartedAt,
          heartbeat: true
        });
      };

      const forceUnplace = (id) => {
        const act = this.activities[id];
        const slot = this.actPlacement[id];
        if(!act || slot < 0) return;
        this.actPlacement[id] = -1;
        const cGrid = this.classGridList[act.classIdx];
        for(let d = 0; d < act.duration; d++){
          const s = slot + d;
          if(cGrid && cGrid[s] === id) cGrid[s] = -1;
          for(const tIdx of act.teacherIdxs || []){
            const tg = this.teacherGridList[tIdx];
            if(tg && tg[s] === id) tg[s] = -1;
          }
          if(act.roomIdx >= 0){
            const rg = this.roomGridList[act.roomIdx];
            if(rg && rg[s] === id) rg[s] = -1;
          }
        }
        if(this.teacherSessionCounts){
          const session = Math.floor(slot / PERIODS_PER_SESSION);
          for(const tIdx of act.teacherIdxs || []) this.teacherSessionCounts[tIdx * 12 + session] -= act.duration;
        }
      };

      const unitCache = new Map();
      const getUnit = (id) => {
        if(unitCache.has(id)) return unitCache.get(id);
        const act = this.activities[id];
        if(!act || this.actPlacement[id] < 0) return null;
        let ids = [id];
        if(act.lockedByLessonBlock && act.duration === 1){
          const siblings = this.activities.filter(other =>
            other.lockedByLessonBlock && other.duration === 1 &&
            other.classId === act.classId && other.mon === act.mon &&
            other.gvList.join("|") === act.gvList.join("|") &&
            Math.floor(this.actPlacement[other.id] / PERIODS_PER_SESSION) === Math.floor(this.actPlacement[id] / PERIODS_PER_SESSION)
          );
          const bySlot = new Map(siblings.map(other => [this.actPlacement[other.id], other.id]));
          ids = [id];
          let slot = this.actPlacement[id] - 1;
          while(bySlot.has(slot)){ ids.unshift(bySlot.get(slot)); slot--; }
          slot = this.actPlacement[id] + 1;
          while(bySlot.has(slot)){ ids.push(bySlot.get(slot)); slot++; }
        }
        ids.sort((a, b) => this.actPlacement[a] - this.actPlacement[b]);
        const offsets = [];
        let duration = 0;
        for(const memberId of ids){
          offsets.push(duration);
          duration += this.activities[memberId]?.duration || 1;
        }
        const originalStart = this.actPlacement[ids[0]];
        const unit = {
          key: ids[0], ids, offsets, duration, originalStart,
          originalSession: Math.floor(originalStart / PERIODS_PER_SESSION),
          movable: ids.every(memberId => {
            const member = this.activities[memberId];
            return member && (!member.isFixed || (member.lockedByLessonBlock && this.options?.reformLessonBlocks));
          })
        };
        for(const memberId of ids) unitCache.set(memberId, unit);
        return unit;
      };

      const unitStarts = (unit, onlySession = null) => {
        if(!unit) return [];
        const first = this.activities[unit.ids[0]];
        const allowed = this.allowedSlotsByActivity?.get(first) || [];
        const starts = [];
        for(const start of allowed){
          if(onlySession !== null && Math.floor(start / PERIODS_PER_SESSION) !== onlySession) continue;
          if(start % PERIODS_PER_SESSION + unit.duration > PERIODS_PER_SESSION) continue;
          let okay = true;
          for(let i = 0; i < unit.ids.length; i++){
            const member = this.activities[unit.ids[i]];
            if(!(this.allowedSlotsByActivity?.get(member) || []).includes(start + unit.offsets[i])){
              okay = false;
              break;
            }
          }
          if(okay) starts.push(start);
        }
        return starts;
      };

      const unitSessions = (unit) => [...new Set(unitStarts(unit).map(start => Math.floor(start / PERIODS_PER_SESSION)))];
      const sessionLoad = (grid, session) => {
        let load = 0;
        for(let p = 0; p < PERIODS_PER_SESSION; p++){
          const cell = grid?.[session * PERIODS_PER_SESSION + p];
          if(cell >= 0 || cell === -3) load++;
        }
        return load;
      };

      const findSingletonRows = () => {
        const rows = [];
        for(let tIdx = 0; tIdx < this.teachers.length; tIdx++){
          if(!this.isScoredTeacher(this.teachers[tIdx])) continue;
          const tg = this.teacherGridList[tIdx];
          if(!tg) continue;
          for(let session = 0; session < 12; session++){
            let load = 0;
            let id = -1;
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const cell = tg[session * PERIODS_PER_SESSION + p];
              if(cell >= 0 || cell === -3) load++;
              if(cell >= 0) id = cell;
            }
            if(load === 1 && id >= 0) rows.push({ teacherIdx: tIdx, session, id });
          }
        }
        return rows;
      };

      const lessonBlocksRemainValid = () => {
        const groups = new Map();
        const add = (classId, mon, session) => {
          const key = `${classId}|${this.getCanonMonKey(mon)}`;
          if(!groups.has(key)) groups.set(key, { classId, mon, counts: new Int16Array(12) });
          groups.get(key).counts[session]++;
        };
        for(const act of this.activities){
          const start = this.actPlacement[act.id];
          if(start < 0) continue;
          for(let d = 0; d < act.duration; d++) add(act.classId, act.mon, Math.floor((start + d) / PERIODS_PER_SESSION));
        }
        for(const [key, fix] of this.fixedSlots.entries()){
          const split = key.lastIndexOf("|");
          if(split >= 0 && fix?.mon) add(key.slice(0, split), fix.mon, Math.floor(Number(key.slice(split + 1)) / PERIODS_PER_SESSION));
        }
        for(const group of groups.values()){
          const lop = this.classes.find(item => String(item.id || "") === String(group.classId));
          const rules = this.getSubjectRules(group.mon, lop)?.lessonBlocks || {};
          for(const size of [5, 4, 3, 2]){
            const min = Number((rules[String(size)] || rules[size] || {}).min) || 0;
            if(min <= 0) continue;
            let count = 0;
            for(const periods of group.counts) if(periods === size) count++;
            if(count < min) return false;
          }
        }
        return true;
      };

      const buildRootPlans = () => {
        const plans = [];
        const keys = new Set();
        const addPlan = (row, unit, targetSession, kind) => {
          if(!unit?.movable || targetSession === unit.originalSession || !unitSessions(unit).includes(targetSession)) return;
          const key = `${unit.key}@${targetSession}`;
          if(keys.has(key)) return;
          keys.add(key);
          plans.push({ row, unit, targetSession, kind });
        };
        for(const row of findSingletonRows()){
          const tg = this.teacherGridList[row.teacherIdx];
          const singletonUnit = getUnit(row.id);
          if(singletonUnit?.movable){
            for(const target of unitSessions(singletonUnit)){
              const load = sessionLoad(tg, target);
              if(target !== row.session && load > 0 && load + singletonUnit.duration <= PERIODS_PER_SESSION){
                addPlan(row, singletonUnit, target, "merge_singleton");
              }
            }
          }
          const donors = new Map();
          for(const act of this.activities){
            if(!act.teacherIdxs.includes(row.teacherIdx) || this.actPlacement[act.id] < 0) continue;
            const unit = getUnit(act.id);
            if(!unit?.movable || donors.has(unit.key) || unit.originalSession === row.session) continue;
            if(sessionLoad(tg, unit.originalSession) - unit.duration < 2) continue;
            donors.set(unit.key, unit);
          }
          for(const donor of donors.values()) addPlan(row, donor, row.session, "fill_singleton");
        }
        plans.sort((a, b) => {
          if(a.kind !== b.kind) return a.kind === "merge_singleton" ? -1 : 1;
          if(a.unit.duration !== b.unit.duration) return a.unit.duration - b.unit.duration;
          return Math.abs(a.targetSession - a.unit.originalSession) - Math.abs(b.targetSession - b.unit.originalSession);
        });
        return plans;
      };

      const buildNeighborhood = (plan) => {
        const units = new Map();
        const sessions = new Set([plan.unit.originalSession, plan.targetSession, plan.row.session]);
        const classes = new Set();
        const teachers = new Set([plan.row.teacherIdx]);
        const addUnit = (unit) => {
          if(!unit?.movable || units.has(unit.key)) return;
          units.set(unit.key, unit);
          for(const id of unit.ids){
            const act = this.activities[id];
            classes.add(act.classIdx);
            for(const tIdx of act.teacherIdxs || []) teachers.add(tIdx);
          }
        };
        addUnit(plan.unit);
        const singletonUnit = getUnit(plan.row.id);
        addUnit(singletonUnit);

        // Two resource-closure passes are enough to reflow the affected class
        // rows while keeping the neighborhood bounded.
        for(let pass = 0; pass < 2; pass++){
          const classSnapshot = new Set(classes);
          const teacherSnapshot = new Set(teachers);
          for(const act of this.activities){
            if(this.actPlacement[act.id] < 0 || !sessions.has(Math.floor(this.actPlacement[act.id] / PERIODS_PER_SESSION))) continue;
            if(!classSnapshot.has(act.classIdx) && !(act.teacherIdxs || []).some(tIdx => teacherSnapshot.has(tIdx))) continue;
            addUnit(getUnit(act.id));
            if(units.size > maxNeighborhoodUnits) return null;
          }
        }
        return [...units.values()];
      };

      const makeCapacity = (grids) => {
        const counts = new Int8Array(grids.length * 12);
        for(let index = 0; index < grids.length; index++){
          const grid = grids[index];
          for(let session = 0; session < 12; session++) counts[index * 12 + session] = sessionLoad(grid, session);
        }
        return counts;
      };

      const contribution = (unit) => {
        const classes = new Map();
        const teachers = new Map();
        const rooms = new Map();
        for(const id of unit.ids){
          const act = this.activities[id];
          classes.set(act.classIdx, (classes.get(act.classIdx) || 0) + act.duration);
          for(const tIdx of act.teacherIdxs || []) teachers.set(tIdx, (teachers.get(tIdx) || 0) + act.duration);
          if(act.roomIdx >= 0) rooms.set(act.roomIdx, (rooms.get(act.roomIdx) || 0) + act.duration);
        }
        return { classes: [...classes], teachers: [...teachers], rooms: [...rooms] };
      };

      const realizePlan = async (units, assignments, baseline) => {
        const snapshot = this.captureStateSnapshot();
        for(const unit of units) for(const id of unit.ids) forceUnplace(id);
        this.suspendStudentHoleGuard = true;
        this.strictTeacherGaps = false;
        this.strictFetGaps = false;

        const placeUnit = (unit, start) => {
          const ignore = new Set(unit.ids);
          for(let i = 0; i < unit.ids.length; i++){
            if(!this.isSlotFeasible(this.activities[unit.ids[i]], start + unit.offsets[i], ignore)) return false;
          }
          for(let i = 0; i < unit.ids.length; i++){
            if(!this.placeActivityDirect(unit.ids[i], start + unit.offsets[i])) return false;
          }
          return true;
        };

        const sessionHasStudentHole = (classIdx, session) => {
          const grid = this.classGridList[classIdx];
          let mask = 0;
          for(let p = 0; p < PERIODS_PER_SESSION; p++){
            const cell = grid?.[session * PERIODS_PER_SESSION + p];
            if(cell >= 0 || cell === -3) mask |= (1 << p);
          }
          return SESSION_STATS_LUT[mask].gaps > 0;
        };

        // Period coloring is independent between sessions.  Solving one
        // five-column bin at a time avoids multiplying equivalent layouts of
        // unrelated bins (the main source of the old 100k+ node explosion).
        const bySession = new Map();
        const affectedClasses = new Map();
        for(let index = 0; index < units.length; index++){
          const assigned = assignments[index];
          if(!bySession.has(assigned)) bySession.set(assigned, []);
          bySession.get(assigned).push(index);
          for(const session of [units[index].originalSession, assigned]){
            if(!affectedClasses.has(session)) affectedClasses.set(session, new Set());
            for(const id of units[index].ids) affectedClasses.get(session).add(this.activities[id].classIdx);
          }
        }
        const sessions = [...new Set([...affectedClasses.keys(), ...bySession.keys()])];
        sessions.sort((a, b) => (bySession.get(b)?.length || 0) - (bySession.get(a)?.length || 0));

        const solveSession = async (session) => {
          const remaining = new Set(bySession.get(session) || []);
          const dfs = async () => {
            if(sessionStates + periodStates >= stateBudget || Date.now() >= deadlineAt || this.isCancelled) return false;
            periodStates++;
            if((periodStates & 1023) === 0){
              await new Promise(resolve => setTimeout(resolve, 0));
              emitHeartbeat();
            }
            if(remaining.size === 0){
              for(const classIdx of affectedClasses.get(session) || []){
                if(sessionHasStudentHole(classIdx, session)) return false;
              }
              return true;
            }

            let chosen = -1;
            let chosenStarts = null;
            for(const index of remaining){
              const unit = units[index];
              const ignore = new Set(unit.ids);
              const starts = unitStarts(unit, session).filter(start =>
                unit.ids.every((id, memberIndex) => this.isSlotFeasible(this.activities[id], start + unit.offsets[memberIndex], ignore))
              );
              if(starts.length === 0) return false;
              if(!chosenStarts || starts.length < chosenStarts.length){
                chosen = index;
                chosenStarts = starts;
                if(starts.length === 1) break;
              }
            }
            const unit = units[chosen];
            chosenStarts.sort((a, b) => {
              const originalPeriod = unit.originalStart % PERIODS_PER_SESSION;
              const affinityA = this.slotTeacherAffinityScore(this.activities[unit.ids[0]], a);
              const affinityB = this.slotTeacherAffinityScore(this.activities[unit.ids[0]], b);
              if(affinityA !== affinityB) return affinityA - affinityB;
              return Math.abs((a % PERIODS_PER_SESSION) - originalPeriod) - Math.abs((b % PERIODS_PER_SESSION) - originalPeriod);
            });
            remaining.delete(chosen);
            for(const start of chosenStarts){
              if(placeUnit(unit, start) && await dfs()) return true;
              for(const id of unit.ids) forceUnplace(id);
              if(sessionStates + periodStates >= stateBudget || Date.now() >= deadlineAt) break;
            }
            remaining.add(chosen);
            return false;
          };
          return dfs();
        };

        let okay = true;
        for(const session of sessions){
          if(!await solveSession(session)){
            okay = false;
            break;
          }
        }
        if(okay){
          const metrics = this.evaluateMetrics();
          okay = this.countTotalStudentHoles() === 0 && lessonBlocksRemainValid() &&
            metrics.unplacedCount === 0 && metrics.soBuoiDay1 < baseline.soBuoiDay1 &&
            metrics.soBuoiTrong2 <= baseline.soBuoiTrong2 + gap2Headroom &&
            this.validateIncumbentLocationConstraints().length === 0 && this.missingMustTeachSlots().length === 0 &&
            this.compareMetrics(metrics, baseline, baseline, "optimize_singletons") < 0;
        }
        this.suspendStudentHoleGuard = originalStudentHoleGuard;
        this.strictTeacherGaps = originalStrictTeacherGaps;
        this.strictFetGaps = originalStrictFetGaps;
        if(okay) return true;
        this.restoreStateSnapshot(snapshot);
        return false;
      };

      const searchPlan = async (plan, units) => {
        const rootIndex = units.findIndex(unit => unit.key === plan.unit.key);
        if(rootIndex < 0) return false;
        const domains = units.map(unit => unitSessions(unit));
        if(domains.some(domain => domain.length === 0)) return false;
        const classCounts = makeCapacity(this.classGridList);
        const teacherCounts = makeCapacity(this.teacherGridList);
        const roomCounts = makeCapacity(this.roomGridList);
        const contrib = units.map(contribution);
        for(let index = 0; index < units.length; index++){
          const session = units[index].originalSession;
          for(const [resource, amount] of contrib[index].classes) classCounts[resource * 12 + session] -= amount;
          for(const [resource, amount] of contrib[index].teachers) teacherCounts[resource * 12 + session] -= amount;
          for(const [resource, amount] of contrib[index].rooms) roomCounts[resource * 12 + session] -= amount;
        }

        const order = units.map((_, index) => index).sort((a, b) => {
          if(a === rootIndex) return -1;
          if(b === rootIndex) return 1;
          return domains[a].length - domains[b].length;
        });
        const assignments = new Int8Array(units.length).fill(-1);

        const applyCounts = (index, session, sign) => {
          for(const [resource, amount] of contrib[index].classes) classCounts[resource * 12 + session] += sign * amount;
          for(const [resource, amount] of contrib[index].teachers) teacherCounts[resource * 12 + session] += sign * amount;
          for(const [resource, amount] of contrib[index].rooms) roomCounts[resource * 12 + session] += sign * amount;
        };
        const fits = (index, session) => {
          for(const [resource, amount] of contrib[index].classes) if(classCounts[resource * 12 + session] + amount > PERIODS_PER_SESSION) return false;
          for(const [resource, amount] of contrib[index].teachers) if(teacherCounts[resource * 12 + session] + amount > PERIODS_PER_SESSION) return false;
          for(const [resource, amount] of contrib[index].rooms) if(roomCounts[resource * 12 + session] + amount > PERIODS_PER_SESSION) return false;
          return true;
        };
        const singletonScore = () => {
          let score = 0;
          for(let tIdx = 0; tIdx < this.teachers.length; tIdx++){
            if(!this.isScoredTeacher(this.teachers[tIdx])) continue;
            for(let session = 0; session < 12; session++) if(teacherCounts[tIdx * 12 + session] === 1) score++;
          }
          return score;
        };

        for(let moveLimit = 1; moveLimit <= maxMovedUnits; moveLimit++){
          const dfsSessions = async (depth, moved) => {
            if(sessionStates + periodStates >= stateBudget || Date.now() >= deadlineAt || this.isCancelled) return false;
            sessionStates++;
            if((sessionStates & 4095) === 0){
              await new Promise(resolve => setTimeout(resolve, 0));
              emitHeartbeat();
            }
            if(depth === order.length){
              if(singletonScore() >= currentBest.soBuoiDay1) return false;
              const signature = units.map((unit, index) => assignments[index] === unit.originalSession ? "" : `${unit.key}:${assignments[index]}`).filter(Boolean).sort().join("|");
              if(seenPlans.has(signature)){ duplicatePlans++; return false; }
              seenPlans.add(signature);
              return realizePlan(units, assignments, currentBest);
            }
            const index = order[depth];
            const unit = units[index];
            let candidates = index === rootIndex ? [plan.targetSession] : domains[index].slice();
            candidates.sort((a, b) => {
              if(a === unit.originalSession) return -1;
              if(b === unit.originalSession) return 1;
              let aScore = 0;
              let bScore = 0;
              for(const [teacher] of contrib[index].teachers){
                const ca = teacherCounts[teacher * 12 + a];
                const cb = teacherCounts[teacher * 12 + b];
                aScore += ca === 1 ? -4 : (ca === 0 ? 2 : -ca);
                bScore += cb === 1 ? -4 : (cb === 0 ? 2 : -cb);
              }
              return aScore - bScore;
            });
            for(const session of candidates){
              const nextMoved = moved + (session === unit.originalSession ? 0 : 1);
              if(nextMoved > moveLimit || !fits(index, session)) continue;
              assignments[index] = session;
              applyCounts(index, session, 1);
              if(await dfsSessions(depth + 1, nextMoved)) return true;
              applyCounts(index, session, -1);
              assignments[index] = -1;
              if(sessionStates + periodStates >= stateBudget || Date.now() >= deadlineAt) break;
            }
            return false;
          };
          if(await dfsSessions(0, 0)) return true;
          if(sessionStates + periodStates >= stateBudget || Date.now() >= deadlineAt) break;
        }
        return false;
      };

      while(currentBest.soBuoiDay1 > singletonFloor && sessionStates + periodStates < stateBudget && Date.now() < deadlineAt){
        unitCache.clear();
        let roundImproved = false;
        const plans = buildRootPlans();
        for(const plan of plans){
          emitHeartbeat();
          if(sessionStates + periodStates >= stateBudget || Date.now() >= deadlineAt || this.isCancelled) break;
          const units = buildNeighborhood(plan);
          if(!units) continue;
          if(await searchPlan(plan, units)){
            currentBest = this.evaluateMetrics();
            improved = true;
            roundImproved = true;
            if(typeof onProgress === "function") onProgress({
              stage: "session_first",
              currentMetric: currentBest.soBuoiDay1,
              initialMetric: bestMetrics.soBuoiDay1,
              metrics: currentBest,
              sessionStates,
              periodStates,
              stateBudget
            });
            break;
          }
        }
        if(!roundImproved) break;
      }

      emitHeartbeat(true);

      this.suspendStudentHoleGuard = originalStudentHoleGuard;
      this.strictTeacherGaps = originalStrictTeacherGaps;
      this.strictFetGaps = originalStrictFetGaps;
      this.lastSessionFirstStats = {
        stateBudget,
        sessionFirstTimeBudgetMs,
        sessionStates,
        periodStates,
        duplicatePlans,
        initialSingletons: Number(bestMetrics.soBuoiDay1 || 0),
        finalSingletons: Number(currentBest.soBuoiDay1 || 0),
        floor: singletonFloor,
        reachedFloor: currentBest.soBuoiDay1 <= singletonFloor
      };
      return improved ? currentBest : null;
    }

    // Exact bounded neighborhood for incumbent schedules.  loadExistingSchedule
    // represents a required lesson block as fixed one-period members so that a
    // generic swap cannot split it.  For this operator those members are
    // temporarily treated as one contiguous unit; the unit is never split in
    // a candidate and the original snapshot is restored on failure.
    async tryRepackSingletonComponents(bestMetrics, onProgress = null){
      let currentBest = { ...bestMetrics };
      let improved = false;
      const maxRounds = 8;

      const forceUnplace = (id) => {
        const act = this.activities[id];
        const slot = this.actPlacement[id];
        if(!act || slot < 0) return;
        this.actPlacement[id] = -1;
        const cGrid = this.classGridList[act.classIdx];
        for(let d = 0; d < act.duration; d++){
          const s = slot + d;
          if(cGrid && cGrid[s] === id) cGrid[s] = -1;
          for(const tIdx of act.teacherIdxs || []){
            const tg = this.teacherGridList[tIdx];
            if(tg && tg[s] === id) tg[s] = -1;
          }
          if(act.roomIdx >= 0){
            const rg = this.roomGridList[act.roomIdx];
            if(rg && rg[s] === id) rg[s] = -1;
          }
        }
        if(this.teacherSessionCounts){
          const sess = Math.floor(slot / PERIODS_PER_SESSION);
          for(const tIdx of act.teacherIdxs || []){
            this.teacherSessionCounts[tIdx * 12 + sess] -= act.duration;
          }
        }
      };

      const makeUnits = (included) => {
        const used = new Set();
        const units = [];
        for(const act of this.activities){
          if(!included.has(act.id) || used.has(act.id)) continue;
          let ids = [act.id];
          if(act.lockedByLessonBlock){
            const siblings = this.activities.filter(other =>
              included.has(other.id) && !used.has(other.id) && other.lockedByLessonBlock &&
              other.classId === act.classId && other.mon === act.mon &&
              other.gvList.join("|") === act.gvList.join("|") && other.duration === 1
            );
            const positions = new Map(siblings.map(other => [this.actPlacement[other.id], other]));
            const run = [act];
            let left = this.actPlacement[act.id] - 1;
            while(positions.has(left)){ run.unshift(positions.get(left)); left--; }
            let right = this.actPlacement[act.id] + 1;
            while(positions.has(right)){ run.push(positions.get(right)); right++; }
            if(run.length >= 2) ids = run.map(item => item.id);
          }
          ids.forEach(id => used.add(id));
          units.push({ ids });
        }
        return units;
      };

      const unitStarts = (unit) => {
        const first = this.activities[unit.ids[0]];
        const allowed = this.allowedSlotsByActivity?.get(first) || [];
        const starts = [];
        for(const start of allowed){
          if(start % PERIODS_PER_SESSION + unit.ids.length > PERIODS_PER_SESSION) continue;
          let okay = true;
          for(let offset = 0; offset < unit.ids.length; offset++){
            const member = this.activities[unit.ids[offset]];
            if(!(this.allowedSlotsByActivity?.get(member) || []).includes(start + offset)){
              okay = false;
              break;
            }
          }
          if(okay) starts.push(start);
        }
        return starts;
      };

      const placeUnit = (unit, start) => {
        // Only the members of this unit are ignored while checking its own
        // contiguous placement. Previously ignoring the whole neighborhood
        // allowed two already-placed units to share a teacher/class slot.
        const ignore = new Set(unit.ids);
        for(let offset = 0; offset < unit.ids.length; offset++){
          const member = this.activities[unit.ids[offset]];
          if(!this.isSlotFeasible(member, start + offset, ignore)) return false;
        }
        for(let offset = 0; offset < unit.ids.length; offset++){
          if(!this.placeActivityDirect(unit.ids[offset], start + offset)) return false;
        }
        return true;
      };

      const searchUnits = async (units, baseline, deadlineAt, maxNodes) => {
        const allIds = units.flatMap(unit => unit.ids);
        const domains = units.map(unit => unitStarts(unit));
        if(domains.some(domain => domain.length === 0)) return { best: null, nodes: 0 };
        const order = units.map((unit, index) => index).sort((a, b) => domains[a].length - domains[b].length);
        let nodes = 0;
        let best = null;

        const dfs = async (depth) => {
          nodes++;
          if(nodes > maxNodes || Date.now() >= deadlineAt) return false;
          if((nodes & 255) === 0) await new Promise(resolve => setTimeout(resolve, 0));
          if(depth === order.length){
            if(this.countTotalStudentHoles() !== 0) return false;
            const metrics = this.evaluateMetrics();
            if(metrics.unplacedCount === 0 && metrics.soBuoiTrong2 === 0 && this.compareMetrics(metrics, baseline, "optimize_singletons") < 0){
              if(!best || this.compareMetrics(metrics, best, "optimize_singletons") < 0){
                best = { ...metrics, snapshot: this.captureStateSnapshot() };
              }
            }
            return Boolean(best && best.soBuoiDay1 === 0);
          }

          const unit = units[order[depth]];
          const starts = domains[order[depth]].slice();
          this.rng.shuffle(starts);
          for(const start of starts){
            if(Date.now() >= deadlineAt) return false;
            const snap = this.captureStateSnapshot();
            if(placeUnit(unit, start) && await dfs(depth + 1)) return true;
            this.restoreStateSnapshot(snap);
            if(best && best.soBuoiDay1 === 0) return true;
          }
          return false;
        };

        await dfs(0);
        return { best, nodes };
      };

      const findSingletons = () => {
        const rows = [];
        for(let tIdx = 0; tIdx < this.teachers.length; tIdx++){
          const teacher = this.teachers[tIdx];
          const tg = this.teacherGridList[tIdx];
          if(!this.isScoredTeacher(teacher) || !tg) continue;
          for(let session = 0; session < DAYS_LIST.length * SESSIONS_LIST.length; session++){
            const start = session * PERIODS_PER_SESSION;
            let mask = 0;
            const ids = [];
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const id = tg[start + p];
              if(id >= 0 || id === -3) mask |= 1 << p;
              if(id >= 0) ids.push(id);
            }
            if(mask && (mask & (mask - 1)) === 0 && ids.length === 1){
              rows.push({ teacher, teacherIdx: tIdx, session, id: ids[0] });
            }
          }
        }
        return rows;
      };

      for(let round = 0; round < maxRounds && currentBest.soBuoiDay1 > 0; round++){
        if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) break;
        let roundImproved = false;
        for(const row of findSingletons()){
          if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) break;
          const singleton = this.activities[row.id];
          if(!singleton || singleton.isFixed || singleton.lockedByLessonBlock) continue;
          const tg = this.teacherGridList[row.teacherIdx];
          const richSessions = new Set();
          for(let session = 0; session < 12; session++){
            let periods = 0;
            for(let p = 0; p < PERIODS_PER_SESSION; p++) if(tg[session * PERIODS_PER_SESSION + p] >= 0) periods++;
            if(periods >= 3 && session !== row.session) richSessions.add(session);
          }

          const donors = [];
          const donorKeys = new Set();
          for(const act of this.activities){
            if(!act.teacherIdxs.includes(row.teacherIdx)) continue;
            const session = Math.floor(this.actPlacement[act.id] / PERIODS_PER_SESSION);
            if(!richSessions.has(session)) continue;
            if(act.duration !== 1 && !act.lockedByLessonBlock) continue;
            if(act.lockedByLessonBlock && !act.isFixed) continue;
            const key = act.classId + "|" + act.mon + "|" + session;
            if(!donorKeys.has(key)){
              donorKeys.add(key);
              donors.push(act);
            }
          }

          for(const donor of donors){
            if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) break;
            const donorSession = Math.floor(this.actPlacement[donor.id] / PERIODS_PER_SESSION);
            const classes = new Set([singleton.classId, donor.classId]);
            const sessions = new Set([row.session, donorSession]);
            const included = new Set();
            for(const act of this.activities){
              const session = Math.floor(this.actPlacement[act.id] / PERIODS_PER_SESSION);
              if((classes.has(act.classId) && sessions.has(session)) ||
                 (act.teacherIdxs.includes(row.teacherIdx) && sessions.has(session))){
                included.add(act.id);
              }
            }
            const units = makeUnits(included);
            const snapshot = this.captureStateSnapshot();
            const previousStrictTeacherGaps = this.strictTeacherGaps;
            const previousStrictFetGaps = this.strictFetGaps;
            this.suspendStudentHoleGuard = true;
            this.strictTeacherGaps = false;
            this.strictFetGaps = false;
            for(const unit of units) for(const id of unit.ids) forceUnplace(id);
            const localDeadline = Math.min(
              this.deadlineAtMs || (Date.now() + 8000),
              Date.now() + 8000
            );
            const result = await searchUnits(units, currentBest, localDeadline, 100000);
            this.suspendStudentHoleGuard = false;
            this.strictTeacherGaps = previousStrictTeacherGaps;
            this.strictFetGaps = previousStrictFetGaps;

            if(result.best?.snapshot){
              this.restoreStateSnapshot(result.best.snapshot);
              currentBest = this.evaluateMetrics();
              roundImproved = true;
              improved = true;
              if(typeof onProgress === "function") onProgress(currentBest);
              break;
            }
            this.restoreStateSnapshot(snapshot);
          }
          if(roundImproved) break;
        }
        if(!roundImproved) break;
      }
      this.suspendStudentHoleGuard = false;
      return improved ? currentBest : null;
    }

    async trySingletonEjectionChains(bestMetrics, onProgress = null){
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
        const targetSessions = [];
        for(let d = 0; d < DAYS_LIST.length; d++){
          for(let b = 0; b < SESSIONS_LIST.length; b++){
            const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
            const acts = [];
            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const s = sStart + p;
              if(tg[s] >= 0) acts.push({ actId: tg[s], slot: s, pIdx: p });
            }
            if(acts.length === 1) singleSessions.push({ sStart, item: acts[0], d, b });
            if(acts.length >= 1 && acts.length <= 4) targetSessions.push({ sStart, acts, d, b });
          }
        }
        if(singleSessions.length === 0 || targetSessions.length === 0) continue;

        for(const single of singleSessions){
          const singleAct = this.activities[single.item.actId];
          if(!singleAct || singleAct.isFixed || singleAct.lockedByLessonBlock) continue;
          const cGrid = this.classGridList[singleAct.classIdx];
          if(!cGrid) continue;

          for(const targetSess of targetSessions){
            if(targetSess.sStart === single.sStart) continue;

            for(let p = 0; p <= PERIODS_PER_SESSION - singleAct.duration; p++){
              if((++evalSteps % 32) === 0 && (Date.now() - lastYieldAt >= 16)){
                await new Promise(resolve => setTimeout(resolve, 0));
                lastYieldAt = Date.now();
              }

              const targetSlot = targetSess.sStart + p;
              if(targetSlot === single.item.slot) continue;
              let tBusy = false;
              for(let d = 0; d < singleAct.duration; d++){
                if(tg[targetSlot + d] >= 0 || tg[targetSlot + d] === -2 || tg[targetSlot + d] === -3){ tBusy = true; break; }
              }
              if(tBusy) continue;

              const occId = cGrid[targetSlot];
              if(occId === -2 || occId === -3) continue;

              const snap = this.captureStateSnapshot();
              this.unplaceActivity(singleAct.id);

              let ok = false;
              if(occId === -1){
                if(this.isSlotFeasible(singleAct, targetSlot)){
                  this.placeActivityDirect(singleAct.id, targetSlot);
                  ok = true;
                }
              } else if(occId >= 0 && occId !== singleAct.id){
                const occAct = this.activities[occId];
                if(occAct && !occAct.isFixed && !occAct.lockedByLessonBlock){
                  this.unplaceActivity(occId);
                  if(this.isSlotFeasible(singleAct, targetSlot)){
                    this.placeActivityDirect(singleAct.id, targetSlot);
                    this.nCalls = 0;
                    this.tabuMap.clear();
                    this.triedRemovals.clear();
                    this.swappedInBranch.clear();
                    this.limitCalls = this.getAdaptiveLimitCalls(2000, 3500);
                    ok = this.randomSwap(occAct.id, 0);
                  }
                }
              }

              if(ok && this.countTotalStudentHoles() > 0){
                this.compactAllStudentSessions();
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
            if(improved) break;
          }
          if(improved) break;
        }
      }
      return improved ? currentBest : null;
    }

    // Dat mot tiet vua bi boc ra vao buoi ma giao vien DANG co tiet, bo qua
    // buoi dang duoc giai phong. Tra ve true neu dat duoc.
    //
    // Day la ve "don sang buoi nhieu tiet": chi cac o nam trong buoi da co
    // nguoi day moi duoc nhan, nen mot buoi bi xoa khong the tai sinh thanh
    // mot buoi moi o ngay khac. Trong so cac o hop le, chon o co diem bam cum
    // tot nhat (slotTeacherAffinityScore — diem cang thap cang bam).
    placeIntoOccupiedTeacherSession(act, vacatingSession, maxEjectionTries = 0){
      if(!this.teacherSessionCounts) return false;
      const allowed = this.allowedSlotsByActivity?.get(act) || [];
      const ranked = [];

      for(let i = 0; i < allowed.length; i++){
        const slot = allowed[i];
        const session = Math.floor(slot / PERIODS_PER_SESSION);
        if(session === vacatingSession) continue;

        let occupied = false;
        for(let t = 0; t < act.teacherIdxs.length; t++){
          if(this.teacherSessionCounts[act.teacherIdxs[t] * 12 + session] > 0){
            occupied = true;
            break;
          }
        }
        if(occupied) ranked.push(slot);
      }
      if(ranked.length === 0) return false;
      ranked.sort((a, b) => this.slotTeacherAffinityScore(act, a) - this.slotTeacherAffinityScore(act, b));

      // Pha 1 — o con trong that su.
      for(let i = 0; i < ranked.length; i++){
        if(this.isSlotFeasible(act, ranked[i])){
          this.placeActivityDirect(act.id, ranked[i]);
          return true;
        }
      }
      if(maxEjectionTries <= 0) return false;

      // Pha 2 — ejection. Do rat da so buoi cua giao vien deu kin cho lop nay,
      // pha 1 mot minh hau nhu luon that bai (do duoc: ~92% truot). FET giai
      // dung tinh huong nay bang cach DAY hoat dong dang chiem ra roi xep lai
      // no bang tim kiem de quy (teacherRemoveAnActivity... -> conflActivities
      // -> randomSwap o level ke tiep). Moi lan thu deu co snapshot rieng nen
      // that bai khong de lai dau vet.
      const classGrid = this.classGridList[act.classIdx];
      if(!classGrid) return false;
      let tries = 0;

      for(let i = 0; i < ranked.length && tries < maxEjectionTries; i++){
        const slot = ranked[i];
        const occId = classGrid[slot];
        if(occId === undefined || occId < 0) continue;
        const occAct = this.activities[occId];
        if(!occAct || occAct.isFixed || occAct.lockedByLessonBlock || occAct.duration !== 1) continue;

        tries++;
        const snap = this.captureStateSnapshot();
        this.unplaceActivity(occId);
        if(!this.isSlotFeasible(act, slot)){
          this.restoreStateSnapshot(snap);
          continue;
        }
        this.placeActivityDirect(act.id, slot);
        this.nCalls = 0;
        this.tabuMap.clear();
        this.triedRemovals.clear();
        this.swappedInBranch.clear();
        this.limitCalls = this.getAdaptiveLimitCalls(1500, 2500);
        if(this.randomSwap(occId, 0)) return true;
        this.restoreStateSnapshot(snap);
      }
      return false;
    }

    // Don buoi it tiet sang buoi nhieu tiet.
    //
    // FET xu ly ConstraintTeacherMaxDaysPerWeek bang cach giai phong TRON MOT
    // ngay day cua giao vien, va luon uu tien ngay co it hoat dong phai day di
    // nhat (generate.cpp: dem _nConflActivities cho tung ngay co the lam trong,
    // roi boc ngau nhien trong so cac ngay dat cuc tieu). O day don vi tuong
    // duong la mot "buoi" (5 tiet sang hoac 5 tiet chieu), nen buoi 1 tiet duoc
    // thu truoc, roi 2 tiet, roi 3 tiet — dung thu tu luy tien k = 1 -> 2 -> 3.
    //
    // Ban truoc 22/08 chi xet buoi co DUNG 2 tiet, nen bo qua ca buoi 1 tiet
    // (vua la singleton vua la buoi thua) lan buoi 3 tiet.
    async tryVacateTeacherSessions(bestMetrics, onProgress = null){
      let currentBest = { ...bestMetrics };
      let improved = false;
      let lastYieldAt = Date.now();

      const MAX_SESSION_PERIODS_TO_VACATE = 3;

      const scoredList = Array.from(this.scoredTeachers || this.teacherGrid.keys());
      this.rng.shuffle(scoredList);

      for(const tKey of scoredList){
        if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) break;
        const tIdx = this.teacherIndexMap.get(tKey);
        if(tIdx === undefined) continue;
        const tg = this.teacherGridList[tIdx];
        if(!tg) continue;

        const candidates = [];
        for(let d = 0; d < DAYS_LIST.length; d++){
          for(let b = 0; b < SESSIONS_LIST.length; b++){
            const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
            const actIds = [];
            const seen = new Set();
            let periods = 0;
            let blocked = false;

            for(let p = 0; p < PERIODS_PER_SESSION; p++){
              const cell = tg[sStart + p];
              // O co dinh (-3) khong the roi buoi nay, nen buoi khong bao gio
              // dong lai duoc: bo qua ngay thay vi ton mot luot randomSwap.
              if(cell === -3){ blocked = true; break; }
              if(cell < 0) continue;
              periods++;
              if(seen.has(cell)) continue;
              seen.add(cell);
              actIds.push(cell);
            }

            if(blocked || periods === 0) continue;
            if(periods > MAX_SESSION_PERIODS_TO_VACATE) continue;

            const movable = actIds.every(id => {
              const act = this.activities[id];
              return act && !act.isFixed && !act.lockedByLessonBlock && act.duration === 1;
            });
            if(!movable) continue;

            candidates.push({
              actIds,
              cost: actIds.length,
              session: Math.floor(sStart / PERIODS_PER_SESSION)
            });
          }
        }

        if(candidates.length === 0) continue;
        // Xao truoc roi sort on dinh: cac buoi cung chi phi giu thu tu ngau
        // nhien, giong cach FET boc ngau nhien trong nhom ngay dat cuc tieu.
        this.rng.shuffle(candidates);
        candidates.sort((a, b) => a.cost - b.cost);

        for(const candidate of candidates){
          if(this.deadlineAtMs && Date.now() >= this.deadlineAtMs) break;
          if(Date.now() - lastYieldAt >= 16){
            await new Promise(resolve => setTimeout(resolve, 0));
            lastYieldAt = Date.now();
          }

          const snap = this.captureStateSnapshot();
          let allMoved = true;

          for(const actId of candidate.actIds){
            const act = this.activities[actId];
            if(!act){ allMoved = false; break; }
            this.unplaceActivity(act.id);
            // Uu tien tuyet doi: dat lai tiet vao mot buoi GIAO VIEN DA CO TIET
            // (va khong phai buoi dang giai phong). randomSwap tu do rat hay
            // mo mot buoi moi o cho khac — luc do tong buoi khong giam, ca nuoc
            // di bi rollback va operator coi nhu bat luc. Do la ly do ban truoc
            // gan nhu khong bao gio ha duoc tsBuoiDay.
            if(this.placeIntoOccupiedTeacherSession(act, candidate.session, 6)) continue;
            this.nCalls = 0;
            this.tabuMap.clear();
            this.triedRemovals.clear();
            this.swappedInBranch.clear();
            this.limitCalls = this.getAdaptiveLimitCalls(2000, 3500);
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
      }
      return improved ? currentBest : null;
    }

    async tryCrushGaps(bestMetrics, onProgress = null, mode = "optimize_gap2"){
      let currentBest = { ...bestMetrics };
      let improved = false;
      let evalSteps = 0;
      let lastYieldAt = Date.now();

      // FET (ConstraintTeachersMaxGapsPerDay) chi coi mot buoi la vi pham khi
      // so lo vuot maxGaps. Muc tieu "2 tiet trong" tuong duong maxGaps = 1 nen
      // chi quet buoi co >= 2 lo; muc tieu "1 tiet trong" tuong duong
      // maxGaps = 0 nen phai quet ca buoi chi co dung 1 lo.
      const minGapToTarget = mode === "optimize_gap1" ? 1 : 2;

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
            if(gapCount < minGapToTarget) continue;

            for(let idx = 0; idx < k; idx++){
              const pOrig = taught[idx];
              const sOrig = sStart + pOrig;
              const actId = tg[sOrig];
              if(actId < 0) continue;
              const act = this.activities[actId];
              if(!act || act.isFixed || act.lockedByLessonBlock || act.duration !== 1) continue;

              for(let pTarget = 0; pTarget < PERIODS_PER_SESSION; pTarget++){
                if((++evalSteps % 32) === 0 && (Date.now() - lastYieldAt >= 16)){
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
                      this.limitCalls = this.getAdaptiveLimitCalls(2000, 3500);
                      ok = this.randomSwap(occAct.id, 0);
                    }

                    if(ok && this.countTotalStudentHoles() === 0){
                      const m = this.evaluateMetrics();
                      if(this.compareMetrics(m, currentBest, mode) < 0){
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
                      if(this.compareMetrics(m, currentBest, mode) < 0){
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

    async tryIntraClassGapCrush(bestMetrics, onProgress = null, mode = "optimize_gap2"){
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
                  if((++evalSteps % 32) === 0 && (Date.now() - lastYieldAt >= 16)){
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
                          if(this.compareMetrics(m, currentBest, mode) < 0){
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

    async tryCrossDayClassSwap(bestMetrics, onProgress = null, mode = "optimize_gap2"){
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
                if((++evalSteps % 32) === 0 && (Date.now() - lastYieldAt >= 16)){
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
                    if(this.compareMetrics(mNew, currentBest, mode) < 0){
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

    async tryIntraSessionBlockPermutations(bestMetrics, onProgress = null, mode = "optimize_gap2"){
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
                if((++evalSteps % 32) === 0 && (Date.now() - lastYieldAt >= 16)){
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
                  if(this.compareMetrics(mNew, currentBest, mode) < 0){
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

    preserveOccupiedIncumbentOffSlots(){
      if(this.options?.preserveOccupiedOffSlots !== true) return;
      for(const act of this.activities || []){
        const start = Number(this.actPlacement?.[act.id]);
        if(!Number.isFinite(start) || start < 0) continue;
        const duration = Math.max(1, Number(act.duration) || 1);
        for(let offset = 0; offset < duration; offset++){
          this.offSlots?.delete(`${act.classId}|${start + offset}`);
        }
      }
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
      this.preserveOccupiedIncumbentOffSlots();
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

      if(mode === "run_until_zero_singletons" || mode === "run_until_stagnation" || mode === "deep_singletons"){
        return this.runUntilZeroSingletons({ onProgress, ...this.options });
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

      if(this.actPlacement.length > 0 && this.actPlacement.some(p => p < 0)){
        return {
          ok: false,
          applied: false,
          failureKind: "fet_optimize_requires_complete_schedule",
          diagnostics: this.constraintPreflight
        };
      }
      if(placedTotal === 0 && totalRequired > 0){
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

      // Vong doi khoa "1 tiet/buoi" (chi tiet o compareMetrics).
      // Muc tieu la 0, hoac san cau truc da duoc chung minh khi 0 la bat kha
      // thi. Lich vao day da dat muc tieu -> khoa ngay, moi mode phia sau
      // (Buoi / 2 tiet trong / 1 tiet trong) deu khong duoc lam no tang lai.
      // Luoi an toan cuoi luot: chup trang thai vao truoc khi tim kiem. Neu vi
      // bat ky ly do nao (compactAllStudentSessions chay ngoai cong so sanh,
      // mot operator moi, hay mot pha danh doi khong tra duoc no) ma luot nay
      // ket thuc voi NHIEU buoi 1 tiet hon luc bat dau, tra lai nguyen trang.
      // Day la bat bien duoc kiem tra o dau ra, khong phu thuoc vao viec tung
      // operator co tu giac hay khong.
      const entrySnapshot = this.captureStateSnapshot();

      const singletonFloor = Math.max(0, Number(
        this.constraintPreflight?.structuralFloor?.metricLowerBounds?.soBuoiDay1 || 0
      ));
      this.singletonLock = initialMetrics.soBuoiDay1 <= singletonFloor
        ? initialMetrics.soBuoiDay1
        : null;
      // Che do danh doi chi bat khi NGUOI DUNG bam lenh "1 tiet/buoi" tren menu
      // Toi uu (phanmon.js dat `singletonRush: true`).
      // KHONG duoc suy ra tu mode: pipeline tron goi trong tkb-fet-worker.js
      // cung goi optimize('optimize_singletons'), nhung no da co co che danh doi
      // rieng va co ky luat hon (`allowSingletonGap2Tradeoff` + tradeoffSnapshot
      // rollback quanh dong 542-594). Bat rush o day se de len co che do.
      this.singletonRushActive = mode === "optimize_singletons"
        && this.singletonLock === null
        && this.options?.singletonRush === true;
      const rushEngagedThisRun = this.singletonRushActive;
      // Khi khoa da dong, bat cong dat tiet cua FET: randomSwap uu tien cac o
      // KHONG mo them mot buoi khong du 2 tiet (opensUnaffordableSession) va
      // xep hang o theo do "bam cum" cua giao vien. Nho vay "khong lam tang
      // 1 tiet/buoi" duoc chan ngay luc dat tiet, chu khong chi bi bat lai o
      // buoc so sanh metrics sau khi da di mot nuoc hong.
      // Chi NANG cong len, khong bao gio ha xuong: mot engine vua chay solve()
      // xong co the dang bat san cong nay, va tat di se doi hanh vi cua duong
      // xep tron goi.
      if(this.singletonLock !== null) this.minTwoGuardActive = true;

      const isDeep = Boolean(this.options?.deepCycles || this.options?.deepLocalFet);
      let budget = Number(this.options?.optimizeTimeBudgetMs || this.options?.timeBudgetMs || this.timeBudgetMs);
      const hasExplicitBudget = Number.isFinite(Number(this.options?.optimizeTimeBudgetMs)) && Number(this.options.optimizeTimeBudgetMs) > 0 ||
        Number.isFinite(Number(this.options?.timeBudgetMs)) && Number(this.options.timeBudgetMs) > 0;
      if(isDeep && (!budget || budget <= 12000) && !hasExplicitBudget){
        budget = 30000;
      } else if(!budget){
        budget = 12000;
      }
      this.deadlineAtMs = Date.now() + budget;

      let maxRounds = mode === "optimize_singletons" ? 8 : (mode === "optimize_all" ? 6 : 5);
      if(this.options?.deepCycles){
        maxRounds = Math.max(maxRounds, Math.min(20, Number(this.options.deepCycles) || 8));
      } else if(this.options?.deepLocalFet){
        maxRounds = Math.max(maxRounds, 12);
      } else if(this.options?.maxRounds){
        maxRounds = Math.max(maxRounds, Number(this.options.maxRounds));
      }
      const MAX_ROUNDS = maxRounds;
      const useSessionBinChains = Boolean(this.options?.deepLocalFet || this.options?.deepCycles || this.options?.sessionBinChains);
      for(let r = 0; r < MAX_ROUNDS; r++){
        if(Date.now() >= this.deadlineAtMs) break;
        let anyRoundImprovement = false;

        if(mode === "optimize_all" || mode === "optimize_singletons"){
          if(useSessionBinChains){
            const resSessionFirst = await this.trySessionFirstSingletonSearch(bestMetrics, onProgress);
            if(resSessionFirst){ bestMetrics = resSessionFirst; anyRoundImprovement = true; }
            if(mode === "optimize_singletons" && bestMetrics.soBuoiDay1 <= targetMetricLowerBound) break;
          }
          const resPair = await this.tryPairClassSingletons(bestMetrics, onProgress);
          if(resPair){ bestMetrics = resPair; anyRoundImprovement = true; }
          const resCross = await this.tryCrossDayPairShift(bestMetrics, onProgress);
          if(resCross){ bestMetrics = resCross; anyRoundImprovement = true; }
          if(useSessionBinChains){
            const resSessionBins = await this.trySessionBinAugmentingChains(bestMetrics, onProgress);
            if(resSessionBins){ bestMetrics = resSessionBins; anyRoundImprovement = true; }
          }
          if(useSessionBinChains){
            const resRepack = await this.tryRepackSingletonComponents(bestMetrics, onProgress);
            if(resRepack){ bestMetrics = resRepack; anyRoundImprovement = true; }
          }
          const resDonorChain = await this.tryTeacherDonorAugmentingChains(bestMetrics, onProgress);
          if(resDonorChain){ bestMetrics = resDonorChain; anyRoundImprovement = true; }
          const res0 = await this.tryTargetedIntraClassSingletonCrusher(bestMetrics, onProgress);
          if(res0){ bestMetrics = res0; anyRoundImprovement = true; }
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
          const res3e = await this.trySingletonEjectionChains(bestMetrics, onProgress);
          if(res3e){ bestMetrics = res3e; anyRoundImprovement = true; }
        }

        if(mode === "optimize_all" || mode === "optimize_gap2" || mode === "optimize_gap1"){
          // Truoc 22/08 ca bon operator deu so sanh cung "optimize_gap2", nen
          // nut "1 tiet trong" that ra chay bo toi uu cua gap-2 va bo qua dung
          // nhung buoi chi co 1 lo ma no nham toi.
          const gapMode = mode === "optimize_gap1" ? "optimize_gap1" : "optimize_gap2";
          const res4 = await this.tryCrushGaps(bestMetrics, onProgress, gapMode);
          if(res4){ bestMetrics = res4; anyRoundImprovement = true; }
          const res4b = await this.tryIntraClassGapCrush(bestMetrics, onProgress, gapMode);
          if(res4b){ bestMetrics = res4b; anyRoundImprovement = true; }
          const res4c = await this.tryCrossDayClassSwap(bestMetrics, onProgress, gapMode);
          if(res4c){ bestMetrics = res4c; anyRoundImprovement = true; }
          const res4d = await this.tryIntraSessionBlockPermutations(bestMetrics, onProgress, gapMode);
          if(res4d){ bestMetrics = res4d; anyRoundImprovement = true; }
        }

        if(mode === "optimize_all" || mode === "optimize_sessions"){
          const res5 = await this.tryVacateTeacherSessions(bestMetrics, onProgress);
          if(res5){ bestMetrics = res5; anyRoundImprovement = true; }
        }

        // compactAllStudentSessions() chay NGOAI cong compareMetrics: no doi lich
        // de khu lo cua hoc sinh va co the vo tinh tach ra buoi giao vien chi con
        // 1 tiet. Vi ngay sau do bestMetrics duoc lay lai tu evaluateMetrics(),
        // moi thiet hai o day tro thanh nen mong cua vong sau — tich luy qua
        // nhieu vong thi 1 tiet/buoi leo len thay vi giam. Neu truoc khi nen lich
        // hoc sinh da khong con lo thi viec nen la tuy chon, nen hoan tac duoc.
        const holesBeforeCompact = this.countTotalStudentHoles();
        const compactSnapshot = holesBeforeCompact === 0 ? this.captureStateSnapshot() : null;
        const singletonsBeforeCompact = bestMetrics.soBuoiDay1;
        this.compactAllStudentSessions();
        bestMetrics = this.evaluateMetrics();
        if(compactSnapshot && bestMetrics.soBuoiDay1 > singletonsBeforeCompact){
          this.restoreStateSnapshot(compactSnapshot);
          bestMetrics = this.evaluateMetrics();
        }

        // Vua cham muc tieu 1 tiet/buoi -> KHOA lai va tat che do danh doi.
        // Tu day tro di khong nuoc di nao (ke ca cua cac pha sau) duoc phep
        // sinh lai mot buoi giao vien chi day 1 tiet.
        if(this.singletonLock === null && bestMetrics.soBuoiDay1 <= singletonFloor){
          this.singletonLock = bestMetrics.soBuoiDay1;
          this.singletonRushActive = false;
          this.minTwoGuardActive = true;
        }

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

        // Nut "1 tiet/buoi" cham dich thi dung ngay: cac chi so con lai la viec
        // cua ba nut kia, khong tieu them ngan sach o day.
        if(mode === "optimize_singletons" && this.singletonLock !== null){
          break;
        }

        if(bestMetrics[targetMetricKey] <= targetMetricLowerBound && bestMetrics.soBuoiDay1 === 0){
          break;
        }

        if(!anyRoundImprovement){
          // If still have singletons, do an ILS push cycle with higher depth
          if((mode === "optimize_all" || mode === "optimize_singletons") && bestMetrics.soBuoiDay1 > 0 && r < MAX_ROUNDS - 1){
            const deepPair = await this.tryPairClassSingletons(bestMetrics, onProgress);
            if(deepPair){
              bestMetrics = deepPair;
              anyRoundImprovement = true;
            } else {
              const deepCross = await this.tryCrossDayPairShift(bestMetrics, onProgress);
              if(deepCross){
                bestMetrics = deepCross;
                anyRoundImprovement = true;
              } else {
                const deepRes = await this.tryClosedPushCycles(bestMetrics, onProgress, 4);
                if(deepRes){
                  bestMetrics = deepRes;
                  anyRoundImprovement = true;
                }
              }
            }
          }
          if(!anyRoundImprovement) break;
        }
      }

      // (GO BO 17/08 — theo chi dao chu du an) Buoc "KHOA CUNG gap2=0 moi tra
      // lich" cu goi this.optimize() NGAY TRONG solve() ma chua applyToDataTKB
      // -> loadExistingSchedule cua optimize nap lai luoi CHI CON O CO DINH va
      // VUT TOAN BO lich vua xep (chinh la loi "287/287"/"360/360" tren app).
      // Nguyen tac moi: solve() CHI lo xep DU 100% (khong du cho thi lap toi
      // da, phan du tra ve Chua phan); chat luong gap2/1t-buoi la viec cua
      // pipeline toi uu (Tron goi/NEW) chay SAU khi lich da ap.

      // (22/08) O day tung co dong `this.__minTwoGuardActive = false;` — mot
      // thuoc tinh KHONG ai doc (co that la `minTwoGuardActive`), tuc la dead
      // code. KHONG duoc "sua" no thanh lenh tat co that: pipeline tron goi
      // trong tkb-fet-worker.js goi lien tiep optimize('optimize_singletons')
      // -> optimize('optimize_gap2') -> runUntilZeroSingletons() tren CUNG mot
      // engine, va cac pha sau dua vao cong min-2 van con bat tu solve(). Tat
      // no o cuoi luot dau tien lam cac pha sau tu do mo lai buoi 1 tiet.
      // Da xoa dong dead code; cong chi duoc NANG len, khong bao gio ha xuong.
      // Che do danh doi chi song trong mot luot optimize(); singletonLock duoc
      // giu lai vi no mo ta mot bat bien lich da dat duoc.
      this.singletonRushActive = false;

      const entrySingletons = Number(initialMetrics.soBuoiDay1 || 0);
      const entryUnplaced = Number(initialMetrics.unplacedCount || 0);
      let singletonRegressionReverted = false;
      let rushRolledBack = false;

      if(Number(bestMetrics.soBuoiDay1 || 0) > entrySingletons
        || Number(bestMetrics.unplacedCount || 0) > entryUnplaced){
        this.restoreStateSnapshot(entrySnapshot);
        bestMetrics = this.evaluateMetrics();
        singletonRegressionReverted = true;
      }else if(rushEngagedThisRun && Number(bestMetrics.soBuoiDay1 || 0) >= entrySingletons){
        // Che do danh doi duoc phep tang tong buoi va tiet trong — nhung LY DO
        // duy nhat de chap nhan thiet hai do la ha duoc 1 tiet/buoi. Neu het
        // luot ma chi so do khong giam, thiet hai la vo ich: tra lai nguyen
        // trang thay vi de nguoi dung ganh mot lich Trong-2 xau hon ma khong
        // duoc gi. (Khong co buoc nay, bam lai nhieu lan se tich luy thiet hai.)
        this.restoreStateSnapshot(entrySnapshot);
        bestMetrics = this.evaluateMetrics();
        rushRolledBack = true;
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
        singletonRegressionReverted,
        rushRolledBack,
        residualSingletons: bestMetrics.soBuoiDay1 > 0 ? this.explainResidualSingletons() : [],
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

    async runUntilZeroSingletons(options = {}){
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

      if(this.actPlacement.length > 0 && this.actPlacement.some(p => p < 0)){
        return {
          ok: false,
          applied: false,
          failureKind: "fet_optimize_requires_complete_schedule",
          diagnostics: this.constraintPreflight
        };
      }
      if(placedTotal === 0 && totalRequired > 0){
        return {
          ok: false,
          applied: false,
          failureKind: "fet_optimize_requires_complete_schedule",
          diagnostics: this.constraintPreflight
        };
      }

      const initialMetrics = this.evaluateMetrics();
      let bestMetrics = { ...initialMetrics };
      const targetMetricKey = "soBuoiDay1";
      const targetMetricLowerBound = Number(this.constraintPreflight?.structuralFloor?.metricLowerBounds?.soBuoiDay1 || 0);
      // Cung luoi an toan nhu optimize(): ham nay nam tren duong ▶ Xep va truoc
      // day khong co bat ky rang buoc dau-ra nao, nen mot luot khong may van co
      // the tra ve lich nhieu buoi 1 tiet hon luc vao.
      const entrySnapshot = this.captureStateSnapshot();

      const maxPasses = Number(options?.maxPasses) || 15;
      const stagnationThreshold = Number(options?.stagnationThreshold) || 3;
      let budget = Number(options?.timeBudgetMs || this.options?.timeBudgetMs || this.options?.optimizeTimeBudgetMs || this.timeBudgetMs);
      if(!budget || budget <= 0) budget = 35000;
      this.deadlineAtMs = Date.now() + budget;

      const onProgress = options?.onProgress || null;

      if(bestMetrics.soBuoiDay1 <= targetMetricLowerBound){
        // (22/08) O day tung co dong `this.__minTwoGuardActive = false;` — mot
      // thuoc tinh KHONG ai doc (co that la `minTwoGuardActive`), tuc la dead
      // code. KHONG duoc "sua" no thanh lenh tat co that: pipeline tron goi
      // trong tkb-fet-worker.js goi lien tiep optimize('optimize_singletons')
      // -> optimize('optimize_gap2') -> runUntilZeroSingletons() tren CUNG mot
      // engine, va cac pha sau dua vao cong min-2 van con bat tu solve(). Tat
      // no o cuoi luot dau tien lam cac pha sau tu do mo lai buoi 1 tiet.
      // Da xoa dong dead code; cong chi duoc NANG len, khong bao gio ha xuong.
        this.applyToDataTKB();
        if(typeof onProgress === "function"){
          onProgress({
            pass: 0,
            maxPasses,
            percent: 100,
            currentMetric: bestMetrics.soBuoiDay1,
            initialMetric: initialMetrics.soBuoiDay1,
            stage: "zero_singletons",
            metrics: bestMetrics
          });
        }
        return {
          ok: true,
          applied: true,
          targetMetric: targetMetricKey,
          targetMetricKey,
          targetMetricLowerBound,
          targetReached: true,
          floorReached: true,
          initialMetrics,
          metrics: bestMetrics,
          passes: 0,
          placed: this.activities.length,
          unassigned: 0,
          diagnostics: this.constraintPreflight
        };
      }

      let stagnantPasses = 0;
      let prevSingletons = bestMetrics.soBuoiDay1;
      let completedPasses = 0;
      const useSessionBinChains = Boolean(this.options?.deepLocalFet || this.options?.deepCycles || this.options?.sessionBinChains);
      const needsSingletons = () =>
        bestMetrics.soBuoiDay1 > targetMetricLowerBound &&
        (!this.deadlineAtMs || Date.now() < this.deadlineAtMs) &&
        !this.isCancelled;
      const runSingletonOperator = async operator =>
        needsSingletons() ? await operator() : null;

      for(let pass = 1; pass <= maxPasses; pass++){
        if(Date.now() >= this.deadlineAtMs || this.isCancelled) break;
        completedPasses = pass;
        let anyPassImprovement = false;

        // Stage 1: Singleton elimination operators
        if(useSessionBinChains){
          const resSessionFirst = await this.trySessionFirstSingletonSearch(bestMetrics, onProgress);
          if(resSessionFirst){ bestMetrics = resSessionFirst; anyPassImprovement = true; }
          if(bestMetrics.soBuoiDay1 <= targetMetricLowerBound) break;
        }

        const resPair = await runSingletonOperator(() => this.tryPairClassSingletons(bestMetrics, onProgress));
        if(resPair){ bestMetrics = resPair; anyPassImprovement = true; }

        const resCross = await runSingletonOperator(() => this.tryCrossDayPairShift(bestMetrics, onProgress));
        if(resCross){ bestMetrics = resCross; anyPassImprovement = true; }

        if(useSessionBinChains){
          const resSessionBins = await runSingletonOperator(() => this.trySessionBinAugmentingChains(bestMetrics, onProgress));
          if(resSessionBins){ bestMetrics = resSessionBins; anyPassImprovement = true; }
        }

        if(useSessionBinChains){
          const resRepack = await runSingletonOperator(() => this.tryRepackSingletonComponents(bestMetrics, onProgress));
          if(resRepack){ bestMetrics = resRepack; anyPassImprovement = true; }
        }

        const resDonorChain = await runSingletonOperator(() => this.tryTeacherDonorAugmentingChains(bestMetrics, onProgress));
        if(resDonorChain){ bestMetrics = resDonorChain; anyPassImprovement = true; }

        const resCrush = await runSingletonOperator(() => this.tryTargetedIntraClassSingletonCrusher(bestMetrics, onProgress));
        if(resCrush){ bestMetrics = resCrush; anyPassImprovement = true; }

        const resEject = await runSingletonOperator(() => this.trySingletonEjectionChains(bestMetrics, onProgress));
        if(resEject){ bestMetrics = resEject; anyPassImprovement = true; }

        const resPush = await runSingletonOperator(() => this.tryClosedPushCycles(bestMetrics, onProgress, 2));
        if(resPush){ bestMetrics = resPush; anyPassImprovement = true; }

        const resReloc = await runSingletonOperator(() => this.tryRelocateSingletons(bestMetrics, onProgress));
        if(resReloc){ bestMetrics = resReloc; anyPassImprovement = true; }

        const resShare = await runSingletonOperator(() => this.tryShareRichToSingleton(bestMetrics, onProgress));
        if(resShare){ bestMetrics = resShare; anyPassImprovement = true; }

        const resRelabel = await runSingletonOperator(() => this.trySingletonRelabelCycles(bestMetrics, onProgress));
        if(resRelabel){ bestMetrics = resRelabel; anyPassImprovement = true; }

        const resSwap = await runSingletonOperator(() => this.tryIntraClassSingletonSwap(bestMetrics, onProgress));
        if(resSwap){ bestMetrics = resSwap; anyPassImprovement = true; }

        const resKempe = await runSingletonOperator(() => this.tryCrossClassSingletonKempeSwap(bestMetrics, onProgress));
        if(resKempe){ bestMetrics = resKempe; anyPassImprovement = true; }

        // Stage 2 is deliberately locked behind the primary objective. A
        // timetable with singleton debt must not spend a pass polishing gaps.
        if(bestMetrics.soBuoiDay1 <= targetMetricLowerBound){
          const resGaps = await this.tryCrushGaps(bestMetrics, onProgress);
          if(resGaps){ bestMetrics = resGaps; anyPassImprovement = true; }

          const resIntraGap = await this.tryIntraClassGapCrush(bestMetrics, onProgress);
          if(resIntraGap){ bestMetrics = resIntraGap; anyPassImprovement = true; }

          const resCrossClass = await this.tryCrossDayClassSwap(bestMetrics, onProgress);
          if(resCrossClass){ bestMetrics = resCrossClass; anyPassImprovement = true; }

          const resPerms = await this.tryIntraSessionBlockPermutations(bestMetrics, onProgress);
          if(resPerms){ bestMetrics = resPerms; anyPassImprovement = true; }
        }

        this.compactAllStudentSessions();
        bestMetrics = this.evaluateMetrics();

        if(typeof onProgress === "function"){
          onProgress({
            pass,
            maxPasses,
            percent: Math.round((pass / maxPasses) * 100),
            currentMetric: bestMetrics.soBuoiDay1,
            initialMetric: initialMetrics.soBuoiDay1,
            stage: "deep_singletons",
            metrics: bestMetrics
          });
        }

        await new Promise(resolve => setTimeout(resolve, 0));

        if(bestMetrics.soBuoiDay1 <= targetMetricLowerBound){
          break;
        }

        if(bestMetrics.soBuoiDay1 < prevSingletons || anyPassImprovement){
          stagnantPasses = 0;
          prevSingletons = bestMetrics.soBuoiDay1;
        } else {
          stagnantPasses++;
          // Stagnation pass 1: ILS perturbation kick
          if(stagnantPasses === 1 && bestMetrics.soBuoiDay1 > targetMetricLowerBound && pass < maxPasses && needsSingletons()){
            const deepPair = await runSingletonOperator(() => this.tryPairClassSingletons(bestMetrics, onProgress));
            if(deepPair){
              bestMetrics = deepPair;
              stagnantPasses = 0;
              prevSingletons = bestMetrics.soBuoiDay1;
            } else {
              const deepCross = await runSingletonOperator(() => this.tryCrossDayPairShift(bestMetrics, onProgress));
              if(deepCross){
                bestMetrics = deepCross;
                stagnantPasses = 0;
                prevSingletons = bestMetrics.soBuoiDay1;
              } else {
                const deepRes = await runSingletonOperator(() => this.tryClosedPushCycles(bestMetrics, onProgress, 4));
                if(deepRes){
                  bestMetrics = deepRes;
                  stagnantPasses = 0;
                  prevSingletons = bestMetrics.soBuoiDay1;
                }
              }
            }
          }

          if(stagnantPasses >= stagnationThreshold){
            break;
          }
        }
      }

      // (22/08) O day tung co dong `this.__minTwoGuardActive = false;` — mot
      // thuoc tinh KHONG ai doc (co that la `minTwoGuardActive`), tuc la dead
      // code. KHONG duoc "sua" no thanh lenh tat co that: pipeline tron goi
      // trong tkb-fet-worker.js goi lien tiep optimize('optimize_singletons')
      // -> optimize('optimize_gap2') -> runUntilZeroSingletons() tren CUNG mot
      // engine, va cac pha sau dua vao cong min-2 van con bat tu solve(). Tat
      // no o cuoi luot dau tien lam cac pha sau tu do mo lai buoi 1 tiet.
      // Da xoa dong dead code; cong chi duoc NANG len, khong bao gio ha xuong.
      let singletonRegressionReverted = false;
      if(Number(bestMetrics.soBuoiDay1 || 0) > Number(initialMetrics.soBuoiDay1 || 0)
        || Number(bestMetrics.unplacedCount || 0) > Number(initialMetrics.unplacedCount || 0)){
        this.restoreStateSnapshot(entrySnapshot);
        bestMetrics = this.evaluateMetrics();
        singletonRegressionReverted = true;
      }
      this.applyToDataTKB();
      const currentVal = bestMetrics.soBuoiDay1;
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
        singletonRegressionReverted,
        residualSingletons: bestMetrics.soBuoiDay1 > 0 ? this.explainResidualSingletons() : [],
        passes: completedPasses,
        placed: this.activities.length,
        unassigned: 0,
        diagnostics: this.constraintPreflight
      };
    }

    async runUntilStagnation(options = {}){
      return this.runUntilZeroSingletons(options);
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

      // CHONG VANG TIET (13.1): tiet nap tu lich cu ma den gio van chua dat lai
      // duoc -> tra NGUYEN VAN o goc cua no (neu o do con trong) thay vi de trong.
      // Nguoi dung khong bao gio bi "mat" tiet chi vi bam Toi uu.
      this.activities.forEach(act => {
        if(this.actPlacement[act.id] >= 0) return;
        if(!(act.initSlot >= 0) || !act.initRaw) return;
        const cells = [{ s: act.initSlot, raw: act.initRaw }];
        if(act.duration === 2 && act.initRaw2) cells.push({ s: act.initSlot + 1, raw: act.initRaw2 });
        for(const c of cells){
          const d = slotToDetails(c.s);
          const key = `${act.classId}|${c.s}`;
          if(this.fixedRawCells.has(key) || this.offSlots.has(key)) continue;
          const row = data.tkb[act.classId]?.[d.thu]?.[d.buoi];
          if(!Array.isArray(row)) continue;
          const cur = row[d.periodIdx];
          if(cur == null || cur === ""){ row[d.periodIdx] = c.raw; }
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
