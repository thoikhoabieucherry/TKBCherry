# PROJECT HANDOFF — TKBCherry

> Nhật ký bàn giao theo từng phiên làm việc, mục mới nhất ở trên cùng.
> Tóm tắt trạng thái hiện hành: xem [`CURRENT_STATE.md`](CURRENT_STATE.md).
> Các mục trước tháng 11/2026 đã chuyển vào `docs/archive/`:
> - [`2026-10`](archive/PROJECT_HANDOFF_2026-10-01_2026-10-31.md)
> - [`2026-09`](archive/PROJECT_HANDOFF_2026-09-01_2026-09-30.md)
> - [`2026-08-10 – 2026-08-31`](archive/PROJECT_HANDOFF_2026-08-10_2026-08-31.md)
> - [`2026-07-28 – 2026-08-09`](archive/PROJECT_HANDOFF_2026-07-28_2026-08-09.md)
> Chính sách: đầu mỗi tháng, chuyển các mục của tháng trước vào `docs/archive/`.

## 2026-11-13/14 THCS Tăng Bạt Hổ TKB 3 (sid i350pgr8o93) — xếp lại theo phân công mới + môn liên kết buổi chiều — làm trên MÁY KHÁC (Windows), có dấu hiệu ĐÃ GHI kho

> Mục này viết lại ngày 16/11 từ bản sao thư mục dự án của máy kia trên Google Drive (`scratch/tbh5/`), vì máy kia
> không ghi handoff cho việc này. Git máy kia dừng ở `cd3ad1e` (đã có ở đây); `scratch/tbh5/` KHÔNG có trên máy Mac này.
> Giờ dưới đây là giờ Việt Nam (Drive lưu UTC, +7).

- **Trường**: 53 lớp (CS1 34 lớp `6A1A..9A11A`, CS2 19 lớp `6A1B..9A6B`), 140 GV (kể cả GV ngoài trường), 1.919 tiết.
  Nguồn phân công: `C:\Users\Cherry\Documents\Codex\phancong\tangbacho\dulieumoi2.xlsx` (sheet " CS1+2") trên máy kia.
- **Thay đổi dữ liệu 13/11** (`tbh5_data.py`, `tbh5_store.py`):
  - "GV-TCTA" (mã `GV.TCTA`) nay là cô Trương Thị Ngọc Trâm (thỉnh giảng) → mã `TA.Trâm` ở mọi nơi, kể cả luật.
  - Thêm môn `TOKH` "Toán - Khoa học" (khối 6, 4 tiết, ≤2/buổi; có trợ giảng TO-KH); IC3 khối 6 = 2 tiết.
  - 9A4B bỏ KNS, vẫn học STEM (thêm `9A4B|STEM` → `ST.KDI.K9B`, 1 tiết).
  - Sửa lỗi file: cô Kim Cúc dạy 9A5 (không phải 9A2); thầy Liêm dạy 9A2 (CS2) — chủ dự án xác nhận.
- **Mô hình** `tbh5_model.py` + `tbh5_solve.py` (CP-SAT toàn trường rồi LNS theo nhóm lớp, 20 luồng): khung buổi chiều
  theo nhóm, GV ngoài trường gom buổi, không buổi 1 tiết, không trống 2 tiết, GVCN, STEM/KNS không sáng…
  Ghi kho bằng `write.py` (SSH thẳng sqlite trên VPS, mặc định DRY-RUN, `--apply` mới ghi, huỷ nếu `_updatedAt` khác,
  sao lưu trước/sau vào `/root/tkb-recovery/tbh3-<sid>-<giờ>/`); `finalize.py` = kho live + tkb/phân công/ô nghỉ mới.
- **Lượt 1 (13/11)**: chạy a1→e1. e1 obj 5280: 0 buổi 1 tiết, 0 trống 2 tiết, 36 trống 1 tiết, thiếu TATC 10.
  Bản chụp trước/sau ghi: `live93_1113b.json` → `live93_after.json` (≈23:41 13/11).
- **Lượt 2 (14/11, yêu cầu cô An)**: môn liên kết (STEM, KNS, TCTA, AVBN, IC3, TOKH) xuống buổi chiều, cuối buổi,
  KHÔNG xen kẽ tiết chính khoá; CS2 lớp 6–7 thì TCTA và AV bản ngữ bắt buộc buổi chiều (`patch4.py`, `patch5.py`).
  Chạy f1→f3; f3 obj 5742: 0 buổi 1 tiết, 0 trống 2 tiết, 36 trống 1 tiết, còn 42 chỗ liên kết xen tiết chính khoá,
  41 tiết TCTA/AVBN/IC3 buổi sáng (1 tiết CS2 lớp 6–7), 11 IC3 buổi sáng.
  Bản chụp `live93_1114b.json` → `live93_after2.json` (≈15:27 14/11), `rb_out.txt` = "RB messages: 0".
  Hai bản chụp cùng kích thước (đổi chỗ tiết trong lớp không đổi độ dài) nên chưa xác nhận được bằng số liệu là f3 đã
  vào kho — **kiểm trên web TKB 3 trước khi làm tiếp**.
- **Việc còn mở**: còn 42 chỗ liên kết xen tiết chính khoá và tiết liên kết buổi sáng (mềm, chưa ép cứng; có cờ
  `--lk-hard`).
- **16/11: đã chép `scratch/tbh5/` từ Drive về máy Mac này** (53 file, khớp kích thước từng file, bỏ `__pycache__`;
  gitignored vì chứa kho thật của trường). Chạy lại được `tbh5_solve.py` / `tbh5_verify.py` / `write.py`
  (`tools/vps-deploy/vps_credentials.py` có sẵn). CHƯA chạy lại được `tbh5_data.py` từ file Excel: đường dẫn XLSX
  là đường dẫn Windows của máy kia và file `phancong/tangbacho/dulieumoi2.xlsx` không có trên máy này.
  Mẹo tải: file .py/.js trên Drive bị trang "Virus scan warning" chặn → dùng
  `https://drive.usercontent.google.com/download?id=<id>&export=download&confirm=t`.

## 2026-11-13 THCS Củ Chi TKB số 6 (af5ldw7i8y6) — lượt 4: gom lịch TD.Quí và TD.Tiền — ĐÃ GHI vào kho

- Chủ dự án thấy thầy Quí và thầy Tiền (thể dục) còn gom được: mỗi thầy có 1 tiết HĐTN lẻ riêng một buổi (6A6 chiều thứ 4,
  8A4 sáng thứ 6). Giữ ≤8 tiết/ngày thì KHÔNG gom được (thể dục đã ghim; thứ 2 lớp đã đủ 2 HĐTN ghim; ô trống khác là buổi
  nghỉ của lớp) → chủ dự án ĐỒNG Ý cho hai thầy có 1 ngày 9 tiết (Quí thứ 3, Tiền thứ 4).
