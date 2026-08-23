# Regression checklist — TKBCherry Web FET

Dùng checklist này trước khi bàn giao thay đổi đáng kể. Đánh dấu theo kết quả
thực tế; không chép số pass từ phiên cũ.

## 1. Cổng kiến trúc

- [ ] Planner nạp `tkb-fet-engine.js` và tạo `tkb-fet-worker.js`.
- [ ] Planner không gọi endpoint tính lịch.
- [ ] Rust health báo `architecture=browser-only`, `engine=fet-web-worker`.
- [ ] Capabilities chỉ gồm static web, auth và school store.
- [ ] Repo không có runtime Python solver, bridge/mirror engine hay script hạ tầng
  của kiến trúc đã nghỉ.
- [ ] `.env.example` không có biến compute/scheduler.
- [ ] Manifest của backend Windows khớp nguồn Rust và SHA-256 binary.

## 2. Tự động

```powershell
Get-ChildItem web,e2e_tests,tools\benchmarks -Recurse -Filter *.js |
  ForEach-Object { node --check $_.FullName }
node --test (Get-ChildItem e2e_tests -Filter *.test.js).FullName
python -m unittest discover -s tests -p "test_*.py"
cargo check --locked --manifest-path rust_api\Cargo.toml
cargo test --locked --manifest-path rust_api\Cargo.toml
git diff --check
```

- [ ] JavaScript syntax pass.
- [ ] Toàn bộ Node test pass.
- [ ] Launcher test pass.
- [ ] Trên Windows không có Cargo, `python start.py` vẫn dùng bản đóng gói.
- [ ] Rust check/test pass.
- [ ] `git diff --check` sạch.
- [ ] Nếu sửa mail: `npm ci && npm test` trong `mail-server/` pass.

## 3. Smoke máy chủ cục bộ

Chạy ở cổng tạm để không ảnh hưởng phiên đang dùng:

```powershell
python .\start.py --foreground --no-browser --no-launcher --port 1011
```

- [ ] `/api/health` trả 200 và đúng identity.
- [ ] `/`, `/app`, `/pages/sapxep.html` trả đúng HTML.
- [ ] Static JS/CSS/WASM có content type đúng.
- [ ] Path traversal và route API không tồn tại bị từ chối.
- [ ] Login tạo Bearer session; session sai/hết hạn trả 401.
- [ ] Registry client không chứa password hash hoặc OTP.
- [ ] School admin chỉ đọc/ghi `sid` của trường mình; trường khác trả 403.
- [ ] POST rồi GET `/api/school/store` giữ nguyên JSON.
- [ ] Dừng process giải phóng cổng.

## 4. Dữ liệu và đăng nhập

- [ ] F5 giữ session hợp lệ và tải đúng trường/TKB.
- [ ] Login mới của tài khoản thường thay session cũ đúng một lần.
- [ ] Logout thu hồi session server rồi xóa storage trình duyệt.
- [ ] Super Admin thấy mọi trường; admin trường không thấy tenant khác.
- [ ] Đổi tên trường không đổi `sid` của các TKB.
- [ ] Copy/xóa TKB thất bại không làm metadata và dữ liệu lệch nhau.
- [ ] `.env` và `tkb_store.db*` không xuất hiện trong Git status.

## 5. Xếp mới bằng FET

- [ ] Một lần bấm Xếp chỉ tạo một worker chính; bấm chồng nhận trạng thái bận.
- [ ] Xếp gửi `action=construct` / `mode=solve_fast`, không gọi optimizer.
- [ ] Alias `solve_optimize_all` cũ cũng kết thúc sau construction, không có
  budget 600 giây.
- [ ] Profile mặc định dừng ở complete-valid đầu tiên trong tổng 12 giây và tối
  đa ba seed; preflight bất khả thi dừng ngay.
- [ ] Tiến trình cập nhật nhưng UI, Dừng và cuộn vẫn phản hồi.
- [ ] Kết quả đủ nhu cầu PCCM và `unplacedCount=0` trước khi áp.
- [ ] Không trùng lớp, giáo viên, phòng.
- [ ] Ô fixed/OFF và tiết đôi được bảo toàn.
- [ ] Ràng buộc lớp/môn/giáo viên/phòng đang bật đều qua validator.
- [ ] Candidate lỗi giữ lịch hiện tại và hiển thị lý do.
- [ ] Sau apply, tải lại trang vẫn thấy đúng lịch vừa lưu.

## 6. Tối ưu và Dừng

Kiểm tra lần lượt **1 tiết/buổi**, **Buổi**, **2 tiết trống**,
**1 tiết trống**:

- [ ] Mỗi mode chỉ chạy khi lịch đã complete; lịch thiếu hướng người dùng bấm
  Xếp trước.
- [ ] Budget mặc định lần lượt là 12/8/8/8 giây và engine dừng sớm ở
  zero/floor/plateau.
- [ ] Metric mục tiêu không bị báo đạt khi chỉ timeout/plateau.
- [ ] Comparator mode không nhận candidate xấu hơn incumbent.
- [ ] Tối ưu không thêm chữ ký vi phạm mới so với lịch legacy.
- [ ] Dừng giữ checkpoint hợp lệ tốt nhất và terminate worker.
- [ ] Chạy lại sau Dừng/timeout tạo worker mới bình thường.
- [ ] Structural floor dương chỉ được báo khi metric bằng floor đã chứng minh.
- [ ] Xóa lịch trong lúc worker cũ kết thúc không bị kết quả cũ ghi đè.

## 7. Chỉnh tay, thống kê và xuất file

- [ ] Kéo/thả, click ô, fixed/OFF, undo/redo và xóa lịch hoạt động.
- [ ] Bảng lớp/giáo viên và thống kê cập nhật sau worker apply.
- [ ] Thống kê dùng cùng định nghĩa singleton/Gap1/Gap2 với engine.
- [ ] Excel lớp, Excel học sinh và Word tải được bằng browser fallback.
- [ ] Export không gọi API ghi file phía máy chủ.

## 8. Responsive/PWA

- [ ] Planner dùng được ở 360 px và 899 px; toolbar không che menu/thống kê.
- [ ] Super Admin card hóa bảng trường; thao tác nguy hiểm vẫn nằm trong overflow.
- [ ] Nút có `title`/`aria-label`; vùng chạm mobile tối thiểu 44 px.
- [ ] Manifest/icon tải được và F5 không nạp asset kiến trúc cũ.

## 9. Dọn repo và bàn giao

- [ ] Không còn `.codex_tmp`, `scratch`, `temp`, build cache hay log được
  theo dõi trong commit.
- [ ] Không có workbook/database/dump dữ liệu thật trong diff.
- [ ] `README.md`, `docs/CURRENT_STATE.md`,
  `PROJECT_INHERITANCE_GUIDE.md` khớp code/config.
- [ ] `docs/PROJECT_HANDOFF.md` ghi đủ thay đổi, test, commit/push và việc còn mở.
- [ ] Commit đã push lên `origin`.
- [ ] Xác nhận rõ: **không triển khai** trong phiên này.
