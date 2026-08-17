(function(root, factory){
  "use strict";
  const api = factory();
  if(typeof module === "object" && module.exports) module.exports = api;
  if(root) root.TKBFastSeed = api;
})(typeof window !== "undefined" ? window : globalThis, function(){
  "use strict";

  const VERSION = "tkb-fast-seed-v1";
  const DEFAULT_DAYS = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
  const SESSION_KEYS = ["sang", "chieu"];

  function text(value){ return String(value == null ? "" : value).trim(); }
  function number(value, fallback = 0){
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  function normalized(value){
    return text(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("vi");
  }
  function resourceKey(value){
    return text(value).replace(/\s+/g, " ").toLocaleLowerCase("vi");
  }
  function truthy(value){
    if(value === true || value === 1) return true;
    return ["1", "true", "yes", "on"].includes(text(value).toLowerCase());
  }
  function cellSubject(value){
    if(!value || value === "OFF") return "";
    if(typeof value === "string") return text(value);
    return text(value.mon || value.subject || value.ten);
  }
  function isFixed(value){ return !!(value && typeof value === "object" && value.fixed === true); }
  function splitAssignmentKey(raw){
    const key = text(raw);
    const index = key.indexOf("|");
    return index > 0 ? [key.slice(0, index), key.slice(index + 1)] : ["", ""];
  }
  function dayNumber(day){
    const match = text(day).match(/(\d+)/);
    return match ? Math.max(2, Math.min(7, Number(match[1]))) : 0;
  }
  function slotKey(day, session, index){ return `${day}|${session}|${index}`; }
  function userOffKey(value){
    if(typeof value === "string") return text(value);
    if(!value || typeof value !== "object") return "";
    const rawDay = text(value.thu || value.day);
    const day = rawDay.startsWith("thu") ? rawDay : (dayNumber(rawDay) ? `thu${dayNumber(rawDay)}` : "");
    const rawSession = text(value.buoi || value.session).toLowerCase();
    const session = rawSession === "am" || rawSession === "sang" ? "sang"
      : rawSession === "pm" || rawSession === "chieu" ? "chieu" : "";
    const rawIndex = value.ti ?? value.index ?? value.period;
    const parsed = Number(rawIndex);
    if(!day || !session || !Number.isFinite(parsed)) return "";
    const index = value.period != null && value.ti == null && value.index == null
      ? Math.max(0, Math.round(parsed) - 1)
      : Math.max(0, Math.round(parsed));
    return slotKey(day, session, index);
  }
  function occupiedKey(name, day, session, index){
    return `${text(name)}|${day}|${session}|${index}`;
  }
  function mulberry32(seed){
    let state = (Number(seed) || 1) >>> 0;
    return function(){
      state += 0x6D2B79F5;
      let value = state;
      value = Math.imul(value ^ value >>> 15, value | 1);
      value ^= value + Math.imul(value ^ value >>> 7, value | 61);
      return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
  }
  function shuffled(items, rng){
    const out = items.slice();
    for(let index = out.length - 1; index > 0; index -= 1){
      const swap = Math.floor(rng() * (index + 1));
      [out[index], out[swap]] = [out[swap], out[index]];
    }
    return out;
  }

  function subjectGroups(data){
    const aliases = new Map();
    const canonical = new Map();
    const aliasesBySubject = new Map();
    for(const row of Array.isArray(data?.monhoc) ? data.monhoc : []){
      const subject = text(row?.ten || row?.ma || row?.ma2 || row?.id);
      const group = text(row?.id) || normalized(subject);
      if(!subject) continue;
      if(!aliasesBySubject.has(subject)) aliasesBySubject.set(subject, new Set());
      for(const alias of [row?.id, row?.ma, row?.ma2, row?.ten]){
        const key = normalized(alias);
        if(!key) continue;
        aliases.set(key, group);
        canonical.set(key, subject);
        aliasesBySubject.get(subject).add(text(alias));
      }
    }
    return {
      aliases,
      group(subject){ return aliases.get(normalized(subject)) || `raw:${normalized(subject)}`; },
      subject(subject){ return canonical.get(normalized(subject)) || text(subject); },
      subjectAliases(subject){
        const canonicalSubject = canonical.get(normalized(subject)) || text(subject);
        return [...(aliasesBySubject.get(canonicalSubject) || []), text(subject), canonicalSubject]
          .map(text)
          .filter(Boolean);
      }
    };
  }

  function gradeNumber(value){
    const match = text(value).match(/\d+/);
    return match ? Number(match[0]) : 0;
  }

  function matrixLookup(matrix, classInfo, subjectAliases, normalizedValues){
    if(!matrix || typeof matrix !== "object") return undefined;
    for(const classAlias of classInfo.aliases){
      for(const subjectAlias of subjectAliases){
        const key = `${classAlias}|${subjectAlias}`;
        if(Object.prototype.hasOwnProperty.call(matrix, key)) return matrix[key];
      }
    }
    const normalizedMatrix = normalizedValues || new Map(
      Object.entries(matrix).map(([key, value]) => [normalized(key), value])
    );
    for(const classAlias of classInfo.aliases){
      for(const subjectAlias of subjectAliases){
        const value = normalizedMatrix.get(normalized(`${classAlias}|${subjectAlias}`));
        if(value !== undefined) return value;
      }
    }
    return undefined;
  }

  function buildModel(data){
    const classes = Array.isArray(data?.lop) ? data.lop : [];
    const classAliases = new Map();
    const classById = new Map();
    for(const row of classes){
      const id = text(row?.id || row?.ma || row?.ten);
      if(!id) continue;
      const item = {
        id,
        name:text(row?.ten || row?.ten2 || id),
        grade:text(row?.khoi || row?.grade),
        aliases:[row?.id, row?.ma, row?.ten, row?.ten2].map(text).filter(Boolean)
      };
      classById.set(id, item);
      for(const alias of [id, row?.ten, row?.ten2, row?.ma]){
        const key = normalized(alias);
        if(key) classAliases.set(key, item);
      }
    }
    const subjects = subjectGroups(data || {});
    const teacherAliases = new Map();
    for(const row of Array.isArray(data?.giaovien) ? data.giaovien : []){
      const canonicalTeacher = text(row?.magv || row?.ma || row?.code || row?.id || row?.ten);
      const fullName = `${text(row?.hodem)} ${text(row?.ten)}`.trim();
      const names = [row?.id, row?.ma, row?.magv, row?.magv2, row?.ten, fullName];
      const values = names.map(text).filter(Boolean);
      for(const alias of values){
        teacherAliases.set(resourceKey(alias), {canonical:canonicalTeacher || alias, aliases:values});
      }
    }
    const roomAliases = new Map();
    for(const row of Array.isArray(data?.phong) ? data.phong : []){
      const names = [row?.id, row?.ma, row?.ten].map(text).filter(Boolean);
      const canonicalRoom = text(row?.ma || row?.id || row?.ten);
      for(const alias of names){
        roomAliases.set(resourceKey(alias), {canonical:canonicalRoom || alias, aliases:names});
      }
    }
    const teacherRows = data?.pccmMatrix && typeof data.pccmMatrix === "object"
      ? data.pccmMatrix
      : {};
    const periodRows = data?.pccmTietMatrix && typeof data.pccmTietMatrix === "object"
      ? data.pccmTietMatrix
      : {};
    const roomRows = data?.pccmRoomMatrix && typeof data.pccmRoomMatrix === "object"
      ? data.pccmRoomMatrix
      : {};
    const limitRows = data?.pccmGioihanMatrix && typeof data.pccmGioihanMatrix === "object"
      ? data.pccmGioihanMatrix
      : {};
    const matrixIndexes = new Map(
      [periodRows, roomRows, limitRows].map(matrix => [
        matrix,
        new Map(Object.entries(matrix).map(([matrixKey, value]) => [normalized(matrixKey), value]))
      ])
    );
    const assignments = [];
    const assignmentByClassGroup = new Map();
    const constraints = data?.tkbConstraints || {};
    const standards = Array.isArray(data?.mon) ? data.mon : [];
    const seenAssignments = new Set();
    for(const [key, rawTeacher] of Object.entries(teacherRows)){
      const [classAlias, subject] = splitAssignmentKey(key);
      const classInfo = classAliases.get(normalized(classAlias));
      const rawTeacherText = text(rawTeacher);
      if(!classInfo || !subject || !rawTeacherText) continue;
      const canonicalSubject = subjects.subject(subject);
      const subjectAliases = subjects.subjectAliases(subject);
      const standard = standards.find(row =>
        gradeNumber(row?.khoi || row?.grade) === gradeNumber(classInfo.grade)
        && subjects.group(row?.ten || row?.mon || row?.ma || row?.id) === subjects.group(subject)
      );
      const periods = Math.max(0, Math.round(number(
        matrixLookup(periodRows, classInfo, subjectAliases, matrixIndexes.get(periodRows)),
        number(standard?.sotiet || standard?.periods)
      )));
      const teacherInfo = teacherAliases.get(resourceKey(rawTeacherText));
      const teacher = text(teacherInfo?.canonical || rawTeacherText);
      if(periods <= 0 || !teacher) continue;
      const assignmentId = `${classInfo.id}|${subjects.group(subject)}|${teacher}`;
      if(seenAssignments.has(assignmentId)) continue;
      seenAssignments.add(assignmentId);
      const rawRoom = text(matrixLookup(roomRows, classInfo, subjectAliases, matrixIndexes.get(roomRows)));
      const roomInfo = roomAliases.get(resourceKey(rawRoom));
      const room = text(roomInfo?.canonical || rawRoom);
      const assignment = {
        key:assignmentId,
        classInfo,
        subject:canonicalSubject,
        subjectGroup:subjects.group(subject),
        teacher,
        teacherAliases:teacherInfo?.aliases || [teacher],
        room,
        roomAliases:roomInfo?.aliases || [room].filter(Boolean),
        periods,
        limit:Math.max(1, Math.round(number(
          matrixLookup(limitRows, classInfo, subjectAliases, matrixIndexes.get(limitRows)),
          number(standard?.gioihan || standard?.limit, 1)
        )))
      };
      assignment.offRules = [
        ...offRulesFor("teacher", assignment.teacherAliases, constraints),
        ...offRulesFor("room", assignment.roomAliases, constraints),
        ...offRulesFor("subject", [assignment.subject], constraints)
      ];
      assignments.push(assignment);
      assignmentByClassGroup.set(`${classInfo.id}|${assignment.subjectGroup}`, assignment);
    }
    const days = new Set(DEFAULT_DAYS);
    for(const schedule of Object.values(data?.tkb || {})){
      if(!schedule || typeof schedule !== "object") continue;
      Object.keys(schedule).forEach(day => { if(/^thu\d+$/i.test(day)) days.add(day); });
    }
    return {
      data,
      classes:[...classById.values()],
      assignments,
      assignmentByClassGroup,
      subjects,
      days:[...days].sort((left, right) => dayNumber(left) - dayNumber(right)),
      expectedPeriods:assignments.reduce((sum, item) => sum + item.periods, 0)
    };
  }

  function offRulesFor(scope, aliases, constraints){
    const root = constraints?.fixedOff?.[scope];
    if(!root || typeof root !== "object") return [];
    const out = [];
    for(const alias of aliases.map(text).filter(Boolean)){
      const direct = root[alias];
      if(direct && typeof direct === "object") out.push(direct);
      const normalizedAlias = normalized(alias);
      for(const [key, value] of Object.entries(root)){
        if(normalized(key) === normalizedAlias && value && typeof value === "object") out.push(value);
      }
    }
    return out;
  }

  function ruleBlocks(rules, key){
    return rules.some(rule => truthy(rule?.[key]));
  }

  function createBaseState(model){
    const constraints = model.data?.tkbConstraints || {};
    const grids = new Map();
    const fixedLessons = [];
    const fixedCounts = new Map();
    const teacherBusy = new Set();
    const roomBusy = new Set();
    const teacherSlots = new Map();
    const invalidReasons = [];

    function teacherSlotArray(teacher, day, session, length){
      const key = `${teacher}|${day}|${session}`;
      if(!teacherSlots.has(key)) teacherSlots.set(key, Array(length).fill(false));
      return teacherSlots.get(key);
    }
    function markLesson(assignment, day, session, index, fixed){
      const teacherKey = occupiedKey(assignment.teacher, day, session, index);
      const roomKey = assignment.room
        ? occupiedKey(assignment.room, day, session, index)
        : "";
      if((fixedCounts.get(assignment.key) || 0) >= assignment.periods){
        invalidReasons.push(`fixed_demand_overflow:${assignment.key}`);
        return null;
      }
      if(teacherBusy.has(teacherKey)){
        invalidReasons.push(`fixed_teacher_collision:${teacherKey}`);
        return null;
      }
      if(roomKey && roomBusy.has(roomKey)){
        invalidReasons.push(`fixed_room_collision:${roomKey}`);
        return null;
      }
      const lesson = {
        classId:assignment.classInfo.id,
        className:assignment.classInfo.name,
        grade:assignment.classInfo.grade,
        subject:assignment.subject,
        teacher:assignment.teacher,
        room:assignment.room,
        day:dayNumber(day),
        session:session === "sang" ? "AM" : "PM",
        period:index + 1,
        fixed:fixed === true
      };
      fixedLessons.push(lesson);
      teacherBusy.add(teacherKey);
      if(roomKey) roomBusy.add(roomKey);
      const slots = teacherSlotArray(assignment.teacher, day, session, Math.max(5, index + 1));
      while(slots.length <= index) slots.push(false);
      slots[index] = true;
      fixedCounts.set(assignment.key, (fixedCounts.get(assignment.key) || 0) + 1);
      return lesson;
    }

    for(const classInfo of model.classes){
      const source = model.data?.tkb?.[classInfo.id]
        || model.data?.tkb?.[classInfo.name]
        || {};
      const userOff = model.data?.tkbUserOff?.[classInfo.id]
        || model.data?.tkbUserOff?.[classInfo.name]
        || [];
      const userOffSet = new Set(
        Array.isArray(userOff)
          ? userOff.map(userOffKey).filter(Boolean)
          : Object.keys(userOff || {}).filter(key => truthy(userOff[key]))
      );
      const classRules = offRulesFor("class", [classInfo.id, classInfo.name], constraints);
      const classGrid = {};
      for(const day of model.days){
        classGrid[day] = {};
        for(const session of SESSION_KEYS){
          const raw = Array.isArray(source?.[day]?.[session]) ? source[day][session] : [];
          const length = Math.max(5, raw.length);
          const cells = Array(length).fill(null);
          for(let index = 0; index < length; index += 1){
            const key = slotKey(day, session, index);
            const value = raw[index];
            if(isFixed(value)){
              const group = model.subjects.group(cellSubject(value));
              const assignment = model.assignmentByClassGroup.get(`${classInfo.id}|${group}`);
              if(!assignment){
                invalidReasons.push(`fixed_unknown_assignment:${classInfo.id}|${cellSubject(value)}`);
                cells[index] = {blocked:true, fixed:true};
                continue;
              }
              const lesson = markLesson(assignment, day, session, index, true);
              cells[index] = lesson
                ? {lesson, assignment, fixed:true}
                : {blocked:true, fixed:true};
              continue;
            }
            if(userOffSet.has(key) || ruleBlocks(classRules, key)){
              cells[index] = {blocked:true};
            }
          }
          classGrid[day][session] = cells;
        }
      }
      grids.set(classInfo.id, classGrid);
    }
    return {grids, fixedLessons, fixedCounts, teacherBusy, roomBusy, teacherSlots, invalidReasons};
  }

  function teacherMetric(slots){
    const positions = [];
    for(let index = 0; index < slots.length; index += 1) if(slots[index]) positions.push(index);
    let gaps = 0;
    let gap2 = 0;
    for(let index = 1; index < positions.length; index += 1){
      const gap = positions[index] - positions[index - 1] - 1;
      gaps += Math.max(0, gap);
      if(gap >= 2) gap2 += 1;
    }
    return {count:positions.length, gaps, gap2};
  }

  function cloneState(base){
    const grids = new Map();
    for(const [classId, schedule] of base.grids){
      const next = {};
      for(const [day, sessions] of Object.entries(schedule)){
        next[day] = {};
        for(const session of SESSION_KEYS) next[day][session] = sessions[session].slice();
      }
      grids.set(classId, next);
    }
    return {
      grids,
      lessons:base.fixedLessons.slice(),
      fixedCounts:new Map(base.fixedCounts),
      teacherBusy:new Set(base.teacherBusy),
      roomBusy:new Set(base.roomBusy),
      teacherSlots:new Map([...base.teacherSlots].map(([key, slots]) => [key, slots.slice()]))
    };
  }

  function candidateQuality(lessons){
    const sessions = new Map();
    for(const lesson of lessons){
      const key = `${lesson.teacher}|${lesson.day}|${lesson.session}`;
      if(!sessions.has(key)) sessions.set(key, []);
      sessions.get(key).push(lesson.period);
    }
    let singleton = 0;
    let gap1 = 0;
    let gap2 = 0;
    let gapTotal = 0;
    for(const periods of sessions.values()){
      const ordered = [...new Set(periods)].sort((a, b) => a - b);
      if(ordered.length === 1) singleton += 1;
      for(let index = 1; index < ordered.length; index += 1){
        const gap = ordered[index] - ordered[index - 1] - 1;
        if(gap === 1) gap1 += 1;
        else if(gap >= 2) gap2 += 1;
        gapTotal += Math.max(0, gap);
      }
    }
    return {teacherSessions:sessions.size, singleton, gap1, gap2, gapTotal};
  }

  function betterCandidate(left, right){
    if(!right) return true;
    const leftMissing = Math.max(0, left.expectedPeriods - left.lessons.length);
    const rightMissing = Math.max(0, right.expectedPeriods - right.lessons.length);
    if(leftMissing !== rightMissing) return leftMissing < rightMissing;
    for(const key of ["singleton", "gap2", "teacherSessions", "gap1", "gapTotal"]){
      if(left.quality[key] !== right.quality[key]) return left.quality[key] < right.quality[key];
    }
    return false;
  }

  function buildAttempt(model, base, seed, deadline){
    const rng = mulberry32(seed);
    const state = cloneState(base);
    const subjectSessionCounts = new Map();
    const unassignedAssignments = [];
    for(const lesson of state.lessons){
      const day = `thu${lesson.day}`;
      const session = lesson.session === "AM" ? "sang" : "chieu";
      const key = `${lesson.classId}|${day}|${session}|${normalized(lesson.subject)}`;
      subjectSessionCounts.set(key, (subjectSessionCounts.get(key) || 0) + 1);
    }

    function assignmentBlocked(assignment, day, session, index){
      const key = slotKey(day, session, index);
      return ruleBlocks(assignment.offRules || [], key);
    }
    function teacherSlots(assignment, day, session, length){
      const key = `${assignment.teacher}|${day}|${session}`;
      if(!state.teacherSlots.has(key)) state.teacherSlots.set(key, Array(length).fill(false));
      const slots = state.teacherSlots.get(key);
      while(slots.length < length) slots.push(false);
      return slots;
    }
    function subjectSessionKey(assignment, day, session){
      return `${assignment.classInfo.id}|${day}|${session}|${normalized(assignment.subject)}`;
    }
    function markOccupied(assignment, day, session, index, occupied){
      const teacherKey = occupiedKey(assignment.teacher, day, session, index);
      if(occupied) state.teacherBusy.add(teacherKey);
      else state.teacherBusy.delete(teacherKey);
      if(assignment.room){
        const roomKey = occupiedKey(assignment.room, day, session, index);
        if(occupied) state.roomBusy.add(roomKey);
        else state.roomBusy.delete(roomKey);
      }
      const grid = state.grids.get(assignment.classInfo.id);
      const cells = grid?.[day]?.[session] || [];
      teacherSlots(assignment, day, session, cells.length)[index] = occupied;
    }
    function updateSubjectCount(assignment, day, session, delta){
      const key = subjectSessionKey(assignment, day, session);
      const next = Math.max(0, (subjectSessionCounts.get(key) || 0) + delta);
      if(next > 0) subjectSessionCounts.set(key, next);
      else subjectSessionCounts.delete(key);
      return key;
    }
    function canPlaceAt(assignment, day, session, index, options = {}){
      const grid = state.grids.get(assignment.classInfo.id);
      const cells = grid?.[day]?.[session] || [];
      if(index < 0 || index >= cells.length || cells[index] != null) return false;
      if(assignmentBlocked(assignment, day, session, index)) return false;
      if((subjectSessionCounts.get(subjectSessionKey(assignment, day, session)) || 0) >= assignment.limit) return false;
      if(!options.ignoreResources){
        if(state.teacherBusy.has(occupiedKey(assignment.teacher, day, session, index))) return false;
        if(assignment.room && state.roomBusy.has(occupiedKey(assignment.room, day, session, index))) return false;
      }
      return true;
    }
    function attachCell(cell, day, session, index){
      const assignment = cell.assignment;
      const grid = state.grids.get(assignment.classInfo.id);
      grid[day][session][index] = cell;
      cell.lesson.day = dayNumber(day);
      cell.lesson.session = session === "sang" ? "AM" : "PM";
      cell.lesson.period = index + 1;
      markOccupied(assignment, day, session, index, true);
      updateSubjectCount(assignment, day, session, 1);
    }
    function detachCell(ref){
      const assignment = ref.cell.assignment;
      const grid = state.grids.get(assignment.classInfo.id);
      if(grid?.[ref.day]?.[ref.session]?.[ref.index] !== ref.cell) return false;
      grid[ref.day][ref.session][ref.index] = null;
      markOccupied(assignment, ref.day, ref.session, ref.index, false);
      updateSubjectCount(assignment, ref.day, ref.session, -1);
      return true;
    }
    function placeNewLesson(assignment, day, session, index){
      if(!canPlaceAt(assignment, day, session, index)) return null;
      const lesson = {
        classId:assignment.classInfo.id,
        className:assignment.classInfo.name,
        grade:assignment.classInfo.grade,
        subject:assignment.subject,
        teacher:assignment.teacher,
        room:assignment.room,
        day:dayNumber(day),
        session:session === "sang" ? "AM" : "PM",
        period:index + 1
      };
      const cell = {lesson, assignment, fixed:false};
      state.lessons.push(lesson);
      attachCell(cell, day, session, index);
      return cell;
    }
    function blockersAt(assignment, day, session, index){
      const refs = [];
      const seen = new Set();
      for(const [classId, grid] of state.grids){
        const cell = grid?.[day]?.[session]?.[index];
        if(!cell?.lesson || seen.has(cell)) continue;
        const teacherHit = assignment.teacher && cell.assignment?.teacher === assignment.teacher;
        const roomHit = assignment.room && cell.assignment?.room === assignment.room;
        if(!teacherHit && !roomHit) continue;
        seen.add(cell);
        refs.push({cell, classId, day, session, index});
      }
      return refs;
    }
    function moveBlockerAside(ref, avoid){
      const cell = ref?.cell;
      const assignment = cell?.assignment;
      if(!assignment || cell.fixed === true) return null;
      if(!detachCell(ref)) return null;
      const grid = state.grids.get(assignment.classInfo.id);
      const candidates = [];
      for(const day of shuffled(model.days, rng)){
        for(const session of shuffled(SESSION_KEYS, rng)){
          const cells = grid?.[day]?.[session] || [];
          for(const index of shuffled(cells.map((_, cellIndex) => cellIndex), rng)){
            if(day === ref.day && session === ref.session && index === ref.index) continue;
            if(
              avoid
              && assignment.classInfo.id === avoid.classId
              && day === avoid.day
              && session === avoid.session
              && index === avoid.index
            ) continue;
            if(!canPlaceAt(assignment, day, session, index)) continue;
            const slots = teacherSlots(assignment, day, session, cells.length);
            const before = teacherMetric(slots);
            const afterSlots = slots.slice();
            afterSlots[index] = true;
            const after = teacherMetric(afterSlots);
            const score = (before.count > 0 ? 200_000 : -100_000)
              - after.gap2 * 500_000
              - after.gaps * 80_000
              + rng() * 10_000;
            candidates.push({day, session, index, score});
          }
        }
      }
      candidates.sort((left, right) => right.score - left.score);
      const destination = candidates[0];
      if(!destination){
        attachCell(cell, ref.day, ref.session, ref.index);
        return null;
      }
      attachCell(cell, destination.day, destination.session, destination.index);
      return function undoMove(){
        detachCell({
          cell,
          classId:assignment.classInfo.id,
          day:destination.day,
          session:destination.session,
          index:destination.index
        });
        attachCell(cell, ref.day, ref.session, ref.index);
      };
    }
    function tryRepairOne(assignment){
      const grid = state.grids.get(assignment.classInfo.id);
      const targets = [];
      for(const day of shuffled(model.days, rng)){
        for(const session of shuffled(SESSION_KEYS, rng)){
          const cells = grid?.[day]?.[session] || [];
          for(const index of shuffled(cells.map((_, cellIndex) => cellIndex), rng)){
            if(!canPlaceAt(assignment, day, session, index, {ignoreResources:true})) continue;
            const blockers = blockersAt(assignment, day, session, index);
            if(blockers.length > 2 || blockers.some(ref => ref.cell.fixed === true)) continue;
            targets.push({
              classId:assignment.classInfo.id,
              day,
              session,
              index,
              blockers,
              score:(blockers.length ? -blockers.length * 1_000_000 : 2_000_000) + rng() * 30_000
            });
          }
        }
      }
      targets.sort((left, right) => right.score - left.score);
      for(const target of targets.slice(0, 36)){
        const undos = [];
        let moved = true;
        for(const blocker of target.blockers){
          const undo = moveBlockerAside(blocker, target);
          if(!undo){ moved = false; break; }
          undos.push(undo);
        }
        if(moved && placeNewLesson(assignment, target.day, target.session, target.index)) return true;
        for(let index = undos.length - 1; index >= 0; index -= 1) undos[index]();
      }
      return false;
    }
    function estimateAvailability(assignment){
      const grid = state.grids.get(assignment.classInfo.id);
      let count = 0;
      for(const day of model.days){
        for(const session of SESSION_KEYS){
          const cells = grid?.[day]?.[session] || [];
          for(let index = 0; index < cells.length; index += 1){
            if(
              cells[index] == null
              && !assignmentBlocked(assignment, day, session, index)
              && !state.teacherBusy.has(occupiedKey(assignment.teacher, day, session, index))
              && (!assignment.room || !state.roomBusy.has(occupiedKey(assignment.room, day, session, index)))
            ) count += 1;
          }
        }
      }
      return count;
    }
    const teacherRemaining = new Map();
    const teacherAvailableSlots = new Map();
    for(const assignment of model.assignments){
      const fixed = state.fixedCounts.get(assignment.key) || 0;
      const remaining = Math.max(0, assignment.periods - fixed);
      teacherRemaining.set(
        assignment.teacher,
        (teacherRemaining.get(assignment.teacher) || 0) + remaining
      );
      if(!teacherAvailableSlots.has(assignment.teacher)){
        teacherAvailableSlots.set(assignment.teacher, new Set());
      }
      const available = teacherAvailableSlots.get(assignment.teacher);
      const grid = state.grids.get(assignment.classInfo.id);
      for(const day of model.days){
        for(const session of SESSION_KEYS){
          const cells = grid?.[day]?.[session] || [];
          for(let index = 0; index < cells.length; index += 1){
            if(
              !assignmentBlocked(assignment, day, session, index)
              && !state.teacherBusy.has(occupiedKey(assignment.teacher, day, session, index))
            ) available.add(slotKey(day, session, index));
          }
        }
      }
    }
    const orderingStrategy = Math.abs(Math.round(seed)) % 4;
    const orderedAssignments = model.assignments
      .map(item => {
        const fixed = state.fixedCounts.get(item.key) || 0;
        const remaining = Math.max(0, item.periods - fixed);
        const availability = estimateAvailability(item);
        const teacherAvailability = teacherAvailableSlots.get(item.teacher)?.size || 0;
        const teacherSlack = teacherAvailability - (teacherRemaining.get(item.teacher) || 0);
        return {
          item,
          availability,
          remaining,
          slack:availability - remaining,
          teacherSlack,
          random:rng()
        };
      })
      .sort((left, right) => {
        const teacherFirst = orderingStrategy === 0
          ? left.teacherSlack - right.teacherSlack
          : 0;
        const teacherTie = orderingStrategy === 1
          ? left.teacherSlack - right.teacherSlack
          : 0;
        return teacherFirst
          || left.slack - right.slack
          || left.availability - right.availability
          || teacherTie
          || right.item.periods - left.item.periods
          || left.random - right.random;
      });

    for(const wrapper of orderedAssignments){
      const assignment = wrapper.item;
      const fixed = state.fixedCounts.get(assignment.key) || 0;
      let remaining = Math.max(0, assignment.periods - fixed);
      while(remaining > 0 && Date.now() < deadline){
        const grid = state.grids.get(assignment.classInfo.id);
        let best = null;
        let bestScore = -Infinity;
        for(const day of shuffled(model.days, rng)){
          for(const session of shuffled(SESSION_KEYS, rng)){
            const cells = grid?.[day]?.[session] || [];
            const classLoad = cells.reduce((sum, cell) => sum + (cell?.lesson ? 1 : 0), 0);
            const subjectKey = `${assignment.classInfo.id}|${day}|${session}|${normalized(assignment.subject)}`;
            const subjectLoad = subjectSessionCounts.get(subjectKey) || 0;
            if(subjectLoad >= assignment.limit) continue;
            for(const index of shuffled(cells.map((_, cellIndex) => cellIndex), rng)){
              if(cells[index] != null) continue;
              if(assignmentBlocked(assignment, day, session, index)) continue;
              if(state.teacherBusy.has(occupiedKey(assignment.teacher, day, session, index))) continue;
              if(assignment.room && state.roomBusy.has(occupiedKey(assignment.room, day, session, index))) continue;
              const slots = teacherSlots(assignment, day, session, cells.length);
              const before = teacherMetric(slots);
              const afterSlots = slots.slice();
              afterSlots[index] = true;
              const after = teacherMetric(afterSlots);
              const neighbor = (index > 0 && cells[index - 1]?.lesson)
                || (index + 1 < cells.length && cells[index + 1]?.lesson);
              let score = 0;
              score += before.count === 1 ? 2_600_000 : (before.count > 1 ? 900_000 : -1_100_000);
              score += after.count >= 2 && after.gaps === 0 ? 600_000 : 0;
              score -= after.gap2 * 1_600_000 + after.gaps * 260_000;
              score += classLoad > 0 ? 220_000 : -350_000;
              score += neighbor ? 120_000 : 0;
              score += subjectLoad > 0 ? 35_000 : 0;
              score -= index * 300;
              score += rng() * 30_000;
              if(score > bestScore){ bestScore = score; best = {day, session, index, subjectKey}; }
            }
          }
        }
        if(!best) break;
        placeNewLesson(assignment, best.day, best.session, best.index);
        remaining -= 1;
      }
      if(remaining > 0){
        unassignedAssignments.push({
          key:assignment.key,
          classId:assignment.classInfo.id,
          className:assignment.classInfo.name,
          subject:assignment.subject,
          teacher:assignment.teacher,
          room:assignment.room,
          periods:remaining
        });
      }
    }
    for(let round = 0; round < 3 && Date.now() < deadline; round += 1){
      let repaired = 0;
      const pending = shuffled(unassignedAssignments, rng)
        .filter(item => item.periods > 0)
        .sort((left, right) => right.periods - left.periods || rng() - 0.5);
      for(const item of pending){
        const assignment = model.assignments.find(candidate => candidate.key === item.key);
        if(!assignment) continue;
        while(item.periods > 0 && Date.now() < deadline){
          if(!tryRepairOne(assignment)) break;
          item.periods -= 1;
          repaired += 1;
        }
      }
      if(repaired <= 0) break;
    }
    return {
      ok:true,
      version:VERSION,
      expectedPeriods:model.expectedPeriods,
      lessons:state.lessons.map(lesson => {
        const copy = {...lesson};
        delete copy.fixed;
        return copy;
      }),
      unassignedAssignments:unassignedAssignments.filter(item => item.periods > 0),
      quality:candidateQuality(state.lessons),
      seed
    };
  }

  function generate(data, options = {}){
    const started = Date.now();
    const maxMs = Math.max(100, Math.min(10_000, number(options.maxMs, 2_500)));
    const attempts = Math.max(1, Math.min(24, Math.round(number(options.attempts, 8))));
    const seed = Math.max(1, Math.round(number(options.seed, Date.now() & 0x7fffffff)));
    const deadline = started + maxMs;
    const model = buildModel(data || {});
    const base = createBaseState(model);
    if(base.invalidReasons.length){
      return {
        ok:false,
        version:VERSION,
        expectedPeriods:model.expectedPeriods,
        scheduledPeriods:0,
        unassignedPeriods:model.expectedPeriods,
        lessons:[],
        unassignedAssignments:[],
        quality:{teacherSessions:0, singleton:0, gap1:0, gap2:0, gapTotal:0},
        seed,
        elapsedMs:Date.now() - started,
        attempts:0,
        complete:false,
        invalidReasons:base.invalidReasons.slice(0, 20)
      };
    }
    let best = null;
    let completedAttempts = 0;
    for(let attempt = 0; attempt < attempts && Date.now() < deadline; attempt += 1){
      const candidate = buildAttempt(model, base, seed + attempt * 104729, deadline);
      completedAttempts += 1;
      if(betterCandidate(candidate, best)) best = candidate;
      if(best && best.lessons.length >= best.expectedPeriods && best.quality.singleton === 0 && best.quality.gap2 === 0) break;
    }
    const result = best || {
      ok:false,
      version:VERSION,
      expectedPeriods:model.expectedPeriods,
      lessons:[],
      unassignedAssignments:[],
      quality:{teacherSessions:0, singleton:0, gap1:0, gap2:0, gapTotal:0},
      seed
    };
    result.elapsedMs = Date.now() - started;
    result.attempts = completedAttempts;
    result.scheduledPeriods = result.lessons.length;
    result.unassignedPeriods = Math.max(0, result.expectedPeriods - result.scheduledPeriods);
    result.complete = result.expectedPeriods > 0 && result.unassignedPeriods === 0;
    return result;
  }

  async function generateAsync(data, options = {}){
    await new Promise(resolve => {
      if(typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
      else setTimeout(resolve, 0);
    });
    return generate(data, options);
  }

  return {VERSION, generate, generateAsync, _buildModel:buildModel};
});
