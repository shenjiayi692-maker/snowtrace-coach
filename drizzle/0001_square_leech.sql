CREATE TABLE `analysis_outputs` (
	`id` text PRIMARY KEY NOT NULL,
	`analysis_run_id` text NOT NULL,
	`status` text NOT NULL,
	`result_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`analysis_run_id`) REFERENCES `analysis_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `analysis_outputs_run_uq` ON `analysis_outputs` (`analysis_run_id`);