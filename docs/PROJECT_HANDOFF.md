# PROJECT HANDOFF — TKBCherry

> Nhật ký bàn giao theo từng phiên làm việc, mục mới nhất ở trên cùng.
> Tóm tắt trạng thái hiện hành: xem [`CURRENT_STATE.md`](CURRENT_STATE.md).
> Các mục trước tháng 10/2026 đã chuyển vào `docs/archive/`:
> - [`2026-09`](archive/PROJECT_HANDOFF_2026-09-01_2026-09-30.md)
> - [`2026-08-10 – 2026-08-31`](archive/PROJECT_HANDOFF_2026-08-10_2026-08-31.md)
> - [`2026-07-28 – 2026-08-09`](archive/PROJECT_HANDOFF_2026-07-28_2026-08-09.md)
> Chính sách: đầu mỗi tháng, chuyển các mục của tháng trước vào `docs/archive/`.

## 2026-10-13 WEBSITE CÔNG KHAI KHỚP ĐƠN CLAUDE STARTUPS (ngày thành lập, tên công ty, cách dùng Claude, email) — ĐÃ DEPLOY

- **Chủ dự án**: đơn Claude Startups (nộp từ contact@tkbcherry.com, tổ chức "Cherry Software") lần trước không được duyệt; yêu cầu
  chỉnh website cho khớp đơn và thêm email liên lạc. Đơn trước ghi Company website = trang của một trường học (phải là tkbcherry.com).
- **Sửa `web/index.html` + `web/about/index.html`** (không đụng thẻ đăng nhập, `auth.js`, CSS, privacy/terms):
  - Founded `2026` → **December 2025** theo đơn chủ dự án tự khai (JSON-LD `foundingDate: "2025-12"`, chip hero, bảng facts, đoạn tiếng Việt).
  - Thêm tên công ty **Cherry Software**: dòng Company trong bảng facts, JSON-LD Organization `name` = Cherry Software +
    `alternateName` = Cherry Scheduler. Không dùng `legalName` — chưa xác nhận pháp nhân.
  - Founder: "Founder & CEO" + link LinkedIn (JSON-LD `sameAs`) + email founder **an@tkbcherry.com** (JSON-LD `founder.email`) —
    chủ dự án nộp lại đơn bằng email này vì đơn dưới contact@ đã bị từ chối; `contact@tkbcherry.com` vẫn là email liên lạc chung.
  - Technology: thêm đoạn stack thật (Rust, OR-Tools CP-SAT trên Cloud Run, đã kiểm chứng 75 lớp / 125 GV / ~2.200 tiết); ghi chú
    **How we build** (một founder + Claude Code) và **Exploring** (onboarding bằng Claude API: nhập bảng tính, yêu cầu GV → ràng buộc,
    giải thích bất khả thi — ghi rõ "not part of the product yet"). `/about` có mục "How we build" cùng nội dung.
  - Email: chip `Contact: contact@tkbcherry.com` ở hero trang chủ (≥ 900px, chip vốn ẩn trên điện thoại) và dòng Contact đầu `/about`.
- Giữ nguyên tắc 07/10: không ghi khách hàng/doanh thu/nhà đầu tư/pháp nhân; Claude chưa nằm trong đường xử lý production.
- **Kiểm**: JSON-LD parse được; chụp Edge headless bản local (hero, About, Technology, `/about`) bố cục ổn;
  `auth_activation_grant_one_year_node` 4/4; `auth_mobile_layout_node` fail sẵn (mốc chuẩn = false, khoá `auth.css`).
  `run_tests.py`: "mới hỏng" 7 test `planner_*` — lỗi sẵn, fail y hệt trên worktree HEAD sạch và không test nào đọc hai trang này.
- **Deploy — ĐÃ lên live 13/10**: trước deploy, live `index.html` là biến thể 07/10 (sha256 `6b459be7…`, khoá `shared/auth.js?v=20260823-default-first-v1`
  vì `auth.js` live chưa phải bản 1 năm) ⇒ dựng worktree sạch `<scratchpad>/wt` với index.html = repo nhưng **giữ khoá live**
  (sha256 `2704a649…`, 26426 B) + about (sha256 `cd6babea…`, 7618 B). `deploy.py files preflight` khớp bản live; lệnh
  `deploy.py files deploy public-site-20261013 --no-restart web/index.html web/about/index.html` **bị classifier chặn "Production Deploy"**
  → chủ dự án chạy bằng `!` (không restart): cả 2 file `BACKED`, backup `/root/tkb-backups/public-site-20261013/`. Kiểm live:
  `/`, `/about`, `/about/` = 200; sha256 khớp (`2704a649…`, `cd6babea…`); thẻ `#authCard` còn nguyên, khoá `auth.js` live giữ nguyên.
  Rollback: `deploy.py files rollback public-site-20261013 web/index.html web/about/index.html` (lệnh này CÓ restart dịch vụ).
  Khi deploy `auth.js` 1 năm thì deploy kèm `index.html` của repo (khoá mới).
- **Kết quả đơn (13/10 trưa)**: đơn nộp bằng an@tkbcherry.com vẫn **không được duyệt** — thư ghi "founded in the last five years or
  funded in the last two… or we couldn't verify it from the details in the application". 12/2025 nằm trong khung ⇒ nhánh "không xác minh được".
- **VIỆC MỞ — `HEAD /` và `HEAD /about` trả 404** (GET 200; `HEAD /robots.txt` 200 vì nginx phục vụ). Đo thẳng backend
  `127.0.0.1:1010`: HEAD 404, GET 200 ⇒ Rust chỉ route GET. Công cụ kiểm tra tự động dò bằng HEAD sẽ thấy website "chết".
  Hướng sửa nhẹ nhất (CHƯA làm, chưa thử `nginx -t`): trong `/etc/nginx/sites-available/tkbcherry` thêm
  `map $request_method $tkb_upstream_method { default $request_method; HEAD GET; }` ở đầu file và
  `proxy_method $tkb_upstream_method;` trong `location / {` (nginx 1.24 nhận biến) — hoặc sửa gốc ở Rust (coi HEAD như GET cho
  file tĩnh, cần build + restart). Phiên này classifier chặn cả việc viết script vá nginx lẫn chạy dry-run ⇒ chờ chủ dự án quyết.
- **Ghi nhận khác**: GET từ bên ngoài (hạ tầng ở Mỹ) đọc được đủ tên công ty/founder/ngày/email; `www` và http→https ổn; MX =
  Google; **chưa có bản ghi SPF/DMARC**. Tìm kiếm web không ra kết quả nào về "Cherry Software"/tkbcherry (trang công khai mới có
  từ 07/10, chưa được lập chỉ mục); website không có mã số đăng ký kinh doanh.
- **Chủ dự án xác nhận 13/10: CHƯA đăng ký kinh doanh** (Cherry Software chưa có pháp nhân). Đơn hỏi "Month and year you
  incorporated" nên chưa có gì để chương trình xác minh ⇒ không nộp lại cho tới khi có đăng ký thật. Website vẫn theo nguyên tắc 07/10
  (không ghi pháp nhân chưa có): dòng "Company: Cherry Software" thêm sáng 13/10 nên đổi nhãn cho khỏi hiểu là công ty đã đăng ký —
  đã đề xuất, chờ chủ dự án quyết.

## 2026-10-10 (tiếp) IN TKB → «TKB PHÒNG»: XUẤT EXCEL MỖI PHÒNG MỘT BẢNG — ĐÃ DEPLOY

- **Chủ dự án** (sau khi có vạch màu phòng): «thêm 1 mục xuất phòng ở phần In TKB thể hiện từng phòng».
- **Hành vi mới**: menu Yêu cầu → **In TKB → TKB phòng** (ngay sau «TKB giáo viên»; `data-rb-print="rooms"` → `handlePrintTKBOption("rooms")`
  → `runPrintExport("exportRoomTKBExcel", …)`). Ra file `phongNN<ddmmyyyy>.xlsx`, sheet `PHONG`, A4 dọc: tiêu đề trường / «THỜI KHÓA BIỂU THEO PHÒNG» /
  TKB số + ngày áp dụng, rồi **mỗi phòng một bảng** Buổi/Tiết × Thứ 2–7, ô ghi «Lớp - Môn - GV». Dòng tên phòng «Phòng 1 · Phòng Tin học · Địa điểm 1 · 39 tiết»
  tô đúng màu vạch cạnh phải trên web (hồng / xanh ngọc / nâu…, cạnh trái đậm), ô có tiết nền nhạt cùng màu, ô trống trắng.
