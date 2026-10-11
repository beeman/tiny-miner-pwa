ALTER TABLE `mining_action` ADD `iron_health` integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE `mining_action` ADD `iron_ore` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `mining_counter` ADD `iron_health` integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE `mining_counter` ADD `iron_ore` integer DEFAULT 0 NOT NULL;