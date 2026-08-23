# Hướng dẫn kế thừa TKBCherry Web FET

Tài liệu này là bản đồ kỹ thuật cho người tiếp quản repo sau ngày 23/08/2026.
Đọc theo thứ tự:

1. `docs/CURRENT_STATE.md` — kiến trúc đang chạy.
2. Mục mới nhất của `docs/PROJECT_HANDOFF.md` — thay đổi và kết quả kiểm thử.
3. `README.md` — cách chạy/cấu hình.
4. Tệp nguồn liên quan trực tiếp tới nhiệm vụ.

## 1. Quy tắc nền

FET chạy trong trình duyệt. Đây không phải một lựa chọn tuyến chạy mà là hợp
đồng kiến trúc:

```text
sapxep.html
  └─ phanmon.js
       └─ tkb-fet-worker.js
            └─ tkb-fet-engine.js

start.py → Rust :1010 → static web + auth + SQLite school store
```

Không đưa thuật toán vào Rust, Python hoặc API từ xa. Không thêm job queue,
polling result, compute telemetry hay bridge thứ hai. Nếu tương lai thật sự cần
đổi kiến trúc, phải có yêu cầu rõ ràng, decision record và migration plan trước
khi sửa mã.

## 2. Thành phần và quyền sở hữu

### 2.1. Planner

- `web/pages/sapxep.html`: cấu trúc trang, toolbar, modal và thứ tự asset.
- `web/pages/phanmon.js`: state planner, thao tác tay, worker lifecycle, progress,
  candidate validation, apply và persistence.
- `web/pages/phanmon.css`: layout planner.
- `web/pages/tkb-optimize-menu.js`: bốn lệnh tối ưu.
- `web/pages/tkb-constraints.js` và `tkb-constraints-menu.js`: ràng buộc và bộ
  kiểm tra độc lập.

Điểm vào canonical của xếp lịch là `executeDirectFastSchedule()`. Tên hàm là di
sản giao diện nhưng bên trong chỉ chọn engine FET trực tiếp hoặc Web Worker FET.
Không tạo điểm vào song song.

### 2.2. Engine và worker

- `web/pages/tkb-fet-engine.js`: `FetTimetableEngine`, construction, metrics,
  structural floor và các operator tối ưu.
- `web/pages/tkb-fet-worker.js`: nạp engine bằng `importScripts`, quản lý seed,
  worker con, tiến trình, checkpoint và stop.

Worker nhận `{action, mode, data, options}` và trả các message progress/done/error.
Planner không tin tuyệt đối kết quả worker: trước khi áp phải gọi cổng kiểm định
FET trong `phanmon.js` và validator ràng buộc giao diện.

Không tạo bản mirror ở `web/` gốc. Nếu đổi cache marker, đổi các trang đang nạp
asset và test contract cùng lúc.

### 2.3. Auth và lưu dữ liệu

- `web/shared/auth-api.js`: lời gọi auth/session/registry.
- `web/shared/auth.js`: logic tài khoản, trường, gói, OTP và school metadata.
- `web/shared/storage.js`: `/api/school/store`, xử lý hết session và lưu JSON.
- `web/shared/runtime.js`: health pill và điều phối hết session.
- `rust_api/src/auth.rs`: hash mật khẩu, session server-side, registry scope.
- `rust_api/src/db.rs`: KV SQLite thread-safe.
- `rust_api/src/main.rs`: HTTP parser/router/static server.

Máy chủ chỉ chấp nhận `sid` hợp lệ và kiểm tra session có quyền với trường chứa
`sid` đó. Super Admin thấy toàn registry; tài khoản trường chỉ thấy trường và
user cùng `schoolId`. Không trả hash mật khẩu/OTP cho browser.

### 2.4. Export

`tkb-export.js`, `tkb-word-export.js` và `tkb-student-excel-export.js` tạo file
trong browser. Chúng dùng File System Access API khi có, nếu không thì tải Blob.
Không thêm tuyến server để ghi vào thư mục Documents.

### 2.5. Mail tùy chọn

`mail-server/` chỉ gửi OTP qua Gmail. `start.py` không cài, build hay khởi động
dịch vụ này. Khi mail không cấu hình, giao diện có chế độ demo OTP hiện tại.
Mail không được ghép vào worker hoặc Rust scheduler vì không có scheduler server.

## 3. Khởi động cục bộ

### 3.1. Cấu hình

```powershell
Copy-Item .env.example .env
```

Đặt `TKB_SUPER_PASSWORD`. Mặc định:

- host `127.0.0.1`;
- port `1010`;
- DB `rust_api/tkb_store.db`.

### 3.2. Chạy

```powershell
python .\start.py
```

Trên Windows x64, launcher ưu tiên release/debug local còn mới, sau đó dùng:

`rust_api/prebuilt/windows-x64/tkb_rust_api.exe`

Manifest đi kèm phải khớp SHA-256 của binary và dấu vân tay đã chuẩn hóa LF của
`rust_api/src/`, `Cargo.toml`, `Cargo.lock`. Vì vậy người dùng cuối chỉ cần
Python. Nếu lập trình viên sửa nguồn Rust khiến manifest không còn khớp, launcher
mới chạy:

```powershell
cargo build --release --locked --manifest-path rust_api\Cargo.toml
```

Sau health thành công, mở `http://127.0.0.1:1010/`. Dùng
`--foreground --no-browser` khi cần log hoặc test tự động.

### 3.3. Dừng và dọn artifact

Đóng launcher hoặc Ctrl+C. Dọn build, cache và tệp tạm có xác nhận:

