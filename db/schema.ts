import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
};

export const profiles = sqliteTable("profiles", {
  id: text("id").primaryKey(),
  anonymousId: text("anonymous_id").notNull(),
  locale: text("locale", { enum: ["en", "zh"] }).notNull().default("en"),
  stance: text("stance", { enum: ["regular", "goofy"] }).notNull().default("regular"),
  level: text("level", { enum: ["intermediate", "advanced"] }).notNull().default("intermediate"),
  consentVersion: text("consent_version"),
  ...timestamps,
}, (table) => [uniqueIndex("profiles_anonymous_id_uq").on(table.anonymousId)]);

export const progressions = sqliteTable("progressions", {
  id: text("id").primaryKey(),
  profileId: text("profile_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  goal: text("goal", { enum: ["medium", "short", "dynamic"] }).notNull(),
  framework: text("framework", { enum: ["none", "casi", "aasi", "jsba"] }).notNull().default("none"),
  referenceVideoId: text("reference_video_id"),
  status: text("status", { enum: ["active", "archived"] }).notNull().default("active"),
  ...timestamps,
}, (table) => [index("progressions_profile_idx").on(table.profileId)]);

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  progressionId: text("progression_id").notNull().references(() => progressions.id, { onDelete: "cascade" }),
  slopeContext: text("slope_context"),
  cameraMode: text("camera_mode", { enum: ["fixed", "follow"] }).notNull(),
  viewAngle: text("view_angle", { enum: ["three-quarter", "side", "front-rear"] }).notNull(),
  referenceCameraMode: text("reference_camera_mode", { enum: ["fixed", "follow"] }).notNull().default("fixed"),
  referenceViewAngle: text("reference_view_angle", { enum: ["three-quarter", "side", "front-rear"] }).notNull().default("three-quarter"),
  riderTravelDirection: text("rider_travel_direction", { enum: ["left-to-right", "right-to-left"] }).notNull().default("left-to-right"),
  referenceTravelDirection: text("reference_travel_direction", { enum: ["left-to-right", "right-to-left"] }).notNull().default("left-to-right"),
  riderStance: text("rider_stance", { enum: ["regular", "goofy"] }).notNull().default("regular"),
  referenceStance: text("reference_stance", { enum: ["regular", "goofy"] }).notNull().default("regular"),
  riderFirstEdge: text("rider_first_edge", { enum: ["heelside", "toeside", "unknown"] }).notNull().default("unknown"),
  referenceFirstEdge: text("reference_first_edge", { enum: ["heelside", "toeside", "unknown"] }).notNull().default("unknown"),
  status: text("status", { enum: ["draft", "processing", "completed", "failed"] }).notNull().default("draft"),
  ...timestamps,
}, (table) => [index("sessions_progression_idx").on(table.progressionId)]);

export const videos = sqliteTable("videos", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["reference", "rider"] }).notNull(),
  objectKey: text("object_key").notNull(),
  proxyObjectKey: text("proxy_object_key"),
  originalName: text("original_name").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  durationSeconds: real("duration_seconds"),
  width: integer("width"),
  height: integer("height"),
  metadataJson: text("metadata_json", { mode: "json" }),
  uploadedAt: text("uploaded_at"),
  expiresAt: text("expires_at").notNull(),
  deletedAt: text("deleted_at"),
  ...timestamps,
}, (table) => [
  index("videos_session_idx").on(table.sessionId),
  index("videos_expiry_idx").on(table.expiresAt),
]);

export const riderTracks = sqliteTable("rider_tracks", {
  id: text("id").primaryKey(),
  videoId: text("video_id").notNull().references(() => videos.id, { onDelete: "cascade" }),
  candidateIndex: integer("candidate_index").notNull(),
  confidence: real("confidence").notNull(),
  selected: integer("selected", { mode: "boolean" }).notNull().default(false),
  selectedBy: text("selected_by", { enum: ["automatic", "user"] }),
  representativeFrameMs: integer("representative_frame_ms"),
  artifactKey: text("artifact_key"),
  ...timestamps,
}, (table) => [index("rider_tracks_video_idx").on(table.videoId)]);

export const segments = sqliteTable("segments", {
  id: text("id").primaryKey(),
  videoId: text("video_id").notNull().references(() => videos.id, { onDelete: "cascade" }),
  riderTrackId: text("rider_track_id").references(() => riderTracks.id, { onDelete: "set null" }),
  startMs: integer("start_ms").notNull(),
  endMs: integer("end_ms").notNull(),
  source: text("source", { enum: ["automatic", "user"] }).notNull(),
  readinessScore: integer("readiness_score"),
  qualityStatus: text("quality_status", { enum: ["full", "limited", "rejected"] }),
  qualityJson: text("quality_json", { mode: "json" }),
  ...timestamps,
}, (table) => [index("segments_video_idx").on(table.videoId)]);