- **Phòng lấy từ hai nguồn** (`allRoomSchedulePayloads`, `web/pages/tkb-student-excel-export.js`): (1) phòng bộ môn `DATA.tkbSubjectRooms` —
  hỏi đúng hàm của trang Sắp xếp (`tkbSubjectRoomGroups`, `tkbEntrySubjectRoom({classId, thu, buoi, ti})`) nên phòng trong file = phòng của vạch màu;
  (2) phòng gắn theo Lớp|Môn (`getRoomForClassMon`, chế độ xem Phòng) cho tiết không thuộc nhóm phòng bộ môn. Thứ tự: phòng bộ môn theo thứ tự khai báo →
  bảng «<nhóm>: tiết chưa có phòng» (đỏ) nếu nhóm đó hết phòng → phòng gắn theo Lớp|Môn theo tên. Tiết hết phòng **không bị giấu**; dòng trạng thái
  ghi «còn N tiết chưa có phòng». Hai GV khác nhau cùng giờ một phòng (chỉ xảy ra với phòng gắn theo Lớp|Môn) → ô đỏ đậm, mỗi mục một dòng.
  Trường chưa khai phòng nào → báo «Trường này chưa khai phòng nên chưa có TKB phòng để xuất.», không tạo file.
- **Tiết học chung nhiều lớp** (cùng GV, cùng môn, cùng giờ) gộp một mục: «6A10, 6A12, 6A15» dòng trên, «THQT - Ti.Hào» dòng dưới. Mục dài hơn 24 ký tự
  tách hai dòng, ô đó xuống dòng và hàng cao lên theo số dòng ước lượng (16 ký tự/dòng, cố ý dư để không bao giờ cắt chữ); ô ngắn in một dòng + co chữ.
- **Kỹ thuật Excel đáng nhớ**: (a) thư viện `xlsx-js-style` (`web/vendor/xlsx.min.js`) **không ghi `shrinkToFit`** — mọi `shrink:true` trong các mẫu cũ
  là vô tác dụng; riêng mẫu phòng `buildXlsxBlob` chèn `shrinkToFit="1"` vào `xl/styles.xml` cho kiểu ô không xuống dòng (`built.shrinkToFit`,
  `addShrinkToFitXml`). (b) Trang cao thấp khác nhau nên ngắt trang theo hàng chỉ định: `print.rowBreaks` → `buildRowBreaksXml(pageCount, pageRows, explicitRows)`;
  sang trang khi đủ 4 phòng hoặc trang quá 780 pt, trang sau có lại tiêu đề. (c) `print.centered: 'horizontal'` = chỉ canh giữa ngang.
  Ba chỗ này chỉ bật cho mẫu phòng; mẫu lớp / GV / toàn trường ra XML y như trước (có test đối chiếu).
- **Chỉ đọc**: mục xuất phòng KHÔNG gọi `saveStore({force:true})` (các mục xuất khác vẫn gọi như cũ).
- **Test**: `e2e_tests/excel_room_export_node.test.js` (11 ca: thứ tự phòng, nội dung ô, GV có phòng riêng, tiết học chung, hết phòng, trùng phòng,
  trường chưa khai phòng, bố cục + màu, sang trang, file .xlsx thật qua JSZip, các mẫu khác không đổi, menu + định tuyến). `python run_tests.py` trọn bộ: **135 pass / 29 fail / 164** (601 s); «mới hỏng» vẫn đúng 7 test CRLF đã biết của planner (chạy lại 7 test đó trên HEAD sạch và trên cây có thay đổi: cùng số pass/fail), không còn test nào khác; `industry_database_export_node` hỏng sẵn 1 ca vì chuỗi `?v=` cũ trong `sapxep.html` (có trong mốc chuẩn).
- **Kiểm trên dữ liệu thật**: `node scratch/tpt4/tap/room_xlsx_real.js <kho.json> <gốc repo> <out.xlsx>` chạy đúng mã web trên kho `af5ldw7i8y4`:
  3 phòng 39 / 21 / 30 tiết = 90 ô giờ (114 ô lớp sau khi gộp tiết chung), 0 tiết chưa có phòng. Mở file bằng **Excel thật** (COM) in ra PDF: 1 trang,
  vừa khổ, chữ không bị cắt; bản thử 7 bảng (2 nhóm phòng, có bảng hết phòng) ra 3 trang, ngắt đúng chỗ. Chưa bấm được trên trình duyệt thật
  (tiện ích Chrome vẫn không kết nối) — đường menu → hàm xuất chỉ mới kiểm bằng test nguồn.
- **Deploy**: `python deploy.py files deploy room-export-20261010 --no-restart web/pages/tkb-student-excel-export.js web/pages/tkb-constraints-menu.js web/pages/phanmon.js`
  chạy **từ worktree sạch tại HEAD** (backup `/root/tkb-backups/room-export-20261010`, không restart, không đụng DB). Lý do: `tkb-student-excel-export.js`
  ở máy còn việc dở 29/09 của phiên khác (`ghepMultiTeacherLabel`, chưa deploy) — bản đưa lên = bản live + đúng phần mục phòng; commit cũng chỉ gồm
  phần này (`git update-index --cacheinfo`), việc dở kia vẫn nằm nguyên trong cây làm việc.
- **Còn mở**: Excel TKB giáo viên / toàn trường chưa có vạch phòng; chưa có lựa chọn «mỗi phòng một trang»; Cherry/Tối ưu vẫn chưa biết sức chứa
  phòng bộ môn (nếu xếp quá phòng thì file có bảng «tiết chưa có phòng»); vẫn chưa có giao diện nhập `tkbSubjectRooms`.

## 2026-10-10 VẠCH MÀU CẠNH PHẢI Ô TKB GIÁO VIÊN THEO PHÒNG BỘ MÔN (`DATA.tkbSubjectRooms`) — ĐÃ DEPLOY

- **Chủ dự án** (THCS Tân Phú Trung, khuya 09/10): «Phòng Tin học chia làm 3 phòng, thầy Ân luôn dạy Phòng 3 (ở địa điểm 2),
  2 phòng còn lại địa điểm 1. Thứ 2 và thứ 6 thầy Thuận dạy trái buổi nhưng ở địa điểm 1. Tô màu cạnh bên phải để biết từng phòng».
- **Hành vi mới** (trang Sắp xếp, cả 3 chỗ vẽ ô TKB giáo viên: bảng chính, cập nhật tại chỗ, bảng GV phụ): ô có tiết của môn dùng
  phòng bộ môn có thêm **vạch màu cạnh PHẢI** theo phòng (`td.tkb-room tkb-room-1..6`, `::after`; vạch địa điểm cạnh trái `tkb-loc` giữ nguyên),
  tooltip ghi «Địa điểm · Phòng», thêm thuộc tính `data-room`. Hết phòng → vạch **sọc đỏ** `tkb-room-x` («… : thiếu phòng»).
  Địa điểm của tiết (vạch trái) lấy theo **phòng bộ môn** nếu có (thầy luôn dạy Phòng 3 thì vạch trái là địa điểm của Phòng 3 dù lớp ở địa điểm khác).
  Màu: Phòng 1 hồng `#eb2f96`, Phòng 2 xanh ngọc `#13c2c2`, Phòng 3 nâu `#5b3a29` (4–6: `#a0d911`, `#2f54eb`, `#595959`).
- **Cấu hình** (khoá kho mới, tuỳ chọn; trường không khai thì mọi thứ y như cũ):
  `DATA.tkbSubjectRooms = [{name, subjects:[mã/tên môn hoặc nhãn dòng Dạy ghép], rooms:[{name, diadiem}], teacherRoom:{mãGV: tên phòng},
  teacherLocation:[{teacher, days:[thuN], buoi?, diadiem}], offSessionPrefer: địa điểm ưu tiên cho tiết trái buổi}]`.
  **Chưa có giao diện nhập** — hiện ghi thẳng vào kho (đã ghi cho `af5ldw7i8y4`: 3 phòng Tin học, `Ti.Ân` → Phòng 3, `Ti.Thuận` thu2/thu6 → Địa điểm 1).
- **Cách chia phòng** (`tkbSubjectRoomPlan`, `web/pages/phanmon.js`): phòng KHÔNG lưu theo từng tiết, mỗi lượt vẽ tự chia lại (bộ nhớ đệm chỉ sống
  trong một lượt vẽ, `setTimeout 0`). Đơn vị = (nhóm phòng, GV) trong một ô giờ — các lớp của một tiết học chung dùng chung phòng. Phòng được phép:
  GV có `teacherRoom` → đúng phòng đó; GV có `teacherLocation` khớp ngày → phòng ở địa điểm đó; lớp học **buổi chính** (buổi mở nhiều ô hơn) →
  phòng cùng địa điểm với lớp; **tiết trái buổi** → phòng nào cũng được, ưu tiên `offSessionPrefer`. Ghép phòng bằng thử-lùi trong từng ô giờ,
  GV đang giữ phòng từ tiết liền trước được xếp trước (ở yên một phòng cả buổi nếu được).
