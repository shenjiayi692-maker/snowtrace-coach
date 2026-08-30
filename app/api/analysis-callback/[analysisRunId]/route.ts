import { env } from "cloudflare:workers";
import { jsonError } from "../../../../lib/session-contract";
import { readBearerToken, secureTokenMatches } from "../../../../lib/secure-token";

export const dynamic = "force-dynamic";

type PairStatus = "completed" | "needs_rider" | "rejected" | "failed";
type CallbackBody = {
  analysis_id: string;
  status: PairStatus;
  evidence?: unknown[];
  error?: string;
  reference?: unknown;
  rider?: unknown;
};

type RunRow = { id: string; session_id: string };

const metricIds = new Set([
  "knee_flexion_lead",
  "knee_flexion_trail",
  "pelvis_height",
  "projected_inclination",
  "fore_aft_pelvis",
  "upper_lower_separation",
  "lead_trail_differential",
]);

function finiteNumber(value: unknown, min: number, max: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function sanitizePoseSnapshot(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const snapshot = value as Record<string, unknown>;
  if (!finiteNumber(snapshot.timestamp_ms, 0, 300_000) || !Array.isArray(snapshot.landmarks) || snapshot.landmarks.length !== 33) {
    return null;
  }
  const landmarks = snapshot.landmarks.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const point = value as Record<string, unknown>;
    if (!finiteNumber(point.x, 0, 1) || !finiteNumber(point.y, 0, 1) || !finiteNumber(point.visibility, 0, 1)) return [];
    return [{ x: point.x, y: point.y, visibility: point.visibility }];
  });
  if (landmarks.length !== 33) return null;
  return { timestamp_ms: snapshot.timestamp_ms, landmarks };
}

function sanitizeEvidence(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (
    typeof item.metric_id !== "string" || !metricIds.has(item.metric_id) ||
    !Number.isInteger(item.rank) || !finiteNumber(item.rank, 1, 20) ||
    !["initiation", "shaping", "apex", "completion"].includes(String(item.phase)) ||
    !finiteNumber(item.confidence, 0, 1) || !finiteNumber(item.effect_size, 0, 100) ||
    !finiteNumber(item.reference_timestamp_ms, 0, 300_000) || !finiteNumber(item.user_timestamp_ms, 0, 300_000) ||
    !finiteNumber(item.reference_value, -10_000, 10_000) || !finiteNumber(item.user_value, -10_000, 10_000) ||
    !finiteNumber(item.difference, -10_000, 10_000) ||
    typeof item.unit !== "string" || item.unit.length > 40 ||
    !Number.isInteger(item.paired_turns) || !finiteNumber(item.paired_turns, 1, 50)
  ) return null;

  const referencePose = item.reference_pose == null ? null : sanitizePoseSnapshot(item.reference_pose);
  const userPose = item.user_pose == null ? null : sanitizePoseSnapshot(item.user_pose);
  if ((item.reference_pose != null && !referencePose) || (item.user_pose != null && !userPose)) return null;
  return {
    metric_id: item.metric_id,
    rank: item.rank,
    phase: item.phase,
    confidence: item.confidence,
    effect_size: item.effect_size,
    reference_timestamp_ms: item.reference_timestamp_ms,
    user_timestamp_ms: item.user_timestamp_ms,
    reference_value: item.reference_value,
    user_value: item.user_value,
    difference: item.difference,
    unit: item.unit,
    paired_turns: item.paired_turns,
    reference_pose: referencePose,
    user_pose: userPose,
  };
}

export async function POST(request: Request, context: { params: Promise<{ analysisRunId: string }> }) {
  const { analysisRunId } = await context.params;
  const receivedToken = readBearerToken(request);
  if (!env.ANALYSIS_SERVICE_TOKEN) return jsonError("The analysis callback is not configured.", 503);
  if (!receivedToken || !(await secureTokenMatches(receivedToken, env.ANALYSIS_SERVICE_TOKEN))) return jsonError("The analysis callback is not authorized.", 401);
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 4 * 1024 * 1024) return jsonError("The analysis result is too large.", 413);

  let body: CallbackBody;
  try {
    body = await request.json() as CallbackBody;
  } catch {
    return jsonError("The analysis result must be valid JSON.", 400);
  }
  if (body.analysis_id !== analysisRunId || !["completed", "needs_rider", "rejected", "failed"].includes(body.status)) {
    return jsonError("The analysis result does not match this run.", 400);
  }
  const run = await env.DB.prepare("SELECT id, session_id FROM analysis_runs WHERE id = ?")
    .bind(analysisRunId)
    .first<RunRow>();
  if (!run) return jsonError("The analysis run was not found.", 404);

  const now = new Date().toISOString();
  const runStatus = body.status === "rejected" ? "failed" : body.status;
  const stage = body.status === "completed" ? "evidence_ready" : body.status;
  const sessionStatus = body.status === "completed" ? "completed" : body.status === "needs_rider" ? "processing" : "failed";
  const errorCode = body.status === "rejected" ? "quality_rejected" : body.status === "failed" ? "analysis_failed" : null;
  const evidence = (body.evidence ?? []).map(sanitizeEvidence).filter((item): item is Record<string, unknown> => item !== null);
  const statements = [
    env.DB.prepare(
      `INSERT INTO analysis_outputs (id, analysis_run_id, status, result_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(analysis_run_id) DO UPDATE SET status = excluded.status, result_json = excluded.result_json, updated_at = excluded.updated_at`,
    ).bind(`out_${analysisRunId}`, analysisRunId, body.status, JSON.stringify(body), now, now),
    env.DB.prepare(
      "UPDATE analysis_runs SET status = ?, stage = ?, error_code = ?, completed_at = ?, updated_at = ? WHERE id = ?",
    ).bind(runStatus, stage, errorCode, body.status === "needs_rider" ? null : now, now, analysisRunId),
    env.DB.prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?").bind(sessionStatus, now, run.session_id),
    env.DB.prepare("DELETE FROM comparison_evidence WHERE analysis_run_id = ?").bind(analysisRunId),
    ...evidence.map((item) => env.DB.prepare(
      `INSERT INTO comparison_evidence
        (id, analysis_run_id, metric_id, rank, confidence, effect_size, phase, user_timestamp_ms, reference_timestamp_ms, evidence_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      `ev_${crypto.randomUUID()}`,
      analysisRunId,
      item.metric_id,
      item.rank,
      item.confidence,
      item.effect_size,
      item.phase,
      item.user_timestamp_ms,
      item.reference_timestamp_ms,
      JSON.stringify(item),
    )),
  ];

  try {
    await env.DB.batch(statements);
    return Response.json({ accepted: true, status: body.status, evidenceCount: evidence.length }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("analysis_callback_failed", error);
    return jsonError("The analysis result could not be stored.", 500);
  }
}
