# Project: Zero Singletons & Cross-Day Pair Shift Optimization

## Architecture
- **Engine Core** (`web/pages/tkb-fet-engine.js`, `web/tkb-fet-engine.js`):
  - Client-side Web Worker FET C++ v7.9.5 port.
  - Activity generation with 4-period paired block normalization (`2 + 2`).
  - Min-Conflicts Recursive `randomSwap` with Tabu tenure, depth $\le 16$, adaptive limit calls ($2,000 \dots 3,500 \dots 5,000$).
  - Fast 32-entry bitmask LUTs (`SESSION_STATS_LUT`, `GAP_PENALTY_LUT`) for $O(1)$ metric and student hole evaluation.
  - Algorithmic Operators:
    - `tryPairClassSingletons`: Intra-class 1-period singleton pair merger to contiguous blocks $(p, p+1)$.
    - `tryCrossDayPairShift`: Cross-class, cross-day multi-period block shifting for multi-subject teachers (e.g. Teacher T.Chung 9A2 + 6A14).
    - `tryTargetedIntraClassSingletonCrusher`, `trySingletonEjectionChains`, `tryClosedPushCycles`, `tryCrushGaps`.
  - Multi-Pass Deep Search: `runUntilZeroSingletons` / `runUntilStagnation` with non-blocking cooperative yielding (`setTimeout(0)` every 16ms) and transactional snapshot rollback.
- **Worker & UI Telemetry** (`web/pages/tkb-fet-worker.js`, `web/tkb-fet-worker.js`):
  - Snapshot throttling (`SNAPSHOT_INTERVAL_MS = 250`), instant task cancellation (`isCancelled`), and live telemetry stream.
- **Strict Invariants**:
  1. `unplacedCount === 0` (100% placed).
  2. `countTotalStudentHoles() === 0` (100% student contiguity).
  3. `soBuoiTrong2 === 0` (0 gap-2 teacher sessions).
  4. 100% immutable locked/fixed cells (-3) and teacher/class off cells (-2).
  5. `soBuoiDay1 -> 0` (all teacher sessions $\ge 2$ periods or structural floor).

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | `tryCrossDayPairShift` Operator | Cross-day, cross-class block relocation for multi-subject teachers | M1 | ORIGINAL_REQUEST §R1 |
| 2 | Enhanced `tryPairClassSingletons` | Intra-class singleton pairing with multi-step recursive ejection chain | M1 | ORIGINAL_REQUEST §R1 |
| 3 | Transactional ACID Snapshot Rollback | Bit-for-bit state snapshot restore on blocked displacement or hole creation | M1 | ORIGINAL_REQUEST §R3 |
| 4 | `Run Until Zero Singletons` Multi-Pass Loop | Multi-pass deep iterative search loop until `soBuoiDay1 <= targetLowerBound` | M2 | ORIGINAL_REQUEST §R2 |
| 5 | Stagnation Detection & ILS Perturbation | Stagnation threshold detection (3 stagnant passes) + ILS perturbation kick | M2 | ORIGINAL_REQUEST §R2 |
| 6 | Non-blocking Cooperative Yielding | 16ms event loop yielding for 60 FPS UI responsiveness and instant cancellation | M2 | ORIGINAL_REQUEST §R2 |
| 7 | Teacher T.Chung Resolution | Specific resolution for T.Chung (Math 9A2 / Math 6A14) on Saturday $\ge 2$t | M3 | ORIGINAL_REQUEST §R1, AC |
| 8 | Whole-School Zero Singletons Pass | Verification of `soBuoiDay1 = 0` on `live_school_default.json` (75 classes / 2,202 slots) | M3 | ORIGINAL_REQUEST §AC |
| 9 | Invariant Hardening | Zero student holes, zero gap-2, 100% fixed cell preservation | M3 | ORIGINAL_REQUEST §R3 |
| 10 | E2E Test Suite (Tiers 1-4) | Comprehensive requirement-driven opaque-box test suite for cross-day & deep search | E2E_TRACK | ORIGINAL_REQUEST §AC |
| 11 | Phase 2 Adversarial Coverage Hardening | Tier 5 adversarial stress testing and coverage verification | FM | Project Pattern |
| 12 | Documentation & Handover | Update `docs/PROJECT_HANDOFF.md`, `docs/CURRENT_STATE.md` per AGENTS.md | FM | ORIGINAL_REQUEST §AC |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| E2E | E2E Testing Track | Design test runner and Tier 1-4 test cases; publish `TEST_READY.md` | none | DONE |
| 1 | Cross-Day Pair Shift & Enhanced Singleton Pairing | Implement `tryCrossDayPairShift` and enhance `tryPairClassSingletons` in engine | none | DONE |
| 2 | Multi-Pass Deep Search Optimizer Loop | Implement `runUntilZeroSingletons` / `runUntilStagnation` with cooperative yielding & worker telemetry | M1 | DONE |
| 3 | Target Invariant & Teacher T.Chung Resolution | Resolve T.Chung and achieve `soBuoiDay1 = 0` on `live_school_default.json` preserving all invariants | M1, M2 | DONE |
| 4 | Final Milestone & Adversarial Hardening | Pass 100% E2E test suite (Tiers 1-4), Tier 5 adversarial hardening, forensic audit clean verdict, documentation | E2E, M3 | DONE |

