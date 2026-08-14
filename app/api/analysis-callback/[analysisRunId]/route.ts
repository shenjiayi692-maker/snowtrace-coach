import { env } from "cloudflare:workers";
import { jsonError } from "../../../../lib/session-contract";

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

async function tokenMatches(received: string, expected: string) {
  const encoder = new TextEncoder();
  const [receivedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(received)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(receivedHash);
  const right = new Uint8Array(expectedHash);
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

function validEvidence(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.metric_id === "string"
    && typeof item.rank === "number"
    && ["initiation", "shaping", "apex", "completion"].includes(String(item.phase))
    && typeof item.confidence === "number"
    && typeof item.effect_size === "number"
    && typeof item.reference_timestamp_ms === "number"
    && typeof item.user_timestamp_ms === "number";
}

export async function POST(request: Request, context: { params: Promise<{ analysisRunId: string }> }) {
  const { analysisRunId } = await context.params;
  const authorization = request.headers.get("authorization");
  const receivedToken = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!env.ANALYSIS_SERVICE_TOKEN) return jsonError("The analysis callback is not configured.", 503);
  if (!receivedToken || !(await tokenMatches(receivedToken, env.ANALYSIS_SERVICE_TOKEN))) return jsonError("The analysis callback is not authorized.", 401);
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
  const evidence = (body.evidence ?? []).filter(validEvidence) as Array<Record<string, number | string>>;
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
