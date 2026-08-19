# TKBCherry — Trạng thái hiện hành (CURRENT STATE)

*Cập nhật: 2026-08-19. File này là bản tóm tắt ngắn để onboard nhanh; chi tiết từng phiên làm việc nằm trong `PROJECT_HANDOFF.md` (mục cũ hơn ở `docs/archive/`).*

## Sản phẩm

Hệ thống xếp thời khóa biểu tự động cho trường phổ thông, production tại `https://tkbcherry.com`. Quy mô đã kiểm chứng: 75 lớp, 129 giáo viên, ~2.200 tiết/tuần, xếp 100% không xung đột trong < 200 ms.

## Kiến trúc thực tế (đối chiếu mã nguồn 2026-08-19)

- **Frontend** `web/`: Vanilla JS, không build system. Planner tại `pages/sapxep.html` + `pages/phanmon.js`; FET engine chạy 100% cục bộ trong Web Worker (`pages/tkb-fet-engine.js`, `pages/tkb-fet-worker.js`). Đã gỡ bỏ toàn bộ phụ thuộc legacy CP-SAT / Cloud Run / Rust solver bridge trên giao diện xếp lịch.
- **Solver Engine**: 100% Client-Side Web Worker FET C++ v7.9.5 port. Thuật toán:
  1. *MRV Activity Difficulty Ordering* (`generate_pre.cpp`): sắp xếp độ khó hoạt động đa chiều (miền giá trị, thời lượng, xung đột lớp/GV/phòng, tải tuần, ô cấm).
  2. *Min-Conflicts Recursive RandomSwap* (`generate.cpp`): độ sâu `depth <= 16`, `limitCalls = 10,000`, Tabu queue $\le 16$, chống lặp vô tận.
  3. *FET Counting Invariant ConstraintMinHoursDaily* (`opensUnaffordableSession`): kiểm soát mở buổi dạy mới $\sum \max(\text{minDaily}, H_d) \le \text{totalLoad}$, ngăn phát sinh buổi 1 tiết.
  4. *Closed Push-Cycles & Gap Crusher* (`tryClosedPushCycles`, `tryCrushGaps`): chuỗi đẩy khép kín 2-step / 3-step và tối ưu đa tầng (buổi 1 tiết $\to 0$, khoảng trống $\ge 2 \to 0$, dồn buổi dạy, bất biến liền mạch học sinh).
- **Backend** `rust_api/`: HTTP server **tự viết trên std** (TcpListener + thread pool), không Axum/Tokio. Dependency: argon2, serde_json, rusqlite, sha2. Auth = Argon2id + **session token opaque** (không JWT). Port local mặc định `1010` (`.env`, `TKB_RUST_PORT`). Quản lý xác thực, phân quyền và lưu trữ dữ liệu trường học.
- **Dữ liệu**: SQLite KV store (`kvstore`), WAL mode; mỗi trường một key `school_{schoolId}`.
- **Luồng solve**: Nút Play ▶ ("Tự động xếp TKB") và Stop ■ ("Dừng xếp") chạy 100% trong Web Worker, cập nhật thanh tiến trình theo thời gian thực (ms), thống kê tức thì và không gửi network request ra ngoài khi xếp lịch.

## Nhánh và quy trình Git

- Remote: `https://github.com/thoikhoabieucherry/TKBCherry` (nhánh chính: `main`).
- Phát triển trên nhánh `codex/*` theo từng đợt tính năng, merge về `main` khi ổn định.
- CI (GitHub Actions): `.github/workflows/tests.yml` (Python solver tests, Node contract tests + syntax, Rust check/test/clippy), `security.yml` (secret scan + CodeQL), `build-agent-wasm.yml`.

## Kiểm thử & Benchmark

- **Automated Benchmarks**:
  - `scratch/dongkhoi_1566.json` (54 lớp / 1.566 tiết): 100% xếp đủ 1.080/1.080 hoạt động trong **< 150 ms** (~84 ms), 0 vi phạm hard constraints, `soBuoiDay1 = 0`.
  - `scratch/default_school_0317.json` (75 lớp / 2.193 tiết): 100% xếp đủ 1.500/1.500 hoạt động trong **< 200 ms** (~98 ms), 0 vi phạm hard constraints, `soBuoiDay1 = 0`.
  - Chạy benchmark: `node scratch/test_forensic_benchmark.js`.
- **E2E & Unit Tests (100% Passing)**:
  - `e2e_tests/tkb_fet_engine_node.test.js` (33 tests pass).
  - `e2e_tests/tkb_fet_benchmark_node.test.js` (3 tests pass).
  - `e2e_tests/benchmark_fet_node.test.js` (4 tests pass).
  - `solver_runtime/tests/` (391 tests pass).
- Checklist thủ công trước deploy: `docs/REGRESSION_CHECKLIST.md`.

## Hợp đồng quan trọng

- **Model-Plan Contract v1** (`docs/MODEL_PLAN_CONTRACT.md`): cổng tương thích định dạng dữ liệu và golden fixtures trong `solver_runtime/fixtures/model_plan_v1/`.
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
