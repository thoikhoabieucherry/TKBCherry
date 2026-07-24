# TKBCherry Project Handoff

Last updated: 2026-07-24 (Asia/Bangkok)

This is the persistent handoff note for future Codex sessions. Read this file
before modifying the scheduler or deploying. Update it after every meaningful
change so a machine restart or a new conversation does not erase project context.

## Release Versioning

- Current deployed application release: **v1.83** (latest-login-wins auth,
  canonical Quick gap-progress baselines, and concise Agent Hint). The public
  API marker is `tkb_new-rust-api-2026-07-24-latest-login-wins-v75`, the bridge
  marker is `tkb-rust-api-v280-canonical-quick-gap-baseline`, the unchanged
  Browser executor is `tkb-browser-wasm-executor-v14-adaptive-workload`, and
  the planner cache is `20260724-v183-latest-login-wins-v1`. The unchanged
  constraints marker is `constraints-ui-v38-one-session-responsive-tables`.
- Current public Agent release: **v1.6.31** (`1.6.31`). The normal owner-Agent
  minimum lease gate is 1.6.31, so 1.6.30 and older stay upgrade-only;
  the operator trusted-worker source and release contract remain 1.6.24. The
  public owner-Agent source and Windows metadata are 1.6.31.
- Every deployed application or packaged Agent update must increment the
  applicable version here and add a short change note. Agent package updates
  must also update `agent_helper/__init__.py` and
  `agent_helper/windows_version_info.txt`.

### v1.83 latest-login-wins auth and Agent Hint (deployed 2026-07-24)

- A valid login now replaces the previous ordinary account session under the
  server login guard. The new device enters immediately; the old session is
  marked replaced and cannot reclaim the active-session slot later.
- The old device receives `session_replaced` from `/api/auth/session`, stores a
  one-shot notice, clears its local session, and returns to the login page with
  `Tài khoản đã được đăng nhập ở nơi khác.`. Existing logout semantics and
  unrestricted superadmin sessions remain unchanged.
- The toolbar keeps the visible label `Agent`. When enabled, its Hint and ARIA
  label are `Agent đã bật`; compact portrait mobile still uses the existing
  icon-only CSS. Worker detail remains available for active/working states.
- Before a Gap optimization click, an already-open device refreshes a newer
  Quick gap baseline from the canonical school store when the expected lesson
  count matches. Rust progress no longer raises a canonical Gap baseline to a
  regressed current count, so a 10-to-12 regression stays at 0%.
- Verification passes full Node **370/370**. Final isolated VPS staging passes
  scheduler **222/222**, Agent **155/155**, trusted worker **5/5**, Rust API
  **189/189**, and validator **38/38**, ending with `STAGING_TESTS_OK`.
- Final transactional production deployment returned `UPDATE_OK`; backups are
  `/opt/cherry-scheduler-backups/server-state-20260724-164221.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260724-164221.tar.gz`.
- Public health serves API v75 with zero active/queued jobs and `6/6` VPS worker
  tokens. In-app browser acceptance loaded all v183 assets, showed text
  `Agent` with Hint `Agent đã bật`, and reported no warning or error logs.

### v1.82 canonical gap progress and Agent labels (deployed 2026-07-24)

- Gap optimization progress now uses independent Gap 1 and Gap 2+ baselines
  captured from the latest successful Quick timetable. For example, reducing a
  baseline of 10 to 9 reports 10%; increasing to 12 reports 0% without moving
  the baseline. Repeated optimization keeps the same baselines until a new
  successful Quick run replaces them.
- Baselines are persisted in the school store, validated against the expected
  period count, derived from the timetable actually applied to the UI, and
  carried as canonical job metadata through reloads, already-open devices,
  VPS/Agent generation handoffs, and the Gap 2-to-Gap 1 stage switch. Legacy,
  missing, or malformed metadata falls back to current metrics.
- Both normal Quick completion and the already-complete Quick path save the new
  baselines atomically with the timetable. A failed remote save restores the
  previous baseline. Executor-reported counters cannot overwrite canonical
  Quick baselines.
- On desktop and other label-capable layouts, the Agent toolbar button now says
  `Agent đã bật` when enabled and `Agent đã tắt` when disabled, while retaining
  detailed Worker information in its tooltip. Compact portrait-mobile layouts
  intentionally remain icon/dot-only because their CSS hides toolbar text.
- Verification passes full Node **367/367**. Final isolated VPS staging passes
  scheduler **222/222**, Agent **155/155**, trusted worker **5/5**, Rust API
  **187/187**, and validator **38/38**, ending with `STAGING_TESTS_OK`.
- Final transactional production deployment returned `UPDATE_OK`; backups are
  `/opt/cherry-scheduler-backups/server-state-20260724-161512.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260724-161512.tar.gz`.
- Public health serves API v74 with zero active/queued jobs and `6/6` VPS worker
  tokens. Public HTML serves cache v182; bridge v280 exposes both canonical gap
  baseline fields, and the live planner asset contains both explicit Agent
  labels.

### v1.81 adaptive local resources (deployed 2026-07-24)

- Available CPU and RAM are ceilings, not utilization targets. Browser and
  native Agents now choose Quick CPU width from the measured timetable size:
  at most 128 periods uses 1 Worker, 129-512 uses 2, 513-2,000 uses 4, and a
  larger timetable uses 8, always capped by the device/lease ceiling. An older
  request without a trustworthy period count uses the balanced 4-Worker tier.
- The real 1,566-period default Quick fixture completed in 12.359 seconds with
  4 Workers, 13.125 seconds with 8, 12.789 seconds with 12, and 19.907 seconds
  with 22. The former all-CPU policy therefore made this common Quick workload
  about 61% slower than the selected 4-Worker tier.
- Quality-heavy singleton, teacher-session, gap, and coordinated complete
  refinement runs retain access to every available logical CPU. Browser WASM
  uses one solver thread per outer Web Worker so parallelism cannot multiply
  recursively. Native Agent RAM retains the full permitted physical-memory
  ceiling, but memory is allocated only when the solver actually needs it.
- Browser runtime state distinguishes the hardware `workerCeiling`, the
  per-request `plannedWorkerCount`, the active Worker count, and the last real
  compute width. The toolbar reports actual/max Worker counts while running and
  the most recent actual count while idle. First Automatic VPS-only routing,
  hidden-tab handoff, Stop behavior, hard constraints, and quality acceptance
  rules are unchanged.
- Candidate markers are API
  `tkb_new-rust-api-2026-07-24-adaptive-agent-cpu-v73`, Browser executor
  `tkb-browser-wasm-executor-v14-adaptive-workload`, and planner cache
  `20260724-v181-adaptive-browser-workers-v1`; bridge v278 is unchanged. Native
  Agent candidate 1.6.31 raises the owner-Agent lease gate to 1.6.31 and the
  private WSL runtime marker to `20260724.2`.
- Local verification passes full Node **358/358**, focused Browser/UI
  **57/57**, Agent **155/155** with one platform skip, Rust API **186/186**,
  validator **38/38**, JavaScript/Python syntax, and `git diff --check`.
- `agent_helper/build_windows.ps1` now uses a URI-backed relative-path helper
  instead of the PowerShell 7-only `System.IO.Path.GetRelativePath`. Packaging
  can therefore run under the workstation's Windows PowerShell 5.1 as well as
  the CI runner's PowerShell 7. Packaging contract tests pass **5/5**.
- GitHub Actions run **30101934448** built and smoke-tested the Windows 1.6.31
  candidate on `windows-2022`. Downloaded candidate sizes and hashes matched
  `candidate-hashes.json`; the signed public ZIP is 88,054,539 bytes with
  SHA-256 `402f4eba12db1b31aa923e0960450855a7314729c90c796889741b31a4aaaa96`,
  and its 88,612,442-byte EXE has SHA-256
  `6b1ad2a224713819c5ae0be98743f48a30df3601b00ec8b3c84a2ad6f3ebaece`.
  File/Product version are both 1.6.31, the ZIP has exactly one root EXE, and
  the DPAPI-backed signed manifest passes packaging/updater tests **15/15**.
- Isolated VPS staging passes scheduler **222/222**, Agent **155/155**, trusted
  worker **5/5**, Rust API **186/186**, and validator **38/38**, ending with
  `STAGING_TESTS_OK`. Transactional deployment waited for an active user solve
  to finish, returned `UPDATE_OK`, and created backups
  `/opt/cherry-scheduler-backups/server-state-20260724-145424.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260724-145424.tar.gz`.
- Public health serves API v73 with zero active/queued jobs and `6/6` VPS worker
  tokens. The page serves cache v181 and executor v14; public Agent manifest
  1.6.31 and its 88,054,539-byte ZIP are live. Signed-in in-app Browser
  acceptance loaded both v181 scripts, showed the enabled adaptive Agent with a
  22-Worker ceiling, kept idle progress hidden, retained the complete visible
  timetable, and reported no console warning or error.

### v1.80 durable school-store save (deployed 2026-07-24)

- The Browser Agent indicator now treats enabled readiness as success: enabled
  and prepared are green, active/working are brighter green, working alone
  pulses, off/unavailable are gray, and red is reserved for a future truthful
  error state. Idle copy says the Agent is ready to use the reported Worker
  count instead of saying it has not connected. The full-resource policy is
  unchanged: local compute still uses every reported logical CPU when an
  eligible job starts, while idle Agent state consumes no solver CPU and RAM
  remains demand-allocated rather than eagerly filled.

- The reported `Remote school store save failed` was not a scheduler failure.
  Nginx access/error logs show two `POST /api/school/store?id=default` requests
  returned 502 at 2026-07-24 13:13:03 UTC while `tkb-app` was stopped from
  13:12:35 through 13:15:05 for a deployment build. The completed timetable
  reached `applyPayload`, but its required remote commit failed and the generic
  error mapper mislabeled that persistence outage as a sorting error.
- Shared remote storage now serializes writes per school, deduplicates identical
  concurrent payloads, and retries transport failures plus HTTP 408/425/429/5xx
  responses with bounded exponential backoff for up to 180 seconds. HTTP
  401/403 still enters the existing one-shot auth recovery immediately, and
  permanent 4xx validation failures are not retried. The awaited solver-result
  save therefore remains the commit point, so a result is not settled or lost
  while VPS persistence is temporarily unavailable.
- The bridge maps an exhausted remote-store commit to the truthful warning
  `Đã xếp xong nhưng chưa lưu được`; it states that the canonical result remains
  on the VPS and can be reattached after connectivity returns. It no longer
  displays the raw English persistence exception as `Có lỗi khi sắp xếp`.
- The Rust school-store endpoint no longer ignores SQLite write errors and then
  returns false success. A database write failure now logs server-side and
  returns retryable HTTP 503 with `school_store_write_failed`.
- Update deployment now prepares npm/Cargo artifacts before gating/stopping the
  live app and installs Python requirements after solver drain but before the
  stop. The offline cutover contains only state backup, source/runtime copy and
  restart. Candidate mail dependencies have a dedicated rollback stage, while
  database and Agent-package protection remains unchanged. This removes the
  observed multi-minute app outage from future builds.
- Deployed markers are API
  `tkb_new-rust-api-2026-07-24-durable-school-store-v72`, bridge
  `tkb-rust-api-v278-durable-school-store`, shared storage
  `remote-save-retry-v1`, and page cache
  `20260724-v180-durable-store-save-v1`. Browser executor and native Agent are
  unchanged.
- Verification passes full Node **357/357** (including bridge/storage
  **236/236**), deployment packaging **13/13**, remote Rust API **186/186**,
  validator **38/38**, remote `bash -n`, JavaScript syntax and
  `git diff --check`. Isolated VPS staging also passes scheduler **222/222**,
  Agent **152/152**, trusted worker **5/5**, Rust API **186/186**, and validator
  **38/38**, ending with `STAGING_TESTS_OK`.
- Transactional production deployment returned `UPDATE_OK`; backups are
  `/opt/cherry-scheduler-backups/server-state-20260724-133825.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260724-133825.tar.gz`. A public
  health probe sampled 901 times at roughly four checks per second across the
  full deployment. Only four consecutive 502 responses occurred from
  20:41:16.104 through 20:41:17.270 local time, reducing the offline cutover
  from the previous 150 seconds to about 1.2 seconds. The new client retry
  window safely covers that cutover.
- Signed-in in-app Browser acceptance loaded the v1.80 storage, planner and
  bridge cache URLs, showed the enabled 22-Worker Agent dot as
  `rgb(22, 163, 74)`, kept idle progress hidden, and reported no console warning
  or error. Public health is idle with zero active/queued jobs and `6/6` VPS
  worker tokens.

### v1.78 full-resource native Agent (deployed 2026-07-24)

- Native Agent no longer chooses 2/4/6 CPU workers from timetable size or
  honors a stale lower `settings.num_workers`. Every fresh, Quick, Automatic,
  and focused lease overwrites that setting with its full physical/logical CPU
  capacity. The Python solver runtime also removes the former 64-worker cap;
  the environment/physical CPU count remains the real ceiling.
- Native Agent no longer slices its permitted memory into 4/8/16 GB. Windows
  Job Object and WSL address-space enforcement receive the full configured
  physical-RAM ceiling. This is permission rather than eager allocation; the
  solver still consumes only memory it needs. BLAS/OpenMP remain one-threaded
  so CP-SAT owns parallelism without nested oversubscription.
- CPU and RAM configuration validation now accepts hosts above the former 256
  logical CPU and 1 TiB ceilings while still clamping explicit values to the
  detected machine. The example config omits both fields so defaults cannot
  accidentally cap a larger host. Browser requests retain the same uncapped
  `navigator.hardwareConcurrency` contract introduced in v1.77.
- Agent 1.6.30 updates both Windows metadata and the private WSL runtime marker
  to `20260724.1`. The server and Browser worker declare minimum version 1.6.30;
  old native Agents therefore cannot claim a job with the legacy resource
  policy before the Browser Agent or VPS.
- GitHub Actions run `30092921949` built and smoke-tested the Windows candidate
  on `windows-2022`. The downloaded artifact hashes matched
  `candidate-hashes.json`; the local public ZIP contains exactly one root entry,
  reports File/Product version 1.6.30, passes GUI and solver protocol smokes,
  and its manifest verifies against the existing DPAPI-backed RSA key.
- Local verification passes Node **354/354**, Agent **152/152** with one
  platform skip, scheduler Python **219 passed / 3 skipped** plus **49** unittest
  subtests, Browser WASM ABI, release signature/hash checks, JavaScript/Python
  syntax, and `git diff --check`. Isolated VPS staging passes scheduler
  **222/222**, Agent **152/152**, trusted worker **5/5**, Rust API **186/186**,
  and validator **38/38**, ending with `STAGING_TESTS_OK`.
- Transactional production deployment returned `UPDATE_OK`; backups are
  `/opt/cherry-scheduler-backups/server-state-20260724-124144.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260724-124144.tar.gz`. Public
  health is idle with zero active/queued jobs and `6/6` VPS worker tokens.
- Signed-in in-app Browser acceptance loaded v1.78 and ran focused session
  optimization through the Browser Agent with the truthful label
  `Agent dang toi uu bang 22 Worker tren thiet bi`; public health retained all
  `6/6` VPS tokens. The real 1,566-period default schedule reduced the displayed
  session baseline from 653 to 523, stayed complete, and kept one-period teacher
  sessions at zero. Turning Agent off sent a gap run to the VPS with all `6/6`
  tokens, Stop returned `Da xep xong!`, and Agent was turned back on. Browser
  console had no warning or error.

### v1.77 full-resource Browser Agent (deployed 2026-07-24)

- Browser Agent status now distinguishes enabled capability from real local
  work. An idle enabled browser remains red; green is reserved for a scoped
  server connection or an active WASM solve. The tooltip explicitly says idle
  Agent work runs inside the browser process only when an eligible solve starts.
- Browser executor runtime evidence now records active local compute, run and
  server-accepted result counts, worker count, and start/finish/accept times.
  Each state transition emits `tkb-browser-agent-state`; the planner also keeps
  the probe, activation and final evidence in
  `window.__TKB_RUST_LAST_REQUEST_DEBUG` for acceptance diagnostics.
- Trace audit confirms the exclusive path is probe/compile -> durable POST ->
  scoped hello -> lease -> Web Worker/WASM -> digested candidate -> server
  native/reference validation -> complete. Hidden pages, disabled Agent,
  heartbeat/lease loss and rejected local results release the same canonical
  job to VPS fallback. A first Automatic solve remains VPS-only by contract;
  Quick and eligible complete refinement/focused solves can use Browser Agent.
- Quick fresh/partial requests run locally for at most 12 seconds and return the
  first complete hard-valid candidate; focused Browser optimization runs at
  most 60 seconds plus a 15-second validation reserve. `Buoi 1 tiet` stops its
  remaining portfolio workers as soon as a validated zero target is available.
- Browser Agent always uses the full positive integer reported by
  `navigator.hardwareConcurrency`; it does not reserve a core, inspect
  `deviceMemory`, or retain the former 64-worker cap. Every auto/Quick/focused
  request overwrites stale lower `num_workers` settings with the same hardware
  count. A deterministic regression proves 512 reported logical CPUs with
  0.25 GB reported device memory still selects 512 workers. If a browser cannot
  create or probe every Worker, it keeps the healthy Workers it actually made.
- Local verification passes Node **354/354**, scheduler Python **218 passed / 3
  skipped** plus **49** unittest subtests, both JavaScript syntax checks, WASM
  ABI, and `git diff --check`. Isolated VPS staging passes scheduler **221/221**,
  Agent **151/151**, trusted worker **5/5**, Rust API **186/186**, and validator
  **38/38**, ending with `STAGING_TESTS_OK`.
- Transactional production deployment returned `UPDATE_OK`; backups are
  `/opt/cherry-scheduler-backups/server-state-20260724-121214.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260724-121214.tar.gz`. Public
  health is idle with zero active/queued jobs and `6/6` VPS worker tokens. The
  public WASM remains 1,104,120 bytes with SHA-256
  `e7d4ecc1942f404e2c95d561a3909ee9e2c0901db0eacc21ea4d8feea51edd37`.
- Native Agent 1.6.29 still had legacy per-workload 2/4/6 CPU and 4/8/16 GB
  runtime slices; v1.78/Agent 1.6.30 above supersedes that policy.

### v1.74 responsive progress and stable Stop (deployed 2026-07-24)

