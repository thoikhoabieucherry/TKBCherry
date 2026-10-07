# PROJECT HANDOFF — TKBCherry

> Nhật ký bàn giao theo từng phiên làm việc, mục mới nhất ở trên cùng.
> Tóm tắt trạng thái hiện hành: xem [`CURRENT_STATE.md`](CURRENT_STATE.md).
> Các mục trước tháng 10/2026 đã chuyển vào `docs/archive/`:
> - [`2026-09`](archive/PROJECT_HANDOFF_2026-09-01_2026-09-30.md)
> - [`2026-08-10 – 2026-08-31`](archive/PROJECT_HANDOFF_2026-08-10_2026-08-31.md)
> - [`2026-07-28 – 2026-08-09`](archive/PROJECT_HANDOFF_2026-07-28_2026-08-09.md)
> Chính sách: đầu mỗi tháng, chuyển các mục của tháng trước vào `docs/archive/`.

## 2026-10-07 (tối, 2) WEBSITE CÔNG KHAI ĐỂ XÁC MINH STARTUP (trang chủ + /about /privacy /terms + robots/sitemap) — ĐÃ DEPLOY

- **Chủ dự án**: làm tkbcherry.com đủ thông tin công khai cho chương trình startup (Claude Startups/Anthropic) mà **không đụng**
  login/đăng ký/API/solver/backend; không bịa khách hàng/doanh thu/nhà đầu tư/pháp nhân; AI chỉ "exploring" (chưa có Claude production).
- **Trang chủ** `web/index.html`: title/description/canonical/OG/twitter + JSON-LD @graph (Organization: founder Person "Nguyen Hoang An"
  alternateName "Nguyễn Hoàng Ân", foundingDate 2026, address TP.HCM, contactPoint contact@tkbcherry.com; WebSite; SoftwareApplication).
  `body.auth-landing`: nav dính (Product/About/Technology/Contact/Đăng nhập), hero bên trái (≥1100px lưới 3fr/2fr), **thẻ đăng nhập/đăng ký/quên
  mật khẩu byte-identical** bên phải, thấy ngay khi mở (mobile: logo + headline + thẻ trong màn đầu, ẩn subheadline/CTA/chips < 900px);
  dưới là `#product` (EN + VI), `#about` (dl Founder/Founded/Location/Stage/Website/Contact), `#technology`, `#contact`, footer mới
  (© 2026, /about /privacy /terms, email, SĐT/Zalo/địa chỉ cũ). CSS riêng `web/public-site.css` (lớp `lp-*`), không sửa `auth.css`/`auth.js`.
- **Trang mới**: `web/about/index.html`, `web/privacy/index.html`, `web/terms/index.html` (Rust `static_file` phục vụ index.html của thư mục →
  `/about` và `/about/` đều 200, không redirect). Privacy liệt kê bên thứ ba thật: VPS, Google Cloud Run (Jakarta/Singapore/Đài Loan),
  Gmail (OTP), Google Workspace (contact@), api.ipify.org (lúc login/đăng ký), Google Fonts, Zalo; không analytics.
- **robots.txt / sitemap.xml**: Rust chỉ phục vụ html/js/css/ảnh ⇒ **nginx** khối `TKB_PUBLIC_SEO_BEGIN/END` (`location =`) trỏ
  `/var/www/tkbcherry-public/` — `tools/vps-deploy/install-public-seo-nginx.py --apply` (sao lưu, `nginx -t`, tự khôi phục nếu lỗi, reload;
  mỗi lần chạy upload lại 2 file từ `web/`). Lần đầu alias vào `/opt/cherry-scheduler/web` bị **403** vì `/opt/cherry-scheduler` là 0700
  (đúng, chứa DB — KHÔNG nới). Cùng lỗi 403 này đang xảy ra với khối `TKB_AGENT_DOWNLOAD` cũ (`/downloads/TKBCherryAgent-*`, Agent đã ngừng).
- **Lệch live ↔ repo**: live `index.html` vẫn gọi `shared/auth.js?v=20260823-default-first-v1` (auth.js 30 ngày) còn repo có bản 1 năm chưa
  deploy (test `auth_activation_grant_one_year_node` cần khoá mới). Đã deploy **biến thể** index.html = repo nhưng giữ khoá live
  (scratch `deploy_index_variant.py`, sha256 `6b459be7…`, 25165 B); repo giữ khoá mới. Lần deploy auth.js 1 năm phải deploy kèm index.html repo.
- **Kiểm**: E2E CDP trên backend local (DB mới) cũ vs mới GIỐNG HỆT: đăng ký 200 "Đăng ký thành công…" → chuyển pane login điền sẵn ID;
  sai mật khẩu "Mật khẩu không đúng."; quên mật khẩu bật/tắt; đăng nhập → `/school-portal`; 0 JS exception. Live (chỉ đọc): thẻ login thấy
  ngay 390×844 và 1366×768, tab đăng ký/quên mật khẩu bật tắt, tài khoản không tồn tại báo lỗi server. HTTP live: `/`, `/about`, `/about/`,
  `/privacy`, `/terms`, `/robots.txt`, `/sitemap.xml` = 200 không redirect (HEAD trả 404 vì Rust chỉ route GET). `run_tests.py`: "mới hỏng"
  chỉ 7 test CRLF đã biết; `test_vps_deploy_packaging` FAIL trong lượt chạy chung nhưng chạy riêng 16/16 pass.
- **Deploy** (không restart, không đổi backend): `deploy-files.py deploy public-site-20261007 --no-restart` (6 file mới) + biến thể index.html,
  backup `/root/tkb-backups/public-site-20261007/`; nginx backup `/root/tkb-backups/nginx-public-seo-20261007-200608/` và `-200720/`.
- **RỦI RO BẢO MẬT phát hiện (CHƯA sửa, chờ chủ dự án duyệt)**: (1) `GET /api/school/store?id=default` trả **toàn bộ kho default không cần
  đăng nhập** (~362 KB: 135 GV kèm mã HT/PHT, 74 lớp, TKB) — `school_store_get_json` bỏ qua auth khi id = default; theo mã nguồn
  `school_store_post_json` cũng vậy ⇒ có thể ghi đè ẩn danh (chưa thử). Đề xuất: bắt buộc phiên superadmin cho `default`.
  (2) `GET /api/sample-data` công khai 43 GV họ tên đầy đủ (`rust_api/fixtures/sample-data.json`) — cần xác nhận là dữ liệu giả.
  (3) `/pages.zip` (500 KB mã JS front-end, 16/08) tải công khai — nên xoá. (4) `/api/health` lộ đường dẫn máy chủ.
