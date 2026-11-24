# PROJECT HANDOFF — TKBCherry

> Nhật ký bàn giao theo từng phiên làm việc, mục mới nhất ở trên cùng.
> Tóm tắt trạng thái hiện hành: xem [`CURRENT_STATE.md`](CURRENT_STATE.md).
> Các mục trước tháng 11/2026 đã chuyển vào `docs/archive/`:
> - [`2026-10`](archive/PROJECT_HANDOFF_2026-10-01_2026-10-31.md)
> - [`2026-09`](archive/PROJECT_HANDOFF_2026-09-01_2026-09-30.md)
> - [`2026-08-10 – 2026-08-31`](archive/PROJECT_HANDOFF_2026-08-10_2026-08-31.md)
> - [`2026-07-28 – 2026-08-09`](archive/PROJECT_HANDOFF_2026-07-28_2026-08-09.md)
> Chính sách: đầu mỗi tháng, chuyển các mục của tháng trước vào `docs/archive/`.

## 2026-11-24 LINH VẬT "CÔ GIÁO CHERRY" TRÊN TRANG CHỦ + TRANG HƯỚNG DẪN — ĐÃ DEPLOY

- **Chủ dự án**: "cần 1 nhân vật vui vui để xếp TKB… tạo chibi bằng meshy.ai"; ban đầu muốn Ran Mori (Conan) rồi Aemeath (Wuthering Waves), kể cả "na ná đổi quần áo" — Claude từ chối
  (nhân vật có bản quyền của hãng khác) và làm NHÂN VẬT MỚI: cô giáo chibi tóc nâu dài buộc nơ đỏ, kẹp tóc quả cherry, áo dài trắng viền đỏ, cầm bảng TKB + que chỉ.
  Chủ dự án chọn "Hình 2" trong 4 phương án, rồi chọn đặt ở "Trang chủ + Hướng dẫn".
- **Nguồn** (`scratch/linh-vat/`, gitignored): meshy.ai → công cụ Hình ảnh (model Nano Banana Pro, 36 credit/4 hình, tài khoản chủ dự án đăng nhập trong trình duyệt của Claude);
  `co-giao-cherry-1..4.png` là 4 hình gốc. `make_mascot.py` (PIL + numpy) xử lý hình 2: vẽ lại mặt bảng bằng chữ Việt ("THỜI KHÓA BIỂU", T2–T7, tiết 1–5) rồi nắn phối cảnh vào khung
  bảng (hình gốc ghi "TIMETABLE/Mon/Tue"), tách nền trắng bằng loang từ 4 góc (áo dài trắng không bị thủng) → `cherry-mascot.png` (~660×910, nền trong suốt), `-512`, `-256`.
- **Web**: `web/assets/mascot/cherry-teacher.png` (378×512, 212 KB); `web/about/about.css` thêm khối `.ab-mascot` / `.ab-mascot-img` / `.ab-mascot-say` (hình 132 px + bong bóng lời thoại,
  104 px dưới 860 px); `web/index.html` đặt dưới hàng nút của hero ("Chào thầy cô, mình là Cherry! Xem video 14 phút…" → `/huong-dan`); `web/huong-dan/index.html` hero thành 2 cột
  (`.hd-hero-row`: chữ trái, linh vật phải; điện thoại xếp dọc). Cả hai trang đổi `about.css?v=20261124-mascot-v1`.
- **Deploy** (`scratch/huongdan-deploy/run_mascot.py`): preflight 3 file cũ = HEAD, backup `/root/tkb-backups/mascot-20261124/`, không restart. Live sha: index `f3afec5c2623f83f`,
  huong-dan `1fbc187a95930598`, about.css `3f8a86281494eee1`, hình `c46c0b8516e041b9`. Kiểm live (Playwright 1366 + 390 px, `/` và `/huong-dan`): hình nạp đủ, không tràn ngang, 0 lỗi JS.
  Test không chạy lại (chỉ HTML/CSS/hình tĩnh của trang công khai).
- **Chưa làm**: linh vật trong phần mềm (thẻ thông báo, hộp video), trong video; mô hình 3D; các dáng khác. Lời thoại trong bong bóng do Claude viết, chủ dự án chưa duyệt chữ.

## 2026-11-24 VIDEO HƯỚNG DẪN BẢN 4 — GIỌNG "RAN" (MINIMAX AUDIO, GIỌNG NHÂN BẢN CỦA CHỦ DỰ ÁN) — ĐÃ DEPLOY

- **Chủ dự án**: giọng edge-tts "hơi gò bó" → nghe 4 mẫu edge-tts không chọn, bảo dùng giọng **Ran** trong My Voices của tài khoản MiniMax Audio (minimax.io/audio, giọng
  Instant Clone, model `speech-2.8-hd`, 1 credit/ký tự). Lời thuyết minh GIỮ NGUYÊN, chỉ đổi giọng; hình và thứ tự cảnh không đổi.
- **Cách làm** (`scratch/video_huongdan/`): `ran/texts.json` = lời từng cảnh, các câu nối bằng thẻ nghỉ `<#1.5#>`; mỗi CẢNH tạo một lần trên trang Text to Speech (≤5.000 ký tự),
  lấy `audio_url` (CDN `cdn.hailuoai.video`, tải thẳng không cần đăng nhập) từ phản hồi `/v1/api/audio/details`; `ran_split.py <cảnh> <url>` tải về và cắt theo quãng lặng ≥1,1 s
  (`silencedetect`, kiểm số quãng = số câu − 1) thành `ran/<cảnh>_<nn>.mp3`; `build.py --ran` dùng các file đó thay edge-tts, đoạn dựng nằm ở `seg_ran/` (bản edge-tts vẫn còn ở `seg/`).
  Tổng 13 cảnh / 105 câu / ~14.400 ký tự. Bản 3 (edge-tts) giữ ở `out/huong-dan-tkbcherry.v3.mp4`.
- **Bẫy thao tác**: làm trong trình duyệt của Claude (chủ dự án đăng nhập sẵn); Claude in Chrome gõ vào ô soạn thảo của MiniMax là treo tab (3 lần). Xoá ô nhập bằng nút tẩy cạnh bộ
  đếm ký tự rồi mới gõ — Ctrl+A/Delete có lúc không ăn, chữ mới chèn vào giữa chữ cũ (hỏng 1 lượt ~4.900 credit, phải tạo lại Bước 8). Luôn xem bộ đếm ký tự trước khi bấm Generate.
  Tài khoản từ 84.271 còn ~64.000 credit sau cả việc.
- **Kết quả**: video 13'32" (812 s) — giọng Ran đọc nhanh hơn. Mốc: Giới thiệu 0:00, B1 0:24, B2 0:45, B3 1:40, B4 2:17, B5 2:54, B6 3:40, B7 4:07, B8 6:08, B9 8:33, Cherry Agent 9:35,
  Trường hợp đặc biệt 10:48, Tổng kết 13:18. Web: `?v=20261124d`, mốc mới trong `web/huong-dan/index.html` + `web/shared/guide-notice.js`, chữ "14 phút" (cả `web/index.html`).
- **Deploy**: video 28.491.723 byte sha `3b9d7dcc5899c1d7`; 3 file web qua `scratch/huongdan-deploy/run_video_v4.py` (preflight = HEAD), backup `/root/tkb-backups/huongdan-video-v4-20261124/`,
  không restart. Live sha: guide-notice `66fe9e270d214d99`, huong-dan `8af5d99ad4a53ac5`, index `7570e8141c1a1800`. Kiểm live (Playwright 1366 + 390 px): 13 mốc, bấm "Trường hợp đặc biệt"
  → 10:48 và phát, thời lượng 812 s, 0 lỗi JS. **Claude không nghe được âm thanh**: chưa ai nghe trọn bản mới (phát âm "Che-ri chấm e xê", "tê ca bê", tên tiếng Anh; chỗ cắt câu).
- **Linh vật chibi**: chủ dự án muốn chibi Ran Mori (Conan) / Aemeath (Wuthering Waves) bằng meshy.ai — Claude từ chối vì là nhân vật có bản quyền của hãng khác (kể cả "na ná đổi quần áo"),
  đề xuất nhân vật mới theo phong cách anime chibi (cô giáo nhỏ kẹp tóc cherry). CHƯA làm, chờ chủ dự án chốt.

## 2026-11-24 VIDEO HƯỚNG DẪN BẢN 3 (17'17", ĐỦ 12 TRƯỜNG HỢP ĐẶC BIỆT) — ĐÃ DEPLOY

- **Chủ dự án** (sau bản 2 chỉ nói 6/12 trường hợp): "đưa mấy cái đó vào clip chứ" → chương "Trường hợp đặc biệt" nay đi đủ 12 thẻ theo đúng thứ tự trang `/huong-dan`:
  thêm lớp nghỉ buổi/tiết (phím X + Yêu cầu cố định lớp học), môn chỉ học chiều (Giới hạn buổi của môn học), Dạy ghép, tiết cố định (bấm đúp), tiết đôi + giờ ra chơi.
  **Bài học: trang chữ có gì thì video phải có đủ, đừng tự bỏ vì "đã nói ở bước trước".**
- Video 17'17" (1037 s): Cherry Agent 12:22, Trường hợp đặc biệt 13:57 (16 câu), Tổng kết 16:58. `record_c.py` (đã viết lại phần `c_dacbiet`, ảnh Dạy ghép `shots/c_dg.png`),
  bản 2 giữ ở `out/huong-dan-tkbcherry.v2.mp4` + `scenes_c.v2.json`. Giọng đọc đoạn mới CHƯA nghe lại bằng tai.
- Web: `?v=20261124c`, mốc Tổng kết `1018` trong `web/huong-dan/index.html` và `web/shared/guide-notice.js`, chữ "17 phút" (cả `web/index.html`).
- Deploy 24/11: video 33.709.325 byte sha `9d5d0d8253593760` (`install-public-media-nginx.py --apply`, nginx không đổi); 3 file web qua `scratch/huongdan-deploy/run_video_v3.py`
  (preflight = HEAD), backup `/root/tkb-backups/huongdan-video-v3-20261124/`, không restart. Live sha: guide-notice `b75ac77e974cf8a9`, huong-dan `4e98511c836d621c`,
  index `bd82ae7d0106245b`. Kiểm live (Playwright 1366 + 390 px): 13 mốc, bấm Tổng kết → 16:58 và phát, thời lượng 1037 s, 0 lỗi JS; hộp video của module cũng nhảy đúng.

## 2026-11-24 VIDEO HƯỚNG DẪN BẢN 2 (16'02", THÊM 2 CHƯƠNG) + LINK "ĐỌC THÊM" TRONG HỘP VIDEO CỦA APP — ĐÃ DEPLOY

- **Chủ dự án** duyệt danh sách 12 trường hợp ("Danh sách ổn rồi") rồi bảo làm tiếp 2 việc còn ngỏ: link tới 2 mục chữ trong hộp video của app, và đưa
  Cherry Agent + trường hợp đặc biệt vào video.
- **Video bản 2**: 16'02" (bản 1 là 12'41"), thêm 2 chương TRƯỚC Tổng kết — "Cherry Agent" 12:22 (8 câu: công tắc ở đâu, hộp "Cherry Agent cần Cherry.exe",
  3 bước cài, Chrome hỏi, Tắt Agent xếp trên máy chủ, ý nghĩa chấm màu) và "Trường hợp đặc biệt" 13:57 (10 câu: 2 cơ sở, giới hạn buổi dạy, môn tránh tiết,
  giới hạn tiết/ngày, giới hạn số tiết/1 thời điểm, còn tiết Chưa phân, thẻ "Xem thêm"); Tổng kết dời tới 15:44. Các chương 1–9 KHÔNG đổi (dùng lại đoạn đã dựng).
  Nguồn: `scratch/video_huongdan/record_c.py` → `scenes_c.json`; `build.py` chèn `scenes_c.json` trước cảnh `ket` và thêm cách đọc `Cherry.exe`/`Cherry.zip`/`100 MB`/`Run`.
  Bản 1 giữ ở `scratch/video_huongdan/out/huong-dan-tkbcherry.v1.mp4`. Quay không chạy lượt xếp nào và không sửa kho mẫu (chỉ mở bảng ra chụp). Giọng đọc CHƯA nghe lại bằng tai
  (các chữ tiếng Anh "Run anyway", "More info", "Agent" là chỗ dễ đọc sai nhất).
- **Web**: `web/huong-dan/index.html` (13 mốc, `?v=20261124b`, "khoảng 16 phút"), `web/shared/guide-notice.js` (`CHAPTERS` 13 mốc, `VERSION` `20261124b`, thẻ thông báo ghi
  "16 phút…", dòng "Đọc thêm:" dưới video với 2 link `/huong-dan#agent` và `/huong-dan#truong-hop-dac-biet`), `web/index.html` (nút "…9 bước (16 phút)").
