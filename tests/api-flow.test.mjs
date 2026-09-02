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
    const result = this.database.prepare(this.sql).run(...this.values);
    return { success: true, meta: result };
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

  get(key, options) {
    const object = this.objects.get(key);
    if (!object) return null;
    const range = options?.range;
    const bytes = range ? object.bytes.slice(range.offset, range.offset + range.length) : object.bytes;
    return { key, size: bytes.byteLength, body: new Response(bytes).body };
  }

  delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }
}

let worker;
let database;
let analysisRequests = [];

before(async () => {
  database = new DatabaseSync(":memory:");
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
    ANALYSIS_SERVICE_URL: "https://analysis.test",
    ANALYSIS_SERVICE_TOKEN: "callback-test-token",
    ANALYSIS_SIGNING_SECRET: "media-signing-test-secret",
    BETA_METRICS_TOKEN: "beta-metrics-test-token",
    BETA_OPS_TOKEN: "beta-ops-test-token",
  };

  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).hostname === "analysis.test") {
      analysisRequests.push(await request.clone().json());
      return Response.json({ status: "accepted" }, { status: 202 });
    }
    return nativeFetch(input, init);
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

function poseSnapshot(timestampMs, xOffset = 0) {
  return {
    timestamp_ms: timestampMs,
    landmarks: Array.from({ length: 33 }, (_, index) => ({
      x: Math.min(0.95, 0.2 + index * 0.015 + xOffset),
      y: Math.min(0.95, 0.1 + index * 0.02),
      visibility: 0.9,
      z: -0.1,
    })),
  };
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
      consent: {
        version: "beta-consent-v1",
        adultAndRightsConfirmed: true,
        retentionAcknowledged: true,
      },
      goal: "medium",
      cameraMode: "fixed",
      referenceCameraMode: "follow",
      viewAngle: "three-quarter",
      referenceViewAngle: "three-quarter",
      travelDirection: "left-to-right",
      referenceTravelDirection: "right-to-left",
      stance: "regular",
      referenceStance: "goofy",
      firstEdge: "heelside",
      referenceFirstEdge: "toeside",
      videos: [
        {
          role: "reference",
          originalName: "reference.mp4",
          contentType: "video/mp4",
          sizeBytes: sourceBytes.reference.byteLength,
          durationSeconds: 8,
          width: 1920,
          height: 1080,
          fingerprint: "a".repeat(64),
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
          fingerprint: "b".repeat(64),
          preflight: { resolutionScore: 88, durationScore: 100, exposureScore: 79, sharpnessScore: 71 },
        },
      ],
    }),
  });
  assert.equal(sessionResponse.status, 201, await sessionResponse.clone().text());
  const created = await sessionResponse.json();
  assert.match(created.sessionId, /^ses_/);
  assert.equal(created.videos.length, 2);
  assert.equal(
    database.prepare("SELECT consent_version FROM profiles WHERE anonymous_id = ?").get("rider_1234567890abcdef").consent_version,
    "beta-consent-v1",
  );
  const storedStances = database.prepare(
    "SELECT rider_stance, reference_stance, rider_first_edge, reference_first_edge, rider_travel_direction, reference_travel_direction, camera_mode, view_angle, reference_camera_mode, reference_view_angle FROM sessions WHERE id = ?",
  ).get(created.sessionId);
  assert.equal(storedStances.rider_stance, "regular");
  assert.equal(storedStances.reference_stance, "goofy");
  assert.equal(storedStances.rider_first_edge, "heelside");
  assert.equal(storedStances.reference_first_edge, "toeside");
  assert.equal(storedStances.rider_travel_direction, "left-to-right");
  assert.equal(storedStances.reference_travel_direction, "right-to-left");
  assert.equal(storedStances.camera_mode, "fixed");
  assert.equal(storedStances.view_angle, "three-quarter");
  assert.equal(storedStances.reference_camera_mode, "follow");
  assert.equal(storedStances.reference_view_angle, "three-quarter");

  for (const video of created.videos) {
    const bytes = sourceBytes[video.role];
    const uploadResponse = await fetchApp(new Request(new URL(video.uploadUrl, "http://snowtrace.test"), {
      method: "PUT",
      headers: { "content-type": "video/mp4", "content-length": String(bytes.byteLength) },
      body: bytes,
    }));
    assert.equal(uploadResponse.status, 200, await uploadResponse.clone().text());
  }
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM videos WHERE session_id = ? AND uploaded_at IS NOT NULL").get(created.sessionId).count,
    2,
  );

  const uploadedReference = created.videos.find((video) => video.role === "reference");
  const fullPlaybackResponse = await fetchApp(new URL(uploadedReference.uploadUrl, "http://snowtrace.test"), { method: "GET" });
  assert.equal(fullPlaybackResponse.status, 200);
  assert.equal(fullPlaybackResponse.headers.get("accept-ranges"), "bytes");
  assert.deepEqual(new Uint8Array(await fullPlaybackResponse.arrayBuffer()), sourceBytes.reference);

  const rangedPlaybackResponse = await fetchApp(new URL(uploadedReference.uploadUrl, "http://snowtrace.test"), {
    headers: { range: "bytes=0-3" },
  });
  assert.equal(rangedPlaybackResponse.status, 206);
  assert.equal(rangedPlaybackResponse.headers.get("content-range"), `bytes 0-3/${sourceBytes.reference.byteLength}`);
  assert.deepEqual(new Uint8Array(await rangedPlaybackResponse.arrayBuffer()), sourceBytes.reference.slice(0, 4));

  const invalidRangeResponse = await fetchApp(new URL(uploadedReference.uploadUrl, "http://snowtrace.test"), {
    headers: { range: "bytes=9999-10000" },
  });
  assert.equal(invalidRangeResponse.status, 416);

  const queueResponse = await fetchApp(new URL(created.analysisUrl, "http://snowtrace.test"), { method: "POST" });
  assert.equal(queueResponse.status, 202);
  const queued = await queueResponse.json();
  assert.match(queued.analysisRunId, /^run_/);
  assert.equal(queued.status, "queued");
  assert.equal(analysisRequests.at(-1).rider_stance, "regular");
  assert.equal(analysisRequests.at(-1).reference_stance, "goofy");
  assert.equal(analysisRequests.at(-1).rider_camera_mode, "fixed");
  assert.equal(analysisRequests.at(-1).reference_camera_mode, "follow");
  assert.equal(analysisRequests.at(-1).rider_view_angle, "three-quarter");
  assert.equal(analysisRequests.at(-1).reference_view_angle, "three-quarter");
  assert.equal(analysisRequests.at(-1).rider_travel_direction, "left-to-right");
  assert.equal(analysisRequests.at(-1).reference_travel_direction, "right-to-left");
  assert.equal(analysisRequests.at(-1).rider.first_edge, "heelside");
  assert.equal(analysisRequests.at(-1).reference.first_edge, "toeside");

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

  const completedCallbackPayload = {
    analysis_id: queued.analysisRunId,
    status: "completed",
    reference: { status: "completed" },
    rider: { status: "completed" },
    evidence: [{
        metric_id: "knee_flexion_lead",
        edge_type: "heelside",
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
        reference_pose: poseSnapshot(8400),
        user_pose: poseSnapshot(6900, 0.02),
        ignored_worker_field: "not persisted",
    }],
  };
  const callbackResponse = await fetchApp(`http://snowtrace.test/api/analysis-callback/${queued.analysisRunId}`, {
    method: "POST",
    headers: { "authorization": "Bearer callback-test-token", "content-type": "application/json" },
    body: JSON.stringify(completedCallbackPayload),
  });
  assert.equal(callbackResponse.status, 200, await callbackResponse.clone().text());
  const callbackResult = await callbackResponse.json();
  assert.equal(callbackResult.evidenceCount, 1);
  assert.equal(callbackResult.reportCreated, true);

  const replayedCallbackResponse = await fetchApp(`http://snowtrace.test/api/analysis-callback/${queued.analysisRunId}`, {
    method: "POST",
    headers: { "authorization": "Bearer callback-test-token", "content-type": "application/json" },
    body: JSON.stringify({ ...completedCallbackPayload, evidence: [] }),
  });
  assert.equal(replayedCallbackResponse.status, 200);
  assert.deepEqual(await replayedCallbackResponse.json(), {
    accepted: true,
    status: "completed",
    evidenceCount: 1,
    reused: true,
  });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM reports WHERE analysis_run_id = ?").get(queued.analysisRunId).count, 1);

  const statusResponse = await fetchApp(new URL(created.statusUrl, "http://snowtrace.test"));
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.run.status, "completed");
  assert.equal(status.evidence[0].metric_id, "knee_flexion_lead");
  assert.equal(status.evidence[0].edge_type, "heelside");
  assert.equal(status.evidence[0].details.reference_pose.landmarks.length, 33);
  assert.equal(status.evidence[0].details.reference_pose.timestamp_ms, 8400);
  assert.equal("z" in status.evidence[0].details.reference_pose.landmarks[0], false);
  assert.equal("ignored_worker_field" in status.evidence[0].details, false);
  assert.equal(status.report.schemaVersion, "coach-report-v1");
  assert.equal(status.report.rendererVersion, "deterministic-coach-v1");
  assert.equal(status.report.drillLibraryVersion, "carving-drills-v1");
  assert.equal(status.report.metricId, "knee_flexion_lead");
  assert.equal(status.report.edgeType, "heelside");
  assert.equal(status.report.phase, "apex");
  assert.equal(status.report.drill.id, "progressive-flexion-v1");
  const runVersions = database.prepare(
    "SELECT prompt_version, drill_library_version FROM analysis_runs WHERE id = ?",
  ).get(queued.analysisRunId);
  assert.equal(runVersions.prompt_version, "deterministic-coach-v1");
  assert.equal(runVersions.drill_library_version, "carving-drills-v1");
  assert.deepEqual(status.videos.map((video) => video.uploaded).sort(), [true, true]);
  assert.ok(status.videos.every((video) => video.playback_url.includes(created.sessionId)));

  const progressResponse = await fetchApp("http://snowtrace.test/api/progress", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ anonymousId: "rider_1234567890abcdef" }),
  });
  assert.equal(progressResponse.status, 200);
  const progress = await progressResponse.json();
  assert.equal(progress.history.length, 1);
  assert.equal(progress.history[0].goal, "medium");
  assert.equal(progress.history[0].metricId, "knee_flexion_lead");
  assert.equal(progress.history[0].edgeType, "heelside");
  assert.equal(progress.history[0].gapChange, null);
  assert.equal("referenceFingerprint" in progress.history[0], false);
  assert.equal("sessionId" in progress.history[0], false);
  assert.equal("originalName" in progress.history[0], false);

  const reportViewedEvent = {
    sessionId: created.sessionId,
    analysisRunId: queued.analysisRunId,
    eventType: "report_viewed",
  };
  const firstReportView = await fetchApp("http://snowtrace.test/api/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(reportViewedEvent),
  });
  assert.equal(firstReportView.status, 201);
  assert.deepEqual(await firstReportView.json(), { accepted: true, recorded: true });
  const duplicateReportView = await fetchApp("http://snowtrace.test/api/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(reportViewedEvent),
  });
  assert.equal(duplicateReportView.status, 201);
  assert.deepEqual(await duplicateReportView.json(), { accepted: true, recorded: false });
  const showMeEvent = await fetchApp("http://snowtrace.test/api/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...reportViewedEvent, eventType: "show_me_clicked" }),
  });
  assert.equal(showMeEvent.status, 201);
  assert.deepEqual(await showMeEvent.json(), { accepted: true, recorded: true });

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
  const duplicateFeedbackResponse = await fetchApp("http://snowtrace.test/api/feedback", {
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
  assert.equal(duplicateFeedbackResponse.status, 201);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM feedback_events WHERE analysis_run_id = ?").get(queued.analysisRunId).count,
    5,
  );

  const unauthorizedReviewQueue = await fetchApp("http://snowtrace.test/api/beta/reviews");
  assert.equal(unauthorizedReviewQueue.status, 401);
  const reviewQueueResponse = await fetchApp("http://snowtrace.test/api/beta/reviews", {
    headers: { authorization: "Bearer beta-metrics-test-token" },
  });
  assert.equal(reviewQueueResponse.status, 200);
  const reviewQueue = await reviewQueueResponse.json();
  assert.equal(reviewQueue.items.length, 1);
  assert.equal(reviewQueue.items[0].analysisRunId, queued.analysisRunId);
  assert.equal(reviewQueue.items[0].review, null);
  assert.equal(reviewQueue.items[0].evidence.edgeType, "heelside");
  assert.match(reviewQueue.items[0].media.referenceUrl, /\/api\/analysis-media\//);
  const reviewSource = await fetchApp(reviewQueue.items[0].media.referenceUrl);
  assert.equal(reviewSource.status, 200);
  assert.deepEqual(new Uint8Array(await reviewSource.arrayBuffer()), sourceBytes.reference);

  const instructorReview = {
    analysisRunId: queued.analysisRunId,
    phaseInspectable: "yes",
    metricDirectionPlausible: "yes",
    explanationAssessment: "supported",
    drillAssessment: "safe-relevant",
    misleadingSeverity: "none",
  };
  const reviewResponse = await fetchApp("http://snowtrace.test/api/beta/reviews", {
    method: "POST",
    headers: { authorization: "Bearer beta-metrics-test-token", "content-type": "application/json" },
    body: JSON.stringify(instructorReview),
  });
  assert.equal(reviewResponse.status, 201, await reviewResponse.clone().text());
  const updatedReviewResponse = await fetchApp("http://snowtrace.test/api/beta/reviews", {
    method: "POST",
    headers: { authorization: "Bearer beta-metrics-test-token", "content-type": "application/json" },
    body: JSON.stringify({ ...instructorReview, phaseInspectable: "partly" }),
  });
  assert.equal(updatedReviewResponse.status, 201);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM instructor_reviews").get().count, 1);

  const metricsResponse = await fetchApp("http://snowtrace.test/api/beta/metrics", {
    headers: { authorization: "Bearer beta-metrics-test-token" },
  });
  assert.equal(metricsResponse.status, 200);
  const metrics = await metricsResponse.json();
  assert.equal(metrics.funnel.sessionsCreated, 1);
  assert.equal(metrics.funnel.participants, 1);
  assert.equal(metrics.funnel.sessionsWithBothUploads, 1);
  assert.equal(metrics.funnel.acceptedEvidenceRuns, 1);
  assert.equal(metrics.funnel.actionableEvidenceOrRider, 1);
  assert.equal(metrics.funnel.reportsViewed, 1);
  assert.equal(metrics.funnel.showMeClicked, 1);
  assert.equal(metrics.funnel.ridersWithSecondSessionWithin7Days, 0);
  assert.equal(metrics.funnel.uploadCompletionRatePct, 100);
  assert.equal(metrics.funnel.actionableStateRatePct, 100);
  assert.equal(metrics.funnel.reportCompletionRatePct, 100);
  assert.equal(metrics.funnel.showMeEngagementRatePct, 100);
  assert.equal(metrics.coaching.helpfulOrPartlyPct, 100);
  assert.equal(metrics.coaching.evidenceClearlySeenPct, 100);
  assert.equal(metrics.coaching.evidenceSeenOrPartlyPct, 100);
  assert.equal(metrics.coaching.drillIntentYesPct, 100);
  assert.equal(metrics.coaching.helpfulnessResponseCount, 1);
  assert.equal(metrics.coaching.evidenceClarityResponseCount, 1);
  assert.equal(metrics.coaching.drillIntentResponseCount, 1);
  assert.equal(metrics.instructorReview.reviewedRuns, 1);
  assert.equal(metrics.instructorReview.reviewCoveragePct, 100);
  assert.equal(metrics.instructorReview.metricDirectionPlausiblePct, 100);
  assert.equal(metrics.instructorReview.phaseInspectableOrPartlyPct, 100);
  assert.equal(metrics.instructorReview.safeRelevantDrillPct, 100);
  assert.equal(metrics.instructorReview.materialOrSafetyCriticalClaims, 0);
  assert.equal(metrics.instructorReview.safetyCriticalClaims, 0);
  assert.equal(metrics.quality.technicalFailures, 0);
  assert.equal(metrics.quality.technicalFailureRatePct, 0);
  assert.ok(metrics.quality.medianUploadToTerminalMinutes >= 0);
  assert.equal(metrics.quality.recaptureCoveragePct, null);

  database.prepare("DELETE FROM instructor_reviews WHERE analysis_run_id = ?").run(queued.analysisRunId);
  database.prepare("DELETE FROM analysis_outputs WHERE analysis_run_id = ?").run(queued.analysisRunId);
  database.prepare("DELETE FROM comparison_evidence WHERE analysis_run_id = ?").run(queued.analysisRunId);
  database.prepare(
    "UPDATE analysis_runs SET status = 'queued', stage = 'test_reset', completed_at = NULL WHERE id = ?",
  ).run(queued.analysisRunId);

  const qualityPayload = {
    status: "rejected",
    readiness_score: 42,
    hard_failures: ["rider_too_small"],
    checks: [{ id: "rider_size", label: "Rider size", score: 31, status: "blocked", detail: "Median rider height 9% of frame" }],
    allowed_metrics: [],
    recapture_instructions: ["Move the camera closer so the rider occupies at least 20% of frame height."],
  };
  const noEvidenceCallback = await fetchApp(`http://snowtrace.test/api/analysis-callback/${queued.analysisRunId}`, {
    method: "POST",
    headers: { "authorization": "Bearer callback-test-token", "content-type": "application/json" },
    body: JSON.stringify({
      analysis_id: queued.analysisRunId,
      status: "completed",
      reference: { status: "completed", quality: { ...qualityPayload, status: "limited", readiness_score: 70, hard_failures: [] } },
      rider: { status: "completed", quality: { ...qualityPayload, status: "limited", readiness_score: 68, hard_failures: [] } },
      evidence: [],
    }),
  });
  assert.equal(noEvidenceCallback.status, 200);
  const noEvidenceSnapshot = await (await fetchApp(new URL(created.statusUrl, "http://snowtrace.test"))).json();
  assert.equal(noEvidenceSnapshot.outcome.kind, "no_evidence");
  assert.equal(noEvidenceSnapshot.outcome.retryable, false);
  const emptyProgress = await fetchApp("http://snowtrace.test/api/progress", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ anonymousId: "rider_1234567890abcdef" }),
  });
  assert.deepEqual(await emptyProgress.json(), { history: [] });
  const noEvidenceEvent = await fetchApp("http://snowtrace.test/api/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(reportViewedEvent),
  });
  assert.equal(noEvidenceEvent.status, 409);

  database.prepare("DELETE FROM analysis_outputs WHERE analysis_run_id = ?").run(queued.analysisRunId);
  database.prepare(
    "UPDATE analysis_runs SET status = 'queued', stage = 'test_reset', completed_at = NULL WHERE id = ?",
  ).run(queued.analysisRunId);

  const rejectedCallback = await fetchApp(`http://snowtrace.test/api/analysis-callback/${queued.analysisRunId}`, {
    method: "POST",
    headers: { "authorization": "Bearer callback-test-token", "content-type": "application/json" },
    body: JSON.stringify({
      analysis_id: queued.analysisRunId,
      status: "rejected",
      reference: { status: "completed", quality: { ...qualityPayload, status: "limited", readiness_score: 70, hard_failures: [] } },
      rider: { status: "rejected", quality: qualityPayload },
      evidence: [],
    }),
  });
  assert.equal(rejectedCallback.status, 200);
  const rejectedSnapshot = await (await fetchApp(new URL(created.statusUrl, "http://snowtrace.test"))).json();
  assert.equal(rejectedSnapshot.outcome.kind, "footage");
  assert.equal(rejectedSnapshot.outcome.videos[1].readiness_score, 42);
  assert.equal(rejectedSnapshot.outcome.videos[1].recapture_instructions.length, 1);

  const deleteResponse = await fetchApp(new URL(created.statusUrl, "http://snowtrace.test"), { method: "DELETE" });
  assert.equal(deleteResponse.status, 204);
  const missingResponse = await fetchApp(new URL(created.statusUrl, "http://snowtrace.test"));
  assert.equal(missingResponse.status, 404);
});

