(function(){
  "use strict";

  const SC = window.TKBSchool || {};
  const sanitize = SC.sanitizeSchoolId || function(s){
    const x = String(s || "").trim();
    return x || "default";
  };
  const getName = SC.getSchoolName || function(){ return ""; };
  const setName = SC.setSchoolName || function(){};
  const setUrl = SC.setSchoolUrlParams || function(url, sid){
    url.searchParams.set("sid", sanitize(sid));
    url.searchParams.delete("school");
  };

  function isSuperAdmin(){
    try{
      const ctx = window.TKBAuth && window.TKBAuth.currentUser();
      return !!(ctx && ctx.user && ctx.user.role === "superadmin");
    }catch(_){ return false; }
  }

  function getSchoolList(){
    try{
      return JSON.parse(localStorage.getItem("TKB_SCHOOL_LIST") || "[]");
    }catch(_){ return []; }
  }

  function addSchoolToList(sid){
    sid = sanitize(sid);
    if(!sid) return;
    const list = [];
    getSchoolList().forEach(item => {
      const clean = sanitize(item);
      if(clean && !list.includes(clean)) list.push(clean);
    });
    if(!list.includes(sid)) list.push(sid);
    localStorage.setItem("TKB_SCHOOL_LIST", JSON.stringify(list));
  }

  function ensureSuperAdminDefault(){
    if(!isSuperAdmin()) return;
    addSchoolToList("default");
  }

  function getCurrentSchoolId(){
    if(typeof window.__TKB_GET_SCHOOL_ID__ === "function"){
      try{ return sanitize(window.__TKB_GET_SCHOOL_ID__()); }catch(_){}
    }
    try{
      const url = new URL(location.href);
      const fromUrl = url.searchParams.get("sid") || url.searchParams.get("school") || "";
      if(fromUrl) return sanitize(fromUrl);
    }catch(_){}
    return sanitize(localStorage.getItem("TKB_LAST_SCHOOL") || "default");
  }

  function escapeHtml(s){
    return String(s == null ? "" : s).replace(/[&<>'"]/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
    }[c]));
  }

  function prettyLabel(s){
    return String(s || "").trim() || "default";
  }

  function lsKey(sid){
    return SC.lsKey ? SC.lsKey(sid) : `TKB_STORE::${sanitize(sid)}`;
  }

  function notify(msg, type){
    if(typeof window.showBottomPopup === "function"){
      window.showBottomPopup(msg, type || "ok");
      return;
    }
    if(msg) alert(msg);
  }

  function navigateToSchool(sid, label){
    const clean = sanitize(sid);
    const name = prettyLabel(label || getName(clean) || clean);
    try{
      sessionStorage.setItem("TKB_SCHOOL_POPUP", `Đã mở trường ${name}.`);
    }catch(_){}
    try{
      localStorage.setItem("TKB_LAST_SCHOOL", clean);
      localStorage.setItem("TKB_LAST_SCHOOL_LABEL", name);
    }catch(_){}
    const u = new URL(location.href);
    setUrl(u, clean, name);
    window.location.href = u.toString();
  }

  function showSchoolSwitcher(){
    closeSchoolSwitcher();
    ensureSuperAdminDefault();
    const isSuper = isSuperAdmin();
    const schools = getSchoolList().slice();
    if(isSuper && !schools.map(sanitize).includes("default")){
      schools.unshift("default");
    }
    const current = getCurrentSchoolId();

    let html = `<div class="modal" id="schoolModal" style="display:flex">
      <div class="modal-content" style="width:320px">
        <h3>Chọn trường</h3>
        <div style="margin-top:10px">`;

    schools.forEach(s => {
      const sid = sanitize(s);
      const js = (sid || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      const name = prettyLabel(getName(sid) || sid);
      const isDefault = sid === "default";
      const delBtn = (isSuper && isDefault)
        ? ""
        : `<button class="school-del" onclick="event.stopPropagation();deleteSchool('${js}')">Xóa</button>`;
      html += `
        <div class="school-item ${sid === current ? "active" : ""}" onclick="switchSchool('${js}')">
          <div class="school-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
          <div style="display:flex;gap:6px;align-items:center">
            <button class="school-edit" onclick="event.stopPropagation();renameSchool('${js}')">Sửa</button>
            ${delBtn}
          </div>
        </div>`;
    });

    html += `</div>`;
    if(typeof window.addNewSchool === "function"){
      html += `<button class="btn primary" style="width:100%;margin-top:10px" onclick="addNewSchool()">Thêm trường</button>`;
    }
    html += `<div style="text-align:right;margin-top:10px">
      <button class="btn" onclick="closeSchoolSwitcher()">Đóng</button>
    </div>
  </div></div>`;

    document.body.insertAdjacentHTML("beforeend", html);
  }

  function closeSchoolSwitcher(){
    const m = document.getElementById("schoolModal");
    if(m) m.remove();
  }

  function switchSchool(sid){
    navigateToSchool(sid);
  }

  function renameSchool(sid){
    sid = sanitize(sid);
    if(!sid) return;
    const cur = getName(sid) || "";
    const next = prompt("Nhập tên hiển thị của trường (có dấu):", cur);
    if(next === null) return;
    const name = String(next || "").trim();
    if(!name){
      notify("Nhập tên hiển thị của trường.", "warning");
      return;
    }
    setName(sid, name);
    if(getCurrentSchoolId() === sid){
      try{ localStorage.setItem("TKB_LAST_SCHOOL_LABEL", name); }catch(_){}
      if(typeof window.updateSchoolBadge === "function") window.updateSchoolBadge();
    }
    showSchoolSwitcher();
    notify("Đã cập nhật tên trường.", "ok");
  }

  function kvdbDeleteDbByName(dbName){
    return new Promise(resolve => {
      try{
        const req = indexedDB.open("TKB_SQLJS_DB", 1);
        req.onupgradeneeded = () => {
          try{
            const db = req.result;
            if(db && !db.objectStoreNames.contains("files")) db.createObjectStore("files");
          }catch(_){}
        };
        req.onsuccess = () => {
          const db = req.result;
          try{
            const tx = db.transaction("files", "readwrite");
            const st = tx.objectStore("files");
            st.delete(dbName);
            tx.oncomplete = () => { try{ db.close(); }catch(_){ } resolve(true); };
            tx.onerror = () => { try{ db.close(); }catch(_){ } resolve(false); };
          }catch(e){
            try{ db.close(); }catch(_){ }
            resolve(false);
          }
        };
        req.onerror = () => resolve(false);
      }catch(e){
        resolve(false);
      }
    });
  }

  async function deleteSchool(sid){
    sid = sanitize(sid);
    if(!sid) return;

    if(isSuperAdmin() && sid === "default"){
      notify("Không thể xóa TKB mặc định. Bạn chỉ có thể đổi tên.", "warning");
      return;
    }

    const msg = `Xóa trường "${sid}"?\n\n- Sẽ xóa dữ liệu của trường này khỏi máy (localStorage/IndexedDB).\n- Thao tác này không thể hoàn tác.`;
    if(!confirm(msg)) return;

    try{
      const list = getSchoolList().filter(x => sanitize(x) !== sid);
      localStorage.setItem("TKB_SCHOOL_LIST", JSON.stringify(list));
    }catch(_){}

    try{ localStorage.removeItem(lsKey(sid)); }catch(_){}

    try{
      const map = JSON.parse(localStorage.getItem("TKB_SCHOOL_NAMES") || "{}");
      delete map[sid];
      localStorage.setItem("TKB_SCHOOL_NAMES", JSON.stringify(map));
    }catch(_){}

    try{ await kvdbDeleteDbByName(`TKB::SCHOOL::${sid}`); }catch(_){}

    if(getCurrentSchoolId() === sid){
      const nextList = getSchoolList();
      const next = sanitize(nextList[0] || "default");
      navigateToSchool(next, getName(next) || next);
      return;
    }

    showSchoolSwitcher();
    notify(`Đã xóa trường ${sid}.`, "ok");
  }

  window.TKBSchoolSwitcher = {
    isSuperAdmin,
    getSchoolList,
    addSchoolToList,
    ensureSuperAdminDefault,
    getCurrentSchoolId,
    showSchoolSwitcher,
    closeSchoolSwitcher,
    switchSchool,
    renameSchool,
    deleteSchool
  };

  window.showSchoolSwitcher = showSchoolSwitcher;
  window.closeSchoolSwitcher = closeSchoolSwitcher;
  window.switchSchool = switchSchool;
  window.renameSchool = renameSchool;
  window.deleteSchool = deleteSchool;
})();
