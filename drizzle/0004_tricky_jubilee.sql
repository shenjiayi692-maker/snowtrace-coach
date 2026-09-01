ALTER TABLE `sessions` ADD `reference_camera_mode` text DEFAULT 'fixed' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `reference_view_angle` text DEFAULT 'three-quarter' NOT NULL;