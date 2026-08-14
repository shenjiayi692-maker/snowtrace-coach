export type VideoRole = "reference" | "rider";

export type VideoInspection = {
  role: VideoRole;
  name: string;
  sizeBytes: number;
  durationSeconds: number;
  width: number;
  height: number;
  orientation: "landscape" | "portrait" | "square";
  resolutionScore: number;
  durationScore: number;
  exposureScore: number | null;
  sharpnessScore: number | null;
  previewUrl: string;
};

export type QualityState = "good" | "medium" | "blocked" | "pending";

export type QualityCheck = {
  id: string;
  label: string;
  value: string;
  score: number | null;
  state: QualityState;
  note: string;
};

export type AnalysisStage = {
  id: string;
  label: string;
  detail: string;
};

export const ANALYSIS_STAGES: AnalysisStage[] = [
  { id: "prepared", label: "Video prepared", detail: "720p analysis proxy and timestamps" },
  { id: "rider", label: "Rider found", detail: "Selected track stays consistent" },
  { id: "pose", label: "Pose extracted", detail: "Landmarks and confidence curves" },
  { id: "turns", label: "Matching turns", detail: "Heelside and toeside phases" },
  { id: "compare", label: "Comparing technique", detail: "Only reliable metrics are ranked" },
  { id: "coach", label: "Building coaching plan", detail: "One observation, one drill" },
];

export function scoreForRange(
  value: number,
  idealMin: number,
  idealMax: number,
  hardMin: number,
  hardMax: number,
) {
  if (value < hardMin || value > hardMax) return 0;
  if (value >= idealMin && value <= idealMax) return 100;
  if (value < idealMin) {
    return Math.round(((value - hardMin) / (idealMin - hardMin)) * 100);
  }
  return Math.round(((hardMax - value) / (hardMax - idealMax)) * 100);
}

export function resolutionScore(width: number, height: number) {
  const shortEdge = Math.min(width, height);
  if (shortEdge >= 1080) return 100;
  if (shortEdge >= 720) return 88;
  if (shortEdge >= 540) return 58;
  return 20;
}

export function qualityState(score: number | null): QualityState {
  if (score === null) return "pending";
  if (score >= 75) return "good";
  if (score >= 50) return "medium";
  return "blocked";
}

export function buildPreflightChecks(video: VideoInspection): QualityCheck[] {
  const dimensions = `${video.width}×${video.height}`;
  const duration = `${video.durationSeconds.toFixed(1)} sec`;
  const exposure = video.exposureScore;
  const sharpness = video.sharpnessScore;

  return [
    {
      id: `${video.role}-resolution`,
      label: "Resolution",
      value: dimensions,
      score: video.resolutionScore,
      state: qualityState(video.resolutionScore),
      note: video.resolutionScore >= 75 ? "Enough detail for pose extraction" : "A 720p or higher source is recommended",
    },
    {
      id: `${video.role}-duration`,
      label: "Clip length",
      value: duration,
      score: video.durationScore,
      state: qualityState(video.durationScore),
      note: video.durationScore >= 75 ? "Good range for auto trim" : "Use a 5–30 second source clip",
    },
    {
      id: `${video.role}-exposure`,
      label: "Exposure",
      value: exposure === null ? "Waiting" : exposure >= 75 ? "Good" : "Check snow detail",
      score: exposure,
      state: qualityState(exposure),
      note: "Estimated from three frames; the pose gate will verify the rider",
    },
    {
      id: `${video.role}-sharpness`,
      label: "Motion clarity",
      value: sharpness === null ? "Waiting" : sharpness >= 75 ? "Good" : "Medium",
      score: sharpness,
      state: qualityState(sharpness),
      note: "A preliminary frame-level signal, not a pose confidence score",
    },
  ];
}

export function preliminaryReadiness(videos: VideoInspection[]) {
  const values = videos.flatMap((video) =>
    buildPreflightChecks(video)
      .map((check) => check.score)
      .filter((value): value is number => value !== null),
  );
  if (!values.length) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}
