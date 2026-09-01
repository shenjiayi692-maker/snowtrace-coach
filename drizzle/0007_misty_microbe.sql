CREATE TABLE `instructor_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`analysis_run_id` text NOT NULL,
	`phase_inspectable` text NOT NULL,
	`metric_direction_plausible` text NOT NULL,
	`explanation_assessment` text NOT NULL,
	`drill_assessment` text NOT NULL,
	`misleading_severity` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`analysis_run_id`) REFERENCES `analysis_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `instructor_reviews_analysis_uq` ON `instructor_reviews` (`analysis_run_id`);