- **Deploy 24/11 ~11:55**: video qua `install-public-media-nginx.py --apply` (ghi đè cùng tên, 30.989.369 byte, sha `b2118d1b87ef31b9`, cấu hình nginx không đổi); 3 file web qua
  `scratch/huongdan-deploy/run_video_v2.py` (preflight cả 3 = HEAD), backup `/root/tkb-backups/huongdan-video-v2-20261124/`, không restart. Live sha: guide-notice `94b390254f3a73ed`,
  huong-dan `8c2aad96d6f185b3`, index `4ad2bdb4f5e70db4`.
- **Kiểm live** (Playwright 1366 và 390 px): `/huong-dan` 13 mốc, bấm "Trường hợp đặc biệt" → 13:57 và phát, thời lượng 963 s, không tràn ngang, 0 lỗi JS; nạp module trên
  trang công khai → hộp video phát bản `?v=20261124b`, bấm "Cherry Agent" → 12:22, 2 link Đọc thêm đúng. Hộp video trong app sau đăng nhập chỉ kiểm trên máy chủ thử local.
  Test không chạy lại (chỉ HTML/JS tĩnh của trang công khai và module độc lập).

## 2026-11-24 TRANG /huong-dan THÊM MỤC "CHERRY AGENT" + "MỘT SỐ TRƯỜNG HỢP ĐẶC BIỆT" — ĐÃ DEPLOY

- **Chủ dự án**: "bạn nên ghi rõ chỗ sử dụng cái đặt agent rồi 1 số trường hợp đặc biệt của các trường". Claude hiểu là viết thành CHỮ trên trang Hướng dẫn
  (video giữ nguyên, chưa có đoạn nào về Agent); danh sách trường hợp do Claude chọn từ các tình huống đã gặp khi xếp cho các trường — CHỜ chủ dự án duyệt/bổ sung.
- `web/huong-dan/index.html` (chỉ file này): 2 nút nhảy dưới video (`.hd-jump`), mục `#agent` (4 hộp: công tắc Agent ở đâu + ý nghĩa chấm màu trên nút Cherry; cài
  Cherry.exe 3 bước; khi Chrome hỏi / chặn; tắt Agent để xếp trên máy chủ + ô ⏱ + Dừng) và mục `#truong-hop-dac-biet` (12 thẻ: 2 cơ sở, lớp nghỉ buổi/tiết, môn chỉ
  học chiều, dạy ghép, GV thỉnh giảng/kiêm nhiệm, tiết cố định, tiết đôi + ra chơi, giới hạn tiết/ngày, môn tránh tiết, phòng có hạn, còn tiết Chưa phân, liên hệ).
  Chữ lấy nguyên từ giao diện: hộp cài đặt trong `tkb-rust-bridge.js`, tên luật trong `shared/constraints-meta.js`, nhóm menu trong `tkb-constraints-menu.js` —
  **đổi tên luật / chữ hộp Agent thì sửa cả trang này**. Không nêu tên trường thật. Theo chỉ đạo 31/10 không viết "máy mạnh / máy yếu".
- Deploy 24/11 (runner `scratch/huongdan-deploy/run_doc_sections.py`): preflight remote = HEAD, backup `/root/tkb-backups/huongdan-doc-sections-20261124/`, không restart;
  live sha `a4262eb5ada16b1e`, `/api/health` 200. Kiểm bố cục bằng Playwright trên bản local (1366 và 390 px: không tràn ngang, 0 lỗi JS, nút nhảy tới đúng mục).
  Chưa đối chiếu từng thẻ bằng cách bấm thật trong app (chỉ đối chiếu với mã nguồn); test không chạy lại (chỉ đổi HTML tĩnh).

## 2026-11-24 THÔNG BÁO + NÚT "HƯỚNG DẪN" XEM VIDEO NGAY TRONG APP — ĐÃ DEPLOY

- **Chủ dự án**: "tôi muốn có 1 thông báo khi người dùng vào họ vẫn thấy được video hướng dẫn này trong giao diện app".
- **Module mới `web/shared/guide-notice.js`** (tự chèn CSS, không phụ thuộc file khác; nạp ở `web/app.html` và `web/pages/sapxep.html`):
  - Thẻ thông báo `#tkbGuideNotice` góc dưới phải ("MỚI · Video hướng dẫn xếp TKB", nút "▶ Xem video" / "Để sau" / ×), KHÔNG chặn thao tác.
    Hiện ~1,8 s sau khi vào trang, mỗi trình duyệt một lần (`localStorage TKB_GUIDE_NOTICE_V1`, ghi khi bấm bất kỳ nút nào của thẻ hoặc mở video);
    đang xếp (`__TKB_RUST_SOLVER_RUNNING` / `__TKB_SOLVE_UI_BUSY`) hoặc đang có hộp Cherry Agent / cài Cherry.exe thì chờ. Muốn hiện lại cho mọi người: đổi khoá sang `_V2`.
  - Hộp `#tkbGuideModal` (`window.TKBGuide.open()` / `.close()`, Esc hoặc bấm nền để đóng, đóng thì dừng video): `<video>` + mục lục 11 mốc bấm để nhảy, link
    "Mở ở trang riêng" → `/huong-dan`. Video lấy `/media/huong-dan-xep-tkb.mp4` (nginx); ngoài tkbcherry.com (Cherry Local, Netlify, máy thử) lấy từ `https://tkbcherry.com`.
    `CHAPTERS` + `VERSION` trong file phải sửa cùng `web/huong-dan/index.html` khi thay video.
- **Nút cố định `#btnGuideVideo`**: `app.html` thêm "▶ Hướng dẫn" cạnh "File .cherry" (class `cf-nav-btn`); `sapxep.html` thêm "Hướng dẫn" cạnh nút Home (dùng lại class
  `agent-helper-button` có sẵn CSS), **ẩn dưới 900 px** vì thanh công cụ điện thoại đã kín (nút làm thanh xuống thêm một hàng) — điện thoại vẫn thấy thẻ thông báo và nút ở trang nhập liệu.
- **Deploy 24/11** (Claude, runner `scratch/huongdan-deploy/run_app_notice.py`, khoá SSH qua worktree `claude/ssh-host-key-pin`): 3 file web, backup
  `/root/tkb-backups/huongdan-app-notice-20261124/`, không restart, không đụng DB. Preflight: `sapxep.html` trên VPS = HEAD; `app.html` trên VPS khác HEAD đúng 1 dòng
  (`shared/auth.js?v=20260823…` thay vì `20260904…` — bản 02/09 chưa được đẩy lại sau khi đổi `?v=`; static trả `no-store` nên vô hại), đã tải về diff rồi mới ghi đè.
  Sau deploy sha khớp: `guide-notice.js 858f000d0e3123f7`, `app.html 460701ab0fbb082d`, `sapxep.html 8c4fdd71cd753cb6`; `/api/health` 200.
- **Kiểm**: máy chủ thử local cổng 2399 (`scratch/huongdan-deploy/check_app_notice.py`, Playwright 1366×768 và 390×844 mobile): thẻ hiện ở cả trang nhập liệu và
  Sắp xếp, bấm Xem video → hộp mở, "Bước 8" nhảy 08:00 và phát, Esc đóng + dừng video, F5 không hiện lại thẻ, nút menu mở lại được, không tràn ngang, 0 lỗi JS.
  Trên live chỉ kiểm được phần KHÔNG cần đăng nhập (3 file trả đúng sha; nạp module trên một trang công khai của tkbcherry.com → thẻ hiện, video phát từ `/media/`).
  **CHƯA kiểm bằng tài khoản thật trên live**, chưa thử điện thoại thật.
- **Test** `run_tests.py`: vẫn đúng 7 [MOI HONG] như mục dưới (6 bộ planner do `phanmon.js` CRLF + `test_engine_v3_cpsat_lns` trượt ngưỡng thời gian), không thêm mục nào.

## 2026-11-24 THCS Hồ Văn Long (Chính) TKB 7 — LẦN 4: nhóm ghép theo THỐNG KÊ-L2 + PCCM 23/11, khung chiều mới, tiết ghép cuối buổi — ĐÃ GHI vào kho

Chủ dự án thêm 2 file vào `phancong/hovanlongchinh/moi3` (`THỐNG KÊ...-L2.xlsx` có cột "XẾP LỚP" ghi rõ lớp nào ghép lớp nào;
`21.11-...PHAN CONG...xlsx` bản 23/11 23:59 đổi GV TATC/TABN, Tin QT, STEM) + dặn trong chat (24/11):
**sáng học full; chiều T2–T4 tới tiết 4, T5–T6 tới tiết 3; lớp chỉ 29 tiết được nghỉ 1 buổi; tiết GHÉP nằm cuối buổi chiều, trước đó
phải có tiết chính khoá (ai không học thì về); các lớp cùng khối, số tiết gần nhau thì ra về giống nhau.**

- Nhóm (xem `scratch/hvl7/build10.py`): K6 nguyên lớp; TATC/TABN ghép 7/3+7/4 (TA.Hương), 8/1+8/8 (TA.My), 9/1–9/5+9/9 (TA.Nghi),
  9/6+9/7 (TA.Vũ2), 9/10+9/11 (TA.Vũ1); **8/4 tách đôi** (14 HS học với 8/6 – cô Vương, 5 HS với 8/7 – cô Mỹ) → một dòng Dạy ghép
  3 lớp 2 GV `TATC-8/4+8/6+8/7` (2 nhóm bắt buộc cùng giờ, nếu khác giờ lớp 8/4 cần 41 ô > 38). Tin QT ghép 8/7+8/8. STEM ghép
  7/1+7/2+7/3, 7/4+7/5+7/8, 8/2+8/4, 8/1+8/6+8/7+8/8; **K9 không còn STEM** (bảng STEM không phân GV cho K9). 6/7 TATC file không ghi GV →
  giữ TA.Vương. GV TATC khác: 7/1 TA.Quỳnh, 7/5 + 7/6 TA.Hảo, 7/2 + 7/7 TA.Mỹ, 7/8 TA.Ni, 8/2 TA.Nhân.
- Khung: `fixedOff.class` mở `thu4|chieu|3`, đóng `thu5|chieu|3` + `thu6|chieu|3` (38 ô/lớp). Gốc = kho sống 23/11 ~23:42 (chủ dự án
  vừa thêm ô nghỉ tiết 3–4 chiều cho SĐ.Thy, TA.Quỳnh, TN.Thơ, TO.Thu, MT.Diễm chiều T5…): giữ nguyên, trừ **TA.Quỳnh `thu4|chieu|2`
  phải gỡ** (cô nhận TATC/TABN 7/1 nhưng bị đánh dấu nghỉ hết ô cuối buổi → không còn chỗ; `softfo10.json`).
- Bộ xếp `h10_lns.py` (sinh từ `mk_h10.py` trên h9): sáng full (`MORN_ALLOW`=0), `OFF_ALLOW` (lớp ≤29 tiết CK và tiết chiều ≤15 được
  nghỉ 1 chiều → cả K9), tiết ghép cấm buổi sáng và cấm buổi "trọn liên kết" (`joint_place`), `dismiss()` + `W_DIS` (cùng khối cùng số
  tiết → độ dài buổi chiều từng ngày bằng nhau), chiều 3 tiết (T5/T6) cho 1 tiết CK rồi LK (`W_ONE`, phạt nhẹ). `h10_finalize.py`.
  Bài học tốc độ: lượt toàn trường có đủ mục tiêu mềm KHÔNG gỡ nổi vài tiết cuối; `REPAIR=1` + `FORCE` cả khối (8 lớp, 45–150 s) gỡ
  ngay, sau đó chạy lượt thường 4–7′ để gọn lại lịch GV.
- Kết quả đã ghi (`final13.json` = `live_f13.json`, `_updatedAt` 1795457558202): 1249 tiết-lớp đủ, sáng lớp nào cũng 4 tiết, 0 trùng GV,
  RB Node 1 thông báo (THQT 8/4 chưa thành tiết đôi). K9: 10 lớp có LK nghỉ chiều T4, 9/8 + 9/12 nghỉ chiều T6. GV 446 buổi / 21 buổi
  1 tiết / 42 trống 1 / 0 trống 2 (buổi 1 tiết tăng vì GV liên kết dạy tiết ghép cuối buổi). Ra về lệch khối: 5 lớp (6/5, 6/7, 7/1, 7/4,
  8/4). 9 buổi chiều T5/T6 chỉ 1 tiết CK trước LK. Excel: `moi3/TKB LIEN KET - TKB7 lan 4 (24-11-2026).xlsx` (`export10.py`).
