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
hosts, creates a fresh temporary directory per job, uploads only 720p proxies,
and retries callbacks three times. Render should use `/ready` as its HTTP health
check and allow up to 300 seconds for graceful shutdown.

## Secrets and wiring

Generate three independent random values:

1. `analysis_service_token` authenticates Sites → worker and worker → Sites.
2. `analysis_signing_secret` signs short-lived source/proxy URLs owned by Sites.
3. `beta_metrics_token` protects the owner-only beta funnel endpoint.
4. `beta_ops_token` protects the expired-video cleanup operation.

Set `SNOWTRACE_JOB_TOKEN` on the worker to `analysis_service_token`. The worker
automatically uses it for callbacks when `SNOWTRACE_CALLBACK_TOKEN` is unset.

After the worker is healthy, configure these five Sites runtime values and
publish the current saved version again:

- `ANALYSIS_SERVICE_URL=https://<worker-host>`
- `ANALYSIS_SERVICE_TOKEN=<analysis_service_token>`
- `ANALYSIS_SIGNING_SECRET=<analysis_signing_secret>`
- `BETA_METRICS_TOKEN=<beta_metrics_token>`
- `BETA_OPS_TOKEN=<beta_ops_token>`

Never put these secret values in `.env.example`, `render.yaml`, source control, a
deployment URL, or a beta issue log.

Schedule an owner-controlled daily `POST /api/ops/cleanup` request with
`Authorization: Bearer <beta_ops_token>`. Treat any nonzero `failures` response
as an operational incident and pause new uploads until the cleanup succeeds.
The route is bounded and idempotent, and session creation runs a small
best-effort cleanup as a backup; that backup does not replace the daily call.

## Smoke test

Before inviting riders:

1. Confirm `/ready` returns `200` and all three checks are `true`.
2. Upload a known short reference/rider pair through the production Site.
   Use different reference and rider stances once and confirm the worker request
   preserves both values independently.
   Also use different camera modes with the same declared view and confirm both
   modes remain independent. Confirm a mismatched-view pair is blocked before
   upload. Start the two clips on opposite edges, label each first complete turn,
   and confirm the worker receives both values independently.
3. Confirm the Site automatically moves from queued to one of four honest
   terminal states: rider selection, recapture, no reliable gap, or evidence.
4. For evidence, confirm every result declares `heelside` or `toeside`, both
   source clips seek to that same edge and phase, and the skeleton appears only
   while each player is near its evidence frame.
5. Delete the session and confirm it is no longer readable.
6. Run the retention operation against a deliberately expired test object and
   confirm both the source and proxy objects are absent afterward.

Do not expand to distributed workers until real beta timings show that one job
at a time cannot meet the eight-minute median target.
