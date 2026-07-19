# TKBCherry Project Handoff

Last updated: 2026-07-19 (Asia/Bangkok)

This is the persistent handoff note for future Codex sessions. Read this file
before modifying the scheduler or deploying. Update it after every meaningful
change so a machine restart or a new conversation does not erase project context.

## Release Versioning

- Current deployed application release: **v1.38** (incumbent refinement and
  resilient VPS fallback). Public health serves API marker
  `tkb_new-rust-api-2026-07-19-incumbent-refinement-v38` and the page serves
  cache marker `20260719-v138-incumbent-refinement-v1`.
- Current public Agent release: **v1.6.15** (`1.6.15`). The server lease gate
  must remain at 1.6.15 or newer so an older local Agent can update itself but
  cannot execute a job with a mismatched solver contract.
- Current local and deployed release: application **v1.38** and Agent
  **v1.6.15** (v1.34-style incumbent refinement, terminal-result recovery,
  animated progress dots, and bounded Agent preflight).
- Every deployed application or packaged Agent update must increment the
  applicable version here and add a short change note. Agent package updates
  must also update `agent_helper/__init__.py` and
   `agent_helper/windows_version_info.txt`.

### v1.34 - 2026-07-19 (deployed)

- iPhone foreground recovery now keeps exactly one durable reconnect attempt
  alive when `visibilitychange` or `pageshow` arrives while the suspended
  request is still unwinding. Concurrent foreground events share one
  single-flight state probe and attach to the existing canonical job ID.
- A resumed job is structurally read-only until its terminal payload is
  validated: it skips default-group synchronization, constraint-release, and
  OFF-lock mirroring regardless of caller settings. Reattach performs no new
  solve POST and no cancel; it polls the existing job, applies the result once,
  then clears the pending record.
- The iOS regression uses a visible flexible timetable that would lose lessons
  if pre-solve release ran. It fires both foreground events, verifies the
  timetable and mappings remain byte-identical before apply, and records one
  state GET, one result GET, zero solve POSTs, zero cancels, and one result
  application. Stop-suppression regressions also remain green.
- Protected frontier cleanup now continues through its reserved budget instead
  of stopping after two unsuccessful neighborhoods. Gap cleanup descends in
  reachable steps (`48 -> 46 -> 44 -> 42`) while the Pareto guard continues to
  reject any visible regression in teacher sessions or gap-1 sessions.
- Agent `1.6.14` is built, one-layer UPX packed, smoke-tested, and signed. Its
  packaged `default` benchmark finished `1566/1566` at `460` teacher sessions,
  `37` gap-1 sessions, zero one-period sessions, and zero gap-2-plus sessions.
  The one-entry ZIP is 91,681,899 bytes with SHA-256
  `96e79db5458ee68970051ab2e16f9e2a14d859dc871adc1c8c22846d6e50b52f`;
  the EXE is 92,147,596 bytes with SHA-256
  `d46ee0e4bb86bb7d7f8448f3e14d7b28441cbc06ed87de9c9f68c1cec9dded48`.
- Release verification passes scheduler `128/128` plus nine
  subtests, Agent `72/72` plus 25 subtests, and frontend/UI `232/232`.
  The final markers are cache `20260719-v134-ios-resume-frontier-v1`, bridge
  `tkb-rust-api-v238-ios-resume-frontier`, API
  `tkb_new-rust-api-2026-07-19-ios-resume-frontier-v34`, and planner
  `updated-v9.3 (v1.34 iOS resume + frontier cleanup)`.
- Production deployment returned `UPDATE_OK` after draining the solver. Transaction
  backups are `/opt/cherry-scheduler-backups/server-state-20260719-013522.tar.gz`
  and `/opt/cherry-scheduler-backups/app-release-20260719-013522.tar.gz`.
  Public health now reports the v34 API marker, zero active/queued jobs, and all
  `6/6` VPS worker tokens available. The public Agent manifest serves `1.6.14`
  and its independently downloaded ZIP size/hash match the signed manifest.
- Production VPS-only E2E stopped the local Agent, dismissed the Agent invitation
  with Cancel, started exactly one solve, then reloaded the scheduler while the
  VPS job was running (`45% / 28 giây`). The reloaded page continued the same
  canonical progress and finished with **Đã xếp xong!**, `Chưa phân:0`, and the
  selected `6/1` class complete at `29/29`. Post-run health remained `0` active,
  `0` queued, `6/6` available. The local Agent was then restored from 1.6.14 and
  starts as the normal parent/worker pair.
- A production mobile render at `440x956` (iPhone 16 Pro Max CSS size) keeps the
  reserved feedback row visible at `46px`, with `0% / Sẵn sàng` and no overflow;
  the timetable reaches the bottom edge.

### Fresh-fallback budget audit (included in v1.35)

