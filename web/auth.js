(function(){
  "use strict";

  const A = window.TKBAuth;
  if(!A){
    document.body.innerHTML = "<p style='padding:24px;color:#fff'>Thiếu module auth.</p>";
    return;
  }

  const AUTH_RETURN_TO_KEY = "TKB_AUTH_RETURN_TO";
  const AUTH_NOTICE_KEY = "TKB_AUTH_NOTICE";

  function pendingAuthReturnTarget(consume){
    let raw = "";
    try{ raw = sessionStorage.getItem(AUTH_RETURN_TO_KEY) || ""; }catch(_){ }
    try{
      const queryValue = new URLSearchParams(String(location.search || "")).get("returnTo");
      if(queryValue) raw = queryValue;
    }catch(_){ }
    const target = String(raw || "").trim();
    const safe = target.startsWith("/") && !target.startsWith("//") && target !== "/";
    if(consume){
      try{ sessionStorage.removeItem(AUTH_RETURN_TO_KEY); }catch(_){ }
    }
    return safe ? target : "";
  }

  function pendingAuthNotice(){
    let message = "";
    try{
      message = sessionStorage.getItem(AUTH_NOTICE_KEY) || "";
      sessionStorage.removeItem(AUTH_NOTICE_KEY);
    }catch(_){ }
    return String(message || "").trim();
  }

  const ctx = A.currentUser();
  if(ctx){
    window.location.replace(pendingAuthReturnTarget(true) || A.redirectAfterLogin(ctx.user.role));
    return;
  }

  const card = document.getElementById("authCard");
  const alertEl = document.getElementById("authAlert");
  let resetAccount = "";

  const REMEMBER_KEY = "TKB_REMEMBER_LOGIN";

  function loadRemembered(){
    try{
      const raw = localStorage.getItem(REMEMBER_KEY);
      if(!raw) return null;
      const data = JSON.parse(raw);
      if(data && typeof data === "object" && (data.checked === true || typeof data.loginId === "string")) return data;
    }catch(_){}
    return null;
  }

  function saveRemembered(loginId){
    try{
      localStorage.setItem(REMEMBER_KEY, JSON.stringify({
        checked: true,
        loginId: String(loginId || "").trim(),
        updatedAt: new Date().toISOString()
      }));
    }catch(_){}
  }

  function clearRemembered(){
    try{ localStorage.removeItem(REMEMBER_KEY); }catch(_){}
  }

  (function migrateRememberedSecurity(){
    const data = loadRemembered();
    if(data && data.password){
      saveRemembered(data.loginId || "");
    }
  })();

  (function prefillRemembered(){
    const data = loadRemembered();
    if(!data) return;
    const loginInput = document.querySelector("#loginForm [name=loginId]");
    const remember = document.getElementById("rememberMe");
    if(loginInput) loginInput.value = data.loginId || "";
    if(remember) remember.checked = true;
  })();

  (function bindRememberCache(){
    const loginInput = document.querySelector("#loginForm [name=loginId]");
    const remember = document.getElementById("rememberMe");
    if(!remember) return;
    const sync = () => {
      if(remember.checked) saveRemembered(loginInput?.value || "");
      else clearRemembered();
    };
    remember.addEventListener("change", sync);
    loginInput?.addEventListener("input", () => { if(remember.checked) sync(); });
  })();

  function showAlert(msg, type){
    if(!alertEl) return;
    alertEl.textContent = msg || "";
    alertEl.hidden = !msg;
    alertEl.className = "auth-alert" + (type ? " is-" + type : "");
  }

  const authNotice = pendingAuthNotice();
  if(authNotice) showAlert(authNotice, "error");

  function showPane(name){
    card.querySelectorAll("[data-pane]").forEach(p => {
      const on = p.dataset.pane === name;
      p.hidden = !on;
      p.classList.toggle("is-active", on);
    });
    card.querySelectorAll(".auth-tab").forEach(t => {
      const on = t.dataset.tab === name;
      t.classList.toggle("is-active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    });
    if(name !== "forgot") showAlert("");
  }

  card.querySelectorAll(".auth-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      if(tab.dataset.tab === "login" || tab.dataset.tab === "register") showPane(tab.dataset.tab);
    });
  });

  document.getElementById("btnForgotPassword")?.addEventListener("click", () => {
    const loginId = document.querySelector("#loginForm [name=loginId]")?.value || "";
    const forgotInput = document.querySelector("#forgotForm [name=loginOrEmail]");
    if(forgotInput && loginId) forgotInput.value = loginId;
    document.getElementById("resetOtpDemo").hidden = true;
    document.getElementById("resetPwdDemo").hidden = true;
    resetAccount = "";
    showPane("forgot");
  });

  document.getElementById("btnBackLogin")?.addEventListener("click", () => showPane("login"));

  document.getElementById("btnSendResetOtp")?.addEventListener("click", async () => {
    const input = document.querySelector("#forgotForm [name=loginOrEmail]");
    const account = String(input?.value || "").trim();
    if(!account){
      showAlert("Nhập tên đăng nhập hoặc email.", "error");
      return;
    }
    const res = await A.requestPasswordReset(account);
    if(!res.ok){
      showAlert(res.message, "error");
      return;
    }
    resetAccount = account;
    const demo = document.getElementById("resetOtpDemo");
    const codeEl = document.getElementById("resetOtpCode");
    if(demo && codeEl && res.demoOtp){
      demo.hidden = false;
      codeEl.textContent = res.demoOtp;
    }else if(demo){
      demo.hidden = true;
    }
    document.getElementById("resetPwdDemo").hidden = true;
    showAlert("Mã xác thực đã gửi tới " + res.email + ". Kiểm tra hộp thư (kể cả mục Spam).", "success");
  });

  document.getElementById("forgotForm")?.addEventListener("submit", async ev => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const account = resetAccount || String(fd.get("loginOrEmail") || "").trim();
    const code = fd.get("code");
    if(!account){
      showAlert("Nhập tài khoản hoặc email trước.", "error");
      return;
    }
    if(!code){
      showAlert("Nhập mã xác thực 6 số.", "error");
      return;
    }
    const res = await A.confirmPasswordReset(account, code);
    if(!res.ok){
      showAlert(res.message, "error");
      return;
    }
    const pwdDemo = document.getElementById("resetPwdDemo");
    const pwdEl = document.getElementById("resetNewPassword");
    if(pwdDemo && pwdEl && res.demoNewPassword){
      pwdDemo.hidden = false;
      pwdEl.textContent = res.demoNewPassword;
    }
    showAlert(res.message, "success");
    const loginInput = document.querySelector("#loginForm [name=loginId]");
    if(loginInput && !A.isEmail(account)) loginInput.value = account;
    setTimeout(() => showPane("login"), 2500);
  });

  document.getElementById("loginForm")?.addEventListener("submit", async ev => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const ip = await A.fetchClientIp();
    const res = await A.login(fd.get("loginId"), fd.get("password"), ip);
    if(!res.ok){
      showAlert(res.message, "error");
      return;
    }
    if(fd.get("remember")) saveRemembered(fd.get("loginId"));
    else clearRemembered();
    showAlert("Đăng nhập thành công. Đang chuyển...", "success");
    const returnTarget = pendingAuthReturnTarget(true);
    setTimeout(() => { window.location.href = returnTarget || A.redirectAfterLogin(res.role); }, 400);
  });

  function todayIso(){
    const d = new Date();
    const pad = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  document.getElementById("registerForm")?.addEventListener("submit", async ev => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const ip = await A.fetchClientIp();
    const res = await A.registerSchool({
      loginId: fd.get("loginId"),
      password: fd.get("password"),
      email: fd.get("email"),
      phone: fd.get("phone"),
      schoolName: fd.get("schoolName"),
      scheduleNumber: 1,
      effectiveDate: todayIso(),
      clientIp: ip
    });
    if(!res.ok){
      showAlert(res.message, "error");
      return;
    }
    showPane("login");
    const loginInput = document.querySelector("#loginForm [name=loginId]");
    if(loginInput && res.loginId) loginInput.value = res.loginId;
    showAlert(res.message, "success");
  });
})();
