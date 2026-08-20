# Project: TKBCherry FET Solver - Zero Singleton & Multi-Tier Optimization

## Architecture
- **Core Algorithm**: Constraint Satisfaction Problem (CSP) solver based on FET C++ engine principles with Maximum Remaining Values (MRV) heuristic, dynamic domain filtering, and conflict-driven recursive backtracking.
- **Session-Block Constructive Packing (R1)**: Mathematical session-budget invariant $M = \lfloor W_T / 2 \rfloor$, `opensUnaffordableSession` deficit guarding, `hasViableCompanionForSession` in `isSlotFeasible`, and strong affinity heuristic scoring (`-1500` for companion slots) to pack teaching periods in pairs during initial constructive placement.
- **Min-Conflicts Escape Chains (R2)**: Multi-tier recursive `randomSwap(actId, level = 0)` with depth up to 16, dynamic Tabu memory $[5..12]$, closed push-cycles (`tryClosedPushCycles`), and cross-class Kempe chains (`tryCrossClassSingletonKempeSwap`) to escape dense conflict clusters without infinite loops or UI freeze.
- **Deep Post-Optimization Engine (R3)**: 14-stage heuristic optimization pipeline (`tryPairClassSingletons`, `tryCrossDayPairShift`, `tryTargetedIntraClassSingletonCrusher`, `trySingletonEjectionChains`, `tryShareRichToSingleton`, etc.) running until zero singletons (`runUntilZeroSingletons`) with Iterated Local Search (ILS) perturbation kicks.
- **Strict Invariant Guarding (R4)**: Contiguous student session compaction (`compactAllStudentSessions`, `countTotalStudentHoles() === 0`), teacher gap-2 avoidance (`soBuoiTrong2 === 0`), 100% placement rate (`unplacedCount === 0`), and absolute preservation of fixed flag cells (`-3`) and off/busy cells (`-2`).

## Code Layout
- `web/pages/tkb-fet-engine.js`: Primary solver implementation, CSP search, ejection chains, and post-optimization operators.
- `web/tkb-fet-engine.js`: Canonical mirror of the engine for runtime consistency.
- `web/pages/tkb-fet-worker.js`: Web Worker background wrapper with cooperative event-loop yielding (`setTimeout(0)`).
- `web/tkb-fet-worker.js`: Canonical mirror of the Web Worker wrapper.
- `e2e_tests/zero_singleton_cross_day_e2e.test.js`: Tier 1–4 acceptance test suite for cross-day shifts and live school default verification.
- `e2e_tests/augmented_singleton_e2e.test.js`: Comprehensive 40-test singleton invariant suite.
- `e2e_tests/tkb_fet_engine_node.test.js`: Core engine CSP semantics and constraint checks.
- `e2e_tests/tkb_fet_benchmark_node.test.js`: Telemetry and performance benchmarks.
- `e2e_tests/adversarial_ui_worker_stress_node.test.js`: Stress tests for worker responsiveness, yielding, and cancellation.
- `e2e_tests/planner_subject_limit_semantics_node.test.js`: Subject daily limits and period distribution semantics.
- `scratch/live_school_default.json`: Official production test benchmark (75 classes, 129 teachers, 2,202 periods).

## Feature Inventory
| # | Feature | Description | Milestone | Source | Status |
|---|---------|-------------|-----------|--------|--------|
| 1 | R1: Session-Block Constructive Packing | Rào cứng >=2 tiết/buổi ngay từ pha khởi tạo (`solve()`, `isSlotFeasible`, `opensUnaffordableSession`) | M1 | ORIGINAL_REQUEST §R1 | **VERIFIED** |
| 2 | R2: Min-Conflicts Escape Chains | Chuỗi đẩy đa tầng đệ quy thoát kẹt khả thi với Tabu list & Kempe chains | M2 | ORIGINAL_REQUEST §R2 | **VERIFIED** |
| 3 | R3: Deep Post-Optimization Pipeline | Tối ưu sâu đa tầng (`tryPairClassSingletons`, `tryCrossDayPairShift`, `tryTargetedIntraClassSingletonCrusher`) đưa `soBuoiDay1 -> 0` | M3 | ORIGINAL_REQUEST §R3 | **VERIFIED** |
| 4 | R4: Invariant Preservation | Bảo toàn 100% unassigned=0 (2202/2202), student holes=0, soBuoiTrong2=0, fixed/off cells (-3, -2) | M4 | ORIGINAL_REQUEST §R4 | **VERIFIED** |
| 5 | Live Benchmark Verification | Kiểm định trường THCS Mặc Định (75 lớp / 2202 tiết) & các thầy cô T.Chung, V.Quỳnh, PHT.Định | M5 | ORIGINAL_REQUEST §Acceptance | **VERIFIED** |
| 6 | E2E Regression & Stress Suites | Toàn bộ 6 test suites đạt 100% (153/153 pass) | M5 | ORIGINAL_REQUEST §Acceptance | **VERIFIED** |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | M1: Constructive Invariant Packing | Session-Block packing and feasibility bounds in `solve()` | None | **DONE** |
| 2 | M2: Min-Conflicts Ejection Chains | Recursive ejection, Tabu memory, Kempe chains | M1 | **DONE** |
| 3 | M3: Multi-Operator Post-Optimization | 14 post-opt operators & `runUntilZeroSingletons` loop | M2 | **DONE** |
| 4 | M4: Invariant Compaction & ACID Guarding | Student hole elimination & strict cell protection | M3 | **DONE** |
| 5 | M5: Verification & Forensic Integrity Gate | 6 E2E test suites pass, live school pass, adversarial audit | M1, M2, M3, M4 | **DONE** |

## Interface Contracts
### `FetTimetableEngine` ↔ `tkb-fet-worker`
- `engine.initFromData(data)`: Prepares class and teacher matrices, computes domains, initializes immutable constraints.
- `engine.solve()`: Runs constructive MRV CSP search with Session-Block packing.
- `engine.runUntilZeroSingletons(options)`: Executes deep multi-pass optimization pipeline until `soBuoiDay1 === 0`.
- `engine.evaluateMetrics()`: Returns `{ unplacedCount, soBuoiDay1, soNgayMotTiet, soBuoiTrong2, ... }`.
- `countTotalStudentHoles(data, lopData)`: Returns integer count of internal student session holes (must be 0).
