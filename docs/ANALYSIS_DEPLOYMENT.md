# Analysis worker deployment

The Sites web application and the CPU video-analysis worker deploy separately.
The web app owns private video storage and durable job state; the worker receives
only short-lived signed media URLs and returns a quality-gated callback.

## Recommended beta shape

Use the root `render.yaml` Blueprint to create one Docker web service with 1 CPU
and 2 GB RAM in Ohio. It intentionally runs one instance and one concurrent
MediaPipe job. This is enough to validate a 20-rider concierge beta without
introducing Redis, Celery, Kubernetes, or a custom queue.

The worker exposes:

- `GET /health` for process liveness and pipeline identity;
- `GET /ready` for the pose model, FFmpeg, and ffprobe readiness;
- `POST /v1/jobs` for authenticated asynchronous pair analysis.

The service limits active work and source bytes, validates source and callback
hosts, refuses cross-host source redirects, applies the media-host allowlist to
proxy uploads, creates a fresh temporary directory per job, uploads only 720p
proxies, and retries callbacks three times. Both `/v1/jobs` and the synchronous
diagnostic `/v1/analyze-pair` require the service bearer token. Render should
use `/ready` as its HTTP health check and allow up to 300 seconds for graceful
shutdown.

If a dispatched run has no callback for 12 minutes, the Site exposes an
explicit retry state. Retrying sends the same analysis ID: a still-running
worker reuses it, while a restarted worker can safely reconstruct the job from
fresh signed URLs. This avoids an infinite queued screen without adding Redis
or a second queue in the beta.

## Secrets and wiring

Generate five independent random values:

1. `analysis_service_token` authenticates Sites → worker and worker → Sites.
2. `analysis_signing_secret` signs short-lived source/proxy URLs owned by Sites.
3. `beta_metrics_token` protects the owner-only beta funnel endpoint.
4. `beta_ops_token` protects the expired-video cleanup operation.
5. `beta_access_code` is the shared, human-entered code for the invited
   20-rider cohort. Use at least 24 random letters, digits, underscores, or
   hyphens; do not reuse an account password.

Set `SNOWTRACE_JOB_TOKEN` on the worker to `analysis_service_token`. The worker
automatically uses it for callbacks when `SNOWTRACE_CALLBACK_TOKEN` is unset.

After the worker is healthy, configure these six Sites runtime values and
publish the current saved version again:

- `ANALYSIS_SERVICE_URL=https://<worker-host>`
- `ANALYSIS_SERVICE_TOKEN=<analysis_service_token>`
- `ANALYSIS_SIGNING_SECRET=<analysis_signing_secret>`
- `BETA_METRICS_TOKEN=<beta_metrics_token>`
- `BETA_OPS_TOKEN=<beta_ops_token>`
- `BETA_ACCESS_CODE=<beta_access_code>`

Never put these secret values in `.env.example`, `render.yaml`, source control, a
deployment URL, or a beta issue log.

Schedule an owner-controlled daily `POST /api/ops/cleanup` request with
`Authorization: Bearer <beta_ops_token>`. Treat any nonzero `failures` response
as an operational incident and pause new uploads until the cleanup succeeds.
The route is bounded and idempotent, and session creation runs a small
best-effort cleanup as a backup; that backup does not replace the daily call.

## Authorization and release boundary

Publishing the web source does not enable paid analysis. Creating the private
GitHub mirror, provisioning the Render service, or adding the three
`ANALYSIS_*` runtime values requires the owner's separate explicit approval.
Until then, `/api/system-status` must keep returning
`"analysisAvailable": false`, uploads must remain disabled, and no paid service
should exist.

Before that approval, the source-only release gate is:

```bash
.venv/bin/python -m unittest discover -s analysis/tests -v
npm run lint
npm run typecheck
npm test
```

The Python dependency versions are intentionally fixed in `analysis/pyproject.toml`.
MediaPipe and the worker use one `opencv-contrib-python` distribution; do not add
another OpenCV wheel because both packages install the same `cv2` namespace.

## Zero-cost local concierge path

Use this path for the first five attended beta riders before paying for an
always-on service. It runs the same Python pipeline and security contract as
the hosted worker, but the operator's Mac supplies the CPU and must stay awake
and online while a job is running.

This is an HTTP worker, even though its job is background video processing. A
free tunnel forwards only the small authenticated job request to localhost;
the worker downloads the signed source videos and uploads proxies directly over
HTTPS. Never expose the virtual-environment development server on `0.0.0.0`.

1. Install the pinned Python package and verify the local release gate:

   ```bash
   python3.12 -m venv .venv
   .venv/bin/pip install -e analysis
   .venv/bin/python -m unittest discover -s analysis/tests -v
   ```

2. Put the generated `analysis_service_token` in the current shell only and
   start the loopback worker:

   ```bash
   export SNOWTRACE_JOB_TOKEN='<analysis_service_token>'
   ./scripts/run-local-analysis.sh
   ```

   Do not add the token to a tracked `.env` file, shell script, command-line
   argument, issue, or log. The launcher binds to `127.0.0.1:8080`, restricts
   media and callback hosts to the production Site, allows one active job, and
   unsets the local-file testing override.

3. In a second terminal, verify localhost before creating a tunnel:

   ```bash
   curl --fail --silent --show-error http://127.0.0.1:8080/health
   curl --fail --silent --show-error http://127.0.0.1:8080/ready
   ```

   Both requests must return `200`; `/ready` must report the pose model,
   FFmpeg, and ffprobe as `true`.

