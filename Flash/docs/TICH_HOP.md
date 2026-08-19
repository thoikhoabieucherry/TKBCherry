# Tích hợp Cherry + Flash vào TKBCherry (19/08/2026)

## File đã thêm / sửa
| File | Việc |
|---|---|
| `solver_runtime/src/tkb_engine_v3/` *(mới, 8 file)* | Thuật toán **Cherry** (thuần Python): `entry.py`, `construct.py`, `core.py`, `state.py`, `checks.py`, `optimize.py`, `cpsat_modes.py` (vỏ gọi Flash), `__init__.py` |
| `solver_runtime/src/tkb_optimizer_ref/unified_cpsat_solver.py` *(mới)* | Thuật toán **Flash** (CP-SAT 2 tầng) — bê nguyên, chỉ thêm 2 hook rỗng |
| `solver_runtime/src/tkb_optimizer_ref/{external_cp_sat,period_milp,session_milp,external_milp}.py` | Bọc import OR-Tools/numpy/scipy → thiếu thư viện vẫn chạy được Cherry |
| `solver_runtime/scripts/solve_stdio.py` | Định tuyến `settings.engine`: `cherry`/`v3` → Cherry; `flash`/`cpsat` → Flash; **không đặt gì = giữ nguyên bộ giải cũ** |
| `web/pages/sapxep.html` | 2 nút 🍒 Cherry + ⚡ Flash (giữa *Tối ưu* và *Xóa*), nút hẹp lại, hàm `tkbRunEngine()` |
| `web/pages/tkb-rust-bridge.js` | Gửi `settings.engine` theo nút, nâng ngân sách ≥200s cho 2 lane này |
| `Cherry/`, `Flash/` | README thuật toán + thư mục `logs/` chứa marker mỗi lượt chạy |

## Nguyên tắc an toàn
- **Nút Sắp xếp ▶ và menu Tối ưu giữ nguyên hành vi cũ** (không gửi `engine`).
- Mỗi lane mới đều có `try/except` → lỗi thì rơi về bộ giải mặc định, ghi `cherry_fallback_reason` / `flash_fallback_reason` trong payload.
- Cả hai đều đi qua `build_payload` + `validate.py` như cũ nên hợp đồng dữ liệu/UI không đổi.

## Kiểm tra nhanh (không cần UI)
```bash
# Cherry (thuần Python)
PYTHONPATH=solver_runtime/src python solver_runtime/scripts/solve_stdio.py solve < request.json   # settings.engine="cherry"
# Flash (cần ortools)
TKB_ENGINE=flash PYTHONPATH=solver_runtime/src python solver_runtime/scripts/solve_stdio.py solve < request.json
```
`request.json` dạng `{"data": <ui_data>, "settings": {"engine": "cherry", "overall_time_limit_seconds": 200}}`.
Đã chạy thử trong repo này: **2175/2175, hard_ok, 0 vi phạm, 33s** (marker `Cherry/logs/cherry-last.json`).

## Cloud Run
`tools/cloud-run/Dockerfile` copy nguyên `solver_runtime/` nên **cả hai engine tự động có trong image**; `requirements.txt` đã có `ortools==9.15.6755` cho Flash. `cloud_run_service.py` truyền thẳng `settings` xuống `solve_stdio.py` ⇒ định tuyến engine hoạt động y hệt local.
Lệnh deploy (chạy trên máy có gcloud đã đăng nhập):
```powershell
pwsh tools/cloud-run/deploy.ps1 -ProjectId <project-id> -ConfirmDeployment
```

## VPS
`python tools/vps-deploy/deploy.py` (backup → upload → build → drain → health check). Không cần đổi cấu hình: chỉ cần môi trường Python của VPS đã cài `requirements.txt`.
