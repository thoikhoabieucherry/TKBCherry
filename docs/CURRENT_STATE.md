# TKBCherry — Trạng thái hiện hành (CURRENT STATE)

*Cập nhật: 2026-08-18. File này là bản tóm tắt ngắn để onboard nhanh; chi tiết từng phiên làm việc nằm trong `PROJECT_HANDOFF.md` (mục cũ hơn ở `docs/archive/`).*

## Đợt thay thế Solver V2 (local, chưa deploy)

- Đường xếp TKB mới nằm ở `solver_runtime/src/tkb_exact_v2/solver.py`, dùng
  CP-SAT tích hợp và chứng minh tuần tự: singleton/Gap2+ là hard zero, sau đó
  tối ưu tổng buổi giáo viên và Gap1 bằng `OPTIMAL`/best-bound.
- `solver_runtime/scripts/solve_stdio.py` nhận `settings.solver_algorithm=
  exact_v2`; không gọi FET/local-search. UI planner đã bỏ các nút Tối ưu,
  NEW và Trọn gói, nút Sắp xếp duy nhất định tuyến request này.
- Mọi `Giới hạn/Max` là cận trên; `lessonBlocks.Min`, `mustTeach`, nghỉ và ô
  cố định không được tự nới. Vô nghiệm hoặc chưa chứng minh tối ưu thì không
  áp lịch.
- Test mới: `python -m unittest solver_runtime.tests.test_exact_v2` (5/5).
- Fixture read-only 1.530 tiết chưa chứng minh được `sessions_optimum` trong
  60–180 giây (`sessions_optimum_not_proven`); hệ thống fail-closed, chưa áp
  candidate. Đây là blocker tối ưu lớn còn mở trước canary.
- Chưa deploy VPS/Cloud Run. Xem chi tiết hợp đồng và gate ở
  [`SOLVER_V2_PLAN.md`](SOLVER_V2_PLAN.md).

## Sản phẩm

Hệ thống xếp thời khóa biểu tự động cho trường phổ thông, production tại `https://tkbcherry.com`. Quy mô đã kiểm chứng: 75 lớp, 125 giáo viên, ~2.200 tiết/tuần.

## Kiến trúc thực tế (đối chiếu mã nguồn 2026-08-16)

- **Frontend** `web/`: Vanilla JS, không build system. Planner ở `pages/sapxep.html` + `pages/phanmon.js`; FET engine chạy trong Web Worker (`pages/tkb-fet-engine.js`); bridge solve ở `pages/tkb-rust-bridge.js`.
- **Backend** `rust_api/`: HTTP server **tự viết trên std** (TcpListener + thread), không Axum/Tokio. Dependency: argon2, serde_json, rusqlite, sha2. Auth = Argon2id + **session token opaque** (không JWT). Port local mặc định `1010` (`.env`, `TKB_RUST_PORT`).
- **Solver** `solver_runtime/`: Python 3.12 + OR-Tools CP-SAT/MILP; chạy trên Cloud Run (chính) và VPS (fallback), giao tiếp stdio protocol `tkb-reference-solver-stdio-v1`.
- **Dữ liệu**: SQLite KV store (`kvstore`), WAL mode; mỗi trường một key `school_{schoolId}`. Registry kết quả solve giữ trong RAM (TTL 6h, tối đa 64 bản) — restart service mất job đang theo dõi.
- **Luồng solve**: một nút Sắp xếp adaptive → precheck (`fresh_complete_first` / `repair_partial` / `refine_complete`) → Cloud Run → VPS Python → Rust native fallback. Chất lượng so sánh lexicographic: đủ tiết + hard-valid → 0 buổi 1 tiết → 0 gap ≥2 → tổng buổi GV → gap 1.
- **Solver pool**: FIFO theo CPU token (VPS: `MAX_CONCURRENT=3`, `CPU_TOKENS=6`); job idempotent theo `solve_run_id`, reconnect qua `GET /api/solve-result`.

## Nhánh và quy trình Git

- Remote: `https://github.com/thoikhoabieucherry/TKBCherry` (nhánh chính: `main`).
- Phát triển trên nhánh `codex/*` theo từng đợt tính năng, merge về `main` khi ổn định.
- CI (GitHub Actions): `.github/workflows/tests.yml` (Python solver tests, Node contract tests + syntax, Rust check/test/clippy), `security.yml` (secret scan + CodeQL), `build-agent-wasm.yml`.

## Kiểm thử

- `solver_runtime/tests/` — 20 module unittest (contract, chất lượng lexicographic, stdio protocol, golden model-plan…). Chạy: `python -m unittest solver_runtime.tests.<module>`.
- `e2e_tests/*_node.test.js` — 29 bộ; 26 bộ chạy không cần server (CI chạy được), 3 bộ cần backend (`app_assignment_subject_visibility`, `app_data_integrity`, `tkb_rust_bridge`) chạy qua `python run_e2e_tests.py` (server test port 1085).
- Benchmark FET: `tools/benchmarks/benchmark-fet.js` với fixture smoke/pressure/medium/stress (xem `docs/benchmarks/FET_BENCHMARK.md`).
- Checklist thủ công trước deploy: `docs/REGRESSION_CHECKLIST.md`.

## Hợp đồng quan trọng

- **Model-Plan Contract v1** (`docs/MODEL_PLAN_CONTRACT.md`): cổng tương thích để di trú model builder từ Python sang Rust/WASM; golden fixtures trong `solver_runtime/fixtures/model_plan_v1/`. Mọi refactor solver phải giữ các fixture này xanh.
- Stdio protocol / progress protocol / agent helper protocol: hằng số phiên bản khai báo ở đầu `rust_api/src/main.rs`.

## Deploy

- VPS: `python tools/vps-deploy/update-deploy.py` (backup → upload → build → drain → health check `UPDATE_OK`). Credentials từ biến môi trường/DPAPI — không ghi vào repo.
- Cloud Run: `tools/cloud-run/deploy.ps1` (build qua Cloud Build, canary rồi chuyển traffic).
- Quy tắc sống còn: **không bao giờ** xóa các exclude `*.db-wal`/`*.db-shm` trong script rsync deploy (đã từng gây mất dữ liệu).

## Việc đang mở / nợ kỹ thuật đã ghi nhận

1. Refactor dần 4 file monolith: `rust_api/src/main.rs` (~25k dòng), `solver_runtime/src/tkb_new/adapter.py` (~27k dòng), `web/pages/tkb-rust-bridge.js` (~20k dòng), `web/pages/phanmon.js` (~12k dòng). Dùng golden fixtures + contract tests làm lưới an toàn; mỗi phiên tách một mảng.
2. Bền hóa registry job solve vào SQLite để sống qua restart service.
3. Dọn secrets plaintext trên máy dev (mail-server/.env, super-admin.conf) — chủ dự án tự thực hiện.
4. Chính sách archive handoff: đầu mỗi tháng, chuyển các mục tháng trước của `PROJECT_HANDOFF.md` sang `docs/archive/PROJECT_HANDOFF_<khoảng-ngày>.md`.