- **24/11 sáng — chủ dự án bấm "Chạy tiếp" (gỡ lệch giờ ra về) → ĐÃ GHI `final14.json` = `live_f14.json` (`_updatedAt` 1795491871403).**
  Gỡ thêm được **6/5** (còn lệch 4 lớp: 6/7, 7/1, 7/4, 8/4); RB Node vẫn 1 (THQT 8/4 chưa đôi); GV 444 buổi / 18 buổi 1 tiết / 41 trống 1 /
  0 trống 2 (tốt hơn bản `final13`). 242 ô ở 29 lớp đổi so với `final13` (do lượt gọn buổi GV). `apply.py` EXPECT = `live_f14.json`.
  Đã CHỨNG MINH (CP-SAT OPTIMAL, mở cả khối, các khối khác giữ nguyên): K6 muốn 6/7 theo mẫu (4,4,4,2,3) thì TATC + TABN 6/7 phải chung
  chiều T2 (trái luật nhóm "Anh/TATC/TABN không cùng buổi"); K8 ép 8/4 theo mẫu thì dư 1 tiết THQT 8/4; riêng K8 không tạo được tiết đôi
  THQT 8/4. K7: 7/1 kẹt CN.Dung (19 tiết/19 ô) + ô cuối buổi của TA.Quỳnh; 7/4 kẹt TQT.Dũng. Toàn trường ép cứng (240 s) và K6+K8 (200 s)
  không hội tụ (còn 2–4 tiết chưa xếp). Muốn gỡ tiếp phải NỚI luật (chưa hỏi/chưa được duyệt): cho 6/7 học TATC + TABN cùng chiều, hoặc
  bớt ô nghỉ cuối buổi của GV liên kết.
  Công cụ thêm vào `h10_lns.py`: `HARD_DIS=6,7,8` (ép cứng cả khối ra về cùng giờ khi cả khối nằm trong vùng), `PAT="6/5:4,4,4,2,3"` (ép độ
  dài buổi chiều của 1 lớp), `NEIGH_T=1` (vùng = lớp chung GV với lớp bị ép); sửa lỗi `REPAIR` (mục tiêu "gần lưới cũ" trước đây thêm SAU
  `Minimize` nên không có tác dụng). Bài học: (1) gỡ 1 lớp = `PAT` + vùng NHỎ (K=3, 15 s, nhiều vòng) — vùng 14–18 lớp không hội tụ trong
  60–90 s; (2) chạy `K=1` trước để biết tiết nào/GV nào kẹt rồi mới chọn vùng; (3) lượt gọn buổi sau đó phải để `W_DIS` < `W_RULE`
  (4500 < 5000): đặt 20000 thì bộ xếp đổi 1 ô trống buổi sáng lấy 1 điểm ra về (trái luật "sáng full").
  Hỏi "cho 6/7 học TATC + TABN chung một buổi chiều để khối 6 ra về đều không?" → chủ dự án 24/11: **"Giữ vậy"** — KHÔNG nới luật nhóm
  Anh/TATC/TABN; chấp nhận 4 lớp ra về lệch + THQT 8/4 chưa đôi. `final14` là bản dùng.
- **24/11 trưa — chủ dự án: "dạy 1 tiết/buổi còn nhiều quá xử lý giúp được không" → ĐÃ GHI `final15.json` = `live_f15.json`
  (`_updatedAt` 1795496512526, `apply.py` EXPECT = `live_f15.json`).** GV 441 buổi / **13 buổi 1 tiết** (trước 18) / 39 trống 1 / 0 trống 2;
  **RB Node 0** (THQT 8/4 đã thành tiết đôi); 389 ô ở 33 lớp đổi so với `final14`. Đổi lại: ra về lệch khối 5 lớp thay vì 4
  (6/7, 7/1, 7/4 như cũ; 8/4 hết lệch, 8/1 + 8/8 lệch mới: (4,4,4,3,2) và (4,4,3,3,3) so với khối 8 (4,4,4,2,3)); 9 buổi chiều T5/T6 1 tiết CK.
  13 buổi còn lại: ST.3 ×4, ST.Khải ×4 (mỗi người 4 nhóm × 1 tiết, tiết ghép phải cuối buổi chiều + cả khối ra về cùng giờ → mỗi chiều chỉ
  1 ô; ép cứng `NOSING` thì ST.3 dư 1 tiết, ST.Khải mất 1 tiết đôi + lệch ra về +3 lớp — chưa chứng minh OPTIMAL), TA.Hương, TA.Hảo
  (tiết TATC lẻ cuối buổi; gỡ thì lệch ra về), MT.Vĩ, SĐ.Linh, TN.Thái (chưa thử hết).
  Công cụ thêm: `NOSING="GV,..."` (ép cứng GV không có buổi 1 tiết), `FORCE_T="GV1;GV2"` (vùng = mọi lớp của GV), `nosing_drv.py`
  (đi từng GV: REPAIR + NOSING + FORCE_T, chỉ nhận khi không thêm vi phạm). Bài học: REPAIR bỏ mục tiêu buổi 1 tiết nên gỡ người này đẩy
  sang người khác (18 → 30 tạm thời) — phải chạy lượt thường sau đó (`W_SG=2400 W_DIS=4900 W_ONE=1500`, K=4 SUB=10 nhanh hơn K=6 SUB=20);
  lượt nhắm `FORCE_T` 7 GV ở chế độ thường (không REPAIR) hiệu quả nhất: 16 → 13 và tự gỡ luôn tiết đôi THQT 8/4.
- **24/11 ~12:45 — chủ dự án bấm "Thử nới cho STEM" (cho vài lớp ra về lệch để gom buổi GV STEM) → ĐÃ GHI `final17.json` = `live_f17.json`
  (`_updatedAt` 1795499001641, `apply.py` EXPECT = `live_f17.json`).** GV **434 buổi / 3 buổi 1 tiết** (SĐ.Linh chiều T5 t1 7/8, TA.Hảo chiều
  T3 t4 TATC 7/6, VA.Loan chiều T5 t1 6/3) / 44 trống 1 / 0 trống 2; RB Node 0; 0 trùng GV; ST.3 dạy chiều T4 + T5, ST.Khải chiều T5 + T6
  (mỗi người 2 buổi × 2 tiết). Ra về lệch khối **4 lớp** (6/7, 7/1, 7/7, 8/3) — KHÔNG tăng; mẫu K7 + K8 đổi thành (4,4,4,3,2). Giá phải
  trả: 11 buổi chiều T5/T6 chỉ 1 tiết CK trước LK (trước 9). 407 ô đổi so với `final15`.
  **ĐÍNH CHÍNH**: kết luận "8 buổi 1 tiết của GV STEM kẹt luật" ở mục trên là SAI — các lượt thử 130–150 s chưa hội tụ. `REPAIR=1 NOSING=<GV>
  FORCE_T=<GV> W_DIS=500 W_ONE=500`, SUB **240 s**, 10 luồng → cả hai GV đều ra lời giải 0 vi phạm, dis không đổi (ST.Khải OPTIMAL).
  Hai lượt chạy song song từ cùng một lưới (K7 / K8 rời nhau) rồi GHÉP theo lớp (`s_merge.json`, 1 trùng GV → lượt thường tự gỡ), sau đó
  lượt thường `NOSING="ST.3,ST.Khải,ST.Duy"` K=4 SUB=10 300 s (19 → 6) + 2 lượt `FORCE_T` nhắm GV còn buổi 1 tiết (6 → 5 → 3).
  Bài học: đừng kết luận "bất khả" từ lượt FEASIBLE ngắn — chỉ nói thế khi CP-SAT trả OPTIMAL; vùng cả khối 8 lớp cần ~4 phút.
- **24/11 chiều — LUẬT MỚI của chủ dự án: "Tin quốc tế là buổi chiều nhé" + "Tiếng Anh tăng cường cũng xuống chiều luôn"** (hỏi tiếp sau câu
  "vẫn còn 3 tiết lẻ có cách nào xử lý triệt để không"). → `base16.json` = `base15` + `subject.THQT/TATC.byClass[*].sessionAllowed.allowMorning
  = false` (cả 4 môn LK giờ cấm buổi sáng; 10 buổi sáng "trọn liên kết" TATC+THQT của `final17` không còn hợp lệ).
  **BẢN XEM THỬ đã ghi `prev19.json` = `live_p19.json` (`_updatedAt` 1795505274187, `apply.py` EXPECT = `live_p19.json`) — CHƯA PHẢI BẢN
  CUỐI:** 1249 tiết đủ, sáng lớp nào cũng 4 tiết chính khoá, 0 tiết LK buổi sáng, 0 trùng GV; **RB Node 5 thông báo = 2 lỗi** (THQT 8/5
  chưa đôi; TN.Quang 4 tiết chiều T4, `maxPeriods` = 3); GV 424 buổi / **16 buổi 1 tiết** / 45 trống 1 / 0 trống 2; **ra về lệch 9 lớp**
  (6/1, 6/3, 6/4, 6/6, 6/7, 7/1, 7/2, 7/6, 8/3); 12 chiều T5/T6 chỉ 1 tiết CK. Bản tốt trước khi đổi luật: `final17.json`/`live_f17.json`
  (3 buổi 1 tiết, lệch 4 lớp, RB 0) — giữ để quay về nếu chủ dự án đổi ý.
  Vì sao khó: (1) mỗi lớp K6/K7 có 8 tiết LK phải nằm hết cuối các buổi chiều (9 tiết CK chiều) — gần như không còn tự do; TQT.Dũng
  16 tiết/18 ô chiều (8 tiết đôi trên đúng 8 chỗ đặt được); (2) **sáng T3**: 27 GV chính khoá nghỉ cả buổi, số còn lại dạy tối đa 142 tiết
  cho 140 ô lớp (dư 2) — `morn_bound.py BASE` chứng minh 700/700 ô sáng lấp được (nới lỏng), và cuối cùng lấp được thật bằng `FORCE`
  quanh lớp bị trống + lớp của GV còn rảnh sáng T3 (lỗ trống cứ dời 8/5 → 9/1 → hết).
  Đã chứng minh OPTIMAL: riêng K8 (khối khác giữ nguyên) không tạo được tiết đôi THQT 8/5; riêng 7/3 + 7/6 không gỡ được TN.Quang
  (chỉ dạy chiều T3/T4/T6, ≤3 tiết/buổi, 8 tiết KHTN). K7 cả khối 200 s + vùng liên khối `NEIGH_T` 290 s: chưa gỡ, CHƯA chứng minh.
  Trình tự đã chạy: REPAIR 23 lớp K6–8 480 s (hết `morning_forbidden`, còn 11 tiết thiếu) → REPAIR LNS K=8–14 (11 → 0 thiếu) → FORCE
  sáng T3 → lượt thường K=4 SUB=10 (51 → 19 buổi 1 tiết) → +2 lượt (16). Việc còn lại: 2 lỗi luật, `NOSING` cho ST.3/ST.Khải/ST.Duy
  (đang lại có buổi 1 tiết), kéo `dis` 15 xuống.
- **24/11 tối — chủ dự án: "Giữ luật, chạy tiếp" → BẢN XEM THỬ MỚI `prev20.json` = `live_p20.json` (`_updatedAt` 1795507580856, `apply.py`
  EXPECT = `live_p20.json`):** GV 423 buổi / **10 buổi 1 tiết** (ST.3 ×2, ST.Khải ×2, ST.Duy, TA.Ni, TA.Trang, TO.Hoàng, TO.Thảo1,
  VA.Trang) / 41 trống 1 / 0 trống 2; **ra về lệch 8 lớp** (6/1, 6/2, 6/3, 6/7, 7/1, 7/6, 7/7, 8/3); 10 chiều T5/T6 chỉ 1 tiết CK;
  **vẫn 2 lỗi RB** (THQT 8/5 chưa đôi; TN.Quang 4 tiết chiều T4). Đủ tiết, sáng full CK, 0 LK buổi sáng, 0 trùng GV.
  Đã thử thêm mà KHÔNG gỡ được 2 lỗi (đều FEASIBLE, không chứng minh): REPAIR cả K7 320 s; REPAIR K8 + 9/1, 9/3, 9/4, 9/5, 9/6 320 s.
  Ép `NOSING` GV STEM theo khối dưới luật mới: ST.Khải được nhưng `dis` +2 (OPTIMAL); ST.3 → vỡ luật nhóm TATC + two_sess; ST.Duy → mất
  2 tiết đôi (2 cái sau FEASIBLE 250 s). Lượt thường `W_SG=3500 W_DIS=3000`: 16 → 10 buổi 1 tiết rồi đứng yên (2 lượt 10′ không giảm) —
  LNS đã chạm ngưỡng. Hướng còn lại cần chủ dự án quyết: chấp nhận 2 lỗi (cho TN.Quang 4 tiết chiều T4, THQT 8/5 2 tiết rời) hay nới
  ô nghỉ/giới hạn GV.
