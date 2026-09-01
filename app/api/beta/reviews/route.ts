import { env } from "cloudflare:workers";
import { signedMediaUrl } from "../../../../lib/analysis-signing";
import { jsonError } from "../../../../lib/session-contract";
import { readBearerToken, secureTokenMatches } from "../../../../lib/secure-token";

export const dynamic = "force-dynamic";

const allowed = {
  phaseInspectable: new Set(["yes", "partly", "no"]),
  metricDirectionPlausible: new Set(["yes", "uncertain", "no"]),
  explanationAssessment: new Set(["supported", "minor-overreach", "material-overreach", "safety-critical"]),
  drillAssessment: new Set(["safe-relevant", "safe-not-relevant", "unsafe"]),
  misleadingSeverity: new Set(["none", "minor", "material", "safety-critical"]),
} as const;

type ReviewValue = {
  phaseInspectable: "yes" | "partly" | "no";
  metricDirectionPlausible: "yes" | "uncertain" | "no";
  explanationAssessment: "supported" | "minor-overreach" | "material-overreach" | "safety-critical";
  drillAssessment: "safe-relevant" | "safe-not-relevant" | "unsafe";
  misleadingSeverity: "none" | "minor" | "material" | "safety-critical";
};

type ReviewRow = {
  analysis_run_id: string;
  session_id: string;
  created_at: string;
  metric_id: string;
  edge_type: "heelside" | "toeside";
  phase: "initiation" | "shaping" | "apex" | "completion";
  confidence: number;
  effect_size: number;
  user_timestamp_ms: number;
  reference_timestamp_ms: number;
  rider_video_id: string | null;
  reference_video_id: string | null;
  phase_inspectable: ReviewValue["phaseInspectable"] | null;
  metric_direction_plausible: ReviewValue["metricDirectionPlausible"] | null;
  explanation_assessment: ReviewValue["explanationAssessment"] | null;
  drill_assessment: ReviewValue["drillAssessment"] | null;
  misleading_severity: ReviewValue["misleadingSeverity"] | null;
  reviewed_at: string | null;
};

async function authorized(request: Request) {
  if (!env.BETA_METRICS_TOKEN) return { error: jsonError("Beta review is not configured.", 503) };
  const received = readBearerToken(request);
  if (!received || !(await secureTokenMatches(received, env.BETA_METRICS_TOKEN))) {
    return { error: jsonError("Beta review is not authorized.", 401) };
  }
  return { error: null };
}

