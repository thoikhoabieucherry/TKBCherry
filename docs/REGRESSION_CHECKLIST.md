# Regression checklist (manual)

Run after significant changes. Start app with `python start.py`, open `http://127.0.0.1:1010/`.

## Admin (`index.html`)

- [ ] Load page without CDN (offline): Excel libs from `web/vendor/`
- [ ] Import Excel: Lớp, Giáo viên, Môn, Tiết chuẩn
- [ ] PCCM matrix loads and saves
- [ ] School switcher: create/switch school, data isolated
- [ ] Open planner via **Sắp xếp TKB**

## Planner (`pages/sapxep.html`)

- [ ] Backend banner hidden when `start.py` is running
- [ ] Backend banner visible when server stopped
- [ ] Chỉ có một nút **Sắp xếp**; không còn dropdown/nút Nhanh, Max hoặc preset lưu từ phiên cũ
- [ ] Lịch trống/thiếu nhiều chọn `fresh_complete_first`: xếp đủ nhu cầu trước rồi mới tối ưu
- [ ] Lịch chỉ thiếu ít tiết chọn `repair_partial`: điền phần thiếu, có thể dời tiết không khóa và không dựng lại toàn bộ vô cớ
- [ ] Lịch đã đủ và hard-valid chọn `refine_complete` ngay khi người dùng bấm: dùng incumbent mềm và chất lượng không xấu hơn lịch đầu vào
- [ ] Sau khi đổi PCCM, incumbent được dựng lại giáo viên theo PCCM mới; không khôi phục tiết mang giáo viên/phân công cũ
- [ ] Chỉ tiết có `fixed: true` giữ nguyên vị trí; các tiết hiện có khác vẫn có thể swap/dời
- [ ] Nút **Dừng** hiện giữa **Sắp xếp** và **Xóa ALL** khi đang xếp; hủy được cả lượt đang chạy lẫn đang chờ mà không ảnh hưởng trường khác
- [ ] Khi server đầy slot/token, UI âm thầm chờ FIFO và thử lại; không hiện lỗi đỏ hoặc để lượt sau vượt lượt trước
- [ ] Trường thời lượng trống dùng `60s` cho lịch mới/đổi yêu cầu và `180s` cho lịch đầy đủ cần tối ưu tiếp; có thể dừng sớm khi bão hòa, không tự điền ô thời gian và không tự tạo lượt retry
- [ ] Thời lượng do người dùng nhập luôn thắng mặc định ẩn; một lần bấm tạo đúng một canonical job
- [ ] Khi tải trang, tiến trình mặc định ẩn. Sau khi dữ liệu/auth sẵn sàng, trang hỏi `/api/solver-state` đúng một lần; có job thì nối lại đúng `jobId`, không có job thì giữ trạng thái nghỉ và không polling ngầm
- [ ] F5, đổi tab, khóa màn hình hoặc đưa PWA iPhone xuống nền không hủy job VPS; khi quay lại chỉ GET state/result, không POST solve thứ hai
- [ ] Hai thiết bị/tab cùng tài khoản và cùng `sid` chỉ có một canonical job; thiết bị đến sau xem cùng tiến trình và có thể gửi Dừng cho job đó
- [ ] Đổi yêu cầu không tự chạy và không xóa lịch ngay. Khi người dùng bấm xếp, giữ snapshot, thử sửa nhẹ rồi tối đa một fresh fallback; thất bại phải khôi phục nguyên lịch trước khi bấm
- [ ] **Xóa ALL** shows confirm with school name + class count
- [ ] Undo / Redo after manual edit
- [ ] Constraints menu (**Yêu cầu**) opens
- [ ] Export: class XLSX, class DOCX, school exports
- [ ] **Home** saves and returns to admin

## API

- [ ] `GET /api/health` returns `ok: true`, `api: rust`
- [ ] `POST /api/auth/login` with valid credentials returns `sessionToken` (password not verified client-side)
- [ ] `GET /api/auth/registry` does **not** expose `passwordHash` fields
- [ ] Local: `GET /api/solver-state` returns `maxConcurrent`, `activeJobs`, `queuedJobs` và worker-token counters
- [ ] VPS với `TKB_SOLVER_REQUIRE_AUTH=1`: năm solver endpoint trả `401` khi thiếu/sai Bearer
- [ ] Bearer hợp lệ gọi được `POST /api/solve-precheck` và `POST /api/solve-data` với `solver_mode: auto`
- [ ] CORS preflight cho phép header `Authorization`
- [ ] Tài khoản/trường B không xem hoặc hủy được job active/queued của tài khoản/trường A
- [ ] Khi pool đầy, `/api/solve-data` trả `202`, `kind: solver_queued`, `queuePosition` và `retryAfterMs`
- [ ] Mười lượt chờ được nhận theo FIFO, không starvation; vé stale không chặn queue vô hạn
- [ ] Job server-owned tự heartbeat/acquire khi queued, không cần browser POST lại; duplicate POST cùng ID không tạo worker thứ hai
- [ ] F5, `visibilitychange`, `pageshow` và mobile sleep nối lại qua `/api/solve-result`; AbortError/network timeout không gửi cancel
- [ ] Chỉ owner tạo job đọc/hủy được job và kết quả; kết quả hết hạn sau TTL, restart dịch vụ có thể làm mất registry RAM
- [ ] Fingerprint lịch phải khớp trước khi apply; nếu lịch đổi thì cancel job cũ và không áp response stale
- [ ] VPS 6 token chạy một fresh/refine chất lượng `6` hoặc tối đa ba repair `2 + 2 + 2`; job đầu FIFO chỉ chạy khi đủ quota đã giữ