- Production Browser reproduction found a roughly 4.9-second main-thread block
  after choosing `Toi uu -> Buoi` with the Browser Agent disabled. The owner
  state can contain many completed jobs, and `selectDiscoverableBackendJob`
  previously rebuilt the deep current-school fingerprint separately for every
  candidate before the progress frame or Stop action could respond.
- The bridge now creates one lazy fingerprint matcher per discovery pass.
  It computes the current v1, v2, or v3 fingerprint at most once per protocol,
  then reuses it for all running, queued, and completed candidates. Direct
  one-off fingerprint matching retains its existing compatibility behavior.
- On the real 263,038-byte `default` production fixture, 100 stale completed
  jobs fell from 8.60 seconds to 59 ms and 250 jobs fell from 21.06 seconds to
  64 ms. A deterministic regression with 128 completed jobs asserts that the
  current v3 schedule is read for hashing exactly once.
- The v5 follow-up centralizes the active-progress invariant in
  `setProgress`: any active `100%` input is rendered and persisted as `99%`, so
  the real planner progress UI keeps Stop available until `finishProgress`
  owns terminal completion. A complete, constraint-clean Quick click also ends
  locally instead of posting another VPS solve.
- Focused Stop keeps one stable `Đang nhận phương án tốt nhất...` status while
  the final checkpoint is collected. Focused singleton/session/gap checkpoints
  may carry temporary debt in a different quality metric, while Automatic
  remains strict and every authored constraint stays mandatory.
- Local verification passes full Node **348/348**, bridge **231/231**, all
  planner suites **68/68**, Browser executor **24/24**, JavaScript syntax, and
  `git diff --check`. The unchanged isolated VPS candidate passed scheduler
  **219/219**, Agent **151/151**, trusted worker **5/5**, Rust API **178/178**,
  and validator **32/32**, ending with `STAGING_TESTS_OK`.
- Final production deployment returned `UPDATE_OK`; backups are
  `/opt/cherry-scheduler-backups/server-state-20260724-091828.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260724-091828.tar.gz`. Signed-in
  in-app Browser acceptance loaded cache v5 with Browser Agent off, completed
  Quick with `Đã xếp xong!`, kept focused Stop feedback stable through terminal
  success, and reloaded to an idle page with hidden progress. Public health is
  idle with zero active/queued jobs and `6/6` worker tokens.

### v1.71 bounded progressive Stop handoff (deployed 2026-07-24)

- Deployed markers are API
  `tkb_new-rust-api-2026-07-24-progressive-stop-flush-v66`, bridge
  `tkb-rust-api-v268-progressive-stop-flush`, planner cache
  `20260724-v171-progressive-stop-flush-v1`, and Browser executor
  `tkb-browser-wasm-executor-v7-best-stop-flush`. The packaged Agent remains
  1.6.29; this patch changes the integrated Browser Agent, bridge and reference
  scheduler only.
- The focused optimizer wall-clock ceiling is now enforced on the final wire
  request. A persisted custom duration and the sum of CP-SAT sub-budgets can no
  longer expand `Buoi 1 tiet`, `Buoi`, or `Tiet trong` past 180 seconds; an
  explicit shorter duration is still honored.
- Focused Browser Agent Stop now aborts only its slow portfolio workers, flushes
  the best completed hard-valid candidate to the canonical lease, and only then
  asks the server to retain best-so-far. The bridge keeps polling and applies
  the accepted result even when candidate completion races the Stop request.
- Progress cannot move backward after an Agent/VPS execution-generation handoff.
  Gap cleanup uses one continuous two-stage percentage: the first half removes
  gap-2 and the second half reduces gap-1, while the raw active count remains
  visible beside elapsed time.
- Local verification passes full Node **338/338**, scheduler Python **215 passed
  / 3 skipped** plus **45** unittest subtests, Browser executor **24/24**, bridge
  **221/221**, JavaScript/Python syntax and `git diff --check`. Isolated VPS
  staging passes scheduler **218/218**, Agent **151/151**, trusted worker
  **5/5**, Rust API **173/173**, and validator **32/32**, ending with
  `STAGING_TESTS_OK`.
- Transactional production deployment returned `UPDATE_OK`; backups are
  `/opt/cherry-scheduler-backups/server-state-20260724-040943.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260724-040943.tar.gz`. Public
  health is idle with zero active/queued jobs and `6/6` worker tokens. The
  unchanged public WASM is 1,031,910 bytes with SHA-256
  `926d2a490a2004235d2b0b445956d1326fc614b3fd5af179b19f7af5f1e1832c`.
- Signed-in in-app Browser acceptance loaded v1.71 with 1,566/1,566 periods,
  497 teacher sessions, gap-1 64, gap-2 0 and singleton sessions 0. Production
  labels expose `Xep nhanh`, `Buoi 1 tiet`, `Buoi`, and `Tiet trong`; an actual
  VPS Play/Stop cycle returned to idle with no console error and no timetable
  mutation. Focused Stop ordering is covered deterministically by the Browser
  executor and bridge suites because the 794px acceptance viewport correctly
  keeps the desktop-only focused controls hidden.

### v1.73 stable live progress and checkpoint Stop (deployed 2026-07-24)

- Candidate markers are API
  `tkb_new-rust-api-2026-07-24-stable-live-progress-v68`, bridge
  `tkb-rust-api-v270-stable-live-progress-r2`, planner cache
  `20260724-v173-stable-live-progress-v2`, and Browser executor
  `tkb-browser-wasm-executor-v8-checkpoint-stop`. The packaged Agent remains
  1.6.29.
- Repeated focused optimization now starts from the visible incumbent counter
  on every click. A metric-free VPS/Agent startup frame or internal retry no
  longer clears the current value and falls back to the 12% admission band.
  The canonical server job is seeded from the request metric and retains that
  metric across execution generations until a newer real counter arrives, so
  reloads and other devices see the same baseline before the first strict
  improvement.
- Focused Stop immediately terminates local Browser workers and asks the server
  to retain its latest validated checkpoint. An accepted checkpoint is
  returned atomically; when Stop lands before the first checkpoint, the server
  returns the already validated complete incumbent instead of starting a VPS
  fallback. VPS Stop still uses OR-Tools `stop_search()` and materializes the
  latest hard-valid incumbent through the normal result path.
- Regression coverage reproduces a second Sessions run across a metric-free
  generation startup frame, a focused internal retry, live raw-counter updates,
  cross-device focused-mode recovery, Agent checkpoint Stop and Stop before the
  first Agent checkpoint. Local verification passes Node **343/343**, scheduler
  Python **216 passed / 3 skipped** plus **45** unittest subtests, deployment and
  credential tests **25/25**, and `git diff --check`. Isolated VPS staging passes
  scheduler **219/219**, Agent **151/151**, trusted worker **5/5**, Rust API
  **178/178**, and validator **32/32**, ending with `STAGING_TESTS_OK`.
- Transactional production deployment returned `UPDATE_OK`; backups are
  `/opt/cherry-scheduler-backups/server-state-20260724-075341.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260724-075341.tar.gz`. A
  concurrent earlier deployment cleanup briefly stopped `tkb-app` after the
  successful transaction; `systemctl daemon-reload` plus a clean restart
  restored it. Follow-up checks found no remaining deployment process or
  service warning. Public health is idle with zero active/queued jobs and
  `6/6` worker tokens; the v1.73 page, v270 bridge and v8 Browser executor are
  all served publicly.

### v1.72 live work progress and immediate Stop (superseded candidate; not deployed)

- Candidate markers are API
  `tkb_new-rust-api-2026-07-24-live-progress-stop-v67`, bridge
  `tkb-rust-api-v269-live-progress-stop`, planner cache
  `20260724-v172-live-progress-stop-v1`, and Browser executor
  `tkb-browser-wasm-executor-v8-checkpoint-stop`. The packaged Agent remains
  1.6.29.
- Progress now has two explicit contracts. Automatic uses canonical elapsed
  server time against its configured budget and stays at 99% until a valid
  result is applied. Quick, Singletons, Sessions and Gaps use only real work
  metrics. Their raw counter remains visible even when rounded percent is
  unchanged, and neither same-generation nor Agent/VPS handoff progress may
  move backward. `solveRequestMode` is carried by reference-solver and Browser
  checkpoint frames, persisted locally, and restored during cross-device load.

- The Browser Agent now uploads each newly completed strict-best portfolio
  candidate as a validated server checkpoint while slower workers continue.
  Checkpoints do not complete the Agent lease, but the canonical coordinator
  atomically retains the best accepted checkpoint on focused Stop, lease loss,
  or watchdog finalization.
- Focused Stop terminates local Browser workers immediately and sends
  `retainBest:true` to the server without waiting for the former 32-second
  client flush. Quick Stop remains destructive. An in-flight candidate is not
  considered complete until VPS validation accepts its checkpoint.
- If focused Stop arrives before the first accepted Agent checkpoint, the
  coordinator now returns the already validated complete incumbent directly
  instead of starting a VPS process only to stop it and return the same
  timetable. An accepted checkpoint still takes priority. The combined Rust
  regression proves that this path preserves the incumbent lessons and metrics
  byte-for-byte and leaves no active server job.
- Accepted Browser checkpoints publish their focused raw metric to canonical
  server progress with the canonical protocol, monotonic server sequence and
  elapsed time, so reloads and other devices can observe counts such as
  `136 -> 134` rather than a client-only timer.
- Focused component verification passes Browser executor **24/24**, bridge
  **224/224**, isolated VPS Rust API **177/177**, and validator **32/32**.
- Quick completion now memoizes immutable assignment/session domains while
  trimming unavailable demand and constructing the exact CP-SAT period bridge.
  It does not relax or bypass any authored rule, fixed/off slot, teacher/room
  conflict, or final validator. On the real 1,566-period `default` request the
  cold stdio run completed in 11.64s protocol time (12.07s process wall time),
  with 1,566/1,566 periods, `hard_ok=true`, and zero authored violations. The
  matched local model-build interval fell from 4.94s to 2.52s. Scheduler
  verification now passes **216 passed / 3 skipped** plus **45** unittest
  subtests, including domain-answer equivalence and cache-reuse coverage.
- Current local verification passes full Node **341/341**, scheduler Python
  **216 passed / 3 skipped** plus **45** unittest subtests, deployment packaging
  **13/13**, JavaScript/Python syntax, and `git diff --check`. Full isolated
  staging passes scheduler **219/219**, Agent **151/151**, trusted worker
  **5/5**, Rust API **176/176**, and validator **32/32**, ending with
  `STAGING_TESTS_OK`. Transactional production deployment remains pending.

### v1.70 progressive focused optimization (deployed 2026-07-24)

- Deployed markers are API
  `tkb_new-rust-api-2026-07-24-progressive-best-stop-v65`, bridge
  `tkb-rust-api-v267-progressive-best-stop`, planner cache
  `20260724-v170-progressive-best-stop-v1`, and Browser executor
  `tkb-browser-wasm-executor-v6-progressive-focus`. The Agent package remains
  1.6.29 because this release changes the web/server scheduler contract only.
- Desktop `Xep nhanh` now owns completeness only: it returns the first complete,
  authored-hard-valid timetable without spending time on teacher singleton,
  session or gap quality. The explicit actions are `Buoi 1 tiet`, `Buoi`, and
  `Tiet trong`; their menu rows use one stable left-aligned geometry.
- Each focused optimizer is bounded to at most 180 seconds. A shorter explicit
  duration is honored. Singleton cleanup stops at the first complete valid
  zero-singleton timetable. Session compression keeps singleton count at zero
  but may deliberately increase gap-1/gap-2. Gap cleanup locks the achieved
  teacher-session count, removes gap-2 first, then reduces gap-1.
- CP-SAT publishes strict-best metric-only incumbents during the solve. The UI
  is driven by real scheduled periods, teacher sessions, singleton sessions or
  gaps and also shows the raw current value beside elapsed time, so consecutive
  one-session improvements remain visible even when integer percent is equal.
  No intermediate timetable cells are published or partially applied.
- Focused Stop is best-effort rather than destructive. `retainBest:true` flows
  from the browser to the canonical server job, a per-job stop file calls
  `CpSolver.stop_search()`, and the normal result path materializes, validates,
  applies and saves the best incumbent found so far. Quick Stop remains the
  old hard cancel. A repeated focused Stop is idempotent and keeps polling.
- VPS/Agent transfer is generation-fenced. A soft-stopping VPS cannot be handed
  away. An Agent job commits an already accepted candidate or returns the same
  canonical job to VPS with the stop flag intact. Progress frames carry the
  execution generation, rejecting late frames from an old executor while
  allowing the replacement stream to restart at sequence one.
- Real `default` sequential benchmark (1,566 periods, six workers) produced:
  Quick in 13.48s at 627 teacher sessions / 118 singleton sessions; singleton
  cleanup in 15.18s at 571 / 0; Session optimization in 174.58s at 486 / 0
  with temporary gap-1 67 / gap-2 7; Gap optimization in 175.80s kept 486 / 0
  and reached gap-1 45 / gap-2 0. Every result was 1,566/1,566, hard-valid,
  zero authored violations, and passed the canonical validator. Session CP-SAT
  emitted 56 strict improvements; Gap CP-SAT emitted 16.
- Local verification currently passes full Node **335/335**, scheduler Python
  **215 passed / 3 skipped** plus 45 unittest subtests, deployment/credential
  **25/25**, remote Rust API **173/173**, validator **32/32**, JavaScript/Python
  syntax, `git diff --check`, and both WASM ABI smokes. The rebuilt WASM is
  1,031,910 bytes with SHA-256
  `926d2a490a2004235d2b0b445956d1326fc614b3fd5af179b19f7af5f1e1832c` in
  both runtime locations. Full isolated staging passes scheduler **218/218**,
  Agent **151/151**, trusted worker **5/5**, Rust API **173/173**, and validator
  **32/32**, ending with `STAGING_TESTS_OK`.
- Transactional production deployment returned `UPDATE_OK`; backups are
  `/opt/cherry-scheduler-backups/server-state-20260724-034627.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260724-034627.tar.gz`. Public
  health is idle with zero active/queued jobs and `6/6` worker tokens. The
  public cache, bridge marker, Browser executor marker and 1,031,910-byte WASM
  SHA-256 shown above were verified after deployment. Signed-in browser
  acceptance remains a separate final check and is not claimed here.

### v1.68 orientation-aware mobile history controls (deployed 2026-07-23)

- Portrait phones retain the compact eight-column toolbar introduced in v1.67,
  with Redo above Undo in one 44px column. Landscape phones now use nine equal
  tracks and restore Undo and Redo as separate full-height 44px buttons. The
  Duration, Play, Delete/Stop, Agent, Home and Statistics controls each retain
  their own stable landscape column.
- This is a responsive CSS and cache-only change. Scheduler behavior, the v63
  API, v265 bridge, browser-Agent execution and the WASM binary are unchanged.
- Verification passes the full Node suite **318/318**, the focused toolbar and
  browser-Agent suites **49/49**, JavaScript syntax, `git diff --check`, and the
  real WASM ABI smoke (`BROWSER_WASM_ABI_OK`). Production checks at 430x932 and
  932x430 confirmed stacked portrait history, separate landscape history, the
  visible blank duration input, stable neighboring controls and no console
  warning or error.
- Transactional production deployment returned `UPDATE_OK`; backups are
  `/opt/cherry-scheduler-backups/server-state-20260723-121024.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260723-121024.tar.gz`. The public
  cache marker is `20260723-v168-landscape-history-v1`.

### Post-v1.68 first-clean speed candidate (backup branch, not deployed)

- The fresh Phase Q model now uses the existing direct hard
  `load >= 2 * active` encoding for `max_one_period_sessions=0` instead of also
  creating 744 redundant singleton objective variables. Strict refinement also
  keeps the incumbent as a CP-SAT hint without creating hint-distance objective
  variables. A forced-singleton unit case remains infeasible, proving the hard
  cap is unchanged.
- Benders no longer repeats a relaxed period allocation after a strict period
  failure has already produced a structural cut. On the measured `default`
  trace each redundant relaxed wave cost about 12.3 seconds.
- The first-click Phase Q has an opt-in first-clean stop. Its first complete,
  hard-valid candidate with zero one-period teacher sessions and zero gap-2
  sessions becomes the atomic first result; later refinement remains separate.
  On the live `default` fixture (54 classes, 93 teachers, 1,566 periods, 54
  fixed periods, six VPS workers, seed 101), this candidate returned in 87.60s
  instead of the 172.15s baseline. Canonical validation passed and quality was
  `570 teacher sessions / 112 gap-1`, versus the slower baseline's `509 / 83`.
  This proves the latency gain but also proves that a separate deep optimizer
  is required before replacing the deployed flow.
- Local scheduler verification passes **175/175** with three platform skips,
  focused CP-SAT and Benders tests pass, and `git diff --check` passes. The
  candidate is preserved on `codex/v169-first-clean-backup`; it is not deployed.
- Next investigation: an atomic two-phase refinement. Phase S may temporarily
  trade gap-1/gap-2 for fewer teacher sessions while retaining the hard
  no-singleton cap. Phase G must lock the achieved teacher-session ceiling,
  restore gap-2 to zero when constraints permit, and reduce gap-1. Only a final
  candidate that passes the complete hard validator and the visible Pareto
  guard may replace the incumbent.

### v1.69 focused optimizer contract (deployed 2026-07-24)

- Candidate markers are API
  `tkb_new-rust-api-2026-07-24-focused-two-stage-v64`, bridge
  `tkb-rust-api-v266-focused-two-stage`, planner cache
  `20260724-v169-focused-two-stage-v1`, and Browser executor
  `tkb-browser-wasm-executor-v5-focused-two-stage`.
- `solver_runtime/src/tkb_new/adapter.py` now normalizes the request focus to
  `automatic`, `quick_complete`, `singletons`, `sessions`, or `gaps` (including
  the bridge aliases `one_period_teacher_sessions`, `teacher_sessions`, and
  `teacher_gaps`). Existing CP-SAT/Benders code is reused; no alternate solver
  is introduced.
- Focused refinements are atomic: singleton cleanup runs one phase, session
  cleanup runs Phase S, and gap cleanup runs Phase G while locking the achieved
  session count. Phase S first targets zero singleton sessions, then uses a
  bounded incumbent-singleton cap only when authored constraints make zero
  infeasible. Phase G likewise targets zero gap-2 first, then keeps the current
  unavoidable gap-2 ceiling while reducing remaining gaps. Automatic keeps
  Phase S then Phase G. No fallback may worsen the validated incumbent.
