# Snowtrace

Snowtrace is a confidence-first snowboard carving coach. A rider uploads one
reference clip and one clip of their own riding; the system checks whether the
footage is usable, aligns comparable turn phases, finds one meaningful movement
gap, and returns one evidence-backed drill.

This repository contains the first vertical slice, not a finished coaching
product. The web experience does not expose sample coaching: it checks worker
availability before upload and only shows evidence returned by the quality-gated
analysis service.

## Current scope

- Mobile-first web flow for goal, reference clip, rider clip, filming context,
  preliminary quality checks, processing, one-gap report, and Show Me evidence
- Browser-side inspection of duration, resolution, orientation, exposure, and
  image clarity before upload
- Real session creation, D1 persistence, streaming R2 uploads, upload-integrity
  checks, idempotent analysis queueing, automatic status refresh, device-local
  session recovery, ranged source playback, explicit beta consent, and source
  deletion
- Replaceable Python video-intelligence service using FFmpeg, OpenCV, and the
  official MediaPipe Pose Landmarker task model
- Multi-person pose tracking with an explicit rider-selection state when the
  main subject is ambiguous, including representative-frame boxes and a
  selected-track re-run
- Auto Trim quality scoring over the selected rider segment rather than clip
  setup time, while blur, camera stability, rider size, and usable turns remain
  independent gates; blocked blur or stability limits metric availability
- Turn segmentation, phase normalization, confidence-aware metric comparison,
  and strict evidence thresholds
- Evidence-frame pose snapshots rendered as synchronized skeleton overlays in
  the Show Me comparison; whole-video landmark streams are not sent to the web
- D1 schema for sessions, videos, tracks, turns, metrics, evidence, reports,
  drills, progression, and feedback; R2 binding reserved for source/proxy video
- Authenticated, idempotent retention cleanup for expired source and proxy
  objects, with an opportunistic bounded pass during session creation
- Durable upload timestamps and idempotent evidence-view events so beta funnel
  metrics remain correct after video expiry and do not count no-evidence runs
  as completed reports
- Anonymous, D1-backed visible-gap history that compares sessions only when the
  reference fingerprint, goal, camera context, metric, phase, and unit match;
  it is explicitly not presented as a riding score

The MVP is snowboard carving only. It does not claim force, pressure, exact
board edge angle, or physically accurate 3D measurements. It does not train a
custom vision model.

## Repository map

- `app/`: the Snowtrace web vertical slice
- `lib/analysis.ts`: shared browser-side analysis contracts and quality helpers
- `lib/coaching.ts`: deterministic, confidence-safe coaching fallback
- `analysis/`: the independent MediaPipe/FFmpeg analysis service and tests
- `docs/LLM_COACHING_CONTRACT.md`: strict evidence-rendering boundary for a
  future Responses API integration
- `docs/BETA_RUNBOOK.md`: 20-rider protocol, independent review, KPI gates, and
  go/no-go rules
- `docs/ANALYSIS_DEPLOYMENT.md`: one-container worker deployment, secrets,
  Sites wiring, and production smoke test
- `db/schema.ts`: D1 application schema
- `drizzle/`: generated D1 migration
- `worker/`: Sites worker binding types
- `tests/`: rendered web-flow smoke tests

## Run the web app

Requires Node.js 22.13 or newer.

```bash
npm ci
npm run dev
```

Validation:

```bash
npm run lint
npm test
```

`npm test` produces the Sites-compatible build in `dist/`, verifies the
server-rendered entry experience, and exercises the full create → upload → queue
→ status → delete API lifecycle against local D1/R2-compatible test doubles.

## Run the analysis service

The service requires Python 3.11 or 3.12 and FFmpeg/ffprobe. The checked-in
MediaPipe task model is used by default.

```bash
python3.12 -m venv .venv
.venv/bin/pip install -e analysis
.venv/bin/uvicorn snowtrace_analysis.api:app --host 127.0.0.1 --port 8080
```

Validation:

```bash
.venv/bin/python -m unittest discover -s analysis/tests -v
```

The pair-analysis endpoint accepts short-lived HTTPS download URLs, optional
short-lived proxy upload URLs, camera mode, initial edge labels, and optional
selected rider track IDs. `SNOWTRACE_SOURCE_HOSTS` can restrict accepted source
hosts in production. `/v1/jobs` adds an authenticated asynchronous wrapper and
delivers the quality-gated result to an allowlisted HTTPS callback.

For one-off local analysis:

```bash
.venv/bin/snowtrace-analyze rider.mp4 --output result.json
```

## Deployment shape

The web UI is built with Vinext and deployed through Sites. `.openai/hosting.json`
declares:

- D1 binding: `DB`
- R2 binding: `VIDEOS`

The Python analysis service is deliberately independent so it can run in a
CPU-friendly container with FFmpeg and MediaPipe. The intended production
handoff is: browser → signed R2 upload → D1 analysis job → Python service → D1
report/evidence records → web report.

When `ANALYSIS_SERVICE_URL`, `ANALYSIS_SERVICE_TOKEN`, and
`ANALYSIS_SIGNING_SECRET` are configured in Sites, queueing a run dispatches it
to the Python service. Short-lived HMAC media grants let that service download
only the two videos attached to the run and upload 720p proxies. The callback
stores the raw versioned output plus ranked evidence; missing runtime secrets
leave the job honestly queued instead of fabricating a result.

The UI never exposes a sample coaching report. A completed job resolves to real
evidence, rider selection, an actionable recapture result, a no-reliable-gap
result, or a technical retry state.

The M0 web path currently uses streamed same-origin uploads capped at 95 MB per
clip so it remains below a common Worker request ceiling. Replace this transport
with direct multipart object-storage uploads before raising the size limit.

## Product guardrails

- A low-confidence clip is rejected or limited; it never produces confident
  coaching language.
- When identity is ambiguous, analysis pauses for rider selection instead of
  silently following the largest or nearest person.
- Every coaching claim must link to a phase and timestamp the rider can inspect.
- One report contains one primary gap and one drill, not a laundry list.
- Framework labels such as CASI, AASI, or JSBA are optional references rather
  than the source of truth.
- The UI never substitutes sample values when service evidence is unavailable.