test("counts a second completed upload within seven days without relying on retained R2 objects", async () => {
  const firstUploadedAt = "2026-01-10T12:00:00.000Z";
  const secondUploadedAt = "2026-01-13T12:00:00.000Z";
  const expiresAt = "2026-02-12T12:00:00.000Z";
  database.prepare(
    "INSERT INTO profiles (id, anonymous_id, locale, stance, level, consent_version, created_at, updated_at) VALUES (?, ?, 'en', 'goofy', 'intermediate', 'beta-consent-v1', ?, ?)",
  ).run("pro_repeat", "rider_repeat_123456789", firstUploadedAt, firstUploadedAt);
  for (const [index, uploadedAt] of [firstUploadedAt, secondUploadedAt].entries()) {
    const progressionId = `pgs_repeat_${index}`;
    const sessionId = `ses_repeat_${index}`;
    database.prepare(
      "INSERT INTO progressions (id, profile_id, goal, framework, status, created_at, updated_at) VALUES (?, ?, 'medium', 'none', 'active', ?, ?)",
    ).run(progressionId, "pro_repeat", uploadedAt, uploadedAt);
    database.prepare(
      "INSERT INTO sessions (id, progression_id, camera_mode, view_angle, status, created_at, updated_at) VALUES (?, ?, 'fixed', 'three-quarter', 'draft', ?, ?)",
    ).run(sessionId, progressionId, uploadedAt, uploadedAt);
    for (const role of ["reference", "rider"]) {
      database.prepare(
        `INSERT INTO videos
          (id, session_id, role, object_key, original_name, content_type, size_bytes, uploaded_at, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'video/mp4', 10, ?, ?, ?, ?)`,
      ).run(
        `vid_repeat_${index}_${role}`,
        sessionId,
        role,
        `source/repeat/${index}/${role}`,
        `${role}.mp4`,
        uploadedAt,
        expiresAt,
        uploadedAt,
        uploadedAt,
      );
    }
  }

  const response = await fetchApp("http://snowtrace.test/api/beta/metrics", {
    headers: { authorization: "Bearer beta-metrics-test-token" },
  });
  assert.equal(response.status, 200);
  const metrics = await response.json();
  assert.equal(metrics.funnel.sessionsCreated, 2);
  assert.equal(metrics.funnel.sessionsWithBothUploads, 2);
  assert.equal(metrics.funnel.participants, 1);
  assert.equal(metrics.funnel.ridersWithSecondSessionWithin7Days, 1);
  assert.equal(metrics.funnel.sevenDayRepeatRatePct, 100);
  assert.equal(globalThis.__snowtraceCloudflareEnv.VIDEOS.objects.size, 0);

  database.prepare("DELETE FROM profiles WHERE id = ?").run("pro_repeat");
});

