# Solver V2 — kế hoạch và hợp đồng xếp TKB

Cập nhật 2026-08-18 (Asia/Bangkok). Đây là kế hoạch thay thế đường xếp TKB,
không phải kế hoạch thay đổi dữ liệu người dùng. Trong giai đoạn này chưa có
Cloud Run/VPS/production deployment nào.

## Quyết định kiến trúc

- Trình duyệt chỉ gửi một request và nhận tiến độ/kết quả. FET Web Worker,
  các vòng `optimize_*`, `NEW` và `Trọn gói` không còn là đường chạy của nút
  Sắp xếp.
- Solver V2 dùng một mô hình CP-SAT tích hợp trên Python/OR-Tools. Mô hình
  dùng biến mẫu khối tiết hợp lệ cho từng phân công và mẫu tải buổi của từng
  giáo viên; local search/FET không được dùng để chứng minh chất lượng.
- Các lời giải tối ưu được chứng minh theo hai pha:
  1. hard constraints + đủ toàn bộ tiết + không buổi một tiết + không Gap2+;
  2. chứng minh tổng số buổi giáo viên nhỏ nhất, khóa giá trị đó, rồi chứng
     minh số Gap1 nhỏ nhất.
- Nếu CP-SAT chỉ trả `FEASIBLE`/`UNKNOWN`, hoặc validator độc lập không khớp,
  hệ thống không áp ứng viên. Lịch cũ được giữ nguyên.

## Hợp đồng rule

- `fixedOff` của lớp, giáo viên, môn, nhóm môn và phòng là hard constraint.
- Xung đột lớp/giáo viên/phòng, đủ định mức phân công, block liên tục,
  `mustTeach`, giới hạn sáng/chiều/ngày/buổi, một buổi/ngày, nhóm môn và giới
  hạn thời điểm đều được kiểm tra trong mô hình và revalidate sau solve.
- Mọi trường có tên “Giới hạn”, `Max`, `maxDays`, `maxSessions`, `maxPeriods`
  là cận trên: `thực tế <= giá trị`; không có mục tiêu phải chạm đúng giá trị.
- `lessonBlocks.Min` và `mustTeach` là yêu cầu dưới/điểm neo do người dùng
  khai báo, không bị tự hạ. Nếu chúng mâu thuẫn với tiết nghỉ/cố định, trả
  chẩn đoán vô nghiệm.
- Một buổi giáo viên được biểu diễn bằng tải 0 hoặc từ 2 tiết trở lên, với
  tổng lỗ trong span không quá một tiết. Vì vậy singleton và Gap2+ là 0 ngay
  trong mô hình; Gap1 chỉ là mục tiêu cuối.

## Chứng chỉ kết quả

Payload thành công phải có:

```json
{
  "solver": {
    "algorithm": "tkb_exact_v2_integrated_pattern_cp_sat",
    "certificate": {
      "sessions": {"value": 0, "status": "OPTIMAL", "best_bound": 0},
      "gap1": {"value": 0, "status": "OPTIMAL", "best_bound": 0},
      "singleton_sessions": 0,
      "gap2_plus_sessions": 0
    }
  }
}
```

`value == best_bound` và `status == OPTIMAL` là điều kiện bắt buộc để gọi là
tối ưu. Trường hợp không khả thi phải trả `exact_v2_no_solution` với mã
nguyên nhân; không được trả best-effort dưới dạng thành công.

## Lộ trình kiểm thử trước deploy

1. Unit/contract: canonicalization, cận trên, fixedOff, block/min, mustTeach,
   singleton/Gap2 hard, lexicographic certificates.
2. Oracle nhỏ: so sánh CP-SAT với vét cạn trên các trường 1–4 lớp; kiểm tra
   mọi nghiệm công bố đều qua validator độc lập.
3. Fixture thật read-only: tối thiểu 1.530, 2.103 và 2.193 tiết; chạy nhiều
   seed/worker count, ghi objective và best-bound, không ghi đè SQLite/user
   timetable.
4. Failure tests: rule nghỉ/cố định mâu thuẫn, giới hạn vượt, stale revision,
   duplicate click, restart backend, timeout, cancel và kết quả đến trễ.
5. Chỉ được canary khi mọi fixture thành công đủ tiết, hard-valid, singleton
   0, Gap2+ 0, objective sessions OPTIMAL và objective Gap1 OPTIMAL. Cloud Run
   phải được nâng timeout/CPU/memory theo benchmark; revision mới phải chạy
   tagged canary và rollback được trước khi nhận traffic.

## Trạng thái triển khai local

- Đã thêm `solver_runtime/src/tkb_exact_v2/` và route stdio
  `solver_algorithm=exact_v2`.
- Đã thêm test `solver_runtime/tests/test_exact_v2.py` (5/5 xanh).
- UI planner chỉ còn nút Sắp xếp và định tuyến sang V2; không deploy.
- Bước kế tiếp của phiên này: chạy `start.py`, smoke qua `/api/health` và
  request nhỏ; benchmark fixture lớn có thể cần nhiều phút để chứng minh
  `OPTIMAL`.