## Interface Contracts
### `FetTimetableEngine.prototype.tryCrossDayPairShift(bestMetrics, onProgress)`
- **Input**: `bestMetrics` (Object from `evaluateMetrics()`), `onProgress` (optional async callback).
- **Behavior**:
  - Scans scored teachers who have sessions with $k = 1$ active period on day $D_1$.
  - Scans other days $D_2 \neq D_1$ where teacher teaches a 1-period or 2-period activity block of class $C_2$.
  - Searches for valid contiguous slot placement $(s_1, s_1+d-1)$ in day $D_1$ session.
  - Checks if candidate slots contain movable occupant activities; unplaces them and invokes `randomSwap(occ.id, 0)` with Tabu memory and adaptive call limit (`limitCalls = this.getAdaptiveLimitCalls(2000, 3500)`).
  - Evaluates: `countTotalStudentHoles() === 0 && compareMetrics(m, currentBest, "optimize_singletons") < 0`.
  - Returns `true` if move accepted and improves metrics, `false` otherwise (with bit-for-bit snapshot restore on failure).

### `FetTimetableEngine.prototype.runUntilZeroSingletons(options)` / `runUntilStagnation(options)`
- **Input**:
  - `options.maxPasses` (default 15)
  - `options.stagnationThreshold` (default 3)
  - `options.timeBudgetMs` (default 35,000ms)
  - `options.onProgress` (async callback emitting `{ pass, maxPasses, metrics, stage }`)
- **Behavior**:
  - Executes multi-pass optimization cycles combining Stage 1 (`tryPairClassSingletons`, `tryCrossDayPairShift`, `tryTargetedIntraClassSingletonCrusher`, `trySingletonEjectionChains`, `tryClosedPushCycles`) and Stage 2 (`tryCrushGaps`).
  - Detects stagnation when `soBuoiDay1` does not improve across passes.
  - Applies ILS perturbation kick on stagnation pass 1.
  - Terminates when `soBuoiDay1 <= targetLowerBound`, `stagnantPasses >= stagnationThreshold`, or time budget expired.
  - Cooperatively yields to JS event loop every 16ms.

## Code Layout
- `web/pages/tkb-fet-engine.js`: Primary engine source code.
- `web/tkb-fet-engine.js`: Mirrored engine source code (MUST maintain 100% bitwise SHA-256 parity with `web/pages/tkb-fet-engine.js`).
- `web/pages/tkb-fet-worker.js`: Primary Web Worker handler.
- `web/tkb-fet-worker.js`: Mirrored Web Worker handler (MUST maintain 100% bitwise SHA-256 parity with `web/pages/tkb-fet-worker.js`).
- `e2e_tests/`: Opaque-box E2E test suites:
  - `e2e_tests/augmented_singleton_e2e.test.js`
  - `e2e_tests/tkb_fet_engine_node.test.js`
  - `e2e_tests/tkb_fet_benchmark_node.test.js`
  - `e2e_tests/adversarial_ui_worker_stress_node.test.js`
  - `e2e_tests/planner_subject_limit_semantics_node.test.js`
  - `e2e_tests/zero_singleton_cross_day_e2e.test.js` (new comprehensive suite for this feature set)
- `scratch/live_school_default.json`: Golden benchmark dataset (75 classes / 2,202 slots).
- `docs/PROJECT_HANDOFF.md`: Work session handoff logs.
- `docs/CURRENT_STATE.md`: Stack and product state summary.
