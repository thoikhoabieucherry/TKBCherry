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
============================================================ */
(function(){
  "use strict";

  const KEY = "CHERRY_LOCAL_ENGINE_BUDGET_SECONDS";
  const MAX_SECONDS = 1800;
  const OPTIONS = [
    { value: 0,    label: "Mặc định" },
    { value: 30,   label: "30 giây" },
    { value: 45,   label: "45 giây" },
    { value: 60,   label: "60 giây" },
    { value: 180,  label: "3 phút" },
    { value: 300,  label: "5 phút" },
    { value: 600,  label: "10 phút" },
    { value: 900,  label: "15 phút" },
    { value: 1800, label: "30 phút" }
  ];

  function normalize(value){
    const n = Math.round(Number(value) || 0);
    if(!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(MAX_SECONDS, Math.max(30, n));
  }

  function readSaved(){
    try{ return normalize(localStorage.getItem(KEY)); }catch(_){ return 0; }
  }

  function describe(seconds){
    if(seconds <= 0) return "Cherry 180 giây · Tối ưu 120 giây (như bản online)";
    return seconds % 60 === 0 ? `${seconds / 60} phút mỗi lượt` : `${seconds} giây mỗi lượt`;
  }

  function apply(seconds, persist){
    const n = normalize(seconds);
    window.__TKB_ENGINE_BUDGET_SECONDS = n;
    window.__TKB_ENGINE_FOCUS_BUDGET_SECONDS = n;
    window.__CHERRY_LOCAL_ENGINE_BUDGET_SECONDS = n;
    if(persist){
      try{
        if(n > 0) localStorage.setItem(KEY, String(n));
        else localStorage.removeItem(KEY);
      }catch(_){ }
    }
    const testBtn = document.getElementById("btnTestMenu");
    if(testBtn){
      const span = n > 0 ? describe(n).replace(" mỗi lượt", "") : "≈120 giây";
      testBtn.title = `Tối ưu — từng mục tiêu bằng Cherry engine (${span})`;
    }
    const select = document.getElementById("localEngineBudget");
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
          n > 0
            ? `Mỗi lượt Cherry / Tối ưu sẽ chạy ${describe(n)} trên máy này (bấm Dừng để lấy kết quả tốt nhất sớm hơn).`
            : "Thời lượng mỗi lượt về mặc định (Cherry 180 giây, Tối ưu 120 giây).",
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
})();
