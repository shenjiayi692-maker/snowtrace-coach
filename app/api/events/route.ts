import { env } from "cloudflare:workers";
import { jsonError } from "../../../lib/session-contract";

export const dynamic = "force-dynamic";

const allowedEvents = new Set(["report_viewed", "show_me_clicked"]);

type EvidenceOwner = { profile_id: string };

export async function POST(request: Request) {
  let body: { sessionId?: unknown; analysisRunId?: unknown; eventType?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError("The beta event must be valid JSON.", 400);
  }
  if (
    typeof body.sessionId !== "string" || !/^ses_[A-Za-z0-9-]{20,80}$/.test(body.sessionId) ||
    typeof body.analysisRunId !== "string" || !/^run_[A-Za-z0-9-]{20,80}$/.test(body.analysisRunId) ||
    typeof body.eventType !== "string" ||
    !allowedEvents.has(body.eventType)
  ) {
    return jsonError("The beta event is invalid.", 400);
  }

  const owner = await env.DB.prepare(
    `SELECT progressions.profile_id
     FROM sessions
     JOIN progressions ON progressions.id = sessions.progression_id
     JOIN analysis_runs ON analysis_runs.session_id = sessions.id
     WHERE sessions.id = ?
       AND analysis_runs.id = ?
       AND analysis_runs.status = 'completed'
       AND EXISTS (
         SELECT 1 FROM comparison_evidence
         WHERE comparison_evidence.analysis_run_id = analysis_runs.id
       )`,
  ).bind(body.sessionId, body.analysisRunId).first<EvidenceOwner>();
  if (!owner) return jsonError("The beta event requires an evidence-backed report.", 409);

  const eventId = `evt_${body.analysisRunId}_${body.eventType}`;
  try {
    const result = await env.DB.prepare(
      `INSERT INTO feedback_events (id, profile_id, analysis_run_id, event_type, value_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(analysis_run_id, event_type) DO NOTHING`,
    ).bind(
      eventId,
      owner.profile_id,
      body.analysisRunId,
      body.eventType,
      JSON.stringify({ source: "web" }),
      new Date().toISOString(),
    ).run();
    return Response.json(
      { accepted: true, recorded: (result.meta?.changes ?? 0) > 0 },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    console.error("beta_event_store_failed", error);
    return jsonError("The beta event could not be saved.", 500);
  }
}
