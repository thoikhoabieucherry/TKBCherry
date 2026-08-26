// 22/08 (dem): nut TEST (chi superadmin) duoc CONG KHAI thanh menu "Toi uu v3":
// 4 muc tieu rieng le chay bang Cherry engine v3 (tkbRunEngine('cherry', _, {mode})),
// luot nhanh 45s, khong vi pham rang buoc. Kiem tra tinh HTML + bridge.
// Chay: node tools/tests/v3_menu_test.js
const fs = require('fs');

const html = fs.readFileSync('web/pages/sapxep.html', 'utf8');
const bridge = fs.readFileSync('web/pages/tkb-rust-bridge.js', 'utf8');
const entry = fs.readFileSync('solver_runtime/src/tkb_engine_v3/entry.py', 'utf8');
const construct = fs.readFileSync('solver_runtime/src/tkb_engine_v3/construct.py', 'utf8');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  if (got === want) { console.log('  OK  ', name); pass++; }
  else { console.log('  SAI ', name, '| nhan:', JSON.stringify(got), '| can:', JSON.stringify(want)); fail++; }
};

// HTML
check('wrap Toi uu v3 KHONG con hidden', /<div id="plannerTestWrap" class="planner-optimize-wrap planner-test-wrap">/.test(html), true);
// 23/08 (chu du an): dien thoai giu Toi uu v3 (icon) + Cherry + RB; an Xep FET + Toi uu FET.
check('mobile: khong con an #plannerTestWrap theo be rong', !/max-width: 760px\)\s*\{\s*body\.planner-shell #plannerTestWrap\s*\{\s*display: none/.test(html), true);
check('mobile: #plannerTestWrap co o rieng (cot 4 doc, sau Cherry)', /\.toolbar-actions\s*>\s*#plannerTestWrap\s*\{[^}]*grid-column:\s*4;/.test(html), true);
check('mobile: Cherry cot 3 (truoc Toi uu v3)', /\.toolbar-actions\s*>\s*#btnEngineCherry\s*\{[^}]*grid-column:\s*3;/.test(html), true);
check('mobile: RB cot 7, Thong ke cot 8 (RB an -> Thong ke ve 7)', /#btnConstraintAudit:not\(\[hidden\]\)\s*\{[^}]*grid-column:\s*7;/.test(html) && /\.toolbar-main:has\(#btnConstraintAudit\[hidden\]\)[^{]*\.stats-toggle\s*\{[^}]*grid-column:\s*7;/.test(html), true);
check('mobile: #btnTestMenu dang icon (font-size: 0)', /#btnTestMenu\s*\{[^}]*font-size:\s*0;/.test(html), true);
check('mobile: an nut Xep FET va menu Toi uu FET', /\.toolbar-actions\s*>\s*#btnAutoSort\s*\{[^}]*display:\s*none !important;/.test(html) && /\.toolbar-actions\s*>\s*#plannerOptimizeWrap\s*\{[^}]*display:\s*none !important;/.test(html), true);
check('nhan nut la "Tối ưu v3"', /<span class="planner-mode-label">Tối ưu v3<\/span>/.test(html), true);
check('khong con nhan TEST', /<span class="planner-mode-label">TEST<\/span>/.test(html), false);
for (const mode of ['optimize_singletons', 'optimize_sessions', 'optimize_gap2', 'optimize_gap1']) {
  check(`menu goi runPlannerV3Mode('${mode}')`, new RegExp(`runPlannerV3Mode\\('${mode}', event\\)`).test(html), true);
}
check('runPlannerV3Mode khong con chan theo superadmin', /function runPlannerV3Mode\(mode, event\)\{[\s\S]{0,700}testUserIsSuperadmin\(\)\) return false/.test(html), false);
check('runPlannerV3Mode di duong tkbRunEngine("cherry", null, {mode})', /window\.tkbRunEngine\("cherry", null, \{ mode: normalized \}\)/.test(html), true);
check('wrap luon hien (wrap.hidden = false)', /wrap\.hidden = false;/.test(html), true);
check('nut RB van chi superadmin', /\["btnConstraintAudit"\]\.forEach\(id => \{[\s\S]{0,200}btn\.hidden = !superadmin;/.test(html), true);
check('nut Lỗi da bo (22/08 khuya)', /id="btnSolveErrorLog"/.test(html), false);
check('fallback tkbRunEngine trong HTML nhan options.mode', /window\.tkbRunEngine = function\(engine, btn, options\)\{/.test(html), true);
// 23/08 trua: bump tiep thanh reclick-keep-v1 (sua hau kiem "ap roi hoan tac").
check('sapxep.html bump bridge (live label tro di)', /tkb-rust-bridge\.js\?v=20260823-(live|reclick-keep|v3-progress|fixed-first|focus-gate)-v1/.test(html), true);

// Bridge
check('bridge tkbRunEngine nhan options.mode', /window\.tkbRunEngine = function\(engine, btn, options\)\{/.test(bridge), true);
check('bridge truyen mode vao bridgeSapXepTuDongAll', /if\(focusMode\) invocation\.mode = focusMode;/.test(bridge), true);
// 23/08: 60s -> 120s (do: 60s->148, 120s->140, 180s->128 tren truong default).
check('bridge: luot mot muc tieu ngan sach 120s', /const engineDefaultBudget = focusedV3Turn \? \(focusBudgetOverride > 0 \? focusBudgetOverride : 120\) : 90;/.test(bridge), true);
// 22/08 (khuya): hien so lieu truc tiep "Dạy 1 tiết: 43 ➔ 4" thay vi nhan "Cherry v3"
check('bridge: ghi nhan metricLabel tu khung tien do cua engine', /progressState\.metricLabelText = liveLabel;/.test(bridge), true);
check('bridge: progressDisplayParts uu tien engineLabel (metricLabelText)', /\? \(engineLabel \|\| metricProgressCurrentLabel\(progressState\?\.metricProgress\)\)/.test(bridge), true);
const phanmonSrc = fs.readFileSync('web/pages/phanmon.js', 'utf8');
check('phanmon: luot engine hien nhan so lieu (details.metricLabel) neu co', /var __live = String\(details\?\.metricLabel \|\| ""\)\.trim\(\);/.test(phanmonSrc), true);
// phanmon.js giu chuoi tieng Viet o vung nay dang \uXXXX (nhu "Đang xếp bằng Cherry v3!") -> chap nhan ca hai dang
check('phanmon: nhan cho cho luot mot muc tieu "Đang tối ưu v3…"', /"Đang tối ưu v3…"|\\u0110ang t\\u1ed1i \\u01b0u v3\\u2026/.test(phanmonSrc), true);
const entrySrc = fs.readFileSync('solver_runtime/src/tkb_engine_v3/entry.py', 'utf8');
check('entry: _LiveQuality gom khung tu worker (Manager queue) + metricLabel', /class _LiveQuality[\s\S]{0,8000}"metricLabel": label/.test(entrySrc), true);
check('bridge: tom tat "Tối ưu v3 (…) xong"', /Tối ưu v3 \(\$\{focusLabels\[focusMode\]\}\) xong:/.test(bridge), true);
check('bridge: nguoi dung thuong duoc phep 4 muc tieu', /SOLVE_REQUEST_MODES\.singletons,\s*SOLVE_REQUEST_MODES\.sessions,\s*SOLVE_REQUEST_MODES\.gap1,\s*SOLVE_REQUEST_MODES\.gap2/.test(bridge), true);
// 23/08 trua: nut "1 tiet trong" v3 KHONG bi chan boi "Hay toi uu Trong 2 tiet truoc"
// (lane gap1 cua engine v3 khoa buoi 1 tiet / trong >= 2 / so buoi; truong con
// trong >= 2 cau truc se khong bao gio chay duoc nut nay neu giu luat cu).
// 23/08 (muc B): luot engine v3 -> vong % theo thoi gian (progressUsesWorkMetrics=false),
// so lieu thuc nam o nhan metricLabel do engine gui.
check('bridge: progressUsesWorkMetrics tra false khi __TKB_FORCE_ENGINE',
  /function progressUsesWorkMetrics\(settings\)\{[\s\S]{0,900}if\(String\(window\.__TKB_FORCE_ENGINE \|\| ""\)\.trim\(\)\) return false;/.test(bridge), true);
// 23/08: chu du an yeu cau menu Toi uu (FET) GIU nguyen ten muc, KHONG them "(FET)".
check('sapxep.html: muc menu Toi uu giu ten goc (khong "(FET)")',
  /data-scheduler-mode="optimize_gap1"[^>]*>1 tiết trống<\/button>/.test(html)
  && !/\(FET\)<\/button>/.test(html)
  && /data-test-mode="optimize_gap1"[^>]*>1 tiết trống<\/button>/.test(html), true);
check('bridge: v3 gap1 bo qua "trong 2 truoc" (__TKB_FORCE_ENGINE)',
  /const forcedEngineGapTurn = String\(window\.__TKB_FORCE_ENGINE \|\| ""\)\.trim\(\) !== "";\s*if\(\s*requestedSolveMode === SOLVE_REQUEST_MODES\.gap1\s*&& !forcedEngineGapTurn\s*&& gap2PlusCount\(visibleMetrics\) > 0/.test(bridge), true);

// Engine
check('entry: quality_focus singletons/sessions/gap2/gap1', /quality_focus = "singletons"/.test(entry) && /quality_focus = "sessions"/.test(entry) && /quality_focus = "gap2"/.test(entry) && /quality_focus = "gap1"/.test(entry), true);
check('construct: focus singletons khoa gap2 + session cap, stage_only = 1', /elif focus == "singletons":[\s\S]{0,400}self\._lock_gap2 = soft\.q_gap2[\s\S]{0,200}self\._session_cap = soft\.q_sessions[\s\S]{0,100}stage_only = 1/.test(construct), true);
check('construct: focus gap2 khoa singleton + session cap, stage_only = 2', /elif focus == "gap2":[\s\S]{0,400}self\._lock_singleton = soft\.q_singleton[\s\S]{0,200}self\._session_cap = soft\.q_sessions[\s\S]{0,100}stage_only = 2/.test(construct), true);
check('construct: focus sessions khoa ca hai', /elif focus == "sessions":[\s\S]{0,300}self\._lock_singleton = soft\.q_singleton\s*\n\s*self\._lock_gap2 = soft\.q_gap2/.test(construct), true);
check('construct: KHONG nut nao rot tiet (swap_only), chi bao cao quality_unavoidable', /def _eject_quality_debts[\s\S]{0,1200}_quality_eject_skipped = \{"disabled": "swap_only"\}/.test(construct), true);
check('construct: bao cao why="kept" kem goi y', /"why": "kept",\s*\n\s*"why_label": \(/.test(construct), true);
check('construct: khong con goi _eject_singletons/_eject_gap2', /changed \|= self\._eject_singletons\(/.test(construct) || /changed \|= self\._eject_gap2\(/.test(construct), false);
check('construct: xep lai "co no" chi cho nut Cherry (focus None)', /if self\.quality_focus is None:\s*\n[\s\S]{0,700}allow_debt=True/.test(construct), true);

console.log('');
console.log(fail === 0 ? 'TAT CA DAT' : fail + ' MUC SAI');
process.exit(fail === 0 ? 0 : 1);