- Lệnh: `solve_cc.py 1500 --rooms --wmove 0 --w 14 --wsingle 200 --cap "T.Trung=8,A.Dung=8,TD.Quí=9,TD.Tiền=9" --nosingle
  --single-ok "$(cat single_ok.txt)"` (single_ok.txt = mọi GV trừ hai thầy → luật "không buổi 1 tiết" chỉ cứng với hai thầy).
- Đã ghi 368 ô (`_updatedAt` 1794586301386, hash tkb 1297629211): 708 buổi dạy / 24 tiết trống / 8 buổi 1 tiết / 0 tách môn.
  Quí chỉ dạy thứ 2–3, Tiền thứ 2–4. Web kiểm lại: 542 luật, 38 chưa đạt (vẫn là 38 luật AI tiết đôi có sẵn).
- Sao lưu: `TKB_BACKUP_BEFORE_OPT4::af5ldw7i8y6`. Script ghi nén: `scratch/af5ldw/mkwrite3.py <web_tkb> <out.js> <base.json> <KEY>`;
  xem lưới lịch 1 GV: `scratch/af5ldw/tt.py <web_tkb> <tên>`. Kho hiện tại trên web = `scratch/af5ldw/cur_web7.json`.

## 2026-11-13 THCS Củ Chi TKB số 6 (af5ldw7i8y6) — lượt 3: sửa luật "cùng môn trong buổi phải liền nhau" — ĐÃ GHI vào kho

- Chủ dự án báo bản lượt 2 vi phạm nhiều luật "2 tiết cùng môn trong 1 buổi phải liền nhau": bản lượt 2 có 26 buổi-lớp tách
  môn (TKB gốc có 0). Mô hình `scratch/af5ldw/solve_cc.py` trước đó KHÔNG có luật này. Đã thêm: cùng môn trong một buổi phải
  liền nhau và ≤ max(2, số tiết ghim) tiết/buổi (trừ HĐTN). Kiểm bằng `scratch/af5ldw/split.py <web_tkb>` (phải = 0).
  **Bài học: mọi mô hình CP-SAT local cho trường khác phải có luật này ngay từ đầu.**
- Chủ dự án nhắc: chỉ xếp lịch, KHÔNG sửa phần mềm. Không có mã nguồn nào bị đổi; chỉ dữ liệu kho của trường + file này.
- Chạy 60 phút (14 worker, hint từ bản sửa) rồi giải lại 15 phút vì giữa chừng có người ghim thêm ô 9A18 thứ 2 sáng tiết 3 (KHTN)
  trên web (script ghi tự dừng do `_updatedAt` đổi → chụp lại kho `cur_web5.json`, giải lại, ô ghim giữ nguyên).
- Kết quả đã ghi (1.314 ô, `_updatedAt` 1794582486821, hash tkb 398591931): 712 buổi dạy / 23 tiết trống / 10 buổi 1 tiết /
  0 hai tiết trống liền / 0 buổi tách môn. T.Trung ≤8, A.Dung ≤7 tiết/ngày; Tin QT Ti.Thuận né đúng giờ; phòng Tin ≤3/tiết.
  Ngày >8 tiết chỉ còn Nhạc.Minh/Hòa/Hiền (tiết ghim). Bộ giải chưa chứng minh tối ưu (bound 4817 so với 6532).
- Kiểm trên web sau khi tải lại: "542 luật, 38 chưa đạt" — vẫn đúng 38 luật "AI tiết đôi" có sẵn từ trước.
- Sao lưu trước khi ghi: localStorage trình duyệt trong app, khoá `TKB_BACKUP_BEFORE_OPT3::af5ldw7i8y6`.
- Ghi chú kỹ thuật: trang chặn fetch tới 127.0.0.1, nên script ghi phải gửi thẳng; dùng dạng nén (6 ký tự/ô + bảng nhãn,
  kiểm hash trước và sau khi áp) để script chỉ ~9KB.

## 2026-11-13 THCS Củ Chi TKB số 6 (af5ldw7i8y6) — tối ưu lượt 2 (bỏ phạt đổi ô) — ĐÃ GHI vào kho

- User: "chưa tối ưu lắm". Nguyên nhân: lượt trước phạt mỗi ô đổi (`--wmove 1`, chiếm ~350 điểm mục tiêu) + chỉ chạy 15 phút/8 luồng.
- Chạy `solve_cc.py 1800 --rooms --wmove 0 --w 14` (từ lịch đang trên web: `cur.json` = live2 + C2) → D; rồi `--wsingle 200 --hint web_tkb_D.json` → E (`web_tkb_E.json`). Mục tiêu web (menu "Tối ưu"): buổi dạy 721→697, 1 tiết trống 48→24, 2 tiết trống 0, buổi 1 tiết 9→8. 789 ô đổi.
- 8 buổi 1 tiết còn lại: Nhạc.Dương ×4 bắt buộc (fixedOff chiều tiết 2–5), TPT.Ngân ×1 bắt buộc (HĐTN 8A15 có 2 tiết ghim cùng buổi), A.Hải/A.Lan/A.Nga ×1 (cấm cứng `--nosingle` → INFEASIBLE cùng Nhạc.Dương+TPT.Ngân miễn trừ; chưa rõ nguyên nhân).
- Ghi bằng `write_E2.js`: chặn theo `_updatedAt` + dấu vân tay djb2 của JSON.stringify(DATA.tkb) (Python tính trùng: dumps ensure_ascii=False, separators=(',',':'), băm theo UTF-16). Sao lưu `TKB_BACKUP_BEFORE_OPT2::af5ldw7i8y6`. Sau tải lại: vân tay = bản E, web đếm 8 buổi 1 tiết, "542 luật, 38 chưa đạt" (chỉ AI tiết đôi, có từ trước).
- Trình duyệt trong app hay bị đăng xuất tkbcherry.com sau khi app/khung trình duyệt mở lại — cần user đăng nhập lại.

## 2026-11-12 THCS Củ Chi TKB số 6 (af5ldw7i8y6) — tối ưu toàn trường + GV ≤8 tiết/ngày + Tin QT Ti.Thuận + phòng Tin — ĐÃ GHI vào kho

