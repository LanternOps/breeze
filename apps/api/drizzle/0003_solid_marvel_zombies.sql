CREATE TYPE IF NOT EXISTS "public"."partner_status" AS ENUM('pending', 'active', 'suspended', 'churned');--> statement-breakpoint
CREATE TYPE IF NOT EXISTS "public"."ip_assignment_type" AS ENUM('dhcp', 'static', 'vpn', 'link-local', 'unknown');--> statement-breakpoint
CREATE TYPE IF NOT EXISTS "public"."initiated_by_type" AS ENUM('manual', 'ai', 'automation', 'policy', 'schedule', 'agent', 'integration');--> statement-breakpoint
CREATE TYPE IF NOT EXISTS "public"."discovered_asset_approval_status" AS ENUM('pending', 'approved', 'dismissed');--> statement-breakpoint
CREATE TYPE IF NOT EXISTS "public"."network_event_type" AS ENUM('new_device', 'device_disappeared', 'device_changed', 'rogue_device');--> statement-breakpoint
CREATE TYPE IF NOT EXISTS "public"."software_policy_mode" AS ENUM('allowlist', 'blocklist', 'audit');--> statement-breakpoint
CREATE TYPE IF NOT EXISTS "public"."config_assignment_level" AS ENUM('partner', 'organization', 'site', 'device_group', 'device');--> statement-breakpoint
CREATE TYPE IF NOT EXISTS "public"."config_feature_type" AS ENUM('patch', 'alert_rule', 'backup', 'security', 'monitoring', 'maintenance', 'compliance', 'automation', 'event_log', 'software_policy', 'sensitive_data', 'peripheral_control', 'warranty', 'helper');--> statement-breakpoint
CREATE TYPE IF NOT EXISTS "public"."config_policy_status" AS ENUM('active', 'inactive', 'archived');--> statement-breakpoint
CREATE TYPE IF NOT EXISTS "public"."monitoring_watch_type" AS ENUM('service', 'process');--> statement-breakpoint
CREATE TYPE IF NOT EXISTS "public"."log_correlation_severity" AS ENUM('info', 'warning', 'error', 'critical');--> statement-breakpoint
CREATE TYPE IF NOT EXISTS "public"."log_correlation_status" AS ENUM('active', 'resolved', 'ignored');--> statement-breakpoint
CREATE TYPE IF NOT EXISTS "public"."trend_direction" AS ENUM('improving', 'stable', 'degrading');--> statement-breakpoint
CREATE TYPE IF NOT EXISTS "public"."ai_approval_mode" AS ENUM('per_step', 'action_plan', 'auto_approve', 'hybrid_plan');--> statement-breakpoint
CREATE TYPE IF NOT EXISTS "public"."ai_plan_status" AS ENUM('pending', 'approved', 'rejected', 'executing', 'completed', 'aborted');--> statement-breakpoint
CREATE TYPE IF NOT EXISTS "public"."agent_log_level" AS ENUM('debug', 'info', 'warn', 'error');--> statement-breakpoint
CREATE TYPE IF NOT EXISTS "public"."brain_context_type" AS ENUM('issue', 'quirk', 'followup', 'preference');--> statement-breakpoint
CREATE TYPE IF NOT EXISTS "public"."playbook_execution_status" AS ENUM('pending', 'running', 'waiting', 'completed', 'failed', 'rolled_back', 'cancelled');--> statement-breakpoint
CREATE TYPE IF NOT EXISTS "public"."playbook_step_type" AS ENUM('diagnose', 'act', 'wait', 'verify', 'rollback');--> statement-breakpoint
CREATE TYPE IF NOT EXISTS "public"."change_action" AS ENUM('added', 'removed', 'modified', 'updated');--> statement-breakpoint
CREATE TYPE IF NOT EXISTS "public"."change_type" AS ENUM('software', 'service', 'startup', 'network', 'scheduled_task', 'user_account');--> statement-breakpoint
CREATE TYPE IF NOT EXISTS "public"."dns_action" AS ENUM('allowed', 'blocked', 'redirected');--> statement-breakpoint
CREATE TYPE IF NOT EXISTS "public"."dns_policy_sync_status" AS ENUM('pending', 'synced', 'error');--> statement-breakpoint
CREATE TYPE IF NOT EXISTS "public"."dns_policy_type" AS ENUM('blocklist', 'allowlist');--> statement-breakpoint
CREATE TYPE IF NOT EXISTS "public"."dns_provider" AS ENUM('umbrella', 'cloudflare', 'dnsfilter', 'pihole', 'opendns', 'quad9');--> statement-breakpoint
CREATE TYPE IF NOT EXISTS "public"."dns_threat_category" AS ENUM('malware', 'phishing', 'botnet', 'cryptomining', 'ransomware', 'spam', 'adware', 'adult_content', 'gambling', 'social_media', 'streaming', 'unknown');--> statement-breakpoint
CREATE TYPE IF NOT EXISTS "public"."cis_baseline_level" AS ENUM('l1', 'l2', 'custom');--> statement-breakpoint
CREATE TYPE IF NOT EXISTS "public"."cis_check_severity" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE IF NOT EXISTS "public"."cis_check_status" AS ENUM('pass', 'fail', 'not_applicable', 'error');--> statement-breakpoint
CREATE TYPE IF NOT EXISTS "public"."cis_os_type" AS ENUM('windows', 'macos', 'linux');--> statement-breakpoint
CREATE TYPE IF NOT EXISTS "public"."cis_remediation_approval_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE IF NOT EXISTS "public"."cis_remediation_status" AS ENUM('pending_approval', 'queued', 'in_progress', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE IF NOT EXISTS "public"."peripheral_device_class" AS ENUM('storage', 'all_usb', 'bluetooth', 'thunderbolt');--> statement-breakpoint
CREATE TYPE IF NOT EXISTS "public"."peripheral_event_type" AS ENUM('connected', 'disconnected', 'blocked', 'mounted_read_only', 'policy_override');--> statement-breakpoint
CREATE TYPE IF NOT EXISTS "public"."peripheral_policy_action" AS ENUM('allow', 'block', 'read_only', 'alert');--> statement-breakpoint
CREATE TYPE IF NOT EXISTS "public"."peripheral_policy_target_type" AS ENUM('organization', 'site', 'group', 'device');--> statement-breakpoint
CREATE TYPE IF NOT EXISTS "public"."check_result_status" AS ENUM('running', 'stopped', 'not_found', 'error');--> statement-breakpoint
CREATE TYPE IF NOT EXISTS "public"."warranty_status" AS ENUM('active', 'expiring', 'expired', 'unknown');--> statement-breakpoint
ALTER TYPE "public"."plan_type" ADD VALUE 'starter' BEFORE 'pro';--> statement-breakpoint
ALTER TYPE "public"."plan_type" ADD VALUE 'community' BEFORE 'pro';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "device_boot_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"boot_timestamp" timestamp NOT NULL,
	"bios_seconds" real,
	"os_loader_seconds" real,
	"desktop_ready_seconds" real,
	"total_boot_seconds" real NOT NULL,
	"startup_item_count" integer NOT NULL,
	"startup_items" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "device_boot_metrics_device_boot_uniq" UNIQUE("device_id","boot_timestamp")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "device_ip_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"interface_name" varchar(100) NOT NULL,
	"ip_address" varchar(45) NOT NULL,
	"ip_type" varchar(4) DEFAULT 'ipv4' NOT NULL,
	"assignment_type" "ip_assignment_type" DEFAULT 'unknown' NOT NULL,
	"mac_address" varchar(17),
	"subnet_mask" varchar(45),
	"gateway" varchar(45),
	"dns_servers" text[],
	"first_seen" timestamp DEFAULT now() NOT NULL,
	"last_seen" timestamp DEFAULT now() NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"deactivated_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_routing_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"priority" integer NOT NULL,
	"conditions" jsonb NOT NULL,
	"channel_ids" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "network_baselines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"subnet" varchar(50) NOT NULL,
	"last_scan_at" timestamp,
	"last_scan_job_id" uuid,
	"known_devices" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scan_schedule" jsonb,
	"alert_settings" jsonb DEFAULT '{"newDevice":true,"disappeared":true,"changed":true,"rogueDevice":false}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "network_change_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"baseline_id" uuid NOT NULL,
	"profile_id" uuid,
	"event_type" "network_event_type" NOT NULL,
	"ip_address" "inet" NOT NULL,
	"mac_address" varchar(17),
	"hostname" varchar(255),
	"asset_type" "discovered_asset_type",
	"previous_state" jsonb,
	"current_state" jsonb,
	"detected_at" timestamp DEFAULT now() NOT NULL,
	"acknowledged" boolean DEFAULT false NOT NULL,
	"acknowledged_by" uuid,
	"acknowledged_at" timestamp,
	"alert_id" uuid,
	"linked_device_id" uuid,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "network_known_guests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_id" uuid NOT NULL,
	"mac_address" varchar(17) NOT NULL,
	"label" varchar(255) NOT NULL,
	"notes" text,
	"added_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "software_compliance_status" (
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
CREATE TABLE IF NOT EXISTS "software_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"mode" "software_policy_mode" NOT NULL,
	"rules" jsonb NOT NULL,
	"target_type" varchar(50),
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
CREATE TABLE IF NOT EXISTS "software_policy_audit" (
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
CREATE TABLE IF NOT EXISTS "config_policy_alert_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feature_link_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"severity" "alert_severity" NOT NULL,
	"conditions" jsonb NOT NULL,
	"cooldown_minutes" integer DEFAULT 5 NOT NULL,
	"auto_resolve" boolean DEFAULT false NOT NULL,
	"auto_resolve_conditions" jsonb,
	"title_template" text DEFAULT '{{ruleName}} triggered on {{deviceName}}' NOT NULL,
	"message_template" text DEFAULT '{{ruleName}} condition met' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "config_policy_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"config_policy_id" uuid NOT NULL,
	"level" "config_assignment_level" NOT NULL,
	"target_id" uuid NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"role_filter" varchar(30)[],
	"os_filter" varchar(10)[],
	"assigned_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "config_policy_automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feature_link_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"trigger_type" varchar(50) NOT NULL,
	"cron_expression" varchar(100),
	"timezone" varchar(100),
	"event_type" varchar(200),
	"actions" jsonb NOT NULL,
	"on_failure" "automation_on_failure" DEFAULT 'stop' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "config_policy_compliance_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feature_link_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"rules" jsonb NOT NULL,
	"enforcement_level" "policy_enforcement" DEFAULT 'monitor' NOT NULL,
	"check_interval_minutes" integer DEFAULT 60 NOT NULL,
	"remediation_script_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "config_policy_event_log_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feature_link_id" uuid NOT NULL,
	"retention_days" integer DEFAULT 30 NOT NULL,
	"max_events_per_cycle" integer DEFAULT 100 NOT NULL,
	"collect_categories" text[] DEFAULT '{"security","hardware","application","system"}' NOT NULL,
	"minimum_level" "event_log_level" DEFAULT 'info' NOT NULL,
	"collection_interval_minutes" integer DEFAULT 5 NOT NULL,
	"rate_limit_per_hour" integer DEFAULT 12000 NOT NULL,
	"enable_full_text_search" boolean DEFAULT true NOT NULL,
	"enable_correlation" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "config_policy_event_log_settings_feature_link_id_unique" UNIQUE("feature_link_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "config_policy_feature_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"config_policy_id" uuid NOT NULL,
	"feature_type" "config_feature_type" NOT NULL,
	"feature_policy_id" uuid,
	"inline_settings" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "config_policy_maintenance_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feature_link_id" uuid NOT NULL,
	"recurrence" varchar(20) DEFAULT 'weekly' NOT NULL,
	"duration_hours" integer DEFAULT 2 NOT NULL,
	"timezone" varchar(100) DEFAULT 'UTC' NOT NULL,
	"window_start" varchar(30),
	"suppress_alerts" boolean DEFAULT true NOT NULL,
	"suppress_patching" boolean DEFAULT false NOT NULL,
	"suppress_automations" boolean DEFAULT false NOT NULL,
	"suppress_scripts" boolean DEFAULT false NOT NULL,
	"notify_before_minutes" integer DEFAULT 15,
	"notify_on_start" boolean DEFAULT true NOT NULL,
	"notify_on_end" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "config_policy_maintenance_settings_feature_link_id_unique" UNIQUE("feature_link_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "config_policy_monitoring_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feature_link_id" uuid NOT NULL,
	"check_interval_seconds" integer DEFAULT 60 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "config_policy_monitoring_settings_feature_link_id_unique" UNIQUE("feature_link_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "config_policy_monitoring_watches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"settings_id" uuid NOT NULL,
	"watch_type" "monitoring_watch_type" NOT NULL,
	"name" varchar(255) NOT NULL,
	"display_name" varchar(255),
	"enabled" boolean DEFAULT true NOT NULL,
	"alert_on_stop" boolean DEFAULT true NOT NULL,
	"alert_after_consecutive_failures" integer DEFAULT 2 NOT NULL,
	"alert_severity" "alert_severity" DEFAULT 'high' NOT NULL,
	"cpu_threshold_percent" real,
	"memory_threshold_mb" real,
	"threshold_duration_seconds" integer DEFAULT 300 NOT NULL,
	"auto_restart" boolean DEFAULT false NOT NULL,
	"max_restart_attempts" integer DEFAULT 3 NOT NULL,
	"restart_cooldown_seconds" integer DEFAULT 300 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "config_policy_patch_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feature_link_id" uuid NOT NULL,
	"sources" text[] DEFAULT '{"os"}' NOT NULL,
	"auto_approve" boolean DEFAULT false NOT NULL,
	"auto_approve_severities" text[] DEFAULT '{}',
	"schedule_frequency" varchar(20) DEFAULT 'weekly' NOT NULL,
	"schedule_time" varchar(10) DEFAULT '02:00' NOT NULL,
	"schedule_day_of_week" varchar(10) DEFAULT 'sun',
	"schedule_day_of_month" integer DEFAULT 1,
	"reboot_policy" varchar(20) DEFAULT 'if_required' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "config_policy_patch_settings_feature_link_id_unique" UNIQUE("feature_link_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "config_policy_sensitive_data_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feature_link_id" uuid NOT NULL,
	"detection_classes" text[] DEFAULT '{"credential"}' NOT NULL,
	"include_paths" text[] DEFAULT '{}' NOT NULL,
	"exclude_paths" text[] DEFAULT '{}' NOT NULL,
	"file_types" text[] DEFAULT '{}' NOT NULL,
	"max_file_size_bytes" integer DEFAULT 104857600 NOT NULL,
	"workers" integer DEFAULT 4 NOT NULL,
	"timeout_seconds" integer DEFAULT 300 NOT NULL,
	"suppress_pattern_ids" text[] DEFAULT '{}' NOT NULL,
	"schedule_type" varchar(20) DEFAULT 'manual' NOT NULL,
	"interval_minutes" integer,
	"cron" varchar(120),
	"timezone" varchar(64) DEFAULT 'UTC' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "config_policy_sensitive_data_settings_feature_link_id_unique" UNIQUE("feature_link_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "configuration_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"status" "config_policy_status" DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "log_correlation_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"pattern" text NOT NULL,
	"is_regex" boolean DEFAULT false NOT NULL,
	"min_occurrences" integer DEFAULT 3 NOT NULL,
	"min_devices" integer DEFAULT 2 NOT NULL,
	"time_window" integer DEFAULT 300 NOT NULL,
	"severity" "log_correlation_severity" DEFAULT 'warning' NOT NULL,
	"alert_on_match" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_matched_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "log_correlations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"pattern" text NOT NULL,
	"first_seen" timestamp NOT NULL,
	"last_seen" timestamp NOT NULL,
	"occurrences" integer NOT NULL,
	"affected_devices" jsonb NOT NULL,
	"sample_logs" jsonb,
	"alert_id" uuid,
	"status" "log_correlation_status" DEFAULT 'active' NOT NULL,
	"resolved_at" timestamp,
	"resolved_by" uuid,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "log_search_queries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"filters" jsonb NOT NULL,
	"created_by" uuid,
	"is_shared" boolean DEFAULT false NOT NULL,
	"run_count" integer DEFAULT 0 NOT NULL,
	"last_run_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_baseline_apply_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"baseline_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"approved_by" uuid,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"request_payload" jsonb NOT NULL,
	"expires_at" timestamp NOT NULL,
	"approved_at" timestamp,
	"consumed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_baseline_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"baseline_id" uuid NOT NULL,
	"compliant" boolean NOT NULL,
	"score" integer NOT NULL,
	"deviations" jsonb NOT NULL,
	"checked_at" timestamp NOT NULL,
	"remediated_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_baselines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"os_type" varchar(20) NOT NULL,
	"profile" varchar(20) NOT NULL,
	"settings" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_policy_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"os_type" varchar(20) NOT NULL,
	"settings" jsonb NOT NULL,
	"raw" jsonb,
	"collected_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "device_reliability" (
	"device_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"computed_at" timestamp DEFAULT now() NOT NULL,
	"reliability_score" integer NOT NULL,
	"uptime_score" integer NOT NULL,
	"crash_score" integer NOT NULL,
	"hang_score" integer NOT NULL,
	"service_failure_score" integer NOT NULL,
	"hardware_error_score" integer NOT NULL,
	"uptime_7d" real NOT NULL,
	"uptime_30d" real NOT NULL,
	"uptime_90d" real NOT NULL,
	"crash_count_7d" integer DEFAULT 0 NOT NULL,
	"crash_count_30d" integer DEFAULT 0 NOT NULL,
	"crash_count_90d" integer DEFAULT 0 NOT NULL,
	"hang_count_7d" integer DEFAULT 0 NOT NULL,
	"hang_count_30d" integer DEFAULT 0 NOT NULL,
	"hang_count_90d" integer DEFAULT 0 NOT NULL,
	"service_failure_count_7d" integer DEFAULT 0 NOT NULL,
	"service_failure_count_30d" integer DEFAULT 0 NOT NULL,
	"hardware_error_count_7d" integer DEFAULT 0 NOT NULL,
	"hardware_error_count_30d" integer DEFAULT 0 NOT NULL,
	"mtbf_hours" real,
	"trend_direction" "trend_direction" NOT NULL,
	"trend_confidence" real DEFAULT 0 NOT NULL,
	"top_issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "device_reliability_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"collected_at" timestamp DEFAULT now() NOT NULL,
	"uptime_seconds" bigint NOT NULL,
	"boot_time" timestamp NOT NULL,
	"crash_events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"app_hangs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"service_failures" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hardware_errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw_metrics" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_risk_events" (
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
CREATE TABLE IF NOT EXISTS "user_risk_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"weights" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"thresholds" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"interventions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_risk_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"score" integer NOT NULL,
	"factors" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"trend_direction" varchar(20),
	"calculated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_action_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"status" "ai_plan_status" DEFAULT 'pending' NOT NULL,
	"steps" jsonb NOT NULL,
	"current_step_index" integer DEFAULT 0 NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_screenshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"session_id" uuid,
	"storage_key" varchar(500) NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"captured_by" varchar(50) DEFAULT 'agent' NOT NULL,
	"reason" varchar(200),
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"timestamp" timestamp NOT NULL,
	"level" "agent_log_level" NOT NULL,
	"component" varchar(100) NOT NULL,
	"message" text NOT NULL,
	"fields" jsonb,
	"agent_version" varchar(50),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "brain_device_context" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"context_type" "brain_context_type" NOT NULL,
	"summary" varchar(255) NOT NULL,
	"details" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp,
	"resolved_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "playbook_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"name" varchar(255) NOT NULL,
	"description" text NOT NULL,
	"steps" jsonb NOT NULL,
	"trigger_conditions" jsonb,
	"is_built_in" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"category" varchar(50),
	"required_permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "playbook_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"playbook_id" uuid NOT NULL,
	"status" "playbook_execution_status" DEFAULT 'pending' NOT NULL,
	"current_step_index" integer DEFAULT 0 NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"context" jsonb,
	"error_message" text,
	"rollback_executed" boolean DEFAULT false NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"triggered_by" varchar(50) NOT NULL,
	"triggered_by_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "device_change_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"timestamp" timestamp NOT NULL,
	"change_type" "change_type" NOT NULL,
	"change_action" "change_action" NOT NULL,
	"subject" varchar(500) NOT NULL,
	"before_value" jsonb,
	"after_value" jsonb,
	"details" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dns_event_aggregations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"date" date NOT NULL,
	"integration_id" uuid,
	"device_id" uuid,
	"domain" varchar(500),
	"category" "dns_threat_category",
	"total_queries" integer DEFAULT 0 NOT NULL,
	"blocked_queries" integer DEFAULT 0 NOT NULL,
	"allowed_queries" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dns_filter_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"provider" "dns_provider" NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"api_key" text,
	"api_secret" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_sync" timestamp,
	"last_sync_status" varchar(20),
	"last_sync_error" text,
	"total_events_processed" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dns_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"type" "dns_policy_type" NOT NULL,
	"domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sync_status" "dns_policy_sync_status" DEFAULT 'pending' NOT NULL,
	"last_synced" timestamp,
	"sync_error" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dns_security_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"device_id" uuid,
	"timestamp" timestamp NOT NULL,
	"domain" varchar(500) NOT NULL,
	"query_type" varchar(10) DEFAULT 'A' NOT NULL,
	"action" "dns_action" NOT NULL,
	"category" "dns_threat_category",
	"threat_type" varchar(100),
	"threat_score" integer,
	"source_ip" varchar(45),
	"source_hostname" varchar(255),
	"provider_event_id" varchar(255) NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cis_baseline_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"baseline_id" uuid NOT NULL,
	"checked_at" timestamp NOT NULL,
	"total_checks" integer NOT NULL,
	"passed_checks" integer NOT NULL,
	"failed_checks" integer NOT NULL,
	"score" integer NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cis_baselines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"os_type" "cis_os_type" NOT NULL,
	"benchmark_version" varchar(200) NOT NULL,
	"level" "cis_baseline_level" NOT NULL,
	"custom_exclusions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scan_schedule" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cis_check_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"os_type" "cis_os_type" NOT NULL,
	"benchmark_version" varchar(200) NOT NULL,
	"level" "cis_baseline_level" NOT NULL,
	"check_id" varchar(120) NOT NULL,
	"title" varchar(400) NOT NULL,
	"severity" "cis_check_severity" NOT NULL,
	"default_action" varchar(80) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cis_remediation_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"baseline_id" uuid,
	"baseline_result_id" uuid,
	"check_id" varchar(120) NOT NULL,
	"action" varchar(40) NOT NULL,
	"status" "cis_remediation_status" DEFAULT 'pending_approval' NOT NULL,
	"approval_status" "cis_remediation_approval_status" DEFAULT 'pending' NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp,
	"approval_note" text,
	"requested_by" uuid,
	"command_id" uuid,
	"executed_at" timestamp,
	"details" jsonb,
	"before_state" jsonb,
	"after_state" jsonb,
	"rollback_hint" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "s1_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"device_id" uuid,
	"requested_by" uuid,
	"action" varchar(40) NOT NULL,
	"payload" jsonb,
	"status" varchar(20) DEFAULT 'queued' NOT NULL,
	"provider_action_id" varchar(128),
	"requested_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"error" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "s1_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"s1_agent_id" varchar(128) NOT NULL,
	"device_id" uuid,
	"status" varchar(30),
	"infected" boolean DEFAULT false NOT NULL,
	"threat_count" integer DEFAULT 0 NOT NULL,
	"policy_name" varchar(200),
	"last_seen_at" timestamp,
	"metadata" jsonb,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "s1_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"api_token_encrypted" text NOT NULL,
	"management_url" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_sync_at" timestamp,
	"last_sync_status" varchar(20),
	"last_sync_error" text,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "s1_site_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" uuid NOT NULL,
	"site_name" varchar(200) NOT NULL,
	"org_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "s1_threats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"device_id" uuid,
	"s1_threat_id" varchar(128) NOT NULL,
	"classification" varchar(60),
	"severity" varchar(20),
	"threat_name" text,
	"process_name" text,
	"file_path" text,
	"mitre_tactics" jsonb,
	"status" varchar(30) NOT NULL,
	"detected_at" timestamp,
	"resolved_at" timestamp,
	"details" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "huntress_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"huntress_agent_id" varchar(128) NOT NULL,
	"device_id" uuid,
	"hostname" varchar(255),
	"platform" varchar(32),
	"status" varchar(20),
	"last_seen_at" timestamp,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "huntress_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"device_id" uuid,
	"huntress_incident_id" varchar(128) NOT NULL,
	"severity" varchar(20),
	"category" varchar(60),
	"title" text NOT NULL,
	"description" text,
	"recommendation" text,
	"status" varchar(30) NOT NULL,
	"reported_at" timestamp,
	"resolved_at" timestamp,
	"details" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "huntress_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"api_key_encrypted" text NOT NULL,
	"account_id" varchar(120),
	"api_base_url" varchar(300) DEFAULT 'https://api.huntress.io/v1' NOT NULL,
	"webhook_secret_encrypted" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_sync_at" timestamp,
	"last_sync_status" varchar(20),
	"last_sync_error" text,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sensitive_data_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"scan_id" uuid NOT NULL,
	"file_path" text NOT NULL,
	"data_type" varchar(20) NOT NULL,
	"pattern_id" varchar(80) NOT NULL,
	"match_count" integer DEFAULT 1 NOT NULL,
	"risk" varchar(20) NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"file_owner" varchar(255),
	"file_modified_at" timestamp,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"remediation_action" varchar(40),
	"remediation_metadata" jsonb,
	"remediated_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sensitive_data_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"detection_classes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"schedule" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sensitive_data_scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"policy_id" uuid,
	"requested_by" uuid,
	"status" varchar(20) DEFAULT 'queued' NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"idempotency_key" varchar(128),
	"request_fingerprint" varchar(64),
	"summary" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "peripheral_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"policy_id" uuid,
	"source_event_id" varchar(255),
	"event_type" "peripheral_event_type" NOT NULL,
	"peripheral_type" varchar(40) NOT NULL,
	"vendor" varchar(255),
	"product" varchar(255),
	"serial_number" varchar(255),
	"details" jsonb,
	"occurred_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "peripheral_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"device_class" "peripheral_device_class" NOT NULL,
	"action" "peripheral_policy_action" NOT NULL,
	"target_type" "peripheral_policy_target_type" NOT NULL,
	"target_ids" jsonb DEFAULT '{}'::jsonb,
	"exceptions" jsonb DEFAULT '[]'::jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "browser_extensions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"browser" varchar(20) NOT NULL,
	"extension_id" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"version" varchar(80),
	"source" varchar(30) NOT NULL,
	"permissions" jsonb NOT NULL,
	"risk_level" varchar(20) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"first_seen_at" timestamp NOT NULL,
	"last_seen_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "browser_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"allowed_extensions" jsonb,
	"blocked_extensions" jsonb,
	"required_extensions" jsonb,
	"settings" jsonb,
	"target_type" varchar(30) NOT NULL,
	"target_ids" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "browser_policy_violations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"policy_id" uuid,
	"violation_type" varchar(40) NOT NULL,
	"details" jsonb NOT NULL,
	"detected_at" timestamp NOT NULL,
	"resolved_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "service_process_check_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"watch_type" "monitoring_watch_type" NOT NULL,
	"name" varchar(255) NOT NULL,
	"status" "check_result_status" NOT NULL,
	"cpu_percent" real,
	"memory_mb" real,
	"pid" integer,
	"details" jsonb,
	"auto_restart_attempted" boolean DEFAULT false NOT NULL,
	"auto_restart_succeeded" boolean,
	"timestamp" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "device_warranty" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"manufacturer" varchar(100),
	"serial_number" varchar(100),
	"status" "warranty_status" DEFAULT 'unknown' NOT NULL,
	"warranty_start_date" date,
	"warranty_end_date" date,
	"entitlements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_sync_at" timestamp,
	"last_sync_error" text,
	"next_sync_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "policies" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "policy_assignments" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "policy_compliance" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "policy_templates" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "policy_versions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "policies" CASCADE;--> statement-breakpoint
DROP TABLE "policy_assignments" CASCADE;--> statement-breakpoint
DROP TABLE "policy_compliance" CASCADE;--> statement-breakpoint
DROP TABLE "policy_templates" CASCADE;--> statement-breakpoint
DROP TABLE "policy_versions" CASCADE;--> statement-breakpoint
ALTER TABLE "agent_versions" DROP CONSTRAINT IF EXISTS "agent_versions_version_platform_arch_unique";--> statement-breakpoint
ALTER TABLE "discovered_assets" DROP CONSTRAINT IF EXISTS "discovered_assets_ignored_by_users_id_fk";
--> statement-breakpoint
DROP INDEX "patch_approvals_org_patch_unique";--> statement-breakpoint
DROP INDEX "backup_policies_target_idx";--> statement-breakpoint
ALTER TABLE "devices" ALTER COLUMN "agent_version" SET DATA TYPE varchar(50);--> statement-breakpoint
ALTER TABLE "alerts" ALTER COLUMN "rule_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_logs" ALTER COLUMN "org_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_policy_compliance" ALTER COLUMN "policy_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ALTER COLUMN "automation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "device_event_logs" ALTER COLUMN "timestamp" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_sessions" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN IF NOT EXISTS "status" "partner_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "setup_completed_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "preferences" jsonb;--> statement-breakpoint
ALTER TABLE "device_metrics" ADD COLUMN IF NOT EXISTS "disk_activity_available" boolean;--> statement-breakpoint
ALTER TABLE "device_metrics" ADD COLUMN IF NOT EXISTS "disk_read_bytes" bigint;--> statement-breakpoint
ALTER TABLE "device_metrics" ADD COLUMN IF NOT EXISTS "disk_write_bytes" bigint;--> statement-breakpoint
ALTER TABLE "device_metrics" ADD COLUMN IF NOT EXISTS "disk_read_bps" bigint;--> statement-breakpoint
ALTER TABLE "device_metrics" ADD COLUMN IF NOT EXISTS "disk_write_bps" bigint;--> statement-breakpoint
ALTER TABLE "device_metrics" ADD COLUMN IF NOT EXISTS "disk_read_ops" bigint;--> statement-breakpoint
ALTER TABLE "device_metrics" ADD COLUMN IF NOT EXISTS "disk_write_ops" bigint;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "device_role" varchar(30) DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "device_role_source" varchar(20) DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "management_posture" jsonb;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "last_user" varchar(255);--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "uptime_seconds" integer;--> statement-breakpoint
ALTER TABLE "alert_templates" ADD COLUMN IF NOT EXISTS "category" varchar(100);--> statement-breakpoint
ALTER TABLE "alert_templates" ADD COLUMN IF NOT EXISTS "targets" jsonb;--> statement-breakpoint
ALTER TABLE "alert_templates" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN IF NOT EXISTS "config_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN IF NOT EXISTS "config_item_name" varchar(200);--> statement-breakpoint
ALTER TABLE "notification_channels" ADD COLUMN IF NOT EXISTS "templates" jsonb DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "initiated_by" "initiated_by_type";--> statement-breakpoint
ALTER TABLE "patch_approvals" ADD COLUMN IF NOT EXISTS "ring_id" uuid;--> statement-breakpoint
ALTER TABLE "patch_compliance_snapshots" ADD COLUMN IF NOT EXISTS "ring_id" uuid;--> statement-breakpoint
ALTER TABLE "patch_jobs" ADD COLUMN IF NOT EXISTS "ring_id" uuid;--> statement-breakpoint
ALTER TABLE "patch_jobs" ADD COLUMN IF NOT EXISTS "config_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "patch_policies" ADD COLUMN IF NOT EXISTS "ring_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "patch_policies" ADD COLUMN IF NOT EXISTS "deferral_days" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "patch_policies" ADD COLUMN IF NOT EXISTS "deadline_days" integer;--> statement-breakpoint
ALTER TABLE "patch_policies" ADD COLUMN IF NOT EXISTS "grace_period_hours" integer DEFAULT 4 NOT NULL;--> statement-breakpoint
ALTER TABLE "patch_policies" ADD COLUMN IF NOT EXISTS "categories" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "patch_policies" ADD COLUMN IF NOT EXISTS "exclude_categories" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "patch_policies" ADD COLUMN IF NOT EXISTS "category_rules" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "discovered_assets" ADD COLUMN IF NOT EXISTS "label" varchar(255);--> statement-breakpoint
ALTER TABLE "discovered_assets" ADD COLUMN IF NOT EXISTS "approval_status" "discovered_asset_approval_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "discovered_assets" ADD COLUMN IF NOT EXISTS "is_online" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "discovered_assets" ADD COLUMN IF NOT EXISTS "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "discovered_assets" ADD COLUMN IF NOT EXISTS "approved_at" timestamp;--> statement-breakpoint
ALTER TABLE "discovered_assets" ADD COLUMN IF NOT EXISTS "dismissed_by" uuid;--> statement-breakpoint
ALTER TABLE "discovered_assets" ADD COLUMN IF NOT EXISTS "dismissed_at" timestamp;--> statement-breakpoint
ALTER TABLE "discovery_profiles" ADD COLUMN IF NOT EXISTS "alert_settings" jsonb;--> statement-breakpoint
ALTER TABLE "software_catalog" ADD COLUMN IF NOT EXISTS "org_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "software_inventory" ADD COLUMN IF NOT EXISTS "file_hash" varchar(128);--> statement-breakpoint
ALTER TABLE "software_inventory" ADD COLUMN IF NOT EXISTS "hash_algorithm" varchar(10);--> statement-breakpoint
ALTER TABLE "software_versions" ADD COLUMN IF NOT EXISTS "s3_key" text;--> statement-breakpoint
ALTER TABLE "software_versions" ADD COLUMN IF NOT EXISTS "file_type" varchar(20);--> statement-breakpoint
ALTER TABLE "software_versions" ADD COLUMN IF NOT EXISTS "original_file_name" varchar(500);--> statement-breakpoint
ALTER TABLE "backup_configs" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "backup_jobs" ADD COLUMN IF NOT EXISTS "org_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "backup_jobs" ADD COLUMN IF NOT EXISTS "policy_id" uuid;--> statement-breakpoint
ALTER TABLE "backup_jobs" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "backup_jobs" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "backup_policies" ADD COLUMN IF NOT EXISTS "org_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "backup_policies" ADD COLUMN IF NOT EXISTS "name" varchar(200) NOT NULL;--> statement-breakpoint
ALTER TABLE "backup_policies" ADD COLUMN IF NOT EXISTS "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "backup_policies" ADD COLUMN IF NOT EXISTS "schedule" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "backup_policies" ADD COLUMN IF NOT EXISTS "retention" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "backup_policies" ADD COLUMN IF NOT EXISTS "targets" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "backup_policies" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "backup_policies" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "backup_snapshots" ADD COLUMN IF NOT EXISTS "org_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "backup_snapshots" ADD COLUMN IF NOT EXISTS "config_id" uuid;--> statement-breakpoint
ALTER TABLE "backup_snapshots" ADD COLUMN IF NOT EXISTS "label" varchar(200);--> statement-breakpoint
ALTER TABLE "backup_snapshots" ADD COLUMN IF NOT EXISTS "location" text;--> statement-breakpoint
ALTER TABLE "restore_jobs" ADD COLUMN IF NOT EXISTS "org_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "restore_jobs" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "restore_jobs" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_policy_compliance" ADD COLUMN IF NOT EXISTS "config_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "automation_policy_compliance" ADD COLUMN IF NOT EXISTS "config_item_name" varchar(200);--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN IF NOT EXISTS "config_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN IF NOT EXISTS "config_item_name" varchar(200);--> statement-breakpoint
ALTER TABLE "agent_versions" ADD COLUMN IF NOT EXISTS "component" varchar(20) DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_budgets" ADD COLUMN IF NOT EXISTS "approval_mode" "ai_approval_mode" DEFAULT 'per_step' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_sessions" ADD COLUMN IF NOT EXISTS "device_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_sessions" ADD COLUMN IF NOT EXISTS "type" text DEFAULT 'general' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_sessions" ADD COLUMN IF NOT EXISTS "flagged_at" timestamp;--> statement-breakpoint
ALTER TABLE "ai_sessions" ADD COLUMN IF NOT EXISTS "flagged_by" uuid;--> statement-breakpoint
ALTER TABLE "ai_sessions" ADD COLUMN IF NOT EXISTS "flag_reason" text;--> statement-breakpoint
ALTER TABLE "device_boot_metrics" DROP CONSTRAINT IF EXISTS "device_boot_metrics_device_id_devices_id_fk";
ALTER TABLE "device_boot_metrics" ADD CONSTRAINT "device_boot_metrics_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_boot_metrics" DROP CONSTRAINT IF EXISTS "device_boot_metrics_org_id_organizations_id_fk";
ALTER TABLE "device_boot_metrics" ADD CONSTRAINT "device_boot_metrics_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_ip_history" DROP CONSTRAINT IF EXISTS "device_ip_history_device_id_devices_id_fk";
ALTER TABLE "device_ip_history" ADD CONSTRAINT "device_ip_history_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_ip_history" DROP CONSTRAINT IF EXISTS "device_ip_history_org_id_organizations_id_fk";
ALTER TABLE "device_ip_history" ADD CONSTRAINT "device_ip_history_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_routing_rules" DROP CONSTRAINT IF EXISTS "notification_routing_rules_org_id_organizations_id_fk";
ALTER TABLE "notification_routing_rules" ADD CONSTRAINT "notification_routing_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_baselines" DROP CONSTRAINT IF EXISTS "network_baselines_org_id_organizations_id_fk";
ALTER TABLE "network_baselines" ADD CONSTRAINT "network_baselines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_baselines" DROP CONSTRAINT IF EXISTS "network_baselines_site_id_sites_id_fk";
ALTER TABLE "network_baselines" ADD CONSTRAINT "network_baselines_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_baselines" DROP CONSTRAINT IF EXISTS "network_baselines_last_scan_job_id_discovery_jobs_id_fk";
ALTER TABLE "network_baselines" ADD CONSTRAINT "network_baselines_last_scan_job_id_discovery_jobs_id_fk" FOREIGN KEY ("last_scan_job_id") REFERENCES "public"."discovery_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_change_events" DROP CONSTRAINT IF EXISTS "network_change_events_org_id_organizations_id_fk";
ALTER TABLE "network_change_events" ADD CONSTRAINT "network_change_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_change_events" DROP CONSTRAINT IF EXISTS "network_change_events_site_id_sites_id_fk";
ALTER TABLE "network_change_events" ADD CONSTRAINT "network_change_events_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_change_events" DROP CONSTRAINT IF EXISTS "network_change_events_baseline_id_network_baselines_id_fk";
ALTER TABLE "network_change_events" ADD CONSTRAINT "network_change_events_baseline_id_network_baselines_id_fk" FOREIGN KEY ("baseline_id") REFERENCES "public"."network_baselines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_change_events" DROP CONSTRAINT IF EXISTS "network_change_events_profile_id_discovery_profiles_id_fk";
ALTER TABLE "network_change_events" ADD CONSTRAINT "network_change_events_profile_id_discovery_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."discovery_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_change_events" DROP CONSTRAINT IF EXISTS "network_change_events_acknowledged_by_users_id_fk";
ALTER TABLE "network_change_events" ADD CONSTRAINT "network_change_events_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_change_events" DROP CONSTRAINT IF EXISTS "network_change_events_alert_id_alerts_id_fk";
ALTER TABLE "network_change_events" ADD CONSTRAINT "network_change_events_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_change_events" DROP CONSTRAINT IF EXISTS "network_change_events_linked_device_id_devices_id_fk";
ALTER TABLE "network_change_events" ADD CONSTRAINT "network_change_events_linked_device_id_devices_id_fk" FOREIGN KEY ("linked_device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_known_guests" DROP CONSTRAINT IF EXISTS "network_known_guests_partner_id_partners_id_fk";
ALTER TABLE "network_known_guests" ADD CONSTRAINT "network_known_guests_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_known_guests" DROP CONSTRAINT IF EXISTS "network_known_guests_added_by_users_id_fk";
ALTER TABLE "network_known_guests" ADD CONSTRAINT "network_known_guests_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_compliance_status" DROP CONSTRAINT IF EXISTS "software_compliance_status_device_id_devices_id_fk";
ALTER TABLE "software_compliance_status" ADD CONSTRAINT "software_compliance_status_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_compliance_status" DROP CONSTRAINT IF EXISTS "software_compliance_status_policy_id_software_policies_id_fk";
ALTER TABLE "software_compliance_status" ADD CONSTRAINT "software_compliance_status_policy_id_software_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."software_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_policies" DROP CONSTRAINT IF EXISTS "software_policies_org_id_organizations_id_fk";
ALTER TABLE "software_policies" ADD CONSTRAINT "software_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_policies" DROP CONSTRAINT IF EXISTS "software_policies_created_by_users_id_fk";
ALTER TABLE "software_policies" ADD CONSTRAINT "software_policies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_policy_audit" DROP CONSTRAINT IF EXISTS "software_policy_audit_org_id_organizations_id_fk";
ALTER TABLE "software_policy_audit" ADD CONSTRAINT "software_policy_audit_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_policy_audit" DROP CONSTRAINT IF EXISTS "software_policy_audit_policy_id_software_policies_id_fk";
ALTER TABLE "software_policy_audit" ADD CONSTRAINT "software_policy_audit_policy_id_software_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."software_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_policy_audit" DROP CONSTRAINT IF EXISTS "software_policy_audit_device_id_devices_id_fk";
ALTER TABLE "software_policy_audit" ADD CONSTRAINT "software_policy_audit_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_policy_audit" DROP CONSTRAINT IF EXISTS "software_policy_audit_actor_id_users_id_fk";
ALTER TABLE "software_policy_audit" ADD CONSTRAINT "software_policy_audit_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_policy_alert_rules" DROP CONSTRAINT IF EXISTS "config_policy_alert_rules_feature_link_id_config_policy_feature_links_id_fk";
ALTER TABLE "config_policy_alert_rules" ADD CONSTRAINT "config_policy_alert_rules_feature_link_id_config_policy_feature_links_id_fk" FOREIGN KEY ("feature_link_id") REFERENCES "public"."config_policy_feature_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_policy_assignments" DROP CONSTRAINT IF EXISTS "config_policy_assignments_config_policy_id_configuration_policies_id_fk";
ALTER TABLE "config_policy_assignments" ADD CONSTRAINT "config_policy_assignments_config_policy_id_configuration_policies_id_fk" FOREIGN KEY ("config_policy_id") REFERENCES "public"."configuration_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_policy_assignments" DROP CONSTRAINT IF EXISTS "config_policy_assignments_assigned_by_users_id_fk";
ALTER TABLE "config_policy_assignments" ADD CONSTRAINT "config_policy_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_policy_automations" DROP CONSTRAINT IF EXISTS "config_policy_automations_feature_link_id_config_policy_feature_links_id_fk";
ALTER TABLE "config_policy_automations" ADD CONSTRAINT "config_policy_automations_feature_link_id_config_policy_feature_links_id_fk" FOREIGN KEY ("feature_link_id") REFERENCES "public"."config_policy_feature_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_policy_compliance_rules" DROP CONSTRAINT IF EXISTS "config_policy_compliance_rules_feature_link_id_config_policy_feature_links_id_fk";
ALTER TABLE "config_policy_compliance_rules" ADD CONSTRAINT "config_policy_compliance_rules_feature_link_id_config_policy_feature_links_id_fk" FOREIGN KEY ("feature_link_id") REFERENCES "public"."config_policy_feature_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_policy_compliance_rules" DROP CONSTRAINT IF EXISTS "config_policy_compliance_rules_remediation_script_id_scripts_id_fk";
ALTER TABLE "config_policy_compliance_rules" ADD CONSTRAINT "config_policy_compliance_rules_remediation_script_id_scripts_id_fk" FOREIGN KEY ("remediation_script_id") REFERENCES "public"."scripts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_policy_event_log_settings" DROP CONSTRAINT IF EXISTS "config_policy_event_log_settings_feature_link_id_config_policy_feature_links_id_fk";
ALTER TABLE "config_policy_event_log_settings" ADD CONSTRAINT "config_policy_event_log_settings_feature_link_id_config_policy_feature_links_id_fk" FOREIGN KEY ("feature_link_id") REFERENCES "public"."config_policy_feature_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_policy_feature_links" DROP CONSTRAINT IF EXISTS "config_policy_feature_links_config_policy_id_configuration_policies_id_fk";
ALTER TABLE "config_policy_feature_links" ADD CONSTRAINT "config_policy_feature_links_config_policy_id_configuration_policies_id_fk" FOREIGN KEY ("config_policy_id") REFERENCES "public"."configuration_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_policy_maintenance_settings" DROP CONSTRAINT IF EXISTS "config_policy_maintenance_settings_feature_link_id_config_policy_feature_links_id_fk";
ALTER TABLE "config_policy_maintenance_settings" ADD CONSTRAINT "config_policy_maintenance_settings_feature_link_id_config_policy_feature_links_id_fk" FOREIGN KEY ("feature_link_id") REFERENCES "public"."config_policy_feature_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_policy_monitoring_settings" DROP CONSTRAINT IF EXISTS "config_policy_monitoring_settings_feature_link_id_config_policy_feature_links_id_fk";
ALTER TABLE "config_policy_monitoring_settings" ADD CONSTRAINT "config_policy_monitoring_settings_feature_link_id_config_policy_feature_links_id_fk" FOREIGN KEY ("feature_link_id") REFERENCES "public"."config_policy_feature_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_policy_monitoring_watches" DROP CONSTRAINT IF EXISTS "config_policy_monitoring_watches_settings_id_config_policy_monitoring_settings_id_fk";
ALTER TABLE "config_policy_monitoring_watches" ADD CONSTRAINT "config_policy_monitoring_watches_settings_id_config_policy_monitoring_settings_id_fk" FOREIGN KEY ("settings_id") REFERENCES "public"."config_policy_monitoring_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_policy_patch_settings" DROP CONSTRAINT IF EXISTS "config_policy_patch_settings_feature_link_id_config_policy_feature_links_id_fk";
ALTER TABLE "config_policy_patch_settings" ADD CONSTRAINT "config_policy_patch_settings_feature_link_id_config_policy_feature_links_id_fk" FOREIGN KEY ("feature_link_id") REFERENCES "public"."config_policy_feature_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_policy_sensitive_data_settings" DROP CONSTRAINT IF EXISTS "config_policy_sensitive_data_settings_feature_link_id_config_policy_feature_links_id_fk";
ALTER TABLE "config_policy_sensitive_data_settings" ADD CONSTRAINT "config_policy_sensitive_data_settings_feature_link_id_config_policy_feature_links_id_fk" FOREIGN KEY ("feature_link_id") REFERENCES "public"."config_policy_feature_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "configuration_policies" DROP CONSTRAINT IF EXISTS "configuration_policies_org_id_organizations_id_fk";
ALTER TABLE "configuration_policies" ADD CONSTRAINT "configuration_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "configuration_policies" DROP CONSTRAINT IF EXISTS "configuration_policies_created_by_users_id_fk";
ALTER TABLE "configuration_policies" ADD CONSTRAINT "configuration_policies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_correlation_rules" DROP CONSTRAINT IF EXISTS "log_correlation_rules_org_id_organizations_id_fk";
ALTER TABLE "log_correlation_rules" ADD CONSTRAINT "log_correlation_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_correlations" DROP CONSTRAINT IF EXISTS "log_correlations_org_id_organizations_id_fk";
ALTER TABLE "log_correlations" ADD CONSTRAINT "log_correlations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_correlations" DROP CONSTRAINT IF EXISTS "log_correlations_rule_id_log_correlation_rules_id_fk";
ALTER TABLE "log_correlations" ADD CONSTRAINT "log_correlations_rule_id_log_correlation_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."log_correlation_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_correlations" DROP CONSTRAINT IF EXISTS "log_correlations_alert_id_alerts_id_fk";
ALTER TABLE "log_correlations" ADD CONSTRAINT "log_correlations_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_correlations" DROP CONSTRAINT IF EXISTS "log_correlations_resolved_by_users_id_fk";
ALTER TABLE "log_correlations" ADD CONSTRAINT "log_correlations_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_search_queries" DROP CONSTRAINT IF EXISTS "log_search_queries_org_id_organizations_id_fk";
ALTER TABLE "log_search_queries" ADD CONSTRAINT "log_search_queries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_search_queries" DROP CONSTRAINT IF EXISTS "log_search_queries_created_by_users_id_fk";
ALTER TABLE "log_search_queries" ADD CONSTRAINT "log_search_queries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_baseline_apply_approvals" DROP CONSTRAINT IF EXISTS "audit_baseline_apply_approvals_org_id_organizations_id_fk";
ALTER TABLE "audit_baseline_apply_approvals" ADD CONSTRAINT "audit_baseline_apply_approvals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_baseline_apply_approvals" DROP CONSTRAINT IF EXISTS "audit_baseline_apply_approvals_baseline_id_audit_baselines_id_fk";
ALTER TABLE "audit_baseline_apply_approvals" ADD CONSTRAINT "audit_baseline_apply_approvals_baseline_id_audit_baselines_id_fk" FOREIGN KEY ("baseline_id") REFERENCES "public"."audit_baselines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_baseline_apply_approvals" DROP CONSTRAINT IF EXISTS "audit_baseline_apply_approvals_requested_by_users_id_fk";
ALTER TABLE "audit_baseline_apply_approvals" ADD CONSTRAINT "audit_baseline_apply_approvals_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_baseline_apply_approvals" DROP CONSTRAINT IF EXISTS "audit_baseline_apply_approvals_approved_by_users_id_fk";
ALTER TABLE "audit_baseline_apply_approvals" ADD CONSTRAINT "audit_baseline_apply_approvals_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_baseline_results" DROP CONSTRAINT IF EXISTS "audit_baseline_results_org_id_organizations_id_fk";
ALTER TABLE "audit_baseline_results" ADD CONSTRAINT "audit_baseline_results_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_baseline_results" DROP CONSTRAINT IF EXISTS "audit_baseline_results_device_id_devices_id_fk";
ALTER TABLE "audit_baseline_results" ADD CONSTRAINT "audit_baseline_results_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_baseline_results" DROP CONSTRAINT IF EXISTS "audit_baseline_results_baseline_id_audit_baselines_id_fk";
ALTER TABLE "audit_baseline_results" ADD CONSTRAINT "audit_baseline_results_baseline_id_audit_baselines_id_fk" FOREIGN KEY ("baseline_id") REFERENCES "public"."audit_baselines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_baselines" DROP CONSTRAINT IF EXISTS "audit_baselines_org_id_organizations_id_fk";
ALTER TABLE "audit_baselines" ADD CONSTRAINT "audit_baselines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_baselines" DROP CONSTRAINT IF EXISTS "audit_baselines_created_by_users_id_fk";
ALTER TABLE "audit_baselines" ADD CONSTRAINT "audit_baselines_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_policy_states" DROP CONSTRAINT IF EXISTS "audit_policy_states_org_id_organizations_id_fk";
ALTER TABLE "audit_policy_states" ADD CONSTRAINT "audit_policy_states_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_policy_states" DROP CONSTRAINT IF EXISTS "audit_policy_states_device_id_devices_id_fk";
ALTER TABLE "audit_policy_states" ADD CONSTRAINT "audit_policy_states_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_reliability" DROP CONSTRAINT IF EXISTS "device_reliability_device_id_devices_id_fk";
ALTER TABLE "device_reliability" ADD CONSTRAINT "device_reliability_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_reliability" DROP CONSTRAINT IF EXISTS "device_reliability_org_id_organizations_id_fk";
ALTER TABLE "device_reliability" ADD CONSTRAINT "device_reliability_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_reliability_history" DROP CONSTRAINT IF EXISTS "device_reliability_history_device_id_devices_id_fk";
ALTER TABLE "device_reliability_history" ADD CONSTRAINT "device_reliability_history_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_reliability_history" DROP CONSTRAINT IF EXISTS "device_reliability_history_org_id_organizations_id_fk";
ALTER TABLE "device_reliability_history" ADD CONSTRAINT "device_reliability_history_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_risk_events" DROP CONSTRAINT IF EXISTS "user_risk_events_org_id_organizations_id_fk";
ALTER TABLE "user_risk_events" ADD CONSTRAINT "user_risk_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_risk_events" DROP CONSTRAINT IF EXISTS "user_risk_events_user_id_users_id_fk";
ALTER TABLE "user_risk_events" ADD CONSTRAINT "user_risk_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_risk_policies" DROP CONSTRAINT IF EXISTS "user_risk_policies_org_id_organizations_id_fk";
ALTER TABLE "user_risk_policies" ADD CONSTRAINT "user_risk_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_risk_policies" DROP CONSTRAINT IF EXISTS "user_risk_policies_updated_by_users_id_fk";
ALTER TABLE "user_risk_policies" ADD CONSTRAINT "user_risk_policies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_risk_scores" DROP CONSTRAINT IF EXISTS "user_risk_scores_org_id_organizations_id_fk";
ALTER TABLE "user_risk_scores" ADD CONSTRAINT "user_risk_scores_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_risk_scores" DROP CONSTRAINT IF EXISTS "user_risk_scores_user_id_users_id_fk";
ALTER TABLE "user_risk_scores" ADD CONSTRAINT "user_risk_scores_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_action_plans" DROP CONSTRAINT IF EXISTS "ai_action_plans_session_id_ai_sessions_id_fk";
ALTER TABLE "ai_action_plans" ADD CONSTRAINT "ai_action_plans_session_id_ai_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."ai_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_action_plans" DROP CONSTRAINT IF EXISTS "ai_action_plans_org_id_organizations_id_fk";
ALTER TABLE "ai_action_plans" ADD CONSTRAINT "ai_action_plans_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_action_plans" DROP CONSTRAINT IF EXISTS "ai_action_plans_approved_by_users_id_fk";
ALTER TABLE "ai_action_plans" ADD CONSTRAINT "ai_action_plans_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_screenshots" DROP CONSTRAINT IF EXISTS "ai_screenshots_device_id_devices_id_fk";
ALTER TABLE "ai_screenshots" ADD CONSTRAINT "ai_screenshots_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_screenshots" DROP CONSTRAINT IF EXISTS "ai_screenshots_org_id_organizations_id_fk";
ALTER TABLE "ai_screenshots" ADD CONSTRAINT "ai_screenshots_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_screenshots" DROP CONSTRAINT IF EXISTS "ai_screenshots_session_id_ai_sessions_id_fk";
ALTER TABLE "ai_screenshots" ADD CONSTRAINT "ai_screenshots_session_id_ai_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."ai_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_logs" DROP CONSTRAINT IF EXISTS "agent_logs_device_id_devices_id_fk";
ALTER TABLE "agent_logs" ADD CONSTRAINT "agent_logs_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_logs" DROP CONSTRAINT IF EXISTS "agent_logs_org_id_organizations_id_fk";
ALTER TABLE "agent_logs" ADD CONSTRAINT "agent_logs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_device_context" DROP CONSTRAINT IF EXISTS "brain_device_context_org_id_organizations_id_fk";
ALTER TABLE "brain_device_context" ADD CONSTRAINT "brain_device_context_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_device_context" DROP CONSTRAINT IF EXISTS "brain_device_context_device_id_devices_id_fk";
ALTER TABLE "brain_device_context" ADD CONSTRAINT "brain_device_context_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_definitions" DROP CONSTRAINT IF EXISTS "playbook_definitions_org_id_organizations_id_fk";
ALTER TABLE "playbook_definitions" ADD CONSTRAINT "playbook_definitions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_definitions" DROP CONSTRAINT IF EXISTS "playbook_definitions_created_by_users_id_fk";
ALTER TABLE "playbook_definitions" ADD CONSTRAINT "playbook_definitions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_executions" DROP CONSTRAINT IF EXISTS "playbook_executions_org_id_organizations_id_fk";
ALTER TABLE "playbook_executions" ADD CONSTRAINT "playbook_executions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_executions" DROP CONSTRAINT IF EXISTS "playbook_executions_device_id_devices_id_fk";
ALTER TABLE "playbook_executions" ADD CONSTRAINT "playbook_executions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_executions" DROP CONSTRAINT IF EXISTS "playbook_executions_playbook_id_playbook_definitions_id_fk";
ALTER TABLE "playbook_executions" ADD CONSTRAINT "playbook_executions_playbook_id_playbook_definitions_id_fk" FOREIGN KEY ("playbook_id") REFERENCES "public"."playbook_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_executions" DROP CONSTRAINT IF EXISTS "playbook_executions_triggered_by_user_id_users_id_fk";
ALTER TABLE "playbook_executions" ADD CONSTRAINT "playbook_executions_triggered_by_user_id_users_id_fk" FOREIGN KEY ("triggered_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_change_log" DROP CONSTRAINT IF EXISTS "device_change_log_device_id_devices_id_fk";
ALTER TABLE "device_change_log" ADD CONSTRAINT "device_change_log_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_change_log" DROP CONSTRAINT IF EXISTS "device_change_log_org_id_organizations_id_fk";
ALTER TABLE "device_change_log" ADD CONSTRAINT "device_change_log_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_event_aggregations" DROP CONSTRAINT IF EXISTS "dns_event_aggregations_org_id_organizations_id_fk";
ALTER TABLE "dns_event_aggregations" ADD CONSTRAINT "dns_event_aggregations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_event_aggregations" DROP CONSTRAINT IF EXISTS "dns_event_aggregations_integration_id_dns_filter_integrations_id_fk";
ALTER TABLE "dns_event_aggregations" ADD CONSTRAINT "dns_event_aggregations_integration_id_dns_filter_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."dns_filter_integrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_event_aggregations" DROP CONSTRAINT IF EXISTS "dns_event_aggregations_device_id_devices_id_fk";
ALTER TABLE "dns_event_aggregations" ADD CONSTRAINT "dns_event_aggregations_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_filter_integrations" DROP CONSTRAINT IF EXISTS "dns_filter_integrations_org_id_organizations_id_fk";
ALTER TABLE "dns_filter_integrations" ADD CONSTRAINT "dns_filter_integrations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_filter_integrations" DROP CONSTRAINT IF EXISTS "dns_filter_integrations_created_by_users_id_fk";
ALTER TABLE "dns_filter_integrations" ADD CONSTRAINT "dns_filter_integrations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_policies" DROP CONSTRAINT IF EXISTS "dns_policies_org_id_organizations_id_fk";
ALTER TABLE "dns_policies" ADD CONSTRAINT "dns_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_policies" DROP CONSTRAINT IF EXISTS "dns_policies_integration_id_dns_filter_integrations_id_fk";
ALTER TABLE "dns_policies" ADD CONSTRAINT "dns_policies_integration_id_dns_filter_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."dns_filter_integrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_policies" DROP CONSTRAINT IF EXISTS "dns_policies_created_by_users_id_fk";
ALTER TABLE "dns_policies" ADD CONSTRAINT "dns_policies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_security_events" DROP CONSTRAINT IF EXISTS "dns_security_events_org_id_organizations_id_fk";
ALTER TABLE "dns_security_events" ADD CONSTRAINT "dns_security_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_security_events" DROP CONSTRAINT IF EXISTS "dns_security_events_integration_id_dns_filter_integrations_id_fk";
ALTER TABLE "dns_security_events" ADD CONSTRAINT "dns_security_events_integration_id_dns_filter_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."dns_filter_integrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_security_events" DROP CONSTRAINT IF EXISTS "dns_security_events_device_id_devices_id_fk";
ALTER TABLE "dns_security_events" ADD CONSTRAINT "dns_security_events_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cis_baseline_results" DROP CONSTRAINT IF EXISTS "cis_baseline_results_org_id_organizations_id_fk";
ALTER TABLE "cis_baseline_results" ADD CONSTRAINT "cis_baseline_results_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cis_baseline_results" DROP CONSTRAINT IF EXISTS "cis_baseline_results_device_id_devices_id_fk";
ALTER TABLE "cis_baseline_results" ADD CONSTRAINT "cis_baseline_results_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cis_baseline_results" DROP CONSTRAINT IF EXISTS "cis_baseline_results_baseline_id_cis_baselines_id_fk";
ALTER TABLE "cis_baseline_results" ADD CONSTRAINT "cis_baseline_results_baseline_id_cis_baselines_id_fk" FOREIGN KEY ("baseline_id") REFERENCES "public"."cis_baselines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cis_baselines" DROP CONSTRAINT IF EXISTS "cis_baselines_org_id_organizations_id_fk";
ALTER TABLE "cis_baselines" ADD CONSTRAINT "cis_baselines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cis_baselines" DROP CONSTRAINT IF EXISTS "cis_baselines_created_by_users_id_fk";
ALTER TABLE "cis_baselines" ADD CONSTRAINT "cis_baselines_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cis_remediation_actions" DROP CONSTRAINT IF EXISTS "cis_remediation_actions_org_id_organizations_id_fk";
ALTER TABLE "cis_remediation_actions" ADD CONSTRAINT "cis_remediation_actions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cis_remediation_actions" DROP CONSTRAINT IF EXISTS "cis_remediation_actions_device_id_devices_id_fk";
ALTER TABLE "cis_remediation_actions" ADD CONSTRAINT "cis_remediation_actions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cis_remediation_actions" DROP CONSTRAINT IF EXISTS "cis_remediation_actions_baseline_id_cis_baselines_id_fk";
ALTER TABLE "cis_remediation_actions" ADD CONSTRAINT "cis_remediation_actions_baseline_id_cis_baselines_id_fk" FOREIGN KEY ("baseline_id") REFERENCES "public"."cis_baselines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cis_remediation_actions" DROP CONSTRAINT IF EXISTS "cis_remediation_actions_baseline_result_id_cis_baseline_results_id_fk";
ALTER TABLE "cis_remediation_actions" ADD CONSTRAINT "cis_remediation_actions_baseline_result_id_cis_baseline_results_id_fk" FOREIGN KEY ("baseline_result_id") REFERENCES "public"."cis_baseline_results"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cis_remediation_actions" DROP CONSTRAINT IF EXISTS "cis_remediation_actions_approved_by_users_id_fk";
ALTER TABLE "cis_remediation_actions" ADD CONSTRAINT "cis_remediation_actions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cis_remediation_actions" DROP CONSTRAINT IF EXISTS "cis_remediation_actions_requested_by_users_id_fk";
ALTER TABLE "cis_remediation_actions" ADD CONSTRAINT "cis_remediation_actions_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "s1_actions" DROP CONSTRAINT IF EXISTS "s1_actions_org_id_organizations_id_fk";
ALTER TABLE "s1_actions" ADD CONSTRAINT "s1_actions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "s1_actions" DROP CONSTRAINT IF EXISTS "s1_actions_device_id_devices_id_fk";
ALTER TABLE "s1_actions" ADD CONSTRAINT "s1_actions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "s1_actions" DROP CONSTRAINT IF EXISTS "s1_actions_requested_by_users_id_fk";
ALTER TABLE "s1_actions" ADD CONSTRAINT "s1_actions_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "s1_agents" DROP CONSTRAINT IF EXISTS "s1_agents_org_id_organizations_id_fk";
ALTER TABLE "s1_agents" ADD CONSTRAINT "s1_agents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "s1_agents" DROP CONSTRAINT IF EXISTS "s1_agents_integration_id_s1_integrations_id_fk";
ALTER TABLE "s1_agents" ADD CONSTRAINT "s1_agents_integration_id_s1_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."s1_integrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "s1_agents" DROP CONSTRAINT IF EXISTS "s1_agents_device_id_devices_id_fk";
ALTER TABLE "s1_agents" ADD CONSTRAINT "s1_agents_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "s1_integrations" DROP CONSTRAINT IF EXISTS "s1_integrations_org_id_organizations_id_fk";
ALTER TABLE "s1_integrations" ADD CONSTRAINT "s1_integrations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "s1_integrations" DROP CONSTRAINT IF EXISTS "s1_integrations_created_by_users_id_fk";
ALTER TABLE "s1_integrations" ADD CONSTRAINT "s1_integrations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "s1_site_mappings" DROP CONSTRAINT IF EXISTS "s1_site_mappings_integration_id_s1_integrations_id_fk";
ALTER TABLE "s1_site_mappings" ADD CONSTRAINT "s1_site_mappings_integration_id_s1_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."s1_integrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "s1_site_mappings" DROP CONSTRAINT IF EXISTS "s1_site_mappings_org_id_organizations_id_fk";
ALTER TABLE "s1_site_mappings" ADD CONSTRAINT "s1_site_mappings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "s1_threats" DROP CONSTRAINT IF EXISTS "s1_threats_org_id_organizations_id_fk";
ALTER TABLE "s1_threats" ADD CONSTRAINT "s1_threats_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "s1_threats" DROP CONSTRAINT IF EXISTS "s1_threats_integration_id_s1_integrations_id_fk";
ALTER TABLE "s1_threats" ADD CONSTRAINT "s1_threats_integration_id_s1_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."s1_integrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "s1_threats" DROP CONSTRAINT IF EXISTS "s1_threats_device_id_devices_id_fk";
ALTER TABLE "s1_threats" ADD CONSTRAINT "s1_threats_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "huntress_agents" DROP CONSTRAINT IF EXISTS "huntress_agents_org_id_organizations_id_fk";
ALTER TABLE "huntress_agents" ADD CONSTRAINT "huntress_agents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "huntress_agents" DROP CONSTRAINT IF EXISTS "huntress_agents_integration_id_huntress_integrations_id_fk";
ALTER TABLE "huntress_agents" ADD CONSTRAINT "huntress_agents_integration_id_huntress_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."huntress_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "huntress_agents" DROP CONSTRAINT IF EXISTS "huntress_agents_device_id_devices_id_fk";
ALTER TABLE "huntress_agents" ADD CONSTRAINT "huntress_agents_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "huntress_incidents" DROP CONSTRAINT IF EXISTS "huntress_incidents_org_id_organizations_id_fk";
ALTER TABLE "huntress_incidents" ADD CONSTRAINT "huntress_incidents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "huntress_incidents" DROP CONSTRAINT IF EXISTS "huntress_incidents_integration_id_huntress_integrations_id_fk";
ALTER TABLE "huntress_incidents" ADD CONSTRAINT "huntress_incidents_integration_id_huntress_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."huntress_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "huntress_incidents" DROP CONSTRAINT IF EXISTS "huntress_incidents_device_id_devices_id_fk";
ALTER TABLE "huntress_incidents" ADD CONSTRAINT "huntress_incidents_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "huntress_integrations" DROP CONSTRAINT IF EXISTS "huntress_integrations_org_id_organizations_id_fk";
ALTER TABLE "huntress_integrations" ADD CONSTRAINT "huntress_integrations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "huntress_integrations" DROP CONSTRAINT IF EXISTS "huntress_integrations_created_by_users_id_fk";
ALTER TABLE "huntress_integrations" ADD CONSTRAINT "huntress_integrations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensitive_data_findings" DROP CONSTRAINT IF EXISTS "sensitive_data_findings_org_id_organizations_id_fk";
ALTER TABLE "sensitive_data_findings" ADD CONSTRAINT "sensitive_data_findings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensitive_data_findings" DROP CONSTRAINT IF EXISTS "sensitive_data_findings_device_id_devices_id_fk";
ALTER TABLE "sensitive_data_findings" ADD CONSTRAINT "sensitive_data_findings_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensitive_data_findings" DROP CONSTRAINT IF EXISTS "sensitive_data_findings_scan_id_sensitive_data_scans_id_fk";
ALTER TABLE "sensitive_data_findings" ADD CONSTRAINT "sensitive_data_findings_scan_id_sensitive_data_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."sensitive_data_scans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensitive_data_policies" DROP CONSTRAINT IF EXISTS "sensitive_data_policies_org_id_organizations_id_fk";
ALTER TABLE "sensitive_data_policies" ADD CONSTRAINT "sensitive_data_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensitive_data_policies" DROP CONSTRAINT IF EXISTS "sensitive_data_policies_created_by_users_id_fk";
ALTER TABLE "sensitive_data_policies" ADD CONSTRAINT "sensitive_data_policies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensitive_data_scans" DROP CONSTRAINT IF EXISTS "sensitive_data_scans_org_id_organizations_id_fk";
ALTER TABLE "sensitive_data_scans" ADD CONSTRAINT "sensitive_data_scans_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensitive_data_scans" DROP CONSTRAINT IF EXISTS "sensitive_data_scans_device_id_devices_id_fk";
ALTER TABLE "sensitive_data_scans" ADD CONSTRAINT "sensitive_data_scans_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensitive_data_scans" DROP CONSTRAINT IF EXISTS "sensitive_data_scans_policy_id_sensitive_data_policies_id_fk";
ALTER TABLE "sensitive_data_scans" ADD CONSTRAINT "sensitive_data_scans_policy_id_sensitive_data_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."sensitive_data_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensitive_data_scans" DROP CONSTRAINT IF EXISTS "sensitive_data_scans_requested_by_users_id_fk";
ALTER TABLE "sensitive_data_scans" ADD CONSTRAINT "sensitive_data_scans_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peripheral_events" DROP CONSTRAINT IF EXISTS "peripheral_events_org_id_organizations_id_fk";
ALTER TABLE "peripheral_events" ADD CONSTRAINT "peripheral_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peripheral_events" DROP CONSTRAINT IF EXISTS "peripheral_events_device_id_devices_id_fk";
ALTER TABLE "peripheral_events" ADD CONSTRAINT "peripheral_events_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peripheral_events" DROP CONSTRAINT IF EXISTS "peripheral_events_policy_id_peripheral_policies_id_fk";
ALTER TABLE "peripheral_events" ADD CONSTRAINT "peripheral_events_policy_id_peripheral_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."peripheral_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peripheral_policies" DROP CONSTRAINT IF EXISTS "peripheral_policies_org_id_organizations_id_fk";
ALTER TABLE "peripheral_policies" ADD CONSTRAINT "peripheral_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peripheral_policies" DROP CONSTRAINT IF EXISTS "peripheral_policies_created_by_users_id_fk";
ALTER TABLE "peripheral_policies" ADD CONSTRAINT "peripheral_policies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_extensions" DROP CONSTRAINT IF EXISTS "browser_extensions_org_id_organizations_id_fk";
ALTER TABLE "browser_extensions" ADD CONSTRAINT "browser_extensions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_extensions" DROP CONSTRAINT IF EXISTS "browser_extensions_device_id_devices_id_fk";
ALTER TABLE "browser_extensions" ADD CONSTRAINT "browser_extensions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_policies" DROP CONSTRAINT IF EXISTS "browser_policies_org_id_organizations_id_fk";
ALTER TABLE "browser_policies" ADD CONSTRAINT "browser_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_policies" DROP CONSTRAINT IF EXISTS "browser_policies_created_by_users_id_fk";
ALTER TABLE "browser_policies" ADD CONSTRAINT "browser_policies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_policy_violations" DROP CONSTRAINT IF EXISTS "browser_policy_violations_org_id_organizations_id_fk";
ALTER TABLE "browser_policy_violations" ADD CONSTRAINT "browser_policy_violations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_policy_violations" DROP CONSTRAINT IF EXISTS "browser_policy_violations_device_id_devices_id_fk";
ALTER TABLE "browser_policy_violations" ADD CONSTRAINT "browser_policy_violations_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_policy_violations" DROP CONSTRAINT IF EXISTS "browser_policy_violations_policy_id_browser_policies_id_fk";
ALTER TABLE "browser_policy_violations" ADD CONSTRAINT "browser_policy_violations_policy_id_browser_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."browser_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_process_check_results" DROP CONSTRAINT IF EXISTS "service_process_check_results_org_id_organizations_id_fk";
ALTER TABLE "service_process_check_results" ADD CONSTRAINT "service_process_check_results_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_process_check_results" DROP CONSTRAINT IF EXISTS "service_process_check_results_device_id_devices_id_fk";
ALTER TABLE "service_process_check_results" ADD CONSTRAINT "service_process_check_results_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_warranty" DROP CONSTRAINT IF EXISTS "device_warranty_device_id_devices_id_fk";
ALTER TABLE "device_warranty" ADD CONSTRAINT "device_warranty_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_warranty" DROP CONSTRAINT IF EXISTS "device_warranty_org_id_organizations_id_fk";
ALTER TABLE "device_warranty" ADD CONSTRAINT "device_warranty_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_boot_metrics_device_boot_idx" ON "device_boot_metrics" USING btree ("device_id","boot_timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_boot_metrics_device_created_idx" ON "device_boot_metrics" USING btree ("device_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_boot_metrics_org_device_idx" ON "device_boot_metrics" USING btree ("org_id","device_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_ip_history_device_id_idx" ON "device_ip_history" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_ip_history_org_id_idx" ON "device_ip_history" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_ip_history_ip_address_idx" ON "device_ip_history" USING btree ("ip_address");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_ip_history_first_seen_idx" ON "device_ip_history" USING btree ("first_seen");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_ip_history_last_seen_idx" ON "device_ip_history" USING btree ("last_seen");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_ip_history_is_active_idx" ON "device_ip_history" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_ip_history_ip_time_idx" ON "device_ip_history" USING btree ("ip_address","first_seen","last_seen");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_routing_rules_org_id_idx" ON "notification_routing_rules" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_routing_rules_priority_idx" ON "notification_routing_rules" USING btree ("org_id","priority");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "network_baselines_org_site_subnet_unique" ON "network_baselines" USING btree ("org_id","site_id","subnet");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "network_baselines_org_id_idx" ON "network_baselines" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "network_baselines_site_id_idx" ON "network_baselines" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "network_change_events_org_id_idx" ON "network_change_events" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "network_change_events_site_id_idx" ON "network_change_events" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "network_change_events_baseline_id_idx" ON "network_change_events" USING btree ("baseline_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "network_change_events_profile_id_idx" ON "network_change_events" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "network_change_events_detected_at_idx" ON "network_change_events" USING btree ("detected_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "network_change_events_acknowledged_idx" ON "network_change_events" USING btree ("acknowledged");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "network_known_guests_partner_mac_unique" ON "network_known_guests" USING btree ("partner_id","mac_address");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "network_known_guests_partner_id_idx" ON "network_known_guests" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "software_compliance_device_id_idx" ON "software_compliance_status" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "software_compliance_policy_id_idx" ON "software_compliance_status" USING btree ("policy_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "software_compliance_status_idx" ON "software_compliance_status" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "software_compliance_device_policy_unique" ON "software_compliance_status" USING btree ("device_id","policy_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "software_policies_org_id_idx" ON "software_policies" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "software_policies_target_type_idx" ON "software_policies" USING btree ("target_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "software_policies_active_priority_idx" ON "software_policies" USING btree ("is_active","priority");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "software_policy_audit_org_id_idx" ON "software_policy_audit" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "software_policy_audit_policy_id_idx" ON "software_policy_audit" USING btree ("policy_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "software_policy_audit_device_id_idx" ON "software_policy_audit" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "software_policy_audit_timestamp_idx" ON "software_policy_audit" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cpar_feature_link_id_idx" ON "config_policy_alert_rules" USING btree ("feature_link_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "config_assignments_policy_id_idx" ON "config_policy_assignments" USING btree ("config_policy_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "config_assignments_level_target_idx" ON "config_policy_assignments" USING btree ("level","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "config_assignments_unique" ON "config_policy_assignments" USING btree ("config_policy_id","level","target_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cpaut_feature_link_id_idx" ON "config_policy_automations" USING btree ("feature_link_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cpaut_trigger_type_enabled_idx" ON "config_policy_automations" USING btree ("trigger_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cpcr_feature_link_id_idx" ON "config_policy_compliance_rules" USING btree ("feature_link_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "config_feature_links_policy_id_idx" ON "config_policy_feature_links" USING btree ("config_policy_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "config_feature_links_feature_type_idx" ON "config_policy_feature_links" USING btree ("feature_type");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "config_feature_links_unique" ON "config_policy_feature_links" USING btree ("config_policy_id","feature_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cpmon_watches_settings_id_idx" ON "config_policy_monitoring_watches" USING btree ("settings_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "config_policies_org_id_idx" ON "configuration_policies" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "config_policies_status_idx" ON "configuration_policies" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "log_correlation_rules_org_id_idx" ON "log_correlation_rules" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "log_correlation_rules_active_idx" ON "log_correlation_rules" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "log_correlations_org_id_idx" ON "log_correlations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "log_correlations_rule_id_idx" ON "log_correlations" USING btree ("rule_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "log_correlations_status_idx" ON "log_correlations" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "log_search_queries_org_id_idx" ON "log_search_queries" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "log_search_queries_created_by_idx" ON "log_search_queries" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_baseline_apply_approvals_org_status_idx" ON "audit_baseline_apply_approvals" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_baseline_apply_approvals_baseline_idx" ON "audit_baseline_apply_approvals" USING btree ("baseline_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_baseline_apply_approvals_expires_at_idx" ON "audit_baseline_apply_approvals" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_results_org_device_idx" ON "audit_baseline_results" USING btree ("org_id","device_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_results_checked_at_idx" ON "audit_baseline_results" USING btree ("checked_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_results_baseline_checked_idx" ON "audit_baseline_results" USING btree ("baseline_id","checked_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_baselines_org_os_idx" ON "audit_baselines" USING btree ("org_id","os_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_baselines_org_active_idx" ON "audit_baselines" USING btree ("org_id","is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_policy_states_org_device_collected_idx" ON "audit_policy_states" USING btree ("org_id","device_id","collected_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_policy_states_device_collected_idx" ON "audit_policy_states" USING btree ("device_id","collected_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_policy_states_org_collected_idx" ON "audit_policy_states" USING btree ("org_id","collected_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reliability_org_score_idx" ON "device_reliability" USING btree ("org_id","reliability_score");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reliability_score_idx" ON "device_reliability" USING btree ("reliability_score");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reliability_trend_idx" ON "device_reliability" USING btree ("trend_direction");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reliability_history_device_collected_idx" ON "device_reliability_history" USING btree ("device_id","collected_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reliability_history_org_collected_idx" ON "device_reliability_history" USING btree ("org_id","collected_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_risk_events_org_user_time_idx" ON "user_risk_events" USING btree ("org_id","user_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_risk_events_org_event_type_time_idx" ON "user_risk_events" USING btree ("org_id","event_type","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_risk_policy_org_idx" ON "user_risk_policies" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_risk_org_user_calc_idx" ON "user_risk_scores" USING btree ("org_id","user_id","calculated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_risk_score_idx" ON "user_risk_scores" USING btree ("score");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_risk_org_score_idx" ON "user_risk_scores" USING btree ("org_id","score");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_risk_org_user_idx" ON "user_risk_scores" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_action_plans_session_id_idx" ON "ai_action_plans" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_action_plans_status_idx" ON "ai_action_plans" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_screenshots_device_id_idx" ON "ai_screenshots" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_screenshots_org_id_idx" ON "ai_screenshots" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_screenshots_expires_at_idx" ON "ai_screenshots" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_logs_device_idx" ON "agent_logs" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_logs_org_ts_idx" ON "agent_logs" USING btree ("org_id","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_logs_level_component_idx" ON "agent_logs" USING btree ("level","component");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_logs_timestamp_idx" ON "agent_logs" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brain_device_context_device_id_idx" ON "brain_device_context" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brain_device_context_org_id_idx" ON "brain_device_context" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brain_device_context_device_type_idx" ON "brain_device_context" USING btree ("device_id","context_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brain_device_context_device_active_idx" ON "brain_device_context" USING btree ("device_id","resolved_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "playbook_definitions_org_id_idx" ON "playbook_definitions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "playbook_definitions_active_idx" ON "playbook_definitions" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "playbook_definitions_category_idx" ON "playbook_definitions" USING btree ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "playbook_executions_org_id_idx" ON "playbook_executions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "playbook_executions_device_id_idx" ON "playbook_executions" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "playbook_executions_playbook_id_idx" ON "playbook_executions" USING btree ("playbook_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "playbook_executions_status_idx" ON "playbook_executions" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "playbook_executions_created_at_idx" ON "playbook_executions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_change_log_device_id_idx" ON "device_change_log" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_change_log_org_id_idx" ON "device_change_log" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_change_log_timestamp_idx" ON "device_change_log" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_change_log_type_idx" ON "device_change_log" USING btree ("change_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_change_log_action_idx" ON "device_change_log" USING btree ("change_action");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_change_log_device_time_idx" ON "device_change_log" USING btree ("device_id","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_change_log_org_time_idx" ON "device_change_log" USING btree ("org_id","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_change_log_created_at_idx" ON "device_change_log" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "device_change_log_device_fingerprint_uniq" ON "device_change_log" USING btree ("device_id","fingerprint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dns_event_agg_org_date_idx" ON "dns_event_aggregations" USING btree ("org_id","date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dns_event_agg_org_date_integration_idx" ON "dns_event_aggregations" USING btree ("org_id","date","integration_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dns_event_agg_integration_id_idx" ON "dns_event_aggregations" USING btree ("integration_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dns_event_agg_device_id_idx" ON "dns_event_aggregations" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dns_filter_integrations_org_id_idx" ON "dns_filter_integrations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dns_filter_integrations_provider_idx" ON "dns_filter_integrations" USING btree ("provider");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dns_policies_org_id_idx" ON "dns_policies" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dns_policies_integration_id_idx" ON "dns_policies" USING btree ("integration_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dns_security_events_org_ts_idx" ON "dns_security_events" USING btree ("org_id","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dns_security_events_integration_id_idx" ON "dns_security_events" USING btree ("integration_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dns_security_events_device_id_idx" ON "dns_security_events" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dns_security_events_domain_idx" ON "dns_security_events" USING btree ("domain");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dns_security_events_action_cat_idx" ON "dns_security_events" USING btree ("action","category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dns_security_events_provider_id_idx" ON "dns_security_events" USING btree ("integration_id","provider_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dns_security_events_provider_evt_uniq" ON "dns_security_events" USING btree ("integration_id","provider_event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cis_results_org_device_checked_idx" ON "cis_baseline_results" USING btree ("org_id","device_id","checked_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cis_results_baseline_checked_idx" ON "cis_baseline_results" USING btree ("baseline_id","checked_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cis_results_score_idx" ON "cis_baseline_results" USING btree ("score");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cis_baselines_org_os_idx" ON "cis_baselines" USING btree ("org_id","os_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cis_baselines_org_active_idx" ON "cis_baselines" USING btree ("org_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cis_check_catalog_unique_idx" ON "cis_check_catalog" USING btree ("os_type","benchmark_version","level","check_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cis_check_catalog_os_benchmark_idx" ON "cis_check_catalog" USING btree ("os_type","benchmark_version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cis_remediation_org_device_status_idx" ON "cis_remediation_actions" USING btree ("org_id","device_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cis_remediation_org_approval_status_idx" ON "cis_remediation_actions" USING btree ("org_id","approval_status","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cis_remediation_result_idx" ON "cis_remediation_actions" USING btree ("baseline_result_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cis_remediation_check_idx" ON "cis_remediation_actions" USING btree ("check_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "s1_actions_org_status_idx" ON "s1_actions" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "s1_actions_provider_action_idx" ON "s1_actions" USING btree ("provider_action_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "s1_agents_external_idx" ON "s1_agents" USING btree ("integration_id","s1_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "s1_agents_org_device_idx" ON "s1_agents" USING btree ("org_id","device_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "s1_agents_integration_idx" ON "s1_agents" USING btree ("integration_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "s1_integrations_org_idx" ON "s1_integrations" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "s1_site_mappings_integration_site_idx" ON "s1_site_mappings" USING btree ("integration_id","site_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "s1_site_mappings_org_idx" ON "s1_site_mappings" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "s1_threats_external_idx" ON "s1_threats" USING btree ("integration_id","s1_threat_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "s1_threats_org_status_idx" ON "s1_threats" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "s1_threats_org_severity_status_idx" ON "s1_threats" USING btree ("org_id","severity","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "s1_threats_integration_idx" ON "s1_threats" USING btree ("integration_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "s1_threats_integration_detected_idx" ON "s1_threats" USING btree ("integration_id","detected_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "s1_threats_device_idx" ON "s1_threats" USING btree ("device_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "huntress_agents_agent_id_idx" ON "huntress_agents" USING btree ("integration_id","huntress_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "huntress_agents_org_device_idx" ON "huntress_agents" USING btree ("org_id","device_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "huntress_incidents_external_idx" ON "huntress_incidents" USING btree ("integration_id","huntress_incident_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "huntress_incidents_org_status_idx" ON "huntress_incidents" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "huntress_integrations_org_idx" ON "huntress_integrations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sensitive_findings_org_risk_idx" ON "sensitive_data_findings" USING btree ("org_id","risk");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sensitive_findings_scan_idx" ON "sensitive_data_findings" USING btree ("scan_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sensitive_findings_org_last_seen_idx" ON "sensitive_data_findings" USING btree ("org_id","last_seen_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sensitive_policy_org_idx" ON "sensitive_data_policies" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sensitive_scan_org_device_idx" ON "sensitive_data_scans" USING btree ("org_id","device_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sensitive_scan_status_idx" ON "sensitive_data_scans" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sensitive_scan_org_idempotency_idx" ON "sensitive_data_scans" USING btree ("org_id","idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "peripheral_events_org_device_time_idx" ON "peripheral_events" USING btree ("org_id","device_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "peripheral_events_type_idx" ON "peripheral_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "peripheral_events_org_policy_time_idx" ON "peripheral_events" USING btree ("org_id","policy_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "peripheral_events_source_event_idx" ON "peripheral_events" USING btree ("org_id","device_id","source_event_id") WHERE source_event_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "peripheral_events_type_time_idx" ON "peripheral_events" USING btree ("event_type","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "peripheral_policy_org_active_idx" ON "peripheral_policies" USING btree ("org_id","is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "peripheral_policy_org_class_idx" ON "peripheral_policies" USING btree ("org_id","device_class");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "browser_ext_org_device_idx" ON "browser_extensions" USING btree ("org_id","device_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "browser_ext_extension_id_idx" ON "browser_extensions" USING btree ("extension_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "browser_ext_risk_level_idx" ON "browser_extensions" USING btree ("org_id","risk_level");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "browser_ext_org_device_browser_ext_uniq" ON "browser_extensions" USING btree ("org_id","device_id","browser","extension_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "browser_policy_org_idx" ON "browser_policies" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "browser_policy_violations_org_device_idx" ON "browser_policy_violations" USING btree ("org_id","device_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "browser_policy_violations_policy_idx" ON "browser_policy_violations" USING btree ("policy_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "browser_policy_violations_unresolved_idx" ON "browser_policy_violations" USING btree ("org_id","resolved_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "spc_results_org_id_idx" ON "service_process_check_results" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "spc_results_device_id_idx" ON "service_process_check_results" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "spc_results_device_name_ts_idx" ON "service_process_check_results" USING btree ("device_id","name","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_warranty_org_id_idx" ON "device_warranty" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "device_warranty_device_id_idx" ON "device_warranty" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_warranty_end_date_idx" ON "device_warranty" USING btree ("warranty_end_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_warranty_next_sync_at_idx" ON "device_warranty" USING btree ("next_sync_at");--> statement-breakpoint
ALTER TABLE "patch_approvals" DROP CONSTRAINT IF EXISTS "patch_approvals_ring_id_patch_policies_id_fk";
ALTER TABLE "patch_approvals" ADD CONSTRAINT "patch_approvals_ring_id_patch_policies_id_fk" FOREIGN KEY ("ring_id") REFERENCES "public"."patch_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_compliance_snapshots" DROP CONSTRAINT IF EXISTS "patch_compliance_snapshots_ring_id_patch_policies_id_fk";
ALTER TABLE "patch_compliance_snapshots" ADD CONSTRAINT "patch_compliance_snapshots_ring_id_patch_policies_id_fk" FOREIGN KEY ("ring_id") REFERENCES "public"."patch_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_jobs" DROP CONSTRAINT IF EXISTS "patch_jobs_ring_id_patch_policies_id_fk";
ALTER TABLE "patch_jobs" ADD CONSTRAINT "patch_jobs_ring_id_patch_policies_id_fk" FOREIGN KEY ("ring_id") REFERENCES "public"."patch_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovered_assets" DROP CONSTRAINT IF EXISTS "discovered_assets_approved_by_users_id_fk";
ALTER TABLE "discovered_assets" ADD CONSTRAINT "discovered_assets_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovered_assets" DROP CONSTRAINT IF EXISTS "discovered_assets_dismissed_by_users_id_fk";
ALTER TABLE "discovered_assets" ADD CONSTRAINT "discovered_assets_dismissed_by_users_id_fk" FOREIGN KEY ("dismissed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_catalog" DROP CONSTRAINT IF EXISTS "software_catalog_org_id_organizations_id_fk";
ALTER TABLE "software_catalog" ADD CONSTRAINT "software_catalog_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_jobs" DROP CONSTRAINT IF EXISTS "backup_jobs_org_id_organizations_id_fk";
ALTER TABLE "backup_jobs" ADD CONSTRAINT "backup_jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_jobs" DROP CONSTRAINT IF EXISTS "backup_jobs_policy_id_backup_policies_id_fk";
ALTER TABLE "backup_jobs" ADD CONSTRAINT "backup_jobs_policy_id_backup_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."backup_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_policies" DROP CONSTRAINT IF EXISTS "backup_policies_org_id_organizations_id_fk";
ALTER TABLE "backup_policies" ADD CONSTRAINT "backup_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_snapshots" DROP CONSTRAINT IF EXISTS "backup_snapshots_org_id_organizations_id_fk";
ALTER TABLE "backup_snapshots" ADD CONSTRAINT "backup_snapshots_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_snapshots" DROP CONSTRAINT IF EXISTS "backup_snapshots_config_id_backup_configs_id_fk";
ALTER TABLE "backup_snapshots" ADD CONSTRAINT "backup_snapshots_config_id_backup_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."backup_configs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_jobs" DROP CONSTRAINT IF EXISTS "restore_jobs_org_id_organizations_id_fk";
ALTER TABLE "restore_jobs" ADD CONSTRAINT "restore_jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_sessions" DROP CONSTRAINT IF EXISTS "ai_sessions_device_id_devices_id_fk";
ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_sessions" DROP CONSTRAINT IF EXISTS "ai_sessions_flagged_by_users_id_fk";
ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_flagged_by_users_id_fk" FOREIGN KEY ("flagged_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_connections_device_port_state_idx" ON "device_connections" USING btree ("device_id","local_port","state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_connections_device_updated_idx" ON "device_connections" USING btree ("device_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "patch_approvals_org_patch_ring_unique" ON "patch_approvals" USING btree ("org_id","patch_id",COALESCE("ring_id", '00000000-0000-0000-0000-000000000000'));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "security_posture_snapshots_org_device_captured_idx" ON "security_posture_snapshots" USING btree ("org_id","device_id","captured_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "security_threats_device_status_detected_idx" ON "security_threats" USING btree ("device_id","status","detected_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "software_catalog_org_id_idx" ON "software_catalog" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "software_inventory_name_vendor_idx" ON "software_inventory" USING btree ("name","vendor");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "backup_jobs_org_id_idx" ON "backup_jobs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "backup_jobs_policy_id_idx" ON "backup_jobs" USING btree ("policy_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "backup_jobs_created_at_idx" ON "backup_jobs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "backup_policies_org_id_idx" ON "backup_policies" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "backup_policies_enabled_idx" ON "backup_policies" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "backup_snapshots_org_id_idx" ON "backup_snapshots" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "restore_jobs_org_id_idx" ON "restore_jobs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "apc_config_policy_id_idx" ON "automation_policy_compliance" USING btree ("config_policy_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "apc_device_id_idx" ON "automation_policy_compliance" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_event_logs_search_vector_idx" ON "device_event_logs" USING gin (search_vector);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_event_logs_message_trgm_idx" ON "device_event_logs" USING gin (message gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_event_logs_source_trgm_idx" ON "device_event_logs" USING gin (source gin_trgm_ops);--> statement-breakpoint
ALTER TABLE "discovered_assets" DROP COLUMN IF EXISTS "status";--> statement-breakpoint
ALTER TABLE "discovered_assets" DROP COLUMN IF EXISTS "ignored_by";--> statement-breakpoint
ALTER TABLE "discovered_assets" DROP COLUMN IF EXISTS "ignored_at";--> statement-breakpoint
ALTER TABLE "backup_policies" DROP COLUMN IF EXISTS "target_type";--> statement-breakpoint
ALTER TABLE "backup_policies" DROP COLUMN IF EXISTS "target_id";--> statement-breakpoint
ALTER TABLE "backup_policies" DROP COLUMN IF EXISTS "includes";--> statement-breakpoint
ALTER TABLE "backup_policies" DROP COLUMN IF EXISTS "excludes";--> statement-breakpoint
ALTER TABLE "backup_policies" DROP COLUMN IF EXISTS "priority";--> statement-breakpoint
ALTER TABLE "agent_versions" DROP CONSTRAINT IF EXISTS "agent_versions_version_platform_arch_component_unique";
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_version_platform_arch_component_unique" UNIQUE("version","platform","architecture","component");--> statement-breakpoint
DROP TYPE "public"."discovered_asset_status";--> statement-breakpoint
DROP TYPE "public"."policy_status";--> statement-breakpoint
DROP TYPE "public"."policy_type";