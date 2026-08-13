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
      ["max1", "Max 1"],
      ["max2", "Max 2"],
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
      const curPlan = String(plan.id || "free").toLowerCase();
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
    if(planId === "max1" || planId === "max2"){
      const selectedPlan = A.PLANS[planId];
      const scope = planId === "max1" ? "tối đa 39 lớp" : "không giới hạn số lớp";
      if(!confirm(`Kích hoạt ${selectedPlan.label} (${scope}) — ${A.formatMoney(selectedPlan.price)}/năm?`)){
        renderSchools();
        return;
      }
    }
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

  function initSolverInfrastructureCard(){
    const card = document.getElementById("solverInfrastructureCard");
    const api = window.TKBAuthApi;
    if(!card || !api || typeof api.getAuthHeaders !== "function" || typeof window.fetch !== "function") return;

    const byId = id => document.getElementById(id);
    const form = byId("solverInfrastructureForm");
    const reloadButton = byId("btnReloadSolverInfrastructure");
    const modeInput = byId("solverInfrastructureMode");
    const activeProfileInput = byId("solverActiveProfileId");
    const profileIdInput = byId("solverProfileId");
    const projectIdInput = byId("solverProfileProjectId");
    const regionInput = byId("solverProfileRegion");
    const urlInput = byId("solverProfileUrl");
    const digestInput = byId("solverProfileDigest");
    const profileBundleInput = byId("solverProfileBundle");
    const importProfileButton = byId("btnImportSolverProfile");
    const refreshGoogleButton = byId("btnRefreshGoogleUsage");
    const infrastructureDetails = byId("solverInfrastructureDetails");
    const accountSwitcher = byId("solverAccountSwitcher");
    const status = byId("solverInfrastructureStatus");
    let currentConfig = { mode:"auto", fallback:"vps", profiles:[] };
    let selectedProfileId = "";
    let googleUsageLoading = false;

    // The portal is intentionally usage-only. Keep the old infrastructure
    // helpers below for rollback/source compatibility, but never enter them
    // from a live card (the deployer also requires this data attribute).
    if(card.dataset?.usageOnly !== "true") return;
    {
      const usageRouteEvent = "tkb:solver-usage-route";
      const usageRouteStorageKey = "TKB_SOLVER_USAGE_ROUTE_V1";
      let usageLoadPromise = null;
      let usageReloadRequested = false;
      const loadUserUsage = () => {
        if(usageLoadPromise){
          usageReloadRequested = true;
          return usageLoadPromise;
        }
        setStatus("Đang tải lượt gọi theo tài khoản…", "");
        usageLoadPromise = (async () => {
          try{
            const payload = await requestJson("/api/admin/solver-usage", {
              headers:api.getAuthHeaders()
            });
            renderAccountUsage(payload?.usage || {});
            setStatus("Đã đồng bộ theo trạng thái luồng xếp.", "success");
          }catch(error){
            setStatus("Không tải được thống kê lượt gọi: " + String(error?.message || error), "error");
          }
        })().finally(() => {
          usageLoadPromise = null;
          if(usageReloadRequested){
            usageReloadRequested = false;
            loadUserUsage();
          }
        });
        return usageLoadPromise;
      };
      const requestUserUsageReload = () => {
        if(usageLoadPromise){
          usageReloadRequested = true;
          return;
        }
        loadUserUsage();
      };
      window.addEventListener?.(usageRouteEvent, requestUserUsageReload);
      window.addEventListener?.("storage", event => {
        if(event?.key === usageRouteStorageKey) requestUserUsageReload();
      });
      window.addEventListener?.("focus", requestUserUsageReload);
      document.addEventListener?.("visibilitychange", () => {
        if(document.visibilityState !== "hidden") requestUserUsageReload();
      });
      loadUserUsage();
      return;
    }

    function setStatus(message, kind){
      if(!status) return;
      status.textContent = String(message || "");
      status.classList.toggle("is-error", kind === "error");
      status.classList.toggle("is-success", kind === "success");
    }

    function revealAccountConfiguration(){
      if(infrastructureDetails) infrastructureDetails.open = true;
      if(accountSwitcher) accountSwitcher.open = true;
    }

    function setBusy(busy){
      card.classList.toggle("is-busy", busy);
      card.setAttribute("aria-busy", busy ? "true" : "false");
      card.querySelectorAll("input, select, textarea, button").forEach(control => { control.disabled = !!busy; });
    }

    function finiteNumber(value, fallback){
      if(value === null || value === undefined || value === "") return fallback;
      const number = Number(value);
      return Number.isFinite(number) ? number : fallback;
    }

    function formatUsd(value){
      return "$" + finiteNumber(value, 0).toLocaleString("en-US", {
        minimumFractionDigits:2,
        maximumFractionDigits:4
      });
    }

    function formatBillingAmount(value, currency){
      const amount = finiteNumber(value, NaN);
      if(!Number.isFinite(amount)) return "—";
      const code = String(currency || "USD").toUpperCase();
      try{
        if(/^[A-Z]{3}$/.test(code)){
          return new Intl.NumberFormat("vi-VN", {
            style:"currency",
            currency:code,
            maximumFractionDigits:code === "VND" ? 0 : 2
          }).format(amount);
        }
      }catch(_){ /* keep the USD-safe fallback */ }
      return formatUsd(amount);
    }

    function formatPercent(value, mode){
      const number = finiteNumber(value, NaN);
      if(!Number.isFinite(number)) return "—";
      // The sanitized Rust snapshot names percentage metrics with a `Pct`
      // suffix and already returns 0..100.  Only legacy/ratio-shaped fields
      // need the 0..1 conversion.  Treating a real 0.5% value as a ratio would
      // incorrectly render it as 50% and could trigger a false warning.
      const percent = mode === "ratio" ? number * 100 : number;
      return Math.max(0, percent).toLocaleString("vi-VN", {maximumFractionDigits:1}) + "%";
    }

    function formatUpdatedAt(value){
      const raw = typeof value === "number" ? value : Date.parse(String(value || ""));
      if(!Number.isFinite(raw)) return "—";
      try{
        return new Date(raw).toLocaleString("vi-VN", {
          hour:"2-digit",
          minute:"2-digit",
          second:"2-digit",
          day:"2-digit",
          month:"2-digit"
        });
      }catch(_){
        return "—";
      }
    }

    function setGoogleWarning(message, level){
      const warning = byId("solverGoogleWarning");
      if(!warning) return;
      warning.textContent = String(message || "");
      ["is-success", "is-warning", "is-danger", "is-error"].forEach(name => warning.classList.toggle(name, false));
      if(level) warning.classList.toggle(`is-${level}`, true);
    }

    function renderGoogleUsage(payload){
      // `/api/admin/solver-usage` returns the sanitized snapshot under
      // `googleCloud`; accept the snapshot itself as well for future callers.
      const snapshot = payload?.googleCloud || payload?.google || payload || {};
      const monitoring = snapshot?.monitoring || {};
      const metrics = monitoring?.metrics || snapshot?.metrics || snapshot?.usage || {};
      const capacity = snapshot?.capacity || {};
      const billing = snapshot?.billing || {};
      const connection = byId("solverGoogleConnection");
      const setConnection = (message, kind) => {
        if(!connection) return;
        connection.textContent = String(message || "");
        connection.classList.toggle("is-error", kind === "error");
        connection.classList.toggle("is-warning", kind === "warning");
        connection.classList.toggle("is-success", kind === "success");
      };
      const hasGoogleSource = snapshot?.status === "ok"
        || snapshot?.configured === true
        || monitoring?.available === true
        || billing?.configured === true;
      const scopeMismatch = snapshot?.scopeMatchesActiveProfile === false
        || billing?.status === "google_usage_scope_mismatch";
      setConnection(
        scopeMismatch
          ? "Sai phạm vi dự án"
          : hasGoogleSource
          ? (snapshot?.stale === true || snapshot?.status === "stale" ? "Đã kết nối · số liệu chậm" : "Đã kết nối tự động")
          : "Chưa có kết nối Google",
        scopeMismatch
          ? "error"
          : hasGoogleSource
            ? (snapshot?.stale === true || snapshot?.status === "stale" ? "warning" : "success")
            : "error"
      );
      const requestCount = metrics.requests60m ?? metrics.requestCount60m ?? metrics.requestCount;
      const instances = metrics.activeInstances
        ?? metrics.instanceCount
        ?? metrics.instances
        ?? metrics.instanceCountLatest
        ?? capacity.instanceCount;
      const cpuIsRatio = metrics.cpuP95Pct === undefined && metrics.cpuPercent === undefined;
      const memoryIsRatio = metrics.memoryP95Pct === undefined && metrics.memoryPercent === undefined;
      const errorIsRatio = metrics.errorRatePct === undefined;
      const cpu = metrics.maxCpuUtilization ?? metrics.cpuMaxUtilization ?? metrics.cpuPercent ?? metrics.cpuP95Pct;
      const memory = metrics.maxMemoryUtilization ?? metrics.memoryMaxUtilization ?? metrics.memoryPercent ?? metrics.memoryP95Pct;
      const errorRate = metrics.errorRate ?? metrics.errorRatio ?? metrics.errorRatePct;
      const setText = (id, value) => {
        const element = byId(id);
        if(element) element.textContent = String(value ?? "");
      };
      setText("solverGoogleRequests", Number.isFinite(Number(requestCount))
        ? Math.max(0, Math.trunc(Number(requestCount))).toLocaleString("vi-VN")
        : "—");
      setText("solverGoogleInstances", Number.isFinite(Number(instances))
        ? Math.max(0, Number(instances)).toLocaleString("vi-VN", {maximumFractionDigits:1})
        : "—");
      setText("solverGoogleCpu", formatPercent(cpu, cpuIsRatio ? "ratio" : "percent"));
      setText("solverGoogleMemory", formatPercent(memory, memoryIsRatio ? "ratio" : "percent"));
      setText("solverGoogleErrorRate", formatPercent(errorRate, errorIsRatio ? "ratio" : "percent"));
      const reconciled = billing.reconciled === true || snapshot?.billingReconciled === true;
      const currency = String(billing.currency || "USD").toUpperCase();
      const grossCost = finiteNumber(billing.grossCost, NaN);
      const rawCredits = finiteNumber(billing.credits, NaN);
      const netCost = finiteNumber(billing.netCost, NaN);
      setText(
        "solverGoogleUpdatedAt",
        reconciled
          ? formatUpdatedAt(billing.latestExportAtMs)
          : billing.status === "billing_export_pending"
            ? "Chưa có dòng chi phí"
            : "—"
      );
      setText("solverGoogleGrossCost", reconciled ? formatBillingAmount(grossCost, currency) : "Chờ Google");
      setText("solverGoogleCreditsApplied", reconciled
        ? formatBillingAmount(Number.isFinite(rawCredits) ? Math.max(0, -rawCredits) : NaN, currency)
        : "Chờ Google");
      setText("solverGoogleNetCost", reconciled ? formatBillingAmount(netCost, currency) : "Chờ Google");

      const warnings = Array.isArray(snapshot?.warnings) ? snapshot.warnings : [];
      const severity = item => String(item?.severity || item?.level || "").toLowerCase();
      const strongest = warnings.find(item => severity(item) === "critical" || severity(item) === "danger" || severity(item) === "error")
        || warnings.find(item => severity(item) === "warning")
        || warnings[0];
      if(strongest){
        const level = severity(strongest) === "critical" || severity(strongest) === "danger"
          ? "danger"
          : severity(strongest) === "error" ? "error" : "warning";
        setGoogleWarning(strongest.message || strongest.code || "Google Cloud đang có cảnh báo.", level);
        return;
      }
      if(snapshot?.available === false || snapshot?.status === "error" || snapshot?.status === "invalid"){
        setGoogleWarning("Chưa có số liệu vận hành Google Cloud; hãy kiểm tra bộ đồng bộ ADC.", "error");
        return;
      }
      if(snapshot?.stale === true || snapshot?.status === "stale" || monitoring?.available === false){
        setGoogleWarning("Số liệu Google Cloud đang chậm hoặc chưa đủ mới; hệ thống vẫn giữ cảnh báo an toàn.", "warning");
        return;
      }
      const cpuNumber = finiteNumber(cpu, 0);
      const memoryNumber = finiteNumber(memory, 0);
      const errorNumber = finiteNumber(errorRate, 0);
      const normalizedCpu = cpuIsRatio ? cpuNumber : cpuNumber / 100;
      const normalizedMemory = memoryIsRatio ? memoryNumber : memoryNumber / 100;
      const normalizedError = errorIsRatio ? errorNumber : errorNumber / 100;
      if(normalizedCpu >= 0.85 || normalizedMemory >= 0.85 || normalizedError >= 0.1){
        setGoogleWarning("Tải Cloud Run đang cao; nên kiểm tra quota và lỗi dịch vụ.", "danger");
      }else if(normalizedCpu >= 0.7 || normalizedMemory >= 0.7 || normalizedError >= 0.03){
        setGoogleWarning("Cloud Run đang tiến gần ngưỡng cảnh báo. Hệ thống vẫn tiếp tục theo dõi.", "warning");
      }else{
        setGoogleWarning("Cloud Run đang ổn định. Dữ liệu vận hành được tự tải lại mỗi 30 giây.", "success");
      }
    }

    async function waitForGoogleRefresh(delayMs){
      if(typeof window.setTimeout !== "function") return;
      await new Promise(resolve => window.setTimeout(resolve, delayMs));
    }

    async function loadGoogleUsage(manual = false){
      if(googleUsageLoading) return;
      googleUsageLoading = true;
      if(refreshGoogleButton) refreshGoogleButton.disabled = true;
      if(manual) setStatus("Đang đồng bộ số liệu Google…", "");
      setGoogleWarning("Đang đồng bộ số liệu từ Google Cloud…", "");
      try{
        const headers = api.getAuthHeaders();
        let requestedAtMs = 0;
        let payload = null;
        if(manual){
          const accepted = await requestJson("/api/admin/solver-usage/refresh", {
            method:"POST",
            headers
          });
          requestedAtMs = finiteNumber(accepted?.refreshRequestedAtMs, 0);
          payload = accepted;
          renderGoogleUsage(accepted?.googleCloud || accepted);
        }

        const attempts = manual && typeof window.setTimeout === "function" ? 20 : 1;
        for(let attempt = 0; attempt < attempts; attempt += 1){
          if(manual) await waitForGoogleRefresh(attempt === 0 ? 750 : 1_500);
          payload = await requestJson("/api/admin/solver-usage", {headers});
          const snapshot = payload?.googleCloud || payload;
          renderGoogleUsage(snapshot);
          if(Array.isArray(payload?.usage?.accountRequests)){
            renderAccountUsage(payload.usage);
          }
          const sampledAtMs = finiteNumber(snapshot?.sampledAtMs, 0);
          if(!manual || requestedAtMs <= 0 || sampledAtMs >= requestedAtMs) break;
        }
        if(manual){
          const snapshot = payload?.googleCloud || payload || {};
          const billing = snapshot?.billing || {};
          if(billing.status === "billing_export_pending"){
            setStatus("Đã kiểm tra Google. Billing Export chưa có dòng chi phí đầu tiên; hệ thống sẽ tự cập nhật khi Google xuất dữ liệu.", "success");
          }else if(billing.reconciled === true){
            setStatus("Đã đồng bộ số tiền Google ghi nhận mới nhất.", "success");
          }else{
            setStatus("Đã gửi yêu cầu đồng bộ; bản mới sẽ tiếp tục tự cập nhật trên máy chủ.", "success");
          }
        }
      }catch(error){
        const connection = byId("solverGoogleConnection");
        if(connection){
          connection.textContent = "Chưa đồng bộ được";
          connection.classList.toggle("is-error", true);
          connection.classList.toggle("is-warning", false);
          connection.classList.toggle("is-success", false);
        }
        const updatedAt = byId("solverGoogleUpdatedAt");
        if(updatedAt) updatedAt.textContent = "Chưa kết nối";
        ["solverGoogleGrossCost", "solverGoogleCreditsApplied", "solverGoogleNetCost"].forEach(id => {
          const element = byId(id);
          if(element) element.textContent = "Chờ Google";
        });
        setGoogleWarning("Chưa đồng bộ được Google Cloud: " + String(error?.message || error), "error");
        if(manual) setStatus("Không đồng bộ được Google: " + String(error?.message || error), "error");
      }finally{
        googleUsageLoading = false;
        if(refreshGoogleButton) refreshGoogleButton.disabled = false;
      }
    }

    function selectedProfile(config, preferredId){
      const profiles = Array.isArray(config?.profiles) ? config.profiles : [];
      const preferred = profiles.find(profile => String(profile?.id || "") === String(preferredId || ""));
      if(preferred) return preferred;
      return profiles
        .filter(profile => profile && profile.enabled !== false)
        .sort((a, b) => finiteNumber(b.priority, 0) - finiteNumber(a.priority, 0))[0] || profiles[0] || null;
    }

    function fillProfileEditor(profile){
      profileIdInput.value = profile?.id || "";
      projectIdInput.value = profile?.projectId || "";
      regionInput.value = profile?.region || "";
      urlInput.value = profile?.url || "";
      digestInput.value = profile?.solverDigest || "";
      const title = byId("solverProfileEditorTitle");
      if(title) title.textContent = profile ? `Thông tin profile: ${profile.id}` : "Thêm Cloud Run profile mới";
    }

    function syncProfileChoices(profiles, activeId){
      if(!activeProfileInput) return;
      activeProfileInput.textContent = "";
      const automatic = document.createElement("option");
      automatic.value = "";
      automatic.textContent = "Tự động theo ưu tiên";
      activeProfileInput.appendChild(automatic);
      profiles
        .filter(profile => profile && profile.enabled !== false && String(profile.id || ""))
        .forEach(profile => {
          const option = document.createElement("option");
          option.value = String(profile.id);
          const projectLabel = String(profile.projectId || profile.id);
          option.textContent = profile.region ? `${projectLabel} · ${profile.region}` : projectLabel;
          activeProfileInput.appendChild(option);
        });
      const addNew = document.createElement("option");
      addNew.value = "__new__";
      addNew.textContent = "+ Kết nối dự án mới";
      activeProfileInput.appendChild(addNew);
      activeProfileInput.value = String(activeId || "");
    }

    function hasForbiddenProfileKey(value){
      if(!value || typeof value !== "object") return false;
      return Object.entries(value).some(([key, child]) => {
        if(/(?:token|secret|password|credential|cookie|private.?key|service.?account)/i.test(key)) return true;
        return child && typeof child === "object" && hasForbiddenProfileKey(child);
      });
    }

    function parseProfileBundle(raw){
      const text = String(raw || "").trim();
      if(!text) throw new Error("Hãy dán mã TKB_CLOUD_PROFILE do công cụ triển khai in ra.");
      const markerLine = text.split(/\r?\n/).find(line => /^\s*TKB_CLOUD_PROFILE\s*=/.test(line));
      const jsonText = (markerLine || text).replace(/^\s*TKB_CLOUD_PROFILE\s*=\s*/, "").trim();
      let decoded;
      try{
        decoded = JSON.parse(jsonText);
      }catch(_){
        throw new Error("Mã cấu hình không phải JSON hợp lệ.");
      }
      if(hasForbiddenProfileKey(decoded)){
        throw new Error("Mã cấu hình có trường bí mật hoặc thông tin xác thực; hệ thống đã từ chối nhập.");
      }
      const source = decoded?.profile && typeof decoded.profile === "object" ? decoded.profile : decoded;
      const profile = {
        id:String(source?.id || "").trim(),
        projectId:String(source?.projectId || source?.project_id || "").trim(),
        region:String(source?.region || "").trim(),
        url:String(source?.url || source?.serviceUrl || "").trim().replace(/\/+$/, ""),
        solverDigest:String(source?.solverDigest || source?.solver_digest || "").trim().toLowerCase()
      };
      if(!profile.id || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(profile.id)) throw new Error("Mã profile trong gói cấu hình không hợp lệ.");
      if(!profile.projectId) throw new Error("Gói cấu hình thiếu Google Cloud Project ID.");
      if(!/^[a-z0-9][a-z0-9-]{0,78}$/i.test(profile.region)) throw new Error("Region trong gói cấu hình không hợp lệ.");
      if(!/^https:\/\/[^\s\/@?#]+\/?$/.test(profile.url)) throw new Error("Service URL trong gói cấu hình không hợp lệ.");
      if(!/^[0-9a-f]{64}$/.test(profile.solverDigest)) throw new Error("Solver digest trong gói cấu hình phải đủ 64 ký tự SHA-256.");
      return { profile };
    }

    function importProfileBundle(){
      try{
        const imported = parseProfileBundle(profileBundleInput?.value);
        selectedProfileId = "";
        if(activeProfileInput) activeProfileInput.value = "__new__";
        modeInput.value = "auto";
        fillProfileEditor(imported.profile);
        byId("solverSelectedProfile").textContent = imported.profile.id;
        setStatus(`Đã nhận cấu hình ${imported.profile.projectId}. Kiểm tra rồi bấm Lưu.`, "success");
      }catch(error){
        setStatus("Không nhập được profile: " + String(error?.message || error), "error");
      }
    }

    function modeSummary(mode, profile, effectiveMode){
      if(effectiveMode === "vps_only" && mode !== "vps_only") return "Cloud Run chưa sẵn sàng — đang dùng VPS";
      if(mode === "vps_only") return "Đang định tuyến: chỉ VPS";
      if(mode === "serverless_only") return `Đang định tuyến: chỉ Cloud Run${profile ? " (" + profile.id + ")" : ""}`;
      return `Đang định tuyến: Cloud Run${profile ? " (" + profile.id + ")" : ""} → VPS dự phòng`;
    }

    function renderAccountUsage(usage){
      const body = byId("solverAccountUsageBody");
      if(!body) return;
      const rows = Array.isArray(usage?.accountRequests) ? usage.accountRequests : [];
      if(!rows.length){
        body.innerHTML = '<tr><td colspan="5" class="portal-muted">Chưa có dữ liệu.</td></tr>';
        return;
      }
      const count = value => String(Math.max(0, Math.trunc(finiteNumber(value, 0))));
      const safe = value => String(value).replace(/[&<>"']/g, character => ({
        "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
      })[character]);
      body.innerHTML = rows
        .slice()
        .sort((a, b) => finiteNumber(b?.totalRequests, 0) - finiteNumber(a?.totalRequests, 0))
        .map(row => {
        const schoolId = String(row?.schoolId || "").trim() || "(chưa gắn trường)";
        const accountId = String(row?.accountId || "").trim() || "(không xác định)";
        return `<tr>
          <td>${safe(schoolId)}</td>
          <td>${safe(accountId)}</td>
          <td>${count(row?.totalRequests)}</td>
          <td>${count(row?.cloudRun?.requests)}</td>
          <td>${count(row?.vps?.requests)}</td>
        </tr>`;
      }).join("");
    }

    function renderInfrastructure(payload, usagePayload){
      const config = payload?.config && typeof payload.config === "object" ? payload.config : {};
      currentConfig = {
        mode:String(config.mode || "auto"),
        fallback:String(config.fallback || "vps"),
        activeProfileId:String(config.activeProfileId || payload?.selectedProfileId || ""),
        profiles:Array.isArray(config.profiles) ? config.profiles.map(profile => Object.assign({}, profile)) : []
      };
      const activeChoice = currentConfig.activeProfileId;
      const profile = selectedProfile(currentConfig, activeChoice || payload?.selectedProfileId);
      selectedProfileId = String(profile?.id || "");
      if(!selectedProfileId && profile) selectedProfileId = String(profile.id || "");
      const usage = usagePayload?.usage || payload?.usage || {};
      const profileUsage = profile && usage?.profiles && typeof usage.profiles === "object"
        ? (usage.profiles[profile.id] || {})
        : {};
      renderAccountUsage(usage);

      modeInput.value = ["auto", "serverless_only", "vps_only"].includes(currentConfig.mode) ? currentConfig.mode : "auto";
      syncProfileChoices(currentConfig.profiles, activeChoice);
      fillProfileEditor(profile);

      byId("solverSelectedProfile").textContent = profile?.id || "Chưa cấu hình";
      byId("solverCompletedJobs").textContent = String(Math.max(0, Math.trunc(finiteNumber(profileUsage.completedJobs, usage.completedJobs || 0))));
      byId("solverFailedJobs").textContent = String(Math.max(0, Math.trunc(finiteNumber(profileUsage.failedJobs, usage.failedJobs || 0))));
      byId("solverInfrastructureEffective").textContent = modeSummary(
        currentConfig.mode,
        profile,
        String(payload?.effectiveMode || currentConfig.mode)
      );
    }

    async function requestJson(url, options){
      const response = await window.fetch(url, Object.assign({cache:"no-store"}, options || {}));
      const data = await response.json().catch(() => ({}));
      if(!response.ok || data?.ok !== true){
        throw new Error(data?.message || data?.detail || data?.error || `HTTP ${response.status}`);
      }
      return data;
    }

    async function loadInfrastructure(successMessage){
      setBusy(true);
      setStatus("Đang tải cấu hình Cloud Run…", "");
      try{
        const headers = api.getAuthHeaders();
        const [infrastructure, usage] = await Promise.all([
          requestJson("/api/admin/solver-infrastructure", {headers}),
          requestJson("/api/admin/solver-usage", {headers})
        ]);
        renderInfrastructure(infrastructure, usage);
        loadGoogleUsage();
        setStatus(successMessage || "", successMessage ? "success" : "");
      }catch(error){
        setStatus("Không tải được cấu hình hạ tầng: " + String(error?.message || error), "error");
      }finally{
        setBusy(false);
      }
    }

    function configFromForm(){
      const mode = String(modeInput.value || "auto");
      const activeChoice = String(activeProfileInput?.value || "").trim();
      const profileFields = {
        id:String(profileIdInput.value || "").trim(),
        projectId:String(projectIdInput.value || "").trim(),
        region:String(regionInput.value || "").trim(),
        url:String(urlInput.value || "").trim().replace(/\/+$/, ""),
        solverDigest:String(digestInput.value || "").trim().toLowerCase()
      };
      const needsCloud = mode !== "vps_only";
      const hasProfileInput = Object.values(profileFields).some(Boolean);
      if(needsCloud || hasProfileInput){
        if(!profileFields.id) throw new Error("Cần nhập mã Cloud Run profile.");
        if(!/^https:\/\/[^\s\/@?#]+\/?$/.test(profileFields.url)){
          throw new Error("Service URL phải là địa chỉ HTTPS gốc, không có path, query hoặc thông tin đăng nhập.");
        }
        if(!/^[0-9a-f]{64}$/.test(profileFields.solverDigest)) throw new Error("Solver digest phải đủ 64 ký tự SHA-256.");
      }

      const profiles = currentConfig.profiles.map(profile => Object.assign({}, profile));
      if(needsCloud || hasProfileInput){
        let index = activeChoice === "__new__"
          ? -1
          : profiles.findIndex(profile => String(profile?.id || "") === selectedProfileId);
        if(index < 0){
          const active = selectedProfile(currentConfig, selectedProfileId);
          index = active ? profiles.indexOf(active) : -1;
        }
        const duplicateIndex = profiles.findIndex((profile, profileIndex) => profileIndex !== index && String(profile?.id || "") === profileFields.id);
        if(duplicateIndex >= 0) throw new Error("Mã profile đã tồn tại trong cấu hình.");
        const maxPriority = profiles.reduce((highest, profile) => Math.max(highest, finiteNumber(profile?.priority, 0)), 0);
        const existing = index >= 0 ? profiles[index] : {};
        const profile = Object.assign({
          enabled:true,
          priority:maxPriority + 1,
          vcpu:6,
          memoryGiB:4,
          maxConcurrency:1
        }, existing, profileFields, {enabled:true});
        if(index >= 0) profiles[index] = profile;
        else profiles.push(profile);
      }

      return {
        mode,
        fallback:mode === "serverless_only" ? "none" : "vps",
        activeProfileId:activeChoice === "__new__"
          ? (profileFields.id || null)
          : (activeChoice
              ? (activeChoice === selectedProfileId ? (profileFields.id || activeChoice) : activeChoice)
              : null),
        profiles
      };
    }

    activeProfileInput?.addEventListener("change", () => {
      const choice = String(activeProfileInput.value || "");
      if(choice === "__new__"){
        revealAccountConfiguration();
        selectedProfileId = "";
        fillProfileEditor(null);
        setStatus("Hãy dùng mã kết nối do công cụ Cloud Run tạo, sau đó bấm Lưu.", "");
        return;
      }
      const profile = selectedProfile(currentConfig, choice);
      selectedProfileId = String(profile?.id || "");
      fillProfileEditor(profile);
      byId("solverSelectedProfile").textContent = profile?.id || "Chưa cấu hình";
      byId("solverInfrastructureEffective").textContent = modeSummary(modeInput.value, profile, modeInput.value);
    });

    importProfileButton?.addEventListener("click", importProfileBundle);
    refreshGoogleButton?.addEventListener("click", () => loadGoogleUsage(true));

    form?.addEventListener("submit", async event => {
      event.preventDefault();
      try{
        const config = configFromForm();
        setBusy(true);
        setStatus("Đang lưu cấu hình hạ tầng…", "");
        const saved = await requestJson("/api/admin/solver-infrastructure", {
          method:"POST",
          headers:api.getAuthHeaders({"Content-Type":"application/json"}),
          body:JSON.stringify(config)
        });
        const usage = await requestJson("/api/admin/solver-usage", {headers:api.getAuthHeaders()});
        renderInfrastructure({
          config:saved.config,
          usage:saved.usage,
          selectedProfileId:selectedProfile(saved.config, profileIdInput.value)?.id || "",
          effectiveMode:saved.config?.mode
        }, usage);
        loadGoogleUsage();
        setStatus("Đã lưu cấu hình. Các lượt xếp mới sẽ dùng chính sách này.", "success");
      }catch(error){
        revealAccountConfiguration();
        setStatus("Không lưu được cấu hình: " + String(error?.message || error), "error");
      }finally{
        setBusy(false);
      }
    });

    reloadButton?.addEventListener("click", () => loadInfrastructure());
    loadInfrastructure();
    if(typeof window.setInterval === "function"){
      const googleUsageTimer = window.setInterval(loadGoogleUsage, 30_000);
      window.addEventListener?.("beforeunload", () => window.clearInterval?.(googleUsageTimer), {once:true});
    }
  }

  initSolverInfrastructureCard();
  renderSchools();
  document.getElementById("btnReloadSchools")?.addEventListener("click", () => {
    if(A.rebuildSchoolsFromAllSources) A.rebuildSchoolsFromAllSources();
    renderSchools();
  });
})();