- Phase S explicitly permits temporary gap-2 debt. Its materialized period
  candidate was previously rejected by the partial-payload guard's legacy
  `max_gap <= 1` check even though it was complete and satisfied every authored
  constraint. The Benders payload builder now propagates gap debt permission
  whenever `period_max_teacher_gap` is off. Phase G now has the bounded debt
  fallback described above instead of discarding all useful progress when an
  authored constraint makes the ideal zero target infeasible.
  A real `default` Quick -> Sessions run improved from 567 to 510 teacher
  sessions in 93.37 seconds, retained 1,566/1,566 periods and zero singleton
  sessions, and passed canonical validation with six temporary gap-2 sessions.
- Quick completion now keeps `period_max_teacher_gap` off after the browser's
  final preset normalization, including when the visible timetable is already
  complete and Browser WASM is eligible. It requires a complete hard-valid
  schedule with zero singleton sessions, but deliberately permits gap-2. On the
  current `default` fixture it returned 1,566/1,566 periods in 48.79 seconds
  with 567 teacher sessions, zero singleton sessions, 124 gap-1 sessions and
  17 gap-2 sessions, preserving room for explicit session compression.
- Phase G now begins with a fixed-session period repack before global CP-SAT.
  It preserves every assignment's half-day and therefore locks the teacher
  session count, while the parallel period MILP removes severe gaps in a few
  seconds. On the 510-session checkpoint, a 40-second real VPS run reached
  gap-2 zero and gap-1 85 in 37.41 seconds. The former direct CP-SAT path had
  returned the unchanged 101 gap-1 / 6 gap-2 incumbent after 186.36 seconds.
- A complete post-review 180-second Automatic benchmark performs session
  compression followed by that fast gap checkpoint atomically: 567 -> 485
  teacher sessions, zero singleton sessions, gap-2 zero and gap-1 50 in 176.13
  seconds. The earlier candidate reached 496 sessions / gap-1 68 in 176.25s. The
  result is complete, hard-valid, has zero authored-constraint violations, and
  passes canonical validation.
- Phase progress emits `optimizationFocus`, `metricCurrent`, `metricTarget`,
  `metricBaseline`, and clamped `metricPercent`. Gap progress reports gap-2
  until it reaches zero, then switches to a fresh gap-1 baseline; it no longer
  labels the sum of both buckets as a gap-2 count.
- Browser Agent portfolio acceptance follows the same focus contract as VPS:
  Quick and Singletons may take temporary gap debt only for real singleton
  cleanup, Sessions may do so only for a real session reduction, Gaps locks the
  session count and compares gap-2 before gap-1, and Automatic keeps its
  coordinated singleton/session/gap-2 envelope. Quality caps are solver goals,
  not authored hard constraints: Browser/Rust Agents may publish complete,
  hard-valid unavoidable singleton or gap-2 debt, while incumbent refinements
  still reject every focus-specific regression.
- Final release review fixed the Browser Agent's multi-candidate Singleton
  comparison: the quality-order helper no longer references out-of-scope
  candidate variables, and the regression now exercises two valid Singleton
  candidates before selecting the lower-session result.
- The rebuilt Browser WASM is 1,031,894 bytes with matching SHA-256
  `c34844eb7876d106a0d9e7de6a3d6a164140bcd727a56af01af7a2fca16926d2`
  in both public runtime locations; remote and local ABI smokes return
  `BROWSER_WASM_ABI_OK`.
- Current verification passes full Node **329/329**, full Python **211/211**
  with three platform skips, focused scheduler **30/30**, deployment packaging
  **13/13**, JavaScript syntax and `git diff --check`.
  Isolated VPS staging passes scheduler **211/211**, Agent **151/151**, trusted
  worker **5/5**, Rust API **166/166**, and Rust Agent validator **31/31**, ending
  with `STAGING_TESTS_OK`.
- Transactional production deployment returned `UPDATE_OK`; backups are
  `/opt/cherry-scheduler-backups/server-state-20260724-014305.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260724-014305.tar.gz`. Public
  health serves API v64 with zero active/queued jobs and `6/6` worker tokens.
  Live HTML/JavaScript expose the v1.69 cache, desktop Quick/Optimize controls,
  bridge v266 and Browser executor v5. The public WASM is 1,031,894 bytes and
  matches SHA-256 `c34844eb7876d106a0d9e7de6a3d6a164140bcd727a56af01af7a2fca16926d2`.

### v1.67 compact mobile history and duration control (deployed 2026-07-23)

- The mobile planner toolbar keeps eight stable columns: Requirements,
  Redo-over-Undo, Duration, Play, Delete/Stop, Agent, Home and Statistics.
  Redo and Undo each occupy one 22px half of the existing 44px command row, so
  the history controls use one column without increasing toolbar height.
- The duration input is visible again on phones and tablets. An empty value
  preserves the automatic scheduler budgets; an explicit value remains a
  user-owned override. Desktop keeps the normal separate history buttons and
  the navigation order Agent, Home, Statistics.
- This is a toolbar/cache-only follow-up to v1.66. It does not change scheduler
  scoring, the v63 API, the v265 bridge contract or the WASM solver binary.
- Local verification passes the full Node suite **317/317**, the focused
  browser-Agent/toolbar suites **48/48**, an independent related-suite review
  **258/258**, JavaScript syntax checks, Python deployment syntax checks and
  `git diff --check`. The real WASM ABI smoke returns `BROWSER_WASM_ABI_OK`;
  both public runtime copies retain SHA-256
  `4ad576cd7136349c9aa163df3db0cf4bb63875d3189ec0e2388e4fe40bb36652`.
- Transactional production deployment returned `UPDATE_OK`; backups are
  `/opt/cherry-scheduler-backups/server-state-20260723-115402.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260723-115402.tar.gz`. Public
  health was idle with zero active/queued jobs and `6/6` worker tokens. The
  public page served all three v1.67 cache keys. A signed-in production check at
  430x932 confirmed the exact eight-column geometry, the blank duration input,
  Agent between Delete and Home, and no console warning or error.

### v1.66 direct browser-Agent worker portfolio (deployed 2026-07-23)

- The integrated browser Agent is enabled by default and exposes one compact
  green/red toggle. Disabling it returns eligible work to VPS. Desktop reserves
  one logical CPU and uses at most eight isolated WASM Workers; mobile uses at
  most two. Portfolio workers receive distinct search seeds and submit only the
  best hard-valid candidate.
- Browser compute remains restricted to a complete, revalidated
  `refine_complete` incumbent. Fresh, incomplete, hard-invalid and
  constraint-repair jobs remain VPS CP-SAT work. The browser and VPS never
  solve the same generation concurrently; hidden tabs, expired leases or an
  Agent-off toggle return the same canonical job to VPS.
- Browser candidates cannot regress one-period sessions, gap-2 sessions,
  teacher sessions, gap-1 periods or total gap. If every candidate is worse,
  the complete incumbent is submitted unchanged. The API may start an eligible
  browser-ready request in `agent_waiting` without consuming a VPS token, with
  bounded fallback when no browser claims it.
- Markers are API
  `tkb_new-rust-api-2026-07-23-browser-portfolio-direct-v63`, bridge
  `tkb-rust-api-v265-browser-portfolio-direct`, and cache
  `20260723-v166-browser-agent-portfolio-v1`. Local verification passed the
  full Node suite **317/317** and the real WASM ABI smoke. Isolated VPS staging
  passed scheduler **172/172**, Agent **151/151**, trusted-worker operations
  **5/5**, Rust API **155/155**, and validator **20/20**, ending with
  `STAGING_TESTS_OK`.
- Transactional production deployment returned `UPDATE_OK`; backups are
  `/opt/cherry-scheduler-backups/server-state-20260723-113605.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260723-113605.tar.gz`. A live
  complete-default refinement showed `Agent đang tối ưu bằng 8 Worker`, kept
  VPS allocation at zero with `6/6` tokens available, and returned 1,566/1,566
  lessons, zero gap-2 sessions, zero one-period sessions, 505 teacher sessions
  and 75 gap-1 periods without a console warning or error.

### v1.65 iOS foreground compute and Windows Agent status (deployed 2026-07-23)

- iPhone, iPad and iPad desktop mode may now run the existing Rust-WASM
  refinement executor while the scheduling page remains visible. The existing
  capability gate is unchanged: only a complete, revalidated
  `refine_complete` incumbent is eligible; fresh, incomplete, hard-invalid and
  constraint-repair work remains on VPS CP-SAT.
- iOS backgrounding deliberately does not imitate media playback. A real
  `visibilitychange` to hidden or `pagehide` terminates the Web Worker, fails
  the exact lease with a keepalive request and disconnects the browser token so
  VPS can resume the canonical job. If iOS suspends networking before keepalive
  completes, the existing 30-second lease expiry remains the bounded fallback.
  The browser and VPS therefore still never solve the same generation at once.
- Windows desktop now shows a compact, non-interactive Agent status control.
  Its dot is green when local Browser WASM prerequisites are ready and gains a
  green ring while a lease is actively using local CPU/RAM. The indicator reads
  only `TKBBrowserWasmExecutor.state()` and no longer polls the retired native
  Agent status endpoint. Mobile/coarse-pointer toolbars remain unchanged.
- This release does not add GPU execution or claim that additional RAM improves
  solve speed. The current browser solver uses one dedicated Web Worker, so
  stronger single-core CPU performance can help while memory is allocated only
  as needed. GPU or multi-worker execution remains gated on a separate quality
  and thermal benchmark.
- Cache marker is `20260723-v165-ios-agent-status-v1`; executor marker is
  `tkb-browser-wasm-executor-v3-ios-foreground`. Rust API v62, bridge v264,
  constraints v38 and the WASM binary are unchanged.
- Local verification passes browser lifecycle **12/12**, toolbar/UI **29/29**,
  full Node E2E **308/308**, JavaScript syntax checks and the real WASM ABI
  smoke (`BROWSER_WASM_ABI_OK`). Isolated VPS staging passes scheduler
  **172/172**, Agent **151/151**, trusted-worker operations **5/5**, Rust API
  **152/152**, and validator **20/20**, ending with `STAGING_TESTS_OK`.
- Transactional production deployment returned `UPDATE_OK`; backups are
  `/opt/cherry-scheduler-backups/server-state-20260723-102722.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260723-102722.tar.gz`. Public
  health stayed idle with zero active/queued jobs and `6/6` worker tokens.
  Public HTML and JavaScript served the v1.65 cache and executor markers, the
  iOS navigator branch, the local-only indicator state reader, and no retired
  `/api/agent-helper/v1/status` poll. A signed-in in-app-browser reload showed
  the Windows Agent indicator visible, disabled and `ready` with its green dot
  between Home and Statistics; the console had no warning or error. No live
  schedule was started during this UI/lifecycle release acceptance.

### v1.64 browser-integrated refinement executor (deployed 2026-07-23)

- Windows, macOS and Android can run the Rust hint solver directly inside a
  dedicated Web Worker during a manual scheduling job. There is no download,
  install prompt or always-on browser worker. iPhone, iPad and iPod are
  deliberately excluded, including iPad desktop mode (`MacIntel` with touch),
  because iOS may suspend Web Workers immediately after the PWA is backgrounded.
- Browser WASM is deliberately capability-gated to `refine_complete` requests
  carrying a revalidated, complete incumbent. A production `default` fresh
  probe proved why: four 90-second Rust-WASM seeds stopped around 1,530/1,566
  lessons, so fresh, incomplete, hard-invalid and constraint-repair requests
  bypass WASM entirely and remain on the VPS CP-SAT pipeline. The same real
  complete `default` incumbent (1,566/1,566, hard-valid, 459 teacher sessions,
  zero one-period sessions, zero gap-2 sessions and 38 gap-1 periods) ran in
  the browser runtime in about 22 seconds, preserved every hard-quality metric
  and reduced gap-1 from 38 to 37. This is the browser acceptance role.
- The page compiles/probes `tkb_native_solver.wasm` before creating an eligible
  refinement job but does not announce executor capacity yet. Only after `POST /api/solve-data`
  returns a durable server-owned `202` does it call Agent `hello` and begin
  leasing. The existing solver-pool execution generation then stops VPS and
  exposes one task only after the VPS child exits; browser and VPS never solve
  the same generation in parallel. Browser hello, worker registration, handoff
  and lease are scoped to that exact `solveRunId`; a tab cannot interrupt or
  claim an older job merely because it has the same school/user owner.
- Eligibility is independently rechecked by the server before it accepts a
  `web-wasm` hello. The leased browser copy enables
  `optimize_existing_schedule`; the canonical request remains byte-for-byte
  unchanged for VPS fallback and candidate validation. Closing the executor or
  pressing Stop aborts an outstanding lease long-poll immediately. The retired
  toolbar download control stays hidden, and manual Play never prompts, checks
  status for, or downloads a native Windows Agent.
- Lease heartbeat and candidate upload stay on the main thread while the
  compute-heavy WASM call blocks only its Web Worker. `visibilitychange` and
  `pagehide` terminate local compute, fail any exact lease and call the new
  session-bound `/api/agent-helper/v1/disconnect` endpoint. If mobile or a
  browser is suspended too quickly to send that request, the 30-second lease
  expiry and generation fence return the canonical request to VPS and reject a
  late browser result. A local expiry watchdog terminates WASM 500 ms before
  its last acknowledged lease deadline, and terminal 4xx heartbeat responses
  stop it immediately, so VPS fallback does not run beside orphaned local CPU.
- The server still validates every browser candidate before publication. The
  browser implements the exact `tkb-json-tree-sha256-v1` digest; its cross-
  language vector matches Python after JSON wire serialization. Source markers
  are `tkb-rust-api-v264-browser-refinement-gate` and
  `tkb_new-rust-api-2026-07-23-browser-refinement-gate-v62`.
- The WASM workflow now publishes the same reproducible artifact to both
  `agent_helper/assets/tkb_native_solver.wasm` and
  `web/pages/tkb_native_solver.wasm`. The first generated artifact exposed an
  ABI allocator trap when freeing output: a `Vec` was reconstructed with
  `capacity == length` even though serialization had reserved a larger
  capacity. Both input and output now cross the ABI as exact `Box<[u8]>`
  allocations. `tools/test-browser-wasm-abi.mjs` solves a real tiny timetable
  and frees both buffers; both WASM workflows must run it before accepting or
  auto-committing an artifact. GitHub artifact commit `560a840` contains the
  rebuilt 1,020,728-byte runtime; both Agent and web copies have SHA-256
  `4ad576cd7136349c9aa163df3db0cf4bb63875d3189ec0e2388e4fe40bb36652`, and the
  real local ABI smoke returns `BROWSER_WASM_ABI_OK`.
- Local frontend verification passes browser-WASM **11/11**, the existing
  bridge suite **208/208**, and toolbar/UI **29/29**. Isolated VPS Rust
  verification passes API/coordinator **152/152** and candidate validator
  **20/20**. The full Node suite passes **307/307**. Final isolated staging
  passes scheduler **172/172**, Agent **151/151**, trusted-worker operations
  **5/5**, Rust API **152/152**, and validator **20/20**, ending with
  `STAGING_TESTS_OK`.
- Transactional deployment returned `UPDATE_OK`; backups are
  `/opt/cherry-scheduler-backups/server-state-20260723-084838.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260723-084838.tar.gz`. Public
  health served API v62 idle with `6/6` worker tokens, the planner served the
  v1.64 cache keys, and the live WASM response was 1,020,728 bytes with
  `application/wasm` and the expected SHA-256. A signed-in in-app-browser
  refinement on production `default` completed with `Đã xếp xong!`, remained
  1,566/1,566 with zero gap-2 and zero one-period teacher sessions, emitted no
  browser warning/error, and did not allocate any VPS worker token. That
  already-saturated incumbent remained at 494 teacher sessions and 81 gap-1
  periods rather than accepting an equal or worse rearrangement.

### Agent 1.6.29 dedicated WSL distro recovery (deployed 2026-07-23)

- Live acceptance of 1.6.28 exposed a real modern-WSL edge case: both
  `wsl --list --quiet` and `wsl --list --all --quiet` returned no distro, while
  installing `Ubuntu-24.04` returned
  `Wsl/InstallDistro/ERROR_ALREADY_EXISTS`. The WSL package was healthy at
  2.7.10 and HKCU `Lxss` had no registered child, so retrying the same public
  distro name could never recover.
- New setup installs an official rootfs through `--web-download` under the
  private name `TKBCherryAgent`. It does not run the installer inside an
  existing Ubuntu, Debian or Docker distro. A bounded second private name
  handles an invisible stale registration; Ubuntu and Debian source images are
  fallback options only when WSL explicitly reports the preceding official
  source as unavailable. The installer parses only the `wsl --install` help
  block and updates an older responsive WSL package before using `--name`; a
  lightweight `/bin/true` probe also bypasses a visible but unlaunchable managed
  distro. No distro is unregistered or deleted.
- WSL1/WSL2 selection remains capability based and the runtime contract remains
  `20260723.1`. Setup generation `20260723.2` lets this repaired installer retry
  exactly once over a same-boot marker written by an older setup, while the same
  generation still suppresses UAC loops. Agent source and Windows metadata are
  1.6.29. Full local Agent verification passes **151/151** with one
  platform-semantic skip. Focused WSL/setup/packaging verification passes
  **36/36**. Final isolated VPS staging passes scheduler **172/172**, Agent
  **151/151**, trusted-worker operations **5/5**, Rust API **149/149**, and
  validator **20/20**, ending with `STAGING_TESTS_OK`.
- GitHub Actions run `29979458980` built commit `b014db9`; artifact
  `8552689198` matched its recorded hashes, one-root-entry ZIP and file/product
  version before local DPAPI release signing. The signed public archive is
  88,001,209 bytes with SHA-256
  `b36e5774f7e89402f7ffbb7075eb2541e7a63a1f874558abba128fe8ecfa25f6`;
  its executable is 88,559,299 bytes with SHA-256
  `ed60b70fd5d6aa08d41b4c551ad1261f61bb52078ef3e98689627b855afa0671`.
  Transactional deployment returned `UPDATE_OK`; backups are
  `/opt/cherry-scheduler-backups/server-state-20260723-043044.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260723-043044.tar.gz`. The
  public manifest signature and fully streamed ZIP matched, and public health
  remained idle with `6/6` worker tokens.
- The exact 1.6.29 executable is installed locally and upgraded the old schema-1
  same-boot marker to schema 2 with setup generation `20260723.2`, proving that
  the repaired installer automatically retries once after an upgrade. Its one
  required Windows UAC confirmation is currently pending; until accepted, the
  Agent remains safely in VPS fallback and no distro or local worker is active.

