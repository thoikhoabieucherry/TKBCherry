# E2E Test Infra: TKBCherryANTIFET

## Test Philosophy
- Opaque-box, requirement-driven, zero external solver backend dependencies.
- Dual focus: Functional correctness (100% placed, constraints respected, UI responsive) + Extreme performance SLAs (< 200 ms and < 300 ms construction).

## Feature Inventory Coverage
| # | Feature | Source | Tier 1 | Tier 2 | Tier 3 | Tier 4 |
|---|---------|--------|:------:|:------:|:------:|:------:|
| 1 | Legacy Solver Removal | ORIGINAL_REQUEST R1 | 5 | 5 | ✓ | ✓ |
| 2 | Pure Web Worker Play/Stop | ORIGINAL_REQUEST R1 | 5 | 5 | ✓ | ✓ |
| 3 | MRV & RandomSwap Solver Engine | ORIGINAL_REQUEST R2 | 5 | 5 | ✓ | ✓ |
| 4 | Counting Invariant & Push-Cycles | ORIGINAL_REQUEST R2 | 5 | 5 | ✓ | ✓ |
| 5 | UI Integrity & Interactive Rules | ORIGINAL_REQUEST R3 | 5 | 5 | ✓ | ✓ |
| 6 | Benchmark SLAs & Singleton Crusher | ORIGINAL_REQUEST R4 | 5 | 5 | ✓ | ✓ |

## Test Architecture
- **Automated Node Test Suite**: `node --test e2e_tests/tkb_fet_benchmark_node.test.js`
- **Real Benchmark Datasets**:
  - `scratch/dongkhoi_1566.json`: 54 classes, 1566 periods, 1080 activities.
  - `scratch/default_school_0317.json`: 75 classes, 2193 periods, 1500 activities.
- **Pass Criteria**:
  - Benchmark test passes 100% (3/3).
  - Dong Khoi: 1080/1080 placed in < 200 ms, `soBuoiDay1 = 0`.
  - Default School: 1500/1500 placed in < 300 ms, `soBuoiDay1 = 0`.
  - Zero network requests to CP-SAT / Cloud Run / VPS.
