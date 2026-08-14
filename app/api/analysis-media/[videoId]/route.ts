import { env } from "cloudflare:workers";
import { type MediaGrant, verifyMediaGrant } from "../../../../lib/analysis-signing";
import { jsonError, MAX_VIDEO_BYTES } from "../../../../lib/session-contract";

export const dynamic = "force-dynamic";

type VideoRow = {
  id: string;
  session_id: string;
  object_key: string;
  content_type: string;
};

async function authorizedGrant(request: Request, videoId: string, method: "GET" | "PUT") {
  const url = new URL(request.url);
  const analysisRunId = url.searchParams.get("run");
  const purpose = url.searchParams.get("purpose");
  const expires = Number(url.searchParams.get("expires"));
  const signature = url.searchParams.get("sig");
  if (!analysisRunId || (purpose !== "source" && purpose !== "proxy") || !Number.isInteger(expires) || !signature) return null;
  if ((method === "GET" && purpose !== "source") || (method === "PUT" && purpose !== "proxy")) return null;
  const grant: MediaGrant = { method, videoId, analysisRunId, purpose, expires };
  if (!env.ANALYSIS_SIGNING_SECRET || !(await verifyMediaGrant(env.ANALYSIS_SIGNING_SECRET, grant, signature))) return null;
  return grant;
}

async function videoForRun(videoId: string, analysisRunId: string) {
  return env.DB.prepare(
    `SELECT videos.id, videos.session_id, videos.object_key, videos.content_type
     FROM videos JOIN analysis_runs ON analysis_runs.session_id = videos.session_id
     WHERE videos.id = ? AND analysis_runs.id = ? AND videos.deleted_at IS NULL`,
  ).bind(videoId, analysisRunId).first<VideoRow>();
}

export async function GET(request: Request, context: { params: Promise<{ videoId: string }> }) {
  const { videoId } = await context.params;
  const grant = await authorizedGrant(request, videoId, "GET");
  if (!grant) return jsonError("The media grant is invalid or expired.", 403);
  const video = await videoForRun(videoId, grant.analysisRunId);
  if (!video) return jsonError("The analysis video was not found.", 404);
  const object = await env.VIDEOS.get(video.object_key);
  if (!object) return jsonError("The source video is no longer available.", 404);
  return new Response(object.body, {
    headers: {
      "content-type": video.content_type,
      "content-length": String(object.size),
      "cache-control": "private, no-store",
      "content-disposition": `attachment; filename="${video.id}"`,
    },
  });
}

export async function PUT(request: Request, context: { params: Promise<{ videoId: string }> }) {
  const { videoId } = await context.params;
  const grant = await authorizedGrant(request, videoId, "PUT");
  if (!grant) return jsonError("The media grant is invalid or expired.", 403);
  if (!request.body) return jsonError("The proxy body is empty.", 400);
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_VIDEO_BYTES) return jsonError("The proxy exceeds the upload limit.", 413);
  if (request.headers.get("content-type")?.split(";")[0] !== "video/mp4") return jsonError("Analysis proxies must be MP4 video.", 415);
  const video = await videoForRun(videoId, grant.analysisRunId);
  if (!video) return jsonError("The analysis video was not found.", 404);
  const proxyKey = `proxy/${video.session_id}/${video.id}.mp4`;
  try {
    await env.VIDEOS.put(proxyKey, request.body, {
      httpMetadata: { contentType: "video/mp4" },
      customMetadata: { videoId: video.id, analysisRunId: grant.analysisRunId, purpose: "analysis-proxy" },
    });
    await env.DB.prepare("UPDATE videos SET proxy_object_key = ?, updated_at = ? WHERE id = ?")
      .bind(proxyKey, new Date().toISOString(), video.id)
      .run();
    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("proxy_upload_failed", error);
    return jsonError("The analysis proxy could not be stored.", 500);
  }
}
