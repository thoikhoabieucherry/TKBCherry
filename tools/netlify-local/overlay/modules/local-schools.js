/* ============================================================
   Cherry Local — modules/local-schools.js
   Quản lý các trường trong máy (mỗi trường = data/<mã>.json trên máy chủ local)
   và đường NHẬP file .cherry thành trường mới.

   - Bảng "Trường trong máy" (thay cho bộ chọn trường / trang Quản lý của bản online):
     mở trường, đổi tên, xóa, tạo trường trống, nhập file .cherry.
   - Nhập .cherry: bọc lại cherryFileApplyImport của modules/cherry-file.js —
       file mang mã trường KHÁC trường đang mở  -> thêm (hoặc ghi đè) trường đó rồi mở;
       file cùng mã trường / kho thô không mã   -> thay dữ liệu trường đang mở như bản online.
   - Lần đầu chạy (chưa có trường nào) -> tự mở bảng này để hướng dẫn nhập .cherry.
============================================================ */
(function(){
  "use strict";

  const API = "/api/local/schools";

  function sanitize(value){
    try{
      if(window.TKBAuth && typeof window.TKBAuth.sanitizeSchoolId === "function") return window.TKBAuth.sanitizeSchoolId(value);
    }catch(_){ }
    return String(value || "").replace(/[^0-9a-zA-Z]+/g, "").toLowerCase() || "default";
  }

  function currentSid(){
    try{ return sanitize(window.TKBAuth.currentUser().session.schoolId); }catch(_){ return "default"; }
  }

  function esc(s){
    return String(s == null ? "" : s).replace(/[&<>'"]/g, c => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;"}[c]));
  }

  async function api(action, body){
    const resp = await fetch(API, {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify(Object.assign({action}, body || {})),
      cache:"no-store"
    });
    const payload = await resp.json().catch(() => null);
    if(!resp.ok || !payload || payload.ok !== true){
      throw new Error((payload && (payload.error || payload.message)) || ("HTTP " + resp.status));
    }
    return payload;
  }

  async function listSchools(){
    const resp = await fetch(API + "?ts=" + Date.now(), {cache:"no-store"});
    const payload = await resp.json().catch(() => null);
    return (payload && Array.isArray(payload.schools)) ? payload.schools : [];
  }

  function formatTime(ms){
    const n = Number(ms || 0);
    if(!n) return "";
    const d = new Date(n);
    const p = v => String(v).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())} ${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
  }

  function summaryText(s){
    if(!s) return "";
    return `${s.lop || 0} lớp · ${s.giaovien || 0} GV · ${s.tkbCells || 0} ô TKB`;
  }

  /* ---------------- Hộp thoại ---------------- */
  function ensureModal(){
    let el = document.getElementById("lsModal");
    if(el) return el;
    el = document.createElement("div");
    el.id = "lsModal";
    el.className = "modal ls-modal";
    el.innerHTML = `
      <div class="modal-content dg-modal-content ls-modal-content" role="dialog" aria-modal="true" aria-labelledby="lsModalTitle">
        <div class="dg-modal-head">
          <span class="dg-modal-icon" aria-hidden="true"></span>
          <h3 id="lsModalTitle">Trường trong máy</h3>
          <button type="button" class="dg-modal-close" title="Đóng" aria-label="Đóng" onclick="localSchoolsClose()">&#x2715;</button>
        </div>
        <div class="dg-modal-body ls-modal-body">
          <p class="ls-intro" id="lsIntro">Dữ liệu trường lưu ngay trong trình duyệt này (không gửi lên mạng).
            Nhập file <b>.cherry</b> (xuất từ tkbcherry.com hoặc từ chính bản này) để thêm trường; nhớ <b>Xuất file .cherry</b> thường xuyên để giữ bản sao.</p>
          <div class="ls-actions">
            <button type="button" class="btn primary" onclick="localSchoolsImport()">&#x2B06; Nhập file .cherry</button>
            <button type="button" class="btn" onclick="localSchoolsCreate()">Tạo trường trống</button>
            <button type="button" class="btn" onclick="localSchoolsRefresh()">Làm mới</button>
          </div>
          <div class="ls-table-wrap"><table class="ls-table"><thead><tr>
            <th>Trường</th><th>Dữ liệu</th><th>Lưu lần cuối</th><th></th>
          </tr></thead><tbody id="lsRows"></tbody></table></div>
          <div id="lsStatus" class="ls-status" aria-live="polite"></div>
        </div>
        <div class="modal-actions dg-modal-actions">
          <button type="button" class="btn" onclick="localSchoolsClose()">Đóng</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    document.addEventListener("keydown", ev => {
      try{
        if(el.style.display !== "flex") return;
        if(ev.key === "Escape"){ ev.preventDefault(); localSchoolsClose(); }
      }catch(_){ }
    });
    return el;
  }

  function setStatus(msg, level){
    const el = document.getElementById("lsStatus");
    if(!el) return;
    el.textContent = msg || "";
    el.className = "ls-status" + (level ? " ls-status-" + level : "");
  }

  async function render(){
    const rows = document.getElementById("lsRows");
    if(!rows) return;
    rows.innerHTML = `<tr><td colspan="4" class="ls-empty">Đang đọc…</td></tr>`;
    let schools = [];
    try{ schools = await listSchools(); }
    catch(err){ rows.innerHTML = `<tr><td colspan="4" class="ls-empty">Không đọc được danh sách: ${esc(err.message || err)}</td></tr>`; return; }
    const cur = currentSid();
    if(!schools.length){
      rows.innerHTML = `<tr><td colspan="4" class="ls-empty">Chưa có trường nào trong máy. Bấm <b>Nhập file .cherry</b> để bắt đầu.</td></tr>`;
      return;
    }
    rows.innerHTML = schools.map(s => {
      const id = esc(s.id);
      const isCur = String(s.id) === cur;
      return `<tr class="${isCur ? "is-current" : ""}">
        <td><div class="ls-name">${esc(s.name || s.id)}</div><div class="ls-sid">${id}${isCur ? " · đang mở" : ""}</div></td>
        <td class="ls-summary">${esc(summaryText(s.summary))}</td>
        <td class="ls-summary">${esc(formatTime(s.updatedAt))}</td>
        <td><div class="ls-row-actions">
          ${isCur ? "" : `<button type="button" class="btn primary" onclick="localSchoolsSwitch('${id}')">Mở</button>`}
          <button type="button" class="btn" onclick="localSchoolsRename('${id}')">Đổi tên</button>
          <button type="button" class="btn danger" onclick="localSchoolsDelete('${id}')">Xóa</button>
        </div></td>
      </tr>`;
    }).join("");
  }

  window.localSchoolsOpen = async function(){
    const modal = ensureModal();
    setStatus("", "");
    modal.style.display = "flex";
    await render();
  };

  window.localSchoolsClose = function(){
    const el = document.getElementById("lsModal");
    if(el) el.style.display = "none";
  };

  window.localSchoolsRefresh = async function(){
    try{ if(window.TKBAuth && window.TKBAuth.refreshSchools) window.TKBAuth.refreshSchools(); }catch(_){ }
    await render();
  };

  window.localSchoolsSwitch = function(id){
    const sid = sanitize(id);
    try{ localStorage.setItem("TKB_LAST_SCHOOL", sid); }catch(_){ }
    location.href = "/app?sid=" + encodeURIComponent(sid);
  };

  window.localSchoolsCreate = async function(){
    const name = prompt("Tên trường mới (trống, chưa có dữ liệu):", "");
    if(name === null) return;
    const clean = String(name || "").trim();
    if(!clean){ setStatus("Chưa nhập tên trường.", "error"); return; }
    try{
      const res = await api("create", {name:clean});
      try{ sessionStorage.setItem("TKB_SCHOOL_POPUP", `Đã tạo trường ${clean}.`); }catch(_){ }
      window.localSchoolsSwitch(res.id);
    }catch(err){ setStatus("Không tạo được trường: " + (err.message || err), "error"); }
  };

  window.localSchoolsRename = async function(id){
    const sid = sanitize(id);
    const schools = await listSchools();
    const cur = schools.find(s => String(s.id) === sid);
    const name = prompt("Tên hiển thị của trường:", (cur && cur.name) || sid);
    if(name === null) return;
    const clean = String(name || "").trim();
    if(!clean){ setStatus("Chưa nhập tên.", "error"); return; }
    try{
      await api("rename", {id:sid, name:clean});
      if(sid === currentSid()){
        location.reload();
        return;
      }
      await window.localSchoolsRefresh();
      setStatus(`Đã đổi tên "${clean}".`, "ok");
    }catch(err){ setStatus("Không đổi tên được: " + (err.message || err), "error"); }
  };

  window.localSchoolsDelete = async function(id){
    const sid = sanitize(id);
    const schools = await listSchools();
    const cur = schools.find(s => String(s.id) === sid);
    const label = (cur && cur.name) || sid;
    if(!confirm(`Xóa trường "${label}" (mã ${sid}) khỏi máy?\n${summaryText(cur && cur.summary)}\nDữ liệu trường lưu trong trình duyệt này sẽ bị XOÁ HẲN — nên Xuất file .cherry trước. Tiếp tục?`)) return;
    try{
      await api("delete", {id:sid});
      if(sid === currentSid()){
        try{ localStorage.removeItem("TKB_LAST_SCHOOL"); }catch(_){ }
        location.href = "/app";
        return;
      }
      await window.localSchoolsRefresh();
      setStatus(`Đã xóa "${label}".`, "ok");
    }catch(err){ setStatus("Không xóa được: " + (err.message || err), "error"); }
  };

  window.localSchoolsImport = function(){
    if(typeof window.cherryFileTriggerImport === "function"){
      window.cherryFileTriggerImport();
      return;
    }
    alert("Chưa tải mô-đun File .cherry. Tải lại trang rồi thử lại.");
  };

  /* ---------------- Bọc đường nhập .cherry ---------------- */
  const originalApply = window.cherryFileApplyImport;
  if(typeof originalApply === "function"){
    window.cherryFileApplyImport = async function(parsed, fileName){
      const meta = (parsed && parsed.meta) || {};
      const rawSid = String(meta.schoolId || "").trim();
      const fileSid = rawSid ? sanitize(rawSid) : "";
      const cur = currentSid();
      if(!fileSid || fileSid === cur){
        return originalApply(parsed, fileName);   // cùng trường / kho thô: thay dữ liệu trường đang mở
      }
      const name = String(meta.schoolName || "").trim() || fileSid;
      let schools = [];
      try{ schools = await listSchools(); }catch(_){ }
      const existing = schools.find(s => String(s.id) === fileSid);
      const summary = (typeof window.cherryFileSummaryText === "function" && parsed.summary)
        ? window.cherryFileSummaryText(parsed.summary) : "";
      const when = meta.exportedAt && typeof window.cherryFileFormatTime === "function"
        ? `, xuất lúc ${window.cherryFileFormatTime(meta.exportedAt)}` : "";
      const lines = [`File "${fileName || ""}" thuộc trường "${name}" (mã ${fileSid})${when}.`];
      if(summary) lines.push(`Nội dung: ${summary}.`);
      lines.push("");
      if(existing){
        lines.push(`Trường này ĐÃ CÓ trong máy ("${existing.name || fileSid}"${existing.summary ? ": " + summaryText(existing.summary) : ""}).`);
        lines.push("GHI ĐÈ toàn bộ dữ liệu của trường đó bằng nội dung file rồi mở? (bản cũ trong trình duyệt sẽ bị thay — nên Xuất file .cherry trước)");
      }else{
        lines.push(`Thêm trường "${name}" vào máy rồi mở? Trường đang mở (${cur}) giữ nguyên.`);
      }
      if(!confirm(lines.join("\n"))){
        if(typeof window.cherryFileSetStatus === "function") window.cherryFileSetStatus("Đã hủy nhập.", "info");
        return false;
      }
      try{
        await api("import", {id:fileSid, name, data:parsed.data});
      }catch(err){
        alert("❌ Không lưu được trường vào máy: " + (err.message || err));
        return false;
      }
      try{ sessionStorage.setItem("TKB_SCHOOL_POPUP", `Đã nhập trường ${name} từ ${fileName || "file .cherry"}.`); }catch(_){ }
      window.localSchoolsSwitch(fileSid);
      return true;
    };
  }

  /* ---------------- Nhãn Local trên thanh điều hướng + lần đầu chạy ---------------- */
  document.addEventListener("DOMContentLoaded", async () => {
    try{
      const badge = document.querySelector(".school-switcher");
      if(badge && !badge.querySelector(".ls-nav-tag")){
        const tag = document.createElement("span");
        tag.className = "ls-nav-tag";
        tag.textContent = "LOCAL";
        tag.title = "Dữ liệu trường lưu trong trình duyệt này; bộ giải Cherry chạy trên máy này";
        badge.appendChild(tag);
      }
    }catch(_){ }
    try{
      const schools = await listSchools();
      if(!schools.length) await window.localSchoolsOpen();
    }catch(_){ }
  });
})();
