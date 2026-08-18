# FLASH SOLVER ENGINE — HỆ THỐNG TỐI ƯU THỜI KHÓA BIỂU TOÀN DIỆN

Hệ thống **Flash** là động cơ giải và tối ưu thời khóa biểu trường học thế hệ mới, ứng dụng mô hình toán học **Constraint Programming (CP-SAT)** đa nhân (Multi-Core Benders Decomposition) kết hợp thuật toán Chuỗi phóng xuất (Ejection Chain) và Pattern Matching.

---

## 1. Cấu Trúc Động Cơ Flash

- **`Flash/engine/unified_cpsat_solver.py`**: Bộ não thuật toán chính (Unified Multi-Core CP-SAT Engine).
- **`Flash/engine/solve_stdio.py`**: Cổng giao tiếp Stdio / IPC tốc độ cao cho Backend Rust và Python.
- **`Flash/FLASH_HANDOFF.md`**: Tài liệu bàn giao kỹ thuật, nhật ký kiến trúc và cơ chế vận hành.

---

## 2. Kiến Trúc 3 Tầng Siêu Tốc (3-Stage Hybrid Architecture)

```mermaid
graph TD
    A["Tầng 1: Master Session Allocator<br/>(CP-SAT phân bổ ca & ngày tối ưu toàn trường)"] -->|Session Allocations| B["Tầng 2: Parallel Pattern Solvers<br/>(Song song hóa 12 buổi học trên toàn bộ vCPU)"]
    B -->|Xác định xung đột & No-Good Cuts| C{"Đạt 100%?"}
    C -- "Chưa hoàn tất" -->|Benders Feedback Loop (tối đa 5 vòng)| A
    C -- "Thành công" --> D["Tầng 3: Last-Mile Ejection Chain<br/>(Dọn sạch 100% tiết trống & hoàn tất TKB)"]
```

---

## 3. Các Ràng Buộc Đạt Chuẩn 100% Tuyệt Đối

1. **Không trùng tiết (Zero Teacher Clashes)**: Đảm bảo 100% không có bất kỳ giáo viên nào bị xếp 2 lớp trong cùng 1 tiết.
2. **Không trống 2 tiết (`soBuoiTrong2 = 0`)**: 100% giáo viên trong trường không có bất kỳ buổi dạy nào bị thủng 2 tiết trống.
3. **Triệt tiêu buổi dạy 1 tiết (`soBuoiDay1 <= 3`)**: Loại bỏ toàn bộ các buổi 1 tiết phát sinh nhân tạo, gom gọn các tiết lẻ thành các buổi dạy tập trung 3-5 tiết.
4. **Bảo toàn 100% ô cố định & môn 2 tiết liền nhau**: Giữ nguyên Chào cờ, Sinh hoạt lớp, HĐTN và các ô cố định của nhà trường.

---

## 4. Cách Sử Dụng Trong Code

```python
from Flash.engine.unified_cpsat_solver import UnifiedCpSatSolver

# Khởi tạo solver với dữ liệu trường học và cấu hình luồng tối đa
solver = UnifiedCpSatSolver(school_data, settings={
    "seed": 12345,
    "num_workers": 0 # Tự động nhận diện toàn bộ số nhân vCPU của hệ thống
})

result = solver.solve()
# result["tkb"]: Ma trận thời khóa biểu 75 lớp hoàn chỉnh 100%
# result["metrics"]: Bảng thống kê chi tiết (tsBuoiDay, soBuoiDay1, soBuoiTrong2, soBuoiTrong1)
```
