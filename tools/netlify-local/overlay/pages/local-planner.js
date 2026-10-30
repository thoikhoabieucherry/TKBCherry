/* ============================================================
   Cherry Local — pages/local-planner.js  (chỉ có ở bản chạy trong máy)

   Ô chọn THỜI LƯỢNG mỗi lượt Cherry / Tối ưu trên thanh công cụ trang Sắp xếp.
   (13/09: bản web đổi nhãn nút "Tối ưu v3" thành "Tối ưu" — chữ ở đây theo.)
   Bản online giới hạn 90 s (Cherry) / 120 s (Tối ưu) vì tốn máy chủ; bản local
   chạy bằng CPU của chính máy này nên cho chọn dài hơn (tới 30 phút = trần của
   máy chủ local và của bridge). Bridge đọc hai biến này lúc gửi yêu cầu:
     window.__TKB_ENGINE_BUDGET_SECONDS        -> nút Cherry
     window.__TKB_ENGINE_FOCUS_BUDGET_SECONDS  -> menu Tối ưu (từng mục tiêu)
   0 = dùng mặc định của bridge. Lựa chọn được nhớ trong localStorage.
   28/10 (chủ dự án: "nên cho option từ 1 phút 2 phút 3 phút thôi"): chỉ còn 1 / 2 / 3 phút,
   mặc định 2 phút (đo An Phú xếp mới: 1 phút đã hợp lệ 303 buổi / 24 trống, 2 phút 284 / 21,
   3 phút 279 / 15). Giá trị cũ đã lưu (30 giây … 30 phút) làm tròn về một trong ba.
============================================================ */
(function(){
  "use strict";

  const KEY = "CHERRY_LOCAL_ENGINE_BUDGET_SECONDS";
  const DEFAULT_SECONDS = 120;
  const OPTIONS = [
    { value: 60,  label: "1 phút" },
    { value: 120, label: "2 phút" },
    { value: 180, label: "3 phút" }
  ];

  function normalize(value){
    const n = Math.round(Number(value) || 0);
    if(!Number.isFinite(n) || n <= 0) return DEFAULT_SECONDS;
    if(n <= 90) return 60;
    if(n <= 150) return 120;
    return 180;
  }

  function readSaved(){
    try{ return normalize(localStorage.getItem(KEY)); }catch(_){ return DEFAULT_SECONDS; }
  }

  function describe(seconds){
    return `${normalize(seconds) / 60} phút mỗi lượt`;
  }

  function apply(seconds, persist){
    const n = normalize(seconds);
    window.__TKB_ENGINE_BUDGET_SECONDS = n;
    window.__TKB_ENGINE_FOCUS_BUDGET_SECONDS = n;
    window.__CHERRY_LOCAL_ENGINE_BUDGET_SECONDS = n;
    if(persist){
      try{ localStorage.setItem(KEY, String(n)); }catch(_){ }
    }
    const testBtn = typeof document !== "undefined" ? document.getElementById("btnTestMenu") : null;
    if(testBtn){
      testBtn.title = `Tối ưu — từng mục tiêu bằng Cherry engine (${describe(n).replace(" mỗi lượt", "")})`;
    }
    const select = typeof document !== "undefined" ? document.getElementById("localEngineBudget") : null;
    if(select){
      select.value = String(n);
      select.title = `Thời lượng mỗi lượt Cherry / Tối ưu trên máy này: ${describe(n)}`;
    }
    return n;
  }

  function mount(){
    if(document.getElementById("localEngineBudget")) return;
    const actions = document.querySelector(".toolbar-main .toolbar-actions");
    const anchor = document.getElementById("plannerTestWrap") || document.getElementById("btnEngineCherry");
    if(!actions || !anchor) return;
    const wrap = document.createElement("label");
    wrap.id = "localEngineBudgetWrap";
    wrap.className = "local-engine-budget";
    wrap.setAttribute("aria-label", "Thời lượng mỗi lượt Cherry / Tối ưu");
    const icon = document.createElement("span");
    icon.className = "local-engine-budget-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "⏱";
    const select = document.createElement("select");
    select.id = "localEngineBudget";
    for(const opt of OPTIONS){
      const el = document.createElement("option");
      el.value = String(opt.value);
      el.textContent = opt.label;
      select.appendChild(el);
    }
    wrap.appendChild(icon);
    wrap.appendChild(select);
    anchor.insertAdjacentElement("afterend", wrap);
    select.addEventListener("change", () => {
      const n = apply(select.value, true);
      try{
        window._setStatus?.(
          `Mỗi lượt Cherry / Tối ưu sẽ chạy ${describe(n)} trên máy này (bấm Dừng để lấy kết quả tốt nhất sớm hơn).`,
          "info"
        );
      }catch(_){ }
    });
    apply(readSaved(), false);
  }

  apply(readSaved(), false);
  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();

  window.cherryLocalEngineBudget = { read: readSaved, apply: (s) => apply(s, true), describe };

  /* ------------------------------------------------------------
     30/10 — Nút gạt NƠI XẾP cạnh Home (chỗ nút RB của tkbcherry.com; RB chỉ dành superadmin nên
     bản này không hiện). Chủ dự án: "mặc định local thì bấm Cherry chạy = Cherry.exe, tắt đi thì
     chạy về cloud run".
       BẬT (mặc định)  -> Cherry.exe trên máy này (Mac: xếp trên trình duyệt như cũ).
       TẮT             -> máy chủ tkbcherry.com (Cloud Run / VPS do máy chủ chọn); lần đầu hỏi
                          đăng nhập tài khoản tkbcherry.com (shared/auth-local.js giữ phiên).
     Chuột phải khi đang có phiên: đăng xuất. Khoá khi đang xếp.
  ------------------------------------------------------------ */
  const MODE_TOGGLE_ID = "cherrySolverModeToggle";

  function serverApi(){
    return window.__cherryServerMode || null;
  }

  function isWindowsDesktop(){
    try{
      const ua = String(navigator.userAgent || "");
      return /Windows/i.test(ua) && !/Mobi|Android|iPhone|iPad/i.test(ua);
    }catch(_){ return false; }
  }

  function solveBusy(){
    return window.__TKB_RUST_SOLVER_RUNNING === true || window.__TKB_SOLVE_UI_BUSY === true;
  }

  function say(text, kind){
    try{ window._setStatus?.(text, kind || "info"); }catch(_){ }
  }

  function syncModeToggle(){
    const btn = document.getElementById(MODE_TOGGLE_ID);
    const api = serverApi();
    if(!btn || !api) return;
    const server = api.active();
    const session = api.session();
    const localLabel = isWindowsDesktop() ? "Cherry.exe" : "Trình duyệt";
    btn.setAttribute("aria-checked", server ? "false" : "true");
    btn.dataset.mode = server ? "server" : "local";
    btn.querySelector(".cmt-label").textContent = server ? "Máy chủ" : localLabel;
    const tip = server
      ? `Cherry xếp trên máy chủ tkbcherry.com (tài khoản ${session ? session.loginId : "?"}). Bấm để chuyển về ${localLabel}. Chuột phải: đăng xuất.`
      : (isWindowsDesktop()
        ? "Cherry xếp bằng Cherry.exe trên máy này. Bấm để chuyển sang máy chủ tkbcherry.com."
        : "Cherry xếp ngay trên trình duyệt. Bấm để chuyển sang máy chủ tkbcherry.com.")
        + (session ? ` Chuột phải: đăng xuất ${session.loginId}.` : "");
    btn.title = tip;
    btn.setAttribute("aria-label", tip);
    btn.disabled = solveBusy();
  }

  let loginResolve = null;

  function closeLogin(ok){
    const box = document.getElementById("cherryServerLogin");
    if(box) box.hidden = true;
    const done = loginResolve;
    loginResolve = null;
    if(done) done(!!ok);
  }

  function ensureLoginBox(){
    let box = document.getElementById("cherryServerLogin");
    if(box) return box;
    box = document.createElement("div");
    box.id = "cherryServerLogin";
    box.hidden = true;
    box.innerHTML = [
      '<form class="csl-card" role="dialog" aria-modal="true" aria-labelledby="cherryServerLoginTitle" novalidate>',
      '<h3 id="cherryServerLoginTitle">Xếp trên máy chủ tkbcherry.com</h3>',
      '<p class="csl-note">Đăng nhập tài khoản tkbcherry.com. Dữ liệu trường chỉ được gửi lên máy chủ trong lúc xếp; kho trường vẫn lưu trong trình duyệt này.</p>',
      '<label>Tài khoản<input name="loginId" autocomplete="username" required></label>',
      '<label>Mật khẩu<input name="password" type="password" autocomplete="current-password" required></label>',
      '<p class="csl-error" role="alert"></p>',
      '<div class="csl-actions"><button type="submit" class="csl-primary">Đăng nhập</button><button type="button" class="csl-cancel">Huỷ</button></div>',
      '</form>'
    ].join("");
    document.body.appendChild(box);
    const form = box.querySelector("form");
    const error = box.querySelector(".csl-error");
    const submit = box.querySelector(".csl-primary");
    box.querySelector(".csl-cancel").addEventListener("click", () => closeLogin(false));
    box.addEventListener("keydown", event => { if(event.key === "Escape") closeLogin(false); });
    box.addEventListener("click", event => { if(event.target === box) closeLogin(false); });
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const api = serverApi();
      if(!api || submit.disabled) return;
      submit.disabled = true;
      error.textContent = "Đang đăng nhập…";
      const res = await api.login(form.loginId.value, form.password.value).catch(() => ({ok:false, message:"Đăng nhập thất bại."}));
      submit.disabled = false;
      if(!res.ok){
        error.textContent = res.message || "Đăng nhập thất bại.";
        return;
      }
      form.password.value = "";
      error.textContent = "";
      closeLogin(true);
    });
    return box;
  }

  function askServerLogin(){
    const box = ensureLoginBox();
    if(loginResolve) closeLogin(false);
    box.querySelector(".csl-error").textContent = "";
    box.hidden = false;
    const session = serverApi()?.session();
    const id = box.querySelector('input[name="loginId"]');
    if(session && !id.value) id.value = session.loginId;
    (id.value ? box.querySelector('input[name="password"]') : id).focus();
    return new Promise(resolve => { loginResolve = resolve; });
  }

  async function onModeToggleClick(){
    const api = serverApi();
    if(!api) return;
    if(solveBusy()){
      say("Đang xếp lịch — đợi lượt này xong rồi mới đổi nơi xếp.", "warning");
      return;
    }
    if(api.active()){
      api.setMode("local");
      say(isWindowsDesktop() ? "Cherry sẽ xếp bằng Cherry.exe trên máy này." : "Cherry sẽ xếp ngay trên trình duyệt.", "info");
      syncModeToggle();
      return;
    }
    if(!api.session()){
      const ok = await askServerLogin();
      if(!ok){
        syncModeToggle();
        return;
      }
    }
    api.setMode("server");
    syncModeToggle();
    say(`Cherry sẽ xếp trên máy chủ tkbcherry.com (tài khoản ${api.session()?.loginId || ""}).`, "info");
  }

  async function onModeToggleContextMenu(event){
    const api = serverApi();
    const session = api?.session();
    if(!session) return;
    event.preventDefault();
    if(solveBusy()) return;
    if(!window.confirm(`Đăng xuất tài khoản máy chủ ${session.loginId}? Cherry sẽ quay về xếp trên máy này.`)) return;
    await api.logout();
    syncModeToggle();
    say(`Đã đăng xuất ${session.loginId} — Cherry xếp trên máy này.`, "info");
  }

  function mountModeToggle(){
    if(!serverApi() || document.getElementById(MODE_TOGGLE_ID)) return;
    const home = document.getElementById("btnHome");
    if(!home) return;
    const btn = document.createElement("button");
    btn.id = MODE_TOGGLE_ID;
    btn.type = "button";
    btn.className = "cherry-mode-toggle";
    btn.setAttribute("role", "switch");
    btn.innerHTML = '<span class="cmt-track" aria-hidden="true"><span class="cmt-knob"></span></span><span class="cmt-label"></span>';
    btn.addEventListener("click", () => { onModeToggleClick().catch(() => {}); });
    btn.addEventListener("contextmenu", event => { onModeToggleContextMenu(event).catch(() => {}); });
    home.insertAdjacentElement("beforebegin", btn);
    window.addEventListener("cherry:solver-mode", event => {
      syncModeToggle();
      if(event?.detail?.reason === "expired"){
        say("Phiên đăng nhập máy chủ đã hết — Cherry quay về xếp trên máy này. Gạt lại để đăng nhập.", "warning");
      }
    });
    syncModeToggle();
    window.setInterval(() => {
      const el = document.getElementById(MODE_TOGGLE_ID);
      if(el && el.disabled !== solveBusy()) el.disabled = solveBusy();
    }, 1000);
  }

  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountModeToggle);
  else mountModeToggle();
})();
