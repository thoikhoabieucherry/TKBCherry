# PROJECT HANDOFF — TKBCherry Web FET

Cập nhật: **23/08/2026 (Asia/Bangkok)**

Nhánh: **codex/backend-fet-billion**

Triển khai: **không deploy**

Đọc **docs/CURRENT_STATE.md** trước. File này chỉ giữ thay đổi còn hiệu lực của
kiến trúc web FET; nhật ký CP-SAT/Cloud/VPS cũ đã xóa khỏi live docs vì mâu
thuẫn với mã hiện tại. Git vẫn là lịch sử đầy đủ.

## 23/08/2026 — Xếp nhanh và bốn profile tối ưu có deadline

### Yêu cầu

- Nghiên cứu FET 7.9.5 gốc tại thư mục ProjectX/FET.
- Làm nút Xếp nhanh, không tự chạy tối ưu sâu.
- Bốn nút Tối ưu phải chạy đúng mục tiêu và dừng hợp lý.
- Không CP-SAT, Cloud Run, backend solver, dữ liệu trường thật hay deploy.

### Nguyên nhân gốc đã xác nhận

1. Nút Xếp bị ánh xạ vào solve_optimize_all. Sau khi có lịch đủ, worker vẫn
   chạy quality budget mặc định 600.000 ms, warmup, deep singleton, restart và
   Gap2. Đây là nguyên nhân chính của lượt “lâu kinh dị”.
2. Child construction cũ gửi action=solve; dispatcher lại coi action đó là
   solve+optimize, nên child có thể xếp xong nhưng không trả done cho parent.
3. randomSwap clone toàn bộ lưới lớp, giáo viên và phòng ở mỗi nhánh ejection.
4. FET gốc dùng MAX_LEVEL=14 và limitcallsrandomswap=2*nInternalActivities;
   bản web dùng depth 16 và 2.000–10.000 calls cố định.
5. Sau placement 124 ms, repairStudentHoles cũ có thể gọi compaction hàng nghìn
   lần không cải thiện và kéo tổng thời gian lên khoảng 10 giây.
6. countStudentHoles tính cả ô OFF không thể sử dụng là “lỗ”, khiến optimizer
   bị chặn bởi điều kiện zero-hole giả.
7. Fixture medium cũ tự tạo 40 tiết sáng dùng chung phòng chỉ có 30 ô, nhưng
   benchmark lại kỳ vọng complete.

### Quyết định và thay đổi

**web/pages/tkb-fet-engine.js**

- randomSwap dùng move journal theo delta và rollback từ transaction mark.
- Depth construction về 14.
- Call budget cơ sở theo 2 × số activity, có floor/cap an toàn; deep fallback
  cũng tỷ lệ theo quy mô thay vì 10.000 cố định.
- Cleanup sau construction có slice 250–350 ms; bỏ repair vô hạn trên lịch
  incomplete.
- OFF không còn bị tính là student hole có thể sửa.
- Preflight phát hiện thiếu sức chứa lớp, giáo viên và phòng theo sáng/chiều;
  ca đã chứng minh bất khả thi trả fet_capacity_shortage ngay.
- loadExistingSchedule khởi tạo placement -1 trước khi đặt activity, bảo đảm
  grid của optimizer được nạp đầy đủ.

**web/pages/tkb-fet-worker.js**

- Viết lại từ 1.000+ dòng xuống worker hai đường rõ ràng.
- runFastConstruction: 12 giây tổng, tối đa 3 seed tuần tự, first-complete wins.
- runFocusedOptimization: chỉ bốn mode được phép.
- Budget mặc định: singleton 12 giây; sessions/Gap2/Gap1 8 giây.
- Checkpoint chỉ chụp khi complete và comparator báo tốt hơn.
- Heartbeat không clone TKB.
- Alias solve_optimize_all/auto cũ đi vào construction nhanh; không có automatic
  quality pipeline, nested worker pool hay budget 600 giây.
- Mỗi done trả timing theo phase và diagnostics.

**web/pages/phanmon.js, sapxep.html**

- Điểm vào mặc định là solve_fast và action=construct.
- Nếu lịch đã đủ, Xếp dừng ngay và hướng người dùng sang menu Tối ưu.
- Nếu lịch chưa đủ, các nút Tối ưu yêu cầu Xếp trước.
- Candidate construction cũng qua validator trình duyệt trước khi áp.
- UI đặt budget đúng từng mode; nút có tooltip “Xếp nhanh thời khóa biểu”.
- Cache marker: 20260823-web-fet-quick-v2.

