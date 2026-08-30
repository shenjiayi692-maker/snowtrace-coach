import { env } from "cloudflare:workers";
import { jsonError } from "../../../../lib/session-contract";
import { readBearerToken, secureTokenMatches } from "../../../../lib/secure-token";
import { cleanupExpiredVideos } from "../../../../lib/video-retention";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!env.BETA_OPS_TOKEN) return jsonError("Beta operations are not configured.", 503);
  const received = readBearerToken(request);
  if (!received || !(await secureTokenMatches(received, env.BETA_OPS_TOKEN))) {
    return jsonError("Beta operations are not authorized.", 401);
  }

  let body: unknown = {};
  const rawBody = await request.text();
  if (rawBody.trim()) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      return jsonError("The cleanup request must be valid JSON.", 400);
    }
  }
  const value = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const limit = value.limit ?? 100;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 200) {
    return jsonError("Cleanup limit must be an integer from 1 to 200.", 400);
  }

  const result = await cleanupExpiredVideos(env, new Date().toISOString(), limit);
  return Response.json(result, { headers: { "cache-control": "private, no-store" } });
}