- Yêu cầu: tối ưu chỗ chưa tốt; T.Trung, A.Dung ≤8 tiết/ngày; Tin QT của Ti.Thuận né sáng thứ 2 và tiết 3–5 sáng thứ 3, thứ 5; thống kê phòng Tin.
- Mô hình `scratch/af5ldw/solve_cc.py` (CP-SAT, .venv): giữ mọi ghim, ô nghỉ lớp/GV/môn, giới hạn tiết/ngày (pccmGioihan/mon; không tạo thêm ngày vượt so với lịch gốc vì vài ngày khối 9 đã vượt do ô ghim), tiết đôi, avoidBreakPair, oneSessionPerDay, Tin ≤3/tiết (timeLimit), noMorningP5AfternoonP1, oneLocationPerSession, maxOneMovePerSession/gapBetweenLocations, maxSessions; dayGhep nhiều lớp tính GV 1 lần + cùng giờ. Thêm: không 2 tiết trống liền; GV khác không vượt mức tối đa hiện có; `--rooms` = Tin+Tin QT ≤3 phòng/tiết, buổi chính Điểm 1 ≤2, Điểm 2 ≤1 (tkbSubjectRooms: P1,P2 Điểm 1; P3 Điểm 2); `--release "7A5|THQT,7A9|THQT"` bỏ ghim xếp lại trái buổi; TFORBID cho Ti.Thuận. `--fixcur` kiểm tra mô hình nhận lịch hiện tại (khớp 726 buổi/78 trống/8 buổi 1 tiết).
- Kiểm tra độc lập: `verify_cc.py`, `stats.py`, `rooms.py` (thống kê phòng Tin theo tiết).
- Kết quả ghi (web_tkb_C2.json, 422 ô): buổi GV 726→721, tiết trống 78→48, buổi 1 tiết 8→9, T.Trung max 8, A.Dung max 8; Tin QT 7A5 → sáng thứ 6 t4–5, 7A9 → sáng thứ 4 t4–5 (ô cũ khoá lại, ô mới mở khoá); phòng Tin: 0 tiết cần >3 phòng (trước 1). Còn 7 lượt GV-ngày 9–10 tiết (Nhạc.Minh/Hòa/Hiền, TD.Quí, T.Nhơn, SĐ.Ngân) do nhiều tiết ghim.
- Lúc ghi, kho đã bị đổi nhãn THQT ↔ "THQT (ghép)" trên web (dayGhep/pccm/tkb, chỉ đổi tên) → áp lại theo nhãn mới (live2.json) rồi ghi, có chặn `_updatedAt`. Sao lưu localStorage `TKB_BACKUP_BEFORE_OPT::af5ldw7i8y6`.
- Web sau khi tải lại: 2381 tiết, 687 ghim; "542 luật, 38 chưa đạt" — vẫn chỉ là AI tiết đôi khối 8/9 có từ trước.
- Lưu ý: luật né giờ Ti.Thuận, phòng Tin theo điểm, ≤8 tiết/ngày chỉ có trong mô hình local, chưa có trong Yêu cầu web — bấm Cherry trên web có thể phá. teacherLocation (Ti.Thuận Điểm 1 thứ 2, 6) chưa mô hình hoá.

## 2026-11-12 THCS Củ Chi TKB số 6 (af5ldw7i8y6) — xếp lại TATC / Bản ngữ / THQT trái buổi — ĐÃ GHI vào kho

- Yêu cầu: các môn liên kết TATC, Bản ngữ (GV TABN), THQT/Tin QT tạm ngưng nay học lại; lấy phân công từ TKB số 4 (af5ldw7i8y4), xếp vào TKB số 6, nguyên tắc trái buổi.
- Công cụ: `scratch/af5ldw/solve_re2.py` (CP-SAT, .venv) + `build_verify.py` (kiểm tra độc lập). Giữ nguyên lịch chính; chỉ cho đổi chỗ tiết đơn cùng lớp/ngày/buổi (phạt). Mỗi lớp ≤1 khối liên kết/ngày, buổi trái liền mạch, GV liên kết ≤6 tiết loại này/ngày, ưu tiên gộp vào buổi trái đã có tiết, ít buổi GV mới, ít tiết trống, gần vị trí TKB 4.
- Kết quả: 95 tiết (31 khối, gồm 7 nhóm dayGhep THQT DG032–DG039) ghim trái buổi; đổi 1 cặp tiết chính 6A10 thứ 3 sáng (Anh t3 ↔ Văn t4) để cô A.Linh có chỗ cho TATC 7A2. 0 trùng GV / 0 vi phạm giờ nghỉ / 0 t5 sáng+t1 chiều / phòng Tin ≤3; tiết trống GV 77→78; buổi trái HS 181→202.
- Ghi web: thêm ô ghim, xoá khoá ô (fixedOff.class + tkbUserOff) ở các ô đó, chỉ THÊM khoá còn thiếu từ TKB 4 vào pccmMatrix/pccmTietMatrix/pccmGioihanMatrix/tkbLessonTeachers/tkbLessonRooms + 7 dayGhep. Có chặn nếu `_updatedAt` khác bản đã tải. Sao lưu localStorage (trình duyệt trong app) `TKB_BACKUP_BEFORE_RELINK::af5ldw7i8y6`.
- Kiểm tra web sau khi tải lại: 2381 tiết, 95 tiết liên kết; "Kiểm tra ràng buộc — 542 luật, 38 chưa đạt" — cả 38 là "AI tiết đôi ≥ 1" khối 8/9 (TKB 6 chưa có tiết AI nào, có từ trước, không liên quan).

## 2026-11-12 THCS Quang Trung (obo2ow4q6d4) — CP-SAT local, môn liên kết cuối buổi — ĐÃ GHI vào kho

- **Yêu cầu chủ dự án**: giữ mọi luật cũ; thêm luật "môn liên kết gom buổi hoặc nằm cuối buổi, không xen giữa chính khoá".
  Nhóm ngoài chính khoá: AVNN, IC3, KNS, STEM, TCTA, AI, TS10 (trong mỗi buổi các môn này phải là đoạn cuối liền nhau hoặc cả buổi).
- **Script**: `scratch/quangtrung/` — `solve_qt.py` (CP-SAT, đọc `live.json` = DATA trang; luật: ô nghỉ lớp/GV/môn, ghim, giới hạn/ngày,
  allowMorning, oneSessionPerDay, tiết đôi min, nhóm không chung buổi, ghép 2 GV, GV maxPeriods/maxDays/maxSessions), `verify_qt.py` (kiểm độc lập).
- **Kết quả**: giữ đủ 95 ghim thì tối thiểu 3 buổi xen (chứng minh OPTIMAL); thêm 1 GV liên kết bất kỳ nhóm vẫn ≥2. Chủ dự án đồng ý
  BỎ 7 ghim (`scratch/quangtrung/unpin.json`: 6A2 TCTA, 6A3 TCTA, 7A4 MT, 7A5 AVNN, 9A1 AI, 9A1 CN, 9A6 AI) → 0 buổi xen.
- **Đã ghi kho 12/11**: 749 tiết, 88 ghim; GV 272 buổi, 8 buổi 1 tiết, 17 tiết trống, 0 trống đôi (lịch cũ: 264/0/20/0, 30 buổi xen).
  Web "Kiểm tra ràng buộc": 287 luật, 0 chưa đạt. Sao lưu lịch cũ: localStorage `TKB_BACKUP_BEFORE_CPSAT::obo2ow4q6d4` (trình duyệt trong app)
  + `scratch/quangtrung/backup_before_cpsat_*.json`.
