# PROJECT HANDOFF — TKBCherry

> Nhật ký bàn giao theo từng phiên làm việc, mục mới nhất ở trên cùng.
> Tóm tắt trạng thái hiện hành: xem [`CURRENT_STATE.md`](CURRENT_STATE.md).
> Các mục trước tháng 11/2026 đã chuyển vào `docs/archive/`:
> - [`2026-10`](archive/PROJECT_HANDOFF_2026-10-01_2026-10-31.md)
> - [`2026-09`](archive/PROJECT_HANDOFF_2026-09-01_2026-09-30.md)
> - [`2026-08-10 – 2026-08-31`](archive/PROJECT_HANDOFF_2026-08-10_2026-08-31.md)
> - [`2026-07-28 – 2026-08-09`](archive/PROJECT_HANDOFF_2026-07-28_2026-08-09.md)
> Chính sách: đầu mỗi tháng, chuyển các mục của tháng trước vào `docs/archive/`.

## 2026-11-02 TRANG CHỦ TRỞ LẠI TRANG ĐĂNG NHẬP GỌN (như trước 07/10) — CHỜ CHỦ DỰ ÁN CHẠY LỆNH DEPLOY

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
- **Test**: `run_tests.py` 140 pass / 27 fail, báo 6 [MOI HONG] (`planner_constraint_audit_stale_class`, `planner_fixed_chao_co_survives_load`,
  `planner_ghep_stale_pin`, `planner_lesson_block_impossible_min`, `planner_lesson_block_standard_periods`, `planner_teacher_code_nfc`): KHÔNG do việc này —
  `web/pages/phanmon.js` ở cây chính là CRLF, bộ cắt hàm của test cần LF ("khong thay ket thuc ham"). Worktree sạch HEAD + đúng 4 file HTML mới: cả 6 pass,
  `auth_activation_grant_one_year` pass. `auth_mobile_layout` (key `auth.css`) fail sẵn theo `docs/test-baseline.json`.
- **Lỗi cũ thấy trên cả bản live, KHÔNG sửa**: ô tick "Ghi nhớ đăng nhập" nằm tách dòng với nhãn của nó và "Quên mật khẩu?" xuống dòng riêng
  (`.auth-form label{display:grid;width:100%}` thắng `.auth-remember`). Trên điện thoại phải vuốt qua hình minh hoạ mới tới thẻ đăng nhập (đúng bản cũ;
  landing 07/10 từng đưa thẻ lên màn đầu).
- **Deploy**: classifier chặn Claude chạy cả `deploy-files.py preflight`. Lệnh cho chủ dự án: `! python scratch/homepage-deploy/run.py`
  (preflight + `deploy homepage-20261102 --no-restart` 4 file HTML, không restart, không đụng DB). Sha mong đợi: index `434217f1704d45e9`, about
  `6a45ee44b697a2a9`, privacy `5c60cf2d58f59b6b`, terms `be9467f0fb4ba661`. Rollback `python deploy.py files rollback homepage-20261102 <4 file>` (có restart).
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

