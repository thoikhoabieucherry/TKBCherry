# TKB Agent Helper REST protocol v1

This document is the integration contract between an outbound-only Agent Helper and the TKBCherry VPS. The base URL is:

```text
https://tkbcherry.com/api/agent-helper/v1
```

Every request uses `Content-Type: application/json`, `Accept: application/json`, and protocol value `tkb-agent-helper-v1`. Authentication depends on the route:

- `/pair/start` and `/pair/status` are device-pairing routes and do not use an `Authorization` header. The unguessable `deviceCode` is the capability required by `/pair/status`.
- `/pair/approve` requires a normal, live browser-session bearer. An Agent credential cannot approve another Agent.
- `/hello`, `/heartbeat`, `/lease`, and every `/leases/{leaseId}/...` route require `Authorization: Bearer <agent credential>` and `X-TKB-Agent-Id: <UUID>`. An operator trusted worker uses its separate `tkbt_` bearer on only these same work routes, as described below.

TLS certificate verification is mandatory. The Agent's pairing and authenticated HTTP clients reject redirects. In particular, an Authorization header or `deviceCode` must never be forwarded to a different origin.

The public Windows distribution is `TKBCherryAgent-Windows.zip`. Its archive root contains exactly one entry, `TKBCherryAgent.exe`; the user extracts that file before running it. A separate `TKBCherryAgent-Windows-onedir.zip` may be produced for internal diagnostics, but it is not the public download.

## Operator trusted-worker mode

Normal browser-paired Agents are always owner scoped and can lease only work
belonging to the school/account that approved the pairing. They must never be
used as shared capacity for other tenants.

An operator-managed machine may instead authenticate with a high-entropy token
whose domain-separated SHA-256 digest is configured on the API process as
`TKB_TRUSTED_AGENT_TOKEN_SHA256`. The raw token uses the `tkbt_` prefix, is
stored only on that worker (for example in a protected service environment),
and is never placed in the repository, browser, release package, or VPS
configuration as plaintext. Without the server-side digest, trusted-worker mode
is disabled.

A trusted worker uses this same REST protocol, but it can lease the oldest
canonical Agent task across owners. It remains a replacement executor rather
than an additional attempt: one job runs on either that worker or the VPS, not
both. An authenticated free lease poll may drain one VPS-queued job; trusted
workers do not race fresh direct starts and do not interrupt a VPS child that
is already running. Lease expiry or worker loss
returns the canonical job to the VPS under the existing generation fence.

The server does not include trusted workers in any school's `/status` count.
It validates every submitted candidate against the original request and remains
the only component allowed to publish the final result. This mode is intended
only for infrastructure controlled by the service operator because the solver
payload necessarily contains timetable data; distributing a trusted token to a
normal user's workstation would break tenant confidentiality.

## `GET /status` (browser only)

The Windows Agent button polls this owner-scoped route with the normal browser-session bearer. It returns only whether a live worker is connected; Agent IDs and credentials are never exposed:

```json
{
  "protocol": "tkb-agent-helper-v1",
  "ok": true,
  "online": true,
  "agentCount": 1,
  "checkedAtMs": 1784030700000,
  "staleAfterMs": 90000
}
```

Mobile, tablet and non-Windows clients do not show the Agent control or installation invitation.

The server provisions a limited Agent credential only after browser-approved device pairing. The credential is delivered over HTTPS in the `/pair/status` response to the client holding the full `deviceCode`; it is never embedded in the release ZIP or executable and never appears in a URL, config file, or log message. The Windows Agent persists it with current-user DPAPI. `/hello` returns a separate opaque `workerToken` bound to that bearer session; this short-lived token remains only in process memory.

## `POST /pair/start`

Starts first-run pairing without authentication. The Agent sends its stable anonymous ID and display metadata:

```json
{
  "protocol": "tkb-agent-helper-v1",
  "agent": {
    "agentId": "123e4567-e89b-12d3-a456-426614174000",
    "name": "Windows PC",
    "version": "1.3.0",
    "platform": "windows-amd64"
  }
}
```

Success is HTTP `200`, `201`, or `202`:

```json
{
  "protocol": "tkb-agent-helper-v1",
  "ok": true,
  "status": "pending",
  "deviceCode": "tkbp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "userCode": "ABCD-2345",
  "agentId": "123e4567-e89b-12d3-a456-426614174000",
  "agentName": "Windows PC",
  "verificationUrl": "/pages/sapxep?agentPair=ABCD-2345",
  "expiresAtMs": 1784030700000,
  "pollEveryMs": 1500
}
```

The pairing expires after five minutes. `verificationUrl` must resolve to the same HTTPS origin as `api_base` and must carry the user code in the `agentPair=XXXX-XXXX` query parameter. The Agent opens this URL in the user's browser and never places `deviceCode` in it.

## `POST /pair/approve`

Approves the displayed code once. This request comes from the TKBCherry page and requires its normal browser-session bearer, never an Agent bearer:

```json
{
  "protocol": "tkb-agent-helper-v1",
  "userCode": "ABCD-2345"
}
```

Success is HTTP `200`:

```json
{
  "protocol": "tkb-agent-helper-v1",
  "ok": true,
  "status": "approved",
  "agentId": "123e4567-e89b-12d3-a456-426614174000",
  "agentName": "Windows PC",
  "expiresAtMs": 1784030700000
}
```

The approval response deliberately omits `agentToken`. Approval binds the pairing and minted Agent credential to the browser session's owner/school. A user code can be approved only once; a repeat or cross-owner approval returns HTTP `409` without revealing the owner.

## `POST /pair/status`

The Agent polls this unauthenticated route at `pollEveryMs`, proving possession of the long random `deviceCode`:

```json
{
  "protocol": "tkb-agent-helper-v1",
  "deviceCode": "tkbp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

While waiting, HTTP `200` returns:

```json
{
  "protocol": "tkb-agent-helper-v1",
  "ok": true,
  "status": "pending",
  "expiresAtMs": 1784030700000,
  "retryAfterMs": 1500
}
```

After approval, HTTP `200` returns the limited credential only to the device-code holder:

```json
{
  "protocol": "tkb-agent-helper-v1",
  "ok": true,
  "status": "approved",
  "agentToken": "tkba_opaque-agent-only-credential",
  "agentTokenExpiresAt": 1791800000,
  "expiresAtMs": 1784030700000
}
```

Repeating `/pair/status` with the same `deviceCode` may return the same approved response until the five-minute pairing expires so a lost transport response is recoverable; it never mints a second credential. The Agent then protects `agentToken` with current-user Windows DPAPI and does not retain `deviceCode`. Invalid, unknown, or expired codes return `400`, `404`, or `410` as appropriate.

## Common rules

- Unless a field is documented more strictly, IDs contain 1–128 ASCII letters, digits, `.`, `_`, `:`, or `-`; the first character is alphanumeric. `agentId` is at most 80 bytes and does not allow `:`; `leaseRequestId` is 8–128 characters.
- ISO timestamps use UTC (`2026-07-14T12:00:00Z`). Fields ending in `AtMs` are Unix epoch milliseconds; `agentTokenExpiresAt` is Unix epoch seconds.
- HTTP `401`/`403` on Agent work routes means the Agent credential is invalid or outside its allowed tenant/school. On `/pair/approve`, it means the normal browser session is missing, expired, or unauthorized.
- HTTP `409` means the lease or operation is no longer current. HTTP `410` means it has expired permanently.
- HTTP `408`, `425`, `429`, and `5xx` are retryable with bounded exponential backoff.
- Candidate, complete, and fail requests carry deterministic `Idempotency-Key` headers. A server must return the original semantic response when a key is replayed with the same body, and reject reuse with a different body.
- Every non-204 success response must be a non-empty object containing `"protocol":"tkb-agent-helper-v1"` and `"ok":true`.
- No endpoint may require an inbound connection to the Agent.
- The server must enforce tenant/owner isolation using the browser or Agent bearer as appropriate; it must never trust an `agentId`, `jobId`, `leaseId`, or short `userCode` by itself.

## `POST /hello`

Registers or refreshes Agent metadata. Repeating this call is safe.

```json
{
  "protocol": "tkb-agent-helper-v1",
  "agent": {
    "agentId": "123e4567-e89b-12d3-a456-426614174000",
    "version": "1.3.0",
    "platform": "windows-amd64"
  },
  "capacity": {
    "cpuWorkers": 4,
    "maxConcurrentJobs": 1
  }
}
```

Success is `200`, `201`, or `202` and must return a new session-bound worker token:

```json
{
  "protocol": "tkb-agent-helper-v1",
  "ok": true,
  "workerToken": "opaque-random-worker-token",
  "heartbeatEveryMs": 10000,
  "workerExpiresAtMs": 1784026890000,
  "leaseMs": 30000
}
```

Registering the same Agent again invalidates the previous `workerToken` and safely requeues its unfinished leases.

## `POST /heartbeat`

Refreshes an idle Agent independently of any lease.

```json
{
  "protocol": "tkb-agent-helper-v1",
  "agentId": "123e4567-e89b-12d3-a456-426614174000",
  "workerToken": "opaque-random-worker-token",
  "status": "idle",
  "capacity": {
    "cpuWorkers": 4,
    "maxConcurrentJobs": 1
  }
}
```

Success is `200`, `202`, or `204`.

## `POST /lease`

Long-polls for one job. The server should keep the request open until work is available or `waitSeconds` elapses, so clicking **Xếp** can dispatch immediately without a visible polling pause.

```json
{
  "protocol": "tkb-agent-helper-v1",
  "workerToken": "opaque-random-worker-token",
  "leaseRequestId": "be672948-35a1-4619-a133-6548a61bb834",
  "agent": {
    "agentId": "123e4567-e89b-12d3-a456-426614174000",
    "version": "1.3.0",
    "platform": "windows-amd64"
  },
  "capacity": {
    "cpuWorkers": 4,
    "maxConcurrentJobs": 1
  },
  "waitSeconds": 20
}
```

The Agent generates `leaseRequestId` once per logical long-poll and derives the `Idempotency-Key` header from it. The complete request body, `leaseRequestId`, and header remain unchanged across transport retries. The server must return the already-issued active lease for a replay instead of assigning a second lease or returning worker-at-capacity. A new ID is generated only after the prior logical poll has produced a definitive lease or no-work response.

No work is either HTTP `204` with an empty body or HTTP `200`:

```json
{
  "protocol": "tkb-agent-helper-v1",
  "ok": true,
  "lease": null
}
```

A leased job is HTTP `200`:

```json
{
  "protocol": "tkb-agent-helper-v1",
  "ok": true,
  "lease": {
    "jobId": "job-20260714-001",
    "leaseId": "lease-7c2c",
    "attempt": 1,
    "leaseExpiresAt": "2026-07-14T12:00:30Z",
    "payload": {
      "data": {},
      "settings": {
        "overall_time_limit_seconds": 180,
        "reference_solver_budget_ms": 180000,
        "reference_watchdog_deadline_ms": 185000,
        "reference_deadline_reserve_ms": 5000
      }
    },
    "limits": {
      "cpuWorkers": 4,
      "timeoutSeconds": 185
    }
  }
}
```

`payload.data` and `payload.settings` must be objects. The Agent forwards the normalized payload and overwrites `settings.num_workers` with the full CPU capacity permitted by the lease and local physical-CPU configuration; stale lower request values and workload size do not reduce it. The configured physical RAM remains permission only rather than reserved memory, and every Windows or WSL solver job receives that full permitted ceiling. BLAS/OpenMP stay single-threaded so CP-SAT owns the declared parallelism without nested oversubscription. The Agent also honors the smaller of `limits.timeoutSeconds`, its local timeout, and a positive `settings.reference_watchdog_deadline_ms`.

## `POST /leases/{leaseId}/heartbeat`

Renews a running lease. The first heartbeat is sent immediately after process creation, then at the configured interval. Heartbeats continue through candidate upload and completion; `phase` is `solving`, `uploading`, or `committing`.

```json
{
  "protocol": "tkb-agent-helper-v1",
  "agentId": "123e4567-e89b-12d3-a456-426614174000",
  "workerToken": "opaque-random-worker-token",
  "jobId": "job-20260714-001",
  "leaseId": "lease-7c2c",
  "phase": "solving",
  "progress": {
    "elapsedSeconds": 12.4,
    "remainingSeconds": 172.6
  }
}
```

Continue response:

```json
{
  "protocol": "tkb-agent-helper-v1",
  "ok": true,
  "cancel": false,
  "leaseExpiresAt": "2026-07-14T12:01:00Z"
}
```

Cancellation may be `"cancel": true` or `"action": "cancel"`. The Agent then terminates the solver process tree and reports a sanitized failure. Missing/expired leases should return `409` or `410`.

## `POST /leases/{leaseId}/candidate`

Uploads a valid solver wrapper's payload. Accepted structured solver outcomes are `2xx`, `409`, `422`, and `500`; these are completed as semantic solver results and must not be repeatedly requeued merely because they are non-`2xx`. Infrastructure, subprocess, and stdio failures use `/fail` instead.

```json
{
  "protocol": "tkb-agent-helper-v1",
  "agentId": "123e4567-e89b-12d3-a456-426614174000",
  "workerToken": "opaque-random-worker-token",
  "jobId": "job-20260714-001",
  "leaseId": "lease-7c2c",
  "sha256": "64-lowercase-hex-characters",
  "digestProtocol": "tkb-json-tree-sha256-v1",
  "solverProtocol": "tkb-reference-solver-stdio-v1",
  "solverStatus": 200,
  "result": {}
}
```

`sha256` uses `tkb-json-tree-sha256-v1`, avoiding language-specific JSON float formatting. Start SHA-256 with ASCII `tkb-json-tree-sha256-v1` plus NUL, then recursively append typed values: `N`, `T`, `F`; strings as `S` + unsigned 64-bit big-endian UTF-8 byte length + bytes; integers as `I` + length + ASCII decimal; finite floats as `D` + IEEE-754 binary64 big-endian; arrays as `L` + item count + items; objects as `O` + member count + string-key/value pairs sorted by key. The server must use the same tree algorithm and return its accepted `sha256`. Success is `200`, `201`, or `202`:

Cross-language test vector: `{"a":1,"b":[1e-7,-0.0],"c":"đ"}` hashes to `08ff413feef63ffe43b690d4bccb07ce3dbf6cff38d312c9cfc32ed82a464a31`.

```json
{
  "protocol": "tkb-agent-helper-v1",
  "ok": true,
  "candidateId": "candidate-f5e9",
  "sha256": "64-lowercase-hex-characters"
}
```

The request's idempotency material is operation + agent ID + job ID + lease ID + digest + solver status.

## `POST /leases/{leaseId}/complete`

Acknowledges that the accepted candidate was uploaded successfully. This endpoint does not publish or finish the canonical VPS job; the VPS compares the validated Agent candidate with its own candidate and remains the only owner of the final result.

```json
{
  "protocol": "tkb-agent-helper-v1",
  "agentId": "123e4567-e89b-12d3-a456-426614174000",
  "workerToken": "opaque-random-worker-token",
  "jobId": "job-20260714-001",
  "leaseId": "lease-7c2c",
  "candidateId": "candidate-f5e9",
  "sha256": "64-lowercase-hex-characters",
  "solverStatus": 200
}
```

Success is `200`, `202`, or `204`. Completion must be transactional: every browser should observe the server job move to its terminal state without depending on the originating tab.

## `POST /leases/{leaseId}/fail`

Reports an Agent/transport/subprocess failure without timetable data, stdout, stderr, environment values, or secrets.

```json
{
  "protocol": "tkb-agent-helper-v1",
  "agentId": "123e4567-e89b-12d3-a456-426614174000",
  "workerToken": "opaque-random-worker-token",
  "jobId": "job-20260714-001",
  "leaseId": "lease-7c2c",
  "failure": {
    "kind": "solver_timeout",
    "message": "Solver exceeded its allowed runtime"
  }
}
```

Success is `200`, `202`, or `204`; `409`/`410` are also terminal acknowledgements because the lease has already moved on. The server may requeue according to attempt limits.

## Solver stdio boundary

The child command in source mode is:

```text
python <repository>/solver_runtime/scripts/solve_stdio.py solve
```

with cwd `<repository>/solver_runtime`. stdin is one complete UTF-8 JSON document followed by EOF—not JSONL. stdout must contain exactly one UTF-8 JSON line:

```json
{"protocol":"tkb-reference-solver-stdio-v1","status":200,"payload":{}}
```

`status` is authoritative; the process normally exits `0` for structured `400`, `409`, `422`, and `500` results. Native/log output belongs on stderr. Agent Helper sends stdout and stderr to bounded temporary files to avoid pipe deadlock or unbounded RAM use. On Windows, a Job Object with `KILL_ON_JOB_CLOSE` terminates descendants during cancellation, timeout, or Agent shutdown.