- **24/11 ~16:25 — chủ dự án: "coi lại file pccm mới rồi chỉnh lại các phân công liên kết rồi chạy lại" → BẢN XEM THỬ `prev21.json` =
  `live_p21.json` (`_updatedAt` 1795512315684, `apply.py` EXPECT = `live_p21.json`).** File `moi3/23.11-…-GỬI ÂN.xlsx` được sửa 16:00
  24/11 (bản sao `scratch/hvl7/pccm2411.xlsx`), thêm sheet `Sheet1` "MÔN LIÊN KẾT" ghi rõ lớp riêng/lớp ghép + GV; trường đã xoá 2 file
  THỐNG KÊ và file Excel xuất cũ khỏi `moi3`. So từng dòng với kho: **chỉ khác 1 chỗ — nhóm STEM 7/4+7/5+7/8 do STEM4 dạy** (kho để
  ST.3). `build11.py IN OUT`: thêm GV `ST.4` (GV094, "STEM 4"), `DG929.gv = ['ST.4']` + 3 khoá `pccmMatrix` → `base17.json` (luật) và
  `g0.json` (lưới f4). Các chỗ file tự mâu thuẫn, GIỮ như kho và đã báo chủ dự án: Sheet1 khối 6 ghi "6/1…6/5, 6/7" (thiếu 6/6) nhưng
  sheet PCCM ghi cô Vương dạy 6/6 và Tin QT/STEM "6/1->6/7" (thống kê L2: 6/6 và 6/7 đều 38 HS, giữ nguyên lớp) → cả 6/6 lẫn 6/7 có
  LK, 6/7 vẫn cô Vương; Sheet1 khối 9 bỏ trống cột TABN nhưng PCCM ghi "TATC,TABN" + Số tiết CT TABN K9 = 2 → giữ TABN K9; nhóm
  "8/4+8/7 (Mỹ)" và "8/6+8/4 (Vương)" vẫn là 1 dòng ghép 3 lớp 2 GV cùng giờ (8/4 tách đôi). Chính khoá: danh sách lớp từng GV khớp
  (cột tổng của file lệch ở SĐ.Tràng 17/20, TO.Hưởng 19/18 — file cộng sai, không sửa). Kho sống trước khi ghi chỉ khác bản p20 ở chỗ
  app tự bỏ 11 khoá `pccmTietMatrix` `<lớp>|STEM` = '1' (bằng tiết chuẩn) — không phải chủ dự án sửa.
  Chạy lại: K7 mở cả khối 300 s (lượt thường; REPAIR cùng lúc đổi `t_max_per` lấy lỗi khác → bỏ) → `FORCE_T` GV có buổi 1 tiết 240 s
  = `h8.json`. Kết quả ghi: GV 422 buổi / **8 buổi 1 tiết** (ST.3, ST.4 — chỉ 1 tiết/tuần nên luôn là buổi 1 tiết, ST.Duy, TA.Ni,
  TA.Trang, TN.Giang, TO.Hoàng, TO.Thảo1) / 38 trống 1 / 0 trống 2; **ra về lệch 9 lớp** (6/1, 6/2, 6/3, 6/7, 7/1, 7/6, 7/7, 8/3, 8/5);
  **vẫn 2 lỗi RB cũ** (THQT 8/5, TN.Quang chiều T4). Lượt `W_DIS=4500` sau đó (`h9.json`, KHÔNG ghi) chỉ đổi ngược: 10 buổi 1 tiết /
  8 lớp lệch — hai chỉ số đang đánh đổi nhau. Excel: `phancong/hovanlongchinh/moi3/TKB LIEN KET - TKB7 lan 5 (24-11-2026).xlsx`.
- **24/11 ~16:45 — chủ dự án trả lời: "thiếu 6/6 và STEM3 dạy luôn lớp ghép 7/4 7/5 7/8" → ĐÃ BỎ `ST.4`, kho = `prev22.json` =
  `live_p22.json` (`_updatedAt` 1795513312351, `apply.py` EXPECT = `live_p22.json`).** Tức Sheet1 ghi thiếu 6/6 (6/6 vẫn học đủ 4 môn
  LK) và ô "STEM4" trong file là sai: ST.3 dạy cả 2 nhóm ghép K7. Luật quay về `base16.json` (phân công = y bản p20; `base17.json`,
  `build11.py`, `prev21` chỉ còn là lịch sử). Lưới: `h8.json` chấm lại theo base16 (0 trùng GV) + 1 lượt `FORCE_T` 240 s = `j1.json`.
  Kết quả ghi: GV 421 buổi / **8 buổi 1 tiết** (ST.3 ×2: chiều T4 t4 nhóm 7/1+7/2+7/3, chiều T5 t2 nhóm 7/4+7/5+7/8; ST.Duy, TA.Ni,
  TA.Trang, TN.Giang, TO.Hoàng, TO.Thảo1) / 37 trống 1 / 0 trống 2; ra về lệch 9 lớp (như p21); **vẫn 2 lỗi RB** (THQT 8/5 chưa đôi,
  TN.Quang 4 tiết chiều T4). Excel "lan 5" đã xuất lại từ `live_p22.json`. Bài học: file mới khác kho đúng 1 ô lạ (GV chưa từng có)
  thì hỏi trước rồi mới thêm GV.

## 2026-11-24 TRANG /huong-dan + VIDEO HƯỚNG DẪN 9 BƯỚC TRÊN tkbcherry.com — ĐÃ DEPLOY

- **Chủ dự án**: "dựa vào các TKB đã xếp tạo video hướng dẫn thật chi tiết… ví dụ Chi Lăng", rồi "up lên trang chủ hoặc chỗ nào gọi là hướng dẫn cho thầy cô xem".
- **Video** 12'41", 1920×1080, giọng đọc `vi-VN-HoaiMyNeural` + phụ đề, quay từ app thật chạy trên máy (Chi Lăng TKB 2, tên GV/trung tâm giả, trường hiện là
  "THCS Mẫu"; bỏ 8 ô nghỉ của một GV Tin để nút Cherry xếp đủ 1339/1339). Dựng tự động trong `scratch/video_huongdan/` (gitignored: Playwright chụp + edge-tts +
  ffmpeg; sửa lời trong `scenes_*.json` rồi `build.py` chỉ dựng lại đoạn đổi). Giọng đọc CHƯA được nghe lại bằng tai.
- **Trang mới `web/huong-dan/index.html`** (`/huong-dan`): dùng `about/about.css` + `<style>` riêng (`hd-*`), trình phát `<video>` + mục lục 11 mốc bấm để nhảy
  (`data-t` giây, tô mốc đang phát), tóm tắt 4 việc, lời mời đăng nhập. Ảnh bìa `web/assets/huong-dan/poster.jpg`. Mốc thời gian chép từ
  `scratch/video_huongdan/out/muc-luc.txt` — dựng lại video làm lệch mốc thì sửa `data-t` + `<time>`.
- **Trang chủ `web/index.html`**: menu thêm "Hướng dẫn"; nút "Xem video hướng dẫn" ở hero (menu ẩn dưới 860 px nên điện thoại cần nút này), nút dưới 4 bước
  "Cách bắt đầu", link chân trang. `web/sitemap.xml` thêm `/huong-dan`.
- **Video do NGINX phục vụ, không nằm trong git**: Rust `is_public_static_file` không nhận `.mp4` và không có HTTP Range (iPhone không phát/tua được). Công cụ mới
  `tools/vps-deploy/install-public-media-nginx.py [--apply] [file.mp4…]` (mẫu theo `install-public-seo-nginx.py`): tải file vào
  `/var/www/tkbcherry-public/media/`, chèn khối `TKB_PUBLIC_MEDIA_BEGIN/END` (`location ^~ /media/`, chỉ type mp4, cache 1 ngày) trước `location /`, sao lưu,
  `nginx -t`, reload. File đang chạy: `/media/huong-dan-xep-tkb.mp4` (23,2 MB, faststart, âm thanh mono 80k; nguồn `scratch/huongdan-deploy/`). Thay video = chạy
  lại công cụ với file cùng tên, rồi đổi `?v=` trong trang (cache 1 ngày).
- **Deploy 24/11 ~00:50** (Claude chạy, khoá SSH qua `connect_vps` của worktree `claude/ssh-host-key-pin` vì nhánh này chưa có; runner `scratch/huongdan-deploy/
  nginx_media.py` + `run.py`): nginx backup `/root/tkb-backups/nginx-public-media-20261124-005017/`; web backup `/root/tkb-backups/huongdan-20261124/`
  (index.html + sitemap cũ), không restart. Preflight: index/sitemap trên VPS = HEAD. Sau deploy sha khớp (index `fd51ab0799a8fdde`, huong-dan `790174baecf7cc56`).
  Gỡ: `install-public-media-nginx.py --remove --apply` + trả `web/index.html`, `web/sitemap.xml` từ backup, xoá `web/huong-dan/`.
- **Kiểm live** (Playwright Chromium 1366×768 và 390×844): từ trang chủ bấm link → `/huong-dan`, không tràn ngang, 0 lỗi JS, bấm "Bước 8" video nhảy tới 08:00 và
  phát; `/media/…mp4` trả 206 + `Content-Range`; `/media/` 404; thẻ đăng nhập trang chủ đổi tab bình thường; `/api/health` 200. CHƯA thử trên iPhone/Android thật.
- **Test** `run_tests.py`: 7 [MOI HONG] không do việc này — 6 bộ planner vì `web/pages/phanmon.js` ở cây chính là CRLF (đã ghi 02/11), và
  `py-solver/test_engine_v3_cpsat_lns` trượt ngưỡng thời gian (3,08 s > 2,0 s, chạy riêng vẫn vậy trên máy này). Thay đổi chỉ gồm HTML, sitemap và công cụ nginx.

## 2026-11-23 THCS Quang Trung TKB 6 (sid obo2ow4q6d6) — cô Chung/thầy Tài nghỉ T2, hết ngày 8 tiết chính khoá — ĐÃ GHI vào kho

- TKB 6 = bản sao y hệt TKB 5 (chỉ khác `meta`, effectiveDate 2026-11-30). Trường xin: (1) CN.Chung (Điêu Thị Thủy Chung) nghỉ
  trọn T2, tránh "T4 buổi chiều" vì nhà ở Củ Chi; (2) TC.Tài dồn tiết chiều T2 qua T4, nghỉ T2; (3) 7/2, 7/4, 8/2, 9/1 "học chính khoá
  8 tiết/ngày là sai quy định".
- **Cách trường đếm (khớp đúng 4 lớp trường nêu, đã thử mọi cách phân loại môn):** tiết "học" trong ngày = MỌI tiết buổi sáng (kể cả
  TCTA/AI ở sáng) + tiết chính khoá buổi chiều; ≤ 7. Vì sáng luôn 4 tiết ⇒ buổi chiều 4 tiết phải có môn ngoài chính khoá
  (AVNN/IC3/KNS/STEM/TCTA/TS10/AI) ở tiết 4. 4 ngày vi phạm cũ đều do CN/MT ở tiết 4 chiều (ô "môn nhẹ" mở từ TKB 4 lần 2).
  Luật cũ `--ck7` (TKB 5) coi AI/TCTA ở sáng là ngoài chính khoá nên chỉ thấy 1 ngày — sai so với cách trường đếm.
- **Ghi vào kho:** `fixedOff.subject` đóng lại CN T2, MT T3, MT T4 tiết 4 chiều (giờ mọi môn chính khoá cấm tiết 4 chiều ⇒ RB/Cherry tự
  giữ luật ≤7); `fixedOff.teacher` CN.Chung nghỉ trọn T2 + chiều T4 (làm cả 2 nghĩa của "T4 buổi chiều": thứ Tư chiều, và tiết 4 chiều
  — CN đã bị cấm tiết 4); TC.Tài thêm nghỉ chiều T2. `CN.Chung maxDays 2` giữ nguyên.