### v1.63 teacher session modes, responsive tables, and SAC fallback (deployed 2026-07-22)

- `oneSessionPerDay.thuX` now stores one mutually exclusive teacher/day mode:
  `{morning:true}` permits only the morning session, `{afternoon:true}` permits
  only the afternoon session, and `{either:true}` permits morning or afternoon
  but never both on that day. No selected mode means no such constraint. Legacy
  boolean `true` remains equivalent to `either`, so existing school data stays
  compatible.
- The three choices render as compact square checkboxes in the
  `Chỉ dạy 1 buổi/1 ngày` table and selecting one clears the other two. The same
  semantics are enforced by client validation and capacity checks, the MILP
  allocator, session CP-SAT, gap-0 CP-SAT, final validator, and adapter local
  LNS. VPS and Agent execution therefore use the same contract.
- All requirement checkboxes use stable 18 px square controls. Desktop tables
  fill their wrapper with fixed, content-appropriate proportions; mobile tables
  retain explicit minimum widths and horizontal scrolling so labels and controls
  do not collapse together. Local visual acceptance measured the desktop table
  and wrapper at 1,341 px in a 1365x900 viewport. At 430x932, the one-session
  table retained 1,240 px and the period-limit table 1,280 px; horizontal
  scrolling, mutual exclusion, and all controls worked with no browser console
  warnings or errors.
- Full local Node E2E verification passed **296/296**. Isolated VPS staging
  passed scheduler **169/169**, Agent **78/78**, Rust API **140/140**, and
  validator **20/20**, ending with `STAGING_TESTS_OK`.
- Agent 1.6.23 detects enforced Windows Smart App Control
  (`VerifiedAndReputablePolicyState=1`) before importing OR-Tools/Pillow or
  loading their unsigned native DLL/PYD dependencies. On such a workstation it
  does not register or claim solver work, displays `VPS`, keeps the updater
  available, and leaves scheduling entirely to the VPS. This avoids presenting
  a broken local-compute path while preserving normal server scheduling. Forced
  UPX packing was removed. A complete local-compute fix still requires trusted
  Authenticode signatures for every embedded EXE/DLL/PYD and then the outer EXE.
- The installed `C:\TKBCherryAgent\TKBCherryAgent.exe` was started after the
  update on 2026-07-22 and correctly showed `VPS`; the verification interval
  produced zero new Code Integrity event 3033 or 3077 entries. The 22:34
  `rustc` security popup came from a one-off local `cargo` test, not from the
  deployed web application or VPS scheduler. Do not repeat local Rust,
  OR-Tools/native-solver, PyInstaller, or Agent package tests on this Smart App
  Control machine; run all native tests in isolated VPS staging.
- The signed public Agent ZIP is 91,746,236 bytes with SHA-256
  `7c7e5499a66bf1c20a955a05f76bfdb94abd343fec3a329f0b22096a1d7f6bb7`.
  Its root executable is 92,342,359 bytes with SHA-256
  `f2d8c7cc6118e8b4368cf367ac2a5f672a2ec2439b169b819180752a69cd2d5e`.
  The public manifest reports 1.6.23 and the public ZIP `HEAD` length matches.
- Transactional deployment returned `UPDATE_OK`. Backups are
  `/opt/cherry-scheduler-backups/server-state-20260722-154806.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260722-154806.tar.gz`. Public
  health reports `ok:true`, zero active/queued jobs, and all `6/6` worker tokens
  available. Production serves API v58, the v1.63 constraints cache and marker,
  and the unchanged v262 bridge marker.

### Agent 1.6.26 automatic first-run WSL setup (deployed 2026-07-23)

- Live testing of 1.6.25 found the one-time setup returned code 2 on a fresh
  Smart App Control workstation. The Windows Store WSL package and
  `VirtualMachinePlatform` were present, but the
  `Microsoft-Windows-Subsystem-Linux` optional feature was disabled. The old
  setup probed `wsl --list` before enabling that feature, so the probe could
  hang or fail and the elevated child reduced the cause to a generic exit code.
- The elevated setup now checks both prerequisite features with signed DISM
  using locale-independent output. It enables missing features before invoking
  WSL, returns restart-required without probing a pending WSL service, and uses
  bounded process-tree timeouts for every servicing, distro and Linux-package
  step. A random one-use JSON result file carries only bounded, path/token-
  redacted diagnostics back to the normal user process; credentials and command
  environments are never persisted.
- Opening an unprepared Agent manually now shows its 420x400 panel and starts
  the one-time UAC setup automatically. Normal Windows startup remains hidden;
  if Windows requested a restart, a small non-secret marker makes the next
  startup show the panel and resume setup automatically. Cancel/failure remains
  visibly on the panel with a retry action while all scheduling stays on VPS.
  Successful setup clears the marker, wakes the existing owner worker and hides
  the panel back into the notification area.
- Source and Windows metadata are 1.6.26. Local Agent verification currently
  passes **126/126** with one platform-semantic skip, including disabled and
  pending Windows features, bounded WSL failure diagnostics, restart-marker
  persistence, automatic first-open setup, retry, and hidden normal startup.
  Isolated VPS staging passes scheduler **172/172**, Agent **126/126**,
  trusted-worker operations **5/5**, Rust API **149/149**, and candidate
  validator **20/20**, ending in `STAGING_TESTS_OK`.
- GitHub Actions run `29973749053` built commit `4c8441d`; the outer artifact
  digest, candidate hash file, one-root-entry ZIP, and file/product version all
  matched before release signing. The signed public archive is 87,989,262 bytes
  with SHA-256
  `a489e51248d25dca6cd2cbee7a3d94ba04f1d9dd8a9cc175402c0a54605c76e8`;
  its executable is 88,546,944 bytes with SHA-256
  `1c771f33caed54c1340844c90bc7f62014f62e68341f91b0e9a12f6ae8449e70`.
  Transactional deployment returned `UPDATE_OK`; backups are
  `/opt/cherry-scheduler-backups/server-state-20260723-022845.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260723-022845.tar.gz`. The public
  manifest signature and fully streamed ZIP matched; API v60 remained idle with
  `6/6` worker tokens.
- The local installed Agent was atomically updated to the exact 1.6.26 hash and
  its manual first-open path automatically displayed the panel and UAC. DISM
  enabled `Microsoft-Windows-Subsystem-Linux`; Windows then set CBS reboot
  pending and a bounded real `wsl --list` probe still timed out after about five
  seconds, proving this workstation genuinely needs one reboot before the WSL
  kernel component can run. The Agent persisted only its non-secret resume
  marker and will automatically continue setup after the next login. Until
  then it remains in VPS fallback and does not claim solver work.

### Agent 1.6.25 notification-area and WSL owner solver (deployed 2026-07-23)

- The Agent now behaves like a notification-area utility on every supported
  Windows path: it starts hidden, double-click opens the panel, X hides it,
  and the context menu exposes Open, On, Off and Exit. The tray backend uses
  only stdlib `ctypes` plus signed Win32 shell APIs, so the Smart App Control
  fallback no longer imports Pillow/pystray or leaves a taskbar-only window.
  Explorer restart is handled through `TaskbarCreated`; bounded retries fall
  back to a visible, closable panel instead of stranding a hidden process.
- Pystray and Pillow were removed from the packaged runtime collection;
  Pillow remains a build-only tool that converts the PNG logo into the EXE
  icon. The redesigned 420x370 control panel states the CPU/RAM ceiling and
  automatically returns to the tray when Agent is enabled.
- On an enforced Smart App Control machine, elevation of the Windows Agent is
  still deliberately rejected as a solution. The panel instead offers a
  one-time elevated WSL setup. Normal Agent launches remain `asInvoker`; UAC is
  used only by `--wsl-setup` to enable/install Ubuntu when needed, create the
  unprivileged Linux user `tkb-agent`, install pinned OR-Tools/SciPy, run a real
  import probe, compile the runtime to bytecode and remove installed `.py`
  files. Smart App Control stays enabled.
- After setup, the Windows process keeps DPAPI pairing, HTTPS, owner scoping,
  lease heartbeat and candidate upload. Only the solver subprocess crosses to
  WSL, so no Agent credential is written into Linux or put on a command line.
  The exact production pipeline runs through stdin/stdout, with worker count,
  adaptive RAM ceiling and hard timeout passed through `WSLENV`. A random
  per-run id fences PID cancellation; OFF first terminates that exact Linux
  process group, then closes the Windows relay. A parent crash still leaves an
  internal Linux timeout, while the existing server lease expiry returns the
  canonical job to VPS. Agent and VPS never solve the same lease concurrently.
- The WSL ready marker is runtime-contract exact (`20260723.1`), so UI-only
  Agent updates do not demand UAC again while a solver/runtime change must bump
  the contract before release. WSL discovery uses a bounded process-tree probe; an
  unavailable/broken WSL service does not leave orphan `wsl.exe` processes.
  This workstation currently has no registered distro, so public live local
  compute still requires the one-time setup after 1.6.25 is installed.
- Local Agent verification passes **111/111**. Final isolated VPS staging passes
  scheduler **172/172**, Agent **111/111**, trusted-worker operations **5/5**,
  Rust API **149/149**, and candidate validator **20/20**, ending in
  `STAGING_TESTS_OK`. This includes a Linux-only end-to-end stdio test for the
  WSL wrapper. Git Bash syntax-checks the embedded installer, Win32 tray
  integration creates/updates/stops a real icon, and the local WSL timeout
  probe returns no runtime with no orphan process.
- GitHub Actions run `29971326206` built commit `362d107`; candidate hashes,
  one-root-entry ZIP and file/product version were independently verified before
  signing. The signed public archive is 87,980,919 bytes with SHA-256
  `4641d511851083089bc98f2e1b455acfbb3d05dc4439a1c79d4bdd07fe540e95`;
  its executable is 88,538,667 bytes with SHA-256
  `cc3ae7cc2ed38695d2728cb2c9b47b5a3f9d71173c5aa7c5baa3046e60242555`.
  Transactional deployment returned `UPDATE_OK`; backups are
  `/opt/cherry-scheduler-backups/server-state-20260723-014247.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260723-014247.tar.gz`. The public
  manifest signature and fully streamed archive matched, API v60 stayed idle,
  and the installed local Agent was atomically updated to the same 1.6.25 hash.

### Post-v1.63 trusted-worker protocol and Agent 1.6.24 (API deployed 2026-07-23; worker dormant)

- The Agent coordinator has an opt-in operator trusted-worker scope for adding
  compute capacity outside the main VPS. It is disabled unless the API process
  receives `TKB_TRUSTED_AGENT_TOKEN_SHA256`, a domain-separated digest of a
  high-entropy `tkbt_` bearer. The raw bearer must exist only on the managed
  worker and must never be committed, embedded in a release, or exposed to a
  browser.
- Browser-paired Agents remain strictly owner scoped. A trusted worker may pull
  the oldest canonical Agent task across owners, but it remains a replacement
  executor: a job runs on the trusted worker or VPS, never both. Only an
  authenticated free lease poll may drain one VPS-queued job; trusted workers
  do not race fresh direct starts and do not interrupt a VPS child that is
  already running. Lease expiry/failure returns the same fenced canonical
  request to the VPS.
- Trusted capacity is deliberately absent from each school's Agent status. The
  server still validates every candidate against the original request and is
  the only component that publishes the result. The lease carries its real job
  owner internally so cancellation checks remain correct without exposing that
  owner on the worker wire.
- This Windows workstation still cannot supply solver compute through the
  packaged Agent while Smart App Control enforces unsigned native-code policy.
  Practical worker hosts are an additional operator-controlled Linux node or a
  tested WSL runtime; the durable Windows solution is trusted Authenticode
  signing of the outer executable and every embedded EXE/DLL/PYD. The existing
  updater-manifest RSA signature is not an Authenticode signature.
- Added Rust unit coverage for global FIFO leasing, hidden owner status,
  trusted-token digest matching, replay-idempotent queue handoff, per-worker
  pending-capacity reservations, and draining queued work without interrupting
  a running VPS job. Isolated Linux staging passes scheduler **169/169**, Agent
  **89/89**, trusted-worker operations **5/5**, Rust API **149/149**, and
  validator **20/20**, ending with `STAGING_TESTS_OK`. Deployment-package
  verification passes **13/13**. The deployed API marker is
  `tkb_new-rust-api-2026-07-23-trusted-worker-race-safe-v60`.
- A committed trusted-worker `leaseRequestId` reserves capacity until its
  AgentJob is registered or claimed, then remains as a non-capacity replay
  tombstone until TTL. Claiming or finishing the Agent task no longer deletes
  that marker, and a replay is scoped to its recorded job, so a delayed retry
  cannot lease an unrelated task or drain a second VPS job. Cleanup after an
  intervening cancel or takeover releases the reservation without deleting the
  tombstone, so neither concurrent polls nor cancel-before-registration can
  overbook or strand the worker. These lifecycle paths have dedicated tests.
- Trusted spillover now walks the real `SolverPoolState.queue` under the pool
  mutex and preserves that deque's FIFO order. A server job whose phase is only
  `VpsQueued` but which has not entered admission is not eligible, and a job
  already present in active `state.jobs` is also excluded. Regression coverage
  holds a fresh pre-admission job on the VPS, holds both acquired and running
  jobs on the VPS, and hands off only the first of two genuinely queued jobs.
- `python -m agent_helper --headless` is the explicit non-GUI continuous-worker
  entry point. It never opens device pairing, passes the process stop event into
  HTTP calls, and requires its credential through the configured environment
  variable. `--check` now verifies the server credential with `/hello` as well
  as probing the real solver. `TKB_AGENT_STATE_DIR` selects an absolute service
  state path; normal Linux source runs otherwise follow the XDG state layout.
- `tools/trusted-worker` contains an Ubuntu installer, hardened single-capacity
  systemd unit, non-secret config, protected credential generator, operational
  runbook, and regression tests. The generator atomically creates a unique
  root-only mode-0600 environment file and prints only the server's
  domain-separated digest. The installer copies an allowlisted runtime into a
  root-owned release and will not start from a symlinked, non-root-owned, or
  incorrectly permissioned credential. A systemd `ExecStartPre` verifies both
  `/hello` authentication and the actual solver protocol before the worker can
  become active. Trusted-worker files are staging-only;
  trusted-worker `*.env` credentials remain excluded from Git and deployment
  archives.
- No existing host currently supplies safe extra capacity: the production VPS
  is the resource being relieved and a second worker there would bypass its CPU
  token pool, this Windows workstation is blocked from unsigned native solver
  code by Smart App Control, no usable WSL Linux distribution is configured,
  and no second Linux host is available. Keep
  `TKB_TRUSTED_AGENT_TOKEN_SHA256` unset until a separate
  operator-controlled Linux node is provisioned and the live queue/fallback
  acceptance in `tools/trusted-worker/README.md` passes.
- Agent source and Windows version metadata are now **1.6.24**. In the enforced
  Smart App Control fallback it creates a controllable taskbar button but stays
  minimized instead of forcing the `VPS` window in front of the user. Focused
  GUI/security/packaging tests pass **23/23**; the full Agent staging suite
  passes **89/89**. The installed copy at
  `C:\TKBCherryAgent\TKBCherryAgent.exe` was updated to the verified 1.6.24
  executable while the Agent was stopped.
- `.github/workflows/build-agent-windows.yml` is a manual, read-only Windows
  runner that builds and smoke-tests an unsigned ZIP/EXE candidate without any
  VPS or release-signing secret. `build_windows.ps1 -SkipReleaseSigning` removes
  any stale manifest and labels that output non-publishable. Exact candidate
  bytes must still be downloaded and signed by the local DPAPI release key
  before replacing the public Agent ZIP/manifest. Authenticode remains a
  separate requirement for local solver execution under Smart App Control.
- Commit `0740c33` is pushed to private GitHub `main`. Transactional deployment
  returned `UPDATE_OK`; backups are
  `/opt/cherry-scheduler-backups/server-state-20260722-174528.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260722-174528.tar.gz`. Public
  health and version serve API v60 with zero active/queued jobs and `6/6`
  worker tokens available. The public page loaded completely in the in-app
  Browser with the toolbar and progress region present and no console warnings
  or errors.
- The signed public Agent 1.6.24 archive is 93,923,421 bytes with SHA-256
  `a4f68328a11bd18202883a115c40358e42bd64402adf52a9a3fd13c1a40bdc29`;
  its executable is 94,485,948 bytes with SHA-256
  `1b76a1f7cfe1939eaec3bccc7f55e356c0ada6f2c7c64b3b104371df573d4536`.
  The public manifest signature, streamed archive size, and streamed archive
  hash were independently verified after deployment.
- Production intentionally has neither the trusted-worker systemd drop-in nor
  `TKB_TRUSTED_AGENT_TOKEN_SHA256` in the running API environment. The global
  spillover path is therefore dormant until a separate managed Linux host is
  provisioned and completes the runbook acceptance; normal VPS and owner-Agent
  scheduling are unchanged meanwhile.

### v1.62 full-width subject requirement tables (deployed 2026-07-21)

- This is a constraints-UI-only change. Scheduler logic, hard-constraint
  semantics, Rust bridge, solver policy, Agent package, and persisted school
  data are unchanged.
- The five tables under `Yêu cầu đối với lớp học 2 ca` and `Giới hạn số buổi
  học` under `Yêu cầu khác` now use the shared `rb-subject-full-table` layout.
  They occupy the complete desktop content width with a 720 px mobile minimum,
  so narrow devices retain deliberate horizontal scrolling instead of
  compressing or clipping headings. The two `Môn học không cùng buổi/ngày`
  grids already used their own full-width scroll layout and remain unchanged.
- Live browser acceptance opened all eight entries in the two menu groups. At
  1440x900, the sample weekly-session table and its content viewport both
  measured 1,399 px; its columns measured `124, 167, 554, 554`. At 430x932,
  the content viewport measured 389 px, the table retained its 720 px floor,
  and horizontal scrolling was available with columns `64, 86, 285, 285`.
  The other five updated tables also rendered at 720 px on the phone; the two
  existing no-same-session/day grids retained their 670 px scroll width.
- Verification: constraints/data/gesture semantics `21/21`, toolbar/mobile/PWA
  `36/36`, JavaScript syntax checks, and `git diff --check` pass. The constraints
  marker is `constraints-ui-v37-full-width-subject-tables`.
