# TKBCherry — Current State

Cập nhật: **23/08/2026**
Trạng thái phát hành: **mã nguồn cục bộ/GitHub, chưa triển khai**

## Kiến trúc hiện hành

TKBCherry là ứng dụng web FET. Toàn bộ thuật toán xếp và tối ưu chạy trong
`web/pages/tkb-fet-worker.js`, sử dụng
`web/pages/tkb-fet-engine.js`. Worker có thể tạo các worker con để thử nhiều
seed nhưng mọi compute vẫn nằm trong trình duyệt.

Rust là một máy chủ HTTP tối thiểu tại `127.0.0.1:1010`:

- phục vụ tệp trong `web/`;
- đăng nhập, đăng xuất, đăng ký, session và registry;
- phân quyền dữ liệu theo trường/TKB;
- đọc/ghi JSON trường trong SQLite.

Máy chủ không nhận bài toán TKB, không có job/polling/queue, không chạy engine
FET thay trình duyệt và không chọn tuyến compute bên ngoài.

## Luồng dữ liệu

```text
Người dùng → planner → FET Web Worker → checkpoint đã kiểm định → DATA
                                                        ↓
                                      /api/school/store → SQLite
```

1. Planner nạp dữ liệu trường từ kho có Bearer session.
2. Khi bấm Xếp/Tối ưu, planner chụp dữ liệu và gửi sang worker.
3. Worker gửi progress và candidate; planner kiểm tra lại ràng buộc cứng.
4. Candidate hợp lệ được render trước, sau đó lưu vào school store.
5. Xuất Excel/Word dùng API trình duyệt và tải file trực tiếp.

## Hợp đồng FET đang giữ

- Construction phải trả lịch đủ tiết hoặc báo thất bại; lịch thiếu không được áp.
- Fixed/OFF, trùng lớp/giáo viên/phòng, tiết đôi, giới hạn môn và các ràng buộc
  người dùng đều được kiểm tra trước khi commit.
- Tối ưu được phép giữ đúng các vi phạm legacy đã có trong incumbent nhưng không
  được thêm một chữ ký vi phạm mới.
- So sánh chất lượng là lexicographic theo mode; checkpoint xấu hơn bị loại.
- Một worker chính mỗi trang; Dừng/timeout/plateau giải phóng worker và giữ best.
- Worker có cooperative yield để giao diện vẫn phản hồi.

## Máy chủ và API

Phiên bản health: `tkb-web-fet-v1`.

Các tuyến chủ động:

- `GET /api/health`, `GET /api/version`.
- `POST /api/auth/login`, `/logout`, `/register`, `/hash-password`.
- `GET /api/auth/session`.
- `GET`/`POST /api/auth/registry`.
- `GET`/`POST /api/school/store?id=<sid>`.
- Static aliases `/`, `/app`, `/school-portal`, `/super-admin`, `/sapxep`.

Giới hạn HTTP: header 64 KiB, body 64 MiB, store id 160 byte và chỉ gồm chữ,
số, `-`, `_`, `.`. Static path được canonicalize để chặn traversal. Response có
`nosniff`, `DENY` frame, referrer/permissions policy và CORS cấu hình được.

Auth dùng Argon2, session hết hạn sau 24 giờ, giới hạn đăng nhập theo cửa sổ và
khóa một session hoạt động cho tài khoản thường. Registry trả cho client đã loại
hash mật khẩu và OTP. Super Admin lấy mật khẩu khởi tạo từ
`TKB_SUPER_PASSWORD`.

SQLite mặc định: `rust_api/tkb_store.db`, WAL + busy timeout 5 giây. `.env` và
database đều bị Git bỏ qua.

## Cây mã nguồn được giữ

- `web/`: giao diện, FET, ràng buộc, auth/storage và thư viện browser.
- `rust_api/`: ba file Rust chính, Cargo manifest/lock, SQLite runtime và bản
  chạy Windows x64 có manifest SHA-256.
- `e2e_tests/`: test engine, worker, planner, auth, export và responsive UI.
- `tools/benchmarks/`: benchmark FET dùng fixture ẩn danh.
- `tests/`: test launcher Python.
- `mail-server/`: OTP Gmail tùy chọn, độc lập với `start.py` và luồng FET.
- `docs/`: tài liệu hiện hành, benchmark và archive handoff.

Đã xóa runtime Python solver, các module điều phối Rust cũ, bridge/mirror/backup
engine, script Cloud/host cũ, file thử nghiệm tạm, dữ liệu benchmark thật, binary
Excel tạm và các test chỉ bảo vệ kiến trúc đã nghỉ.

## Chạy và cấu hình

```powershell
python .\start.py
```

Mặc định mở `http://127.0.0.1:1010/`. Trên Windows x64, launcher kiểm tra cả
dấu vân tay nguồn Rust và SHA-256 binary rồi dùng
`rust_api/prebuilt/windows-x64/tkb_rust_api.exe`; không yêu cầu cài Rust. Bản
build local còn mới được ưu tiên, còn Cargo chỉ được gọi khi mã Rust đã thay đổi
và bản đóng gói không còn khớp. Launcher không kiểm tra phụ thuộc solver Python.

Biến môi trường hỗ trợ: `TKB_SUPER_PASSWORD`, `TKB_RUST_HOST`,
`TKB_RUST_PORT`, tùy chọn `TKB_DB_PATH`, `TKB_CORS_ORIGIN`, `TKB_NO_LOGS` và
`TKB_RUST_BUILD_TIMEOUT`.

## Kiểm thử chuẩn

- JavaScript syntax cho `web/`, `e2e_tests/`, `tools/benchmarks/`.
- `node --test e2e_tests/*.test.js`.
- `python -m unittest discover -s tests -p "test_*.py"`.
- `cargo check --locked` và `cargo test --locked` trong `rust_api/`.
- `npm ci && npm test` trong `mail-server/`.
- Smoke local: health, static planner, auth và school store trên một cổng tạm.

CI hiện hành: `.github/workflows/tests.yml` với bốn lane browser FET, launcher,
mail và Rust; `.github/workflows/security.yml` cho secret/JS/Rust review.

## Trạng thái triển khai

Không có thao tác triển khai trong lần chuyển đổi 23/08/2026. Repo không còn
runbook hay script triển khai ứng dụng chính. Việc phát hành về sau phải được yêu
cầu rõ ràng và kiểm tra riêng; không suy ra quyền triển khai từ một yêu cầu sửa
mã, kiểm thử hoặc push Git.

## Việc cần lưu ý khi sửa tiếp

1. `tkb-fet-engine.js` và `phanmon.js` vẫn lớn; chia nhỏ chỉ nên làm cùng fixture
   và contract test tương ứng.
2. Không tạo mirror của engine/worker; tránh lệch phiên bản.
3. Không đưa school workbook, registry dump hoặc database vào fixture; chỉ dùng
   dữ liệu tổng hợp/ẩn danh.
4. Khi đổi hợp đồng worker, cập nhật architecture test, benchmark và handoff
   trong cùng phiên.