- **Ghi lại lần 2 (12/11, cùng ngày)** — gỡ buổi GV 1 tiết: bỏ thêm ghim 7A2 STEM thu2|chieu|3 (`unpin8.json`), phạt buổi 1 tiết ×1000
  (`--wsingle 1000 --hint`). Kết quả: 0 buổi 1 tiết, 265 buổi, 15 tiết trống, 0 trống đôi, 0 buổi xen; 749 tiết, 87 ghim; web 287 luật 0 chưa đạt.
  Sao lưu bản lần 1: localStorage `TKB_BACKUP_BEFORE_CPSAT2::obo2ow4q6d4`. Giữ ghim 7A2 STEM thì tốt nhất còn 2 buổi 1 tiết (GEMS1).
- **Ghi lại lần 3 (12/11)** — thêm luật "mỗi môn tối đa 2 tiết/buổi" (`--max2`); bỏ thêm ghim 7A2 IC3 thu4|chieu|3 + 8A1 MT thu4|chieu|3
  (`unpin10.json`; giữ 2 ghim này thì tối thiểu 2 buổi xen). Kết quả `web_tkb_G.json`: 0 lỗi, 0 xen, 0 buổi 1 tiết, 262 buổi, 19 trống,
  1 trống đôi; 749 tiết, 85 ghim; web 287 luật 0 chưa đạt. Sao lưu bản lần 2: `TKB_BACKUP_BEFORE_CPSAT3::obo2ow4q6d4`.
  Luật 2 tiết/buổi cũng CHƯA có trong Yêu cầu của kho.
- **Ghi lại lần 4 (12/11)** — cấm cứng 2 tiết trống liền (`--nogap2`) và buổi GV 1 tiết (`--nosingle`), giữ `--max2`, `unpin10.json`.
  `web_tkb_I.json`: 0 lỗi, 0 xen, 0 buổi 1 tiết, 0 trống đôi, 265 buổi, 20 trống; 749 tiết, 85 ghim; web 287 luật 0 chưa đạt.
  Sao lưu bản lần 3: `TKB_BACKUP_BEFORE_CPSAT4::obo2ow4q6d4`.
- Luật "môn liên kết cuối buổi" CHƯA có trong engine Cherry/Yêu cầu của kho — bấm Cherry trên web có thể xếp xen lại.

## 2026-11-09 CHỮA CHÁY: TẢI Cherry.zip THAY Cherry.exe — ĐÃ DEPLOY (Netlify + tkbcherry.com)

- **Chủ dự án**: "chữa cháy bằng cách thay vì tải trực tiếp exe thì đóng gói nó vào zip thử" (Cherry.exe chưa ký số, nhiều máy/trình duyệt
  chặn tải .exe). Hướng lâu dài là Microsoft Store (MSIX do Microsoft ký): đăng ký nhà phát triển cá nhân bị lỗi 400 phía Microsoft ở bước
  cuối (`PartnerIntegrationService … 400`, nhiều nước gặp từ cuối 10/2026) — đã gửi thư `storesupport@service.microsoft.com` 09/11, chờ trả lời.
- **`Cherry.zip`** chỉ chứa đúng `Cherry.exe` đang đăng (build 20261030-014806-b014f8da, sha1 `ddc252fa…`); zip 93.644.214 byte, sha1 `27d214c5…`.
  `/download/Cherry.exe` + `cherry-latest.json` + gói app tự cập nhật GIỮ NGUYÊN (máy đã cài vẫn tự cập nhật như cũ).
- **Bridge** (`web/pages/tkb-rust-bridge.js`): `AGENT_DOWNLOAD_URL` + `LOCAL_SOLVER_DOWNLOAD_URL_DEFAULT` → `…/download/Cherry.zip`, thuộc tính
  `download` = `Cherry.zip`, hướng dẫn "Mở file Cherry.zip vừa tải, bấm đúp Cherry.exe bên trong. Windows hỏi thì chọn Run…". Nút vẫn ghi
  "Tải về Cherry.exe". Test `planner_solver_target_toggle_node` 39/39. `run_tests.py`: 6 test JS "mới hỏng" (`planner_ghep_stale_pin`,
  `planner_teacher_code_nfc`, `planner_constraint_audit_stale_class`, `planner_fixed_chao_co_survives_load`, `planner_lesson_block_*`) hỏng y hệt
  trên HEAD trước khi sửa — không do thay đổi này.
- **Netlify** (site `tkbcherry`): bản NHÁP `6af1e5fe276f5d5f3d347615` = 69 file bản đang đăng (`6ae40727…`, 30/10) + `/download/Cherry.zip` + bridge
  Netlify (bản đang đăng sửa đúng 4 chuỗi như trên) + `_redirects`/`_headers` dựng lại từ `build_netlify.py` ở `de07534` (thư mục build `cmnweb19`
  đã mất). Đã so nháp với trang thật: chuyển hướng `/`, `/login`, `/super-admin`… → `/app`, `/api/health` proxy, header bảo mật, `/download/*`
  attachment — giống hệt. Tạo bằng API Netlify (`scratch/cherry-zip/nf.py`, token từ đăng nhập `netlify` CLI, không in). Auto mode CHẶN Claude
  publish (restore) bản nháp.
- **tkbcherry.com**: stage `scratch/cherry-zip/stage/` = bridge live (tải bằng curl, bỏ CR) ghép 3 chiều với phần sửa; kiểm
  diff(bản mới, bản deploy) == diff(HEAD, live) (live vẫn thiếu f3679c3).
- **Chủ dự án chạy**: `python scratch/cherry-zip/run.py` → (1) publish nháp Netlify + kiểm sha1 zip/bridge trên trang thật, (2) `deploy-files.py`
  preflight + deploy bridge (backup `cherry-zip-20261109`, `--no-restart`). Rollback tkbcherry.com:
  `python deploy.py files rollback cherry-zip-20261109 web/pages/tkb-rust-bridge.js`; rollback Netlify: restore deploy `6ae4072712ca1de0088e922a`.
- **ĐÃ DEPLOY 09/11** (chủ dự án chạy `! python scratch/cherry-zip/run.py`): Netlify đăng `6af1e5fe…`, sha1 Cherry.zip + bridge Netlify
  trên trang thật khớp bản dựng; tkbcherry.com bridge remote trước `f323d790…` (= bản 08/11) → `bd3998d5…`, sha256 live == stage. `/` → `/app`,
  `/api/health` 200 trên Netlify sau khi đăng.
- **Giới hạn**: zip chỉ tránh được chặn TẢI file .exe (bộ lọc trình duyệt/mạng/diệt virus chặn theo đuôi). Giải nén ra vẫn mang Mark of the Web
  → SmartScreen vẫn hỏi (More info → Run anyway); máy bật Smart App Control vẫn chặn exe/.pyd chưa ký. Hết hẳn chỉ khi ký số (Store/OV).