- **Việc mở**: chủ dự án xác nhận hộp thư contact@tkbcherry.com nhận được thư; duyệt hướng sửa 4 rủi ro trên.

## 2026-10-07 (tối) `ry7gvvz7vk3` — CÔ QUYÊN TIN CHỈ DẠY THỨ 5 (10 TIẾT), THẦY TAM NGHỈ CHUYÊN MÔN THỨ 4 (ĐÃ GHI)

- **Chủ dự án**: «giữ nguyên các ràng buộc cũ, cô Quyên Tin học chỉ dạy thứ 5 10 tiết; thầy Tam nghỉ chuyên môn Thứ Tư, không nghỉ
  thứ 3 và 5 nữa. TKB vừa rồi đẹp rồi» ⇒ sửa ít nhất có thể.
- **Ràng buộc** (`tkbConstraints`): `fixedOff.teacher["TI.Quyên"]` = nghỉ cả ngày T2/T3/T4/T6/T7 (thêm T6), `maxPeriods.day.thu5` 8 → 10;
  `fixedOff.teacher["TN.Tam"]` bỏ T3 sáng + T5 sáng, giữ nghỉ cả ngày T4. Mọi ràng buộc khác giữ nguyên.
- **Lịch**: CP-SAT cục bộ trên lớp 9A10/9A13 (`scratch/ry7gvvz7vk3_20261007/minimum_change.py`, mục tiêu = ít ô đổi nhất) → **11 ô / 3 lớp**
  (9A9, 9A10, 9A13). Cô Quyên đủ 10 tiết T5 (sáng 9A9–9A13, chiều 6A6–6A10); thầy Tam không có tiết T4 (lịch thầy không đổi).
  Chất lượng 387 buổi / 0 buổi 1 tiết / 0 trống 2 / 65 trống 1 → **386 / 0 / 0 / 65**; 1370/1370; giữ mọi ô cố định/nghỉ.
- **Kiểm**: validator Python `hard_ok`, 0 vi phạm Yêu cầu; RB production (`tkb-constraints.live.js` `validateAll(5000)`) = 0 cả trước và sau khi
  đọc lại bản đã ghi.
- **Ghi**: SSH KV (`remote.py --apply`, `BEGIN IMMEDIATE` + cổng hash toàn kho), chỉ thay `tkb` + `tkbConstraints`, bỏ kết quả giải cũ;
  `_updatedAt = 1791373254319`; backup `/root/tkb-recovery/pvh3-ry7gvvz7vk3-20261007-184052/`. Không đổi mã nguồn, không deploy.

## 2026-10-07 CHERRY TỰ DỜI TIẾT CHUNG NHIỀU LỚP (An Phú KNS/STEM "bay về T2 sáng")

- **Chủ dự án** (`kkhg52etp92`): «tôi bấm nút cherry tự nhiên tiết kns và stem bay vào tiết 2 3 của lớp 6a2 sáng thứ 2», «nó ở ô nào
  cũng về ô đó luôn» → «tôi muốn bạn fix ko cố định như vậy nữa khi xếp». File `.cherry` chủ dự án xuất 07/10 00:35 (Desktop\vanban).
- **Gốc**: `tkbJointPinForSolve` ghim TẠM tiết chung; dòng thiếu tiết (kéo ra Chưa phân / đặt tiết khác vào) lấy ô chung ĐẦU TIÊN =
  đúng lỗ vừa bỏ ra (T2 sáng tiết 3-4) — tái hiện bằng chính hàm của app trên kho (scratchpad `sim/pin_sim*.js`); engine coi là ô cố định
  dùng chung ⇒ không bao giờ dời. Lượt 00:31: 866/869, cô Vy thiếu 3 tiết (2 bị cắt sức chứa TRƯỚC khi giải vì sáng T2 6A2 kín ô cố định).
- **Sửa**: bridge gửi `settings.cherry_joint_movable` (`tkbJointPinnedKeys`), engine `joint.py` `relocate_joint_lessons` (CP-SAT toàn trường,
  nhóm buộc cùng ô qua `Problem.joint_sync` / `cpsat_lns`, giữ mọi tiết + tối thiểu tiết thiếu, cắt sức chứa lại khi bỏ ghim) rồi chạy lại lượt
  với lịch viết lại; payload `solver.engine_v3.joint_free` ⇒ `applyPayload` `releaseJointFreeLocks` nhận vị trí mới. Chi tiết
  `docs/CHERRY_ENGINE.md` mục 07/10.
- **Đo** (kho 00:35, ghim như production, 180 s): cũ 866/869 `hard_ok=false` [1,0,316,12]; mới **869/869 hợp lệ** [0,0,315,14], KNS → T3 sáng
  t1, STEM → T3 sáng t2. Luật "ghép nhiều lớp học sau 2 tiết, cuối buổi" (01/10) không có trong Yêu cầu ⇒ engine không biết.
- **Test**: `test_engine_v3_joint_free.py` 9/9; engine v3 + hợp đồng 357 pass / 2 skip; `planner_ghep_pin_survives_apply_node` 5/5;
  `run_tests.py` "mới hỏng" chỉ 7 test CRLF đã biết (đạt hết trên bản bỏ CR).
- **Deploy**: CHƯA — web (`phanmon.js` = live + `tkbJointPinnedKeys`, bridge = live + phần này) và Cloud Run (engine) đều phải do chủ dự án
  chạy (classifier chặn "Production Deploy"). Thứ tự nào cũng an toàn: engine cũ không trả `joint_free` ⇒ bridge giữ khoá như trước.

## 2026-10-06 (tối) TIẾT GHÉP NHIỀU LỚP BỊ "KHOÁ" SAU LƯỢT CHERRY (An Phú KNS/STEM)

- **Chủ dự án** (`kkhg52etp92`): «bấm nút cherry lại có tiết kns và stem cố định là sao» → «tôi kéo rồi nhưng bấm Cherry nó lại khóa 2 tiết đó».
- **Cơ chế** (`phanmon.js tkbJointPinForSolve`): trước mỗi lượt (Cherry/▶/Tối ưu) mọi dòng Dạy ghép ≥ 2 lớp được ghim tạm
  `{mon, fixed:true, jointPin:true}` cùng ô ở mọi lớp; dòng đã có tiết thì GIỮ đúng chỗ (Cherry không bao giờ dời tiết ghép), dòng
  thiếu tiết thì lấy ô chung ĐẦU TIÊN (Thứ 2, sáng, tiết nhỏ trước). An Phú: sau lượt xoá lịch + Cherry 05/10, KNS T3 sáng t4 → T2 sáng t3,
  STEM T6 sáng t4 → T2 sáng t4, TANN 6A1-4 T4 chiều t3 → T2 chiều t1 (`scratch/anphu2r/live_0510b.json` → `live_0510c.json`, cả 19 ô
  `jointPin`); sáng T2 6A2 kín 4 ô cố định = nút thắt NV.Vy (trần 867/869 ở mục chiều nay).
