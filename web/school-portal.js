(function(){
  "use strict";

  const A = window.TKBAuth;
  const auth = A && A.requireAuth(["school_admin"]);
  if(!auth || !auth.ok){
    window.location.replace("/");
    return;
  }

  const schoolId = auth.ctx.session.schoolId;
  const loginId = auth.ctx.user.id;
  let reg = A.loadRegistry();
  let school = reg.schools[schoolId];
  let user = reg.users[loginId] || auth.ctx.user;
  if(!school){
    alert("Không tìm thấy dữ liệu trường.");
    window.location.href = "/";
    return;
  }
  if(A.persistSchoolRecord) A.persistSchoolRecord(school);
  // Chuẩn hóa lại tên trường đầy đủ (có dấu) vào meta/store, phòng khi logic cũ
  // đã lưu nhầm bằng mã trường viết liền không dấu.
  if(school.name && A.updateSchoolMeta) A.updateSchoolMeta(schoolId, { name: school.name });

  document.getElementById("btnLogout").onclick = () => {
    A.logout();
    window.location.href = "/";
  };
  function todayIso(){
    const d = new Date();
    const pad = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  document.getElementById("btnOpenApp").onclick = () => {
    const entry = A.activeScheduleEntry(schoolId);
    if(!entry){
      if(confirm("Chưa có TKB hiện hành. Tạo một TKB mới ngay bây giờ?")){
        const res = A.createSchoolSchedule(schoolId, todayIso());
        if(!res.ok){ alert(res.message || "Không tạo được TKB mới."); return; }
        A.setActiveSchedule(schoolId, res.number);
        if(typeof renderSchedules === "function") renderSchedules();
        window.location.href = "/app?sid=" + encodeURIComponent(res.sid);
      }
      return;
    }
    window.location.href = "/app?sid=" + encodeURIComponent(entry.sid);
  };

  const accountMenu = document.getElementById("accountMenu");
  const accountDropdown = document.getElementById("accountDropdown");
  const accountChip = document.getElementById("btnAccountMenu");

  function isAccountOpen(){
    return accountDropdown && !accountDropdown.hidden;
  }
  function openAccountModal(){
    editingAccount = false;
    renderAccountInfo();
    renderAccountModalSub();
    if(accountDropdown) accountDropdown.hidden = false;
    if(accountChip) accountChip.setAttribute("aria-expanded", "true");
  }
  function closeAccountModal(){
    if(accountDropdown) accountDropdown.hidden = true;
    if(accountChip) accountChip.setAttribute("aria-expanded", "false");
  }
  function toggleAccountModal(){
    if(isAccountOpen()) closeAccountModal();
    else openAccountModal();
  }

  accountChip.onclick = ev => { ev.stopPropagation(); toggleAccountModal(); };
  document.addEventListener("click", ev => {
    if(isAccountOpen() && accountMenu && !accountMenu.contains(ev.target)) closeAccountModal();
  });
  document.addEventListener("keydown", ev => {
    if(ev.key === "Escape" && isAccountOpen()) closeAccountModal();
  });

  renderAccountChip();

  function planUsageText(){
    const plan = A.effectivePlan(school);
    if(plan.unlimited) return "Không giới hạn thời gian";
    if(plan.id === "free" || !school.expiresAt) return "";
    try{
      const exp = new Date(school.expiresAt);
      const days = Math.max(0, Math.ceil((exp.getTime() - Date.now()) / 86400000));
      return "Còn " + days + " ngày · hết hạn " + A.formatDate(school.expiresAt);
    }catch(_){
      return "Hết hạn " + A.formatDate(school.expiresAt);
    }
  }

  function renderAccountChip(){
    const chip = document.getElementById("btnAccountMenu");
    const nameEl = document.getElementById("chipName");
    const planEl = document.getElementById("chipPlan");
    const plan = A.effectivePlan(school);
    if(chip) chip.style.setProperty("--plan-color", plan.color || "#60a5fa");
    if(nameEl) nameEl.textContent = school.name || auth.ctx.user.displayName || auth.ctx.user.id;
    if(planEl){
      planEl.textContent = plan.label || "";
      planEl.style.color = plan.color || "#60a5fa";
    }
  }

  function renderAccountModalSub(){
    const el = document.getElementById("accountModalSub");
    if(!el) return;
    const usage = planUsageText();
    const parts = [A.planBadgeHtml(school.plan, school)];
    if(usage) parts.push('<span class="portal-usage-inline">' + esc(usage) + '</span>');
    el.innerHTML = parts.join(" · ");
  }

  function esc(s){
    return String(s == null ? "" : s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  }

  function refreshUserSchool(){
    reg = A.loadRegistry();
    school = reg.schools[schoolId] || school;
    user = reg.users[loginId] || user;
  }

  function renderEmailVerify(){
    const card = document.getElementById("emailVerifyCard");
    if(!card) return;
    const verified = user.emailVerified === true;
    card.hidden = verified;
    if(verified) return;

    document.getElementById("verifyEmailField").value = user.email || school.ownerEmail || "";
    document.getElementById("verifyPhoneField").value = user.phone || school.ownerPhone || "";
  }

  let otpCountdownTimer = null;

  function formatCountdown(ms){
    const total = Math.max(0, Math.ceil(Number(ms || 0) / 1000));
    const min = Math.floor(total / 60);
    const sec = total % 60;
    return String(min).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
  }

  function setOtpStatus(message, type){
    const el = document.getElementById("portalOtpStatus");
    if(!el) return;
    el.textContent = message || "";
    el.classList.toggle("is-error", type === "error");
    el.classList.toggle("is-success", type === "success");
    el.classList.toggle("is-pending", type === "pending");
  }

  function resetOtpButton(label){
    const btn = document.getElementById("btnSendOtp");
    if(!btn) return;
    btn.disabled = false;
    btn.textContent = label || "Gửi mã xác thực";
  }

  function startOtpCountdown(expiresAt, email){
    if(otpCountdownTimer) clearInterval(otpCountdownTimer);
    const btn = document.getElementById("btnSendOtp");
    if(btn) btn.disabled = true;
    const tick = () => {
      const left = Number(expiresAt || 0) - Date.now();
      if(left <= 0){
        if(otpCountdownTimer) clearInterval(otpCountdownTimer);
        otpCountdownTimer = null;
        resetOtpButton("Gửi lại mã");
        setOtpStatus("Mã đã hết hạn. Bấm Gửi lại mã để nhận mã mới.", "error");
        return;
      }
      const remain = formatCountdown(left);
      if(btn) btn.textContent = "Gửi lại sau " + remain;
      setOtpStatus("Mã đã được gửi tới " + email + ". Mã hết hạn sau " + remain + ".", "success");
    };
    tick();
    otpCountdownTimer = setInterval(tick, 1000);
  }

  document.getElementById("btnSaveContact")?.addEventListener("click", () => {
    const email = document.getElementById("verifyEmailField").value;
    const phone = document.getElementById("verifyPhoneField").value;
    const res = A.updateAccountContact(loginId, { email, phone });
    if(!res.ok){
      alert(res.message);
      return;
    }
    refreshUserSchool();
    renderAccountInfo();
    alert("Đã lưu thông tin liên hệ.");
  });

  document.getElementById("btnSendOtp")?.addEventListener("click", async () => {
    const btn = document.getElementById("btnSendOtp");
    const email = document.getElementById("verifyEmailField").value;
    const phone = document.getElementById("verifyPhoneField").value;
    const saveRes = A.updateAccountContact(loginId, { email, phone });
    if(!saveRes.ok){
      setOtpStatus(saveRes.message, "error");
      return;
    }
    refreshUserSchool();
    if(btn){
      btn.disabled = true;
      btn.textContent = "Đang gửi...";
    }
    setOtpStatus("Đang gửi mã xác thực tới email...", "pending");
    const res = await A.requestEmailVerification(loginId);
    if(!res.ok){
      resetOtpButton();
      setOtpStatus(res.message, "error");
      return;
    }
    const demo = document.getElementById("portalOtpDemo");
    const codeEl = document.getElementById("portalOtpCode");
    if(demo && codeEl && res.demoOtp){
      demo.hidden = false;
      codeEl.textContent = res.demoOtp;
    }
    startOtpCountdown(res.expiresAt || (Date.now() + 60000), res.email || email);
  });

  document.getElementById("otpConfirmForm")?.addEventListener("submit", async ev => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const res = await A.verifyAccountEmail(loginId, fd.get("code"));
    alert(res.ok ? res.message : res.message);
    if(res.ok){
      refreshUserSchool();
      renderEmailVerify();
      renderAccountInfo();
      renderPlans();
      renderAccountChip();
      renderAccountModalSub();
      ev.target.reset();
      document.getElementById("portalOtpDemo").hidden = true;
      if(otpCountdownTimer) clearInterval(otpCountdownTimer);
      otpCountdownTimer = null;
      resetOtpButton();
      setOtpStatus("", "");
    }
  });

  let editingAccount = false;

  function renderAccountInfo(){
    refreshUserSchool();
    if(editingAccount){ renderAccountEdit(); return; }
    const editBtn = document.getElementById("btnEditAccount");
    if(editBtn){ editBtn.hidden = false; editBtn.textContent = "Chỉnh sửa"; }
    const emailStatus = user.emailVerified
      ? '<span style="color:#4ade80">Đã xác thực</span>'
      : '<span style="color:#fbbf24">Chưa xác thực</span>';
    document.getElementById("accountInfo").innerHTML = `
      <div><span class="portal-muted">Tên trường</span><div>${esc(school.name || "-")}</div></div>
      <div><span class="portal-muted">Tên đăng nhập</span><div>${esc(loginId)}</div></div>
      <div><span class="portal-muted">Email</span><div>${esc(user.email || school.ownerEmail)} · ${emailStatus}</div></div>
      <div><span class="portal-muted">Số điện thoại</span><div>${esc(A.formatPhone ? A.formatPhone(user.phone || school.ownerPhone) : (user.phone || school.ownerPhone || "-"))}</div></div>
      <div><span class="portal-muted">Mã trường</span><div>${esc(schoolId)}</div></div>
      <div><span class="portal-muted">Gói hiện tại</span><div>${A.planBadgeHtml(school.plan, school)}</div></div>
      <div><span class="portal-muted">Hết hạn gói</span><div>${esc(A.effectivePlan(school).unlimited ? "Unlimited" : A.formatDate(school.expiresAt))}</div></div>
    `;
  }

  function renderAccountEdit(){
    const editBtn = document.getElementById("btnEditAccount");
    if(editBtn) editBtn.hidden = true;
    const verified = user.emailVerified === true;
    const email = user.email || school.ownerEmail || "";
    const phone = user.phone || school.ownerPhone || "";
    document.getElementById("accountInfo").innerHTML = `
      <div class="portal-field"><label>Tên trường<input type="text" id="accSchoolName" value="${esc(school.name || "")}" /></label></div>
      <div class="portal-field"><label>Tên đăng nhập<input value="${esc(loginId)}" disabled /></label></div>
      <div class="portal-field"><label>Mã trường (không sửa được)<input value="${esc(schoolId)}" disabled readonly autocomplete="off" /></label></div>
      <div class="portal-field"><label>Email${verified ? " (đã xác thực — không sửa được)" : ""}<input type="email" id="accEmail" value="${esc(email)}"${verified ? " disabled" : ""} /></label></div>
      <div class="portal-field"><label>Số điện thoại<input type="tel" id="accPhone" value="${esc(phone)}" /></label></div>
      <div class="portal-grid-2" style="grid-column:1/-1;gap:16px">
        <div class="portal-field"><label>Mật khẩu mới<input type="password" id="accPwd" autocomplete="new-password" minlength="6" placeholder="Bỏ trống nếu giữ nguyên" /></label></div>
        <div class="portal-field"><label>Nhập lại mật khẩu mới<input type="password" id="accPwd2" autocomplete="new-password" /></label></div>
      </div>
      <div class="portal-field" style="grid-column:1/-1;display:flex;gap:10px;flex-wrap:wrap">
        <button type="button" class="portal-btn primary" id="btnSaveAccount">Lưu thay đổi</button>
        <button type="button" class="portal-btn" id="btnCancelAccount">Hủy</button>
      </div>
    `;
    document.getElementById("btnSaveAccount").onclick = saveAccount;
    document.getElementById("btnCancelAccount").onclick = () => { editingAccount = false; renderAccountInfo(); };
  }

  async function saveAccount(){
    const emailEl = document.getElementById("accEmail");
    const phone = document.getElementById("accPhone").value;
    const patch = { phone };
    if(emailEl && !emailEl.disabled) patch.email = emailEl.value;
    const res = A.updateAccountContact(loginId, patch);
    if(!res.ok){ alert(res.message); return; }
    const nameEl = document.getElementById("accSchoolName");
    const newName = nameEl ? String(nameEl.value || "").trim() : "";
    if(newName && newName !== school.name){
      const nres = A.updateSchoolMeta(schoolId, { name: newName });
      if(!nres.ok){ alert(nres.message); return; }
      school.name = newName;
    }
    const pwd = document.getElementById("accPwd").value;
    const pwd2 = document.getElementById("accPwd2").value;
    if(pwd){
      if(pwd.length < 6){ alert("Mật khẩu mới tối thiểu 6 ký tự."); return; }
      if(pwd !== pwd2){ alert("Mật khẩu nhập lại không khớp."); return; }
      const pres = await A.updateUserPassword(loginId, pwd);
      if(!pres.ok){ alert(pres.message); return; }
    }
    editingAccount = false;
    refreshUserSchool();
    renderAccountInfo();
    renderEmailVerify();
    renderAccountChip();
    renderAccountModalSub();
    alert("Đã lưu thông tin tài khoản.");
  }

  document.getElementById("btnEditAccount")?.addEventListener("click", () => {
    editingAccount = true;
    renderAccountInfo();
  });

  const PLAN_RANK = { free: 0, plus: 1, max: 2, ultra: 3 };

  let transferContentText = "";

  function openTransferModal(plan, isRenew){
    const bank = A.BANK_TRANSFER;
    transferContentText = A.transferContentForSchool(school);
    const title = document.getElementById("transferModalTitle");
    const body = document.getElementById("transferModalBody");
    if(title) title.textContent = (isRenew ? "Gia hạn" : "Đăng ký") + " gói " + plan.label;
    if(body){
      body.innerHTML = `
        <p class="portal-muted">Chuyển khoản đúng số tiền gói, sau đó gửi <strong>hình ảnh giao dịch</strong> qua Zalo để được kích hoạt.</p>
        <dl class="portal-topup-dl">
          <div><dt>Ngân hàng</dt><dd>${esc(bank.bank)}</dd></div>
          <div><dt>Số tài khoản</dt><dd><strong>${esc(bank.accountNumber)}</strong></dd></div>
          <div><dt>Chủ tài khoản</dt><dd>${esc(bank.accountName)}</dd></div>
          <div><dt>Số tiền</dt><dd><strong class="portal-topup-amount">${esc(A.formatMoney(plan.price))}</strong></dd></div>
        </dl>
        <p class="portal-transfer-zalo">Sau khi chuyển khoản, gửi ảnh xác nhận qua <a href="${esc(bank.zaloUrl)}" target="_blank" rel="noopener">Zalo ${esc(bank.zaloPhone)}</a> để kích hoạt.</p>`;
    }
    const modal = document.getElementById("transferModal");
    if(modal) modal.hidden = false;
  }

  function closeTransferModal(){
    const modal = document.getElementById("transferModal");
    if(modal) modal.hidden = true;
  }

  function renderPlans(){
    const root = document.getElementById("planCards");
    const eff = A.effectivePlan(school);
    const current = eff.id;
    const currentRank = PLAN_RANK[current] ?? 0;
    let banner = "";
    if(current === "trial"){
      banner = `<div class="portal-trial-banner is-active">Gói Trial — ${esc(planUsageText() || "30 ngày")}. Hết hạn sẽ tự chuyển về gói Free.</div>`;
    }else if(eff.expiredFrom === "trial"){
      banner = `<div class="portal-trial-banner is-expired">Gói Trial đã hết hạn, tài khoản đang ở gói Free. Nâng cấp Plus hoặc Max để dùng đầy đủ tính năng.</div>`;
    }else if(current === "free" && !user.emailVerified && !school.trialUsed){
      banner = `<div class="portal-trial-banner is-active">Xác thực email để nhận ngay <strong>30 ngày miễn phí</strong> đầy đủ tính năng.</div>`;
    }
    root.innerHTML = banner + ["free", "plus", "max"].map(id => A.PLANS[id]).filter(Boolean).map(p => {
      const isCurrent = current === p.id;
      const targetRank = PLAN_RANK[p.id] ?? 0;
      const isDowngrade = targetRank < currentRank;
      let btn = "";
      if(p.id !== "free"){
        if(isCurrent){
          if(!p.unlimited){
            btn = `<button type="button" class="portal-btn primary" data-plan="${p.id}" data-renew="1">Gia hạn · ${A.formatMoney(p.price)}</button>`;
          }
        }else if(isDowngrade){
          btn = `<button type="button" class="portal-btn" disabled>Đăng ký</button>`;
        }else{
          btn = `<button type="button" class="portal-btn primary" data-plan="${p.id}">Đăng ký · ${A.formatMoney(p.price)}</button>`;
        }
      }
      const usage = isCurrent ? planUsageText() : "";
      return `<article class="plan-card${isCurrent ? " is-current" : ""}" style="--plan-color:${p.color}">
        <div class="plan-card-head">
          <h3>${esc(p.label)}</h3>
          ${isCurrent ? '<span class="plan-current-badge">Đang dùng</span>' : ""}
        </div>
        <div class="price">${p.price ? A.formatMoney(p.price) : "Miễn phí"}</div>
        <ul>
          <li>${p.print ? "Được in / xuất TKB" : "Chỉ xếp TKB, không in"}</li>
          <li>${A.planDurationLabel ? A.planDurationLabel(p) : (p.durationDays ? p.durationDays + " ngày sử dụng" : "Không giới hạn thời gian")}</li>
        </ul>
        ${usage ? `<div class="plan-usage">${esc(usage)}</div>` : ""}
        ${btn}
      </article>`;
    }).join("");

    root.querySelectorAll("[data-plan]").forEach(btn => {
      btn.onclick = () => {
        const planId = btn.dataset.plan;
        const plan = A.PLANS[planId];
        if(!plan) return;
        const isRenew = btn.dataset.renew === "1";
        if(!isRenew && (PLAN_RANK[planId] ?? 0) <= currentRank) return;
        openTransferModal(plan, isRenew);
      };
    });
  }

  document.getElementById("btnCloseTransfer")?.addEventListener("click", closeTransferModal);
  document.querySelector("[data-close-transfer]")?.addEventListener("click", closeTransferModal);

  function updateSubUsersHeading(){
    const used = A.countSchoolSubUsers(schoolId);
    const el = document.getElementById("subUsersHeading");
    if(el) el.textContent = `Quản lý tài khoản phụ (${used}/${A.MAX_SCHOOL_USERS})`;
  }

  function syncAddUserForm(){
    const used = A.countSchoolSubUsers(schoolId);
    const atLimit = used >= A.MAX_SCHOOL_USERS;
    const canAdd = A.canAddSchoolUsers(school) && !atLimit;
    const form = document.getElementById("addUserForm");
    const hint = document.getElementById("addUserPlanHint");
    const btn = document.getElementById("btnAddUser");
    if(form){
      form.querySelectorAll("input,button").forEach(el => { el.disabled = !canAdd; });
    }
    if(btn) btn.disabled = !canAdd;
    if(hint){
      if(!A.canAddSchoolUsers(school)){
        hint.textContent = "Nâng cấp Plus hoặc Max để thêm tài khoản phụ.";
        hint.hidden = false;
      }else if(atLimit){
        hint.textContent = `Đã đủ ${A.MAX_SCHOOL_USERS} tài khoản phụ. Xóa bớt để thêm mới.`;
        hint.hidden = false;
      }else{
        hint.textContent = "";
        hint.hidden = true;
      }
    }
    updateSubUsersHeading();
  }

  function renderUsers(){
    const users = A.listSchoolUsers(schoolId);
    const body = document.getElementById("usersBody");
    updateSubUsersHeading();
    if(!users.length){
      body.innerHTML = `<tr><td colspan="5" class="portal-muted">Chưa có tài khoản phụ.</td></tr>`;
      return;
    }
    body.innerHTML = users.map(u => {
      const active = u.active !== false;
      const roleLabel = u.role === "school_admin" ? "Admin" : "Người dùng";
      const actions = u.role === "school_admin" ? "" : `
        <div class="portal-user-actions">
          <button type="button" class="portal-btn portal-btn-slot${active ? "" : " warn"}" data-uid="${esc(u.id)}" data-act="toggle">${active ? "Block" : "Unblock"}</button>
          <button type="button" class="portal-btn portal-btn-slot" data-uid="${esc(u.id)}" data-act="pwd">Đổi MK</button>
          <button type="button" class="portal-btn portal-btn-slot danger" data-uid="${esc(u.id)}" data-act="del">Xóa</button>
        </div>`;
      return `<tr>
        <td>${esc(u.id)}</td>
        <td>${esc(u.displayName || u.id)}</td>
        <td>${roleLabel}</td>
        <td><span class="portal-status-badge ${active ? "is-active" : "is-blocked"}">${active ? "Hoạt động" : "Blocked"}</span></td>
        <td class="portal-cell-user-actions">${actions}</td>
      </tr>`;
    }).join("");
  }

  document.getElementById("usersBody").addEventListener("click", ev => {
    const btn = ev.target.closest("button[data-act]");
    if(!btn) return;
    const uid = btn.dataset.uid;
    const act = btn.dataset.act;
    if(act === "toggle"){
      const u = A.loadRegistry().users[uid];
      A.setUserActive(uid, u && u.active === false);
      renderUsers();
    }else if(act === "pwd"){
      const pw = prompt("Mật khẩu mới:", "");
      if(pw === null) return;
      A.updateUserPassword(uid, pw).then(r => alert(r.ok ? "Đã đổi." : r.message));
    }else if(act === "del"){
      if(!confirm("Xóa tài khoản " + uid + "?")) return;
      A.deleteUser(uid);
      renderUsers();
    }
  });

  document.getElementById("addUserForm").addEventListener("submit", async ev => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const res = await A.createSchoolUser(schoolId, fd.get("loginId"), fd.get("password"), fd.get("displayName"));
    alert(res.ok ? "Đã thêm tài khoản." : res.message);
    if(res.ok){
      ev.target.reset();
      renderUsers();
    }
  });

  function activeScheduleSid(){
    const entry = A.activeScheduleEntry(schoolId);
    return entry ? entry.sid : schoolId;
  }

  function activeScheduleNumber(){
    const entry = A.activeScheduleEntry(schoolId);
    return entry ? Number(entry.number) : 1;
  }

  let editingScheduleNum = null;
  let newScheduleNum = null;

  function renderSchedules(){
    const body = document.getElementById("schedulesBody");
    if(!body) return;
    const list = A.listSchoolSchedules(schoolId);
    const activeNum = activeScheduleNumber();
    body.innerHTML = list.map(s => {
      const isActive = Number(s.number) === activeNum;
      const editing = editingScheduleNum === Number(s.number);
      const title = s.label ? esc(s.label) : esc(s.number);
      if(editing){
        return `
      <tr data-num="${s.number}" class="is-editing-schedule">
        <td>
          <input type="text" class="portal-schedule-label" data-num="${s.number}" value="${esc(s.label || s.number)}" placeholder="Tên / số" />
          <div class="portal-muted portal-cell-sub">Mã: ${esc(s.sid)}</div>
        </td>
        <td><input type="date" class="portal-schedule-date-edit" data-num="${s.number}" value="${esc(s.effectiveDate || "")}" /></td>
        <td>
          <div class="portal-user-actions portal-schedule-actions">
            <button type="button" class="portal-btn portal-btn-slot primary" data-sc-act="save" data-num="${s.number}">Lưu</button>
            <button type="button" class="portal-btn portal-btn-slot" data-sc-act="cancel" data-num="${s.number}">Hủy</button>
          </div>
        </td>
      </tr>`;
      }
      return `
      <tr data-num="${s.number}"${isActive ? ' class="is-active-schedule"' : ""}>
        <td><strong>${title}</strong>${isActive ? ' <span class="portal-schedule-tag">Hiện hành</span>' : ""}<div class="portal-muted portal-cell-sub">Mã: ${esc(s.sid)}</div></td>
        <td>${s.effectiveDate ? esc(A.formatDate(s.effectiveDate)) : '<span class="portal-muted">Chưa đặt</span>'}</td>
        <td>
          <div class="portal-user-actions portal-schedule-actions">
            ${isActive ? "" : `<button type="button" class="portal-btn portal-btn-slot" data-sc-act="activate" data-num="${s.number}">Hiện hành</button>`}
            <button type="button" class="portal-btn portal-btn-slot" data-sc-act="edit" data-num="${s.number}">Sửa</button>
            <button type="button" class="portal-btn portal-btn-slot" data-sc-act="copy" data-num="${s.number}">Copy</button>
            <button type="button" class="portal-btn portal-btn-slot danger" data-sc-act="del" data-num="${s.number}">Xóa</button>
          </div>
        </td>
      </tr>`;
    }).join("");
  }

  document.getElementById("schedulesBody").addEventListener("click", ev => {
    const dateInput = ev.target.closest("input.portal-schedule-date-edit");
    if(dateInput && typeof dateInput.showPicker === "function"){
      try{ dateInput.showPicker(); }catch(_){}
    }
    const btn = ev.target.closest("button[data-sc-act]");
    if(!btn) return;
    const num = Number(btn.dataset.num);
    const act = btn.dataset.scAct;
    const list = A.listSchoolSchedules(schoolId);
    const entry = list.find(s => Number(s.number) === num);
    if(!entry) return;
    if(act === "activate"){
      const res = A.setActiveSchedule(schoolId, num);
      if(!res.ok){ alert(res.message || "Không đặt được TKB hiện hành."); return; }
      renderSchedules();
    }else if(act === "edit"){
      editingScheduleNum = num;
      renderSchedules();
    }else if(act === "cancel"){
      if(newScheduleNum === num){
        A.deleteSchoolSchedule(schoolId, num);
        newScheduleNum = null;
      }
      editingScheduleNum = null;
      renderSchedules();
    }else if(act === "save"){
      const row = btn.closest("tr");
      const dateEl = row.querySelector("input.portal-schedule-date-edit");
      const labelEl = row.querySelector("input.portal-schedule-label");
      let label = labelEl ? labelEl.value.trim() : "";
      if(!label){
        alert("Phần tên/số không được để trống.");
        labelEl?.focus();
        return;
      }
      if(label === String(num)) label = "";
      const res = A.updateSchedule(schoolId, num, {
        label: label,
        effectiveDate: dateEl ? dateEl.value : ""
      });
      if(!res.ok){ alert(res.message || "Không lưu được."); return; }
      const wasNew = newScheduleNum === num;
      newScheduleNum = null;
      editingScheduleNum = null;
      if(wasNew) A.setActiveSchedule(schoolId, num);
      renderSchedules();
      if(wasNew) alert("Đã tạo TKB " + (label || num) + " và đặt làm hiện hành.");
    }else if(act === "copy"){
      const res = A.copySchoolSchedule(schoolId, num);
      if(!res.ok){ alert(res.message || "Không sao chép được."); return; }
      A.setActiveSchedule(schoolId, res.number);
      renderSchedules();
      alert("Đã tạo TKB số " + res.number + " (sao chép từ TKB số " + num + ") và đặt làm hiện hành. Sửa ngày áp dụng rồi bấm “Mở phần mềm TKB”.");
    }else if(act === "del"){
      if(list.length <= 1){
        alert("Không thể xóa. Phải luôn tồn tại ít nhất một TKB.");
        return;
      }
      if(!confirm("Xóa TKB số " + num + "? Dữ liệu xếp của phiên bản này sẽ mất.")) return;
      const res = A.deleteSchoolSchedule(schoolId, num);
      if(!res.ok){ alert(res.message || "Không xóa được."); return; }
      if(editingScheduleNum === num) editingScheduleNum = null;
      renderSchedules();
    }
  });

  document.getElementById("btnNewSchedule")?.addEventListener("click", () => {
    const res = A.createSchoolSchedule(schoolId, todayIso());
    if(!res.ok){ alert(res.message || "Không tạo được TKB mới."); return; }
    newScheduleNum = res.number;
    editingScheduleNum = res.number;
    renderSchedules();
    const row = document.querySelector(`#schedulesBody tr[data-num="${res.number}"]`);
    row?.querySelector("input.portal-schedule-label")?.focus();
  });

  renderEmailVerify();
  renderAccountInfo();
  renderPlans();
  renderSchedules();
  syncAddUserForm();
  renderUsers();
})();
