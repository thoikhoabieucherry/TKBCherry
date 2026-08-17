# Kế hoạch cải tiến bộ tối ưu TKB (Optimizer v2)

*Lập ngày 2026-08-16, dựa trên yêu cầu của chủ dự án và số liệu đo từ bộ dữ liệu thật (`C:\Users\Love\Documents\Codex\MD`).*

---

## 0. Hiện trạng đo được (baseline)

Đo từ `tonggv0316082026.xlsx` — kết quả thuật toán hiện tại trên trường mặc định (125 giáo viên, 75 lớp, 2.193 tiết):

| Chỉ số | Hiện tại | Mục tiêu |
|---|---:|---|
| Buổi giáo viên dạy 1 tiết (singleton) | **68** | **0** (hoặc sàn cấu trúc có giải thích) |
| Buổi có khoảng trống ≥ 2 tiết (gap2) | **49** | **0** (hoặc sàn cấu trúc có giải thích) |
| Buổi có khoảng trống 1 tiết (gap1) | 153 | Giảm tối đa (mục tiêu ≥ 30%) |
| Tổng buổi dạy toàn trường | 735 | Giảm (không đánh đổi 3 chỉ số trên) |
| Tổng ngày dạy toàn trường | 643 | Giảm theo buổi |

Phân bố lỗi trải rộng trên nhiều GV (mỗi người 2–4 singleton) chứ không dồn vào vài người — nghĩa là vấn đề nằm ở **cơ chế thoát kẹt cục bộ**, không phải một ràng buộc đơn lẻ. Có các ca cấu trúc thật (PHT.Đài 4 tiết/3 buổi — tải quá mỏng để gộp) cần được *chứng minh là sàn* thay vì tối ưu mãi không xong.

Baseline này phải được cố định thành fixture benchmark trước khi sửa bất kỳ dòng code nào.

---

## 1. Chuẩn hóa: MỘT thứ tự ưu tiên duy nhất

Bốn nút hiện tại thực chất là bốn phép chiếu của **cùng một hàm mục tiêu lexicographic**. Từ mô tả của chủ dự án ("gap2 được phép tăng nhẹ buổi để tháo kẹt, và phải khử về 0"), thứ tự đầy đủ là:

```
T = ( unplaced = 0  &  hard-valid        — bất khả xâm phạm, không bao giờ rớt về "chưa phân"
    , soBuoiDay1 (singleton)             — ưu tiên 1, mục tiêu 0
    , soBuoiTrong2 (gap ≥ 2)             — ưu tiên 2, mục tiêu 0, ĐƯỢC đổi bằng tăng buổi
    , tsBuoiDay (tổng buổi dạy)          — ưu tiên 3, cực tiểu
    , soBuoiTrong1 (gap 1)               — ưu tiên 4, cực tiểu
    , tsNgayDay (tie-break)              — hòa thì ít ngày hơn thắng
    )
```

Thứ tự này **trùng với hợp đồng lexicographic phía server** (README/Cloud Run) — tức là toàn hệ thống chỉ còn một định nghĩa "tốt hơn". Việc đầu tiên của v2 là hợp nhất: hiện `compareMetrics(a, b, mode)` trong `tkb-fet-engine.js` có logic riêng cho từng mode — thay bằng một `compareTuple(a, b)` duy nhất + tham số `focus` chỉ quyết định *operator nào được ưu tiên chạy*, không đổi định nghĩa tốt/xấu.

## 2. Trả lời câu hỏi "có cần 4 nút không?"

**Không cần cho người dùng cuối.** Đề xuất UX:

- **Một nút "Tối ưu"** chạy toàn bộ pipeline tự động theo thứ tự T (mục 3). Người dùng thường chỉ thấy nút này — bấm một lần, máy tự lo.
- **4 nút cũ chuyển vào menu nâng cao** (hoặc chỉ superadmin thấy) làm công cụ chẩn đoán/từng bước — đúng như mục "Buổi" tổng quát hiện đã chỉ hiện với superadmin. Không xóa code, chỉ đổi chỗ trên UI, nên rủi ro gần bằng 0.

## 3. Kiến trúc chống kẹt — trả lời nỗi lo "liên hoàn tối ưu vướng một bước"

Đây là phần lõi của v2. Ba cơ chế phối hợp:

### 3.1. Stage controller round-robin với ngân sách

Không chạy tuần tự "xong hẳn stage 1 mới sang stage 2" (kiểu này mới bị kẹt một chỗ ăn hết thời gian). Thay vào đó:

- Mỗi stage (singleton → gap2 → sessions → gap1) nhận **ngân sách mềm mỗi vòng** (ví dụ 25% / 25% / 30% / 20% tổng budget của vòng).
- **Stagnation detector**: K vòng lặp không cải thiện tuple → snapshot best, chuyển stage kế tiếp ngay, quay lại stage này ở vòng sau.
- Lặp round-robin đến khi **fixpoint** (một vòng trọn không stage nào cải thiện được) hoặc hết tổng ngân sách. Kết quả trả về luôn là best snapshot.
- **Early-exit**: metric của stage chạm 0 hoặc chạm sàn cấu trúc → bỏ qua stage đó ở các vòng sau.

