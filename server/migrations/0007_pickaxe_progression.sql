ALTER TABLE `mining_action` ADD `golden_pickaxe_owned` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `mining_action` ADD `equipped_pickaxe` text DEFAULT 'wooden' NOT NULL;--> statement-breakpoint
ALTER TABLE `mining_action` ADD `steel_pickaxe_owned` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `mining_counter` ADD `golden_pickaxe_owned` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `mining_counter` ADD `equipped_pickaxe` text DEFAULT 'wooden' NOT NULL;--> statement-breakpoint
ALTER TABLE `mining_counter` ADD `steel_pickaxe_owned` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `mining_counter` SET `equipped_pickaxe` = 'iron' WHERE `iron_pickaxe_owned` = 1;--> statement-breakpoint
UPDATE `mining_action` SET `equipped_pickaxe` = 'iron' WHERE `iron_pickaxe_owned` = 1;
