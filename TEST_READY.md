# E2E Test Suite Ready

## Test Runner
- Command: `python run_e2e_tests.py`
- Expected: all tests pass with exit code 0 (once SQLite auth endpoints are implemented)

## Coverage Summary
| Tier | Count | Description |
|------|------:|-------------|
| 1. Feature Coverage | 16 | User signup, duplicate checks, login, token validation, user listing filters |
| 2. Boundary & Corner | 15 | Health, version, sample data, exports (empty/valid), precheck (valid/invalid), invalid routes |
| 3. Cross-Feature | 5 | Fast solve, solver timeouts (422 and best-effort), solver cancellation, concurrency limits |
| 4. Real-World Application | 5 | End-to-end workflows including login, solve, export, timeout recovery, and parallel solves |
| **Total** | **41** | |

## Feature Checklist
| Feature | Tier 1 | Tier 2 | Tier 3 | Tier 4 |
|---------|:------:|:------:|:------:|:------:|
| Account SQLite Sync | 16 | 0 | ✓ | ✓ |
| Solver Timeout/Best-effort | 0 | 15 | ✓ | ✓ |
| UI 'Dùng' Button Fix | 0 | 0 | ✓ | ✓ |