- **Chỉ là hiển thị**: không đổi lịch, không đổi `tkb-constraints.js`, bridge hay engine. Cherry/Tối ưu v3 **chưa biết** sức chứa phòng bộ môn —
  bấm Cherry có thể xếp quá số phòng, khi đó ô hiện sọc đỏ. Đường phòng cũ (`DATA.phong`, `pccmRoomMatrix`, `tkbLessonRooms`) không đụng tới:
  `pccmRoomMatrix` vẫn bị `app.js ensureDataShape` xoá mỗi lần mở trang Dữ liệu và `tkbLessonRooms` bị ghi đè sau mỗi lượt áp kết quả, nên không dùng
  được để giữ phòng. Excel (`tkb-student-excel-export.js`) chưa có vạch phòng (file đó đang có việc dở chưa deploy của phiên khác).
- **Giữ hợp đồng cũ**: dòng `sched[thu].sang[ti].push({classId, classDisplay, mon, room, fixed: isShownFixed(v)});` không đổi
  (`planner_ghep_pin_survives_apply` đối chiếu nguyên văn); vị trí ô (`thu/buoi/ti`) được đóng dấu một lần ở cuối `buildTeacherSchedule`.
  `tkbEntryLocation(e)` với ô không mang vị trí (Excel) chạy như trước.
- **Test**: `e2e_tests/planner_subject_rooms_node.test.js` (7 ca: buổi chính theo địa điểm, hai lớp cùng giờ khác phòng, giữ phòng tiết liền nhau,
  quá phòng → đúng một ô sọc đỏ, phòng riêng của GV + địa điểm theo phòng, trái buổi + địa điểm theo ngày, trường không khai thì như cũ).
  `python run_tests.py --group js-e2e|js-guard|js-syntax`: «mới hỏng» vẫn đúng 7 test CRLF đã biết; chạy 11 test đang hỏng trên cây gốc (bản live
  trước khi sửa) và cây mới cho cùng số pass/fail. Chạy thật mã chia phòng trên kho `af5ldw7i8y4` trong Node: 0 ô thiếu phòng.
  `python run_tests.py` trọn bộ: **132 pass / 31 fail / 163** (726 s, máy đang chạy job giải của phiên khác): ngoài 7 test CRLF còn báo «mới hỏng»
  `py-solver/test_engine_v3_cpsat_lns` (`test_stop_check_stops_quickly`: 2,42 s > 2,0 s) và `test_engine_v3_co_teacher_lessons` — cả hai là test đo
  thời gian, chạy lại riêng đều đạt; phiên này không sửa file Python nào. Chưa nhìn vạch màu trên trình duyệt thật (tiện ích Chrome không kết nối).
- **Deploy**: `python deploy.py files deploy subject-rooms-20261010 --no-restart web/pages/phanmon.js web/pages/phanmon.css`
  (backup `/root/tkb-backups/subject-rooms-20261010`, không restart, không đụng DB). Trước khi sửa: bản local của hai file = bản live (md5).
  File tĩnh trả `Cache-Control: no-store` nên không cần đổi `?v=`.

## 2026-10-09 (tiếp) TKB 4 TÂN PHÚ TRUNG: SỬA TĂNG BUỔI 1 TIẾT, 8 → 6 (ĐÃ GHI)

- **Phản hồi**: «lẽ ra 1 tiết/buổi phải ít hơn … coi lại». Hai lượt trước đã gom ưu tiên cá nhân nhưng
  đẩy buổi lẻ sang GV khác: toàn trường từ 6 ban đầu lên 8. Đã nhận rõ đánh đổi này và tối ưu lại toàn trường.
- **Kết quả đã ghi**: buổi 1 tiết **8 → 6**, tổng buổi GV **683 → 680**, tổng ô trống giữa buổi **102 → 88**,
  trống ≥2 giữ **0**. Cô Lan giữ **5 buổi / 0 buổi lẻ**, nay **0 ô trống** (trước 1); cô Trang giữ **5 buổi / 0 ô trống**;
  Hải–Nhơn giữ **0 buổi / 0 tiết trùng**. Gỡ buổi lẻ phát sinh của `CN.Liên` và `SĐ.Thắm`.
  Đổi cơ sở ngoài Âm nhạc/Mỹ thuật **15 → 14 lượt**; vẫn chỉ ngoại lệ chưa xử lý là hai ô cố định thầy Ân tiết 4–5 sáng T2.
- **Giới hạn buổi lẻ còn lại**: 4 buổi chiều của `Nhạc.Dương` (T2–T5 chỉ được dạy tiết 1 theo nghỉ GV;
  9 tiết chiều, T6 chứa tối đa 5). `A.Hải` và `A.Khánh` mỗi người chỉ có 3 tiết sáng, đều môn Anh ở một lớp
  (`8A8`, `8A2`), giới hạn 2 tiết/buổi, khung còn lại của các lớp này không thể tự mở do nghỉ/cố định.
  Vì vậy mỗi người còn ít nhất một buổi lẻ. Sáu buổi hiện tại đạt sàn này khi giữ nguyên phân công, khung và luật;
  không tuyên bố tối ưu toàn cục các chỉ số khác.
- **Cách tìm**: các bản sao/script trong `scratch/tpt4/location_20261009/single*/` (gitignore).
  LNS ban đầu về 7 buổi lẻ; vùng rộng không tìm được nghiệm trong thời gian thử. Dùng lịch ban đầu của 9A17/9A18
  làm gợi ý (chưa hợp lệ: 5 xung đột), mở thêm các lớp xung đột và lớp của CN.Lý để sửa bằng CP-SAT;
  `single/seed_local.py` tìm nghiệm hợp lệ 6 buổi lẻ. Bản chốt riêng ở `single_final/`, không bị các lượt thử ghi đè.
- **Kiểm tra / ghi**: đủ **2.279/2.279 tiết**, giữ **2.746 ô nghỉ/cố định**, đổi 325 ô ở 57 lớp;
  validator JS production **0 vi phạm**, audit độc lập đạt theo lớp/môn, tiết đôi, lịch GV và di chuyển.
  Ghi transaction có cổng SHA256 toàn kho, chỉ đổi `tkb`, cập nhật timestamp/revision và gỡ cache solver cũ.
  Backup `/root/tkb-recovery/tpt4-single-20261009-203522/`, `_updatedAt=_lastModified=tkbScheduleRevision=1791552923865`.
  Đọc lại production khớp chính xác lưới ứng viên, dữ liệu khác được giữ; validator trên bản đọc lại = 0.
- **Phạm vi**: không sửa mã nguồn/test, không deploy/restart. Dùng kết quả `python run_tests.py` đã chạy trong cùng phiên
  (133 pass / 29 fail / 162 module, 7 "mới hỏng" CRLF đã biết), kiểm tra riêng toàn bộ dữ liệu vừa thay trước và sau ghi.

## 2026-10-09 (tiếp) TKB 4 TÂN PHÚ TRUNG: GOM CÔ HƯƠNG LAN `A.Lan` 6 → 5 BUỔI (ĐÃ GHI)

- **Phản hồi**: «cô Hương Lan không tối ưu vậy? … phải tối ưu …». Đúng GV là Nguyễn Thị Hương Lan, mã `A.Lan`
  (không phải `T.HLoan`, cô Hồng Loan). Lịch xuất phát: 21 tiết, **6 buổi**, hai buổi sáng T4/T5 chỉ 1 tiết.
- **Kết quả**: cô Lan **6 → 5 buổi**, **2 → 0 buổi 1 tiết**: giữ sáng T3 4 tiết, sáng T4 dạy tiết 1 và 3,
  bỏ buổi sáng T5; ba buổi chiều T3/T4/T5 vẫn 5 tiết/buổi. Còn **1 ô trống tiết 2 sáng T4**; không khẳng định
  đã tối ưu tuyệt đối ô trống. Cô Thùy Trang giữ **5 buổi / 0 ô trống**, Hải–Nhơn giữ **0 buổi / 0 tiết trùng**.
  Đổi cơ sở giữ **15 lượt**, chỉ trường hợp thầy Ân tiết 4–5 sáng T2 cố định còn thiếu khoảng di chuyển như trước.
- **Toàn trường / kiểm tra**: **2.279/2.279 tiết**, giữ 2.746 ô nghỉ/cố định, đổi 64 ô ở 7 lớp; validator JS production
  **0 vi phạm**, độc lập đếm từng lớp/môn và lịch GV cũng đạt. Buổi GV **684 → 683**, buổi 1 tiết toàn trường giữ **8**,
  trống ≥2 giữ **0**; đánh đổi tổng ô trống **98 → 102**. Không thay PCCM, yêu cầu, nghỉ hay dữ liệu khác.