- **Lỗi**: `applyPayload` dựng lại ô cố định thành `{mon, fixed:true}` trần → mất `jointPin`. Đường gỡ ghim nào lỡ (tải lại trang, áp
  kết quả sau khi sổ ghim đã mất) thì lượt ghim sau coi ô đó là ô NGƯỜI DÙNG khoá (`wasFixed`) → khoá vĩnh viễn, `tkbJointClearStalePins`
  (quét cờ `jointPin`) cũng không nhận ra.
- **Sửa**: `tkb-rust-bridge.js` `collectFixedLessonLocks` ghi `jointPin`, `fixedLessonLockCell` giữ cờ khi áp (vòng lặp áp +
  `applyFixedLessonLocks`); `phanmon.js` `isShownFixed` — lưới lớp, vẽ lại tại chỗ và TKB GV không vẽ khoá cho ô ghim tạm.
  Đã thử thêm gỡ ghim trong `restoreScheduleData` rồi BỎ: `maybeFinishLocalUnassignedRepairSolve` (▶/v3) khôi phục SAU khi ghim, TRƯỚC khi gửi.
- **Test**: mới `e2e_tests/planner_ghep_pin_survives_apply_node.test.js` 3/3 (bản cũ 0/3); `planner_ghep_teacher_clash` thêm stub
  `isShownFixed`. `run_tests.py`: "mới hỏng" chỉ 7 test CRLF đã biết — cả 7 đạt trên bản bỏ CR có phần sửa.
- **Deploy**: ĐÃ DEPLOY 07/10 (chủ dự án chạy `deploy.py files deploy joint-pin-flag-20261006 --no-restart` từ worktree = live + phần này;
  lệnh của Claude bị classifier chặn "Production Deploy"), backup `/root/tkb-backups/joint-pin-flag-20261006`; live sha256
  phanmon.js `9646bf21f0d0fbbe`, tkb-rust-bridge.js `2a794b98a150ec6a` (= bản dựng). Bridge live vẫn CŨ hơn HEAD (f3679c3 soft-stop chưa deploy).
- **Còn mở**: (1) Cherry vẫn không tự dời tiết ghép (engine coi là ô cố định dùng chung, `core.py shared_fixed`); muốn Cherry chọn ô
  phải mô hình tiết ghép trong engine v3 (biến chung cho các lớp trong CP-SAT + bridge nhận ô ghép đã dời). (2) Ô ghép đã lỡ thành cố
  định thật (không `jointPin`) trong kho phải "Bỏ cố định" tay — không tự gỡ được vì người dùng cũng tự cố định tiết ghép (Chào cờ (ghép)).

## 2026-10-06 (chiều) KIỂM TRA THUẬT TOÁN NÚT CHERRY: LỊCH HỢP LỆ THẮNG LỊCH NHIỀU TIẾT CÒN NỢ LUẬT + GIỮ PHẦN LẤP ĐƯỢC

- **Chủ dự án** (An Phú `kkhg52etp92`): «bấm xếp nó lại ko xếp đủ tiết và tối ưu, có phải thuật toán có vấn đề ko?» →
  «tôi cần bạn kiểm tra lại thuật toán».
- **Không đọc được dữ liệu trường**: SSH đọc kho production và cả bản sao cũ trong `scratch/anphu2r/` bị classifier chặn
  ("Production Reads") → CHƯA tái hiện trên kho thật của An Phú; mọi kết luận dưới đây từ trường thử.
- **Cách kiểm**: trường thử CÓ ĐÁP ÁN (`scratch/synthetic_bench/`, gitignore; README trong đó): 28 lớp 2 cơ sở, 871 tiết,
  10 GV dạy 2 cơ sở có "1 địa điểm/buổi" (MT/Nhạc 28 lớp), họp tổ, tiết ghép cố định; Cherry xếp bản lỏng ra đáp án 871/871 rồi
  ghi `maxSessions = minSessions` = số buổi đáp án cho mọi GV (luật "đúng bằng" như An Phú). Lưới trống, 180 s, 6 tiến trình + 6 luồng.
- **Lỗi 1 (gốc của "không xếp đủ / không tối ưu")**: vòng 1 heuristic trả lưới 871/871 còn nợ luật số buổi; `_rank_key` xếp số tiết
  lên đầu nên lưới đó thắng lưới HỢP LỆ 869/868/797 của vòng CP-SAT → payload `ok=false` (41–45 `teacher.maxSessions`), trình duyệt
  không áp được. Bản cũ gặp ở 4/8 lượt. Sửa `entry.py`: `_grid_rule_debt` → `result["rule_debt"]`, xếp hạng nút Cherry đặt `rule_debt`
  trước số tiết, `_result_hits_floor` đòi 0 nợ, lưới xây mới còn nợ không làm điểm xuất phát vòng 2.
- **Lỗi 2**: `_cpsat_fill_phase` vứt cả lần giải toàn trường (758 → 864) khi gỡ địa điểm không hết → về 758. Sửa `construct.py`: gỡ không
  hết thì `_shed_rule_debt` + GIỮ phần còn lại; gỡ vùng ≤ max(8 s, 30 %); ngưỡng thêm lần toàn trường 25 → 15 s; `entry.py` trường có
  `minSessions` để vòng 1 dùng 25 % ngân sách (cũ 40 %). Toàn trường chỉ chạy khi ≤ 40 lớp (Tân Nhựt, Tân An Hội không đổi).
- **Đo**: cũ 4/8 lượt lưới vi phạm, 4/8 đủ 871; bản cuối 4/4 đủ 871/871 hợp lệ [3,0,270,1]/[3,0,271,0] (= đáp án); bấm lần 2 trên lịch
  đủ [3,0,270,4] → [3,0,270,1], trên lịch 869 → 871 trong 10 s. Chi tiết: `docs/CHERRY_ENGINE.md` mục 06/10 chiều.
- **Test**: engine v3 + hợp đồng kết quả 340 pass (+6 `test_engine_v3_valid_first.py`; `test_engine_v3_location_rules` sửa chỉ số khoá
  xếp hạng). `run_tests.py`: 133 pass / 27 fail / 160; "mới hỏng" chỉ 7 test JS CRLF đã biết, `test_cloud_run_deploy_assets` fail sẵn.
