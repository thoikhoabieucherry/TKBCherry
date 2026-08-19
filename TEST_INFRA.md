# E2E Test Infra: TKBCherry Augmented Singleton & FET Invariant Testing

## Test Philosophy
- Requirement-driven, opaque-box testing against `ORIGINAL_REQUEST.md`.
- Systematic 4-tier coverage: Category-Partition + Boundary Value Analysis + Pairwise Combinations + Real-World Workload.

## Feature Inventory
| # | Feature | Source | Tier 1 (Coverage) | Tier 2 (Boundary) | Tier 3 (Cross-Feature) | Tier 4 (Workload) |
|---|---------|--------|:-----------------:|:-----------------:|:----------------------:|:-----------------:|
| 1 | 12-Session FET Counting Invariant (`opensUnaffordableSession`) | ORIGINAL_REQUEST §R3 | $\ge 5$ cases | $\ge 5$ cases | ✓ | ✓ |
| 2 | Invariant Enforced in Construction & Ejection | ORIGINAL_REQUEST §R3 | $\ge 5$ cases | $\ge 5$ cases | ✓ | ✓ |
| 3 | Unconstrained Displacement Chains (`randomSwap` depth $\le 16$, Tabu) | ORIGINAL_REQUEST §R2 | $\ge 5$ cases | $\ge 5$ cases | ✓ | ✓ |
| 4 | Lift Duration Constraints in Escape Operators (2-period donors) | ORIGINAL_REQUEST §R2 | $\ge 5$ cases | $\ge 5$ cases | ✓ | ✓ |
| 5 | Single-Period Teaching Elimination (`soBuoiDay1 -> 0`) | ORIGINAL_REQUEST §R1 | $\ge 5$ cases | $\ge 5$ cases | ✓ | ✓ |
| 6 | Hard Invariants Preservation (100% placed, gap2=0, studentHoles=0, fixed/off intact) | ORIGINAL_REQUEST §R4 | $\ge 5$ cases | $\ge 5$ cases | ✓ | ✓ |

## Test Architecture
- Framework: Node.js standard test runner (`node --test`)
- Test suites:
  - `e2e_tests/tkb_fet_engine_node.test.js`: Core engine unit and semantic tests
  - `e2e_tests/tkb_fet_benchmark_node.test.js`: Benchmark performance and metric asserts
  - `e2e_tests/adversarial_ui_worker_stress_node.test.js`: Worker stress & lifecycle tests
  - `e2e_tests/planner_subject_limit_semantics_node.test.js`: Planner semantics & subject limits
  - `e2e_tests/augmented_singleton_e2e.test.js`: Dedicated Tier 1-4 comprehensive suite
- Benchmark Workload:
  - `scratch/live_school_default.json`: 75 classes, 125 teachers, 1,650 activities, 2,202 slots.

## Real-World Application Scenarios (Tier 4)
| # | Scenario | Features Exercised | Complexity | Target Criterion |
|---|----------|--------------------|------------|------------------|
| 1 | Standard High School (75 classes / 2,202 slots) Full Solve & Optimize | F1-F6 | High | `unplacedCount = 0`, `soBuoiTrong2 = 0`, `studentHoles = 0`, `soBuoiDay1 <= 2` |
| 2 | Shift-Isolated Teacher (Mathematical 1-Period Floor) | F1, F5, F6 | Medium | Correctly identifies and permits exact math exception without infinite loop |
| 3 | Heavy Teacher Load Multi-Room Contention | F2, F3, F4 | High | Resolves ejection chains with 2-period donors under tight room constraints |
| 4 | Highly Constrained Teacher Off Days & Fixed Events | F3, F4, F6 | Medium | Preserves 100% fixed (-3) and off (-2) cells with zero gaps |
