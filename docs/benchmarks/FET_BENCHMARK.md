# FET benchmark harness

`tools/benchmarks/benchmark-fet.js` runs the same browser FET source used by
the Web Worker against deterministic, anonymised fixtures. It never reads the
production `DATA` singleton, calls a network service, or deploys anything.
Every seed/mode receives a fresh fixture copy.

## Fixtures

| Variant | Classes | Required periods | Purpose |
| --- | ---: | ---: | --- |
| `smoke` | 5 | 49 | Fast regression smoke test with shared teachers/rooms, OFF cells, fixed cells and paired lessons. |
| `pressure` | 6 | 51 | Smoke data plus two fixed edge lessons that prove a structural `gap2` floor of 1. |
| `medium` | 24 | 432 | Synthetic contention fixture in the 300–700-period range. |
| `stress` | 60 | 2,340 | Synthetic 1,500+ period fixture for capacity/runtime observations. |

The synthetic names (`S001`, `GV001`, `P001`, etc.) contain no school or user
data. `medium` and `stress` are deliberately larger than the smoke fixture;
they are useful for detecting budget exhaustion, not as proof that FET can
solve every production school inside a fixed budget. `stress` leaves both
sessions available per class so its load is structurally feasible; `medium`
retains morning/afternoon class domains for `ca` coverage.

## Commands

Run the fast regression set:

```powershell
node tools/benchmarks/benchmark-fet.js `
  --fixture=smoke `
  --seeds=101,202,303 `
  --modes=auto,optimize_singletons,optimize_sessions,optimize_gap2,optimize_gap1
```

Write a machine-readable report:

```powershell
node tools/benchmarks/benchmark-fet.js `
  --fixture=pressure `
  --seeds=101,202,303 `
  --modes=auto,optimize_gap2 `
  --out=docs/benchmarks/fet-pressure-latest.json
```

For a bounded medium/stress observation, select Auto only and set a budget:

```powershell
node tools/benchmarks/benchmark-fet.js --fixture=medium --seeds=101 --modes=auto --auto-budget-ms=12000
node tools/benchmarks/benchmark-fet.js --fixture=stress --seeds=101 --modes=auto --auto-budget-ms=1000
```

`--optimizer-timeout-ms` sets a harness stop request for asynchronous FET
optimization (clamped to 120 seconds). `--auto-budget-ms` follows the engine's
1–30 second construction range. A stopped run is reported as a non-target
result; the harness does not convert it to success.

## Report fields and validity gate

Each record contains runtime, executor, placement counts, initial/final
metrics, target status, failure kind, preflight diagnostics, and independent
validator violations. `completeValid` is true only when all required cells are
present, the engine reports zero unassigned activities, and the validator sees
no hard violation. `targetReached` means the requested metric reached zero;
`floorReached` means it reached the fixture's declared structural lower bound.

The validator checks class morning/afternoon (`ca`), class/teacher/room OFF,
fixed-cell preservation, teacher and room collisions, subject maximum periods
per half-day, paired lesson blocks, and optional spacing/no-same metadata. It
reports an enabled rule violation instead of silently treating an unsupported
rule as satisfied.

The `pressure` fixture intentionally keeps `soBuoiTrong2 = 1` because both
edge lessons are fixed. A result with `targetReached: false` there is expected:
`floorReached: true` demonstrates lower-bound reporting and is not a solver
failure.
