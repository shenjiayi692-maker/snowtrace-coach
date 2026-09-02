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
  assert.match(html, /Private source storage/);
  assert.match(html, /I am 18 or older and I have permission to use these clips/);
  assert.match(html, /scheduled for deletion after 30 days/);
  assert.match(html, /Visible gap history/);
  assert.match(html, /Not a riding score/);
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
  assert.match(html, /Your camera/);
  assert.match(html, /Your view/);
  assert.match(html, /Your travel/);
  assert.match(html, /Reference camera/);
  assert.match(html, /Reference view/);
  assert.match(html, /Reference travel/);
  assert.match(html, /Your stance/);
  assert.match(html, /Reference stance/);
  assert.match(html, /Your first turn/);
  assert.match(html, /Reference first turn/);
  assert.match(html, /Beta access code/);
  assert.match(html, /not stored with your videos/);
  assert.match(html, /Choose edge/);
  assert.match(html, /Left → right/);
  assert.match(html, /mirrors pose coordinates/);
  assert.match(html, /keeps heelside paired with heelside, toeside with toeside/);
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

test("keeps progress history behind a valid anonymous device identifier", async () => {
  const response = await fetchBuiltApp(new Request("http://localhost/api/progress", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ anonymousId: "short" }),
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
    fingerprint: (role === "reference" ? "a" : "b").repeat(64),
    preflight: { resolutionScore: 88, durationScore: 100, exposureScore: 80, sharpnessScore: 75 },
  }));
  const sessionBody = {
    anonymousId: "rider_1234567890abcdef",
    betaAccessCode: "snowtrace-beta-test-code",
    consent: {
      version: "beta-consent-v1",
      adultAndRightsConfirmed: true,
      retentionAcknowledged: true,
    },
    goal: "medium",
    cameraMode: "fixed",
    referenceCameraMode: "fixed",
    viewAngle: "three-quarter",
    referenceViewAngle: "three-quarter",
    travelDirection: "left-to-right",
    referenceTravelDirection: "right-to-left",
    stance: "regular",
    referenceStance: "regular",
    firstEdge: "heelside",
    referenceFirstEdge: "toeside",
    videos,
  };
  const mismatch = await fetchBuiltApp(new Request("http://localhost/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...sessionBody, referenceViewAngle: "side" }),
  }));
  assert.equal(mismatch.status, 400);
  assert.deepEqual(await mismatch.json(), {
    error: "Reference and rider clips must use the same declared view for this 2D beta.",
  });

  const missingDirection = await fetchBuiltApp(new Request("http://localhost/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...sessionBody, travelDirection: undefined }),
  }));
  assert.equal(missingDirection.status, 400);
  assert.deepEqual(await missingDirection.json(), {
    error: "Choose your direction of travel across the frame.",
  });

  const response = await fetchBuiltApp(new Request("http://localhost/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sessionBody),
  }));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "The private beta is not accepting uploads yet." });
});
