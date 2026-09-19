# TKBCherry Agent Notes

Before changing or deploying this project, read `docs/CURRENT_STATE.md` first,
then the recent entries of `docs/PROJECT_HANDOFF.md`.

After any significant scheduler, UI-contract, test, infrastructure, or deployment
change, update `docs/PROJECT_HANDOFF.md` in the same work session. Keep current
behavior, important decisions, verification commands, deployment state, and open
investigations there. When architecture or workflow changes, also refresh
`docs/CURRENT_STATE.md` and `PROJECT_INHERITANCE_GUIDE.md` so they never drift
from the code (check `rust_api/Cargo.toml` and `.env.example` before describing
the stack).

Handoff archive policy: at the start of each month, move last month's entries
from `docs/PROJECT_HANDOFF.md` into `docs/archive/PROJECT_HANDOFF_<date-range>.md`
so the live file stays small enough to read in one pass.

Commit work to git and push to `origin` (GitHub) regularly — at least once per
work session. There is no GitHub test CI (the old workflow lived outside
`.github/workflows/` and never ran; removed 28/08/2026). Run `python run_tests.py`
before committing — it compares against `docs/test-baseline.json` and fails only
on NEW breakage. GitHub still runs `security.yml` (secret scan + CodeQL) and Dependabot.

Never store passwords, tokens, cookies, or bearer credentials in this repository.
VPS scripts read secrets from environment variables such as `TKB_VPS_PASSWORD`.
