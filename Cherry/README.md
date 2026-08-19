# Cherry — thuật toán xếp TKB thuần Python (engine v3)

**Mã nguồn:** `solver_runtime/src/tkb_engine_v3/`
**Nút trên UI:** 🍒 `btnEngineCherry` (giữa *Tối ưu* và ⚡ *Flash*)
**Kích hoạt:** UI gửi `settings.engine = "cherry"` (hoặc biến môi trường `TKB_ENGINE=cherry`).
**Không phụ thuộc:** thuần Python, KHÔNG cần OR-Tools — chạy y hệt trên local, VPS, Cloud Run.

## Mục tiêu (thứ tự ưu tiên, "Giới hạn là CẬN TRÊN")
1. Xếp đủ 100% số tiết, không vi phạm ràng buộc nào (rule nghỉ, ô OFF, tiết đôi, tránh tiết 2–3, giới hạn môn/buổi…)
2. `0` buổi dạy 1 tiết (hoặc bằng sàn cấu trúc có chứng cứ)
3. `0` buổi trống ≥ 2 tiết (hoặc sàn)
4. Ít tổng buổi dạy nhất
5. Ít buổi trống 1 tiết nhất; hoà thì ít ngày dạy nhất

## Kiến trúc
```
entry.solve_from_ui_data_v3(ui_data, settings, progress)
 ├─ dùng lại adapter (parse, capacity, fixed cells, build_payload, validate)
 ├─ core.compile_problem  → mảng phẳng (lớp × 60 slot, mask khả dụng, rule biên dịch)
 └─ portfolio đa seed (multiprocessing, fallback tuần tự):
      Phase 1  Lát kín từng lớp (DFS ngẫu nhiên + pre-match giáo viên chật)
      Phase 2  Min-conflicts khử trùng giờ GV (relabel cycle, dig, Kempe, re-tile cụm)
      Phase 3  Tabu chất lượng lexicographic (1e11 singleton / 1e8 gap2 / 1e5 buổi / 10 gap1)
               + relax-escape khi bí + dừng sớm khi hết cải thiện
```
- **Warm-start:** nếu đã có lịch (kể cả mới đủ ≥80%), engine dùng làm điểm xuất phát và **sửa cục bộ** từng lớp hỏng → bấm lại không bao giờ xấu đi.
- **Chưa phân có chứng cứ:** tiết nào chứng minh được là không còn ô hợp lệ (matching Kuhn) sẽ vào *Chưa phân* kèm lý do, phần còn lại vẫn tối ưu.

## Log / theo dõi
Mỗi lượt ghi `Cherry/logs/cherry-last.json`:
```json
{ "engine": "tkb-engine-v3", "finished_at": "...", "elapsed_seconds": 52.5,
  "expected": 2175, "placed": 2175,
  "objective_singleton_gap2_sessions_gap1_days": [2, 0, 688, 210, 583],
  "warm_start": true, "warm_hint": {"cells": 2175},
  "floors": {"one_period_floor": 0, "gap2_floor": 0, "evidence": []},
  "workers": 5, "portfolio": [...], "capacity_unassigned": 0 }
```
Đọc `objective` theo thứ tự: **[buổi 1 tiết, trống ≥2, tổng buổi, trống 1 tiết, ngày dạy]**.

## Chạy tay để đối chiếu
```bash
TKB_ENGINE=cherry python solver_runtime/scripts/solve_stdio.py solve < request.json
```
