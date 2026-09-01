import { env } from "cloudflare:workers";
import { signedMediaUrl } from "../../../../../lib/analysis-signing";
import { analysisServiceConfigured } from "../../../../../lib/runtime-capabilities";
import { jsonError } from "../../../../../lib/session-contract";

export const dynamic = "force-dynamic";

type VideoRow = { id: string; role: "reference" | "rider"; object_key: string };
type ExistingRun = { id: string; status: string; stage: string | null };
type Stance = "regular" | "goofy";
type TravelDirection = "left-to-right" | "right-to-left";
type SessionRow = {
  id: string;
  camera_mode: "fixed" | "follow";
  view_angle: "three-quarter" | "side" | "front-rear";
  reference_camera_mode: "fixed" | "follow";
  reference_view_angle: "three-quarter" | "side" | "front-rear";
  rider_travel_direction: TravelDirection;
  reference_travel_direction: TravelDirection;
  rider_stance: Stance;
  reference_stance: Stance;
  rider_first_edge: "heelside" | "toeside";
  reference_first_edge: "heelside" | "toeside";
};
type SelectedTrackIds = Partial<Record<"reference" | "rider", number>>;

async function dispatchToWorker(request: Request, runId: string, session: SessionRow, videos: VideoRow[], selectedTrackIds: SelectedTrackIds = {}) {
  if (!analysisServiceConfigured(env)) return "awaiting_worker";
  let serviceUrl: URL;
  try {
    serviceUrl = new URL("/v1/jobs", env.ANALYSIS_SERVICE_URL);
  } catch {
    return "dispatch_failed";
  }
  if (serviceUrl.protocol !== "https:") return "dispatch_failed";

  const origin = new URL(request.url).origin;
  const expires = Math.floor(Date.now() / 1000) + 45 * 60;
  const byRole = Object.fromEntries(videos.map((video) => [video.role, video])) as Record<"reference" | "rider", VideoRow>;
  const sourceUrls = await Promise.all((["reference", "rider"] as const).map((role) => signedMediaUrl(origin, env.ANALYSIS_SIGNING_SECRET, {
    method: "GET",
    videoId: byRole[role].id,
    analysisRunId: runId,
    purpose: "source",
    expires,
  })));
  const proxyUrls = await Promise.all((["reference", "rider"] as const).map((role) => signedMediaUrl(origin, env.ANALYSIS_SIGNING_SECRET, {
    method: "PUT",
    videoId: byRole[role].id,
    analysisRunId: runId,
    purpose: "proxy",
    expires,
  })));

  try {
    const response = await fetch(serviceUrl, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${env.ANALYSIS_SERVICE_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        analysis_id: runId,
        reference: { source_url: sourceUrls[0], first_edge: session.reference_first_edge, selected_track_id: selectedTrackIds.reference ?? null },
        rider: { source_url: sourceUrls[1], first_edge: session.rider_first_edge, selected_track_id: selectedTrackIds.rider ?? null },
        reference_stance: session.reference_stance,
        rider_stance: session.rider_stance,
        reference_camera_mode: session.reference_camera_mode,
        rider_camera_mode: session.camera_mode,
        reference_view_angle: session.reference_view_angle,
        rider_view_angle: session.view_angle,
        reference_travel_direction: session.reference_travel_direction,
        rider_travel_direction: session.rider_travel_direction,
        proxy_upload_urls: { reference: proxyUrls[0], rider: proxyUrls[1] },
        callback_url: new URL(`/api/analysis-callback/${encodeURIComponent(runId)}`, origin).toString(),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok ? "worker_dispatched" : "dispatch_failed";
  } catch (error) {
    console.error("analysis_dispatch_failed", error);
    return "dispatch_failed";
  }
}

async function selectionIsValid(runId: string, selectedTrackIds: SelectedTrackIds) {
  const output = await env.DB.prepare("SELECT result_json FROM analysis_outputs WHERE analysis_run_id = ? AND status = 'needs_rider'")
    .bind(runId)
    .first<{ result_json: string }>();
  if (!output) return false;
  try {
    const result = JSON.parse(output.result_json) as Record<string, unknown>;
    const requiredRoles = (["reference", "rider"] as const).filter((role) => {
      const video = result[role] as Record<string, unknown> | undefined;
      return video?.selected_track_id === null && Array.isArray(video.rider_candidates);
    });
    if (!requiredRoles.length || requiredRoles.some((role) => !Number.isInteger(selectedTrackIds[role]))) return false;
    return requiredRoles.every((role) => {
      const video = result[role] as { rider_candidates: Array<Record<string, unknown>> };
      return video.rider_candidates.some((candidate) => candidate.track_id === selectedTrackIds[role]);
    });
  } catch {
    return false;
  }
}

export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await context.params;
  let selectedTrackIds: SelectedTrackIds = {};
  if (request.headers.get("content-type")?.includes("application/json")) {
    try {
      const body = await request.json() as { selectedTrackIds?: SelectedTrackIds };
      selectedTrackIds = body.selectedTrackIds ?? {};
    } catch {
      return jsonError("Rider selection must be valid JSON.", 400);
    }
  }
  const session = await env.DB.prepare(
    `SELECT id, camera_mode, view_angle, reference_camera_mode, reference_view_angle,
       rider_travel_direction, reference_travel_direction,
       rider_stance, reference_stance, rider_first_edge, reference_first_edge
     FROM sessions WHERE id = ?`,
  ).bind(sessionId).first<SessionRow>();
  if (!session) return jsonError("The analysis session was not found.", 404);

  const videoResult = await env.DB.prepare(
    "SELECT id, role, object_key FROM videos WHERE session_id = ? AND deleted_at IS NULL ORDER BY role",
  ).bind(sessionId).all<VideoRow>();
  const videos = videoResult.results ?? [];
  if (videos.length !== 2 || new Set(videos.map((video) => video.role)).size !== 2) {
    return jsonError("The session needs one uploaded reference and rider video.", 409);
  }
  const stored = await Promise.all(videos.map((video) => env.VIDEOS.head(video.object_key)));
  if (stored.some((object) => object === null)) return jsonError("Finish both video uploads before starting analysis.", 409);

  const existing = await env.DB.prepare(
    "SELECT id, status, stage FROM analysis_runs WHERE session_id = ? AND status != 'failed' ORDER BY created_at DESC LIMIT 1",
  ).bind(sessionId).first<ExistingRun>();
  if (existing) {
    let stage = existing.stage;
    if (existing.status === "needs_rider") {
      if (!(await selectionIsValid(existing.id, selectedTrackIds))) {
        return jsonError("Choose one visible rider for each ambiguous video.", 400);
      }
      await env.DB.prepare(
        "UPDATE analysis_runs SET status = 'queued', stage = 'dispatching', error_code = NULL, completed_at = NULL, updated_at = ? WHERE id = ?",
      ).bind(new Date().toISOString(), existing.id).run();
      stage = await dispatchToWorker(request, existing.id, session, videos, selectedTrackIds);
      await env.DB.prepare("UPDATE analysis_runs SET stage = ?, updated_at = ? WHERE id = ?")
        .bind(stage, new Date().toISOString(), existing.id)
        .run();
      return Response.json({ analysisRunId: existing.id, status: "queued", stage, reused: true }, { status: 202, headers: { "cache-control": "no-store" } });
    }
    if (existing.status === "queued" && stage !== "worker_dispatched") {
      stage = await dispatchToWorker(request, existing.id, session, videos);
      await env.DB.prepare("UPDATE analysis_runs SET stage = ?, updated_at = ? WHERE id = ?")
        .bind(stage, new Date().toISOString(), existing.id)
        .run();
    }
    return Response.json({ analysisRunId: existing.id, status: existing.status, stage, reused: true }, { headers: { "cache-control": "no-store" } });
  }

  const analysisRunId = `run_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO analysis_runs (id, session_id, status, stage, pipeline_version, model_version, started_at, created_at, updated_at)
         VALUES (?, ?, 'queued', 'dispatching', 'video-intelligence-v1.0', 'mediapipe-pose-landmarker-lite', ?, ?, ?)`,
      ).bind(analysisRunId, sessionId, now, now, now),
      env.DB.prepare("UPDATE sessions SET status = 'processing', updated_at = ? WHERE id = ?").bind(now, sessionId),
    ]);
  } catch (error) {
    console.error("analysis_queue_failed", error);
    return jsonError("The analysis job could not be queued.", 500);
  }

  const stage = await dispatchToWorker(request, analysisRunId, session, videos);
  await env.DB.prepare("UPDATE analysis_runs SET stage = ?, updated_at = ? WHERE id = ?")
    .bind(stage, new Date().toISOString(), analysisRunId)
    .run();

  return Response.json({
    analysisRunId,
    status: "queued",
    stage,
    statusUrl: `/api/sessions/${sessionId}`,
  }, { status: 202, headers: { "cache-control": "no-store" } });
}
