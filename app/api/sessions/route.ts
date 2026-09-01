import { env } from "cloudflare:workers";
import { analysisServiceConfigured } from "../../../lib/runtime-capabilities";
import { jsonError, parseCreateSessionInput } from "../../../lib/session-contract";
import { cleanupExpiredVideos } from "../../../lib/video-retention";

export const dynamic = "force-dynamic";

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

async function stableProfileId(anonymousId: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(anonymousId));
  return `pro_${Array.from(new Uint8Array(digest).slice(0, 12), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("The session request must be valid JSON.", 400);
  }

  const parsed = parseCreateSessionInput(body);
  if (!parsed.ok) return jsonError(parsed.error, 400);
  if (!analysisServiceConfigured(env)) {
    return jsonError("The beta analysis worker is temporarily unavailable. No video was uploaded.", 503);
  }

  try {
    await cleanupExpiredVideos(env, new Date().toISOString(), 20);
  } catch (error) {
    console.error("opportunistic_video_cleanup_failed", error);
  }

  const input = parsed.value;
  const profileId = await stableProfileId(input.anonymousId);
  const progressionId = id("pgs");
  const sessionId = id("ses");
  const referenceVideoId = id("vid");
  const riderVideoId = id("vid");
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  const videoIds = { reference: referenceVideoId, rider: riderVideoId } as const;

  const statements = [
    env.DB.prepare(
      `INSERT INTO profiles (id, anonymous_id, locale, stance, level, consent_version, created_at, updated_at)
       VALUES (?, ?, 'en', ?, 'intermediate', ?, ?, ?)
       ON CONFLICT(anonymous_id) DO UPDATE SET
         stance = excluded.stance,
         consent_version = excluded.consent_version,
         updated_at = excluded.updated_at`,
    ).bind(profileId, input.anonymousId, input.stance, input.consent.version, now, now),
    env.DB.prepare(
      `INSERT INTO progressions (id, profile_id, goal, framework, reference_video_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'none', ?, 'active', ?, ?)`,
    ).bind(progressionId, profileId, input.goal, referenceVideoId, now, now),
    env.DB.prepare(
      `INSERT INTO sessions
        (id, progression_id, camera_mode, view_angle, reference_camera_mode, reference_view_angle, rider_stance, reference_stance, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    ).bind(
      sessionId,
      progressionId,
      input.cameraMode,
      input.viewAngle,
      input.referenceCameraMode,
      input.referenceViewAngle,
      input.stance,
      input.referenceStance,
      now,
      now,
    ),
    ...input.videos.map((video) => {
      const videoId = videoIds[video.role];
      const objectKey = `source/${profileId}/${sessionId}/${videoId}`;
      return env.DB.prepare(
        `INSERT INTO videos
          (id, session_id, role, object_key, original_name, content_type, size_bytes, duration_seconds, width, height, metadata_json, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        videoId,
        sessionId,
        video.role,
        objectKey,
        video.originalName,
        video.contentType,
        video.sizeBytes,
        video.durationSeconds,
        video.width,
        video.height,
        JSON.stringify({ browserPreflight: video.preflight, fingerprint: video.fingerprint }),
        expiresAt,
        now,
        now,
      );
    }),
  ];

  try {
    await env.DB.batch(statements);
  } catch (error) {
    console.error("session_create_failed", error);
    return jsonError("The private analysis session could not be created.", 500);
  }

  return Response.json({
    sessionId,
    progressionId,
    expiresAt,
    videos: input.videos.map((video) => {
      const videoId = videoIds[video.role];
      return {
        id: videoId,
        role: video.role,
        uploadUrl: `/api/videos/${videoId}/content?session=${encodeURIComponent(sessionId)}`,
      };
    }),
    analysisUrl: `/api/sessions/${sessionId}/analysis`,
    statusUrl: `/api/sessions/${sessionId}`,
  }, { status: 201, headers: { "cache-control": "no-store" } });
}
