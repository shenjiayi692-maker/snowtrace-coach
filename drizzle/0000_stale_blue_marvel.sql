CREATE TABLE `analysis_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`stage` text,
	`pipeline_version` text NOT NULL,
	`model_version` text,
	`prompt_version` text,
	`drill_library_version` text,
	`error_code` text,
	`started_at` text,
	`completed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `analysis_runs_session_idx` ON `analysis_runs` (`session_id`);--> statement-breakpoint
CREATE TABLE `comparison_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`analysis_run_id` text NOT NULL,
	`metric_id` text NOT NULL,
	`rank` integer NOT NULL,
	`confidence` real NOT NULL,
	`effect_size` real NOT NULL,
	`phase` text NOT NULL,
	`user_timestamp_ms` integer NOT NULL,
	`reference_timestamp_ms` integer NOT NULL,
	`evidence_json` text NOT NULL,
	FOREIGN KEY (`analysis_run_id`) REFERENCES `analysis_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `comparison_evidence_analysis_idx` ON `comparison_evidence` (`analysis_run_id`);--> statement-breakpoint
CREATE TABLE `drill_library` (
	`id` text PRIMARY KEY NOT NULL,
	`version` text NOT NULL,
	`title_en` text NOT NULL,
	`title_zh` text NOT NULL,
	`body_en_json` text NOT NULL,
	`body_zh_json` text NOT NULL,
	`allowed_metric_ids_json` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `feedback_events` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`analysis_run_id` text,
	`event_type` text NOT NULL,
	`value_json` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`analysis_run_id`) REFERENCES `analysis_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `feedback_events_analysis_idx` ON `feedback_events` (`analysis_run_id`);--> statement-breakpoint
CREATE TABLE `metric_results` (
	`id` text PRIMARY KEY NOT NULL,
	`analysis_run_id` text NOT NULL,
	`turn_id` text,
	`video_id` text NOT NULL,
	`metric_id` text NOT NULL,
	`confidence` real NOT NULL,
	`phase_summary_json` text NOT NULL,
	`curve_artifact_key` text,
	FOREIGN KEY (`analysis_run_id`) REFERENCES `analysis_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`turn_id`) REFERENCES `turns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `metric_results_analysis_idx` ON `metric_results` (`analysis_run_id`);--> statement-breakpoint
CREATE INDEX `metric_results_metric_idx` ON `metric_results` (`metric_id`);--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`anonymous_id` text NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	`stance` text DEFAULT 'regular' NOT NULL,
	`level` text DEFAULT 'intermediate' NOT NULL,
	`consent_version` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profiles_anonymous_id_uq` ON `profiles` (`anonymous_id`);--> statement-breakpoint
CREATE TABLE `progressions` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`goal` text NOT NULL,
	`framework` text DEFAULT 'none' NOT NULL,
	`reference_video_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `progressions_profile_idx` ON `progressions` (`profile_id`);--> statement-breakpoint
CREATE TABLE `reports` (
	`id` text PRIMARY KEY NOT NULL,
	`analysis_run_id` text NOT NULL,
	`evidence_id` text NOT NULL,
	`drill_id` text,
	`locale` text NOT NULL,
	`schema_version` text NOT NULL,
	`content_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`analysis_run_id`) REFERENCES `analysis_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`evidence_id`) REFERENCES `comparison_evidence`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`drill_id`) REFERENCES `drill_library`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reports_analysis_locale_uq` ON `reports` (`analysis_run_id`,`locale`);--> statement-breakpoint
CREATE TABLE `rider_tracks` (
	`id` text PRIMARY KEY NOT NULL,
	`video_id` text NOT NULL,
	`candidate_index` integer NOT NULL,
	`confidence` real NOT NULL,
	`selected` integer DEFAULT false NOT NULL,
	`selected_by` text,
	`representative_frame_ms` integer,
	`artifact_key` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `rider_tracks_video_idx` ON `rider_tracks` (`video_id`);--> statement-breakpoint
CREATE TABLE `segments` (
	`id` text PRIMARY KEY NOT NULL,
	`video_id` text NOT NULL,
	`rider_track_id` text,
	`start_ms` integer NOT NULL,
	`end_ms` integer NOT NULL,
	`source` text NOT NULL,
	`readiness_score` integer,
	`quality_status` text,
	`quality_json` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`rider_track_id`) REFERENCES `rider_tracks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `segments_video_idx` ON `segments` (`video_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`progression_id` text NOT NULL,
	`slope_context` text,
	`camera_mode` text NOT NULL,
	`view_angle` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`progression_id`) REFERENCES `progressions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_progression_idx` ON `sessions` (`progression_id`);--> statement-breakpoint
CREATE TABLE `turns` (
	`id` text PRIMARY KEY NOT NULL,
	`analysis_run_id` text NOT NULL,
	`video_id` text NOT NULL,
	`turn_index` integer NOT NULL,
	`edge_type` text NOT NULL,
	`start_ms` integer NOT NULL,
	`apex_ms` integer NOT NULL,
	`end_ms` integer NOT NULL,
	`marker_source` text NOT NULL,
	`confidence` real NOT NULL,
	FOREIGN KEY (`analysis_run_id`) REFERENCES `analysis_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `turns_analysis_idx` ON `turns` (`analysis_run_id`);--> statement-breakpoint
CREATE TABLE `videos` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`object_key` text NOT NULL,
	`proxy_object_key` text,
	`original_name` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`duration_seconds` real,
	`width` integer,
	`height` integer,
	`metadata_json` text,
	`expires_at` text NOT NULL,
	`deleted_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `videos_session_idx` ON `videos` (`session_id`);--> statement-breakpoint
CREATE INDEX `videos_expiry_idx` ON `videos` (`expires_at`);