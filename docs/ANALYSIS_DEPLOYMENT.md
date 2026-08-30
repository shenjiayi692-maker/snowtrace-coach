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

Generate two independent random values:

1. `analysis_service_token` authenticates Sites → worker and worker → Sites.
2. `analysis_signing_secret` signs short-lived source/proxy URLs owned by Sites.

Set `SNOWTRACE_JOB_TOKEN` on the worker to `analysis_service_token`. The worker
automatically uses it for callbacks when `SNOWTRACE_CALLBACK_TOKEN` is unset.

After the worker is healthy, configure these three Sites runtime values and
publish the current saved version again:

- `ANALYSIS_SERVICE_URL=https://<worker-host>`
- `ANALYSIS_SERVICE_TOKEN=<analysis_service_token>`
- `ANALYSIS_SIGNING_SECRET=<analysis_signing_secret>`

Never put either secret in `.env.example`, `render.yaml`, source control, a
deployment URL, or a beta issue log.

## Smoke test

Before inviting riders:

1. Confirm `/ready` returns `200` and all three checks are `true`.
2. Upload a known short reference/rider pair through the production Site.
3. Confirm the Site automatically moves from queued to one of four honest
   terminal states: rider selection, recapture, no reliable gap, or evidence.
4. For evidence, confirm Show Me seeks both source clips to the returned phase.
5. Delete the session and confirm it is no longer readable.

Do not expand to distributed workers until real beta timings show that one job
at a time cannot meet the eight-minute median target.
