(function(){
  "use strict";

  const A = window.TKBAuth;
  const auth = A && A.requireAuth(["superadmin"]);
  if(!auth || !auth.ok){
    window.location.replace("/");
    return;
  }

  const PORTAL_ICON_PATHS = Object.freeze({
    key:'<circle cx="7.5" cy="15.5" r="3.5"/><path d="m10 13 9-9"/><path d="m15 4 3 3"/><path d="m12 7 3 3"/>',
    layout:'<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
    logout:'<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
    plus:'<path d="M5 12h14"/><path d="M12 5v14"/>',
    refresh:'<path d="M20 6v5h-5"/><path d="M4 18v-5h5"/><path d="M6.1 9a7 7 0 0 1 11.6-2.6L20 9M4 15l2.3 2.6A7 7 0 0 0 17.9 15"/>',
    calendar:'<path d="M8 2v4M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="m9 16 2 2 4-4"/>',
    calendarClock:'<path d="M8 2v4M16 2v4M3 10h18"/><path d="M18 14v4l2 1"/><path d="M21 12.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h7"/><circle cx="18" cy="18" r="4"/>',
    trash:'<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/>',
    ban:'<circle cx="12" cy="12" r="9"/><path d="m6.4 6.4 11.2 11.2"/>',
    activate:'<circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/>',
    pencil:'<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/>',
    more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    close:'<path d="m6 6 12 12M18 6 6 18"/>',
    chevronDown:'<path d="m6 9 6 6 6-6"/>',
    chevronUp:'<path d="m18 15-6-6-6 6"/>'
  });

  function portalIcon(name){
    const paths = PORTAL_ICON_PATHS[name] || PORTAL_ICON_PATHS.more;
    return `<svg class="portal-ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
  }

  function hydrateStaticIcons(){
    if(!document.querySelectorAll) return;
    document.querySelectorAll("[data-portal-icon]").forEach(slot => {
      slot.innerHTML = portalIcon(slot.dataset.portalIcon);
    });
  }

  hydrateStaticIcons();

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

  function renderScheduleSelect(school, extraClass=""){
    const list = scheduleRowsForSchool(school);
    const activeNum = activeScheduleNumberForSchool(school, list);
    const classes = `portal-plan-select portal-tkb-select${extraClass ? " " + extraClass : ""}`;
    if(!list.length){
      return `<select class="${classes}" data-act="schedule-select" title="Chọn TKB" aria-label="Chọn thời khóa biểu"><option value="1">TKB 1</option></select>`;
    }
    return `<select class="${classes}" data-act="schedule-select" title="Chọn TKB" aria-label="Chọn thời khóa biểu">${
      list.map(item => {
        const num = Number(item.number) || 1;
        return `<option value="${num}"${num === activeNum ? " selected" : ""}>TKB ${num}</option>`;
      }).join("")
    }</select>`;
  }

  function selectedScheduleNumber(row, fallbackSchool, actionTarget){
    const localScope = actionTarget?.closest?.(".portal-action-mobile") || row;
    const raw = localScope?.querySelector?.("select[data-act=schedule-select]")?.value;
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

  function closeSchoolActionMenus(except){
    if(!tbody?.querySelectorAll) return;
    tbody.querySelectorAll("details.portal-row-menu[open]").forEach(menu => {
      if(menu !== except) menu.removeAttribute("open");
    });
  }

  document.addEventListener("click", ev => {
    const inside = ev.target?.closest?.("details.portal-row-menu");
    if(!inside) closeSchoolActionMenus();
  });
  document.addEventListener("keydown", ev => {
    if(ev.key === "Escape") closeSchoolActionMenus();
  });

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
                  <button type="button" class="portal-btn portal-btn-xs${active ? "" : " warn"}" data-sub-act="toggle" data-uid="${esc(u.id)}" title="${active ? "Khóa tài khoản" : "Mở khóa tài khoản"}" aria-label="${active ? "Khóa tài khoản" : "Mở khóa tài khoản"}">${portalIcon(active ? "ban" : "activate")}<span class="portal-action-label">${active ? "Block" : "Unblock"}</span></button>
                  <button type="button" class="portal-btn portal-btn-xs" data-sub-act="pwd" data-uid="${esc(u.id)}" title="Đổi mật khẩu" aria-label="Đổi mật khẩu">${portalIcon("key")}<span class="portal-action-label">MK</span></button>
                  <button type="button" class="portal-btn portal-btn-xs danger" data-sub-act="del" data-uid="${esc(u.id)}" title="Xóa tài khoản phụ" aria-label="Xóa tài khoản phụ">${portalIcon("trash")}<span class="portal-action-label">Xóa</span></button>
                </span>
              </li>`;
            }).join("")}
          </ul>
        </div>
      </td>
    </tr>`;
  }

  function renderPlanSelect(currentPlan, extraClass=""){
    const planOptions = [
      ["free", "Free"],
      ["trial", "Trial"],
      ["plus", "Plus"],
      ["max", "Max"],
      ["ultra", "Ultra"]
    ];
    const classes = `portal-plan-select${extraClass ? " " + extraClass : ""}`;
    return `<select class="${classes}" data-act="plan-select" title="Đổi gói" aria-label="Đổi gói dịch vụ">${
      planOptions.map(([id, label]) => `<option value="${id}"${currentPlan === id ? " selected" : ""}>${label}</option>`).join("")
    }</select>`;
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
      const planSelect = renderPlanSelect(curPlan);
      const mobilePlanSelect = renderPlanSelect(curPlan, "portal-mobile-plan-select");
      const scheduleSelect = renderScheduleSelect(s);
      const mobileScheduleSelect = renderScheduleSelect(s, "portal-mobile-schedule-select");
      const expandBtn = hasSubs
        ? `<button type="button" class="portal-expand-btn${expanded ? " is-open" : ""}" data-act="expand" aria-expanded="${expanded ? "true" : "false"}" title="Tài khoản phụ (${subCount})" aria-label="${expanded ? "Thu gọn" : "Mở"} ${subCount} tài khoản phụ">${portalIcon(expanded ? "chevronUp" : "chevronDown")}</button>`
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
          <div class="portal-action-bar portal-action-desktop">
            <button type="button" class="portal-btn portal-btn-sm portal-btn-slot portal-btn-open" data-act="open-tkb" title="Mở TKB hiện hành" aria-label="Mở TKB hiện hành">${portalIcon("calendar")}<span class="portal-action-label">TKB</span></button>
            ${scheduleSelect}
            <button type="button" class="portal-btn portal-btn-sm portal-btn-slot danger" data-act="del-tkb" title="Xóa TKB đang chọn" aria-label="Xóa TKB đang chọn">${portalIcon("trash")}<span class="portal-action-label">XTKB</span></button>
            <button type="button" class="portal-btn portal-btn-sm portal-btn-slot portal-btn-toggle${active ? "" : " warn"}" data-act="toggle" title="${active ? "Khóa trường" : "Mở khóa trường"}" aria-label="${active ? "Khóa trường" : "Mở khóa trường"}">${portalIcon(active ? "ban" : "activate")}<span class="portal-action-label">${active ? "Block" : "Unblock"}</span></button>
            ${planSelect}
            <button type="button" class="portal-btn portal-btn-sm portal-btn-slot portal-btn-expiry" data-act="expiry" title="Chỉnh ngày hết hạn gói" aria-label="Chỉnh ngày hết hạn gói">${portalIcon("calendarClock")}<span class="portal-action-label">Ngày</span></button>
            <button type="button" class="portal-btn portal-btn-sm portal-btn-slot portal-btn-pwd" data-act="pwd" title="Đổi mật khẩu admin" aria-label="Đổi mật khẩu admin">${portalIcon("key")}<span class="portal-action-label">MK</span></button>
            <button type="button" class="portal-btn portal-btn-sm portal-btn-slot portal-btn-edit" data-act="edit" title="Sửa tên trường" aria-label="Sửa tên trường">${portalIcon("pencil")}<span class="portal-action-label">Sửa</span></button>
            <button type="button" class="portal-btn portal-btn-sm portal-btn-slot portal-btn-del danger" data-act="del" title="Xóa trường" aria-label="Xóa trường">${portalIcon("trash")}<span class="portal-action-label">Xóa</span></button>
          </div>
          <div class="portal-action-mobile" aria-label="Thao tác trường ${esc(s.name)}">
            <button type="button" class="portal-btn portal-btn-sm portal-btn-open portal-mobile-open" data-act="open-tkb" title="Mở TKB hiện hành" aria-label="Mở TKB hiện hành">${portalIcon("calendar")}<span class="portal-visually-hidden">Mở TKB</span></button>
            ${mobileScheduleSelect}
            <details class="portal-row-menu">
              <summary class="portal-more-trigger" title="Thao tác khác" aria-label="Thao tác khác">${portalIcon("more")}<span class="portal-visually-hidden">Thao tác khác</span></summary>
              <div class="portal-action-menu" role="menu" aria-label="Thao tác trường ${esc(s.name)}">
                <div class="portal-action-menu-head">
                  <strong title="${esc(s.name)}">${esc(s.name)}</strong>
                  <button type="button" class="portal-menu-close" data-menu-close title="Đóng" aria-label="Đóng">${portalIcon("close")}</button>
                </div>
                <label class="portal-menu-field"><span>Gói</span>${mobilePlanSelect}</label>
                <button type="button" class="portal-btn portal-btn-sm portal-btn-toggle${active ? "" : " warn"}" data-act="toggle" title="${active ? "Khóa trường" : "Mở khóa trường"}" aria-label="${active ? "Khóa trường" : "Mở khóa trường"}">${portalIcon(active ? "ban" : "activate")}<span>${active ? "Khóa trường" : "Mở khóa"}</span></button>
                <button type="button" class="portal-btn portal-btn-sm danger" data-act="del-tkb" title="Xóa TKB đang chọn" aria-label="Xóa TKB đang chọn">${portalIcon("trash")}<span>Xóa TKB</span></button>
                <button type="button" class="portal-btn portal-btn-sm portal-btn-expiry" data-act="expiry" title="Chỉnh ngày hết hạn gói" aria-label="Chỉnh ngày hết hạn gói">${portalIcon("calendarClock")}<span>Hết hạn</span></button>
                <button type="button" class="portal-btn portal-btn-sm portal-btn-pwd" data-act="pwd" title="Đổi mật khẩu admin" aria-label="Đổi mật khẩu admin">${portalIcon("key")}<span>Mật khẩu</span></button>
                <button type="button" class="portal-btn portal-btn-sm portal-btn-edit" data-act="edit" title="Sửa tên trường" aria-label="Sửa tên trường">${portalIcon("pencil")}<span>Sửa tên</span></button>
                <button type="button" class="portal-btn portal-btn-sm portal-btn-del danger" data-act="del" title="Xóa trường" aria-label="Xóa trường">${portalIcon("trash")}<span>Xóa trường</span></button>
              </div>
            </details>
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
    const menuClose = ev.target.closest("button[data-menu-close]");
    if(menuClose){
      menuClose.closest("details.portal-row-menu")?.removeAttribute("open");
      return;
    }

    const menuTrigger = ev.target.closest("summary.portal-more-trigger");
    if(menuTrigger && tbody.querySelectorAll){
      const current = menuTrigger.closest("details.portal-row-menu");
      tbody.querySelectorAll("details.portal-row-menu[open]").forEach(menu => {
        if(menu !== current) menu.removeAttribute("open");
      });
      return;
    }

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
    btn.closest("details.portal-row-menu")?.removeAttribute("open");
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
      const num = selectedScheduleNumber(row, school, btn);
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
