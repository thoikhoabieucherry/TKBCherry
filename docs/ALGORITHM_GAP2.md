# Thuật toán xử lý "Trống 2 tiết" (optimize_gap2)

*Tài liệu mô tả đúng theo mã nguồn `web/pages/tkb-fet-engine.js` hiện hành (bản 17/08/2026). Đây là thuật toán chạy khi bấm nút **Tối ưu → 2 tiết trống**, và cũng là giai đoạn gap2 bên trong nút **Tối ưu tất cả**.*

---

## 1. Định nghĩa và thước đo (đồng bộ với bảng Thống kê)

Một **buổi** của giáo viên = 5 tiết sáng hoặc 5 tiết chiều của một ngày.

Với mỗi buổi có dạy, tính:

```
span   = (tiết dạy cuối − tiết dạy đầu + 1)
số lỗ  = span − số tiết dạy trong buổi
```

Phân loại: `số lỗ = 1` → buổi **Trống 1 tiết**; `số lỗ ≥ 2` → buổi **Trống 2 tiết**. Lưu ý: đây là **tổng lỗ trong span**, nên mẫu `[dạy, trống, dạy, trống, dạy]` (2 lỗ rời) cũng là Trống-2 — đúng cách bảng Thống kê đếm.

Chỉ **giáo viên có trong PCCM** được chấm điểm (`scoredTeachers`). Các dòng "giáo viên ma" sinh từ ô cố định/chuỗi lạ vẫn được tôn trọng khi kiểm tra trùng tiết, nhưng không phải mục tiêu tối ưu.

## 2. Tiêu chí chấp nhận một nước đi

Mọi nước đi chỉ được nhận khi **cải thiện theo thứ tự từ điển** (`compareMetrics`, mode gap2):

1. Không làm tăng **buổi 1 tiết** (ưu tiên tuyệt đối).
2. Hàng rào ngân sách buổi: `tổng buổi ≤ tổng buổi ban đầu + budget`. Budget mặc định **6 buổi**, chỉ mở khi đã qua 30% số vòng *hoặc* kẹt 3 vòng liên tiếp — tức được phép "mua" gap2=0 bằng vài buổi dạy thêm, đúng thứ tự ưu tiên đã chốt.
3. Giảm **số buổi Trống-2** (mục tiêu chính).
4. Hòa Trống-2 thì ít **tổng buổi** hơn thắng; hòa nữa thì ít **ngày dạy** hơn thắng.
5. **Trống-1 được thả tự do** — đánh đổi Trống-2 thành Trống-1 là hợp lệ (đúng như công cụ tham chiếu làm: 24 gap2 → 0, gap1 tăng ~24).

Và các **bất biến không bao giờ vi phạm**: đủ 100% số tiết, không trùng giáo viên/phòng, ô cố định (`fixed`) và ô OFF bất khả xâm phạm, tiết đôi không bị tách, các tiết cùng môn trong một buổi phải liền nhau, không vượt giới hạn môn/buổi.

## 3. Vòng lặp chính

```
MAX_ROUNDS = 45; kẹt tối đa 18 vòng liên tiếp thì dừng
mỗi vòng:
  chạy lần lượt operator 0 → 4 (mỗi operator quét toàn trường,
  commit ngay từng nước cải thiện; nước xấu tự rollback)
  nếu cả vòng không cải thiện → leo "thang thoát kẹt" (mục 5)
dừng khi: Trống-2 = 0 | hết vòng | kẹt 18 vòng | hết ngân sách thời gian | người dùng bấm Dừng
```

Người dùng bấm **Dừng** giữa chừng: giữ lại checkpoint tốt nhất đã qua kiểm định, không bao giờ trả lịch xấu hơn lúc bắt đầu.

## 4. Năm operator, theo thứ tự chạy

### Operator 0 — Vòng đẩy tái nhãn (`tryGapRelabelCycles`) ⭐ *nước chủ lực, học từ diff base→1/2/3 của bạn*

Nguyên lý: **không dùng ô trống của lớp, không đổi hình dạng lịch lớp** — chỉ hoán vị *nhãn* tiết giữa các ô đã có tiết của cùng một lớp, theo chuỗi đẩy khép vòng.

```
với mỗi buổi Trống-2 của giáo viên t:
  X = tiết BIÊN của t trong buổi (tiết đầu hoặc cuối span, duration 1, không cố định)
  H = một Ô LỖ bên trong span (t đang rảnh ở đó)
  C = lớp của tiết X;  ô (C, H):
    • nếu ô lớp trống thật → dời thẳng X vào H (xong)
    • nếu ô đang bị tiết Y (giáo viên khác) chiếm:
        X đè vào chỗ Y → Y phải tìm chỗ mới, CHỈ trong các ô đã chiếm khác
        của chính lớp C, nơi giáo viên của Y đang rảnh
        → tiết Z bị Y đè lại đi tiếp như vậy… (DFS, sâu tối đa 7 bước)
        → vòng KHÉP khi một tiết đáp đúng vào ô mà X vừa bỏ trống
  commit: chụp snapshot → nhấc cả chuỗi ra → đặt lại theo vòng, kiểm tra
  đầy đủ ràng buộc từng ô → tính lại metrics → nhận nếu cải thiện, không thì
  khôi phục snapshot nguyên trạng
```

