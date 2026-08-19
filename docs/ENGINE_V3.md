# Engine v3 — Bộ máy xếp TKB một nút (2026-08-18)

## Tóm tắt

Toàn bộ thuật toán xếp cũ (session CP-SAT → period MILP → LNS, nhiều mode) được thay bằng **một engine mới thuần Python**: `solver_runtime/src/tkb_engine_v3/`. Không phụ thuộc OR-Tools, chạy y hệt nhau trên local (`start.py`), VPS và Cloud Run. Một nút **Sắp xếp** duy nhất; các nút Tối ưu / NEW ★ / Trọn gói ★ đã gỡ khỏi UI (`web/pages/sapxep.html`).

Ưu tiên chất lượng (lexicographic, đúng yêu cầu chủ dự án):

1. Xếp đủ 100% tiết, không vi phạm bất kỳ ràng buộc cứng/app nào (rule nghỉ, ô OFF, giới hạn…)
2. `0` buổi giáo viên 1 tiết *(hoặc bằng sàn cấu trúc có chứng cứ — xem Floors)*
3. `0` buổi trống ≥ 2 tiết *(hoặc sàn)*
4. Ít tổng buổi dạy nhất
5. Ít buổi trống 1 tiết nhất; tie-break: ít ngày dạy

**Mọi "Giới hạn" trong dữ liệu người dùng là CẬN TRÊN (≤), không bao giờ là bắt buộc.**

## Kiến trúc

```
entry.solve_from_ui_data_v3(ui_data, settings, progress)
  ├─ dùng lại adapter: build_school_data_from_ui / _trim_context_to_available_slots
  │  / fixed-lesson helpers / build_payload / validate.py  (giữ nguyên hợp đồng payload)
  ├─ compile.core:  Problem = mảng phẳng (lớp×60 slot, mask khả dụng, rule đã biên dịch)
  └─ portfolio đa seed (multiprocessing; fallback tuần tự) → Constructor.solve():
       Phase 1  Lát kín từng lớp (DFS ngẫu nhiên, ràng buộc phía lớp, GV chật được
                pre-match trước theo slot rảnh của chính họ)               ~0.2s
       Phase 2  Min-conflicts tabu-walk khử trùng giờ GV; đòn kết liễu:
                relabel cycles (vòng đẩy khép kín trong lớp), dig theo hàng slot
                của GV (cuộn xung đột tới slot trống), Kempe 2-slot, augment DFS,
                exact re-tile cụm lớp                                      ~0-10s
       Phase 3  Tabu-walk chất lượng theo trọng số lexicographic
                (singleton 1e11, gap2 1e8, buổi 1e5, gap1 10, ngày 1):
                mọi nước đi là hoán vị run trong lớp + đa-run (đôi↔2 đơn)
                + vòng đẩy + Kempe; sàn cấu trúc được loại khỏi mục tiêu    phần còn lại
  └─ nạp vào State (kiểm tra cứng đầy đủ) → build_payload → metrics/validation như cũ
```

- `state.py` — State cứng: mọi `apply()` tự kiểm tra TOÀN BỘ ràng buộc (lớp, GV, timeLimit) và rollback nếu vi phạm ⇒ kết quả không bao giờ phạm luật.
- `checks.py` — bộ kiểm tra phía lớp dùng chung cho cả trạng thái mềm lẫn cứng (đồng bộ 1-1 với `validate.py`).
- Ô `fixed` chỉ bị KHÓA khi bridge gửi `preserve_fixed_lessons_only` / `__tkbRequestFixedScheduleOnly` (đúng hợp đồng cũ). Khi khóa, phần thiếu hụt bất khả kháng được trim quy về `Chưa phân — not_enough_available_slots` (best-effort 200 như cũ).

## Floors (chứng chỉ sàn)

`Constructor.structural_floors()` chứng minh cận dưới: GV chỉ còn 1 ô khả dụng trong một buổi mà tổng ô rảnh vừa khít tải ⇒ buổi 1 tiết bắt buộc; GV phải dùng hết ô khả dụng của một buổi bị ngắt quãng ⇒ trống ≥2 bắt buộc. Kết quả nằm trong `payload.solver.engine_v3.floors` (kèm evidence) để UI có thể giải thích "còn X do ràng buộc của thầy/cô Y".

## Kết quả đo (sandbox 2 vCPU — máy thật nhiều nhân sẽ tốt hơn)

| Bộ dữ liệu | Cũ (production log) | Engine v3 |
|---|---|---|
| Trường mặc định 2103 tiết, không khóa ô fixed (60s) | 2103/2103, hard_ok | 2103/2103, hard_ok, **1 tiết = 4 (sàn 1), trống ≥2 = 0**, buổi 785, trống1 201 |
| Cùng trường, khóa 360 ô fixed (150s) | 2099/2103 (4 chưa phân), 1 tiết 3, **trống ≥2 = 89**, buổi 781 | 2099/2103 (4 chưa phân — cùng chứng cứ), 1 tiết 6, **trống ≥2 = 9**, buổi 748 |
| Trường nhỏ 627 tiết (40s) | — | 627/627, **1 tiết = 0, trống ≥2 = 0**, buổi 214 |

Baseline export thật của thuật toán cũ (docs/OPTIMIZER_V2_PLAN.md): 68 buổi 1 tiết / 49 buổi trống ≥2 / 153 trống 1 / 735 buổi.

## Cách chạy / kiểm tra

```bash
# benchmark trực tiếp trên request log thật
python solver_runtime/scripts/bench_v3.py solver_runtime/logs/<request>.json 120 6

# ép dùng engine cũ khi cần đối chiếu
TKB_ENGINE=legacy python solver_runtime/scripts/solve_stdio.py solve < request.json
```

`solve_stdio.py` mặc định dùng engine v3; nếu engine v3 văng exception bất ngờ thì tự rơi về pipeline cũ (cờ `engine_v3_fallback` trong runtime_settings) — nút Sắp xếp không bao giờ chết.

## Chưa làm / ghi chú

- `optimize.py` (bộ tối ưu State-based đời đầu của v3) không còn nằm trên đường chạy chính — phase 3 trên SoftSchedule nhanh hơn ~10×.
- E2E tests về toolbar planner (menu Tối ưu, NEW ★, Trọn gói ★) cần cập nhật vì các nút đã gỡ.
- Deploy VPS/Cloud Run CHƯA thực hiện — mới chạy local theo yêu cầu.
