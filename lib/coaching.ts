export type TurnPhase = "initiation" | "shaping" | "apex" | "completion";

export type PoseSnapshot = {
  timestamp_ms: number;
  landmarks: Array<{ x: number; y: number; visibility: number }>;
};

export type EvidenceSnapshot = {
  metric_id: string;
  edge_type: "heelside" | "toeside";
  rank: number;
  confidence: number;
  effect_size: number;
  phase: TurnPhase;
  user_timestamp_ms: number;
  reference_timestamp_ms: number;
  details: {
    reference_value: number;
    user_value: number;
    difference: number;
    unit: string;
    paired_turns: number;
    reference_pose?: PoseSnapshot | null;
    user_pose?: PoseSnapshot | null;
  };
};

export const COACHING_SCHEMA_VERSION = "coach-report-v1";
export const COACHING_RENDERER_VERSION = "deterministic-coach-v1";
export const DRILL_LIBRARY_VERSION = "carving-drills-v1";

export type Drill = {
  id: "progressive-flexion-v1" | "quiet-torso-v1" | "centered-corridor-v1";
  title: string;
  steps: [string, string, string];
  successCue: string;
};

export type CoachingView = {
  schemaVersion: typeof COACHING_SCHEMA_VERSION;
  rendererVersion: typeof COACHING_RENDERER_VERSION;
  drillLibraryVersion: typeof DRILL_LIBRARY_VERSION;
  metricId: string;
  edgeType: "heelside" | "toeside";
  phase: TurnPhase;
  metricLabel: string;
  title: string;
  explanation: string;
  drill: Drill;
};

const progressiveFlexion: Drill = {
  id: "progressive-flexion-v1",
  title: "Progressive flexion turns",
  steps: [
    "Use a comfortable blue groomer.",
    "Begin flexing smoothly as the new edge engages.",
    "Let the movement build through shaping without forcing a low position.",
  ],
  successCue: "The movement changes earlier and more smoothly while edge change timing stays calm.",
};

const quietTorso: Drill = {
  id: "quiet-torso-v1",
  title: "Quiet-torso railroads",
  steps: [
    "Use a mellow groomer and make low-angle carved tracks.",
    "Keep the chest quiet while the lower body guides each edge change.",
    "Add range only while the tracks remain clean and the view stays stable.",
  ],
  successCue: "The torso line becomes more repeatable without skidding the board through the apex.",
};

const centeredCorridor: Drill = {
  id: "centered-corridor-v1",
  title: "Centered corridor turns",
  steps: [
    "Choose a wide, comfortable groomer and a medium turn shape.",
    "Keep the pelvis between the feet through initiation and shaping.",
    "Repeat the same corridor for three turns before adding speed.",
  ],
  successCue: "The pelvis path looks steadier across turns without a sudden reach toward either foot.",
};

function magnitude(value: number, unit: string) {
  const suffix = unit === "degrees" || unit === "deg" ? "°" : unit === "torso_lengths" ? " torso lengths" : unit === "ankle_spans" ? " ankle spans" : ` ${unit}`;
  return `${Math.abs(value).toFixed(unit.includes("length") || unit.includes("span") ? 2 : 1)}${suffix}`;
}

type CoachingEvidence = {
  metricId: string;
  edgeType: "heelside" | "toeside";
  phase: TurnPhase;
  difference: number;
  unit: string;
  pairedTurns: number;
};

function report(evidence: CoachingEvidence, content: Pick<CoachingView, "metricLabel" | "title" | "explanation" | "drill">): CoachingView {
  return {
    schemaVersion: COACHING_SCHEMA_VERSION,
    rendererVersion: COACHING_RENDERER_VERSION,
    drillLibraryVersion: DRILL_LIBRARY_VERSION,
    metricId: evidence.metricId,
    edgeType: evidence.edgeType,
    phase: evidence.phase,
    ...content,
  };
}