- Transactional deployment returned `UPDATE_OK`. Backups are
  `/opt/cherry-scheduler-backups/server-state-20260721-164535.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260721-164535.tar.gz`. Public
  health reports `ok:true`, zero active/queued jobs, and all `6/6` worker tokens
  available. The public page, constraints marker, and full-width CSS all serve
  the v1.62 release.

### v1.61 mobile requirement-grid double-tap actions (deployed 2026-07-21)

- This is a frontend-only constraints interaction change. Scheduler, Rust
  bridge, solver policy, Agent package, and existing persisted requirements are
  unchanged.
- On touch/pen devices, two taps on one `Vị trí phải có tiết dạy` cell within
  380 ms toggle that one required-teaching `X`. A later double-tap removes it.
  A single tap still selects only, swiping still selects a range, and a 550 ms
  hold still applies `X` to the selected range. Mouse double-click behavior is
  not routed through the touch controller.
- In `Yêu cầu cố định`, double-tapping an empty class cell opens the existing
  subject picker with `Nghỉ` as the first item. Double-tapping a visible `Nghỉ`
  or fixed-lesson cell clears it immediately. For teacher/subject fixed-off
  grids, an empty double-tap applies `Nghỉ` directly and the next double-tap
  clears it. Multi-row actions choose add/remove intent from the visible primary
  cell, then apply that action to the selected rows.
- The fixed-subject popup is clamped to `visualViewport`, including rightmost
  and bottom grid cells, and gains bounded internal scrolling. Synthetic native
  click/dblclick events after a handled touch double-tap are suppressed so an
  action cannot run twice.
- Real local browser acceptance at 430x932 used the production UI script: the
  must-teach cell changed `selected -> selected must -> selected`; the class
  picker rendered exactly `Nghỉ, Toán`; `Nghỉ` and a fixed `Toán` lesson could
  each be added and then removed by double-tap; teacher `Nghỉ` also toggled
  directly. Browser warning/error logs were empty.
- Verification: constraints/gesture/data semantics `21/21`, toolbar/mobile/PWA
  `36/36`, JavaScript syntax checks, and `git diff --check` pass. The constraints
  marker is `constraints-ui-v36-mobile-grid-double-tap`.
- Transactional deployment returned `UPDATE_OK`. Backups are
  `/opt/cherry-scheduler-backups/server-state-20260721-162857.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260721-162857.tar.gz`. Public
  health reports `ok:true`, zero active/queued jobs, and all `6/6` worker tokens
  available. The public page and constraints asset serve the v1.61 cache and
  marker; public browser logs were empty.

### v1.59-v1.60 full-width subject grid and click accordions (deployed 2026-07-21)

- These are frontend-only follow-ups to v1.58. No scheduler, Rust bridge,
  solver policy, persisted constraints, or Agent package changed.
- The consecutive-period subject table now fills the available desktop wrapper
  instead of leaving a blank band on the right. It keeps an 820 px mobile
  minimum, uses an 84 px class column and 64 px assigned-period column, and
  distributes the eight Min/Max columns across the remaining width. At a
  1365 px desktop viewport the table and wrapper both measured about 1324 px,
  with columns `84, 64, 147 x 8`; narrow devices retain horizontal scrolling.
- Every requirements group is now click-controlled. The first click opens it,
  a second click on the same group closes it, and opening another group closes
  its sibling. Pointer movement no longer opens or switches groups. The same
  behavior is used by the toolbar button inside a requirements page. Leaf
  navigation and print commands retain their previous actions.
- Submenu buttons expose `aria-haspopup` and synchronized `aria-expanded`
  state. The active menu anchor is excluded from the capture-phase outside
  click so clicking the main `Yeu cau` button again really closes it instead
  of immediately reopening it. Leaf buttons do not receive accordion state.
- v1.60 follows v1.59 with an internal-scroll guard: scrolling or swiping a
  long mobile requirements menu keeps it open, while a real page scroll still
  closes the fixed menu. Live browser acceptance at 390x700 scrolled the long
  subject menu to its lower items and retained the open group; 430x932 and
  desktop click/hover checks also passed. Browser warning/error logs were empty.
- Verification: subject/gesture/copy `19/19`, menu/toolbar `29/29`, mobile/PWA
  `7/7`, JavaScript syntax checks, and `git diff --check` pass. The menu marker
  is `constraints-menu-v3-click-accordion-scroll-safe`; the constraints marker
  remains `constraints-ui-v35-full-width-subject-grid`.
- The final transactional deployment returned `UPDATE_OK`. Final backups are
  `/opt/cherry-scheduler-backups/server-state-20260721-160304.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260721-160304.tar.gz`. Public
  health reports `ok:true`, zero active/queued jobs, and all `6/6` worker tokens
  available. The served page contains both v1.59/v1.60 cache keys and the served
  menu contains no hover-open listener.

### v1.58 compact constraint tables and mobile grid gestures (deployed 2026-07-21)

- This is a frontend-only constraints UI change. No scheduler, Rust bridge,
  solver policy, or Agent code is changed; the v1.57 API and v262 bridge
  markers remain current.
- Subject-requirement tables with numeric values no longer stretch sparse
  columns across the whole viewport. The consecutive-period table uses a
  128 px class column, a 72 px assigned-period column, and eight 84 px Min/Max
  columns. The generic sticky-column selector now targets only the first real
  header row, so the first `Min` heading is centered instead of being mistaken
  for the leftmost class column. The same header-row scoping also fixes the
  multi-row linked-days table.
- The separate `Nhập nhanh` row was removed. Each of the eight quick-fill
  inputs now sits immediately before its `Min` or `Max` label in the second
  header row, while retaining grade-filtered bulk fill behavior.
- Numeric requirement cells reuse the existing Tiết chuẩn-style grid contract:
  mouse drag, Ctrl/Cmd-click, and Shift-click select cells; Ctrl/Cmd+C copies a
  TSV rectangle; Ctrl/Cmd+V pastes a rectangle or repeats one value across the
  selected cells. A browser probe copied `1\t2\n3\t4` from a selected 2x2
  rectangle and pasted `8\t9\n10\t11` back into the matching four cells.
- On touch/pen devices, swiping inside `Yêu cầu cố định` or `Vị trí phải có
  tiết dạy` selects the existing rectangular range. Holding for 550 ms applies
  the same `X` action as the desktop keyboard. Holding an already selected cell
  preserves the multi-selection; normal taps and desktop mouse/double-click
  behavior remain on their prior paths. Native long-press context menus are
  suppressed only for these coarse-pointer grid cells. A swipe starting inside
  the grid deliberately selects cells; scrolling still works from the list or
  outside the grid.
- Local browser verification covered 1440x900 desktop, 440x956 phone portrait,
  and 768x1024 tablet viewports. The compact table measured 872 px, its wrapper
  remained device-width and horizontally scrollable on narrow devices, all
  eight inline quick-fill inputs measured 36 px, and no quick-fill body row was
  present.
- Verification: constraints/gesture/copy-paste `19/19`, toolbar `28/28`, mobile
  cell actions plus PWA `7/7`, `node --check`, and `git diff --check` pass. The
  public page cache is `20260721-v158-compact-constraint-ui-v1` and the
  constraints marker is `constraints-ui-v34-compact-grid-touch-copy`.
- The final transactional deployment returned `UPDATE_OK`. Backups are
  `/opt/cherry-scheduler-backups/server-state-20260721-153807.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260721-153807.tar.gz`. Post-deploy
  health reports zero active/queued jobs and all `6/6` worker tokens available;
  the public page and constraints asset serve the v1.58 cache/marker, inline
  quick heads, touch gesture controller, and clipboard scope guard.
- Final in-app-browser acceptance loaded the live `default` school without
  editing its constraints. The rendered table measured 872 px inside a 641 px
  scroll wrapper, contained 432 spreadsheet numeric cells and exactly eight
  36 px inline quick-fill inputs, had no quick-fill body row, and computed the
  first `Min` header as centered with `left:auto`. Browser warning/error logs
  were empty.

### v1.49 live-default quality investigation (included in v1.50)

- A production replay of the plain `default` school (no non-empty subject
  `lessonBlocks`) returned a complete `1566/1566` timetable with singleton and
  gap-2 debt because the first strict-quality CP-SAT lane consumed the whole
  deadline before its debt fallback could run.
- The scheduler now recognizes an automatic large fresh first click via
  `ui_unified_first_click_quality` + `fresh_complete_first` and enables the
  period-safe completion lane even without subject-period rows. This reserves
  the strict retry/fallback budget and allows the same wide-cap cleanup used by
  the subject-period case to enforce zero one-period sessions and gap <= 1.
- Local verification: result-contract unittest `132/132`, `py_compile`, and
  `git diff --check` pass. The production release is recorded below under
  v1.50, which includes this period-safe completion lane.

### v1.50 subject-period constraint rebuild (deployed 2026-07-20)

- When a complete timetable violates a newly authored subject-period rule
  (`lessonBlocks`, `avoidBreakPair23/34`, or linked-day contiguous-period
  rules), the browser no longer sends it through the staged fill-only repair.
  That repair deliberately skips teacher optimization and only has a short
  quality slice, which was the cause of complete results retaining singleton
  sessions and gap-2 periods.
- The affected path now performs one transactional `fresh_complete_first`
  rebuild. Flexible timetable cells and the old solver payload are stripped;
  fixed lessons and the edited constraints remain. The automatic subject-rule
  ceiling is 180 seconds, and the unified backend first keeps a complete
  hard-valid incumbent, then enforces zero one-period teacher sessions and
  teacher gap at most one. If those quality goals are impossible under the
  authored rules, the complete hard-valid incumbent is retained.
- The violation classifier is scoped to subject-period messages/kinds. A
  teacher-only max-days/max-sessions violation on a school that also has
  subject rules continues to use the existing staged repair path.
- Release markers for deployment: API
  `tkb_new-rust-api-2026-07-20-subject-period-constraint-rebuild-v50`, bridge
  `tkb-rust-api-v255-subject-period-constraint-rebuild`, and page cache
  `20260720-v150-subject-period-constraint-rebuild-v1`. Agent package
  `1.6.18` is signed and hash-matched in `agent_helper/dist` and
  `web/downloads`.
- Local verification: bridge `196/196`, constraint semantics `14/14`, toolbar
  `28/28`, scheduler `149/149`, result-contract `132/132`, Python syntax, and
  `git diff --check`. Isolated VPS staging passed scheduler `149/149`, Agent
  `72/72`, Rust API `136/136`, and validator `20/20`, ending with
  `STAGING_TESTS_OK`.
- Production deployment returned `UPDATE_OK`. Transaction backups are
  `/opt/cherry-scheduler-backups/server-state-20260720-031046.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260720-031046.tar.gz`.
- Post-deploy health reports API v50, zero active/queued jobs, and all `6/6`
  VPS worker tokens available. The public page serves the v150 cache; the
  bridge asset contains `tkb-rust-api-v255-subject-period-constraint-rebuild`,
  and the Agent manifest serves signed `1.6.18`.

### Post-v1.50 Min-block semantics and quality recovery (local, not deployed)

- `lessonBlocks.2.min = 1` means at least one contiguous two-period block for
  that class/subject during the week. Other weekly periods may remain separate.
  An absent/blank `max` means no upper bound; it must not be interpreted as one
  block. Focused solver regressions accept both `[2, 1, 1]` and `[2, 2]`.
- The session CP-SAT model now counts a block formed by a hard-fixed period and
  an adjacent residual period. Previously fixed demand was removed before the
  residual model, so this feasible pair was incorrectly reported impossible.
  Residual-only validation is diagnostic; final merged fixed-plus-residual
  validation remains the authoritative acceptance check.
- A fixed-only timetable naturally violates a weekly `lessonBlocks.min` before
  sorting. The bridge now defers that preflight-only minimum and sends a real
  fixed-anchor fresh solve instead of misrouting it to the short staged repair.
- The final wire normalizer now preserves an explicit unified initial ceiling.
  This fixes a quality rebuild planned for 180 seconds being silently reduced
  to 60 seconds immediately before the VPS/Agent request.
- A first sort keeps a complete hard-valid Phase-F timetable as soon as it is
  found. If it still has singleton/gap-2 debt, only the configured bounded
  cleanup slice is attempted before returning it. A later explicit quality
  rebuild (`ui_quality_debt_fresh_rebuild`) may use the full remaining 180
  seconds. Very rough complete schedules are rebuilt from fixed anchors, with
  the visible complete incumbent retained unless the new candidate is better.
- The ordinary automatic first-quality ceiling is 130 seconds. Subject-period
  and deliberate quality rebuilds may carry a 180-second ceiling; explicit user
  duration still wins and the input itself is never auto-filled.
- Exact local replay of the captured production `default` data completed
  `1566/1566`, hard-valid, with zero application-constraint violations. All
  324 `Min=1` rows were satisfied. Weekly session shapes were `(2)` = 54,
  `(2,1)` = 108, `(2,1,1)` = 149, and `(2,2)` = 13. Thus 257 rows retained
  separate periods while 13 valid rows used more than one pair with no Max.
- The same six-worker replay remains quality-sensitive: a deep 180-second
  rebuild returned `522 sessions / 23 singleton / gap1=83 / gap2=3`; a separate
  first-result replay returned complete at about 158 seconds and was handed
  back immediately at `522 / 25 / gap1=62 / gap2=6`. These are complete valid
  safety results, not the final quality target. Continue the separate teacher
  quality investigation before claiming that later clicks reach the desired
  zero singleton/gap-2 goal reliably.
- Local verification after this candidate: bridge `197/197`, subject semantics
  `14/14`, toolbar `28/28`, unified benchmark `6/6`, scheduler `152/152`, Agent
  `72/72`, Python syntax, and `git diff --check`. Production remains v1.50;
  this candidate has not been staged, packaged, committed, or deployed.

### Post-v1.50 completion-rescue hardening (local, not deployed)

- The production `422` after a long first click had two independent causes:
  fixed-period demand was removed before `lessonBlocks.min` modeling, and the
  large period-safe lane had no emergency completion slice after a CP-SAT
  `UNKNOWN`. The session model now counts fixed+flexible contiguous blocks
  when concrete period choices exist, and defers the affected min/max bound to
  merged validation when a legacy session-only caller has no period bridge.
- Large safe-first requests reserve `35-70` seconds for one relaxed completion
  attempt. That rescue uses the theoretical upper session cap only in this
  emergency lane, keeps all user-authored application constraints hard, and
  never replaces a complete incumbent with an incomplete payload.
- Focused regression covers the no-period-bridge fixed+flexible pair and the
  late-`UNKNOWN` rescue. Local scheduler verification is now `154/154`; full
  backend E2E is `46/46`; bridge `197/197`, benchmark `6/6`, subject semantics
  `14/14`, Agent `72/72`. Isolated VPS staging of this candidate ended with
  `STAGING_TESTS_OK` (`154` scheduler, `72` Agent, `136` Rust API, `20`
  validator). Production remains v1.50; no deployment was performed.
- Exact current `default` fresh-after-delete replay with the previously bad
  seed returned `1566/1566`, `hard_ok=true`, and zero application violations
  after the first complete candidate was found; the run no longer ends as a
  422 merely because the first cap probe is `UNKNOWN`.

### v1.51 completion-rescue quality recovery (deployed 2026-07-20)

- The candidate keeps a complete hard-valid timetable as soon as the strict
  period-safe lane finds one, and never replaces it with an incomplete or
  lower-quality payload. The first-click gate requires zero one-period teacher
  sessions and zero gap-2-plus sessions when those goals are feasible; authored
  constraints remain hard and may legitimately force quality debt.
- A fresh default replay with 1,566 periods and 54 fixed lessons returned
  `1566/1566`, `hard_ok=true`, zero application violations, zero singleton
  sessions, and zero gap-2-plus sessions. A captured strict replay reached
  `522` teacher sessions with gap distribution `0=417, 1=105` in about 66
  seconds. Refinement replays are Pareto-guarded and retain the complete
  incumbent when a tighter cap is inconclusive.
- `lessonBlocks.2.min=1` remains an at-least-one-pair rule; blank `max` remains
  unbounded. Fixed-plus-flexible contiguous pairs are validated only after the
  fixed lessons are merged back into the candidate.
- Local verification: result contract `139/139` plus 9 subtests, bridge/UI
  suites and syntax checks pass. The release Agent is `1.6.19`; its ZIP and
  signed manifest are copied to `web/downloads` and the ZIP contains exactly
  one root-level `TKBCherryAgent.exe`.
- Release markers: API
  `tkb_new-rust-api-2026-07-20-completion-rescue-v51`, bridge
  `tkb-rust-api-v256-quality-recovery`, and page cache
  `20260720-v151-completion-rescue-v1`.
- Isolated VPS staging passed `STAGING_TESTS_OK` (scheduler 156, Agent 72,
  Rust API 136, validator 20). Production deployment returned `UPDATE_OK`;
  post-deploy health reports API v51, zero active/queued jobs, and all `6/6`
  worker tokens available. Public page and bridge markers were verified, and
  the signed Agent 1.6.19 manifest/hash are live.
- The existing in-app browser tab was refreshed after deployment and served
  `phanmon.js` and `tkb-rust-bridge.js` with the v151 cache key; it settled at
  `Sẵn sàng` with no active job. A standalone/PWA tab must be refreshed or
  reopened once if it still holds the old v150 document in memory.

### Post-v1.51 Agent OFF responsiveness (local, not packaged or deployed)

- The Agent ON/OFF window now paints OFF immediately after the stop signal is
  set. Solver cancellation still uses the same event, while an already-open
  long-poll socket may finish harmlessly in the daemon worker. A quick ON click
  during that drain is remembered and starts exactly one fresh worker session
  after the old session exits.
- `ApiClient` observes the worker stop event before every request and during
  retry backoff, so OFF no longer waits through multiple network retry sleeps.
  The lease socket timeout is bounded to the configured long-poll plus a
  five-second transport margin. If a long-poll returns a lease after OFF, the
  worker does not start the solver; the server reclaims that lease normally.
- `Tắt Agent` continues to remove only the app-owned HKCU Run value and leaves
  the lightweight tray process available for a later ON click. `Thoát` closes
  the process; the window X continues to hide it to the tray. The two same-name
  processes visible for a published one-file executable are the normal
  PyInstaller bootloader parent/application-child pair, not two worker leases;
  `SingleInstanceLock` still prevents a second Agent session for the same ID.
- After stopping the observed local executable, both the process list and the
  `TKBCherryAgent` HKCU Run value were confirmed empty. Local Agent verification
  passes all `75/75` tests. The local source candidate is version `1.6.20`; it
  still needs a signed package build and release/deployment decision before
  users receive it. The public manifest remains `1.6.19` meanwhile.