- **Cách làm / bài học**: các script và bản sao trong `scratch/tpt4/location_20261009/hlan/`, ứng viên cuối từ
  `alternative/`. Các lượt ép cô Lan đồng thời 5 buổi + 0 ô trống không tìm được nghiệm bảo toàn các ưu tiên;
  không suy ra vô nghiệm toàn cục từ `UNKNOWN` hay vùng hoán đổi `INFEASIBLE`. Cho phép 1 ô trống tìm được 5 buổi,
  0 buổi 1 tiết và giữ cô Trang 5 buổi. Các ứng viên đẩy Trang lên 6 buổi đã loại, không ghi. CP-SAT `repair_hint`
  thử trên máy gây native check failure `heuristics.fixed_search != nullptr`; bỏ tùy chọn này, không sửa engine/repo.
- **Ghi**: cổng SHA256 lần đầu chặn đúng vì kho đổi `tkbConstraints.meta.defaultGroupsSig` (32 → 52), timestamp;
  lưới và mọi luật thực chất vẫn nguyên. Nạp metadata mới, kiểm tra lại ứng viên trước khi transaction ghi.
  Backup `/root/tkb-recovery/tpt4-hlan-20261009-195333/`, `_updatedAt=_lastModified=tkbScheduleRevision=1791550414554`.
  Đọc lại từ VPS: lưới khớp chính xác, mọi trường dữ liệu khác được giữ; validator trên bản đọc lại = 0.
- **Xác minh**: validator production + `hlan/audit.py` kiểm thêm hồ sơ Lan/Trang, Hải–Nhơn và từng lượt di chuyển.
  Chỉ đổi dữ liệu trường và nhật ký; không deploy/restart, không thay mã nguồn/test. Bộ `python run_tests.py` đã chạy
  trong cùng phiên trước thay đổi dữ liệu: **133 pass / 29 fail / 162 module**, 7 "mới hỏng" CRLF đã biết; không chạy
  lại toàn bộ khi mã nguồn không đổi. Người dùng tải lại trang để nhận lịch mới.

## 2026-10-09 TỐI ƯU TÂN PHÚ TRUNG TKB 4 `af5ldw7i8y4`: ĐỔI CƠ SỞ + HẢI/NHƠN + THÙY TRANG

- **Yêu cầu**: hạn chế đổi cơ sở; nếu đổi phải ở giờ ra chơi tiết 2–3 hoặc có tiết trống; miễn yêu cầu này cho GV Âm nhạc,
  Mỹ thuật. Ưu tiên cô Hải (`A.Hải`) và thầy Nhơn (`T.Nhơn`) ít trùng lịch, gom buổi cô Thùy Trang (`T.Trang`).
- **Nguồn / cách làm**: đọc riêng kho được yêu cầu bằng SSH SQLite `mode=ro`, `_updatedAt=1791542302004`, 74 lớp / 139 dòng GV.
  Dữ liệu và các script CP-SAT chuyên trường ở `scratch/tpt4/location_20261009/` (gitignore); không thay engine, frontend hay luật
  của trường. Chỉ hoán đổi tiết đang xếp; giữ PCCM, khung, nghỉ, tiết ghép và mọi ô cố định. Kiểm tra bằng validator JS production
  vừa tải từ VPS (`scratch/0adf9782364/tkb-constraints.live.js`) và bộ đếm độc lập theo lớp/GV.
- **Giới hạn**: cô Trang có 12 tiết chiều + 8 tiết sáng, khung tối đa 5 tiết/buổi ⇒ ít nhất 3 chiều + 2 sáng = 5 buổi;
  không thể xuống 4 nếu giữ khung hiện tại. Thầy Ân (`Ti.Ân`) đổi cơ sở tiết 4–5 sáng T2: cả hai ô cố định thật,
  giữ nguyên trong lượt này; đã hỏi riêng về việc dời ô cố định, chưa có trả lời. Không tự coi thầy Ân là ngoại lệ của yêu cầu.
- **Kết quả đã ghi**: đủ **2.279/2.279 tiết**, validator JS production = **0 vi phạm**, giữ nguyên 2.746 ô nghỉ/cố định;
  đổi 530 ô ở 68 lớp. Không tính Âm nhạc/Mỹ thuật: lượt đổi cơ sở trong buổi **24 → 15**; đổi sát tiết ngoài giờ ra chơi
  **11 → 1**, trường hợp còn lại chính là thầy Ân ở hai ô cố định kể trên. Mọi lượt đổi khác ở tiết 2–3 hoặc có tiết trống.
  Hải/Nhơn: **1 → 0 buổi trùng**, **1 → 0 tiết trùng**. Trang: giữ sàn **5 buổi**, trống giữa buổi **1 → 0**.
  Tổng buổi GV **685 → 684**, trống ≥2 giữ **0**; đánh đổi do ưu tiên di chuyển và tách lịch: buổi 1 tiết **6 → 8**,
  tổng ô trống giữa buổi **84 → 98**. Đây là nghiệm cải thiện theo ưu tiên riêng, không chứng minh tối ưu toàn cục.
- **Ghi / sao lưu**: `scratch/tpt4/location_20261009/write.py` transaction `BEGIN IMMEDIATE` + cổng SHA256 toàn kho,
  chỉ thay `tkb`, làm mới timestamp/revision và gỡ cache kết quả solver/baseline cũ. Backup đầy đủ trước/sau tại
  `/root/tkb-recovery/tpt4-location-20261009-184722/`; `_updatedAt=_lastModified=tkbScheduleRevision=1791546443838`.
  Đọc lại từ production: lưới khớp chính xác ứng viên, PCCM/luật/các dữ liệu khác giữ nguyên; validator trên bản đọc lại = 0.
  Không deploy/restart. Người dùng tải lại trang để nạp bản mới.
- **Kiểm tra**: `node scratch/tpt4/location_20261009/rb_check.js <store>` dùng JS production;
  `python -X utf8 scratch/tpt4/location_20261009/audit.py` kiểm đủ từng lớp/môn, giữ ô nghỉ/cố định, trùng GV,
  nghỉ GV, liên tiết, tiết đôi, giới hạn, đồng bộ tiết ghép. `python run_tests.py` đã chạy lại ngoài sandbox
  (lần trong sandbox lỗi khởi tạo tiến trình Node); "mới hỏng" đúng 7 test JS CRLF đã biết từ 30/09.
  Không thay mã nguồn/test trong phiên này; các test engine v3 địa điểm, tiết ghép và hợp đồng đều đạt.

## 2026-10-08 KIỂM TRA CHERRY / TỐI ƯU AN PHÚ `kkhg52etp92`: SEED CANONICAL VƯỢT INT32 LÀM HỎNG CP-SAT TIẾT GHÉP

- **Chủ dự án**: trang Sắp xếp báo không xếp / tối ưu được. Đọc kho bằng SSH SQLite `mode=ro`
  (`scratch/cherry_check_20261008/before.json`, không vào git), `_updatedAt=1791424910050`, 28 lớp / 58 dòng GV.
- **Live hiện tại**: cả bridge + planner ĐÃ có `cherry_joint_movable` / `tkbJointPinnedKeys` (khác trạng thái chưa deploy ghi 07/10).
  Kết quả lưu 08/10 02:01:40 UTC, revision `tkb-solver-00434-kup`, digest `d351e288…`, đủ **869/869**, `hard_ok=true`,
  chất lượng [1,0,315,27]; chạy validator JS trên kho hiện tại = **0 vi phạm**. Không có browser surface trong phiên này,
  nên kiểm tra bằng bản JS production tải từ VPS + engine chạy trên bản sao; chưa bấm UI thật.
- **Lỗi xác định**: `solver.engine_v3.joint_free.cpsat.error` ghi `TypeError` khi gán seed `825714465373582943` vào
  `SatParameters.random_seed` (int32). Backend `server_request_with_canonical_seed` thay seed bằng hash job (u64);
  `joint.py` chuyển nguyên số này vào `cpsat_lns`; các test cũ chỉ dùng seed nhỏ nên không thấy lỗi.
  Pha tiết ghép thất bại trước `Solve`, còn pha Cherry sau đó vẫn có thể chạy và xếp đủ — không quy mọi lỗi tối ưu cho seed.
- **Sửa**: chuẩn hoá tại ranh giới CP-SAT (`int(seed) & 0x7FFFFFFF`), giữ nguyên seed int32 không âm; không đổi seed của
  portfolio heuristic / job. Test mới LNS dùng seed production, âm int64 và int32 tối đa; test end-to-end tiết ghép cũng dùng seed production.
  Trước sửa test mới lỗi 2/3 seed; sau sửa đạt. Suite tiết ghép **9/9 pass**.
- **Đo trên bản sao trường**: ghim bằng chính khối planner live; Cherry 90 s → 83,8 s, **869/869 hợp lệ**, [1,0,315,27] →
  **[0,0,315,20]**. CP-SAT tiết ghép `OPTIMAL` (không còn TypeError), giữ vị trí vì không tốt hơn; không tự ghi lịch thử vào trường.
