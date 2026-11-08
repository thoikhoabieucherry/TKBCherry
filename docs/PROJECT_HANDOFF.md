# PROJECT HANDOFF — TKBCherry

> Nhật ký bàn giao theo từng phiên làm việc, mục mới nhất ở trên cùng.
> Tóm tắt trạng thái hiện hành: xem [`CURRENT_STATE.md`](CURRENT_STATE.md).
> Các mục trước tháng 11/2026 đã chuyển vào `docs/archive/`:
> - [`2026-10`](archive/PROJECT_HANDOFF_2026-10-01_2026-10-31.md)
> - [`2026-09`](archive/PROJECT_HANDOFF_2026-09-01_2026-09-30.md)
> - [`2026-08-10 – 2026-08-31`](archive/PROJECT_HANDOFF_2026-08-10_2026-08-31.md)
> - [`2026-07-28 – 2026-08-09`](archive/PROJECT_HANDOFF_2026-07-28_2026-08-09.md)
> Chính sách: đầu mỗi tháng, chuyển các mục của tháng trước vào `docs/archive/`.

## 2026-11-08 TRANG GIỚI THIỆU /about LÀM LẠI THEO BỐ CỤC qtm.vn + LINK "GIỚI THIỆU" Ở TRANG CHỦ — ĐÃ DEPLOY

- **Chủ dự án**: "tham khảo qtm.vn thiết kế lại web chúng ta biết đâu đăng ký được startup". Đã nói rõ: đơn Claude Startups bị
  từ chối vì chưa có pháp nhân để xác minh, trang đẹp hơn không đổi được điều đó (qtm.vn cũng không ghi MST). Chủ dự án chọn:
  **trang chủ giữ trang đăng nhập gọn (02/11)**, làm lại `/about` theo bố cục qtm.vn; chỉ dùng số liệu thật, ý kiến thầy cô thật
  (chưa gửi → chưa có mục này), ảnh chụp phần mềm với dữ liệu mẫu; **chưa có pháp nhân** → ghi "dự án độc lập của người sáng lập,
  tự đầu tư", không ghi "startup thành lập 12/2025", JSON-LD bỏ `foundingDate`.
- **`web/about/index.html`** (viết lại, tiếng Việt + khối "In English") + **`web/about/about.css`** (mới, lớp `ab-*`, font Be Vietnam Pro
  vì Outfit thiếu bộ chữ tiếng Việt): thanh liên hệ trên cùng → menu dính → hero + ảnh màn Sắp xếp → dải số liệu → 6 thẻ tính năng →
  ảnh phần mềm theo tab (Yêu cầu / Phân công / In TKB, không JS thì hiện cả 3) → 4 bước bắt đầu → Về chúng tôi + bảng thông tin →
  lời mời liên hệ → chân trang 3 cột. `public-site.css` không đổi (privacy/terms vẫn dùng).
- **Số liệu trên trang đều kiểm được**: 27 loại yêu cầu (đếm menu Yêu cầu: 11 GV + 12 môn + 3 cố định + 1 giới hạn số tiết/thời điểm),
  75 lớp / ~2.200 tiết/tuần (trường lớn nhất, đã ghi từ 07/10), ⏱ 1–3 phút/lượt. **Số dùng thật** (classifier chặn Claude đọc kho
  production → chủ dự án chạy `! python scratch/about-deploy/stats.py`, chỉ đọc sqlite `mode=ro`): 79 tài khoản trường, 65 kho có ≥1 tiết
  (2.293 lớp, 61.338 tiết). Bỏ 5 kho < 10 tiết/lớp (`510b6f8ac81`, `f93cab980e1`, `4afb620fa41`, `0vt12dq6431`, `5fe3d1177b1`),
  `claudetest30` (bản sao thử), `default` (TKB 1 của Tân Phú Trung, trùng `af5ldw7i8y`) → 58 trường / 2.040 lớp / 58.532 tiết.
  Chủ dự án duyệt **số làm tròn** đăng lên dải số liệu: "Hơn 50 trường", "~2.000 lớp", "Hơn 55.000 tiết mỗi tuần" + "27 loại yêu cầu"
  (chừa chỗ cho kho thử chưa nhận ra, vd `7ff06d42ec1` 6 lớp/38 GV, `a31c3ff6fd1`, `c1619c9a521`). Bẫy của script: tên trường
  trống vì mã kho ≠ khoá registry; nhóm phiên bản bằng cắt mọi chữ số cuối (đúng hơn là `id[:10]`); đếm ô chuỗi nên là cận dưới.
