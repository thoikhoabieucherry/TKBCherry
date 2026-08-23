# Benchmark FET trên web

**tools/benchmarks/benchmark-fet.js** nạp đúng
**web/pages/tkb-fet-engine.js** bằng VM; không có bản solver thứ hai. Fixture
đều tổng hợp, ẩn danh, không đọc DATA, SQLite hay gọi mạng.

## Fixture

| Variant | Lớp | Tiết yêu cầu | Mục đích |
| --- | ---: | ---: | --- |
| smoke | 5 | 49 | Test nhanh fixed/OFF, phòng, GV và tiết đôi |
| pressure | 6 | 51 | Có sàn Gap2 cố định bằng 1 |
| medium | 24 | 432 | Mốc construction và bốn nút tối ưu |
| stress | 60 | 2.340 | Kiểm tra deadline trên bài toán lớn |

Room generator của medium bảo đảm sức chứa sáng/chiều khả thi. Preflight engine
vẫn tự phát hiện thiếu sức chứa lớp, giáo viên hoặc phòng trong fixture tùy
biến.

## Lệnh canonical

~~~powershell
node tools\benchmarks\benchmark-fet.js --fixture=medium --seeds=101,202,303 --modes=auto,optimize_singletons,optimize_sessions,optimize_gap2,optimize_gap1 --auto-budget-ms=6000 --optimizer-timeout-ms=8000 --out=docs\benchmarks\fet-medium-latest.json --strict

node tools\benchmarks\benchmark-fet.js --fixture=pressure --seeds=101,202,303 --modes=auto,optimize_gap2 --auto-budget-ms=6000 --optimizer-timeout-ms=8000 --out=docs\benchmarks\fet-pressure-latest.json --strict
~~~

Mode auto trong harness mô phỏng nút Xếp: construction polish 250 ms và
initialSingletonPacking=false. optimize_singletons bật đúng cờ singletonRush
của menu.

## Kết quả 23/08/2026

Medium, 3 seed:

| Mode | Complete/hard-valid | Wall p50 / p95 | Optimization p50 / p95 | Delta mục tiêu TB |
| --- | ---: | ---: | ---: | ---: |
| auto | 100% / 100% | 166,93 / 199,13 ms | 0 / 0 ms | — |
| 1 tiết/buổi | 100% / 100% | 1.804,15 / 2.325,41 ms | 1.634,45 / 2.155,97 ms | -16,33 |
| Buổi | 100% / 100% | 717,20 / 733,69 ms | 519,83 / 560,56 ms | -13,00 |
| 2 tiết trống | 100% / 100% | 486,60 / 543,09 ms | 300,76 / 363,28 ms | 0,00 (đã bằng 0) |
| 1 tiết trống | 100% / 100% | 738,56 / 835,25 ms | 506,26 / 673,20 ms | -3,33 |

Pressure, 3 seed: complete/hard-valid 100%; Gap2 giữ đúng sàn đã chứng minh
bằng 1, floorReached=100%, p50 31,75 ms.

Stress với budget construction 1.000 ms dừng ở khoảng 1.054 ms và báo
incomplete. Đây là kiểm tra deadline, không phải kỳ vọng solve 2.340 tiết trong
một giây.

## Trường báo cáo

Mỗi record có:

- runtimeMs: tổng wall time;
- phaseRuntimeMs.construction và phaseRuntimeMs.optimization;
- placement, initial/final metrics, delta, target/floor;
- preflight/failure kind;
- kết quả validator độc lập.

completeValid=true chỉ khi đủ đúng số tiết, engine không còn activity chưa xếp
và validator không thấy vi phạm. Timeout/plateau không được đổi thành target
success.

Chỉ giữ hai report *-latest.json canonical. Report ngày cũ và tài liệu mô tả
pipeline 90–600 giây đã xóa để tránh dùng nhầm.
