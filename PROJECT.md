# Project: TKB DEMO Upgrade

> Current operational state, scheduler decisions, tests, and VPS deployment notes
> are maintained in `docs/PROJECT_HANDOFF.md`. Read that file first. The milestone
> table below is historical and may be stale.

## Architecture
- **Frontend**: A vanilla HTML/JS application (in the `web/` directory). Stores session state (previously LocalStorage) and triggers backend actions.
- **Backend (Rust)**: Actix-web/Axum API server (in the `rust_api/` directory) listening on HTTP. Responsible for handling user requests, database transactions, and triggering the scheduling solver.
- **Database**: SQLite database (to be integrated) managed by the Rust backend to persist user and school records.
- **Solver**: A Python-based scheduling runner (in the `solver_runtime/` directory) using OR-Tools CP-SAT and/or MILP models, called by the Rust backend.

## Code Layout
- `rust_api/src/main.rs`: Entry point and route handlers for Rust API.
- `rust_api/src/native_solver.rs`: Rust bridge invoking Python solver execution.
- `web/auth.js`: User signup/login logic.
- `web/school-portal.js` & `web/super-admin.js`: Business panels.
- `solver_runtime/src/tkb_new/adapter.py`: Python script routing optimization runs.
- `solver_runtime/src/tkb_optimizer_ref/`: CP-SAT and MILP model files.

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Exploration & Architecture | Investigate current auth, solver call flow, and UI crash bugs | None | DONE |
| 2 | SQLite Backend Integration | Implement SQLite connection, tables, and registration/auth endpoints in Rust | M1 | IN_PROGRESS |
| 3 | Frontend Auth SQLite Sync | Update frontend JS to use backend SQLite endpoints instead of LocalStorage | M2 | IN_PROGRESS |
| 4 | Solver Best-Effort Fixes | Update solver to return best-effort results on timeout and avoid hanging | M1 | IN_PROGRESS |
| 5 | UI 'Dùng' Button Fix | Resolve UI crash when using scheduler output, fix payload format | M1 | IN_PROGRESS |
| 6 | E2E Testing & Verification | Perform integrated manual and automated E2E tests, pass forensic audit | M3, M4, M5 | PLANNED |

## Interface Contracts
### Auth API (Backend ↔ Frontend)
- **POST `/api/register`** (or equivalent): Creates a new school/user account in SQLite.
- **POST `/api/login`** (or equivalent): Authenticates credentials against SQLite.
- **GET `/api/users`** (or equivalent, restricted to `suadmin`): Retrieves all registered users/schools.

### Solver Interface (Backend ↔ Python Solver)
- Rust spawns Python process running adapter/solver.
- Must propagate time-limit limits and read output JSON containing either optimal or best-effort schedule.
