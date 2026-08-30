import { env } from "cloudflare:workers";
import { jsonError } from "../../../../lib/session-contract";
import { readBearerToken, secureTokenMatches } from "../../../../lib/secure-token";

export const dynamic = "force-dynamic";

type VideoRow = { session_id: string; object_key: string };
type StatusRow = { status: string; count: number };
type FeedbackRow = { event_type: string; value_json: string; count: number };

function ratio(numerator: number, denominator: number) {
  return denominator ? Math.round((numerator / denominator) * 1000) / 10 : 0;
}

export async function GET(request: Request) {
  if (!env.BETA_METRICS_TOKEN) return jsonError("Beta metrics are not configured.", 503);
  const received = readBearerToken(request);
  if (!received || !(await secureTokenMatches(received, env.BETA_METRICS_TOKEN))) return jsonError("Beta metrics are not authorized.", 401);
  const sessionCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first<{ count: number }>();
  const participantCount = await env.DB.prepare(
    "SELECT COUNT(DISTINCT progressions.profile_id) AS count FROM sessions JOIN progressions ON progressions.id = sessions.progression_id",
  ).first<{ count: number }>();
  const repeatCount = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM (
       SELECT progressions.profile_id
       FROM sessions JOIN progressions ON progressions.id = sessions.progression_id
       GROUP BY progressions.profile_id
       HAVING COUNT(*) >= 2 AND julianday(MAX(sessions.created_at)) - julianday(MIN(sessions.created_at)) <= 7
     )`,
  ).first<{ count: number }>();
  const videos = await env.DB.prepare("SELECT session_id, object_key FROM videos WHERE deleted_at IS NULL")
    .all<VideoRow>();
  const uploadedBySession = new Map<string, number>();
  await Promise.all((videos.results ?? []).map(async (video) => {
    if (await env.VIDEOS.head(video.object_key)) uploadedBySession.set(video.session_id, (uploadedBySession.get(video.session_id) ?? 0) + 1);
  }));
  const sessionsWithBothUploads = [...uploadedBySession.values()].filter((count) => count >= 2).length;

  const statusRows = await env.DB.prepare("SELECT status, COUNT(*) AS count FROM analysis_runs GROUP BY status").all<StatusRow>();
  const statuses = Object.fromEntries((statusRows.results ?? []).map((row) => [row.status, Number(row.count)]));
  const feedbackRows = await env.DB.prepare(
    "SELECT event_type, value_json, COUNT(*) AS count FROM feedback_events GROUP BY event_type, value_json",
  ).all<FeedbackRow>();
  const feedback = Object.fromEntries((feedbackRows.results ?? []).map((row) => {
    const answer = (JSON.parse(row.value_json) as { answer: string }).answer;
    return [`${row.event_type}:${answer}`, Number(row.count)];
  }));

  const sessionsCreated = Number(sessionCount?.count ?? 0);
  const participants = Number(participantCount?.count ?? 0);
  const ridersWithSecondSessionWithin7Days = Number(repeatCount?.count ?? 0);
  const completedReports = Number(statuses.completed ?? 0);
  const useful = Number(feedback["report_helpfulness:yes"] ?? 0) + Number(feedback["report_helpfulness:partly"] ?? 0);
  const helpfulResponses = useful + Number(feedback["report_helpfulness:no"] ?? 0);
  const drillYes = Number(feedback["drill_intent:yes"] ?? 0);
  const drillResponses = drillYes + Number(feedback["drill_intent:maybe"] ?? 0) + Number(feedback["drill_intent:no"] ?? 0);

  return Response.json({
    generatedAt: new Date().toISOString(),
    funnel: {
      sessionsCreated,
      participants,
      sessionsWithBothUploads,
      completedReports,
      ridersWithSecondSessionWithin7Days,
      uploadCompletionRatePct: ratio(sessionsWithBothUploads, sessionsCreated),
      reportCompletionRatePct: ratio(completedReports, sessionsWithBothUploads),
      sevenDayRepeatRatePct: ratio(ridersWithSecondSessionWithin7Days, participants),
    },
    quality: {
      needsRider: Number(statuses.needs_rider ?? 0),
      failedOrRejected: Number(statuses.failed ?? 0),
      queued: Number(statuses.queued ?? 0),
    },
    coaching: {
      helpfulOrPartlyPct: ratio(useful, helpfulResponses),
      drillIntentYesPct: ratio(drillYes, drillResponses),
      responseCount: helpfulResponses,
    },
    raw: { statuses, feedback },
  }, { headers: { "cache-control": "private, no-store" } });
}
