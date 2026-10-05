# PROJECT HANDOFF — TKBCherry

> Nhật ký bàn giao theo từng phiên làm việc, mục mới nhất ở trên cùng.
> Tóm tắt trạng thái hiện hành: xem [`CURRENT_STATE.md`](CURRENT_STATE.md).
> Các mục trước tháng 10/2026 đã chuyển vào `docs/archive/`:
> - [`2026-09`](archive/PROJECT_HANDOFF_2026-09-01_2026-09-30.md)
> - [`2026-08-10 – 2026-08-31`](archive/PROJECT_HANDOFF_2026-08-10_2026-08-31.md)
> - [`2026-07-28 – 2026-08-09`](archive/PROJECT_HANDOFF_2026-07-28_2026-08-09.md)
> Chính sách: đầu mỗi tháng, chuyển các mục của tháng trước vào `docs/archive/`.

## 2026-10-05 `0adf9782364` THCS Tân Nhựt — XẾP LẠI + TỐI ƯU, ĐÃ GHI 1746/1746

- **Chủ dự án**: «xếp và tối ưu TKB này» (TKB số 4, bản sao TKB 3, ngày áp dụng 12/10). Kho có 54 lớp, 113 GV trong danh sách,
  2 địa điểm, 124 ô tiết cố định. Lịch ban đầu đã đủ 1746 tiết nhưng RB live báo 269 thông báo vi phạm (đếm theo ô);
  Python báo 96 lỗi yêu cầu, 17 buổi có nợ luật địa điểm. Chất lượng đầu vào: 713 buổi, 99 buổi 1 tiết, 10 buổi trống 2, 78 buổi trống 1.
- **Xếp/tối ưu**: chạy ngoại tuyến engine HEAD `6dc8d7f`, giữ ô cố định/nghỉ và nguyên phân công/yêu cầu: Cherry 180 s → Buổi dạy 120 s
  → Trống 1 tiết 120 s (`scratch/0adf9782364/solve.py`, có main guard). Kết quả **1746/1746, 594 buổi, 0 buổi 1 tiết, 0 trống 2,
  37 trống 1**; 1430 ô thay đổi. Kiểm độc lập bằng `tkb-constraints.js` tải từ production: `validateAll(5000)` **0 thông báo**.
  Python kiểm 0 trùng GV/lớp/phòng, 0 thiếu/thừa phân công, 0 lỗi tiết đôi/ô nghỉ/yêu cầu, 0 nợ địa điểm; giữ đúng 124 ô cố định.
- **Ngoại lệ có sẵn, GIỮ NGUYÊN**: 6/5 và 7/5 khóa cả hai tiết Tin-QT chiều T6 t1–2 dù giới hạn phân công = 1/buổi.
  Đã hỏi lựa chọn xử lý; chưa nhận trả lời nên giữ nguyên ô khóa lẫn giới hạn. Python `hard_ok=false` CHỈ vì hai lỗi giới hạn này,
  RB web không báo chúng. Không được mô tả kết quả là đã thỏa mọi kiểm tra hard; các luật còn lại đạt và không tạo vi phạm mới.
- **Ghi**: SSH KV store, transaction `BEGIN IMMEDIATE` + so hash toàn kho trước khi ghi; lần đầu hủy vì app tự đổi
  `tkbConstraints.meta.defaultGroupsSig` 2→3 (lịch/phân công/luật thực tế không đổi), đọc lại và giữ meta mới rồi ghi.
  Chỉ thay `tkb`, `tkbLessonTeachers`, `tkbLessonRooms`, bỏ kết quả giải/plateau cũ, cập nhật ba revision/timestamp.
  `_updatedAt = _lastModified = tkbScheduleRevision = 1791213967843`; backup trước/sau tại
  `/root/tkb-recovery/tannhut4-0adf9782364-20261005-222607/`. Đọc lại độc lập qua SQLite RO khớp hoàn toàn `written.json`; RB lại 0.
- **Mã nguồn/deploy**: không đổi scheduler/frontend/backend, không deploy. Dump/lệnh/audit chỉ ở `scratch/0adf9782364/` (đã gitignore).
  Thực hiện lưu trữ nhật ký tháng 8–9 vào `docs/archive/` theo chính sách; giữ đầy đủ các ghi chú đang sửa của phiên khác,
  chỉ đưa phần đã nằm trong HEAD và mục mới này vào commit.