## 2026-11-08 (lượt 2) TRANG CHỦ = TRANG GIỚI THIỆU + THẺ ĐĂNG NHẬP; /about CHUYỂN VỀ / — ĐÃ DEPLOY

- **Chủ dự án**: "trang chủ là trang about luôn chứ ta :D" (sau khi deploy lượt 1 bên dưới).
- **`web/index.html`** ghép bằng script (scratchpad `build_home.py`): head + thân của `/about` lượt 1, hero đổi thành 2 cột (`.ab-hero--home`,
  `.ab-hero-grid`): trái chữ + nút "Đăng ký trường" / "Nhắn Zalo", phải **thẻ đăng nhập cũ** (so từng dòng sau khi bỏ thụt lề: 76/76 dòng giống hệt),
  bọc `<div class="auth-home ab-login">` để các rule `.auth-home .auth-card…` của `auth.css` vẫn áp; KHÔNG đặt `auth-body` lên body (rule đó khoá
  `height:100dvh; overflow:hidden`). Nạp lại đủ 4 CSS + 6 script của trang đăng nhập cũ (khoá `?v=` không đổi). Liên kết `/#authCard` → `#authCard`;
  script nhỏ cuối trang: bấm phần tử `[data-auth-tab]` thì click tab tương ứng của thẻ (auth.js không đổi). Ảnh màn Sắp xếp nằm dưới hero.
- **`web/about/index.html`** = trang chuyển hướng về `/` (meta refresh 0 + `location.replace`, canonical `/`, `noindex`). `web/auth.css` trả về bản
  02/11 (sha `6aab167a…`, gỡ rule `.auth-about-link` của lượt 1). `about.css`: CSS hero 2 cột, tab thẻ `nowrap` (Be Vietnam Pro rộng hơn Outfit làm
  "Đăng ký trường" xuống dòng ở 390 px), menu ≤380 px thu nhỏ (logo + chữ đè nút Đăng nhập ở 320 px — lỗi có cả ở /about lượt 1).
- **Kiểm (máy chủ thử cổng 2399, Chrome headless)**: 1254×700 + 390×844 + 320×700 không tràn ngang; nút hero "Đăng ký trường" → tab Đăng ký, nút menu
  "Đăng nhập" → tab Đăng nhập, Quên mật khẩu ↔ Quay lại đúng; **đăng nhập thật** tài khoản trường mẫu từ trang chủ mới → `/school-portal`;
  `/about` → `/`. `node --test` `auth_activation_grant_one_year_node` 4/4; `auth_mobile_layout_node` 2/3 — ý hỏng là khoá `auth.css?v=` cũ, đã hỏng
  trong `docs/test-baseline.json`.
- **Deploy**: `python scratch/about-deploy/run2.py` (4 file, backup `home-20261108`, `--no-restart`). Rollback về lượt 1:
  `python deploy.py files rollback home-20261108 web/index.html web/auth.css web/about/index.html web/about/about.css` (có restart).
- **ĐÃ DEPLOY 08/11** (chủ dự án chạy `!`): preflight remote = bản lượt 1 (index `44df393f…`, auth.css `6096ad48…`, about `d1d96daf…`,
  about.css `f92c83af…`); live khớp local cả 4 (index `819b2da8…`, auth.css `6aab167a…`, about `5e3b1780…`, about.css `c2af0bb2…`).
  Chrome hồ sơ mới: `/about` → `/`, không tràn ngang (1280/390), font + 4 số đúng, nút Đăng ký/Đăng nhập đổi tab đúng (không gửi form
  trên production). `/school-portal`, `/privacy`, `/terms`, ảnh 200.

## 2026-11-08 TRANG GIỚI THIỆU /about LÀM LẠI THEO BỐ CỤC qtm.vn + LINK "GIỚI THIỆU" Ở TRANG CHỦ — ĐÃ DEPLOY (rollback rồi deploy lại cùng ngày)

- **Chủ dự án**: "tham khảo qtm.vn thiết kế lại web chúng ta biết đâu đăng ký được startup". Đã nói rõ: đơn Claude Startups bị
  từ chối vì chưa có pháp nhân để xác minh, trang đẹp hơn không đổi được điều đó (qtm.vn cũng không ghi MST). Chủ dự án chọn:
  **trang chủ giữ trang đăng nhập gọn (02/11)**, làm lại `/about` theo bố cục qtm.vn; chỉ dùng số liệu thật, ý kiến thầy cô thật
  (chưa gửi → chưa có mục này), ảnh chụp phần mềm với dữ liệu mẫu; **chưa có pháp nhân** → ghi "dự án độc lập của người sáng lập,
  tự đầu tư", không ghi "startup thành lập 12/2025", JSON-LD bỏ `foundingDate`.
- **`web/about/index.html`** (viết lại, tiếng Việt + khối "In English") + **`web/about/about.css`** (mới, lớp `ab-*`, font Be Vietnam Pro
  vì Outfit thiếu bộ chữ tiếng Việt): thanh liên hệ trên cùng → menu dính → hero + ảnh màn Sắp xếp → dải số liệu → 6 thẻ tính năng →
  ảnh phần mềm theo tab (Yêu cầu / Phân công / In TKB, không JS thì hiện cả 3) → 4 bước bắt đầu → Về chúng tôi + bảng thông tin →
  lời mời liên hệ → chân trang 3 cột. `public-site.css` không đổi (privacy/terms vẫn dùng).
- **Số liệu trên trang đều kiểm được**: 27 loại yêu cầu (đếm menu Yêu cầu: 11 GV + 12 môn + 3 cố định + 1 giới hạn số tiết/thời điểm),
  75 lớp / ~2.200 tiết/tuần (trường lớn nhất, đã ghi từ 07/10), ⏱ 1–3 phút/lượt. **Số dùng thật** (classifier chặn Claude đọc kho
  production → chủ dự án chạy `! python scratch/about-deploy/stats.py`, chỉ đọc sqlite `mode=ro`): 79 tài khoản trường, 65 kho có ≥1 tiết
  (2.293 lớp, 61.338 tiết). Bỏ 5 kho < 10 tiết/lớp (`510b6f8ac81`, `f93cab980e1`, `4afb620fa41`, `0vt12dq6431`, `5fe3d1177b1`),
  `claudetest30` (bản sao thử), `default` (TKB 1 của Tân Phú Trung, trùng `af5ldw7i8y`) → 58 trường / 2.040 lớp / 58.532 tiết.
  Chủ dự án duyệt **số làm tròn** đăng lên dải số liệu: "Hơn 50 trường", "~2.000 lớp", "Hơn 55.000 tiết mỗi tuần" + "27 loại yêu cầu"
  (chừa chỗ cho kho thử chưa nhận ra, vd `7ff06d42ec1` 6 lớp/38 GV, `a31c3ff6fd1`, `c1619c9a521`). Bẫy của script: tên trường
  trống vì mã kho ≠ khoá registry; nhóm phiên bản bằng cắt mọi chữ số cuối (đúng hơn là `id[:10]`); đếm ô chuỗi nên là cận dưới.