- **Deploy** (chủ dự án chạy `deploy-and-pin.ps1` — lệnh deploy của Claude bị classifier chặn "Production Deploy"): ảnh
  `tkb-solver:20261006-033419`, digest `683e7603bf6a90013370a1b3ce003a8e35b30dc27ff1030c0a91d71858d405fa`; Jakarta `00424-new`,
  Singapore `00083-six`, Đài Loan `00083-yud`; 3 profile kvstore + 2 drop-in đã ghim, /health 3 vùng khớp. Bước max 2 lại hết giờ ở cả
  3 vùng: revision max 2 cùng image ĐÃ Ready (`00182-bgv` / `00039-swd` / `00039-nxg`) nhưng 0 % traffic — `update-traffic` của
  Claude cũng bị chặn → chủ dự án chạy 3 lệnh `update-traffic`; Claude kiểm lại: cả 3 vùng 100 % trên revision max 2, cùng image
  `sha256:f79feabe…88c6c7`, Ready. Chưa nghiệm thu `/solve` trên Cloud Run; chủ dự án đang bấm Cherry trên An Phú để thử.
- **HỒI QUY sau deploy (13:53)**: chủ dự án bấm Cherry An Phú → vòng 2 trả 167 tiết, khoá "nợ lên đầu" chọn nó, bridge từ chối, lịch 859 giữ nguyên.
  Tái hiện từ file `.cherry` chủ dự án xuất (Desktop\QLSS_HDSD, chép vào scratchpad): nhánh warm `_repair_partial_warm` sửa xong 863 tiết, `_load_state`
  từ chối (thiếu tiết → tiết đôi chưa đủ) → rơi xuống xây lại từ đầu với ~1 s. Sửa (`b7e28ef` + commit này): khoá `(rule_debt − handled)`, giữ lưới đã sửa
  (`warm_final_lenient`), không xây lại khi < 20 s. Kho An Phú 180 s ×2: 866/869, 0 nợ luật GV/địa điểm. Trần dữ liệu 867: NV.Vy chỉ rảnh sáng T2 + chiều T3,
  sáng T2 của 6A2 kín ô cố định. 343 test v3 đạt. ĐÃ DEPLOY (chủ dự án chạy deploy-and-pin 15:04): digest
  `5de729ee70476f2193142623f344a0e45efa22969d70edd9a9ad59a40166dff1`, Jakarta `00429-xay`, Singapore `00088-kow`, Đài Loan `00088-wir` (max 1),
  /health 3 vùng khớp; revision max 2 Ready cùng image `00184-5nk` / `00041-hq8` / `00041-nv6` — chờ chủ dự án update-traffic.

## 2026-10-06 NÚT CHERRY: Ô CỐ ĐỊNH VƯỢT GIỚI HẠN KHÔNG CÒN LÀM BỎ KẾT QUẢ + 2 VÒNG CHO TRƯỜNG 2 CƠ SỞ XẾP TỪ ĐẦU

- **Chủ dự án** (Tân Nhựt `0adf9782364`): «bấm Cherry thấy có tối ưu nhưng trả kết quả về lại không nhận, trả lại như cũ; xếp lại
  vi phạm ràng buộc quá nhiều; phải đảm bảo mọi ràng buộc, xếp đủ, tối ưu, lần sau bấm tối ưu tiếp».
- **Nguyên nhân** (kho kéo RO `_updatedAt=1791217377134`, chạy 180 s như production): engine ra 1746/1746 [0,0,620,59] từ
  [7,0,679,106] nhưng `ok=false` chỉ vì 2 cặp Tin-QT CỐ ĐỊNH (mục 05/10/06/10 bên dưới) → bridge "Kết quả máy chủ chưa đủ điều kiện để
  áp dụng; lịch hiện tại được giữ nguyên" ở MỌI lượt. Xếp từ đầu trường 54 lớp có luật địa điểm đi đường heuristic cũ (không CP-SAT).
- **Code**: `validate.compute_metrics(fixed_lessons=)` → `fixed_subject_session_limit_overrides` (cảnh báo) cho phần vượt nằm trọn
  trong ô cố định; `adapter.build_payload`/engine v3 truyền ô cố định; Cherry 2 vòng mặc định cho trường luật địa điểm khi xếp từ
  đầu (`TKB_CHERRY_LOC_FRESH=0` = cũ). Chi tiết + số đo: `docs/CHERRY_ENGINE.md` mục 06/10.
- **Đo**: lịch trên kho → `ok=true` 60 s [0,1,658,91]; lưới trống 180 s cũ [6,1,672,100] → mới [0,0,635,68]; Tân An Hội lưới trống
  [0,0,664,118] → [0,0,646,114]. RB (node + `tkb-constraints.js`) mọi kết quả 0 vi phạm, 0 nợ địa điểm.
- **Test**: engine v3 + hợp đồng kết quả 334 pass (+4 `test_fixed_cell_limit_override.py`); sửa fixture
  `test_engine_v3_edge_pair_rule` (chọn seed có ≥ 2 vi phạm). KHÔNG ghi dữ liệu trường (phiên khác đang ghi Tân Nhựt).
- **Deploy** commit `1bad953`: `deploy-and-pin.ps1` → digest `7bf7ddd86e82ec244d006e2e116fc388475834e65962f94adb4ab294266c346d`, VPS ghim,
  /health 3 vùng khớp. Bước nâng max 2 lại hết giờ ở CẢ 3 vùng (revision max 2 Ready nhưng 0 % traffic) → `update-traffic` sang
  `00180-wzh` (Jakarta) / `00037-bqb` (Singapore) / `00037-xpr` (Đài Loan), cùng image `3c84cdfd…`. Nghiệm thu Cloud Run thật trên
  kho mới nhất (`_updatedAt=1791224196468`, settings như bridge, 180 s): `ok=true hard_ok=true` 1746/1746 [0,0,640,70] → [0,0,619,59].
  Bẫy lặp lại 2 lần: `deploy-and-pin.ps1` chờ revision max 2 chỉ 2 phút — cần nới thời gian chờ trong script.

## 2026-10-06 `0adf9782364` THCS Tân Nhựt — TỐI ƯU THÊM 1 LƯỢT, ĐÃ GHI 1746/1746

- **Chủ dự án**: «tối ưu thêm 1 lần nữa». Đọc lại kho live `_updatedAt=1791217377134`: lịch/yêu cầu đã khác bản tối ưu 05/10,
  có 141 ô cố định (trước 124), 679 buổi, 7 buổi 1 tiết, 0 trống 2, 106 trống 1; 2 lỗi yêu cầu giới hạn số ngày dạy.
