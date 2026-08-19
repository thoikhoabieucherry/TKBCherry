# Project: TKBCherryANTIFET

## Architecture
TKBCherryANTIFET is a high-performance, 100% client-side automated timetable scheduling system for Vietnamese secondary and high schools. It eliminates all backend solver dependencies in favor of an optimized, Web Worker-driven JavaScript solver based on FET C++ v7.9.5 core algorithms with deep recursive Min-Conflicts escape and Tabu memory.

### High-Level Data Flow:
```
[Browser UI: sapxep.html] (Play ▶ / Stop ■)
       │
       ▼
[Web Worker: tkb-fet-worker.js] ── (Progress Stream: % placed, time, metrics) ──▶ UI Progress Bar / Timer
       │
       ▼
[FET Engine: tkb-fet-engine.js]
  ├── Step 1: Preprocessing & MRV Activity Difficulty Ordering (generate_pre.cpp)
  ├── Step 2: Hard Constraint Enforcement (MaxGap <= 1, MinDaily >= 2 Invariant, gioihan <= 2)
  ├── Step 3: Min-Conflicts Deep Recursive RandomSwap + Persistent Tabu [5..12] + Vacancy Gap Guard
  ├── Step 4: Step-Budgeted Intra-Session Permutations & Bidirectional Singleton Merging (Non-blocking)
  └── Step 5: Lexicographic Local Search & Gap Crusher (Eliminate Singletons -> soBuoiDay1 <= 2, soBuoiTrong2 = 0)
```

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | MaxGapPerSession <= 1 Feasibility Guard | Enforce no gaps >= 2 in teacher sessions in `isSlotFeasible()` | M1 | ORIGINAL_REQUEST R1 |
| 2 | Ejection Vacancy Gap Guard in randomSwap | Reject/rollback ejections that leave intermediate gaps >= 2 in vacated teacher sessions | M1 | ORIGINAL_REQUEST R1 |
| 3 | MinDailyPeriods >= 2 Counting Invariant | Enforce daily counting invariant during initial construction in `opensUnaffordableSession()` | M1 | ORIGINAL_REQUEST R1 |
| 4 | Gioihan <= 2 & Contiguity in Session | Enforce max 2 periods/day for subject and strict contiguity when >= 2 periods in same session | M1 | ORIGINAL_REQUEST R1 |
| 5 | Worker Dispatcher Contract Alignment | Harmonize `tkb-fet-worker.js` message dispatcher with contract test suite (33/33 pass) | M1 | ORIGINAL_REQUEST Criteria |
| 6 | Persistent Multi-Step Tabu Tenure | Implement Tabu tenure T in [5, 12] and ILS kick perturbation in `randomSwap` | M2 | ORIGINAL_REQUEST R2 |
| 7 | Intra-Session Block Permutations | Implement session-level block permutations to untangle tight configurations | M2 | ORIGINAL_REQUEST R2 |
| 8 | Bidirectional Singleton Merging | Implement rich-to-single and single-to-rich activity relocation with bounded ejection | M2 | ORIGINAL_REQUEST R2 |
| 9 | Micro-Task Yielding (Non-blocking UI) | Implement step-budgeted yielding (`setTimeout(0)`) in worker to ensure smooth UI/timer | M2 | ORIGINAL_REQUEST R2 |
| 10 | 100% Placement on live_school_default | Place 2,175 / 2,175 periods (1,650 activities + 150 fixed) with unassigned = 0 | M3 | ORIGINAL_REQUEST R3 |
| 11 | Student Hole & Cell Lock Invariants | Preserve `Lỗ trống HS = 0`, Fixed (-3) and OFF (-2) protections across all runs | M3 | ORIGINAL_REQUEST R3 |
| 12 | Automated Benchmark & E2E Test Suite | Pass `tkb_fet_benchmark_node.test.js` (3/3), `tkb_fet_engine_node.test.js` (33/33), `adversarial_ui_worker_stress_node.test.js` (11/11) | M3 | ORIGINAL_REQUEST Criteria |
| 13 | Documentation & PROJECT_HANDOFF Update | Update `docs/PROJECT_HANDOFF.md` with current state, decisions, and verification | M3 | AGENTS.md / ORIGINAL_REQUEST |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Initial Hard Constraints & Feasibility Guards | Features 1, 2, 3, 4, 5: `isSlotFeasible`, `randomSwap` vacancy guard, `MinDaily` counting invariant, `gioihan` contiguity, worker dispatch alignment | None | DONE |
| M2 | Min-Conflicts Deep Escape & Non-blocking Permutations | Features 6, 7, 8, 9: Persistent Tabu, ILS perturbation, block permutations, singleton merging, micro-task yielding | M1 | DONE |
| M3 | Full School Benchmark, Invariant Pass & Handoff | Features 10, 11, 12, 13: 100% placement on `live_school_default.json` (2175 periods), 0 HS gaps, 100% test pass (3/3, 33/33, 11/11), `docs/PROJECT_HANDOFF.md` | M1, M2 | DONE |