- **Ảnh** `web/assets/about/tkb-{planner,rules,assignment,print}.jpg` (JPEG vì Rust `is_public_static_file` không phục vụ .webp):
  chụp từ app thật chạy cục bộ — `rust_api/target/release/tkb_rust_api.exe` (bản 17/08) với `TKB_APP_ROOT`=repo, `TKB_DB_PATH` ở
  scratchpad, cổng 2399; trường mẫu = `rust_api/fixtures/sample-data.json` (22 lớp) **đổi toàn bộ 43 tên/mã GV sang tên giả**
  (kiểm 0 mã/tên cũ còn sót), xếp bằng ▶ FET trong trình duyệt (627/627 tiết); chụp Chrome headless 2x qua CDP.
- **Trang chủ** `web/index.html`: nút "Giới thiệu phần mềm →" dưới khẩu hiệu + "Giới thiệu" ở chân trang; CSS `.auth-home .auth-about-link`
  trong `web/auth.css` (chỉ thêm). Thẻ đăng nhập/đăng ký không đổi.
- **Kiểm**: Chrome headless 1254×700 (2x) và 390×844 mobile: không tràn ngang (scrollWidth = 390), tab ảnh đổi đúng, font tiếng Việt nạp.
  `run_tests.py` cây chính: đúng 6 [MOI HONG] cũ của 02/11 (phanmon.js CRLF); worktree sạch HEAD + đúng các file này: 145 pass / 22 fail,
  "Khong co test nao moi hong so voi moc chuan". Không test nào đọc `web/about/` (chỉ `auth_mobile_layout_node` đọc `auth.css`, fail sẵn).
- **ĐÃ DEPLOY 08/11** (chủ dự án chạy `! python scratch/about-deploy/run.py`): preflight remote = đúng bản 02/11 (index `434217f1…`,
  about `6a45ee44…`, auth.css `6aab167a…`), 5 file mới MISSING → NEW; `--no-restart`, backup `/root/tkb-backups/about-20261108/`.
  Live (curl GET) khớp sha local cả 8 file (index `44df393f…`, auth.css `6096ad48…`, about `d1d96daf…`, about.css `f92c83af…`).
  Chrome hồ sơ mới: `/about` không tràn ngang (1280 và 390), Be Vietnam Pro nạp, 4 số đúng, tab hiện; trang chủ có nút Giới thiệu,
  thẻ đăng nhập còn, h1 không bị cắt. Rollback 3 file sửa: `python deploy.py files rollback about-20261108 web/index.html web/auth.css web/about/index.html`.
- **ROLLBACK 08/11** (chủ dự án tự chạy đúng lệnh rollback trên, có restart, `active`): live lại đúng bản 02/11 (index `434217f1…`,
  auth.css `6aab167a…`, about `6a45ee44…`, đã curl đối chiếu). 5 file mới (`web/about/about.css`, `web/assets/about/*.jpg`) vẫn nằm trên
  VPS nhưng không trang nào trỏ tới. Chủ dự án không nói lý do.
- **DEPLOY LẠI 08/11** (chủ dự án chạy lại `! python scratch/about-deploy/run.py`): preflight remote = bản 02/11 cho 3 file sửa, 5 file mới
  đã có sẵn (sha = local). Cùng tên backup `about-20261108` nên `cp -p` ghi lại đúng bản 02/11 vào backup → lệnh rollback ở trên vẫn đúng.
  Live khớp sha local (index `44df393f…`, auth.css `6096ad48…`, about `d1d96daf…`). **Live = repo HEAD.**

## 2026-11-08 CHERRY AGENT TRÊN MÁY KHÁC: CHROME CHẶN/HỎI QUYỀN "ỨNG DỤNG TRÊN THIẾT BỊ" (ĐÃ DEPLOY) + KÝ SỐ CHERRY.EXE

- **Chủ dự án**: "Cherry.exe trên máy khác: Chrome chặn cài đặt và đường dẫn check theo máy của tôi" → "dùng chứng chỉ ký số
  ký được không? máy khác thấy Cherry bật mà web không nhận".
- **Đường dẫn**: KHÔNG ghi cứng — `install.ps1` cài vào `%LOCALAPPDATA%\Cherry` của từng người dùng, `cherry-local://` + lối tắt
  theo thư mục đó, `cherry_local_solver.py` dò đường dẫn tương đối. `C:\Users\Cherry\…` chỉ nằm trong `co_filename` của .pyc
  (dựng ở `%TEMP%\cmnb21`), không dùng khi chạy; Cherry.exe phát trên Netlify (sha `1dc678a5…`) không chứa chuỗi đó.
- **Ký số**: Cherry.exe `NotSigned`, .pyd ortools cũng không ký → Chrome cảnh báo tải, SmartScreen, Smart App Control (Win 11 bật)
  chặn hẳn. Chứng chỉ của chủ dự án trên máy (Ban Cơ yếu Chính phủ, cá nhân công vụ THCS Củ Chi) chỉ có EKU Client Auth /
  Secure Email / Smart Card Logon — KHÔNG ký mã được. Cần chứng thư Code Signing (Azure Trusted Signing / OV-EV) — chờ chủ dự án.
- **Web không nhận Cherry**: Cherry trả đúng (GET health + preflight `Access-Control-Request-Private-Network` → 200/204 với ACAO
  tkbcherry.com + `Allow-Private-Network`). Nguyên nhân: Chrome Local Network Access — trang https phải được cho phép "truy cập
  ứng dụng và dịch vụ trên thiết bị" mới gọi 127.0.0.1; probe huỷ sau 1,5 s làm mất hộp hỏi, hộp thoại báo nhầm "hãy mở Cherry".
  Sửa bridge: `localNetworkPermissionState()` (thử `loopback-network`, `local-network-access`, `local-network`); `prompt` → probe
  127.0.0.1 chờ tới 45 s + dòng "bấm Cho phép" trong hộp; `denied` → hộp `blocked` "Chrome đang chặn Cherry Agent" chỉ đường Cài
  đặt trang web (không nút tải/mở). Test toggle 39/39, `run_tests.py` không mới hỏng. Commit 2a44ae2 (nhánh agent 071e20c). CHƯA
  thử trên Chrome thật (extension mất kết nối). Deploy `scratch/agent-deploy/run.py`: preflight `fbd346db…`, live `f323d790…`,
  backup `/root/tkb-backups/agent-lna-20261108/`.

## 2026-11-02 ĐẨY NỐT 17 FILE SỬA DỞ LÊN GITHUB (CHƯA DEPLOY gì thêm)