- **Ảnh** `web/assets/about/tkb-{planner,rules,assignment,print}.jpg` (JPEG vì Rust `is_public_static_file` không phục vụ .webp):
  chụp từ app thật chạy cục bộ — `rust_api/target/release/tkb_rust_api.exe` (bản 17/08) với `TKB_APP_ROOT`=repo, `TKB_DB_PATH` ở
  scratchpad, cổng 2399; trường mẫu = `rust_api/fixtures/sample-data.json` (22 lớp) **đổi toàn bộ 43 tên/mã GV sang tên giả**
  (kiểm 0 mã/tên cũ còn sót), xếp bằng ▶ FET trong trình duyệt (627/627 tiết); chụp Chrome headless 2x qua CDP.
- **Trang chủ** `web/index.html`: nút "Giới thiệu phần mềm →" dưới khẩu hiệu + "Giới thiệu" ở chân trang; CSS `.auth-home .auth-about-link`
  trong `web/auth.css` (chỉ thêm). Thẻ đăng nhập/đăng ký không đổi.
- **Kiểm**: Chrome headless 1254×700 (2x) và 390×844 mobile: không tràn ngang (scrollWidth = 390), tab ảnh đổi đúng, font tiếng Việt nạp.
  `run_tests.py` cây chính: đúng 6 [MOI HONG] cũ của 02/11 (phanmon.js CRLF); worktree sạch HEAD + đúng các file này: 145 pass / 22 fail,
  "Khong co test nao moi hong so voi moc chuan". Không test nào đọc `web/about/` (chỉ `auth_mobile_layout_node` đọc `auth.css`, fail sẵn).
- **ĐÃ DEPLOY 08/11** (chủ dự án chạy `! python scratch/about-deploy/run.py`): preflight remote = đúng bản 02/11 (index `434217f1…`,
  about `6a45ee44…`, auth.css `6aab167a…`), 5 file mới MISSING → NEW; `--no-restart`, backup `/root/tkb-backups/about-20261108/`.
  Live (curl GET) khớp sha local cả 8 file (index `44df393f…`, auth.css `6096ad48…`, about `d1d96daf…`, about.css `f92c83af…`).
  Chrome hồ sơ mới: `/about` không tràn ngang (1280 và 390), Be Vietnam Pro nạp, 4 số đúng, tab hiện; trang chủ có nút Giới thiệu,
  thẻ đăng nhập còn, h1 không bị cắt. Rollback 3 file sửa: `python deploy.py files rollback about-20261108 web/index.html web/auth.css web/about/index.html`.

## 2026-11-08 CHERRY AGENT TRÊN MÁY KHÁC: CHROME CHẶN/HỎI QUYỀN "ỨNG DỤNG TRÊN THIẾT BỊ" (ĐÃ DEPLOY) + KÝ SỐ CHERRY.EXE

- **Chủ dự án**: "Cherry.exe trên máy khác: Chrome chặn cài đặt và đường dẫn check theo máy của tôi" → "dùng chứng chỉ ký số
  ký được không? máy khác thấy Cherry bật mà web không nhận".
- **Đường dẫn**: KHÔNG ghi cứng — `install.ps1` cài vào `%LOCALAPPDATA%\Cherry` của từng người dùng, `cherry-local://` + lối tắt
  theo thư mục đó, `cherry_local_solver.py` dò đường dẫn tương đối. `C:\Users\Cherry\…` chỉ nằm trong `co_filename` của .pyc
  (dựng ở `%TEMP%\cmnb21`), không dùng khi chạy; Cherry.exe phát trên Netlify (sha `1dc678a5…`) không chứa chuỗi đó.