## Solver quality benchmark

Dùng cùng một snapshot dữ liệu cho mọi lần so sánh. Không biến số liệu của một trường thành target hardcode cho trường khác.

- [ ] Fresh benchmark ghi lại: số tiết nhu cầu/đã xếp/chưa xếp, `hard_ok`, vi phạm app, runtime, buổi 1 tiết, gap >=2, tổng buổi GV và gap 1
- [ ] Bộ regression 1566 tiết: kết quả phải đủ `1566/1566`, hard-valid và giữ đúng toàn bộ 54 tiết `fixed: true`
- [ ] So sánh ứng viên bằng tuple lexicographic: đủ + hard-valid → buổi 1 tiết → gap >=2 → tổng buổi GV → gap 1
- [ ] Bấm **Sắp xếp** lần hai trên lịch đầy đủ: chạy nhánh refine và chỉ nhận ứng viên tốt hơn theo tuple; không hardcode mốc buổi/gap của bộ default cho trường khác
- [ ] Với bộ default, ghi lại dải tham chiếu lịch sử (ví dụ khoảng `460-482` buổi và `34-50` gap-1) để phát hiện hồi quy, nhưng không biến dải này thành ràng buộc cứng
- [ ] Residual benchmark: đổi vài PCCM hoặc bỏ một ít tiết, xác nhận nhánh repair nhanh hơn fresh, đủ tiết và không còn assignment cũ
- [ ] Chạy lại cùng snapshot ít nhất 3 lần; lưu runtime và tuple chất lượng từng lần để phát hiện biến thiên bất thường
- [ ] Benchmark tải: mô phỏng 10 trường cùng bấm; số job chạy không vượt `maxConcurrent`/CPU tokens, phần còn lại hoàn tất theo FIFO

## Launcher

- [ ] `python start.py` shows Python deps status in control window
- [ ] Closing control window stops backend and frees port 1010
- [ ] `scripts/setup.ps1` installs Python deps without error

## Deploy VPS

- [ ] Python contract tests, Rust unit tests, E2E và syntax check bridge đều pass trước deploy
- [ ] `tools/vps-deploy/solver-pool.conf` giữ `TKB_SOLVER_MAX_CONCURRENT=3`, `TKB_SOLVER_CPU_TOKENS=6`, worker `2-6` và `TKB_SOLVER_REQUIRE_AUTH=1`; unified fresh/refine chất lượng yêu cầu đủ 6 worker mỗi job
- [ ] Trước deploy, production báo `activeJobs: 0` và `queuedJobs: 0`; không thay binary khi solver còn chạy
- [ ] Deploy bằng `python tools/vps-deploy/update-deploy.py` với thông tin đăng nhập lấy từ biến môi trường, không ghi mật khẩu vào repo/log
- [ ] Sau deploy, smoke `https://tkbcherry.com`: health/version mới, chỉ một nút adaptive và asset cache mới được tải
- [ ] Smoke auth: solver endpoint thiếu Bearer bị chặn; Bearer hợp lệ precheck/solve/state/cancel hoạt động và owner isolation còn đúng
- [ ] Smoke FIFO: tạo lượt chờ, xác nhận tự chạy khi có token và nút **Dừng** xóa được lượt đang chờ
- [ ] Smoke một bộ nhỏ rồi bộ benchmark chuẩn; xác nhận đủ tiết, hard-valid, fixed đúng và metrics không hồi quy

## v1.9 release evidence (2026-07-16)

- [x] Local scheduler 100/100, Agent 53/53, frontend/UI 173/173, launcher 7/7.
- [x] Packaged Agent 1.6.0 tested with raw UTF-8 requests, not source shortcuts.
- [x] H1 maxDays=3: 1566/1566, hard-valid, 18 periods on 3 days, fixed 54/54.
- [x] H2 changed-rule fresh fallback: same hard contract, fixed 54/54.
- [x] Default: 1566/1566, hard-valid, zero app violations, fixed 54/54.
- [x] d8f7b12caf1: 1566/1566, hard-valid, zero app violations, fixed 108/108.
- [x] All four packaged-EXE lanes converged below 218 seconds with a 360-second test guard.
- [x] Isolated VPS staging: scheduler 100/100, Agent 53/53, Rust 139/139.
- [x] Full pre-deploy VPS tree backed up to `C:\Users\Love\Documents\Codex\TKB`.
- [x] Production deploy returned `UPDATE_OK`; health reports 0 active/queued and 6/6 free tokens.
- [x] Public v213 marker/cache key and Agent ZIP SHA-256 match the release artifacts.
