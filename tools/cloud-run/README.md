# TKB Cherry solver on Google Cloud Run

This directory deploys the existing Python/OR-Tools solver as a **private**
Cloud Run service. The browser still submits and polls jobs through the TKB
Cherry API. Only the server-side dispatcher is allowed to call Cloud Run.

The deployment does not change the VPS solver algorithm. It builds the image in
Google Cloud Build, so Docker is not required on the deployment workstation.
The upload is assembled from an explicit allowlist containing only the solver
requirements, `solve_stdio.py`, the Cloud Run wrapper and solver source files;
the repository, school workbooks, databases, tests and credentials are not sent
to Cloud Build.

## Before deployment

You need:

- a Google Cloud project with an active billing account;
- permission to enable APIs, run Cloud Build, deploy Cloud Run, create an
  Artifact Registry repository, and edit the Cloud Run invoker policy;
- the [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) installed;
- optionally, the email address of a dedicated service account used by the VPS
  dispatcher.

Sign in directly in the Google Cloud CLI on the deployment workstation:

```powershell
gcloud auth login
```

Choose or create the project and link billing in
[Google Cloud Console](https://console.cloud.google.com/billing). Billing is a
financial/account action and is deliberately not automated by this repository.
The deployment script verifies that billing is enabled before it enables APIs
or creates resources.

Do not paste a password, OAuth token, service-account JSON, browser cookie, or
bearer token into chat, a command argument, this repository, or a build log.

## Deploy

From the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File tools\cloud-run\deploy.ps1 `
  -ProjectId YOUR_PROJECT_ID `
  -InvokerServiceAccount tkb-cloud-run-invoker@YOUR_PROJECT_ID.iam.gserviceaccount.com `
  -RuntimeServiceAccount tkb-cloud-run-runtime@YOUR_PROJECT_ID.iam.gserviceaccount.com `
  -ConfirmDeployment
```

Defaults:

- region: `asia-southeast2`;
- service: `tkb-solver`;
- Artifact Registry repository: `tkb-cloud-run`;
- compute per instance: 6 vCPU and 4 GiB;
- request concurrency: 1;
- Cloud Run request timeout: 300 seconds;
- solver subprocess ceiling inside the container: 285 seconds;
- automatic UI solver budget: 270 seconds, leaving 15 seconds for canonical
  validation, framing, and response serialization before the subprocess guard;
- minimum instances: 0;
- maximum instances: 3 (configurable from 1 through 50 after quota allows it).

The service is always deployed with `--no-allow-unauthenticated`. If
`-InvokerServiceAccount` is supplied, the script grants only
`roles/run.invoker` to that identity. The parameter is an account email, never
a key or token. The deployment also applies `app=tkb-cherry`,
`component=solver`, and `runtime=cloud-run` resource labels for billing reports.
Each release is created with `--no-traffic` and a temporary canary tag. The
script verifies the exact Ready revision, its solver digest and 285-second
ceiling, then calls the tagged `/health` and `/solve` endpoints with a
short-lived identity token kept only in PowerShell memory. The synthetic
two-period solve must be complete, hard-valid, zero-unassigned, singleton-free,
Gap2-free, and carry matching revision/digest provenance. Only that verified
revision is promoted to 100% traffic. Any failure restores the captured
previous revision traffic before the command exits.
Use a separate `-RuntimeServiceAccount` with no project roles for the identity
inside the solver container. Cloud Build permissions belong to its build
identity and must never be inherited by the runtime container.

The script prints the non-secret service URL at the end. Use the same URL as
both `TKB_CLOUD_RUN_URL` and `TKB_CLOUD_RUN_AUDIENCE` in the VPS service
environment. It also prints `TKB_CLOUD_RUN_SOLVER_DIGEST`. Store that digest in
the selected application Cloud profile: every request and terminal result is
pinned to it, so a stale or unintended image is rejected before its timetable
can be accepted.

## Give the VPS an Application Default Credentials identity

The dispatcher uses Google Application Default Credentials (ADC) to mint an ID
token for the private service. The audience is forced to equal the configured
service URL; the application does not accept an independent audience. Pick one
of these approaches:

1. **VPS running on Google Compute Engine:** attach the dedicated invoker
   service account to the VM and grant it `roles/run.invoker` on this Cloud Run
   service. ADC obtains short-lived credentials from the metadata server; no
   credential file is needed.
2. **VPS outside Google Cloud (preferred):** configure
   [Workload Identity Federation](https://cloud.google.com/iam/docs/workload-identity-federation)
   for the VPS's trusted workload identity and impersonate the dedicated
   invoker service account. Put the generated ADC configuration outside the
   repository, restrict its file permissions, and point
   `GOOGLE_APPLICATION_CREDENTIALS` to it from the system service environment.
   Workload Identity Federation avoids a long-lived Google private key.
   This deployment uses an X.509 provider restricted to the exact subject
   `tkb-cherry-vps`; the certificate key and external-account ADC file stay in
   `/root/.config/tkb-cherry/wif` with mode `0600`. The VPS systemd drop-in sets
   `GOOGLE_APPLICATION_CREDENTIALS` and `TKB_CLOUD_RUN_SERVICE_ACCOUNT`.
3. **Temporary compatibility option:** if federation cannot yet be configured
   and organization policy explicitly permits keys,
   use a dedicated least-privilege service-account key. Transfer it directly to
   a root-owned directory on the VPS, set permissions to `0600`, set
   `GOOGLE_APPLICATION_CREDENTIALS` to that path, and rotate/delete the key as
   soon as federation is ready. Never send the file through chat, commit it, or
   place it below the application directory.

The Cloud Run invoker identity does not need owner, editor, billing, Cloud
Build, or Artifact Registry permissions. It needs only `roles/run.invoker` on
the deployed service.

## Billing and capacity safeguards

Cloud Run billing and the Google Cloud promotional credit are controlled by the
Google billing account, not by this script. The application does not enforce a
separate monetary ceiling. Configure any optional alerts directly in Google
Cloud Billing; application routing continues to use Cloud Run whenever the
selected profile is available.

## Super Admin Google usage synchronization

The coordinator shows two separate data sources only in the Super Admin portal:

* Cloud Monitoring supplies request count, 5xx rate, p95 latency, CPU/RAM
  utilization, instance count, and billable instance time. Monitoring usually
  trails by one to three minutes, so it is described as **near real-time**.
* An optional BigQuery Billing Export reconciliation reports gross Cloud Run
  cost, credits, promotion credits, currency, and net cost. Billing Export is
  the sole public source of monetary cost. It is not real-time and can lag for
  hours (or a day).

The sync is deliberately outside the solve request. Install the one-shot
service and one-minute timer on the VPS after granting the read-only IAM roles:

```bash
install -m 0600 tools/cloud-run/google-cloud-usage.env.example \
  /etc/tkb-google-cloud-usage.env
# Edit only public project/region/service/table identifiers.
bash tools/cloud-run/install-google-cloud-usage-sync.sh
```

The existing keyless ADC/invoker identity may be reused for a small deployment,
or a dedicated monitor service account may be used instead. It needs only:

```text
roles/monitoring.viewer   (project)
roles/run.viewer          (project, to read service capacity)
roles/bigquery.jobUser    (billing query project, only when Billing Export is enabled)
roles/bigquery.dataViewer (the Billing Export dataset, only when enabled)
```

Do not grant Owner/Editor and do not put a service-account key, password, OAuth
token, or cookie in `/etc/tkb-google-cloud-usage.env`. The helper uses ADC and,
when `TKB_GOOGLE_CLOUD_MONITOR_SERVICE_ACCOUNT` is set, short-lived service
account impersonation. It writes an atomic, mode-0600 snapshot at
`/opt/cherry-scheduler/data/google-cloud-usage.json`; the Rust API exposes that
snapshot only on the authenticated Super Admin `/api/admin/solver-usage` and
`/api/admin/solver-infrastructure` responses. School administrators cannot call
these infrastructure endpoints and receive no Google billing data.

The Billing Export table must be supplied as a fully-qualified identifier such
as `PROJECT.DATASET.gcp_billing_export_v1_ACCOUNT`. Set
`TKB_GOOGLE_BILLING_START_DATE` to the first date whose Google charges should
be included. No application-side budget or remaining-credit estimate is used.

The default maximum of 3 instances fits the initial 20-vCPU regional quota at
6 vCPU per instance and limits cost growth. Increase it only after Google
approves a regional CPU quota increase and after measuring solve duration,
memory, and spend. Concurrency remains 1 because each CP-SAT solve is CPU
intensive.

## Verify without exposing credentials

After the application dispatcher is configured, verify through its normal
authenticated job API and compare the returned timetable with the unchanged VPS
reference. Do not make the Cloud Run service public for a browser test. A valid
acceptance run must be complete, pass hard validation, have zero one-period
sessions, and have Gap2 equal to zero.

Local static/transport tests:

```powershell
python -m unittest `
  solver_runtime.tests.test_cloud_run_transport `
  solver_runtime.tests.test_cloud_run_deploy_assets
```

To validate the exact minimal upload and print its deterministic digest without
accessing a Google project:

```powershell
powershell -ExecutionPolicy Bypass -File tools\cloud-run\deploy.ps1 `
  -ProjectId tkb-test-project-123 -ConfirmDeployment -ValidateBuildContext
```