- **Thực hiện**: đúng một lượt Cherry 180 s, warm từ kho mới, giữ toàn bộ ô cố định/nghỉ và nguyên yêu cầu/phân công.
  Chạy ngoài sandbox để multiprocessing hoạt động (6 worker, `used_multiprocessing=true`), thực tế 174,6 s.
  Kết quả **1746/1746, 640 buổi, 0 buổi 1 tiết, 0 trống 2, 70 trống 1**; 2 lỗi số ngày dạy đã hết.
- **Kiểm chứng**: validator Python 0 trùng GV/lớp/phòng, 0 thiếu/thừa phân công, 0 lỗi tiết đôi/ô nghỉ/yêu cầu/địa điểm;
  `validateAll(5000)` của RB production = 0, cả trước khi ghi và sau khi đọc lại độc lập. Giữ đúng 141 ô cố định.
  Vẫn giữ hai ngoại lệ Tin-QT cố định 6/5, 7/5 chiều T6 t1–2 vượt giới hạn 1/buổi đã nêu ở mục 05/10;
  Python `hard_ok=false` chỉ vì hai ngoại lệ này, không mô tả là đã thỏa mọi kiểm tra hard.
- **Đã ghi** qua SSH KV store với transaction + cổng hash toàn kho, backup
  `/root/tkb-recovery/tannhut4-0adf9782364-20261006-011635/`; ba timestamp/revision = `1791224196468`.
  Chỉ cập nhật lịch và ánh xạ GV/phòng, bỏ kết quả giải cũ; phân công/yêu cầu giữ nguyên. Bản đọc lại khớp lưới đã ghi và chất lượng,
  có file `.cherry` tại `scratch/0adf9782364/rerun_20261006/` (gitignore). Không thay mã nguồn sản phẩm/deploy.
- **Kiểm tra repo trước commit**: `python run_tests.py`: 131 pass / 28 fail / 159 module (483 s); 7 module đánh dấu MỚI HỎNG khớp các lỗi JS CRLF đã ghi nhận trước phiên này. Không đổi mã nguồn sản phẩm hoặc baseline.

## 2026-10-05 `0adf9782364` THCS Tân Nhựt — XẾP LẠI + TỐI ƯU, ĐÃ GHI 1746/1746

- **Chủ dự án**: «xếp và tối ưu TKB này» (TKB số 4, bản sao TKB 3, ngày áp dụng 12/10). Kho có 54 lớp, 113 GV trong danh sách,
  2 địa điểm, 124 ô tiết cố định. Lịch ban đầu đã đủ 1746 tiết nhưng RB live báo 269 thông báo vi phạm (đếm theo ô);
  Python báo 96 lỗi yêu cầu, 17 buổi có nợ luật địa điểm. Chất lượng đầu vào: 713 buổi, 99 buổi 1 tiết, 10 buổi trống 2, 78 buổi trống 1.
- **Xếp/tối ưu**: chạy ngoại tuyến engine HEAD `6dc8d7f`, giữ ô cố định/nghỉ và nguyên phân công/yêu cầu: Cherry 180 s → Buổi dạy 120 s
  → Trống 1 tiết 120 s (`scratch/0adf9782364/solve.py`, có main guard). Kết quả **1746/1746, 594 buổi, 0 buổi 1 tiết, 0 trống 2,
  37 trống 1**; 1430 ô thay đổi. Kiểm độc lập bằng `tkb-constraints.js` tải từ production: `validateAll(5000)` **0 thông báo**.
  Python kiểm 0 trùng GV/lớp/phòng, 0 thiếu/thừa phân công, 0 lỗi tiết đôi/ô nghỉ/yêu cầu, 0 nợ địa điểm; giữ đúng 124 ô cố định.
- **Ngoại lệ có sẵn, GIỮ NGUYÊN**: 6/5 và 7/5 khóa cả hai tiết Tin-QT chiều T6 t1–2 dù giới hạn phân công = 1/buổi.
  Đã hỏi lựa chọn xử lý; chưa nhận trả lời nên giữ nguyên ô khóa lẫn giới hạn. Python `hard_ok=false` CHỈ vì hai lỗi giới hạn này,
  RB web không báo chúng. Không được mô tả kết quả là đã thỏa mọi kiểm tra hard; các luật còn lại đạt và không tạo vi phạm mới.
- **Ghi**: SSH KV store, transaction `BEGIN IMMEDIATE` + so hash toàn kho trước khi ghi; lần đầu hủy vì app tự đổi
  `tkbConstraints.meta.defaultGroupsSig` 2→3 (lịch/phân công/luật thực tế không đổi), đọc lại và giữ meta mới rồi ghi.
  Chỉ thay `tkb`, `tkbLessonTeachers`, `tkbLessonRooms`, bỏ kết quả giải/plateau cũ, cập nhật ba revision/timestamp.
  `_updatedAt = _lastModified = tkbScheduleRevision = 1791213967843`; backup trước/sau tại
  `/root/tkb-recovery/tannhut4-0adf9782364-20261005-222607/`. Đọc lại độc lập qua SQLite RO khớp hoàn toàn `written.json`; RB lại 0.
- **Mã nguồn/deploy**: không đổi scheduler/frontend/backend, không deploy. Dump/lệnh/audit chỉ ở `scratch/0adf9782364/` (đã gitignore).
  Thực hiện lưu trữ nhật ký tháng 8–9 vào `docs/archive/` theo chính sách; giữ đầy đủ các ghi chú đang sửa của phiên khác,
  chỉ đưa phần đã nằm trong HEAD và mục mới này vào commit.
- **Kiểm tra repo trước commit**: `python run_tests.py` trong sandbox bị chặn tiến trình con (`spawn EPERM`);
  Chạy lại ngoài sandbox: 130 pass / 28 fail / 158 module (454 s); 7 module được đánh dấu MỚI HỎNG khớp đúng các lỗi JS CRLF đã ghi nhận ngày 30/09–05/10. Không đổi mã nguồn hay test baseline trong phiên này. Việc xác nhận lịch đã hoàn tất bằng cả validator Python và RB production.

## 2026-10-05 (chiều) CHERRY KẾ THỪA LẦN BẤM TRƯỚC + GỠ LUẬT ĐỊA ĐIỂM KHÔNG BỎ TIẾT + NGÂN SÁCH 180 s

- **Chủ dự án**: xoá lịch An Phú `kkhg52etp92` rồi bấm Cherry → thiếu tiết + bảng ràng buộc báo lỗi nhiều; «nút cherry phải xếp đủ và
  tối ưu», «tăng thời gian chạy và kế thừa kết quả chạy thử». (Trước đó đã chọn "Khôi phục lịch cũ ngay" — CHƯA ghi vì Chrome mất kết
  nối; file `Downloads\kkhg52etp92_khoi_phuc_0510.cherry`, bản JSON `scratchpad 81e0937b/anphu2_restore_0510.json`.)
