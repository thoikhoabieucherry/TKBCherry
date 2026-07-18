(function(){
  "use strict";

  const A = window.TKBAuth;
  const auth = A && A.requireAuth(["superadmin"]);
  if(!auth || !auth.ok){
    window.location.replace("/");
    return;
  }

  document.getElementById("btnLogout").onclick = () => {
    A.logout();
    window.location.href = "/";
  };
  document.getElementById("btnChangePassword").onclick = async () => {
    const current = A.currentUser();
    const loginId = (current && current.user && current.user.id) || "suadmin";
    const pw = prompt("Mật khẩu mới cho " + loginId + ":", "");
    if(pw === null || !String(pw).trim()) return;
    const res = await A.updateUserPassword(loginId, String(pw).trim());
    alert(res.ok ? "Đã đổi mật khẩu. Lần sau đăng nhập dùng mật khẩu mới." : (res.message || "Không đổi được mật khẩu."));
  };
  document.getElementById("btnOpenApp").onclick = () => { window.location.href = "/app?sid=default"; };

  const addSchoolModal = document.getElementById("addSchoolModal");
  const addSchoolForm = document.getElementById("addSchoolForm");

  function todayInputValue(){
    const d = new Date();
    const pad = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function openSchoolApp(schoolId){
    const reg = A.loadRegistry();
    const school = reg.schools[schoolId];
    if(!school){
      alert("Không tìm thấy trường trong registry. Thử tải lại danh sách.");
      return;
    }
    let entry = A.activeScheduleEntry(schoolId);
    if(!entry){
      const created = A.createSchoolSchedule(schoolId, todayInputValue());
      if(!created || !created.ok){
        alert((created && created.message) || "Không tạo được TKB đầu tiên.");
        return;
      }
      const active = A.setActiveSchedule(schoolId, created.number);
      if(!active || !active.ok){
        alert((active && active.message) || "Không đặt được TKB hiện hành.");
        return;
      }
      entry = { sid: created.sid, number: created.number };
    }
    if(!entry.sid){
      alert("TKB nay chua co ma luu tru.");
      return;
    }
    window.location.href = "/app?sid=" + encodeURIComponent(entry.sid);
  }

  function scheduleRowsForSchool(school){
    const list = Array.isArray(school?.schedules) ? school.schedules.slice() : [];
    if(list.length){
      return list.sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0));
    }
    if(A.scheduleEntrySid && school){
      return [{
        number: 1,
        effectiveDate: school.effectiveDate || "",
        sid: A.scheduleEntrySid(school, 1),
        original: true
      }];
    }
    return [];
  }

  function activeScheduleNumberForSchool(school, schedules){
    const list = schedules || scheduleRowsForSchool(school);
    const want = Number(school?.activeSchedule);
    const entry = list.find(s => Number(s.number) === want) || list.find(s => s.original) || list[0];
    return Number(entry?.number) || 1;
  }

  function renderScheduleSelect(school){
    const list = scheduleRowsForSchool(school);
    const activeNum = activeScheduleNumberForSchool(school, list);
    if(!list.length){
      return `<select class="portal-plan-select portal-tkb-select" data-act="schedule-select" title="Chọn TKB"><option value="1">TKB 1</option></select>`;
    }
    return `<select class="portal-plan-select portal-tkb-select" data-act="schedule-select" title="Chọn TKB">${
      list.map(item => {
        const num = Number(item.number) || 1;
        return `<option value="${num}"${num === activeNum ? " selected" : ""}>TKB ${num}</option>`;
      }).join("")
    }</select>`;
  }

  function selectedScheduleNumber(row, fallbackSchool){
    const raw = row?.querySelector?.("select[data-act=schedule-select]")?.value;
    const num = Number(raw);
    if(Number.isFinite(num) && num > 0) return num;
    return activeScheduleNumberForSchool(fallbackSchool);
  }

  function resetAddSchoolForm(){
    if(!addSchoolForm) return;
    addSchoolForm.reset();
    const schedule = addSchoolForm.querySelector("[name=scheduleNumber]");
    const date = addSchoolForm.querySelector("[name=effectiveDate]");
    if(schedule) schedule.value = "1";
    if(date) date.value = todayInputValue();
  }

  function openAddSchoolModal(){
    if(!addSchoolModal) return;
    resetAddSchoolForm();
    addSchoolModal.hidden = false;
    const first = addSchoolForm?.querySelector("input[name=name]");
    if(first) setTimeout(() => first.focus(), 0);
  }

  function closeAddSchoolModal(){
    if(!addSchoolModal) return;
    addSchoolModal.hidden = true;
  }

  document.getElementById("btnAddSchool")?.addEventListener("click", openAddSchoolModal);
  document.getElementById("btnCloseAddSchool")?.addEventListener("click", closeAddSchoolModal);
  document.getElementById("btnCancelAddSchool")?.addEventListener("click", closeAddSchoolModal);
  addSchoolModal?.querySelector("[data-close-modal]")?.addEventListener("click", closeAddSchoolModal);
  document.addEventListener("keydown", ev => {
    if(ev.key === "Escape" && addSchoolModal && !addSchoolModal.hidden) closeAddSchoolModal();
  });

  const tbody = document.getElementById("schoolsBody");
  const expandedSchools = new Set();

  function esc(s){
    return String(s == null ? "" : s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  }

  function normalizedSchoolName(value){
    return String(value == null ? "" : value)
      .normalize("NFC")
      .replace(/\s+/g, " ")
      .trim();
  }

  function editSchoolName(id, school){
    const currentName = normalizedSchoolName(school?.name || "");
    const entered = prompt("Tên trường mới:", currentName);
    if(entered === null) return;

    const nextName = normalizedSchoolName(entered);
    if(!nextName){
      alert("Tên trường không được để trống.");
      return;
    }
    if(Array.from(nextName).length > 160){
      alert("Tên trường không được dài quá 160 ký tự.");
      return;
    }
    if(/[\u0000-\u001f\u007f]/.test(nextName)){
      alert("Tên trường chứa ký tự không hợp lệ.");
      return;
    }
    if(nextName === currentName) return;

    // Chỉ gửi trường `name`; mã trường, shortId và các mã phiên bản TKB
    // không thuộc bản vá này nên luôn được giữ nguyên.
    const res = A.updateSchoolMeta(id, { name: nextName });
    if(!res || !res.ok){
      alert((res && res.message) || "Không cập nhật được tên trường.");
      return;
    }
    renderSchools();
  }

  function listSubUsers(schoolId){
    return A.listSchoolUsers(schoolId).filter(u => u.role === "school_user");
  }

  function renderSubUsersRow(schoolId){
    const subs = listSubUsers(schoolId);
    if(!subs.length || !expandedSchools.has(schoolId)) return "";
    return `<tr class="portal-subusers-row" data-parent-id="${esc(schoolId)}">
      <td colspan="6">
        <div class="portal-subusers-panel">
          <div class="portal-subusers-head">Tài khoản phụ (${subs.length}/${A.MAX_SCHOOL_USERS})</div>
          <ul class="portal-subusers-list">
            ${subs.map(u => {
              const active = u.active !== false;
              return `<li class="portal-subusers-item">
                <span class="portal-subusers-id" title="Tên đăng nhập">${esc(u.id)}</span>
                <span class="portal-subusers-name" title="Tên hiển thị">${esc(u.displayName || u.id)}</span>
                <span class="portal-subusers-ip portal-muted" title="IP đăng nhập gần nhất">${u.lastIp ? "IP " + esc(u.lastIp) : "Chưa đăng nhập"}</span>
                <span class="portal-status-badge portal-status-badge-sm ${active ? "is-active" : "is-blocked"}">${active ? "Hoạt động" : "Blocked"}</span>
                <span class="portal-subusers-actions">
                  <button type="button" class="portal-btn portal-btn-xs${active ? "" : " warn"}" data-sub-act="toggle" data-uid="${esc(u.id)}">${active ? "Block" : "Unblock"}</button>
                  <button type="button" class="portal-btn portal-btn-xs" data-sub-act="pwd" data-uid="${esc(u.id)}" title="Đổi mật khẩu">MK</button>
                  <button type="button" class="portal-btn portal-btn-xs danger" data-sub-act="del" data-uid="${esc(u.id)}">Xóa</button>
                </span>
              </li>`;
            }).join("")}
          </ul>
        </div>
      </td>
    </tr>`;
  }

  function renderSchools(){
    const schools = A.listSchools();
    if(!schools.length){
      tbody.innerHTML = `<tr><td colspan="6" class="portal-muted">Chưa có trường nào.</td></tr>`;
      return;
    }
    tbody.innerHTML = schools.map(s => {
      const plan = A.effectivePlan(s);
      const active = s.active !== false;
      const curPlan = String(s.plan || "free").toLowerCase();
      const subs = listSubUsers(s.id);
      const subCount = A.countSchoolSubUsers ? A.countSchoolSubUsers(s.id) : subs.length;
      const hasSubs = subCount > 0;
      const expanded = expandedSchools.has(s.id);
      const planOptions = [
        ["free", "Free"],
        ["trial", "Trial"],
        ["plus", "Plus"],
        ["max", "Max"],
        ["ultra", "Ultra"]
      ];
      const planSelect = `<select class="portal-plan-select" data-act="plan-select" title="Đổi gói">${
        planOptions.map(([id, label]) => `<option value="${id}"${curPlan === id ? " selected" : ""}>${label}</option>`).join("")
      }</select>`;
      const scheduleSelect = renderScheduleSelect(s);
      const expandBtn = hasSubs
        ? `<button type="button" class="portal-expand-btn${expanded ? " is-open" : ""}" data-act="expand" aria-expanded="${expanded ? "true" : "false"}" title="Tài khoản phụ (${subCount})">${expanded ? "−" : "+"}</button>`
        : "";
      return `<tr data-id="${esc(s.id)}" class="portal-school-row">
        <td class="portal-cell-school" data-label="Trường">
          <div class="portal-school-cell">
            ${expandBtn}
            <div class="portal-school-info">
              <strong>${esc(s.name)}</strong>
              <div class="portal-muted portal-cell-sub">${esc(s.ownerLoginId || s.id)}${s.lastIp ? ` · IP ${esc(s.lastIp)}` : ""}</div>
            </div>
          </div>
        </td>
        <td class="portal-cell-email" data-label="Email">
          <div class="portal-cell-primary">${esc(s.ownerEmail)}</div>
          <div class="portal-muted portal-cell-sub">${esc(s.ownerLoginId || "")}${s.ownerPhone ? " · " + esc(A.formatPhone ? A.formatPhone(s.ownerPhone) : s.ownerPhone) : ""}</div>
        </td>
        <td class="portal-cell-plan" data-label="Gói">${A.planBadgeHtml(s.plan, s)}</td>
        <td class="portal-cell-expiry" data-label="Hết hạn">${esc(plan.unlimited ? "Unlimited" : A.formatDate(s.expiresAt))}</td>
        <td class="portal-cell-status" data-label="Trạng thái"><span class="portal-status-badge ${active ? "is-active" : "is-blocked"}">${active ? "Kích hoạt" : "Blocked"}</span></td>
        <td class="portal-cell-actions" data-label="Thao tác">
          <div class="portal-action-bar">
            <button type="button" class="portal-btn portal-btn-sm portal-btn-slot portal-btn-open" data-act="open-tkb" title="Mở TKB hiện hành">TKB</button>
            ${scheduleSelect}
            <button type="button" class="portal-btn portal-btn-sm portal-btn-slot danger" data-act="del-tkb" title="Xóa TKB đang chọn">XTKB</button>
            <button type="button" class="portal-btn portal-btn-sm portal-btn-slot portal-btn-toggle${active ? "" : " warn"}" data-act="toggle">${active ? "Block" : "Unblock"}</button>
            ${planSelect}
            <button type="button" class="portal-btn portal-btn-sm portal-btn-slot portal-btn-expiry" data-act="expiry" title="Chỉnh ngày hết hạn gói">Ngày</button>
            <button type="button" class="portal-btn portal-btn-sm portal-btn-slot portal-btn-pwd" data-act="pwd" title="Đổi mật khẩu admin">MK</button>
            <button type="button" class="portal-btn portal-btn-sm portal-btn-slot portal-btn-edit" data-act="edit" title="Sửa tên trường">Sửa</button>
            <button type="button" class="portal-btn portal-btn-sm portal-btn-slot portal-btn-del danger" data-act="del">Xóa</button>
          </div>
        </td>
      </tr>${renderSubUsersRow(s.id)}`;
    }).join("");
  }

  tbody.addEventListener("change", ev => {
    const scheduleSel = ev.target.closest("select[data-act=schedule-select]");
    if(scheduleSel){
      const row = scheduleSel.closest("tr[data-id]");
      const id = row?.dataset?.id;
      if(!id) return;
      const num = Number(scheduleSel.value);
      const res = A.setActiveSchedule(id, num);
      if(!res || !res.ok){
        alert((res && res.message) || "Không đặt được TKB hiện hành.");
      }
      renderSchools();
      return;
    }

    const sel = ev.target.closest("select[data-act=plan-select]");
    if(!sel) return;
    const row = sel.closest("tr[data-id]");
    const id = row?.dataset?.id;
    if(!id) return;
    const planId = sel.value;
    const res = A.activatePlan(id, planId, planId !== "free" && planId !== "trial");
    if(!res || !res.ok){
      alert((res && res.message) || "Không đổi được gói.");
    }
    renderSchools();
  });

  tbody.addEventListener("click", ev => {
    const expandBtn = ev.target.closest("button[data-act=expand]");
    if(expandBtn){
      const row = expandBtn.closest("tr[data-id]");
      const id = row?.dataset?.id;
      if(!id) return;
      if(expandedSchools.has(id)) expandedSchools.delete(id);
      else expandedSchools.add(id);
      renderSchools();
      return;
    }

    const subBtn = ev.target.closest("button[data-sub-act]");
    if(subBtn){
      const uid = subBtn.dataset.uid;
      const act = subBtn.dataset.subAct;
      if(!uid) return;
      if(act === "toggle"){
        const u = A.loadRegistry().users[uid];
        A.setUserActive(uid, u && u.active === false);
        renderSchools();
        return;
      }
      if(act === "pwd"){
        const pw = prompt("Mật khẩu mới cho " + uid + ":", "");
        if(pw === null) return;
        A.updateUserPassword(uid, pw).then(r => alert(r.ok ? "Đã đổi mật khẩu." : r.message));
        return;
      }
      if(act === "del"){
        if(!confirm("Xóa tài khoản phụ " + uid + "?")) return;
        A.deleteUser(uid);
        renderSchools();
      }
      return;
    }

    const btn = ev.target.closest("button[data-act]");
    if(!btn) return;
    const row = btn.closest("tr[data-id]");
    const id = row?.dataset?.id;
    if(!id) return;
    const reg = A.loadRegistry();
    const school = reg.schools[id];
    if(!school){
      alert("Không tìm thấy trường trong registry. Thử Tải lại danh sách.");
      return;
    }
    const act = btn.dataset.act;

    if(act === "open-tkb"){
      openSchoolApp(id);
      return;
    }
    if(act === "del-tkb"){
      const num = selectedScheduleNumber(row, school);
      const list = A.listSchoolSchedules ? A.listSchoolSchedules(id) : scheduleRowsForSchool(school);
      if(list.length <= 1){
        alert("Không thể xóa. Mỗi trường phải giữ ít nhất 1 TKB.");
        renderSchools();
        return;
      }
      const entry = list.find(s => Number(s.number) === Number(num));
      const label = entry ? (entry.label || entry.number || num) : num;
      if(!confirm("Xóa TKB " + label + " của trường " + school.name + "? Dữ liệu xếp của phiên bản này sẽ mất.")) return;
      const res = A.deleteSchoolSchedule(id, num);
      if(!res || !res.ok){
        alert((res && res.message) || "Không xóa được TKB.");
        return;
      }
      renderSchools();
      return;
    }
    if(act === "toggle"){
      const res = A.setSchoolActive(id, school.active === false);
      if(!res.ok){
        alert(res.message || "Không cập nhật được trạng thái.");
        return;
      }
      renderSchools();
      return;
    }
    if(act === "expiry"){
      const pad = n => String(n).padStart(2, "0");
      const cur = school.expiresAt ? new Date(school.expiresAt) : null;
      const def = cur ? `${cur.getFullYear()}-${pad(cur.getMonth() + 1)}-${pad(cur.getDate())}` : "";
      const input = prompt("Ngày hết hạn gói (YYYY-MM-DD). Để trống = không giới hạn:", def);
      if(input === null) return;
      const res = A.setSchoolExpiry(id, input);
      if(!res.ok){ alert(res.message || "Không cập nhật được ngày hết hạn."); return; }
      renderSchools();
      return;
    }
    if(act === "pwd"){
      const adminId = school.ownerLoginId || Object.values(A.loadRegistry().users || {}).find(u => u.role === "school_admin" && u.schoolId === id)?.id || school.ownerEmail;
      const pw = prompt("Mật khẩu mới cho " + adminId + ":", "");
      if(pw === null) return;
      A.updateUserPassword(adminId, pw).then(r => alert(r.ok ? "Đã đổi mật khẩu." : r.message));
      return;
    }
    if(act === "edit"){
      editSchoolName(id, school);
      return;
    }
    if(act === "del"){
      if(!confirm("Xóa trường " + school.name + "?")) return;
      const res = A.deleteSchool(id);
      if(!res.ok){
        alert(res.message || "Không xóa được trường.");
        return;
      }
      renderSchools();
      return;
    }
  });

  addSchoolForm?.addEventListener("submit", async ev => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const res = await A.superCreateSchool({
      name: fd.get("name"),
      loginId: fd.get("loginId"),
      email: fd.get("email"),
      phone: fd.get("phone"),
      password: fd.get("password"),
      scheduleNumber: fd.get("scheduleNumber"),
      effectiveDate: fd.get("effectiveDate")
    });
    alert(res.ok ? "Đã thêm trường." : res.message);
    if(res.ok){
      resetAddSchoolForm();
      closeAddSchoolModal();
      renderSchools();
    }
  });

  renderSchools();
  document.getElementById("btnReloadSchools")?.addEventListener("click", () => {
    if(A.rebuildSchoolsFromAllSources) A.rebuildSchoolsFromAllSources();
    renderSchools();
  });
})();