- **Ký số**: Cherry.exe `NotSigned`, .pyd ortools cũng không ký → Chrome cảnh báo tải, SmartScreen, Smart App Control (Win 11 bật)
  chặn hẳn. Chứng chỉ của chủ dự án trên máy (Ban Cơ yếu Chính phủ, cá nhân công vụ THCS Củ Chi) chỉ có EKU Client Auth /
  Secure Email / Smart Card Logon — KHÔNG ký mã được. Cần chứng thư Code Signing (Azure Trusted Signing / OV-EV) — chờ chủ dự án.
- **Web không nhận Cherry**: Cherry trả đúng (GET health + preflight `Access-Control-Request-Private-Network` → 200/204 với ACAO
  tkbcherry.com + `Allow-Private-Network`). Nguyên nhân: Chrome Local Network Access — trang https phải được cho phép "truy cập
  ứng dụng và dịch vụ trên thiết bị" mới gọi 127.0.0.1; probe huỷ sau 1,5 s làm mất hộp hỏi, hộp thoại báo nhầm "hãy mở Cherry".
  Sửa bridge: `localNetworkPermissionState()` (thử `loopback-network`, `local-network-access`, `local-network`); `prompt` → probe
  127.0.0.1 chờ tới 45 s + dòng "bấm Cho phép" trong hộp; `denied` → hộp `blocked` "Chrome đang chặn Cherry Agent" chỉ đường Cài
  đặt trang web (không nút tải/mở). Test toggle 39/39, `run_tests.py` không mới hỏng. Commit 2a44ae2 (nhánh agent 071e20c). CHƯA
  thử trên Chrome thật (extension mất kết nối). Deploy `scratch/agent-deploy/run.py`: preflight `fbd346db…`, live `f323d790…`,
  backup `/root/tkb-backups/agent-lna-20261108/`.

## 2026-11-02 ĐẨY NỐT 17 FILE SỬA DỞ LÊN GITHUB (CHƯA DEPLOY gì thêm)

- **Chủ dự án**: "tôi muốn đưa dự án này lên github". Repo đã có sẵn (`thoikhoabieucherry/TKBCherry`, riêng tư),
  nhánh làm việc `cursor/cherry-v3-speed-teacher-stats-a03d` đã đẩy đủ; chủ dự án chọn commit 17 file sửa dở của các phiên
  trước và đẩy lên nhánh này. **Không đụng `main`** (main trên GitHub dừng ở 20/08, sau nhánh này 61 commit; 28 commit FET
  19–20/08 chỉ nằm trên main, chưa từng được gộp).
- Nội dung commit (không phải viết mới phiên này):
  - `tools/cloud-run/*` + `solver_runtime/tests/test_cloud_run_deploy_assets.py`: mặc định đổi sang project
    `project-8ce8bf36-3ba7-430f-8f7`, service `cherry-solver`, repo ảnh `cherry-images`, SA `cherry-invoker@…`/`cherry-runtime@…`,
    nhãn `app=cherry`; `deploy.ps1` không còn vùng phụ mặc định, lần tạo service đầu bỏ `--no-traffic`, cấp quyền invoker
    TRƯỚC canary; `deploy-and-pin.ps1` đọc URL từng vùng bằng `gcloud run services list` thay vì ghi cứng.
    **Phiên này KHÔNG xác minh** service đó đang chạy hay VPS đã ghim sang project này — `CURRENT_STATE.md` vẫn ghi project
    `29291bde` (bị đình chỉ 23/10). Kiểm tra trước khi chạy bất kỳ script deploy nào.
  - `web/pages/tkb-constraints.js` (+ cache-bust trong `sapxep.html`): Yêu cầu cố định của lớp không còn "vay" số tiết
    từ khối khác khi Tiết chuẩn đúng khối = 0 (lớp 9/10 trường `0adf9782362`: CNghệ khối 9 = 0 → tổng 31 thay vì 30), có test
    mới trong `planner_subject_limit_semantics_node.test.js`. **Chưa rõ đã deploy** — so bản live trước khi deploy.
  - 2 test mới `planner_ghep_session_limit_node` (01/10) và `planner_ghep_teacher_grade_label_node` (30/09);
    `.gitignore` chặn `/scratch_*`, `/cloud_e2e_result*.json`, `/cloud_run_profiles*.json` ở gốc; AGENTS.md thêm luật giữ
    gốc repo sạch; archive tháng 9 bổ sung các mục 30/09 bị sót.
