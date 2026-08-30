export type TurnPhase = "initiation" | "shaping" | "apex" | "completion";

export type PoseSnapshot = {
  timestamp_ms: number;
  landmarks: Array<{ x: number; y: number; visibility: number }>;
};

export type EvidenceSnapshot = {
  metric_id: string;
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

type Drill = {
  title: string;
  steps: [string, string, string];
  successCue: string;
};

export type CoachingView = {
  metricLabel: string;
  title: string;
  explanation: string;
  drill: Drill;
};

const progressiveFlexion: Drill = {
  title: "Progressive flexion turns",
  steps: [
    "Use a comfortable blue groomer.",
    "Begin flexing smoothly as the new edge engages.",
    "Let the movement build through shaping without forcing a low position.",
  ],
  successCue: "The movement changes earlier and more smoothly while edge change timing stays calm.",
};

const quietTorso: Drill = {
  title: "Quiet-torso railroads",
  steps: [
    "Use a mellow groomer and make low-angle carved tracks.",
    "Keep the chest quiet while the lower body guides each edge change.",
    "Add range only while the tracks remain clean and the view stays stable.",
  ],
  successCue: "The torso line becomes more repeatable without skidding the board through the apex.",
};

const centeredCorridor: Drill = {
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

export function buildCoachingView(evidence: EvidenceSnapshot): CoachingView {
  const difference = evidence.details.difference;
  const amount = magnitude(difference, evidence.details.unit);
  const phase = evidence.phase;

  if (evidence.metric_id === "knee_flexion_lead" || evidence.metric_id === "knee_flexion_trail") {
    const side = evidence.metric_id.endsWith("lead") ? "lead" : "trail";
    const relation = difference > 0 ? "straighter" : "more flexed";
    return {
      metricLabel: `${side} knee angle`,
      title: `Your ${side} knee is ${relation} than the reference near ${phase}.`,
      explanation: `The visible knee angle differs by ${amount} across ${evidence.details.paired_turns} paired turns. You may be changing flexion range or timing here; the video cannot establish force or pressure.`,
      drill: progressiveFlexion,
    };
  }
  if (evidence.metric_id === "pelvis_height") {
    return {
      metricLabel: "normalized pelvis height",
      title: `Your pelvis appears ${difference > 0 ? "higher" : "lower"} than the reference near ${phase}.`,
      explanation: `The 2D pelvis-to-ankle distance differs by ${amount}, normalized to torso length. This may reflect a different flexion pattern, but it is not a center-of-mass or pressure measurement.`,
      drill: progressiveFlexion,
    };
  }
  if (evidence.metric_id === "fore_aft_pelvis") {
    return {
      metricLabel: "projected fore/aft pelvis position",
      title: `Your projected pelvis position differs most near ${phase}.`,
      explanation: `The visible pelvis projection differs by ${amount}. Foreshortening and board direction can affect this 2D signal, so treat it as a movement cue rather than a balance diagnosis.`,
      drill: centeredCorridor,
    };
  }
  if (evidence.metric_id === "upper_lower_separation") {
    return {
      metricLabel: "upper/lower body separation",
      title: `Your shoulder-to-pelvis alignment differs most near ${phase}.`,
      explanation: `The projected axis difference is ${amount} from the reference pattern. You may be using a different torso rotation strategy; the single camera view cannot determine torque.`,
      drill: quietTorso,
    };
  }
  if (evidence.metric_id === "lead_trail_differential") {
    return {
      metricLabel: "lead/trail knee differential",
      title: `Your lead-to-trail knee relationship differs most near ${phase}.`,
      explanation: `The visible difference between the two knee angles changes by ${amount}. This may reflect asymmetrical flexion, but occlusion and camera view remain possible contributors.`,
      drill: progressiveFlexion,
    };
  }
  return {
    metricLabel: "projected body inclination",
    title: `Your projected body line differs most near ${phase}.`,
    explanation: `The 2D body-line angle differs by ${amount} across ${evidence.details.paired_turns} paired turns. This is a screen-plane comparison, not a true edge-angle or 3D inclination estimate.`,
    drill: quietTorso,
  };
}