export const analysisRuns = sqliteTable("analysis_runs", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  status: text("status", {
    enum: ["queued", "quality_check", "needs_rider", "needs_markers", "analyzing", "coaching", "completed", "failed"],
  }).notNull().default("queued"),
  stage: text("stage"),
  pipelineVersion: text("pipeline_version").notNull(),
  modelVersion: text("model_version"),
  promptVersion: text("prompt_version"),
  drillLibraryVersion: text("drill_library_version"),
  errorCode: text("error_code"),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  ...timestamps,
}, (table) => [index("analysis_runs_session_idx").on(table.sessionId)]);

export const turns = sqliteTable("turns", {
  id: text("id").primaryKey(),
  analysisRunId: text("analysis_run_id").notNull().references(() => analysisRuns.id, { onDelete: "cascade" }),
  videoId: text("video_id").notNull().references(() => videos.id, { onDelete: "cascade" }),
  turnIndex: integer("turn_index").notNull(),
  edgeType: text("edge_type", { enum: ["heelside", "toeside", "unknown"] }).notNull(),
  startMs: integer("start_ms").notNull(),
  apexMs: integer("apex_ms").notNull(),
  endMs: integer("end_ms").notNull(),
  markerSource: text("marker_source", { enum: ["automatic", "user"] }).notNull(),
  confidence: real("confidence").notNull(),
}, (table) => [index("turns_analysis_idx").on(table.analysisRunId)]);

export const metricResults = sqliteTable("metric_results", {
  id: text("id").primaryKey(),
  analysisRunId: text("analysis_run_id").notNull().references(() => analysisRuns.id, { onDelete: "cascade" }),
  turnId: text("turn_id").references(() => turns.id, { onDelete: "cascade" }),
  videoId: text("video_id").notNull().references(() => videos.id, { onDelete: "cascade" }),
  metricId: text("metric_id").notNull(),
  confidence: real("confidence").notNull(),
  phaseSummaryJson: text("phase_summary_json", { mode: "json" }).notNull(),
  curveArtifactKey: text("curve_artifact_key"),
}, (table) => [
  index("metric_results_analysis_idx").on(table.analysisRunId),
  index("metric_results_metric_idx").on(table.metricId),
]);

export const comparisonEvidence = sqliteTable("comparison_evidence", {
  id: text("id").primaryKey(),
  analysisRunId: text("analysis_run_id").notNull().references(() => analysisRuns.id, { onDelete: "cascade" }),
  metricId: text("metric_id").notNull(),
  edgeType: text("edge_type", { enum: ["heelside", "toeside", "unknown"] }).notNull().default("unknown"),
  rank: integer("rank").notNull(),
  confidence: real("confidence").notNull(),
  effectSize: real("effect_size").notNull(),
  phase: text("phase", { enum: ["initiation", "shaping", "apex", "completion"] }).notNull(),
  userTimestampMs: integer("user_timestamp_ms").notNull(),
  referenceTimestampMs: integer("reference_timestamp_ms").notNull(),
  evidenceJson: text("evidence_json", { mode: "json" }).notNull(),
}, (table) => [index("comparison_evidence_analysis_idx").on(table.analysisRunId)]);

export const analysisOutputs = sqliteTable("analysis_outputs", {
  id: text("id").primaryKey(),
  analysisRunId: text("analysis_run_id").notNull().references(() => analysisRuns.id, { onDelete: "cascade" }),
  status: text("status", { enum: ["completed", "needs_rider", "rejected", "failed"] }).notNull(),
  resultJson: text("result_json", { mode: "json" }).notNull(),
  ...timestamps,
}, (table) => [uniqueIndex("analysis_outputs_run_uq").on(table.analysisRunId)]);

export const drillLibrary = sqliteTable("drill_library", {
  id: text("id").primaryKey(),
  version: text("version").notNull(),
  titleEn: text("title_en").notNull(),
  titleZh: text("title_zh").notNull(),
  bodyEnJson: text("body_en_json", { mode: "json" }).notNull(),
  bodyZhJson: text("body_zh_json", { mode: "json" }).notNull(),
  allowedMetricIdsJson: text("allowed_metric_ids_json", { mode: "json" }).notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  ...timestamps,
});

export const reports = sqliteTable("reports", {
  id: text("id").primaryKey(),
  analysisRunId: text("analysis_run_id").notNull().references(() => analysisRuns.id, { onDelete: "cascade" }),
  evidenceId: text("evidence_id").notNull().references(() => comparisonEvidence.id, { onDelete: "cascade" }),
  drillId: text("drill_id").references(() => drillLibrary.id, { onDelete: "set null" }),
  locale: text("locale", { enum: ["en", "zh"] }).notNull(),
  schemaVersion: text("schema_version").notNull(),
  contentJson: text("content_json", { mode: "json" }).notNull(),
  ...timestamps,
}, (table) => [uniqueIndex("reports_analysis_locale_uq").on(table.analysisRunId, table.locale)]);

export const feedbackEvents = sqliteTable("feedback_events", {
  id: text("id").primaryKey(),
  profileId: text("profile_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  analysisRunId: text("analysis_run_id").references(() => analysisRuns.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  valueJson: text("value_json", { mode: "json" }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("feedback_events_analysis_idx").on(table.analysisRunId),
  uniqueIndex("feedback_events_analysis_type_uq").on(table.analysisRunId, table.eventType),
]);
