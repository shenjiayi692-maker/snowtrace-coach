"use client";

import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildPreflightChecks,
  preliminaryReadiness,
  qualityState,
  resolutionScore,
  scoreForRange,
  type VideoInspection,
  type VideoRole,
} from "../lib/analysis";
import { MAX_VIDEO_BYTES } from "../lib/session-contract";
import { buildCoachingView, type EvidenceSnapshot, type TurnPhase } from "../lib/coaching";

type Screen = "upload" | "readiness" | "processing" | "queued" | "select-rider" | "outcome" | "report";
type Goal = "medium" | "short" | "dynamic";

type CreatedSession = {
  sessionId: string;
  expiresAt: string;
  videos: Array<{ id: string; role: VideoRole; uploadUrl: string }>;
  analysisUrl: string;
  statusUrl: string;
};

type RiderCandidate = {
  track_id: number;
  score: number;
  coverage: number;
  representative_frame_ms: number;
  representative_bbox: [number, number, number, number];
};

type RiderSelectionAction = {
  type: "select_rider";
  roles: Array<{ role: VideoRole; candidates: RiderCandidate[] }>;
};

type FeedbackAnswers = {
  report_helpfulness?: "yes" | "partly" | "no";
  evidence_clarity?: "yes" | "partly" | "no";
  drill_intent?: "yes" | "maybe" | "no";
};

type QualityCheckSnapshot = {
  id: string;
  label: string;
  score: number;
  status: "good" | "medium" | "blocked";
  detail: string;
};

type VideoQualitySnapshot = {
  role: VideoRole;
  status: "full" | "limited" | "rejected";
  readiness_score: number;
  checks: QualityCheckSnapshot[];
  recapture_instructions: string[];
};

type AnalysisOutcome = {
  kind: "footage" | "no_evidence" | "technical" | "service_unavailable";
  title: string;
  message: string;
  retryable: boolean;
  videos: VideoQualitySnapshot[];
};

type SessionSnapshot = {
  run: { status: string; stage: string | null; error_code: string | null } | null;
  evidence: EvidenceSnapshot[];
  action: RiderSelectionAction | null;
  outcome: AnalysisOutcome | null;
};

const SUBMISSION_STAGES = [
  { id: "session", label: "Private session created", detail: "Context and browser preflight saved" },
  { id: "reference", label: "Reference video uploaded", detail: "Source stored in the private video bucket" },
  { id: "rider", label: "Rider video uploaded", detail: "Upload verified against the inspected file" },
  { id: "queue", label: "Pose gate queued", detail: "Waiting for the MediaPipe analysis worker" },
];

const goalCopy: Record<Goal, { label: string; caption: string }> = {
  medium: { label: "Medium carving", caption: "Round, controlled turns" },
  short: { label: "Short turns", caption: "Quicker edge-to-edge timing" },
  dynamic: { label: "Dynamic carving", caption: "More range and commitment" },
};

const feedbackQuestions: Array<{
  id: keyof FeedbackAnswers;
  label: string;
  options: Array<{ value: string; label: string }>;
}> = [
  { id: "report_helpfulness", label: "Was this report useful?", options: [{ value: "yes", label: "Yes" }, { value: "partly", label: "Partly" }, { value: "no", label: "No" }] },
  { id: "evidence_clarity", label: "Could you see the gap at Show Me?", options: [{ value: "yes", label: "Yes" }, { value: "partly", label: "Somewhat" }, { value: "no", label: "No" }] },
  { id: "drill_intent", label: "Would you try this drill next run?", options: [{ value: "yes", label: "Yes" }, { value: "maybe", label: "Maybe" }, { value: "no", label: "No" }] },
];

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTimestamp(milliseconds: number) {
  const seconds = milliseconds / 1000;
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
}

function formatEvidenceValue(value: number, unit: string) {
  if (unit === "degrees" || unit === "deg") return `${value.toFixed(1)}°`;
  return value.toFixed(2);
}

function contentTypeFor(file: File) {
  if (file.type.startsWith("video/")) return file.type;
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "mov") return "video/quicktime";
  if (extension === "webm") return "video/webm";
  return "video/mp4";
}