4. Start one free HTTPS tunnel that forwards to `http://127.0.0.1:8080`.
   Prefer an account-bound ngrok development domain for the attended beta
   because it remains stable between restarts. A TryCloudflare Quick Tunnel is
   acceptable for a short smoke test only because its hostname changes and it
   has no availability commitment.

5. From outside localhost, repeat `/health` and `/ready`, then confirm a
   format-valid `POST /v1/jobs` without the bearer token returns `401`. Only
   after those checks pass, set the six Sites runtime values listed above and
   republish the reviewed Site version.

6. Keep the Mac awake until each accepted job has delivered its callback. If
   the worker, tunnel, or laptop stops mid-job, restore both processes and use
   the Site's retry action after the 12-minute watchdog appears. The repeated
   analysis ID makes that retry idempotent.

Stop this path and move to an unattended service when any of these becomes
true: riders submit without the operator present, a job waits because the Mac
is asleep, the tunnel quota interrupts a session, or five accepted riders have
completed the concierge checkpoint. Cloud Run with request-based billing is
the next cost-sensitive option; the fixed Render `1c-2g` service remains the
simpler predictable-capacity option.

Do not install a queue, Redis, Celery, Kubernetes, automatic tunnel restarter,
or multi-worker orchestration for this five-rider checkpoint.

## Paid deployment checklist

Run these steps only after the owner approves both the private source mirror and
the monthly Render service:

1. Push the reviewed commit to the approved private GitHub repository and create
   the Render Blueprint from the root `render.yaml`. Do not change the plan,
   region, instance count, health path, or allowlists during the beta.
2. In Render, set only `SNOWTRACE_JOB_TOKEN` to the generated
   `analysis_service_token`. Wait for the image build and `/ready` health check
   to pass. A Docker image build is a hard release gate; local tests are not a
   substitute when Docker is unavailable on the development machine.
3. Check the deployed worker without sending a video:

   ```bash
   curl --fail --silent --show-error https://<worker-host>/health
   curl --fail --silent --show-error https://<worker-host>/ready
   curl --silent --output /dev/null --write-out '%{http_code}\n' \
     --request POST https://<worker-host>/v1/jobs \
     --header 'content-type: application/json' \
     --data '{}'
   ```

   Both GET requests must return `200`; all `/ready` checks must be `true`. The
   unauthenticated POST must return `422` for the invalid body or `401` for a
   valid body, and must never accept a job. Keep the service URL private until
   this gate passes.
4. Add the six Sites runtime values listed above and republish the reviewed web
   version. Then verify:

   ```bash
   curl --fail --silent --show-error \
     https://snowtrace-coach.sjysjy.chatgpt.site/api/system-status
   ```

   It must return `"analysisAvailable": true` without revealing URLs or secret
   values. Complete the UI smoke test below with an owner-owned test pair before
   inviting any beta rider.

## Fast disable and rollback

If analysis is failing or returning unsafe evidence, stop new dispatches first:

1. Remove `ANALYSIS_SERVICE_URL`, `ANALYSIS_SERVICE_TOKEN`, and
   `ANALYSIS_SIGNING_SECRET` from the Sites runtime configuration, republish the
   current web version, and confirm `/api/system-status` returns
   `"analysisAvailable": false`. This keeps the public landing page reachable
   while disabling uploads and paid analysis.
2. Suspend the Render worker after dispatch is disabled. Do not delete D1, R2,
   or the service while investigating; beta sessions and evidence remain
   auditable and retention cleanup can still run.
3. If the current web source itself is broken, redeploy the last known-good
   saved Sites version. Database migrations are forward-only; never roll back by
   deleting tables or objects.
4. For a suspected secret leak, rotate the worker token and signing secret
   before re-enabling dispatch. Repeat the entire smoke test and independently
   inspect the first completed report.

## Smoke test

Before inviting riders:

1. Confirm `/ready` returns `200` and all three checks are `true`.
2. Upload a known short reference/rider pair through the production Site.
   Use different reference and rider stances once and confirm the worker request
   preserves each stance. Then use opposite screen travel directions and confirm
   the worker receives both declarations while signed metrics remain canonical.
   Also use different camera modes with the same declared view and confirm both
   modes remain independent. Confirm a mismatched-view pair is blocked before
   upload. Start the two clips on opposite edges, label each first complete turn,
   and confirm the worker receives both values independently.
   Include one rotated portrait phone clip and one variable-frame-rate clip;
   confirm the generated proxy is upright CFR 30, begins at zero, and differs
   from source content duration by no more than one frame.
3. Confirm the Site automatically moves from queued to one of four honest
   terminal states: rider selection, recapture, no reliable gap, or evidence.
   For the lost-callback drill, stop the worker after it accepts a test job,
   wait for the 12-minute watchdog, restart it, and confirm Retry redispatches
   the same analysis ID rather than creating a duplicate run.
4. For evidence, confirm every result declares `heelside` or `toeside`, both
   source clips seek to that same edge and phase, and the skeleton appears only
   while each player is near its evidence frame. Use one asymmetric turn and
   confirm its detected apex is the 50% normalization anchor; verify the shown
   pair is closest to the median accepted gap rather than whichever turn happens
   to be in the middle of the clip.
5. Repeat with one knee hidden for part of both clips. Confirm the dependent
   knee/differential metrics are absent, remaining visible metrics are still
   eligible, and a gap longer than 250 ms is not interpolated into evidence.
6. Delete the session and confirm it is no longer readable.
7. Run the retention operation against a deliberately expired test object and
   confirm both the source and proxy objects are absent afterward.

Do not expand to distributed workers until real beta timings show that one job
at a time cannot meet the eight-minute median target.
