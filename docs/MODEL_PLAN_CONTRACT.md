# TKBCherry Model-Plan Contract v1

`tkb-model-plan-v1` is the compatibility gate for moving model construction
from the VPS Python runtime into a Rust crate shared by native and WASM builds.
It is a verification contract only. It is not called by Play and does not
change scheduler objectives, deadlines, or candidate selection.

## Canonical artifacts

Each plan binds five artifacts:

1. Canonical request JSON.
2. Solver model bytes and search-parameter bytes.
3. Existing model wire digest used to fence stale solver responses.
4. A canonical variable map with one contiguous entry per model variable.
5. Canonical result JSON plus a hard-valid quality envelope.

Canonical JSON uses UTF-8, sorted object keys, no insignificant whitespace, and
rejects NaN or infinity. The plan itself uses digest protocol
`tkb-model-plan-sha256-v1`. Any schema change requires a new protocol version;
adding an unversioned field is test failure.

The JSON Schema is
`solver_runtime/contracts/tkb-model-plan-v1.schema.json`. Python validation and
digest helpers are in `tkb_optimizer_ref.model_plan`. Rust and Browser ports
must implement the same canonical bytes and field semantics before a local
builder can replace the server-built stream.

## Golden fixtures

`small-cp-sat-v1` commits the complete synthetic request, CP-SAT model,
parameters, variable map, and result. Its test decodes and solves the model,
checks every digest, and requires the exact solution vector.

`automatic-refinement-1566-v1` freezes the current acceptance request, first
quality CP-SAT model, parameter bytes, expanded variable-map fingerprint,
model statistics, accepted result fingerprint, and quality envelope. Raw
production-derived artifacts remain under `.codex_tmp` and are not committed
because they contain school data. The committed plan contains only hashes,
sizes, aggregate model counts, and aggregate timetable quality.

The 1,566-period quality gate requires:

- `1566/1566` periods, hard-valid, zero application violations.
- Zero unassigned periods, one-period teacher sessions, and Gap2 sessions.
- At most 488 teacher sessions and Gap1 50.

The recorded Agent result is 482 teacher sessions and Gap1 50. The envelope
uses the same-seed backend parity ceiling rather than requiring bit-identical
multi-worker CP-SAT output.

## Verification

Run committed fixture tests:

```powershell
python -m unittest solver_runtime.tests.test_model_plan_contract
node --test e2e_tests/model_plan_contract_node.test.js
```

When the private acceptance capture is present, verify it directly:

```powershell
python solver_runtime/scripts/verify_model_plan_golden.py `
  --plan solver_runtime/fixtures/model_plan_v1/automatic-1566.plan.json `
  --request .codex_tmp/parity-1566-normalized-request.json `
  --model-wrapper .codex_tmp/model-plan-1566-step0-wrapper.json `
  --result .codex_tmp/parity-1566-agent-result.json
```

Migration phases must land behind a per-phase feature flag. A Rust/WASM builder
may replace one Python phase only after its expanded model plan matches the
golden schema and fingerprints, its candidate passes authoritative validation,
and its ordered quality stays inside the envelope.
