ALTER TABLE `comparison_evidence` ADD `edge_type` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `rider_first_edge` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `reference_first_edge` text DEFAULT 'unknown' NOT NULL;