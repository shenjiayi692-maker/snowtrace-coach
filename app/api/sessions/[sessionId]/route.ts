import { env } from "cloudflare:workers";
import { jsonError } from "../../../../lib/session-contract";

export const dynamic = "force-dynamic";

type SessionRow = {
  id: string;
  progression_id: string;
  status: string;
  camera_mode: string;
  view_angle: string;
  created_at: string;
  updated_at: string;
};

type RunRow = { id: string; status: string; stage: string | null; error_code: string | null; updated_at: string };
type VideoRow = { id: string; role: string; object_key: string; original_name: string; expires_at: string };
type EvidenceRow = { metric_id: string; rank: number; confidence: number; effect_size: number; phase: string; user_timestamp_ms: number; reference_timestamp_ms: number; evidence_json: string };
type OutputRow = { status: string; result_json: string };

function riderSelectionAction(output: OutputRow | null) {
  if (!output || output.status !== "needs_rider") return null;
  try {
    const result = JSON.parse(output.result_json) as Record<string, unknown>;
    const roles = (["reference", "rider"] as const).flatMap((role) => {
      const video = result[role] as Record<string, unknown> | undefined;
      if (!video || video.selected_track_id !== null || !Array.isArray(video.rider_candidates)) return [];
      const candidates = video.rider_candidates.filter((candidate) => {
        if (!candidate || typeof candidate !== "object") return false;
        const item = candidate as Record<string, unknown>;
        return Number.isInteger(item.track_id)
          && typeof item.score === "number"
          && typeof item.coverage === "number"
          && typeof item.representative_frame_ms === "number"
          && Array.isArray(item.representative_bbox)
          && item.representative_bbox.length === 4;
      });
      return candidates.length ? [{ role, candidates }] : [];
    });
    return roles.length ? { type: "select_rider", roles } : null;
  } catch {
    return null;
  }
}

export async function GET(_request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await context.params;
  const session = await env.DB.prepare(
    "SELECT id, progression_id, status, camera_mode, view_angle, created_at, updated_at FROM sessions WHERE id = ?",
  ).bind(sessionId).first<SessionRow>();
  if (!session) return jsonError("The analysis session was not found.", 404);

  const run = await env.DB.prepare(
    "SELECT id, status, stage, error_code, updated_at FROM analysis_runs WHERE session_id = ? ORDER BY created_at DESC LIMIT 1",
  ).bind(sessionId).first<RunRow>();
  const videoResult = await env.DB.prepare(
    "SELECT id, role, object_key, original_name, expires_at FROM videos WHERE session_id = ? AND deleted_at IS NULL",
  ).bind(sessionId).all<VideoRow>();
  const videos = await Promise.all((videoResult.results ?? []).map(async ({ object_key, ...video }) => ({
    ...video,
    uploaded: Boolean(await env.VIDEOS.head(object_key)),
  })));
  const evidenceResult = run ? await env.DB.prepare(
    `SELECT metric_id, rank, confidence, effect_size, phase, user_timestamp_ms, reference_timestamp_ms, evidence_json
     FROM comparison_evidence WHERE analysis_run_id = ? ORDER BY rank LIMIT 3`,
  ).bind(run.id).all<EvidenceRow>() : { results: [] };
  const output = run ? await env.DB.prepare(
    "SELECT status, result_json FROM analysis_outputs WHERE analysis_run_id = ? LIMIT 1",
  ).bind(run.id).first<OutputRow>() : null;

  return Response.json({
    session,
    run,
    videos,
    evidence: (evidenceResult.results ?? []).map(({ evidence_json, ...item }) => ({
      ...item,
      details: JSON.parse(evidence_json),
    })),
    action: riderSelectionAction(output),
  }, { headers: { "cache-control": "no-store" } });
}

export async function DELETE(_request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await context.params;
  const session = await env.DB.prepare("SELECT progression_id FROM sessions WHERE id = ?")
    .bind(sessionId)
    .first<{ progression_id: string }>();
  if (!session) return jsonError("The analysis session was not found.", 404);

  const videoResult = await env.DB.prepare("SELECT object_key, proxy_object_key FROM videos WHERE session_id = ?")
    .bind(sessionId)
    .all<{ object_key: string; proxy_object_key: string | null }>();
  const objectKeys = (videoResult.results ?? []).flatMap((video) => [video.object_key, video.proxy_object_key].filter(Boolean) as string[]);
  try {
    if (objectKeys.length) await env.VIDEOS.delete(objectKeys);
    await env.DB.prepare("DELETE FROM progressions WHERE id = ?").bind(session.progression_id).run();
    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("session_delete_failed", error);
    return jsonError("The private session could not be deleted.", 500);
  }
}
