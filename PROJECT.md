# Project: TKBCherry Targeted Intra-Class Singleton Crusher & Deep Compute Budget

## Architecture
- **Client-Side Core Engine**: `web/pages/tkb-fet-engine.js` (and mirrored `web/tkb-fet-engine.js`)
  - Activity MRV sorting & domain computation (`computeDifficultiesAndSort`)
  - Min-conflicts recursive `randomSwap` (depth $\le 16$, call budget $\ge 2,000$, Tabu map)
  - FET Session Counting Invariant guard (`opensUnaffordableSession`)
  - Targeted Intra-Class Singleton Crusher (`tryTargetedIntraClassSingletonCrusher`)
  - Multi-tier recursive push displacement chain (`trySingletonEjectionChains`)
  - 4-Stage Lexicographic Local Search (`optimize` / `optimizeAll`) with deep compute budgets (`deepCycles`)
- **Background Worker & UI Telemetry**: `web/pages/tkb-fet-worker.js` / `web/tkb-fet-worker.js` and `web/pages/phanmon.js`
  - Multi-attempt solve execution and non-blocking real-time progress streaming
  - 250ms snapshot sampling (`getRetainedOptimizationSnapshotTKB`)
  - Hard constraint candidate validator (`validateFetCandidateHardConstraints` via `inspectTrueHardConflicts`)
- **Core Invariants Protected**:
  1. Complete Placement Invariant: `unplacedCount === 0` (100% placed, 2,202 / 2,202 periods).
  2. Student Session Contiguity Invariant: `countTotalStudentHoles() === 0` (zero internal holes for classes).
  3. Teacher Gap-2 Invariant: `soBuoiTrong2 === 0` (zero 2-period internal gaps for teachers).
  4. Fixed & Off Cell Invariant: Locked cells (`-3`) and off cells (`-2`) remain 100% immutable.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F1 | Targeted Intra-Class Singleton Crusher | Implement `tryTargetedIntraClassSingletonCrusher` algorithm: for teacher $T$ with singleton session $S1$ in class $C$, inspect target session $S2$, perform direct intra-class swap or multi-tier recursive `randomSwap` to evacuate obstacles and crush $S1 \to 0$ | M1 | ORIGINAL_REQUEST §R1 |
| F2 | Singleton Ejection Chains Fix & Enhancement | Fix session classification in `trySingletonEjectionChains` so singleton-only teachers (e.g. PHT.Định) are paired and consolidated into $\ge 2$-period sessions | M1 | ORIGINAL_REQUEST §R1 |
| F3 | Deep Compute Budget & Multi-tier Cycles | Expand `deepCycles` in `optimize('optimize_singletons')` and `optimizeAll()`, expand Tabu jump limits and recursive search budget without memory leaks or stack overflow | M2 | ORIGINAL_REQUEST §R2 |
| F4 | Real-time Worker Telemetry & Responsiveness | Ensure Web Worker event loop yielding ($\le 16\text{ms}$), anti-freeze streaming, and instant responsive cancellation | M2 | ORIGINAL_REQUEST §R2 |
| F5 | Full School Benchmark & Zero-Singleton Verification | Validate `scratch/live_school_default.json` (75 classes, 2,202 periods) achieving `unplacedCount = 0`, `soBuoiTrong2 = 0`, `studentHoles = 0`, `soBuoiDay1 = 0` (including PHT.Định with 4 periods HĐTN 3) | M3 | ORIGINAL_REQUEST §Acceptance Criteria |
| F6 | Automated Test Suites Green Gate | Pass 100% of tests in `augmented_singleton_e2e.test.js`, `tkb_fet_engine_node.test.js`, `tkb_fet_benchmark_node.test.js`, `adversarial_ui_worker_stress_node.test.js`, and `planner_subject_limit_semantics_node.test.js` | M3 | ORIGINAL_REQUEST §Acceptance Criteria |
| F7 | Documentation & Code Parity | Update `docs/PROJECT_HANDOFF.md` per AGENTS.md, maintain bitwise SHA-256 parity between `web/pages/` and `web/` | M3 | AGENTS.md & User Request |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Targeted Intra-Class Singleton Crusher Implementation | Implement `tryTargetedIntraClassSingletonCrusher`, enhance `trySingletonEjectionChains`, integrate into `optimize()` pipeline | Survey | DONE |
| M2 | Deep Compute Budget & Parameter Tuning | Expand `deepCycles`, Tabu jump limits, call limits, and optimize local search iteration depth | M1 | DONE |
| M3 | Full Integration, Verification & Documentation | Execute all 5 automated test suites, verify live school 2,202-period benchmark, maintain `docs/PROJECT_HANDOFF.md`, verify SHA-256 parity | M2 | DONE |

## Interface Contracts
### `tryTargetedIntraClassSingletonCrusher(bestMetrics, onProgress)`
- Input: `bestMetrics` (Metric snapshot), `onProgress` (callback)
- Output: `bestMetrics` object if improved, or `null` if no improvement
- Behavior: Strictly targets teachers with $k=1$ sessions. Explores all destination sessions $S2 \neq S1$ where $T$ has available capacity. Performs direct intra-class swap $A \leftrightarrow B$ within class $C$ if feasible, or executes `randomSwap(B.id, 0)` with Tabu memory and recursion depth $\le 16$ to relocate occupant $B$. Rolls back state on failure or if student holes occur.

### `trySingletonEjectionChains(bestMetrics, onProgress)`
- Input: `bestMetrics` (Metric snapshot), `onProgress` (callback)
- Output: `bestMetrics` object if improved, or `null` if no improvement
- Behavior: Evaluates all sessions $S2$ with $k \ge 1$ as targets for merging singletons. Displaces donors of any duration via `randomSwap(occAct.id, 0)` with Tabu memory.

### `optimize(mode, onProgress)`
- Input: `mode` (e.g. `"optimize_singletons"`, `"optimize_all"`), `onProgress` (callback)
- Output: `Promise<boolean>` (`true` if schedule was improved)
- Behavior: Runs deep compute cycles with `deepCycles`, executing the full singleton crusher pipeline while yielding to event loop every 16ms.

## Code Layout
- `web/pages/tkb-fet-engine.js`: Primary engine implementation
- `web/tkb-fet-engine.js`: Mirrored production engine (byte-identical)
- `web/pages/tkb-fet-worker.js`: Web worker handler
- `web/tkb-fet-worker.js`: Mirrored worker (byte-identical)
- `web/pages/phanmon.js`: Frontend UI glue & validator
- `web/phanmon.js`: Mirrored frontend validator (byte-identical)
- `e2e_tests/`: E2E test suites
- `docs/PROJECT_HANDOFF.md`: Project handoff and audit documentation