- **Menu tối ưu trên bản sao** (60 s/mục): cả 4 mục HTTP-style 200 / 869 tiết / `hard_ok=true`; 1 tiết/buổi 1→1,
  trống 2 0→0, buổi 315→315 (giữ lịch, không phải lỗi giải), trống 1 **27→20**. Áp lưới thử vào bản sao rồi chạy
  đúng validator JS live: **0 vi phạm ở cả 5 kết quả**, giữ mọi ô cố định/nghỉ. Trong sandbox, portfolio nhiều tiến trình
  rơi về một tiến trình ở mục singletons; đây là đo ngắn, không phải chứng minh tối ưu toàn cục.
- **Vì sao tối ưu buổi khó giảm**: 47/58 dòng GV có `minSessions=maxSessions` (5–5/6–6…), 7 GV khác đã đạt min.
  Tổng min của 54 GV = 292; 4 GV không đặt min đóng góp 23 buổi: KHTN.Lên 27 tiết / 7 buổi (khung 4 tiết ⇒ đã đạt sàn),
  LSĐL.Bích 16 tiết / 5 buổi, MT.Thi 28 tiết / 8 buổi (16+12 ở 2 cơ sở), TANN 7 tiết chung / 3 buổi (ghim giữ vị trí trong focus).
  CP-SAT toàn trường target <315, 90 s / 6 luồng = `UNKNOWN` (9.966 biến lựa chọn, không đóng băng GV), không phải chứng minh
  vô nghiệm. Không được kết luận 315 là sàn tuyệt đối chỉ từ lượt heuristic không giảm. Đọc lại kho 02:10 UTC:
  `_updatedAt=1791425428194`, đã đổi luật địa điểm, vẫn 47 GV min=max, lịch đủ 869 và 315 buổi / 0 buổi 1 tiết.
- **Chủ dự án sửa rõ ý định trong phiên**: «tối đa là 6 có thể xếp ít hơn cũng được». Form `maxDaysSessions` production
  chỉ có maxDays/maxSessions, KHÔNG hiện minSessions; giới hạn tối thiểu do lượt chỉnh kho 05/10 vẫn còn ẩn ⇒ trên UI thấy
  "tối đa", engine nhận "đúng bằng". ĐÃ gỡ **54 khoá minSessions** (47 đúng bằng + 7 min riêng), chỉ giữ giới hạn tối đa
  và các luật khác, không đổi lịch/PCCM/nghỉ/ô cố định. Ghi bằng transaction + kiểm hash toàn kho, sao lưu
  `/root/tkb-recovery/anphu-hidden-min-20261008-021746/`; `_updatedAt=_lastModified=1791425866501`.
  Đọc lại xác nhận không còn min, mọi max giữ nguyên, lịch byte-equivalent. Từ nay không được tự thêm minSessions
  khi chủ dự án yêu cầu số buổi **tối đa**; "đúng bằng" cần chỉ dẫn rõ riêng.
- **Xác minh / triển khai**: `python run_tests.py` trong sandbox bị `spawn EPERM` ở test Node; đã chạy lại ngoài sandbox,
  PATH chỉ rõ runtime Node để tránh quét toàn LocalAppData: **133 pass / 29 fail / 162 module, 512 s**.
  "Mới hỏng" chỉ 7 test JS CRLF đã biết từ 30/09,
  không thuộc file sửa; test CP-SAT seed + tiết ghép đạt. Bản sửa seed CHƯA deploy; thay đổi dữ liệu trường đã có hiệu lực,
  không cần deploy/restart. Sau khi bỏ min, **Tối ưu buổi 120 s → 115 s: 315→283 buổi**, 869/869,
  0 buổi 1 tiết / 0 trống 2, trống 1 18→21 (mục này ưu tiên giảm buổi). Chỉ đo trên bản sao, không ghi lịch thử.
  Payload HTTP-style 200, `hard_ok=true`, focus gate nhận; validator JS live trên lưới đã áp vào bản sao = 0 vi phạm,
  giữ mọi ô cố định/nghỉ. Nhắc người dùng Ctrl+F5 trước khi tối ưu để tab không gửi cấu hình min cũ.
  Đọc lại lúc kết thúc thấy tab/lượt cũ đã ghi lại 54 min (`_updatedAt=1791425960950`); gỡ lại bằng cùng cổng hash,
  giữ LỊCH MỚI NHẤT của người dùng. Backup lần 2 `/root/tkb-recovery/anphu-hidden-min-20261008-022045/`,
  `_updatedAt=1791426045968`; đã xác nhận lại 0 min.
  Người dùng cần dừng lượt cũ và tải lại tất cả tab của trường này để tránh tiếp tục ghi cấu hình cũ.

## 2026-10-07 (tối, 2) WEBSITE CÔNG KHAI ĐỂ XÁC MINH STARTUP (trang chủ + /about /privacy /terms + robots/sitemap) — ĐÃ DEPLOY

- **Chủ dự án**: làm tkbcherry.com đủ thông tin công khai cho chương trình startup (Claude Startups/Anthropic) mà **không đụng**
  login/đăng ký/API/solver/backend; không bịa khách hàng/doanh thu/nhà đầu tư/pháp nhân; AI chỉ "exploring" (chưa có Claude production).
- **Trang chủ** `web/index.html`: title/description/canonical/OG/twitter + JSON-LD @graph (Organization: founder Person "Nguyen Hoang An"
  alternateName "Nguyễn Hoàng Ân", foundingDate 2026, address TP.HCM, contactPoint contact@tkbcherry.com; WebSite; SoftwareApplication).
  `body.auth-landing`: nav dính (Product/About/Technology/Contact/Đăng nhập), hero bên trái (≥1100px lưới 3fr/2fr), **thẻ đăng nhập/đăng ký/quên
  mật khẩu byte-identical** bên phải, thấy ngay khi mở (mobile: logo + headline + thẻ trong màn đầu, ẩn subheadline/CTA/chips < 900px);
  dưới là `#product` (EN + VI), `#about` (dl Founder/Founded/Location/Stage/Website/Contact), `#technology`, `#contact`, footer mới
  (© 2026, /about /privacy /terms, email, SĐT/Zalo/địa chỉ cũ). CSS riêng `web/public-site.css` (lớp `lp-*`), không sửa `auth.css`/`auth.js`.
- **Trang mới**: `web/about/index.html`, `web/privacy/index.html`, `web/terms/index.html` (Rust `static_file` phục vụ index.html của thư mục →
  `/about` và `/about/` đều 200, không redirect). Privacy liệt kê bên thứ ba thật: VPS, Google Cloud Run (Jakarta/Singapore/Đài Loan),
  Gmail (OTP), Google Workspace (contact@), api.ipify.org (lúc login/đăng ký), Google Fonts, Zalo; không analytics.
- **robots.txt / sitemap.xml**: Rust chỉ phục vụ html/js/css/ảnh ⇒ **nginx** khối `TKB_PUBLIC_SEO_BEGIN/END` (`location =`) trỏ
  `/var/www/tkbcherry-public/` — `tools/vps-deploy/install-public-seo-nginx.py --apply` (sao lưu, `nginx -t`, tự khôi phục nếu lỗi, reload;
  mỗi lần chạy upload lại 2 file từ `web/`). Lần đầu alias vào `/opt/cherry-scheduler/web` bị **403** vì `/opt/cherry-scheduler` là 0700
  (đúng, chứa DB — KHÔNG nới). Cùng lỗi 403 này đang xảy ra với khối `TKB_AGENT_DOWNLOAD` cũ (`/downloads/TKBCherryAgent-*`, Agent đã ngừng).
- **Lệch live ↔ repo**: live `index.html` vẫn gọi `shared/auth.js?v=20260823-default-first-v1` (auth.js 30 ngày) còn repo có bản 1 năm chưa
  deploy (test `auth_activation_grant_one_year_node` cần khoá mới). Đã deploy **biến thể** index.html = repo nhưng giữ khoá live
  (scratch `deploy_index_variant.py`, sha256 `6b459be7…`, 25165 B); repo giữ khoá mới. Lần deploy auth.js 1 năm phải deploy kèm index.html repo.
- **Kiểm**: E2E CDP trên backend local (DB mới) cũ vs mới GIỐNG HỆT: đăng ký 200 "Đăng ký thành công…" → chuyển pane login điền sẵn ID;
  sai mật khẩu "Mật khẩu không đúng."; quên mật khẩu bật/tắt; đăng nhập → `/school-portal`; 0 JS exception. Live (chỉ đọc): thẻ login thấy
  ngay 390×844 và 1366×768, tab đăng ký/quên mật khẩu bật tắt, tài khoản không tồn tại báo lỗi server. HTTP live: `/`, `/about`, `/about/`,
  `/privacy`, `/terms`, `/robots.txt`, `/sitemap.xml` = 200 không redirect (HEAD trả 404 vì Rust chỉ route GET). `run_tests.py`: "mới hỏng"
  chỉ 7 test CRLF đã biết; `test_vps_deploy_packaging` FAIL trong lượt chạy chung nhưng chạy riêng 16/16 pass.