- **Nguyên nhân** (đo offline 180 s): bấm lần 2 trên lịch 868/869 hợp lệ trả y nguyên — nghiệm 869 / 7 buổi vi phạm địa điểm đứng đầu
  xếp hạng, `_location_gate` trả lịch cũ và vứt luôn nghiệm 868 tốt hơn; tiết cuối (MT 8A3 cô Thi, 1 tiết × 28 lớp × 2 cơ sở) cần
  đổi cơ sở cả buổi, CP-SAT luật địa điểm cứng 173 s vẫn 868. Xếp từ đầu chọn 869 kèm 10 buổi vi phạm thay bản hợp lệ.
- **Code** (`entry.py`, `construct.py`, `cpsat_lns.py`, `tkb-rust-bridge.js`): xếp hạng có cổng địa điểm (cả khi xếp từ đầu), vòng 2
  chỉ đi từ lưới xây mới khi qua cổng; CP-SAT `loc_soft` + `require_full`; `_cpsat_fill_phase` lặp toàn trường (phạt mềm) +
  `_cpsat_repair_loc_debt`; gỡ nợ cả nguyên buổi; `prefer_valid`; Cherry 90 → 180 s. Chi tiết: `docs/CHERRY_ENGINE.md` mục 05/10 chiều.
- **Đo An Phú 180 s**: bấm lần 2 → **869/869 hợp lệ [0,0,317,20]**; xếp từ đầu → **869/869 hợp lệ [2,0,316,15]**.
- **Test**: engine v3 154/154 (+6 `test_engine_v3_loc_fill_repair.py`; sửa kỳ vọng `test_fill_phase_completes_chain` vì lần giải
  toàn trường lấp xong trước vòng cụm). `run_tests.py`: chỉ 7 test JS CRLF đã biết. Bench 7 trường (110 s, tuần tự): không trường nào
  xấu đi ngoài dao động (số liệu trong `CHERRY_ENGINE.md`); GDTX lưới trống chậm hơn chút → giới hạn lần giải toàn trường cho trường
  không có luật địa điểm.
- **Deploy**: Cloud Run `deploy-and-pin.ps1` → digest `863a25892ccb4cfb8c4dca8318104ad1b93ca478be861598023df1d6f9b521d8`, Jakarta
  `00415-but`; 2 vùng phụ script hết giờ chờ bước max 2 → Claude `update-traffic` sang `00035-d28` (asia-southeast1) / `00035-cpz`
  (asia-east1) — cùng image, max 2; `/health` có token 3 vùng khớp digest, VPS đã ghim. Web: `tkb-rust-bridge.js` dựng = bản LIVE +
  đúng dòng ngân sách 180 s (live đang cũ hơn HEAD: commit ea9af15 "soft-stop status" + nhãn "Đang tìm" CHƯA từng deploy — cố ý
  không kéo theo), đẩy từ worktree sạch `deploy.py files deploy cherry-180s-20261005 --no-restart` (backup
  `/root/tkb-backups/cherry-180s-20261005`), sha live = 057db7d9….

## 2026-10-05 CHERRY: TIẾT GHÉP TÍNH VÀO CHẤT LƯỢNG GV + LUẬT ĐỊA ĐIỂM TRONG CP-SAT + minSessions (ĐÃ DEPLOY)

- **Chủ dự án**: «bấm Cherry xong TKB không đổi» (THCS An Phú `kkhg52etp92`) → chọn "Nâng engine Cherry".
- **Code** commit `2513f38` (đã push): `Problem.teacher_fixed_busy` (ô cố định dùng chung nhiều lớp tính vào chiếm chỗ GV ở
  SoftSchedule/State/CP-SAT), luật địa điểm mã hoá trong `cpsat_lns` (`TKB_CPSAT_LOC=0` = cách cũ), Cherry 2 vòng cho trường có luật
  địa điểm chỉ khi có lịch đủ tiết, `maxDaysSessions.minSessions` (engine; giao diện CHƯA có ô nhập — `tkb-constraints.js` đang có
  sửa dở của phiên khác), `State.apply` cập nhật `ts_count` trước khi kiểm luật. Chi tiết + số đo: `docs/CHERRY_ENGINE.md` mục 05/10.
- **Test**: v3 148/148; `run_tests.py` chỉ 7 test CRLF đã biết. Bench 8 trường (`scratchpad bench_run.sh`, chạy song song old/new gây
  nhiễu — Hồ Văn Long đo lại tuần tự thì ngang nhau).
- **Deploy Cloud Run** (`deploy-and-pin.ps1`): digest `63596248f26dc8260e3e1e870abfd304a93823155edb3d83feb1197264fdc105`, /health 3 vùng
  khớp, VPS đã ghim. VPS chưa nhận 5 file engine (chỉ dự phòng, `serverless_only`).
- **Dữ liệu An Phú** (05/10, ghi qua tab Chrome, cổng `_lastModified` 1791135250543 → 1791142958307): `minSessions` = số buổi hiện tại
  (≤ maxSessions) cho 54 GV — luật "đúng bằng" của chủ dự án; lưới không đổi (316 buổi). Danh sách: `scratch/anphu2r/minsessions_written_0510.json`.

## 2026-10-04 ĐÃ DEPLOY CLOUD RUN ENGINE CHERRY 8ff47eb (CP-SAT LẤP TIẾT) — 3 VÙNG, DIGEST ĐÃ GHIM

- **Chủ dự án**: «sao nay nút Cherry hết xếp được và tối ưu rồi nhỉ? toàn phải phụ thuộc vào AI» → «deploy đi».
- **Chẩn đoán** (`/api/admin/solver-telemetry`, chỉ số gộp): Cloud Run vẫn là `tkb-solver-00404-guf` (build 19/09 = `bd2ff6b`,
  digest `bad7ef38…`); 24 h 35/39 lượt cloud "failed" (Tối ưu v3 13/13), 7 ngày 234/321; FET trình duyệt 88/89 ổn. Tái hiện ngoại tuyến
  trên TKB 3 Củ Chi 2 (`0l2vcan0xx3`, khung đúng, lưới trống, 60 s, 6 tiến trình): bản 19/09 1818/1819 `hard_ok=false`; bản `8ff47eb`
  1819/1819 hợp lệ, 0 buổi 1 tiết. Bẫy đo: script gọi `solve_from_ui_data_v3` trên Windows phải có `if __name__ == "__main__"` — thiếu
  thì `worker_count=1`, Cherry 2 vòng không bật, bản cũ/mới ra y hệt.