### Post-v1.51 authoritative-idle warning cleanup (local, not deployed)

- An authenticated `/api/solver-state` response with no active, queued, or
  completed owner job now clears a visible stale solver warning/error even when
  the browser has no durable pending job id. This removes an old `Chưa đủ`
  progress ring left behind after an iOS/PWA suspension and unlocks Play.
- An ordinary idle wake does not otherwise reset the page. In particular, the
  legitimate green `Đã xếp xong!` terminal status remains visible; if it ever
  coexists with a stale warning ring, only the ring is removed.
- Focused authoritative-idle regressions pass `3/3`, the complete bridge suite
  passes `203/203`, `node --check`, and changed-file `git diff --check` pass.
  This UI-contract change has not been versioned, packaged, staged, or deployed.

### v1.52 auth recovery and integrated refinement (deployed 2026-07-20)

- Solver/result/state and remote school-store `401/403` responses are now
  authentication expiry, not transport outages. The browser stops polling and
  saving, preserves the canonical VPS job id, performs one central login
  recovery, remembers the protected return URL, and resumes the same owner job
  after authentication. It never cancels or reposts the job during this flow.
- An authoritative owner-state response with no job clears a stale visible
  warning such as `Chưa đủ`, but preserves the legitimate green
  `Đã xếp xong!` status. Shared auth/runtime/storage assets and the login entry
  page have v1.52 cache keys so iPhone/PWA tabs cannot silently keep the old
  recovery code after deployment.
- A complete timetable with subject-period requirements now keeps the exact
  all-session period bridge during `Xếp tiếp`. The backend previously overwrote
  the browser's `lean=false` request, found attractive session-only vectors,
  then rejected them when concrete periods were allocated and returned the
  unchanged incumbent. The overwrite is removed.
- When the incumbent already has zero one-period teacher sessions and zero
  gap-2-plus sessions, the integrated model receives its concrete lessons as a
  soft warm start. A dirty incumbent still explores without that hint. The hint
  is never fixed, and the existing Pareto guard still rejects regressions.
- Exact current `default` replay uses 1,566 periods, 54 fixed lessons, 324
  `lessonBlocks.2.min=1` rows, and 324 avoid-2-3 rules. A no-hint first solve
  completed in 89.003 seconds at `522 sessions / 0 singleton / gap1=108 /
  gap2+=0`, hard-valid with zero app violations. Before the fix, a 180-second
  refine returned the identical `522/108`. After the fix, consecutive
  180-second refinements improved it to `498/87` and then `493/84`, while
  remaining 1,566/1,566, hard-valid, zero app violations, zero singleton, and
  zero gap-2-plus. A shorter 75-second probe already improved `522/108` to
  `514/90`.
- Release markers are API
  `tkb_new-rust-api-2026-07-20-auth-resume-integrated-refine-v52`, bridge
  `tkb-rust-api-v257-auth-resume-integrated-refine`, and page cache
  `20260720-v152-auth-resume-refine-v1`. The minimum/public Agent candidate is
  `1.6.20`.
- Agent 1.6.20 was rebuilt after the final solver change, passed GUI and
  solver-child smoke checks, one-layer UPX integrity, `--version`, ZIP-layout,
  and signed-manifest checks. The public ZIP SHA-256 is
  `c03e17f09bfc2a4a8f6a294c20fa0953ef64a30b241db468c2912910b298a8d3`;
  the executable SHA-256 is
  `3e34a0c863ca86b0e26d6479d8c7fd1501258f729cff010842cb151b14490df5`.
  The final ZIP and signed manifest are copied to `web/downloads`.
- Local verification: bridge/UI `203/203`, other Node UI `74/74`, scheduler
  `157/157`, Agent `75/75`, application E2E `46/46`, deployment/package
  `25/25`, Python syntax, Node syntax, and `git diff --check` pass. The isolated
  Linux staging and production update both completed successfully. Public
  health was rechecked before v1.53 staging and served the v1.52 API marker,
  zero active/queued jobs, and all `6/6` worker tokens available.

### Post-v1.52 non-blocking manual Play (local, not deployed)

- Production tracing found a manual Play could stop after successful
  `/api/solver-state` and Agent-status reads but before `/api/solve-data`.
  The blocking point was the native offline-Agent `confirm` dialog, which ran
  before the progress UI and request preparation and could suspend an embedded
  browser renderer indefinitely.
- Manual Play now chooses immediate VPS fallback. Agent status refresh is
  opportunistic and cannot delay the solve; an online Agent still leases the
  one canonical VPS-owned job through the existing handoff protocol. The
  separate Agent toolbar button remains the explicit install/download action,
  and the legacy invitation helper still supports its direct prompt path.
- Regression coverage verifies that a pending Agent-status request cannot show
  a prompt or delay VPS fallback, and that the offline/Cancel path reaches
  exactly one solve POST with no cancel POST. Bridge tests pass `204/204`,
  toolbar/UI tests pass `28/28`, both changed JavaScript files pass
  `node --check`, and changed-file `git diff --check` passes. This fix has not
  been deployed or in-app-browser retested yet.

### v1.53 VPS-first Play and same-click quality rescue (release candidate)

- Manual Play no longer waits for or prompts about an offline Agent. It creates
  exactly one canonical VPS-owned job immediately. An online Agent may lease
  that same job; turning Agent off leaves VPS as the executor rather than
  blocking the click or creating a second flow.
- A strict quality-cap probe can time out and fall back to a complete but wide
  schedule. Phase Q now starts from that same-click complete schedule as a soft
  incumbent, keeps its current session cap initially, and spends the remaining
  budget on integrated cleanup. It does not fix cells, import a legacy sample,
  or optimize hint distance. This removes the old failure where Phase Q jumped
  straight back to an unrealistically tight cap and returned `UNKNOWN`.
- The exact period bridge and period MILP now apply subject break-pair and
  linked-day rules to merged fixed-plus-flexible blocks. Previously a fixed P2
  plus flexible P3 could pass the residual model under avoid-2-3, then be
  rejected by final validation even though fixed P2 plus flexible P1 was
  feasible. A focused regression covers `lessonBlocks.2.min=1` with this fixed
  anchor and proves the valid P1+P2 pair is selected.
- Exact current `default` replays contain 1,566 periods, 54 fixed lessons, 324
  `lessonBlocks.2.min=1` rows and 324 avoid-2-3 rows, with no legacy solver
  result in the fresh wire. Post-fix seed 101 returned `1566/1566`, hard-valid,
  zero app violations, `579 sessions / 0 singleton / gap1=147 / gap2+=0` in
  137.5 seconds. An independent validation returned HTTP 200. A 180-second
  refine from a comparable `578/154` incumbent improved to `518/100`, retained
  zero singleton and gap-2-plus debt, and again passed independent validation.
  Earlier candidate seeds also reached `521/99`; output is intentionally
  randomized and is not a stored timetable template.
- Release markers are API
  `tkb_new-rust-api-2026-07-20-nonblocking-vps-play-v53`, bridge
  `tkb-rust-api-v258-nonblocking-vps-play`, and page cache
  `20260720-v153-nonblocking-vps-play-v1`. Minimum/public Agent is `1.6.21`.
- Agent 1.6.21 was rebuilt after the final solver change. GUI and solver-child
  smoke tests, one-layer UPX integrity, signed-manifest parsing, one-entry ZIP
  layout, and archive/executable hash checks pass. Public ZIP SHA-256 is
  `06ab213a0dbc5e6bae1befca3327b57501aa71dadb8a0566e5494d7c338f2efa`;
  executable SHA-256 is
  `edd0263bfbdbad594f8e4fddfbc6a2b2702cb0211d6a6166491aec045604b2ff`.
- Local verification passes scheduler `159/159`, Agent `75/75`, bridge
  `204/204`, other Node UI `74/74`, benchmark `6/6`, deployment packaging
  `13/13`, Python/Node syntax, and `git diff --check`. Isolated Linux staging
  passes the same scheduler and Agent suites, Rust API `138/138`, validator
  `20/20`, and ends with `STAGING_TESTS_OK`. Production deployment and browser
  acceptance remain pending at this checkpoint.

### Post-v1.53 localized Min preflight routing (local, not deployed)

- The retained production `default` state after the v1.53 HTTP 422 was replayed
  through the real constraint validator and bridge VM. It contained 1,566
  required periods, 54 fixed cells, 324 `lessonBlocks.2.min=1` preflight
  messages, and a fingerprint-matched 80-second retry record. The captured
  v1.53 validator messages had no structured `kind` field.
- The fallback classifier normalized accents with NFD but did not normalize the
  Vietnamese `d`-stroke. Consequently every localized `chua dat Min` message
  was missed and the fixed-only request was misplanned as `repair_constraints`
  with an 80-second deadline instead of `fresh_complete_first`.
- New sync and async validator results include the stable kind
  `subject.lessonBlocks.min`; constraint-message normalization also explicitly
  maps Unicode `U+0111` after accent removal for old tabs and retained data.
  Replaying the exact production state now plans one fixed-only fresh request,
  records all 324 deferred Min rows, keeps all 54 fixed cells, strips flexible
  solver state, and assigns a 180-second backend deadline. Teacher-only
  violations still retain the staged repair path.
- Verification: focused localized-message regression `1/1`, full bridge suite
  `205/205`, constraint semantics `14/14`, JavaScript syntax, exact
  production-data VM replay, and changed-file `git diff --check` pass. No
  deployment was performed for this scoped fix.
- The browser forwards a 10-second Python-reference watchdog reserve, matching
  the backend contract, while its response/poll lifetime has a separate
  30-second reserve. This prevents a terminal completion near the old
  five-second boundary from racing the process watchdog without making the
  server compute budget itself 30 seconds longer. This frontend contract update
  is not deployed yet.

### v1.54 terminal-result safety (release candidate)

- Production v1.53 failed after the Python solver emitted
  `result:complete/status=200` at about 84.873 seconds. The Rust parent reached
  its 85-second watchdog before the child exited, killed it, discarded the
  already-flushed stdout wrapper, and synthesized an empty HTTP 422. The UI
  correctly retained the original 54 fixed lessons, but no completed candidate
  remained for the browser to apply.
- The helper now flushes its authoritative result wrapper before progress and
  optional artifact logging. Rust keeps a bounded 10-second result reserve,
  observes a successful terminal frame, permits a bounded exit grace, and
  decodes any complete wrapper already in stdout before it may create a timeout
  response. The existing final-response fence still accepts only a complete,
  hard-valid, constraint-clean HTTP 200 payload.
- Cached v1.53 iPhone/PWA requests that still label this fixed-anchor subject
  solve as `repair_constraints` receive the same defensive 180-second server
  ceiling and all six worker tokens. An explicit user-entered duration remains
  authoritative and is never raised by this compatibility rule. Partial repair
  remains the lightweight two-worker lane.
- Unified browser requests keep the 10-second server watchdog reserve but wait
  up to 30 additional seconds for the terminal response and result polling. A
  fake-clock lifecycle regression holds a 180-second job until about 195
  seconds, then proves the complete two-period result is still applied before
  the 210-second client deadline and the durable pending job is cleared.
- Scheduler contract regressions now mirror the large subject-period flow:
  Phase F uses the wide objective-free `fresh_complete_wide_period_safe` lane,
  Phase Q receives that complete result as a soft incumbent and enforces
  singleton `0` plus gap-2 `0`, and a Phase-Q error retains the complete
  hard-valid Phase-F result. The full result-contract module passes `143/143`;
  this was a test-only update and did not change `adapter.py`.
- Release markers are API
  `tkb_new-rust-api-2026-07-20-terminal-result-safe-v54`, bridge
  `tkb-rust-api-v259-terminal-result-safe`, and page cache
  `20260720-v154-terminal-result-safe-v1`. Agent remains `1.6.21`; this release
  does not change the Agent solver contract.
- Focused verification currently passes bridge `205/205`, subject constraint
  semantics `14/14`, Rust API `140/140`, validator `20/20`, stdio protocol
  `5/5`, Python/Node syntax, and changed-file `git diff --check`. Full local
  suites, isolated staging, deployment, and production acceptance are pending.

### Post-v1.54 first-click Pareto tail polish (local, not deployed)

- The unified first-click path previously set the local LNS budget to zero when
  `ui_stop_after_first_complete_schedule` was present. A complete but rough
  Phase-F result could therefore be retained after Phase Q consumed the full
  remaining deadline and returned `UNKNOWN`, with no independent cleanup left.
- After a complete incumbent exists, Phase Q now protects up to 16 seconds of
  the configured local-LNS budget. This reserve is never taken from mandatory
  Phase-F completion and never extends the caller's deadline. It applies to
  both clean and quality-debt incumbents.
- A local candidate is accepted only when complete, hard-valid, constraint
  clean, fixed lessons survive, and `_incremental_refinement_candidate_better`
  confirms no regression in one-period sessions, gap-2 sessions, teacher
  sessions, gap-1 sessions, or total gaps. Failed and slower neighborhoods keep
  the exact incumbent. Attempt metadata records `clean_frontier_polish`,
  `quality_debt_tail_polish`, and `protected_local_tail_seconds`.
- An exact binary-safe replay of the captured 1,566-period default request with
  54 fixed lessons returned `1566/1566`, `hard_ok=true`, zero application
  violations, zero singleton sessions, and zero gap-2 sessions. Phase Q reached
  `536 sessions / gap1=91`; the protected tail improved gap-1 to `89`. A real
  180-second `Xep tiep` replay then improved the same incumbent to
  `503 sessions / gap1=87`, preserving every hard-quality gate.
- Verification: result contract `143/143`, all solver-runtime tests `161/161`,
  benchmark E2E `6/6`, Python syntax, and changed-file `git diff --check`. No
  staging, packaging, or production deployment has been performed for this
  candidate.

### v1.56 quality-frontier polish (staged release candidate)

- Phase Q now continues from the first complete hard-valid timetable instead of
  treating the first clean `0 singleton / 0 gap-2` result as the end of the
  search. Teacher-session and gap-1 targets are carried into the bounded quality
  pass, session early-stop is disabled while that pass is active, and a final
  local LNS slice is reserved for gap polishing.
- The local tail is Pareto guarded: it can never lose periods or fixed lessons,
  increase teacher sessions, introduce gap-2 debt, or regress singleton quality.
  A gap-2 to gap-1 transition is allowed because it removes the higher-priority
  debt; ordinary gap-1 regressions remain rejected. Fresh clicks keep request
  seeds independent and do not use a static hint/template.
- Exact default replay (1,566 expected periods, 54 fixed lessons) remains
  complete, hard-valid, and application-constraint clean with zero singleton and
  zero gap-2 sessions. The first candidate was `506 sessions / gap1=88`; a
  180-second refinement reached `499 / 82`, then independent consecutive
  refinements reached `495 / 78` and `493 / 74`. These are measured replay
  outcomes, not a stored timetable.
- Root-cause replay of the plain `default` first click found that a session-only
  Phase Q could report a 461-session vector whose external period materializer
  failed; the browser then retained the wide `522 / 28 singleton / gap2=8`
  draft. The automatic large fresh path now uses the all-session period bridge
  in both Phase F and Phase Q, and only retains the Phase-F incumbent if the
  integrated quality attempt is inconclusive. Exact raw seed `101` now returns
  `1,566/1,566`, `hard_ok=true`, zero application violations, `501 sessions`,
  zero singleton, and zero gap-2 in about 86 seconds; independent seed `202`
  returns `511 / 0 / 0` in about 104 seconds. A 60-second artificial deadline
  still returns a complete hard-valid schedule, but may retain quality debt due
  to the deliberately shorter budget.
- The Agent package is rebuilt as `1.6.22`; its signed ZIP and manifest are
  copied to both `agent_helper/dist` and `web/downloads`. The public package hash
  is recorded in the release manifest, and the ZIP contains one root-level
  `TKBCherryAgent.exe`.
- Local verification: scheduler `163/163`, Agent `75/75`, bridge/UI `207/207`,
  other Node UI `55/55`, root tests `25/25`, benchmark E2E `6/6`, Python/Node
  syntax, and `git diff --check` pass. Isolated VPS staging passed scheduler
  `163/163`, Agent `75/75`, Rust API `140/140`, validator `20/20`, ending with
  `STAGING_TESTS_OK`.
- Before deployment, the release gate required `UPDATE_OK`, matching health and
  page/bridge cache markers, Agent manifest `1.6.22`, zero active/queued jobs,
  and an Agent-OFF default replay followed by a refinement replay; those checks
  are recorded below.

### v1.56 production acceptance (deployed 2026-07-20)

- `tools/vps-deploy/update-deploy.py` returned `UPDATE_OK`. Transaction backups:
  `/opt/cherry-scheduler-backups/server-state-20260720-175029.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260720-175029.tar.gz`.
- Public health serves API marker
  `tkb_new-rust-api-2026-07-20-quality-frontier-polish-v56`; the page serves
  cache `20260720-v156-quality-frontier-polish-v1`; the bridge asset is v261;
  and the signed Agent manifest is `1.6.22` with archive SHA-256
  `50c1ba1df6cfd5d977fa989eae4d0bc026fb6cd5c4c44f729164921b33e40963`.
- Post-deploy browser acceptance with Agent **OFF** completed on the live
  `default` school: `1566/1566` periods, `hard_ok=true`, application violations
  `0`, `trống 2 tiết=0`, `dạy 1 tiết=0`, `491 buổi`, and `trống 1 tiết=69`.
  The page ended with the concise green `Đã xếp xong!` notice and the VPS had
  zero active/queued jobs and all `6/6` worker tokens available.
- The quality frontier is therefore incremental: a later `Xếp tiếp` may lower
  `buổi` and `trống 1 tiết` further, but it never replaces a complete or
  hard-invalid schedule. Fresh clicks remain randomized and do not use a
  static hint.

### v1.57 canonical cross-device progress (deployed 2026-07-21)

- Root cause of the reported `Xếp tiếp` progress split: the owner tab received
  `solver_queued`, then polled `/api/solver-state` while waiting for FIFO
  admission. When the job became active, that path only refreshed the status
  and live stage; it did not promote the tab from the 12% pre-admission cap to
  the canonical server clock. A second device did promote itself during
  reattach, so the same job could show 12% on one screen and 35% on another.
- The bridge now promotes a tracked job whenever a concrete running item is
  returned by `/api/solver-state`, while queued responses remain capped until
  admission. Promotion is guarded to live state only, so a terminal/idle probe
  cannot resurrect an old progress timestamp.