test("computes a visible-gap trend only for matching reference and capture context", async () => {
  const records = [
    { index: 0, date: "2026-01-01T12:00:00.000Z", fingerprint: "c".repeat(64), difference: 20 },
    { index: 1, date: "2026-01-02T12:00:00.000Z", fingerprint: "c".repeat(64), difference: 5 },
    { index: 2, date: "2026-01-03T12:00:00.000Z", fingerprint: "c".repeat(64), difference: 12 },
    { index: 3, date: "2026-01-04T12:00:00.000Z", fingerprint: "c".repeat(64), difference: 9 },
    { index: 4, date: "2026-01-05T12:00:00.000Z", fingerprint: "c".repeat(64), difference: 7 },
  ];
  database.prepare(
    "INSERT INTO profiles (id, anonymous_id, locale, stance, level, consent_version, created_at, updated_at) VALUES (?, ?, 'en', 'regular', 'intermediate', 'beta-consent-v1', ?, ?)",
  ).run("pro_progress", "rider_progress_1234567", records[0].date, records[0].date);
  for (const record of records) {
    const progressionId = `pgs_progress_${record.index}`;
    const sessionId = `ses_progress_${record.index}`;
    const videoId = `vid_progress_${record.index}`;
    const runId = `run_progress_${record.index}`;
    database.prepare(
      `INSERT INTO progressions
        (id, profile_id, goal, framework, reference_video_id, status, created_at, updated_at)
       VALUES (?, ?, 'medium', 'none', ?, 'active', ?, ?)`,
    ).run(progressionId, "pro_progress", videoId, record.date, record.date);
    database.prepare(
      `INSERT INTO sessions
        (id, progression_id, camera_mode, view_angle, reference_camera_mode, reference_view_angle,
         rider_travel_direction, reference_travel_direction, rider_stance, reference_stance,
         rider_first_edge, reference_first_edge, status, created_at, updated_at)
       VALUES (?, ?, 'fixed', 'three-quarter', ?, 'three-quarter', ?, 'right-to-left', ?, ?, 'heelside', 'toeside', 'completed', ?, ?)`,
    ).run(
      sessionId,
      progressionId,
      record.index === 3 ? "follow" : "fixed",
      record.index === 4 ? "right-to-left" : "left-to-right",
      record.index === 1 ? "goofy" : "regular",
      record.index === 1 ? "goofy" : "regular",
      record.date,
      record.date,
    );
    database.prepare(
      `INSERT INTO videos
        (id, session_id, role, object_key, original_name, content_type, size_bytes, metadata_json, expires_at, created_at, updated_at)
       VALUES (?, ?, 'reference', ?, 'reference.mp4', 'video/mp4', 10, ?, '2026-02-10T12:00:00.000Z', ?, ?)`,
    ).run(videoId, sessionId, `source/progress/${record.index}`, JSON.stringify({ fingerprint: record.fingerprint }), record.date, record.date);
    database.prepare(
      `INSERT INTO analysis_runs
        (id, session_id, status, stage, pipeline_version, created_at, updated_at)
       VALUES (?, ?, 'completed', 'evidence_ready', 'video-intelligence-v0.2', ?, ?)`,
    ).run(runId, sessionId, record.date, record.date);
    database.prepare(
      `INSERT INTO comparison_evidence
        (id, analysis_run_id, metric_id, edge_type, rank, confidence, effect_size, phase, user_timestamp_ms, reference_timestamp_ms, evidence_json)
       VALUES (?, ?, 'knee_flexion_lead', 'heelside', 1, 0.86, 1.7, 'apex', 6000, 7000, ?)`,
    ).run(`ev_progress_${record.index}`, runId, JSON.stringify({
      reference_value: 45,
      user_value: 45 + record.difference,
      difference: record.difference,
      unit: "degrees",
      paired_turns: 3,
    }));
  }

  const response = await fetchApp("http://snowtrace.test/api/progress", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ anonymousId: "rider_progress_1234567" }),
  });
  assert.equal(response.status, 200);
  const progress = await response.json();
  assert.equal(progress.history.length, 5);
  assert.equal(progress.history[0].difference, 7);
  assert.equal(progress.history[0].edgeType, "heelside");
  assert.equal(progress.history[0].gapChange, null);
  assert.equal(progress.history[1].difference, 9);
  assert.equal(progress.history[1].gapChange, null);
  assert.equal(progress.history[2].difference, 12);
  assert.equal(progress.history[2].gapChange, 8);
  assert.equal(progress.history[3].difference, 5);
  assert.equal(progress.history[3].gapChange, null);
  assert.equal(progress.history[4].gapChange, null);
  assert.equal("referenceFingerprint" in progress.history[0], false);
  assert.equal("riderStance" in progress.history[0], false);
  assert.equal("referenceStance" in progress.history[0], false);
  assert.equal("referenceCameraMode" in progress.history[0], false);
  assert.equal("referenceViewAngle" in progress.history[0], false);
  assert.equal("riderTravelDirection" in progress.history[0], false);
  assert.equal("referenceTravelDirection" in progress.history[0], false);

  database.prepare("DELETE FROM profiles WHERE id = ?").run("pro_progress");
});

