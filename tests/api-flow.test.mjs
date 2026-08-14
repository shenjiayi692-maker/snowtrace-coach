import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { before, test } from "node:test";

class D1StatementMock {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new D1StatementMock(this.database, this.sql, values);
  }

  run() {
    return this.database.prepare(this.sql).run(...this.values);
  }

  first() {
    return this.database.prepare(this.sql).get(...this.values) ?? null;
  }

  all() {
    return { results: this.database.prepare(this.sql).all(...this.values) };
  }
}

class D1Mock {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new D1StatementMock(this.database, sql);
  }

  batch(statements) {
    this.database.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

class R2Mock {
  objects = new Map();

  async put(key, body, metadata) {
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    this.objects.set(key, { bytes, metadata });
    return { key, size: bytes.byteLength };
  }

  head(key) {
    const object = this.objects.get(key);
    return object ? { key, size: object.bytes.byteLength } : null;
  }

  get(key) {
    const object = this.objects.get(key);
    if (!object) return null;
    return { key, size: object.bytes.byteLength, body: new Response(object.bytes).body };
  }

  delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }
}

let worker;

before(async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const migrationsRoot = new URL("../drizzle/", import.meta.url);
  const migrationFiles = (await readdir(migrationsRoot)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of migrationFiles) {
    const migration = await readFile(new URL(file, migrationsRoot), "utf8");
    database.exec(migration.replaceAll("--> statement-breakpoint", "\n"));
  }
  globalThis.__snowtraceCloudflareEnv = {
    DB: new D1Mock(database),
    VIDEOS: new R2Mock(),
    ANALYSIS_SERVICE_TOKEN: "callback-test-token",
    ANALYSIS_SIGNING_SECRET: "media-signing-test-secret",
  };

  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("api-flow", `${process.pid}-${Date.now()}`);
  ({ default: worker } = await import(workerUrl.href));
});

function fetchApp(input, init) {
  const request = input instanceof Request ? input : new Request(input, init);
  return worker.fetch(request, {
    ...globalThis.__snowtraceCloudflareEnv,
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  }, { waitUntil() {}, passThroughOnException() {} });
}

function signedMediaPath(method, videoId, runId, purpose, expires) {
  const message = [method, videoId, runId, purpose, expires].join("\n");
  const signature = createHmac("sha256", "media-signing-test-secret").update(message).digest("hex");
  return `/api/analysis-media/${videoId}?run=${encodeURIComponent(runId)}&purpose=${purpose}&expires=${expires}&sig=${signature}`;
}

