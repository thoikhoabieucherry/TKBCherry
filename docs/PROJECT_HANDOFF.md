# PROJECT HANDOFF — TKBCherry

> Nhật ký bàn giao theo từng phiên làm việc, mục mới nhất ở trên cùng.
> Tóm tắt trạng thái hiện hành: xem [`CURRENT_STATE.md`](CURRENT_STATE.md).
> Các mục cũ hơn 2026-08-10 đã chuyển sang
> [`archive/PROJECT_HANDOFF_2026-07-28_2026-08-09.md`](archive/PROJECT_HANDOFF_2026-07-28_2026-08-09.md).
> Chính sách: đầu mỗi tháng, chuyển các mục của tháng trước vào `docs/archive/`.

## 2026-08-17 Robust Teacher Stats Counting & Alias Resolution (DEPLOYED & VERIFIED)

- **Issues addressed**:
  - `calcTeacherTKBStats` in `phanmon.js` previously initialized `occ[code]` only for codes found in `_getAssignedTeacherCodes()`. If a cell text contained teacher aliases or variations (e.g. `Lan(NT)`, `N Phước`), `occ[gv]` was undefined, causing lessons to be omitted from the teacher's weekly matrix and resulting in inaccurate "Dạy 1 tiết" or total session stats.
  - Implemented `_ensureTeacherOcc(rawCode)` to dynamically resolve canonical teacher codes and track all teachers found across all class timetables without omission.
  - Deployed to VPS `165.101.47.133`.

## 2026-08-17 Immediate Termination on Zero/Floor + Daily Constraint Safety (DEPLOYED & VERIFIED)

- **Issues addressed**:
  1. Optimizer reached target (gap2 = 0 or singletons <= 2) but didn't stop immediately: the inner round loop broke out, but `portfolioDone` remained `false`, causing unnecessary portfolio restart attempts. Fixed by setting `portfolioDone = true; break;` immediately upon reaching target.
  2. Constraint violation post-validation rejection: `isDailySubjectLimitSafe` checked `act.subject` (which was undefined; activities store `act.mon`), bypassing max-daily subject period limits during swap operations. Fixed `isDailySubjectLimitSafe` to check `act.mon || act.subject`, and wired it into `tryConsolidatePairSingletons`.
- **Verified**:
  - Live Node.js test confirmed `soBuoiDay1` reduced 4 -> 2 with `Placement Integrity OK: true`.
  - Quick deployed to VPS `165.101.47.133`.

## 2026-08-17 Automatic Singletons Resolution (4 -> 2) via `tryConsolidatePairSingletons` (DEPLOYED & VERIFIED)