- **Bất khả đã chứng minh (`cap6.py` + mô hình đầy đủ):** 52 buổi chiều 4 tiết/tuần (T2 16 lớp, T3 13, T4 13, T5 7, T6 3) nhưng GV
  ngoài chính khoá rảnh cùng lúc chỉ lấp tối đa 49 (thiếu T2, T3: tổ Toán nghỉ CM T3 nên không có TS10; TO.Phương nghỉ chiều tiết 3–5).
  Cho TO.Phương dạy tiết 3–4 chiều vẫn vô nghiệm; luật 6A2–6A4 (`--pair64`) + ghim tiết 4 thì kể cả thêm GV cũng phải dời ≥4 ghim.
  **Chủ dự án chốt (hỏi trong phiên): thêm GV liên kết, chuyển 4 lớp** — KNS 7A1, 9A1 → `KNS 3`; STEM 7A1, 8A2 → `STEM 3` (2 mã có sẵn
  trong danh sách GV, trước 0 tiết). Đánh đổi: KNS 3/STEM 3 mỗi người 2 buổi 1 tiết (muốn 0 buổi 1 tiết phải chuyển ≥8 lớp).
- **Kết quả ĐÃ GHI 23/11 19:52** (`_updatedAt` 1795438374931, sao lưu kho trước `scratch/qt6/backup_obo2ow4q6d6_20261123-195254_truoc-ghi.json`
  = `live6_0.json`, kéo lại `live6_after.json` khớp 100%): 749/749, `verify6.py` 0 lỗi, RB Node 0; 0 ngày > 7 tiết; GV trường 236→235 buổi,
  0 buổi 1 tiết, trống 24→16, 0 trống 2; GV liên kết 36→39 buổi, 4 buổi 1 tiết (KNS 3/STEM 3); tối đa 8 tiết/ngày. CN.Chung dạy T3 (sáng 4 +
  chiều 3) + chiều T6; TC.Tài nghỉ trọn T2, thêm chiều T4. Dời 5 ghim tiết 4 chiều (6A1 TCTA T3, 7A2 TCTA T5, 7A3 KNS T2, 7A3 IC3 T5,
  7A4 KNS T5; KNS 7A3/7A4 ghim lại ở tiết 4 ngày mới). 518 ô đổi ở 20 lớp (chạy `--wmove 0` cho gọn buổi; `--wmove 1` giữ ~290 ô nhưng 279 buổi).
- Công cụ `scratch/qt6/`: `mk_rules6.py` (luật mới → `rules6.json`), `solve_qt6.py` (= solve_qt5 + `--ck7m`, `--pool/--poolfix/--singleok`,
  `--pinpen` giữ cứng HĐTN 1/2, `--maxdrop/--maxpool`, `--minonly`, `--fixfrom/--free` cho LNS, `--movefrom`, `--seed`), `cap6.py` (mô hình
  nhỏ tiết 4 chiều), `lns6.py`, `final6.py` (dựng kho + đổi pccm + ghim lại), `verify6.py`, `apply6.py` (connect_vps, so băm, `--write`),
  `pull.py`, `rb_check.js`. Quy trình hiệu quả: CP-SAT toàn trường 25′ (279–282 buổi) → LNS 6 lớp kẹt ở 279 → toàn trường `--wmove 0` có
  gợi ý 20′ + 15′ → 274.
- Luật "liên kết cuối buổi", "6A2–6A4" vẫn chỉ có trong mô hình (bấm Cherry trên web có thể phá). Không chạy `run_tests.py`: phiên này chỉ đổi tài liệu.

## 2026-11-22 THCS Hồ Văn Long PHÂN HIỆU TKB 7 (sid g1eegcr1ww7) — ghép lớp tiết liên kết, K9 nghỉ T7, ≤8 phòng chiều K9 — ĐÃ GHI vào kho

- Yêu cầu trường (chủ dự án dán) + `phancong/hovanlong/moi/` (PHAN_LOP K8 v4, K9 phương án B, sơ đồ trường PDF): K9 xếp lại buổi chiều
  cho HS nghỉ T7 (bỏ khung cứng 9/15–20 chiều T2-T4, 9/21–27 chiều T5-T7); 9/23–9/27 ở dãy D nhường phòng buổi chiều cho 8/11–8/15;
  K6 chỉ ghép ToánK 6/8+6/10, 6/9+6/11; K7 chỉ ghép ToánK 7/9+7/10; K8/K9 ghép TABN/KNS/STEM theo file; ToánK 9/13+9/14.
- Chủ dự án chốt (hỏi trong phiên): bỏ ABN 9/13, 9/14 (0 HS) và ToánK 8/9, 8/10 (không mở lớp), đóng 2 ô t5 chiều mỗi lớp;
  K9 chiều = 3 buổi từ tiết 3 (3+2+2 tiết), máy chọn ngày T2–T6; mỗi tiết chiều ≤8 lớp/nhóm K9 9/15–27 (nhóm ghép = 1 phòng);
  nhóm ghép khác GV trung tâm → máy chọn 1 GV trong các GV hiện có của nhóm.
- Kho: 24 dòng Dạy ghép `ten "<môn> (ghép)"`, nhãn = mã môn, 1 GV (gỡ phân công chính lớp|môn, chiếu `pccm*` + `dayGhepProjected`);
  `maxPeriods.day = 8` cho mọi GV trừ GV chỉ dạy MT/Nhạc/CN (luật chung của chủ dự án 30/10). Ô dư của 7/14–7/20 (trường mở 34 ô/33 tiết)
  chỉ được trống ở sáng t5. Luật phòng chiều K9 chỉ có trong mô hình (kho không biểu diễn được).
- Kết quả đã ghi (`_updatedAt` 1795323374514, sao lưu `scratch/hvlph7/backup_g1eegcr1ww7_20261122-115547_truoc-ghi.json` = `live0.json`):
  1820 tiết, RB Node 0, kiểm độc lập 0, kéo lại khớp. Mọi GV 594 buổi / 1 buổi 1 tiết (GD.Thắm, nghỉ T5) / 32 trống 1 / 0 trống 2
  (TKB 6: 615/4/39/0); GV trường 504/1/27 (TKB 6: 501/2/33). Phòng chiều K9 max 8; mọi lớp dãy D có phòng mượn cố định cả buổi (`report7.py`).
- Công cụ `scratch/hvlph7/`: `model7.py` (CP-SAT: khung biến K9/8/9/8/10, nhóm ghép + chọn GV, phòng, ≤8 tiết/ngày), `lns7.py`,
  `finalize7.py`, `verify7.py`, `report7.py`, `apply.py` (connect_vps, so băm bản mong đợi, `--expect <file>`). Cách nhanh nhất: giải toàn
  trường 25′ có gợi ý từ bản LNS tốt nhất (19 448 → 18 333).
- **Tối ưu lượt 2 (chiều 22/11, ĐÃ GHI `_updatedAt` 1795332040472, sao lưu `backup_g1eegcr1ww7_20261122-142040_truoc-ghi.json`):** bỏ
  điểm "đổi ô so với live0" (`--w_chg 0`, không `--ref`), LNS 3 chuỗi × 10 vùng 17 170 → 17 065, rồi toàn trường 25′ + 20′ có gợi ý →
  16 715 (`q4.json`). Mọi GV 579 buổi / 1 / 28 / 0; GV trường 489/1/24. Khung chiều K9 và GV nhóm ghép giữ nguyên; 576 ô đổi so với lượt 1.
- **Buổi 1 tiết của GD.Thắm là bất khả (đã chứng minh):** 10 lớp chiều (6/16–19, 8/16–21) có buổi sáng toàn GDTC/TinQT cố định, nên
  GDCD phải ở chiều; cô nghỉ T5, T7 và tiết 1–2 mọi buổi chiều; chiều T2 tiết 4–5 là HĐTN cố định mọi lớp → chỉ đúng 10 ô (T2 t3 + T3/T4/T6
  t3–5) cho 10 tiết, T2 chiều luôn 1 tiết. `model7.py --max_single 0` → INFEASIBLE 15 s. Muốn hết: cho cô dạy tiết 2 chiều một ngày
  T3/T4/T6, hoặc chuyển GDCD một lớp chiều cho GV khác.
- **Lượt 3 (22/11 ~16:03, ĐÃ GHI `_updatedAt` 1795338171858, sao lưu `backup_g1eegcr1ww7_20261122-160251_truoc-ghi.json`):** chủ dự án
  "chỗ cô Thắm không sao", bỏ lỗ trống: 7/14–7/20 (34 ô/33 tiết) **nghỉ T7 sáng tiết 5** (OFF 3 chỗ) → 33/33, hết ô trống.
  `model7.py --k7_sat5_off` (đóng ô 54); `finalize7.py`/`verify7.py` hiểu khung mới. Hệ quả đã chứng minh: luật ABN/STEM cuối buổi
  + mất 7 ô cuối buổi T7 → **≥3 buổi 1 tiết** (`--max_single 1/2` INFEASIBLE); chừa 2 lớp (7/15, 7/16) mới giữ được 1 (`--k7_sat5_w`,
  `--k7_max_exc 1` INFEASIBLE). Chủ dự án chọn đóng cả 7 lớp. Kết quả: mọi GV 583 / 3 (GD.Thắm, GEMS1, STEM2) / 37 / 0; GV trường
  491/1/33; RB 0, verify 0, kéo lại khớp. Cách làm: sửa riêng 7 lớp (`--free`, gợi ý `q4.json`) rồi toàn trường có gợi ý + `--ref q4_store.json`
  (giải toàn trường thẳng từ gợi ý không hợp lệ cho 9 buổi lẻ — đừng làm vậy). Lời giải `q10.json`.
- **Lượt 4 (22/11 ~18:05, ĐÃ GHI `_updatedAt` 1795345475335; bản thử 17:50 = 1795343343952):** trường bổ sung:
  (1) lớp ghép ToánK thì 2 tiết ABN bổ trợ cũng ghép: thêm nhóm ABN 6/8+6/10 (Smart), 6/9+6/11 (Smart2), 7/9+7/10 (Smart),
  9/13+9/14 (Smart) — **khôi phục ABN 9/13, 9/14** (lượt 1 đã bỏ vì 0 HS), mở lại ô t5 chiều T2/T3;
  (2) AVS2 là GV của GEM → ABN 6/14, 6/15, 7/11, 7/13 thành nhóm 1 lớp, máy chọn trong GEMS1–5 (`CAND_OVERRIDE`): 6/14, 7/13 GEMS2;
  6/15, 7/11 GEMS4; AVS2 còn trong danh sách GV nhưng 0 tiết; (3) bỏ ABN 8/9, 8/10 (đi chung ToánK đã bỏ) → `o5` Σ=1 (đóng 4/5 ô t5 chiều).
  `--w_chg 0`, nên nhóm ABN K8/K9 cũng đổi GV trong ứng viên của nhóm: GEMS3 chỉ còn 2 tiết/1 buổi, GEMS5 gánh phần lớn ABN K9.
  Kết quả: mọi GV 580 / 3 (Thắm, GEMS1, STEM2) / 37 / 0; GV trường 494/1/30; RB 0, verify 0, kéo lại khớp. Quy trình: sửa riêng lớp bị
  ảnh hưởng (`--free`, 5′) → toàn trường 25′ → LNS 3×8 → toàn trường 20′ (`r3.json`). `model7_before_abn.py` = bản trước lượt 4.
- `run_tests.py` 22/11: 7 test báo "mới hỏng" (6 js-e2e đọc `web/pages/phanmon.js`, vd. không tìm thấy kết thúc `tkbAdoptRemoteData`,
  + `test_engine_v3_edge_pair_rule`) — có sẵn trên nhánh, không do thay đổi tài liệu này; chưa điều tra.

## 2026-11-23 THCS Hồ Văn Long (Chính) TKB 7 — LẦN 3: chia nhóm liên kết theo thống kê HS từng lớp, lớp ít HS học ghép — ĐÃ GHI vào kho

- Nguồn: `phancong/hovanlongchinh/moi3/THỐNG KÊ SỐ LƯỢNG HS HỌC MÔN HỌC THEO NHU CẦU (Câu trả lời).xlsx` (số HS TATC/TABN/Tin QT/STEM theo lớp chủ nhiệm):
  lớp nào cũng có HS học liên kết (kể cả 6/7, 7/8, 8/6–8/8, 9/5–9/11 mà lần 2 không có tiết LK), 9/1–9/4 và 8/1 rất ít. Chủ dự án chọn
  **"ghép lớp ít HS"**: lớp có HS thì có tiết LK trong TKB lớp đó; lớp ít HS học ghép cùng giờ (dòng Dạy ghép nhiều lớp, `ten "<môn>-<lớp>+<lớp>"`).
