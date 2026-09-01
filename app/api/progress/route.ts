import { env } from "cloudflare:workers";
import { jsonError } from "../../../lib/session-contract";

export const dynamic = "force-dynamic";

type ProgressRow = {
  goal: "medium" | "short" | "dynamic";
  camera_mode: "fixed" | "follow";
  view_angle: "three-quarter" | "side" | "front-rear";
  reference_camera_mode: "fixed" | "follow";
  reference_view_angle: "three-quarter" | "side" | "front-rear";
  rider_stance: "regular" | "goofy";
  reference_stance: "regular" | "goofy";
  recorded_at: string;
  metric_id: string;
  phase: "initiation" | "shaping" | "apex" | "completion";
  confidence: number;
  evidence_json: string;
  reference_fingerprint: string | null;
};

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value);
}

export async function POST(request: Request) {
  let body: { anonymousId?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError("The progress request must be valid JSON.", 400);
  }
  if (typeof body.anonymousId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(body.anonymousId)) {
    return jsonError("A valid anonymous rider ID is required.", 400);
  }

  const result = await env.DB.prepare(
    `SELECT
       progressions.goal,
       sessions.camera_mode,
       sessions.view_angle,
       sessions.reference_camera_mode,
       sessions.reference_view_angle,
       sessions.rider_stance,
       sessions.reference_stance,
       sessions.created_at AS recorded_at,
       comparison_evidence.metric_id,
       comparison_evidence.phase,
       comparison_evidence.confidence,
       comparison_evidence.evidence_json,
       CASE
         WHEN json_valid(reference_video.metadata_json)
         THEN json_extract(reference_video.metadata_json, '$.fingerprint')
         ELSE NULL
       END AS reference_fingerprint
     FROM profiles
     JOIN progressions ON progressions.profile_id = profiles.id
     JOIN sessions ON sessions.progression_id = progressions.id
     JOIN analysis_runs ON analysis_runs.session_id = sessions.id AND analysis_runs.status = 'completed'
     JOIN comparison_evidence ON comparison_evidence.analysis_run_id = analysis_runs.id AND comparison_evidence.rank = 1
     LEFT JOIN videos AS reference_video ON reference_video.id = progressions.reference_video_id
     WHERE profiles.anonymous_id = ?
     ORDER BY sessions.created_at DESC
     LIMIT 20`,
  ).bind(body.anonymousId).all<ProgressRow>();

  const internalHistory = (result.results ?? []).flatMap((row) => {
    try {
      const evidence = JSON.parse(row.evidence_json) as Record<string, unknown>;
      if (
        !finiteNumber(evidence.reference_value) ||
        !finiteNumber(evidence.user_value) ||
        !finiteNumber(evidence.difference) ||
        typeof evidence.unit !== "string" || evidence.unit.length > 40 ||
        !Number.isInteger(evidence.paired_turns)
      ) return [];
      return [{
        goal: row.goal,
        cameraMode: row.camera_mode,
        viewAngle: row.view_angle,
        referenceCameraMode: row.reference_camera_mode,
        referenceViewAngle: row.reference_view_angle,
        riderStance: row.rider_stance,
        referenceStance: row.reference_stance,
        recordedAt: row.recorded_at,
        metricId: row.metric_id,
        phase: row.phase,
        difference: evidence.difference,
        unit: evidence.unit,
        referenceFingerprint: typeof row.reference_fingerprint === "string" && /^[a-f0-9]{64}$/.test(row.reference_fingerprint)
          ? row.reference_fingerprint
          : null,
      }];
    } catch {
      return [];
    }
  });

  const history = internalHistory.map((item, index) => {
    const previous = item.referenceFingerprint
      ? internalHistory.slice(index + 1).find((candidate) =>
        candidate.referenceFingerprint === item.referenceFingerprint &&
        candidate.goal === item.goal &&
        candidate.cameraMode === item.cameraMode &&
        candidate.viewAngle === item.viewAngle &&
        candidate.referenceCameraMode === item.referenceCameraMode &&
        candidate.referenceViewAngle === item.referenceViewAngle &&
        candidate.riderStance === item.riderStance &&
        candidate.referenceStance === item.referenceStance &&
        candidate.metricId === item.metricId &&
        candidate.phase === item.phase &&
        candidate.unit === item.unit)
      : null;
    return {
      goal: item.goal,
      recordedAt: item.recordedAt,
      metricId: item.metricId,
      phase: item.phase,
      difference: item.difference,
      unit: item.unit,
      gapChange: previous ? Math.abs(previous.difference as number) - Math.abs(item.difference as number) : null,
    };
  });

  return Response.json({ history }, { headers: { "cache-control": "private, no-store" } });
}