- **Deploy** (không restart, không đổi backend): `deploy-files.py deploy public-site-20261007 --no-restart` (6 file mới) + biến thể index.html,
  backup `/root/tkb-backups/public-site-20261007/`; nginx backup `/root/tkb-backups/nginx-public-seo-20261007-200608/` và `-200720/`.
- **RỦI RO BẢO MẬT phát hiện (CHƯA sửa, chờ chủ dự án duyệt)**: (1) `GET /api/school/store?id=default` trả **toàn bộ kho default không cần
  đăng nhập** (~362 KB: 135 GV kèm mã HT/PHT, 74 lớp, TKB) — `school_store_get_json` bỏ qua auth khi id = default; theo mã nguồn
  `school_store_post_json` cũng vậy ⇒ có thể ghi đè ẩn danh (chưa thử). Đề xuất: bắt buộc phiên superadmin cho `default`.
  (2) `GET /api/sample-data` công khai 43 GV họ tên đầy đủ (`rust_api/fixtures/sample-data.json`) — cần xác nhận là dữ liệu giả.
  (3) `/pages.zip` (500 KB mã JS front-end, 16/08) tải công khai — nên xoá. (4) `/api/health` lộ đường dẫn máy chủ.
- **Việc mở**: chủ dự án xác nhận hộp thư contact@tkbcherry.com nhận được thư; duyệt hướng sửa 4 rủi ro trên.

## 2026-10-07 (tối) `ry7gvvz7vk3` — CÔ QUYÊN TIN CHỈ DẠY THỨ 5 (10 TIẾT), THẦY TAM NGHỈ CHUYÊN MÔN THỨ 4 (ĐÃ GHI)

- **Chủ dự án**: «giữ nguyên các ràng buộc cũ, cô Quyên Tin học chỉ dạy thứ 5 10 tiết; thầy Tam nghỉ chuyên môn Thứ Tư, không nghỉ
  thứ 3 và 5 nữa. TKB vừa rồi đẹp rồi» ⇒ sửa ít nhất có thể.
- **Ràng buộc** (`tkbConstraints`): `fixedOff.teacher["TI.Quyên"]` = nghỉ cả ngày T2/T3/T4/T6/T7 (thêm T6), `maxPeriods.day.thu5` 8 → 10;
  `fixedOff.teacher["TN.Tam"]` bỏ T3 sáng + T5 sáng, giữ nghỉ cả ngày T4. Mọi ràng buộc khác giữ nguyên.
- **Lịch**: CP-SAT cục bộ trên lớp 9A10/9A13 (`scratch/ry7gvvz7vk3_20261007/minimum_change.py`, mục tiêu = ít ô đổi nhất) → **11 ô / 3 lớp**
  (9A9, 9A10, 9A13). Cô Quyên đủ 10 tiết T5 (sáng 9A9–9A13, chiều 6A6–6A10); thầy Tam không có tiết T4 (lịch thầy không đổi).
  Chất lượng 387 buổi / 0 buổi 1 tiết / 0 trống 2 / 65 trống 1 → **386 / 0 / 0 / 65**; 1370/1370; giữ mọi ô cố định/nghỉ.
- **Kiểm**: validator Python `hard_ok`, 0 vi phạm Yêu cầu; RB production (`tkb-constraints.live.js` `validateAll(5000)`) = 0 cả trước và sau khi
  đọc lại bản đã ghi.
- **Ghi**: SSH KV (`remote.py --apply`, `BEGIN IMMEDIATE` + cổng hash toàn kho), chỉ thay `tkb` + `tkbConstraints`, bỏ kết quả giải cũ;
  `_updatedAt = 1791373254319`; backup `/root/tkb-recovery/pvh3-ry7gvvz7vk3-20261007-184052/`. Không đổi mã nguồn, không deploy.

## 2026-10-07 CHERRY TỰ DỜI TIẾT CHUNG NHIỀU LỚP (An Phú KNS/STEM "bay về T2 sáng")

- **Chủ dự án** (`kkhg52etp92`): «tôi bấm nút cherry tự nhiên tiết kns và stem bay vào tiết 2 3 của lớp 6a2 sáng thứ 2», «nó ở ô nào
  cũng về ô đó luôn» → «tôi muốn bạn fix ko cố định như vậy nữa khi xếp». File `.cherry` chủ dự án xuất 07/10 00:35 (Desktop\vanban).
- **Gốc**: `tkbJointPinForSolve` ghim TẠM tiết chung; dòng thiếu tiết (kéo ra Chưa phân / đặt tiết khác vào) lấy ô chung ĐẦU TIÊN =
  đúng lỗ vừa bỏ ra (T2 sáng tiết 3-4) — tái hiện bằng chính hàm của app trên kho (scratchpad `sim/pin_sim*.js`); engine coi là ô cố định
  dùng chung ⇒ không bao giờ dời. Lượt 00:31: 866/869, cô Vy thiếu 3 tiết (2 bị cắt sức chứa TRƯỚC khi giải vì sáng T2 6A2 kín ô cố định).
- **Sửa**: bridge gửi `settings.cherry_joint_movable` (`tkbJointPinnedKeys`), engine `joint.py` `relocate_joint_lessons` (CP-SAT toàn trường,
  nhóm buộc cùng ô qua `Problem.joint_sync` / `cpsat_lns`, giữ mọi tiết + tối thiểu tiết thiếu, cắt sức chứa lại khi bỏ ghim) rồi chạy lại lượt
  với lịch viết lại; payload `solver.engine_v3.joint_free` ⇒ `applyPayload` `releaseJointFreeLocks` nhận vị trí mới. Chi tiết
  `docs/CHERRY_ENGINE.md` mục 07/10.
- **Đo** (kho 00:35, ghim như production, 180 s): cũ 866/869 `hard_ok=false` [1,0,316,12]; mới **869/869 hợp lệ** [0,0,315,14], KNS → T3 sáng
  t1, STEM → T3 sáng t2. Luật "ghép nhiều lớp học sau 2 tiết, cuối buổi" (01/10) không có trong Yêu cầu ⇒ engine không biết.
- **Test**: `test_engine_v3_joint_free.py` 9/9; engine v3 + hợp đồng 357 pass / 2 skip; `planner_ghep_pin_survives_apply_node` 5/5;
  `run_tests.py` "mới hỏng" chỉ 7 test CRLF đã biết (đạt hết trên bản bỏ CR).
- **Deploy**: CHƯA — web (`phanmon.js` = live + `tkbJointPinnedKeys`, bridge = live + phần này) và Cloud Run (engine) đều phải do chủ dự án
  chạy (classifier chặn "Production Deploy"). Thứ tự nào cũng an toàn: engine cũ không trả `joint_free` ⇒ bridge giữ khoá như trước.

## 2026-10-06 (tối) TIẾT GHÉP NHIỀU LỚP BỊ "KHOÁ" SAU LƯỢT CHERRY (An Phú KNS/STEM)

- **Chủ dự án** (`kkhg52etp92`): «bấm nút cherry lại có tiết kns và stem cố định là sao» → «tôi kéo rồi nhưng bấm Cherry nó lại khóa 2 tiết đó».
- **Cơ chế** (`phanmon.js tkbJointPinForSolve`): trước mỗi lượt (Cherry/▶/Tối ưu) mọi dòng Dạy ghép ≥ 2 lớp được ghim tạm
  `{mon, fixed:true, jointPin:true}` cùng ô ở mọi lớp; dòng đã có tiết thì GIỮ đúng chỗ (Cherry không bao giờ dời tiết ghép), dòng
  thiếu tiết thì lấy ô chung ĐẦU TIÊN (Thứ 2, sáng, tiết nhỏ trước). An Phú: sau lượt xoá lịch + Cherry 05/10, KNS T3 sáng t4 → T2 sáng t3,
  STEM T6 sáng t4 → T2 sáng t4, TANN 6A1-4 T4 chiều t3 → T2 chiều t1 (`scratch/anphu2r/live_0510b.json` → `live_0510c.json`, cả 19 ô
  `jointPin`); sáng T2 6A2 kín 4 ô cố định = nút thắt NV.Vy (trần 867/869 ở mục chiều nay).
- **Lỗi**: `applyPayload` dựng lại ô cố định thành `{mon, fixed:true}` trần → mất `jointPin`. Đường gỡ ghim nào lỡ (tải lại trang, áp
  kết quả sau khi sổ ghim đã mất) thì lượt ghim sau coi ô đó là ô NGƯỜI DÙNG khoá (`wasFixed`) → khoá vĩnh viễn, `tkbJointClearStalePins`
  (quét cờ `jointPin`) cũng không nhận ra.
