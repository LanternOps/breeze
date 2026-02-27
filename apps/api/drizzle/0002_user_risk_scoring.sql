CREATE TABLE "user_risk_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"score" integer NOT NULL,
	"factors" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"trend_direction" varchar(20),
	"calculated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_risk_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"event_type" varchar(60) NOT NULL,
	"severity" varchar(20),
	"score_impact" integer DEFAULT 0 NOT NULL,
	"description" text NOT NULL,
	"details" jsonb,
	"occurred_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_risk_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"weights" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"thresholds" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"interventions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_risk_scores" ADD CONSTRAINT "user_risk_scores_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_risk_scores" ADD CONSTRAINT "user_risk_scores_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_risk_events" ADD CONSTRAINT "user_risk_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_risk_events" ADD CONSTRAINT "user_risk_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_risk_policies" ADD CONSTRAINT "user_risk_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_risk_policies" ADD CONSTRAINT "user_risk_policies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_risk_org_user_calc_idx" ON "user_risk_scores" USING btree ("org_id","user_id","calculated_at");--> statement-breakpoint
CREATE INDEX "user_risk_score_idx" ON "user_risk_scores" USING btree ("score");--> statement-breakpoint
CREATE INDEX "user_risk_org_score_idx" ON "user_risk_scores" USING btree ("org_id","score");--> statement-breakpoint
CREATE INDEX "user_risk_org_user_idx" ON "user_risk_scores" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "user_risk_events_org_user_time_idx" ON "user_risk_events" USING btree ("org_id","user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "user_risk_events_org_event_type_time_idx" ON "user_risk_events" USING btree ("org_id","event_type","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_risk_policy_org_idx" ON "user_risk_policies" USING btree ("org_id");
