CREATE TABLE `premium_purchase_intent` (
	`amount` integer NOT NULL,
	`item_id` text NOT NULL,
	`mint` text NOT NULL,
	`network` text NOT NULL,
	`recipient` text NOT NULL,
	`reference` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'unresolved' NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `premium_purchase_intent_unresolved` ON `premium_purchase_intent` (`user_id`,`item_id`) WHERE "premium_purchase_intent"."status" = 'unresolved';