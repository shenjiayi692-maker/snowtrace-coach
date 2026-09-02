import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../lib/coaching.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const coaching = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

const expectedDrills = {
  knee_flexion_lead: "progressive-flexion-v1",
  knee_flexion_trail: "progressive-flexion-v1",
  pelvis_height: "progressive-flexion-v1",
  projected_inclination: "quiet-torso-v1",
  fore_aft_pelvis: "centered-corridor-v1",
  upper_lower_separation: "quiet-torso-v1",
  lead_trail_differential: "progressive-flexion-v1",
};

test("renders every allowed metric into one versioned cautious coaching contract", () => {
  for (const [metricId, drillId] of Object.entries(expectedDrills)) {
    const report = coaching.buildCoachingReport({
      metricId,
      edgeType: "toeside",
      phase: "shaping",
      difference: 12.5,
      unit: metricId === "pelvis_height" ? "torso_lengths" : "degrees",
      pairedTurns: 3,
    });
    assert.equal(report.schemaVersion, "coach-report-v1");
    assert.equal(report.rendererVersion, "deterministic-coach-v1");
    assert.equal(report.drillLibraryVersion, "carving-drills-v1");
    assert.equal(report.metricId, metricId);
    assert.equal(report.edgeType, "toeside");
    assert.equal(report.phase, "shaping");
    assert.equal(report.drill.id, drillId);
    assert.equal(report.drill.steps.length, 3);
    assert.equal(coaching.isCoachingView(report), true);
    assert.match(`${report.title} ${report.explanation}`, /may|cannot|not a true|rather than/i);
    assert.doesNotMatch(`${report.title} ${report.explanation}`, /you (?:are|must be) applying|your edge angle is|this proves|you are unbalanced/i);
  }
});

test("rejects unsupported metrics and report/evidence identity drift", () => {
  assert.throws(() => coaching.buildCoachingReport({
    metricId: "exact_edge_angle",
    edgeType: "heelside",
    phase: "apex",
    difference: 20,
    unit: "degrees",
    pairedTurns: 3,
  }), /Unsupported coaching metric/);

  const report = coaching.buildCoachingReport({
    metricId: "projected_inclination",
    edgeType: "heelside",
    phase: "apex",
    difference: 10,
    unit: "degrees",
    pairedTurns: 2,
  });
  const evidence = {
    metric_id: "projected_inclination",
    edge_type: "heelside",
    phase: "completion",
    details: {},
  };
  assert.equal(coaching.isCoachingView(report, evidence), false);
  assert.equal(coaching.isCoachingView({ ...report, rendererVersion: "unversioned" }), false);
});
