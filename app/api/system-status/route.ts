import { env } from "cloudflare:workers";
import { betaUploadConfigured } from "../../../lib/runtime-capabilities";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    analysisAvailable: betaUploadConfigured(env),
    betaAccessRequired: true,
    productScope: "snowboard_carving",
    pipelineVersion: "video-intelligence-v1.0",
  }, { headers: { "cache-control": "no-store" } });
}
