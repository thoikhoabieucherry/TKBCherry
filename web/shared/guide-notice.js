/* 24/11 (chu du an: "toi muon co 1 thong bao khi nguoi dung vao ho van thay duoc video huong dan
   nay trong giao dien app"): the thong bao "Video huong dan" o goc duoi phai khi vao phan mem
   (app.html + pages/sapxep.html) va hop xem video NGAY TRONG app (window.TKBGuide.open()), de nut
   "Huong dan" tren thanh menu luon mo lai duoc sau khi da tat thong bao.
   Video do nginx phuc vu o /media/ (xem tools/vps-deploy/install-public-media-nginx.py); ban chay
   ngoai tkbcherry.com (Cherry Local, Netlify) lay video tu tkbcherry.com.
   Doi video: sua CHAPTERS + VERSION cho khop web/huong-dan/index.html. */
(function(){
  "use strict";
  if(typeof window === "undefined" || typeof document === "undefined") return;
  if(window.TKBGuide) return;

  var NOTICE_KEY = "TKB_GUIDE_NOTICE_V1";
  var VERSION = "20261124d";
  var CHAPTERS = [
    [0, "Giới thiệu"],
    [24, "Bước 1 · Đăng ký, đăng nhập"],
    [45, "Bước 2 · Khối học, Lớp học"],
    [100, "Bước 3 · Giáo viên"],
    [137, "Bước 4 · Môn học, Tiết chuẩn"],
    [174, "Bước 5 · Phân công"],
    [220, "Bước 6 · Dạy ghép"],
    [247, "Bước 7 · Yêu cầu"],
    [368, "Bước 8 · Xếp TKB"],
    [513, "Bước 9 · Chỉnh tay, in TKB"],
    [575, "Cherry Agent"],
    [648, "Trường hợp đặc biệt"],
    [798, "Tổng kết"]
  ];

  function siteBase(){
    try{
      var host = String(window.location.hostname || "").toLowerCase();
      if(host === "tkbcherry.com" || host === "www.tkbcherry.com") return "";
    }catch(_){ }
    return "https://tkbcherry.com";
  }

  function fmt(t){
    var m = Math.floor(t / 60), s = t % 60;
    return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
  }

  var CSS = [
    "#tkbGuideNotice{position:fixed;right:16px;bottom:60px;z-index:99990;width:320px;max-width:calc(100vw - 32px);",
    "background:#fff;color:#0f172a;border:1px solid #e2e8f0;border-left:4px solid #e11d48;border-radius:12px;",
    "box-shadow:0 12px 32px rgba(15,23,42,.18);padding:12px 14px 12px 14px;font:14px/1.5 system-ui,'Segoe UI',sans-serif}",
    "#tkbGuideNotice[hidden]{display:none}",
    "#tkbGuideNotice .gn-badge{display:inline-block;font:700 11px/1 system-ui,'Segoe UI',sans-serif;letter-spacing:.04em;",
    "color:#be123c;background:#ffe4e6;border-radius:999px;padding:4px 8px;margin-bottom:6px}",
    "#tkbGuideNotice .gn-title{font-weight:700;font-size:15px;margin:0 22px 2px 0}",
    "#tkbGuideNotice .gn-text{margin:0;color:#475569;font-size:13px}",
    "#tkbGuideNotice .gn-actions{display:flex;gap:8px;margin-top:10px}",
    "#tkbGuideNotice .gn-actions button{font:600 13px/1 system-ui,'Segoe UI',sans-serif;padding:9px 12px;border-radius:8px;",
    "border:1px solid #cbd5e1;background:#fff;color:#0f172a;cursor:pointer}",
    "#tkbGuideNotice .gn-actions .gn-primary{background:#e11d48;border-color:#e11d48;color:#fff}",
    "#tkbGuideNotice .gn-close{position:absolute;top:6px;right:6px;width:28px;height:28px;border:0;background:transparent;",
    "color:#64748b;font-size:18px;line-height:1;cursor:pointer;border-radius:6px}",
    "#tkbGuideNotice .gn-close:hover{background:#f1f5f9;color:#0f172a}",
    "#tkbGuideModal{position:fixed;inset:0;z-index:100001;display:flex;align-items:center;justify-content:center;",
    "background:rgba(15,23,42,.6);padding:16px}",
    "#tkbGuideModal[hidden]{display:none}",
    "#tkbGuideModal .gm-card{background:#fff;color:#0f172a;width:100%;max-width:1040px;max-height:calc(100vh - 32px);",
    "border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.35);display:flex;flex-direction:column;overflow:hidden;",
    "font:14px/1.5 system-ui,'Segoe UI',sans-serif}",
    "#tkbGuideModal .gm-head{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid #e2e8f0}",
    "#tkbGuideModal .gm-head h3{margin:0;font-size:16px;flex:1 1 auto}",
    "#tkbGuideModal .gm-head a{color:#be123c;font-weight:600;font-size:13px;text-decoration:none;white-space:nowrap}",
    "#tkbGuideModal .gm-head a:hover{text-decoration:underline}",
    "#tkbGuideModal .gm-x{width:32px;height:32px;border:1px solid #cbd5e1;background:#fff;color:#0f172a;border-radius:8px;",
    "font-size:18px;line-height:1;cursor:pointer;flex:0 0 auto}",
    "#tkbGuideModal .gm-body{display:flex;gap:14px;padding:14px 16px;min-height:0;overflow:auto}",
    "#tkbGuideModal .gm-video{flex:1 1 auto;min-width:0}",
    "#tkbGuideModal video{display:block;width:100%;aspect-ratio:16/9;background:#000;border-radius:10px}",
    "#tkbGuideModal .gm-more{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:baseline;margin-top:10px;font-size:13px;color:#475569}",
    "#tkbGuideModal .gm-more a{color:#be123c;font-weight:600;text-decoration:none}",
    "#tkbGuideModal .gm-more a:hover{text-decoration:underline}",
    "#tkbGuideModal .gm-chapters{flex:0 0 250px;display:flex;flex-direction:column;gap:2px;overflow:auto;max-height:520px}",
    "#tkbGuideModal .gm-chapters button{display:flex;gap:10px;align-items:baseline;text-align:left;border:0;background:transparent;",
    "color:#0f172a;font:500 13px/1.35 system-ui,'Segoe UI',sans-serif;padding:7px 8px;border-radius:7px;cursor:pointer}",
    "#tkbGuideModal .gm-chapters button:hover{background:#f1f5f9}",
    "#tkbGuideModal .gm-chapters button[aria-current=\"true\"]{background:#ffe4e6;color:#9f1239;font-weight:700}",
    "#tkbGuideModal .gm-chapters time{flex:0 0 auto;font-variant-numeric:tabular-nums;color:#64748b;font-size:12px}",
    "@media (max-width:820px){#tkbGuideModal{padding:8px}#tkbGuideModal .gm-body{flex-direction:column;padding:10px}",
    "#tkbGuideModal .gm-chapters{flex:0 0 auto;max-height:none}#tkbGuideModal .gm-card{max-height:calc(100vh - 16px)}}",
    "@media print{#tkbGuideNotice,#tkbGuideModal{display:none!important}}"
  ].join("");

  function ensureCss(){
    if(document.getElementById("tkbGuideCss")) return;
    var style = document.createElement("style");
    style.id = "tkbGuideCss";
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function el(tag, cls, text){
    var node = document.createElement(tag);
    if(cls) node.className = cls;
    if(text) node.textContent = text;
    return node;
  }

  function noticeSeen(){
    try{ return Boolean(window.localStorage && window.localStorage.getItem(NOTICE_KEY)); }catch(_){ return false; }
  }

  function dismissNotice(){
    try{ window.localStorage && window.localStorage.setItem(NOTICE_KEY, String(Date.now())); }catch(_){ }
    var n = document.getElementById("tkbGuideNotice");
    if(n){ try{ n.remove(); }catch(_){ n.hidden = true; } }
  }

  function onKey(event){
    if(event && event.key === "Escape") close();
  }

  function close(){
    var modal = document.getElementById("tkbGuideModal");
    if(!modal) return;
    try{ var v = modal.querySelector("video"); if(v) v.pause(); }catch(_){ }
    modal.hidden = true;
    document.removeEventListener("keydown", onKey, true);
  }

  function open(){
    if(!document.body) return null;
    ensureCss();
    dismissNotice();
    var modal = document.getElementById("tkbGuideModal");
    if(!modal){
      var base = siteBase();
      modal = el("div");
      modal.id = "tkbGuideModal";
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      modal.setAttribute("aria-labelledby", "tkbGuideTitle");
      var card = el("div", "gm-card");
      var head = el("div", "gm-head");
      var title = el("h3", "", "Video hướng dẫn: từ nhập liệu đến xếp TKB hoàn chỉnh");
      title.id = "tkbGuideTitle";
      var link = el("a", "", "Mở ở trang riêng ↗");
      link.href = base + "/huong-dan";
      link.target = "_blank";
      link.rel = "noopener";
      var x = el("button", "gm-x", "×");
      x.type = "button";
      x.id = "tkbGuideClose";
      x.setAttribute("aria-label", "Đóng video hướng dẫn");
      x.addEventListener("click", close);
      head.appendChild(title); head.appendChild(link); head.appendChild(x);
      var body = el("div", "gm-body");
      var wrap = el("div", "gm-video");
      var video = document.createElement("video");
      video.controls = true;
      video.preload = "metadata";
      video.setAttribute("playsinline", "");
      video.poster = base + "/assets/huong-dan/poster.jpg?v=" + VERSION;
      video.src = base + "/media/huong-dan-xep-tkb.mp4?v=" + VERSION;
      wrap.appendChild(video);
      var list = el("div", "gm-chapters");
      list.setAttribute("aria-label", "Mục lục video");
      var buttons = CHAPTERS.map(function(ch){
        var b = el("button");
        b.type = "button";
        b.appendChild(el("time", "", fmt(ch[0])));
        b.appendChild(el("span", "", ch[1]));
        b.addEventListener("click", function(){
          try{ video.currentTime = ch[0]; var p = video.play(); if(p && p.catch) p.catch(function(){}); }catch(_){ }
        });
        list.appendChild(b);
        return b;
      });
      video.addEventListener("timeupdate", function(){
        var t = video.currentTime, cur = 0;
        for(var i = 0; i < CHAPTERS.length; i++){ if(t + 0.25 >= CHAPTERS[i][0]) cur = i; }
        buttons.forEach(function(b, i){
          if(i === cur) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current");
        });
      });
      var more = el("div", "gm-more");
      more.appendChild(el("span", "", "Đọc thêm:"));
      [["#agent", "Cherry Agent: bật ở đâu, cài thế nào"], ["#truong-hop-dac-biet", "Một số trường hợp đặc biệt của trường"]].forEach(function(item){
        var a = el("a", "", item[1] + " ↗");
        a.href = base + "/huong-dan" + item[0];
        a.target = "_blank";
        a.rel = "noopener";
        more.appendChild(a);
      });
      wrap.appendChild(more);
      body.appendChild(wrap); body.appendChild(list);
      card.appendChild(head); card.appendChild(body);
      modal.appendChild(card);
      modal.addEventListener("click", function(event){ if(event && event.target === modal) close(); });
      document.body.appendChild(modal);
    }
    modal.hidden = false;
    document.addEventListener("keydown", onKey, true);
    return modal;
  }

  function showNotice(){
    if(!document.body || document.getElementById("tkbGuideNotice")) return null;
    ensureCss();
    var n = el("div");
    n.id = "tkbGuideNotice";
    n.setAttribute("role", "status");
    n.appendChild(el("span", "gn-badge", "MỚI"));
    n.appendChild(el("div", "gn-title", "Video hướng dẫn xếp TKB"));
    n.appendChild(el("p", "gn-text", "14 phút: 9 bước từ nhập liệu đến thời khóa biểu hoàn chỉnh, kèm Cherry Agent và các trường hợp đặc biệt. Lúc nào cần xem lại, bấm nút Hướng dẫn trên thanh công cụ."));
    var actions = el("div", "gn-actions");
    var watch = el("button", "gn-primary", "▶ Xem video");
    watch.type = "button";
    watch.id = "tkbGuideNoticeWatch";
    watch.addEventListener("click", open);
    var later = el("button", "", "Để sau");
    later.type = "button";
    later.addEventListener("click", dismissNotice);
    actions.appendChild(watch); actions.appendChild(later);
    n.appendChild(actions);
    var x = el("button", "gn-close", "×");
    x.type = "button";
    x.setAttribute("aria-label", "Tắt thông báo");
    x.addEventListener("click", dismissNotice);
    n.appendChild(x);
    document.body.appendChild(n);
    return n;
  }

  function scheduleNotice(){
    if(noticeSeen()) return;
    // Cho trang dung xong; dang xep hoac dang co hop thoai khac (Cherry Agent, cai Cherry.exe) thi doi.
    var tries = 0;
    var attempt = function(){
      if(noticeSeen() || document.getElementById("tkbGuideNotice")) return;
      var other = document.getElementById("tkbAgentAnnounce") || document.getElementById("tkbLocalSolverInstall");
      var busy = window.__TKB_RUST_SOLVER_RUNNING === true || window.__TKB_SOLVE_UI_BUSY === true
        || Boolean(other && !other.hidden);
      if(!busy){ showNotice(); return; }
      tries += 1;
      if(tries < 300) window.setTimeout(attempt, 2000);
    };
    window.setTimeout(attempt, 1800);
  }

  window.TKBGuide = { open: open, close: close, showNotice: showNotice, dismissNotice: dismissNotice };

  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", scheduleNotice);
  else scheduleNotice();
})();
