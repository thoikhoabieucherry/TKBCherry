# E2E Test Infra: Zero Singletons, Cross-Day Pair Shifts & Multi-Pass Deep Search Optimization

## Test Philosophy
- **Requirement-Driven & Opaque-Box**: All test cases strictly map to requirements in `ORIGINAL_REQUEST.md` (§R1, §R2, §R3) and `PROJECT.md` (§Architecture, §Interface Contracts).
- **Systematic 4-Tier Coverage Hierarchy**:
  - **Tier 1 (Feature Coverage)**: Unit & integration testing of core algorithmic operators (`tryCrossDayPairShift`, `tryPairClassSingletons`, `runUntilZeroSingletons`, `runUntilStagnation`).
  - **Tier 2 (Boundary & Corner Cases)**: Edge conditions, structural floors ($W_T=1$), prime workloads (3, 5, 7, 11, 13, 17, 19), asymmetric shift splits, dense fixed cells (`-3`), and OFF cells (`-2`).
  - **Tier 3 (Cross-Feature Combinations)**: Multi-operator interactions, student contiguity preservation, gap-2 preservation, non-blocking cooperative yielding ($<65$ms), and Tabu memory isolation.
  - **Tier 4 (Real-World Benchmark Workloads)**: End-to-end full-scale validation on production school datasets (`live_school_default.json`, `dongkhoi_1566.json`, `default_school_0317.json`).

---

## Feature Inventory & Tier Coverage Matrix

| # | Feature / Algorithmic Operator | Source Specification | Tier 1 (Coverage) | Tier 2 (Boundary) | Tier 3 (Cross-Feature) | Tier 4 (Workload) |
|---|--------------------------------|----------------------|:-----------------:|:-----------------:|:----------------------:|:-----------------:|
| 1 | `tryCrossDayPairShift` (Cross-Day Block Relocation) | ORIGINAL_REQUEST §R1 | $\ge 5$ cases | $\ge 5$ cases | ✓ | ✓ |
| 2 | Enhanced `tryPairClassSingletons` (Intra-Class Singleton Pairing) | ORIGINAL_REQUEST §R1 | $\ge 5$ cases | $\ge 5$ cases | ✓ | ✓ |
| 3 | `runUntilZeroSingletons` (Multi-Pass Iterative Deep Loop) | ORIGINAL_REQUEST §R2 | $\ge 5$ cases | $\ge 5$ cases | ✓ | ✓ |
| 4 | `runUntilStagnation` & ILS Perturbation Kick | ORIGINAL_REQUEST §R2 | $\ge 5$ cases | $\ge 5$ cases | ✓ | ✓ |
| 5 | Non-blocking Cooperative Yielding ($<65$ms UI Latency) | PROJECT.md §M2 | $\ge 5$ cases | $\ge 5$ cases | ✓ | ✓ |
| 6 | Strict Hard Invariants (100% placed, gap2=0, holes=0, fixed/off intact) | ORIGINAL_REQUEST §R3 | $\ge 5$ cases | $\ge 5$ cases | ✓ | ✓ |
| 7 | Teacher T.Chung Resolution (Saturday $\ge 2$t) & School Zero Singletons | ORIGINAL_REQUEST §AC | $\ge 5$ cases | $\ge 5$ cases | ✓ | ✓ |

---

## Test Architecture & Execution Engine

### Execution Sandbox & Test Runner
- **Runner Framework**: Node.js Standard Test Runner (`node --test`) with Strict Assertions (`node:assert/strict`).
- **VM Engine Loader**: Sandboxed execution of `web/pages/tkb-fet-engine.js` via Node.js `vm.createContext` providing native typed arrays (`Int32Array`, `Int8Array`), global timers, and Web Worker mock interfaces.
- **Transactional Snapshot Verification**: Full state integrity verification before and after operator execution (`captureStateSnapshot()` / `restoreStateSnapshot()`).

### Test Suites in Scope
1. **Primary Feature Suite**:
   - `e2e_tests/zero_singleton_cross_day_e2e.test.js`: Dedicated 4-Tier test suite covering all cross-day shifts, deep iterative loops, boundary cases, and real-world school benchmarks.
2. **Regression & Hardening Suites**:
   - `e2e_tests/augmented_singleton_e2e.test.js`: 40-test singleton invariant and session counting suite.
   - `e2e_tests/tkb_fet_engine_node.test.js`: 33-test core FET engine semantics and preflight suite.
   - `e2e_tests/tkb_fet_benchmark_node.test.js`: 3-test solver benchmark and telemetry suite.
   - `e2e_tests/adversarial_ui_worker_stress_node.test.js`: 11-test UI/worker stress, interruption, and stopwatch suite.
   - `e2e_tests/planner_subject_limit_semantics_node.test.js`: 30-test planner constraints and subject limits suite.

---

## Real-World Application Workloads (Tier 4)

| # | Benchmark Dataset | Scale / Complexity | Features Tested | Target Acceptance Criteria |
|---|-------------------|--------------------|-----------------|-----------------------------|
| 1 | **THCS Mặc Định** (`scratch/live_school_default.json`) | 75 classes, 129 teachers, 1,650 activities, 2,202 slots | F1–F7 | `unplacedCount = 0` (2,202/2,202 placed 100%), `soBuoiDay1 = 0`, Teacher T.Chung `soBuoiDay1 = 0` (Saturday $\ge 2$t), `soBuoiTrong2 = 0`, `studentHoles = 0`. |
| 2 | **THCS Đồng Khởi** (`scratch/dongkhoi_1566.json`) | 54 classes, 108 teachers, 1,080 activities, 1,566 slots | F1–F6 | `unplacedCount = 0`, `soBuoiDay1 = 0`, `soBuoiTrong2 = 0`, `studentHoles = 0`, fixed/off cells 100% intact. |
| 3 | **THCS Phân Ca** (`scratch/default_school_0317.json`) | 75 classes, 125 teachers, 1,500 activities, 2,193 slots | F1, F5, F6 | Mathematical shift-isolated floor verification; `unplacedCount = 0`, `soBuoiTrong2 = 0`, `studentHoles = 0`. |

---

## Verification Commands

```powershell
# 1. Primary Feature Test Suite (Tiers 1–4)
node --test e2e_tests/zero_singleton_cross_day_e2e.test.js

# 2. Regression & Invariant Test Suites
node --test e2e_tests/augmented_singleton_e2e.test.js
node --test e2e_tests/tkb_fet_engine_node.test.js
node e2e_tests/tkb_fet_benchmark_node.test.js
node e2e_tests/adversarial_ui_worker_stress_node.test.js
node --test e2e_tests/planner_subject_limit_semantics_node.test.js
```
