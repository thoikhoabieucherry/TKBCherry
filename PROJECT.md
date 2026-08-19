# Project: TKBCherryANTIFET

## Architecture
TKBCherryANTIFET is a high-performance, 100% client-side automated timetable scheduling system for Vietnamese secondary and high schools. It eliminates all backend solver dependencies (Python CP-SAT, Cloud Run, VPS endpoints) in favor of an optimized, Web Worker-driven JavaScript solver based on FET C++ v7.9.5 core algorithms.

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
  ├── Step 2: Min-Conflicts Recursive RandomSwap + Tabu <= 16 (generate.cpp)
  ├── Step 3: FET Counting Invariant (ConstraintMinHoursDaily)
  └── Step 4: Closed Push-Cycles & Gap Crusher (Eliminate Singletons -> soBuoiDay1 = 0)
```

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Remove Legacy CP-SAT Links | Remove `tkb-rust-bridge.js` script tag, polling `/api/solver-state`, and legacy solve API callers | M1 | ORIGINAL_REQUEST R1 |
| 2 | Clean `phanmon.js` Hybrid Branches | Eliminate `useHybridOptimization`, `#hybridFailureChoice` modal, dead greedy placers, and dead routing stubs | M1 | ORIGINAL_REQUEST R1 |
| 3 | Local Web Worker Play ▶ / Stop ■ | Ensure Play ▶ starts `tkb-fet-worker.js` locally and Stop ■ cancels worker cleanly without network | M1 | ORIGINAL_REQUEST R1 |
| 4 | MRV Activity Difficulty Ordering | Sort activities by constraint pressure (duration, teacher load, room contention, unavailable slots) | M2 | ORIGINAL_REQUEST R2 |
| 5 | Min-Conflicts Recursive RandomSwap | Implement FET C++ `randomSwap` with CLR permutation, `_minWrong`/`_minIndexAct`, Tabu queue <= 16 | M2 | ORIGINAL_REQUEST R2 |
| 6 | FET Counting Invariant Daily Hours | Enforce `ConstraintMinHoursDaily` counting bounds ($\sum \max(\text{minDaily}, H_d) \le \text{total}$) | M2 | ORIGINAL_REQUEST R2 |
| 7 | Closed Push-Cycles & Gap Crusher | Eliminate singletons via length 3–7 DFS push cycles to achieve `soBuoiDay1 = 0` | M2 | ORIGINAL_REQUEST R2 |
| 8 | Multi-Seed Worker Construction | Web Worker multi-seed solve with streaming checkpoints and throttling | M2 | ORIGINAL_REQUEST R2 |
| 9 | Drag-and-Drop Schedule Editing | Interactive cell drag/drop with validation and debounced storage (`saveStoreDeferred`) | M3 | ORIGINAL_REQUEST R3 |
| 10 | Fixed (-3) and Off (-2) Constraints | Support fixed/locked periods (-3) and forbidden/off periods (-2) across teacher/class/room/subject | M3 | ORIGINAL_REQUEST R3 |
| 11 | Shift (`lop.ca`) Rules | Morning ("sang") and Afternoon ("chieu") partition constraints | M3 | ORIGINAL_REQUEST R3 |
| 12 | Campus Mobility Constraints | Enforce 1 campus per half-day and max 1 campus movement between morning/afternoon | M3 | ORIGINAL_REQUEST R3 |
| 13 | UI Progress, Timer & Live Stats | Live progress bar, stopwatch execution timer, live metrics popover, and teacher stats | M3 | ORIGINAL_REQUEST R3 |
| 14 | Automated Benchmark Test Runner | `node e2e_tests/tkb_fet_benchmark_node.test.js` passes 100% (3/3) | M4 | ORIGINAL_REQUEST R4 |
| 15 | Dong Khoi Benchmark Target | 54 classes / 1566 periods: 100% placed (1080/1080) in < 200 ms, `soBuoiDay1 = 0` | M4 | ORIGINAL_REQUEST R4 |
| 16 | Default School Benchmark Target | 75 classes / 2193 periods: 100% placed (1500/1500) in < 300 ms, `soBuoiDay1 = 0` | M4 | ORIGINAL_REQUEST R4 |
| 17 | Zero CP-SAT Network Isolation | Zero network requests to `/api/solve*` or Cloud Run on solve | M4 | ORIGINAL_REQUEST R4 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Legacy Solver Residue Cleanup | Remove `tkb-rust-bridge.js`, clean `phanmon.js` hybrid/solver branches, wire 100% local Web Worker Play/Stop | None | DONE |
| M2 | FET C++ v7.9.5 Engine Integration | Implement MRV ordering, Min-Conflicts RandomSwap, Counting Invariant, and Closed Push-Cycles in `tkb-fet-engine.js` & `tkb-fet-worker.js` | None | DONE |
| M3 | UI Integrity & Constraints | Validate Drag-Drop, Fixed (-3) / Off (-2), Shift (`lop.ca`), Campus mobility, Progress Bar, Timer, Live Stats | M1, M2 | DONE |
| M4 | E2E Testing & Benchmark Pass | Pass `tkb_fet_benchmark_node.test.js` (3/3), Dong Khoi < 200 ms with `soBuoiDay1 = 0`, Default School < 300 ms with `soBuoiDay1 = 0`, Zero CP-SAT Network Calls | M1, M2, M3 | DONE |

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
      "placed": 1080,
      "total": 1080,
      "elapsedMs": 120,
      "stage": "optimize_singletons",
      "metrics": { "soBuoiDay1": 0, "soNgayMotTiet": 0, "soBuoiTrong2": 12, "tsBuoiDay": 611 },
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
    "metrics": { "soBuoiDay1": 0, "soNgayMotTiet": 0, "soBuoiTrong2": 12, "tsBuoiDay": 611 },
    "durationMs": 190
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
- `scratch/dongkhoi_1566.json`: Dong Khoi High School test dataset (54 classes, 1566 periods).
- `scratch/default_school_0317.json`: Large comprehensive school test dataset (75 classes, 2193 periods).
