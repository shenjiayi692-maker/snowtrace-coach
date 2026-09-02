declare namespace Cloudflare {
  interface Env {
    ASSETS: Fetcher;
    DB: D1Database;
    VIDEOS: R2Bucket;
    IMAGES: {
      input(stream: ReadableStream): {
        transform(options: Record<string, unknown>): {
          output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
        };
      };
    };
    ANALYSIS_SERVICE_URL?: string;
    ANALYSIS_SERVICE_TOKEN?: string;
    ANALYSIS_SIGNING_SECRET?: string;
    BETA_ACCESS_CODE?: string;
    BETA_METRICS_TOKEN?: string;
    BETA_OPS_TOKEN?: string;
  }
}
