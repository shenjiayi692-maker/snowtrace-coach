import { env } from "cloudflare:workers";
import { buildBetaDecision } from "../../../../lib/beta-decision";
import { jsonError } from "../../../../lib/session-contract";
import { readBearerToken, secureTokenMatches } from "../../../../lib/secure-token";

export const dynamic = "force-dynamic";

type StatusRow = { status: string; count: number };
type FeedbackRow = { event_type: string; value_json: string; count: number };
type EventRow = { event_type: string; count: number };
type ReviewRow = { phase_inspectable: string; metric_direction_plausible: string; drill_assessment: string; misleading_severity: string; count: number };
type ErrorRow = { error_code: string | null; count: number };
type LatencyRow = { duration_minutes: number };
type OutputRow = { result_json: string };

function ratio(numerator: number, denominator: number) {
  return denominator ? Math.round((numerator / denominator) * 1000) / 10 : 0;
}

function median(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return Math.round(value * 10) / 10;
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
  const riderUploadCount = await env.DB.prepare(
    `SELECT COUNT(DISTINCT progressions.profile_id) AS count
     FROM sessions
     JOIN progressions ON progressions.id = sessions.progression_id
     WHERE EXISTS (
       SELECT 1
       FROM videos
       WHERE videos.session_id = sessions.id
         AND videos.uploaded_at IS NOT NULL
       GROUP BY videos.session_id
       HAVING COUNT(DISTINCT videos.role) = 2
     )`,
  ).first<{ count: number }>();
  const acceptedEvidenceCount = await env.DB.prepare(
    "SELECT COUNT(DISTINCT analysis_run_id) AS count FROM comparison_evidence",
  ).first<{ count: number }>();
  const actionableRiderCount = await env.DB.prepare(
    `SELECT COUNT(DISTINCT progressions.profile_id) AS count
     FROM sessions
     JOIN progressions ON progressions.id = sessions.progression_id
     WHERE EXISTS (
       SELECT 1
       FROM analysis_runs
       WHERE analysis_runs.session_id = sessions.id
         AND (
           analysis_runs.status = 'needs_rider'
           OR EXISTS (
             SELECT 1 FROM comparison_evidence
             WHERE comparison_evidence.analysis_run_id = analysis_runs.id
           )
         )
     )`,
  ).first<{ count: number }>();
  const observedFollowUpCount = await env.DB.prepare(
    `SELECT COUNT(*) AS count
     FROM (
       SELECT progressions.profile_id, MIN(sessions.created_at) AS first_session_at
       FROM sessions
       JOIN progressions ON progressions.id = sessions.progression_id
       GROUP BY progressions.profile_id
     )
     WHERE julianday(first_session_at) <= julianday('now') - 7`,
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
  const reviewRows = await env.DB.prepare(
    `SELECT phase_inspectable, metric_direction_plausible, drill_assessment, misleading_severity, COUNT(*) AS count
     FROM instructor_reviews
     GROUP BY phase_inspectable, metric_direction_plausible, drill_assessment, misleading_severity`,
  ).all<ReviewRow>();
  const reviews = Object.fromEntries((reviewRows.results ?? []).map((row) => [
    [row.phase_inspectable, row.metric_direction_plausible, row.drill_assessment, row.misleading_severity].join(":"),
    Number(row.count),
  ]));
  const errorRows = await env.DB.prepare(
    "SELECT error_code, COUNT(*) AS count FROM analysis_runs WHERE status = 'failed' GROUP BY error_code",
  ).all<ErrorRow>();
  const errors = Object.fromEntries((errorRows.results ?? []).map((row) => [row.error_code ?? "unknown", Number(row.count)]));
  const technicalFailureCount = await env.DB.prepare(
    `SELECT COUNT(DISTINCT session_id) AS count
     FROM analysis_runs
     WHERE status = 'failed' AND COALESCE(error_code, 'unknown') != 'quality_rejected'`,
  ).first<{ count: number }>();
  const latencyRows = await env.DB.prepare(
    `WITH both_uploads AS (
       SELECT session_id, MAX(uploaded_at) AS completed_upload_at
       FROM videos
       WHERE uploaded_at IS NOT NULL
       GROUP BY session_id
       HAVING COUNT(DISTINCT role) = 2
     )
     SELECT (julianday(analysis_runs.completed_at) - julianday(both_uploads.completed_upload_at)) * 1440.0 AS duration_minutes
     FROM analysis_runs
     JOIN both_uploads ON both_uploads.session_id = analysis_runs.session_id
     WHERE analysis_runs.completed_at IS NOT NULL
       AND julianday(analysis_runs.completed_at) >= julianday(both_uploads.completed_upload_at)`,
  ).all<LatencyRow>();
  const rejectedOutputs = await env.DB.prepare(
    "SELECT result_json FROM analysis_outputs WHERE status = 'rejected'",
  ).all<OutputRow>();

  const sessionsCreated = Number(sessionCount?.count ?? 0);
  const participants = Number(participantCount?.count ?? 0);
  const sessionsWithBothUploads = Number(uploadCount?.count ?? 0);
  const ridersWithBothUploads = Number(riderUploadCount?.count ?? 0);
  const ridersWithSecondSessionWithin7Days = Number(repeatCount?.count ?? 0);
  const acceptedEvidenceRuns = Number(acceptedEvidenceCount?.count ?? 0);
  const needsRiderCurrent = Number(statuses.needs_rider ?? 0);
  const actionableEvidenceOrRider = acceptedEvidenceRuns + needsRiderCurrent;
  const ridersWithActionableState = Number(actionableRiderCount?.count ?? 0);
  const ridersWithMaturedSevenDayWindow = Number(observedFollowUpCount?.count ?? 0);
  const reportsViewed = Number(events.report_viewed ?? 0);
  const showMeClicked = Number(events.show_me_clicked ?? 0);
  const useful = Number(feedback["report_helpfulness:yes"] ?? 0) + Number(feedback["report_helpfulness:partly"] ?? 0);
  const helpfulResponses = useful + Number(feedback["report_helpfulness:no"] ?? 0);
  const drillYes = Number(feedback["drill_intent:yes"] ?? 0);
  const drillResponses = drillYes + Number(feedback["drill_intent:maybe"] ?? 0) + Number(feedback["drill_intent:no"] ?? 0);
  const clarityYes = Number(feedback["evidence_clarity:yes"] ?? 0);
  const claritySeen = clarityYes + Number(feedback["evidence_clarity:partly"] ?? 0);
  const clarityResponses = claritySeen + Number(feedback["evidence_clarity:no"] ?? 0);
  const reviewCount = Object.values(reviews).reduce((total, count) => total + count, 0);
  const plausibleReviews = (reviewRows.results ?? []).filter((row) => row.metric_direction_plausible === "yes")
    .reduce((total, row) => total + Number(row.count), 0);
  const inspectableReviews = (reviewRows.results ?? []).filter((row) => row.phase_inspectable !== "no")
    .reduce((total, row) => total + Number(row.count), 0);
  const safeRelevantReviews = (reviewRows.results ?? []).filter((row) => row.drill_assessment === "safe-relevant")
    .reduce((total, row) => total + Number(row.count), 0);
  const materialOrCritical = (reviewRows.results ?? []).filter((row) => ["material", "safety-critical"].includes(row.misleading_severity))
    .reduce((total, row) => total + Number(row.count), 0);
  const safetyCritical = (reviewRows.results ?? []).filter((row) => row.misleading_severity === "safety-critical")
    .reduce((total, row) => total + Number(row.count), 0);
  const technicalFailures = Number(technicalFailureCount?.count ?? 0);
  let rejectedClips = 0;
  let rejectedClipsWithRecapture = 0;
  for (const output of rejectedOutputs.results ?? []) {
    try {
      const result = JSON.parse(output.result_json) as Record<string, unknown>;
      for (const role of ["reference", "rider"] as const) {
        const video = result[role] as Record<string, unknown> | undefined;
        const quality = video?.quality as Record<string, unknown> | undefined;
        if (quality?.status !== "rejected") continue;
        rejectedClips += 1;
        if (Array.isArray(quality.recapture_instructions) && quality.recapture_instructions.some((item) => typeof item === "string" && item.trim())) {
          rejectedClipsWithRecapture += 1;
        }
      }
    } catch {
      // Malformed raw output is counted as lacking actionable recapture guidance.
      rejectedClips += 1;
    }
  }

  const decision = buildBetaDecision({
    participants,
    ridersWithMaturedSevenDayWindow,
    ridersWithBothUploads,
    ridersWithActionableState,
    ridersWithSecondSessionWithin7Days,
    acceptedEvidenceRuns,
    reviewCount,
    clarityResponses,
    helpfulResponses,
    drillResponses,
    metricDirectionPlausiblePct: ratio(plausibleReviews, reviewCount),
    evidenceSeenOrPartlyPct: ratio(claritySeen, clarityResponses),
    helpfulOrPartlyPct: ratio(useful, helpfulResponses),
    drillIntentYesPct: ratio(drillYes, drillResponses),
    materialOrCriticalClaims: materialOrCritical,
  });

  return Response.json({
    generatedAt: new Date().toISOString(),
    funnel: {
      sessionsCreated,
      participants,
      sessionsWithBothUploads,
      ridersWithBothUploads,
      acceptedEvidenceRuns,
      actionableEvidenceOrRider,
      ridersWithActionableState,
      reportsViewed,
      showMeClicked,
      ridersWithSecondSessionWithin7Days,
      ridersWithMaturedSevenDayWindow,
      uploadCompletionRatePct: ratio(sessionsWithBothUploads, sessionsCreated),
      actionableStateRatePct: ratio(actionableEvidenceOrRider, sessionsWithBothUploads),
      reportCompletionRatePct: ratio(reportsViewed, acceptedEvidenceRuns),
      showMeEngagementRatePct: ratio(showMeClicked, reportsViewed),
      sevenDayRepeatRatePct: ratio(ridersWithSecondSessionWithin7Days, participants),
    },
    quality: {
      needsRider: needsRiderCurrent,
      failedOrRejected: Number(statuses.failed ?? 0),
      qualityRejected: Number(errors.quality_rejected ?? 0),
      technicalFailures,
      technicalFailureRatePct: ratio(technicalFailures, sessionsWithBothUploads),
      queued: Number(statuses.queued ?? 0),
      medianUploadToTerminalMinutes: median((latencyRows.results ?? []).map((row) => Number(row.duration_minutes))),
      rejectedClips,
      rejectedClipsWithRecapture,
      recaptureCoveragePct: rejectedClips ? ratio(rejectedClipsWithRecapture, rejectedClips) : null,
    },
    coaching: {
      helpfulOrPartlyPct: ratio(useful, helpfulResponses),
      helpfulnessResponseCount: helpfulResponses,
      evidenceClearlySeenPct: ratio(clarityYes, clarityResponses),
      evidenceSeenOrPartlyPct: ratio(claritySeen, clarityResponses),
      evidenceClarityResponseCount: clarityResponses,
      drillIntentYesPct: ratio(drillYes, drillResponses),
      drillIntentResponseCount: drillResponses,
      responseCount: helpfulResponses,
    },
    instructorReview: {
      reviewedRuns: reviewCount,
      reviewCoveragePct: ratio(reviewCount, acceptedEvidenceRuns),
      metricDirectionPlausiblePct: ratio(plausibleReviews, reviewCount),
      phaseInspectableOrPartlyPct: ratio(inspectableReviews, reviewCount),
      safeRelevantDrillPct: ratio(safeRelevantReviews, reviewCount),
      materialOrSafetyCriticalClaims: materialOrCritical,
      safetyCriticalClaims: safetyCritical,
    },
    decision,
    raw: { statuses, feedback, events, reviews, errors },
  }, { headers: { "cache-control": "private, no-store" } });
}