- Nhóm (`scratch/hvl7/build9.py`): TATC+TABN 23 nhóm — K6 mỗi lớp (6/7 → TA.Vương), K7: 7/3+7/4 (TA.Hảo), 7/8 (TA.Ni), K8: 8/1+8/7 (TA.Vương), 8/4+8/6 (TA.Mỹ),
  8/8 (TA.Hảo — không giao TA.Mỹ vì cô chỉ dạy chiều, 18 tiết/19 ô), K9: 9/10 (TA.Quỳnh), 9/6+9/7 (TA.Vũ2), 7 lớp 9/1–9/5+9/9+9/11 (TA.Nghi); TA.My hết TATC.
  Tin QT: K6/K7 mỗi lớp, K8 8/1+8/7 và từng lớp 8/2–8/6, 8/8. STEM: K6 mỗi lớp; 7/1+7/2, 7/3+7/4, 7/5+7/8, 7/6, 7/7; 8/2, 8/3, 8/5, 8/4+8/6, 8/1+8/7+8/8; 9/5+9/6+9/7+9/11.
  9/8, 9/12 không có LK. Bỏ điều kiện tự đặt "2 lớp STEM không cùng giờ" (file chỉ ghi mỗi buổi 2 GV STEM, không trùng nhau).
- Gốc = kho sống 23/11 17:26 (chủ dự án đã tự bỏ `Tự học (ghép)` K9, dời vài ô 6/7, gỡ GDCD 7/3): giữ nguyên các sửa đó.
- Kết quả đã ghi (`_updatedAt` 1795435387169, `final12.json` = `live_f12.json`): 1253 tiết-lớp, RB Node 0, 0 tiết vào ô nghỉ GV, lớp nào cũng đủ 10 buổi ≥2 tiết;
  GV 427 buổi / 1 buổi 1 tiết / 36 trống 1 / 0 trống 2. CÒN: buổi sáng 3 tiết ở K9 (9/1–9/4, 9/9 mỗi lớp 2 buổi; 9/5, 9/11, 9/8, 9/12 1 buổi) và 7/4 một buổi sáng 2 tiết —
  K9 bỏ Tự học nên chỉ còn 29 tiết CK: 9 tiết CK buổi chiều < 10 cần (mỗi chiều ≥2 tiết, LK sau 2 tiết CK) ⇒ ≥1 buổi sáng 3 tiết/lớp là bắt buộc; buổi thứ 2 chưa gỡ được.
  **Chủ dự án chốt 23/11: "Không, giữ vậy"** — KHÔNG thêm lại Tự học K9, chấp nhận các buổi sáng thiếu tiết này; bản `final12` là bản dùng.
- Công cụ mới: `h4lib.py` (dòng ghép nhiều lớp không tính trùng GV: `S.joint`, `S.jcls`), `h9_lns.py` (ghim dòng ghép khi không mở đủ lớp; `P_CLOSE` mở cả nhóm ghép),
  `h9_finalize.py`, `export8.py` (cột "ghép"). Excel: `phancong/hovanlongchinh/moi3/TKB LIEN KET - TKB7 lan 3 (23-11-2026).xlsx`.

## 2026-11-22 (tối) THCS Hồ Văn Long (Chính) TKB 7 — LẦN 2: làm lại môn liên kết theo đúng file, ngày nghỉ GV = TKB 6 — ĐÃ GHI vào kho

- Chủ dự án bác bản ghi 11:43 (mục dưới): "phân công liên kết bị sai". Làm lại: phân công LK theo ĐÚNG `moi2/21.11-...xlsx`
  (không thêm GV; GV TATC lớp nào trợ giảng TABN lớp đó; Tin QT Thảo K6 / Dũng K7 / TQT.3 K8; STEM Duy 6/1-6/5, ST.3 7/1-7/4, Khải 8/1-8/3 + 9/1);
  chốt thêm: cô Mỹ 8/4, 7/1, 7/2; thầy Đoàn Quốc Vũ 9/3; cô Anh Vũ bỏ TATC; TATC không bắt buộc tiết đôi.
- Luật khung mới (mỗi lớp): LK chỉ buổi chiều, sau 2 tiết chính khoá (cuối buổi) hoặc trọn buổi chiều LK; không giới hạn chiều T2-T4.
  Mở tiết 4 chiều T5, T6 (GV nghỉ tiết 3 chiều hôm đó nghỉ luôn tiết 4). "Học sinh không được nghỉ buổi nào": lớp nào cũng đủ 10 buổi, mỗi buổi ≥2 tiết.
- Ngày nghỉ GV phục hồi theo TKB 6 (`fiwemj2uyk6`; khác bản TKB 7 09:51 đúng 1 chỗ: không có "SĐ.Thy nghỉ các chiều"); KHÔNG còn tiết nào
  trong buổi chuyên môn tổ. Luật "số buổi tối đa" của 14 GV do chủ dự án tự bỏ trên web 19:29 — giữ theo bản đó.
- Kết quả đã ghi (`_updatedAt` 1795351827402, `scratch/hvl7/final8.json` = `live_f8.json`): 1203/1203 tiết, 0 tiết vào ô nghỉ GV, STEM không đụng tiết,
  GV 417 buổi / 2 buổi 1 tiết / 33 trống 1 / 0 trống 2. RB Node 27 dòng CÒN LẠI (chưa gỡ được, đã báo chủ dự án): VA.Cảnh 3 buổi sáng (luật 2, 15 dòng),
  GDTC thiếu tiết đôi 7/1, 7/6, 8/2, 9/9; TATC+TABN 7/3 cùng chiều T5; KHTN 6/5 sáng+chiều T3; KHTN 6/6 liền tiết 2-3 sáng; 6/7 có 2 buổi sáng 3 tiết.
- **Cập nhật 20:06** (`_updatedAt` 1795355202423, `final9.json` = `live_f9.json`): chủ dự án yêu cầu GDTC phải tiết đôi, mỗi môn ≤2 tiết/buổi
  (N Văn 8/6, 8/7, 9/3, 9/8 giới hạn 3 → 2). Đã gỡ: GDTC đủ tiết đôi, 7/3 tách TATC/TABN, VA.Cảnh 2 sáng/2 chiều. RB Node còn 5 dòng (KHTN 6/5 sáng+chiều T3,
  KHTN 6/6 liền tiết 2-3). CÒN MỞ: lớp 8/7 trống cả sáng T3 — nghẽn cấu trúc: sáng T3 tổ Toán, LS-ĐL, Tin (+GDCD) cùng nghỉ, sức chứa GV 144 ô/140 cần
  (MT.Phát 4 ô chỉ dạy 2 tiết) nên luôn có ~1 lớp thiếu; cần chủ dự án cho 1 GV tổ nghỉ T3 dạy sáng T3 hoặc chấp nhận. Bài học LNS: vùng 13-15 lớp không hội tụ trong 100s;
  vùng 3-5 lớp quanh lớp lỗi (12-15s) mới ra OPTIMAL.
- **BẢN CUỐI 22/11 ~21:40** (`_updatedAt` 1795358437102, `final11.json` = `live_f11.json`): 1203/1203, RB Node **0**, `h8_finalize` 0 cảnh báo; GV 420 buổi / 1 buổi 1 tiết /
  27 trống 1 / 0 trống 2. Gỡ được lỗ sáng T3 nhờ làm như TKB 6: cho **trọn buổi SÁNG liên kết (Tin QT 2 + TATC 2)** — TKB 6 lấp sáng T3 bằng 16 tiết LK;
  bản mới có 7 buổi sáng như vậy (6/4, 6/6, 7/3 sáng T3; 6/5, 7/4, 7/6 sáng T4; 8/5 sáng T5). Bỏ `allowMorning:false` của TATC/THQT (giữ TABN, STEM chỉ chiều theo luật trường).
  Giữ ô chủ dự án tự dời 21:03: STEM 9/1 → chiều T4 tiết 4 (mở riêng ô đó cho 9/1).
- Công cụ `scratch/hvl7/`: `build8.py`, `h8_lns.py` (giải cả trường K=35 rồi LNS; `FORCE=` nhắm lớp), `h8_finalize.py [--preview]`, `export8.py`, `lk8_check.py`.
  Excel: `phancong/hovanlongchinh/moi2/TKB LIEN KET - TKB7 lan 2 (22-11-2026).xlsx` (file lần 1 cùng thư mục đã lỗi thời).

## 2026-11-22 THCS Hồ Văn Long (Chính) TKB 7 (sid fiwemj2uyk7) — môn liên kết dồn vào khung chiều T2-T4 t2-4, thêm 9 GV liên kết — ĐÃ GHI vào kho

- Yêu cầu: xếp TKB 7 theo `phancong/hovanlongchinh/moi2` (PCCM 21.11 + `XẾP LIÊN KẾT 20-11-2026.xlsx` + PDF danh sách HS); môn
  liên kết xếp riêng trong khung chiều T2 t2-4, chiều T3/T4 t2-3, "giống Quang Trung, cần thì tăng GV liên kết"; sau đó "tối ưu, phải xếp được".
- Dữ liệu: HS đăng ký TA (TATC 3 + TABN 2; K8 TATC 2) / Tin QT 2 / STEM 1, gom thành danh sách `6A1-6A6, 7A1-7A7, 8A1-8A6, 9A1-9A4`
  trộn HS nhiều lớp (mỗi HS đúng 1 mã; mọi lớp chính khoá đều có HS đi LK) ⇒ cả khối trống chính khoá khi LK học. Chính khoá PCCM 21.11 = kho.
- Chủ dự án chốt (hỏi trong phiên): khung 7 ô bất khả (nhóm 8 tiết) → **8 ô, thêm tiết 4 chiều T3**; trợ giảng TABN được là GV TATC
  khác, giữ tiết đôi TABN/Tin QT/TATC → **thêm 9 GV**: `TA.LK1-4`, `GVBN8`, `TQT.4-7` (`TQT.3` có trong bảng phân công). Giữ đủ luật cũ
  thì +15; bớt 1 GV TATC: 10′ UNKNOWN. Tin QT tiết đôi ⇒ 7 lớp Tin QT cùng lúc (cần đủ phòng máy).
- **Lần ghi đầu (10:17) để 23 nhóm thành lớp riêng "6A1.."** — chủ dự án bác ("tách ra dãy lớp A làm gì, để các lớp như cũ ghép chung");
  web còn coi "6A1" ≡ "6/1" nên lần tự lưu 10:30 làm rối khoá phân công. **Bản cuối: tiết LK của danh sách xAy đặt vào lớp x/y**
  (đúng cách bảng phân công ghi "TATC 6/1"), ô khung của lớp không có danh sách (6/7, 7/8, 8/7, 8/8, 9/5-9/12) = nghỉ. Khi gộp, luật cũ
  "Anh–TATC–TABN không cùng buổi" (34 lớp) và "Tin–THQT" có hiệu lực → xếp lại khung LK với TATC/TABN khác buổi (vẫn 9 GV thêm).
- Bất khả do mất chiều T2-T4 (đếm ô, `cap.py`): CN.Dung −6, GD.Loan −5, TI.Thảo −4, TN.Hằng1 −3, TN.Quang −3, AN.Vân −1, TO.Thảo1 −1
  → chủ dự án duyệt dạy vào buổi chuyên môn của tổ (thầy Quang thêm chiều T5); kho mở đúng các ô dùng trong `fixedOff.teacher`.
  Cùng nguyên tắc (báo sau; chủ dự án đồng ý GIỮ, 22/11): SĐ.Thy (trường thêm luật 09:51 hôm nay: nghỉ mọi chiều) tự thiếu 1 ô → 1 tiết sáng T3; VA.Cảnh
  `maxMorningAfternoon` 2/2 → tối đa 14/15 tiết → 2 sáng/3 chiều; GDTC 8/6 bỏ luật tiết đôi (TC.Dương 9 lớp, chỉ còn chỗ 8 tiết đôi).
- K8 học chính khoá ở T2 t2 (GDĐP cô Hương chỉ chiều T2, ghim lại 8/1 t2, 8/2 t1 chiều T2), K9 ở T2 t2 + T3 t2; Tự học K9 (ghép 12 lớp)
  ghim chiều T4 t1 + sáng T5 t4. STEM 6/1, 6/2, 6/3 cùng giờ (11 HS STEM của danh sách 6A6 học ghép).
- **ĐÃ GHI 22/11 11:43** (`_updatedAt` 1795322607504, sao lưu kho trước mỗi lần ghi `scratch/hvl7/backup_fiwemj2uyk7_*_truoc-ghi.json`): 35 lớp,
  1203 tiết, RB Node 0, kéo lại khớp. GV trường (bỏ GV LK/thỉnh giảng TA): 383→383 buổi, trống 1 tiết 49→30, trống 2 tiết 3→0,
  buổi 1 tiết 31→47 (mỗi lớp chỉ còn 1 tiết chính khoá đầu chiều T2-T4). File cho trường: `phancong/hovanlongchinh/moi2/TKB LIEN KET - TKB7 (22-11-2026).xlsx`.
