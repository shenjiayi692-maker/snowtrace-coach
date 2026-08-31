import { env } from "cloudflare:workers";
import { jsonError } from "../../../lib/session-contract";

export const dynamic = "force-dynamic";

const allowedEvents = {
  report_helpfulness: new Set(["yes", "partly", "no"]),
  evidence_clarity: new Set(["yes", "partly", "no"]),
  drill_intent: new Set(["yes", "maybe", "no"]),
} as const;

type EventType = keyof typeof allowedEvents;
type FeedbackInput = { eventType: EventType; value: string };
type SessionOwner = { profile_id: string };

export async function POST(request: Request) {
  let body: { sessionId?: unknown; analysisRunId?: unknown; events?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError("Feedback must be valid JSON.", 400);
  }
  if (typeof body.sessionId !== "string" || typeof body.analysisRunId !== "string") {
    return jsonError("Feedback must identify a completed analysis.", 400);
  }
  if (!Array.isArray(body.events) || body.events.length < 1 || body.events.length > 3) {
    return jsonError("Submit one to three feedback answers.", 400);
  }
  const events = body.events as Array<Record<string, unknown>>;
  const parsed: FeedbackInput[] = [];
  for (const event of events) {
    if (typeof event.eventType !== "string" || !(event.eventType in allowedEvents) || typeof event.value !== "string") {
      return jsonError("One or more feedback answers are invalid.", 400);
    }
    const eventType = event.eventType as EventType;
    if (!allowedEvents[eventType].has(event.value as never)) return jsonError("One or more feedback answers are invalid.", 400);
    parsed.push({ eventType, value: event.value });
  }
  if (new Set(parsed.map((event) => event.eventType)).size !== parsed.length) return jsonError("Submit each feedback question once.", 400);

  const owner = await env.DB.prepare(
    `SELECT progressions.profile_id
     FROM sessions
     JOIN progressions ON progressions.id = sessions.progression_id
     JOIN analysis_runs ON analysis_runs.session_id = sessions.id
     WHERE sessions.id = ? AND analysis_runs.id = ? AND analysis_runs.status = 'completed'`,
  ).bind(body.sessionId, body.analysisRunId).first<SessionOwner>();
  if (!owner) return jsonError("Feedback is accepted only for a completed analysis.", 409);

  const now = new Date().toISOString();
  try {
    await env.DB.batch(parsed.map((event) => env.DB.prepare(
      `INSERT INTO feedback_events (id, profile_id, analysis_run_id, event_type, value_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(analysis_run_id, event_type) DO UPDATE SET value_json = excluded.value_json`,
    ).bind(`fb_${crypto.randomUUID()}`, owner.profile_id, body.analysisRunId, event.eventType, JSON.stringify({ answer: event.value }), now)));
    return Response.json({ accepted: true, count: parsed.length }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("feedback_store_failed", error);
    return jsonError("Feedback could not be saved.", 500);
  }
}
