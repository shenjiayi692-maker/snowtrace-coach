import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  globalThis.__snowtraceCloudflareEnv = {};
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

async function fetchBuiltApp(request) {
  globalThis.__snowtraceCloudflareEnv = {};
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("api-test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(request, {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  }, { waitUntil() {}, passThroughOnException() {} });
}

test("server-renders the Snowtrace vertical slice", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Snowtrace — AI Snowboard Progression Coach<\/title>/i);
  assert.match(html, /See the gap\./);
  assert.match(html, /Ride the fix\./);
  assert.match(html, /Reference video/);
  assert.match(html, /Rider video/);
  assert.match(html, /Check analysis readiness/);
  assert.match(html, /Private by default/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("renders capture guidance and context controls", async () => {
  const response = await render();
  const html = await response.text();

  assert.match(html, /Three turns\. Full body\. One stable view\./);
  assert.match(html, /Fixed 3\/4 camera angle is best/);
  assert.match(html, /Medium carving/);
  assert.match(html, /Short turns/);
  assert.match(html, /Dynamic carving/);
  assert.match(html, /Follow cam/);
  assert.match(html, /Regular/);
  assert.match(html, /Goofy/);
});

test("rejects an invalid analysis session before touching storage", async () => {
  const response = await fetchBuiltApp(new Request("http://localhost/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goal: "medium" }),
  }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "A valid anonymous rider ID is required." });
});

test("does not create a valid session while the analysis worker is offline", async () => {
  const videos = ["reference", "rider"].map((role) => ({
    role,
    originalName: `${role}.mp4`,
    contentType: "video/mp4",
    sizeBytes: 100,
    durationSeconds: 8,
    width: 1280,
    height: 720,
    preflight: { resolutionScore: 88, durationScore: 100, exposureScore: 80, sharpnessScore: 75 },
  }));
  const response = await fetchBuiltApp(new Request("http://localhost/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      anonymousId: "rider_1234567890abcdef",
      goal: "medium",
      cameraMode: "fixed",
      viewAngle: "three-quarter",
      stance: "regular",
      videos,
    }),
  }));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "The beta analysis worker is temporarily unavailable. No video was uploaded." });
});
