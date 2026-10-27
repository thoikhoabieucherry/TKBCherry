# Cherry trên máy này

Bộ giải Cherry (engine v3) chạy bằng CPU của máy đang mở trang Sắp xếp, thay cho máy chủ.
Dữ liệu trường vẫn lưu trên tkbcherry.com; máy này chỉ giải rồi trả kết quả cho trang.

## Cài một lần

1. Cài Python 3.10 trở lên từ python.org (khi cài nhớ tick **Add python.exe to PATH**).
2. Giải nén gói `cherry-may-nay.zip` vào một thư mục cố định (vd `C:\CherryMayNay`).

## Mỗi lần dùng

1. Mở `start-cherry-local.bat` (lần đầu sẽ tự cài thư viện ortools/numpy/scipy, cần mạng).
   Cửa sổ đen hiện "Sẵn sàng tại http://127.0.0.1:2210" là xong — để nguyên cửa sổ đó.
2. Trên trang Sắp xếp, bấm nút gạt cạnh nút Cherry để chuyển từ **Máy chủ** sang **Máy này**.
   Chrome có thể hỏi "cho phép truy cập thiết bị trong mạng cục bộ" — chọn Cho phép.
3. Bấm Cherry hoặc Tối ưu như bình thường.

Gạt về **Máy chủ** để giải trên máy chủ như cũ. Lựa chọn được nhớ theo trình duyệt.

## Ghi chú

- Máy càng nhiều nhân càng tốt; mặc định dùng `min(8, số nhân - 1)` luồng
  (`start-cherry-local.bat --workers 4` để giảm khi máy yếu hoặc ít RAM).
- Bộ giải chỉ nghe `127.0.0.1` và chỉ nhận lệnh từ trang tkbcherry.com.
- Nhật ký chạy ở thư mục `logs/` cạnh file này (không chứa dữ liệu trường).

## Cho người phát triển

- Chạy từ repo: `python tools/local-solver/cherry_local_solver.py` (dùng `solver_runtime/` của repo).
- Đóng gói: `python tools/local-solver/build_package.py` → `tools/local-solver/dist/cherry-may-nay.zip`.
- Test: `python -m unittest tools.tests.test_local_solver`.
