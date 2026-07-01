ALTER TABLE "User" ADD COLUMN "username" varchar(32);
--> statement-breakpoint
ALTER TABLE "User" ADD CONSTRAINT "User_username_unique" UNIQUE("username");