- Đổi 6 file từ CRLF về LF trước khi commit (chỉ mục là LF) để diff chỉ còn thay đổi thật (904+/59−).
- **Bẫy test trên máy này**: `run_tests.py` ở thư mục làm việc báo 6 "MỚI HỎNG" (`planner_constraint_audit_stale_class`,
  `planner_fixed_chao_co_survives_load`, `planner_ghep_stale_pin`, `planner_lesson_block_impossible_min`,
  `planner_lesson_block_standard_periods`, `planner_teacher_code_nfc`) vì `web/pages/phanmon.js` trên đĩa là CRLF
  (`git ls-files --eol` = `i/lf w/crlf`). Kiểm chứng: worktree sạch của HEAD + áp đúng 17 file này → "Khong co test nao moi
  hong so voi moc chuan".

## 2026-11-02 TRANG CHỦ TRỞ LẠI TRANG ĐĂNG NHẬP GỌN (như trước 07/10) — ĐÃ DEPLOY (cả vá tiêu đề bị cắt)

- **Chủ dự án**: "tôi đã thiết kế trang chủ để xin startup của claude ko được, giờ trang chủ rối quá thiết kế lại cho tôi như cũ cũng được".
- **`web/index.html`** = bản `9637942` (trước landing 07/10: logo + khẩu hiệu + hình minh hoạ bên trái, thẻ đăng nhập bên phải, chân trang
  một dòng). Thẻ đăng nhập/đăng ký/quên mật khẩu giống hệt từng byte (đã `cmp`), cùng script + CSS, chỉ bớt `public-site.css`; `auth.css` không
  đổi từ 08/2026 nên giao diện đúng bản cũ. Bỏ nav, hero tiếng Anh, chip, 4 mục Product/About/Technology/Contact, JSON-LD.
- **Khác bản cũ, cố ý**: (1) giữ meta description/canonical/OG bằng tiếng Việt (ẩn; để Google và xem trước link Zalo không mất mô tả);
  (2) chân trang thêm "Bảo mật · Điều khoản" vì form đăng ký thu email + SĐT.
- **`/about`, `/privacy`, `/terms` giữ nguyên**, chỉ đổi thanh trên: bỏ `/#product`, `/#technology`, `/#contact` (sẽ thành link chết), thêm
  Privacy/Terms; "Đăng nhập" `/#authCard` vẫn đúng vì trang cũ có `id="authCard"`. `/about` không còn link từ trang chủ, vẫn trong sitemap.
- **Lệch key live**: live đang nạp `shared/auth.js?v=20260823-default-first-v1`, repo `?v=20260904-grant-1year-v1` (test
  `auth_activation_grant_one_year_node` cần key mới). Deploy bản repo vẫn nhận đúng file `auth.js` đang có trên VPS (query chỉ để bust cache,
  static `no-store`). `auth.js` live KHÁC local (sha `dc379744…` vs `3e3d833b…`) — chuyện cũ, phiên này không đụng.
- **Kiểm**: Chrome headless qua `http.server` cổng 8799: 1366×768, 1920×1080, và 390×1400 trong iframe (`--window-size` dưới ~500 px bị Chrome
  chạy ẩn nới rộng rồi cắt ảnh, không phải lỗi trang). Live `/about`, `/privacy`, `/terms` đối chiếu `curl` + bỏ CR khớp HEAD (about = HEAD + "Team").
