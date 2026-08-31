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
type VideoRow = {
  id: string;
  role: "reference" | "rider";
  object_key: string;
  original_name: string;
  content_type: string;
  size_bytes: number;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  metadata_json: string | null;
  expires_at: string;
};
type EvidenceRow = { metric_id: string; rank: number; confidence: number; effect_size: number; phase: string; user_timestamp_ms: number; reference_timestamp_ms: number; evidence_json: string };
type OutputRow = { status: string; result_json: string };

type QualityCheckSnapshot = {
  id: string;
  label: string;
  score: number;
  status: "good" | "medium" | "blocked";
  detail: string;
};

type VideoQualitySnapshot = {
  role: "reference" | "rider";
  status: "full" | "limited" | "rejected";
  readiness_score: number;
  checks: QualityCheckSnapshot[];
  recapture_instructions: string[];
};

function qualitySnapshot(role: "reference" | "rider", value: unknown): VideoQualitySnapshot | null {
  if (!value || typeof value !== "object") return null;
  const video = value as Record<string, unknown>;
  const quality = video.quality;
  if (!quality || typeof quality !== "object") return null;
  const item = quality as Record<string, unknown>;
  if (!["full", "limited", "rejected"].includes(String(item.status)) || typeof item.readiness_score !== "number") return null;
  const checks = Array.isArray(item.checks) ? item.checks.flatMap((check) => {
    if (!check || typeof check !== "object") return [];
    const entry = check as Record<string, unknown>;
    if (typeof entry.id !== "string" || typeof entry.label !== "string" || typeof entry.score !== "number"
      || !["good", "medium", "blocked"].includes(String(entry.status)) || typeof entry.detail !== "string") return [];
    return [{
      id: entry.id,
      label: entry.label,
      score: Math.max(0, Math.min(100, entry.score)),
      status: entry.status as QualityCheckSnapshot["status"],
      detail: entry.detail,
    }];
  }) : [];
  const recaptureInstructions = Array.isArray(item.recapture_instructions)
    ? item.recapture_instructions.filter((instruction): instruction is string => typeof instruction === "string").slice(0, 5)
    : [];
  return {
    role,
    status: item.status as VideoQualitySnapshot["status"],
    readiness_score: Math.max(0, Math.min(100, Math.round(item.readiness_score))),
    checks,
    recapture_instructions: recaptureInstructions,
  };
}

function analysisOutcome(output: OutputRow | null, evidenceCount: number) {
  if (!output) return null;
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(output.result_json) as Record<string, unknown>;
  } catch {
    return output.status === "failed" ? {
      kind: "technical",
      title: "The analysis did not finish.",
      message: "Your clips were not used to generate coaching. Retry the job or delete the session and start again.",
      retryable: true,
      videos: [],
    } : null;
  }
  const videos = (["reference", "rider"] as const)
    .map((role) => qualitySnapshot(role, result[role]))
    .filter((video): video is VideoQualitySnapshot => video !== null);
  if (output.status === "rejected") return {
    kind: "footage",
    title: "One or both clips need a recapture.",
    message: "The pose quality gate could not support a reliable comparison, so Snowtrace did not generate coaching.",
    retryable: false,
    videos,
  };
  if (output.status === "failed") return {
    kind: "technical",
    title: "The analysis did not finish.",
    message: "Your clips were not used to generate coaching. Retry the job or delete the session and start again.",
    retryable: true,
    videos,
  };
  if (output.status === "completed" && evidenceCount === 0) return {
    kind: "no_evidence",
    title: "No reliable gap cleared the evidence threshold.",
    message: "Both clips were analyzed, but no repeatable difference was strong enough to justify a drill. That is a valid result, not a failed analysis.",
    retryable: false,
    videos,
  };
  return null;
}

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
    `SELECT id, role, object_key, original_name, content_type, size_bytes, duration_seconds, width, height, metadata_json, expires_at
     FROM videos WHERE session_id = ? AND deleted_at IS NULL`,
  ).bind(sessionId).all<VideoRow>();
  const videos = await Promise.all((videoResult.results ?? []).map(async ({ object_key, metadata_json, ...video }) => {
    let preflight: unknown = null;
    let fingerprint: string | null = null;
    try {
      const metadata = metadata_json ? JSON.parse(metadata_json) as { browserPreflight?: unknown; fingerprint?: unknown } : null;
      preflight = metadata?.browserPreflight ?? null;
      fingerprint = typeof metadata?.fingerprint === "string" && /^[a-f0-9]{64}$/.test(metadata.fingerprint)
        ? metadata.fingerprint
        : null;
    } catch {
      preflight = null;
    }
    return {
      ...video,
      preflight,
      fingerprint,
      playback_url: `/api/videos/${encodeURIComponent(video.id)}/content?session=${encodeURIComponent(sessionId)}`,
      uploaded: Boolean(await env.VIDEOS.head(object_key)),
    };
  }));
  const evidenceResult = run ? await env.DB.prepare(
    `SELECT metric_id, rank, confidence, effect_size, phase, user_timestamp_ms, reference_timestamp_ms, evidence_json
     FROM comparison_evidence WHERE analysis_run_id = ? ORDER BY rank LIMIT 3`,
  ).bind(run.id).all<EvidenceRow>() : { results: [] };
  const output = run ? await env.DB.prepare(
    "SELECT status, result_json FROM analysis_outputs WHERE analysis_run_id = ? LIMIT 1",
  ).bind(run.id).first<OutputRow>() : null;
  const evidence = (evidenceResult.results ?? []).map(({ evidence_json, ...item }) => ({
    ...item,
    details: JSON.parse(evidence_json),
  }));

  return Response.json({
    session,
    run,
    videos,
    evidence,
    action: riderSelectionAction(output),
    outcome: analysisOutcome(output, evidence.length),
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
