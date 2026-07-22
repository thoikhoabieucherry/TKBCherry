# Operator Linux trusted worker

This directory installs one additional, operator-controlled Linux solver node.
It is not the normal Windows Agent and must never be distributed to schools.
The worker can receive timetable payloads from any tenant, so the host must be
managed to the same security standard as the production VPS.

The trusted worker is spillover capacity, not a parallel attempt. It can take
only a canonical job that is still queued for the VPS. It never interrupts a
running VPS child, never steals a fresh job offered to its owner's paired
Agent, and the server still validates the result before publishing it.

## Host requirements

- A separate Ubuntu 22.04/24.04 x86-64 node controlled by the operator.
- Python 3.11 or newer with `venv`, at least 4 logical CPUs and preferably
  8-16 GB RAM.
- Outbound DNS and HTTPS to `tkbcherry.com`; no inbound Agent port is needed.
- Current security updates, restricted SSH access and encrypted storage where
  the hosting platform supports it.

Do not install this service on the existing application VPS merely to increase
the worker count. It would consume the same CPU/RAM outside the VPS scheduler's
token pool and can reduce capacity instead of adding it.

## Install without a bearer

Transfer or privately clone a reviewed repository snapshot onto the new node,
then run from its repository root:

```bash
sudo bash tools/trusted-worker/install-linux.sh --no-start
```

The installer copies only the Python Agent modules and solver runtime into a
root-owned release under `/opt/tkbcherry-trusted-worker`, creates an isolated
virtual environment, and installs a hardened `systemd` service. It never reads
or accepts a bearer on its command line.

Review `/etc/tkbcherry/trusted-worker.json` before starting. The shipped values
allow at most six solver workers and one timetable job at a time. Lower
`cpu_workers` or `max_memory_mb` for a smaller machine. The systemd unit also
contains a 16 GB cgroup ceiling and can be overridden with a local drop-in.

## Create and activate the credential

On the worker, create a unique credential after the installer has created
`/etc/tkbcherry`:

```bash
sudo python3 tools/trusted-worker/create-credential.py
```

The command atomically writes the raw `tkbt_` bearer only to
`/etc/tkbcherry/trusted-worker.env` with mode `0600`. It does not print the
bearer. Save the single printed line beginning with
`TKB_TRUSTED_AGENT_TOKEN_SHA256=`; that domain-separated digest is the value the
API needs.

On the application VPS, put only that digest in a root-owned systemd drop-in:

```ini
# /etc/systemd/system/tkb-app.service.d/trusted-worker.conf
[Service]
Environment=TKB_TRUSTED_AGENT_TOKEN_SHA256=<64-hex-digest>
```

Reload and restart `tkb-app` through the normal drained deployment procedure so
an active scheduling job is not interrupted. Trusted-worker mode stays fully
disabled when this environment value is absent or malformed.

Finally, on the additional node:

```bash
sudo systemctl enable --now tkb-trusted-worker.service
sudo systemctl status tkb-trusted-worker.service
sudo journalctl -u tkb-trusted-worker.service -n 50 --no-pager
```

The service must settle in `active (running)`. HTTP 401/403 means the server
digest and worker credential do not match. A version error means the worker
source and deployed API contract are from different releases.
Before every service start, `ExecStartPre` runs the Agent's `--check` path. It
must authenticate `/hello` and complete a real local solver protocol probe, so
an invalid digest or broken OR-Tools environment cannot appear healthy.

## Acceptance before production traffic

1. Keep the normal VPS pool occupied with controlled test jobs.
2. Submit one more test schedule and verify exactly one queued job changes to
   Agent execution on the trusted node.
3. Verify a second tenant cannot see the worker in its browser Agent status.
4. Stop the trusted service during a leased test and verify the same canonical
   job returns to the VPS after lease expiry.
5. Confirm a job already running on the VPS is never interrupted or duplicated.
6. Confirm the published timetable passes server validation and no raw token or
   timetable payload appears in either journal.

Do not enable the digest in production until all six checks pass.

## Rotation and removal

Stop the worker before rotating its only trusted credential. Remove the old
environment file explicitly, run `create-credential.py` again, replace the
digest on the VPS, restart the API through its drained procedure, and then
start the worker. The API currently accepts one trusted digest, so rotating it
revokes the prior worker immediately.

To remove the node:

```bash
sudo systemctl disable --now tkb-trusted-worker.service
sudo rm -f /etc/systemd/system/tkb-trusted-worker.service
sudo systemctl daemon-reload
```

Also remove the digest drop-in from the VPS and restart `tkb-app` safely. Delete
the credential and worker state only after confirming no lease is active.
