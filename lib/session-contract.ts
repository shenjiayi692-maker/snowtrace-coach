import type { VideoRole } from "./analysis";

// Keep the direct-upload vertical slice below the common 100 MB Worker request
// ceiling. A later multipart S3 upload path can raise this without changing the
// analysis contract.
export const MAX_VIDEO_BYTES = 95 * 1024 * 1024;
export const CONSENT_VERSION = "beta-consent-v1";

export type SessionVideoInput = {
  role: VideoRole;
  originalName: string;
  contentType: string;
  sizeBytes: number;
  durationSeconds: number;
  width: number;
  height: number;
  preflight: {
    resolutionScore: number;
    durationScore: number;
    exposureScore: number | null;
    sharpnessScore: number | null;
  };
};

export type CreateSessionInput = {
  anonymousId: string;
  consent: {
    version: typeof CONSENT_VERSION;
    adultAndRightsConfirmed: true;
    retentionAcknowledged: true;
  };
  goal: "medium" | "short" | "dynamic";
  cameraMode: "fixed" | "follow";
  viewAngle: "three-quarter" | "side" | "front-rear";
  stance: "regular" | "goofy";
  videos: SessionVideoInput[];
};

type ParseResult =
  | { ok: true; value: CreateSessionInput }
  | { ok: false; error: string };

const goals = new Set(["medium", "short", "dynamic"]);
const cameras = new Set(["fixed", "follow"]);
const views = new Set(["three-quarter", "side", "front-rear"]);
const stances = new Set(["regular", "goofy"]);

function finiteNumber(value: unknown, min: number, max: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function parseVideo(value: unknown): SessionVideoInput | null {
  if (!value || typeof value !== "object") return null;
  const video = value as Record<string, unknown>;
  const preflight = video.preflight as Record<string, unknown> | null;
  if (video.role !== "reference" && video.role !== "rider") return null;
  if (typeof video.originalName !== "string" || !video.originalName.trim() || video.originalName.length > 240) return null;
  if (typeof video.contentType !== "string" || !video.contentType.startsWith("video/")) return null;
  if (!finiteNumber(video.sizeBytes, 1, MAX_VIDEO_BYTES)) return null;
  if (!finiteNumber(video.durationSeconds, 0.1, 300)) return null;
  if (!finiteNumber(video.width, 1, 16384) || !finiteNumber(video.height, 1, 16384)) return null;
  if (!preflight) return null;

  for (const key of ["resolutionScore", "durationScore"] as const) {
    if (!finiteNumber(preflight[key], 0, 100)) return null;
  }
  for (const key of ["exposureScore", "sharpnessScore"] as const) {
    if (preflight[key] !== null && !finiteNumber(preflight[key], 0, 100)) return null;
  }

  return {
    role: video.role,
    originalName: video.originalName.trim(),
    contentType: video.contentType,
    sizeBytes: video.sizeBytes,
    durationSeconds: video.durationSeconds,
    width: video.width,
    height: video.height,
    preflight: {
      resolutionScore: preflight.resolutionScore as number,
      durationScore: preflight.durationScore as number,
      exposureScore: preflight.exposureScore as number | null,
      sharpnessScore: preflight.sharpnessScore as number | null,
    },
  };
}

export function parseCreateSessionInput(input: unknown): ParseResult {
  if (!input || typeof input !== "object") return { ok: false, error: "Expected a JSON object." };
  const value = input as Record<string, unknown>;
  if (typeof value.anonymousId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(value.anonymousId)) {
    return { ok: false, error: "A valid anonymous rider ID is required." };
  }
  const consent = value.consent as Record<string, unknown> | null;
  if (
    !consent ||
    consent.version !== CONSENT_VERSION ||
    consent.adultAndRightsConfirmed !== true ||
    consent.retentionAcknowledged !== true
  ) {
    return { ok: false, error: "Confirm the beta video permissions and retention terms before uploading." };
  }
  if (typeof value.goal !== "string" || !goals.has(value.goal)) return { ok: false, error: "Choose a supported carving goal." };
  if (typeof value.cameraMode !== "string" || !cameras.has(value.cameraMode)) return { ok: false, error: "Choose a supported camera mode." };
  if (typeof value.viewAngle !== "string" || !views.has(value.viewAngle)) return { ok: false, error: "Choose a supported view angle." };
  if (typeof value.stance !== "string" || !stances.has(value.stance)) return { ok: false, error: "Choose regular or goofy stance." };
  if (!Array.isArray(value.videos) || value.videos.length !== 2) return { ok: false, error: "Provide one reference video and one rider video." };

  const videos = value.videos.map(parseVideo);
  if (videos.some((video) => video === null)) return { ok: false, error: "One or more video records are invalid." };
  const parsedVideos = videos as SessionVideoInput[];
  if (new Set(parsedVideos.map((video) => video.role)).size !== 2) {
    return { ok: false, error: "Provide exactly one video for each role." };
  }

  return {
    ok: true,
    value: {
      anonymousId: value.anonymousId,
      consent: {
        version: CONSENT_VERSION,
        adultAndRightsConfirmed: true,
        retentionAcknowledged: true,
      },
      goal: value.goal as CreateSessionInput["goal"],
      cameraMode: value.cameraMode as CreateSessionInput["cameraMode"],
      viewAngle: value.viewAngle as CreateSessionInput["viewAngle"],
      stance: value.stance as CreateSessionInput["stance"],
      videos: parsedVideos,
    },
  };
}

export function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: { "cache-control": "no-store" } });
}