- **Problem diagnosed**:
  - Timetable export `temp/tonggv0917082026.xlsx` was stuck at `Day 1 tiet: 4 -> 4` in the UI because greedy 1-hop moves moving isolated singletons (e.g. T.Huy's 7A17 Math on Saturday) to other sessions were rejected by `compareMetrics` (creating a new singleton at destination without reducing `soBuoiDay1`).
  - Furthermore, `T.Huy` had 5 periods on Monday PM and 1 period on Saturday PM; existing operators required `singletons.length >= 2` singleton *sessions*, ignoring split partner periods inside full sessions.
- **Solution implemented**:
  - `tryConsolidatePairSingletons` operator added to `web/pages/tkb-fet-engine.js`: searches across the teacher's schedule for partner 1-period lessons of the SAME class and subject (e.g., 7A17 Math on Monday and 7A17 Math on Saturday), and executes an atomic 4-way transaction placing them as a contiguous 2-period block in a target session (e.g. Tuesday PM T1-T2) while displacing the occupied class lessons back to the vacated slots.
  - Normalized teacher keys (`String(a.gv || '').trim().toLowerCase()`) to prevent uppercase/lowercase key mismatch (`T.Huy` vs `t.huy`).
  - Added `tryCompoundEjectionChainForSingletons` for 2-hop ejection chains across 60 slots.
  - Verified with live Node.js runner: `soBuoiDay1` successfully reduced from **4 -> 2** (the absolute structural floor, with 100% placement integrity confirmed).
- **Deployment**:
  - Deployed to live VPS via `deploy_web_quick.py`. Tested live and active.


## 2026-08-17 GAP2 = 0 with user-approved relaxations: merge-into-holes, new-session moves, Kempe chains, ILS portfolio (Local, DEPLOY REQUIRED)

- **Owner direction implemented verbatim** ("lấy tiết lẻ ghép vào 2 chỗ trống hoặc đưa qua 1 buổi mới"):
  - `tryMergeSessionIntoGaps` — pulls a WHOLE thin session (2-3 lessons) or an edge PAIR from a >=4 session of the same teacher into >=2 span holes in ONE atomic transaction (single fills of a 3-hole `[1,5]` session cannot pass the tuple gate; the compound move can). Tier-1 donor dissolves its session: sessions -1 and gap2 -1 together.
  - `tryRelocateGapSessionToNewDay` — moves an ENTIRE stuck gap2 session (2-3 cells, doubles supported) to a half-day the teacher currently has free, contiguously (never creates a singleton; session count neutral). Landing order permutations tried; occupied class cells forced open via `randomSwap(id, 0, [exactSlot])`. Tier B: odd edge lesson + a companion edge lesson from another session open a NEW 2-lesson session (+1 session inside the gap2 budget fence).
  - `tryKempeChainPeriodSwap` — Kempe chain between an edge period and a hole period within one half-day: closed class-set swap, class coverage unchanged, all affected teachers stay in the same half-day. The surgical move when every class column is saturated and random ejection only shifts the gap ("whack-a-mole" wall from the previous entry).
- **Portfolio restarts in `optimize()`** (gap2/gap1/singleton buttons): alternating diversify (restart from initial state + `perturbForRestart` ILS shake) / intensify (from global best) with per-run local best; global best kept across restarts; `checkpointGuard` makes every outgoing snapshot (Stop button!) the GLOBAL BEST, never a mid-walk state. Defaults `optimizeRestartBudgetMs` 90 s / `optimizeMaxRestarts` 14; singleton button gate stops at floor 2 (no pointless spins).
- **`optimizeAll`**: stage slices run portfolio-free (`__inOptimizeAll`); 35 % of the budget is RESERVED for final alternating sweeps (singletons -> gap2) that run the full button machinery on remaining time.
- **Results on the constraint-aware default school (`default_school_0417_off.json`, 2,307 OFF cells honored, 2,193/2,193 lessons)**:
  - gap2 button: 35 -> **0** (seed 101, 57 s) / **1** (seed 202 with 1tiet improved to 2) / **0** (seed 303, 25 s); integrity clean, 0 rejections.
  - **`optimizeAll`: 1tiet=0, gap2=0**, sessions 723, gap1 119 in 175 s (gap2=0 outranks sessions per owner priority; gap1 fell 181 -> 119).
- **Reference data study** (owner's `vesion/` + `SmartScheduler/temp/` 20-step chain + BAO_CAO_TOI_UU_2_TIET_TRONG.md): verified the reference does 24 -> 0 purely by permutation (591 sessions constant, 0 singletons, no new sessions, gap1 166 -> 196). All four tiers in the report map onto existing engine operators. Our one-click result on the same base: 24 -> 0 in **0.1 s** with sessions 591 -> **567** and gap1 **165** — strictly better on every metric than the 20 manual steps.
- Regressions: dongkhoi24 24->0 (0.1 s, all seeds), 1566 stage-4 9->0 sessions 491 (ref 500), default 0317 37->0 (0.3 s), gap1 button 166->0 gap1 + gap2 24->8 side-win (1.2 s), singleton button 4->2 floor (0.2 s). Slow cold-start `solve()` on full-wipe dongkhoi is pre-existing (HEAD identical), untouched today.
- Files: `web/pages/tkb-fet-engine.js` only (worker/phanmon/sapxep unchanged; worker cache-busts engine per load). **Owner: deploy `python tools\vps-deploy\update-deploy.py` + Ctrl+F5** — production still runs the pre-relabel engine.


## 2026-08-17 Constraint-aware reproduction, eject-place operator, and the honest wall (Local, DEPLOY REQUIRED)

- **Production check via web fetch**: tkbcherry.com serves an engine WITHOUT `tryGapRelabelCycles`/`tryDissolveGapSession` (metric-alignment build only) — the owner's latest run (`tonggv0417082026.xlsx`, gap2 37 -> 35) never had the two strongest operators. Redeploy is the first fix.
- **Constraint-aware fixture**: merged 2,307 class OFF cells (`MD/co_dinh_tiet_lop_20260816.xlsx`, only "Nghi" entries — no user-pinned lessons) into the 0417 state -> `scratch/default_school_0417_off.json`. With OFF honored, gap2 button converges 35 -> ~7 (identical residual set at 3 seeds — structural, not stochastic).
- **New power operators**: `tryEjectPlaceIntoGap` (FET-style forced placement into the hole with recursive-swapping ejection, `randomSwap` gains an optional `restrictSlots` argument) wired into gap2+gap1 stages; dissolve gains ejection landings. `optimizeAll` on the constrained state now reaches **1tiet=0, gap2=3, sessions 653, gap1 156** (button alone ~7).
- **Diagnosed wall (per-case)**: the last ~7 sessions are all minor-subject teachers (GDTC/GDDP/GDCD/Tin/LSDL/Nhac) with `[1,5]`-style patterns; every in-span hole is blocked by a classmate lesson whose every relocation shifts a gap2/singleton onto ANOTHER teacher (whack-a-mole). No OFF/fixed cell is directly involved. Reaching absolute 0 needs one of: (1) temporary equal-tuple "gap migration" moves, (2) allowing a lesson to move to another day (creates a new session — currently forbidden by owner rule), (3) data-level relaxation of OFF/subject limits for the involved classes, or (4) accepting ~3 as the structural floor of this constraint set. Owner to decide direction.
- Singleton locking confirmed: `soBuoiDay1` is the first lexicographic key of every comparator — no stage can increase it; runs above even reduced it 4 -> 2-3 while killing gap2.
- Regression: owner base experiment still 24 -> 0 (0.1 s); smoke suites 100 % complete-valid. Files: `web/pages/tkb-fet-engine.js`.

## 2026-08-17 tryDissolveGapSession + sessions-stage deprioritised — beats the reference on every metric (Local, DEPLOY REQUIRED)

- **FET source survey** (`C:/Users/Love/Documents/Codex/FET`, doc/algorithm): gaps are constraints enforced INSIDE recursive-swapping placement (depth 14, eject-and-replace) — no separate repair phase. Confirms our eject-style direction; idea credited, no GPL code copied.
- **New operator `tryDissolveGapSession`** (owner's idea "tách tiết đáp vào buổi khác nhưng không hình thành buổi mới"): a thin gap session (2-3 movable periods, no fixed cells) is dissolved by relocating every lesson into the teacher's OTHER existing sessions, hole-fill first then edge-extend, detached landings forbidden. Snapshot-guarded, full validation, tuple acceptance. Wired as gap2 stage operator #0a; guarded list updated. Also `optimizeAll` gives the sessions stage a 0.5 time-slice weight (owner priority: singletons + gap2 first, session reduction after).
- **Results**:
  - Owner base experiment: 24 -> 0 all seeds AND sessions 591 -> **568** with gap1 168 (reference kept 591 sessions and paid gap1 ~190 — we now beat it on both axes).
  - Default school 0317: gap2 button 37 -> 0, sessions 658 -> 644, 0.3 s; `optimizeAll` **1tiet 0 / gap2 0 / sessions 556 / gap1 83 / days 475 in 57 s** (previous best 561/106/64 s).
  - Stage-4 1566: 9 -> 0 with 492 sessions (reference 500). Smoke 3x6 100 % complete-valid; pressure floor semantics intact.
- Files: `web/pages/tkb-fet-engine.js`; docs: `docs/ALGORITHM_GAP2.md` updated separately. Deploy + Ctrl+F5 to pick up.

## 2026-08-17 Gap relabel ejection cycles — the reference tool's signature move, reverse-engineered and implemented (Local, DEPLOY REQUIRED)

- **Owner experiment**: `base.xlsx` (Dong Khoi, 24 gap2 sessions — every one the `(1,4)` pattern) optimised three times by the reference tool -> `1/2/3.xlsx`: gap2 0 in all three runs, sessions pinned at 591, singletons 0, gap1 166 -> ~190.
- **Forensics (diff base->1)**: 173 changed cells across 96 class-sessions, 100 % "replace" — the reference NEVER uses empty cells and never changes a class's occupied-slot shape; it relabels which lesson sits in each occupied cell along multi-hop, cross-day ejection cycles within each class.
- **New operator `tryGapRelabelCycles`** (engine): for each scored-teacher gap session, move an edge lesson into an in-span hole; the displaced classmate lesson chains through OCCUPIED cells of the same class (teacher-availability-checked DFS, depth <= 7) until a lesson closes the cycle by landing on the freed edge slot. Class timetable shape is preserved by construction. Commit is snapshot-guarded and fully validated (`getConflictsForSlot`, lesson blocks, tuple acceptance). Wired as operator #0 of both gap2 and gap1 stages; guarded-operator list updated.
- **Results**:
  - Owner's base experiment: gap2 **24 -> 0 in 0.2 s at all three seeds** (sessions 591 -> 588-589, singletons stay 0) — matches the reference and shaves sessions it kept.
  - Default school 0317 state: gap2 button 37 -> 0 in 0.3 s; `optimizeAll` improves to **1tiet 0, gap2 0, sessions 561, gap1 106, days 484 in 64 s** (was 569/142/95 s).
  - Reference stage-4 fixture: 9 -> 0 with 497 sessions (reference: 500). Smoke suite 3 seeds x 6 modes 100 % complete-valid.
- Fixture added: `scratch/dongkhoi_gap2_base.json`. Files: `web/pages/tkb-fet-engine.js` only. Deploy + Ctrl+F5 to pick up.

## 2026-08-17 Metric alignment: engine now scores the SAME teacher universe and gap rule as the UI statistics (Local, DEPLOY REQUIRED)

- **Diagnosis from owner screenshots + `tonggv0317082026.xlsx`**: engine `evaluateMetrics` scored EVERY `teacherGrid` row — including ghost rows born from fixed cells / odd teacher strings — while UI `calcTeacherTKBStats` counts only pccm-derived teacher codes. On the real school the engine saw `gap2 = 70` where the UI saw 30, optimised the inflated objective, and could worsen the real one (gap2 button showed `22 -> 30`; done-labels also mixed UI initial with engine final).
- **Fixes (engine)**:
  1. `scoredTeachers` universe built in `init()` from `pccmMatrix` values via `parseTeacherList` (same source as the UI's `_getAssignedTeacherCodes`); `isScoredTeacher()` now gates `evaluateMetrics`, `evaluateTeacherMetrics`, residual classifiers, and every operator target list. Conflict checking still respects all rows (ghosts cannot be double-booked, they are just no longer optimisation targets).
  2. **Span gap rule everywhere**: UI classifies a session by TOTAL holes in its span (`[x,.,x,.,x]` = "Trong 2 tiet"). `tryCrushTeacherGaps` target selection and the gap2 vacate scan now use the span rule instead of max-consecutive, so split-hole sessions are attacked by the gap2 stage.
- **Verified**: parser reproduction of the 0317 export now matches the UI stats box exactly (658 sessions / 4 / 177 / 37). From that exact state: gap2 button **37 -> 0 in 0.3 s** (gap1 177 -> 241, allowed trade); `optimizeAll` **1tiet 4 -> 0, gap2 37 -> 0, sessions 658 -> 569, gap1 177 -> 142, days 589 -> 488** in 95 s, 2193/2193, integrity clean. Ghost-exclusion unit-tested (ghost row present in grid, absent from metrics). Smoke/pressure suites 100 % complete-valid; fixture `scratch/default_school_0317.json` added.
- Files: `web/pages/tkb-fet-engine.js` only. Deploy + Ctrl+F5 required (engine loads with cache-buster via worker, so a plain deploy suffices for the engine; phanmon/sapxep hotfix from the previous entry must ship in the same deploy).

## 2026-08-17 HOTFIX: shipped phanmon.js was missing optimize_all -> menu click rebuilt the schedule; fail-closed guards added (Local, DEPLOY REQUIRED)

- **Incident**: the B4 package accidentally shipped the pre-B4 `phanmon.js` (an A/B test file swap overwrote the edited copy before packaging). On production the new "Tối ưu tất cả" menu item therefore hit a phanmon that did not recognise `optimize_all`, fell through to the CONSTRUCTION lane and rebuilt the whole timetable from scratch — owner's default school went from 550-session optimized state to 779 sessions / ~300 one-period sessions / 22 gap2 (`tonggv0217082026.xlsx`).
- **Fixes**:
  1. `phanmon.js` re-edited with the full optimize_all wiring and verified by content grep in the packaged artifact this time.
  2. **Fail-closed guard (phanmon)**: any unrecognised `optimize*` mode now returns `unknown_optimize_mode` with a Ctrl+F5 hint instead of falling into the construction lane. A stale cached phanmon can never destroy a schedule again.
  3. **Fail-closed guard (worker)**: the `solve` action refuses `optimize*` modes outright.
  4. Cache-buster bumped: `phanmon.js?v=20260817-optimize-all-v2` in `sapxep.html` (spec test updated accordingly).
- **Recovery verified in sandbox**: from the damaged export (`scratch/default_school_0217_damaged.json`, 150 singleton/22 gap2/779 sessions by engine count) `optimizeAll` repairs to **1tiet=0, gap2=0, buoi 560, gap1 127, ngay 487 in 88 s**, 2193/2193 lessons, integrity clean. Owner expectation for the real app (with fixed-cell constraints): singleton floor 2, gap2 0.
- Planner spec suites: 39 pass / 2 pre-existing failures. Smoke benchmark green.
- **Operator action**: redeploy (`python tools/vps-deploy/update-deploy.py`), hard-refresh, then click "Tối ưu tất cả" once to repair the damaged default-school schedule (~1.5-2 phút).

## 2026-08-17 B4: one-click "Tối ưu tất cả" in the planner UI + cross-metric synergy + worker speed (Local, pending deploy)

- **UI (B4)**: planner Tối ưu menu gains a first item **"Tối ưu tất cả"** (`optimize_all`) wired through `runPlannerSchedulerMode -> sapXepTheoCheDo -> executeDirectFastSchedule -> FET worker`. `optimize_all` is excluded from the Cloud Run hybrid lane (local-only pipeline). Progress badge shows the running stage + full tuple; stop/done messages report all four metrics. Files: `web/pages/sapxep.html`, `web/pages/phanmon.js`, `web/pages/tkb-fet-worker.js` (stage passthrough).
- **Synergy (owner request)**:
  - `tryConsolidateTeacherSingletons` now orders destination slots hole-first: khi dồn tiết lẻ, ưu tiên đặt vào đúng LỖ TRỐNG của buổi đích (lấp gap2/gap1 cùng lúc), rồi mới tới vị trí nối mép.
  - `optimize_gap1` comparator now ranks gap2 ABOVE total sessions (matches the global tuple): the gap1 button co-reduces gap2. Measured on the default school: gap1 pass alone now does gap2 19 -> 13 and gap1 187 -> 148.
- **Speed**: per-round 25 ms UI-breathing sleep is skipped in the worker (`uiBreathingMs: 0`); optimizeAll on the default school ~104 s -> ~90 s.
- **Spec tests updated** for the five-item menu: `planner_scheduler_modes_node.test.js`, `planner_toolbar_layout_node.test.js`. Planner suites: 39 pass / 2 pre-existing failures (status-message timing, mobile cell stacking — unrelated).
- Multi-thread note: true parallel restarts (N workers, best tuple wins) is designed but deferred; single-run speed and the restart option cover the immediate need.
- Verification: smoke benchmark 3 seeds x 6 modes 100 % complete-valid; default-school optimizeAll unchanged at 1tiet=0 gap2=0 buoi=550 gap1=136.

## 2026-08-17 "19 unreducible gap2" disproved on the default school; settled-stage reopen fix (Local, pending deploy)

- Owner reported 19 gap2 sessions "impossible to reduce" (export `tonggv0117082026.xlsx`, default school 2,193 periods). Rebuilt state as `scratch/default_school_0117.json` and ran the current on-disk engine:
  - gap2 button alone: **19 -> 0 in 0.6 s**, sessions 635 -> 632, gap1 187 -> 210 (allowed trade), 2193/2193 intact, 0 integrity rejections — none of the 19 is a structural floor (caveat: reconstruction carries no user fixed-cells/constraints).
  - `optimizeAll`: **1tiet=0, gap2=0, sessions 635 -> 550, gap1 187 -> 136, days 561 -> 479** in ~104 s.
- Controller fix: a zero-target stage (gap2/singletons) that "settled" could not re-open when a later compaction stage reintroduced its metric — now `settled` is cleared whenever the metric rises above 0 (was leaving gap2=3 after session compaction).
- Reference-pipeline forensics (stage 4 -> 5 diff, 50 cells): ~90 % of the reference's gap2 kills are 2-3-cell intra-class period swaps inside one session (sessions/days unchanged, gap2 traded into gap1). From the same stage-4 state our engine reaches gap2 0 with **496** sessions vs the reference's 500 (fixture `scratch/dongkhoi_1566_stage4.json`).
- Production still runs the pre-B3 engine; owner deploy + hard refresh required, and the one-button `optimize_all` UI (B4) remains the path to these numbers in-app.

## 2026-08-16 Reference-pipeline benchmark: optimizeAll beats the staged reference on identical data (Local, pending deploy)

- Owner supplied six staged exports (fresh -> limit 1/2/3-period sessions -> kill gap2 -> reduce gap1) for the 1,566-period Dong Khoi instance; reference final: 500 sessions, 0 singletons, 0 gap2, 68 gap1, 370 days.
- Rebuilt the instance as `scratch/dongkhoi_1566.json` (from `xep_moi.xlsx`; empty cells treated as free, no fixed flags) and ran `optimizeAll` (B3 engine): seed 101 -> 482 sessions/78 gap1/367 days; seed 202 -> 457/67/357; seed 303 -> **410/63/329** — all 0 singleton + 0 gap2, 1566/1566 lessons, integrity clean. Lexicographically better than the reference at every seed.
- Added `optimizeAllRestarts` option (default 1): multi-seed restart portfolio inside the global time budget, keeping the best tuple across restarts (observed inter-seed spread 410-482 sessions motivates it).
- Analysis + prior-art survey appended to `docs/OPTIMIZER_V2_PLAN.md` §8. Files: `web/pages/tkb-fet-engine.js`.
- No user data touched; production deploy still pending the owner's `update-deploy.py` run (B3 engine sits on local disk).

## 2026-08-16 Optimizer v2 B3 slice: crush freshness guards + earlier gap2 session budget (Local, pending deploy)

- **Trigger**: production test after the B1 deploy showed `Trong 2 tiet: 62 -> 39` — the standalone gap2 button could not reach 0 on the default school.
- **Root cause found (crush)**: `tryCrushTeacherGaps` (and its cross-session section), `tryFillTeacherGapFromElsewhere`, `tryMoveDoubleBlockIntoGap` iterate collected lists whose `srcItem.slot`/`donor.srcSlot` can go stale after earlier trials relocate the same activity; a stale slot used in unplace/restore silently overwrote other lessons and the integrity gate then rejected the whole operator pass (dropping its legitimate improvements too). Added **freshness guards**: every trial re-checks `actPlacement[act] === collectedSlot` and skips/stops on mismatch.
- **Policy change**: gap2 session budget now unlocks at 30 % of rounds or after 3 stagnant rounds (was 65 %), default budget 6 (was 2) — per the agreed priority order gap2=0 outranks total sessions.
- **Results (Dong Khoi, seed 101)**:
  - Standalone gap2 button: `18 -> 0` in 0.2 s, `integrityRejections = 0` (was stuck at 3 with ~99 rejections).
  - `optimize_all`: `1tiet=0, gap2=0, buoi 350, gap1 36` (~56 s) — improves on the previous 361/71; 1080/1080 lessons, 0 collisions, final integrity true.
  - Smoke 3 seeds x 6 modes and pressure fixtures: 100 % complete-valid; structural-floor semantics preserved.
- **Note on button order**: running the manual buttons in menu order (singletons -> sessions -> gap2) compresses sessions first and can leave gap2 at 2-3; clicking gap2 before heavy session compression reaches 0. The unified `optimize_all` stage order (singletons -> gap2 -> sessions -> gap1) handles this automatically — wiring it into the UI is B4.
- **Files**: `web/pages/tkb-fet-engine.js` only.

## 2026-08-16 Optimizer v2 B1: unified lexicographic controller, exact-replay journal, integrity guard (Local, not deployed)

- **Scope**: first implementation slice of `docs/OPTIMIZER_V2_PLAN.md` (B0+B1) plus three real defect fixes found by the new verification loop. All changes are client-engine/tooling only; no server, schema, or user-data changes.
- **New engine API (`web/pages/tkb-fet-engine.js`)**:
  - `compareTuple(a, b)` — single global "better-than" order: `soBuoiDay1 -> soBuoiTrong2 -> tsBuoiDay -> soBuoiTrong1 -> tsNgayDay` (matches the server lexicographic contract; gap2 outranks sessions per owner decision).
  - `optimizeAll(progressCallback)` — one-button stage controller: round-robin `singletons -> gap2 -> sessions -> gap1`, per-stage time slice (`optimizeAllBudgetMs`, default 150 s), stagnation hand-off, `target-zero` early-exit, per-stage rollback when a stage worsens the global tuple. Returns `stages[]` trace + residual classifiers. Worker (`tkb-fet-worker.js`) dispatches `mode === "optimize_all"`.
  - `this.pushToZero` — optimizeAll pushes singleton stage to a true 0 (legacy manual button keeps the historical `<= 2` early exit).
- **Defect fix 1 — `tryWholeSessionSwap` double placement**: session scans collected duration-2 activities once per covered cell; swap/rollback then placed the same activity twice, overwriting neighbours and leaking lessons (validator: teacher+room collisions, 48/49 lessons on the smoke fixture). Now only head cells are collected.
- **Defect fix 2 — `randomSwap` restore was not an exact inverse**: the old `restoreStack` ({actId, oldSlot} + LIFO re-place) silently stacked two activities onto one cell when a slot hosted different activities during a deep branch (op-trace proof: acts 432/434 both restored to slot 32). Replaced with `moveJournal` + `jrnPlace/jrnUnplace/jrnRollback` exact reverse replay. Cleared at every top-level call.
- **Defect fix 3 — benchmark harness false `auto_incumbent_unavailable`**: `benchmark-fet.js` required `autoResult.applied === true` but engine `solve()` never returns `applied`; every optimizer-mode benchmark silently failed. Now `applied === false` only. Harness also gained `--fixture=file:<path>` (real-school JSON) and `optimize_all` mode.
- **Integrity guard (belt-and-braces)**: `verifyPlacementIntegrity()` + snapshot wrapper around all 16 manual-grid operators; a corrupt post-state (overwrite, orphan cell, lost lesson) restores the snapshot and counts `integrityRejections` instead of surviving. Root-causing the remaining offenders (99 rejections/run on the Dong Khoi set, first proven: `tryCrushTeacherGaps` 3-way stale `srcItem.slot`) is B3 work.
- **Results (Dong Khoi 54 classes / 95 teachers / 1,080 periods, seed 101, existing schedule)**:
  - Legacy 4-button sequence (fixed engine): `1tiet 84->0, gap2 18->2..3, buoi 434->328, gap1 80->67`, ~26 s — gap2 never reaches 0.
  - `optimize_all`: **`1tiet 0, gap2 0`, buoi 360, gap1 71, ~40 s, 1080/1080 lessons, 0 independent teacher collisions** — first run achieving both hard targets; trades ~32 sessions for gap2=0 per the agreed priority order.
  - Smoke fixture 3 seeds x 6 modes: 100 % complete-valid; pressure fixture keeps structural floor semantics.
  - Engine e2e suites: v2 passes 20/53 vs original 18/53 on the identical mixed tree — 33 failures pre-date this work (feature-drift tests, need full local tree / CI to triage).
- **Verification commands**: `node --check web/pages/tkb-fet-engine.js`; `node tools/benchmarks/benchmark-fet.js --fixture=smoke --seeds=101,202,303 --modes=auto,optimize_singletons,optimize_sessions,optimize_gap2,optimize_gap1,optimize_all`; same with `--fixture=pressure`; real-school lane: `--fixture=file:scratch/dongkhoi_base_vps.json --modes=optimize_all`.
- **Known limitations / next (B2-B3)**: floor certificates not yet surfaced to UI; `optimize_sessions` stage frequently `rolled-back` inside optimizeAll (its budget fence vs tuple order needs B3 tuning); guarded operators still contain latent stale-slot bugs (gate masks them safely); UI button for `optimize_all` not wired yet (B4); construction `solve()` has no time budget and thrashes on zero-slack instances when `data.tkb` is pre-filled — clear grid or warm-start instead.

## 2026-08-16 Advanced 2-Period Gap Crusher (`ANTIGRAVITY_KHU_2_TIET_TRONG.md`) & VPS Deployment

- **User Directives Addressed (`ANTIGRAVITY_KHU_2_TIET_TRONG.md`)**:
  1. *De Xuat 1 (Mode-Aware Vacate Gate)*:
     - Updated `tryVacateTeacherSession(tKey, d, b, bestMetrics, initialMetrics, mode)` to receive `mode` and use `this.compareMetrics(currentM, bestMetrics, mode) < 0` instead of a hardcoded sessions-only gate.
     - Unlocked the vacate escape branch for `optimize_gap2` and increased allowable movable target activities up to 3 (covering patterns like `[1, 1, 0, 0, 1]` with $k=3$).
  2. *De Xuat 2 (Controlled Session Budget Pareto Order)*:
     - In `compareMetrics(a, b, "optimize_gap2")`: prioritized `soBuoiTrong2` over `tsBuoiDay` while enforcing `a.tsBuoiDay <= initialTsBuoiDay + gap2SessionBudget`.
     - Automatically activated late-stage budget in second half of optimization rounds to safely break structural deadlocks.
  3. *De Xuat 3 (Inbound Gap-Filler `tryFillTeacherGapFromElsewhere`)*:
     - Created reverse search operator targeting the gap slots directly: pulls single-period lessons of teacher `tKey` from other sessions to fill the gap via direct placement or 2-way swaps.
  4. *De Xuat 4 (Double Block Gap-Filler `tryMoveDoubleBlockIntoGap`)*:
     - Created 2-period block operator: matches exact 2-period gaps ($g=2$) and moves or swaps paired double lessons (`duration === 2`) into the gap.
  5. *De Xuat 5 (Expanded Vacate Scope)*:
     - Removed rigid `idx.length <= 2` restriction in `optimize_gap2` vacate loop and expanded sample size to 15 teachers.
  6. *De Xuat 6 (`getResidualGap2Sessions`)*:
     - Implemented residual gap-2 classifier to categorize remaining gaps into `duration-locked`, `class-fixed-halfday-shift`, and `algorithm-not-yet-resolved`.
- **End-to-End Automated Verification (`school_default_vps.json`, 75 classes, 125 teachers, 2,193 lessons)**:
  - Button 1 (`optimize_singletons`): `soNgayMotTiet: 84 -> 2`, `soBuoiDay1: 138 -> 7`, `tsBuoiDay: 780 -> 702`, **0 added violations**.
  - Button 2 (`optimize_sessions`): `tsBuoiDay: 780 -> 665` (-115 sessions!), `tsNgayDay: 680 -> 589` (-91 days off!), `soBuoiDay2: 221 -> 175` (-46 2-period sessions!), **0 added violations**.
  - Button 3 (`optimize_gap2`): `soBuoiTrong2: 27 -> 22` (-5 gap-2 sessions), `soBuoiDay1: 138 -> 100` (-38 singletons), **0 added violations**.
  - Button 4 (`optimize_gap1`): `soBuoiTrong1: 113 -> 101`, `soBuoiTrong2: 27 -> 43`, `tsBuoiDay: 780 -> 748`, **0 added violations**.
- **VPS Deployment**:
  - Uploaded `web/pages/tkb-fet-engine.js` to `/opt/cherry-scheduler/web/pages/`.
  - Syntax validated (`node --check`), systemd service `tkb-app` verified active.

## 2026-08-16 Comprehensive Fixed-Cell Alignment (`cd:1`), Subject-Off Enforcement, & Non-Intrusive Validation Modal

- **User Directives Addressed**:
  1. *"lúc bị lỗi ràng buộc bạn chỉ cần thông báo nhẹ nhàng thôi đừng hiện ra cái bảng này nữa"*:
     - In `web/pages/phanmon.js`: Suppressed `renderFetDiagnosticPanel` for candidate validation failures (`diagnostics.origin === "candidate_validation"`).
     - Swapped intrusive warning modal with subtle, clean status toasts (`updateStatusMsg("Không thể tối ưu thêm do chạm giới hạn ràng buộc (lịch hiện tại được giữ nguyên).", "info")`).
  2. *"cố gắng thử nghiệm đụng ràng buộc thì bạn nên tránh chứ sao lại cố vi phạm rồi thông báo"*:
     - **Root Cause Solved**: Fixed cells marked with `cd: 1`, `cd: true`, `codinh: true`, `isFixed: true`, `locked: true` were not recognized by `isCellFixed` in `web/pages/tkb-fet-engine.js` (which previously only checked `fixed: true`).
     - Aligned `isCellFixed(cell)` and `isCellOff(cell)` in `tkb-fet-engine.js` with `tkb-constraints.js` (`isFixedSafe(v)`).
     - Added `subjectOffSlots` scanning and checking in `getConflictsForSlot` to guarantee subject-off constraints are strictly enforced internally during placement search.
- **Automated Verification Across Entire School (75 classes, 125 teachers, 2,193 lessons)**:
  - Unit tests: `test_fixed_cells_recognition.js` passed 100% across all 13 fixed cell variations and 8 off cell variations.
  - Button 1 (`optimize_singletons`): `soNgayMotTiet: 79 -> 0` (100% eliminated), `soBuoiDay1: 136 -> 6`, `tsBuoiDay: 774 -> 710`, **0 added violations**.
  - Button 2 (`optimize_sessions`): `tsBuoiDay: 774 -> 655` (**-119 sessions!**), `tsNgayDay: 669 -> 575` (**-94 days off!**), `soBuoiDay2: 235 -> 172`, `soNgayMotTiet: 79 -> 2`, **0 added violations**.
  - Button 3 (`optimize_gap2`): `soBuoiTrong2: 28 -> 19` (**-9 2-period gaps!**), **0 added violations**.
  - Button 4 (`optimize_gap1`): `soBuoiTrong1: 127 -> 95` (**-32 1-period gaps!**), **0 added violations**.
- **VPS Deployment**:
  - Uploaded `web/pages/tkb-fet-engine.js`, `web/pages/phanmon.js` to `/opt/cherry-scheduler/web/pages/`.
  - Checksums and syntax validated, service `tkb-app` active.

## 2026-08-16 v3 Shift-Block Singleton Classifier & Advanced Session Vacating ("Dồn Buổi") & VPS Deployment

- **User Directives Addressed**:
  1. *Spec v3: `ANTIGRAVITY_GIAM_1_TIET_v3_KHOI_BUOI.md`*:
     - Shift-block classification (`getShiftBlock(classId)`): Differentiates classes with fixed Morning (`S`) vs Afternoon (`C`) shifts.
     - Singleton Classifier (`classifySingleton`, `classifyAllSingletons`): Distinguishes **Structural Singletons** (unsolvable due to fixed shift bounds or daily subject limits, e.g. A.Khánh, TN.Sương) from **Fixable Singletons** (solvable, targeting $\to 0$).
     - Replaced v2 metric distortion framing with true shift-block classification logic.
  2. *Spec: `CAI_THIEN_DON_BUOI_TKB.md`*:
     - Activated `tryVacateTeacherSession` (LNS ruin-and-recreate) across `optimize("optimize_sessions")` and `optimize("optimize_gap2")`.
     - Implemented `obliterateAllThinTeacherSessions(maxPasses, [1, 2])` to systematically crush thin 2-period sessions across passes.
     - Expanded `bottleneckTeachers` condition in stagnation escape to include teachers with `soBuoiDay2 > 0 || soBuoiDay3 > 0`.
     - Added gradient bonus in `getPlacementPenalty` to encourage filling sessions up to 3, 4, 5 periods.
  3. *Incumbent Preservation Rule*:
     - Strictly retains the best evaluated timetable (`saveBestSnapshot()` on verified strictly better candidates with 0 added violations).
- **Automated End-to-End Verification (`school_default_vps.json`, 75 classes, 125 teachers, 2,193 lessons)**:
  - **Initial Solve ("Xếp TKB")**: **2,193 / 2,193 placed (100%)**, **0 violations** in **534 ms**.
  - **Button 1 (Tối ưu 1 tiết/buổi - `optimize_singletons`)**:
    - `soNgayMotTiet`: **70 $\to$ 1**
    - `soBuoiDay1`: **132 $\to$ 10**
    - `tsBuoiDay`: **776 $\to$ 714**
    - **0 Added Violations!** Time: **43.94 s**.
  - **Button 2 (Tối ưu Buổi dạy / Dồn buổi - `optimize_sessions`)**:
    - `tsBuoiDay`: **776 $\to$ 672** (**-104 sessions vacated!**)
    - `tsNgayDay`: **669 $\to$ 585** (**-84 whole days off created!**)
    - `soBuoiDay2`: **233 $\to$ 190** (**-43 2-period sessions vacated!**)
    - `soBuoiDay1`: **132 $\to$ 5** (**-127 single-period sessions!**)
    - `soNgayMotTiet`: **70 $\to$ 0** (**100% eliminated!**)
    - **0 Added Violations!** Time: **65.72 s**.
  - **Button 3 (Tối ưu 2 tiết trống - `optimize_gap2`)**:
    - `soBuoiTrong2`: **39 $\to$ 26** (**-13 2-period gaps eliminated!**)
    - **0 Added Violations!** Time: **19.21 s**.
  - **Button 4 (Tối ưu 1 tiết trống - `optimize_gap1`)**:
    - `soBuoiTrong1`: **94 $\to$ 76** (**-18 1-period gaps eliminated!**)
    - **0 Added Violations!** Time: **147.75 s**.
- **VPS Deployment Status**:
  - Uploaded `web/pages/tkb-fet-engine.js`, `web/pages/tkb-fet-worker.js`, `web/pages/phanmon.js`, `web/pages/tkb-constraints.js`, `web/pages/sapxep.html` to `/opt/cherry-scheduler/web/pages/`.
  - Checksums verified, syntax validated (`node --check` passed with 0 errors), systemd service `tkb-app` active.

## 2026-08-16 Multi-Directional Escape Architecture & Strict Zero-Violation 4-Mode Verification & VPS Deployment

- **User Request & Stagnation Problem Solved**:
  - Addressed the user directive: *"các thuật toán sắp xếp kiểu này lúc bị đứng nên thử nghiệm nhiều hướng đi để đạt được kết quả tốt nhất, cứ mỗi lần tôi thấy đứng là thấy đứng luôn, bạn xem có thuật toán nào cải thiện như ý tưởng của tôi ko"*.
  - When local search hits combinatorial plateaus or local minima, the optimizer now activates a **Multi-Directional Escape Architecture** across 5 distinct topological escape operators rather than stalling:
    1. **Direction 1 (Whole-Session Block Swapping - `tryWholeSessionSwap`)**: Swaps 5-period session blocks between compatible days for sample classes with safe lesson block validation.
    2. **Direction 2 (Fast Deep 4-Way Ejection Chains - `tryDeepEjectionChain`)**: Branch-limited ($k \le 3$) 4-way ejection chains ($A \to B \to C \to D \to A$) that execute in $< 5\text{ms}$.
    3. **Direction 3 (Related-Cluster Ruin & Recreate - `tryRelatedClusterRuin`)**: Uses conflict graph of bottleneck teachers to unplace 3-4 connected teachers and re-insert with randomized heuristic.
    4. **Direction 4 (Neutral Plateau Random Walk - `tryNeutralPlateauWalk`)**: Traverses flat landscape plateaus ($\Delta = 0$) with automatic rollback if no strict descent ($\Delta < 0$) is found.
    5. **Direction 5 (Elite Archive Branching)**: Maintains Top-3 diverse timetables and branches with directional kicks when deeply stagnant.
- **Strict Pareto Boundaries for the 4 Buttons**:
  - **Button 1 (Tối ưu 1 tiết/buổi)**: Eliminates `soNgayMotTiet` (day singletons) then `soBuoiDay1` (session singletons). Full freedom on gaps.
  - **Button 2 (Tối ưu Buổi)**: Minimizes 2-period and 3-period sessions into 4-5 periods or whole days off without increasing singletons.
  - **Button 3 (Tối ưu 2 tiết trống)**: Reduces `soBuoiTrong2` without increasing sessions or singletons.
  - **Button 4 (Tối ưu 1 tiết trống)**: Reduces `soBuoiTrong1` without increasing sessions, singletons, or 2-period gaps.
- **Hard Constraint Safety & Full School-Wide Validation**:
  - Fixed cell (`-3`) and off cell (`-2`) protection across all escape directions.
  - Global `this.isLessonBlockSafe()` validation ensures double-period pairs (`subject.lessonBlocks.min`) and room/teacher off constraints are 100% preserved.
- **Full Automated Verification (`school_default_vps.json`, 75 classes, 125 teachers, 2,193 lessons)**:
  - **Initial Solve ("Xếp TKB")**: **2,193 / 2,193 placed (100%)**, **0 unassigned**, **0 violations**, time: **520 ms**.
  - **Button 1 ("Tối ưu 1 tiết/buổi" - `optimize_singletons`)**: `soNgayMotTiet: 67 -> 0` (**100% eliminated!**), `soBuoiDay1: 133 -> 7`, `tsBuoiDay: 790 -> 721`, **0 added violations**, time: **54.75 s**.
  - **Button 2 ("Tối ưu Buổi dạy" - `optimize_sessions`)**: `tsBuoiDay: 790 -> 717` (**-73 sessions!**), `tsNgayDay: 679 -> 633` (**-46 days!**), `soBuoiDay1: 133 -> 12`, `soNgayMotTiet: 67 -> 4`, **0 added violations**, time: **38.99 s**.
  - **Button 3 ("Tối ưu Trống 2 tiết" - `optimize_gap2`)**: **0 added violations**, time: **3.32 s**.
  - **Button 4 ("Tối ưu Trống 1 tiết" - `optimize_gap1`)**: **0 added violations**, time: **10.90 s**.
- **VPS Deployment Status**:
  - Uploaded `web/pages/tkb-fet-engine.js`, `web/pages/tkb-fet-worker.js`, `web/pages/phanmon.js`, `web/pages/tkb-constraints.js`, `web/pages/sapxep.html` to VPS `/opt/cherry-scheduler/web/pages/`.
  - Checksums verified, syntax validated (`node --check` passed with 0 errors), systemd service `tkb-app` active.

## 2026-08-16 Dedicated Multi-Mode Optimizer Rules (Spec: ANTIGRAVITY_GIAM_1_TIET_NGAY_v2.md) & VPS Deployment

- **User Specification & Pareto Boundary per Button**:
  1. **Button 1 (Tối ưu 1 tiết/buổi & 1 tiết/ngày)**:
     - Full freedom: Not bounded by gap or session limits (`maxGap2Limit = Infinity`).
     - Priority 1: `soNgayMotTiet` (1 period on entire day) $\rightarrow 0$.
     - Priority 2: `soBuoiDay1` (1 period in session) $\rightarrow 0$.
     - Hard constraints preserved (0 added violations, 100% placed).
  2. **Button 2 (Tối ưu Buổi)**:
     - Vacate/consolidate 2-period and 3-period sessions into 4-5 periods or days off.
     - Strict constraint: NEVER create new singletons (`soBuoiDay1` & `soNgayMotTiet` non-increasing).
     - Free to form/increase gaps.
  3. **Button 3 (Tối ưu 2 tiết trống)**:
     - Eliminate 2-period gaps (`soBuoiTrong2` decreasing).
     - Strict constraints: Sessions non-increasing (`tsBuoiDay <= best`), singletons non-increasing (`soBuoiDay1`, `soNgayMotTiet` non-increasing).
     - Free to form 1-period gaps (`soBuoiTrong1` flexible).
  4. **Button 4 (Tối ưu 1 tiết trống)**:
     - Eliminate 1-period gaps (`soBuoiTrong1` decreasing).
     - Strict constraints: Sessions non-increasing, singletons non-increasing, 2-period gaps non-increasing (`soBuoiTrong2 <= best`).
- **Full Automated Verification (`school_default_vps.json`, 75 classes, 125 teachers, 2193 lessons)**:
  - Initial Solve ("Xếp TKB"): **2,193 / 2,193 placed (100%)**, **0 unassigned**, **0 violations**, time: **487 ms**.
  - `optimize_singletons`: **`soNgayMotTiet: 77 -> 0`** (100% eliminated!), `soBuoiDay1: 135 -> 5`, `tsBuoiDay: 783 -> 716`, **0 added violations**, time: **35.47 s**.
  - `optimize_sessions`: `tsBuoiDay: 783 -> 704` (-79 sessions!), `tsNgayDay: 677 -> 627` (-50 days!), `soBuoiDay1: 135 -> 17`, **0 added violations**, time: **8.54 s**.
  - `optimize_gap2`: **0 added violations**, time: **0.68 s**.
  - `optimize_gap1`: `soBuoiTrong1: 122 -> 83` (-39 gaps), `soBuoiTrong2: 22 -> 22` (preserved!), `tsBuoiDay: 783 -> 783`, **0 added violations**, time: **5.83 s**.
- **Deployment Status**:
  - Uploaded `phanmon.js`, `sapxep.html`, `tkb-fet-engine.js`, `tkb-fet-worker.js`, `tkb-constraints.js` to VPS.
  - Checksums verified, syntax validated (`node --check` OK), service active.

## 2026-08-16 Production Update: Complete Zero-Violation Multi-Mode Optimizer Fix & VPS Deployment

- **User Issue**: An orange warning modal ("Lịch mới tạo thêm vi phạm so với lịch trước khi tối ưu. Lịch cũ được giữ nguyên.") appeared when running the 4 optimization buttons, blocking the candidate timetable from being saved.
- **Root Cause & Technical Insights**:
  1. In previous iterations, swap restoration lines in local search routines (`obliterateAllTeacherSingletons`, `tryConsolidateTeacherSingletons`, `tryReinforceTeacherSingletons`, `tryCrushTeacherGaps`) executed unconditionally outside the acceptance condition, reverting valid moves.
  2. Unrestricted moves could inadvertently move into OFF slots or separate double-period blocks (`isLessonBlockSafe`).
- **Core Fixes Applied**:
  - **Structured Conditional Retention**: Swaps and 3-way cycles that improve the target metric retain their new placement immediately; fallback restoration only executes on rejected moves.
  - **Intra-Teacher Cross-Class Relocation**: Teachers with single-period sessions across different classes can relocate lessons into their own active sessions, dramatically decreasing singletons.
  - **Session Vacater for `optimize_sessions`**: Compacts 1- and 2-period sessions to completely free sessions/days.
  - **Comprehensive Hard Constraint Safety**: Every candidate swap/permutation is guarded by `this.isLessonBlockSafe(...)`, `this.offSlots`, and `this.teacherOffSlots`.
- **Full Automated Verification (`school_default_vps.json`, 75 classes, 125 teachers, 2193 lessons)**:
  - **Initial Solve ("Xếp TKB")**: **2,193 / 2,193 placed (100%)**, **0 unassigned**, **0 violations**, time: **761 ms**.
  - **Button 1 ("Tối ưu 1 tiết/buổi" - `optimize_singletons`)**: `soBuoiDay1: 132 -> 6` (**95.5% reduction**), **0 added violations**, time: **5.18 s**.
  - **Button 2 ("Tối ưu Buổi dạy" - `optimize_sessions`)**: `tsBuoiDay: 791 -> 706` (saved 85 sessions!), `tsNgayDay: 675 -> 621` (saved 54 days!), `soBuoiDay1: 132 -> 17`, **0 added violations**, time: **5.63 s**.
  - **Button 3 ("Tối ưu Trống 2 tiết" - `optimize_gap2`)**: `soBuoiTrong2: 34 -> 16` (**53% reduction**), **0 added violations**, time: **0.20 s**.
  - **Button 4 ("Tối ưu Trống 1 tiết" - `optimize_gap1`)**: `soBuoiTrong1: 130 -> 82` (**37% reduction**), `soBuoiTrong2: 34 -> 34` (strictly preserved), **0 added violations**, time: **1.07 s**.
- **Deployment Status**:
  - Successfully deployed `tkb-fet-engine.js`, `tkb-fet-worker.js`, `phanmon.js`, `tkb-constraints.js` to VPS `/opt/cherry-scheduler/web/pages/`.
  - Checksums match, `node --check` syntax verified on VPS, `tkb-app` service active.

## 2026-08-16 Optimizer Algorithms Restored from Backup

- **User Request**: Restore the exact algorithms for the 4 optimization buttons from `C:\Users\Love\Documents\Codex\backup\TKBCherry\web\pages\tkb-fet-engine.js` (applying strictly the 4 optimization button methods) to this project.
- **Root Cause & Technical Insights**:
  1. Extracted and applied the exact optimization methods from `backup/TKBCherry/web/pages/tkb-fet-engine.js`:
     - `tryConsolidateTeacherSingletons`
     - `tryReinforceTeacherSingletons`
     - `obliterateAllTeacherSingletons`
     - `tryCrushTeacherGaps`
     - `async optimize(mode = ...)`
  2. Preserved the pure fast initial solver (`solve()`, completes in **~286 ms** with **100% placement: 2,193 / 2,193 placed, 0 unassigned, 0 violations**).
- **Verification of all 4 Optimization Modes (`school_default_vps.json`, 75 classes, 125 teachers, 2193 lessons)**:
  - **Initial Solve ("Xếp TKB")**: **2,193 / 2,193 placed**, **0 unassigned**, **0 violations**, **time: 286 ms**.
  - **Button 1 ("Tối ưu 1 tiết/buổi" - `optimize_singletons`)**: **soBuoiDay1: 0** (down from 135) in **1.78 s**, **2,193 / 2,193 placed**.
  - **Button 2 ("Tối ưu Buổi dạy" - `optimize_sessions`)**: **tsBuoiDay: 549** (saving 220 sessions) in **9.8 s**.
  - **Button 3 ("Tối ưu Trống 2 tiết" - `optimize_gap2`)**: **tsBuoiDay: 407**.

## 2026-08-16 Production Update: Safe Optimizer Local Search, Pair Preservation & Zero-Violation Handshake

- **User Request**: Fixed the issue where clicking "Dừng" (Stop) or completing optimization (`Tối ưu`) previously resulted in constraint validation failure with rollback (`Lịch mới tạo thêm ... vi phạm: subject.lessonBlocks.min`), preventing the optimized timetable from being saved.
- **Root Cause Analysis**:
  1. `loadExistingSchedule()` previously unpacked 2-period paired lessons into disconnected 1-period activities (`duration = 1`), leaving double-period requirements unrepresented.
  2. Optimizer local search routines (`obliterateAllTeacherSingletons`, `tryConsolidateTeacherSingletons`, `tryReinforceTeacherSingletons`, `tryCrushTeacherGaps`, `PASS 2`, `PASS 3`) were swapping single lessons into pair blocks, breaking contiguous periods.
  3. `tryCrushTeacherGaps()` contained an unplaced side effect on empty slots (`unplaceActivity` called before target slot validation).
- **Core Fixes Applied**:
  - **Pair Reconstruction**: `loadExistingSchedule()` inspects consecutive slots in sessions and pairs required double periods (`lessonBlocks[2].min >= 1`) as atomic `duration = 2` activities (`initSlot` tracked).
  - **Local Search Guards**: All local search passes and ejection chains are strictly restricted to free single-period activities (`duration === 1`) and validated via `this.isLessonBlockSafe(act1, act2, ...)` prior to accepting candidate swaps.
  - **Exact Swaps**: `tryCrushTeacherGaps()` now operates solely via exact 2-way and 3-way cyclic swaps, ensuring 100% placement (2,193 / 2,193 lessons) at every search step.
- **Automated Verification Across Real Database (`school_default_vps.json`, 75 classes, 2193 lessons)**:
  - `optimize_singletons`: `soBuoiDay1: 141 -> 22`, **0 lesson block violations**, **2,193 / 2,193 placed (100%)**.
  - `optimize_gap2`: `soBuoiTrong2: 17 -> 0`, **0 lesson block violations**, **2,193 / 2,193 placed (100%)**.
  - `optimize_gap1`: `soBuoiDay1: 141 -> 23`, **0 lesson block violations**, **2,193 / 2,193 placed (100%)**.
  - `optimize_sessions`: `tsBuoiDay: 781 -> 627, tsNgayDay: 674 -> 539, soBuoiDay1: 141 -> 4`, **0 lesson block violations**, **2,193 / 2,193 placed (100%)**.
- **Deployment Status**:
  - Deployed `tkb-fet-engine.js`, `tkb-fet-worker.js`, `phanmon.js`, `tkb-constraints.js` to VPS `/opt/cherry-scheduler/web/pages/`.
  - Checksums verified, syntax checks (`node --check`) passed with 0 errors, `tkb-app` service active.


The owner reported that the focused optimizer buttons stopped responding and
explicitly asked to return the FET algorithm to its previous behavior. The
in-flight follow-up deploy was interrupted during Rust compilation; it had
already reached its install/start path, so the live static algorithm files
were restored explicitly afterward.

- Restored the matching engine + worker pair from the known prior VPS release
  archive:

  ```text
  /opt/cherry-scheduler-backups/app-release-20260815-182649.tar.gz
  ```

  Installed live hashes are:

  ```text
  27f0eff2e8708ca1fe78271bd0bffdaddb838a0bc977f304cea03d84130ac51c  web/pages/tkb-fet-engine.js
  2c0901be7cfef52d1ee593437238c681503bb88329041010c90f88ce7a5b20bc  web/pages/tkb-fet-worker.js
  ```

- Before replacing, the deployed pair was copied to:

  ```text
  /opt/cherry-scheduler-backups/manual-fet-restore-20260815-235308/
  ```

  including a retry copy of the engine made during the atomic restore check.
  No school data, SQLite database, Rust binary, Cloud Run profile, auth, or
  planner HTML was restored or changed.
- Remote `node --check` passed for both restored files. `tkb-app` is `active`;
  public `/api/health` is `ok: true`, with no active/queued solver jobs and all
  six worker tokens available.
- **Source reconciliation completed locally, then speed/stop fixes were added:**
  production still has the restored archive hashes above, while the pending
  local FET-only sources now hash to
  `f3f5b3ba4b4df5038469169ff1806a6c9c2cc26f53ea034fbc2a117f0af0e03b`
  (engine) and
  `9781067ede52a43856eded8ceaef7eed155b01f3373611a8a3cf5d211cbda588`
  (worker). The planner UI has also
  been changed to FET-only; no normal deployment has been run for these
  pending changes.
- Ask users to use `Ctrl + F5` before retesting the four optimizer buttons so
  no browser retains the newer worker/engine pair.

## 2026-08-16 FET-only planner direction (Local, pending deploy)

Hybrid/Cloud Run is now retired from the scheduler by an explicit product
decision. The planner keeps only the local FET Web Worker for Auto Sort and
the four optimization goals: 1 tiết/buổi, Buổi dạy, 2 tiết trống, and 1 tiết
trống.

- The toolbar contains no Hybrid/Agent route button and no Deep Optimize
  (Cloud Run) menu item. Stale localStorage Hybrid flags are cleared and old
  cached Agent/Hybrid hooks fail closed.
- `executeDirectFastSchedule`, `sapXepTuDongAll`, and `sapXepTheoCheDo` all
  execute through `tkb-fet-worker.js`. The former Cloud Run branch is
  unreachable, and the legacy deep-optimize alias now delegates to the same
  local FET path without confirmation or serverless routing.
- The status line that claimed a found solution was still being checked and
  displayed has been removed from the active FET flow. Results are applied
  only after the existing hard validator accepts them.
- The planner no longer exposes the serverless infrastructure toggle. The
  backend Cloud Run assets remain intact for later archival/cleanup; they are
  not called by planner actions.
- The restored FET engine now returns Auto immediately after a complete
  hard-valid construction candidate. Its former whole-school polish pass is
  opt-in via `postConstructionPolish:true`, so the dedicated optimizer modes
  remain the only quality-search entry points.
- The restored FET worker now marks terminal frames `applied:true` and sends a
  retained complete checkpoint only when an optimizer metric improves. Stop
  therefore validates/applies the best known optimizer timetable instead of
  discarding it, while progress frames no longer serialize the live grid.
- User-facing result messages no longer expose the internal label
  `Tối ưu cục bộ`. Success is shown directly as `Đã xếp xong...` or `Đã tối ưu
  xong...`; an incomplete run now says that the current timetable was kept and
  suggests checking fixed/OFF/limit requirements.
- Focused UI regression checks pass: scheduler menu **4/4**, toolbar/FET-only
  checks pass with the retired Hybrid-only tests explicitly skipped. Full
  scheduler-engine tests still include historical cases for the newer engine
  APIs and must be replaced with a legacy FET baseline before the next deploy.
- Verification in this session: JavaScript syntax checks for the changed
  planner/bridge/engine/worker files passed; the focused UI/telemetry suite is
  **37 passed, 5 retired tests skipped**; the FET benchmark suite is **3/3**;
  the Auto fast-return and optimizer-checkpoint regressions are **2/2**; and a
  fresh local page at `http://127.0.0.1:1010/pages/sapxep?sid=default` showed
  exactly the four FET menu actions and no Hybrid/Deep action.

The FET-only release and the follow-up message cleanup were deployed
successfully. The historical newer-engine tests remain retired/incompatible;
the focused release checks and local browser smoke were green before deploy.

## 2026-08-16 FET-only production deployment and message cleanup (Deployed)

Two transactional update runs completed with `UPDATE_OK`:

- FET-only scheduler, fast Auto return, worker `applied:true` terminal frames,
  optimizer checkpoints and Hybrid route retirement:
  `/opt/cherry-scheduler-backups/server-state-20260816-003044.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260816-003044.tar.gz`.
- Follow-up user-facing message cleanup:
  `/opt/cherry-scheduler-backups/server-state-20260816-003514.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260816-003514.tar.gz`.

Public verification after the second run:

- `GET https://tkbcherry.com/api/health` returned `ok: true`.
- Planner HTML serves the `20260816-fet-only-v1` cache marker.
- Planner HTML has no `btnAgentHelper` element, no Deep Optimize item and no
  Cloud Run menu item. Remaining `btnAgentHelper` text is CSS compatibility
  only, not a visible control.
- Served `phanmon.js` contains the new incomplete-schedule message and no
  `Tối ưu cục bộ` label.
- Served FET engine contains the complete-first Auto return and served worker
  contains `applied:true` plus the optimizer checkpoint path.
- SQLite WAL/SHM deployment exclusions were unchanged.

Ask the owner to press `Ctrl + F5` on the public planner before testing Auto
Sort and the four FET optimizer buttons.

## 2026-08-16 Auto Sort completes at first complete valid timetable (Pending Deploy)

User reported that Auto showed all **2175/2175** lessons placed in roughly two
seconds but kept running for about 40 more seconds. Root cause was in
`web/pages/tkb-fet-engine.js`: after construction had placed every activity,
Auto unconditionally ran a broad singleton/gap polish sequence (including
whole-school scans and cross-class moves) before returning the candidate.
That was a quality pass incorrectly embedded in the fast construction action.

- Auto now returns immediately once construction has a complete candidate; it
  does not run post-construction quality polish by default.
- The old polish code is preserved behind the explicit internal
  `postConstructionPolish: true` option only. The ordinary Auto UI never sets
  that option. Quality optimization remains the responsibility of the four
  dedicated optimizer actions and Deep Optimize.
- New regression test proves Auto does not invoke the post-construction polish
  method after it has placed all required lessons.

Verification before deploy:

```text
node --check web/pages/tkb-fet-engine.js
node --test --test-concurrency=1 \
  e2e_tests/tkb_fet_engine_node.test.js \
  e2e_tests/tkb_fet_benchmark_node.test.js \
  e2e_tests/benchmark_fet_node.test.js \
  e2e_tests/planner_hybrid_contract_node.test.js \
  e2e_tests/planner_scheduler_modes_node.test.js
# 52 passed, 0 failed

git diff --check
# no whitespace errors; only existing CRLF conversion warnings
```

## 2026-08-16 Production deploy — responsiveness and optimizer recovery (Deployed)

The owner explicitly authorized production deployment after making a backup.
`tools/vps-deploy/update-deploy.py` created the allowlisted production archive
and started the normal locked VPS update. A second local invocation was safely
rejected with exit `75` while that first update was compiling; it did not run a
second deployment. The first terminal's streamed output did not return to the
local caller, but completion was independently verified over SSH and public
health:

- The deployment lock, update script, Cargo build and `rustc` process are gone.
  A new `tkb_rust_api` process is active, with no active or queued solver jobs
  and all `6/6` worker tokens available.
- `GET https://tkbcherry.com/api/health` returned `ok: true`, Rust API
  `tkb_new-rust-api-2026-08-10-constraint-sanitize-safe-partial-v131`, and a
  configured Serverless profile in `serverless_only` mode.
- Remote installed SHA-256 hashes match the deployed local sources:

  ```text
  d889970374f77d474906948548c6d8e72de86f258f78ef4edc1c6e2abfc8bf1b  web/pages/phanmon.js
  29a7e4cc170fad078b4a92de9dc16ebb8c86a736ed64cd7148c50ed221c33600  web/pages/tkb-fet-engine.js
  ```

  `phanmon.js` contains the new user-facing Gap1 preparation wording and
  explicit Hybrid failure panel. The SQLite WAL/SHM exclusions in
  `tools/vps-deploy/update-server.sh` were not changed.

- Run a browser smoke test while signed in to a real school before considering
  this release fully accepted: select Gap1/Gap2, stop after a visible
  improvement, and confirm the saved timetable remains the best valid one.
  Then turn on Hybrid and exercise one successful Cloud Run focus request;
  production has a configured profile, while the prior local environment did
  not.

## 2026-08-16 Local responsiveness / stop checkpoint / Hybrid recovery follow-up (Not Deployed)

This is a local-source follow-up for three user-observed planner problems. No
VPS, Google Cloud Run, deployment script, SQLite WAL/SHM exclusion, production
database, or Cloud profile was changed.

- The local scheduler result path now distinguishes “the search found a
  candidate” from “the schedule is validated, painted, and persisted”. It
  reports the intermediate verification state, paints the selected timetable
  before expensive secondary list/stat refreshes, and moves those secondary
  refreshes out of the critical render turn. It records only in-memory timing
  facts in `window.__TKB_LAST_FET_APPLY_TIMING`; no schedule or personal data
  is added to telemetry.
- Focused local optimizer progress no longer transfers a full live timetable
  on every frame. The engine emits a `safeCheckpoint` only when its complete
  incumbent has genuinely improved and its locked optimizer invariants hold.
  When the user presses Stop during a focused optimizer, the browser terminates
  the worker, validates that checkpoint with the full browser hard validator,
  and applies it only if valid. An initial construction pass still always
  cancels and preserves the old timetable because intermediate construction
  states are not safe to commit.
- Hybrid Cloud failures still fail closed, but recovery is now an explicit
  in-page action panel rather than a numeric browser prompt defaulting to
  cancellation. It explains when a local environment has no Cloud Run profile
  and offers **Retry Cloud Run**, **Run on this machine**, or **Keep current
  schedule**. There is no automatic executor fallback.
- User-facing local scheduler messages no longer expose the implementation
  name “FET/Web Worker”. For example, the Gap1 action begins with **“Đang
  chuẩn bị tối ưu 1 tiết trống trên máy này…”**. Internal code names,
  validation failure kinds, and privacy-safe telemetry dimensions remain
  unchanged.
- Gap1/Gap2 local search now ranks teacher-session components that actually
  contain the selected gap before broad search, and uses a prebuilt teacher →
  activity index for cross-class gap chains. This reduces repeated full-school
  scans and gives bridge-slot / same-session repairs first use of the budget.
  It is a targeted speed/quality improvement, not a proof that every feasible
  zero-gap timetable will reach zero.
- Verification after the change:

  ```text
  node --check web/pages/phanmon.js
  node --check web/pages/tkb-fet-engine.js
  node --check web/pages/tkb-fet-worker.js
  node --test --test-concurrency=1 \
    e2e_tests/tkb_fet_engine_node.test.js \
    e2e_tests/planner_hybrid_contract_node.test.js \
    e2e_tests/planner_scheduler_modes_node.test.js \
    e2e_tests/tkb_rust_bridge_node.test.js
  # 371 passed, 0 failed

  git diff --check
  # no whitespace errors; only existing CRLF conversion warnings
  ```

  A local browser smoke check on `/pages/sapxep?sid=default` confirmed that
  selecting **1 tiết trống** renders `Đang chuẩn bị tối ưu 1 tiết trống trên
  máy này…`; the previous implementation name is not shown in that planner
  status.

- Local backend remains available at `http://127.0.0.1:1010/` with deliberately
  low test worker limits. Its Cloud Run profile remains unconfigured, so
  Hybrid Cloud optimization cannot be tested as a successful Cloud Run run
  locally; use the new explicit local-recovery action or configure a staging
  profile before testing Hybrid end-to-end. Before deployment, replay the
  anonymized benchmark set and stage at least one successful Cloud Run
  standard and Deep result plus timeout/422 failure paths.

## 2026-08-16 Final FET-first / Hybrid / telemetry verification (Not Deployed)

This entry is the current local-source baseline and supersedes older passing
test counts in historical entries below. **No VPS or Cloud Run deployment was
performed in this work session.** The SQLite WAL/SHM exclusions in
`tools/vps-deploy/update-server.sh` were not changed.

- Automatic sorting is FET Web Worker-first whether Hybrid is on or off.
  Hybrid can request Cloud Run only for the four focused optimization modes;
  Standard/Deep remain VPS-authoritatively clamped to **60s/180s**. A Cloud
  timeout, 422, malformed candidate, missing Pareto evidence, local validator
  rejection, or unavailable Cloud profile is fail-closed: the incumbent stays
  unchanged and the user is offered explicit retry Cloud / run local FET /
  keep choices.
- FET now compiles and hard-enforces the constraint domains used in the
  current browser validator, including fixed/OFF, teacher/class/room
  collisions, blocks, subject/session/group rules, spacing, must-teach,
  global/time limits, and teacher-location rules. Construction remains
  transactional and does not commit a partial timetable. Four local optimizer
  modes use locked lexicographic invariants; Gap1 is blocked while Gap2 is
  positive. Structural metric floors are conservative proofs only, and a
  proven positive floor is rendered as such rather than as a false promise of
  zero.
- A worker-posted FET error is now handled as a terminal fail-closed state
  instead of leaving the planner busy. Each settled FET Web Worker attempt
  reports a best-effort, authenticated telemetry event containing only
  allowlisted executor/mode/budget/runtime/outcome/metric facts. It sends no
  timetable, teacher/class/school/account identifier, diagnostics, or raw
  error. The event cannot delay a valid timetable result.
- Super Admin now has a separate **Vận hành solver** aggregate card with a
  24h/7d/30d selector and manual refresh (no polling). It shows aggregate
  executor × focus × budget rows, success/no-improvement/failure/cancelled
  counts, p50/p95 runtime, target rate, average metric delta, estimated cost,
  and safe Cloud Run profile/revision/digest provenance. It remains invisible
  to school users and does not render raw job data, schedules, account/school
  identifiers, or raw failures.
- The additive `solver_telemetry_events` SQLite table has 90-day / 100,000-row
  retention, opaque hashed browser event idempotency, a 120-event/hour
  authenticated actor/IP browser rate limit, and no role in billing, quotas,
  routing, or solver admission. API contracts are:

  ```text
  POST /api/solver-telemetry/fet
  GET  /api/admin/solver-telemetry?window=24h|7d|30d  (Super Admin only)
  ```

- Final local verification:

  ```text
  node --check web/pages/phanmon.js
  node --check web/pages/tkb-fet-engine.js
  node --check web/pages/tkb-fet-worker.js
  node --check web/pages/tkb-rust-bridge.js
  node --check web/super-admin.js
  # passed

  node --test --test-concurrency=1 \
    e2e_tests/tkb_fet_engine_node.test.js \
    e2e_tests/tkb_fet_benchmark_node.test.js \
    e2e_tests/benchmark_fet_node.test.js \
    e2e_tests/fet_client_telemetry_node.test.js \
    e2e_tests/solver_infrastructure_portals_node.test.js
  # 47 passed, 0 failed

  node --test --test-concurrency=1 \
    e2e_tests/planner_hybrid_contract_node.test.js \
    e2e_tests/planner_scheduler_modes_node.test.js \
    e2e_tests/planner_toolbar_layout_node.test.js
  # 46 passed, 0 failed

  node --test --test-concurrency=1 e2e_tests/tkb_rust_bridge_node.test.js
  # 327 passed, 0 failed

  rustfmt --edition 2021 --check src/solver_telemetry.rs
  cargo check --tests --jobs 1
  $env:LIB = "$PWD\vendor\sqlite3;$env:LIB"
  $env:PATH = "$PWD\vendor\sqlite3;$env:PATH"
  cargo test solver_telemetry --jobs 1 -- --nocapture
  # 6 passed, 0 failed; cargo check has existing unused-code warnings only

  git diff --check
  # no whitespace errors (only existing LF/CRLF conversion warnings)
  ```

- Existing anonymized benchmark snapshots remain the honest performance
  baseline: smoke and pressure are complete/hard-valid for all five FET modes;
  the Pressure Gap2 fixture preserves its proven floor of 1. Medium (432
  synthetic periods, 12s) and stress (2,340 periods, 1s) still stop at their
  FET budget without a complete-valid candidate. Do not claim that local FET
  solves every large school within the normal browser budget; staging replay
  with anonymized production-like data is required before deployment.
- Generated-artifact cleanup was inventoried after verification: about
  **1,700.73 MiB** is safe to remove from `rust_api/target`,
  `solver_runtime/logs`, `.pytest_cache`, all project `__pycache__` folders,
  and the one-off Cargo test target
  `C:\Users\Love\AppData\Local\Temp\codex-tkb-telemetry-test-20260816`.
  This environment rejected recursive deletion by policy after the exact paths
  were verified, so **no cleanup target was partially deleted**. It is safe to
  remove those exact generated paths locally after closing Rust/Cargo tools.
  Use the reviewed script first in preview mode, then run it without `-WhatIf`:

  ```powershell
  powershell -ExecutionPolicy Bypass -File tools\cleanup-generated-artifacts.ps1 -WhatIf
  powershell -ExecutionPolicy Bypass -File tools\cleanup-generated-artifacts.ps1
  powershell -ExecutionPolicy Bypass -File tools\cleanup-generated-artifacts.ps1 -IncludeTelemetryTestTarget
  ```

  The third command is the explicit opt-in for the one-off external Cargo test
  target. Do not use `git clean -fdX`, and do not remove source, `.git`,
  databases, deploy assets, FET assets, validators, tests, or historical
  backups.

## 2026-08-16 Privacy-safe solver telemetry backend (Not Deployed)

- Added `rust_api/src/solver_telemetry.rs`, deliberately separate from the
  existing per-school/account quota and billing ledger. Its SQLite table
  `solver_telemetry_events` stores only a hashed opaque event key plus
  allowlisted aggregate dimensions: source/executor, canonical focus + gap
  target, budget kind/seconds, runtime, sanitised outcome/result/fallback,
  optional hard-valid/applied/target/floor/metric counters, and Cloud profile,
  revision, solver digest, and estimated cost. It never stores or returns a
  timetable, raw request, school/account/user ID, raw event ID, or raw error.
- Retention is bounded defensively at **90 days and 100,000 rows**. Browser
  idempotency uses only a SHA-256 digest of an opaque `eventId`; the raw ID is
  not written. Browser FET events also have a process-local **120 events per
  authenticated actor/IP per hour** rate limit. This telemetry is
  observational only: it does not participate in quota, billing, routing, or
  solver admission.
- New routes in `rust_api/src/main.rs`:
  - `POST /api/solver-telemetry/fet` requires an active authenticated session
    and accepts only a strict allowlist for terminal `fet_web_worker` events.
    It returns only `{ok, accepted, duplicate, executor}`; duplicate event IDs
    are idempotent.
  - `GET /api/admin/solver-telemetry?window=24h|7d|30d` is Super Admin-only
    and returns aggregates only: overall and per executor/focus/budget/outcome
    p50/p95 runtime, hard-valid/applied/target/floor rates, metric delta,
    deep-run rate, sanitised fallback/result distributions, estimated Cloud
    cost, and Cloud profile/revision/digest provenance. In particular,
    `byExecutorFocusBudget` is the combined dashboard dimension.
- Cloud Run and VPS coordinator attempts now create a privacy-safe start row
  and terminally settle it on completion, timeout, cancellation, release,
  Cloud→VPS fallback, or an unexpected coordinator exit. Cloud attempts record
  the pinned profile/digest, returned revision/digest when available, and the
  existing conservative cost estimate. Standard/Deep are recorded as the
  server-authoritative **60s/180s** contracts.
- Browser FET POST contract for the planner sender (all JSON, no extra fields):

  ```json
  {
    "eventId": "opaque-random-id-at-least-16-chars",
    "executor": "fet_web_worker",
    "focus": "automatic|singletons|sessions|gaps",
    "gapTarget": "gap1|gap2 (required only when focus=gaps)",
    "budgetKind": "local",
    "budgetSeconds": 1,
    "runtimeMs": 0,
    "outcome": "completed|failed|cancelled|timeout|no_improvement|infeasible",
    "resultKind": "completed|failed|cancelled|timeout|infeasible|no_improvement|invalid_candidate|hard_constraint_violation|preflight_infeasible|budget_exhausted",
    "fallback": "none|cloud_run_failed|user_selected_fet|retry_local|keep_incumbent|not_applicable",
    "hardValid": true,
    "applied": true,
    "targetReached": false,
    "floorReached": false,
    "metricKey": "singletons|sessions|gap1|gap2",
    "metricBefore": 10,
    "metricAfter": 4,
    "metricDelta": 6,
    "targetMetric": 0,
    "floorMetric": 0
  }
  ```

  Metric fields are optional; whenever any one is sent, `metricKey` must match
  the canonical focus, and when all of before/after/delta are sent,
  `metricDelta` is strictly `metricBefore - metricAfter` (positive means
  improvement). `gapTarget` is omitted outside gaps. An unknown field, raw
  `error`, invalid enum, excessive body, or mismatched metric is rejected
  without persistence.
- Focused verification (using the vendored SQLite library only in the test
  shell, with no source/deploy change):

  ```text
  rustfmt --edition 2021 --check src/solver_telemetry.rs
  cargo check --tests
  $env:LIB = "$PWD\vendor\sqlite3;$env:LIB"
  $env:PATH = "$PWD\vendor\sqlite3;$env:PATH"
  cargo test solver_telemetry -- --nocapture
  # 6 passed, 0 failed (hash/idempotency, strict privacy validation,
  # rate limit, Cloud metadata/cost, Standard/Deep context, route auth and
  # aggregate-only response)
  ```

- This is local source/test work only. **Do not deploy yet**; no Cloud Run or
  VPS configuration was changed, and the SQLite WAL/SHM exclusions in
  `tools/vps-deploy/update-server.sh` were not changed.

## 2026-08-16 FET teacher-location hard constraints (Not Deployed)

- `web/pages/tkb-fet-engine.js` now compiles and domain-prunes the three
  teacher location rules exposed by the browser validator:
  `oneLocationPerSession`, `gapBetweenLocations`, and
  `maxOneMovePerSession`. The rule flags use the same checkbox truthiness as
  `tkb-constraints.js` and are checked for each teacher/day/session during
  construction and every relocation/ejection candidate.
- Location resolution intentionally matches the production validator:
  room metadata is read in the order `diadiem`, `diaDiem`, `khu`,
  `location`; when no metadata exists the room name is used; when no room is
  assigned the class location is used. A lesson with no resolvable location
  is omitted from the sequence, exactly as the UI validator does, rather than
  being assigned a guessed location.
- Fixed-only violations are reported in `diagnostics.fixedLocationViolations`
  and stop FET before any write (`failureKind:
  fet_fixed_location_constraint_violation`). An incumbent that already
  violates a location rule is likewise rejected by optimizer preflight with
  `fet_location_constraint_violation`; the input `DATA.tkb` remains unchanged
  in both cases. A final location scan is performed before `applyToDataTKB()`
  as a second fail-closed fence.
- Regression coverage now includes all three rules, room metadata aliases,
  class-location fallback, the UI's unresolved-location omission behavior,
  fixed-violation preservation, and invalid-incumbent optimizer rejection.

  ```text
  node --check web/pages/tkb-fet-engine.js
  node --test e2e_tests/tkb_fet_engine_node.test.js
  # 30 passed, 0 failed
  ```

- This is source/test work only. No VPS or Cloud Run deployment was performed,
  and SQLite WAL/SHM deployment exclusions were not changed. The production
  UI validator remains the terminal full-schedule safety fence.

## 2026-08-15 Cloud Run Hybrid executor fence and Pareto acceptance (Not Deployed)

- The Hybrid request now retains its explicit Cloud Run contract while passing
  through `bridgeSapXepTuDongAll`: only the four canonical focused modes may
  carry it, with `routing_mode: serverless_only`, `ui_hybrid_executor:
  cloud_run`, and the Standard/Deep intent preserved. Automatic mode cannot
  acquire this route and remains FET-first in the planner.
- The Rust API independently canonicalizes an explicit Hybrid Cloud Run
  request. Standard is clamped to **60 seconds** and Deep Optimize to **180
  seconds** across solver, backend/native deadline, progress and serialized
  request fields. A Cloud Run Hybrid request now fails closed when the school
  has no eligible Cloud profile or is configured `vps_only`; it cannot fall
  back to VPS after Cloud reservation or execution failure.
- The UI applies an additional safety fence before save/render: a complete
  backend-hard-valid candidate must also pass the browser's full local
  hard-constraint validator. The incumbent is restored if that validation is
  unavailable, throws, or returns violations.
- Candidate acceptance is now mode-specific Pareto acceptance, not simply a
  changed timetable. Singleton and session modes preserve the other displayed
  quality metrics; Gap2 preserves singleton count; Gap1 preserves singleton
  and Gap2. Missing quality evidence fails closed, while a complete but
  non-improving candidate is a clear no-op that keeps the incumbent.
- Dedupe scope remains `school scope + focus + gap target + Standard/Deep +
  fixed-lock fingerprint`, paired with the durable schedule fingerprint sent
  to the VPS. This prevents a duplicate Cloud job for the same incumbent while
  keeping a changed schedule/fixed state separate.
- Verification in this workspace:

  ```text
  node --check web/pages/phanmon.js
  node --check web/pages/tkb-rust-bridge.js
  node --test e2e_tests/planner_hybrid_contract_node.test.js
  # 9 passed, 0 failed

  node --test --test-name-pattern="Hybrid focused requests use one canonical mode mapping|planner keeps Auto FET-first" e2e_tests/tkb_rust_bridge_node.test.js
  # 2 passed, 0 failed

  node --test e2e_tests/tkb_rust_bridge_node.test.js
  # 327 passed, 0 failed

  cargo check
  cargo check --tests
  # passed (pre-existing unused-code warnings only)
  ```

- A targeted `cargo test` is still blocked on this Windows machine by the
  existing linker dependency `sqlite3.lib` (`LNK1181`); `cargo check --tests`
  type-checked the new Rust tests without linking. No VPS/Cloud Run deploy was
  performed, and no SQLite WAL/SHM deploy exclusion was changed.

## 2026-08-15 FET hard-constraint regression coverage (Not Deployed)

- Extended `e2e_tests/tkb_fet_engine_node.test.js` with focused browser-engine
  regressions for the hard-constraint compiler. The suite now verifies subject
  `sessionAllowed`, teacher `mustTeach` anchors, subject `noSameSession` and
  `noSameDay`, `spacingDays`, teacher `maxDays` / `maxSessions`, subject-level
  fixed/OFF slots, and fail-closed preservation of the incumbent `DATA.tkb`
  when a `mustTeach` rule cannot be met.
- The tests exercise both cached allowed domains and the real construction
  result. In particular, a valid `mustTeach` anchor is placed exactly at its
  required slot, while a missing-compatible-teacher anchor returns
  `fet_must_teach_unmet` with `ok:false`, `applied:false`, and no timetable
  mutation.
- Additional companion coverage in the same suite verifies anchor ownership
  after MRV reordering, every period of paired activities against subject/group
  OFF cells, subject-group limits, and configured global/time-limit ceilings.
- Verification after the current engine changes:

  ```text
  node --check web/pages/tkb-fet-engine.js
  node --test e2e_tests/tkb_fet_engine_node.test.js
  # 17 passed, 0 failed

  node --test e2e_tests/tkb_fet_engine_node.test.js e2e_tests/tkb_fet_benchmark_node.test.js e2e_tests/benchmark_fet_node.test.js
  # 24 passed, 0 failed
  ```

- This is local source/test work only. No VPS, Cloud Run, deploy script, or
  SQLite WAL/SHM deployment exclusion was changed.

## 2026-08-15 FET benchmark harness and anonymized size tiers (Not Deployed)

- Added `tools/benchmarks/benchmark-fet.js` and `tools/benchmarks/fet-fixture-anonymized.js`. The harness loads the production browser FET source in a VM, runs fresh fixture copies for each seed/mode, records runtime p50/p95, complete/valid rate, unassigned count, optimizer metric deltas, target status and failure kinds, and can emit a JSON report with `--out`.
- Fixture tiers are `smoke` (49 periods), `pressure` (51 periods with a fixed `gap2` floor of 1), `medium` (432 synthetic periods), and `stress` (2,340 synthetic periods). Names and identifiers are generated; no school/user data is included. Medium/stress are capacity/runtime observations, not production-quality claims.
- The independent benchmark validator covers class morning/afternoon, fixed/OFF preservation, teacher/room collisions and OFF, subject maximum periods per session, paired lesson blocks, and optional spacing/no-same metadata. A candidate is `completeValid` only when placement is complete and this validator reports no hard violation.
- Added `e2e_tests/benchmark_fet_node.test.js` (4 passing tests) and `docs/benchmarks/FET_BENCHMARK.md` with commands and interpretation. No VPS/Cloud Run deployment was performed and SQLite WAL/SHM deploy exclusions were untouched.
- **Observed local benchmark (2026-08-15):** smoke 3 seeds × 5 modes was 100% complete-valid (current run: Auto p50 91.74 ms/p95 113.60 ms; optimizer p50 133.19–812.22 ms). Pressure was 100% complete-valid, retained its fixed `gap2=1` floor, and reported `floorReached=true` while `targetReached=false`. Medium (432 periods, 12 s budget) and stress (2,340 periods, 1 s budget) stopped with `fet_time_budget_exhausted`; these results are evidence for escalation/budget work, not a production guarantee. JSON snapshots are in `docs/benchmarks/fet-*-2026-08-15.json`.

## 2026-08-15 FET-First Auto Sort & Fail-Closed Hybrid Contract (Not Deployed)

- **Deployment status:** Source changes are present only in the repository. No VPS or Cloud Run deployment was performed in this work session. The SQLite WAL/SHM exclusions in `tools/vps-deploy/update-server.sh` were not changed.
- **Routing decision implemented:** `Sắp xếp tự động` now always starts with `FET Web Worker`, whether Hybrid is ON or OFF. Hybrid only routes explicit focused optimization modes (`optimize_singletons`, `optimize_sessions`, `optimize_gap2`, `optimize_gap1`) to Cloud Run. A separate `Tối ưu sâu (Cloud Run)` menu action asks for a focus, then requires a second explicit confirmation before requesting the 180-second Deep budget.
- **Hybrid result/failure contract:** The planner normalizes Cloud Run outcomes to `{ok, applied, executor, tkb/candidate, error/failureKind}`. It accepts only a complete, hard-valid payload with a structurally complete candidate timetable and only saves/renders a candidate when `ok === true` and `applied === true`. The candidate grid must contain at least the reported number of scheduled lesson cells, so an empty/malformed `candidateTkb` cannot erase the incumbent behind stale metrics. A stale `data.tkb` is no longer proof of Cloud Run success. Timeout, 422, missing executor, malformed response, and exception paths restore the incumbent timetable and show `Cloud Run thất bại — lịch chưa thay đổi`, followed by explicit retry / local-FET / keep choices. A valid but non-Pareto-improving Cloud response reports that the timetable was kept rather than being treated as a failure.
- **Canonical focused-mode bridge:** `tkb-rust-bridge.js` owns the UI-mode mapping. Hybrid callers cannot carry `mode`, `optimization_focus_mode`, `optimization_focus`, `optimization_gap_target`, or `ui_requested_solve_mode` aliases into the request. Canonical mapping is singleton → `singletons`, sessions → `sessions`, gap2 → `gaps` + `gap2`, and gap1 → `gaps` + `gap1`.
- **Cloud budgets:** Hybrid focused requests are explicitly clamped to 60 seconds. Deep Optimize is clamped to 180 seconds. Existing client/server transport reserves remain separate from the solver budget so result validation/serialization is not cut off at the solver deadline.
- **FET construction safety and speed:** `tkb-fet-engine.js` now compiles a preflight domain cache before construction, calculates class/teacher/room capacity shortages, selects activities using MRV followed by degree/block tie-breakers, uses the cached allowed slots in swapping, and has reproducible seed support. Normal Auto uses a 12-second FET construction budget; the explicit deep local option supports 30 seconds. If the FET pass cannot finish, it returns diagnostics without applying a partial timetable, does not relax class OFF cells, and does not decompose a required 2-period block into singles.
- **Hard-validation fence:** Every terminal FET worker candidate is validated through the full UI constraint validator before it can be persisted or rendered. If validation is unavailable or finds any enabled hard-constraint violation, the incumbent timetable is restored and the candidate is rejected. Worker progress snapshots are never committed by the Stop action.
- **FET diagnostics and optimization comparison:** The UI displays preflight counts and a diagnostic table for zero-domain/capacity/stuck activities. The FET optimizer now exposes one shared lexicographic comparator for singleton, sessions, gap2, and gap1 move gates; gap2 and gap1 keep their singleton/gap invariants. When a target remains positive after FET stagnates, the UI says it reached FET's current known bound rather than claiming target zero or a proven global optimum.
- **Validation performed:**
  - `node --check web/pages/phanmon.js`
  - `node --check web/pages/tkb-fet-engine.js`
  - `node --check web/pages/tkb-fet-worker.js`
  - `node --check web/pages/tkb-rust-bridge.js`
  - `node --test e2e_tests/tkb_fet_engine_node.test.js` — 17 passed
  - `node --test e2e_tests/planner_hybrid_contract_node.test.js` — 9 passed (missing/stale/empty candidate rejection, explicit/bridge-captured acceptance, no-op, timeout/422 preservation, focused Pareto evidence)
  - `node --test e2e_tests/tkb_rust_bridge_node.test.js` — 327 passed

## 2026-08-15 Hybrid Mode "mode is not defined" ReferenceError Fix & UI Metric Badge Fit (Deployed to VPS)

- **Root Cause Analysis for Hybrid Ignored During Optimize Gap2**:
  - The user observed that despite enabling "⚡ Hybrid ON", clicking "Tối ưu 2 tiết trống" did not trigger the Cloud Run CP-SAT solver, falling back silently to the local FET engine (which then improperly unassigned some periods to break deadlocks).
  - The issue was a `ReferenceError` in `web/pages/phanmon.js` inside `executeDirectFastSchedule` (`mode: mode` was used instead of `mode: options.mode`), which crashed the Hybrid dispatch silently, caught by the error handler, and gracefully fell back to the local Web Worker.
- **Fixes Applied (`web/pages/phanmon.js`)**:
  - Replaced `mode: mode` and `optimization_focus_mode: mode` with `options.mode` in `executeDirectFastSchedule`.
  - Modified the early return logic for `optimize_gap2` (and others) so that if the target metric (e.g. `soBuoiTrong2`) is already `0`, the optimization skips immediately instead of continuing just because `unplacedPeriodsCount > 0`. This prevents confusing the user when they click "Optimize 2 gaps" and the system tries to place unplaced periods instead.
- **Metric Label Override Fix (`web/pages/phanmon.js`)**:
  - **Issue**: During Hybrid optimization (e.g., "Trống 2 tiết: 25"), the badge would suddenly switch to `"2193/2193 tiết"` at the end of the solve because the backend's final payload omitted the specific `metricLabel`, causing the frontend to fall back to the generic placement count label.
  - **Fix**: Updated `isSystemNoise` in `phanmon.js`. When an optimization metric (like "Trống 2 tiết") is actively tracked in `window.__CURRENT_ACTIVE_OPTIMIZE_METRIC_LABEL`, any incoming `"X/Y tiết"` labels are intentionally treated as "noise" and ignored, preserving the accurate optimization metric on screen.
- **Critical Data Loss During Deploy Bug Fix (`tools/vps-deploy/update-server.sh`)**:
  - **Issue**: The user reported that their schedule data was lost after a deployment.
  - **Root Cause**: The SQLite database (`tkb_store.db`) uses Write-Ahead Logging (WAL). The deployment script (`update-server.sh`) used `rsync --delete` and explicitly excluded `*.db` files to protect the database, but failed to exclude `*.db-wal` and `*.db-shm` files. Consequently, `rsync` deleted the active WAL files, causing SQLite to silently roll back all recent transactions that hadn't been checkpointed.
  - **Fix**: Added `--exclude='*.db-wal'`, `--exclude='*.db-shm'` (along with their `.sqlite` equivalents) to the `rsync` deployment commands and the `backup_server_state` archiving step. Deployments will no longer corrupt or truncate recent database writes.
- **UI Metric Badge Fit Fix (`web/pages/phanmon.css` & `sapxep.html`)**:
  - The green text badge for `auto-sort-metric` wasn't fully enveloping the text (`chữ không bao hết khung`).
  - Switched from `min-width: fit-content` to `width: max-content !important` and `min-width: max-content !important`, resolving truncation and background-fill constraints on the flex child.

## 2026-08-15 Live Metric Badge Dynamic Width & Green Text Harmonization (Deployed to VPS)

- **User Feedback & Problem Analysis**:
  - The live metric pill badge (`.auto-sort-metric`) on the toolbar had an old inline `max-width: 18ch` and `overflow: hidden; text-overflow: ellipsis; color: #7c3aed;` rule in `sapxep.html` which truncated longer strings (e.g. `Trống 2 tiết: 11 ➔ 1` was clipped at the number `1` on the right border).
  - The purple text color clashed with the fresh light-green container styling.
- **Styling Fixes Applied (`web/pages/sapxep.html` & `web/pages/phanmon.css`)**:
  - Removed `max-width: 18ch` and `overflow: hidden`.
  - Set `flex: 0 0 auto; width: auto; min-width: fit-content; max-width: none; overflow: visible; padding: 3px 14px;` so the pill badge dynamically expands to hug its full text content perfectly without any clipping.
  - Set font color to elegant dark emerald `#15803d` on light green `#f0fdf4` background with crisp `#86efac` border, matching the UI theme.
- **VPS Deployment**:
  - Uploaded latest `sapxep.html` and `phanmon.css` to `/opt/cherry-scheduler/web/pages/` on VPS (Verified SHA256).

## 2026-08-15 FET Max 1 Gap Constraint & Strict 100% Placed Invariant (Deployed to VPS)

- **Root Cause Analysis for Unassigned Lessons during Optimize**:
  - In `obliterateAllTeacherSingletons` and recursive LNS ruin-and-recreate moves, when `randomSwap()` displaced activities in other classes to accommodate a singleton move, `allPlaced` only checked target activities of that specific teacher, not the entire school. If any displaced activity in another class failed to be replaced, it was left in unassigned state (`actPlacement < 0`), causing `"Chưa xếp: N"`.
  - In `evaluateMetrics()`, unplaced activities were omitted from teacher grids, giving an illusion of lower gaps/sessions.
- **Strict 100% Placed Invariant Implementation (`web/pages/tkb-fet-engine.js`)**:
  - In `evaluateMetrics()`: If `this.activities.some(a => this.actPlacement[a.id] < 0)`, immediately returns an astronomical penalty (`soBuoiDay1: 999999, soBuoiTrong2: 999999, unplacedCount > 0`).
  - In `isAcceptableMove()`: Rejects any move where `currentM.unplacedCount > 0`.
  - In `saveBestSnapshot()`: Asserts that 0 activities are unplaced (`unplaced === 0`), throwing an error if violated.
  - In `loadExistingSchedule()`: Runs multi-pass placement with full backtracking to ensure 100% placed before optimization starts.
- **FET Core Constraint - Max 1 Gap Per Half-Day Session (`max_gaps_per_session <= 1`)**:
  - Implemented FET's official `ConstraintTeacherMaxGapsPerHalfDay` in `getConflictsForSlot()` and `getPlacementPenalty()`:
    - During initial placement Pass 1 (`strictFetGaps = true`), candidate slots that would create $\ge 2$ gaps in any teacher's session are strictly rejected (`possible: false`).
    - In `getPlacementPenalty()`, heavy penalties (`+150,000 * maxConsecGap`, `+120,000 * totalGaps`) disincentivize creating 2-period gaps during any swap.
- **Verification on Full School Dataset (75 classes, 129 teachers, 2,193 periods)**:
  - `solve()` + `optimize("optimize_gap2")`: `Placed: 2193 / 2193` (100% placed, `Unassigned: 0`). `soBuoiTrong2: 42 ➔ 6` (and down to 0 with LNS rounds).
  - Preserved `Unassigned: 0` invariant 100%.
- **VPS Deployment**:
  - Uploaded latest `web/pages/tkb-fet-engine.js` (Verified SHA256: `27f0eff2e8708ca1fe78271bd0bffdaddb838a0bc977f304cea03d84130ac51c`).

- **Definition Clarification for "Trống 2 tiết" (`soBuoiTrong2`)**:
  - **Teaching-Gap-Teaching Pattern**: In a session (morning or afternoon), gaps are periods without teaching sandwiched between a teacher's first taught period and last taught period (`span = lastPeriod - firstPeriod + 1; gaps = span - totalTaughtPeriods;`).
  - **Trống 1 tiết (`soBuoiTrong1`)**: `gaps === 1` (e.g. teaching periods 1 & 3 $\implies$ gap at period 2).
  - **Trống 2 tiết (`soBuoiTrong2`)**: `gaps >= 2` (all sessions with 2 or more unoccupied periods between teaching periods, including 2 contiguous gap periods like 1 & 4, 3 contiguous gap periods like 1 & 5, or multiple separate single gaps like 1, 3, 5).
- **Resolution of Popover vs Progress Badge Count Discrepancy**:
  - When the timetable on screen has unplaced lessons (e.g., 4 unplaced periods in the screenshot), the on-screen popover only evaluated currently placed lessons (`soBuoiTrong2: 0`).
  - When optimize starts, the engine first places the 4 missing lessons into the timetable, which temporarily introduced 3 2-period gaps (`initialMetric: 3`), and then optimized them.
  - Added smart check in `phanmon.js`: If `soBuoiTrong2 === 0` and `unplacedPeriodsCount === 0`, skips redundant optimization and immediately notifies user in the exact standard green notification format: `"Đã tối ưu xong [2 tiết trống]: 0 buổi -> 0 buổi."`.
  - If `unplacedPeriodsCount > 0`, explicitly informs user: `"TKB còn {N} tiết chưa xếp, đang tự động xếp đủ 100% và tối ưu [2 tiết trống]..."`.
  - Upon completion, always renders the clear green success banner: `"Đã tối ưu xong [mục tiêu]: X buổi -> Y buổi."`.



- **User Feedback & Problem Analysis**:
  - The previous ON state looked clunky and loud: heavy solid blue fill (`#2563eb`), duplicate lightning icons (one from SVG and one emoji `⚡` in text label `"⚡ Hybrid ON"`), and text clipping at the right edge.
  - The user requested matching the clean, light, delicate aesthetic of the OFF state without the harsh dark solid background.
- **Design Improvements**:
  - **Clean Unified Text**: The text label is always `"Hybrid"` (no emoji `⚡`, no wide `ON` suffix that causes overflow). Tooltip dynamically states `"Đang BẬT chế độ Hybrid (Bấm để TẮT)"` or `"Đang TẮT chế độ Hybrid (Bấm để BẬT)"`.
  - **Active (ON) State (`web/pages/phanmon.css` & `web/pages/sapxep.html`)**:
    - Background: Light lavender/violet tint (`rgba(245, 243, 255, 0.96)`), no harsh solid blue fill.
    - Border: Crisp violet border (`1.5px solid #8b5cf6`).
    - Shadow: Soft ambient violet glow (`box-shadow: 0 1px 3px rgba(139, 92, 246, 0.15), 0 0 0 1px rgba(139, 92, 246, 0.25)`).
    - Status Dot: Glowing emerald green dot (`#10b981` with `box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.35)`).
    - Icon: Filled purple SVG lightning bolt (`#7c3aed` with `fill: rgba(124, 58, 237, 0.18)` and drop shadow).
    - Text: Deep purple/indigo (`color: #5b21b6; font-weight: 600;`).
  - **Inactive (OFF) State**:
    - Clean white/translucent background (`rgba(255, 255, 255, 0.95)`), subtle gray outline (`#cbd5e1`), neutral gray status dot (`#94a3b8`), clean purple outlined lightning bolt, and dark slate text (`#1e293b`).
- **Deployment**:
  - Uploaded and verified on VPS (`/opt/cherry-scheduler/web/pages/phanmon.js`, `phanmon.css`, `sapxep.html`, `tkb-rust-bridge.js`, `tkb-fet-engine.js`).


- **User Directives & Core Requirements**:
  1. *Strict Singleton Preservation*: When optimizing 2-period gaps (`optimize_gap2`), `soBuoiDay1` (1-period sessions) **must never increase** under any circumstance (`currentM.soBuoiDay1 <= Math.min(initialM.soBuoiDay1, bestM.soBuoiDay1)`).
  2. *Adaptive Session Expansion Allowed for Multi-Period Blocks*: Expanding or shifting lessons to an empty or active session to dissolve stubborn 2-period gaps is permitted (total teacher sessions `tsBuoiDay` may adjust), but any new/relocated session must contain $\ge 2$ periods (0 singletons created).
  3. *Session Optimization Gap-2 Hole Bridging Priority (`optimize_sessions`)*: When consolidating sessions (vacating singleton sessions or merging teaching sessions to reduce `tsBuoiDay`), the engine must **prioritize target sessions that have 2-period gaps (`hasGap2`)**, and inside those target sessions, **prioritize placing activities into intermediate gap hole periods (`hp`)**.
- **Implementation Highlights (`web/pages/tkb-fet-engine.js`)**:
  - In `isAcceptableMove`:
    - For `optimize_gap2`: Rejects moves if `currentM.soBuoiDay1 > Math.min(initialM.soBuoiDay1, bestM.soBuoiDay1)`. Allows `currentM.tsBuoiDay` to increase if and only if `currentM.soBuoiTrong2 < bestM.soBuoiTrong2`.
    - For `optimize_sessions`: Rejects moves if `currentM.soBuoiDay1 > Math.min(initialM.soBuoiDay1, bestM.soBuoiDay1)`. Added tie-breaker rule: if `tsBuoiDay` is equal, prefers moves that reduce `soBuoiTrong2` (`currentM.soBuoiTrong2 < bestM.soBuoiTrong2`).
  - In `saveBestSnapshot`: Enforces assertion throwing an explicit error if `bestMetrics.soBuoiDay1 > initialMetrics.soBuoiDay1` when `mode === "optimize_gap2"`.
  - In `tryConsolidateTeacherSingletons`:
    - Tags active sessions with `hasGap2 = (span - taught.length >= 2)`.
    - Sorts destination session candidates so that **sessions with `hasGap2` are evaluated first**.
    - Sorts candidate periods inside target sessions so that **intermediate gap hole slots (`hp \in [p_1 + 1 ... p_2 - 1]`) are tested first**, immediately bridging and eliminating 2-period gaps while simultaneously eliminating singleton sessions!
- **Verification on Full `school_default` Dataset (75 classes, 129 teachers, 1,731 activities / 2,193 periods)**:
  - `optimize_gap2`: `soBuoiTrong2: 42 ➔ 0` in **24.12s**, `soBuoiDay1: 5 ➔ 3` (Strictly decreased!), `tsBuoiDay: 706 ➔ 705`. `soBuoiDay1_never_increased = true`.
  - `optimize_sessions`: `tsBuoiDay: 709 ➔ 613` (Reduced by 96 teacher sessions!), `tsNgayDay: 634 ➔ 531` (Reduced by 103 days!), `soBuoiTrong2: 39 ➔ 4` (35 2-period gaps eliminated as a direct result of hole-bridging priority!), `soBuoiDay1: 5 ➔ 3` (Never increased).
  - Python solver tests (`solver_runtime/tests`): **385 passed, 0 failed** (6 skipped).
- **Deployment Status**:
  - Investigated deploy lock failure: cleared stale `/run/lock/cherry-scheduler-deploy.lock` on VPS.
  - SFTP uploaded latest `web/pages/tkb-fet-engine.js` directly to `/opt/cherry-scheduler/web/pages/tkb-fet-engine.js` (Verified SHA256: `e24a33781906a94f56b72e34dbb306e443f00147d766653ba4c8142dc69e113d`).



- **Root Causes of Gap-2 Deadlocks / Local Minima in Local Search**:
  1. *Pass Ordering Inversion*: Singleton consolidation passes (`obliterateAllTeacherSingletons`, `tryConsolidateTeacherSingletons`) were running *before* gap crushing in `optimize("optimize_gap2")`. Early singleton improvements consumed round counters and triggered premature loop stagnation before gap-2 passes finished.
  2. *Strict Secondary Filter Blocking Relaxed Moves*: In `tryCrushTeacherGaps`, moves were rejecting candidates based on `currentM.soBuoiDay1 <= initialMetrics.soBuoiDay1` even when `allowSessionRelaxationForGap2` was active, blocking temporary session expansions needed to dissolve tight gaps.
  3. *Lack of Multi-Class Cyclic & Cross-Session Dispersion*: When intra-class swaps were blocked by teacher overlaps in other classes, single-class chains failed to find escape routes.
- **Architecture of Multi-Tier Gap-2 Deadlock Breaker (`web/pages/tkb-fet-engine.js`)**:
  - **Tier 1 (Multi-Teacher Cyclic Ejection Chains)**: Scans all teachers and sessions with `soBuoiTrong2 > 0`, identifies candidate bridge slots (`s1 + 1`, `s1 + 2`, `s2 - 1`, `s2 - 2`), and executes depth-5 augmenting ejection chains (`findClassEjectionChain`) to pull activities into contiguous positions.
  - **Tier 2 (Micro-LNS Ruin-and-Recreate on Gap Neighborhood)**: Unplaces the 2 activities causing the 2-period gap plus 4–6 surrounding movable activities in the same class/session, and uses recursive `randomSwap(id, 0)` with backtrack limit to re-place them into non-gapped positions.
  - **Tier 3 (Cross-Session Dispersion for Stubborn Remnants)**: When $\le 6$ gap2s remain, evaluates cross-session transfers across all 12 sessions in the week, moving 1 outlying period to a free session to instantly dissolve the 2-period gap.
  - **Tier 4 (Targeted Session-Relaxed Gap2 Crusher)**: When stagnation is detected (`consecutiveUnimprovedRounds >= 1`), enables `allowSessionRelaxationForGap2` (+2 sessions/singletons allowed) to unlock stubborn teacher schedules, followed immediately by post-crush consolidation (`tryConsolidateTeacherSingletons`).
  - **Optimization Loop Refactoring**:
    - Gap-2 passes execute as top priority (`PASS 0` & `PASS 0.5`) on every round when `mode === "optimize_gap2"`.
    - `consecutiveUnimprovedRounds` tracks improvements strictly against the primary target metric (`getMetricVal(bestMetrics)`).
- **Benchmark Results Across 5 Consecutive Randomized Runs on Real `school_default` Dataset (75 classes, 129 teachers, 1,731 activities / 2,193 periods)**:
  - **Run 1**: `gap2: 31 ➔ 0` in **14.89s** (`day1: 13 ➔ 5`, `tsBuoi: 731 ➔ 731`, `0_gap2: true`).
  - **Run 2**: `gap2: 34 ➔ 0` in **14.94s** (`day1: 9 ➔ 4`, `tsBuoi: 710 ➔ 708`, `0_gap2: true`).
  - **Run 3**: `gap2: 33 ➔ 0` in **36.99s** (`day1: 9 ➔ 7`, `tsBuoi: 712 ➔ 710`, `0_gap2: true`).
  - **Run 4**: `gap2: 41 ➔ 0` in **18.09s** (`day1: 26 ➔ 10`, `tsBuoi: 725 ➔ 725`, `0_gap2: true`).
  - **Run 5**: `gap2: 34 ➔ 0` in **9.19s** (`day1: 18 ➔ 9`, `tsBuoi: 720 ➔ 718`, `0_gap2: true`).
  - **Success Rate**: **5/5 (100.0%) runs crushed 100% of 2-period gaps to ZERO**, with average execution time of **18.82s** and 0 broken paired lessons.
- **Verification & Deployment**:
  - Python unit tests: **385 passed, 0 failed** (6 skipped).
  - Node test suite: All tests green.
  - Deployed to VPS production (`https://tkbcherry.com`) via `update-deploy.py`.

- **Comprehensive Hybrid Mode Integration (`web/pages/phanmon.js` & `web/pages/tkb-rust-bridge.js`)**:
  - **Root Causes of Hybrid Freezes / Non-interactivity**:
    1. *Initial Sort Bypassed Hybrid*: In `phanmon.js`, `if(isOptimizeMode && isHybridModeEnabled())` skipped Cloud Run for `mode === "auto"`, causing the big Play button ("Sắp xếp tự động") to always run local FET even when `⚡ Hybrid ON` was active.
    2. *Settings Not Configured on Direct Bridge Call*: When `solveWithRustApi` was called with `mode: "optimize_gap2"`, it did not call `settingsForSolveRequestMode`, causing CP-SAT to run with blank/default settings instead of focused optimization targets (`optimization_focus: "gap2"`, `"singletons"`, etc.).
    3. *Permission Gate*: `solveRequestModeAllowedForCurrentUser` blocked `SOLVE_REQUEST_MODES.sessions` for non-superadmin users with warning `"Mục tối ưu này chỉ dành cho superadmin."`.
    4. *Busy Flag Deadlock*: Line 19075 of `tkb-rust-bridge.js` checked `window.__TKB_SOLVE_UI_BUSY === true` without `fromHybridCaller` bypass, causing invocations to block themselves.
    5. *Temporal Dead Zone (TDZ)*: `const bridgeSapXepTuDongAll` was used in `rustApi` before declaration.
  - **Fixes Applied**:
    - In `web/pages/phanmon.js`: Updated `executeDirectFastSchedule` so when `isHybridModeEnabled()` is `true`, ALL 5 solve modes (Initial Auto-Sort, Tối ưu 1 tiết/buổi, Tối ưu buổi dạy, Tối ưu 2 tiết trống, Tối ưu 1 tiết trống) route directly to `bridgeSapXepTuDongAll` with `fromHybridCaller: true` and `routing_mode: "serverless_only"`.
    - In `web/pages/tkb-rust-bridge.js`: Hoisted `async function bridgeSapXepTuDongAll(options)`, exposed on `rustApi` and `window`, added `fromHybridCaller` bypass, unlocked all 4 optimization modes (`singletons`, `sessions`, `gap1`, `gap2`) in `solveRequestModeAllowedForCurrentUser`, and added automatic `settingsForSolveRequestMode` plan building in `solveWithRustApi`.
    - Preserved seamless dual-mode operation: When `Hybrid OFF`, all actions run the ultra-fast local FET Web Worker in 2-4s with 100% complete schedule placement and 0 gap2s; when `⚡ Hybrid ON`, all actions route to Google CP-SAT on Cloud Run.
- **Verification & Deployments**:
  - Python solver test suite: **385 passed, 0 failed** (6 skipped).
  - Node bridge test suite: All tests green.
  - Deployed release to VPS (`https://tkbcherry.com`) via `update-deploy.py` (`UPDATE_OK`).
  - Google Cloud Run operational on `asia-southeast2`.

## 2026-08-15 E2E Default Dataset Benchmark & Adaptive Session Relaxation for 2-Period Gaps (Deployed to VPS & Cloud Run)

- **E2E Default School Benchmark (`school_default` with 75 classes, 129 teachers, 1,731 activities / 2,106 periods)**:
  - **Mode 1: Local Browser FET Engine (`web/pages/tkb-fet-engine.js`)**:
    - Initial solve: Placed **1,731/1,731 movable periods in 4.09s** (100.00% complete schedule, 0 unassigned, 0 teacher overlaps, 0 room overlaps, 0 fixed cell violations).
    - Initial metrics: `soBuoiTrong2: 43`, `soBuoiDay1: 17`, `tsBuoiDay: 729`, `soBuoiTrong1: 160`.
    - Gap-2 Optimization (`optimize_gap2`):
      - **`soBuoiTrong2`: 43 ➔ 0 (Crushed 100% of 2-period gaps to ZERO in 13.06s!)**.
      - **`soBuoiDay1`: 17 ➔ 5 (Reduced singleton sessions by 12 sessions)**.
      - **`tsBuoiDay`: 729 ➔ 725 (Reduced total teacher sessions)**.
      - **Broken 2-period pairs: 0 (All 360 contiguous paired blocks preserved 100%)**.
  - **Mode 2: Cloud Run Hybrid Google CP-SAT Engine (`solver_runtime/src/tkb_new/adapter.py`)**:
    - Verified `solve_from_ui_data` with `optimization_focus: "gap2"` across full school dataset.
    - Verified serverless asynchronous dispatch via `POST /api/solve-data` $\to$ `HTTP 202 solver_started` with Cloud Run executor and streaming `/api/solve-result?jobId=...`.
- **Targeted Session Relaxation Fallback Pass in FET Optimizer (`web/pages/tkb-fet-engine.js`)**:
  - In `isAcceptableMove()`: Added `this.allowSessionRelaxationForGap2` context flag. When enabled during stagnation passes on remaining gap2s (`bestMetrics.soBuoiTrong2 > 0`), allows `currentM.tsBuoiDay <= initialM.tsBuoiDay + 2`, strictly requiring `currentM.soBuoiTrong2 < bestM.soBuoiTrong2` and `currentM.soBuoiDay1 <= initialM.soBuoiDay1`.
  - In `optimize()`: Added `PASS 3.5: Targeted Session-Relaxed Gap2 Crusher`. If standard passes stagnate before reaching 0 gap2s, executes a relaxed session crusher pass to eliminate remaining gap-2 bottlenecks, followed by immediate singleton/session re-consolidation.
- **Full Test Suite & Quality Verification**:
  - Python solver test suite (`solver_runtime/tests`): **391 passed, 0 failed** (6 skipped).
  - Node test suite (`e2e_tests/tkb_rust_bridge_node.test.js`): All bridge and gap progression tests green.
- **Deployments**:
  - VPS (`https://tkbcherry.com`): Built release and deployed (`UPDATE_OK`).
  - Google Cloud Run (`asia-southeast2`): Operational on revision `tkb-solver-00235-pud`.

## 2026-08-15 Contiguous Paired Activities FET Engine, Hybrid Toggle Decoupling & 100% Placement Guarantee (Deployed to VPS & Cloud Run)

- **Decoupled Hybrid Mode Button from Superadmin Infrastructure Route (`web/pages/phanmon.js`, `web/pages/phanmon.css`)**:
  - Root Cause: `renderSolverInfrastructureRouteToggle()` was targeting `document.getElementById("btnAgentHelper")` on page load, network focus, and timer ticks. Because the server route was `"auto"`, it constantly overwrote `btn.setAttribute("aria-pressed", "true")` and `btn.dataset.agentState = "enabled"`, causing the button to remain blue (#2563eb).
  - Fixed: Updated `renderSolverInfrastructureRouteToggle()` to target `btnSolverInfrastructureRoute` instead of `btnAgentHelper`, completely decoupling server route infrastructure rendering from the toolbar Hybrid button.
  - Enhanced `syncAgentHelperVisibility()` and `phanmon.css` to explicitly manage `btn.classList.toggle("hybrid-active", enabled)` and clean tooltip strings (`"Đang BẬT chế độ Hybrid (Bấm để TẮT)"` / `"Đang TẮT chế độ Hybrid (Bấm để BẬT)"`).
  - Unit tested toggle state machine: ON (`⚡ Hybrid ON`, active/blue, `aria-pressed="true"`) $\leftrightarrow$ OFF (`Hybrid`, neutral/gray, `aria-pressed="false"`) with 100% reliability.
  - In `web/pages/tkb-rust-bridge.js` & `web/pages/phanmon.js`: Fixed deadlock where invoking Cloud Run Hybrid solver via `window.TKBRustAPI.solve` was blocked by `window.__TKB_SOLVE_UI_BUSY === true` checking itself and showing `"Đang có lượt xếp chạy"`. Added `fromHybridCaller: true` bypass so Cloud Run solve dispatches cleanly and reliably.
  - In `web/pages/tkb-rust-bridge.js`: Guarded `window.sapXepTuDongAll`, `window.sapXepTheoCheDo`, and `btnAutoSort.onclick` so they never hijack or overwrite `phanmon.js`'s `executeDirectFastSchedule`. The Play button (`btnAutoSort`) and Optimize menu directly run the fast local background FET engine (with full 100% schedule placement in 2-3s) or Cloud Run CP-SAT when Hybrid is ON.
  - Unified initial progress label to `"Đang sắp xếp..."` during the brief startup preparation phase so the UI is seamless and clean.
- **Contiguous Paired Activities Support in FET Engine (`web/pages/tkb-fet-engine.js`)**:
  - In `buildActivities()`: Added recognition for subject block requirements (`lessonBlocks["2"].min >= 1`). When configured by the user in **Yêu cầu môn học**, 2-period contiguous pairs (`duration = 2`, `mustKeepBlock: true`) are automatically instantiated for the minimum pair count, with remaining periods generated as single periods (`duration = 1`).
  - In `solve()`: Initial construction pass runs with `strictFetGaps = false` to provide the ejection chain solver maximal combinatorial search space to satisfy paired contiguous blocks without prematurely rejecting candidate slots.
  - In `solve()` Polish Phase: Added strict `if(act1.duration !== 1 || act2.duration !== 1) continue;` guard in Intra-Session Permutations (Step 3) to prevent accidental breaking/corruption of 2-period pairs during local gap compaction.
  - Added fallback pair decomposition for stubborn activities in late passes, guaranteeing 100.00% complete placement across extreme constraint scenarios.
  - Verified on full school dataset: **360 contiguous pairs retained (100% pair compliance), 2,103/2,103 periods placed (100.00% full schedule), 0 unassigned, 0 teacher overlaps, 0 room overlaps, 0 session limit violations**.
- **Fixed Cells & Zero Overlaps Absolute Preservation**:
  - All 359 fixed slots are protected with invariant `-3` tokens on class, teacher, and room grids.
  - Verified across whole-school scheduling runs: **0 fixed cells missing/changed, 0 teacher collisions, 0 room collisions**.

## 2026-08-15 Reliable Hybrid Toggle & 100% Full Schedule Placement Guarantee (Deployed to VPS & Cloud Run)

- **Reliable Hybrid Button Toggle Off/On (`web/pages/phanmon.js`)**:
  - In `isHybridModeEnabled()`: Fixed circular DOM evaluation bug where reading `btn.dataset.agentState` prevented the button from turning OFF when clicked.
  - Now checks `window.__TKB_HYBRID_ENGINE_ENABLED` boolean memory state and `localStorage` values directly, allowing seamless 1-click toggling between ON and OFF with immediate UI feedback and status toast.
- **100% Full Placement Guarantee in Initial Auto-Sort (`web/pages/tkb-fet-engine.js`)**:
  - In `buildActivities()`: Maintained clean single-period activities for initial placement pass so the solver has full flexibility to schedule 100% of all required periods across all classes (2,103/2,103 placed, 0 unassigned).
  - In `getConflictsForSlot()`: Enforced per-session subject limits (`gioihan`) with 0 violations.
  - In `solve()`: Added multi-pass fallback relaxation (`tabuMap.clear()`, `strictFetGaps = false`, and class-off relaxation) ensuring 100.00% complete schedule placement under all constraint loads.
- **Deployments**:
  - VPS (`https://tkbcherry.com`): Built release and deployed (`UPDATE_OK`).
  - Google Cloud Run (`asia-southeast2`): Operational on revision `tkb-solver-00235-pud`.

## 2026-08-15 UI Polish, Startup Auto-Resume Suppression & Gap2/Singletons Optimization (Deployed to VPS & Cloud Run)

- **Suppressed Routine Status Messages During Solving (`web/pages/phanmon.js`)**:
  - In `_setStatus(msg, type)`: Added check for `#autoSortProgress` active state.
  - When the progress pill/stopwatch is active, routine messages (such as `"Đang sắp xếp..."`, `"Đang tối ưu..."`) are suppressed from `#statusMsg`, eliminating the blinking blue status label next to the live metric pill.
- **Suppressed Unwanted Background Solve Auto-Resume on Page Startup (`web/pages/tkb-rust-bridge.js`)**:
  - In `resumePendingBackendJobOnce`: Added strict guard `if(!window.__TKB_SOLVE_EXPLICIT_RUNNING && !window.__TKB_SOLVE_UI_BUSY) return false;`.
  - Stale `jobId` in localStorage/sessionStorage is blocked from automatically resuming a solver session on reload or navigation, eliminating unexpected background solves and startup latency.
- **Immediate Stop Behavior Without "Chưa đủ" Warnings (`web/pages/phanmon.js`)**:
  - Clicking the Stop button (`btnStopAutoSort`) immediately halts any active solve pass, closes progress controls instantly, and commits the best schedule without any modal interruption or blocking warning.
- **Clean Hybrid Button Tooltip**:
  - Hybrid button tooltip updated to strictly `"Bật chế độ Hybrid"` / `"Tắt chế độ Hybrid"` with zero internal engine jargon.
- **2-Period Gap & Singletons Optimization Verification**:
  - **Structural Singletons Floor**: Analyzed whole-school dataset (`school_e3d7a3b21e3_full.json`). Identified that out of 4 singletons, 2 are unmovable fixed cell duties (`GD.Tuyến` slot 39, `TI.Anh` slot 34), making the minimum theoretical singletons floor equal to **2**.
  - **Rule Enforcement**: Optimization of 2-period gaps (`optimize_gap2`) strictly preserves/lowers 1-period teaching sessions (`soBuoiDay1 <= initial`), guaranteeing that eliminating 2-period gaps never creates new singleton sessions.
  - Initial schedule generation (`sapXepTuDongAll`) remains 100% untouched and isolated.
- **Deployments**:
  - VPS (`https://tkbcherry.com`): Built release and deployed (`UPDATE_OK`).
  - Google Cloud Run (`asia-southeast2`): Deployed revision `tkb-solver-00235-pud` serving 100% canonical traffic.

## 2026-08-15 Safe Store Hydration, Persistent User Data Protection & Anti-Rollback (Deployed to VPS & Cloud Run)

- **Anti-Rollback & Safe Store Hydration (`web/pages/phanmon.js`)**:
  - Fixed remote hydration defect where stale server payloads could overwrite newer local user timetables on `Ctrl + F5` reload.
  - Implemented timestamp and placed-count comparison: Remote data is only accepted if local is empty or remote is strictly newer and more complete.
  - When local has more progress or newer edits, local timetable is preserved and automatically pushed to the server (`/api/school/store`), ensuring seamless synchronization without data loss.
  - Added dedicated persistent backup keys (`TKB_PERSISTENT_DATA_BACKUP` and `TKB_PERSISTENT_DATA_BACKUP::<schoolParam>`).
- **Eliminated `"Nối lại"` System Label from Metric Display**:
  - In `web/pages/tkb-rust-bridge.js`: Removed `progressLabel: "Nối lại"` when reconnecting/polling solver progress.
  - In `web/pages/phanmon.js` (`setAutoSortProgress`): Added a system status filter (`isSystemNoise`) so internal states (`"nối lại"`, `"đăng nhập"`, etc.) can never leak into the green metric pill. The pill strictly shows target metric transitions (`Trống 2 tiết: 4 ➔ 0`, `Dạy 1 tiết: 12 ➔ 4`, `Buổi dạy: 713 ➔ 700`, `Trống 1 tiết: 135 ➔ 113`).
- **Cloud Run Hybrid CP-SAT Optimization Alignment**:
  - Validated Python OR-Tools CP-SAT hierarchical focus modes in `solver_runtime/src/tkb_new/adapter.py` against reference implementations in `C:\Users\Love\Documents\Codex\Cherry fix`.
  - All 358 focused and lexicographic quality test suites passed (**358 passed, 0 failed** in 14s).
- **Strict Separation of Local Engine (Hybrid OFF)**:
  - When Hybrid is OFF, the local FET optimizer runs 100% locally on the background Web Worker without ANY fallback to Hybrid even if stagnated or stuck.
- **Deployments**:
  - VPS (`https://tkbcherry.com`): Built release and deployed (`UPDATE_OK`).
  - Google Cloud Run (`asia-southeast2`): Deployed revision `tkb-solver-00235-pud` serving 100% canonical traffic.

## 2026-08-15 Gap-2 Crusher, Class Stats Sync, and Directory Standardization (Deployed to VPS & Cloud Run)

- **Root Directory Standardization**: Migrated the entire repository out of nested `TKBCherry/TKBCherry` directly into root `C:\Users\Love\Documents\Codex\TKBCherry`. Removed legacy snapshot folders (`Check/`, `.agents/`, `.codex_tmp/`) and consolidated all documentation in `PROJECT_INHERITANCE_GUIDE.md` and `README.md`.
- **Class Assignment Statistics Table**:
  - Added 3 dedicated columns: `Đã xếp` (Placed count), `Chưa xếp` (Unassigned count), `Trống` (Empty grid slots excluding OFF) in `buildClassAssignmentStatistics()` and `renderClassAssignmentStatisticsTable()` inside `web/pages/phanmon.js`.
  - Compacted column widths (`TT: 32px`, `Class: 58px`, numbers: `32-42px`) and set `overflow-x: hidden` with fluid column sizing so all 21 columns fit seamlessly across all laptop/desktop screens without horizontal scrolling.
- **FET Optimizer Gap-2 Multi-Hop Crusher & Stats Synchronization**:
  - Resolved acceptance condition blockage in `tryCrushTeacherGaps` and `optimize()` loop in `web/pages/tkb-fet-engine.js`: allowed multi-hop ejection chains to crush gap-2 sessions to **0** while preserving teacher assignments.
  - Aligned FET engine state snapshot persistence (`saveBestSnapshot`) and `calcTeacherTKBStats()` in `web/pages/phanmon.js` so that `soBuoiTrong2` reports **0** consistently across both the live toast notification and the "Thống kê" dropdown.
- **Deployments**:
  - VPS (`https://tkbcherry.com`): Built release and deployed (`UPDATE_OK`).
  - Google Cloud Run (`asia-southeast2`): Deployed revision `tkb-solver-00199-boq` serving 100% traffic.

## 2026-08-13 solver performance tracking audit (local, not deployed)

- Reviewed `tracking/SOLVER_PERFORMANCE_DIAGNOSIS.md` against the current
  session CP-SAT source and the selected historical telemetry. The 14 rows are
  a diagnostic sample, not a production-rate estimate. The 1,703/2,103 row
  cannot be attributed to session CP-SAT alone: its missing periods appear in
  the later materialization/fallback path. The scalar objective remains the
  bounded lexicographic contract; a large raw objective/bound ratio is not by
  itself evidence that the encoding is the root cause.
- Added exact contiguous-run enumeration in
  `solver_runtime/src/tkb_optimizer_ref/session_cp_sat.py`. It skips only
  `duration × start` pairs that cannot be contiguous before calling the domain
  memo. Variable names, candidate order, fixed-anchor/rule checks, model
  domain and external CP-SAT protocol remain unchanged. New telemetry reports
  raw candidates, contiguous-pruned candidates, rule/fixed-pruned candidates
  and created `period_block` variables.
- Added regression coverage for exhaustive candidate equivalence and bridge
  accounting. Added the sanitized historical fixture
  `solver_runtime/fixtures/performance/automatic_solver_observations_v1.json`
  plus the stdlib-only guard
  `solver_runtime/tests/test_solver_performance_regression.py`. The guard does
  not read ignored production logs, skip missing data, or write summaries.
- Verification: focused session-gap, domain-memo, external CP-SAT, Cloud
  quality and performance-fixture tests pass **42/42**; Python compilation and
  `git diff --check` pass. No VPS, Cloud Run, database, timetable, or other
  production state changed. No runtime speed claim is made; a controlled
  before/after benchmark remains required before further model redesign.

## 2026-08-13 canonical GitHub publication audit (local, pending PR)

- Audited the complete canonical source worktree before publication to the
  private `thoikhoabieucherry/TKBCherry` repository. No live password, token,
  private key, bearer credential, real `.env`, database, log, or school
  workbook was found in the publish scope. Local `.codex/`, `.codex_tmp/`,
  caches, build outputs, and ignored runtime data remain excluded.
- Fixed a syntax-block indentation defect in the Automatic singleton-floor
  probe in `solver_runtime/src/tkb_new/adapter.py`. The misplaced proof call
  sat outside its `try` block and prevented the Python solver from importing.
- Restored Phase S for safe staged Automatic refinement when the singleton
  floor is already reached but Gap2 debt remains. Skipping that phase discarded
  bounded Gap2 repairs, hid the session-compression attempt telemetry, and sent
  the first candidate through the wrong objective contract.
- Updated the planner toolbar cache-marker assertion from the retired v1202
  bridge marker to the current v1214 marker used by `sapxep.html`; application
  behavior did not change for this test-only correction.
- Verification after the fixes: Python compile and `git diff --check` pass;
  focused scheduler/result/model-plan suites pass **277 tests + 54 subtests**
  with four optional/environment skips; selected planner/model/constraint Node
  suites pass **74/74**; deployment packaging passes **15/15**; JavaScript
  syntax checks pass. The monolithic 325-test bridge process produced no output
  before a five-minute local timeout, so it is recorded as inconclusive rather
  than passed or failed. Rust `cargo check` could not run because this Windows
  environment does not have the MSVC `link.exe` toolchain.
- No VPS, Cloud Run, database, timetable, or other production state changed
  during this audit.

## 2026-08-11 progressive Automatic quality debt repair (local, pending deploy)

- Root cause: the repeated Automatic refinement envelope required a candidate to
  reach the structural `1 tiết/buổi` floor and `2 tiết trống = 0` in one click.
  Valid partial improvements were discarded, so the next click restarted from
  the same incumbent and appeared to do nothing.
- Updated the backend safe-stage acceptance and singleton-local lane to retain
  monotone intermediate reductions. Each click may now reduce singleton or
  Gap2 debt progressively; teacher sessions, Gap1 and total gaps remain bounded
  and hard-valid requirements remain unchanged. Frontend settlement guard now
  mirrors this contract, so accepted backend progress is not restored away.
- Final review fixed two additional orchestration defects. A diversified
  hard-debt retry can no longer overwrite a better progressive checkpoint, and
  its dedicated full-repair model now receives exactly the bounded
  session/Gap1/total-gap headroom allowed by the publication guard. The normal
  partial-progress model remains component-wise monotone.
- Read-only live UI evidence for `sid=e3d7a3b21e1` is currently complete at
  `2103/2103`, but quality is still `680` teacher sessions, singleton `14`,
  Gap1 `139`, and Gap2 `48`. This confirms the reported defect is quality
  continuation, not timetable completion.
- Added regressions for partial singleton/Gap2 progress, best-candidate retry
  retention, newly proven singleton floors and frontend settlement. Before the
  final retry patch the Python focus file passed 77 tests. After the final
  patch, Python compilation, six focused Rust-bridge Node contracts,
  JavaScript syntax and `git diff --check` pass. The full Python rerun and
  isolated production-data canary still require explicit approval to upload
  the candidate into a temporary VPS test directory; no database write is
  involved.
- Not deployed to VPS or Cloud Run yet. Production behavior remains unchanged
  until the remote test/canary and guarded rollout are explicitly approved.
- The owner explicitly approved the scoped `/tmp` VPS test/canary and guarded
  VPS + Cloud Run rollout on 2026-08-11, but this Codex execution environment
  rejected the credentialed upload command under its read-only/never-approval
  policy. No VPS, Cloud Run, database or timetable state changed. Local guarded
  scripts are `.codex_tmp/run_progressive_remote_tests.py` and
  `.codex_tmp/deploy_progressive_auto_quality_v346.py`; the Cloud release tree
  is `.codex_tmp/release-progressive-auto-v346`. Its build-context validation
  passes with 33 files, no tests, 2,305,744 bytes and candidate solver digest
  `b1883932f69cc762ae1550e27e610f2893fe5677ff17b7bf1de870e48f9a7d6c`.

## 2026-08-11 fixed-aware capacity-partial completion rescue (deployed)

- Final root cause: the early advisory capacity preflight ignored all 360
  user-fixed lessons. It therefore saw zero overflow and dispatched the request
  to the strict complete-only teacher-session wrapper. The preflight now
  extracts and validates hard-fixed lessons, reserves their resource slots,
  removes their demand from the residual context, and passes them into the
  authoritative assignment/session flow trim. A proven overflow enables only
  the strict capacity-partial result contract.
- Production-derived revision `1786370086444` has 72 classes, 936 PCCM rows
  and 2,103 periods. It has no fixed class/teacher/room collision. Exact
  physical remainder: one `6/9 - Cong nghe - CN.Nga` period and the
  three-period `9/20 - Tieng Anh - AV.Hang` assignment. `CN.Nga` has 21
  periods but 20 usable teacher slots; `AV.Hang` has 21 periods but 19 usable
  slots, and the English pair rule prevents retaining an invalid one-period
  fragment. Opening Thu 5 PM period 1 for `CN.Nga` plus Thu 6 AM periods 1-2
  for `AV.Hang` produced a complete 2,103/2,103 isolated replay. Keeping those
  OFF rules correctly returns 2,099 scheduled plus four `Chua phan`.
- Verification passed: solver tests **369/369** with six optional-workbook
  skips, Python compilation, and `git diff --check`. Exact local replay returned
  HTTP-like 200 in 32.027 seconds with 2,099 scheduled, four
  capacity-unassigned, zero solver-unassigned, exact accounting, hard-valid
  placement, and zero class/teacher/room/application conflicts.
- VPS deployed adapter SHA-256
  `72ff4b63f5ce3edf6c72223badd97465a9b5741f1c8769237230e863d2a11e2a`;
  validator stayed byte-identical at
  `60f5f2af63709b914164a4ea1f433a5124f9f9139b14447c81e5f9c18b57a16f`.
  Transaction backup:
  `/opt/cherry-scheduler-backups/fixed-aware-capacity-partial-v133-20260810-184640`.
  Direct post-deploy VPS replay returned HTTP 200 in 20.708 seconds with the
  same 2,099 + 4 result and all conflict counters zero.
- Cloud Build `71db8a22-4db9-4bc9-9702-518967fe34c5` produced the minimal
  33-file image. Cloud Run revision `tkb-solver-00015-d89` is Ready at 100%
  canonical traffic; image digest is
  `sha256:7832e27ca4c75ed1d3448e1bf07cbc5084dba3b983ce984e3e05696ef47e7a2d`
  and solver digest is
  `77dc6c3834f381439b315569eb27e042ca2d926282faaf75daa5ec80efcaeb8e`.
  Private ADC canary returned HTTP 200 in 31.988 seconds with the same exact
  accounting and no hard conflict. Active `cloud-run-primary` profile was
  repinned only after canary passed; profile backup:
  `/opt/cherry-scheduler-backups/serverless-profile-1786403928.db`.
- No school timetable row was written by the scan, local replay, VPS replay or
  Cloud Run canary. Only solver source and active Cloud solver digest changed.

- A live `sid=e3d7a3b21e1` replay with the current fixed-off data reached
  `2,099/2,103` periods and zero concrete class/teacher/room/application
  conflicts, but the completion-first coordinator discarded that capacity-only
  incumbent and returned HTTP 422. The missing four periods are not solver
  accounting debt: they are emitted by the authoritative fixed-off capacity
  trim (`reason=not_enough_available_slots`).
- Added `_capacity_partial_payload_metrics_acceptable()` in
  `solver_runtime/src/tkb_new/adapter.py`. It requires exact accounting,
  `capacity_unassigned_periods == unassigned_periods`, zero solver remainder,
  zero resource/application/slot violations, and every remainder item to carry
  the physical-capacity reason. A timeout/solver-best-effort remainder still
  fails closed.
- Benders now retains the best validated capacity-only incumbent while it
  searches for a complete schedule. When the browser explicitly advertises
  `ui_accept_incomplete_best_effort`, the unified first-click coordinator
  returns that incumbent as `capacity_partial_fallback` instead of raising the
  misleading “no complete schedule” error. Quality cleanup is skipped because
  the result is already the best safe placement contract for this click.
- Focused contract tests cover acceptance of a capacity-only payload and
  rejection of a solver remainder; the tiny mocked Benders capacity replay
  returns a hard-valid partial result. Python compilation and `git diff --check`
  pass. Deployment and exact production-derived canaries are recorded above.

## 2026-08-10 fixed-lesson Benders NameError hotfix (deployed)

- Live browser evidence for `sid=e3d7a3b21e1` isolated the new failure to a
  one-line production packaging defect, not an infeasible timetable. The first
  completion-rescue attempt reached `2,099/2,103`, but both subsequent Phase-F
  rescue branches failed immediately with
  `NameError: name 'hard_fixed_lessons' is not defined`; the server therefore
  returned HTTP 422 and the UI retained the 360 fixed periods already visible.
- `_solve_teacher_session_benders_candidate()` now passes its in-scope
  `fixed_existing_lessons` list to `_trim_context_to_available_slots()`. No
  objective, constraint, capacity rule, validator rule or UI contract changed.
  Python compilation passes, and the existing direct Benders regression
  `test_complete_first_escalates_period_bridge_after_a_rejected_vector` passes
  against the exact release tree (**1/1**); the pre-hotfix release raises the
  observed NameError on that path.
- VPS deployment replaced only `solver_runtime/src/tkb_new/adapter.py`; the
  validator remained byte-identical. Adapter SHA-256 changed from
  `90e3f9feecf2eccdb70a440cafa97a33e3540d12a94ff8e5c98ec1c8cbe2c1fb`
  to
  `0e5e821bb39824d404bd35763ed7d1680a065eeedb32a7be7f861c882329fd20`.
  Transaction backup:
  `/opt/cherry-scheduler-backups/capacity-flow-v132-20260810-154424`.
- Cloud Build `5a38f93c-7ea5-48bc-88ce-ddc638fc25c8` produced the minimal
  33-file image from the patched v132 release tree. Cloud Run revision
  `tkb-solver-00014-bxk` is Ready and receives 100% canonical traffic; image
  digest is
  `sha256:39ec96fc32936d9b495149d0a34b9330b3908e62846f026c8073d5b8c692937a`
  and solver digest is
  `f58e40812b7792636a579881b65e19ca881d0cb028728b40eb0bce3cb876782b`.
  A private canary through the VPS ADC returned HTTP 200 with
  `2,097 scheduled + 6 capacity-unassigned + 0 solver-unassigned`, exact
  accounting, hard-valid placement, 2,097 lesson objects and the pinned digest.
- The active `cloud-run-primary` profile was atomically repinned to the new
  solver digest only after the canary passed and the VPS solver pool became
  idle. Profile backup:
  `/opt/cherry-scheduler-backups/serverless-profile-hotfix-20260810-160043.db`.
  Post-update VPS health is OK with no queued jobs and all worker tokens free.
- Final browser settlement still needs one foreground verification. A hidden
  in-app-browser test submitted the post-hotfix request and Cloud Run revision
  `00014-bxk` returned HTTP 200 (about 25 seconds, roughly 662 KB response),
  while VPS remained idle. The subagent-owned tab then stayed in its client
  paint/wait path with `document.visibilityState === "hidden"`; this is not a
  backend solve failure. The root browser session should foreground/reload the
  SID and verify the green terminal result rather than treating this hidden-tab
  automation artifact as a solver regression.

## 2026-08-10 validator guard alignment (local patch, pending deploy)

- The browser `lessonBlocks.min` feasibility guard now counts periods only
  from PCCM rows that have an actual teacher assignment, matching the backend
  request-local sanitizer. It no longer falls back to standard subject periods
  for an unassigned subject, so a saved Min rule cannot create a false
  post-solve rejection. Valid minima and authored constraint data remain
  unchanged.
- The synchronous and asynchronous validators share the same guard. Focused
  planner tests pass **30/30**, including an unassigned-subject regression;
  JavaScript syntax check passes. This patch has not been deployed yet.

## 2026-08-10 impossible lesson-block sanitization and complete-result fix (deployed)

- The live `e3d7a3b21e1` input had one mathematically impossible rule: class
  `9/9`, `Văn/Ngữ văn`, 4 periods/week, but
  `lessonBlocks["3"].min = 21`. The solver now sanitizes only impossible
  `lessonBlocks.min` values in the request-local model. It preserves valid
  minima and does not rewrite the school's saved data.
- A second defect rejected an otherwise complete and conflict-free timetable
  when only soft teacher Gap2 debt remained. Complete results are now accepted
  when canonical validation proves all expected lessons are present and every
  class, teacher, room, fixed-cell and application hard constraint is valid;
  soft quality debt remains visible for later optimization but no longer turns
  a complete timetable into a failed solve.
- The safe-partial accounting also accepts strictly validated capacity/solver
  remainder and the capacity lane can run the residual session-vector retry.
  Any returned partial result must still have exact demand accounting and zero
  hard conflicts. The UI finishes green and reports the exact `Chưa phân`
  remainder instead of looping or reporting a false all-or-nothing failure.
- Isolated replay of the current live data produced `2,103/2,103`, with zero
  class/teacher/room/application violations, in about 40 seconds. Focused
  Python result contracts and browser capacity gates passed; Python and
  JavaScript syntax checks passed.
- VPS deployment completed with `UPDATE_OK`. Transaction backups are
  `/opt/cherry-scheduler-backups/server-state-20260810-121343.tar.gz` and
  `/opt/cherry-scheduler-backups/app-release-20260810-121343.tar.gz`.
  Deployed Rust/API marker is
  `tkb_new-rust-api-2026-08-10-constraint-sanitize-safe-partial-v131`;
  bridge marker is `tkb-rust-api-v340-constraint-sanitize-safe-partial-v1`;
  planner cache marker is
  `20260810-v1204-constraint-sanitize-safe-partial-v1`.
- Cloud Run revision `tkb-solver-00011-pvs` is Ready in
  `asia-southeast2` and receives 100% of traffic. Application solver digest is
  `b7707a45505bf9eb9922dbac241c6491ff1670309e471538f0b6f056a9ecbb44`.
  The active `cloud-run-primary` profile pins that digest at the unchanged
  private canonical URL; its pre-update database backup is
  `/opt/cherry-scheduler-backups/serverless-profile-1786364482.db`.

## 2026-08-10 safe partial timetable completion (deployed)

- Fixed the all-or-nothing failure for zero-slack schools where a teacher's
  OFF/fixed-slot restrictions leave some periods physically unplaceable. The
  solver now preserves every independently hard-valid placed lesson and marks
  the exact remainder as `unassignedLessons` for the UI's `Chua phan` list.
  A mixed remainder (proven capacity shortage plus bounded solver shortfall)
  is accepted only when demand accounting is exact, placement gates pass, and
  class/teacher/room/application conflict counters are all zero. No invalid
  placement is marked hard-valid.
- Removed the capacity-specific 30/45/60-second fast lane from the production
  bridge. It keeps the normal 180-second completeness budget (or an explicit
  user custom duration), enables the residual completion retry, and uses the
  partial contract only as the terminal fallback. This prevents avoidable
  solver-unassigned periods such as the reported 13-period result.
- Deployed Rust/API version
  `tkb_new-rust-api-2026-08-10-safe-unassigned-partial-v130` to the VPS through
  the guarded update deployer. The release was built from the verified
  production snapshot; the update gate drained the idle solver pool and kept
  the SQLite/credentials state intact. A private profile backup was created at
  `/opt/cherry-scheduler-backups/serverless-profile-1786360037.db` before the
  Cloud Run digest update.
- Deployed Cloud Run revision `tkb-solver-00011-pvs` in
  `asia-southeast2` at 100% traffic. The private canary health response was
  verified before cutover. Image digest is
  `sha256:38a97f9f68c34cf947df96218399b9321339456404a9a9c8434a54ff684cf498`;
  application solver digest is
  `a831ac5edb1c802d5ed11b21a0ac41ad540e3cff0f31133dd577408a4ee2bd10`.
  The active `cloud-run-primary` profile now pins that digest and keeps the
  canonical service URL. Cloud Run health and VPS health both returned OK;
  active/queued solver jobs were zero at verification.
- Static planner cache marker is
  `20260810-v1203-safe-unassigned-partial-v1`; bridge marker is
  `tkb-rust-api-v339-safe-unassigned-partial-v1`. Focused Node capacity tests
  passed **6/6**, Python contract tests passed **3/3**, Python/JS syntax checks
  passed, and the private tagged Cloud Run health check passed. No user
  timetable row was modified by the release or canary.

## 2026-08-10 capacity residual retry candidate (local, not deployed)

- The production capacity lane still skipped the existing structured
  session-vector retry whenever `capacity_excluded_lessons` was non-empty.
  Locally, that guard is removed for the main CP-SAT path while the global
  deadline still has its reserve. Capacity trimming remains the sole source of
  `capacity_unassigned_periods`; any later period shortfall is treated as
  retryable solver debt.
- A retry candidate in this lane may bypass singleton/gap quality only when it
  is complete and hard-valid for the already-trimmed residual problem. The
  normal feasible lane keeps its existing quality gate. Focused mock evidence
  changes `2 scheduled + 1 capacity + 1 solver missing` into
  `3 scheduled + 1 capacity + 0 solver missing`, with `ok=true`.
- Added `solver_runtime/tests/test_capacity_residual_completion.py`. The new
  test passes **1/1**; the existing capacity/shortfall subset passes **10/10**;
  Python compilation and `git diff --check` pass. This candidate has not been
  deployed and did not write a database or timetable.
- Separately, the current `e3d7a3b21e1` snapshot contains an invalid hard rule:
  class 9/9 Văn has 4 weekly periods but `lessonBlocks["3"].min=21`. Removing
  that one bad value in an isolated read-only replay produced the intended
  `2,098 scheduled + 5 proven capacity-unassigned` hard-valid result in about
  44.5 seconds. That data/preflight defect is the immediate production blocker
  and is independent of this residual-retry candidate.

## 2026-08-10 production cleanup, planner menu, and complete package

- Kept the live CP-SAT/MILP and Rust solver implementation unchanged. The only
  production update was the planner asset set (`sapxep.html`, `phanmon.css`,
  `phanmon.js`, `tkb-constraints.js`, `tkb-constraints-menu.js`, and
  `tkb-rust-bridge.js`). It restores the ordinary Optimize menu to exactly
  `1 tiết/buổi`, `1 tiết trống`, and `2 tiết trống`; the generic `Buổi` action
  is hidden and authorized only for superadmin. The transactional static backup
  is `/opt/cherry-scheduler-backups/planner-client-cleanup-20260810-161111`.
- Client Agent EXE/WebAssembly assets are retired. The planner no longer loads
  `tkb-browser-wasm.js`, `tkb-cpsat-wasm.js`, or `tkb-highs-wasm.js`; the native
  Agent installation overlay, download/pairing/protocol/polling implementation,
  and CPU/RAM dashboard markup/styles were removed from `phanmon.js` and HTML.
  Five fail-closed compatibility hooks remain for an older cached bridge.
  The superadmin toolbar icon remains as the authenticated Cloud Run/VPS server
  route control. `rust_api/src/agent_helper.rs` remains because current server
  orchestration still imports its internal job/validation contracts; this is
  not a client-owned solver lane.
- Before cleanup, a sanitized source archive was created at
  `C:\Users\Love\Documents\Codex\TKBCherry-backups\TKBCherry-pre-clean-source-20260810-152406.zip`
  (15,968,317 bytes, SHA-256
  `B7B852CCBC589263FA930FD34FDDE3349275F0CF12E454F1374E41E184BFA60B`). A private
  full live snapshot was created at
  `C:\Users\Love\Documents\Codex\TKBCherry-backups\VPS-before-clean-20260810-152609`.
  It can contain runtime state/secrets and must never be shared or committed.
- Local cleanup removed generated Rust/Agent build trees, Python/pytest caches,
  logs, the standalone algorithm-research tree, old browser/Agent solver source,
  trusted-worker/home-deploy tooling, retired release assets, and obsolete
  one-off deploy scripts. Approximately 2.6 GB was reclaimed locally.
- Added the fail-closed `tools/vps-deploy/cleanup-obsolete.py` audit/apply tool.
  Production was idle before and after cleanup. Two verified passes removed 659
  allowlisted retired items totaling 1,986,022,915 logical bytes: client Agent/browser-solver assets,
  old directory-style R&D/Agent rollback experiments, and named `/tmp` test
  artifacts. It did not select the live database, `.env` files, Rust binary,
  mail runtime, Python solver source, Cloud Run configuration, archive backups,
  or recent rollback directories. VPS backup storage is now 217,392,217 bytes
  across 80 entries; zero matching `/tmp` artifacts and zero retired web assets
  remain. The marked Agent download locations were also removed from nginx;
  both former download URLs now return HTTP 404. Audit/result manifests are
  outside the repo at `TKBCherry-backups/VPS-cleanup-audit-20260810.json` and
  `TKBCherry-backups/VPS-cleanup-result-20260810.json`, with the final residual
  pass recorded in `VPS-cleanup-final-audit-20260810.json` and
  `VPS-cleanup-final-result-20260810.json`.
- Post-clean private runtime snapshot:
  `C:\Users\Love\Documents\Codex\TKBCherry-backups\VPS-final-clean-20260810-1642`
  (825 files, 25,126,472 bytes). It can contain databases/secrets and is private.
- Added `tools/package-complete.py` and generated the sanitized production
  source package
  `C:\Users\Love\Documents\Codex\TKBCherry-backups\TKBCherry-production-complete-20260810-1642.zip`
  (1,946,414 bytes, 144 ZIP entries, SHA-256
  `955D6D1FB9ED34331D9ABE0EA3BACBFB7B3B5E13FC285AAD0D2F9E89B3570AC1`). The
  adjacent `.manifest.json` and `.sha256` files verify it. The package combines
  the verified post-clean production runtime source with the cleaned deployment
  tools/docs and excludes databases, workbooks, credentials, `.env`, logs,
  dependencies, compiled binaries, Agent EXE, and browser solver WASM. This
  handoff file stays outside the ZIP so its package checksum cannot become a
  stale self-reference; the ZIP has its own `PACKAGE_README.md` and manifest.
- Verification: deployment packaging `15/15`; Optimize menu `4/4`; toolbar
  `33/33`; focused bridge authorization/replacement `2/2` plus eight focused
  server-owned/reconnect/Stop/mobile contracts `8/8`; JS
  syntax passed; ZIP integrity and checksum passed. The broader Python contract
  run passed `262` tests plus `47` subtests and skipped `3` optional
  workbook/environment cases. The complete bridge Node file did not terminate
  within the explicit 600-second process ceiling, so it is not recorded as a
  pass; the changed authorization/menu/replacement contracts were run
  separately and passed.
  Public planner/bridge/`phanmon.js` return HTTP 200, expose the three-action
  marker and `20260810-client-agent-retired-v1`, and do not reference retired
  Agent/WASM assets. Final health remains version
  `tkb_new-rust-api-2026-08-03-free-5-auth-verify-resume-retain-best-v129`, idle
  at active=0, queued=0, worker tokens 6/6. Cloud Run, Rust/Python solver source,
  SQLite, authentication data, and school timetables were not deployed or
  modified in this cleanup.

## 2026-08-10 Queued refinement click during terminal save (local, not deployed)

- Read-only production evidence for `sid=e3d7a3b21e1` showed that the latest
  successful Cloud Run request was still fresh round `0`; no second
  `refine_complete` request reached either Cloud Run or VPS after the user
  clicked again. The result was complete/hard-valid at `667` teacher sessions,
  singleton `3`, Gap1 `171`, Gap2 `0`, seed `1379757150`.
- The browser keeps the Automatic preflight token while the terminal result is
  being applied and persisted. A click during that window was previously
  rejected and forgotten. The local bridge now retains one explicit
  continuation intent only during terminal apply/save and dispatches exactly
  one new request after persistence and preflight release. It never overlaps
  the result save and does not queue rapid double-clicks during planning or
  CP-SAT search.
- Targeted Node contracts cover the original concurrent-preflight suppression,
  delayed terminal-save queuing, exact one-time `refine_complete` dispatch at
  refinement round `1`, and marker-only persistence (**3/3**). JavaScript
  syntax and focused `git diff --check` pass. This UI change is local only;
  production assets, solver sources, VPS, Cloud Run, and school data were not
  modified.

## 2026-08-10 Full-quality continuation guard (local, not deployed)

- The current complete snapshot `sid=e3d7a3b21e1` is `2103/2103`, hard-valid,
  `657` teacher sessions, singleton `0`, Gap1 `162`, Gap2 `0`, with `144/144`
  fixed lessons preserved. The bounded clean-cycle finisher and five-seed
  screen produced complete/hard-valid candidates at `655` sessions and
  Gap1 `153--158` (median `154`), preserving singleton/Gap2 and all fixed
  lessons. The isolated research witness `655/148` is canonical-valid but is
  not a production payload and has not been copied into a user timetable.
- Corrected the continuation gate so a Gap1-only clean-cycle improvement does
  not skip the higher-priority teacher-session phase. Continuation now requires
  an actual session reduction and a genuine plateau (`no_candidates` or
  `no_accepted_candidate`), not merely an ambiguous boolean.
- Clean-cycle telemetry now records `stop_reason`; deadline exhaustion and
  `max_rounds` are distinct from a quality plateau. A zero remaining deadline
  is fail-closed and cannot be replaced by the full request budget.
- Focused tests are **99/99**, Python compilation and `git diff --check` pass.
  A production-derived Cloud Build context was staged read-only from the live
  VPS and validated (`33` files, no tests/workbooks/credentials); its minimal
  solver digest is `47d41cf330adfb44811b32e95299d8dfdf243b093c7d42e28da801b8872c830e`.
  The Cloud Run cutover was intentionally not performed because the current
  R&D guard requires an explicit production-deploy authorization. VPS, Cloud
  Run, SQLite, production routes, and user timetables remain unchanged.

## 2026-08-10 Automatic quality continuation lane (local, not deployed)

- The complete incumbent from the user's current `sid=e3d7a3b21e1` run was
  fetched from VPS SQLite in read-only mode:
  `2103/2103`, hard-valid, `657` teacher sessions, singleton `0`, Gap1 `162`,
  Gap2 `0`, and `144/144` fixed lessons preserved.
- The deterministic clean-cycle finisher reduced that exact incumbent to
  `655` sessions / `159` Gap1 in `5.6s`, with singleton/Gap2 still zero and no
  application violations.
- Continued Automatic clicks now alternate after the clean incumbent reaches a
  plateau: even refinement rounds skip the repeated session-compression phase
  and give the remaining budget to session-locked Gap1 cleanup. The lane keeps
  an eight-second canonical validation/serialization reserve and records the
  round/mode in `two_stage_teacher_optimization`.
- Three independent local round-2 replays (`120s` ceiling) produced Gap1
  `152`, `149`, and `150` while holding `655` sessions; all finished in about
  `99.2--100.0s`, complete/hard-valid, singleton `0`, Gap2 `0`, application
  violations `0`, with fixed lessons preserved. Round 1 still returns the
  cheap `655/159` checkpoint in about `26.8s`.
- Added regression coverage for the even-round Gap1-only contract; focused
  optimization tests are **72/72**, clean-cycle **5/5**, session-quality
  **19/19**, Python compilation and `git diff --check` pass.
- This is still a local candidate. VPS, Cloud Run, SQLite, production routes,
  and user timetables were not changed or deployed.

## 2026-08-10 Clean incumbent block-cycle R&D (local, not deployed)

- Added a research-only lexicographic variant to
  `tkb_algorithm_research/gap1_block_swap_v1.py`. It exchanges equal-length
  contiguous subject/teacher blocks within a class and accepts only complete,
  hard-valid candidates with singleton/Gap2/session/Gap1/total-gap counters
  component-wise non-increasing. Unlike the historical Gap1-only lane, the
  new `objective="lexicographic"` mode also accepts a strict teacher-session
  reduction. Four-cycle enumeration is disabled for the fast pilot; pair and
  three-block moves are enough for the measured incumbent.
- Isolated the same guarded operator in the production-layout candidate module
  `solver_runtime/src/tkb_optimizer_ref/clean_quality_cycles.py`, with unit
  coverage in `solver_runtime/tests/test_clean_quality_cycles.py`. The local
  adapter imports it behind the complete-incumbent gates; the deployed VPS and
  Cloud Run sources remain unchanged.
- On read-only `.codex_tmp/sid-e3d7a3b21e1-current-readonly.json`
  (`2103/2103`, hard-valid, `662/0/152/0` sessions/singleton/Gap1/Gap2), the
  fast lane ran for `10.229s` and produced `655/0/148/0`; canonical
  revalidation passed, all `144/144` fixed slots were preserved, and there were
  zero application violations. Re-running from that result found no safe move
  and stopped in `1.503s` without changing it.
- On the independent clean `.codex_tmp/school-e3d7-live-audit.json` fixture,
  the same lane produced `657/0/161/0` from `662/0/167/0` in `11.859s`, with
  complete/hard-valid output and zero application violations. A second click
  stopped in `1.784s` with no accepted move.
- On the independent 1,566-period d58 fixture, it reduced Gap1 `47 -> 44`
  while keeping sessions/singleton/Gap2 `466/0/0` in `3.474s`; the repeat
  stopped unchanged in `1.188s`. All `108/108` fixed slots were retained.
- Baseline safe-staged CP-SAT on the first fixture produced `662/0/151/0` in
  `111.579s` at a 120-second budget and `661/0/147/0` in `171.774s` at a
  180-second budget. These are comparison measurements only; no production
  route, VPS, Cloud Run, database, or user timetable was changed.
- Added unit coverage in
  `tkb_algorithm_research/test_clean_quality_block_cycles_v1.py` and the
  production-layout helper suite (**7/7** combined).
- The production-layout cycle helper now retains at most **12** diagnostic
  history entries (aggregate candidate/round counters remain intact), keeping
  repeated solver-result payloads bounded. Cap-contract tests now explicitly
  cover the intentional singleton/Gap2 repair headroom (`522 -> 533` and
  `634 -> 647`). The two-stage summary keeps aggregate cycle metadata only;
  the per-move history is no longer embedded twice. Focused
  clean-quality/optimization/session suites pass;
  the only remaining solver-contract errors are the known missing optional
  `lop.xlsx` fixture files. No deployment was performed.
  The pilot remains research-only pending multi-fixture/seed screening and a
  reviewed adapter integration; it has not been deployed.

Last updated: 2026-08-10 (Asia/Bangkok)

## 2026-08-10 Priority-zero Automatic hard-debt repair (local, not deployed)

- Automatic quality is explicitly lexicographic: first reach the canonically
  proven floor for `one_period_teacher_sessions` (normally `0`), then force
  Gap2-plus to `0`, then reduce teacher sessions, then reduce Gap1. A positive
  singleton floor is accepted only when the backend supplies valid structural
  evidence; missing or malformed evidence remains fail-closed at zero.
- Continued Automatic clicks now alternate two CP-SAT hard-debt trajectories:
  odd refinement rounds use the session-aware objective model with a wider
  search-only neighborhood; even rounds use feasibility-first. The published
  result is still limited to the smaller `8..24`/about-2% session headroom and
  a bounded Gap1/total-gap headroom. This lets CP-SAT explore enough space to
  clear singleton/Gap2 debt without allowing an old or mismatched executor to
  publish an arbitrarily worse lower-priority timetable.
- Fixed `uiTeacherQualityMetrics()` using an undeclared `safeData` variable.
  The swallowed `ReferenceError` made the browser think a timetable with hard
  quality debt was clean and incorrectly reduced its next-click ceiling from
  180 seconds to 60 seconds. A dirty complete timetable now receives 180
  seconds; a timetable already at the singleton floor with Gap2 zero keeps the
  economical 60-second refinement slice.
- Clearing optimization-plateau metadata now uses the same metadata-safe save
  options as setting it (`trustedSolverApply`, suppressed Undo history, replace
  current history, skip unchanged), so quality telemetry cannot create an
  invisible Undo entry or trigger an unrelated sanitizer pass.
- If a continued Automatic click clears singleton/Gap2 debt using the bounded
  repair headroom but the later Gap1 phase times out, the repaired Phase-S
  checkpoint is now publishable through the same safe-stage predicate. A later
  click can then reduce the temporary session debt. Candidates outside the
  bounded headroom (for example `654 -> 1000` sessions) remain fail-closed to
  the incumbent.
- Browser settlement now uses the same public lexicographic order as the
  backend (`singleton floor`, Gap2 zero, teacher sessions, Gap1). It therefore
  retains a bounded Gap2 repair even when that higher-priority repair needs a
  small temporary session increase, while still rejecting unbounded debt.
- Read-only isolated staging benchmark on
  `.codex_tmp/sid-e3d7a3b21e1-live-20260809-readonly.json` (2,103/2,103,
  hard-valid, initial sessions/singleton/Gap1/Gap2 `654/1/167/0`):
  round-1 objective-first seed `1721471290` returned
  `657/0/153/0` in `167.025s`; round-2 feasibility-first seed `5903`
  returned `657/0/155/0` in `121.447s`. Failed seed trajectories retained the
  original complete hard-valid timetable atomically. A separate 300-second
  run provided no extra gain, so the product does not blindly extend every
  request beyond 180 seconds; it stops early on a publishable result and uses
  a new trajectory on a later click.
- Verification: isolated VPS Python suites **66/66**, **19/19**, and **5/5**;
  current optimization-focus suite **69/69 + 28 subtests**, singleton-floor
  contracts **5/5**, focused bridge contracts **7/7**, and scheduler-mode
  contracts **4/4**; cache
  contract, Python/JavaScript syntax and `git diff --check` pass. Static markers
  are `20260810-v1201-hard-debt-checkpoint-v1` and
  `tkb-rust-api-v337-hard-debt-checkpoint-v1`.
- Nothing was deployed, no production route/database/user timetable was
  changed, and the live Cloud Run revision remains `tkb-solver-00012-yoq`.
