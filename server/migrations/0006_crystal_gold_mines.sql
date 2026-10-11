ALTER TABLE `mining_action` ADD `crystal_health` integer DEFAULT 40 NOT NULL;--> statement-breakpoint
ALTER TABLE `mining_action` ADD `crystal_ore` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `mining_action` ADD `gold_health` integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE `mining_action` ADD `gold_ore` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `mining_counter` ADD `crystal_health` integer DEFAULT 40 NOT NULL;--> statement-breakpoint
ALTER TABLE `mining_counter` ADD `crystal_ore` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `mining_counter` ADD `gold_health` integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE `mining_counter` ADD `gold_ore` integer DEFAULT 0 NOT NULL;