## Interface Contracts
### `sapxep.html` / `phanmon.js` ↔ `tkb-fet-worker.js`
- **Post Message Request**:
  ```json
  {
    "action": "optimize",
    "mode": "optimize_all",
    "data": { "teachers": [...], "classes": [...], "subjects": [...], "tkb": {...}, "tkbConstraints": {...} },
    "options": { "timeBudgetMs": 10000, "seed": 101 }
  }
  ```
- **Progress Message**:
  ```json
  {
    "type": "progress",
    "checkpoint": {
      "placed": 1650,
      "total": 1650,
      "elapsedMs": 3500,
      "stage": "optimize_singletons",
      "metrics": { "soBuoiDay1": 0, "soNgayMotTiet": 0, "soBuoiTrong2": 0, "tsBuoiDay": 611 },
      "tkb": { ... }
    }
  }
  ```
- **Terminal Result Message**:
  ```json
  {
    "type": "done",
    "ok": true,
    "applied": true,
    "tkb": { ... },
    "metrics": { "soBuoiDay1": 0, "soNgayMotTiet": 0, "soBuoiTrong2": 0, "tsBuoiDay": 611 },
    "durationMs": 4200
  }
  ```

### `tkb-fet-engine.js` Class Interface
- `new FetTimetableEngine(data, options)`
- `engine.solve()` $\rightarrow$ `{ ok: boolean, placed: number, total: number, timeMs: number }`
- `engine.optimizeAll()` $\rightarrow$ `Promise<{ ok: boolean, metrics: Object, durationMs: number }>`
- `engine.evaluateMetrics()` $\rightarrow$ `{ soBuoiDay1: number, soNgayMotTiet: number, soBuoiTrong2: number, tsBuoiDay: number }`

## Code Layout
- `web/pages/sapxep.html`: Timetable interactive workbench UI (Play ▶, Stop ■, Progress bar, Stopwatch, Table grid, Modals).
- `web/pages/phanmon.js`: Core frontend controller, drag-drop handling, constraint synchronization, worker event bindings.
- `web/pages/tkb-fet-engine.js`: Pure mathematical FET C++ v7.9.5 timetable engine (MRV, Min-Conflicts RandomSwap, Invariant pruning, Push Cycles).
- `web/pages/tkb-fet-worker.js`: Background Web Worker orchestrator for non-blocking browser solving.
- `e2e_tests/tkb_fet_benchmark_node.test.js`: Deterministic automated benchmark test suite.
- `e2e_tests/tkb_fet_engine_node.test.js`: Engine contract test suite (33 tests).
- `e2e_tests/adversarial_ui_worker_stress_node.test.js`: Adversarial UI and worker stress test suite (11 tests).
- `scratch/dongkhoi_1566.json`: Dong Khoi High School test dataset (54 classes, 1566 periods).
- `scratch/live_school_default.json`: Large comprehensive school test dataset (75 classes, 2175 periods).
- `docs/PROJECT_HANDOFF.md`: Living handoff documentation.