Vì mọi bước đều là "thay chỗ trong ô đã chiếm", lịch học sinh giữ nguyên tuyệt đối — chỉ lịch giáo viên xoay. Đây chính là 100% loại nước đi mà công cụ tham chiếu dùng (173 ô đổi / 96 buổi-lớp / toàn "replace").

### Operator 1 — Nghiền lỗ trong buổi (`tryCrushTeacherGaps`)

Chọn buổi mục tiêu theo đúng luật span (tổng lỗ ≥ 2). Với từng tiết di động của giáo viên trong buổi đó:

- **2-swap**: đổi chỗ với tiết của lớp mình đang nằm ở vị trí đích trong buổi (giáo viên của tiết kia phải rảnh tại chỗ cũ của mình);
- **3-swap vòng**: xoay qua một ô thứ ba bất kỳ trong tuần của lớp khi 2-swap bí;
- **Freshness guard**: mọi nước thử đều kiểm tra lại vị trí thật của tiết trước khi động tay (chống dùng vị trí cũ — nguồn lỗi xếp đè trước đây);
- **Mục 4 — dồn xuyên buổi**: bốc hẳn tiết "lạc đàn" sang buổi khác giáo viên đã có mặt.

### Operator 2 — Kéo tiết về lấp lỗ (`tryFillTeacherGapFromElsewhere`)

Đi từ góc nhìn CÁI LỖ: tìm tiết duration-1 của **chính giáo viên đó** ở buổi khác, kéo về đặt vào lỗ (đặt thẳng nếu ô lớp trống, hoặc 2-swap với tiết đang chiếm).

### Operator 3 — Khối tiết đôi vào lỗ (`tryMoveDoubleBlockIntoGap`)

Lỗ đúng 2 ô liền + giáo viên có khối tiết đôi (duration 2) ở buổi khác → chuyển/hoán cả khối vào lỗ.

### Operator 4 — Giải phóng cả buổi (`tryVacateTeacherSession`)

Buổi Trống-2 quá kẹt → thử dời **toàn bộ** tiết của giáo viên trong buổi đó sang các buổi khác (mỗi tiết tự tìm chỗ qua recursive swapping), chấp nhận tăng nhẹ tổng buổi trong hàng rào ngân sách. Buổi biến mất thì lỗ cũng biến mất.

### Operator 5 — Dời trọn buổi sang nửa-ngày trống (`tryRelocateGapSessionToNewDay`) ⭐ *nới lỏng bạn chốt 17/08: "đưa qua 1 buổi mới"*

Buổi Trống-2 kẹt cấu trúc (2-3 tiết, hỗ trợ cả khối tiết đôi) được bốc **trọn gói** sang một nửa-ngày giáo viên đang trống hoàn toàn, các tiết đặt **liền nhau** (không bao giờ sinh buổi 1 tiết; tổng buổi trung hòa: đóng 1 mở 1). Thử mọi hoán vị thứ tự tiết; ô lớp bị chắn thì ép mở bằng recursive swapping nhắm đúng 1 ô. Ưu tiên đáp: cùng ngày khác buổi → ngày đã có dạy → ngày trống hẳn.

**Tầng B** — đúng chữ "đưa TIẾT LẺ qua buổi mới": khi dời trọn buổi bất thành và buổi có ≥3 tiết, bốc riêng tiết lẻ ở mép (phần còn lại phải liền mạch ≥2 tiết) + mượn một tiết mép từ buổi khác làm bạn đồng hành, mở buổi mới đúng 2 tiết liền nhau (+1 buổi, nằm trong hàng rào ngân sách).

### Operator 6 — Ghép buổi hiến vào lỗ (`tryMergeSessionIntoGaps`) ⭐ *vế 1 hướng 17/08: "lấy tiết lẻ ghép vào 2 chỗ trống"*

Nghịch đảo của dissolve: kéo **nguyên một buổi mỏng** (2-3 tiết) hoặc **cặp tiết mép** của buổi dày (≥4 tiết) về lấp **≥2 lỗ CÙNG LÚC** trong một giao dịch nguyên tử. Vì sao bắt buộc: ca `[1,5]` có 3 lỗ — lấp 1 lỗ vẫn là Trống-2 nên mọi nước đơn lẻ bị gate loại; chỉ nước ghép mới đổi hạng. Buổi hiến tan biến → tổng buổi -1 và Trống-2 -1: thắng kép.

### Operator 7 — Chuỗi Kempe hoán đổi 2 tiết trong buổi (`tryKempeChainPeriodSwap`)