- **Kiểm tra repo trước commit**: `python run_tests.py` trong sandbox bị chặn tiến trình con (`spawn EPERM`);
  Chạy lại ngoài sandbox: 130 pass / 28 fail / 158 module (454 s); 7 module được đánh dấu MỚI HỎNG khớp đúng các lỗi JS CRLF đã ghi nhận ngày 30/09–05/10. Không đổi mã nguồn hay test baseline trong phiên này. Việc xác nhận lịch đã hoàn tất bằng cả validator Python và RB production.

## 2026-10-05 (chiều) CHERRY KẾ THỪA LẦN BẤM TRƯỚC + GỠ LUẬT ĐỊA ĐIỂM KHÔNG BỎ TIẾT + NGÂN SÁCH 180 s

- **Chủ dự án**: xoá lịch An Phú `kkhg52etp92` rồi bấm Cherry → thiếu tiết + bảng ràng buộc báo lỗi nhiều; «nút cherry phải xếp đủ và
  tối ưu», «tăng thời gian chạy và kế thừa kết quả chạy thử». (Trước đó đã chọn "Khôi phục lịch cũ ngay" — CHƯA ghi vì Chrome mất kết
  nối; file `Downloads\kkhg52etp92_khoi_phuc_0510.cherry`, bản JSON `scratchpad 81e0937b/anphu2_restore_0510.json`.)
- **Nguyên nhân** (đo offline 180 s): bấm lần 2 trên lịch 868/869 hợp lệ trả y nguyên — nghiệm 869 / 7 buổi vi phạm địa điểm đứng đầu
  xếp hạng, `_location_gate` trả lịch cũ và vứt luôn nghiệm 868 tốt hơn; tiết cuối (MT 8A3 cô Thi, 1 tiết × 28 lớp × 2 cơ sở) cần
  đổi cơ sở cả buổi, CP-SAT luật địa điểm cứng 173 s vẫn 868. Xếp từ đầu chọn 869 kèm 10 buổi vi phạm thay bản hợp lệ.
- **Code** (`entry.py`, `construct.py`, `cpsat_lns.py`, `tkb-rust-bridge.js`): xếp hạng có cổng địa điểm (cả khi xếp từ đầu), vòng 2
  chỉ đi từ lưới xây mới khi qua cổng; CP-SAT `loc_soft` + `require_full`; `_cpsat_fill_phase` lặp toàn trường (phạt mềm) +
  `_cpsat_repair_loc_debt`; gỡ nợ cả nguyên buổi; `prefer_valid`; Cherry 90 → 180 s. Chi tiết: `docs/CHERRY_ENGINE.md` mục 05/10 chiều.
- **Đo An Phú 180 s**: bấm lần 2 → **869/869 hợp lệ [0,0,317,20]**; xếp từ đầu → **869/869 hợp lệ [2,0,316,15]**.
- **Test**: engine v3 154/154 (+6 `test_engine_v3_loc_fill_repair.py`; sửa kỳ vọng `test_fill_phase_completes_chain` vì lần giải
  toàn trường lấp xong trước vòng cụm). `run_tests.py`: chỉ 7 test JS CRLF đã biết. Bench 7 trường (110 s, tuần tự): không trường nào
  xấu đi ngoài dao động (số liệu trong `CHERRY_ENGINE.md`); GDTX lưới trống chậm hơn chút → giới hạn lần giải toàn trường cho trường
  không có luật địa điểm.
- **Deploy**: Cloud Run `deploy-and-pin.ps1` → digest `863a25892ccb4cfb8c4dca8318104ad1b93ca478be861598023df1d6f9b521d8`, Jakarta
  `00415-but`; 2 vùng phụ script hết giờ chờ bước max 2 → Claude `update-traffic` sang `00035-d28` (asia-southeast1) / `00035-cpz`
  (asia-east1) — cùng image, max 2; `/health` có token 3 vùng khớp digest, VPS đã ghim. Web: `tkb-rust-bridge.js` dựng = bản LIVE +
  đúng dòng ngân sách 180 s (live đang cũ hơn HEAD: commit ea9af15 "soft-stop status" + nhãn "Đang tìm" CHƯA từng deploy — cố ý
  không kéo theo), đẩy từ worktree sạch `deploy.py files deploy cherry-180s-20261005 --no-restart` (backup
  `/root/tkb-backups/cherry-180s-20261005`), sha live = 057db7d9….

## 2026-10-05 CHERRY: TIẾT GHÉP TÍNH VÀO CHẤT LƯỢNG GV + LUẬT ĐỊA ĐIỂM TRONG CP-SAT + minSessions (ĐÃ DEPLOY)