async function readApiResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status}).`);
  return body as T;
}

function uploadVideo(url: string, file: File, onProgress: (progress: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    request.setRequestHeader("content-type", contentTypeFor(file));
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else {
        try {
          const body = JSON.parse(request.responseText) as { error?: string };
          reject(new Error(body.error ?? `Upload failed (${request.status}).`));
        } catch {
          reject(new Error(`Upload failed (${request.status}).`));
        }
      }
    };
    request.onerror = () => reject(new Error("The upload connection was interrupted."));
    request.send(file);
  });
}

function getAnonymousRiderId() {
  const storageKey = "snowtrace_anonymous_rider_id";
  const existing = window.localStorage.getItem(storageKey);
  if (existing) return existing;
  const created = `rider_${crypto.randomUUID()}`;
  window.localStorage.setItem(storageKey, created);
  return created;
}

function analyzePixels(data: Uint8ClampedArray, width: number, height: number) {
  const gray = new Float32Array(width * height);
  let brightnessTotal = 0;
  for (let i = 0, pixel = 0; i < data.length; i += 4, pixel += 1) {
    const value = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    gray[pixel] = value;
    brightnessTotal += value;
  }

  let laplacianTotal = 0;
  let laplacianSquared = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const laplacian =
        gray[index - 1] + gray[index + 1] + gray[index - width] + gray[index + width] - 4 * gray[index];
      laplacianTotal += laplacian;
      laplacianSquared += laplacian * laplacian;
      count += 1;
    }
  }

  const meanLaplacian = laplacianTotal / Math.max(1, count);
  const variance = laplacianSquared / Math.max(1, count) - meanLaplacian * meanLaplacian;
  return {
    brightness: brightnessTotal / Math.max(1, gray.length),
    sharpness: variance,
  };
}

async function inspectVideo(file: File, role: VideoRole): Promise<VideoInspection> {
  const previewUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  video.playsInline = true;
  video.src = previewUrl;

  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error("This video could not be read."));
  });

  const durationSeconds = Number.isFinite(video.duration) ? video.duration : 0;
  const width = video.videoWidth;
  const height = video.videoHeight;
  const canvas = document.createElement("canvas");
  const targetWidth = 240;
  const targetHeight = Math.max(1, Math.round((height / Math.max(1, width)) * targetWidth));
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });

  const samples: Array<{ brightness: number; sharpness: number }> = [];
  if (context && durationSeconds > 0) {
    for (const ratio of [0.25, 0.5, 0.75]) {
      video.currentTime = Math.min(Math.max(0, durationSeconds * ratio), Math.max(0, durationSeconds - 0.05));
      await new Promise<void>((resolve) => {
        video.onseeked = () => resolve();
      });
      context.drawImage(video, 0, 0, targetWidth, targetHeight);
      samples.push(analyzePixels(context.getImageData(0, 0, targetWidth, targetHeight).data, targetWidth, targetHeight));
    }
  }

  const brightness = samples.length
    ? samples.reduce((sum, sample) => sum + sample.brightness, 0) / samples.length
    : null;
  const sharpness = samples.length
    ? samples.reduce((sum, sample) => sum + sample.sharpness, 0) / samples.length
    : null;

  const exposureScore =
    brightness === null ? null : scoreForRange(brightness, 70, 205, 25, 245);
  const sharpnessScore =
    sharpness === null ? null : Math.max(0, Math.min(100, Math.round((sharpness / 700) * 100)));

  return {
    role,
    name: file.name,
    sizeBytes: file.size,
    durationSeconds,
    width,
    height,
    orientation: width > height ? "landscape" : width < height ? "portrait" : "square",
    resolutionScore: resolutionScore(width, height),
    durationScore: scoreForRange(durationSeconds, 6, 20, 3, 30),
    exposureScore,
    sharpnessScore,
    previewUrl,
  };
}

function BrandMark() {
  return (
    <div className="brand-mark" aria-label="Snowtrace">
      <span className="brand-glyph">S/</span>
      <span>SNOWTRACE</span>
    </div>
  );
}

function UploadCard({
  role,
  video,
  busy,
  onSelect,
}: {
  role: VideoRole;
  video: VideoInspection | null;
  busy: boolean;
  onSelect: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const isReference = role === "reference";
  return (
    <section className={`upload-card ${video ? "has-video" : ""}`}>
      <div className="card-number">{isReference ? "01" : "02"}</div>
      <div className="upload-card-copy">
        <span className="eyebrow">{isReference ? "TARGET RIDE" : "YOUR RIDE"}</span>
        <h3>{isReference ? "Reference video" : "Rider video"}</h3>
        <p>
          {isReference
            ? "The movement pattern you want to learn."
            : "A recent run with at least three connected turns."}
        </p>
      </div>
      {video ? (
        <div className="selected-file">
          <video src={video.previewUrl} muted playsInline preload="metadata" />
          <div className="file-details">
            <strong>{video.name}</strong>
            <span>
              {video.durationSeconds.toFixed(1)}s · {video.width}×{video.height} · {formatBytes(video.sizeBytes)}
            </span>
            <button type="button" className="text-button" onClick={() => inputRef.current?.click()}>
              Replace video
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="upload-drop" disabled={busy} onClick={() => inputRef.current?.click()}>
          <span className="upload-plus">+</span>
          <span>{busy ? "Inspecting video…" : "Choose video"}</span>
          <small>5–30 sec · up to 95 MB</small>
        </button>
      )}
      <input
        ref={inputRef}
        className="visually-hidden"
        type="file"
        accept="video/*"
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          const file = event.target.files?.[0];
          if (file) onSelect(file);
          event.target.value = "";
        }}
      />
    </section>
  );
}

function RiderCandidateCard({
  candidate,
  video,
  selected,
  onSelect,
}: {
  candidate: RiderCandidate;
  video: VideoInspection;
  selected: boolean;
  onSelect: () => void;
}) {
  const [left, top, right, bottom] = candidate.representative_bbox.map((value) => Math.max(0, Math.min(1, value)));
  return (
    <button type="button" className={`candidate-card ${selected ? "selected" : ""}`} onClick={onSelect}>
      <div className="candidate-frame" style={{ aspectRatio: `${video.width} / ${video.height}` }}>
        <video
          src={video.previewUrl}
          muted
          playsInline
          preload="metadata"
          onLoadedMetadata={(event) => {
            event.currentTarget.currentTime = candidate.representative_frame_ms / 1000;
            event.currentTarget.pause();
          }}
        />
        <span
          className="candidate-box"
          style={{
            left: `${left * 100}%`,
            top: `${top * 100}%`,
            width: `${Math.max(0.02, right - left) * 100}%`,
            height: `${Math.max(0.02, bottom - top) * 100}%`,
          }}
        />
      </div>
      <span className="candidate-meta">
        <strong>Rider {candidate.track_id + 1}</strong>
        <small>{Math.round(candidate.coverage * 100)}% clip coverage · {formatTimestamp(candidate.representative_frame_ms)}</small>
      </span>
      <b>{selected ? "Selected ✓" : "Choose"}</b>
    </button>
  );
}

function ContextSelector({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="context-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option value={option.value} key={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function StatusDot({ state }: { state: ReturnType<typeof qualityState> }) {
  return <span className={`status-dot ${state}`} aria-hidden="true" />;
}

export function CoachApp() {
  const [screen, setScreen] = useState<Screen>("upload");
  const [reference, setReference] = useState<VideoInspection | null>(null);
  const [rider, setRider] = useState<VideoInspection | null>(null);
  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const [riderFile, setRiderFile] = useState<File | null>(null);
  const [busyRole, setBusyRole] = useState<VideoRole | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [goal, setGoal] = useState<Goal>("medium");
  const [camera, setCamera] = useState("fixed");
  const [view, setView] = useState("three-quarter");
  const [stance, setStance] = useState("regular");
  const [activeStage, setActiveStage] = useState(0);
  const [activeMoment, setActiveMoment] = useState<TurnPhase>("apex");
  const [submissionProgress, setSubmissionProgress] = useState(0);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [analysisRunId, setAnalysisRunId] = useState<string | null>(null);
  const [queueMessage, setQueueMessage] = useState("Waiting for the analysis worker.");
  const [analysisOutcome, setAnalysisOutcome] = useState<AnalysisOutcome | null>(null);
  const [isCheckingStatus, setIsCheckingStatus] = useState(false);
  const [realEvidence, setRealEvidence] = useState<EvidenceSnapshot | null>(null);
  const [riderAction, setRiderAction] = useState<RiderSelectionAction | null>(null);
  const [selectedTracks, setSelectedTracks] = useState<Partial<Record<VideoRole, number>>>({});
  const [feedbackAnswers, setFeedbackAnswers] = useState<FeedbackAnswers>({});
  const [feedbackStatus, setFeedbackStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const referenceVideoRef = useRef<HTMLVideoElement>(null);
  const riderVideoRef = useRef<HTMLVideoElement>(null);

  const applySessionSnapshot = useCallback((snapshot: SessionSnapshot) => {
    if (!snapshot.run) {
      setQueueMessage("The session exists, but no analysis run is attached.");
      return;
    }
    if (snapshot.run.status === "needs_rider" && snapshot.action) {
      setRiderAction(snapshot.action);
      setSelectedTracks({});
      setScreen("select-rider");
      return;
    }
    if (snapshot.run.status === "completed" && snapshot.evidence[0]) {
      setAnalysisOutcome(null);
      setRealEvidence(snapshot.evidence[0]);
      setActiveMoment(snapshot.evidence[0].phase);
      setScreen("report");
      return;
    }
    if (snapshot.outcome) {
      setAnalysisOutcome(snapshot.outcome);
      setScreen("outcome");
      return;
    }
    if (snapshot.run.stage === "awaiting_worker" || snapshot.run.stage === "dispatch_failed") {
      setAnalysisOutcome({
        kind: "service_unavailable",
        title: "The analysis worker is not available yet.",
        message: snapshot.run.stage === "dispatch_failed"
          ? "Your clips are stored safely, but the video-intelligence service could not accept this job."
          : "Your clips are stored safely, but this beta deployment is not connected to the video-intelligence service.",
        retryable: true,
        videos: [],
      });
      setScreen("outcome");
      return;
    }
    const stageMessages: Record<string, string> = {
      dispatching: "Connecting the job to the MediaPipe worker…",
      worker_dispatched: "Analyzing rider visibility, turns and comparable phases…",
      evidence_ready: "Evidence is ready. Opening your report…",
    };
    setQueueMessage(stageMessages[snapshot.run.stage ?? ""] ?? `Analysis status: ${snapshot.run.status}.`);
  }, []);

  const refreshQueue = useCallback(async (announce = true) => {
    if (!sessionId) return;
    if (announce) setIsCheckingStatus(true);
    try {
      const response = await fetch(`/api/sessions/${sessionId}`, { cache: "no-store" });
      const snapshot = await readApiResponse<SessionSnapshot>(response);
      applySessionSnapshot(snapshot);
    } catch (cause) {
      setQueueMessage(cause instanceof Error ? cause.message : "Status could not be refreshed.");
    } finally {
      if (announce) setIsCheckingStatus(false);
    }
  }, [applySessionSnapshot, sessionId]);

  useEffect(() => {
    if (screen !== "queued" || !sessionId) return;
    let active = true;
    const poll = async () => {
      if (!active || document.visibilityState === "hidden") return;
      await refreshQueue(false);
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 4_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [refreshQueue, screen, sessionId]);

  useEffect(() => {
    return () => {
      if (reference) URL.revokeObjectURL(reference.previewUrl);
      if (rider) URL.revokeObjectURL(rider.previewUrl);
    };
  }, [reference, rider]);

  const videos = useMemo(() => [reference, rider].filter(Boolean) as VideoInspection[], [reference, rider]);
  const readiness = useMemo(() => preliminaryReadiness(videos), [videos]);
  const allChecks = useMemo(
    () => videos.flatMap((video) => buildPreflightChecks(video).map((check) => ({ ...check, role: video.role }))),
    [videos],
  );
  const canContinue = Boolean(reference && rider && !busyRole);
  const coaching = useMemo(() => realEvidence ? buildCoachingView(realEvidence) : null, [realEvidence]);
  const activeReferenceTimestamp = realEvidence?.reference_timestamp_ms ?? 0;
  const activeRiderTimestamp = realEvidence?.user_timestamp_ms ?? 0;

  function seekEvidence() {
    if (!realEvidence) return;
    if (referenceVideoRef.current) referenceVideoRef.current.currentTime = realEvidence.reference_timestamp_ms / 1000;
    if (riderVideoRef.current) riderVideoRef.current.currentTime = realEvidence.user_timestamp_ms / 1000;
  }

  async function selectVideo(file: File, role: VideoRole) {
    setError(null);
    if (file.size > MAX_VIDEO_BYTES) {
      setError("Keep each source clip under 95 MB for this direct-upload MVP. Trim it before uploading.");
      return;
    }
    setBusyRole(role);
    try {
      const inspection = await inspectVideo(file, role);
      const previous = role === "reference" ? reference : rider;
      if (previous) URL.revokeObjectURL(previous.previewUrl);
      if (role === "reference") {
        setReference(inspection);
        setReferenceFile(file);
      } else {
        setRider(inspection);
        setRiderFile(file);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This video could not be inspected.");
    } finally {
      setBusyRole(null);
    }
  }

  async function startLiveAnalysis() {
    if (!reference || !rider || !referenceFile || !riderFile) return;
    setSubmissionError(null);
    setSubmissionProgress(0);
    setRealEvidence(null);
    setAnalysisOutcome(null);
    setRiderAction(null);
    setSelectedTracks({});
    setFeedbackAnswers({});
    setFeedbackStatus("idle");
    setActiveStage(0);
    setScreen("processing");
    let createdSessionId: string | null = null;

    try {
      const createResponse = await fetch("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          anonymousId: getAnonymousRiderId(),
          goal,
          cameraMode: camera,
          viewAngle: view,
          stance,
          videos: [
            { inspection: reference, file: referenceFile },
            { inspection: rider, file: riderFile },
          ].map(({ inspection, file }) => ({
            role: inspection.role,
            originalName: inspection.name,
            contentType: contentTypeFor(file),
            sizeBytes: inspection.sizeBytes,
            durationSeconds: inspection.durationSeconds,
            width: inspection.width,
            height: inspection.height,
            preflight: {
              resolutionScore: inspection.resolutionScore,
              durationScore: inspection.durationScore,
              exposureScore: inspection.exposureScore,
              sharpnessScore: inspection.sharpnessScore,
            },
          })),
        }),
      });
      const created = await readApiResponse<CreatedSession>(createResponse);
      createdSessionId = created.sessionId;
      setSessionId(created.sessionId);

      const referenceUpload = created.videos.find((video) => video.role === "reference");
      const riderUpload = created.videos.find((video) => video.role === "rider");
      if (!referenceUpload || !riderUpload) throw new Error("The upload contract is incomplete.");

      setActiveStage(1);
      await uploadVideo(referenceUpload.uploadUrl, referenceFile, setSubmissionProgress);
      setSubmissionProgress(0);
      setActiveStage(2);
      await uploadVideo(riderUpload.uploadUrl, riderFile, setSubmissionProgress);
      setSubmissionProgress(100);
      setActiveStage(3);

      const analysisResponse = await fetch(created.analysisUrl, { method: "POST" });
      const queued = await readApiResponse<{ analysisRunId: string; status: string; stage: string }>(analysisResponse);
      setAnalysisRunId(queued.analysisRunId);
      if (queued.stage === "awaiting_worker" || queued.stage === "dispatch_failed") {
        setAnalysisOutcome({
          kind: "service_unavailable",
          title: "The analysis worker is not available yet.",
          message: queued.stage === "dispatch_failed"
            ? "Your clips are stored safely, but the video-intelligence service could not accept this job."
            : "Your clips are stored safely, but this beta deployment is not connected to the video-intelligence service.",
          retryable: true,
          videos: [],
        });
        setScreen("outcome");
      } else {
        setQueueMessage("Both clips are stored. Analysis has started; this page updates automatically.");
        setScreen("queued");
      }
    } catch (cause) {
      if (createdSessionId) {
        await fetch(`/api/sessions/${createdSessionId}`, { method: "DELETE" }).catch(() => undefined);
        setSessionId(null);
      }
      setSubmissionError(cause instanceof Error ? cause.message : "The analysis session could not be submitted.");
    }
  }

  async function submitRiderSelection() {
    if (!sessionId || !riderAction) return;
    const complete = riderAction.roles.every(({ role }) => Number.isInteger(selectedTracks[role]));
    if (!complete) return;
    setQueueMessage("Submitting your rider selection…");
    try {
      const response = await fetch(`/api/sessions/${sessionId}/analysis`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ selectedTrackIds: selectedTracks }),
      });
      const queued = await readApiResponse<{ analysisRunId: string; status: string; stage: string }>(response);
      setAnalysisRunId(queued.analysisRunId);
      setRiderAction(null);
      setQueueMessage(queued.stage === "worker_dispatched" ? "Rider confirmed. Analysis restarted." : "Rider confirmed. Analysis is queued for the worker.");
      setScreen("queued");
    } catch (cause) {
      setQueueMessage(cause instanceof Error ? cause.message : "Rider selection could not be submitted.");
    }
  }

  async function retryAnalysisDispatch() {
    if (!sessionId) return;
    setQueueMessage("Reconnecting to the analysis worker…");
    try {
      const response = await fetch(`/api/sessions/${sessionId}/analysis`, { method: "POST" });
      const queued = await readApiResponse<{ analysisRunId: string; status: string; stage: string }>(response);
      setAnalysisRunId(queued.analysisRunId);
      if (queued.stage === "worker_dispatched") {
        setAnalysisOutcome(null);
        setQueueMessage("Analysis has started. This page updates automatically.");
        setScreen("queued");
      } else {
        setAnalysisOutcome((current) => current ? {
          ...current,
          message: queued.stage === "dispatch_failed"
            ? "The analysis worker still could not accept this job. Your clips remain stored safely."
            : "The analysis worker is still offline. Your clips remain stored safely.",
        } : current);
      }
    } catch (cause) {
      setAnalysisOutcome((current) => current ? {
        ...current,
        message: cause instanceof Error ? cause.message : "The analysis job could not be retried.",
      } : current);
    }
  }

  async function deleteQueuedSession() {
    if (!sessionId) return;
    setQueueMessage("Deleting both source clips…");
    try {
      const response = await fetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
      if (!response.ok) throw new Error("The private session could not be deleted.");
      setSessionId(null);
      setAnalysisRunId(null);
      setRealEvidence(null);
      setAnalysisOutcome(null);
      setRiderAction(null);
      setSelectedTracks({});
      setQueueMessage("Session deleted.");
      setScreen("upload");
    } catch (cause) {
      setQueueMessage(cause instanceof Error ? cause.message : "The private session could not be deleted.");
    }
  }

  async function submitFeedback() {
    if (!sessionId || !analysisRunId || Object.keys(feedbackAnswers).length !== 3) return;
    setFeedbackStatus("sending");
    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId,
          analysisRunId,
          events: Object.entries(feedbackAnswers).map(([eventType, value]) => ({ eventType, value })),
        }),
      });
      await readApiResponse<{ accepted: true }>(response);
      setFeedbackStatus("sent");
    } catch {
      setFeedbackStatus("error");
    }
  }

  function reset() {
    setScreen("upload");
    setActiveStage(0);
    setSubmissionError(null);
    setAnalysisOutcome(null);
    setRealEvidence(null);
    setFeedbackAnswers({});
    setFeedbackStatus("idle");
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <BrandMark />
        <div className="topbar-meta">
          <span className="prototype-pill">M0 VERTICAL SLICE</span>
          <button type="button" className="language-button" aria-label="Switch language">
            EN
          </button>
        </div>
      </header>

      {screen === "upload" && (
        <div className="page-grid upload-screen">
          <section className="hero-copy">
            <div className="eyebrow-row">
              <span className="eyebrow">CARVING · REFERENCE COMPARISON</span>
              <span className="step-count">STEP 01 / 04</span>
            </div>
            <h1>
              See the gap.
              <br />
              <em>Ride the fix.</em>
            </h1>
            <p className="hero-lede">
              Upload the riding you want, then your own run. Snowtrace checks whether the footage is measurable before it says anything about technique.
            </p>

            <div className="capture-guide">
              <div className="capture-diagram" aria-hidden="true">
                <span className="camera-icon">🎥</span>
                <div className="s-line" />
                <span className="rider-icon">🏂</span>
              </div>
              <div>
                <span className="eyebrow">RECOMMENDED RECORDING</span>
                <h2>Three turns. Full body. One stable view.</h2>
                <ul>
                  <li>Fixed 3/4 camera angle is best</li>
                  <li>Keep the rider at least 20% of frame height</li>
                  <li>Avoid digital zoom and hard backlight</li>
                </ul>
              </div>
            </div>
          </section>

          <section className="upload-workspace">
            <div className="goal-selector">
              <span className="eyebrow">WHAT ARE YOU WORKING ON?</span>
              <div className="goal-options">
                {(Object.keys(goalCopy) as Goal[]).map((key) => (
                  <button
                    type="button"
                    key={key}
                    className={goal === key ? "selected" : ""}
                    onClick={() => setGoal(key)}
                  >
                    <strong>{goalCopy[key].label}</strong>
                    <span>{goalCopy[key].caption}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="upload-pair">
              <UploadCard role="reference" video={reference} busy={busyRole === "reference"} onSelect={(file) => selectVideo(file, "reference")} />
              <UploadCard role="rider" video={rider} busy={busyRole === "rider"} onSelect={(file) => selectVideo(file, "rider")} />
            </div>

            <div className="context-row">
              <ContextSelector
                label="Camera"
                value={camera}
                onChange={setCamera}
                options={[{ value: "fixed", label: "Fixed" }, { value: "follow", label: "Follow cam" }]}
              />
              <ContextSelector
                label="View"
                value={view}
                onChange={setView}
                options={[
                  { value: "three-quarter", label: "3/4 view" },
                  { value: "side", label: "Side" },
                  { value: "front-rear", label: "Front / rear" },
                ]}
              />
              <ContextSelector
                label="Stance"
                value={stance}
                onChange={setStance}
                options={[{ value: "regular", label: "Regular" }, { value: "goofy", label: "Goofy" }]}
              />
            </div>

            {error && <p className="error-message" role="alert">{error}</p>}
            <button type="button" className="primary-button" disabled={!canContinue} onClick={() => setScreen("readiness")}>
              Check analysis readiness <span aria-hidden="true">→</span>
            </button>
            <p className="privacy-line">Private by default · 30-day expiry recorded · Delete queued clips anytime</p>
          </section>
        </div>
      )}

      {screen === "readiness" && reference && rider && (
        <div className="focused-screen readiness-screen">
          <div className="screen-heading">
            <button type="button" className="back-button" onClick={() => setScreen("upload")}>
              ← Back
            </button>
            <span className="eyebrow">STEP 02 / 04 · VIDEO INTELLIGENCE</span>
            <h1>Analysis readiness</h1>
            <p>This is a footage score, not a riding score. Pose-level checks remain pending until the analysis worker is connected.</p>
          </div>

          <div className="readiness-layout">
            <section className="score-card">
              <div className={`score-ring ${qualityState(readiness)}`} style={{ "--score": `${readiness * 3.6}deg` } as React.CSSProperties}>
                <div>
                  <strong>{readiness}</strong>
                  <span>/100</span>
                </div>
              </div>
              <h2>{readiness >= 75 ? "Ready for the pose gate" : readiness >= 50 ? "Usable with caution" : "Recapture recommended"}</h2>
              <p>Metadata, exposure and frame clarity have been inspected locally.</p>
              <div className="pending-gate">
                <StatusDot state="pending" />
                <span><strong>Pose gate pending</strong>Rider size, body visibility, turns and compatibility</span>
              </div>
            </section>

            <section className="checks-card">
              <div className="checks-header">
                <span className="eyebrow">WHAT WE CAN VERIFY NOW</span>
                <span>{allChecks.filter((check) => check.state === "good").length}/{allChecks.length} good</span>
              </div>
              <div className="checks-list">
                {allChecks.map((check) => (
                  <div className="check-row" key={check.id}>
                    <StatusDot state={check.state} />
                    <div>
                      <strong>{check.label}</strong>
                      <span>{check.role === "reference" ? "Reference" : "Your ride"} · {check.note}</span>
                    </div>
                    <b>{check.value}</b>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <div className="metric-confidence">
            <article>
              <span className="confidence-label high">HIGH AFTER POSE GATE</span>
              <h3>Turn timing · torso line</h3>
              <p>Available only when both videos pass the same view and phase checks.</p>
            </article>
            <article>
              <span className="confidence-label medium">VIEW DEPENDENT</span>
              <h3>Knee flexion · fore/aft</h3>
              <p>Restricted when blur, foreshortening or ankle visibility is weak.</p>
            </article>
            <article>
              <span className="confidence-label unavailable">NOT MEASURABLE</span>
              <h3>Edge angle · pressure</h3>
              <p>Snowtrace will not estimate these from monocular pose video.</p>
            </article>
          </div>

          <div className="readiness-actions">
            <button type="button" className="primary-button centered-button" onClick={startLiveAnalysis}>
              Upload &amp; queue pose gate <span aria-hidden="true">→</span>
            </button>
          </div>
        </div>
      )}

      {screen === "processing" && (
        <div className="processing-screen">
          <div className="processing-orbit" aria-hidden="true"><span /></div>
          <span className="eyebrow">STEP 03 / 04</span>
          <h1>Securing your analysis session.</h1>
          <p>Upload progress is real. Coaching does not begin until the MediaPipe quality gate accepts both clips.</p>
          <div className="stage-list">
            {SUBMISSION_STAGES.map((stage, index) => {
              const state = index < activeStage ? "done" : index === activeStage ? "active" : "waiting";
              return (
                <div className={`stage-row ${state}`} key={stage.id}>
                  <span className="stage-marker">{state === "done" ? "✓" : state === "active" ? "→" : "·"}</span>
                  <div>
                    <strong>{stage.label}</strong>
                    <span>{stage.detail}{index === activeStage && (index === 1 || index === 2) ? ` · ${submissionProgress}%` : ""}</span>
                  </div>
                </div>
              );
            })}
          </div>
          {submissionError && (
            <div className="submission-error" role="alert">
              <strong>Submission stopped safely</strong>
              <p>{submissionError}</p>
              <div>
                <button type="button" className="secondary-button" onClick={() => setScreen("readiness")}>Back to footage check</button>
              </div>
            </div>
          )}
        </div>
      )}

      {screen === "queued" && (
        <div className="focused-screen queued-screen">
          <div className="queue-check" aria-hidden="true">✓</div>
          <span className="eyebrow">STEP 04 / 04 · REAL JOB CREATED</span>
          <h1>Your clips are stored.<br /><em>The pose gate is queued.</em></h1>
          <p className="queue-lede">
            No coaching report is generated until the MediaPipe worker inspects rider visibility, finds comparable turns and passes metric confidence thresholds. This page checks progress automatically.
          </p>
          <div className="queue-status-grid">
            <article><span>01</span><strong>Private upload</strong><p>Reference and rider files verified in video storage.</p></article>
            <article><span>02</span><strong>Analysis job</strong><p>{queueMessage}</p></article>
            <article><span>03</span><strong>Coaching output</strong><p>Locked until real evidence clears the quality gate.</p></article>
          </div>
          <div className="queue-identifiers">
            <span>Session <code>{sessionId?.slice(0, 18)}…</code></span>
            <span>Run <code>{analysisRunId?.slice(0, 18)}…</code></span>
          </div>
          <div className="queue-actions">
            <button type="button" className="primary-button" disabled={isCheckingStatus} onClick={() => refreshQueue()}>
              {isCheckingStatus ? "Checking…" : "Check now"}
            </button>
            <button type="button" className="danger-text-button" onClick={deleteQueuedSession}>Delete session &amp; both clips</button>
          </div>
        </div>
      )}

      {screen === "outcome" && analysisOutcome && (
        <div className="focused-screen outcome-screen">
          <div className={`outcome-mark ${analysisOutcome.kind}`} aria-hidden="true">
            {analysisOutcome.kind === "no_evidence" ? "≈" : analysisOutcome.kind === "footage" ? "!" : "↻"}
          </div>
          <span className="eyebrow">VIDEO INTELLIGENCE RESULT · NO COACHING GENERATED</span>
          <h1>{analysisOutcome.title}</h1>
          <p className="outcome-lede">{analysisOutcome.message}</p>

          {analysisOutcome.videos.length > 0 && (
            <div className="quality-result-grid">
              {analysisOutcome.videos.map((video) => (
                <section className="quality-result-card" key={video.role}>
                  <div className="quality-result-heading">
                    <div>
                      <span className="eyebrow">{video.role === "reference" ? "REFERENCE VIDEO" : "YOUR RIDE"}</span>
                      <h2>{video.readiness_score}/100 readiness</h2>
                    </div>
                    <span className={`quality-badge ${video.status}`}>{video.status}</span>
                  </div>
                  <div className="quality-check-list">
                    {video.checks.map((check) => (
                      <div className="quality-check-item" key={check.id}>
                        <StatusDot state={check.status} />
                        <div><strong>{check.label}</strong><span>{check.detail}</span></div>
                        <b>{Math.round(check.score)}</b>
                      </div>
                    ))}
                  </div>
                  {video.recapture_instructions.length > 0 && (
                    <div className="recapture-list">
                      <span>RECATCH THIS CLIP</span>
                      <ul>{video.recapture_instructions.map((instruction) => <li key={instruction}>{instruction}</li>)}</ul>
                    </div>
                  )}
                </section>
              ))}
            </div>
          )}

          <div className="outcome-actions">
            {analysisOutcome.retryable && (
              <button type="button" className="primary-button" onClick={retryAnalysisDispatch}>Retry analysis</button>
            )}
            <button type="button" className={analysisOutcome.retryable ? "secondary-button" : "primary-button"} onClick={deleteQueuedSession}>
              Delete clips &amp; choose new videos
            </button>
          </div>
          <p className="outcome-guardrail">Snowtrace did not turn uncertain footage into a confident coaching claim.</p>
        </div>
      )}

      {screen === "select-rider" && riderAction && reference && rider && (
        <div className="focused-screen rider-selection-screen">
          <div className="screen-heading">
            <span className="eyebrow">HUMAN-IN-THE-LOOP · RIDER IDENTITY</span>
            <h1>Which rider should Snowtrace follow?</h1>
            <p>The pose gate found more than one plausible person. Choose the outlined rider in each ambiguous clip; this changes tracking only, not the coaching standard.</p>
          </div>
          <div className="rider-role-list">
            {riderAction.roles.map(({ role, candidates }) => {
              const source = role === "reference" ? reference : rider;
              return (
                <section className="rider-role-section" key={role}>
                  <div className="rider-role-heading">
                    <span className="eyebrow">{role === "reference" ? "REFERENCE VIDEO" : "YOUR RIDE"}</span>
                    <strong>Choose one outlined rider</strong>
                  </div>
                  <div className="candidate-grid">
                    {candidates.map((candidate) => (
                      <RiderCandidateCard
                        key={candidate.track_id}
                        candidate={candidate}
                        video={source}
                        selected={selectedTracks[role] === candidate.track_id}
                        onSelect={() => setSelectedTracks((current) => ({ ...current, [role]: candidate.track_id }))}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
          <div className="rider-selection-actions">
            <button
              type="button"
              className="primary-button"
              disabled={!riderAction.roles.every(({ role }) => Number.isInteger(selectedTracks[role]))}
              onClick={submitRiderSelection}
            >
              Confirm rider &amp; restart pose gate <span aria-hidden="true">→</span>
            </button>
            <button type="button" className="danger-text-button" onClick={deleteQueuedSession}>Delete session &amp; both clips</button>
          </div>
          {queueMessage.startsWith("Rider selection") && <p className="error-message" role="alert">{queueMessage}</p>}
        </div>
      )}

      {screen === "report" && reference && rider && realEvidence && coaching && (
        <div className="report-screen">
          <div className="report-header">
            <div>
              <span className="eyebrow">STEP 04 / 04 · QUALITY-GATED EVIDENCE</span>
              <h1>Your biggest visible gap</h1>
            </div>
            <button type="button" className="secondary-button" onClick={reset}>New analysis</button>
          </div>

          <section className="finding-card">
            <div className="finding-index">01</div>
            <div className="finding-copy">
              <span className={`confidence-label ${realEvidence.confidence >= 0.8 ? "high" : "medium"}`}>
                {Math.round(realEvidence.confidence * 100)}% CONFIDENCE · {coaching.metricLabel.toUpperCase()}
              </span>
              <h2>{coaching.title}</h2>
              <p>{coaching.explanation}</p>
              <div className="evidence-stat">
                <div>
                  <span>Reference</span>
                  <strong>{formatEvidenceValue(realEvidence.details.reference_value, realEvidence.details.unit)}</strong>
                  <small>{realEvidence.phase}</small>
                </div>
                <div className="difference-arrow">→ <b>{realEvidence.details.difference > 0 ? "+" : ""}{formatEvidenceValue(realEvidence.details.difference, realEvidence.details.unit)}</b></div>
                <div>
                  <span>Your ride</span>
                  <strong>{formatEvidenceValue(realEvidence.details.user_value, realEvidence.details.unit)}</strong>
                  <small>{realEvidence.details.paired_turns} paired turns</small>
                </div>
              </div>
            </div>
          </section>

          <section className="video-compare">
            <div className="compare-toolbar">
              <div>
                <span className="eyebrow">SHOW ME WHERE</span>
                <h2>One paired turn. Exact evidence phase.</h2>
              </div>
              <div className="moment-tabs" role="tablist" aria-label="Turn phase">
                {[realEvidence.phase].map((moment) => (
                  <button type="button" role="tab" aria-selected={activeMoment === moment} className={activeMoment === moment ? "active" : ""} onClick={() => { setActiveMoment(moment); window.setTimeout(seekEvidence, 0); }} key={moment}>
                    {moment}
                  </button>
                ))}
              </div>
            </div>
            <div className="video-grid">
              <figure>
                <div className="video-label"><span>REFERENCE</span><b>{formatTimestamp(activeReferenceTimestamp)}</b></div>
                <video ref={referenceVideoRef} src={reference.previewUrl} muted playsInline controls preload="metadata" onLoadedMetadata={seekEvidence} />
                <figcaption>{reference.name}</figcaption>
              </figure>
              <figure>
                <div className="video-label"><span>YOUR RIDE</span><b>{formatTimestamp(activeRiderTimestamp)}</b></div>
                <video ref={riderVideoRef} src={rider.previewUrl} muted playsInline controls preload="metadata" onLoadedMetadata={seekEvidence} />
                <figcaption>{rider.name}</figcaption>
              </figure>
            </div>
          </section>

          <section className="coaching-grid">
            <article className="explanation-card">
              <span className="eyebrow">WHAT IT MAY MEAN</span>
              <h3>{coaching.explanation}</h3>
              <p>A deterministic coaching template turns one accepted metric into cautious language. It does not infer force, pressure or exact edge angle.</p>
            </article>
            <article className="drill-card">
              <span className="eyebrow">ONE DRILL FOR YOUR NEXT RUN</span>
              <h3>{coaching.drill.title}</h3>
              <ol>
                {coaching.drill.steps.map((step) => <li key={step}>{step}</li>)}
              </ol>
              <div className="success-cue"><span>SUCCESS CUE</span>{coaching.drill.successCue}</div>
            </article>
          </section>

          {realEvidence && sessionId && analysisRunId && (
            <section className="beta-feedback">
              <div className="beta-feedback-heading">
                <span className="eyebrow">BETA SIGNAL · 20 SECONDS</span>
                <h2>Did this create a useful next action?</h2>
                <p>These answers measure coaching usefulness, not your riding.</p>
              </div>
              <div className="feedback-question-grid">
                {feedbackQuestions.map((question) => (
                  <fieldset key={question.id} disabled={feedbackStatus === "sent" || feedbackStatus === "sending"}>
                    <legend>{question.label}</legend>
                    <div>
                      {question.options.map((option) => (
                        <button
                          type="button"
                          key={option.value}
                          className={feedbackAnswers[question.id] === option.value ? "selected" : ""}
                          onClick={() => setFeedbackAnswers((current) => ({ ...current, [question.id]: option.value }))}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                ))}
              </div>
              <button
                type="button"
                className="feedback-submit"
                disabled={Object.keys(feedbackAnswers).length !== 3 || feedbackStatus === "sending" || feedbackStatus === "sent"}
                onClick={submitFeedback}
              >
                {feedbackStatus === "sending" ? "Saving…" : feedbackStatus === "sent" ? "Feedback saved ✓" : "Send beta feedback"}
              </button>
              {feedbackStatus === "error" && <p className="error-message" role="alert">Feedback could not be saved. Your report is unaffected.</p>}
            </section>
          )}

          <footer className="report-footer">
            <BrandMark />
            <p>Evidence first. Confidence always visible.</p>
          </footer>
        </div>
      )}
    </main>
  );
}