```powershell
.\tools\cleanup-generated-artifacts.ps1 -WhatIf
.\tools\cleanup-generated-artifacts.ps1
```

Script không chọn `.env`, `.git` hoặc database.

## 4. Hợp đồng chất lượng và an toàn lịch

Một candidate chỉ được áp khi:

- dữ liệu TKB là object hợp lệ;
- số tiết không giảm và construction không còn activity chưa xếp;
- fixed/OFF không bị thay;
- lớp, giáo viên và phòng không trùng;
- ràng buộc đang bật qua validator;
- với tối ưu, metric qua comparator của mode và không xấu hơn incumbent.

Các vi phạm legacy: planner chụp chữ ký baseline. Candidate có thể giữ đúng số
lần xuất hiện của chữ ký cũ, nhưng đổi một vi phạm cũ thành loại mới vẫn bị coi
là regression.

Metric chính:

- `unplacedCount`: tiết chưa xếp;
- `soBuoiDay1`: buổi giáo viên chỉ có một tiết;
- `soBuoiTrong2`: buổi có từ hai lỗ trở lên;
- `tsBuoiDay`: tổng buổi dạy;
- `soBuoiTrong1`: buổi có một lỗ;
- `tsNgayDay`: tổng ngày dạy.

Worker và planner phải thống nhất metric, floor, `targetReached` và checkpoint.
Không biến plateau/timeout thành “đã đạt mục tiêu”.

## 5. API contract

| Method | Path | Quyền | Mục đích |
| --- | --- | --- | --- |
| GET | `/api/health` | Công khai | Identity/capabilities |
| GET | `/api/version` | Công khai | Phiên bản |
| POST | `/api/auth/login` | Công khai, rate-limited | Tạo session |
| POST | `/api/auth/logout` | Bearer | Thu hồi session |
| POST | `/api/auth/register` | Công khai, kiểm tra IP | Tạo trường |
| POST | `/api/auth/hash-password` | Theo auth policy | Hash cho thao tác quản trị |
| GET | `/api/auth/session` | Token | Kiểm tra/khôi phục session |
| GET/POST | `/api/auth/registry` | Bearer + role scope | Quản lý registry |
| GET/POST | `/api/school/store?id=...` | Bearer + school scope | JSON TKB |

Mọi endpoint khác dưới `/api/` trả 404. Không mở endpoint tính lịch.

## 6. Kiểm thử trước khi bàn giao

Chạy tối thiểu:

```powershell
$node = "node"
Get-ChildItem web,e2e_tests,tools\benchmarks -Recurse -Filter *.js |
  ForEach-Object { & $node --check $_.FullName }
& $node --test (Get-ChildItem e2e_tests -Filter *.test.js).FullName
python -m unittest discover -s tests -p "test_*.py"
cargo check --locked --manifest-path rust_api\Cargo.toml
cargo test --locked --manifest-path rust_api\Cargo.toml
git diff --check
```

Sau thay đổi HTTP/auth/store, chạy server trên cổng tạm và smoke:

- `/api/health` đúng identity;
- `/pages/sapxep.html` trả HTML;
- đăng nhập/session hoạt động;
- GET/POST school store đúng quyền;
- một path traversal và một route không tồn tại bị từ chối.

Sau thay đổi FET, thêm benchmark fixture ẩn danh hoặc focused test tái hiện lỗi.
Không dùng database/workbook thật làm test fixture.

## 7. CI

`.github/workflows/tests.yml` chạy:

1. syntax + Node tests FET/UI;
2. Python launcher tests;
3. mail-server tests;
4. Rust check/test.

`.github/workflows/security.yml` chạy secret scan, CodeQL JavaScript, npm audit và
Rust advisory/policy review. Dependabot chỉ theo dõi npm mail, Cargo và Actions.

## 8. Quy tắc thay đổi repo

- Dùng `rg` để tìm tham chiếu trước khi xóa/đổi tên.
- Không sửa/xóa `.env` và `tkb_store.db*` trong một đợt dọn mã.
- Không commit `target/`, cache, log, `scratch` hoặc `temp`.
- Cập nhật handoff sau thay đổi quan trọng; ghi lệnh và kết quả kiểm thử thật.
- Commit/push đều đặn nhưng không coi push là quyền triển khai.
- Việc triển khai không nằm trong repo hiện tại; chỉ làm khi người dùng yêu cầu
  riêng và cung cấp đích/quyền phù hợp.

## 9. Điểm dễ lỗi

1. **Asset cache cũ**: đổi JS quan trọng nhưng quên query marker có thể khiến các
   trang dùng phiên bản khác nhau.
2. **Session thay thế**: tài khoản thường chỉ có một session; request cũ phải
   nhận đúng `session_replaced` và redirect một lần.
3. **Registry merge**: school admin không được xóa/ghi user trường khác hoặc làm
   mất password hash do payload client đã được strip.
4. **Apply sớm**: không gán candidate vào `DATA.tkb` trước khi kiểm định.
5. **Worker rò rỉ**: mọi nhánh done/error/timeout/stop phải terminate và giải
   phóng single-flight state.
6. **Dữ liệu nhạy cảm**: fixture trường thật, log chứa registry hoặc workbook
   giáo viên không được đưa vào Git.

## 10. Bàn giao một phiên làm việc

Mục handoff mới cần có:

- mục tiêu và phạm vi;
- quyết định kiến trúc/hợp đồng thay đổi;
- danh sách file/module quan trọng;
- migration hoặc cleanup đã làm;
- lệnh kiểm thử và số pass/fail;
- trạng thái commit/push;
- trạng thái triển khai rõ ràng;
- hạn chế hoặc việc còn mở.
