# TKBCherry — trạng thái hiện hành

Cập nhật: **23/08/2026**

Trạng thái: **chỉ mã nguồn local/GitHub, chưa triển khai**

## Kiến trúc

TKBCherry là bản web của FET. Toàn bộ construction và tối ưu thời khóa biểu
chạy trong trình duyệt:

```text
sapxep.html
  └─ phanmon.js
       └─ tkb-fet-worker.js
            └─ tkb-fet-engine.js
```

Rust chỉ là máy chủ local tại `127.0.0.1:1010`:

- phục vụ `web/`;
- auth/session/registry;
- lưu JSON trường trong SQLite.

Rust không nhận bài toán TKB, không có queue/job/polling và không chạy solver.
Repo không còn CP-SAT, Cloud Run, bridge hay backend solver.

## Hợp đồng nút Xếp

Nút **Xếp** dùng mode `solve_fast`:

- dừng ở lịch đầu tiên đủ 100% activity và hợp lệ;
- không tự chạy singleton, Gap2 hoặc tối ưu tổng hợp;
- tổng ngân sách mặc định 12 giây, tối đa 3 seed tuần tự;
- mỗi seed nhận một phần ngân sách còn lại;
- một lỗi cấu trúc đã chứng minh (zero-domain hoặc thiếu sức chứa
  lớp/giáo viên/phòng) dừng ngay, không restart vô ích;
- lịch đã đủ tiết thì nút Xếp không dựng lại và hướng người dùng sang menu
  **Tối ưu**.

Các tên mode cũ `solve_optimize_all`, `auto` và `fast` chỉ còn là alias
tương thích và đều đi vào construction nhanh. Không còn đường chạy chất lượng
ngầm 600 giây.

## Bốn profile tối ưu

Mỗi click chỉ chạy đúng một metric:

| Nút | Metric | Ngân sách mặc định |
| --- | --- | ---: |
| 1 tiết/buổi | `soBuoiDay1` | 12 giây |
| Buổi | `tsBuoiDay` | 8 giây |
| 2 tiết trống | `soBuoiTrong2` | 8 giây |
| 1 tiết trống | `soBuoiTrong1` | 8 giây |

Engine dừng khi đạt zero/sàn đã chứng minh, hết deadline hoặc một vòng không
cải thiện. Worker chỉ chụp checkpoint hoàn chỉnh có metric tốt hơn. Heartbeat
không mang bản sao TKB. Planner kiểm định candidate trước khi áp và lưu.

Nút **1 tiết/buổi** được phép đánh đổi metric thấp hơn chỉ khi singleton thực sự
giảm; ba nút còn lại không được làm tăng singleton. Candidate thiếu tiết, có
vi phạm mới hoặc xấu hơn theo comparator của mode đều bị loại.

## Construction theo FET 7.9.5

Các giới hạn nóng bám theo `FET/src/engine/generate.cpp`:

- recursion depth 14;
- call budget cơ sở xấp xỉ `2 × số activity`;
- MRV/domain trước, sau đó duration và mức xung đột;
- nhánh kẹt kết thúc sớm để seed sau thử permutation khác.

`randomSwap` dùng nhật ký delta để rollback các activity đã chạm, không clone
toàn bộ lưới lớp/giáo viên/phòng ở mỗi nhánh. Cleanup sau construction có deadline
riêng 250–350 ms; không chạy repair vô hạn sau khi đã xếp xong hoặc hết giờ.
OFF nằm giữa hai tiết không bị tính nhầm là một lỗ học sinh có thể sửa.

## Luồng dữ liệu và an toàn

```text
Người dùng → planner → FET worker → candidate → validator → DATA
                                                        ↓
                                      /api/school/store → SQLite
```

Candidate chỉ được áp khi:

- đủ tiết, `unplacedCount = 0`;
- fixed/OFF và tiết đôi còn nguyên;
- không trùng lớp, giáo viên, phòng;
- không thêm vi phạm ràng buộc đang bật;
- với tối ưu, không xấu hơn incumbent theo mode.

Lệnh Dừng giữ checkpoint hoàn chỉnh tốt nhất đã kiểm định; Dừng trong
construction giữ nguyên lịch trước khi chạy.

## Benchmark hiện hành

Fixture đều tổng hợp và ẩn danh. Báo cáo canonical:

- `docs/benchmarks/fet-medium-latest.json`;
- `docs/benchmarks/fet-pressure-latest.json`.

Medium (24 lớp, 432 tiết, 3 seed):

- construction complete-valid: 100%, p50 **166,93 ms**, p95 **199,13 ms**;
- singleton: delta trung bình **-16,33**, wall p50 **1.804,15 ms**;
- sessions: delta trung bình **-13,00**, wall p50 **717,20 ms**;
- Gap2: giữ zero 100%, wall p50 **486,60 ms**;
- Gap1: delta trung bình **-3,33**, wall p50 **738,56 ms**.

Pressure giữ đúng sàn Gap2 cố định bằng 1 trong 3/3 seed; complete-valid 100%.
Stress 2.340 tiết với budget 1 giây dừng khoảng 1,05 giây và báo incomplete,
không treo thêm hàng phút sau deadline.

## Máy chủ và cấu hình

`rust_api/Cargo.toml` chỉ dùng Argon2, JSON, SQLite và SHA-256. API chủ động:

- `GET /api/health`, `GET /api/version`;
- auth login/logout/register/session/hash-password;
- registry GET/POST;
- school store GET/POST.

SQLite mặc định: `rust_api/tkb_store.db`. Cấu hình hợp lệ trong
`.env.example`: `TKB_SUPER_PASSWORD`, `TKB_RUST_HOST`,
`TKB_RUST_PORT`, tùy chọn `TKB_DB_PATH`, `TKB_CORS_ORIGIN`,
`TKB_NO_LOGS`.

Khởi động:

```powershell
python .\start.py
```

Launcher Windows dùng binary đóng gói đã kiểm tra SHA-256/fingerprint nếu nguồn
Rust không đổi. Không cần cài Rust để chạy ứng dụng.

## Tài liệu được giữ

- `README.md`: cách chạy và tổng quan.
- `PROJECT_INHERITANCE_GUIDE.md`: bản đồ kỹ thuật.
- `docs/CURRENT_STATE.md`: trạng thái canonical này.
- `docs/PROJECT_HANDOFF.md`: nhật ký thay đổi còn hiệu lực.
- `docs/REGRESSION_CHECKLIST.md`: cổng kiểm thử.
- `docs/benchmarks/FET_BENCHMARK.md`: cách tái tạo benchmark.

Tài liệu thuật toán/benchmark/handoff cũ mâu thuẫn với kiến trúc hiện tại đã
được xóa; lịch sử vẫn có trong Git.

## Kiểm thử chuẩn

```powershell
Get-ChildItem web,e2e_tests,tools\benchmarks -Recurse -Filter *.js |
  ForEach-Object { node --check $_.FullName }
node --test (Get-ChildItem e2e_tests -Filter *.test.js).FullName
python -m unittest discover -s tests -p "test_*.py"
cargo check --locked --manifest-path rust_api\Cargo.toml
cargo test --locked --manifest-path rust_api\Cargo.toml
git diff --check
```

CI có bốn lane: Browser FET/UI, launcher Python, mail tùy chọn và Rust.

## Triển khai

Không có thao tác deploy trong đợt thay đổi này. Smoke server nếu cần phải dùng
cổng tạm (ví dụ 1011) và database tạm; không suy ra quyền triển khai từ yêu cầu
sửa mã hoặc benchmark.
