# TKBCherry — FET chạy trên web

TKBCherry là ứng dụng web quản lý và xếp thời khóa biểu trường học. Người dùng
nhập danh mục, phân công chuyên môn, ràng buộc và các ô cố định; FET tự xếp ngay
trong trình duyệt, cho phép chỉnh tay rồi xuất Excel/Word.

Phiên bản hiện tại có một kiến trúc duy nhất:

```text
Trình duyệt
  ├─ giao diện, ràng buộc, import/export
  └─ Web Worker FET: toàn bộ việc xếp và tối ưu TKB

Rust tại 127.0.0.1:1010
  ├─ phục vụ thư mục web/
  ├─ đăng nhập và phiên làm việc
  └─ lưu dữ liệu trường vào SQLite
```

Không có bộ xếp lịch phía máy chủ, hàng đợi job, bridge solver, CP-SAT hay Cloud
Run. Trình duyệt không gửi bài toán TKB ra dịch vụ tính toán bên ngoài.

## Hợp đồng ổn định

| Thành phần | Trách nhiệm | Không được làm |
| --- | --- | --- |
| Planner | Nhập/chỉnh dữ liệu, hiển thị tiến trình, kiểm định và áp lịch | Gọi dịch vụ tính lịch từ xa |
| FET worker | Xếp mới, tối ưu, checkpoint, hủy và trả metrics | Ghi trực tiếp vào SQLite |
| Rust | Static web, auth/session, registry và school store | Chạy hoặc điều phối thuật toán TKB |
| Mail service | Gửi OTP khi được cấu hình riêng | Tham gia luồng xếp lịch |

Mọi thay đổi phải giữ các bất biến sau:

- Không mất tiết và không áp kết quả thiếu tiết.
- Không ghi đè ô cố định hoặc ô OFF.
- Không thêm trùng lớp, giáo viên, phòng hay vi phạm cứng đang bật.
- Mỗi trang chỉ có một worker chính; lệnh Dừng giữ checkpoint tốt nhất đã qua
  kiểm định.
- Lịch không rời thiết bị để được tính toán.
- Máy chủ mặc định chỉ nghe `127.0.0.1:1010`.

## Chạy ứng dụng

Yêu cầu: Python 3.10+ và Rust/Cargo để build máy chủ lần đầu.

Từ thư mục gốc:

```powershell
python .\start.py
```

Mở:

```text
http://127.0.0.1:1010/
```

`start.py` tự build Rust khi mã nguồn mới hơn bản chạy, khởi động máy chủ và mở
trình duyệt. Đóng cửa sổ launcher để dừng. Chế độ dòng lệnh:

```powershell
python .\start.py --foreground --no-browser
```

Cổng mặc định là `1010`; có thể đổi tạm để kiểm thử bằng `--port` hoặc
`TKB_RUST_PORT`. Máy chủ mặc định chỉ nghe `127.0.0.1`.

## Cấu hình

Sao chép `.env.example` thành `.env`, tối thiểu đổi mật khẩu Super Admin:

```dotenv
TKB_SUPER_PASSWORD=your-secure-password-here
TKB_RUST_HOST=127.0.0.1
TKB_RUST_PORT=1010
```

Các tùy chọn còn lại được giải thích ngay trong `.env.example`. Không commit
`.env`, token phiên, cơ sở dữ liệu hoặc file Excel có dữ liệu thật.

## Luồng xếp lịch

1. Trang `web/pages/sapxep.html` nạp engine FET và giao diện planner.
2. `web/pages/phanmon.js` kiểm tra dữ liệu, tạo
   `web/pages/tkb-fet-worker.js` và gửi một bản sao dữ liệu vào worker.
3. Worker chạy `FetTimetableEngine`, gửi tiến trình/checkpoint về giao diện và
   quan sát lệnh Dừng.
4. Ứng viên chỉ được áp dụng sau khi qua kiểm tra đủ tiết, ô cố định, OFF, trùng
   giáo viên/phòng và các ràng buộc đang bật.
5. Lịch hợp lệ được lưu qua `/api/school/store`; Excel/Word được tạo và tải ngay
   trong trình duyệt.

Thứ tự chất lượng tổng quát:

1. Xếp đủ nhu cầu và không thêm vi phạm cứng.
2. Giảm buổi giáo viên chỉ dạy một tiết.
3. Giảm buổi có từ hai tiết trống trở lên.
4. Giảm tổng buổi/ngày dạy.
5. Giảm buổi có một tiết trống và cân bằng lịch.