- **Sửa**: `tkb-rust-bridge.js` `collectFixedLessonLocks` ghi `jointPin`, `fixedLessonLockCell` giữ cờ khi áp (vòng lặp áp +
  `applyFixedLessonLocks`); `phanmon.js` `isShownFixed` — lưới lớp, vẽ lại tại chỗ và TKB GV không vẽ khoá cho ô ghim tạm.
  Đã thử thêm gỡ ghim trong `restoreScheduleData` rồi BỎ: `maybeFinishLocalUnassignedRepairSolve` (▶/v3) khôi phục SAU khi ghim, TRƯỚC khi gửi.
- **Test**: mới `e2e_tests/planner_ghep_pin_survives_apply_node.test.js` 3/3 (bản cũ 0/3); `planner_ghep_teacher_clash` thêm stub
  `isShownFixed`. `run_tests.py`: "mới hỏng" chỉ 7 test CRLF đã biết — cả 7 đạt trên bản bỏ CR có phần sửa.
- **Deploy**: ĐÃ DEPLOY 07/10 (chủ dự án chạy `deploy.py files deploy joint-pin-flag-20261006 --no-restart` từ worktree = live + phần này;
  lệnh của Claude bị classifier chặn "Production Deploy"), backup `/root/tkb-backups/joint-pin-flag-20261006`; live sha256
  phanmon.js `9646bf21f0d0fbbe`, tkb-rust-bridge.js `2a794b98a150ec6a` (= bản dựng). Bridge live vẫn CŨ hơn HEAD (f3679c3 soft-stop chưa deploy).
- **Còn mở**: (1) Cherry vẫn không tự dời tiết ghép (engine coi là ô cố định dùng chung, `core.py shared_fixed`); muốn Cherry chọn ô
  phải mô hình tiết ghép trong engine v3 (biến chung cho các lớp trong CP-SAT + bridge nhận ô ghép đã dời). (2) Ô ghép đã lỡ thành cố
  định thật (không `jointPin`) trong kho phải "Bỏ cố định" tay — không tự gỡ được vì người dùng cũng tự cố định tiết ghép (Chào cờ (ghép)).

## 2026-10-06 (chiều) KIỂM TRA THUẬT TOÁN NÚT CHERRY: LỊCH HỢP LỆ THẮNG LỊCH NHIỀU TIẾT CÒN NỢ LUẬT + GIỮ PHẦN LẤP ĐƯỢC

- **Chủ dự án** (An Phú `kkhg52etp92`): «bấm xếp nó lại ko xếp đủ tiết và tối ưu, có phải thuật toán có vấn đề ko?» →
  «tôi cần bạn kiểm tra lại thuật toán».
- **Không đọc được dữ liệu trường**: SSH đọc kho production và cả bản sao cũ trong `scratch/anphu2r/` bị classifier chặn
  ("Production Reads") → CHƯA tái hiện trên kho thật của An Phú; mọi kết luận dưới đây từ trường thử.
- **Cách kiểm**: trường thử CÓ ĐÁP ÁN (`scratch/synthetic_bench/`, gitignore; README trong đó): 28 lớp 2 cơ sở, 871 tiết,
  10 GV dạy 2 cơ sở có "1 địa điểm/buổi" (MT/Nhạc 28 lớp), họp tổ, tiết ghép cố định; Cherry xếp bản lỏng ra đáp án 871/871 rồi
  ghi `maxSessions = minSessions` = số buổi đáp án cho mọi GV (luật "đúng bằng" như An Phú). Lưới trống, 180 s, 6 tiến trình + 6 luồng.
- **Lỗi 1 (gốc của "không xếp đủ / không tối ưu")**: vòng 1 heuristic trả lưới 871/871 còn nợ luật số buổi; `_rank_key` xếp số tiết
  lên đầu nên lưới đó thắng lưới HỢP LỆ 869/868/797 của vòng CP-SAT → payload `ok=false` (41–45 `teacher.maxSessions`), trình duyệt
  không áp được. Bản cũ gặp ở 4/8 lượt. Sửa `entry.py`: `_grid_rule_debt` → `result["rule_debt"]`, xếp hạng nút Cherry đặt `rule_debt`
  trước số tiết, `_result_hits_floor` đòi 0 nợ, lưới xây mới còn nợ không làm điểm xuất phát vòng 2.
- **Lỗi 2**: `_cpsat_fill_phase` vứt cả lần giải toàn trường (758 → 864) khi gỡ địa điểm không hết → về 758. Sửa `construct.py`: gỡ không
  hết thì `_shed_rule_debt` + GIỮ phần còn lại; gỡ vùng ≤ max(8 s, 30 %); ngưỡng thêm lần toàn trường 25 → 15 s; `entry.py` trường có
  `minSessions` để vòng 1 dùng 25 % ngân sách (cũ 40 %). Toàn trường chỉ chạy khi ≤ 40 lớp (Tân Nhựt, Tân An Hội không đổi).
- **Đo**: cũ 4/8 lượt lưới vi phạm, 4/8 đủ 871; bản cuối 4/4 đủ 871/871 hợp lệ [3,0,270,1]/[3,0,271,0] (= đáp án); bấm lần 2 trên lịch
  đủ [3,0,270,4] → [3,0,270,1], trên lịch 869 → 871 trong 10 s. Chi tiết: `docs/CHERRY_ENGINE.md` mục 06/10 chiều.
- **Test**: engine v3 + hợp đồng kết quả 340 pass (+6 `test_engine_v3_valid_first.py`; `test_engine_v3_location_rules` sửa chỉ số khoá
  xếp hạng). `run_tests.py`: 133 pass / 27 fail / 160; "mới hỏng" chỉ 7 test JS CRLF đã biết, `test_cloud_run_deploy_assets` fail sẵn.
- **Deploy** (chủ dự án chạy `deploy-and-pin.ps1` — lệnh deploy của Claude bị classifier chặn "Production Deploy"): ảnh
  `tkb-solver:20261006-033419`, digest `683e7603bf6a90013370a1b3ce003a8e35b30dc27ff1030c0a91d71858d405fa`; Jakarta `00424-new`,
  Singapore `00083-six`, Đài Loan `00083-yud`; 3 profile kvstore + 2 drop-in đã ghim, /health 3 vùng khớp. Bước max 2 lại hết giờ ở cả
  3 vùng: revision max 2 cùng image ĐÃ Ready (`00182-bgv` / `00039-swd` / `00039-nxg`) nhưng 0 % traffic — `update-traffic` của
  Claude cũng bị chặn → chủ dự án chạy 3 lệnh `update-traffic`; Claude kiểm lại: cả 3 vùng 100 % trên revision max 2, cùng image
  `sha256:f79feabe…88c6c7`, Ready. Chưa nghiệm thu `/solve` trên Cloud Run; chủ dự án đang bấm Cherry trên An Phú để thử.
- **HỒI QUY sau deploy (13:53)**: chủ dự án bấm Cherry An Phú → vòng 2 trả 167 tiết, khoá "nợ lên đầu" chọn nó, bridge từ chối, lịch 859 giữ nguyên.
  Tái hiện từ file `.cherry` chủ dự án xuất (Desktop\QLSS_HDSD, chép vào scratchpad): nhánh warm `_repair_partial_warm` sửa xong 863 tiết, `_load_state`
  từ chối (thiếu tiết → tiết đôi chưa đủ) → rơi xuống xây lại từ đầu với ~1 s. Sửa (`b7e28ef` + commit này): khoá `(rule_debt − handled)`, giữ lưới đã sửa
  (`warm_final_lenient`), không xây lại khi < 20 s. Kho An Phú 180 s ×2: 866/869, 0 nợ luật GV/địa điểm. Trần dữ liệu 867: NV.Vy chỉ rảnh sáng T2 + chiều T3,
  sáng T2 của 6A2 kín ô cố định. 343 test v3 đạt. ĐÃ DEPLOY (chủ dự án chạy deploy-and-pin 15:04): digest
  `5de729ee70476f2193142623f344a0e45efa22969d70edd9a9ad59a40166dff1`, Jakarta `00429-xay`, Singapore `00088-kow`, Đài Loan `00088-wir` (max 1),
  /health 3 vùng khớp; revision max 2 Ready cùng image `00184-5nk` / `00041-hq8` / `00041-nv6` — chờ chủ dự án update-traffic.

## 2026-10-06 NÚT CHERRY: Ô CỐ ĐỊNH VƯỢT GIỚI HẠN KHÔNG CÒN LÀM BỎ KẾT QUẢ + 2 VÒNG CHO TRƯỜNG 2 CƠ SỞ XẾP TỪ ĐẦU

- **Chủ dự án** (Tân Nhựt `0adf9782364`): «bấm Cherry thấy có tối ưu nhưng trả kết quả về lại không nhận, trả lại như cũ; xếp lại
  vi phạm ràng buộc quá nhiều; phải đảm bảo mọi ràng buộc, xếp đủ, tối ưu, lần sau bấm tối ưu tiếp».