- **Test** (lượt vá tiêu đề chạy lại nhóm `js-e2e`, nhóm duy nhất đọc `auth.css`: cùng 6 test, không thêm): `run_tests.py` 140 pass / 27 fail, báo 6 [MOI HONG] (`planner_constraint_audit_stale_class`, `planner_fixed_chao_co_survives_load`,
  `planner_ghep_stale_pin`, `planner_lesson_block_impossible_min`, `planner_lesson_block_standard_periods`, `planner_teacher_code_nfc`): KHÔNG do việc này —
  `web/pages/phanmon.js` ở cây chính là CRLF, bộ cắt hàm của test cần LF ("khong thay ket thuc ham"). Worktree sạch HEAD + đúng 4 file HTML mới: cả 6 pass,
  `auth_activation_grant_one_year` pass. `auth_mobile_layout` (key `auth.css`) fail sẵn theo `docs/test-baseline.json`.
- **Lỗi cũ thấy trên cả bản live, KHÔNG sửa**: ô tick "Ghi nhớ đăng nhập" nằm tách dòng với nhãn của nó và "Quên mật khẩu?" xuống dòng riêng
  (`.auth-form label{display:grid;width:100%}` thắng `.auth-remember`). Trên điện thoại phải vuốt qua hình minh hoạ mới tới thẻ đăng nhập (đúng bản cũ;
  landing 07/10 từng đưa thẻ lên màn đầu).
- **ĐÃ DEPLOY 02/11** (chủ dự án chạy `!` — classifier chặn Claude, kể cả `preflight`): `python scratch/homepage-deploy/run.py`, 4 file HTML,
  `--no-restart`, backup `/root/tkb-backups/homepage-20261102/`. Rollback `python deploy.py files rollback homepage-20261102 <4 file>` (có restart).
  Preflight remote khớp bản đã đối chiếu; live sha = local cả 4 (index `434217f1704d45e9`, about `6a45ee44b697a2a9`, privacy `5c60cf2d58f59b6b`,
  terms `be9467f0fb4ba661`); `/`, `/about`, `/privacy`, `/terms`, `/robots.txt`, `/sitemap.xml`, `/api/health` 200.
- **Kiểm live bằng CDP** (Chrome chạy riêng, không gửi form; `scratchpad/live_check.mjs`): 1366×768, 1920×1080, 390×844 mobile thật: 0 phần tử landing, không tràn
  ngang, tab Đăng ký/Đăng nhập + Quên mật khẩu/Quay lại đổi đúng, `/#authCard` cuộn tới thẻ, 3 trang phụ hết link chết, 0 JS exception. Log lỗi duy nhất: 401
  `/api/auth/registry` khi chưa đăng nhập (`shared/auth.js` gọi; script không đổi so với trước).
- **LỖI PHÁT HIỆN SAU DEPLOY — tiêu đề "Cherry Schedule" mất chữ r** ở LẦN TẢI ĐẦU, mọi màn ≥1100 px (tái hiện chắc chắn: hồ sơ Chrome mới + tắt cache; 1366: khung 330 / chữ 365,4).
  `auth.css` `@media ≥1100` có `.auth-home .auth-panel-brand h1 { max-width: 12ch }`: `ch` tính theo font dự phòng khi Outfit (Google Fonts, `display=swap`) chưa về và Chrome
  giữ nguyên số đó sau khi font về; chữ gradient (`background-clip: text`) không vẽ ngoài khung nên mất chữ cuối. Có font trong cache hoặc đổi cỡ cửa sổ thì đúng — vì vậy ảnh thử đầu
  (1366, 1920) không lộ. Có sẵn từ 08/2026; landing 07/10 che đi bằng `.auth-landing .auth-panel-brand h1` trong `public-site.css`, khôi phục trang cũ làm nó lộ lại.
  **Vá**: `max-width: none` (h1 vốn `nowrap` + `width: max-content`, rule chỉ áp `.auth-home` = trang chủ, không đụng school-portal/super-admin, `?v=` không cần đổi vì static `no-store`).
  Sau vá, cold load bản local: 1100/1366/1536/1920 khung = chữ. Test mới trong `auth_mobile_layout_node`: "homepage title width never depends on ch units" (bắt đúng CSS cũ, pass CSS mới).
  **ĐÃ DEPLOY 02/11** (chủ dự án chạy `!`): `python scratch/homepage-deploy/run2.py`, `web/auth.css`, `--no-restart`, backup `/root/tkb-backups/homepage-title-20261102/`,
  remote trước `5f0e12ec…` (= local trước khi vá), live sau `6aab167aa96e5281` khớp. Cold load live (hồ sơ mới, tắt cache): 1100/1366/1536/1920 khung = chữ, `max-width: none`;
  chạy lại `live_check.mjs` không đổi; `/school-portal`, `/super-admin`, `/api/health` 200. Rollback `python deploy.py files rollback homepage-title-20261102 web/auth.css` (có restart).
