# TKB DEMO — Phần mềm xếp thời khóa biểu local

Ứng dụng web local cho trường học: nhập danh mục, phân công (PCCM), ràng buộc, sắp xếp TKB tự động, chỉnh tay, xuất Excel/Word.

## Chạy ứng dụng

Từ thư mục gốc repo:

```powershell
python .\start.py
```

Hoặc dùng `start.exe` nếu đã build bằng PyInstaller (xem mục Build bên dưới).

Mở trình duyệt:

```text
http://127.0.0.1:1010/
```

Đóng cửa sổ điều khiển TKB (hoặc Ctrl+C khi chạy `--foreground`) để dừng backend và giải phóng port `1010`.

## Kiến trúc

| Thành phần | Mô tả |
|------------|--------|
| `web/` | Giao diện: quản lý dữ liệu, planner TKB, ràng buộc, import/export |
| `rust_api/` | HTTP API Rust (port 1010), phục vụ static files + solve + export |
| `solver_runtime/` | Python optimizer tham chiếu (CP-SAT / MILP qua `ortools`) |
| `web/vendor/` | Thư viện JS/WASM local (xlsx, jszip, sql.js) — không cần CDN |
| `data/` | File Excel mẫu (nếu có) |
| `start.py` | Launcher: build Rust nếu cần, khởi động API, mở trình duyệt |

### Luồng sắp xếp tự động

```text
UI (một nút Sắp xếp) → POST /api/solve-precheck
  → tự nhận diện trạng thái lịch
     ├─ fresh_complete_first: lịch trống/thiếu nhiều → xếp đủ trước, rồi tối ưu
     ├─ repair_partial: chỉ thiếu ít tiết → sửa phần còn thiếu từ incumbent mềm
     └─ refine_complete: lịch đã đủ và hợp lệ → tối ưu tiếp từ incumbent mềm
  → POST /api/solve-data
  → Hybrid Python CP-SAT/MILP (solver_mode: auto)
  → Rust native fallback/repair khi Python không sẵn sàng hoặc trả lỗi
```

Người dùng không phải chọn Nhanh/Max. Bridge tự chọn nhánh theo nhu cầu tiết từ PCCM và trạng thái TKB hiện tại. Lịch hiện có chỉ là **incumbent mềm**: solver được phép dời các tiết để thoát nghiệm cục bộ; chỉ ô có `fixed: true` mới là khóa cứng. Trước khi tái sử dụng incumbent, backend dựng lại giáo viên theo PCCM hiện tại và kiểm tra ràng buộc cứng để không khôi phục lịch cũ sai phân công.

Chất lượng được so sánh theo thứ tự ưu tiên (lexicographic), không dùng một mốc số buổi/tiết trống cố định cho mọi trường:

1. Xếp đủ nhu cầu và không vi phạm ràng buộc cứng.
2. Bắt buộc `0` buổi giáo viên chỉ dạy 1 tiết.
3. Bắt buộc `0` buổi giáo viên có khoảng trống từ 2 tiết trở lên.
4. Giảm tổng số buổi dạy của giáo viên.
5. Giảm khoảng trống 1 tiết, sau đó mới xét tổng khoảng trống và độ cân bằng.

Khi ô thời lượng để trống, lần xếp mới hoặc dựng lại sau khi đổi yêu cầu có cổng chất lượng tối đa `110` giây nhưng trả sớm ngay khi lịch đã đủ, hợp lệ, không có buổi giáo viên dạy một tiết và không có khoảng trống từ hai tiết trở lên; lần bấm tối ưu tiếp trên lịch đầy đủ có ceiling `180` giây để giảm tiếp tổng buổi và gap 1. Ô thời lượng không bị tự điền, thời gian người dùng nhập luôn thắng mặc định ẩn, thời gian chờ FIFO không bị tính vào thời gian giải, và mỗi lần bấm chỉ tạo một canonical job. Nhánh sửa lịch thiếu ít tiết dùng ngân sách ngắn hơn theo đúng số tiết còn thiếu. Bản v1.46 giữ lịch đầy đủ dự phòng cho trường hợp yêu cầu người dùng bắt buộc tạo nợ chất lượng, thử thêm một seed ngẫu nhiên trước khi dùng dự phòng, và không dùng legacy/static hint cho lượt fresh.

`GET /api/health` trả về `api: "rust"` và `algorithmStatus` phản ánh backend đang dùng (ví dụ `hybrid-reference-cp-sat-milp-v1` khi Python solver sẵn sàng).

### API chính

- `GET /api/health` — trạng thái server và solver
- `POST /api/solve-data` — sắp xếp TKB
- `GET /api/solve-result?jobId=...` — nối lại trạng thái/kết quả của job server-owned
- `POST /api/solve-precheck` — kiểm tra dữ liệu trước khi solve
- `POST /api/solve-cancel` — hủy solve đang chạy (theo `solve_run_id` của trường)
- `GET /api/solver-state` — số lượt xếp đang chạy / slot còn trống
- `POST /api/export/tkb-class-xlsx` / `docx` — lưu file export ra thư mục Documents

### Nhiều trường xếp cùng lúc

Backend dùng **solver pool FIFO** có giới hạn CPU để nhiều trường không làm CP-SAT tranh tài nguyên rồi hết deadline:

