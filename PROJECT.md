# Project: TKBCherry Class Singleton Pairing & 4-Period Subject Standardization

## Architecture
- **Engine Core**: Port of FET C++ in `web/pages/tkb-fet-engine.js` and `web/tkb-fet-engine.js` (100% SHA-256 byte parity).
- **Planner & Activity Generator**: `buildActivities()` decomposes curriculum requirements into discrete activities (`duration: 1`, `duration: 2`, etc.). Standardized to `2 + 2` paired blocks for 4-period subjects.
- **Optimization Pipeline**: Multi-pass local search with Min-Conflicts recursive `randomSwap`, ejection chains, Kempe swaps, and `tryPairClassSingletons` under strict lexicographic metric comparison.
- **Invariants**: 100% placement (2,202/2,202), 0 student gaps (`countTotalStudentHoles() === 0`), 0 teacher 2-period gaps (`soBuoiTrong2 === 0`), immutable fixed (-3) and OFF (-2) cells.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Standardize 4-Period Subjects (`2 + 2`) | Structure 4-period/week subjects (Văn, Toán, KHTN...) into `2 + 2` paired lesson blocks in `buildActivities()`, preventing `2 + 1 + 1` fragmentation | M1 | ORIGINAL_REQUEST §R2 |
| 2 | Class Singleton Pairing Operator (`tryPairClassSingletons`) | Implement `tryPairClassSingletons` to detect intra-class singletons across separate days, pair into contiguous (p, p+1) blocks, and evacuate obstacles via direct swap / `randomSwap` | M2 | ORIGINAL_REQUEST §R1 |
| 3 | Optimization Pipeline Integration | Integrate `tryPairClassSingletons` into `optimize("optimize_singletons")` & `optimize("optimize_all")` at top priority, fix target session classification in ejection chains | M2 | ORIGINAL_REQUEST §R1 |
| 4 | Verification on `live_school_default.json` | Verify `soBuoiDay1 -> 0`, Ms. V.Quỳnh Saturday freed (0 periods), `soBuoiTrong2 = 0`, `unplacedCount = 0`, `studentHoles = 0` on 75 classes / 2,202 periods | M3 | ORIGINAL_REQUEST §Acceptance Criteria |
| 5 | Regression & E2E Test Suite Validation | Run and verify 100% pass across all 5 test suites (117+ tests), Python solver tests, Rust check, and SHA-256 mirror parity | M3 | ORIGINAL_REQUEST §Acceptance Criteria |
| 6 | Documentation & Handoff Update | Update `docs/PROJECT_HANDOFF.md` per AGENTS.md requirements | M3 | ORIGINAL_REQUEST §5 & AGENTS.md |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | 4-Period Subject Standardization | Standardize 4-period subject activity generation to `2 + 2` paired blocks in `buildActivities()` | none | DONE |
| M2 | Engine Class Singleton Pairing Operator | Implement `tryPairClassSingletons` with obstacle displacement and integrate into `optimize()` | M1 | DONE |
| M3 | Comprehensive E2E Verification & Handoff | Verify all 5 test suites, `live_school_default.json` metrics, mirror parity, and update `docs/PROJECT_HANDOFF.md` | M2 | DONE |

## Interface Contracts
### Planner/Activity Generation ↔ Solver Engine
- `buildActivities(lop, mon, gv, needed, maxDaily, subRules)`:
  - For subjects with `needed >= 4` and `maxDaily >= 2`: decomposes into blocks of 2 (`duration: 2, mustKeepBlock: true, lessonBlockLen: 2`) when `lessonBlocks["2"].max !== 0`. Leftover $1$ period created only for odd `needed`.
- `tryPairClassSingletons(bestMetrics, onProgress)`:
  - Input: `bestMetrics` (Object), `onProgress` (Function).
  - Output: updated `bestMetrics` (Object) or `null`.
  - Invariant guarantee: `countTotalStudentHoles() === 0`, `soBuoiTrong2 <= initial.soBuoiTrong2`, `unplacedCount === 0`.

## Code Layout
- `web/pages/tkb-fet-engine.js`: Primary engine source.
- `web/tkb-fet-engine.js`: Mirrored engine source (100% identical SHA-256).
- `e2e_tests/augmented_singleton_e2e.test.js`: Core singleton E2E test suite (40 tests).
- `e2e_tests/tkb_fet_engine_node.test.js`: Core engine test suite (33 tests).
- `e2e_tests/tkb_fet_benchmark_node.test.js`: Benchmark telemetry test suite (3 tests).
- `e2e_tests/adversarial_ui_worker_stress_node.test.js`: Adversarial worker stress suite (11 tests).
- `e2e_tests/planner_subject_limit_semantics_node.test.js`: Subject limit semantics suite (30 tests).
- `e2e_tests/challenger_m3_singleton_pair_stress.test.js`: Adversarial class singleton pairing stress suite (18 tests).
- `scratch/live_school_default.json`: Live school fixture (75 classes, 2,202 periods).
- `docs/PROJECT_HANDOFF.md`: Project handoff and change log.
