(function(){
  "use strict";

  const EYE = "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z'/><circle cx='12' cy='12' r='3'/></svg>";
  const EYE_OFF = "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24'/><line x1='1' y1='1' x2='23' y2='23'/></svg>";

  function decorate(input){
    if(!input || input.dataset.pwToggle === "1") return;
    if(input.type !== "password") return;
    input.dataset.pwToggle = "1";

    const wrap = document.createElement("span");
    wrap.className = "pw-toggle-wrap";
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    input.classList.add("pw-toggle-input");

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pw-toggle-btn";
    btn.setAttribute("aria-label", "Hiện mật khẩu");
    btn.tabIndex = -1;
    btn.innerHTML = EYE;
    wrap.appendChild(btn);

    btn.addEventListener("click", () => {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.innerHTML = show ? EYE_OFF : EYE;
      btn.setAttribute("aria-label", show ? "Ẩn mật khẩu" : "Hiện mật khẩu");
    });
  }

  function scan(root){
    (root || document).querySelectorAll("input[type=password]").forEach(decorate);
  }

  function init(){
    scan(document);
    const mo = new MutationObserver(muts => {
      muts.forEach(m => {
        m.addedNodes.forEach(node => {
          if(node.nodeType !== 1) return;
          if(node.matches && node.matches("input[type=password]")) decorate(node);
          if(node.querySelectorAll) scan(node);
        });
      });
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", init);
  }else{
    init();
  }
})();