- **Chủ dự án**: "tôi muốn đưa dự án này lên github". Repo đã có sẵn (`thoikhoabieucherry/TKBCherry`, riêng tư),
  nhánh làm việc `cursor/cherry-v3-speed-teacher-stats-a03d` đã đẩy đủ; chủ dự án chọn commit 17 file sửa dở của các phiên
  trước và đẩy lên nhánh này. **Không đụng `main`** (main trên GitHub dừng ở 20/08, sau nhánh này 61 commit; 28 commit FET
  19–20/08 chỉ nằm trên main, chưa từng được gộp).
- Nội dung commit (không phải viết mới phiên này):
  - `tools/cloud-run/*` + `solver_runtime/tests/test_cloud_run_deploy_assets.py`: mặc định đổi sang project
    `project-8ce8bf36-3ba7-430f-8f7`, service `cherry-solver`, repo ảnh `cherry-images`, SA `cherry-invoker@…`/`cherry-runtime@…`,
    nhãn `app=cherry`; `deploy.ps1` không còn vùng phụ mặc định, lần tạo service đầu bỏ `--no-traffic`, cấp quyền invoker
    TRƯỚC canary; `deploy-and-pin.ps1` đọc URL từng vùng bằng `gcloud run services list` thay vì ghi cứng.
    **Phiên này KHÔNG xác minh** service đó đang chạy hay VPS đã ghim sang project này — `CURRENT_STATE.md` vẫn ghi project
    `29291bde` (bị đình chỉ 23/10). Kiểm tra trước khi chạy bất kỳ script deploy nào.
  - `web/pages/tkb-constraints.js` (+ cache-bust trong `sapxep.html`): Yêu cầu cố định của lớp không còn "vay" số tiết
    từ khối khác khi Tiết chuẩn đúng khối = 0 (lớp 9/10 trường `0adf9782362`: CNghệ khối 9 = 0 → tổng 31 thay vì 30), có test
    mới trong `planner_subject_limit_semantics_node.test.js`. **Chưa rõ đã deploy** — so bản live trước khi deploy.
  - 2 test mới `planner_ghep_session_limit_node` (01/10) và `planner_ghep_teacher_grade_label_node` (30/09);
    `.gitignore` chặn `/scratch_*`, `/cloud_e2e_result*.json`, `/cloud_run_profiles*.json` ở gốc; AGENTS.md thêm luật giữ
    gốc repo sạch; archive tháng 9 bổ sung các mục 30/09 bị sót.
- Đổi 6 file từ CRLF về LF trước khi commit (chỉ mục là LF) để diff chỉ còn thay đổi thật (904+/59−).
- **Bẫy test trên máy này**: `run_tests.py` ở thư mục làm việc báo 6 "MỚI HỎNG" (`planner_constraint_audit_stale_class`,
  `planner_fixed_chao_co_survives_load`, `planner_ghep_stale_pin`, `planner_lesson_block_impossible_min`,
  `planner_lesson_block_standard_periods`, `planner_teacher_code_nfc`) vì `web/pages/phanmon.js` trên đĩa là CRLF
  (`git ls-files --eol` = `i/lf w/crlf`). Kiểm chứng: worktree sạch của HEAD + áp đúng 17 file này → "Khong co test nao moi
  hong so voi moc chuan".

## 2026-11-02 TRANG CHỦ TRỞ LẠI TRANG ĐĂNG NHẬP GỌN (như trước 07/10) — ĐÃ DEPLOY (cả vá tiêu đề bị cắt)

- **Chủ dự án**: "tôi đã thiết kế trang chủ để xin startup của claude ko được, giờ trang chủ rối quá thiết kế lại cho tôi như cũ cũng được".
- **`web/index.html`** = bản `9637942` (trước landing 07/10: logo + khẩu hiệu + hình minh hoạ bên trái, thẻ đăng nhập bên phải, chân trang
  một dòng). Thẻ đăng nhập/đăng ký/quên mật khẩu giống hệt từng byte (đã `cmp`), cùng script + CSS, chỉ bớt `public-site.css`; `auth.css` không
  đổi từ 08/2026 nên giao diện đúng bản cũ. Bỏ nav, hero tiếng Anh, chip, 4 mục Product/About/Technology/Contact, JSON-LD.
- **Khác bản cũ, cố ý**: (1) giữ meta description/canonical/OG bằng tiếng Việt (ẩn; để Google và xem trước link Zalo không mất mô tả);
  (2) chân trang thêm "Bảo mật · Điều khoản" vì form đăng ký thu email + SĐT.
- **`/about`, `/privacy`, `/terms` giữ nguyên**, chỉ đổi thanh trên: bỏ `/#product`, `/#technology`, `/#contact` (sẽ thành link chết), thêm
  Privacy/Terms; "Đăng nhập" `/#authCard` vẫn đúng vì trang cũ có `id="authCard"`. `/about` không còn link từ trang chủ, vẫn trong sitemap.
- **Lệch key live**: live đang nạp `shared/auth.js?v=20260823-default-first-v1`, repo `?v=20260904-grant-1year-v1` (test
  `auth_activation_grant_one_year_node` cần key mới). Deploy bản repo vẫn nhận đúng file `auth.js` đang có trên VPS (query chỉ để bust cache,
  static `no-store`). `auth.js` live KHÁC local (sha `dc379744…` vs `3e3d833b…`) — chuyện cũ, phiên này không đụng.
- **Kiểm**: Chrome headless qua `http.server` cổng 8799: 1366×768, 1920×1080, và 390×1400 trong iframe (`--window-size` dưới ~500 px bị Chrome
  chạy ẩn nới rộng rồi cắt ảnh, không phải lỗi trang). Live `/about`, `/privacy`, `/terms` đối chiếu `curl` + bỏ CR khớp HEAD (about = HEAD + "Team").
- **Test** (lượt vá tiêu đề chạy lại nhóm `js-e2e`, nhóm duy nhất đọc `auth.css`: cùng 6 test, không thêm): `run_tests.py` 140 pass / 27 fail, báo 6 [MOI HONG] (`planner_constraint_audit_stale_class`, `planner_fixed_chao_co_survives_load`,
  `planner_ghep_stale_pin`, `planner_lesson_block_impossible_min`, `planner_lesson_block_standard_periods`, `planner_teacher_code_nfc`): KHÔNG do việc này —
  `web/pages/phanmon.js` ở cây chính là CRLF, bộ cắt hàm của test cần LF ("khong thay ket thuc ham"). Worktree sạch HEAD + đúng 4 file HTML mới: cả 6 pass,
  `auth_activation_grant_one_year` pass. `auth_mobile_layout` (key `auth.css`) fail sẵn theo `docs/test-baseline.json`.
- **Lỗi cũ thấy trên cả bản live, KHÔNG sửa**: ô tick "Ghi nhớ đăng nhập" nằm tách dòng với nhãn của nó và "Quên mật khẩu?" xuống dòng riêng
  (`.auth-form label{display:grid;width:100%}` thắng `.auth-remember`). Trên điện thoại phải vuốt qua hình minh hoạ mới tới thẻ đăng nhập (đúng bản cũ;
  landing 07/10 từng đưa thẻ lên màn đầu).
