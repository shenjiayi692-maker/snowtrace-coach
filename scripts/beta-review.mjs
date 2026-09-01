const siteUrl = (process.env.SNOWTRACE_SITE_URL ?? "https://snowtrace-coach.sjysjy.chatgpt.site").replace(/\/$/, "");
const token = process.env.BETA_METRICS_TOKEN;
const [command, ...arguments_] = process.argv.slice(2);

function usage() {
  console.error(`Usage:
  BETA_METRICS_TOKEN=... node scripts/beta-review.mjs list
  BETA_METRICS_TOKEN=... node scripts/beta-review.mjs submit RUN_ID PHASE METRIC EXPLANATION DRILL SEVERITY

Values:
  PHASE       yes | partly | no
  METRIC      yes | uncertain | no
  EXPLANATION supported | minor-overreach | material-overreach | safety-critical
  DRILL       safe-relevant | safe-not-relevant | unsafe
  SEVERITY    none | minor | material | safety-critical`);
  process.exitCode = 2;
}

async function request(path, init = {}) {
  const response = await fetch(`${siteUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Request failed with ${response.status}`);
  return body;
}

if (!token) {
  console.error("Set BETA_METRICS_TOKEN in the shell; never paste it into a URL.");
  process.exitCode = 2;
} else if (command === "list" && arguments_.length === 0) {
  const result = await request("/api/beta/reviews");
  const pending = result.items.filter((item) => item.review === null);
  console.log(`${pending.length} pending of ${result.items.length} evidence-backed runs returned.`);
  for (const item of pending) {
    console.log(`\n${item.analysisRunId} · ${item.createdAt}`);
    console.log(`${item.evidence.edgeType} ${item.evidence.phase} · ${item.evidence.metricId} · confidence ${item.evidence.confidence}`);
    console.log(`Reference @ ${(item.evidence.referenceTimestampMs / 1000).toFixed(2)}s: ${item.media.referenceUrl ?? "source expired"}`);
    console.log(`Rider @ ${(item.evidence.riderTimestampMs / 1000).toFixed(2)}s: ${item.media.riderUrl ?? "source expired"}`);
  }
} else if (command === "submit" && arguments_.length === 6) {
  const [analysisRunId, phaseInspectable, metricDirectionPlausible, explanationAssessment, drillAssessment, misleadingSeverity] = arguments_;
  const result = await request("/api/beta/reviews", {
    method: "POST",
    body: JSON.stringify({
      analysisRunId,
      phaseInspectable,
      metricDirectionPlausible,
      explanationAssessment,
      drillAssessment,
      misleadingSeverity,
    }),
  });
  console.log(`Saved instructor review for ${result.analysisRunId}.`);
} else {
  usage();
}
