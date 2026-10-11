CREATE TABLE `mining_action` (
	`action_id` text NOT NULL,
	`copper` integer NOT NULL,
	`health` integer NOT NULL,
	`revision` integer NOT NULL,
	`user_id` text NOT NULL,
	`xp` integer NOT NULL,
	PRIMARY KEY(`action_id`, `user_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `mining_counter` ADD `copper` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `mining_counter` ADD `health` integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE `mining_counter` ADD `xp` integer DEFAULT 0 NOT NULL;