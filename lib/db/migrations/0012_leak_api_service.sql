CREATE TABLE IF NOT EXISTS "ApiKey" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" uuid NOT NULL,
	"name" varchar(64) DEFAULT 'default' NOT NULL,
	"keyHash" varchar(64) NOT NULL,
	"prefix" varchar(24) NOT NULL,
	"lastUsedAt" timestamp,
	"revokedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ApiKey_keyHash_unique" UNIQUE("keyHash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ProblemJob" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" uuid NOT NULL,
	"apiKeyId" uuid,
	"problem" text NOT NULL,
	"isMock" boolean DEFAULT false NOT NULL,
	"status" varchar DEFAULT 'queued' NOT NULL,
	"pricingClass" varchar(32),
	"quotedCredits" real,
	"chargedCredits" real,
	"leasedBy" varchar(128),
	"leaseExpiresAt" timestamp,
	"heartbeatAt" timestamp,
	"attempts" integer DEFAULT 0 NOT NULL,
	"proof" text,
	"resultError" text,
	"tokensInput" integer,
	"tokensOutput" integer,
	"modelId" varchar(128),
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"leasedAt" timestamp,
	"finishedAt" timestamp
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ProblemJob" ADD CONSTRAINT "ProblemJob_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ProblemJob" ADD CONSTRAINT "ProblemJob_apiKeyId_ApiKey_id_fk" FOREIGN KEY ("apiKeyId") REFERENCES "public"."ApiKey"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- The worker leases the oldest queued job; index the hot path.
CREATE INDEX IF NOT EXISTS "ProblemJob_status_createdAt_idx" ON "ProblemJob" ("status","createdAt");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ProblemJob_userId_idx" ON "ProblemJob" ("userId");
