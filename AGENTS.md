# TKBCherry Agent Notes

Before changing or deploying this project, read `docs/PROJECT_HANDOFF.md`.

After any significant scheduler, UI-contract, test, infrastructure, or deployment
change, update `docs/PROJECT_HANDOFF.md` in the same work session. Keep current
behavior, important decisions, verification commands, deployment state, and open
investigations there.

Never store passwords, tokens, cookies, or bearer credentials in this repository.
VPS scripts read secrets from environment variables such as `TKB_VPS_PASSWORD`.