- **Deploy** (Claude chạy, có xác nhận): `powershell -ExecutionPolicy Bypass -File tools\cloud-run\deploy-and-pin.ps1 -ConfirmDeployment`
  → ảnh `tkb-solver:20261004-134507`, digest `110dc8e6877d5ac10b0b0340b1c44072a7cc2eef7f16ea862ead122b4f731c3d`; Jakarta `00407-ker`,
  Singapore + Đài Loan (`00065-mim`…) 100 % traffic, max 2; VPS: profile 3 vùng (backup `/root/tkb-backups/profiles-20261004-210321`) +
  `pin-cloud-run-digest.py --apply` (restart `tkb-app` active). Kiểm khô lại: 2 drop-in + 3 profile đều `110dc8e6…`.
- **Nghiệm thu**: gọi thẳng `/solve` Jakarta (token mượn SA invoker, engine cherry, 60 s) với TKB 3 lưới trống → 107 s, ok, `hard_ok`,
  1819/1819, 0 buổi 1 tiết, 614 buổi, trống 1 = 56 (`cpsat_quality` 634 → 614).
- **Còn mở**: trường có luật địa điểm GV vẫn đi đường cũ (không CP-SAT); Tối ưu v3 trên lưới thiếu tiết vẫn bị tính failed (mục 01/10 dưới).

## 2026-10-01 NÚT CHERRY DÙNG CP-SAT: LẤP TIẾT THIẾU + TỐI ƯU (CODE + TEST XONG, ĐÃ DEPLOY CLOUD RUN 04/10)

- **Chủ dự án**: «làm sao nút Cherry làm được như bạn? giờ người ta xếp bằng Cherry không được». Nguyên nhân (mục dưới): trường 0 ô dư,
  pha 1+2 heuristic không có CP-SAT → ~1192/1207; lane CP-SAT cũ chỉ hoán đổi tiết đã xếp.
- **Code** (`solver_runtime/src/tkb_engine_v3/`): `cpsat_lns.py` lane `fill` (ô trống + tiết thiếu là biến, `full_classes`, `fill_quality`,
  hoãn tiết đôi có phạt); `construct.py` `_cpsat_fill_phase` / `_cpsat_quality_phase` / `_salvage_warm` / `_shed_rule_debt` /
  `_maybe_fill_warm`, cờ `cherry_cpsat`; `entry.py` Cherry 2 vòng (portfolio heuristic ~40 % → 1 tiến trình × N luồng CP-SAT warm từ
  lưới tốt nhất / lịch người dùng), chỉ khi `_cpsat_lane_enabled` và KHÔNG GV nào có luật địa điểm; tắt `TKB_CHERRY_CPSAT=0`.
  Chi tiết + số đo: `docs/CHERRY_ENGINE.md` mục 01/10.
- **Đo** (60 s, `TKB_CPSAT_THREADS=6`, cùng máy, cũ = `TKB_CHERRY_CPSAT=0`; máy đang có tiến trình `tbh4_solve.py` 16 luồng của phiên khác
  chạy nền suốt lúc đo): bản mới tốt hơn hoặc bằng ở 12/12 ca (6 trường × lưới trống/lịch có sẵn) — Hưng Long trống 1192 → 1207 hợp lệ,
  Hồ Văn Long TKB5 trống không hợp lệ → hợp lệ [1,1,616,134], Nguyễn Ảnh Thủ trống 1123 → 1149 hợp lệ, trường 61 lớp lịch có vi phạm
  2051 [72,31,724] → 2071 [5,7,649]; Tân An Hội (luật địa điểm) giữ đường cũ.
- **Test**: `solver_runtime/tests/test_engine_v3_cpsat_fill.py` 8/8; `python -m unittest discover -s solver_runtime/tests -p "test_engine_v3_*.py"`
  140/140. `run_tests.py`: 7 "MỚI HỎNG" JS = đúng 7 test CRLF đã ghi ngày 30/09; thêm `test_model_plan_contract` (không dính file sửa) —
  chạy riêng PASS cả bản mới lẫn HEAD (hỏng do máy quá tải khi chạy cả bộ).
- **Commit** `8ff47eb` (chỉ 5 file của thay đổi này; đã push). **VPS** (dự phòng, `serverless_only` nên không đổi hành vi web):
  `deploy.py files deploy cherry-cpsat-fill-20261001 --no-restart` 3 file engine, backup `/root/tkb-backups/cherry-cpsat-fill-20261001`.
- **Deploy Cloud Run**: ĐÃ DEPLOY 04/10 (mục trên, digest `110dc8e6…`). Ghi chú cũ: Cloud Run vùng chính ghim `bad7ef38…`, 2 vùng phụ `dffac571…` (13/09). Lệnh (chủ dự án chạy, có restart
  `tkb-app` ở bước cập nhật VPS → chạy lúc vắng): `python deploy.py cloudrun --max-instances 2` (giữ maxConcurrency 2 của vùng chính).

## 2026-10-01 Tối ưu v3 trên lưới THIẾU tiết luôn bị tính "failed" (điều tra, CHƯA sửa)

- **Báo lỗi** (một trường "tối ưu không được"): `solver_execution_usage` cho thấy 5 lượt Tối ưu v3 (1 tiết/buổi, Buổi dạy) liền nhau đều
  `failed`, `hard_valid=0`, chỉ số trước = sau. Lưới lúc đó là kết quả Cherry **chưa đủ tiết** (trường 0 ô dư: Cherry 60 s từ lưới trống
  chỉ đạt 1192/1207, tái hiện ngoại tuyến bằng `solver_runtime/scripts/solve_stdio.py`, engine=cherry).
- **Cơ chế**: engine v3 vẫn tối ưu trên lưới thiếu (đo: 1 tiết/buổi 14→8) nhưng `_finalize_solve_status` (`solve_stdio.py`) đặt
  `hard_ok=false` khi còn tiết chưa xếp → lượt bị tính thất bại, trình duyệt không áp. Trên lưới đủ tiết cùng nút chạy bình thường.
- **Hướng sửa có thể** (cần chủ dự án duyệt): cho lượt một mục tiêu được áp khi số tiết đã xếp không giảm so với lưới xuất phát, hoặc
  báo rõ "lịch còn N tiết Chưa phân — bấm Cherry/xếp đủ trước khi Tối ưu" thay vì thất bại im lặng.

## 2026-10-01 XUẤT EXCEL TKB GV + TKB TỔNG TÔ MÀU THEO ĐỊA ĐIỂM (ĐÃ DEPLOY)