Menu **Tối ưu** có bốn mục tiêu riêng: **1 tiết/buổi**, **Buổi**,
**2 tiết trống**, **1 tiết trống**. Mỗi lần chạy giữ checkpoint tốt nhất; Dừng
không áp một lịch thiếu tiết hoặc xấu hơn theo cổng chất lượng của chế độ đó.

## Máy chủ Rust

Máy chủ chỉ cung cấp các tuyến sau:

- `GET /api/health` — trạng thái và danh tính kiến trúc.
- `GET /api/version` — phiên bản ứng dụng.
- `POST /api/auth/login`, `/logout`, `/register`, `/hash-password`.
- `GET /api/auth/session`.
- `GET`/`POST /api/auth/registry` — registry đã giới hạn theo vai trò/trường.
- `GET`/`POST /api/school/store?id=...` — dữ liệu một TKB, bắt buộc Bearer.
- Các đường dẫn còn lại phục vụ tệp tĩnh trong `web/`.

`GET /api/health` phải báo:

```json
{
  "api": "rust",
  "architecture": "browser-only",
  "engine": "fet-web-worker",
  "capabilities": ["static-web", "auth", "school-store"]
}
```

Dữ liệu mặc định nằm ở `rust_api/tkb_store.db`. Mỗi request lưu trường được kiểm
tra session và quyền truy cập `sid`; registry trả về trình duyệt không chứa hash
mật khẩu hay mã OTP.

## Cấu trúc repo

| Đường dẫn | Vai trò |
| --- | --- |
| `web/pages/tkb-fet-engine.js` | Engine FET/CSP và các operator tối ưu |
| `web/pages/tkb-fet-worker.js` | Worker nền, tiến trình, checkpoint và hủy |
| `web/pages/phanmon.js` | Hợp đồng giao diện ↔ FET, kiểm định và áp lịch |
| `web/pages/tkb-constraints*.js` | Khai báo, nhập/xuất và kiểm tra ràng buộc |
| `web/shared/` | Đăng nhập, phiên, ngữ cảnh trường và lưu dữ liệu |
| `rust_api/src/` | Máy chủ static/auth/store và SQLite |
| `e2e_tests/` | Kiểm thử FET, worker và hợp đồng giao diện |
| `tools/benchmarks/` | Fixture ẩn danh và benchmark FET cục bộ |
| `mail-server/` | Dịch vụ OTP Gmail tùy chọn, không được `start.py` khởi động |
| `docs/` | Trạng thái, thuật toán, checklist và nhật ký bàn giao |

## Kiểm thử

Với Node 22, Python và Rust/Cargo:

```powershell
Get-ChildItem web,e2e_tests,tools\benchmarks -Recurse -Filter *.js |
  ForEach-Object { node --check $_.FullName }
node --test e2e_tests\*.test.js
python -m unittest discover -s tests -p "test_*.py"
cargo check --locked --manifest-path rust_api\Cargo.toml
cargo test --locked --manifest-path rust_api\Cargo.toml
```

Kiểm thử dịch vụ mail tùy chọn:

```powershell
cd mail-server
npm ci
npm test
```

Benchmark nhanh dùng fixture ẩn danh:

```powershell
node tools\benchmarks\benchmark-fet.js --fixture=smoke --seeds=101,202,303 --modes=auto,optimize_gap2
```

Tài liệu kỹ thuật được giữ lại có mục đích rõ ràng:

- [Trạng thái hiện hành](docs/CURRENT_STATE.md)
- [Hướng dẫn kế thừa](PROJECT_INHERITANCE_GUIDE.md)
- [Checklist hồi quy](docs/REGRESSION_CHECKLIST.md)
- [Thiết kế tối ưu Gap 2](docs/ALGORITHM_GAP2.md)
- [Benchmark FET](docs/benchmarks/FET_BENCHMARK.md)
- [Nhật ký bàn giao](docs/PROJECT_HANDOFF.md)

## Phạm vi triển khai

Repo này không chứa quy trình triển khai hạ tầng. Phiên chuyển đổi kiến trúc
ngày 23/08/2026 chỉ sửa, kiểm thử, commit và push mã nguồn; không triển khai lên
dịch vụ hay máy chủ bên ngoài. Mọi yêu cầu phát hành sau này phải là một công
việc riêng, có đích và quyền rõ ràng.