- **Nguyên nhân** (kho kéo RO `_updatedAt=1791217377134`, chạy 180 s như production): engine ra 1746/1746 [0,0,620,59] từ
  [7,0,679,106] nhưng `ok=false` chỉ vì 2 cặp Tin-QT CỐ ĐỊNH (mục 05/10/06/10 bên dưới) → bridge "Kết quả máy chủ chưa đủ điều kiện để
  áp dụng; lịch hiện tại được giữ nguyên" ở MỌI lượt. Xếp từ đầu trường 54 lớp có luật địa điểm đi đường heuristic cũ (không CP-SAT).
- **Code**: `validate.compute_metrics(fixed_lessons=)` → `fixed_subject_session_limit_overrides` (cảnh báo) cho phần vượt nằm trọn
  trong ô cố định; `adapter.build_payload`/engine v3 truyền ô cố định; Cherry 2 vòng mặc định cho trường luật địa điểm khi xếp từ
  đầu (`TKB_CHERRY_LOC_FRESH=0` = cũ). Chi tiết + số đo: `docs/CHERRY_ENGINE.md` mục 06/10.
- **Đo**: lịch trên kho → `ok=true` 60 s [0,1,658,91]; lưới trống 180 s cũ [6,1,672,100] → mới [0,0,635,68]; Tân An Hội lưới trống
  [0,0,664,118] → [0,0,646,114]. RB (node + `tkb-constraints.js`) mọi kết quả 0 vi phạm, 0 nợ địa điểm.
- **Test**: engine v3 + hợp đồng kết quả 334 pass (+4 `test_fixed_cell_limit_override.py`); sửa fixture
  `test_engine_v3_edge_pair_rule` (chọn seed có ≥ 2 vi phạm). KHÔNG ghi dữ liệu trường (phiên khác đang ghi Tân Nhựt).
- **Deploy** commit `1bad953`: `deploy-and-pin.ps1` → digest `7bf7ddd86e82ec244d006e2e116fc388475834e65962f94adb4ab294266c346d`, VPS ghim,
  /health 3 vùng khớp. Bước nâng max 2 lại hết giờ ở CẢ 3 vùng (revision max 2 Ready nhưng 0 % traffic) → `update-traffic` sang
  `00180-wzh` (Jakarta) / `00037-bqb` (Singapore) / `00037-xpr` (Đài Loan), cùng image `3c84cdfd…`. Nghiệm thu Cloud Run thật trên
  kho mới nhất (`_updatedAt=1791224196468`, settings như bridge, 180 s): `ok=true hard_ok=true` 1746/1746 [0,0,640,70] → [0,0,619,59].
  Bẫy lặp lại 2 lần: `deploy-and-pin.ps1` chờ revision max 2 chỉ 2 phút — cần nới thời gian chờ trong script.

## 2026-10-06 `0adf9782364` THCS Tân Nhựt — TỐI ƯU THÊM 1 LƯỢT, ĐÃ GHI 1746/1746

- **Chủ dự án**: «tối ưu thêm 1 lần nữa». Đọc lại kho live `_updatedAt=1791217377134`: lịch/yêu cầu đã khác bản tối ưu 05/10,
  có 141 ô cố định (trước 124), 679 buổi, 7 buổi 1 tiết, 0 trống 2, 106 trống 1; 2 lỗi yêu cầu giới hạn số ngày dạy.
- **Thực hiện**: đúng một lượt Cherry 180 s, warm từ kho mới, giữ toàn bộ ô cố định/nghỉ và nguyên yêu cầu/phân công.
  Chạy ngoài sandbox để multiprocessing hoạt động (6 worker, `used_multiprocessing=true`), thực tế 174,6 s.
  Kết quả **1746/1746, 640 buổi, 0 buổi 1 tiết, 0 trống 2, 70 trống 1**; 2 lỗi số ngày dạy đã hết.
- **Kiểm chứng**: validator Python 0 trùng GV/lớp/phòng, 0 thiếu/thừa phân công, 0 lỗi tiết đôi/ô nghỉ/yêu cầu/địa điểm;
  `validateAll(5000)` của RB production = 0, cả trước khi ghi và sau khi đọc lại độc lập. Giữ đúng 141 ô cố định.
  Vẫn giữ hai ngoại lệ Tin-QT cố định 6/5, 7/5 chiều T6 t1–2 vượt giới hạn 1/buổi đã nêu ở mục 05/10;
  Python `hard_ok=false` chỉ vì hai ngoại lệ này, không mô tả là đã thỏa mọi kiểm tra hard.
- **Đã ghi** qua SSH KV store với transaction + cổng hash toàn kho, backup
  `/root/tkb-recovery/tannhut4-0adf9782364-20261006-011635/`; ba timestamp/revision = `1791224196468`.
  Chỉ cập nhật lịch và ánh xạ GV/phòng, bỏ kết quả giải cũ; phân công/yêu cầu giữ nguyên. Bản đọc lại khớp lưới đã ghi và chất lượng,
  có file `.cherry` tại `scratch/0adf9782364/rerun_20261006/` (gitignore). Không thay mã nguồn sản phẩm/deploy.
- **Kiểm tra repo trước commit**: `python run_tests.py`: 131 pass / 28 fail / 159 module (483 s); 7 module đánh dấu MỚI HỎNG khớp các lỗi JS CRLF đã ghi nhận trước phiên này. Không đổi mã nguồn sản phẩm hoặc baseline.

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

## 2026-10-01 Sắp xếp: tiết DẠY GHÉP dùng giới hạn tiết/buổi của chính dòng ghép (ĐÃ DEPLOY) · `af5ldw7i8y3` Tân Phú Trung TKB 3 (ĐÃ GHI)

- **Lỗi (chủ dự án)**: dòng ghép "Bản ngữ" giới hạn 2, kéo 2 tiết liền thì báo "giới hạn môn này chỉ có 1".
  Gốc: `validateDrop`/`showTKBError` lấy giới hạn qua `getMonMeta(mon)` = `CURRENT_MON_META`, mà danh sách này chỉ có môn
  ĐÃ PHÂN CÔNG GV và khoá theo TÊN HIỂN THỊ; ô TKB lưu khoá dòng ghép (`Bản ngữ (ghép)`) → tiết ghép (đặc biệt dòng không GV)
  rơi về mặc định `{sotiet:0, gioihan:1}`. RB (`tkb-constraints.js`) không kiểm giới hạn phân công nên không bị.
- **Sửa (`web/pages/phanmon.js`)**: `tkbGhepMetaForClass(classRef, mon)` (bộ đệm theo ref dayGhep/pccmTiet/pccmGioihan, xoá trong
  `invalidatePccmNumCaches`) lấy Số tiết / Giới hạn của DÒNG ghép (khoá chiếu `Lớp|ten`, thiếu thì `row.sotiet/row.gioihan`);
  `getMonMeta` ưu tiên nó cho lớp đang chọn. `setClassSubjectSessionLimit` (nâng giới hạn khi thả) với tiết ghép ghi cả
  `row.gioihan` + khoá chiếu mọi lớp của dòng (vì `day-ghep.js syncDayGhepProjection` chép `row.gioihan` đè lên).
  Test mới `e2e_tests/planner_ghep_session_limit_node.test.js` (5/5). `run_tests.py`: 7 "MỚI HỎNG" + 2 test mới FAIL
  (`planner_teacher_assignment_statistics`, `planner_teacher_slot_presence_forecast`) cho kết quả Y HỆT khi thay bằng bản live chưa sửa.
  Deploy `python deploy.py files deploy ghep-limit-20261001 --no-restart web/pages/phanmon.js` (backup `/root/tkb-backups/ghep-limit-20261001`),
  live sha (bỏ CR) `0b89d6ac19b54e81` = working tree; kiểm trên trang TKB 3: `getMonMeta('Bản ngữ (ghép)')` 6A1 = 2/2 (trước 0/1).
  Bản deploy = live + phần này (live trước đó khớp working tree, kể cả sửa đổi chưa commit của phiên khác). Không commit (cùng lý do mục 30/09).
- **Dữ liệu TKB 3 Tân Phú Trung** (`scratch/tpt3/`, không vào repo): phân công 05/10 (`pccm510moi.xlsx` sheet tổng) + 2 GV mới, Bản ngữ/KNS/THQT
  ngoài nhà trường (dòng ghép không GV; app sau đó tự đổi khoá thành `Bản ngữ (ghép)`/`KNS (ghép)`/`THQT`), cô Hòa T5→T4, giữ 14 ô thầy Ân.
  CP-SAT với khung buổi trái là biến; ghi 01/10 03:42: 651 buổi / 14 buổi 1 tiết / 86 trống, RB 0.