export function buildCoachingReport(evidence: CoachingEvidence): CoachingView {
  const difference = evidence.difference;
  const amount = magnitude(difference, evidence.unit);
  const moment = `${evidence.edgeType} ${evidence.phase}`;

  if (evidence.metricId === "knee_flexion_lead" || evidence.metricId === "knee_flexion_trail") {
    const side = evidence.metricId.endsWith("lead") ? "lead" : "trail";
    const relation = difference > 0 ? "straighter" : "more flexed";
    return report(evidence, {
      metricLabel: `${side} knee angle`,
      title: `Your ${side} knee is ${relation} than the reference near ${moment}.`,
      explanation: `The visible knee angle differs by ${amount} across ${evidence.pairedTurns} paired turns. You may be changing flexion range or timing here; the video cannot establish force or pressure.`,
      drill: progressiveFlexion,
    });
  }
  if (evidence.metricId === "pelvis_height") {
    return report(evidence, {
      metricLabel: "normalized pelvis height",
      title: `Your pelvis appears ${difference > 0 ? "higher" : "lower"} than the reference near ${moment}.`,
      explanation: `The 2D pelvis-to-ankle distance differs by ${amount}, normalized to torso length. This may reflect a different flexion pattern, but it is not a center-of-mass or pressure measurement.`,
      drill: progressiveFlexion,
    });
  }
  if (evidence.metricId === "fore_aft_pelvis") {
    return report(evidence, {
      metricLabel: "projected fore/aft pelvis position",
      title: `Your projected pelvis position differs most near ${moment}.`,
      explanation: `The visible pelvis projection differs by ${amount}. Foreshortening and board direction can affect this 2D signal, so treat it as a movement cue rather than a balance diagnosis.`,
      drill: centeredCorridor,
    });
  }
  if (evidence.metricId === "upper_lower_separation") {
    return report(evidence, {
      metricLabel: "upper/lower body separation",
      title: `Your shoulder-to-pelvis alignment differs most near ${moment}.`,
      explanation: `The projected axis difference is ${amount} from the reference pattern. You may be using a different torso rotation strategy; the single camera view cannot determine torque.`,
      drill: quietTorso,
    });
  }
  if (evidence.metricId === "lead_trail_differential") {
    return report(evidence, {
      metricLabel: "lead/trail knee differential",
      title: `Your lead-to-trail knee relationship differs most near ${moment}.`,
      explanation: `The visible difference between the two knee angles changes by ${amount}. This may reflect asymmetrical flexion, but occlusion and camera view remain possible contributors.`,
      drill: progressiveFlexion,
    });
  }
  if (evidence.metricId === "projected_inclination") {
    return report(evidence, {
      metricLabel: "projected body inclination",
      title: `Your projected body line differs most near ${moment}.`,
      explanation: `The 2D body-line angle differs by ${amount} across ${evidence.pairedTurns} paired turns. This is a screen-plane comparison, not a true edge-angle or 3D inclination estimate.`,
      drill: quietTorso,
    });
  }
  throw new Error(`Unsupported coaching metric: ${evidence.metricId}`);
}

export function buildCoachingView(evidence: EvidenceSnapshot): CoachingView {
  return buildCoachingReport({
    metricId: evidence.metric_id,
    edgeType: evidence.edge_type,
    phase: evidence.phase,
    difference: evidence.details.difference,
    unit: evidence.details.unit,
    pairedTurns: evidence.details.paired_turns,
  });
}

export function isCoachingView(value: unknown, evidence?: EvidenceSnapshot): value is CoachingView {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  const drill = item.drill as Record<string, unknown> | null;
  if (
    item.schemaVersion !== COACHING_SCHEMA_VERSION ||
    item.rendererVersion !== COACHING_RENDERER_VERSION ||
    item.drillLibraryVersion !== DRILL_LIBRARY_VERSION ||
    typeof item.metricId !== "string" ||
    !["heelside", "toeside"].includes(String(item.edgeType)) ||
    !["initiation", "shaping", "apex", "completion"].includes(String(item.phase)) ||
    typeof item.metricLabel !== "string" || typeof item.title !== "string" || typeof item.explanation !== "string" ||
    !drill || !["progressive-flexion-v1", "quiet-torso-v1", "centered-corridor-v1"].includes(String(drill.id)) ||
    typeof drill.title !== "string" || !Array.isArray(drill.steps) || drill.steps.length !== 3 ||
    drill.steps.some((step) => typeof step !== "string") || typeof drill.successCue !== "string"
  ) return false;
  return !evidence || (
    item.metricId === evidence.metric_id &&
    item.edgeType === evidence.edge_type &&
    item.phase === evidence.phase
  );
}