- **Chủ dự án**: «bấm Cherry xong TKB không đổi» (THCS An Phú `kkhg52etp92`) → chọn "Nâng engine Cherry".
- **Code** commit `2513f38` (đã push): `Problem.teacher_fixed_busy` (ô cố định dùng chung nhiều lớp tính vào chiếm chỗ GV ở
  SoftSchedule/State/CP-SAT), luật địa điểm mã hoá trong `cpsat_lns` (`TKB_CPSAT_LOC=0` = cách cũ), Cherry 2 vòng cho trường có luật
  địa điểm chỉ khi có lịch đủ tiết, `maxDaysSessions.minSessions` (engine; giao diện CHƯA có ô nhập — `tkb-constraints.js` đang có
  sửa dở của phiên khác), `State.apply` cập nhật `ts_count` trước khi kiểm luật. Chi tiết + số đo: `docs/CHERRY_ENGINE.md` mục 05/10.
- **Test**: v3 148/148; `run_tests.py` chỉ 7 test CRLF đã biết. Bench 8 trường (`scratchpad bench_run.sh`, chạy song song old/new gây
  nhiễu — Hồ Văn Long đo lại tuần tự thì ngang nhau).
- **Deploy Cloud Run** (`deploy-and-pin.ps1`): digest `63596248f26dc8260e3e1e870abfd304a93823155edb3d83feb1197264fdc105`, /health 3 vùng
  khớp, VPS đã ghim. VPS chưa nhận 5 file engine (chỉ dự phòng, `serverless_only`).
- **Dữ liệu An Phú** (05/10, ghi qua tab Chrome, cổng `_lastModified` 1791135250543 → 1791142958307): `minSessions` = số buổi hiện tại
  (≤ maxSessions) cho 54 GV — luật "đúng bằng" của chủ dự án; lưới không đổi (316 buổi). Danh sách: `scratch/anphu2r/minsessions_written_0510.json`.

## 2026-10-04 ĐÃ DEPLOY CLOUD RUN ENGINE CHERRY 8ff47eb (CP-SAT LẤP TIẾT) — 3 VÙNG, DIGEST ĐÃ GHIM

- **Chủ dự án**: «sao nay nút Cherry hết xếp được và tối ưu rồi nhỉ? toàn phải phụ thuộc vào AI» → «deploy đi».
- **Chẩn đoán** (`/api/admin/solver-telemetry`, chỉ số gộp): Cloud Run vẫn là `tkb-solver-00404-guf` (build 19/09 = `bd2ff6b`,
  digest `bad7ef38…`); 24 h 35/39 lượt cloud "failed" (Tối ưu v3 13/13), 7 ngày 234/321; FET trình duyệt 88/89 ổn. Tái hiện ngoại tuyến
  trên TKB 3 Củ Chi 2 (`0l2vcan0xx3`, khung đúng, lưới trống, 60 s, 6 tiến trình): bản 19/09 1818/1819 `hard_ok=false`; bản `8ff47eb`
  1819/1819 hợp lệ, 0 buổi 1 tiết. Bẫy đo: script gọi `solve_from_ui_data_v3` trên Windows phải có `if __name__ == "__main__"` — thiếu
  thì `worker_count=1`, Cherry 2 vòng không bật, bản cũ/mới ra y hệt.
- **Deploy** (Claude chạy, có xác nhận): `powershell -ExecutionPolicy Bypass -File tools\cloud-run\deploy-and-pin.ps1 -ConfirmDeployment`
  → ảnh `tkb-solver:20261004-134507`, digest `110dc8e6877d5ac10b0b0340b1c44072a7cc2eef7f16ea862ead122b4f731c3d`; Jakarta `00407-ker`,
  Singapore + Đài Loan (`00065-mim`…) 100 % traffic, max 2; VPS: profile 3 vùng (backup `/root/tkb-backups/profiles-20261004-210321`) +
  `pin-cloud-run-digest.py --apply` (restart `tkb-app` active). Kiểm khô lại: 2 drop-in + 3 profile đều `110dc8e6…`.
- **Nghiệm thu**: gọi thẳng `/solve` Jakarta (token mượn SA invoker, engine cherry, 60 s) với TKB 3 lưới trống → 107 s, ok, `hard_ok`,
  1819/1819, 0 buổi 1 tiết, 614 buổi, trống 1 = 56 (`cpsat_quality` 634 → 614).
