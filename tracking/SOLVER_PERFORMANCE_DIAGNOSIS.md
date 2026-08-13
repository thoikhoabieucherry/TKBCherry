# Chẩn đoán hiệu năng bộ sắp xếp thời khóa biểu tự động

Phạm vi chính: `solver_runtime/src/tkb_optimizer_ref/session_cp_sat.py`, đặc
biệt là `solve_session_allocation_cp_sat()` và cầu nối tiết học
(`period_block`).

## Kết luận ngắn

1. Bộ dữ liệu hiện có gồm **14 quan sát lịch sử đã được chọn để chẩn đoán**,
   không phải mẫu ngẫu nhiên của toàn bộ production. Vì vậy, các tỷ lệ
   `8/14 OPTIMAL`, `6/14 FEASIBLE` và `7/14 bestEffort` **không phải tỷ lệ lỗi
   production**.
2. `period_block` là phần mô hình lớn, tối đa **31.763 biến** trong tập quan
   sát. Đây là tín hiệu cần đo thêm, chưa đủ để kết luận nó là nguyên nhân gốc
   của thời gian chạy.
3. Code hiện tại đã kiểm tra `_assignment_block_allowed()` và các điều kiện
   fixed/contiguous/subject **trước** `NewBoolVar()`. Đề xuất “đưa lọc lên
   trước khi tạo biến” trong bản chẩn đoán cũ vì thế không còn đúng.
4. Hàm mục tiêu trọng số hiện tại là phép mã hóa lexicographic chính xác nếu
   mọi upper bound dùng để tạo trọng số đều đúng. Khoảng cách
   `objective/best_bound` lớn không tự chứng minh rằng trọng số là nguyên nhân
   làm cận yếu.
5. Thay đổi an toàn đã triển khai trong phiên này chỉ bỏ các cặp
   `duration × start` chắc chắn không liên tiếp trước khi gọi rule-domain
   memo. Nó giữ nguyên miền biến, tên biến và thứ tự tạo biến. Chưa có
   benchmark production nên chưa tuyên bố mức tăng tốc.

## 1. Dữ liệu và giới hạn suy luận

Baseline được lưu dưới dạng telemetry đã khử định danh tại:

`solver_runtime/fixtures/performance/automatic_solver_observations_v1.json`

Fixture chỉ giữ cấu hình solver, số đếm, thời gian lịch sử và trạng thái kết
thúc. Nó không chứa request, response, bài học, tên trường, lớp, môn, giáo viên
hay phòng. Vì không có payload đầu vào và môi trường máy gốc, fixture này:

- tái tạo được các phép tổng hợp trong tài liệu;
- bảo vệ schema và provenance của baseline;
- **không** chạy lại solver hiện tại;
- **không** phải benchmark trước/sau;
- **không** cho phép quy một khác biệt về thời gian cho một thay đổi code.

### Các cohort phải so sánh riêng

| Cohort | Số quan sát | Kết quả | Thời gian lịch sử | Mức hoàn thành thấp nhất | `period_block_vars` lớn nhất |
|---|---:|---|---:|---:|---:|
| Trường lớn, chỉ tối thiểu buổi 1 tiết | 7 | 7 OPTIMAL | 4,204–8,696 giây | 2096/2103 = 99,667% | 31.763 |
| Trường lớn, cho phép chưa xếp (`allow_unassigned`) | 4 | 4 FEASIBLE | 60,109–120,123 giây | 1927/2103 = 91,631% | 24.906 |
| Trường lớn, buổi 1 tiết rồi tổng buổi GV | 2 | 2 FEASIBLE | 30,124–30,156 giây | xem lưu ý bên dưới | 31.373 |
| Smoke 1 lớp × 1 giáo viên | 1 | 1 OPTIMAL | 0,004 giây | 1/1 | 0 |

Cohort trường lớn có 72 lớp, 122–123 giáo viên và 2.103 tiết kỳ vọng. Dòng
smoke không được dùng để suy luận hiệu năng trường lớn.

Trong cohort `allow_unassigned`, raw gap lớn nhất là
`168,999998337804`, tính theo
`(objective - best_bound) / abs(best_bound)`. Chỉ số này có thể dùng để tái
tạo đúng một dòng lịch sử, nhưng không được so trực tiếp giữa các
`objective_mode`: scale và ý nghĩa của objective khác nhau.

Trong cohort “buổi 1 tiết rồi tổng buổi GV”:

- một lần xếp đủ 2103/2103 nhưng dừng FEASIBLE sau khoảng 30,16 giây; raw gap
  của chính lần đó khoảng 20,98;