test("reports worker availability without exposing runtime secrets", async () => {
  const response = await fetchApp("http://snowtrace.test/api/system-status");
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.deepEqual(status, {
    analysisAvailable: true,
    productScope: "snowboard_carving",
    pipelineVersion: "video-intelligence-v1.0",
  });
  assert.equal(JSON.stringify(status).includes("callback-test-token"), false);

  const metricsResponse = await fetchApp("http://snowtrace.test/api/beta/metrics");
  assert.equal(metricsResponse.status, 401);
});

test("requires the current video consent before creating a session", async () => {
  const response = await fetchApp("http://snowtrace.test/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      anonymousId: "rider_missing_consent_1234",
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
      videos: [],
    }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "Confirm the beta video permissions and retention terms before uploading.",
  });
});

test("deletes expired source and proxy objects through the protected retention operation", async () => {
  const now = new Date().toISOString();
  database.prepare(
    "INSERT INTO profiles (id, anonymous_id, locale, stance, level, consent_version, created_at, updated_at) VALUES (?, ?, 'en', 'regular', 'intermediate', 'beta-consent-v1', ?, ?)",
  ).run("pro_retention", "rider_retention_123456", now, now);
  database.prepare(
    "INSERT INTO progressions (id, profile_id, goal, framework, status, created_at, updated_at) VALUES (?, ?, 'medium', 'none', 'active', ?, ?)",
  ).run("pgs_retention", "pro_retention", now, now);
  database.prepare(
    "INSERT INTO sessions (id, progression_id, camera_mode, view_angle, status, created_at, updated_at) VALUES (?, ?, 'fixed', 'three-quarter', 'completed', ?, ?)",
  ).run("ses_retention", "pgs_retention", now, now);
  database.prepare(
    `INSERT INTO videos
      (id, session_id, role, object_key, proxy_object_key, original_name, content_type, size_bytes, expires_at, created_at, updated_at)
     VALUES (?, ?, 'rider', ?, ?, 'expired.mp4', 'video/mp4', 5, ?, ?, ?)`,
  ).run("vid_retention", "ses_retention", "source/expired", "proxy/expired", "2020-01-01T00:00:00.000Z", now, now);

  const bucket = globalThis.__snowtraceCloudflareEnv.VIDEOS;
  await bucket.put("source/expired", new TextEncoder().encode("source"), {});
  await bucket.put("proxy/expired", new TextEncoder().encode("proxy"), {});

  const unauthorized = await fetchApp("http://snowtrace.test/api/ops/cleanup", { method: "POST" });
  assert.equal(unauthorized.status, 401);
  assert.ok(await bucket.head("source/expired"));

  const cleanup = await fetchApp("http://snowtrace.test/api/ops/cleanup", {
    method: "POST",
    headers: { authorization: "Bearer beta-ops-test-token", "content-type": "application/json" },
    body: JSON.stringify({ limit: 50 }),
  });
  assert.equal(cleanup.status, 200, await cleanup.clone().text());
  assert.deepEqual(await cleanup.json(), {
    selected: 1,
    videosMarkedDeleted: 1,
    objectKeysDeleted: 2,
    failures: 0,
  });
  assert.equal(await bucket.head("source/expired"), null);
  assert.equal(await bucket.head("proxy/expired"), null);
  assert.ok(database.prepare("SELECT deleted_at FROM videos WHERE id = ?").get("vid_retention").deleted_at);

  const repeat = await fetchApp("http://snowtrace.test/api/ops/cleanup", {
    method: "POST",
    headers: { authorization: "Bearer beta-ops-test-token" },
  });
  assert.equal(repeat.status, 200);
  assert.deepEqual(await repeat.json(), {
    selected: 0,
    videosMarkedDeleted: 0,
    objectKeysDeleted: 0,
    failures: 0,
  });
});
