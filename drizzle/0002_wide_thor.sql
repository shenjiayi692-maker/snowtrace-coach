ALTER TABLE `videos` ADD `uploaded_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `feedback_events_analysis_type_uq` ON `feedback_events` (`analysis_run_id`,`event_type`);