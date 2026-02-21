CREATE TYPE "public"."software_policy_mode" AS ENUM('allowlist', 'blocklist', 'audit');--> statement-breakpoint
CREATE TABLE "software_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"mode" "software_policy_mode" NOT NULL,
	"rules" jsonb NOT NULL,
	"target_type" varchar(50) NOT NULL,
	"target_ids" jsonb,
	"priority" integer DEFAULT 50 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"enforce_mode" boolean DEFAULT false NOT NULL,
	"remediation_options" jsonb,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "software_compliance_status" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"status" varchar(20) DEFAULT 'compliant' NOT NULL,
	"last_checked" timestamp NOT NULL,
	"violations" jsonb,
	"remediation_status" varchar(20) DEFAULT 'none',
	"last_remediation_attempt" timestamp,
	"remediation_errors" jsonb
);
--> statement-breakpoint
CREATE TABLE "software_policy_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"policy_id" uuid,
	"device_id" uuid,
	"action" varchar(50) NOT NULL,
	"actor" varchar(50) NOT NULL,
	"actor_id" uuid,
	"details" jsonb,
	"timestamp" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "software_policies" ADD CONSTRAINT "software_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_policies" ADD CONSTRAINT "software_policies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_compliance_status" ADD CONSTRAINT "software_compliance_status_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_compliance_status" ADD CONSTRAINT "software_compliance_status_policy_id_software_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."software_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_policy_audit" ADD CONSTRAINT "software_policy_audit_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_policy_audit" ADD CONSTRAINT "software_policy_audit_policy_id_software_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."software_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_policy_audit" ADD CONSTRAINT "software_policy_audit_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_policy_audit" ADD CONSTRAINT "software_policy_audit_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "software_policies_org_id_idx" ON "software_policies" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "software_policies_target_type_idx" ON "software_policies" USING btree ("target_type");--> statement-breakpoint
CREATE INDEX "software_policies_active_priority_idx" ON "software_policies" USING btree ("is_active","priority");--> statement-breakpoint
CREATE INDEX "software_compliance_device_id_idx" ON "software_compliance_status" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "software_compliance_policy_id_idx" ON "software_compliance_status" USING btree ("policy_id");--> statement-breakpoint
CREATE INDEX "software_compliance_status_idx" ON "software_compliance_status" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "software_compliance_device_policy_unique" ON "software_compliance_status" USING btree ("device_id","policy_id");--> statement-breakpoint
CREATE INDEX "software_policy_audit_org_id_idx" ON "software_policy_audit" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "software_policy_audit_policy_id_idx" ON "software_policy_audit" USING btree ("policy_id");--> statement-breakpoint
CREATE INDEX "software_policy_audit_device_id_idx" ON "software_policy_audit" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "software_policy_audit_timestamp_idx" ON "software_policy_audit" USING btree ("timestamp");
