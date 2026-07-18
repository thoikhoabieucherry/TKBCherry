(function(){
  'use strict';

  const MENU_ID = 'tkbConstraintsDropdownMenu';
  const STYLE_ID = 'tkbConstraintsDropdownStyle';

  const teacherCommon = [
    ['maxDaysSessions', 'Giới hạn số ngày dạy & buổi dạy/1 tuần'],
    ['maxPeriods', 'Giới hạn số tiết dạy/1 buổi']
  ];
  const teacherTwoShift = [
    ['maxMorningAfternoon', 'Giới hạn số buổi dạy sáng & chiều'],
    ['oneSessionPerDay', 'Chỉ dạy 1 buổi/1 ngày'],
    ['noMorningP5AfternoonP1', 'Không dạy tiết 5 sáng & tiết 1 chiều/1 ngày']
  ];
  const teacherLocations = [
    ['oneLocationPerSession', 'Chỉ dạy 1 địa điểm/1 buổi'],
    ['gapBetweenLocations', 'Có tiết trống giữa 2 địa điểm'],
    ['maxOneMovePerSession', 'Không di chuyển 2 lần/1 buổi giữa các địa điểm']
  ];
  const teacherPositions = [
    ['mustTeach', 'Vị trí phải có tiết dạy']
  ];
  const subjectLessonBlocks = [
    ['lessonBlocks', 'Số buổi học có tiết học xếp liền'],
    ['avoidBreakPair23', 'Tránh xếp 2 tiết liền qua tiết 2-3'],
    ['avoidBreakPair34', 'Tránh xếp 2 tiết liền qua tiết 3-4'],
    ['linkedDays', 'Tránh xếp tiết học liền vào các thứ trong tuần']
  ];
  const subjectTwoShift = [
    ['sessionAllowed', 'Gi\u1edbi h\u1ea1n bu\u1ed5i c\u1ee7a m\u00f4n h\u1ecdc'],
    ['weeklySessionPeriods', 'Giới hạn số tiết của môn học/1 buổi/1 tuần'],
    ['spacingDays', 'Học cách ngày'],
    ['maxPeriods', 'Giới hạn số tiết/1 buổi'],
    ['maxPeriodsDay', 'Giới hạn số tiết/1 ngày']
  ];
  const subjectOther = [
    ['noSameSession', 'Môn học không cùng buổi'],
    ['noSameDay', 'Môn học không cùng ngày'],
    ['maxSessions', 'Giới hạn số buổi học']
  ];
  const fixedOffRules = [
    ['class', 'Yêu cầu cố định lớp học'],
    ['teacher', 'Yêu cầu cố định giáo viên'],
    ['subject', 'Yêu cầu cố định môn học']
  ];
  const timeLimitRules = [
    ['groups-class', 'Tạo nhóm lớp'],
    ['groups-subject', 'Tạo nhóm môn học'],
    ['limits', 'Giới hạn']
  ];
  const printTKBRules = [
    ['class', 'TKB lớp học'],
    ['teacher', 'TKB giáo viên'],
    ['school-class', 'TKB toàn trường theo lớp học'],
    ['school-teacher', 'TKB toàn trường theo giáo viên']
  ];

  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
  }

  function ensureStyle(){
    if(document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = `
      #${MENU_ID}{position:fixed;z-index:1000002;min-width:228px;max-width:calc(100vw - 8px);max-height:calc(100vh - 16px);overflow-y:auto;overflow-x:hidden;background:#fff;border:1px solid #cfd6e3;box-shadow:0 8px 22px rgba(0,0,0,.18);font:13px Arial,sans-serif;color:#222}
      #${MENU_ID},#${MENU_ID} ul{list-style:none;margin:0;padding:4px 0}
      #${MENU_ID} li{position:relative;white-space:nowrap}
      #${MENU_ID} button{width:100%;display:flex;align-items:center;justify-content:space-between;gap:18px;border:0;background:transparent;border-radius:0;padding:7px 28px 7px 14px;text-align:left;color:inherit;font:inherit;cursor:default}
      #${MENU_ID} button:hover,#${MENU_ID} li:hover>button{background:#e8f0ff}
      #${MENU_ID} .rb-menu-arrow{position:absolute;right:9px}
      #${MENU_ID} .rb-menu-sep{height:1px;background:#d8d8d8;margin:4px 0}
      #${MENU_ID} .rb-menu-head{padding:6px 14px 4px;font-weight:700;color:#333}
      #${MENU_ID} .rb-menu-sub{display:none;position:fixed;left:auto;top:auto;min-width:322px;max-width:calc(100vw - 8px);max-height:calc(100vh - 16px);overflow:auto;background:#fff;border:1px solid #cfd6e3;box-shadow:0 8px 22px rgba(0,0,0,.18);padding:4px 0}
      #${MENU_ID} .rb-menu-sub.rb-menu-narrow{min-width:150px}
      #${MENU_ID} li.is-open>.rb-menu-sub{display:block}
      #${MENU_ID} .rb-menu-danger{font-weight:400}
      @media (max-width:700px){
        #${MENU_ID}{left:4px!important;right:4px;width:auto;min-width:0;overflow-y:auto;overflow-x:hidden}
        #${MENU_ID} li{white-space:normal}
        #${MENU_ID} button{padding:8px 28px 8px 12px}
        #${MENU_ID} .rb-menu-sub{position:static!important;left:auto!important;top:auto!important;min-width:0;width:100%;max-width:none;max-height:none;border-left:0;border-right:0;box-shadow:none;margin:0;padding:2px 0 4px 10px}
      }
    `;
    document.head.appendChild(st);
  }

  function openPage(section, rule, title){
    closeMenu();
    const api = window.TKBConstraints || window.TKBConstraintsFull;
    if(!api || typeof api.openPage !== 'function'){
      alert('Chưa tải xong module yêu cầu TKB.');
      return;
    }
    api.openPage({section, rule, title: title || 'Yêu cầu TKB'});
  }

  function rows(section, list){
    return list
      .map(([rule, label]) => `<li><button type="button" data-rb-open="${esc(section)}" data-rb-rule="${esc(rule)}" data-rb-title="${esc(label)}">${esc(label)}</button></li>`)
      .join('');
  }

  function printRows(){
    return `
      <li><button type="button" data-rb-print="class">TKB lớp học</button></li>
      <li>
        <button type="button">TKB giáo viên <span class="rb-menu-arrow">›</span></button>
        <ul class="rb-menu-sub rb-menu-narrow">
          <li><button type="button" data-rb-print="teacher-template-1">Mẫu 1</button></li>
          <li><button type="button" data-rb-print="teacher-template-2">Mẫu 2</button></li>
        </ul>
      </li>
      <li><button type="button" data-rb-print="school-class">TKB toàn trường theo lớp học</button></li>
      <li><button type="button" data-rb-print="school-teacher">TKB toàn trường theo giáo viên</button></li>
    `;
  }

  function buildMenu(){
    const html = `
      <ul>
        <li><button type="button" data-rb-open="dashboard" data-rb-title="Yêu cầu thời khóa biểu">Tổng quan yêu cầu</button></li>
        <li><button type="button" data-rb-open="groups" data-rb-title="Nhóm lớp / môn">Nhóm lớp / môn</button></li>
        <li class="rb-menu-sep"></li>
        <li>
          <button type="button">Yêu cầu của giáo viên <span class="rb-menu-arrow">›</span></button>
          <ul class="rb-menu-sub">
            <li class="rb-menu-head">Yêu cầu chung</li>
            ${rows('teacher', teacherCommon)}
            <li class="rb-menu-sep"></li>
            <li class="rb-menu-head">Yêu cầu của giáo viên dạy 2 ca</li>
            ${rows('teacher', teacherTwoShift)}
            <li class="rb-menu-sep"></li>
            <li class="rb-menu-head">Yêu cầu của giáo viên dạy nhiều địa điểm</li>
            ${rows('teacher', teacherLocations)}
            <li class="rb-menu-sep"></li>
            <li class="rb-menu-head">Vị trí bắt buộc</li>
            ${rows('teacher', teacherPositions)}
          </ul>
        </li>
        <li>
          <button type="button">Yêu cầu của môn học <span class="rb-menu-arrow">›</span></button>
          <ul class="rb-menu-sub">
            <li class="rb-menu-head">Yêu cầu tiết học xếp liền</li>
            ${rows('subject', subjectLessonBlocks)}
            <li class="rb-menu-sep"></li>
            <li class="rb-menu-head">Yêu cầu đối với lớp học 2 ca</li>
            ${rows('subject', subjectTwoShift)}
            <li class="rb-menu-sep"></li>
            <li class="rb-menu-head">Yêu cầu khác</li>
            ${rows('subject', subjectOther)}
          </ul>
        </li>
        <li class="rb-menu-sep"></li>
        <li>
          <button type="button">Yêu cầu cố định <span class="rb-menu-arrow">›</span></button>
          <ul class="rb-menu-sub">
            ${rows('fixedOff', fixedOffRules)}
          </ul>
        </li>
        <li>
          <button type="button">Giới hạn số tiết/1 thời điểm <span class="rb-menu-arrow">›</span></button>
          <ul class="rb-menu-sub">${rows('timeLimit', timeLimitRules)}</ul>
        </li>
        <li class="rb-menu-sep"></li>
        <li><button type="button" class="rb-menu-danger" data-rb-open="clear" data-rb-title="Xóa yêu cầu TKB">Xóa yêu cầu TKB ...</button></li>
        <li class="rb-menu-sep"></li>
        <li>
          <button type="button">In TKB <span class="rb-menu-arrow">›</span></button>
          <ul class="rb-menu-sub">${printRows()}</ul>
        </li>
      </ul>
    `;
    return html.replace(/<li><button type="button" data-rb-open="groups"[\s\S]*?<\/li>\s*/, '');
  }

  function closeMenu(){
    document.getElementById(MENU_ID)?.remove();
    document.removeEventListener('click', onOutsideClick, true);
    window.removeEventListener('resize', closeMenu);
    window.removeEventListener('scroll', closeMenu, true);
  }

  function toggleMenu(anchor){
    const old = document.getElementById(MENU_ID);
    if(old){ closeMenu(); return; }
    ensureStyle();
    const menu = document.createElement('div');
    menu.id = MENU_ID;
    menu.innerHTML = buildMenu();
    document.body.appendChild(menu);
    const rect = (anchor || document.activeElement || document.body).getBoundingClientRect();
    const left = Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8);
    const top = Math.min(rect.bottom + 2, window.innerHeight - menu.offsetHeight - 8);
    menu.style.left = Math.max(4, left) + 'px';
    menu.style.top = Math.max(4, top) + 'px';
    menu.addEventListener('click', ev => {
      ev.stopPropagation();
      const printBtn = ev.target.closest('[data-rb-print]');
      if(printBtn){
        const mode = printBtn.dataset.rbPrint || '';
        closeMenu();
        if(typeof window.handlePrintTKBOption === 'function') window.handlePrintTKBOption(mode);
        return;
      }
      const btn = ev.target.closest('[data-rb-open]');
      if(!btn){
        const parent = ev.target.closest('li');
        const sub = parent && parent.querySelector(':scope > .rb-menu-sub');
        if(sub){
          closeSiblingSubmenus(parent);
          positionSubmenu(menu, parent);
          parent.classList.add('is-open');
          return;
        }
        return;
      }
      openPage(btn.dataset.rbOpen, btn.dataset.rbRule || '', btn.dataset.rbTitle || '');
    });
    const openHoveredSubmenu = ev => {
      const parent = menuItemForTarget(menu, ev.target);
      if(!parent) return;
      if(!parent.querySelector(':scope > .rb-menu-sub')){
        closeSiblingSubmenus(parent);
        return;
      }
      if(ev.relatedTarget && parent.contains(ev.relatedTarget) && parent.classList.contains('is-open')) return;
      closeSiblingSubmenus(parent);
      positionSubmenu(menu, parent);
      parent.classList.add('is-open');
    };
    menu.addEventListener('pointerover', openHoveredSubmenu);
    menu.addEventListener('mouseover', openHoveredSubmenu);
    menu.addEventListener('mousemove', openHoveredSubmenu);
    menu.addEventListener('focusin', openHoveredSubmenu);
    setTimeout(() => document.addEventListener('click', onOutsideClick, true), 0);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
  }

  function menuItemForTarget(menu, target){
    const item = target && target.closest ? target.closest('li') : null;
    if(!item || !menu || !menu.contains(item)) return null;
    return item;
  }

  function closeSiblingSubmenus(parent){
    const root = parent && parent.parentNode;
    if(!root) return;
    Array.from(root.children || []).forEach(item => {
      if(item !== parent && item.classList) item.classList.remove('is-open');
    });
  }

  function positionSubmenu(menu, parent){
    const sub = parent && parent.querySelector(':scope > .rb-menu-sub');
    if(!sub || window.matchMedia('(max-width:700px)').matches) return;
    const parentRect = parent.getBoundingClientRect();
    sub.style.display = 'block';
    const fallbackWidth = sub.classList.contains('rb-menu-narrow') ? 150 : 322;
    const subWidth = Math.max(sub.offsetWidth || fallbackWidth, fallbackWidth);
    const subHeight = sub.offsetHeight || 120;
    let left = parentRect.right + 2;
    if(left + subWidth > window.innerWidth - 6) left = Math.max(4, parentRect.left - subWidth - 2);
    let top = parentRect.top - 4;
    if(top + subHeight > window.innerHeight - 6) top = Math.max(4, window.innerHeight - subHeight - 6);
    sub.style.left = `${Math.max(4, left)}px`;
    sub.style.top = `${Math.max(4, top)}px`;
    sub.style.display = '';
  }

  function onOutsideClick(ev){
    const menu = document.getElementById(MENU_ID);
    if(menu && menu.contains(ev.target)) return;
    closeMenu();
  }

  window.toggleRangBuoc = function(){
    toggleMenu(document.activeElement);
  };
  window.openRangBuocMenu = toggleMenu;
})();