- Rust server-owned responses now expose one `startedAtMs` derived from the
  canonical watchdog start (falling back to creation time for legacy/unit
  jobs) across initial `solver_started`, queued/running/completed
  `solve-result`, active/queued/completed `solver-state`, and Agent-to-VPS
  handoff. `requestedJobStartedAtMs` is also exposed for observers.
- Release markers: API
  `tkb_new-rust-api-2026-07-21-canonical-progress-v57`, bridge
  `tkb-rust-api-v262-canonical-progress`, and page cache
  `20260721-v157-canonical-progress-v1`.
- Verification before deployment: bridge `208/208`, toolbar `28/28`, subject
  semantics `14/14`, scheduler `163/163`, Agent `75/75`, isolated VPS staging
  Rust API `140/140` plus validator `20/20`, Python syntax/unit checks, and
  `git diff --check` all pass. The focused regression reproduces queued →
  running admission and asserts the owner tab leaves 12% with the same server
  timestamp used by another observer.
- `tools/vps-deploy/update-deploy.py` returned `UPDATE_OK`. Transaction
  backups: `/opt/cherry-scheduler-backups/server-state-20260721-072758.tar.gz`
  and `/opt/cherry-scheduler-backups/app-release-20260721-072758.tar.gz`.
- Post-deploy health reports the v57 API marker, `0` active/queued jobs, and
  all `6/6` VPS worker tokens available. The in-app browser loaded
  `20260721-v157-canonical-progress-v1` and the v262 bridge; its console had no
  warning/error entries. A real `default` solve was intentionally not started
  during acceptance so the user's saved timetable was not changed; the
  queued-to-running and cross-device behavior is covered by the focused
  regression and VPS Rust tests above.

### v1.42 VPS-authoritative PWA wake (deployed 2026-07-19)

- The browser no longer paints a running/reconnecting session from
  `localStorage` alone. After planner data and remote school-store hydration
  are ready, page load performs one authenticated `/api/solver-state` probe.
  A concrete queued, active, or completed owner job is adopted; an empty state
  leaves the UI idle with no hidden polling loop.
- iPhone/PWA wake events (`visibilitychange` to visible, `pageshow`, `online`,
  planner-data-ready, and auth-ready) trigger a new authoritative probe. Wake
  calls are single-flight, preserve the earliest retry when an older suspended
  lifecycle unwinds, and only reattach by canonical job ID. They never enter
  the normal Play pipeline or create another solve POST.
- Stop now unlocks Play/Home, hides progress, and stops timers immediately,
  while server cancellation and idempotent lifecycle cleanup finish in the
  background. Failed cancellation is stored as a scoped durable intent and is
  retried on a later foreground/online wake.
- Schedule deletion and other destructive timetable mutations write a scoped
  revision/tombstone, abort local reattach, suppress stale result discovery,
  and run a cancellation barrier that also discovers a server job when the
  local tab did not yet know its ID. A new manual Play waits for that barrier,
  then clears the tombstone and starts exactly one current-schedule request.
  The valid fixed-only 54-period state is no longer mistaken for incomplete
  browser hydration.
- All direct and menu class/school delete routes force and await remote store
  persistence before a stale result can be accepted. The durable fingerprint
  includes the timetable schedule revision.
- Release markers: page cache
  `20260719-v142-vps-authoritative-pwa-wake-v1`, bridge
  `tkb-rust-api-v247-vps-authoritative-pwa-wake`, planner
  `updated-v10.2 (v1.42 VPS-authoritative PWA wake)`, and API
  `tkb_new-rust-api-2026-07-19-vps-authoritative-pwa-wake-v42`.
- Local verification: Node/UI **256/256**, local API E2E **46/46**, scheduler
  **129/129**, Agent **72/72**, result-contract pytest **117/117 plus 9
  subtests**, and deployment/package tests **25/25**. `node --check`,
  `git diff --check`, and the changed-file credential scan pass.
- Isolated VPS staging passes scheduler **129/129**, Agent **72/72**, Rust API
  **136/136**, and validator **20/20**, ending with `STAGING_TESTS_OK`.
- Production deployment returned `UPDATE_OK` after draining the solver. The
  transaction backups are `/opt/cherry-scheduler-backups/server-state-20260719-085957.tar.gz`
  and `/opt/cherry-scheduler-backups/app-release-20260719-085957.tar.gz`.
  Production health reports API v42, zero active/queued jobs, and all `6/6`
  worker tokens available. A fresh production page served both v142 script
  markers and rendered the complete default fixture (`29/29`, zero unassigned)
  without console errors. Existing iOS/PWA tabs can retain their old document
  and local fixed-only state; close/reopen the standalone app or perform a
  hard reload to obtain the v142 assets before comparing behavior.

### v1.43 Diverse quality seed + fixed-only fallback (deployed 2026-07-19)

- Large fresh solves no longer replace the caller's random trajectory with the
  historical fixed Phase-Q seed `1`. That hidden default made independent
  devices converge to the same 521-session, hint-like result. Reproducible
  Phase-Q seeding remains available only when
  `optimization_first_click_stable_quality_seed=true` is explicitly sent.
- Production package markers are API
  `tkb_new-rust-api-2026-07-19-diverse-quality-seed-v43`, bridge
  `tkb-rust-api-v248-diverse-quality-seed`, planner
  `updated-v10.3 (v1.43 diverse quality seed)`, and page cache
  `20260719-v143-diverse-quality-seed-v1`. Agent **1.6.16** is one-layer UPX
  packed and signed; the ZIP and executable hashes are recorded in the public
  release manifest.
- The packaged Agent ran the 1,566-period fixture to `1566/1566`, zero
  unassigned, hard-valid, with Phase-Q seed `246813579` retained and
  `stable_large_quality_seed=false`. Two local seeds produced different gap
  profiles (`50` and `42`) instead of replaying one hint-like result.

- Production deployment returned `UPDATE_OK` after draining the solver. Transaction
  backups are `/opt/cherry-scheduler-backups/server-state-20260719-095743.tar.gz`
  and `/opt/cherry-scheduler-backups/app-release-20260719-095743.tar.gz`.
  Public health reports API v43, zero active/queued jobs, and all `6/6` worker
  tokens available. The public page serves the v143 assets and the Agent
  manifest serves **1.6.16**.
- Production cross-device resume verification: one tab started a solve, a
  second tab reloaded while it was running, and both tabs observed the same
  canonical server job without a second solve POST. The reloaded tab displayed
  VPS progress (`Đang nối lại lượt xếp...`), both tabs finished with
  `Đã xếp xong!`, and health returned to zero active jobs. An idle reload keeps
  the progress row hidden and performs one authoritative state probe; an empty
  state does not start a hidden polling loop.
- No further release number should be incremented merely to report progress.
  v1.43 remains the production baseline until a separately reproduced defect
  has a verified fix and an intentional deployment decision.

### Post-v1.43 hydration maintenance fix (local, not deployed)

- When planner hydration is still pending and there is no durable pending job,
  the page now waits for the explicit planner/auth/foreground event instead of
  arming a hidden two-second VPS probe loop. A known pending job keeps its
  bounded retry so a real session can still reconnect.
- Delete persistence is now a first-class manual-Play barrier. Every direct or
  menu delete serializes its forced remote save behind any older in-flight
  planner save and exposes that Promise to the solver bridge. An immediate Play
  waits for both server-job cancellation and delete persistence before its one
  solve POST, so users no longer need to refresh after deleting a complete
  timetable and an older asynchronous write cannot later overwrite the new
  result. The regression verifies zero solve POSTs while the delete save is
  pending, followed by one fixed-only fresh request with no stale incumbent.
- Local bridge verification is **188/188** and planner/toolbar verification is
  **28/28**; `node --check` and `git diff --check` pass. Isolated VPS staging also passed
  `STAGING_TESTS_OK` (`131` scheduler, `72` Agent, `136` Rust API, `20`
  candidate-validator tests).
- This maintenance change is intentionally **not deployed yet** and does not
  change the public v1.43 markers. Deploy it only after the scheduler quality
  baseline is accepted, with a clearly recorded release increment.

### Post-v1.43 first-click period-safe quality rescue (local, not deployed)

- The 1,566-period default fixture exposed a seed-sensitive Phase-Q failure:
  seed `202` built a complete `522`-session Phase-F timetable, then spent about
  28.5 seconds rejecting two lean `482`-session vectors at concrete-period
  allocation and returned only `522 sessions / 108 gap-1` after local polish.
- Large fixed-only first clicks keep the fast lean Phase-Q trajectory, so a
  good seed is not penalized. That primary lane is limited to one vector; only
  if it fails concrete-period allocation does the same server job run an
  independent all-session CP-SAT rescue. The rescue seed is derived from that
  click's random seed, carries no Phase-F/cached/static hint, and keeps Phase F
  as the complete hard-valid fallback. One looser request-derived cap remains
  available only when the tight rescue returns early with usable budget.
- The adaptive seed-202 replay completed in **56.523 seconds** at `1566/1566`,
  hard-valid, zero application violations, all `54/54` fixed lessons retained,
  `482` teacher sessions, zero one-period sessions, `61` gap-1 sessions, and
  zero gap-2-plus sessions. The lean vector failed in 12.204 seconds, the
  independent integrated rescue produced `482 / 68` in 17.825 seconds, and
  bounded LNS reduced gap-1 to 61.
- Seed `101` verifies that the rescue is conditional: its lean Phase Q succeeded
  in 14.292 seconds, no integrated rescue ran, and the final result improved
  from the earlier `482 / 50` baseline to `481 / 46` in **56.284 seconds**.
- Seed `303` exercised the rescue path and finished `482 / 51` in **56.429
  seconds**. Compared with its earlier `481 / 57`, this is a one-session versus
  six-gap-1 tradeoff rather than a Pareto improvement; keep it visible in any
  later quality-policy tuning rather than hardcoding one fixture threshold.
- Seeds `101`, `202`, and `303` produced three different canonical assignment
  hashes, so the rescue does not reintroduce the old hidden-hint behavior.
- Evidence is in `.codex_tmp/phase-q-adaptive-fresh-{101,202,303}-{wire,result,evidence,stderr}`.
  Focused regressions cover the preserved lean primary, exact-cap integrated
  rescue, and relaxed-cap error rescue. Result-contract tests pass **122/122**
  and the complete scheduler suite passes **139/139**; `py_compile` and
  `git diff --check` pass.
- This change is local only. Do not deploy or increment the release until it is
  combined with the pending lifecycle work and staging/live verification is
  intentionally completed.

### v1.44 delete barrier + adaptive quality (deployed 2026-07-19)

- The delete-to-sort race is closed end to end. Destructive timetable writes are
  serialized behind older remote saves, expose a Promise barrier, and manual
  Play waits for both cancellation discovery and remote persistence. A failed
  delete save fails closed without posting a solver job. The tombstone also
  blocks stale result adoption after a delete.
- CP-SAT seeds are normalized to the signed 32-bit range before use, including
  derived retry seeds. The regression replays the former `2654435761` failure
  and preserves all fixed lessons while completing the 1,566-period fixture.
- Large first-click quality uses the adaptive Phase-Q portfolio described above:
  the lean incumbent-assisted path runs first; only a failed concrete-period
  vector opens one request-seeded, no-hint all-period CP-SAT rescue, with an
  optional relaxed cap inside the same deadline. Fresh replay evidence covers
  seeds 101, 202, and 303 with complete hard-valid schedules and distinct
  assignment hashes.
- Local verification after this candidate: Node/UI `217/217`, scheduler
  `139/139`, isolated VPS staging scheduler `139/139`, Agent `72/72`, Rust API
  `136/136`, and validator `20/20` (`STAGING_TESTS_OK`). No Agent was started
  for the VPS-only browser path; an offline invitation must be dismissed with
  Cancel/Hủy.
- Release markers are API
  `tkb_new-rust-api-2026-07-19-delete-barrier-adaptive-quality-v44`, bridge
  `tkb-rust-api-v249-delete-barrier-adaptive-quality`, and page cache
  `20260719-v144-delete-barrier-adaptive-quality-v1`. Agent remains `1.6.16`.
- Deployment returned `UPDATE_OK`; transaction backups are
  `/opt/cherry-scheduler-backups/server-state-20260719-113419.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260719-113419.tar.gz`.
- Live health after restart reports API v44, zero active/queued jobs, and all
  `6/6` worker tokens available. The refreshed scheduler served the v144 cache
  and rendered the default fixture complete at `29/29` with zero unassigned.
  The VPS-only browser check used one canonical job while Agent stayed offline;
  no Agent invitation appeared and no second job was created.

### Post-v1.44 iOS terminal-watchdog UI contract (local, not deployed)

- Reproduced the iPhone Home Screen sequence where a fixed-only fresh solve is
  backgrounded beyond its deadline and the VPS retains a terminal
  `no_complete_schedule_before_deadline` result. Foreground recovery was
  correctly polling the canonical job once and settling it, but the poll-only
  catch path bypassed `friendlySolveError`, painted a red `Lỗi`, and exposed the
  raw English server-watchdog text.
- Poll-only reattach now uses the same localized terminal-error contract as the
  foreground solve path. A genuine incomplete watchdog result ends as the
  Vietnamese warning `Chưa tìm được lịch đủ; lịch hiện tại vẫn được giữ
  nguyên.`, records the raw payload only in diagnostics, consumes the pending
  job, unlocks Play, and cannot be rediscovered into a reconnect loop.
- The regression suspends the simulated page for over five minutes and verifies
  one result GET, zero duplicate solve POSTs, zero cancel requests, no raw
  English UI text, a settled job id, and no second poll on the next wake. The
  bridge suite passes **189/189**, planner PWA tests pass **4/4** (**193/193**
  combined), and `node --check` passes. This UI fix does not turn a genuinely
  incomplete watchdog payload into a complete timetable; the solver/watchdog
  cause must be verified separately before a release.

### v1.45 iOS resume + complete-first (deployed 2026-07-19)

- Production logs prove that iPhone backgrounding did not cancel or duplicate
  the reported jobs. Each canonical VPS job ran about `65.16s` with the Agent
  offline, then genuinely returned HTTP `422` because no complete candidate had
  reached the Rust watchdog. The retained result remained available server-side
  and the foreground tab correctly reattached to that same job.
- Poll-only iOS/PWA reattach now routes terminal errors through
  `friendlySolveError`, consumes the terminal job once, unlocks Play, and never
  exposes the raw English watchdog message. A simulated 305-second suspension
  verifies one result poll, zero duplicate solve POSTs, and zero cancel calls.
- Phase F now builds a complete hard-valid timetable before treating singleton
  sessions or gap-2 as quality failures. `maxDays`, `maxSessions`, AM/PM counts,
  and one-session-per-day remain hard in the compact session CP-SAT model and
  are no longer misclassified as concrete-period bridge rules.
- For large period-sensitive data, mandatory Phase F uses the computed
  data-sized feasibility ceiling instead of the UI quality target plus
  headroom. On the exact 1,566-period `default` data, cap `501` failed one of
  three VPS seeds; cap `522` completed all three at `1566/1566`, zero unassigned,
  `hard_ok=true`, while preserving all 54 fixed lessons and the three-day
  teacher rule. A fast failure still retries the theoretical upper completion
  cap; all later quality exceptions retain the validated Phase-F incumbent.
- Soft singleton/gap-2 debt remains allowed when user constraints make those
  goals impossible. Actual CP-SAT regressions cover an unavoidable singleton,
  an unavoidable gap-2, and a fixed lesson plus residual demand under aggregate
  teacher day/session caps.
- Release markers: API
  `tkb_new-rust-api-2026-07-19-ios-resume-complete-first-v45`, bridge
  `tkb-rust-api-v250-ios-resume-complete-first`, and page cache
  `20260719-v145-ios-resume-complete-first-v1`. Agent remains `1.6.16` and is
  deliberately offline for the server-only staging/live path.
- Local verification passes frontend/PWA **229/229** and scheduler **142/142**.
  Isolated VPS staging passes scheduler **142/142**, Agent contract **72/72**,
  Rust API **136/136**, and validator **20/20**, ending with
  `STAGING_TESTS_OK`.
- Production deployment returned `UPDATE_OK`. Transaction backups are
  `/opt/cherry-scheduler-backups/server-state-20260719-141010.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260719-141010.tar.gz`. The public
  bridge SHA-256 matches the release source:
  `691E69D899DB246545342D1F5A5895E7AA1A52908DF65791959190AA34D8EEF1`.
- Live Agent-offline E2E reproduced the reported iPhone lifecycle: start from
  the 54 fixed lessons, click Play, navigate away while the VPS solves, then
  reopen after the solver deadline. The browser reattached with `solver-state`
  and `solve-result`, issued no duplicate solve POST, applied all 1,566 lessons,
  and settled to `Đã xếp xong!` with controls unlocked. The accepted timetable
  had zero unassigned lessons, `hard_ok=true`, 522 teacher sessions, 21
  one-period sessions, 91 gap-1 sessions, and 9 gap-2 sessions. Result
  application plus remote persistence can take another one to two minutes on
  this large timetable after the solver itself has finished.
- Known follow-up risk: the period-safe Phase-F lane reserves no separate time
  for its theoretical upper-cap retry. A fast cap failure is covered and tested,
  but a late CP-SAT `UNKNOWN` on a larger school could consume the click before
  that fallback is constructed. Benchmark a parallel or explicitly reserved
  complete-first lane in staging before changing this production flow again.

### v1.46 strict first-result quality gate (deployed 2026-07-19)

- The production v1.45 result reported by the user was not a statistics bug.
  The retained VPS payload was complete and hard-valid, but genuinely contained
  `522` teacher sessions, `24` one-period sessions, `83` gap-1 sessions, and
  `9` gap-2 sessions. Its objective-free debt-allowed Phase F consumed
  `42.232s`; Phase Q then spent `12.739s` rebuilding the cap-482 model, leaving
  CP-SAT only about `1.1s` of actual search before `UNKNOWN`. The period-safe
  rescue was disabled specifically for this safe-first branch and local LNS had
  no watchdog budget.
- A blank first click now has a 110-second hidden ceiling but stops as soon as
  the first-result gate is met: all required lessons assigned, hard/application
  constraints valid, zero one-period teacher sessions, and zero gap-2-plus
  sessions. The duration input remains blank and an explicit user duration
  still overrides the automatic ceiling.
