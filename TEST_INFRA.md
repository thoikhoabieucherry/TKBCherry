# E2E Test Infra: TKB DEMO Upgrade

## Test Philosophy
- Opaque-box, requirement-driven. No dependency on implementation design.
- Methodology: Category-Partition + BVA + Pairwise + Workload Testing.

## Feature Inventory
| # | Feature | Source (requirement) | Tier 1 | Tier 2 | Tier 3 |
|---|---------|---------------------|:------:|:------:|:------:|
| 1 | Account SQLite Sync | ORIGINAL_REQUEST §R1 | 16 | 0 | ✓ |
| 2 | Solver Timeout/Best-effort | ORIGINAL_REQUEST §R2 | 0 | 15 | ✓ |
| 3 | UI 'Dùng' Button Fix | ORIGINAL_REQUEST §R3 | 0 | 0 | ✓ |

## Test Architecture
- Test runner: `run_e2e_tests.py` at project root. It starts the server using `start.py` on port 1085, waits for it to become healthy, discovers and executes tests in `e2e_tests/test_suite.py`, and cleans up all processes when finished.
- Test case format: Python `unittest.TestCase` making HTTP requests to the backend server and asserting status codes and response JSON content.
- Directory layout:
  - `e2e_tests/test_suite.py` - Contains 41 test cases spanning Tiers 1-4.
  - `run_e2e_tests.py` - Main test runner.
  - `rust_server_e2e.log` - Local log generated during test runs.

## Real-World Application Scenarios (Tier 4)
| # | Scenario | Features Exercised | Complexity |
|---|----------|--------------------|------------|
| 1 | Full Lifecycle Success | Account, Solver, Export | High |
| 2 | Solver Timeout Recovery | Solver timeouts, UI state | Medium |
| 3 | Super Admin Audit | Account registration, listing | Medium |
| 4 | Invalid Data Rejection | Solver, precheck, validation | Medium |
| 5 | Parallel Compilation & Solve | Multi-user solver concurrency | High |

## Coverage Thresholds
- Tier 1: 16 test cases covering SQLite registration, login, token management, list users.
- Tier 2: 15 test cases covering standard endpoint responses, precheck warnings, exports, and invalid requests.
- Tier 3: 5 test cases covering fast solve, timeout response formats, solver cancellation, and concurrency limits.
- Tier 4: 5 realistic application scenario test cases exercising end-to-end user workflows.