- **ĐÃ DEPLOY 02/11** (chủ dự án chạy `!` — classifier chặn Claude, kể cả `preflight`): `python scratch/homepage-deploy/run.py`, 4 file HTML,
  `--no-restart`, backup `/root/tkb-backups/homepage-20261102/`. Rollback `python deploy.py files rollback homepage-20261102 <4 file>` (có restart).
  Preflight remote khớp bản đã đối chiếu; live sha = local cả 4 (index `434217f1704d45e9`, about `6a45ee44b697a2a9`, privacy `5c60cf2d58f59b6b`,
  terms `be9467f0fb4ba661`); `/`, `/about`, `/privacy`, `/terms`, `/robots.txt`, `/sitemap.xml`, `/api/health` 200.
- **Kiểm live bằng CDP** (Chrome chạy riêng, không gửi form; `scratchpad/live_check.mjs`): 1366×768, 1920×1080, 390×844 mobile thật: 0 phần tử landing, không tràn
  ngang, tab Đăng ký/Đăng nhập + Quên mật khẩu/Quay lại đổi đúng, `/#authCard` cuộn tới thẻ, 3 trang phụ hết link chết, 0 JS exception. Log lỗi duy nhất: 401
  `/api/auth/registry` khi chưa đăng nhập (`shared/auth.js` gọi; script không đổi so với trước).
- **LỖI PHÁT HIỆN SAU DEPLOY — tiêu đề "Cherry Schedule" mất chữ r** ở LẦN TẢI ĐẦU, mọi màn ≥1100 px (tái hiện chắc chắn: hồ sơ Chrome mới + tắt cache; 1366: khung 330 / chữ 365,4).
  `auth.css` `@media ≥1100` có `.auth-home .auth-panel-brand h1 { max-width: 12ch }`: `ch` tính theo font dự phòng khi Outfit (Google Fonts, `display=swap`) chưa về và Chrome
  giữ nguyên số đó sau khi font về; chữ gradient (`background-clip: text`) không vẽ ngoài khung nên mất chữ cuối. Có font trong cache hoặc đổi cỡ cửa sổ thì đúng — vì vậy ảnh thử đầu
  (1366, 1920) không lộ. Có sẵn từ 08/2026; landing 07/10 che đi bằng `.auth-landing .auth-panel-brand h1` trong `public-site.css`, khôi phục trang cũ làm nó lộ lại.
  **Vá**: `max-width: none` (h1 vốn `nowrap` + `width: max-content`, rule chỉ áp `.auth-home` = trang chủ, không đụng school-portal/super-admin, `?v=` không cần đổi vì static `no-store`).
  Sau vá, cold load bản local: 1100/1366/1536/1920 khung = chữ. Test mới trong `auth_mobile_layout_node`: "homepage title width never depends on ch units" (bắt đúng CSS cũ, pass CSS mới).
  **ĐÃ DEPLOY 02/11** (chủ dự án chạy `!`): `python scratch/homepage-deploy/run2.py`, `web/auth.css`, `--no-restart`, backup `/root/tkb-backups/homepage-title-20261102/`,
  remote trước `5f0e12ec…` (= local trước khi vá), live sau `6aab167aa96e5281` khớp. Cold load live (hồ sơ mới, tắt cache): 1100/1366/1536/1920 khung = chữ, `max-width: none`;
  chạy lại `live_check.mjs` không đổi; `/school-portal`, `/super-admin`, `/api/health` 200. Rollback `python deploy.py files rollback homepage-title-20261102 web/auth.css` (có restart).
- **Handoff**: chuyển 28 mục tháng 10 sang `docs/archive/PROJECT_HANDOFF_2026-10-01_2026-10-31.md`, gồm mục 26/10 trước đó chưa từng được commit.
- **Còn trong cây làm việc** (có từ 26/10, không phải việc phiên này, chưa commit): `.gitignore`, `AGENTS.md`, `tools/cloud-run/*`,
  `web/pages/sapxep.html`, `web/pages/tkb-constraints.js`, 2 test ghép; mục 26/10 ghi là đã commit nhưng không thấy trong lịch sử nhánh.

## 2026-11-01 TKBCHERRY.COM: Ô ⏱ 1 / 2 / 3 PHÚT CHO CHERRY + TỐI ƯU (ĐÃ DEPLOY) + DỪNG = DỪNG HẲN

- **Chủ dự án**: "thêm yếu tố thời gian: mặc định 2 phút, tùy chọn 1 đến 3 phút… bấm dừng thì dừng hẳn hay CP-SAT vẫn tối ưu?".
- **Bridge** (`initSolveBudgetUi`, chỉ trang có máy chủ — Netlify có ô riêng trong overlay `local-planner.js`): `<label
  #tkbSolveBudgetWrap.tkb-solve-budget>` "⏱" + `<select #tkbSolveBudget>` 60/120/180 s ngay sau `#plannerTestWrap` (menu Tối ưu);
  đặt `window.__TKB_ENGINE_BUDGET_SECONDS` + `__TKB_ENGINE_FOCUS_BUDGET_SECONDS` (bridge đã đọc sẵn — override thắng mặc định
  Cherry 180 s / Tối ưu 120 s), nhớ ở `localStorage.TKB_ENGINE_BUDGET_SECONDS_V1` (giá trị lạ làm tròn về 1/2/3 phút). Áp cả Agent
  lẫn máy chủ, cả Mac; ẩn trong lưới nút điện thoại (vẫn 2 phút). **Cherry mặc định 180 → 120 s** theo chủ dự án.
- **Dừng**: engine đọc `TKB_SOLVER_STOP_FILE` mỗi 0,5 s (`Constructor._stop_requested`), lượt CP-SAT hỏi `stop_check` ở
  callback lời giải (lượt chưa có lời giải chạy hết `time_limit` 2–3,2 s) → dừng trong ~1–3 s, trả lịch tốt nhất; bridge chỉ áp
  khi tốt hơn. KHÔNG tối ưu tiếp sau khi Dừng.
- **Test**: toggle 37/37 (harness thêm `plannerTestWrap`, `fire(type)`; đếm riêng công tắc bằng `switchInserted`), `run_tests.py`
  không test mới hỏng. Commit bdd9b89 (nhánh agent 2d48513). Deploy `scratch/agent-deploy/run.py`: preflight remote
  `4b48ce53…`, live `fbd346db…` khớp, backup `/root/tkb-backups/agent-budget-20261101/`.
- **Đề xuất chờ chủ dự án chọn**: (1) vùng CP-SAT lớn khi còn buổi 1 tiết (sửa yếu điểm xếp mới trường > 60 lớp), (2) nhiều vùng
  CP-SAT song song (8 vs 16 luồng không khác → lõi rảnh), (3) nháp FET cho cả chế độ máy chủ.