Chọn (tiết biên, tiết lỗ) của buổi kẹt rồi hoán đổi bài học giữa 2 cột tiết đó theo **chuỗi lớp khép kín** (đóng bao qua xung đột giáo viên, tối đa 12 lớp). Đặc tính vàng: lịch mọi lớp giữ nguyên độ phủ (2 ô đổi chỗ nội bộ), mọi giáo viên liên đới chỉ xê dịch trong đúng buổi đó — nhiễu cực nhỏ, không cần recursive swapping. Đây là nước "phẫu thuật" khi kinh tế ô lớp đã bão hòa và mọi eject ngẫu nhiên chỉ dồn gap sang người khác.

## 4b. Portfolio restart + ILS (một cú bấm = nhiều seed)

Quan sát thực nghiệm: mỗi pha ngẫu nhiên "mở" được các ca kẹt KHÁC NHAU (seed này còn 5 ca, seed kia còn 2 ca...). Nút Trống-2 (và Trống-1, 1 tiết/buổi) vì vậy chạy **portfolio**: hết một lượt tối ưu mà chỉ tiêu chưa về 0 thì tự khởi động lại — lượt lẻ đi lại **từ trạng thái gốc** sau khi **lay chuyển ILS** (`perturbForRestart`: vài nước đi hợp lệ ngẫu nhiên để thoát lòng chảo), lượt chẵn đi tiếp **từ global best**. Ngân sách mặc định 90 s / tối đa 14 lượt; chạm 0 là dừng ngay. Kết quả cuối và MỌI checkpoint gửi ra (kể cả khi bấm Dừng) luôn là **global best** qua mọi lượt (`checkpointGuard`).

Trong "Tối ưu tất cả": các lát stage chạy không portfolio; 35% ngân sách được **để dành** cho bước chốt — quét xen kẽ (1 tiết/buổi → Trống-2) bằng đúng cỗ máy portfolio trên toàn bộ thời gian còn lại.

## 5. Thang thoát kẹt (khi một vòng trọn không cải thiện)

Chạy lần lượt, mỗi bậc mạnh (và rủi ro thời gian) hơn bậc trước:

- **A.** Hoán đổi nguyên buổi giữa hai ngày của một lớp (`tryWholeSessionSwap`);
- **B.** Chuỗi đẩy sâu 4 bước nhắm vào các giáo viên đang kẹt (`tryDeepEjectionChain`);
- **C.** Phá-và-dựng-lại cụm 3–4 giáo viên liên đới qua đồ thị xung đột (`tryRelatedClusterRuin`);
- **D.** Đi ngang trên "yên ngựa" — chấp nhận các nước hòa để đổi vùng tìm kiếm, tự rollback nếu không dẫn tới cải thiện (`tryNeutralPlateauWalk`);
- **E.** Nhảy sang một bản lịch "tinh hoa" khác trong kho Top-3 rồi tìm tiếp từ đó.

## 6. Lưới an toàn (áp cho mọi operator)

1. **Integrity gate**: mỗi operator chạy xong bị kiểm tra nhất quán toàn cục (mỗi tiết đúng một ô, không ô mồ côi, không mất tiết). Trạng thái hỏng → khôi phục snapshot, coi như "không cải thiện". Không một nước hỏng nào sống sót được vào kết quả.
2. **moveJournal**: riêng recursive swapping dùng nhật ký giao dịch, hoàn tác bằng cách phát lại ngược chính xác — loại trừ lớp lỗi "khôi phục nhầm ô".
3. Kết quả cuối luôn là **best snapshot** đã qua kiểm định; bảng Thống kê và nhãn tiến trình giờ dùng cùng một thước đo với engine.

## 7. Vì sao có thể còn sót vài ca trên app thật?

Fixture kiểm chứng của Claude không chứa ràng buộc người dùng; trên app, một ca Trống-2 chỉ "cứng đầu" khi **mọi** đường ở mục 4 đều bị chặn bởi: tiết cố định nằm đúng biên/lỗ, ô OFF, giới hạn môn/buổi, hoặc tiết đôi không tách được. Đó là **sàn cấu trúc** — bước B2 kế tiếp (chứng chỉ sàn) sẽ chỉ đích danh "ca này còn vì ràng buộc X của thầy/cô Y" ngay trên giao diện, thay vì để bạn đoán.

---

*Số liệu kiểm chứng hiện tại: bộ thí nghiệm base của bạn 24→0 trong 0,1s, buổi 591→567, Trống-1 165 (tham chiếu: 20 bước tay, giữ 591 buổi, Trống-1 196); trường default 0317: 37→0/0,3s; 1566 giai đoạn 4: 9→0 với 491 buổi (tham chiếu 500); **trường default + 2.307 ô OFF thật: nút Trống-2 35→0, "Tối ưu tất cả" đạt 1tiết=0 & Trống-2=0**.*
