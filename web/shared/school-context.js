(function(){
  "use strict";

  function stripVietnameseMarks(x){
    return (x || "").toString()
      .replace(/đ/g, "d")
      .replace(/Đ/g, "d")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  }

  function sanitizeOptionalSchoolId(x){
    x = (x || "").toString().trim();
    x = stripVietnameseMarks(x).replace(/[^0-9a-zA-Z]+/g, "").toLowerCase();
    return x || "";
  }

  function sanitizeSchoolId(x){
    x = sanitizeOptionalSchoolId(x);
    return x || "default";
  }

  function legacySanitizeSchoolId(x){
    x = (x || "").toString().trim();
    x = x.replace(/[^0-9a-zA-Z_\-]/g, "_");
    return x || "";
  }

  function legacyUpperSanitizeSchoolId(x){
    return (x || "")
      .toString()
      .trim()
      .toUpperCase()
      .replace(/\s+/g, "_")
      .replace(/[^A-Z0-9_-]/g, "")
      .slice(0, 40) || "";
  }

  function safeParseJSON(raw, fallback){
    try{
      return raw ? JSON.parse(raw) : (fallback ?? {});
    }catch(_){
      return (fallback ?? {});
    }
  }

  function schoolNameMap(){
    return safeParseJSON(localStorage.getItem("TKB_SCHOOL_NAMES"), {});
  }

  function getSchoolName(sid){
    const key = sanitizeSchoolId(sid);
    const map = schoolNameMap();
    const v = map ? map[key] : "";
    return (v == null) ? "" : String(v);
  }

  function setSchoolName(sid, name){
    const key = sanitizeSchoolId(sid);
    const n = (name || "").toString().trim();
    if(!key || !n) return;
    const map = schoolNameMap();
    map[key] = n;
    try{ localStorage.setItem("TKB_SCHOOL_NAMES", JSON.stringify(map)); }catch(_){}
  }

  function schoolStoreScore(sid){
    try{
      const key = `TKB_STORE::${sanitizeSchoolId(sid)}`;
      const raw = localStorage.getItem(key);
      if(!raw) return 0;
      const data = JSON.parse(raw);
      if(!data || typeof data !== "object") return 0;
      let score = 1 + Math.min(String(raw).length, 200000) / 10000;
      if(Array.isArray(data.lop)) score += data.lop.length * 20;
      if(Array.isArray(data.giaovien)) score += data.giaovien.length * 8;
      if(Array.isArray(data.monhoc)) score += data.monhoc.length * 6;
      if(Array.isArray(data.mon)) score += data.mon.length * 4;
      if(data.pccmMatrix && typeof data.pccmMatrix === "object") score += Object.keys(data.pccmMatrix).length * 3;
      if(data.tkb && typeof data.tkb === "object") score += Object.keys(data.tkb).length * 2;
      return score;
    }catch(_){
      return 0;
    }
  }

  function discoverStoredSchoolIds(){
    const ids = [];
    const add = (value) => {
      const raw = (value == null) ? "" : String(value).trim();
      if(!raw) return;
      const sid = sanitizeSchoolId(raw);
      if(!sid || ids.includes(sid)) return;
      ids.push(sid);
    };
    const list = safeParseJSON(localStorage.getItem("TKB_SCHOOL_LIST"), []);
    if(Array.isArray(list)) list.forEach(add);
    try{
      for(let i = 0; i < localStorage.length; i++){
        const key = String(localStorage.key(i) || "");
        const match = key.match(/^TKB_STORE::(.+)$/);
        if(match) add(match[1]);
      }
    }catch(_){}
    return ids;
  }

  function bestStoredSchoolId(){
    const ids = discoverStoredSchoolIds();
    let best = "";
    let bestScore = -1;
    let fallback = "";
    ids.forEach((sid) => {
      if(sid === "default"){
        fallback = fallback || sid;
        return;
      }
      const score = schoolStoreScore(sid);
      if(!best || score > bestScore){
        best = sid;
        bestScore = score;
      }
    });
    return best || fallback;
  }

  function lsKey(schoolId){
    return `TKB_STORE::${sanitizeSchoolId(schoolId)}`;
  }

  function readUrlSchoolParams(){
    try{
      const url = new URL(location.href);
      return {
        sid: sanitizeOptionalSchoolId(url.searchParams.get("sid") || ""),
        school: String(url.searchParams.get("school") || "").trim()
      };
    }catch(_){
      return { sid: "", school: "" };
    }
  }

  function setSchoolUrlParams(url, sid, label){
    const clean = sanitizeSchoolId(sid || label);
    const display = (label || getSchoolName(clean) || clean).toString().trim();
    url.searchParams.set("sid", clean);
    url.searchParams.delete("school");
    return { sid: clean, label: display || clean };
  }

  function bootstrapPlannerFromUrl(){
    if(window.__TKB_PLANNER_SCHOOL_BOOTSTRAP__) return;
    window.__TKB_PLANNER_SCHOOL_BOOTSTRAP__ = true;
    try{
      if(window.TKBSchoolSwitcher && window.TKBSchoolSwitcher.ensureSuperAdminDefault){
        window.TKBSchoolSwitcher.ensureSuperAdminDefault();
      }
      const url = new URL(location.href);
      const urlSid = sanitizeOptionalSchoolId(url.searchParams.get("sid") || "");
      const urlSchool = String(url.searchParams.get("school") || "").trim();
      const isSuper = !!(window.TKBAuth && window.TKBAuth.currentUser && window.TKBAuth.currentUser()?.user?.role === "superadmin");

      if(isSuper && !urlSid && !urlSchool){
        const label = getSchoolName("default") || localStorage.getItem("TKB_LAST_SCHOOL_LABEL") || "default";
        url.searchParams.set("sid", "default");
        url.searchParams.delete("school");
        history.replaceState(null, "", url.toString());
        localStorage.setItem("TKB_LAST_SCHOOL", "default");
        localStorage.setItem("TKB_LAST_SCHOOL_LABEL", label);
        return;
      }

      if(urlSid || urlSchool){
        const directSid = sanitizeSchoolId(urlSchool || urlSid);
        if(directSid){
          url.searchParams.set("sid", directSid);
          url.searchParams.delete("school");
          history.replaceState(null, "", url.toString());
        }
        return;
      }

      const lastSid = sanitizeOptionalSchoolId(localStorage.getItem("TKB_LAST_SCHOOL") || "");
      const bestSid = bestStoredSchoolId();
      let sid = "";
      if(lastSid && lastSid !== "default"){
        const lastScore = schoolStoreScore(lastSid);
        const bestScore = bestSid ? schoolStoreScore(bestSid) : 0;
        sid = (!bestSid || bestSid === "default" || lastSid === bestSid || lastScore >= bestScore) ? lastSid : bestSid;
      }else{
        sid = bestSid || lastSid;
      }
      if(!sid && schoolStoreScore("default") > 0) sid = "default";
      if(!sid) return;

      const label = getSchoolName(sid) || localStorage.getItem("TKB_LAST_SCHOOL_LABEL") || sid;
      url.searchParams.set("sid", sid);
      url.searchParams.delete("school");
      history.replaceState(null, "", url.toString());
      localStorage.setItem("TKB_LAST_SCHOOL", sid);
      localStorage.setItem("TKB_LAST_SCHOOL_LABEL", label || sid);
    }catch(_){}
  }

  window.TKBSchool = {
    stripVietnameseMarks,
    sanitizeOptionalSchoolId,
    sanitizeSchoolId,
    legacySanitizeSchoolId,
    legacyUpperSanitizeSchoolId,
    safeParseJSON,
    schoolNameMap,
    getSchoolName,
    setSchoolName,
    schoolStoreScore,
    discoverStoredSchoolIds,
    bestStoredSchoolId,
    lsKey,
    readUrlSchoolParams,
    setSchoolUrlParams,
    bootstrapPlannerFromUrl
  };
})();
