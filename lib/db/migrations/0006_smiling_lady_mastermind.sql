CREATE TABLE IF NOT EXISTS "CreditTransaction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" uuid NOT NULL,
	"amount" integer NOT NULL,
	"type" varchar(32) NOT NULL,
	"description" text NOT NULL,
	"createdAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "MCPServer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"url" text NOT NULL,
	"description" text,
	"authType" varchar DEFAULT 'none' NOT NULL,
	"credentials" json,
	"flaskServerId" varchar(255),
	"isActive" boolean DEFAULT true NOT NULL,
	"userId" uuid NOT NULL,
	"createdAt" timestamp NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "UserCredits" (
	"userId" uuid PRIMARY KEY NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "Document" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "Suggestion" ADD PRIMARY KEY ("id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "MCPServer" ADD CONSTRAINT "MCPServer_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "UserCredits" ADD CONSTRAINT "UserCredits_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN IF EXISTS "password";