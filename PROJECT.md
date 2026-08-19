# Project: TKBCherry Augmented Singleton Escape Chains & FET Counting Invariants

## Architecture
- **Client-Side Core Engine**: `web/pages/tkb-fet-engine.js` (and mirrored `web/tkb-fet-engine.js`)
  - Activity MRV sorting & domain computation (`computeDifficultiesAndSort`)
  - Min-conflicts recursive `randomSwap` (depth $\le 16$, call budget 2,000, Tabu map)
  - FET Session Counting Invariant guard (`opensUnaffordableSession`)
  - 4-Stage Lexicographic Local Search (`optimize` / `optimizeAll`)
- **Background Worker & UI Telemetry**: `web/pages/tkb-fet-worker.js` / `web/tkb-fet-worker.js` and `web/pages/phanmon.js`
  - Multi-attempt solve execution and non-blocking real-time progress streaming
  - 250ms snapshot sampling (`getRetainedOptimizationSnapshotTKB`)
  - Hard constraint candidate validator (`validateFetCandidateHardConstraints`)
- **Core Invariants Protected**:
  1. Complete Placement Invariant: `unplacedCount === 0` (100% placed).
  2. Student Session Contiguity Invariant: `countTotalStudentHoles() === 0` (zero internal holes for classes).
  3. Teacher Gap-2 Invariant: `soBuoiTrong2 === 0` (zero 2-period internal gaps for teachers).
  4. Fixed & Off Cell Invariant: Locked cells (`-3`) and off cells (`-2`) remain 100% immutable.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F1 | 12-Session Counting Invariant Formula | Upgrade `opensUnaffordableSession` from 6-day aggregation to 12 half-day sessions ($M = \lfloor T / 2 \rfloor$) with remaining period deficit validation | M1 | ORIGINAL_REQUEST §R3 |
| F2 | Invariant Guard in Construction & Ejection | Enforce session counting invariant in `solve()` and `randomSwap` Phase 1 & 2 without blocking completion under high constraint density | M1 | ORIGINAL_REQUEST §R3 |
| F3 | Unconstrained Displacement Chains | Enable `trySingletonEjectionChains` to displace multi-period activities ($B.\text{duration} \ge 2$) via `randomSwap(B.id, 0)` with Tabu memory and recursion depth $\le 16$ | M2 | ORIGINAL_REQUEST §R2 |
| F4 | Lift Duration Constraints in Escape Operators | Remove restrictive `duration === 1` filters in `tryClosedPushCycles`, `tryShareRichToSingleton`, and Kempe swaps while preserving student contiguity | M2 | ORIGINAL_REQUEST §R2 |
| F5 | Single-Period Teaching Elimination | Drive `soBuoiDay1` and `soNgayMotTiet` to mathematical lower bound ($0$ for all teachers, $1$ for shift-isolated math exceptions like `tn.sương`) | M2 | ORIGINAL_REQUEST §R1 |
| F6 | 4-Tier Opaque-Box E2E Test Suite | Build comprehensive E2E tests (Tier 1 Feature, Tier 2 Boundary, Tier 3 Cross-Feature Combinations, Tier 4 Full School Benchmark) | E2E | ORIGINAL_REQUEST §Acceptance Criteria |
| F7 | Full School Acceptance & Benchmark Verification | Validate `scratch/live_school_default.json` (75 classes, 2,202 slots) achieving 100% placement, 0 gap-2, 0 student holes, and minimal `soBuoiDay1` | M3 | ORIGINAL_REQUEST §Acceptance Criteria |
| F8 | Documentation & Project Handoff Maintenance | Update `docs/PROJECT_HANDOFF.md` and related state docs per AGENTS.md | M3 | AGENTS.md & User Request |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| E2E | E2E Testing Suite & Benchmark Harness | Create 4-Tier test suite (Tiers 1-4) in `e2e_tests/` verifying counting invariant, unconstrained escape chains, and full school benchmark | none | DONE |
| M1 | FET Session Counting Invariant | Refactor `opensUnaffordableSession` to 12 sessions, integrate into `solve()` and `randomSwap`, verify initial construction quality | none | DONE |
| M2 | Augmented Singleton Escape Chains | Implement unconstrained displacement chains with multi-period ejection, Tabu memory, Kempe chains, and duration filter relaxation | M1 | DONE |
| M3 | Full Integration, Verification & Documentation | Verify all node test suites, E2E benchmarks on `live_school_default.json`, worker telemetry, and update `docs/PROJECT_HANDOFF.md` | M2, E2E | DONE |


## Interface Contracts
### `opensUnaffordableSession(act, slot)`
- Input: `act` (Activity object), `slot` (0..59 integer)
- Output: `boolean` (`true` if placing `act` at `slot` opens an unaffordable session, `false` otherwise)
- Behavior: Evaluates teacher's total periods $T$, active sessions count $S$, and checks if adding a session exceeds $\lfloor T / 2 \rfloor$ or if remaining unplaced periods are insufficient to bring all active sessions to $\ge 2$ periods.

### `trySingletonEjectionChains(tId, maxChains)`
- Input: `tId` (teacher index), `maxChains` (iteration limit)
- Output: `boolean` (`true` if a single-period session was eliminated, `false` otherwise)
- Behavior: Transactionally attempts to move singleton activity $A$ into target session of `tId`. If occupied by activity $B$ (of any duration 1..2), attempts `randomSwap(B.id, 0)` with Tabu memory and recursion depth $\le 16$. Rolls back state on failure.

### `evaluateMetrics()` & `compareMetrics(a, b)`
- Output object: `{ unplacedCount, soBuoiDay1, soNgayMotTiet, soBuoiTrong2, soBuoiTrong1, tsBuoiDay, totalGaps, studentHoles }`
- Strict Lexicographic Ordering: Hard Validity (`unplacedCount == 0`, `soBuoiTrong2 == 0`, `studentHoles == 0`) $\to$ `soBuoiDay1` $\to$ `soNgayMotTiet` $\to$ `tsBuoiDay` $\to$ `soBuoiTrong1`.

## Code Layout
- `web/pages/tkb-fet-engine.js`: Primary engine implementation
- `web/tkb-fet-engine.js`: Mirrored production engine
- `web/pages/tkb-fet-worker.js`: Web worker handler
- `web/tkb-fet-worker.js`: Mirrored worker
- `web/pages/phanmon.js`: Frontend UI glue & validator
- `e2e_tests/`: E2E test suites
- `docs/PROJECT_HANDOFF.md`: Project handoff and audit documentation