### 3.2. Chứng chỉ sàn (floor certificates) — biến "kẹt" thành "đã chứng minh"

Trước khi tối ưu, tính **cận dưới cấu trúc** cho từng GV từng metric (tổng quát hóa `classifySingleton` và `getResidualGap2Sessions` đã có):

- *Singleton floor*: GV có tổng tiết trong một khối ca không thể gộp (tải quá mỏng như PHT 4 tiết, tiết cố định đơn độc trong buổi, giới hạn môn/buổi do người dùng đặt).
- *Gap2 floor*: hai tiết cố định của cùng GV cách nhau ≥ 2 trong một buổi mà mọi tiết chèn được đều bị ràng buộc chặn.

Stage chạm sàn → **dừng ngay và báo nhẹ nhàng**: "Đã tối ưu xong. Còn X buổi 1 tiết do ràng buộc: [GV A — tiết cố định thứ 5; GV B — tải 4 tiết/tuần…]". Đây chính là câu trả lời cho ca "người dùng tự tạo mâu thuẫn": không tốn thời gian húc vào tường, và người dùng biết chính xác phải nới ràng buộc nào.

### 3.3. Không bao giờ rớt về "chưa phân"

Mọi operator chỉ hoán đổi/dời trong không gian **lịch đầy đủ**; mọi biến đổi thất bại đều rollback về snapshot. (Engine hiện đã có `saveBestSnapshot` — nâng thành bất biến bắt buộc của controller: mọi đường thoát đều đi qua verify hard-valid + đủ tiết trước khi commit.)

## 4. Nâng cấp bộ operator (trong `tkb-fet-engine.js`)

Xếp theo tỷ lệ lợi ích/rủi ro:

1. **Micro-exact repair** *(mới — đáng giá nhất)*: với các nút thắt còn sót cuối kỳ tối ưu (thường < 10 GV), cố định toàn bộ lịch trừ 2–3 GV liên quan (chọn qua conflict graph sẵn có) rồi **giải chính xác** bài toán con ~20–40 ô bằng duyệt toàn bộ/DP — vài chục ms mỗi nút thắt. Heuristic bỏ sót thì exact bắt được; đây là con đường thực tế để đạt "0 tuyệt đối" cho singleton và gap2.
2. **Ejection chain sâu hơn theo kiểu FET**: FET gốc dùng "recursive swapping" với độ sâu lớn (14+). Engine hiện giới hạn 3–4 bước. Nâng thành **iterative deepening** có time-box theo từng nút thắt: thử sâu 4 → 6 → 8… chỉ với các GV đang kẹt. (Học ý tưởng, không copy code GPL.)
3. **LAHC (Late Acceptance Hill Climbing)** làm acceptance chung thay cho strict-descent + plateau walk rời rạc: đơn giản, một tham số, chuyên trị plateau — phối hợp tự nhiên với comparator hợp nhất.
4. **Elite archive dùng chung giữa các stage** (hiện có Top-3 nhưng cục bộ theo mode): stage sau khởi động lại từ elite đa dạng của stage trước khi bị kẹt.
5. **Construction có lookahead cụm**: tăng trọng số "xếp bám cụm cùng buổi" trong `getPlacementPenalty` để nghiệm khởi đầu ít singleton sẵn — giảm tải cho cả pipeline (số liệu handoff cho thấy construction hiện tạo ~130 singleton trước tối ưu).

## 5. Học được gì từ FET gốc (thư mục `C:\Users\Love\Documents\Codex\FET`)

Ba ý tưởng đáng vay mượn (ý tưởng thuật toán — không copy mã nguồn vì FET là GPL):

- Không chia phase: mọi ràng buộc mềm là trọng số trong một hàm đánh giá duy nhất → khớp với comparator hợp nhất ở mục 1.
- Recursive swapping sâu với randomized restart → mục 4.2.
- Đặt activity theo độ khó giảm dần và **quay lui sớm** khi một activity hết chỗ → engine đã có MRV, bổ sung phần quay lui sớm trong construction.

## 6. Lộ trình thực thi (verification-first, không đụng dữ liệu người dùng)

Lợi thế lớn: engine FET là **JS thuần** — chạy và benchmark được ngay trong sandbox làm việc của Claude bằng `tools/benchmarks/benchmark-fet.js` (không cần server, không cần Windows). Mỗi bước dưới đây đều có cổng kiểm chứng tự động trước khi sang bước sau.

