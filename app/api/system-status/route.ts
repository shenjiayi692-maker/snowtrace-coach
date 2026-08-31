import { env } from "cloudflare:workers";
import { analysisServiceConfigured } from "../../../lib/runtime-capabilities";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    analysisAvailable: analysisServiceConfigured(env),
    productScope: "snowboard_carving",
    pipelineVersion: "video-intelligence-v0.3",
  }, { headers: { "cache-control": "no-store" } });
}