- **Còn mở**: trường có luật địa điểm GV vẫn đi đường cũ (không CP-SAT); Tối ưu v3 trên lưới thiếu tiết vẫn bị tính failed (mục 01/10 dưới).

## 2026-10-01 NÚT CHERRY DÙNG CP-SAT: LẤP TIẾT THIẾU + TỐI ƯU (CODE + TEST XONG, ĐÃ DEPLOY CLOUD RUN 04/10)

- **Chủ dự án**: «làm sao nút Cherry làm được như bạn? giờ người ta xếp bằng Cherry không được». Nguyên nhân (mục dưới): trường 0 ô dư,
  pha 1+2 heuristic không có CP-SAT → ~1192/1207; lane CP-SAT cũ chỉ hoán đổi tiết đã xếp.
- **Code** (`solver_runtime/src/tkb_engine_v3/`): `cpsat_lns.py` lane `fill` (ô trống + tiết thiếu là biến, `full_classes`, `fill_quality`,
  hoãn tiết đôi có phạt); `construct.py` `_cpsat_fill_phase` / `_cpsat_quality_phase` / `_salvage_warm` / `_shed_rule_debt` /
  `_maybe_fill_warm`, cờ `cherry_cpsat`; `entry.py` Cherry 2 vòng (portfolio heuristic ~40 % → 1 tiến trình × N luồng CP-SAT warm từ
  lưới tốt nhất / lịch người dùng), chỉ khi `_cpsat_lane_enabled` và KHÔNG GV nào có luật địa điểm; tắt `TKB_CHERRY_CPSAT=0`.
  Chi tiết + số đo: `docs/CHERRY_ENGINE.md` mục 01/10.
- **Đo** (60 s, `TKB_CPSAT_THREADS=6`, cùng máy, cũ = `TKB_CHERRY_CPSAT=0`; máy đang có tiến trình `tbh4_solve.py` 16 luồng của phiên khác
  chạy nền suốt lúc đo): bản mới tốt hơn hoặc bằng ở 12/12 ca (6 trường × lưới trống/lịch có sẵn) — Hưng Long trống 1192 → 1207 hợp lệ,
  Hồ Văn Long TKB5 trống không hợp lệ → hợp lệ [1,1,616,134], Nguyễn Ảnh Thủ trống 1123 → 1149 hợp lệ, trường 61 lớp lịch có vi phạm
  2051 [72,31,724] → 2071 [5,7,649]; Tân An Hội (luật địa điểm) giữ đường cũ.
- **Test**: `solver_runtime/tests/test_engine_v3_cpsat_fill.py` 8/8; `python -m unittest discover -s solver_runtime/tests -p "test_engine_v3_*.py"`
  140/140. `run_tests.py`: 7 "MỚI HỎNG" JS = đúng 7 test CRLF đã ghi ngày 30/09; thêm `test_model_plan_contract` (không dính file sửa) —
  chạy riêng PASS cả bản mới lẫn HEAD (hỏng do máy quá tải khi chạy cả bộ).
- **Commit** `8ff47eb` (chỉ 5 file của thay đổi này; đã push). **VPS** (dự phòng, `serverless_only` nên không đổi hành vi web):
  `deploy.py files deploy cherry-cpsat-fill-20261001 --no-restart` 3 file engine, backup `/root/tkb-backups/cherry-cpsat-fill-20261001`.
- **Deploy Cloud Run**: ĐÃ DEPLOY 04/10 (mục trên, digest `110dc8e6…`). Ghi chú cũ: Cloud Run vùng chính ghim `bad7ef38…`, 2 vùng phụ `dffac571…` (13/09). Lệnh (chủ dự án chạy, có restart
  `tkb-app` ở bước cập nhật VPS → chạy lúc vắng): `python deploy.py cloudrun --max-instances 2` (giữ maxConcurrency 2 của vùng chính).

## 2026-10-01 Tối ưu v3 trên lưới THIẾU tiết luôn bị tính "failed" (điều tra, CHƯA sửa)

- **Báo lỗi** (một trường "tối ưu không được"): `solver_execution_usage` cho thấy 5 lượt Tối ưu v3 (1 tiết/buổi, Buổi dạy) liền nhau đều
  `failed`, `hard_valid=0`, chỉ số trước = sau. Lưới lúc đó là kết quả Cherry **chưa đủ tiết** (trường 0 ô dư: Cherry 60 s từ lưới trống
  chỉ đạt 1192/1207, tái hiện ngoại tuyến bằng `solver_runtime/scripts/solve_stdio.py`, engine=cherry).
