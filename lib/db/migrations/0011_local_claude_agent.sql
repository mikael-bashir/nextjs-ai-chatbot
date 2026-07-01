CREATE TABLE IF NOT EXISTS "LocalClaudeAgentConfig" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" uuid NOT NULL,
	"binaryPath" varchar(1024) DEFAULT 'claude' NOT NULL,
	"workingDirectory" text,
	"model" varchar(128),
	"permissionMode" varchar DEFAULT 'default' NOT NULL,
	"allowedTools" text,
	"maxTurns" integer,
	"timeoutMs" integer DEFAULT 120000 NOT NULL,
	"systemPromptAppend" text,
	"extraArgs" json,
	"enabled" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "LocalClaudeAgentConfig_userId_unique" UNIQUE("userId")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "LocalClaudeAgentConfig" ADD CONSTRAINT "LocalClaudeAgentConfig_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
