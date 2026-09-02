export type BetaGateStatus = "pending" | "go" | "iterate" | "stop";
export type BetaDecisionStatus = "collecting" | "go" | "iterate" | "stop";

export const BETA_COHORT_TARGET = 20;

export type BetaDecisionInput = {
  participants: number;
  ridersWithMaturedSevenDayWindow: number;
  ridersWithBothUploads: number;
  ridersWithActionableState: number;
  ridersWithSecondSessionWithin7Days: number;
  acceptedEvidenceRuns: number;
  reviewCount: number;
  clarityResponses: number;
  helpfulResponses: number;
  drillResponses: number;
  metricDirectionPlausiblePct: number;
  evidenceSeenOrPartlyPct: number;
  helpfulOrPartlyPct: number;
  drillIntentYesPct: number;
  materialOrCriticalClaims: number;
};

function minimumGate(
  id: string,
  label: string,
  value: number,
  goAtLeast: number,
  iterateAtLeast: number,
  eligible: boolean,
) {
  const status: BetaGateStatus = !eligible ? "pending" : value >= goAtLeast ? "go" : value >= iterateAtLeast ? "iterate" : "stop";
  return { id, label, value, goAtLeast, iterateAtLeast, status };
}

export function buildBetaDecision(input: BetaDecisionInput) {
  const blockers = [
    input.participants < BETA_COHORT_TARGET ? `${BETA_COHORT_TARGET - input.participants} more enrolled riders` : null,
    input.ridersWithMaturedSevenDayWindow < BETA_COHORT_TARGET
      ? `${BETA_COHORT_TARGET - input.ridersWithMaturedSevenDayWindow} more riders need a complete 7-day observation window`
      : null,
    input.reviewCount < input.acceptedEvidenceRuns ? `${input.acceptedEvidenceRuns - input.reviewCount} instructor reviews` : null,
    input.clarityResponses < input.acceptedEvidenceRuns ? `${input.acceptedEvidenceRuns - input.clarityResponses} evidence-clarity responses` : null,
    input.helpfulResponses < input.acceptedEvidenceRuns ? `${input.acceptedEvidenceRuns - input.helpfulResponses} helpfulness responses` : null,
    input.drillResponses < input.acceptedEvidenceRuns ? `${input.acceptedEvidenceRuns - input.drillResponses} drill-intent responses` : null,
  ].filter((item): item is string => item !== null);
  const eligible = blockers.length === 0;
  const gates = [
    minimumGate("upload_completion", "Riders completing both uploads", input.ridersWithBothUploads, 16, 12, eligible),
    minimumGate("actionable_state", "Riders reaching evidence or rider selection", input.ridersWithActionableState, 14, 10, eligible),
    minimumGate("metric_plausibility", "Instructor metric-direction plausibility", input.metricDirectionPlausiblePct, 80, 65, eligible),
    minimumGate("visible_gap", "Riders seeing the highlighted gap", input.evidenceSeenOrPartlyPct, 70, 50, eligible),
    minimumGate("report_usefulness", "Reports useful or partly useful", input.helpfulOrPartlyPct, 70, 50, eligible),
    minimumGate("drill_intent", "Riders saying yes to the drill", input.drillIntentYesPct, 60, 40, eligible),
    minimumGate("seven_day_repeat", "Riders uploading again within 7 days", input.ridersWithSecondSessionWithin7Days, 8, 5, eligible),
  ];
  const immediateSafetyStop = input.materialOrCriticalClaims > 0;
  const status: BetaDecisionStatus = immediateSafetyStop
    ? "stop"
    : !eligible
      ? "collecting"
      : gates.some((gate) => gate.status === "stop")
        ? "stop"
        : gates.every((gate) => gate.status === "go")
          ? "go"
          : "iterate";

  return {
    status,
    eligible,
    cohortTarget: BETA_COHORT_TARGET,
    blockers,
    immediateSafetyStop,
    gates,
    note: "A final decision is withheld until 20 riders have a full 7-day observation window and every accepted report has rider feedback plus an independent review.",
  };
}
