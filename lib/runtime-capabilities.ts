type AnalysisRuntime = {
  ANALYSIS_SERVICE_URL?: string;
  ANALYSIS_SERVICE_TOKEN?: string;
  ANALYSIS_SIGNING_SECRET?: string;
};

export function analysisServiceConfigured(runtime: AnalysisRuntime) {
  if (!runtime.ANALYSIS_SERVICE_TOKEN || !runtime.ANALYSIS_SIGNING_SECRET) return false;
  try {
    return new URL(runtime.ANALYSIS_SERVICE_URL ?? "").protocol === "https:";
  } catch {
    return false;
  }
}
