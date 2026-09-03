#!/usr/bin/env node

const expectedPipeline = "video-intelligence-v1.0";
const baseArgument = process.argv[2];

if (!baseArgument) {
  fail("Usage: npm run worker:check -- https://<worker-host>");
}

let baseUrl;
try {
  baseUrl = new URL(baseArgument);
} catch {
  fail("Worker URL is invalid.");
}

const localHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
  fail("Worker URL must not contain credentials, a query, or a fragment.");
}
if (baseUrl.protocol !== "https:" && !(baseUrl.protocol === "http:" && localHosts.has(baseUrl.hostname))) {
  fail("Worker URL must use HTTPS unless it points to localhost.");
}

const health = await getJson("/health");
if (health.status !== "ok" || health.pipeline_version !== expectedPipeline) {
  fail("Worker health response does not match the expected pipeline.");
}

const ready = await getJson("/ready");
const checks = ready.checks ?? {};
if (
  ready.status !== "ready"
  || ready.pipeline_version !== expectedPipeline
  || checks.pose_model !== true
  || checks.ffmpeg !== true
  || checks.ffprobe !== true
) {
  fail("Worker readiness checks did not all pass.");
}

const unauthorizedResponse = await fetchAt("/v1/jobs", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    analysis_id: "analysis-deployment-check",
    reference_camera_mode: "fixed",
    rider_camera_mode: "fixed",
    reference_view_angle: "three-quarter",
    rider_view_angle: "three-quarter",
    reference_stance: "regular",
    rider_stance: "regular",
    reference: { source_url: "https://invalid.example/reference.mp4" },
    rider: { source_url: "https://invalid.example/rider.mp4" },
    callback_url: "https://snowtrace-coach.sjysjy.chatgpt.site/api/analysis-callback/analysis-deployment-check",
  }),
});

if (unauthorizedResponse.status !== 401) {
  fail(`Token boundary check returned ${unauthorizedResponse.status}; expected 401.`);
}

console.log(JSON.stringify({
  status: "ready",
  worker: baseUrl.origin,
  pipelineVersion: expectedPipeline,
  checks: {
    poseModel: true,
    ffmpeg: true,
    ffprobe: true,
    unauthenticatedJobsRejected: true,
  },
}, null, 2));

async function getJson(pathname) {
  const response = await fetchAt(pathname);
  if (!response.ok) fail(`${pathname} returned ${response.status}.`);
  try {
    return await response.json();
  } catch {
    fail(`${pathname} did not return JSON.`);
  }
}

async function fetchAt(pathname, init = {}) {
  const target = new URL(pathname, `${baseUrl.origin}/`);
  try {
    return await fetch(target, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    fail(`${pathname} could not be reached: ${error instanceof Error ? error.message : "request failed"}`);
  }
}

function fail(message) {
  console.error(`Worker check failed: ${message}`);
  process.exit(1);
}