- **Chủ dự án** (THCS Tăng Bạt Hổ 2 cơ sở): "khi xuất ra, trên TKB của giáo viên và TKB tổng trên file Excel cần thể hiện các màu ở
  Địa điểm để người ta phân biệt như trên web".
- **`web/pages/tkb-student-excel-export.js`**: 4 file Excel (GV mẫu 1 `gv…`, GV mẫu 2 `gv…`, tổng theo GV `tonggv…`, tổng theo lớp `tonghs…`)
  tô ô có tiết theo địa điểm — cùng 4 màu vạch trên web (`tkb-loc-1..4`: #1677ff, #fa8c16, #52c41a, #722ed1): **cạnh trái đậm (thick)**
  đúng màu web + **nền nhạt** cùng tông (BAE0FF / FFE7BA / D9F7BE / EFDBFF). Địa điểm lấy giống web (`tkbLocationList` / `tkbEntryLocation`:
  phòng `DATA.phong.diadiem` nếu tiết có phòng, không thì `DATA.lop.diadiem`; có bản dự phòng khi phanmon.js cũ). Chỉ tô khi trường ≥ 2 địa điểm;
  ô trống / ô có lớp ở nhiều địa điểm (trùng lịch) không tô; tiết học chung đã gộp xét đủ `jointClassIds`.
  **Chú thích** tên địa điểm trên nền màu: mẫu 1 ở dòng trống `top+6`, mẫu 2 ở dòng trống `top+5`, bản tổng ở dòng tiêu đề sau cột 16.
  Bản tổng theo lớp tô cả ô tên lớp. Phiếu TKB lớp (`hs…`) không đổi.
- **Test**: `e2e_tests/excel_location_colors_node.test.js` 7/7 (nạp `vendor/xlsx.min.js` thật, kiểm style ô + `xl/styles.xml` có `<left style="thick">`).
  `run_tests.py`: 7 "MỚI HỎNG" giống hệt mục 30/09 — hỏng y nguyên trên HEAD sạch không có bản sửa này (không test nào nạp module xuất Excel).
- **Deploy**: dựng từ git worktree sạch tại HEAD (= live cho file này) để KHÔNG đẩy thay đổi chưa deploy của phiên khác trong cùng file
  (nhãn dạy ghép nhiều GV 29/09, `ghepMultiTeacherLabel`): `python deploy.py files deploy excel-location-colors-20261001 --no-restart
  web/pages/tkb-student-excel-export.js` (sha `02047acdc49046e3`, backup `/root/tkb-backups/excel-location-colors-20261001`). Server trả
  `Cache-Control: no-store` nên không đổi `?v=` trong sapxep.html. Working tree giữ cả hai thay đổi (gộp 3 chiều).
- **Kiểm trên web thật** (sid `i350pgr8o92`, 53 lớp, 2 địa điểm): xuất cả 4 file — tonghs 1975 ô màu (= 1920 tiết + 53 tiêu đề lớp + 2 chú thích),
  tonggv 1922 (= 1920 + 2), mẫu 1/2 mỗi file 2772 (= 1920 + 142 GV × 6 ô chú thích).
- **Chưa commit (của phiên khác)**: tính năng vạch màu địa điểm trên web 23/09 (`tkbLocationList`/`tkbLocationCellInfo` trong phanmon.js,
  `phanmon.css`) đã live nhưng vẫn nằm ở working tree.

## 2026-10-01 Sắp xếp: tiết DẠY GHÉP dùng giới hạn tiết/buổi của chính dòng ghép (ĐÃ DEPLOY) · `af5ldw7i8y3` Tân Phú Trung TKB 3 (ĐÃ GHI)

- **Lỗi (chủ dự án)**: dòng ghép "Bản ngữ" giới hạn 2, kéo 2 tiết liền thì báo "giới hạn môn này chỉ có 1".
  Gốc: `validateDrop`/`showTKBError` lấy giới hạn qua `getMonMeta(mon)` = `CURRENT_MON_META`, mà danh sách này chỉ có môn
  ĐÃ PHÂN CÔNG GV và khoá theo TÊN HIỂN THỊ; ô TKB lưu khoá dòng ghép (`Bản ngữ (ghép)`) → tiết ghép (đặc biệt dòng không GV)
  rơi về mặc định `{sotiet:0, gioihan:1}`. RB (`tkb-constraints.js`) không kiểm giới hạn phân công nên không bị.
- **Sửa (`web/pages/phanmon.js`)**: `tkbGhepMetaForClass(classRef, mon)` (bộ đệm theo ref dayGhep/pccmTiet/pccmGioihan, xoá trong
  `invalidatePccmNumCaches`) lấy Số tiết / Giới hạn của DÒNG ghép (khoá chiếu `Lớp|ten`, thiếu thì `row.sotiet/row.gioihan`);
  `getMonMeta` ưu tiên nó cho lớp đang chọn. `setClassSubjectSessionLimit` (nâng giới hạn khi thả) với tiết ghép ghi cả
  `row.gioihan` + khoá chiếu mọi lớp của dòng (vì `day-ghep.js syncDayGhepProjection` chép `row.gioihan` đè lên).
  Test mới `e2e_tests/planner_ghep_session_limit_node.test.js` (5/5). `run_tests.py`: 7 "MỚI HỎNG" + 2 test mới FAIL
  (`planner_teacher_assignment_statistics`, `planner_teacher_slot_presence_forecast`) cho kết quả Y HỆT khi thay bằng bản live chưa sửa.
  Deploy `python deploy.py files deploy ghep-limit-20261001 --no-restart web/pages/phanmon.js` (backup `/root/tkb-backups/ghep-limit-20261001`),
  live sha (bỏ CR) `0b89d6ac19b54e81` = working tree; kiểm trên trang TKB 3: `getMonMeta('Bản ngữ (ghép)')` 6A1 = 2/2 (trước 0/1).
  Bản deploy = live + phần này (live trước đó khớp working tree, kể cả sửa đổi chưa commit của phiên khác). Không commit (cùng lý do mục 30/09).
- **Dữ liệu TKB 3 Tân Phú Trung** (`scratch/tpt3/`, không vào repo): phân công 05/10 (`pccm510moi.xlsx` sheet tổng) + 2 GV mới, Bản ngữ/KNS/THQT
  ngoài nhà trường (dòng ghép không GV; app sau đó tự đổi khoá thành `Bản ngữ (ghép)`/`KNS (ghép)`/`THQT`), cô Hòa T5→T4, giữ 14 ô thầy Ân.
  CP-SAT với khung buổi trái là biến; ghi 01/10 03:42: 651 buổi / 14 buổi 1 tiết / 86 trống, RB 0.