- **Handoff**: chuyển 28 mục tháng 10 sang `docs/archive/PROJECT_HANDOFF_2026-10-01_2026-10-31.md`, gồm mục 26/10 trước đó chưa từng được commit.
- **Còn trong cây làm việc** (có từ 26/10, không phải việc phiên này, chưa commit): `.gitignore`, `AGENTS.md`, `tools/cloud-run/*`,
  `web/pages/sapxep.html`, `web/pages/tkb-constraints.js`, 2 test ghép; mục 26/10 ghi là đã commit nhưng không thấy trong lịch sử nhánh.

## 2026-11-01 TKBCHERRY.COM: Ô ⏱ 1 / 2 / 3 PHÚT CHO CHERRY + TỐI ƯU (ĐÃ DEPLOY) + DỪNG = DỪNG HẲN

- **Chủ dự án**: "thêm yếu tố thời gian: mặc định 2 phút, tùy chọn 1 đến 3 phút… bấm dừng thì dừng hẳn hay CP-SAT vẫn tối ưu?".
- **Bridge** (`initSolveBudgetUi`, chỉ trang có máy chủ — Netlify có ô riêng trong overlay `local-planner.js`): `<label
  #tkbSolveBudgetWrap.tkb-solve-budget>` "⏱" + `<select #tkbSolveBudget>` 60/120/180 s ngay sau `#plannerTestWrap` (menu Tối ưu);
  đặt `window.__TKB_ENGINE_BUDGET_SECONDS` + `__TKB_ENGINE_FOCUS_BUDGET_SECONDS` (bridge đã đọc sẵn — override thắng mặc định
  Cherry 180 s / Tối ưu 120 s), nhớ ở `localStorage.TKB_ENGINE_BUDGET_SECONDS_V1` (giá trị lạ làm tròn về 1/2/3 phút). Áp cả Agent
  lẫn máy chủ, cả Mac; ẩn trong lưới nút điện thoại (vẫn 2 phút). **Cherry mặc định 180 → 120 s** theo chủ dự án.
- **Dừng**: engine đọc `TKB_SOLVER_STOP_FILE` mỗi 0,5 s (`Constructor._stop_requested`), lượt CP-SAT hỏi `stop_check` ở
  callback lời giải (lượt chưa có lời giải chạy hết `time_limit` 2–3,2 s) → dừng trong ~1–3 s, trả lịch tốt nhất; bridge chỉ áp
  khi tốt hơn. KHÔNG tối ưu tiếp sau khi Dừng.
- **Test**: toggle 37/37 (harness thêm `plannerTestWrap`, `fire(type)`; đếm riêng công tắc bằng `switchInserted`), `run_tests.py`
  không test mới hỏng. Commit bdd9b89 (nhánh agent 2d48513). Deploy `scratch/agent-deploy/run.py`: preflight remote
  `4b48ce53…`, live `fbd346db…` khớp, backup `/root/tkb-backups/agent-budget-20261101/`.
- **Đề xuất chờ chủ dự án chọn**: (1) vùng CP-SAT lớn khi còn buổi 1 tiết (sửa yếu điểm xếp mới trường > 60 lớp), (2) nhiều vùng
  CP-SAT song song (8 vs 16 luồng không khác → lõi rảnh), (3) nháp FET cho cả chế độ máy chủ.

