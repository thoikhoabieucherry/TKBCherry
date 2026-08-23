/* Menu "Tối ưu" cạnh nút Xếp.
 *
 * Mỗi mục chỉ chạy đúng một mục tiêu chất lượng của engine FET
 * (`FetTimetableEngine.optimize(mode)`), qua `window.sapXepTheoCheDo(mode)`:
 *
 *   optimize_singletons  1 tiết/buổi   -> soBuoiDay1   (buổi giáo viên dạy đúng 1 tiết)
 *   optimize_sessions    Buổi          -> tsBuoiDay    (dồn buổi ít tiết sang buổi nhiều tiết)
 *   optimize_gap2        2 tiết trống  -> soBuoiTrong2 (một buổi không quá 1 tiết trống)
 *   optimize_gap1        1 tiết trống  -> soBuoiTrong1 (giảm tiết trống của giáo viên)
 *
 * Khóa nút khi đang có lượt xếp/tối ưu do `setAutoSortBusyControls` trong
 * phanmon.js đảm nhiệm; module này chỉ lo đóng/mở và điều phối lệnh.
 */
(function(){
  'use strict';

  var VERSION = 'optimize-menu-v1-four-goals';
  var BUTTON_ID = 'btnOptimizeMenu';
  var MENU_ID = 'plannerOptimizeMenu';
  var VALID_MODES = [
    'optimize_singletons',
    'optimize_sessions',
    'optimize_gap2',
    'optimize_gap1'
  ];

  function button(){ return document.getElementById(BUTTON_ID); }
  function menu(){ return document.getElementById(MENU_ID); }

  function isOpen(){
    var el = menu();
    return !!el && !el.hidden;
  }

  function setOpen(open){
    var btn = button();
    var el = menu();
    if(!btn || !el) return;
    var shouldOpen = !!open && !btn.disabled && !btn.classList.contains('is-auto-sort-disabled');
    el.hidden = !shouldOpen;
    btn.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
    if(shouldOpen){
      var first = el.querySelector('button[data-optimize-mode]:not([hidden])');
      if(first){ try{ first.focus({preventScroll:true}); }catch(_){ } }
    }
  }

  function close(){ setOpen(false); }

  function toggle(ev){
    try{ if(ev){ ev.preventDefault(); ev.stopPropagation(); } }catch(_){ }
    setOpen(!isOpen());
  }

  function runMode(mode){
    var normalized = String(mode || '').trim();
    if(VALID_MODES.indexOf(normalized) < 0) return;
    close();
    var runner = window.sapXepTheoCheDo;
    if(typeof runner !== 'function'){
      if(typeof window.setStatus === 'function'){
        window.setStatus('Chưa tải xong bộ tối ưu, vui lòng thử lại.', 'error');
      }
      return;
    }
    // executeDirectFastSchedule đã có khóa single-flight theo worker thật sự
    // (window.__ACTIVE_TKB_FET_WORKER), nên không tự dựng thêm cờ bận ở đây.
    try{
      var result = runner(normalized);
      if(result && typeof result.catch === 'function'){
        result.catch(function(err){ console.error('optimize menu run failed:', err); });
      }
    }catch(err){
      console.error('optimize menu run failed:', err);
    }
  }

  function onMenuClick(ev){
    var target = ev && ev.target && ev.target.closest
      ? ev.target.closest('button[data-optimize-mode]')
      : null;
    if(!target) return;
    ev.preventDefault();
    ev.stopPropagation();
    runMode(target.getAttribute('data-optimize-mode'));
  }

  function onDocumentPointerDown(ev){
    if(!isOpen()) return;
    var target = ev && ev.target;
    if(target && target.closest && target.closest('.planner-optimize-wrap')) return;
    close();
  }

  function onKeyDown(ev){
    if(!isOpen()) return;
    if(ev.key !== 'Escape' && ev.key !== 'Esc') return;
    close();
    var btn = button();
    if(btn){ try{ btn.focus({preventScroll:true}); }catch(_){ } }
  }

  function bind(){
    var el = menu();
    if(!el || el.dataset.optimizeMenuBound === '1') return;
    el.dataset.optimizeMenuBound = '1';
    el.addEventListener('click', onMenuClick);
  }

  if(!window.__TKB_OPTIMIZE_MENU_BOUND){
    window.__TKB_OPTIMIZE_MENU_BOUND = true;
    document.addEventListener('pointerdown', onDocumentPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', function(ev){
      var el = menu();
      if(el && ev && ev.target && (ev.target === el || (el.contains && el.contains(ev.target)))) return;
      close();
    }, true);
    if(document.readyState === 'loading'){
      document.addEventListener('DOMContentLoaded', bind);
    }else{
      bind();
    }
  }

  window.togglePlannerOptimizeMenu = toggle;
  window.closePlannerOptimizeMenu = close;
  window.runPlannerOptimizeMode = runMode;
  window.__TKB_OPTIMIZE_MENU_VERSION = VERSION;
})();
