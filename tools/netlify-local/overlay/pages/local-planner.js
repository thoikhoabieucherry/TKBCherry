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
})();