- **Cơ chế**: engine v3 vẫn tối ưu trên lưới thiếu (đo: 1 tiết/buổi 14→8) nhưng `_finalize_solve_status` (`solve_stdio.py`) đặt
  `hard_ok=false` khi còn tiết chưa xếp → lượt bị tính thất bại, trình duyệt không áp. Trên lưới đủ tiết cùng nút chạy bình thường.
- **Hướng sửa có thể** (cần chủ dự án duyệt): cho lượt một mục tiêu được áp khi số tiết đã xếp không giảm so với lưới xuất phát, hoặc
  báo rõ "lịch còn N tiết Chưa phân — bấm Cherry/xếp đủ trước khi Tối ưu" thay vì thất bại im lặng.

## 2026-10-01 XUẤT EXCEL TKB GV + TKB TỔNG TÔ MÀU THEO ĐỊA ĐIỂM (ĐÃ DEPLOY)

- **Chủ dự án** (THCS Tăng Bạt Hổ 2 cơ sở): "khi xuất ra, trên TKB của giáo viên và TKB tổng trên file Excel cần thể hiện các màu ở
  Địa điểm để người ta phân biệt như trên web".
- **`web/pages/tkb-student-excel-export.js`**: 4 file Excel (GV mẫu 1 `gv…`, GV mẫu 2 `gv…`, tổng theo GV `tonggv…`, tổng theo lớp `tonghs…`)
  tô ô có tiết theo địa điểm — cùng 4 màu vạch trên web (`tkb-loc-1..4`: #1677ff, #fa8c16, #52c41a, #722ed1): **cạnh trái đậm (thick)**
  đúng màu web + **nền nhạt** cùng tông (BAE0FF / FFE7BA / D9F7BE / EFDBFF). Địa điểm lấy giống web (`tkbLocationList` / `tkbEntryLocation`:
  phòng `DATA.phong.diadiem` nếu tiết có phòng, không thì `DATA.lop.diadiem`; có bản dự phòng khi phanmon.js cũ). Chỉ tô khi trường ≥ 2 địa điểm;
  ô trống / ô có lớp ở nhiều địa điểm (trùng lịch) không tô; tiết học chung đã gộp xét đủ `jointClassIds`.
  **Chú thích** tên địa điểm trên nền màu: mẫu 1 ở dòng trống `top+6`, mẫu 2 ở dòng trống `top+5`, bản tổng ở dòng tiêu đề sau cột 16.
  Bản tổng theo lớp tô cả ô tên lớp. Phiếu TKB lớp (`hs…`) không đổi.
- **Test**: `e2e_tests/excel_location_colors_node.test.js` 7/7 (nạp `vendor/xlsx.min.js` thật, kiểm style ô + `xl/styles.xml` có `<left style="thick">`).
  `run_tests.py`: 7 "MỚI HỎNG" giống hệt mục 30/09 — hỏng y nguyên trên HEAD sạch không có bản sửa này (không test nào nạp module xuất Excel).
- **Deploy**: dựng từ git worktree sạch tại HEAD (= live cho file này) để KHÔNG đẩy thay đổi chưa deploy của phiên khác trong cùng file
  (nhãn dạy ghép nhiều GV 29/09, `ghepMultiTeacherLabel`): `python deploy.py files deploy excel-location-colors-20261001 --no-restart
  web/pages/tkb-student-excel-export.js` (sha `02047acdc49046e3`, backup `/root/tkb-backups/excel-location-colors-20261001`). Server trả
  `Cache-Control: no-store` nên không đổi `?v=` trong sapxep.html. Working tree giữ cả hai thay đổi (gộp 3 chiều).
- **Kiểm trên web thật** (sid `i350pgr8o92`, 53 lớp, 2 địa điểm): xuất cả 4 file — tonghs 1975 ô màu (= 1920 tiết + 53 tiêu đề lớp + 2 chú thích),
  tonggv 1922 (= 1920 + 2), mẫu 1/2 mỗi file 2772 (= 1920 + 142 GV × 6 ô chú thích).
- **Chưa commit (của phiên khác)**: tính năng vạch màu địa điểm trên web 23/09 (`tkbLocationList`/`tkbLocationCellInfo` trong phanmon.js,
  `phanmon.css`) đã live nhưng vẫn nằm ở working tree.
