# FLASH SOLVER — NHẬT KÝ KỸ THUẬT & HƯỚNG DẪN BẢO TRÌ

## 1. Thông Tin Kiến Trúc & Quyết Định Thiết Kế

- **Động cơ**: Google OR-Tools CP-SAT (Constraint Programming Solver).
- **Mục tiêu ưu tiên**:
  1. `unassigned == 0` (Xếp đủ 100% số tiết, không rớt tiết nào).
  2. `soBuoiTrong2 == 0` (Triệt tiêu hoàn toàn các buổi có 2 tiết trống trên toàn bộ giáo viên).
  3. `soBuoiDay1 <= 3` (Triệt tiêu buổi 1 tiết, chỉ chấp nhận các trường hợp bất khả kháng do phân công chuyên môn).
  4. Môn 2 tiết trong buổi bắt buộc phải liền nhau ($|p_0 - p_1| = 1$).
  5. 0 vi phạm quy định nghỉ của giáo viên và học sinh.
  6. 0 vi phạm trùng tiết (Zero teacher collisions).

---

## 2. Các Cải Tiến Kỹ Thuật Đột Phá

1. **Khử Nghẽn Số Slot Thực Tế (Pigeonhole Constraint)**:
   - Sáng Thứ 2 chỉ có 3 slot mở (Tiết 3, 4, 5) do Tiết 1, 2 là Chào cờ & HĐTN.
   - Tầng 1 tính toán chính xác `open_p_for_gv` dựa trên số slot mở thực tế của các lớp mà giáo viên giảng dạy, ngăn chặn việc gán quá 3 tiết vào buổi này.
2. **Khóa Cứng Môn 2 Tiết**:
   - Ở Tầng 2, các cặp tiết con của môn 2 tiết được ràng buộc đẳng thức `placed_vars[i0] == placed_vars[i1]`, không cho phép bộ giải xé lẻ thành các tiết đơn lẻ.
3. **Phân Tách Khóa Chuẩn Hóa Môn Độc Lập**:
   - Tách riêng `hdtn1`, `hdtn2` (cố định) và `hdtn3` (tiết dạy động của GV bộ môn), bảo toàn 100% ràng buộc `p_teacher_slot <= 1`.
4. **Khai Thác Tối Đa vCPU**:
   - Hệ thống tự động phát hiện số lõi CPU (`os.cpu_count()`) và phân bổ worker pool tối đa để giải song song 12 buổi học trong vòng 12–30 giây.

---

## 3. Nhật Ký Kiểm Thử Thực Tế (E2E Real Browser Test Suite)

- **Test 1 — Baseline Solve**: 2,175 / 2,175 tiết (100%), `soBuoiTrong2 = 0`, `soBuoiDay1 = 3` (PASS trong ~14.6s).
- **Test 2 — Teacher Off Rules**: 0 vi phạm (PASS).
- **Test 3 — Class Off Rules**: 0 vi phạm (PASS).
- **Test 4 — Consecutive Blocks**: 100% môn 2 tiết liền nhau (PASS).
- **Test 5 — Fixed Cells Integrity**: 151 ô fixed bảo toàn 100% (PASS).
- **Test 6 — High-Load Teachers**: 129 GV có `soBuoiTrong2 = 0` (PASS).
- **Test 7 — Rust API Contract**: Phản hồi HTTP 200 đầy đủ metrics (PASS).
- **Test 8 — Zero Teacher Clash**: 129 GV có 0 trùng tiết (PASS).
