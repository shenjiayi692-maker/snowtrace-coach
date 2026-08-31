import { env } from "cloudflare:workers";
import { jsonError } from "../../../../lib/session-contract";
import { readBearerToken, secureTokenMatches } from "../../../../lib/secure-token";

export const dynamic = "force-dynamic";

type StatusRow = { status: string; count: number };
type FeedbackRow = { event_type: string; value_json: string; count: number };
type EventRow = { event_type: string; count: number };

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
    `WITH completed_uploads AS (
       SELECT progressions.profile_id, sessions.id AS session_id, MAX(videos.uploaded_at) AS completed_at
       FROM sessions
       JOIN progressions ON progressions.id = sessions.progression_id
       JOIN videos ON videos.session_id = sessions.id
       WHERE videos.uploaded_at IS NOT NULL
       GROUP BY progressions.profile_id, sessions.id
       HAVING COUNT(DISTINCT videos.role) = 2
     ), first_uploads AS (
       SELECT profile_id, MIN(completed_at) AS first_completed_at
       FROM completed_uploads
       GROUP BY profile_id
     )
     SELECT COUNT(*) AS count
     FROM first_uploads
     WHERE EXISTS (
       SELECT 1 FROM completed_uploads later
       WHERE later.profile_id = first_uploads.profile_id
         AND julianday(later.completed_at) > julianday(first_uploads.first_completed_at)
         AND julianday(later.completed_at) - julianday(first_uploads.first_completed_at) <= 7
     )`,
  ).first<{ count: number }>();
  const uploadCount = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM (
       SELECT session_id
       FROM videos
       WHERE uploaded_at IS NOT NULL
       GROUP BY session_id
       HAVING COUNT(DISTINCT role) = 2
     )`,
  ).first<{ count: number }>();
  const acceptedEvidenceCount = await env.DB.prepare(
    "SELECT COUNT(DISTINCT analysis_run_id) AS count FROM comparison_evidence",
  ).first<{ count: number }>();

  const statusRows = await env.DB.prepare("SELECT status, COUNT(*) AS count FROM analysis_runs GROUP BY status").all<StatusRow>();
  const statuses = Object.fromEntries((statusRows.results ?? []).map((row) => [row.status, Number(row.count)]));
  const feedbackRows = await env.DB.prepare(
    `SELECT event_type, value_json, COUNT(*) AS count
     FROM feedback_events
     WHERE event_type IN ('report_helpfulness', 'evidence_clarity', 'drill_intent')
     GROUP BY event_type, value_json`,
  ).all<FeedbackRow>();
  const feedback = Object.fromEntries((feedbackRows.results ?? []).map((row) => {
    const answer = (JSON.parse(row.value_json) as { answer: string }).answer;
    return [`${row.event_type}:${answer}`, Number(row.count)];
  }));
  const eventRows = await env.DB.prepare(
    `SELECT event_type, COUNT(DISTINCT analysis_run_id) AS count
     FROM feedback_events
     WHERE event_type IN ('report_viewed', 'show_me_clicked')
     GROUP BY event_type`,
  ).all<EventRow>();
  const events = Object.fromEntries((eventRows.results ?? []).map((row) => [row.event_type, Number(row.count)]));

  const sessionsCreated = Number(sessionCount?.count ?? 0);
  const participants = Number(participantCount?.count ?? 0);
  const sessionsWithBothUploads = Number(uploadCount?.count ?? 0);
  const ridersWithSecondSessionWithin7Days = Number(repeatCount?.count ?? 0);
  const acceptedEvidenceRuns = Number(acceptedEvidenceCount?.count ?? 0);
  const needsRiderCurrent = Number(statuses.needs_rider ?? 0);
  const actionableEvidenceOrRider = acceptedEvidenceRuns + needsRiderCurrent;
  const reportsViewed = Number(events.report_viewed ?? 0);
  const showMeClicked = Number(events.show_me_clicked ?? 0);
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
      acceptedEvidenceRuns,
      actionableEvidenceOrRider,
      reportsViewed,
      showMeClicked,
      ridersWithSecondSessionWithin7Days,
      uploadCompletionRatePct: ratio(sessionsWithBothUploads, sessionsCreated),
      actionableStateRatePct: ratio(actionableEvidenceOrRider, sessionsWithBothUploads),
      reportCompletionRatePct: ratio(reportsViewed, acceptedEvidenceRuns),
      showMeEngagementRatePct: ratio(showMeClicked, reportsViewed),
      sevenDayRepeatRatePct: ratio(ridersWithSecondSessionWithin7Days, participants),
    },
    quality: {
      needsRider: needsRiderCurrent,
      failedOrRejected: Number(statuses.failed ?? 0),
      queued: Number(statuses.queued ?? 0),
    },
    coaching: {
      helpfulOrPartlyPct: ratio(useful, helpfulResponses),
      drillIntentYesPct: ratio(drillYes, drillResponses),
      responseCount: helpfulResponses,
    },
    raw: { statuses, feedback, events },
  }, { headers: { "cache-control": "private, no-store" } });
}
