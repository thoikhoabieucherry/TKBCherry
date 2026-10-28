# Cherry trên máy này

Bộ giải Cherry (engine v3) chạy bằng CPU của máy đang mở trang Sắp xếp, thay cho máy chủ.
Dữ liệu trường vẫn lưu trên tkbcherry.com; máy này chỉ giải rồi trả kết quả cho trang.

## Cài một lần (khuyên dùng)

1. Nhấp đúp `Cherry.exe` (đã gói Python portable + OR-Tools, không cần cài Python, không cần quyền admin) → cửa sổ nhỏ "Đang khởi động Cherry…" hiện ngay (`installer/splash.ps1`), lên xong báo "Cherry đã chạy" rồi tự đóng; lần đầu / bản mới mất ~20 s giải nén, mở lại đúng bản đã cài (`build-id.txt`) thì chỉ bật bộ giải. Không có câu hỏi Yes/No.
   Không cần cài Python, không cần quyền admin. Windows SmartScreen có thể cảnh báo vì file
   chưa ký số: bấm **More info → Run anyway**.
2. Biểu tượng 🍒 hiện ở khay hệ thống (cạnh đồng hồ) kèm thông báo "Đã cài xong".
3. Từ đó bộ giải tự chạy ngầm mỗi khi bật máy, không có cửa sổ nào. Chuột phải biểu tượng 🍒:
   trạng thái, **Mở TKB Cherry**, **Thoát**.

Bản web không đăng nhập: chỉ có nút 🍒 Cherry (chấm xanh = bộ giải sẵn sàng). Bấm Cherry khi
bộ giải không chạy: trình duyệt từng thấy bộ giải → hộp **Bật bộ giải và xếp** (đánh thức qua
`cherry-local://`, Chrome hỏi "Mở Cherry máy này?" một lần — tick "Luôn cho phép"); chưa từng thấy
→ hộp **Tải về Cherry.exe**. Bản tkbcherry.com (có đăng nhập): nút gạt **Máy chủ / Máy này**.

Gỡ: **Settings → Apps → Installed apps → Cherry máy này → Uninstall**.

Cài vào `%LOCALAPPDATA%\CherryMayNay` (Python nhúng + ortools/numpy/scipy + bytecode bộ giải),
lối tắt `Cherry may nay` trong Startup và Start Menu, khoá `HKCU\Software\Classes\cherry-local`.

## Cách cũ: chạy bằng Python có sẵn

Cài Python 3.10+ (tick **Add python.exe to PATH**), giải nén `cherry-may-nay.zip`, mở
`start-cherry-local.bat` (lần đầu tự cài thư viện, cần mạng) và để nguyên cửa sổ đó.

## Ghi chú

- Cổng `2211` (cổng `2210` là của Cherry Local — bản chạy cả web trong máy).
- Máy càng nhiều nhân càng tốt; mặc định dùng `min(8, số nhân - 1)` luồng.
- Bộ giải chỉ nghe `127.0.0.1`, giữ cổng độc quyền (bản thứ hai tự thoát), chỉ nhận lệnh từ
  trang tkbcherry.com (và localhost).
- Nhật ký ở `logs/` cạnh `cherry_local_solver.py` (không chứa dữ liệu trường).

## Cho người phát triển

- Chạy từ repo: `python tools/local-solver/cherry_local_solver.py` (dùng `solver_runtime/` của repo).
- Bộ cài: `python tools/local-solver/build_installer.py --out <thư mục ĐƯỜNG DẪN NGẮN>` → `Cherry.exe`
  (cần mạng + Windows; thư mục build sâu quá 260 ký tự sẽ lỗi MAX_PATH).
- Gói zip (cách cũ): `python tools/local-solver/build_package.py` → `dist/cherry-may-nay.zip`.
- Test: `python -m unittest tests.test_local_solver`, `node --test e2e_tests/planner_solver_target_toggle_node.test.js`.
