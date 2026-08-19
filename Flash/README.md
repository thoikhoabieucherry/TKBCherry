# Flash — thuật toán xếp TKB bằng CP-SAT 2 tầng

**Mã nguồn:** `solver_runtime/src/tkb_optimizer_ref/unified_cpsat_solver.py` (bê nguyên từ dự án TKBCherryAnti)
**Vỏ tích hợp:** `solver_runtime/src/tkb_engine_v3/cpsat_modes.py` → `solve_unified_cpsat()`
**Nút trên UI:** ⚡ `btnEngineFlash` (giữa 🍒 *Cherry* và 🗑️ *Xóa*)
**Kích hoạt:** `settings.engine = "flash"` (hoặc `TKB_ENGINE=flash`).
**Phụ thuộc:** cần **OR-Tools** (`ortools`) — phải có trong image Cloud Run / môi trường VPS.

## Cách hoạt động (Benders 2 tầng + no-good cut, tối đa 5 vòng)
- **Tầng 1 — Session Master (CP-SAT):** phân bổ (lớp, môn) vào 12 buổi. Hàm mục tiêu
  `Minimize(1e7 × số buổi-1-tiết + 1e3 × tổng buổi dạy)` → tối ưu tổng buổi **toàn cục**.
- **Tầng 2 — Pattern theo buổi:** sinh sẵn mọi dải tiết trong 1 buổi 5 tiết có **tổng trống ≤ 1**
  ⇒ *trống ≥2 tiết = 0 do cấu tạo*; trong mỗi buổi tối thiểu hoá số trống 1 tiết.
- Buổi nào bất khả thi → gửi **no-good cut** ngược lên Tầng 1 rồi lặp lại.

## Điểm mạnh / điểm yếu (đo trên trường 2175 tiết)
| | Flash | Cherry |
|---|---|---|
| Tổng buổi dạy | **578–585** | ~689 |
| Trống 1 tiết | **76–82** | ~200 |
| Buổi 1 tiết / trống ≥2 | 1 / 0 | 2 / 0 |
| Thời gian | **25–71s** | 52–264s |
| Ràng buộc tiết đôi (`lessonBlocks`) + tránh tiết 2–3 | **KHÔNG hỗ trợ** | Đầy đủ |

⚠️ Vì Flash không đọc `lessonBlocks` / `avoidBreakPair23` / rule giáo viên nâng cao, lịch của nó có thể
vi phạm quy định của trường. Khi payload bị đánh dấu vi phạm, vỏ tích hợp sẽ **giao lại cho Cherry hoàn tất
một lịch hợp lệ**, và vẫn ghi số liệu gốc của Flash để đối chiếu.

## Log / theo dõi
Mỗi lượt ghi `Flash/logs/flash-last.json`:
```json
{ "engine": "tkb-flash-cpsat", "finished_at": "...", "elapsed_seconds": 26.8,
  "expected": 2175, "placed": 2175,
  "raw": { "tsBuoiDay": 585, "soBuoiDay1": 1, "soBuoiTrong2": 0, "soBuoiTrong1": 82, "iterations": 2 } }
```
Log tiến trình chi tiết theo thời gian thực: `temp/solver_live.log` (dòng `[Bộ giải TKB]`).

## Chạy tay để đối chiếu
```bash
TKB_ENGINE=flash python solver_runtime/scripts/solve_stdio.py solve < request.json
```
