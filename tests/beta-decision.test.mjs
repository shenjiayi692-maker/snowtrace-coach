import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../lib/beta-decision.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { buildBetaDecision } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

const goInput = {
  participants: 20,
  ridersWithMaturedSevenDayWindow: 20,
  ridersWithBothUploads: 16,
  ridersWithActionableState: 14,
  ridersWithSecondSessionWithin7Days: 8,
  acceptedEvidenceRuns: 14,
  reviewCount: 14,
  clarityResponses: 14,
  helpfulResponses: 14,
  drillResponses: 14,
  metricDirectionPlausiblePct: 80,
  evidenceSeenOrPartlyPct: 70,
  helpfulOrPartlyPct: 70,
  drillIntentYesPct: 60,
  materialOrCriticalClaims: 0,
};

test("withholds a beta decision until cohort, follow-up and review evidence are complete", () => {
  const decision = buildBetaDecision({ ...goInput, participants: 19, reviewCount: 12 });
  assert.equal(decision.status, "collecting");
  assert.equal(decision.eligible, false);
  assert.ok(decision.blockers.includes("1 more enrolled riders"));
  assert.ok(decision.blockers.includes("2 instructor reviews"));
  assert.ok(decision.gates.every((gate) => gate.status === "pending"));
});

test("returns go only when every product gate clears its go threshold", () => {
  const decision = buildBetaDecision(goInput);
  assert.equal(decision.status, "go");
  assert.equal(decision.eligible, true);
  assert.ok(decision.gates.every((gate) => gate.status === "go"));
});

test("separates iterate-range evidence from a stop-range result", () => {
  const iterate = buildBetaDecision({
    ...goInput,
    ridersWithBothUploads: 14,
    ridersWithActionableState: 12,
    ridersWithSecondSessionWithin7Days: 6,
    metricDirectionPlausiblePct: 72,
    evidenceSeenOrPartlyPct: 62,
    helpfulOrPartlyPct: 61,
    drillIntentYesPct: 50,
  });
  assert.equal(iterate.status, "iterate");
  assert.ok(iterate.gates.every((gate) => gate.status === "iterate"));

  const stop = buildBetaDecision({ ...goInput, ridersWithSecondSessionWithin7Days: 4 });
  assert.equal(stop.status, "stop");
  assert.equal(stop.gates.find((gate) => gate.id === "seven_day_repeat").status, "stop");
});

test("a material claim triggers an immediate stop before the cohort is complete", () => {
  const decision = buildBetaDecision({ ...goInput, participants: 3, materialOrCriticalClaims: 1 });
  assert.equal(decision.status, "stop");
  assert.equal(decision.eligible, false);
  assert.equal(decision.immediateSafetyStop, true);
});