- VPS 6 CPU mặc định: `TKB_SOLVER_MAX_CONCURRENT=3`, `TKB_SOLVER_CPU_TOKENS=6`; unified fresh/refine chất lượng dùng toàn bộ 6 worker và xếp hàng FIFO, repair ngắn dùng 2 worker
- Một job chỉ được nhận khi còn đủ toàn bộ worker yêu cầu; mỗi thời điểm VPS chạy một unified fresh/refine hoặc tối đa ba repair ngắn `2 + 2 + 2`
- Local `start.py` tự chọn 1-4 slot theo số CPU và chia tối đa 8 worker cho mỗi lượt
- Khi hết slot/token, request nhận trạng thái `solver_queued` và giao diện âm thầm giữ vị trí, thử lại theo FIFO; lượt sau không được vượt lượt trước
- Mỗi lượt xếp có `solve_run_id` và chủ sở hữu riêng — trạng thái và nút **Dừng** chỉ xem/hủy lượt đang chạy hoặc đang chờ của trường đó
- Hai trình duyệt cùng tài khoản gửi đồng thời cùng một fingerprint TKB sẽ dùng chung một server job; trình duyệt đến sau chỉ nối tiến trình/kết quả, không tiêu tốn thêm một lượt solve
- Unified solve là job do server sở hữu: waiter trên server tự gia hạn vé và nhận CPU theo FIFO kể cả khi trình duyệt ngủ hoặc mất kết nối
- `GET /api/solve-result?jobId=...` trả `202` khi queued/running và trả nguyên status/payload cuối khi hoàn tất; duplicate POST cùng `solve_run_id` là idempotent
- Kết quả reconnect giữ trong RAM tối đa 6 giờ và tối đa 64 bản; sống qua F5/chuyển tab nhưng không qua restart dịch vụ. Frontend lưu job ID cùng fingerprint lịch theo từng `sid` và không áp kết quả stale
- Thời gian chờ không bị trừ vào deadline giải

Có thể chỉnh hai biến trên theo cấu hình máy. VPS: xem `tools/vps-deploy/solver-pool.conf`.

## Bảo mật (auth server-side)

- Đăng nhập qua `POST /api/auth/login` — mật khẩu xác thực trên server
- Session token (Bearer) bắt buộc cho `GET/POST /api/auth/registry` và `/api/school/store`
- Production đặt `TKB_SOLVER_REQUIRE_AUTH=1`: `/api/solve-data`, `/api/solve-result`, `/api/solve-precheck`, `/api/solver-state` và `/api/solve-cancel` đều yêu cầu Bearer hợp lệ
- Local có thể để auth solver tắt phục vụ phát triển; không tắt cổng này trên VPS
- CORS cho phép header `Authorization`; state/cancel được lọc theo chủ sở hữu dù hàng đợi vẫn là FIFO toàn cục
- Đăng ký trường qua `POST /api/auth/register` (public, có kiểm tra IP trùng)
- `GET /api/auth/registry` không trả `passwordHash` / mã OTP
- Super admin khởi tạo từ `TKB_SUPER_PASSWORD` trong `.env`
- Giao diện **không lưu mật khẩu** trong “Ghi nhớ đăng nhập” (chỉ tên đăng nhập)
- Pill trạng thái backend góc màn hình (`runtime.js`) — biết ngay khi server chưa chạy

## Cài đặt lần đầu

### 1. Python dependencies (cho sắp xếp chất lượng cao)

```powershell
pip install -r solver_runtime\requirements.txt
```

Cần: `numpy`, `scipy`, `openpyxl`, `ortools`. Nếu thiếu, app vẫn chạy nhưng hybrid solver có thể không hoạt động.

### 2. Rust backend

`start.py` tự build `rust_api/target/release/tkb_rust_api.exe` nếu source mới hơn exe.

**Không build được (thiếu MSVC)?** Đặt file build sẵn vào `rust_api/prebuilt/tkb_rust_api.exe` hoặc chạy:

```powershell
.\scripts\setup.ps1
```

Setup script kiểm tra Python deps, MSVC linker, và hướng dẫn cài Build Tools nếu thiếu.

Cần Rust toolchain (`cargo`) hoặc MSVC Build Tools trên Windows.

Build thủ công:

```powershell
cd rust_api
cargo build --release
```

### 3. Build launcher EXE (tùy chọn)

```powershell
python -m pip install --user pyinstaller
python -m PyInstaller --onefile --windowed --name start .\start.py
```

Hoặc chạy setup tự động:

```powershell
.\scripts\setup.ps1
```

`start.exe` và `tkb_rust_api.exe` là **artifact build** — có thể không có sẵn trong repo clone mới.

## Kiểm tra regression

Xem [docs/REGRESSION_CHECKLIST.md](docs/REGRESSION_CHECKLIST.md) để test thủ công sau khi chỉnh sửa.

## Lưu trữ dữ liệu

- Mỗi trường = một DB riêng (`TKB_STORE::<schoolId>` trong localStorage + IndexedDB/sql.js)
- Backup localStorage khi KVDB lỗi
- Đổi trường qua school switcher trên thanh menu

## Một nút sắp xếp adaptive

- **Lần đầu hoặc lịch thiếu nhiều:** dựng nghiệm đầy đủ trước, sau đó chỉ nhận ứng viên tốt hơn theo thứ tự chất lượng ở trên.
- **Sau khi đổi một ít PCCM:** giữ phần lịch hợp lệ làm gợi ý mềm, điền phần thiếu và cho phép swap/dời các tiết không khóa; không dựng lại toàn bộ nếu không cần.
- **Bấm lại khi lịch đã đủ:** dùng lịch hiện tại đã tái kiểm định làm incumbent và tối ưu tiếp; không trả về metrics cũ nếu incumbent không còn hợp lệ.
- Mỗi lần chạy có thể tìm nghiệm khác. Solver không khóa cứng lịch cũ và không lấy cache/hint chưa kiểm định làm kết quả.

## Ghi chú kỹ thuật

- Thuật toán sắp xếp trên trình duyệt đã gỡ (`tkb-engine.js` chỉ tạo shell TKB trống)
- Ràng buộc: `web/pages/tkb-constraints.js`
- Bridge solver UI: `web/pages/tkb-rust-bridge.js`