- Lưu ý: "cả khối trống khi LK học" và 9 GV thêm chỉ có trong mô hình; tiết LK đều ghim nên bấm Cherry không phá khung LK.
  RB Node không bắt lệch giờ dòng dạy ghép nhiều lớp (Tự học) — `h7m_finalize.py` tự kiểm. Công cụ `scratch/hvl7/` (`lk_model.py`
  `--pair loose --k8core M2 --nosame 1`, `build_base7.py` → `merge_back.py`, `h7_lns.py` + `SOFTFO=softfo.json`, `cap.py`, `h7m_finalize.py`,
  `apply.py` dùng `connect_vps` từ worktree `claude/ssh-key-auth`). Test `run_tests.py`: 6 test planner FAIL như mục 21/11 (CRLF), không liên quan.

## 2026-11-21 BẢO MẬT — máy quét lỗ hổng 143.246.203.109 + SSH bị dò mật khẩu: chặn IP ở nginx, cài fail2ban

- **Sự việc**: chủ dự án thấy tài khoản lạ ở Super Admin (`marcusjreed`, trường "Reedline Analytics" `schbfc44ad803`, IP
  143.246.203.109, SĐT/email giả). Đọc log VPS (chỉ đọc): IP này là **máy quét tự động** (HeadlessChrome + UA giả), ~850 request
  ngày 09/11, 16/11, 18/11, 21/11, thử 152 đường dẫn (`/.env`, `/.git/config`, `/.ssh/id_rsa`, `/.aws/credentials`,
  `/terraform.tfstate`, swagger/openapi, `/actuator`, `/api/admin/*`, đường ngẫu nhiên `__xxxx` dò route bắt-tất).
  **Không lọt gì**: mọi đường nhạy cảm 404 (cả 14 ngày log, mọi IP); `/api/admin/solver-usage|solver-infrastructure` và
  `/api/auth/hash-password` 401/403; `/api/auth/registry` chỉ trả phần trường của họ (~1 KB); kho `school_92aeb8fb981` 236 byte.
  Đăng ký 16/11 23:50 UTC (trường đó bị xoá 17/11 → `ip_registered` giải phóng IP) rồi đăng ký lại 18/11 10:58 UTC.
  Chủ dự án đã **Khoá** trường 21/11 15:17 UTC → IP vào `blockedIps`.
- **SSH**: 16.836 lần đăng nhập sai/24 h từ 110 IP (14.539 lần `root`); `permitrootlogin yes`, `passwordauthentication yes`,
  0 `authorized_keys`, chưa có fail2ban. Mọi lần đăng nhập thành công từ 18/10 (auth.log) đều từ IP nhà mạng VN khớp phiên làm
  việc — không thấy xâm nhập. Không có user nào khác có shell / uid 0.
- **Đã áp (chủ dự án duyệt)**:
  - nginx: `/etc/nginx/conf.d/tkb-blocklist.conf` = `deny 143.246.203.109;` (nginx.conf include `conf.d/*.conf` trong khối
    http → 403 mọi server block). Công cụ mới `tools/vps-deploy/block-ip-nginx.py <ip> [--apply|--remove]` (mặc định chỉ xem;
    `nginx -t` hỏng thì khôi phục file cũ, không reload; reload không restart `tkb-app`).
  - fail2ban 1.0.2-3ubuntu0.1 (Ubuntu 24.04), jail `/etc/fail2ban/jail.d/tkb-sshd.local`: `backend=systemd`, `maxretry=5`,
    `findtime=10m`, `bantime=1h` tăng gấp đôi tới 1 tuần; chặn qua nftables (`inet f2b-table`). Phút đầu đã cấm 3 IP.
    Đăng nhập đúng mật khẩu (script deploy) không bị tính. Thêm cùng cấu hình vào `tools/vps-deploy/install-server.sh`.
  - Kiểm sau khi áp: `https://tkbcherry.com/` 200, `/api/health` 200.
- **Lệnh hữu ích**: `fail2ban-client status sshd`; gỡ cấm nhầm: `fail2ban-client set sshd unbanip <ip>` (vào qua console nhà
  cung cấp VPS nếu chính IP mình bị cấm); tắt hẳn: `systemctl disable --now fail2ban`.
- **Vá phiên của tài khoản bị khoá (cùng ngày)**: `auth::session_account_locked(reg, session)` — từ chối khi registry ghi
  RÕ user `active:false`, trường `active:false`, hoặc user/trường nằm trong `deletedUsers`/`deletedSchools` mà chưa được tạo
  lại; Super Admin `suadmin` không bao giờ bị khoá; tài khoản role `superadmin` khác bỏ qua cờ khoá của trường (giống login).
  Registry rỗng/hỏng ⇒ không chặn ai (fail-open, tránh đăng xuất cả hệ thống). Gọi ở `require_session` (mọi API), 
  `session_json` (401 `account_locked`, "Tài khoản hoặc trường đã bị khóa. Liên hệ quản trị.") và `require_agent_credential`
  (khoá Agent 90 ngày; không xoá credential nên mở khoá là dùng lại). `web/shared/runtime.js` hiện thông báo khoá ở trang đăng
  nhập như `session_replaced`. Mỗi lần kiểm phiên đọc thêm một lần `auth_registry`. Test: 5 test mới trong `auth::tests`
  (`locking_a_school_ends_its_open_sessions_until_unlocked`, `deleted_accounts_lose_their_sessions_but_recreated_logins_do_not`,
  `missing_registry_does_not_log_everyone_out`, `super_admin_session_ignores_registry_locks`,
  `locking_a_school_suspends_its_agent_credential`); `cargo test --locked` 374/374 (chạy trong `/tmp` trên VPS);
  `e2e_tests/auth_session_persistence_node` 9/9. Trước deploy: `auth.rs`/`runtime.js` trên VPS = HEAD; `main.rs` trên VPS
  khác HEAD (lệch sẵn, không thuộc commit nào trong 25 commit gần nhất) — bản vá không đổi API công khai của `auth`.
  **ĐÃ DEPLOY 21/11 ~15:53 UTC**: `deploy-files.py deploy session-lock-20261121 --no-restart rust_api/src/auth.rs
  web/shared/runtime.js` + `build-rust.py --apply` (build release 2m32s, đổi binary khi solver rảnh; binary cũ ở
  `/root/tkb-backups/rust-bin-20261121-225059/`). Sau deploy: `tkb-app` active, journal không cảnh báo, 17/17 request `/api/*`
  trả 200 (không có 401/403 bất thường), token giả → 401, trang chủ 200. Chưa thử đầu-cuối bằng phiên thật của trường bị khoá
  (không có token của họ) — phần đó do unit test phủ. Rollback: `deploy-files.py rollback session-lock-20261121
  rust_api/src/auth.rs web/shared/runtime.js` rồi `build-rust.py --apply`.
- **Còn mở**:
  1. `blockedIps` của app vẫn chỉ chặn login/register (chặn toàn site thì dùng `block-ip-nginx.py`).
  2. SSH vẫn cho root đăng nhập bằng mật khẩu. Chuyển sang khoá SSH + `PasswordAuthentication no` cần sửa `vps_credentials.py`
     và mọi script paramiko trước — làm riêng.
  3. Chưa có giới hạn tốc độ nginx (`limit_req`) cho `/api/auth/*`; khoá đăng nhập sai hiện là bộ đếm trong RAM của Rust.
- Lưu ý: **Khoá** chứ đừng **Xoá** trường giả — xoá gỡ luôn `blockedIps` của trường và cho IP đăng ký lại.
- `python run_tests.py` (21/11, cây chính): 6 test planner báo [MOI HONG] (`planner_constraint_audit_stale_class`,
  `planner_fixed_chao_co_survives_load`, `planner_ghep_stale_pin`, `planner_lesson_block_impossible_min`,
  `planner_lesson_block_standard_periods`, `planner_teacher_code_nfc`) — **không do thay đổi này**: bản làm việc
  `web/pages/phanmon.js` của cây chính là CRLF (`git ls-files --eol`: `i/lf w/crlf`, mtime 30/10) trong khi test tìm `"\n}\n"`;
  chạy trên worktree sạch của HEAD cả 6 test đều qua. `py-infra/test_vps_credentials` là mục mới (chưa có trong mốc), FAIL.

## 2026-11-20 ĐỒNG BỘ XẾP TKB TRƯỜNG TỪ MÁY MAC VỀ WINDOWS + GHI BÙ NHẬT KÝ AN NHƠN TÂY TKB 2 (15/11 & 18/11)

- **Đồng bộ từ `G:\Other computers\Máy Mac của tôi\Desktop\TKBCherry`** (0 thay đổi mã nguồn):
  - Fast-forward 15 commit `docs/PROJECT_HANDOFF.md` (`cd3ad1e..11ef8ae`) từ máy Mac (Quang Trung TKB 4 & 5, Củ Chi TKB 6, Tăng Bạt Hổ TKB 3, Phạm Văn Hai TKB 4); dọn `desktop.ini` do Google Drive sinh trong `.git/` để khôi phục `git fetch`/`push`.
  - Chép 5 thư mục trường trong `scratch/` từ Mac sang Windows (240 file): `scratch/quangtrung/` (59), `scratch/af5ldw/` (79), `scratch/pvh/` (39), `scratch/qt5/` (24), `scratch/qt5b/` (39); chuyển bộ thử CP-SAT độc lập ở gốc Mac (`solve_cpsat.py`, `data/school.json`, `output/*` của kho `1aabcab4ec1` ngày 12/11) vào `scratch/cpsat_1aabcab4ec1_20261112/` để giữ sạch thư mục gốc theo `AGENTS.md`.
  - Giữ nguyên `scratch/tbh5/` (53 file đã khớp SHA-1 hai máy) và giữ nguyên `scratch/annhontay2/` mới hơn trên máy Windows.
- **Ghi bù nhật ký THCS An Nhơn Tây TKB số 2 (`sid 6c5p6ewusv2`, làm trên máy Windows trong `scratch/annhontay2/`)**:
  - **15/11** (`change_tran_6a1.py` → `store_rules3.json` → `u1..u5` → `store_final3.json`, ĐÃ GHI kho ~08:34, sao lưu `backup_6c5p6ewusv2_20261115-083433_truoc-ghi.json`, `live_after3.json`, RB 0): `CN.Trân` (con nhỏ) nghỉ tiết 1 buổi sáng (T2–T4, T6–T7) + nghỉ sáng T5, mở dạy chiều T5; chốt khung cố định lớp `6A1` (chiều T2 4 tiết, T3–T5 3 tiết, T6 nghỉ). Kết quả `u5`: GV trường `(311 buổi, 1 lẻ, 20 trống 1, 0 trống 2)`, trung tâm `(7, 0, 0, 0)`, max 8 tiết/ngày, đổi 59 ô / 16 lớp.
  - **18/11** (`change_tg.py` → `store_rules4.json` → `v1..v4` → `store_final4.json`, ĐÃ GHI kho ~13:04 qua `apply.py`, sao lưu `backup_6c5p6ewusv2_20261118-130440_truoc-ghi.json`, `live_after4.json`, RB 0): đổi lịch GV thỉnh giảng — chuyển `6A7|LSĐL` sang `LSĐL.An` (7A2–7A5, 7A8 + 6A7); `LSĐL.Thủy` (6A1, 6A5, 6A6) chỉ dạy chiều T2, T3, T4. Kết quả `v4` (OPTIMAL/LNS): GV trường `(312 buổi, 1 lẻ, 22 trống 1, 0 trống 2)`, trung tâm `(7, 0, 0, 0)`, max 8 tiết/ngày, đổi 12 ô / 3 lớp so với bản 15/11.

## 2026-11-18 THCS Quang Trung TKB số 5 — VA.Trường nghỉ hưu, chuyển lớp + gom lịch cô Chung — ĐÃ GHI vào kho

- Yêu cầu: thầy Phạm Nhật Trường (VA.Trường) nghỉ hưu → Văn 6A2 cho VA.T Phương, Văn 7A3 cho VA.Trang, GDĐP 6A3/8A2/8A4
  cho TN.An (cô Dương Thị Bình An). Thêm: cô Điêu Thị Thủy Chung (CN.Chung, 10 tiết CN khối 7–8) "không dạy chiều t4, đi cả ngày
  cho tiện; không được thì thôi".
- Làm trong `scratch/qt5b/` (solve_qt5.py chép từ qt5 + `--wmove N` phạt mỗi ô khác lịch gợi ý, `--tnogap GV` cấm tiết trống
  của GV đó). Cùng cờ như TKB 5: `--extra --max2 --nogap2 --nosingle --contig --ck7 --ck7soft --pair64 --pair64-tcta --nopair 6A2:TCTA`.
