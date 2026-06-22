CREATE TABLE IF NOT EXISTS "StripeCustomer" (
	"userId" uuid PRIMARY KEY NOT NULL,
	"stripeCustomerId" varchar(255) NOT NULL,
	"createdAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "StripeSubscription" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" uuid NOT NULL,
	"stripeSubscriptionId" varchar(255) NOT NULL,
	"planId" varchar(50) NOT NULL,
	"status" varchar(50) NOT NULL,
	"currentPeriodEnd" timestamp NOT NULL,
	"createdAt" timestamp NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "CreditTransaction" ALTER COLUMN "amount" SET DATA TYPE real;--> statement-breakpoint
ALTER TABLE "UserCredits" ALTER COLUMN "balance" SET DATA TYPE real;--> statement-breakpoint
ALTER TABLE "CreditTransaction" ADD COLUMN "tokensInput" integer;--> statement-breakpoint
ALTER TABLE "CreditTransaction" ADD COLUMN "tokensOutput" integer;--> statement-breakpoint
ALTER TABLE "CreditTransaction" ADD COLUMN "modelId" varchar(128);--> statement-breakpoint
ALTER TABLE "CreditTransaction" ADD COLUMN "rawCostGbp" real;--> statement-breakpoint
ALTER TABLE "CreditTransaction" ADD COLUMN "markupFactor" real;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "StripeCustomer" ADD CONSTRAINT "StripeCustomer_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "StripeSubscription" ADD CONSTRAINT "StripeSubscription_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