**Benchmark và test**

- Fixture medium tăng số phòng để không còn thiếu sức chứa giả.
- Harness mô phỏng đúng profile Xếp, bật singletonRush đúng như UI.
- Record có phaseRuntimeMs construction/optimization.
- Thêm worker VM test chạy thật legacy construction và cả bốn profile.
- Test cũ bắt buộc pipeline 600 giây được thay bằng contract chống hồi quy mới.

### Mốc tái tạo được

Medium 24 lớp, 432 tiết, seed 101/202/303:

| Mode | Complete/hard-valid | Wall p50 / p95 | Delta mục tiêu TB |
| --- | ---: | ---: | ---: |
| Xếp | 100% / 100% | 166,93 / 199,13 ms | — |
| 1 tiết/buổi | 100% / 100% | 1.804,15 / 2.325,41 ms | -16,33 |
| Buổi | 100% / 100% | 717,20 / 733,69 ms | -13,00 |
| 2 tiết trống | 100% / 100% | 486,60 / 543,09 ms | 0,00, đầu vào đã zero |
| 1 tiết trống | 100% / 100% | 738,56 / 835,25 ms | -3,33 |

Worker VM riêng trên seed 101:

- construct 360/360 khoảng 0,15 giây;
- singleton 57 → 28 khoảng 1,13 giây;
- sessions và Gap1 giảm đúng metric;
- Gap2 zero trả targetReached ngay.

Pressure 3/3 seed complete-valid; Gap2 giữ đúng sàn cố định 1.
Stress 2.340 tiết với budget 1 giây dừng khoảng 1,05 giây, không chạy repair
thêm hàng phút.

### Kiểm chứng đã chạy

- JavaScript syntax cho engine, worker, planner, benchmark: pass.
- Focused engine/worker/benchmark/architecture: **53/53 pass**.
- Toàn bộ Node FET/UI: **152/152 pass**.
- Launcher Python: **11/11 pass**.
- Mail service: **5/5 pass** (cài dependency local bằng pnpm vì npm không có
  trong PATH của phiên).
- Worker VM functional profiles: pass.
- Medium report 15/15 record complete-valid.
- Pressure report 6/6 record complete-valid.
- Local browser smoke ở cổng 1011 với SQLite tạm: backend sẵn sàng, trang login
  tải không có console error. Không dùng cổng 1010 và không dùng DB hiện có.
- Đối chiếu ảnh launcher báo thiếu backend: câu báo đó không còn trong
  `start.py` hiện tại; binary `rust_api/prebuilt/windows-x64/tkb_rust_api.exe`
  tồn tại và manifest khớp cả source fingerprint lẫn SHA-256.
- git diff --check: pass tại thời điểm rà soát.

Cargo không có trên máy nên không chạy lại cargo check/test; phiên này không sửa
nguồn Rust. Launcher tests và smoke bằng binary Rust đóng gói đều pass.

Report:

- docs/benchmarks/fet-medium-latest.json
- docs/benchmarks/fet-pressure-latest.json

### Dọn tài liệu

Đã xóa:

- ALGORITHM_GAP2.md vì mô tả portfolio 90 giây/optimize-all không còn tồn tại;
- handoff archive CP-SAT/Cloud cũ;
- sáu report benchmark ngày cũ/trùng latest.

Live docs còn CURRENT_STATE, PROJECT_HANDOFF, REGRESSION_CHECKLIST,
FET_BENCHMARK, README và PROJECT_INHERITANCE_GUIDE.

### Trạng thái Git và deploy

Baseline trước phiên: commit **0b97a2f**. Toàn bộ thay đổi của mục này được gom
trên nhánh **codex/backend-fet-billion**; Git là nguồn xác nhận commit/push.

Không deploy, không chạm Cloud/VPS, không gửi bài toán ra ngoài, không sửa
database hoặc lịch người dùng. Port 1011 chỉ dùng cho smoke local rồi đã dừng.

## 23/08/2026 — Baseline kiến trúc được kế thừa

- Repo đã được chuyển sang browser-only FET.
- Python solver, serverless/Cloud Run, bridge/mirror và Rust compute route đã
  bị xóa.
- Rust còn static/auth/school-store, mặc định 127.0.0.1:1010.
- Launcher Windows dùng prebuilt đã kiểm tra SHA-256 và source fingerprint.
- .env và rust_api/tkb_store.db* vẫn bị Git ignore; không lưu credential.