| Bước | Nội dung | Cổng kiểm chứng |
|---|---|---|
| **B0** | Fixture hóa baseline: dựng fixture từ bộ default 2.193 tiết (tìm `school_default_vps.json` đã dùng trong các đợt verify trước) + ghi cứng số liệu 68/49/153/735 làm mốc so sánh; thêm export metrics tự động từ engine | Benchmark chạy lặp lại được, số khớp mốc |
| **B1** | Hợp nhất `compareTuple` + stage controller (round-robin, budget, stagnation, early-exit); 4 nút cũ gọi qua controller | 4 fixture benchmark + bộ default: không chỉ số nào tệ hơn baseline; `node --check` + e2e planner tests xanh |
| **B2** | `computeFloors()` — chứng chỉ sàn cho singleton/gap2 + toast giải thích nguyên nhân trên UI | Ca PHT.Đài được chứng minh sàn; test đơn vị cho từng loại chứng chỉ |
| **B3** | Micro-exact repair + ejection chain iterative-deepening + LAHC + elite chung | Bộ default: singleton 68 → 0 (hoặc sàn), gap2 49 → 0 (hoặc sàn), gap1 giảm ≥ 30%, tổng buổi không tăng so baseline |
| **B4** | UX một nút "Tối ưu" hợp nhất; 4 nút vào menu nâng cao; cập nhật e2e planner tests | e2e + checklist regression |
| **B5** | Deploy VPS (chỉ upload `web/pages/*`, như các đợt trước) | Smoke tkbcherry.com; **không đụng** `tkb_store.db*` — rsync đã exclude WAL, giữ nguyên |

Ghi chú an toàn dữ liệu: toàn bộ thay đổi nằm ở engine phía trình duyệt và test; không sửa schema, không ghi đè kvstore, không thay đổi quy trình deploy DB.

## 7. Ngoài phạm vi (ghi nhận, làm sau)

- Thiết kế lại giao diện tổng thể (ý tưởng "skill kiểu Hermes") — làm sau khi thuật toán xong; có thể đóng thành skill riêng để tái sử dụng.
- Gỡ hoàn toàn mã Agent còn sót trong `main.rs` / `tkb-rust-bridge.js` — phiên riêng, cần build Rust cục bộ.
- Đồng bộ thứ tự ưu tiên mới (nếu có thay đổi) sang solver Python/Cloud Run — hiện thứ tự đã trùng, chỉ cần đối chiếu lại sau B3.


---

## 8. Đối đầu với pipeline tham chiếu (bổ sung 2026-08-16, tối)

Chủ dự án cung cấp 6 file xuất theo quy trình tham chiếu (nghi từ SmartScheduler) trên bộ Đông Khởi 1.566 tiết / 54 lớp / 93 GV: `xếp mới → hạn chế 1 tiết/buổi → hạn chế 2 tiết/buổi → hạn chế 3 tiết/buổi → giảm 2 tiết trống → giảm 1 tiết trống`.

Metrics đo được từng giai đoạn (buổi / 1t / gap1 / gap2 / ngày):

| Giai đoạn | buổi | 1t | 2t | 3t | 4t | gap1 | gap2 | ngày |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Xếp mới | 699 | 155 | 270 | 225 | 49 | 153 | 32 | 454 |
| Hạn chế 1t/buổi | 602 | 0 | 309 | 224 | 69 | 177 | 28 | 414 |
| Hạn chế 2t/buổi | 516 | 0 | 97 | 304 | 115 | 117 | 9 | 380 |
| Hạn chế 3t/buổi | 500 | 0 | 96 | 242 | 162 | 82 | 9 | 370 |
| Giảm 2 tiết trống | 500 | 0 | 97 | 240 | 163 | 95 | 0 | 370 |
| Giảm 1 tiết trống (cuối) | **500** | **0** | 113 | 208 | 179 | **68** | **0** | **370** |

Chiến lược tham chiếu = dồn buổi lũy tiến (k=1→2→3) trước, khử trống sau; gap2 tự rơi 32→9 trong lúc dồn buổi.

**Kết quả engine TKBCherry (bản B3, `optimizeAll`, cùng dữ liệu, fixture `scratch/dongkhoi_1566.json`):**

| Seed | 1t | gap2 | buổi | gap1 | ngày | thời gian |
|---|---:|---:|---:|---:|---:|---:|
| 101 | 0 | 0 | **482** | 78 | **367** | 43 s |
| 202 | 0 | 0 | **457** | **67** | **357** | 59 s |
| 303 | 0 | 0 | **410** | **63** | **329** | 40 s |
| *Tham chiếu* | 0 | 0 | 500 | 68 | 370 | — |

→ Engine hiện tại **thắng tham chiếu theo thứ tự lexicographic ở cả 3 seed** (seed 303 vượt ở mọi chỉ số: ít hơn 90 buổi, 41 ngày). Độ lệch giữa seed lớn (410–482) → đã thêm option `optimizeAllRestarts` (mặc định 1) chạy nhiều seed lấy kết quả tốt nhất khi cho phép ngân sách lớn.

**Prior art đối chiếu:** quy trình tham chiếu thuộc họ *phased/lexicographic local search* quen thuộc trong văn liệu xếp TKB trường học: FET dùng "recursive swapping" (Lalescu); KHE của Jeff Kingston chạy theo pha + ejection chains; GOAL solver (vô địch ITC2011/XHSTT) là hybrid SA + Iterated Local Search; ngoài ra có Tabu search (Schaerf) và MaxSAT-LNS. optimizeAll của ta cùng họ này, bổ sung: cổng toàn vẹn, chứng chỉ sàn (B2), micro-exact repair (B3 tiếp).