export async function GET(request: Request) {
  const auth = await authorized(request);
  if (auth.error) return auth.error;
  if (!env.ANALYSIS_SIGNING_SECRET) return jsonError("Beta review media is not configured.", 503);

  const rows = await env.DB.prepare(
    `SELECT
       analysis_runs.id AS analysis_run_id,
       analysis_runs.session_id,
       analysis_runs.created_at,
       comparison_evidence.metric_id,
       comparison_evidence.edge_type,
       comparison_evidence.phase,
       comparison_evidence.confidence,
       comparison_evidence.effect_size,
       comparison_evidence.user_timestamp_ms,
       comparison_evidence.reference_timestamp_ms,
       rider_video.id AS rider_video_id,
       reference_video.id AS reference_video_id,
       instructor_reviews.phase_inspectable,
       instructor_reviews.metric_direction_plausible,
       instructor_reviews.explanation_assessment,
       instructor_reviews.drill_assessment,
       instructor_reviews.misleading_severity,
       instructor_reviews.updated_at AS reviewed_at
     FROM analysis_runs
     JOIN comparison_evidence
       ON comparison_evidence.analysis_run_id = analysis_runs.id
      AND comparison_evidence.rank = 1
     LEFT JOIN videos AS rider_video
       ON rider_video.session_id = analysis_runs.session_id
      AND rider_video.role = 'rider'
      AND rider_video.deleted_at IS NULL
     LEFT JOIN videos AS reference_video
       ON reference_video.session_id = analysis_runs.session_id
      AND reference_video.role = 'reference'
      AND reference_video.deleted_at IS NULL
     LEFT JOIN instructor_reviews ON instructor_reviews.analysis_run_id = analysis_runs.id
     WHERE analysis_runs.status = 'completed'
     ORDER BY instructor_reviews.updated_at IS NULL DESC, analysis_runs.created_at DESC
     LIMIT 50`,
  ).all<ReviewRow>();

  const origin = new URL(request.url).origin;
  const expires = Math.floor(Date.now() / 1000) + 30 * 60;
  const items = await Promise.all((rows.results ?? []).map(async (row) => {
    const sourceUrl = async (videoId: string | null) => videoId
      ? signedMediaUrl(origin, env.ANALYSIS_SIGNING_SECRET, {
        method: "GET",
        videoId,
        analysisRunId: row.analysis_run_id,
        purpose: "source",
        expires,
      })
      : null;
    return {
      analysisRunId: row.analysis_run_id,
      sessionId: row.session_id,
      createdAt: row.created_at,
      evidence: {
        metricId: row.metric_id,
        edgeType: row.edge_type,
        phase: row.phase,
        confidence: row.confidence,
        effectSize: row.effect_size,
        riderTimestampMs: row.user_timestamp_ms,
        referenceTimestampMs: row.reference_timestamp_ms,
      },
      media: {
        riderUrl: await sourceUrl(row.rider_video_id),
        referenceUrl: await sourceUrl(row.reference_video_id),
        expiresAt: new Date(expires * 1000).toISOString(),
      },
      review: row.reviewed_at ? {
        phaseInspectable: row.phase_inspectable,
        metricDirectionPlausible: row.metric_direction_plausible,
        explanationAssessment: row.explanation_assessment,
        drillAssessment: row.drill_assessment,
        misleadingSeverity: row.misleading_severity,
        reviewedAt: row.reviewed_at,
      } : null,
    };
  }));

  return Response.json({ items }, { headers: { "cache-control": "private, no-store" } });
}

export async function POST(request: Request) {
  const auth = await authorized(request);
  if (auth.error) return auth.error;
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return jsonError("The instructor review must be valid JSON.", 400);
  }
  if (typeof body.analysisRunId !== "string" || !/^run_[A-Za-z0-9-]{20,80}$/.test(body.analysisRunId)) {
    return jsonError("The instructor review must identify an analysis run.", 400);
  }
  for (const [field, choices] of Object.entries(allowed)) {
    if (typeof body[field] !== "string" || !choices.has(body[field] as never)) {
      return jsonError("One or more instructor review answers are invalid.", 400);
    }
  }
  const run = await env.DB.prepare(
    `SELECT analysis_runs.id
     FROM analysis_runs
     WHERE analysis_runs.id = ?
       AND analysis_runs.status = 'completed'
       AND EXISTS (
         SELECT 1 FROM comparison_evidence
         WHERE comparison_evidence.analysis_run_id = analysis_runs.id
       )`,
  ).bind(body.analysisRunId).first<{ id: string }>();
  if (!run) return jsonError("Instructor review requires an evidence-backed completed run.", 409);

  const review = body as unknown as ReviewValue & { analysisRunId: string };
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO instructor_reviews
        (id, analysis_run_id, phase_inspectable, metric_direction_plausible, explanation_assessment,
         drill_assessment, misleading_severity, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(analysis_run_id) DO UPDATE SET
         phase_inspectable = excluded.phase_inspectable,
         metric_direction_plausible = excluded.metric_direction_plausible,
         explanation_assessment = excluded.explanation_assessment,
         drill_assessment = excluded.drill_assessment,
         misleading_severity = excluded.misleading_severity,
         updated_at = excluded.updated_at`,
    ).bind(
      `irev_${crypto.randomUUID()}`,
      review.analysisRunId,
      review.phaseInspectable,
      review.metricDirectionPlausible,
      review.explanationAssessment,
      review.drillAssessment,
      review.misleadingSeverity,
      now,
      now,
    ).run();
  } catch (error) {
    console.error("instructor_review_store_failed", error);
    return jsonError("The instructor review could not be saved.", 500);
  }

  return Response.json({ accepted: true, analysisRunId: review.analysisRunId }, {
    status: 201,
    headers: { "cache-control": "private, no-store" },
  });
}