- Cô Chung bỏ chiều t4: KHÔNG làm — CN vốn bị `fixedOff.subject` cấm t4 chiều T3–T7, CN T2 t4 là một trong ít môn chính khóa
  lấp được t4 chiều T2 (16 lớp, thiếu GV liên kết); ép bỏ → đổi ~150 ô và 4 ngày-lớp 8 tiết (cận dưới chứng minh). Làm phần
  "đi cả ngày": `maxDays 2` + không tiết trống → T2 chiều t1–t4, T3 sáng t2–4 + chiều t1–3 (trước 3 ngày, 2 buổi có trống).
- Đã ghi (35 ô ở 9 lớp, `_updatedAt` 1794967854366, hash tkb 495192473) + đổi `pccmMatrix`/`tkbLessonTeachers` 5 lớp-môn +
  thêm `tkbConstraints.teacher['CN.Chung'].maxDaysSessions.maxDays = 2`. GV 272 buổi (trước 269); tăng 1 buổi: CN.Hiền, MT.An,
  TN.Kiệt, TO.Hòa (chạy phạt di chuyển thấp vẫn 272 — tối ưu). VA.Trường vẫn trong danh sách GV, 0 tiết.
  Web "Kiểm tra ràng buộc": 286 luật, 0 chưa đạt. Sao lưu: `TKB_BACKUP_BEFORE_QT5c::obo2ow4q6d5` (trước mọi thay đổi).
- **Bài học ghi kho (2):** (1) Hash phải tính trên dữ liệu web đã vá theo ĐÚNG thứ tự khoá của web (ở đây ô buổi là
  `chieu` trước `sang`); file solver xuất `sang` trước → hash khác dù nội dung giống → script dừng "MISMATCH". (2) MISMATCH
  dừng TRƯỚC saveStore nhưng DATA trong trang ĐÃ bị vá; người dùng bấm chuyển trang → trang tự lưu bản vá (thiếu phần pccm).
  Sau MISMATCH phải tải lại trang ngay; tốt hơn: vá trên bản sao (`structuredClone`) và chỉ gán vào DATA khi hash khớp.
  Trang `/pages/sapxep` không có `schoolParam` — dùng `/api/school/store?id=<sid>`.

## 2026-11-17 THCS Quang Trung TKB số 5 (sid obo2ow4q6d5) — xếp theo phân công HK1-30.12 + 3 ghi chú — ĐÃ GHI vào kho

- Nguồn: `/Users/cherry/Desktop/AI/phancong/quangtrung/PHÂN CÔNG HK1-30.12.26.xlsx` (sheet phân công, "phan tiet 30.12" = số tiết
  sáng-chiều từng ngày theo khối/lớp TCTA, "giao duc" = đơn vị liên kết). TKB 5 là bản sao y hệt TKB 4 (đã xếp 12/11); phân công
  trên web đã khớp Excel (phần "dự kiến tháng 12" chưa áp). Khung ngày từng lớp đã đúng bảng phân tiết.
- Ghi chú trường: (1) 6A2 các tiết cuối cho HS 6A4 sang học TCTA/AVNN; (2) tiết đôi bị tách 1-3; (3) lớp học 8 tiết chính khóa.
- Mô hình `scratch/qt5/solve_qt5.py` (chép từ `scratch/quangtrung/solve_qt.py`) — **phải chạy với `--extra`** như lần 12/11
  (không có cờ này thì luật "liên kết cuối buổi" áp riêng nhóm PARTNER và lịch hiện tại cũng không thỏa). Thêm: `--contig`
  (cùng môn trong buổi liền nhau), `--ck7` [`--ck7soft`] (≤7 tiết chính khóa/ngày; ngoài chính khóa = AVNN, IC3, KNS, STEM, TCTA,
  AI, TS10), `--pair64 --pair64-tcta` (ô 6A2 học mà 6A4 nghỉ phải là TCTA 6A2), `--nopair 6A2:TCTA`, `--fixcur` (dò lỗi mô hình).
- Phát hiện: (1) AV.Hưng (TCTA/AVNN 6A2) nghỉ cả thứ Sáu → chỉ 3 ô dùng được (t4 chiều T2, T3, T4); chủ dự án chọn đặt cả 3 tiết
  TCTA 6A2 vào đó (TCTA 6A2 thành 3 tiết lẻ, đã XOÁ luật lessonBlocks TCTA của 6A2 trên web). (3) Web có `fixedOff.subject` cấm
  hầu hết môn chính khóa ở t4 chiều, trừ CN thứ Hai và MT thứ Ba/Tư → các lớp 8 tiết. Chiều T2 có 16 lớp 4-4 nhưng không đủ GV
  ngoài chính khóa cùng lúc → tối thiểu vẫn 1 ngày-lớp 8 tiết (chứng minh INFEASIBLE khi ép cứng, kể cả cho dời ghim).
- Đã ghi (552 ô, `_updatedAt` 1794903056335, hash tkb 994302393): 0 môn tách, 0 >2 tiết/buổi, 0 xen liên kết, ngày 8 tiết chính
  khóa 6 → 1 (9A1 T2, có CN t4), GV 269 buổi (cũ 265), 22 tiết trống, 0 buổi 1 tiết, 0 trống đôi. Dời 12 ghim (chủ dự án duyệt):
  6A1 TCTA, 6A2 AVNN, 6A3 CN, 7A4 IC3, 8A2 AVNN (t4 chiều T2); 7A1 IC3, 7A2 KNS, 8A2 IC3, 9A1 MT, 9A3 STEM (t4 chiều T3);
  7A2 AVNN ×2 (chiều T6). Chỉ dời 9 ghim duyệt ban đầu thì INFEASIBLE.
  Web "Kiểm tra ràng buộc": 286 luật, 0 chưa đạt. Sao lưu: localStorage `TKB_BACKUP_BEFORE_QT5::obo2ow4q6d5`.
- Luật "≤7 tiết chính khóa", "liên kết cuối buổi", "6A2-6A4" CHƯA có trong engine Cherry — bấm xếp lại trên web có thể phá.

## 2026-11-16 (lượt 2) THCS Phạm Văn Hai TKB số 4 — "SAU KHI XEM TKB": 5 GV giảm buổi — ĐÃ GHI vào kho

- Yêu cầu thêm (cuối file `/Users/cherry/Downloads/30.11.2026_ YÊU CẦU XẾP TKB.docx`): TN.An bỏ chiều T2; TN.Hảo bỏ sáng
  T5 hoặc T7; AV.Linh bỏ chiều T2 hoặc T7; TO.Trang bỏ sáng T5 hoặc T6 (nếu được); TO.Gái bỏ sáng T6 (nếu được).
  Hiểu "giảm thêm 1 buổi" = buổi đó trống VÀ tổng số buổi/tuần giảm 1 (không bù buổi khác).
- `solve_pvh.py` thêm `--sess "GV=buổi/buổi:tối_đa_buổi:H|S"` và `--capsess web_tkb_B.json` (GV khác tăng buổi so với bản
  đang trên web bị phạt `--wover` 80; GV có tên trong --sess thì cấm tăng). Bài học: lần chạy đầu không chặn tăng buổi
  → 5 cô giảm nhưng ~15 GV khác tăng 1–2 buổi; chặn cứng thì cô Gái không giảm được → dùng phạt.
  Lệnh: `solve_pvh.py 1500 --w 14 --in cur2.json --gdtc-cap 4 --wmove 2 --hint web_tkb_C.json --capsess web_tkb_B.json --sess "..."`.
- Kết quả đã ghi (427 ô, `_updatedAt` 1794843398395, hash tkb 374824338): đủ 5 yêu cầu (An bỏ chiều T2, Hảo bỏ sáng T7,
  Linh bỏ chiều T2, Trang bỏ sáng T6, Gái bỏ sáng T6); không GV nào tăng buổi, thêm 4 GV giảm 1 buổi. 385 buổi dạy
  (trước 394), 20 tiết trống, 0 buổi 1 tiết. Đã thêm 5 buổi trên vào `fixedOff.teacher` để giữ luật.
  Web "Kiểm tra ràng buộc": 220 luật, 0 chưa đạt. Sao lưu: localStorage `TKB_BACKUP_BEFORE_PVH4b::ry7gvvz7vk4`.
  Ghi bằng `saveStore({force:true, syncRemote:true})` + đọc lại máy chủ + tải lại trang: khớp.

## 2026-11-16 THCS Phạm Văn Hai TKB số 4 (sid ry7gvvz7vk4) — xếp theo "YÊU CẦU XẾP TKB LẦN 4 (áp dụng 30/11/2026)" — ĐÃ GHI vào kho

- Nguồn yêu cầu: `/Users/cherry/Desktop/AI/phancong/phamvanhai/30.11.2026_ YÊU CẦU XẾP TKB.docx` (+ yêu cầu lần 1 01/9 cùng thư mục).
  44 lớp; buổi chính: khối 7, 9 sáng, khối 6, 8 chiều; GDTC/IC3/Toán khoa… học trái buổi (ô ghim).
- Áp dụng (`scratch/pvh/prep.py` → `cur.json`): bỏ TATC 9A1/9A2 (2 tiết ghim chiều → nghỉ, 3 tiết sáng → mô hình dồn
  buổi sáng, ô trống ở cuối buổi); ÂN.Công nghỉ sáng T2 + cả T7; TI.Luật, TI.Thương nghỉ T3, T5; phân công lại LSĐL
  (cô Đức nghỉ hộ sản: 6A7→SĐ.Dung, 8A10→SĐ.Anh, 7A2→SĐ.Vinh, 7A3/7A4→SĐ.Khương, 8A1/2/3/8→GV mới `SĐ.Giang`
  Huỳnh Thị Lệ Giang, chỉ chiều T3 t2–5, chiều T6 t2–5, chiều T7); lịch trực giám thị = GV nghỉ (SĐ.Tài, TC.Tâm,
  TN.Tuấn, GD.Mai).
- GDTC: bỏ ghim toàn bộ 88 tiết, xếp lại trái buổi (khối 2 tiết, chỉ ở vị trí bắt đầu đang dùng: sáng t1/t3, chiều
  t2/t4), phạt sáng T2 t1–2 và chiều T2 t4–5. **Mâu thuẫn**: "tối đa 3 GV/buổi" + cô Tươi không dạy t5 chiều + thầy
  Tâm trực T3 & chiều T6 → không xếp được 23 lớp khối 7, 9 buổi chiều. Trường trả lời: **cho phép 4 GV/buổi nếu khó**
  → cứng ≤4, phạt mỗi GV thứ 4. Kết quả: chỉ chiều T3 có 4 GV.
- Mô hình `scratch/pvh/solve_pvh.py` (chép từ `scratch/af5ldw/solve_cc.py`, thêm: bỏ ghim tự động, ô FREE, phòng ≤26 lớp/tiết
  trừ GDTC, Tin/Nhạc/IC3 ≤2/tiết, GDTC ≤N GV/buổi). Lệnh: `solve_pvh.py 1200 --w 14 --gdtc-cap 4 --hint web_tkb_t.json`.
  Kiểm độc lập `scratch/pvh/verify_pvh.py <web_tkb>`. Lịch cũ trên web vốn đúng luật cùng môn liền nhau → giữ luật đó.
- Kết quả đã ghi (666 ô, `_updatedAt` 1794802835740, hash tkb 554459314): 394 buổi dạy (cũ 386), 16 tiết trống (cũ 65),
  0 buổi 1 tiết, 0 trống 2 liền. Ngoại lệ: TN.Tuấn trực chiều T2 nhưng giữ 2 tiết HĐTN ghim của 8A8 (GVCN). TI.Quyên
  1 ngày 10 tiết (như cũ, chỉ dạy T5). Web "Kiểm tra ràng buộc": **220 luật, 0 chưa đạt**.
- Sao lưu trước khi ghi: localStorage trình duyệt trong app `TKB_BACKUP_BEFORE_PVH4::ry7gvvz7vk4` (cả DATA).
- **Bài học ghi kho (quan trọng)**: lần ghi đầu bằng `await saveStore()` (lưu bất đồng bộ) bị ghi đè ~0,9 s sau bằng
  đúng bản cũ (trang tự nạp lại kho khi ẩn/hiện khung trình duyệt trong lúc lệnh lưu còn treo, rồi lưu lại). Máy chủ
  `/api/school/store` không có chống ghi đè. Cách đúng: `saveStore({force:true, syncRemote:true})` (XHR đồng bộ) rồi
  `fetch` lại kho từ máy chủ và so hash; đợi vài giây, tải lại trang, so hash lần nữa.

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