- Large period-sensitive data tries the wide cap-522 strict gate first. An
  early failure may receive one distinct request-derived seed while preserving
  at least 45 seconds for a completion fallback; a late `UNKNOWN` skips that
  retry rather than consuming the completion reserve. Only after strict paths
  fail may a debt-allowed, objective-free completion fallback run. A complete
  hard-valid debt candidate is retained as a final safety incumbent if that
  fallback itself fails. This keeps unavoidable singleton/gap-2 cases
  schedulable without defining them as a successful quality gate.
- Fresh solves use a new positive random seed per click. Legacy/static session
  hints remain hard-disabled in `_legacy_solver_hints_enabled`; the strict gate
  is an acceptance rule, not a timetable template. Exact-data seed 101 and 202
  early results have different canonical assignment hashes.
- Exact current `default` data includes 54 fixed lessons and the persisted
  `A.Quyen maxDays=3` rule. Local early-stop probes completed at `1566/1566`,
  zero unassigned, hard-valid, and zero/zero quality debt with distinct
  assignment hashes: seed 101 in `38.0s` (`521 sessions / 124 gap-1`), seed
  202 in `27.3s` (`522 / 128`), seed 303 in `31.8s` (`521 / 118`), and the
  formerly rough production seed 2061401938 in `16.2s` (`521 / 120`).
- The same three 110-second wires ran on the isolated VPS with Agent offline:
  seed 101 in `68.5s`, seed 303 in `52.9s`, and seed 2061401938 in `41.0s`;
  every result was `1566/1566`, `hard_ok=true`, zero one-period sessions,
  zero gap-2-plus sessions, and each assignment hash differed. A VPS
  180-second refinement from the seed-101 incumbent reached `472 sessions /
  39 gap-1` in `177.4s`, retaining completeness and both zero gates.
- A real 180-second second-click replay started from the seed-101 early result
  and improved it to `465 teacher sessions / 38 gap-1`, while retaining
  `1566/1566`, zero singleton, zero gap-2, and `hard_ok=true`. This confirms the
  intended split: first click returns a clean timetable quickly; later clicks
  compact sessions and gap-1 from the incumbent.
- Release markers are API
  `tkb_new-rust-api-2026-07-19-strict-first-quality-gate-v46`, bridge
  `tkb-rust-api-v251-strict-first-quality-gate`, and page cache
  `20260719-v146-strict-first-quality-gate-v1`. Agent remains `1.6.16`.
- The candidate's additional fallback-cap and complete-debt-safety regressions
  pass locally; full scheduler tests are `144/144`, bridge plus benchmark UI
  tests are `195/195`, and isolated VPS staging is scheduler `145/145`, Agent
  `72/72`, Rust API `136/136`, validator `20/20` (`STAGING_TESTS_OK`).
- Production deployment returned `UPDATE_OK` after draining the solver. Transaction
  backups are `/opt/cherry-scheduler-backups/server-state-20260719-161523.tar.gz`
  and `/opt/cherry-scheduler-backups/app-release-20260719-161523.tar.gz`.
  Public health reports API v46, zero active/queued jobs, and all `6/6` worker
  tokens available. The deployed bridge SHA-256 is
  `B50D5E9397859D59EB2CFC14DF1A480C1F898DD9E264E530D0B615D498451876`, matching
  the local release source. Public page and bridge markers were verified after
  deployment; the authenticated browser solve was not launched a second time
  after the tab closed during its first click, so the isolated VPS wire probes
  above remain the live solver acceptance evidence.

### v1.47 stable active-progress status (deployed 2026-07-19)

- A reattached job could visibly alternate between `Dang noi lai luot xep...`
  and `Dang sap xep...`: the reattach path and each HTTP 202/timer tick were
  writing different labels to the same status element. The canonical job was
  still singular and continued on the VPS; this was a UI race, not a second
  solver thread.
- All active/reattached/observer paths now paint one stable `Dang sap xep...`
  label. Reconnect ownership remains available in internal progress state and
  diagnostics. The same contract covers temporary transport loss and the HTTP
  409 path that adopts an already-running canonical job with the same schedule
  fingerprint.
- Release markers are API
  `tkb_new-rust-api-2026-07-19-stable-active-progress-v47`, bridge
  `tkb-rust-api-v252-stable-active-progress`, and page cache
  `20260719-v147-stable-active-progress-v1`. Agent remains `1.6.16`.
- DOM-history regressions exercise real poll-only reattach and 409 canonical
  adoption, and reject every active status write except `Dang sap xep.` / `..`
  / `...`. Local verification passes bridge **191/191**, all Node/UI
  **262/262**, local API E2E **46/46**, `node --check`, and `git diff --check`.
- Isolated VPS staging passes scheduler **145/145**, Agent contract **72/72**,
  Rust API **136/136**, and validator **20/20**, ending with
  `STAGING_TESTS_OK`.
- Production deployment returned `UPDATE_OK`. Transaction backups are
  `/opt/cherry-scheduler-backups/server-state-20260719-165330.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260719-165330.tar.gz`.
  Public health reports API v47, zero active/queued jobs, and all `6/6` worker
  tokens available. The public page serves v147, the bridge serves v252 with
  SHA-256 `4E430240DE143A0420AE7C3560611E8CF5C83BBDD8D1C29340F57580225887A8`,
  and the obsolete reconnect status writer is absent. The in-app browser
  loaded the v147 page idle with no v252 warning/error console entries.

### v1.48 subject-period complete first (deployed 2026-07-20)

- The production `default` data gained 324 ordinary subject-period rules: six
  subjects across 54 classes require at least one consecutive two-period block
  (`lessonBlocks.2.min = 1`) while avoiding the period 2-3 pair. These rules
  are feasible and remain hard requirements.
- The previous large first-click lane promoted zero one-period teacher sessions
  and zero gap-2 sessions to mandatory search goals before it had a complete
  timetable. It repeatedly returned 1,565/1,566 candidates until the watchdog
  expired, then incorrectly surfaced HTTP 422 even though the user-authored
  requirements were satisfiable.
- Requests with subject-period rules now use the period-feasibility-first lane.
  The solver must first return a complete, hard-valid timetable that satisfies
  every application constraint. Teacher-session and gap cleanup remains an
  optimization objective for the remaining budget and later manual clicks; any
  residual quality debt must not be reported as an impossible timetable.
- Release markers are API
  `tkb_new-rust-api-2026-07-20-subject-period-complete-first-v48`, bridge
  `tkb-rust-api-v253-subject-period-complete-first`, page cache
  `20260720-v148-subject-period-complete-first-v1`, and Agent **1.6.17**.
- Local verification passes scheduler **147/147**, Agent **72/72**, bridge
  **191/191**, planner/UI **28/28**, constraint UI **12/12**, Python syntax,
  and `git diff --check`. Three independent real-data seeds completed
  `1566/1566`, hard-valid, with zero application violations in about 35-55
  seconds and produced different schedule hashes. The real Agent runner and
  the packed Agent EXE also completed `1566/1566`, hard-valid, with zero
  violations.
- Isolated VPS staging passes scheduler **147/147**, Agent **72/72**, Rust API
  **136/136**, and validator **20/20**, ending with `STAGING_TESTS_OK`.
- Production deployment returned `UPDATE_OK`. Transaction backups are
  `/opt/cherry-scheduler-backups/server-state-20260720-003147.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260720-003147.tar.gz`. Public
  health serves v48 with zero queued/active jobs and all `6/6` worker tokens
  available after the production E2E.
- Authenticated no-Agent production E2E dismissed the Agent invitation with
  Cancel and created one VPS job. The page finished at `1566/1566`,
  `Chua phan: 0`, and the final status `Da xep xong!`; a fresh reload retained
  the complete result and emitted no warning/error console entries. This run
  intentionally proves completion with the two new hard rules. Its first-click
  quality debt is eligible for later manual optimization and is not a reason
  to discard the complete schedule.
- Public Agent archive SHA-256 is
  `d7ea7e965d123adc9b0826535adf2880638c7fa05d440d9597a2981c058f326c`;
  packed executable SHA-256 is
  `5e1135e748fdc4636ec370d8a92b52966de3eefdef0c74dde4d2d12410c25ec8`.

### Post-v1.48 subject-period strict cleanup (local, not deployed)

- The v1.48 completion-first lane correctly preserved the 324 hard subject
  rules, but it returned the first complete debt-allowed timetable immediately
  because `ui_stop_after_first_complete_schedule` and
  `optimization_first_click_skip_global_quality` also suppressed Phase Q. The
  reproduced result was `522` teacher sessions, `28` one-period sessions, and
  `5` gap-2 sessions; this was real quality debt rather than a statistics bug.
- A subject-period first click now retains that complete hard-valid timetable
  as a safety incumbent and opens one bounded strict cleanup at the proven
  complete cap instead of immediately tightening to the ordinary compact cap.
  The cleanup requires zero one-period teacher sessions, teacher gap at most
  one period, and all-session period materialization. A timeout, infeasible
  quality envelope, or cleanup error returns the complete incumbent rather
  than turning a feasible timetable into HTTP 422.
- Exact-data seed-101 replay with the six subjects across all 54 classes used a
  `180`-second ceiling. Phase F retained `1566/1566` at `522 / 28 / 5`; the
  incumbent-assisted cap-522 cleanup then returned `1566/1566`, hard-valid,
  zero application violations, `522` teacher sessions, zero one-period
  sessions, and gap distribution `{0: 418, 1: 104}`. Total optimizer time was
  `119.364` seconds, and the cleanup stopped before any tighter-cap compaction.
- Focused regressions cover strict cleanup despite first-complete stop flags and
  incumbent retention when cleanup fails. Result-contract tests pass
  **131/131** plus nine subtests; the full scheduler suite passes **148/148**
  plus nine subtests. `py_compile` and `git diff --check` pass.

### Post-v1.49 complete clean constraint repair guard (local, not deployed)

- A complete schedule with zero current constraint violations must not enter the
  staged fill-only repair path. That native path intentionally sets
  `native_skip_teacher_optimization=true`, so using it for a complete clean
  schedule preserved rough singleton/gap debt instead of running the normal
  quality refinement. `partialExistingRepairState` now marks a complete
  constraint repair eligible only when preflight reports at least one real
  violation; incomplete schedules and genuinely violating complete schedules
  retain staged repair behavior.
- Added an E2E regression covering a complete constraint-clean timetable and
  verified bridge tests at **193/193**, `node --check`, `py_compile`, and
  `git diff --check`.

### Fixed-only empty-flexible fallback (included in deployed v1.43)

- A Benders candidate that starts from an incomplete fixed-only request can now
  make one guarded retry when its lean anchor-preserving search finds no complete
  result. The retry stays inside the original deadline, discards every soft
  incumbent/hint/warm start, enables the all-session period-feasibility bridge,
  and keeps the fixed lessons plus all application constraints hard.
- The retry is limited to sparse fixed-only inputs with no incumbent payload and
  cannot recurse. Quality-only singleton/gap caps may relax so a complete
  hard-valid timetable remains the priority; user-authored constraints do not.
- The production-shaped local wire
  `.codex_tmp/default-fixed-fresh-wire.json` completed at `1566/1566`, zero
  unassigned, hard-valid, and canonical-validation `ok` in about 57 seconds.
  Its primary solve succeeded. A forced cap-1/lean first vector against the same
  wire then exercised the fallback itself and returned `1566/1566`, zero
  unassigned, hard-valid, all `54` anchors preserved, no hint, and canonical
  validation `ok` in about 37.8 seconds. The focused mock regression verifies
  the same contract. Result-contract verification passes `119/119`; the full
  scheduler suite passes `131/131` and Agent tests pass `72/72`.

### v1.41 iOS/PWA durable resume (deployed)

- A production v1.40 Agent run exposed a reload gap: while the Agent child kept
  running, a slowly hydrated default timetable exhausted the fixed six x 500 ms
  fingerprint grace, discarded its local pending row without consulting the
  server, and showed `0% / Sẵn sàng` with Play enabled. A later manual Play
  found the same canonical job again.
- Reload now primes the persisted progress and locks Play immediately. After
  the short local hydration grace, authenticated `/api/solver-state` is the
  authority: an active Agent/VPS job remains pending, unknown work is detached,
  and a just-completed result receives a bounded 30 x 2 second hydration grace
  so it is not lost at the live-to-terminal boundary.
- Manual Play with a local pending id now enters the immutable poll-only
  reattach directly. It performs zero solve POSTs, zero cancels, and no default
  group sync, constraint release, or timetable mutation before the validated
  result is applied.
- The local candidate also retains a complete hard-valid incumbent for any
  terminal reattach failure and permits a locally-started completed job to
  repair a fixed-only/incomplete reload, including Agent-to-VPS handoff, while
  still rejecting incomplete or hard-invalid terminal payloads.
- Bridge regressions cover slow live hydration, completion during hydration,
  fixed-only Agent-to-VPS recovery, immediate Play/Home locking, and manual
  poll-only adoption. Full local Node E2E passes **253/253** and scheduler
  discovery passes **129/129**. Isolated VPS staging passes scheduler
  **129/129**, Agent **72/72**, Rust API **136/136**, and validator **20/20**,
  ending with `STAGING_TESTS_OK`.
- Production deployment returned `UPDATE_OK`. Transaction backups are
  `/opt/cherry-scheduler-backups/server-state-20260719-071929.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260719-071929.tar.gz`. Public
  health reports the v41 API marker with `0` active/queued jobs and all `6/6`
  VPS worker tokens available. The public bridge asset SHA-256 matches the
  local release source exactly.
- Production VPS-only E2E stopped the Agent, dismissed the Windows invitation
  with Cancel, and created exactly one six-worker job. Reloading and completely
  closing/reopening the scheduler retained the same canonical job, kept Play
  locked, resumed visible progress, and finished green at `29/29` with zero
  unassigned periods. A production Agent E2E then used the online local Agent,
  left all `6/6` VPS workers idle, and also finished green at `29/29` with zero
  unassigned periods. A complete incumbent may saturate early, so a short live
  Agent refinement can finish before a reload is issued; the long-running
  background/resume and Agent-to-VPS boundaries remain covered by the durable
  bridge regressions above.

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

### v1.39 physical incumbent guard (deployed before v1.40)

- Refinement and poll-only iPhone reattach now derive the retained incumbent's
  quality from the visible timetable cells and current teacher statistics,
  even when `tkbSolverResult` is absent or stale. A worse terminal candidate
  cannot replace a complete hard-valid schedule after reload.
- The no-Agent invitation remains explicit: choosing Huy/Cancel continues with
  exactly one canonical VPS solve. Agent status preflight is bounded at 2.5
  seconds, so a hung Agent endpoint falls through to VPS instead of leaving
  the Play control locked indefinitely.
- Regressions cover physical-vs-stale metrics, normal-refinement iPhone
  reattach, Cancel-to-VPS single-flight behavior, and the hung Agent probe.
- Local verification passed bridge 177/177, planner/UI 28/28, and subject
  semantics 12/12. Deployment returned `UPDATE_OK`; backups are
  `/opt/cherry-scheduler-backups/server-state-20260719-054021.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260719-054021.tar.gz`.

### v1.40 cross-tab Agent reattach (deployed)

- A stale settled marker written by an older cached tab can no longer hide an
  active or queued server-owned Agent/VPS job. The authenticated owner-state
  response is authoritative for live work; an explicit Stop still suppresses
  rediscovery through its persistent stop marker.
- Blank/reloaded tabs clear the stale marker before adopting a matching live
  job, while completed jobs already consumed by this browser remain filtered.
  This keeps one canonical executor and prevents a second click from starting
  a duplicate solve.
- Regression coverage now includes an active Agent job hidden by an older tab,
  the existing pending-row race, explicit Stop suppression, and a Rust API
  assertion that Agent-owned jobs remain visible through `/api/solver-state`.
- v1.39 production E2E exposed the old-tab edge; clean one-tab and two-tab
  checks both retained progress and finished green.
- Full local verification passed Node E2E 249/249 and solver 129/129. VPS
  staging passed solver 129/129, Agent 72/72, Rust API 136/136, and validator
  20/20, ending with `STAGING_TESTS_OK`.
- Production deployment returned `UPDATE_OK`. Backups are
  `/opt/cherry-scheduler-backups/server-state-20260719-061201.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260719-061201.tar.gz`.
- Live Agent E2E kept one local `--solver-child` while VPS stayed 6/6 free.
  A v1.40 tab reloaded while two older v1.39 tabs remained open; clicking Play
  in an old tab adopted the same canonical job. Both tabs finished green with
  `29/29`, zero unassigned, and the child exited.
- Live no-Agent E2E waited for the Agent lease to expire, dismissed the prompt
  with Cancel, and used one six-worker VPS job. Reload at 29 seconds resumed at
  26 percent with Play locked; it finished green at `29/29`, zero unassigned,
  and health returned to 0 active/queued with 6/6 workers free. Agent 1.6.15
  was restarted afterward.

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

Latest successful deployment marker observed on 2026-07-24: `UPDATE_OK` for
application v1.83. Public health serves
`tkb_new-rust-api-2026-07-24-latest-login-wins-v75`; the page serves
`20260724-v183-latest-login-wins-v1`, bridge marker
`tkb-rust-api-v280-canonical-quick-gap-baseline`, and Browser executor
`tkb-browser-wasm-executor-v14-adaptive-workload`.
Public health is idle with zero active/queued jobs and `6/6` worker tokens.
Transaction backups are
`/opt/cherry-scheduler-backups/server-state-20260724-164221.tar.gz` and
`/opt/cherry-scheduler-backups/app-release-20260724-164221.tar.gz`.
Public Agent release `1.6.31` and its signed manifest are live. The 88,054,539
byte archive SHA-256 is
`402f4eba12db1b31aa923e0960450855a7314729c90c796889741b31a4aaaa96`; the
88,612,442-byte executable SHA-256 is
`6b1ad2a224713819c5ae0be98743f48a30df3601b00ec8b3c84a2ad6f3ebaece`.
On enforced Smart App Control systems Agent 1.6.31 starts hidden, prepares its
private WSL runtime automatically, and stays controllable from the Win32
notification area. Its WSL runtime marker is `20260724.2` so an existing private
runtime receives the adaptive CPU policy.
Stable active-status DOM histories, iPhone/PWA reattach, No-Agent/Cancel, and
Agent handoff regressions remain covered by the local and isolated VPS suites.
Owner Agents older than 1.6.31 are upgrade-only at the server lease gate.
Trusted spillover remains disabled until a separate Linux node is accepted and
its server digest is configured.

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