test("creates, uploads, queues, reads and deletes a real analysis session", async () => {
  const sourceBytes = {
    reference: new TextEncoder().encode("reference-video"),
    rider: new TextEncoder().encode("rider-video"),
  };
  const sessionResponse = await fetchApp("http://snowtrace.test/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      anonymousId: "rider_1234567890abcdef",
      goal: "medium",
      cameraMode: "fixed",
      viewAngle: "three-quarter",
      stance: "regular",
      videos: [
        {
          role: "reference",
          originalName: "reference.mp4",
          contentType: "video/mp4",
          sizeBytes: sourceBytes.reference.byteLength,
          durationSeconds: 8,
          width: 1920,
          height: 1080,
          preflight: { resolutionScore: 100, durationScore: 100, exposureScore: 82, sharpnessScore: 76 },
        },
        {
          role: "rider",
          originalName: "rider.mp4",
          contentType: "video/mp4",
          sizeBytes: sourceBytes.rider.byteLength,
          durationSeconds: 9,
          width: 1280,
          height: 720,
          preflight: { resolutionScore: 88, durationScore: 100, exposureScore: 79, sharpnessScore: 71 },
        },
      ],
    }),
  });
  assert.equal(sessionResponse.status, 201, await sessionResponse.clone().text());
  const created = await sessionResponse.json();
  assert.match(created.sessionId, /^ses_/);
  assert.equal(created.videos.length, 2);

  for (const video of created.videos) {
    const bytes = sourceBytes[video.role];
    const uploadResponse = await fetchApp(new Request(new URL(video.uploadUrl, "http://snowtrace.test"), {
      method: "PUT",
      headers: { "content-type": "video/mp4", "content-length": String(bytes.byteLength) },
      body: bytes,
    }));
    assert.equal(uploadResponse.status, 200, await uploadResponse.clone().text());
  }

  const queueResponse = await fetchApp(new URL(created.analysisUrl, "http://snowtrace.test"), { method: "POST" });
  assert.equal(queueResponse.status, 202);
  const queued = await queueResponse.json();
  assert.match(queued.analysisRunId, /^run_/);
  assert.equal(queued.status, "queued");

  const expires = Math.floor(Date.now() / 1000) + 60;
  const referenceVideo = created.videos.find((video) => video.role === "reference");
  const sourceResponse = await fetchApp(`http://snowtrace.test${signedMediaPath("GET", referenceVideo.id, queued.analysisRunId, "source", expires)}`);
  assert.equal(sourceResponse.status, 200);
  assert.deepEqual(new Uint8Array(await sourceResponse.arrayBuffer()), sourceBytes.reference);

  const proxyBytes = new TextEncoder().encode("proxy-video");
  const proxyResponse = await fetchApp(new Request(
    `http://snowtrace.test${signedMediaPath("PUT", referenceVideo.id, queued.analysisRunId, "proxy", expires)}`,
    {
      method: "PUT",
      headers: { "content-type": "video/mp4", "content-length": String(proxyBytes.byteLength) },
      body: proxyBytes,
    },
  ));
  assert.equal(proxyResponse.status, 204);

  const duplicateQueue = await fetchApp(new URL(created.analysisUrl, "http://snowtrace.test"), { method: "POST" });
  assert.equal(duplicateQueue.status, 200);
  assert.equal((await duplicateQueue.json()).analysisRunId, queued.analysisRunId);

  const needsRiderResponse = await fetchApp(`http://snowtrace.test/api/analysis-callback/${queued.analysisRunId}`, {
    method: "POST",
    headers: { "authorization": "Bearer callback-test-token", "content-type": "application/json" },
    body: JSON.stringify({
      analysis_id: queued.analysisRunId,
      status: "needs_rider",
      reference: {
        status: "needs_rider",
        selected_track_id: null,
        rider_candidates: [
          { track_id: 0, score: 0.82, coverage: 0.91, representative_frame_ms: 4100, representative_bbox: [0.2, 0.1, 0.5, 0.9] },
          { track_id: 1, score: 0.79, coverage: 0.86, representative_frame_ms: 4200, representative_bbox: [0.55, 0.12, 0.8, 0.88] },
        ],
      },
      rider: { status: "completed", selected_track_id: 0, rider_candidates: [] },
      evidence: [],
    }),
  });
  assert.equal(needsRiderResponse.status, 200);

  const selectionStatus = await fetchApp(new URL(created.statusUrl, "http://snowtrace.test"));
  const selectionSnapshot = await selectionStatus.json();
  assert.equal(selectionSnapshot.run.status, "needs_rider");
  assert.equal(selectionSnapshot.action.type, "select_rider");
  assert.equal(selectionSnapshot.action.roles[0].candidates.length, 2);

  const selectionResponse = await fetchApp(new URL(created.analysisUrl, "http://snowtrace.test"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ selectedTrackIds: { reference: 0 } }),
  });
  assert.equal(selectionResponse.status, 202, await selectionResponse.clone().text());
  assert.equal((await selectionResponse.json()).status, "queued");

  const callbackResponse = await fetchApp(`http://snowtrace.test/api/analysis-callback/${queued.analysisRunId}`, {
    method: "POST",
    headers: { "authorization": "Bearer callback-test-token", "content-type": "application/json" },
    body: JSON.stringify({
      analysis_id: queued.analysisRunId,
      status: "completed",
      reference: { status: "completed" },
      rider: { status: "completed" },
      evidence: [{
        metric_id: "knee_flexion_lead",
        rank: 1,
        phase: "apex",
        reference_value: 44,
        user_value: 57,
        difference: 13,
        effect_size: 1.7,
        confidence: 0.86,
        reference_timestamp_ms: 8400,
        user_timestamp_ms: 6900,
        unit: "deg",
        paired_turns: 3,
      }],
    }),
  });
  assert.equal(callbackResponse.status, 200, await callbackResponse.clone().text());
  assert.equal((await callbackResponse.json()).evidenceCount, 1);

  const statusResponse = await fetchApp(new URL(created.statusUrl, "http://snowtrace.test"));
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.run.status, "completed");
  assert.equal(status.evidence[0].metric_id, "knee_flexion_lead");
  assert.deepEqual(status.videos.map((video) => video.uploaded).sort(), [true, true]);

  const feedbackResponse = await fetchApp("http://snowtrace.test/api/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: created.sessionId,
      analysisRunId: queued.analysisRunId,
      events: [
        { eventType: "report_helpfulness", value: "yes" },
        { eventType: "evidence_clarity", value: "yes" },
        { eventType: "drill_intent", value: "yes" },
      ],
    }),
  });
  assert.equal(feedbackResponse.status, 201, await feedbackResponse.clone().text());

  const metricsResponse = await fetchApp("http://snowtrace.test/api/beta/metrics");
  assert.equal(metricsResponse.status, 200);
  const metrics = await metricsResponse.json();
  assert.equal(metrics.funnel.sessionsCreated, 1);
  assert.equal(metrics.funnel.participants, 1);
  assert.equal(metrics.funnel.ridersWithSecondSessionWithin7Days, 0);
  assert.equal(metrics.funnel.uploadCompletionRatePct, 100);
  assert.equal(metrics.funnel.reportCompletionRatePct, 100);
  assert.equal(metrics.coaching.helpfulOrPartlyPct, 100);
  assert.equal(metrics.coaching.drillIntentYesPct, 100);

  const deleteResponse = await fetchApp(new URL(created.statusUrl, "http://snowtrace.test"), { method: "DELETE" });
  assert.equal(deleteResponse.status, 204);
  const missingResponse = await fetchApp(new URL(created.statusUrl, "http://snowtrace.test"));
  assert.equal(missingResponse.status, 404);
});