- dòng 1703/2103 không phải bằng chứng rằng session solver chỉ xếp được 81%.
  Telemetry của dòng tổng hợp có 1.739 tiết thuộc phần request/allocation ở
  pha này, 360 tiết fixed và phần thiếu xuất hiện sau đường materialization /
  fallback. Muốn quy nguyên nhân phải replay toàn pipeline với payload gốc.

`bestEffort` cũng là cờ ở cấp pipeline, không đồng nghĩa một-một với
`session_solver=FEASIBLE`: dòng smoke vừa `OPTIMAL` vừa có `bestEffort=true`.

## 2. Những gì source hiện tại thực sự làm

### 2.1. Miền `period_block`

Với mỗi `(assignment, session)`, solver xét các block liên tiếp theo
`duration` và `start`. Trước khi tạo biến, code đã thực hiện:

1. kiểm tra block nằm trong tập tiết được phép qua
   `_assignment_block_allowed()`;
2. kiểm tra tính liên tiếp khi ghép với tiết fixed;
3. kiểm tra rule môn và nhóm môn cho block đã ghép;
4. chỉ sau đó mới gọi
   `NewBoolVar("period_block_<assignment>_<session>_<duration>_<start>")`.

Tên `period_block_*` là một phần của protocol nội bộ hiện có:
`external_cp_sat.py` parse tên này để giữ/release hint trong external LNS và
test replay cũng dựa vào nó. Không được bỏ hoặc đổi tên chỉ để giảm chi phí
f-string nếu chưa thay đồng thời protocol và test tương ứng.

Số biến lớn nhất 31.763 cho thấy cầu nối này đáng profile, nhưng số lượng biến
không đo riêng thời gian build, presolve hoặc search. Cần benchmark có kiểm
soát trước khi gọi đây là “đóng góp chính”.

### 2.2. `AssignmentSessionDomainMemo`

`AssignmentSessionDomainMemo` hiện có vòng đời một lần solve. Điều này được
thiết kế rõ trong docstring và tránh chia sẻ state giữa request.

Tái sử dụng memo giữa nhiều lần bấm là một **giả thuyết tối ưu**, chưa phải
bug đã chứng minh. Một cache liên request chỉ an toàn khi khóa cache bao phủ
toàn bộ dữ liệu ảnh hưởng domain, object dùng làm key thật sự immutable, có
giới hạn bộ nhớ, có cơ chế invalidation và an toàn khi solve đồng thời. Chưa
có profile cho thấy chi phí query domain chiếm tỷ trọng đủ lớn để biện minh
cho độ phức tạp này.

Tái sử dụng cả `CpModel` còn rủi ro hơn vì fixed lessons, incumbent, hints,
caps, objective mode và deadline có thể thay đổi giữa các pha. Không triển
khai khi chưa có thiết kế state/invalidation riêng.

### 2.3. Mục tiêu lexicographic

`_lexicographic_expression()` tạo trọng số từ upper bound của từng tầng:

```python
for name, expression, upper_bound in reversed(components):
    weights[name] = multiplier
    objective += expression * multiplier
    multiplier *= upper_bound + 1
```

Khi upper bound hợp lệ, đây là scalarization lexicographic chính xác: một đơn
vị ở tầng ưu tiên cao luôn lớn hơn tổng phạm vi của các tầng thấp hơn. Code
cũng kiểm tra rủi ro int64 khi thêm hint-distance tie-break và bỏ tie-break
nếu có nguy cơ vượt giới hạn.

Do đó, chưa có bằng chứng để kết luận “big-M làm LP relaxation yếu” chỉ từ raw
gap. Muốn kiểm tra giả thuyết này phải so A/B trên cùng model proto, seed,
workers, deadline và tuple chất lượng đầu ra.

Giải tuần tự nhiều lượt không tự động an toàn hơn. Chỉ được khóa giá trị một
tầng khi lượt đó đã `OPTIMAL`; nếu chỉ `FEASIBLE`, khóa incumbent có thể loại
bỏ nghiệm tốt hơn ở chính tầng ưu tiên cao. Ngoài ra, nhiều lượt solve phải
chia cùng một ngân sách tổng thay vì cấp lại toàn bộ timeout cho mỗi lượt.

## 3. Phần đã triển khai an toàn

### 3.1. Bỏ kiểm tra Python dư thừa, không đổi mô hình

Helper `_contiguous_run_lengths_by_start(allowed_periods)` tính độ dài dải
liên tiếp bắt đầu tại mỗi tiết, rồi vòng lặp cũ bỏ ngay block dài hơn dải đó.

Các bất biến được giữ:

- cùng tập `(duration, start, block)` từng vượt qua kiểm tra liên tiếp cũ;
- cùng thứ tự `duration` trước, `start` sau;
- cùng tên biến `period_block_*`;
- cùng số biến và miền nghiệm CP-SAT;
- cùng đường kiểm tra rule/fixed còn lại.

Tối ưu này chỉ ngăn các cặp chắc chắn cắt qua tiết không khả dụng đi vào
`_assignment_block_allowed()` và domain memo. Trên một sample audit, phần bị
bỏ là 400/11.801 cặp (3,39%); trên dữ liệu quan sát đã instrument có mức
khoảng 8,55%. Đây là tỷ lệ bớt kiểm tra Python, **không phải tỷ lệ giảm biến
hay tỷ lệ tăng tốc**.

Telemetry mới:

- `period_block_candidate_pairs`: số cặp Cartesian thô;
- `period_block_contiguous_pruned`: số cặp bị bỏ vì không liên tiếp;
- `period_block_rule_or_fixed_pruned`: số cặp còn lại bị rule/fixed loại;
- `period_block_vars`: số biến thực sự được tạo.

Với bridge bật, các số đếm phải thỏa:

```text
candidate_pairs
= period_block_vars + contiguous_pruned + rule_or_fixed_pruned
```

Khi bridge không chạy, cả ba telemetry mới bằng 0.

### 3.2. Guardrail baseline tự chứa

`solver_runtime/tests/test_solver_performance_regression.py` đọc fixture đã
khử định danh, dùng Python standard library, không skip khi thiếu production
logs và không ghi file trong lúc chạy. Test kiểm tra:

- schema, provenance và đủ 14 dòng;
- đúng cohort 13 trường lớn + 1 smoke;
- tổng trạng thái 8 OPTIMAL + 6 FEASIBLE;
- accounting tiết học ở từng dòng;
- baseline lớn nhất 31.763 `period_block_vars`;
- phép tổng hợp raw gap và completion khớp fixture.

Hai ngưỡng 200 cho raw gap và 75% cho completion chỉ bảo vệ baseline lịch sử
khỏi bị sửa nhầm. Chúng không chặn hồi quy runtime của solver hiện tại và
không nên được quảng bá như SLO production.

## 4. Gates trước các thay đổi tiếp theo

### Gate A — chứng minh quick win hiện tại có lợi

Chạy benchmark trước/sau trên cùng input có quyền sử dụng, cùng OR-Tools,
máy, seed, workers và deadline. Ghi riêng thời gian build model, thời gian
solve, số biến/ràng buộc, branches, conflicts và tuple chất lượng. Chỉ giữ
tối ưu vì hiệu năng nếu kết quả lặp lại cho thấy lợi ích ngoài nhiễu đo.

### Gate B — giảm thật số biến hoặc dùng interval

Phải chứng minh tương đương miền nghiệm trên fixture nhỏ bằng exhaustive /
property tests, giữ external LNS protocol hoặc version protocol mới, và chạy
toàn bộ regression Planner. `OptionalIntervalVar` là một hướng nghiên cứu,
không phải thay thế cơ học vì model hiện còn fixed anchors, subject/group
block rules, materialization và hint replay.

### Gate C — cache qua nhiều solve

Profile trước để xác nhận domain lookup đáng kể. Sau đó mới thiết kế chữ ký
cache đầy đủ, invalidation, giới hạn bộ nhớ và test concurrency. Không cache
`CpModel` theo `solve_run_id` nếu key không bao phủ toàn bộ state mô hình.

### Gate D — objective nhiều lượt

So sánh với scalarization hiện tại bằng tuple lexicographic công khai. Mỗi
tầng chỉ được khóa sau `OPTIMAL`; khi hết giờ ở trạng thái `FEASIBLE`, phải
giữ semantic ưu tiên tuyệt đối và trả incumbent hợp lệ. Tổng thời gian của
tất cả lượt không được vượt deadline của request.

## 5. Kiểm chứng

Chạy guardrail dữ liệu lịch sử:

```bash
python -m unittest solver_runtime/tests/test_solver_performance_regression.py -v
```

Chạy test miền candidate và materialization của cầu nối tiết:

```bash
python -m unittest solver_runtime/tests/test_session_cp_sat_period_gap_quality.py -v
```

Chạy contract external CP-SAT vì tên `period_block_*` được protocol sử dụng:

```bash
python -m unittest solver_runtime/tests/test_external_cp_sat.py -v
```

Ba lệnh trên kiểm tra contract và tính đúng trên fixture. Một benchmark
production-like có kiểm soát vẫn là điều kiện bắt buộc trước khi kết luận
solver nhanh hơn hoặc chất lượng tốt hơn.
