import { env } from "cloudflare:workers";
import { jsonError, MAX_VIDEO_BYTES } from "../../../../../lib/session-contract";

export const dynamic = "force-dynamic";

type StoredVideo = {
  id: string;
  session_id: string;
  role: "reference" | "rider";
  object_key: string;
  size_bytes: number;
  content_type: string;
  expires_at: string;
};

export async function PUT(request: Request, context: { params: Promise<{ videoId: string }> }) {
  const { videoId } = await context.params;
  const sessionId = new URL(request.url).searchParams.get("session");
  if (!sessionId) return jsonError("The session ID is required.", 400);
  if (!request.body) return jsonError("The video body is empty.", 400);

  const row = await env.DB.prepare(
    `SELECT id, session_id, role, object_key, size_bytes, content_type, expires_at
     FROM videos WHERE id = ? AND session_id = ? AND deleted_at IS NULL`,
  ).bind(videoId, sessionId).first<StoredVideo>();
  if (!row) return jsonError("This video upload is not part of the session.", 404);
  if (row.size_bytes > MAX_VIDEO_BYTES) return jsonError("The video exceeds the upload limit.", 413);

  const declaredLength = request.headers.get("content-length");
  if (declaredLength && Number(declaredLength) !== row.size_bytes) {
    return jsonError("The uploaded file size does not match the inspected file.", 409);
  }
  const suppliedType = request.headers.get("content-type")?.split(";")[0].trim();
  if (!suppliedType?.startsWith("video/")) return jsonError("Upload a supported video file.", 415);
  if (suppliedType !== row.content_type) return jsonError("The uploaded video type changed after inspection.", 409);

  try {
    const object = await env.VIDEOS.put(row.object_key, request.body, {
      httpMetadata: { contentType: row.content_type },
      customMetadata: {
        videoId: row.id,
        sessionId: row.session_id,
        role: row.role,
        expiresAt: row.expires_at,
      },
    });
    if (object.size !== row.size_bytes) {
      await env.VIDEOS.delete(row.object_key);
      return jsonError("The upload was incomplete. Please try again.", 409);
    }
    await env.DB.prepare("UPDATE videos SET updated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), row.id)
      .run();
    return Response.json({ videoId: row.id, role: row.role, sizeBytes: object.size }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("video_upload_failed", error);
    return jsonError("The video could not be stored.", 500);
  }
}