- A staged-repair fallback is now explicitly bounded to the hidden fresh ceiling
  (`60` seconds for a blank duration, or the user's explicit duration). It no
  longer inherits the persisted `tkbManualFreshRetryBudget` value, which may
  have reached the `180`-second refinement ceiling after earlier failed clicks.
- The fallback marks its initial fast stage and ceiling before wire normalization;
  `effectiveSettingsForSolve` honors that marker, and
  `applySchedulingPressureTimeFloor` does not expand this second-half-of-click
  request back to the fixed-off pressure floor. The final wire fields therefore
  remain `overall/integrated/optimization = 60` and
  `backend/native_global_deadline_ms = 60,000` for blank input.
- Focused verification passes the new stale-budget and large fixed-off fallback
  regressions, the fallback/duration bridge subset (`17/17`), benchmark tooling
  (`6/6`), JavaScript syntax checks, and `git diff --check`; the changes are
  included in the v1.35 production package.

### iOS poll-only hardening (included in v1.35)

- Foreground recovery for queued, active, and completed owner jobs now enters a
  dedicated GET-only reattach lifecycle. It never calls the normal Play
  preflight/planner, never POSTs `/api/solve-data`, and never requests cancel.
  The visible timetable remains unchanged until the terminal response has
  passed fingerprint, response-shape, completeness/best-effort, hard-validity,
  and full UI apply validation.
- Applying a resumed result is transactional: the incumbent is snapshotted and
  restored if UI validation rejects the payload. The canonical pending row is
  marked settled only after a successful apply or a terminal rejection. A
  short in-memory reattach lease prevents the old suspended lifecycle from
  deleting that row while the foreground state probe or result apply owns it.
- A new race regression removes the pending localStorage row while the state
  GET is in flight. Reattach continues from its immutable job metadata, applies
  the retained VPS result exactly once, and records one state GET, one result
  GET, zero solve POSTs, and zero cancels. Repeated `visibilitychange` and
  `pageshow` events still share one state probe and one result application.
- Local bridge verification passes **167/167** with Node's explicit 10-second
  per-test timeout. The five focused iOS/race regressions pass **5/5**;
  JavaScript syntax and `git diff --check` also pass. These changes are now
  deployed as v1.35.

### v1.35 - 2026-07-19 (deployed)

- iOS `visibilitychange`/`pageshow` recovery now uses one immutable, GET-only
  reattach for the authenticated canonical VPS job. A suspended page never
  enters the normal Play/preflight path, never posts a second solve, and never
  cancels the server job merely because the phone was backgrounded.
- The reattach lease survives a late callback or another tab marking the local
  job settled and deleting its storage row. The server-owned state and retained
  result remain authoritative; the result is applied transactionally only after
  fingerprint, shape, completeness, hard-validity, and UI validation checks.
- Frontend/API markers are `20260719-v135-ios-poll-reattach-v1`,
  `tkb-rust-api-v239-ios-poll-reattach`, and
  `tkb_new-rust-api-2026-07-19-ios-poll-reattach-v35`.
- Verification before deployment: bridge **167/167**, planner/mobile UI
  **27/27**, five focused iOS/race tests **5/5**, staging scheduler **128/128**,
  Agent **72/72**, Rust API **136/136**, validator **20/20**, JavaScript syntax
  checks, and `git diff --check` all pass.
- Deployment returned `UPDATE_OK` at 2026-07-19 02:43 UTC. Transaction backups
  are `/opt/cherry-scheduler-backups/server-state-20260719-024306.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260719-024306.tar.gz`.
- Post-deploy health reports `ok:true`, `0` active/queued jobs, and `6/6`
  worker tokens available. The public page serves the v135 cache marker and the
  authenticated browser loaded the timetable with `Chưa phân:0` and no warning
  or error console entries. A destructive live solve was not started in this
  post-deploy check; the iOS background/resume contract is covered by the five
  focused production-shaped bridge regressions above.

### v1.38 incumbent refinement and VPS fallback (deployed)

- A complete, hard-valid timetable always enters the incumbent-safe refinement
  lane used by v1.34, with the normal 180-second ceiling. The v1.37 branch that
  discarded the flexible timetable and rebuilt from fixed lessons in a fresh
  60-second lane is disabled; that branch could return an unstable feasibility
  draft such as `522/119` before quality search ran.
- If a server-owned refinement reaches a terminal deadline without a better
  candidate, an iPhone reload/foreground reattach retains the complete
  incumbent and reports exactly **Đã xếp xong!** in green. A genuinely
  incomplete or hard-invalid result still stays warning/error.
- Sorting status animates `Đang sắp xếp.`, `Đang sắp xếp..`,
  `Đang sắp xếp...`; the timer stops at terminal state and the toolbar reserves
  stable width. A hung Agent status probe aborts after 2.5 seconds and falls
  through to VPS. Dismissing the offline-Agent prompt produces exactly one VPS
  solve POST.
- The Rust API minimum Agent lease version is now **1.6.15**. Agent 1.6.14 and
  older receive upgrade-only status and never receive a solver lease.
- Local verification: all Node E2E **247/247** (including bridge **176/176**,
  planner/UI **28/28**, and subject semantics **12/12**), solver Python
  **129/129**, JavaScript syntax, and `git diff --check`. Isolated VPS staging
  returned `STAGING_TESTS_OK`: solver
  **129/129**, Agent **72/72**, Rust API **136/136**, and validator **20/20**.
- Production deployment returned `UPDATE_OK`. Transaction backups are
  `/opt/cherry-scheduler-backups/server-state-20260719-045824.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260719-045824.tar.gz`. Post-deploy
  health was idle at `0` active, `0` queued, and `6/6` VPS worker tokens.
- Live no-Agent E2E dismissed the offline-Agent prompt with Cancel, submitted
  exactly one VPS job, and reloaded the tab during the run. The same job resumed
  from `35` to `38` seconds with Play still locked. It completed green at
  `1566/1566`, improving **522 teacher sessions / 100 gap-1** to **476 / 55**,
  with zero singleton and zero gap-2 sessions; VPS capacity returned to `6/6`.
- The installed Agent 1.6.14 was correctly invisible/ineligible under the new
  lease gate. Launching the packaged 1.6.15 replaced it in
  `C:\TKBCherryAgent`, after which the page reported one online Agent. The live
  Agent E2E used one local `--solver-child` while VPS stayed `0` active and
  `6/6` free, retained the Pareto-equal `476/55` incumbent, completed green,
  and removed the solver child afterward.
- Mobile production verification at `440x956` (iPhone 16 Pro Max CSS size)
  shows the full timetable to the bottom edge, exact green **Đã xếp xong!**,
  no `Cần tối ưu`, and a stable toolbar/status row.

### v1.37 quality-debt rebuild (deployed before v1.38)

- A complete but severely rough timetable now uses the user's requested
  fallback behavior on the next Play: rebuild from fixed lessons only in the
  bounded 60-second complete-first lane, while retaining the current complete
  timetable as an incumbent guard. A rebuilt candidate is applied only when
  the ordered quality vector improves; otherwise the old timetable remains
  byte-for-byte intact.
- The recovery threshold is data-sized and applies only to schedules with at
  least 300 expected periods. It triggers for any singleton/gap-2 debt or for a
  large excess above the practical teacher-session/gap-1 targets. The historical
  `default` 522-session/122-gap incumbent triggers; a practical 481/53 result
  continues through the normal 180-second soft-incumbent refinement lane.
- Wire normalization preserves `ui_keep_better_existing_on_resort=true` for
  this one no-hint rebuild mode. The normalized production-shaped request is
  `kind=refine_complete`, server kind `fresh_complete_first`, 60 seconds, with
  exactly 54 fixed cells, no old solver payload, and unchanged constraints/OFF
  maps.
- A six-worker local benchmark starting from 1,566/1,566 at 522 teacher sessions
  and 122 gap-1 sessions finished in 56.3 seconds at **481 teacher sessions / 47
  gap-1 sessions**, with zero singleton sessions, hard-valid completeness, and
  all fixed lessons preserved. A direct 180-second incumbent refinement also
  reproduced 522/122 -> 472/49, confirming the prior production no-change was a
  path/seed issue rather than an impossible timetable.
- Every complete hard-valid terminal path now hides the progress widget and
  shows exactly **Đã xếp xong!**. Quality debt remains in metrics and E2E
  metadata but no longer renders the contradictory `Cần tối ưu`/`Giữ lịch`
  label beside the success message. Incomplete, stopped, and failed results
  retain their visible warning/error progress.
- The v1.37 production health marker was observed with `0` active jobs,
  `0` queued jobs, and `6/6` worker tokens available. Its fixed-only quality
  lane is intentionally disabled by the deployed v1.38 release above.

### v1.36 large first-fresh quality stabilization (deployed)

- The production-equivalent `default` benchmark (54 fixed lessons,
  `1,566/1,566` required) reproduced the rough first result with browser seed
  `17`: **522 teacher sessions / 119 gap-1 sessions** in about 56.7 seconds.
  Its Phase Q did find a 482-session vector, but that vector was period
  infeasible; the remaining two- and one-second Benders retries could not
  replace it, so the valid 522-session feasibility draft was retained.
- Large (`expected >= 900`) empty-rebuild clicks now keep the browser seed for
  the mandatory feasibility phase and randomized local portfolio, but use the
  established deterministic default seed (`1`, request-overridable) for the
  strict Phase-Q probe. Complete-incumbent refinement still derives its
  portfolio from the click/round seed, so later optimization retains diversity.
- Exact post-change reference benchmarks stayed within the 60-second contract:
  seed `17` completed at **481/51** in 56.4 seconds and seed `18` at **482/47**
  in 56.5 seconds. Both were `1,566/1,566`, canonical hard-valid, with zero
  unassigned lessons, zero one-period teacher sessions, and zero gap-2-plus
  sessions. The deterministic baseline completed at **481/48** in 56.3 seconds.
- The independent `d8f7b12caf1` fixture with 108 fixed lessons also completed
  in 56.4 seconds at **482 teacher sessions / 42 gap-1 sessions**, with
  `1,566/1,566`, zero unassigned, zero singleton/gap-2 sessions, and zero
  application-constraint violations.
- The quality-debt rescue lane explicitly re-enables the CP-SAT session-quality
  objective after the mandatory feasibility-only probe. It may relax product
  quality debt when user requirements force that debt, but no longer inherits
  the objective-free mode that returned a needlessly rough 522-session result.
- Focused seed-policy regressions cover large stable Phase Q, unchanged
  small-school request seeding, and the rescue objective reset. Full scheduler
  discovery passes **129/129**.
- Production now serves the v1.36 web/API markers and was observed healthy with
  zero active/queued jobs and all six worker tokens available. Agent 1.6.15 was
  built locally but was not yet public at this checkpoint; production still
  served Agent 1.6.14.

### v1.33 - 2026-07-19 (deployed)

- Changed-requirement and staged-repair fallback requests now use the same
  bounded fresh-solve contract as a first click: a blank request is capped at
  the hidden 60-second ceiling, while an explicit user duration is preserved.
  Legacy `robust_retry`/`complete_schedule_seed_retry` flags and the old
  partial-repair ceiling are cleared before the fresh request is normalized.
  This prevents fixed-off schools from having the fallback silently expanded
  to 180 seconds by the scheduling-pressure floor.
- `tools/benchmark-unified-solver.js` now builds the fallback through the same
  bridge path as the browser. The fixed-off four-missing benchmark asserts the
  final wire budget is `60s / 60,000ms`, with no stale partial-repair flags.
- The persistent mobile progress row and concise terminal notice from the
  post-v1.32 audit remain in this candidate. Desktop keeps idle progress
  visually hidden; mobile keeps the row visible through idle, running, and
  terminal states.
- Local verification after the fallback fix: Rust bridge `160/160`, scheduler
  `127/127`, Agent `72/72`, benchmark `6/6`, toolbar `27/27`, PWA `4/4`, mobile
  actions `3/3`, subject semantics `12/12`, pair scroll `1/1`, app integrity
  `7/7`, auth persistence `6/6`, and super-admin UI `4/4`.
- A live production Agent smoke run on `default` used exactly one local
  solver-child while the VPS stayed at zero active jobs and `6/6` free tokens.
  It completed `1566/1566` with `458` teacher sessions, `38` gap-1 sessions,
  zero unassigned periods, zero gap-2 sessions, zero singleton sessions, and
  zero student holes. Public observation after deployment serves cache marker
  `20260719-v133-fresh-fallback-budget-v1`; the API binary retained the v1.32
  marker because v1.33 changed browser and benchmark contracts only.

### v1.32 - 2026-07-19 (deployed)

- Agent 1.6.13 fixes a Windows version-resource mismatch discovered during the
  final v1.31 release review. Agent 1.6.12 displayed `1.6.12`, but its numeric
  `FixedFileInfo` tuple still contained `1.6.11.0`. The new executable reports
  `1.6.13` and `1.6.13.0` consistently for file/product display and raw numeric
  versions. `build_windows.ps1` now rejects any future mismatch between the
  runtime semantic version, both fixed tuples, and both display strings; a
  packaging regression covers the same contract.
- Refinement is less dataset-specific. At a practical incumbent it probes the
  same cap, then `current - 3`; if that stronger cap is infeasible, a
  `current - 1` nearby fallback runs before further tightening or stagnation
  termination. A successful stronger probe still rebuilds the queue immediately,
  preserving the fast path measured on `default`. This lets schools with a
  narrower feasible boundary improve within the same click.
- A lower-session frontier no longer causes roughly 50 seconds to be left idle
  merely to preserve the cleanup tail. Global probes may use all time before a
  protected `30 + 2` second tail, including the target-cap path, and the final
  gap-directed LNS still receives the full 30-second budget. Completeness, hard
  requirements, fixed lessons, Pareto safety, zero singleton sessions, and zero
  gap-2-plus sessions remain protected.
- Local verification passes scheduler `127/127`, Agent `72/72`, frontend/UI
  `219/219`, and deployment/credential tooling `7/7` (`425/425` total).
  Isolated VPS staging ended with `STAGING_TESTS_OK`: scheduler `127/127`, Agent
  `72/72`, Rust API `136/136`, and candidate validator `20/20` (`355/355`
  total). GUI/solver-child smoke, UPX integrity, signed-manifest parsing, and
  one-entry ZIP validation also pass.
- The Agent release manifest is RSA-SHA256 signed and the executable is
  one-layer UPX packed. The public one-entry ZIP is 95,291,399 bytes with
  SHA-256
  `6141C23CB14B13423978AFFD8BCD576DFC53A184E72E588803785F18BB9F0FAA`;
  the EXE is 95,771,128 bytes with SHA-256
  `45331874DB4F38BE5787B05468D8096A8C5BBC51A51786E99BE49FDB47F2956D`.
  The EXE is not Authenticode-signed; integrity/authenticity is supplied by the
  signed release manifest, whose key is pinned in the Agent.
- Production deployment returned `UPDATE_OK`. Transaction backups are
  `/opt/cherry-scheduler-backups/server-state-20260718-212432.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260718-212432.tar.gz`. Public
  health serves API marker
  `tkb_new-rust-api-2026-07-19-agent-version-metadata-v32`; the page serves
  cache marker `20260719-v132-agent-version-metadata-v1`, bridge marker
  `tkb-rust-api-v236-agent-version-metadata`, and planner marker
  `updated-v9.1 (Agent 1.6.13 version metadata hotfix)`.
- The public Agent ZIP was downloaded independently after deployment and both
  its size and SHA-256 match the live signed manifest. The installed
  `C:\TKBCherryAgent\TKBCherryAgent.exe` was updated to 1.6.13, reports raw
  version `1.6.13.0`, starts the normal parent/worker pair, and is recognized by
  the browser as `Agent đang ON · 1 máy đang hỗ trợ`.
- Final production Agent E2E started from the already strong `460` teacher
  sessions / `39` gap-1 incumbent and improved it to **459/38**. The timetable
  remained complete at `1,566/1,566`, with zero unassigned periods, zero
  singleton teacher sessions, zero gap-2-plus sessions, and zero student holes.
  Exactly one Agent solver child owned the solve while VPS capacity stayed at
  6/6 free tokens; after completion the solver child exited and both server and
  Agent returned to their idle states.
- A repeat production Agent E2E on 2026-07-19 confirmed the already-saturated
  `459/38` incumbent is retained unchanged. The blank duration input used the
  hidden refinement policy, no Agent/VPS selection dialog appeared because one
  current Agent was already online, and exactly one local `--solver-child`
  owned the job while VPS stayed at zero jobs with all 6/6 tokens free. The UI
  finished at `1,566/1,566`, `459` teacher sessions, `38` gap-1 sessions, and
  zero singleton, gap-2-plus, or student-hole debt; the solver child then exited.
- All successful terminal UI paths now use the concise notice **Đã xếp xong!**,
  including quick local repairs, off-day restoration, and complete-incumbent
  rollback. Detailed repair/rollback context remains in the payload and E2E
  metadata rather than being repeated in the visible status line.

### Post-v1.32 mobile feedback audit (local, not deployed)

- The reserved mobile feedback row is now informative in every lifecycle
  state. It shows `0% / Sẵn sàng` while idle, switches immediately to
  `0% / Chuẩn bị` when Play is pressed, then advances to elapsed-time progress
  after the existing one-second measurement boundary. The first second is no
  longer a blank row.
- Complete, warning, and error progress states remain visible instead of being
  hidden by a 2.6/4.2/5.2-second timer. The exact successful status
  **Đã xếp xong!** is also exempt from the generic five-second status timeout;
  other transient toolbar notices still expire normally. Desktop keeps the
  idle progress element visually hidden through the existing base CSS, while
  mobile shows it inside the already-reserved 46/34-pixel feedback row.
- Focused local verification passes bridge `158/158` and mobile/PWA/toolbar/
  cell-action `34/34`. The bridge suite is invoked with Node's explicit
  `--test-timeout=10000` guard so a failed asynchronous test cannot leave the
  test runner waiting on a diagnostic interval. Production remains v1.32; no
  cache marker was bumped and this audit change has not been deployed.
- A local Chromium render check at iPhone 16 Pro Max CSS sizes `440x956` and
  `956x440` shows the idle progress row at 46/34 pixels and the complete notice
  fully visible. A `320x568` narrow-phone probe wraps the longer reconnect
  notice onto exactly two lines with `scrollHeight == clientHeight`, so the
  text is not clipped.

### v1.31 - 2026-07-19 (deployed)

- Complete-incumbent refinement no longer begins with the overly aggressive
  direct `466 -> 461` teacher-session cap. It now probes feasible nearby caps
  through the deterministic frontier contract `466/seed A -> 463/seed B ->
  462/seed C`. Seeds are consumed globally and are not reused after the
  frontier changes, so successive attempts explore new trajectories instead of
  replaying the same hint. Each Benders probe receives approximately 60
  seconds, and the default refinement budget reserves 30 seconds for
  gap-directed cleanup of the best lower-session frontier.
- Completeness, every hard requirement, fixed lessons, the exact lesson count,
  Pareto safety against the visible incumbent, zero one-period teacher
  sessions, and zero gap-2-plus teacher sessions remain protected. A candidate
  that lowers teaching sessions but cannot repair its gap-1 debt is never
  allowed to replace a better visible timetable.
- Exact local `default` benchmark from the production-equivalent complete
  `466` teacher sessions / `44` gap-1 incumbent, using six workers, completed
  in 171.826 seconds at **460 teacher sessions / 35 gap-1**. It retained
  `1,566/1,566`, zero unassigned periods, zero singleton teacher sessions, and
  zero gap-2-plus sessions.
- Production Agent E2E refined `466/44 -> 462/41`. Exactly one Agent executor
  owned the canonical job while the VPS remained at 6/6 free worker tokens;
  the result was complete and hard-valid with `1,566/1,566`, zero unassigned,
  zero singleton, and zero gap-2-plus sessions.
- Production VPS-only E2E stopped the Agent, pressed Play exactly once, and
  dismissed the Agent invitation with **Cancel** to choose VPS execution. The
  VPS showed one active canonical job using all 6/6 worker tokens and refined
  `462/41 -> 460/39`, again retaining `1,566/1,566`, zero unassigned, zero
  singleton, zero gap-2-plus, and hard validity. The final UI notification was
  exactly **Da xep xong!** (rendered in Vietnamese as **Đã xếp xong!**).
- Local release verification passes scheduler `126/126`, Agent `71/71`,
  frontend `219/219`, and tooling `7/7` (`423/423` total). Agent GUI smoke and
  solver-child smoke pass both before and after one-layer UPX packing. Isolated
  VPS staging ended with `STAGING_TESTS_OK`: scheduler `126/126`, Agent
  `71/71`, Rust API `136/136`, and candidate validator `20/20` (`353/353`
  total).
- Public Agent 1.6.12 used a signed release manifest and a UPX-packed EXE. The
  one-entry ZIP is
  95,291,488 bytes with SHA-256
  `C81A842837CCB26C28827F6044F08F9E6DB2250C84B445DCD60766220DFA1ECC`;
  `TKBCherryAgent.exe` is 95,771,256 bytes with SHA-256
  `49ED88F180E00F25705DC191655F1065DE170C52223DEBE08E44BC0436B21887`.
  The public signed manifest reports version `1.6.12`.
- Production deployment returned `UPDATE_OK`. Transaction backups are
  `/opt/cherry-scheduler-backups/server-state-20260718-203657.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260718-203657.tar.gz`. Public
  health serves API marker
  `tkb_new-rust-api-2026-07-19-balanced-refinement-v31`; the page serves cache
  marker `20260719-v131-balanced-refinement-v1`.
- Post-deploy operational verification restarted the installed
  `C:\TKBCherryAgent\TKBCherryAgent.exe --startup` copy and confirmed file/product
  version 1.6.12, one normal parent/worker pair, and the browser status
  `Agent đang ON · 1 máy đang hỗ trợ`. A further refinement started from the
  already strong `460/39` incumbent, created exactly one Agent solver child,
  left the VPS at 6/6 free worker tokens, and completed cleanly with the Pareto
  guard retaining `460/39`. The public ZIP was downloaded independently after
  deployment; its 95,291,488-byte size and SHA-256 match the signed manifest.
  Beyond this release, continue benchmarking diverse school data: search
  quality is intentionally saturation- and feasibility-driven rather than tied
  to the `default` dataset's observed `460/35` result.

### v1.30 - 2026-07-19 (deployed)

- Production Agent 1.6.10 received a complete-refinement job and returned the
  unchanged complete, hard-valid `466` teacher sessions / `44` gap-1 schedule
  after roughly three minutes. The browser, Rust dispatcher, Agent lease, and
  solver-child wire all retain the request. Python reconstructs the soft
  incumbent from the complete visible `data.tkb`, passes it into Benders, and
  CP-SAT applies it with `AddHint`; the plateau was not caused by a missing
  incumbent.
- The packaged 1.6.10 adapter predates the final equality case in the bounded
  staircase. At incumbent `466/44` with practical teacher target `466`, it
  queues caps `466, 466, 467`; two stagnant attempts can stop the refinement
  before any lower-session cap runs. The local source now queues cap `461`
  first, with the exact `466` incumbent as the Benders soft hint. If that
  candidate cannot also clear gap debt, the existing Pareto guard still returns
  the exact visible incumbent.
- Focused source regressions cover both the cap order and the end-to-end outer
  contract: `466/44 -> cap 461` receives an incumbent payload at `466` and may
  return `461/33`. The full solver-result contract suite passes `112/112` plus
  nine subtests; Python bytecode compilation and `git diff --check` also pass.
- Agent 1.6.11 is the first packaged runtime carrying this equality-case fix,
  so the server accepts 1.6.11+ as active workers and leaves older Agents in
  upgrade-only mode. Complete refinement requests six CPU workers, matching
  the VPS production-width lane. The protected adapter was loaded directly and
  verified to queue `461, 466, 466, 467`, not the stale 1.6.10 sequence.
- GUI smoke before and after UPX, solver-child smoke, one-layer UPX integrity,
  file/product version, and the signed manifest all pass. The public one-entry
  ZIP is 91,674,716 bytes with SHA-256
  `B4F0CAB37F43842ADEDF9C70DD49DABDF0645341ECE405F3505E438554217C52`;
  the EXE is 92,139,560 bytes with SHA-256
  `A2A7ACC47DB7610975389E86F643BD2759189FDFEA5E5680C6E890FF96B32A6A`.
- Final staging returned `STAGING_TESTS_OK`: scheduler `124/124`, Agent
  `71/71`, Rust API `136/136`, and candidate validator `20/20`. Local release
  verification passes scheduler `112/112`, Agent `71/71`, deployment and
  credential tooling `18/18`, frontend bridge/toolbar `182/182` across the
  final sources, JavaScript syntax checks, and `git diff --check`.
- Production deployment returned `UPDATE_OK`. Backups are
  `/opt/cherry-scheduler-backups/server-state-20260718-193908.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260718-193908.tar.gz`. Public
  health serves `tkb_new-rust-api-2026-07-19-frontier-staircase-v30`, zero
  active/queued VPS jobs, and 6/6 free worker tokens. The page serves cache key
  `20260719-v130-frontier-staircase-v1`, bridge marker
  `tkb-rust-api-v234-frontier-staircase`, planner marker
  `updated-v8.9 (Agent 1.6.11 frontier staircase)`, and signed Agent 1.6.11.
- Production Agent E2E upgraded the installed `C:\TKBCherryAgent` copy from
  1.6.10 to 1.6.11, showed exactly one online worker, and ran one canonical
  refinement while VPS worker tokens stayed completely free. It returned a
  complete hard-valid `1,566/1,566` timetable with zero unassigned, zero
  singleton, and zero gap-2-plus sessions, but the visible Pareto guard retained
  the incumbent `466` teacher sessions / `44` gap-1. This is safe but not yet a
  quality improvement. Investigate whether cap `461` is too aggressive for the
  first 60-second slice; benchmark nearby caps and a plateau-aware local-LNS
  prelude before another scheduler release.

### v1.27 - 2026-07-19 (staged, not deployed)

- The shared VPS/Agent watchdog now reserves time for solver JSON
  serialization and upload. A complete hard-valid response that crosses the
  final millisecond fence is preserved; incomplete responses still become a
  structured timeout. This fixes the production case where VPS-only sorting
  left only the 54 fixed lessons.
- Agent versions below `1.6.8` authenticate as upgrade-only workers so their
  self-update flow can run, but they are excluded from online counts,
  handoff, and leases. Malformed versions and downgraded active leases are
  rejected and any lease is requeued to the VPS.
- Unified complete-refinement requests now retain the incumbent `lessons`
  array inside the otherwise compact solver-result snapshot. If an earlier UI
  rollback snapshot has already dropped that array, the bridge rebuilds it
  from the visible timetable before POST. Generic warm-start requests remain
  compact and fresh requests still omit `tkbSolverResult` entirely. Rust keeps
  rejecting metrics-only or lesson-count-mismatched incumbents, so an expired
  watchdog can return the exact complete incumbent with HTTP 200 without
  weakening incomplete-schedule safety.
- Staging verification before the incumbent-wire fix: solver Python
  `123/123`, Agent `71/71`, Rust API `135/135`, candidate validator `20/20`,
  and frontend bridge `155/155` plus toolbar/mobile `38/38`.
- Local verification for the incumbent-wire fix passes frontend bridge
  `156/156`, Rust API `136/136`, and JavaScript syntax checks. Full staging
  verification still needs to be rerun before deployment. The bridge marker
  and page cache key have not yet been bumped for this frontend delta.
- Test-only Agent claim grace is `500 ms`, safely above the HTTP lease poll's
  `150 ms` cadence; production claim grace remains `8 seconds`.
- Candidate API marker: `tkb_new-rust-api-2026-07-18-watchdog-reserve-agent-gate-v27`.

### v1.26 - 2026-07-18 (deployed)

- Server-owned solving now has one exclusive executor at a time. A canonical
  job is routed to the Agent when an authenticated Agent is online; otherwise
  the VPS owns it. An Agent hello requests a fenced VPS-to-Agent handoff,
  cancels the VPS child, and invalidates the old generation before the Agent
  lease is exposed. The VPS and Agent never receive parallel tasks for the
  same job.
- Agent lease expiry, worker loss, or a failed claim atomically returns the
  same canonical job to the VPS. Generation fences reject stale VPS/Agent
  results, and the Agent candidate/takeover race preserves a candidate that
  completed at the handoff boundary. Each canonical job creates exactly one
  Agent task (no seed portfolio); Agent claim grace is 8 seconds in production
  and 100 ms in Rust unit tests.
- A server-owned watchdog starts when the first executor is reserved and its
  remaining milliseconds are carried into every executor request. VPS and
  Agent settings are capped to the remaining budget, so a handoff cannot reset
  a 60/180-second solve to a fresh full run. The watchdog returns a structured
  timeout if no complete result remains.
- The CP-SAT in-memory search tree is not transferable between machines. On a
  mid-search Agent failure the VPS resumes the same canonical request/body,
  rather than creating a second job; the in-memory search tree is restarted.
- Final successful UI notification is exactly **Da xep xong!** (the UI uses the Vietnamese text Đã xếp xong!). Complete
  hard-valid schedules remain successful even when soft teacher-session/gap
  debt is still reported in metrics.
- Staging verification: frontend/UI `218/218`, scheduler `123/123`, Agent
  `71/71`, Rust API `128/128`, candidate validator `20/20`, and deployment
  packaging tests `25/25`. `stage-tests.py` ended with `STAGING_TESTS_OK`.
  Current production/staging package measurements are approximately
  93,561,154 / 93,670,943 bytes (tar metadata varies between runs).
- Production deployment returned `UPDATE_OK` with backups
  `/opt/cherry-scheduler-backups/server-state-20260718-162216.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260718-162216.tar.gz`.
  Public health reports `ok:true`, zero active/queued jobs, and 6/6 worker
  tokens. The public page serves cache key
  `20260718-v126-concise-completion-v1`, bridge marker
  `tkb-rust-api-v231-concise-completion`, planner marker
  `updated-v8.6 (Agent 1.6.8 balanced refinement interleave)`, and signed
  Agent manifest `1.6.8`.

### v1.25 - 2026-07-18 (deployed)

- Refinement now separates an internal search frontier from the visible
  incumbent. A lower-session candidate is allowed to carry temporary gap-1
  debt through the next CP-SAT/Benders probe, while the returned timetable still
  has to be complete, hard-valid, and Pareto-safe against the visible schedule.
  If cleanup cannot remove the temporary debt, the exact visible incumbent is
  restored.
- Balanced complete refinement restores `target_gap1_sessions=0` as a search
  routing signal without changing the product priority order
  `one_period -> gap2 -> teacher_sessions -> gap1`. The frontend no longer
  deletes that signal, so the proven same-cap/staircase portfolio is reachable.
- When gap-1 is already within the practical acceptance band, refinement tries
  the tighter teacher-session cap early. A reserved tail budget runs local gap
  cleanup on a lower-session frontier instead of letting one difficult final
  Benders slice consume the entire watchdog.
- Refinement saturation requires at least two stagnant attempts. The inner
  Benders lane uses the same frontier comparator, so temporary gap debt is not
  discarded before the next repair pass.
- Rough refinements now interleave gap cleanup with teacher-session reduction.
  After a same-session gap-only improvement, the next portfolio probe must use
  the bounded lower-session staircase instead of rebuilding another same-cap
  attempt at the front. This fixes the production symptom where a 180-second
  continuation reduced only gap-1 while the teaching-session count stayed
  unchanged. A practical-gap incumbent still uses the proven direct target-cap
  probe because it is materially faster on `default`.
- The reserved frontier cleanup tail is explicitly gap-directed. It forces the
  `gap1` ALNS operator and caps gap-1 at the visible incumbent, so a useful
  lower-session bridge is polished toward a Pareto-safe visible result instead
  of spending the final seconds reducing sessions again with unchanged gap.
- Exact local `default` benchmark (54 fixed lessons, 1,566 periods, six
  workers): first click `1,566/1,566`, `482` teacher sessions, `48` gap-1 in
  55.234 seconds; refinement completed in 175.594 seconds at
  `1,566/1,566`, `463` teacher sessions, `34` gap-1, zero singleton and zero
  gap-2-plus sessions, `hard_ok=true`. Independent refinement seed probe also
  returned `462` sessions / `39` gap-1 in 174.547 seconds.
- Local verification currently passes scheduler `123/123`, bridge `155/155`,
  and the focused frontier/fallback regressions. The final staged bridge marker
  is `tkb-rust-api-v230-balanced-refinement-interleave`; page cache key is
  `20260718-v125-balanced-interleave-v2`.
- Final interleaving benchmark on the exact complete `default` incumbent used
  a 180-second browser-equivalent continuation that improved `482` sessions /
  `41` gap-1 to `462` / `37` in
  173.000 seconds, with `1,566/1,566`, zero unassigned, zero singleton, no
  gap-2-plus bucket, and `hard_ok=true`. The first global result was `466/41`;
  the next same-cap polish reached `462/37`, proving that both objectives move
  in one click rather than starving the session objective.
- Final local release verification passes frontend/UI `218/218`, scheduler
  `123/123`, Agent `71/71`, API E2E `46/46`, deployment/credential tooling
  `19/19`, and JavaScript/Python syntax checks. Isolated VPS staging ended with
  `STAGING_TESTS_OK`: scheduler `123/123`, Agent `71/71`, Rust API `123/123`,
  and Agent-candidate validator `20/20`, for `337/337` total.
- Agent 1.6.8 candidate artifacts:
  - `TKBCherryAgent.exe`: 92,545,151 bytes, SHA-256
    `881E01381E5C1F16957AA98BF48184F3364C3775B904BDB270A594AFE77CB668`.
  - One-entry ZIP: 92,078,973 bytes, SHA-256
    `4168C53A4187549C6AD1E5843EDD833956C97947C775BC54A3FC5F59C24A480B`.
  - Signed manifest: 978 bytes, SHA-256
    `8034619709C32CF19A5874CCAE682CC61774DF94B1F1FE8E33AFC2E096523A16`.
  File/product version, parsed signed manifest, one-root-entry ZIP, UPX 5.2.0
  integrity, GUI smoke, and packaged solver-child smoke all report `1.6.8`.
- The source repository is initialized and backed up to the private GitHub
  repository `thoikhoabieucherry/TKBCherry`, branch `main`. Initial source-only
  backup commit is `24ef651`; secrets, databases, school workbooks, temporary
  build trees, EXE/ZIP artifacts, and release archives are intentionally ignored.
- Production deployment completed with `UPDATE_OK`. Backups are
  `/opt/cherry-scheduler-backups/server-state-20260718-141453.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260718-141453.tar.gz`. Public
  health returned `ok:true`, zero active/queued jobs, and 6/6 available worker
  tokens. The public page serves cache key
  `20260718-v125-balanced-interleave-v2`, bridge marker
  `tkb-rust-api-v230-balanced-refinement-interleave`, planner marker
  `updated-v8.6 (Agent 1.6.8 balanced refinement interleave)`, and the signed
  Agent manifest reports `1.6.8`.
- The public Agent ZIP downloaded as 92,078,973 bytes with SHA-256
  `4168C53A4187549C6AD1E5843EDD833956C97947C775BC54A3FC5F59C24A480B`,
  byte-identical by hash to the local signed candidate.
- Production browser E2E on `sid=default` started from a complete timetable at
  `1,566/1,566`, `506` teacher sessions, `50` gap-1, zero singleton, and zero
  gap-2. One blank-duration `Xep tiep` completed at `466` sessions / `46`
  gap-1, `1,566/1,566`, zero unassigned, zero singleton, and zero gap-2. Both
  primary quality objectives improved in one click. During that live solve the
  browser-control connection was deliberately lost and reattached at elapsed
  `1:35`; it resumed the same canonical job without a second Play/POST, then
  the VPS returned to zero active/queued jobs and 6/6 free worker tokens.

### v1.24 - 2026-07-18 (deployed)

- A manual Play can no longer fall back to the synchronous whole-school
  constraint validator when another tab/data refresh replaces `DATA` during
  the sliced preflight. On the 1,566-period `default` timetable that fallback
  could monopolize the browser before any solver POST, leaving the VPS at zero
  active jobs even though the UI appeared to be sorting.
- Preflight now uses `validateAllAsync` exclusively. Two stale sliced attempts
  preserve the `stale` marker; the click exits cleanly with the existing
  data-changed guidance and releases Play. It never calls `validateAll`
  synchronously. Fixed lessons, edited requirements, and all actual validation
  semantics remain unchanged on a stable data snapshot.
- A focused regression forces two consecutive stale async results and proves
  the synchronous validator is called zero times. Full frontend/UI verification
  passes 218/218, bridge 155/155, and JavaScript syntax checking passes.
- Refreshed isolated VPS staging ended with `STAGING_TESTS_OK`: scheduler
  118/118, Agent 71/71, Rust API 123/123, and Agent-candidate validator 20/20,
  for 332/332 total.
- Candidate bridge marker is `tkb-rust-api-v228-async-preflight-safety` and its
  page cache key is `20260718-v124-async-preflight-safety-v1`. Scheduler and
  Agent binaries are unchanged from v1.23/Agent 1.6.7.
- Production deployment completed with `UPDATE_OK`. Backups are
  `/opt/cherry-scheduler-backups/server-state-20260718-123341.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260718-123341.tar.gz`. Public
  health returned `ok:true`, zero active/queued jobs, and 6/6 worker tokens;
  the v1.24 bridge/cache markers were served publicly.

### v1.23 - 2026-07-18 (deployed)

- Fixed the fresh-sort regression that could spend the entire 60-second click
  on repeated feasibility work, return no timetable on a low-resource worker,
  or stop at a complete but weak result such as 522 teacher sessions / 119
  gap-1 sessions. The all-session CP-SAT lane no longer reserves time for an
  unused second period-allocation pass, and strict/fallback phases now receive
  balanced budgets.
- A bounded fresh click may retain a complete, hard-valid timetable with
  temporary teacher singleton/gap debt while the remaining budget continues
  improving it. User requirements, fixed lessons, exact lesson demand, and
  collision/contiguity validation remain hard. The quality-cap headroom is 16,
  preventing the first usable incumbent from consuming the useful cleanup
  window.
- A low-resource one- or two-worker fallback now prioritizes completeness. A
  one-worker stress probe returns all 1,566 periods instead of failing; quality
  is deliberately secondary on that emergency path.
- Exact local verification used the current backed-up `school_default` data:
  54 classes, 54 fixed lessons, 1,566 required periods, and a blank 60-second
  fresh click with six workers. It returned 1,566/1,566, `hard_ok=true`, in
  55.094 solver seconds (56.030 seconds wall time), at 482 teacher sessions / 41
  gap-1 sessions, zero one-period teacher sessions, zero gap-2-plus sessions,
  and zero class/teacher/room, application, or contiguous violations. The
  termination reason was `first_click_local_lns_improved`.
- Solver errors now cross the stdio/bridge boundary as structured errors and
  are mapped to concise Vietnamese guidance instead of exposing internal
  Benders/deadline text.
- When a refinement returns an equal-visible timetable with a different cell
  arrangement, the browser still restores the better visible incumbent but
  now carries forward the attempted `optimization_refinement_round`. The next
  Play therefore advances to a new search trajectory instead of replaying the
  restored round. The focused bridge regression and the full Node bridge suite
  pass (`154/154`).
- Refinement randomness now reaches the solver instead of stopping at the
  browser contract. The request `random_seed`/`quality_variant_seed` is mixed
  into the round-adaptive local ALNS pass portfolio and is also assigned to
  queued/tighter global cap probes. The same request seed remains reproducible,
  while a different seed produces different local-pass and global-cap
  trajectories. Focused scheduler regressions cover both paths.
- A real source refinement starting at 1,566/1,566 and 482/41 improved to
  482/39 in 45.72 seconds and stopped on saturation. A fresh alternate-seed
  probe remained complete and hard-valid at 482/45 in 54.94 seconds, with zero
  singleton and zero gap-2-plus sessions. This verifies diversity without
  weakening the Pareto incumbent guard.
- Frontend cache key is
  `20260718-v123-first-click-quality-safety-v1`; bridge marker is
  `tkb-rust-api-v227-first-click-quality-safety`; planner marker is
  `updated-v8.5 (Agent 1.6.7 first-click quality safety)`.
- Local scheduler regression passes 118/118 and the full bridge suite passes
  154/154. Refreshed isolated VPS staging of the final seed-aware source ended
  with `STAGING_TESTS_OK`: scheduler 118/118, Agent 71/71 (including GUI smoke
  for 1.6.7), Rust API 123/123, and Agent-candidate validator 20/20, for 332/332
  total. Both the VPS and packaged Agent therefore carry the same final seed
  propagation behavior.
- Production deployment ended with `UPDATE_OK`. Final recorded backups are
  `/opt/cherry-scheduler-backups/server-state-20260718-115857.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260718-115857.tar.gz`. Public
  health returned `ok:true`, zero active/queued jobs, and 6/6 worker tokens;
  the v1.23 cache, bridge, and planner markers matched source.
- Agent 1.6.7 was rebuilt after the final seed propagation change, UPX-packed,
  integrity-tested, GUI-smoked,
  solver-child-smoked, and signed. Candidate artifacts are:
  - `TKBCherryAgent.exe`: 92,422,786 bytes, SHA-256
    `1A8BF93234386D413177DEACAEEDAC6419692323371614EE119A2D879B6B6337`.
  - One-entry ZIP: 91,956,291 bytes, SHA-256
    `C0ED54E6BE84A92F4FF9392ED8BCE7D4C6EEA74314F085640061D995D864F382`.
  - Signed manifest: SHA-256
    `A86BF63CD616A8770635B8F2CE887570DAFAE29DEC6F959059685FD175E8FAE9`.
  The ZIP and manifest in `web/downloads` are byte-identical to the candidates
  in `agent_helper/dist`. The public ZIP downloaded as 91,956,291 bytes with
  SHA-256
  `C0ED54E6BE84A92F4FF9392ED8BCE7D4C6EEA74314F085640061D995D864F382`,
  byte-identical to local; the public signed manifest reports Agent 1.6.7.

### v1.22 - 2026-07-18 (deployed)

- Complete incumbent refinement jobs now request the full six-worker VPS pool.
  The three-worker path can spend about 187 seconds on the production-size
  `default` refinement and miss the 180-second server deadline; the six-worker
  path returns a valid better candidate before that deadline. The schedule-scope
  single-flight lock is unchanged, so a second device still attaches to the
  same job instead of starting a duplicate.
- A blank-duration fresh click now has a 60-second ceiling and returns as soon
  as it has a complete, hard-valid timetable with zero one-period teacher
  sessions and no teacher gap above one period. A failed manual fresh click
  records the next manual ceiling in five-second steps without changing the
  user's blank duration field. Every complete-incumbent continuation keeps a
  180-second ceiling.
- Refinement no longer waits for a fixed numeric quality threshold or consumes
  180 seconds unconditionally. It retains the Pareto-best complete timetable
  and stops after bounded search saturation (two stagnant Benders iterations,
  or the adaptive stagnant attempt/time window). On the exact backed-up
  `school_default` data with 54 fixed lessons, sampled source runs produced the
  first strict timetable in 10-15 seconds at 1,566/1,566. A continuation then
  stopped after 95.844 seconds at 462 teacher sessions / 34 gap-1 sessions,
  with zero one-period sessions and no gap above one. A longer pre-saturation
  probe had shown 460/34 and 457/30 are reachable, confirming the quality path.
- User requirements remain hard, while zero singleton/gap-2 teacher quality is
  a strongly preferred soft objective during requirement-change repair. If a
  user constraint makes those quality goals mutually incompatible, staged and
  full-rebuild paths still return a complete hard-valid timetable and expose
  the remaining quality debt. A real one-period-per-week regression proves the
  unavoidable singleton is scheduled instead of being reported infeasible.
- Fresh sorting now uses the same rule safely. Its first lane still requires
  zero one-period teacher sessions and no gap above one. A bounded second lane
  runs only when the strict candidate fails, relaxes only those two product
  quality goals, and never relaxes user/application constraints. A real
  three-period regression fixes one teacher at Monday AM periods 1 and 4 while
  another teacher has only one weekly period; the result is complete `3/3`,
  hard-valid, and truthfully retains both the unavoidable gap-2 session and
  singleton instead of returning no timetable. The browser applies this
  complete result and reports **Can toi uu**, rather than rejecting it as a
  hard-constraint failure or claiming it is already optimized.
- Mobile/background job ownership is now durable across iOS app switching.
  Mobile Safari can suspend every JavaScript timer while another app is in the
  foreground; when it resumed after the local result-wait deadline, v1.21
  converted `solver_result_wait_timeout` to `client_timeout`, called the VPS
  cancel endpoint, and deleted the pending job id. That produced the misleading
  **Cho lau / Chua nhan duoc ket qua** notice while leaving the old complete but
  improvable timetable (for example 503 teacher sessions / 53 gap-1 sessions)
  on screen. v1.22 no longer lets a browser deadline cancel a server-owned job.
  It retains the durable job id, shows reconnecting state, and polls the same
  canonical job after `visibilitychange`, `pageshow`, or `online`; only explicit
  Stop or a terminal server response can cancel it. A deterministic E2E freezes
  browser time for 20 seconds beyond the client deadline, proves zero cancel
  POSTs, preserves the pending id, and reconnects without a duplicate solve.
- The frontend cache keys are scoped to
  `20260718-v122-mobile-background-reconnect-v3`; bridge marker is
  `tkb-rust-api-v226-mobile-background-reconnect`. Planner marker is
  `updated-v8.4 (Agent 1.6.6 requirement quality fallback)`. Quality status remains factual: a
  complete schedule with remaining teacher session/gap debt is reported as
  needing more optimization, while an unchanged incumbent is reported as
  retained.
- Mobile double-tap cell actions now expose **Cố định**, **Nghỉ**, and **Xóa**.
  The Nghỉ action uses the existing transactional `OFF` path, persists the
  class/teacher fixed-off constraint, moves any displaced lesson to Chưa phân,
  and is available on empty cells as well as occupied cells. Existing Nghỉ
  cells offer **Bỏ nghỉ**.
- Verification: frontend/UI `216/216`, scheduler `115/115`, Agent `71/71`, API
  E2E `46/46`, deployment/credential tooling `12/12`, DPAPI dummy credential
  round-trip, and JavaScript syntax checks passed locally. Isolated VPS staging
  passed scheduler `115/115`, Agent `71/71`, Rust `123/123`, and Rust validator
  `20/20`, ending with `STAGING_TESTS_OK`. Production update ended with
  `UPDATE_OK`; backups are
  `/opt/cherry-scheduler-backups/server-state-20260718-100824.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260718-100824.tar.gz`.
- Public Agent `1.6.6` bundles the corrected solver. The build completed both
  onedir and standalone GUI smokes, packaged solver-child protocol smoke, UPX
  5.2.0 integrity testing, one-entry ZIP validation, embedded file/product
  version checks, and manifest verification with the Agent's pinned public
  key. Candidate artifacts are:
  - `TKBCherryAgent.exe`: 92,088,823 bytes, SHA-256
    `7A13D12D5548D9E48E61475168E6B2CACE6C9A4BD7BC72AA382B84E8E3E5FECA`.
  - One-entry ZIP: 91,589,835 bytes, SHA-256
    `E08882FFB12CFA8EAE6E08C8A6119592DAE7C6403DBA6C0866BA661CDD52FCB4`.
  - Signed manifest: SHA-256
    `5764C7DF9632CFDB72729A493CA467B8424F98AEFD366536A55B34966BD6123C`.
  The ZIP and manifest are synchronized from `agent_helper/dist` into
  `web/downloads` and are deployed publicly. A direct public download returned
  91,589,835 bytes with SHA-256
  `E08882FFB12CFA8EAE6E08C8A6119592DAE7C6403DBA6C0866BA661CDD52FCB4`,
  byte-identical to local.
- `tools/vps-deploy/save-vps-credential.ps1` parses cleanly and has a masked
  topmost Windows GUI input path. The VPS password is now present in the
  CurrentUser DPAPI store at
  `%LOCALAPPDATA%\TKBCherry\secrets\vps-password.dpapi`; status reports
  `VPS_CREDENTIAL_READY`. Never place the plaintext password in a command,
  repository file, log, or this handoff.
- Final public verification returned `ok:true`, zero active jobs, zero queued
  jobs, and 6/6 available worker tokens. The page contains cache key
  `20260718-v122-mobile-background-reconnect-v3`; the bridge contains
  `tkb-rust-api-v226-mobile-background-reconnect`; the planner contains
  `updated-v8.4 (Agent 1.6.6 requirement quality fallback)`; and the signed
  Agent manifest reports `1.6.6` with the expected archive size and hash.

### v1.21 - 2026-07-18 (deployed)

- Mobile planner layout now reserves a fixed progress row before any solve
  starts, so the timetable does not jump when progress/status content appears.
  Touch mobile pages reclaim the bottom safe-area band instead of leaving a
  blank strip below the two timetable panes. Portrait uses a 32px row; short
  landscape uses a compact 20px row and smaller progress ring while preserving
  the independent pane scrolling behavior.
- Mobile status text remains on one line without CSS ellipsis. The planner
  fits the text down to the device-appropriate minimum and applies a final
  horizontal fit so long notifications do not lose characters.
- Local iPhone-sized visual check at `440x956` measured a stable 32px feedback
  row and a 2px border-only bottom gap in both idle and active-status states.
  Local frontend/UI Node tests pass `213/213`; targeted mobile/PWA tests pass
  `30/30`.
- VPS deployment returned `UPDATE_OK`. Backups are
  `/opt/cherry-scheduler-backups/server-state-20260718-030609.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260718-030609.tar.gz`. The
  public `sapxep.html`, `phanmon.js`, and `phanmon.css` assets are byte-identical
  to local; their SHA-256 values are respectively
  `A163C7C78D42419557AED3E13178358F64D52C5D48D335A9E7A0A355217EA146`,
  `62B3847F8F190A8ADA2B51E30266FD7853751DEF518F9B002BFE7D8E4F42820D`, and
  `214F280E9DCE4DD4138317F77E7FB4445BC4AB5B0340CB0487F7DF0A4A43F027`.
- Public health after deployment returned `ok:true`, zero active jobs, zero
  queued jobs, and 6/6 available worker tokens. Static production verification
  found cache key `20260718-mobile-progress-reserve-v2` and planner marker
  `updated-v8.1`. Direct authenticated visual measurement was not repeated in
  this session because the available browser tab had expired to the login page;
  the local iPhone-sized visual check remains the layout evidence.

### v1.20 - 2026-07-18 (deployed)

- A VPS/reference-solver timeout during a complete `Xếp tiếp` refinement no
  longer discards the valid timetable and returns an empty 422. Rust now
  recognizes both current and older cached `refine_complete` clients, checks
  that the incumbent contains exactly the expected lesson payload with no
  unassigned lessons, and returns that incumbent as a successful no-op when
  the quality search times out or fails. A changed requirement still follows
  the repair/rebuild path because the browser does not mark a violated schedule
  as a refinement incumbent.
- The frontend marks a complete, constraint-clean incumbent as revalidated and
  requests this fallback explicitly. Rust also accepts the solve-kind contract
  without that marker for backward compatibility with cached v1.18/v1.19 pages.
- Full verification passed before deployment: frontend bridge `150/150`, other
  frontend/UI `61/61`, API E2E `46/46`, scheduler staging `113/113`, Agent
  staging `71/71`, Rust `123/123`, and Rust validator `20/20`. Both targeted
  timeout/incumbent regressions passed.
- Production deployment returned `UPDATE_OK`. Backups are
  `/opt/cherry-scheduler-backups/server-state-20260718-020357.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260718-020357.tar.gz`. Public
  bridge SHA-256 is
  `1DD536569065C8CB229F1249CF52200410F0399BC6936D8C0A600DC19A57FEDF`,
  byte-identical to local. The public page serves bridge marker
  `tkb-rust-api-v221-refine-incumbent-timeout-fallback` and cache key
  `20260718-refine-incumbent-fallback-v1`.
- Final live production verification used `default` with Agent disconnected,
  so the complete refinement ran on the VPS (on desktop, dismiss the optional
  Agent-download prompt; phones hide that prompt and use VPS directly). The
  incumbent began at
  1,566/1,566, 481 teacher sessions, 58 gap-one sessions, zero gap-two-plus
  sessions, and zero one-period sessions. A second browser tab pressed Play
  during the run and attached to the same canonical job with the same Stop
  control; it did not create a duplicate job. After the 180-second solver
  ceiling both tabs returned to idle without a 422 or long-wait error. The
  valid incumbent was retained exactly at 1,566/1,566 and 481/58, proving the
  timeout fallback preserves a complete timetable when no better candidate is
  found. Final public health was `ok:true`, zero active jobs, zero queued jobs,
  and 6/6 available worker tokens.

### v1.19 - 2026-07-18 (deployed)

- Requirement-change repair is now fully transactional. The browser no longer
  deletes timetable cells in `sapXepTuDongAll()` or `postSolve()` before it
  submits a solve. A complete incumbent remains visibly and durably at
  1,566/1,566 while the backend receives it as a soft hint.
- The backend releases only the smallest useful flexible group inside its own
  repair copy for aggregate teacher caps. For `teacher.maxDays`, it removes the
  fewest-lesson excess day; corresponding logic covers maximum sessions,
  mornings, and afternoons. Hard fixed lessons are excluded from rule-driven
  release and remain immutable. An unstructured violation no longer triggers
  the previous catastrophic "release every lesson" fallback.
- Exact local regression started from the validated `default` 466/38 timetable,
  then set `T.Thắm.maxDaysSessions.maxDays=3` without any frontend pre-release.
  The request still contained all 1,566 periods and reported zero client-side
  missing periods. The source solver completed in 9.541s with 1,566/1,566,
  `hard_ok=true`, zero application violations, zero one-period sessions, no gap
  above one, and T.Thắm's 18 periods on exactly three days (`7 + 7 + 4`). It
  retained 1,545/1,566 exact positions (98.66%) and all 54/54 fixed cells.
- Blank fresh and refinement clicks now share a 180-second safety ceiling. The
  duration field remains blank and user-owned; there is no automatic retry and
  no hidden 60 -> 65 ladder. Fresh stops at the first strict usable timetable,
  and refinement stops early when the quality threshold is already met.
- Exact fresh `default` with 54 fixed lessons stopped in 69.453s at 1,566/1,566,
  504 teacher sessions / 62 gap-1 sessions, zero one-period sessions, no gap
  above one, and zero hard/application violations. Three 180-second refinements
  improved this sampled basin to `474/44 -> 474/38 -> 474/36`; all retained
  completeness and hard validity. This demonstrates real improvement but also
  records the open limitation that global period-feasible cap search can remain
  at a local 474-session basin. A separately validated path reaches 466/38.
- An already-good 466/38 incumbent returned unchanged in 1.067s with termination
  reason `existing_good_enough_early_stop`, proving that the 180-second value is
  a ceiling rather than a mandatory wait.
- Source verification passes 185/185 frontend/UI tests, 112/112 scheduler tests,
  71/71 Agent tests, 7/7 launcher/deployment-tooling tests, 5/5 mail-server tests,
  and 46/46 full local API/application E2E tests. The PowerShell build script also
  parses cleanly. The local full E2E used the retained Windows Rust binary; this
  machine currently has no `cargo`, so freshly compiled Rust unit tests still
  belong to isolated VPS staging before deployment.
- The packaged UPX Agent 1.6.5 completed the no-pre-release T.Tham three-day
  repair in 15.679s at 1,566/1,566, 470 teacher sessions / 40 gap-1 sessions,
  zero singleton or gap-2-plus sessions, and `7 + 7 + 4` lessons across exactly
  three days. Packaged fresh `default` completed in 73.009s at 1,566/1,566,
  502/57, zero singleton or gap-2-plus sessions, and zero hard/application or
  contiguous violations.
- Final local Agent candidate artifacts are:
  - `TKBCherryAgent.exe`: 92,365,967 bytes, SHA-256
    `DEBDB82B5828C9ACFF3F97CFF29C588DBCC9F6E74D2B1C1BACD1BD9F7DCABAB8`.
  - One-entry ZIP: 91,873,277 bytes, SHA-256
    `B4944D5CE200155ADCD075FBB033776581DB47F66F9C367492196E2A786CCB62`.
  - Signed manifest: 978 bytes, SHA-256
    `60B3314CBC7F4EFB38BF87183F0826821CF9C548C145815649423DEAEB65815A`.
  File/CLI version is `1.6.5`; manifest signature parsing, the one-root-entry ZIP,
  UPX 5.2.0 integrity, solver-child protocol, and real Windows GUI smoke pass.
- `build_windows.ps1` now runs every packaged GUI smoke in a child environment
  with `TCL_LIBRARY` and `TK_LIBRARY` removed. This prevents the normalized Tcl
  tree used by the build Python from masking a missing/broken Tcl payload inside
  the packaged Agent. A smoke run inside the Codex filesystem sandbox can falsely
  fail because native Tcl cannot traverse the sandboxed user-profile directories;
  the required unsandboxed Windows smoke passed with `GUI smoke OK 1.6.5`.
- Candidate markers are `tkb-rust-api-v221-refine-incumbent-timeout-fallback` and
  `updated-v7.9 (Agent 1.6.5 transactional internal repair)`. Candidate cache
  keys are `20260718-refine-incumbent-fallback-v1` and
  `20260718-agent165-refine-incumbent-fallback-v1`.
- Isolated VPS staging passed scheduler `112/112`, Agent `71/71`, Rust
  `141` main tests plus `20` validator tests, and returned `STAGING_TESTS_OK`.
  Production update returned `UPDATE_OK` after draining the solver. Backups:
  `/opt/cherry-scheduler-backups/server-state-20260718-000450.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260718-000450.tar.gz`.
- Public post-deploy health is `ok:true`, API `rust`, `solverActiveJobs=0`,
  `solverQueuedJobs=0`, and `solverWorkerTokensAvailable=6/6`. Public bridge
  and planner assets are byte-identical to local:
  bridge SHA-256 `4F037F5014A4C1836B364D785D14ABB379537D3AAD933ACB0329BAC1F404C0E9`
  and planner SHA-256
  `0A8B6FE533428CC0DF31D21CD26B47A47948DCC87A29C64C6BF7337D541706AC`.
  The public Agent manifest reports version `1.6.5` and the local candidate
  archive/executable hashes listed above.
- No live timetable click was issued during post-deploy verification, so the
  user's current schedule was not mutated automatically. A browser refresh is
  required to load the new cache keys before the next manual **Xếp** click.

### v1.18 - 2026-07-17 (deployed)

- Preserves the product timing contract: a blank-duration fresh sort remains
  60 seconds and every later incumbent refinement remains 180 seconds. Agent is
  optional acceleration only; the VPS reference solver uses the same corrected
  scheduler and can complete/refine without a connected workstation.
- Fixed the teacher-quality regression caused by forcing every refinement with
  54 fixed lessons through the full integrated period bridge. That path added
  about 27,648 period variables to each CP-SAT attempt and left too little useful
  search time for reducing teacher sessions. A complete, validated refinement
  now sets `optimization_benders_lean_refinement_periods=true`: CP-SAT chooses
  the session vector and the MILP period allocator materializes it. Fresh and
  changed-requirement solves retain the full integrated bridge for reliable
  first completeness.
- The lean refinement is still strict. The updated period MILP joins fixed and
  flexible periods of the same multi-period assignment into one contiguous
  block, and every candidate must pass exact demand, fixed lesson, resource,
  application, contiguous, zero-singleton, and maximum-gap validation. The
  existing complete timetable remains the fallback; no non-Pareto regression is
  applied and no failed attempt can remove periods.
- Exact local default regression, starting from 1,566/1,566 with 54 fixed
  lessons, improved across ordinary 180-second clicks as follows:
  `521 sessions / 117 gap-1 -> 500/78 -> 479/56 -> 469/48`. Every result had
  zero unassigned periods, zero one-period teacher sessions, zero gap-2-plus
  sessions, `hard_ok=true`, zero application violations, and zero contiguous
  violations. These runs used the same source solver used by VPS and did not
  use Agent.
- The packaged UPX Agent fresh checks completed `default` (54 fixed) in 29.779s
  and `d8f7b12caf1` (108 fixed) in 24.457s. Both returned 1,566/1,566,
  `hard_ok=true`, zero application/contiguous violations, zero one-period
  sessions, and no gap above one. A packaged 180-second refinement exercised
  the lean MILP lane; its sampled candidate portfolio was period-infeasible, so
  it correctly retained the exact 479/56 incumbent instead of degrading it.
- Frontend bridge marker: `tkb-rust-api-v219-strong-teacher-refine`; cache key:
  `20260717-strong-teacher-refine-v1`. Planner marker:
  `updated-v7.8 (Agent 1.6.4 strong teacher refinement)`; cache key:
  `20260717-agent164-strong-teacher-refine-v1`.
- Local verification passes 206/206 frontend/UI tests, 107/107 scheduler tests,
  71/71 Agent tests, and 7/7 deployment/tooling tests. Isolated VPS staging
  passes 107/107 scheduler, 71/71 Agent, and 141/141 Rust tests with
  `STAGING_TESTS_OK`.
- Final public Agent artifacts:
  - `TKBCherryAgent.exe`: 92,358,144 bytes, SHA-256
    `B533EF5AAEDCB26FC11E8D8F39EDB37A557F9127E7B8CCC230D33AAC2BFD3C0F`.
  - One-entry ZIP: 91,864,797 bytes, SHA-256
    `B0D279214FE0AED528B5155276D5328D42756A2DBD0981639F8F671D6A3A7B5F`.
  - Signed manifest: 978 bytes, SHA-256
    `4A0BB9B7AFED8F25CD2F6585924DA90311B7A27BBCEB8F5608F0968999473E84`.
  - File/product/CLI versions are `1.6.4`; UPX 5.2.0 integrity passed, the
    manifest signature verified with the pinned public key, and the public ZIP
    contains exactly one root `TKBCherryAgent.exe` entry.
- Production deployment returned `UPDATE_OK`. State and release backups are
  `/opt/cherry-scheduler-backups/server-state-20260717-140146.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260717-140146.tar.gz`.
- The public bridge and planner assets are byte-identical to local: bridge
  SHA-256 `23B221F55ED813A09542BDF3C25280FD35DC9C22735B3479E24912EA538190AD`
  and planner SHA-256
  `CDE01C59196AAA60E34CF9AB0A84AE17D4A5C6954C6693A4E267373886BC0123`.
  The public signed manifest and Agent ZIP also match the artifact hashes above.
- A live production check with Agent offline ran one VPS-owned 180-second
  refinement and synchronized the running/stop state across the UI. It returned
  to idle with 1,566/1,566 periods, 516 teacher sessions, 107 gap-one sessions,
  zero gap-two-plus sessions, and zero one-period teacher sessions. The sampled
  candidate portfolio had no Pareto improvement, so the exact incumbent was
  retained; no lesson was removed and no invalid result was applied.
- Final public health returned `ok:true`, zero active jobs, zero queued jobs,
  and 6/6 available worker tokens.

### v1.17 - 2026-07-17 (deployed)

- Replaced the unreliable short first-click Benders path with one strict
  feasibility-first CP-SAT result. `session_cp_sat.py` now materializes concrete
  lesson periods directly from period-bridge choices, enforces the teacher gap
  cap in that model, prunes gap constraints from about 3,348 to 426, and models
  zero one-period teacher sessions without the previous per-session Boolean
  expansion. The adapter fully validates the materialized timetable and falls
  back to the legacy period allocator if validation ever rejects it.
- A fresh timetable or full rebuild after edited requirements returns as soon as
  the first complete strict-quality timetable exists. Completeness, all hard/app
  constraints, zero one-period teacher sessions, and maximum within-session gap
  one are mandatory for this lane. No automatic retry was added: every new
  attempt still requires the user to press Play, the visible duration field stays
  user-owned, and failed/partial output is never applied over the current TKB.
- The exact production-size fixtures pass locally and in the packaged Agent:
  `default` completed in 26.335s, `d8f7b12caf1` in 25.943s, and the changed-rule
  case with `T.Thắm.maxDaysSessions.maxDays = 3` in 22.780s. Every case returned
  1,566/1,566, zero unassigned, `hard_ok=true`, zero app violations, zero
  one-period sessions, and a gap distribution containing only 0 and 1. The
  constrained teacher's 18 periods use exactly three days (`7 + 4 + 7`).
- Scheduler bridge marker: `tkb-rust-api-v218-strict-first-complete`; cache key:
  `20260717-strict-first-complete-v1`. Planner marker: `updated-v7.7 (Agent 1.6.3
  strict first complete)`; cache key:
  `20260717-agent163-self-update-strict-first-v1`.
- Windows Agent `1.6.3` adds user-confirmed self-update. The packaged Agent checks
  at startup and every six hours. It prompts only while connected and idle; an
  available update discovered during a solve is deferred until the worker
  returns to `waiting`. Pressing OK first stops the long-poll worker, then stages
  the update. Declining never downloads or changes a file.
- Release metadata at `/downloads/TKBCherryAgent-release.json` is signed with a
  pinned 3,072-bit RSA key. The private key is DPAPI-protected in the release
  operator's Windows profile and is never stored in the repository or VPS. The
  updater requires same-origin HTTPS, verifies the manifest signature, declared
  sizes, ZIP and EXE SHA-256 values, exactly one root entry named
  `TKBCherryAgent.exe`, a real packaged GUI smoke, and an exact `--version` match.
  It rehashes the EXE after both probes before launching it.
- The already-established relocation handoff performs the actual replacement:
  the staged new EXE stops only the installed Agent process tree, atomically
  replaces the installed file, and relaunches it. A download, signature, hash,
  ZIP, smoke, version, launch, or write failure leaves the installed EXE intact
  and turns the old Agent worker back on. Agent `1.6.2` and older need one manual
  `1.6.3` install; versions after `1.6.3` can update themselves.
- Final public-candidate artifacts:
  - `TKBCherryAgent.exe`: 92,350,898 bytes, SHA-256
    `B3E50492D773E6F6E15BDDDAD6B2A8560F2605FC0FA1B681DCEE36749753AA05`.
  - One-entry ZIP: 91,858,677 bytes, SHA-256
    `1F0A13A22606652EB95413C60949532520ABECDB28C79556452AB6D981669C6F`.
  - Signed manifest: 978 bytes, SHA-256
    `7CD331E12BEB2277E166C61D7C0ABA09297EE1E51733F8E12D7D0F5A564EF718`.
  - UPX 5.2.0 `-t` passed. One unpack changed 92,350,898 bytes to
    92,505,522 bytes, and a second UPX test returned `NotPackedException`,
    confirming exactly one UPX layer. File/product metadata and `--version` are
    all `1.6.3`; the PyInstaller archive contains `agent_helper.updater`.
- Verification passes 206/206 Node/UI tests, 104/104 scheduler tests, 69/69
  Agent tests, and 14/14 deployment/tooling tests. Final isolated VPS staging
  passed 104/104 scheduler, 69/69 Agent, and 139/139 Rust tests with
  `STAGING_TESTS_OK`.
- Production deployment returned `UPDATE_OK`. State and release backups are
  `/opt/cherry-scheduler-backups/server-state-20260717-063333.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260717-063333.tar.gz`.
- The public bridge and planner assets are byte-identical to local: bridge
  SHA-256 `AA3A01EECB391AD148A577467D033BFA2FA9B608D6439B9CABDDFC2D7295711B`
  and planner SHA-256
  `B9CA4E7914AE81BD492E5E67A5EA1CB49D988E63CC173EF2233005E26A5E5356`.
  The public signed manifest and Agent ZIP also match the hashes listed above;
  the manifest signature and both ZIP/EXE payload hashes were verified.
- A live authenticated two-tab production check observed one canonical job,
  `tkb-rust-api-v218-strict-first-complete:1784270456873:2:rbm1otlj7ad:req:1784270457897:y8lpalf8jcl`.
  Access evidence showed one solve submission; the second tab only performed
  precheck and polling. Both tabs received the same result, returned to idle,
  exposed Play again, disabled Stop, and displayed zero unassigned periods.
- Final public health after the browser check returned `ok:true`, zero active
  jobs, zero queued jobs, and 6/6 available worker tokens.
- v1.16 was an internal, undeployed diagnostic candidate and is superseded by
  this complete v1.17 package; it must not be deployed separately.

### v1.15 - 2026-07-17 (deployed)

- Fixed the remaining bottom band in installed mobile apps across iOS and
  Android. A touch-capable standalone/fullscreen PWA now uses the screen height
  in the current orientation when the browser-reported viewport is slightly
  shorter because of system overlays. Regular Safari/Chrome tabs continue to
  use the dynamic visible viewport so the timetable does not extend beneath
  browser chrome.
- Split-screen and windowed mobile modes are protected: screen dimensions are
  ignored when they exceed the measured app viewport by more than 35 percent.
  The existing resize, pageshow, and repeated orientation-settle listeners keep
  both class and teacher panes synchronized after portrait/landscape changes.
- The mobile top command toolbar and desktop layout are unchanged. Mobile
  `Da xep` and `Chua phan` pane counters remain hidden, while each timetable
  pane expands to consume its share of all remaining height.
- Planner asset cache key: `20260717-standalone-mobile-edge-v1`.
  `phanmon.js` marker: `updated-v7.5 (standalone mobile fills the screen)`.
  Scheduler bridge is `tkb-rust-api-v217-manual-fresh-plus5`, with cache key
  `20260717-manual-fresh-plus5-v1`. Windows Agent remains `1.6.1`.
- A failed blank-duration fresh or changed-requirement click no longer repeats
  the exact same 60-second ceiling forever. It records a fingerprint-scoped,
  hidden next-click budget of 65 seconds, then 70, 75, and so on in five-second
  steps up to 180 seconds. The user must press Play for every attempt; there is
  no automatic retry or second solve job. The visible duration input remains
  blank and exclusively user-controlled. An explicit user duration always wins,
  and the hidden ladder resets after a complete result.
- Production access logs confirmed the reported failure was one canonical
  `default` job started from iPhone at 08:51 local time and observed by Windows,
  not two compute streams. It ended HTTP 500 near the 60-second boundary after
  the feasibility search exhausted its Benders budget. The Agent had no lease
  traffic, so the VPS reference solver owned this run.
- The exact current `default` data was reproduced locally. A 60-second control
  completed 1,566/1,566 in 56.322 seconds with zero unassigned, `hard_ok=true`,
  481 teacher sessions, and zero one-period sessions. The hidden 65-second retry
  completed 1,566/1,566 in 60.979 seconds with zero unassigned, `hard_ok=true`,
  520 teacher sessions, and 20 one-period sessions. A proposed wider feasibility
  cap was rejected after benchmarking because it reduced quality; the release
  keeps the existing optimizer and adds only bounded manual retry time.
- Full frontend/UI verification passes 206/206 Node tests. The viewport
  regressions cover iOS and Android standalone apps, ordinary Android browser
  tabs, both orientations, and the screen-to-window guard. A production-CSS
  fixture at 440x956 measured a 2px bottom gap and equal 425px panes before and
  after `portrait -> landscape -> portrait`.
- Scheduler verification passes 101/101 tests and Agent verification passes
  56/56 tests. The new frontend regressions prove 60 -> 65 -> 70 across manual
  clicks, a blank unchanged input, explicit-duration precedence, success reset,
  exactly one solve POST per click, and history-free persistence of the hidden
  retry state.
- Isolated VPS staging passes 101/101 scheduler tests, 56/56 Agent tests, and
  139/139 Rust tests with `STAGING_TESTS_OK`. Deployment completed with
  `UPDATE_OK` after draining the active solve. State and release backups are
  `/opt/cherry-scheduler-backups/server-state-20260717-023628.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260717-023628.tar.gz`.
- Final public health returned `ok:true`, zero active jobs, zero queued jobs,
  and 6/6 available worker tokens. Both public cache keys and both v1.15
  markers were present. Public/local SHA-256 matched for `tkb-rust-bridge.js`
  (`E42EA83D1EF62A61C3D2E47189E54E88E6AF8165950236F086BFFE8B755AC763`)
  and `phanmon.js`
  (`38064B7F48C3055FBF818000F25ED0CA949226064668E1C96015F4FDA681CD2E`).

### v1.14 - 2026-07-17 (deployed)

- Fixed a production-confirmed server-only failure on a fresh `default` sort.
  With no Windows Agent connected, the 60-second Phase F search treated zero
  one-period teacher sessions and a maximum teacher gap of one as mandatory.
  Two period-infeasible Benders vectors could consume the feasibility budget
  and return HTTP 500 even though the 1,566-period timetable was feasible.
- A fresh or changed-requirement rebuild below 120 seconds now accepts the first
  complete hard-valid timetable with optional teacher-quality debt. Completeness,
  fixed lessons, resource conflicts, and every application constraint remain
  mandatory. One-period sessions and teacher gaps are still minimized, and a
  longer fresh run or later 180-second refinement retains the strict quality
  lane. There is still one user-owned job, no hidden retry, and no automatic
  solve without pressing Play.
- `_solve_teacher_session_benders_candidate()` now honors
  `period_max_teacher_gap`, including the explicit `off` sentinel, instead of
  always passing a hardcoded value of one to period allocation.
- Frontend bridge marker: `tkb-rust-api-v216-bounded-fresh-no-agent`; cache key:
  `20260717-bounded-fresh-no-agent-v1`. Windows Agent remains `1.6.1` and is not
  required for basic VPS sorting.
- Regression verification passes 203/203 frontend/UI tests, 101/101 scheduler
  tests, and 56/56 Agent tests. Isolated VPS staging passes the same Python
  suites plus 139/139 Rust tests with `STAGING_TESTS_OK`.
- The exact stored `default` fixture was tested through two isolated loopback
  Rust API instances with temporary databases and no possible Agent connection.
  Both 60-second requests returned 1,566/1,566 periods, zero unassigned, zero
  application constraint violations, and `hard_ok=true`; solver elapsed times
  were 45.53 and 46.71 seconds.
- Deployment completed with `UPDATE_OK`. Public health returned `ok:true`, zero
  active/queued jobs, and 6/6 available worker tokens. The served bridge marker
  was `tkb-rust-api-v216-bounded-fresh-no-agent`; public and local
  `phanmon.js` SHA-256 values matched at
  `EDBE09E2820AEB07632ED264633EEC3354CD49AA7DC793BC0F020D46F946442B`.

### v1.13 - 2026-07-17 (deployed)

- Removed the duplicated paired-pane `Da xep` and `Chua phan` statistics on
  mobile only. Desktop statistics remain unchanged, and the functional mobile
  `Chua phan` dropdown remains available for opening the unassigned list.
- Fixed the remaining iPhone bottom gap after rotation. iOS standalone can
  report a `visualViewport.height` that already excludes a safe area; using it
  as the body height while also applying safe-area padding subtracted the inset
  twice. The synchronized mobile height now uses the largest valid visual,
  inner, and layout viewport height.
- Portrait paired-pane toolbars use one 26px content row inside a 28px toolbar
  instead of reserving a second statistics row. Both timetable panes therefore
  split and fill all remaining height.
- Planner asset cache key: `20260717-mobile-full-height-v1`. `phanmon.js`
  marker: `updated-v7.4 (full mobile viewport after rotation)`. Scheduler
  bridge and Windows Agent remain unchanged.
- Full frontend verification passes 202/202 tests. The safe-area regression
  explicitly verifies that `visualViewport.height=862` does not shrink a
  956px iPhone layout viewport. A browser fixture using production CSS passed
  `440x956 -> 956x440 -> 440x956`: portrait bottom gap stayed 2px, both panes
  stayed 445px, both mobile statistics were hidden, and no console errors were
  emitted.
- Isolated VPS staging passed 100/100 scheduler tests, 56/56 Agent tests, and
  139/139 Rust tests with `STAGING_TESTS_OK`. Deployment completed with
  `UPDATE_OK`; public health returned `ok:true`, zero active/queued jobs, and
  6/6 available worker tokens. The served v7.4 JavaScript was byte-identical to
  local SHA-256
  `BF8B2A6F5D6A49D979C1F20423CCBE136C59A0902466AF601A1F6BC4E56D2FE1`.

### v1.12 - 2026-07-17 (deployed)

- Fixed iPhone standalone/mobile height drift after portrait-to-landscape-to-
  portrait rotation. `phanmon.js` now synchronizes
  `--tkb-mobile-viewport-h` from `visualViewport.height` on load, resize,
  pageshow, and repeated post-orientation settle points. Mobile `html`, body,
  and timetable sizing use that measured height with `100dvh` as fallback.
- The empty 40px mobile progress/status row is collapsed while idle and is
  restored only while progress or a non-empty status is visible. This removes
  the blank band between the command toolbar and timetable without hiding live
  solve feedback.
- Portrait class/teacher panes still split the remaining viewport equally and
  now keep a compact fixed second toolbar row with `Da xep` and `Chua phan` for
  each pane. Landscape keeps the same counters inline and fixed while each
  timetable body scrolls independently. Class unassigned-list access remains
  available.
- `pvClassStatsHTML` and `pvTeacherStatsHTML` both render `Da xep` and
  `Chua phan`; the optional teacher off-period warning follows those required
  counters so it cannot displace them.
- Planner asset cache keys: `20260717-mobile-viewport-stats-v1` for
  `phanmon.css` and `phanmon.js`. Scheduler bridge marker/cache remain v1.11:
  `tkb-rust-api-v215-observer-cancel-60-180` and
  `20260717-observer-cancel-60-180-v1`.
- Local frontend/UI verification passes 201/201 Node tests. A browser layout
  fixture using the real planner CSS passed the rotation sequence
  `440x956 -> 956x440 -> 440x956`: both portrait panes stayed equal at 445px,
  the timetable ended 2px above the viewport bottom before and after rotation,
  idle feedback stayed at 0px, both pane counters remained visible, and no
  console errors were emitted.
- Windows Agent remains `1.6.1`; scheduler/Agent code and package are unchanged.
- Isolated VPS staging passes 100/100 scheduler tests, 56/56 Agent tests, and
  139/139 Rust tests with `STAGING_TESTS_OK`.
- VPS deployment completed with `UPDATE_OK`. Public verification serves cache
  key `20260717-mobile-viewport-stats-v1`, `phanmon.js` marker `updated-v7.3`,
  and a byte-identical JS SHA-256 of
  `626071D94EE1AAA0EE2F05889E1F599473E8BF4D1EFF6B5DDD0E4D9C8EF4AA1B`.
  The scheduler bridge remains `tkb-rust-api-v215-observer-cancel-60-180`.
  Final health was `ok:true`, zero active jobs, zero queued jobs, and 6/6
  available worker tokens.
- The public Agent ZIP remains version `1.6.1`, 90,474,695 bytes, SHA-256
  `71EA8845569F8B878CDAC0D5BD35B2B1A821F255CEA368D18F17220E9899EF06`.

### v1.11 - 2026-07-17 (deployed)

- A second tab/device observing the same owner's canonical solve now exposes an
  enabled Stop action. Stop sends exactly one authenticated
  `POST /api/solve-cancel` with the canonical `solve_run_id`, aborts only the
  local observer poll, removes its pending ledger entry, and suppresses reload
  resurrection. The observer still never posts another solve or applies a
  result when its local timetable fingerprint differs.
- Automatic budgets are explicit again: a new timetable and a full rebuild
  after changed requirements each receive 60 seconds; a later refinement
  receives 180 seconds. No hidden retry raises these limits. A bounded fresh
  run under 120 seconds returns the first complete hard-valid timetable instead
  of spending its short budget on deeper optional optimization.
- Frontend bridge marker: `tkb-rust-api-v215-observer-cancel-60-180`; cache key:
  `20260717-observer-cancel-60-180-v1`.
- Windows Agent remains `1.6.1`; its public ZIP is unchanged.
- Local verification passes 175/175 frontend/UI tests, 100/100 scheduler tests,
  and 56/56 Agent tests. Packaged Agent acceptance on the 1,566-period fixture:
  normal first sort completed in 61.955 seconds; first sort with T.Tham limited
  to three days completed in 61.659 seconds; and a fresh rebuild after changing
  that requirement completed in 58.521 seconds. Every lane scheduled
  1,566/1,566 periods, was hard-valid, had zero application constraint
  violations, and the constrained lanes placed T.Tham's 18 periods on three
  days (`7 + 7 + 4`).
- Isolated VPS staging passes 100/100 scheduler tests, 56/56 Agent tests, and
  139/139 Rust tests with `STAGING_TESTS_OK`.
- Deployment completed with `UPDATE_OK`; state and release backups were kept,
  Rust rebuilt successfully, nginx validation passed, and services restarted.
  Public health returned `ok:true`, zero active jobs, zero queued jobs, and all
  six worker tokens available.
- Public verification served bridge marker
  `tkb-rust-api-v215-observer-cancel-60-180` and cache key
  `20260717-observer-cancel-60-180-v1`. The served bridge and `phanmon.js`
  SHA-256 hashes exactly matched the local release files.
- The public Agent ZIP remains 90,474,695 bytes with SHA-256
  `71EA8845569F8B878CDAC0D5BD35B2B1A821F255CEA368D18F17220E9899EF06`;
  it contains only the 90,961,672-byte `TKBCherryAgent.exe` and exactly matches
  the local `1.6.1` artifact.
- A live authenticated two-tab cancellation was not launched after deployment
  because the available automation browser session was signed out. The
  production files are byte-for-byte identical to the 175/175 frontend/UI
  suite inputs, including the regression proving that Stop on an observe-only
  device cancels the canonical owner job exactly once.

### v1.10 - 2026-07-16 (deployed)

- A second browser/device signed into the same owner and `sid` now observes the
  canonical server job even when its local timetable fingerprint differs. The
  observer is GET-only: it never POSTs another solve, cancels the owner job, or
  applies the result to its different local DATA. It locks Play while the job is
  active but does not expose Stop. If its hydrated fingerprint later matches,
  it may resume the normal result-owning path.
- Manual-only behavior is preserved. Discovery/reload only polls owner state;
  editing requirements or opening another browser never starts a solve.
- Frontend bridge marker: `tkb-rust-api-v214-cross-device-observer`; cache key:
  `20260716-cross-device-observer-v1`.
- Windows Agent is now `1.6.1`. The GUI build includes Tcl/Tk, supports a real
  `--gui-smoke`, and a newly launched copy stops the older installed process
  tree before atomically replacing and relaunching it. An identical installed
  binary is reused without killing or copying it.
- The release uses exactly one UPX 5.2.0 layer (`--best --lzma --force`) followed
  by `upx -t`, a real Tk GUI smoke, and a packaged `--solver-child` smoke. UPX is
  compression/light obfuscation, not a claim of absolute source protection. The
  packaged solver runtime contains optimized bytecode rather than loose `.py`
  source files.
- `build_windows.ps1` no longer uses the `ProcessStartInfo` encoding properties
  absent from Windows PowerShell 5.1. Its packaged solver smoke request is ASCII;
  production-size acceptance continues to send request JSON as raw UTF-8 bytes.
- Prepared Agent artifacts:
  - EXE: 90,961,672 bytes, SHA-256
    `A89F1E142BF2E9CC07BFF4F58BEDE96DC286749CA8C59AD4A955FEBAE9411D47`.
  - One-entry ZIP: 90,474,695 bytes, SHA-256
    `71EA8845569F8B878CDAC0D5BD35B2B1A821F255CEA368D18F17220E9899EF06`.
  - ZIP contains only `TKBCherryAgent.exe`; file/product metadata are `1.6.1`.
- Local verification: 175/175 frontend/UI tests, 56/56 Agent tests, and 100/100
  scheduler tests pass. The frontend total includes 142/142 bridge tests and the
  cross-device contract checks for POST=0, cancel=0, and unchanged observer DATA.
- The actual UPX-packed EXE passed the 1,566-period T.Tham max-three-days case in
  210.572 seconds: 1,566/1,566 scheduled, zero unassigned, hard-valid, zero app
  constraint violations, and all 18 T.Tham lessons on exactly three days
  (`7 + 7 + 4`).
- Isolated VPS staging passed `100/100` scheduler tests, `56/56` Agent tests,
  and `139/139` Rust tests with `STAGING_TESTS_OK`.
- Deployment completed with `UPDATE_OK`; the update script drained active work,
  kept state/release backups, rebuilt Rust, validated nginx, and restarted the
  services. Public health returned `ok:true`, `solverActiveJobs=0`,
  `solverQueuedJobs=0`, and six available worker tokens.
- Public verification served the bridge marker and cache key above, the Agent
  link `1.6.1`, and a ZIP of 90,474,695 bytes with SHA-256
  `71EA8845569F8B878CDAC0D5BD35B2B1A821F255CEA368D18F17220E9899EF06`, exactly
  matching the local release artifact.
- A live two-browser solve was not launched after deployment because the
  available browser session was signed out; do not automate around that login.
  The cross-device contract suite still passed all observer assertions, and
  production health confirmed no duplicate or leftover jobs.

### v1.9 - 2026-07-16 (deployed)

- Replaced the old blank-field 60-second first-sort and 180-second refinement
  ceilings with one complete-first convergence search. The backend may search
  for up to 1,800 seconds, but normally stops earlier when its search phases
  converge. The 1,800-second value is an orphan-process watchdog, not a quality
  target; extra time is available for difficult quality probes.
- A normal automatic request is strict: `require_complete_schedule=true`,
  `best_effort_on_timeout=false`, and `ui_allow_short_backend_deadline=false`.
  An incomplete timetable is never accepted just because the safety ceiling was
  reached. Explicit custom durations and the small staged-repair probe retain
  their separate short-deadline behavior.
- The first-click flow reserves up to 70 seconds to obtain a complete hard-valid
  incumbent, then continues quality work. For production-size timetables it
  tightens the proven incumbent by two teacher sessions. That optional tighter
  cap now has a 120-second convergence ceiling and stops after two consecutive
  Benders slices without improvement, including no-solution, rejected-period,
  and strict-quality-miss slices. A difficult optional cap can never consume the
  1,800-second orphan watchdog after a complete incumbent already exists.
- Manual-only and single-flight behavior is unchanged: editing requirements does
  not start a solve, one click owns one server job, and browsers/Agent/VPS adopt
  the same canonical job instead of computing duplicates.
- Fixed-lesson session capacity is no longer subtracted twice in
  `session_milp.py`. `session_cp_sat.py` models the cross-session rule prohibiting
  morning period 5 and afternoon period 1 for the same teacher, including fixed
  lessons. Candidate validation now uses the canonical Python validator before
  the VPS accepts a constrained Agent result.
- Rust API source marker:
  `tkb_new-rust-api-2026-07-16-agent-reference-validation-v25`.
  Frontend marker: `tkb-rust-api-v213-bounded-quality-convergence`; cache key:
  `20260716-bounded-quality-convergence-v1`.
- Packaged Agent v1.6.0 artifacts:
  - EXE: 87,699,056 bytes, SHA-256
    `01E9137F2F293927EFFE8A3B01733C036A93199B7B6F0EFEE623DC7DB46EDCC9`.
  - One-entry ZIP: 87,146,752 bytes, SHA-256
    `BDB78695078DA77192471021AC0394C0AED569FB28928DF5223F3186D1A03D61`.
  - File/product metadata and source `--version` are `1.6.0`; the ZIP contains
  only `TKBCherryAgent.exe`.
- Acceptance used the actual packaged EXE with UTF-8 bytes, never a source-only
  shortcut:
  - `default`: 1,566/1,566, hard-valid, zero violations, all 54/54 fixed
    lessons preserved, 478 teacher sessions, zero one-period sessions, 50 gap-1
    sessions, 217.665 seconds.
  - `d8f7b12caf1`: 1,566/1,566, hard-valid, zero violations, all 108/108 fixed
    lessons preserved, 478 teacher sessions, zero one-period sessions, 45 gap-1
    sessions, 196.469 seconds.
  - First sort with `T.Tham.maxDays=3`: 1,566/1,566, 18/18 T.Tham periods on
    exactly three days (`7 + 7 + 4`), hard-valid, all 54/54 fixed lessons
    preserved, 479 teacher sessions, zero one-period sessions, 211.477 seconds.
  - Changed-requirement fresh fallback with `T.Tham.maxDays=3`:
    `1,566/1,566`, 18/18 periods on exactly three days (`7 + 7 + 4`),
    hard-valid, all 54/54 fixed lessons preserved, 478 teacher sessions, zero
    one-period sessions, 202.370 seconds.
- A pre-fix packaged-EXE probe reproduced the runaway: it was manually stopped
  after 533.392 seconds. Three older orphan Python probes were also found and
  terminated. The final four acceptance lanes above each converged below 218
  seconds and used a 360-second external test guard.
- Current local verification: 173/173 frontend/UI tests, 53/53 Agent tests,
  100/100 scheduler tests, and 7/7 launcher/deploy tests pass. Isolated VPS
  staging passed 100/100 scheduler, 53/53 Agent, and 139/139 Rust tests with
  `STAGING_TESTS_OK`. Acceptance used the actual packaged EXE and raw UTF-8
  request bytes.
- Deployment completed with `UPDATE_OK`. Production smoke returned `ok:true`,
  zero active/queued jobs, 6/6 free worker tokens, frontend marker
  `tkb-rust-api-v213-bounded-quality-convergence`, and cache key
  `20260716-bounded-quality-convergence-v1`. The public Agent ZIP size/hash
  exactly matched the packaged artifact above.
- The currently running installed Windows Agent at
  `C:\TKBCherryAgent\TKBCherryAgent.exe` was intentionally not stopped or
  overwritten during deployment. It still reports v1.5.0 and the prior release
  hash. The public download is v1.6.0; launching that new EXE performs the
  in-place update after the old Agent is stopped once.

### v1.8 - 2026-07-16

- Fixed a production-confirmed violation of the manual-only solve contract.
  Reloading a tab with a pending job that the same tab originally created could
  call the full solve path and POST `/api/solve-data` again after the previous
  result had completed. Access logs showed repeated automatic POSTs even though
  the user had not pressed Play.
- Resume mode is now strictly poll-only for every known pending job, whether it
  was discovered from another browser or created locally before reload. It may
  GET owner state/result and apply the canonical result, but may never POST.
- If resume has no pending job, it exits before network access. If the pending
  fingerprint no longer matches the timetable, it detaches locally instead of
  cancelling or recreating server work. Normal manual Play is unchanged.
- Frontend bridge marker: `tkb-rust-api-v208-resume-poll-only`; cache key:
  `20260716-resume-poll-only-v1`.
- Regressions explicitly verify `POST=0` for a locally-created pending job after
  reload and `network=0` when resume has no known server job. Frontend result:
  141/141 bridge tests, 20/20 toolbar tests, and 12/12 constraint tests.
- Deployment completed with `UPDATE_OK`. Public verification served bridge
  `tkb-rust-api-v208-resume-poll-only` and cache key
  `20260716-resume-poll-only-v1`; health returned `ok:true`, zero active jobs,
  and zero queued jobs.

### v1.7 - 2026-07-16

- Fixed the changed-requirement repair path when a staged backend candidate
  claims a complete timetable but fails the UI's real constraint validation.
  The concrete production symptom was backend `1566/1566`, followed by the UI
  releasing T.Tham's four-period overflow day and rejecting `1562/1566`.
- `applyPayload()` now rejects a backend-complete candidate contract when UI
  validation releases/rejects lessons, leaves violations, produces incomplete
  visible metrics, or fails UI hard validation. Diagnostics are bounded and
  retain rejected/released counts, up to 16 released cells, up to eight
  violation summaries, backend/applied metrics, and scalar runtime settings.
- Only a changed-requirement staged repair catches that contract error. It
  restores the post-release snapshot and runs exactly one 60-second fresh
  rebuild with `preserve_existing_tkb=false`, no solver warm start, and no
  flexible incumbent cells. A normal first sort still has no added retry.
- If the fresh rebuild also fails, the manual Play transaction still restores
  the exact pre-click timetable through `restoreFailedConstraintRepairSnapshot`.
- Frontend bridge marker: `tkb-rust-api-v207-ui-contract-fresh-fallback`.
  Served cache key: `20260716-ui-contract-fresh-fallback-v1`.
- Regression coverage includes a staged response that falsely reports 7/7
  while GV01 spans four days under `maxDays=3`; the UI rejects it, exactly one
  fresh request follows, both requests retain the rule, the fresh request has
  no flexible timetable, and the accepted result is 7/7 on three days.
- Pre-deploy verification: 139/139 bridge tests, 20/20 toolbar tests, 12/12
  constraint tests, 81/81 Python solver contract tests, and 118/118 Rust tests.
- Production-size Agent probe: 1,566/1,566 scheduled, zero unassigned,
  `hard_ok=true`, and T.Tham on exactly three days. Wall time including packaged
  Agent startup was about 63.6 seconds for the 60-second solver budget.
- Deployment completed with `UPDATE_OK`. Both acceptance tabs served bridge
  `v207` and cache key `20260716-ui-contract-fresh-fallback-v1`; public health
  returned `ok:true`, API marker `cross-device-job-lock-v24`, zero queued jobs,
  and zero active jobs after completion.
- Production acceptance observed exactly one server job while both tabs showed
  the same solve in progress (`solverActiveJobs=1`, `solverQueuedJobs=0`). The
  active tab consumed the result with zero unassigned periods and no red error.
  The in-app browser suspended the background tab's JavaScript timer at an old
  progress frame; reload/wakeup recovered the already completed canonical
  result without creating another job. Both tabs then showed zero unassigned,
  T.Tham with all 18 periods on exactly three day columns, enabled Play, no
  error, and the duration input restored to automatic/blank.
- Follow-up access-log inspection found that the initial and later passive page
  reloads still emitted solve POSTs. Server single-flight kept them to one
  compute job, but automatic POST itself violated product behavior. This is
  superseded by the v1.8 poll-only resume fix above.

### v1.5 - 2026-07-16

- Fixed the server/Agent completion race on an async solve. When the local VPS
  solver returns a failure just before an online Agent uploads a hard-valid
  candidate, the server now waits only through the remaining bounded watchdog
  reserve (capped at 12 seconds) and chooses the validated Agent result if it
  arrives. A VPS-only failure still returns at the original deadline.
- Added `has_active_lease` coordination and a Rust regression for a late Agent
  candidate replacing a failed local result. Rust API tests: 116/116 passed.
- Rust API marker: `tkb_new-rust-api-2026-07-16-agent-candidate-grace-v23`.

### v1.6 - 2026-07-16 (prepared)

- Prevents duplicate timetable solves across tabs, browsers, and the Windows
  Agent/VPS path. Every async solve carries a normalized schedule scope derived
  from the current `sid`; the server reuses the canonical job for that scope
  when the fingerprint is the same and returns `solver_schedule_busy` when a
  different request tries to run concurrently.
- Anonymous/public pages may discover only a matching server job (same scope and
  durable schedule fingerprint). A page with an authenticated job waiting for
  identity hydration remains isolated until its owner session is available.
- Manual **Xep** checks shared server state before posting. A matching live or
  completed job is adopted; a different live job is shown as busy and no second
  solver thread is started.
- Added Rust regressions for changed-fingerprint same-scope posts and frontend
  regressions for anonymous discovery and manual duplicate blocking.
- Frontend bridge marker: `tkb-rust-api-v205-cross-device-job-lock`.
- Rust API marker: `tkb_new-rust-api-2026-07-16-cross-device-job-lock-v24`.
- Verification before deployment: 137/137 bridge tests, 20/20 toolbar tests,
  12/12 constraint tests, and 118/118 Rust tests on the VPS.

### v1.4 - 2026-07-16

- Fixed the browser-side server-owned job wait that could remain at 99% for
  tens of minutes after a nominal 60-second solve. The default FIFO wait is now
  180 seconds, active/pending waits are bounded, only one FIFO deadline
  extension is allowed, and a result-wait timeout cancels and consumes the
  pending job instead of replaying it indefinitely.
- Pending browser jobs older than ten minutes are retired as settled. This
  prevents an old 6-hour reconnect ledger from restarting a stale progress
  clock after reload. Short transport detach/reconnect behavior remains.
- Windows Agent cancellation now uses `taskkill /T /F` on the solver PID before
  closing the Job Object. This closes a containment gap where a solver
  grandchild could briefly survive cancellation and keep inherited pipes open.
- Fixed-lesson preprocessing now releases duplicate fixed class/teacher/room
  resource locks back into residual demand instead of making every downstream
  model infeasible. Benders rejection history records hard-validation counts,
  scheduled/unassigned accounting, and compact resource conflicts.
- Important diagnostic rule: never pipe the UTF-8 production request through
  Windows PowerShell text output when reproducing the solver. That conversion
  replaced Vietnamese characters with `?` and made distinct names such as
  `T.Hong` variants collide. Feed `current-agent-repro-request.json` to the
  subprocess as raw bytes.
- Raw-byte production-size verification returned 1,566/1,566 scheduled,
  zero unassigned, `hard_ok=true`, and zero teacher-slot conflicts.
- The packaged `TKBCherryAgent.exe --solver-child` was also verified against
  the same raw UTF-8 production request: HTTP-style status 200, 1,566/1,566
  scheduled, zero unassigned, `hard_ok=true`, and zero teacher conflicts.
- Agent v1.3.0 release artifacts:
  - EXE: 90,557,098 bytes, SHA-256
    `4D9E1A143D4042127D0DE88E74F976F10087AF0A87E4A28EA1387C7780B06B72`.
  - Public ZIP: 89,969,292 bytes, SHA-256
    `2FA23B9603F49139BD4483E9895F4C55CBEBE0407B288F326EF891B304D68407`.
- Verification before packaging: 168/168 relevant frontend tests, 81/81
  backend contract tests, and 53/53 Agent tests passed.
- Frontend bridge marker: `tkb-rust-api-v204-bounded-server-wait`; served cache
  key: `20260716-bounded-server-wait-v1`.
- Deployment and final package hashes are recorded below after the v1.5 build.

### v1.3 - 2026-07-16

- The packaged Windows Agent now relocates itself on first GUI launch to
  `C:\TKBCherryAgent\TKBCherryAgent.exe`, then starts the relocated copy.
- If the system drive is not writable, it falls back to
  `%LOCALAPPDATA%\TKBCherry\Agent\` without requesting Administrator access.
- Headless diagnostics (`--check`, `--once`, `--solver-child`, `--version`) and
  source runs never relocate. The startup registry entry is created by the
  relocated process, so it points to the stable executable path.
- During the first migration, an older Agent process must be closed once so the
  new copy can acquire the shared per-user single-instance lock.
- Opening a newer downloaded EXE over a stopped installed copy is an in-place
  update: the new file replaces the installed EXE atomically before relaunch.
- Agent regression result: 53/53 tests passed. The public ZIP was rebuilt as a
  one-entry archive containing only `TKBCherryAgent.exe`; both file and product
  metadata report `1.2.0`.
- Release EXE SHA-256:
  `8A3AB53CEED2A609C29ED39B039954110FCB7F9339DD63CB18977BAC03D61818`.
- The v1.3 package was deployed with `UPDATE_OK`; the public ZIP is
  `89,965,518` bytes and has SHA-256
  `608AB7D2655D7B505CDBCEF0B37EE425D6A692A863D7611B606BEBFB3A24BE73`.
- Post-deploy health returned `ok:true` with zero active and zero queued solver
  jobs.
- UPX 5.2.0 refused the new Control Flow Guard-enabled PE unless forced. The
  release intentionally remains unpacked so packaging does not disable this
  Windows exploit mitigation merely for obfuscation/compression.

### v1.2 - 2026-07-16

- A manual **Xếp** click now checks Agent status before starting. On a supported
  Windows desktop with a red/offline Agent, the user can download Agent and stop
  that sort, or explicitly continue with the VPS.
- Background job recovery and non-user-triggered solver calls do not show the
  Agent invitation.
- Frontend regression result: 168/168 relevant tests passed.
- Deployed successfully with `UPDATE_OK`. Public health returned `ok:true`, the
  served page used both `20260716-agent-offline-invite-v1` cache keys, and the
  served bridge exposed `tkb-rust-api-v203-agent-offline-invite`.
- Public browser verification used a red/offline Agent. A manual Play click was
  held by the confirmation before sorting; the automation then dismissed the
  confirmation (the VPS choice), after which the test run was stopped before
  backend admission. Health confirmed zero active and zero queued solver jobs.

### v1.1 - 2026-07-16

- Packaged Agent includes the solver candidate validation fix for teacher
  constraints and is ready for Windows distribution.
- This version label is the reference for the Agent package and deployment
  notes; frontend cache markers may continue to use their own scoped markers.

## Local Transactional Benchmark Audit (not deployed)

- `tools/benchmark-unified-solver.js` now models the manual-click transaction
  without releasing visible lessons in the UI. The real `K.Phát maxDays=3`
  case retains all `1,566` incumbent periods (`54` hard-fixed + `1,512`
  flexible), records one actual preflight violation, sends staged fill first,
  and prepares at most one 60-second fixed-only fresh fallback.
- The full local `default` run returned staged `409`, then exactly one fresh
  fallback completed `1,566/1,566` in about 56.7 seconds. Canonical Python
  revalidation passed with zero malformed/unassigned lessons and zero app
  constraint violations. Planning left both the schedule fingerprint and exact
  four-field snapshot hash unchanged.
- The deterministic four-missing case removes four flexible lessons from
  `L026`/`8/1`, retaining `1,562/1,566`, all `54` fixed lessons and `1,508`
  flexible lessons. The binary-safe Python reference run (`--reference-run`)
  filled all four in about 2.5 seconds and passed canonical validation. This
  flag changes only the executor selector from Rust-native to Python-reference;
  the persisted production wire request remains unchanged.
- `tools/solver-stdio-runner.js` sends and receives raw UTF-8 buffers without a
  shell, parses the one-frame solver protocol strictly, and always validates
  benchmark candidates through `solve_stdio.py validate-candidate`. The
  generated evidence now preserves strings such as `Khối 8` exactly.
- A bridge lifecycle regression starts from a complete but violating incumbent,
  forces staged and fresh failure, asserts exactly two solver POSTs, then
  deep-compares `tkb`, teacher/room maps, and compact solver result after
  rollback while confirming the edited max-days rule remains. Focused tests pass
  benchmark tooling `6/6` and transactional lifecycle `2/2`.

## Product Behavior That Must Be Preserved

- Editing a requirement must never start the solver automatically. Solving starts
  only when the user presses **Xếp**.
- The duration input belongs exclusively to the user and must never be
  auto-filled. A blank fresh or changed-requirement rebuild has a hidden
  60-second safety ceiling; a complete-incumbent refinement has a hidden
  180-second ceiling. Both may stop early when search saturation or a strong
  usable result is reached. A failed fresh/rebuild click records a
  fingerprint-scoped five-second increase for the next manual click without
  filling the input. There is no automatic retry. Every attempt requires another
  user click and creates exactly one canonical job. An explicit user duration
  wins.
- When a completed timetable violates a newly edited requirement:
  1. Snapshot the exact pre-click timetable.
  2. Keep the visible timetable intact and send it as a soft incumbent.
  3. Inside the backend transaction, release the smallest useful non-fixed
     group, preferably the day/session with the fewest lessons, then try a
     bounded light repair that keeps most of the timetable.
  4. If repair is incomplete or invalid, rebuild from an empty flexible timetable
     while keeping fixed lessons and the new requirements.
  5. If the whole click fails, restore the exact pre-click timetable. Never leave
     the user with a progressively deleted timetable.
- A complete hard-valid timetable is more important than cosmetic quality targets.
  One-period teacher sessions and teacher gaps are optimization quality, not a
  reason to claim that an otherwise valid timetable is impossible.
- Teacher counters use PCCM demand as the total and actual timetable cells as the
  assigned count:
  - PCCM total 18, scheduled/fixed 1 => `Đã xếp 1`, `Chưa xếp 17`.
  - PCCM total 18, scheduled 18 => `Đã xếp 18`, `Chưa xếp 0`.
- The teacher-requirement tables show one column named **Số tiết**. Do not bring
  back separate Sáng/Chiều count columns unless the user explicitly requests it.

## Current Scheduler Flow

Primary frontend bridge: `web/pages/tkb-rust-bridge.js`.

- `window.sapXepTuDongAll()` owns the manual-click lifecycle.
- It snapshots the schedule and validates current constraints, but never calls
  `releaseConstraintViolatingLessons()` before a solve. The request carries the
  complete incumbent and `ui_skip_pre_solve_constraint_release=true`.
- `buildConstraintRepairAutoSortPlan()` creates the light-repair request.
- `solveStagedExistingRepair()` performs one staged fill. An incomplete or invalid
  result uses `stagedExistingFreshRetrySettings()` for a full rebuild.
- `_release_invalid_fixed_lessons()` performs the smallest flexible aggregate
  release inside the backend copy and receives hard fixed lessons as protected
  context. It never clears the whole incumbent merely because a violation lacks
  a precise cell selector.
- Fresh requests pass through `dataForSolverRequest()`. Flexible timetable cells
  must be stripped; only fixed lessons and valid must-teach anchors remain.
- `restoreFailedConstraintRepairSnapshot()` restores the pre-click schedule when
  no acceptable result is returned.
- Server-owned requests include `ui_schedule_scope` from the current `sid`.
  `SolverPool` treats that scope as a single-flight lock, so a second browser
  adopts the existing job or receives `solver_schedule_busy`; it must never
  create a parallel solve for the same timetable.

Primary backend scheduler: `solver_runtime/src/tkb_new/adapter.py`.

- Session allocation uses OR-Tools CP-SAT, with MILP/period allocation and Benders
  fallbacks where applicable.
- Constraint validation is also implemented in
  `solver_runtime/src/tkb_optimizer_ref/validate.py`.
- Teacher max-days is stored at
  `tkbConstraints.teacher[teacherId].maxDaysSessions.maxDays`.
- The session CP-SAT constraint is in
  `solver_runtime/src/tkb_optimizer_ref/session_cp_sat.py`.
- Tight teacher day/session rules can activate the period-feasibility bridge via
  `_constraints_need_period_feasibility_bridge()` in `adapter.py`. This can make a
  60-second solve substantially heavier, so treat deadline failures as timeout,
  not proof of infeasibility.

## Recent Fixes

### Transactional constraint repair

- `web/pages/tkb-rust-bridge.js` version marker:
  `v202-transactional-constraint-repair`.
- Fresh first sort is one bounded run.
- A failed light repair automatically performs one full fresh rebuild with the
  edited constraints.
- The fresh fallback does not send old flexible timetable cells.
- Failure restores the exact schedule snapshot.

### Teacher requirement table

- `web/pages/tkb-constraints.js` version marker:
  `constraints-ui-v32-teacher-assigned-total`.
- The table contains one **Số tiết** value sourced from PCCM assignment demand.

### Teacher counters

- `web/pages/phanmon.js` now derives teacher demand from deduplicated
  `requiredSubjectsForClass()` rows instead of `computeMonsForClass()`.
- Scheduled counts no longer inflate the expected total.
- `web/pages/sapxep.html` currently cache-busts this as
  `phanmon.js?v=20260716-teacher-count-dedup-v2`.

### Verification

The relevant frontend suite passed 168/168 tests:

```powershell
node --test e2e_tests/tkb_rust_bridge_node.test.js
node --test e2e_tests/planner_toolbar_layout_node.test.js
node --test e2e_tests/planner_subject_limit_semantics_node.test.js
```

The counter regression explicitly verifies total 18 and assigned 1, resulting in
17 unassigned periods.

Backend solver contract tests:

```powershell
agent_helper\.build-windows\venv\Scripts\python.exe -m unittest `
  solver_runtime.tests.test_solver_result_contract
```

Current result: 80/80 backend tests and 168/168 relevant frontend tests pass.

## Resolved: Edited Max-Days Requirement

User report: a timetable previously sorted successfully, then a teacher is limited
to four teaching days. Capacity still appears sufficient, but the app sometimes
reports that it cannot find a complete timetable.

Reproduction run on 2026-07-16 used the stored 1,566-period production-size request
and added `P.My.maxDaysSessions.maxDays = 4`:

- Period bridge enabled: 1,566/1,566, hard-valid, teacher on four days, about 63.7s
  wall time.
- Period bridge disabled: 1,566/1,566, hard-valid, teacher on four days, about 56.1s
  wall time.

This proved that the example constraint was feasible. The false failure came from
`_solve_unified_first_click_feasibility_then_quality()` treating two quality goals
as mandatory during a constraint-change rebuild: zero one-period teacher sessions
and zero teacher gaps of two or more periods. Those are optimization targets, not
hard timetable constraints.

Fix in `solver_runtime/src/tkb_new/adapter.py`:

- A request marked `ui_constraint_change_fresh_retry` or
  `ui_constraint_change_rebuild_from_empty` now accepts the first complete,
  hard-valid schedule even when it still has teacher-quality debt.
- Fixed lessons and every edited hard constraint remain mandatory.
- The strict-quality phase still tries to reach zero debt when enough time remains.
- Local LNS improvements are retained incrementally even if they improve quality
  without reaching zero in one pass.
- Normal first-run behavior is unchanged; the relaxation applies only to the
  full rebuild caused by edited constraints.

Post-fix production-size probe with the same 1,566 periods and four-day limit:

- 1,566/1,566 scheduled, 0 unassigned, `hard_ok=true`.
- `P.My` teaches on exactly four days.
- Completed in about 54.3 seconds.
- The remaining-time optimizer reduced one-period teacher sessions from 36 to 25
  and teacher sessions from 522 to 517 instead of discarding the valid timetable.

Regression coverage includes a real CP-SAT case where one teacher has exactly one
weekly lesson. The constraint-change rebuild must return the valid 1/1 timetable
instead of reporting infeasibility merely because that one-period session cannot
be eliminated.

### Follow-up: T.Tham limited to three days

The public browser test on 2026-07-16 reproduced a separate bounded-search
failure with `T.Tham.maxDaysSessions.maxDays = 3`. The UI correctly restored the
pre-click fixed-only timetable, but the backend returned
`Benders teacher-session cap search failed` after two period-infeasible session
vectors. The full period-feasibility session model was enabled only on iteration
three, when approximately four seconds remained, so CP-SAT returned `UNKNOWN`.

Fix in `solver_runtime/src/tkb_new/adapter.py`:

- A fresh rebuild caused by an edited constraint now enables the all-session
  period-feasibility envelope on the first Benders vector.
- A first/incomplete sort with an already-persisted period-sensitive rule (for
  example teacher max-days below six) also enables that envelope. This covers
  recovery after an older failed rebuild left only fixed lessons and the next
  click no longer carries the transient constraint-change flag.
- Normal first sorting still starts with the lean session model, so this does not
  add the larger model to first runs without period-sensitive requirements.
- At that deployment the click was still a single 60-second bounded run and
  hard-valid completeness remained the acceptance requirement. The duration
  policy is superseded by the v1.9 adaptive complete-first contract above.

Production-size local verification on the stored 1,566-period request completed
in about 56.5 seconds: 1,566/1,566 scheduled, zero unassigned, `hard_ok=true`, and
T.Tham taught on exactly three days. The same fixed-only request also completed
without any transient constraint-change flags. Contract regressions verify both
the changed-requirement lane and the persisted tight-rule first-sort lane.

Historical public browser verification for the earlier 60-second deployment:

- Started from the persisted fixed-only state (54 fixed lessons, the rest
  unassigned) with T.Tham already limited to three days.
- One manual 60-second click completed with 1,566 assigned and zero unassigned.
- T.Tham showed 18 assigned, zero unassigned, and lessons only on days 2, 3, and
  4 (exactly three teaching days).
- No new browser console error was emitted. The Windows Agent was disconnected,
  so this run exercised the deployed VPS solver directly.

The historical `.codex_tmp` diagnostic artifacts were removed during the
2026-07-18 workspace cleanup. Their relevant metrics are preserved in this file
and in permanent regression tests.

## Local Workspace Cleanup

- On 2026-07-18 the local tree was reduced from about 3.0 GiB to about 295 MiB
  (309,663,014 bytes), without removing application source, school data, or
  the published Agent package.
- Removed reproducible/generated content: old `.codex_tmp` diagnostics and
  dependency copies, Agent build work/venv, the internal onedir Agent
  bundle/archive, the 456 MiB Cargo target cache, solver logs, Python/test
  caches, and transient E2E logs. `mail-server/node_modules` was also removed
  and is regenerated with `npm ci` when local mail development is needed.
- Preserved the signed Agent 1.6.8 EXE/ZIP/manifest in `agent_helper/dist`, the
  published Agent download in `web/downloads`, `start.exe`, both old root RAR
  archives, all source/test fixtures, and the minimal local Rust runtime
  (`rust_api/target-gnu/release/tkb_rust_api.exe` plus `sqlite3.dll`).
- `.codex_tmp/release-venv` was removed after staging/deployment. `.agents` and
  the protected empty `.pytest_cache` directory are small Codex-managed paths
  and could not be removed by the current Windows account, so they are left
  alone.
- `.gitignore` excludes generated build/cache/log paths so they do not silently
  return. There is no system `cargo` on `PATH`; Rust changes must be compiled
  and tested during VPS staging before deployment. Recreate local Python
  tooling with `scripts/setup.ps1` (or a venv containing `paramiko`, `pytest`,
  and the solver requirements) before the next test/deploy session.

## Deployment Package Hygiene

- The deployed infrastructure now separates production and VPS
  staging archives. Production is an explicit runtime allowlist containing only
  `web`, the Rust API build/source and live sample fixture, the Python solver and
  its hint data, the mail server runtime files, and `solver-pool.conf`. Staging
  adds only the Agent and solver test sources needed by `stage-tests.py`. The
  inspected production archive is about 93,561,154 bytes with 107 members
  across five top-level runtime directories; staging is about 93,670,943 bytes
  with 150 members.
- Full and update deployment explicitly request the production profile;
  `stage-tests.py` explicitly requests staging. The full-install path now passes
  its unique upload directory through `TKB_DEPLOY_UPLOAD_DIR`, fixing the stale
  hard-coded `/tmp/cherry-upload/` source.
- A successful deployment removes stale `target-gnu`, solver logs, Cargo debug
  and dependency build products while retaining
  `rust_api/target/release/tkb_rust_api`. Persistent databases, mail credentials,
  Node runtime dependencies, and the public Agent download remain protected.
- Release archives no longer duplicate the roughly 92 MB Agent ZIP and manifest.
  The pre-update pair is held in a transaction-local temporary directory and is
  restored if that update rolls back. Successful updates delete the temporary
  pair. Backup retention keeps the newest 10 app releases and 30 state archives,
  always preserves the current transaction backups, and never deletes archives
  whose filename contains `manual`.
- Verification passes deployment/package tests `25/25`, all scheduler/Agent
  suites, Python syntax checks, and remote Ubuntu `bash -n` checks for both
  server scripts. Production deployment returned `UPDATE_OK`; remote inventory
  is about 104 MiB with 785 files, with no Cargo target or solver log tree.

## VPS And Deployment

- Hostname: `TDC-260709270`
- Public IP: `165.101.47.133`
- SSH user: `root`
- Non-secret connection config: `tools/vps-deploy/vps-config.json`
- Password store: `%LOCALAPPDATA%\TKBCherry\secrets\vps-password.dpapi`
  (Windows DPAPI CurrentUser, deliberately outside the repository)
- Public site: `https://tkbcherry.com`
- Public scheduler: `https://tkbcherry.com/pages/sapxep?sid=default`
- Public health check: `https://tkbcherry.com/api/health`
- Application directory on VPS: `/opt/cherry-scheduler`
- Main service: `tkb-app`

Full pre-v1.9 VPS snapshot created on 2026-07-16:

- Local destination: `C:\Users\Love\Documents\Codex\TKB`
- Source: complete live `/opt/cherry-scheduler` tree, with symlink targets
  materialized for a usable Windows copy.
- Verified extraction: 3,680 files, 855,051,960 bytes. The 300,270,390-byte
  transfer archive was size-checked before extraction and removed afterward.
- Reusable command: `tools/vps-deploy/backup-full.py --destination <empty-dir>`.
  It prompts at runtime when `TKB_VPS_PASSWORD` is absent and never stores the
  password.

The VPS password must never be committed or written to this file. Save it once
for the current Windows user with a hidden secure prompt:

```powershell
powershell -ExecutionPolicy Bypass -File tools\vps-deploy\save-vps-credential.ps1
```

`vps_credentials.py` resolves `TKB_VPS_PASSWORD` first, then the DPAPI store.
All VPS entrypoints use this shared resolver: staging, update/full deploy,
backup, Rust test, auth check, diagnostics, and service repair. Host/user
environment variables remain optional overrides.

Update deployment from the repository root:

```powershell
python tools\vps-deploy\update-deploy.py
```

Use a local virtual environment with `paramiko`/`pytest` before running the
command; the disposable `.codex_tmp\release-venv` used for v1.26 was removed
after deployment.

Deployment is not complete until output contains `UPDATE_OK`. The update script
drains active solver jobs, uploads a package, installs dependencies, rebuilds the
Rust service, validates nginx, restarts services, and keeps server/release backups.

After every deploy, verify:

```text
GET https://tkbcherry.com/api/health
GET https://tkbcherry.com/pages/sapxep?sid=default
```

Also verify the served cache key and the relevant version marker inside each
changed JS asset. Ask the user to press `Ctrl + F5` after a frontend deployment.

Latest successful deployment marker observed on 2026-07-19: `UPDATE_OK` for
v1.38. Public health serves API marker
`tkb_new-rust-api-2026-07-19-incumbent-refinement-v38`; the page serves cache
key `20260719-v138-incumbent-refinement-v1`. Public Agent release `1.6.15` and
its signed manifest are live. Its one-entry ZIP is 91,683,250 bytes with
SHA-256 `a91ff1217990cf8b80e7b07f2f4e203f849c7ba794db60942b39789dd30ee5b2`;
the packaged EXE is 92,148,649 bytes with SHA-256
`5650ef4b0d65e43f866db5f455f36e735d9adf2f20145878e9feed8729140b99`.
The v1.38 production VPS-only E2E reloaded the browser during the canonical
job and still completed with zero unassigned periods, no duplicate job, and
all worker tokens released. The Agent E2E then kept VPS capacity fully free,
used one local solver child, and exited that child after retaining the best
complete incumbent.
Workstations on Agent `1.6.2` or older require one manual install of a
self-update-capable build before future in-Agent updates are available.

## Security And Repository Notes

- Never place VPS passwords, auth tokens, cookies, or bearer tokens in source,
  logs, diagnostics, or this handoff.
- No certificate with both a private key and the Code Signing EKU was visible in
  the Windows certificate stores during the v1.10 build. When the owner's token
  or certificate is available, sign the final EXE after UPX and add a trusted
  timestamp; never export or copy the private key into this repository.
- The source repository is backed up to the private GitHub repository
  `thoikhoabieucherry/TKBCherry` on branch `main`. Generated packages, databases,
  school workbooks, credentials, and temporary build trees remain ignored.
- The existing `PROJECT.md` and `progress.md` are older planning notes. This file
  is the authoritative current operational handoff.
