CREATE TYPE "public"."org_status" AS ENUM('active', 'suspended', 'trial', 'churned');--> statement-breakpoint
CREATE TYPE "public"."org_type" AS ENUM('customer', 'internal');--> statement-breakpoint
CREATE TYPE "public"."partner_type" AS ENUM('msp', 'enterprise', 'internal');--> statement-breakpoint
CREATE TYPE "public"."plan_type" AS ENUM('free', 'pro', 'enterprise', 'unlimited');--> statement-breakpoint
CREATE TYPE "public"."mfa_method" AS ENUM('totp', 'sms');--> statement-breakpoint
CREATE TYPE "public"."org_access" AS ENUM('all', 'selected', 'none');--> statement-breakpoint
CREATE TYPE "public"."role_scope" AS ENUM('system', 'partner', 'organization');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'invited', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."connection_protocol" AS ENUM('tcp', 'tcp6', 'udp', 'udp6');--> statement-breakpoint
CREATE TYPE "public"."device_group_type" AS ENUM('static', 'dynamic');--> statement-breakpoint
CREATE TYPE "public"."device_status" AS ENUM('online', 'offline', 'maintenance', 'decommissioned', 'quarantined');--> statement-breakpoint
CREATE TYPE "public"."group_membership_log_action" AS ENUM('added', 'removed');--> statement-breakpoint
CREATE TYPE "public"."group_membership_log_reason" AS ENUM('manual', 'filter_match', 'filter_unmatch', 'pinned', 'unpinned');--> statement-breakpoint
CREATE TYPE "public"."membership_source" AS ENUM('manual', 'dynamic_rule', 'policy');--> statement-breakpoint
CREATE TYPE "public"."os_type" AS ENUM('windows', 'macos', 'linux');--> statement-breakpoint
CREATE TYPE "public"."execution_status" AS ENUM('pending', 'queued', 'running', 'completed', 'failed', 'timeout', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."script_language" AS ENUM('powershell', 'bash', 'python', 'cmd');--> statement-breakpoint
CREATE TYPE "public"."script_run_as" AS ENUM('system', 'user', 'elevated');--> statement-breakpoint
CREATE TYPE "public"."trigger_type" AS ENUM('manual', 'scheduled', 'alert', 'policy');--> statement-breakpoint
CREATE TYPE "public"."alert_severity" AS ENUM('critical', 'high', 'medium', 'low', 'info');--> statement-breakpoint
CREATE TYPE "public"."alert_status" AS ENUM('active', 'acknowledged', 'resolved', 'suppressed');--> statement-breakpoint
CREATE TYPE "public"."notification_channel_type" AS ENUM('email', 'slack', 'teams', 'webhook', 'pagerduty', 'sms');--> statement-breakpoint
CREATE TYPE "public"."file_transfer_direction" AS ENUM('upload', 'download');--> statement-breakpoint
CREATE TYPE "public"."file_transfer_status" AS ENUM('pending', 'transferring', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."remote_session_status" AS ENUM('pending', 'connecting', 'active', 'disconnected', 'failed');--> statement-breakpoint
CREATE TYPE "public"."remote_session_type" AS ENUM('terminal', 'desktop', 'file_transfer');--> statement-breakpoint
CREATE TYPE "public"."actor_type" AS ENUM('user', 'api_key', 'agent', 'system');--> statement-breakpoint
CREATE TYPE "public"."audit_result" AS ENUM('success', 'failure', 'denied');--> statement-breakpoint
CREATE TYPE "public"."report_format" AS ENUM('csv', 'pdf', 'excel');--> statement-breakpoint
CREATE TYPE "public"."report_run_status" AS ENUM('pending', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."report_schedule" AS ENUM('one_time', 'daily', 'weekly', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."report_type" AS ENUM('device_inventory', 'software_inventory', 'alert_summary', 'compliance', 'performance', 'executive_summary');--> statement-breakpoint
CREATE TYPE "public"."api_key_status" AS ENUM('active', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."sso_provider_status" AS ENUM('active', 'inactive', 'testing');--> statement-breakpoint
CREATE TYPE "public"."sso_provider_type" AS ENUM('oidc', 'saml');--> statement-breakpoint
CREATE TYPE "public"."access_review_decision" AS ENUM('pending', 'approved', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."access_review_status" AS ENUM('pending', 'in_progress', 'completed');--> statement-breakpoint
CREATE TYPE "public"."device_patch_status" AS ENUM('pending', 'installed', 'failed', 'skipped', 'missing');--> statement-breakpoint
CREATE TYPE "public"."patch_approval_status" AS ENUM('pending', 'approved', 'rejected', 'deferred');--> statement-breakpoint
CREATE TYPE "public"."patch_compliance_report_format" AS ENUM('csv', 'pdf');--> statement-breakpoint
CREATE TYPE "public"."patch_compliance_report_status" AS ENUM('pending', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."patch_job_result_status" AS ENUM('pending', 'running', 'completed', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."patch_job_status" AS ENUM('scheduled', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."patch_rollback_status" AS ENUM('pending', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."patch_severity" AS ENUM('critical', 'important', 'moderate', 'low', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."patch_source" AS ENUM('microsoft', 'apple', 'linux', 'third_party', 'custom');--> statement-breakpoint
CREATE TYPE "public"."event_bus_priority" AS ENUM('low', 'normal', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."plugin_status" AS ENUM('active', 'disabled', 'error', 'installing');--> statement-breakpoint
CREATE TYPE "public"."psa_provider" AS ENUM('connectwise', 'autotask', 'halo', 'syncro', 'kaseya', 'jira', 'servicenow', 'freshservice', 'zendesk', 'other');--> statement-breakpoint
CREATE TYPE "public"."webhook_delivery_status" AS ENUM('pending', 'delivered', 'failed', 'retrying');--> statement-breakpoint
CREATE TYPE "public"."webhook_status" AS ENUM('active', 'disabled', 'error');--> statement-breakpoint
CREATE TYPE "public"."ticket_priority" AS ENUM('low', 'normal', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."ticket_status" AS ENUM('new', 'open', 'pending', 'on_hold', 'resolved', 'closed');--> statement-breakpoint
CREATE TYPE "public"."plugin_install_status" AS ENUM('available', 'installing', 'installed', 'updating', 'uninstalling', 'error');--> statement-breakpoint
CREATE TYPE "public"."plugin_type" AS ENUM('integration', 'automation', 'reporting', 'collector', 'notification', 'ui');--> statement-breakpoint
CREATE TYPE "public"."discovered_asset_status" AS ENUM('new', 'identified', 'managed', 'ignored', 'offline');--> statement-breakpoint
CREATE TYPE "public"."discovered_asset_type" AS ENUM('workstation', 'server', 'printer', 'router', 'switch', 'firewall', 'access_point', 'phone', 'iot', 'camera', 'nas', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."discovery_job_status" AS ENUM('scheduled', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."discovery_method" AS ENUM('arp', 'ping', 'port_scan', 'snmp', 'wmi', 'ssh', 'mdns', 'netbios');--> statement-breakpoint
CREATE TYPE "public"."device_platform" AS ENUM('ios', 'android');--> statement-breakpoint
CREATE TYPE "public"."maintenance_recurrence" AS ENUM('once', 'daily', 'weekly', 'monthly', 'custom');--> statement-breakpoint
CREATE TYPE "public"."maintenance_window_status" AS ENUM('scheduled', 'active', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."security_provider" AS ENUM('windows_defender', 'bitdefender', 'sophos', 'sentinelone', 'crowdstrike', 'malwarebytes', 'eset', 'kaspersky', 'other');--> statement-breakpoint
CREATE TYPE "public"."security_risk_level" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."threat_severity" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."threat_status" AS ENUM('detected', 'quarantined', 'removed', 'allowed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."deployment_device_status" AS ENUM('pending', 'running', 'completed', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."deployment_status" AS ENUM('draft', 'pending', 'running', 'paused', 'downloading', 'installing', 'completed', 'failed', 'cancelled', 'rollback');--> statement-breakpoint
CREATE TYPE "public"."backup_job_type" AS ENUM('scheduled', 'manual', 'incremental');--> statement-breakpoint
CREATE TYPE "public"."backup_provider" AS ENUM('local', 's3', 'azure_blob', 'google_cloud', 'backblaze');--> statement-breakpoint
CREATE TYPE "public"."backup_status" AS ENUM('pending', 'running', 'completed', 'failed', 'cancelled', 'partial');--> statement-breakpoint
CREATE TYPE "public"."backup_type" AS ENUM('file', 'system_image', 'database', 'application');--> statement-breakpoint
CREATE TYPE "public"."restore_type" AS ENUM('full', 'selective', 'bare_metal');--> statement-breakpoint
CREATE TYPE "public"."notification_priority" AS ENUM('low', 'normal', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('alert', 'device', 'script', 'automation', 'system', 'user', 'security');--> statement-breakpoint
CREATE TYPE "public"."policy_status" AS ENUM('draft', 'active', 'inactive', 'archived');--> statement-breakpoint
CREATE TYPE "public"."policy_type" AS ENUM('monitoring', 'patching', 'security', 'backup', 'maintenance', 'software', 'alert', 'custom');--> statement-breakpoint
CREATE TYPE "public"."automation_on_failure" AS ENUM('stop', 'continue', 'notify');--> statement-breakpoint
CREATE TYPE "public"."automation_run_status" AS ENUM('running', 'completed', 'failed', 'partial');--> statement-breakpoint
CREATE TYPE "public"."automation_trigger_type" AS ENUM('schedule', 'event', 'webhook', 'manual');--> statement-breakpoint
CREATE TYPE "public"."compliance_status" AS ENUM('compliant', 'non_compliant', 'pending', 'error');--> statement-breakpoint
CREATE TYPE "public"."policy_enforcement" AS ENUM('monitor', 'warn', 'enforce');--> statement-breakpoint
CREATE TYPE "public"."custom_field_type" AS ENUM('text', 'number', 'boolean', 'dropdown', 'date');--> statement-breakpoint
CREATE TYPE "public"."event_log_category" AS ENUM('security', 'hardware', 'application', 'system');--> statement-breakpoint
CREATE TYPE "public"."event_log_level" AS ENUM('info', 'warning', 'error', 'critical');--> statement-breakpoint
CREATE TYPE "public"."ai_message_role" AS ENUM('user', 'assistant', 'system', 'tool_use', 'tool_result');--> statement-breakpoint
CREATE TYPE "public"."ai_session_status" AS ENUM('active', 'closed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."ai_tool_status" AS ENUM('pending', 'approved', 'executing', 'completed', 'failed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."monitor_status" AS ENUM('online', 'offline', 'degraded', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."monitor_type" AS ENUM('icmp_ping', 'tcp_port', 'http_check', 'dns_check');--> statement-breakpoint
CREATE TYPE "public"."filesystem_cleanup_run_status" AS ENUM('previewed', 'executed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."filesystem_snapshot_trigger" AS ENUM('on_demand', 'threshold');--> statement-breakpoint
CREATE TYPE "public"."device_session_activity_state" AS ENUM('active', 'idle', 'locked', 'away', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."device_session_type" AS ENUM('console', 'rdp', 'ssh', 'other');--> statement-breakpoint
CREATE TABLE "enrollment_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid,
	"name" varchar(255) NOT NULL,
	"key" varchar(64) NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"max_usage" integer,
	"expires_at" timestamp,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "enrollment_keys_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"type" "org_type" DEFAULT 'customer' NOT NULL,
	"status" "org_status" DEFAULT 'active' NOT NULL,
	"max_devices" integer,
	"settings" jsonb DEFAULT '{}'::jsonb,
	"sso_config" jsonb,
	"contract_start" timestamp,
	"contract_end" timestamp,
	"billing_contact" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "partners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"type" "partner_type" DEFAULT 'msp' NOT NULL,
	"plan" "plan_type" DEFAULT 'free' NOT NULL,
	"max_organizations" integer,
	"max_devices" integer,
	"settings" jsonb DEFAULT '{}'::jsonb,
	"sso_config" jsonb,
	"billing_email" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "partners_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"address" jsonb,
	"timezone" varchar(50) DEFAULT 'UTC' NOT NULL,
	"contact" jsonb,
	"settings" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"site_ids" uuid[],
	"device_group_ids" uuid[],
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"org_access" "org_access" DEFAULT 'none' NOT NULL,
	"org_ids" uuid[],
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource" varchar(100) NOT NULL,
	"action" varchar(50) NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	"constraints" jsonb
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_id" uuid,
	"org_id" uuid,
	"parent_role_id" uuid,
	"scope" "role_scope" NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"ip_address" varchar(45),
	"user_agent" text,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"password_hash" text,
	"mfa_secret" text,
	"mfa_enabled" boolean DEFAULT false NOT NULL,
	"mfa_recovery_codes" jsonb,
	"phone_number" text,
	"phone_verified" boolean DEFAULT false NOT NULL,
	"mfa_method" "mfa_method",
	"status" "user_status" DEFAULT 'invited' NOT NULL,
	"avatar_url" text,
	"last_login_at" timestamp,
	"password_changed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "device_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"type" varchar(50) NOT NULL,
	"payload" jsonb,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"executed_at" timestamp,
	"completed_at" timestamp,
	"result" jsonb
);
--> statement-breakpoint
CREATE TABLE "device_config_state" (
	"device_id" uuid NOT NULL,
	"file_path" text NOT NULL,
	"config_key" text NOT NULL,
	"config_value" text,
	"collected_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "device_config_state_device_id_file_path_config_key_pk" PRIMARY KEY("device_id","file_path","config_key")
);
--> statement-breakpoint
CREATE TABLE "device_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"protocol" "connection_protocol" NOT NULL,
	"local_addr" varchar(45) NOT NULL,
	"local_port" integer NOT NULL,
	"remote_addr" varchar(45),
	"remote_port" integer,
	"state" varchar(20),
	"pid" integer,
	"process_name" varchar(255),
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_disks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"mount_point" varchar(255) NOT NULL,
	"device" varchar(255),
	"fs_type" varchar(50),
	"total_gb" real NOT NULL,
	"used_gb" real NOT NULL,
	"free_gb" real NOT NULL,
	"used_percent" real NOT NULL,
	"health" varchar(50) DEFAULT 'healthy',
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_group_memberships" (
	"device_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"added_at" timestamp DEFAULT now() NOT NULL,
	"added_by" "membership_source" DEFAULT 'manual' NOT NULL,
	CONSTRAINT "device_group_memberships_device_id_group_id_pk" PRIMARY KEY("device_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "device_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid,
	"name" varchar(255) NOT NULL,
	"type" "device_group_type" DEFAULT 'static' NOT NULL,
	"rules" jsonb,
	"filter_conditions" jsonb,
	"filter_fields_used" text[] DEFAULT '{}',
	"parent_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_hardware" (
	"device_id" uuid PRIMARY KEY NOT NULL,
	"cpu_model" varchar(255),
	"cpu_cores" integer,
	"cpu_threads" integer,
	"ram_total_mb" integer,
	"disk_total_gb" integer,
	"gpu_model" varchar(255),
	"serial_number" varchar(100),
	"manufacturer" varchar(255),
	"model" varchar(255),
	"bios_version" varchar(100),
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_metrics" (
	"device_id" uuid NOT NULL,
	"timestamp" timestamp NOT NULL,
	"cpu_percent" real NOT NULL,
	"ram_percent" real NOT NULL,
	"ram_used_mb" integer NOT NULL,
	"disk_percent" real NOT NULL,
	"disk_used_gb" real NOT NULL,
	"network_in_bytes" bigint,
	"network_out_bytes" bigint,
	"bandwidth_in_bps" bigint,
	"bandwidth_out_bps" bigint,
	"interface_stats" jsonb,
	"process_count" integer,
	"custom_metrics" jsonb,
	CONSTRAINT "device_metrics_device_id_timestamp_pk" PRIMARY KEY("device_id","timestamp")
);
--> statement-breakpoint
CREATE TABLE "device_network" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"interface_name" varchar(100) NOT NULL,
	"mac_address" varchar(17),
	"ip_address" varchar(45),
	"ip_type" varchar(4) DEFAULT 'ipv4' NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"public_ip" varchar(45),
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_registry_state" (
	"device_id" uuid NOT NULL,
	"registry_path" text NOT NULL,
	"value_name" text NOT NULL,
	"value_data" text,
	"value_type" varchar(64),
	"collected_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "device_registry_state_device_id_registry_path_value_name_pk" PRIMARY KEY("device_id","registry_path","value_name")
);
--> statement-breakpoint
CREATE TABLE "device_software" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"name" varchar(500) NOT NULL,
	"version" varchar(100),
	"publisher" varchar(255),
	"install_date" date,
	"install_location" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"agent_id" varchar(64) NOT NULL,
	"agent_token_hash" varchar(64),
	"mtls_cert_serial_number" varchar(128),
	"mtls_cert_expires_at" timestamp,
	"mtls_cert_issued_at" timestamp,
	"mtls_cert_cf_id" varchar(128),
	"quarantined_at" timestamp,
	"quarantined_reason" varchar(255),
	"hostname" varchar(255) NOT NULL,
	"display_name" varchar(255),
	"os_type" "os_type" NOT NULL,
	"os_version" varchar(100) NOT NULL,
	"os_build" varchar(100),
	"architecture" varchar(20) NOT NULL,
	"agent_version" varchar(20) NOT NULL,
	"status" "device_status" DEFAULT 'offline' NOT NULL,
	"last_seen_at" timestamp,
	"enrolled_at" timestamp DEFAULT now() NOT NULL,
	"enrolled_by" uuid,
	"tags" text[] DEFAULT '{}',
	"custom_fields" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "devices_agent_id_unique" UNIQUE("agent_id")
);
--> statement-breakpoint
CREATE TABLE "group_membership_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"action" "group_membership_log_action" NOT NULL,
	"reason" "group_membership_log_reason" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "script_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"name" varchar(100) NOT NULL,
	"description" text,
	"icon" varchar(50),
	"color" varchar(7),
	"parent_id" uuid,
	"order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "script_execution_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"script_id" uuid NOT NULL,
	"triggered_by" uuid,
	"trigger_type" "trigger_type" DEFAULT 'manual' NOT NULL,
	"parameters" jsonb,
	"devices_targeted" integer NOT NULL,
	"devices_completed" integer DEFAULT 0 NOT NULL,
	"devices_failed" integer DEFAULT 0 NOT NULL,
	"status" "execution_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "script_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"script_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"triggered_by" uuid,
	"trigger_type" "trigger_type" DEFAULT 'manual' NOT NULL,
	"parameters" jsonb,
	"status" "execution_status" DEFAULT 'pending' NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"exit_code" integer,
	"stdout" text,
	"stderr" text,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "script_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"name" varchar(50) NOT NULL,
	"color" varchar(7)
);
--> statement-breakpoint
CREATE TABLE "script_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"category" varchar(100),
	"language" "script_language",
	"content" text NOT NULL,
	"parameters" jsonb,
	"is_built_in" boolean DEFAULT false NOT NULL,
	"downloads" integer DEFAULT 0 NOT NULL,
	"rating" numeric(2, 1)
);
--> statement-breakpoint
CREATE TABLE "script_to_tags" (
	"script_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "script_to_tags_script_id_tag_id_pk" PRIMARY KEY("script_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "script_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"script_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"changelog" text,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"name" varchar(255) NOT NULL,
	"description" text,
	"category" varchar(100),
	"os_types" text[] NOT NULL,
	"language" "script_language" NOT NULL,
	"content" text NOT NULL,
	"parameters" jsonb,
	"timeout_seconds" integer DEFAULT 300 NOT NULL,
	"run_as" "script_run_as" DEFAULT 'system' NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_correlations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_alert_id" uuid NOT NULL,
	"child_alert_id" uuid NOT NULL,
	"correlation_type" varchar(50) NOT NULL,
	"confidence" numeric(3, 2),
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alert_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"sent_at" timestamp,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"target_type" varchar(50) NOT NULL,
	"target_id" uuid NOT NULL,
	"override_settings" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"name" varchar(200) NOT NULL,
	"description" text,
	"conditions" jsonb NOT NULL,
	"severity" "alert_severity" NOT NULL,
	"title_template" text NOT NULL,
	"message_template" text NOT NULL,
	"auto_resolve" boolean DEFAULT false NOT NULL,
	"auto_resolve_conditions" jsonb,
	"cooldown_minutes" integer DEFAULT 5 NOT NULL,
	"is_built_in" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"status" "alert_status" DEFAULT 'active' NOT NULL,
	"severity" "alert_severity" NOT NULL,
	"title" varchar(500) NOT NULL,
	"message" text,
	"context" jsonb,
	"triggered_at" timestamp DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp,
	"acknowledged_by" uuid,
	"resolved_at" timestamp,
	"resolved_by" uuid,
	"resolution_note" text,
	"suppressed_until" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "escalation_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"steps" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"type" "notification_channel_type" NOT NULL,
	"config" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid,
	"device_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"direction" "file_transfer_direction" NOT NULL,
	"remote_path" text NOT NULL,
	"local_filename" varchar(500) NOT NULL,
	"size_bytes" bigint NOT NULL,
	"status" "file_transfer_status" DEFAULT 'pending' NOT NULL,
	"progress_percent" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "remote_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "remote_session_type" NOT NULL,
	"status" "remote_session_status" DEFAULT 'pending' NOT NULL,
	"webrtc_offer" text,
	"webrtc_answer" text,
	"ice_candidates" jsonb DEFAULT '[]'::jsonb,
	"started_at" timestamp,
	"ended_at" timestamp,
	"duration_seconds" integer,
	"bytes_transferred" bigint,
	"recording_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" uuid NOT NULL,
	"actor_email" varchar(255),
	"action" varchar(100) NOT NULL,
	"resource_type" varchar(50) NOT NULL,
	"resource_id" uuid,
	"resource_name" varchar(255),
	"details" jsonb,
	"ip_address" varchar(45),
	"user_agent" text,
	"result" "audit_result" NOT NULL,
	"error_message" text,
	"checksum" varchar(128)
);
--> statement-breakpoint
CREATE TABLE "audit_retention_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"retention_days" integer DEFAULT 365 NOT NULL,
	"archive_to_s3" boolean DEFAULT false NOT NULL,
	"last_cleanup_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"status" "report_run_status" DEFAULT 'pending' NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"output_url" text,
	"error_message" text,
	"row_count" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"type" "report_type" NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"schedule" "report_schedule" DEFAULT 'one_time' NOT NULL,
	"format" "report_format" DEFAULT 'csv' NOT NULL,
	"last_generated_at" timestamp,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"key_hash" varchar(255) NOT NULL,
	"key_prefix" varchar(12) NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp,
	"last_used_at" timestamp,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"rate_limit" integer DEFAULT 1000 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"status" "api_key_status" DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sso_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"type" "sso_provider_type" NOT NULL,
	"status" "sso_provider_status" DEFAULT 'inactive' NOT NULL,
	"issuer" varchar(500),
	"client_id" varchar(255),
	"client_secret" text,
	"authorization_url" varchar(500),
	"token_url" varchar(500),
	"userinfo_url" varchar(500),
	"jwks_url" varchar(500),
	"scopes" varchar(500) DEFAULT 'openid profile email',
	"entity_id" varchar(500),
	"sso_url" varchar(500),
	"certificate" text,
	"attribute_mapping" jsonb DEFAULT '{"email":"email","name":"name"}'::jsonb,
	"auto_provision" boolean DEFAULT true NOT NULL,
	"default_role_id" uuid,
	"allowed_domains" varchar(1000),
	"enforce_sso" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sso_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"state" varchar(64) NOT NULL,
	"nonce" varchar(64) NOT NULL,
	"code_verifier" varchar(128),
	"redirect_url" varchar(500),
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sso_sessions_state_unique" UNIQUE("state")
);
--> statement-breakpoint
CREATE TABLE "user_sso_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"external_id" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"profile" jsonb,
	"access_token" text,
	"refresh_token" text,
	"token_expires_at" timestamp,
	"last_login_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "access_review_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"decision" "access_review_decision" DEFAULT 'pending' NOT NULL,
	"notes" text,
	"reviewed_at" timestamp,
	"reviewed_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "access_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_id" uuid,
	"org_id" uuid,
	"name" varchar(255) NOT NULL,
	"description" text,
	"status" "access_review_status" DEFAULT 'pending' NOT NULL,
	"reviewer_id" uuid,
	"due_date" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "device_patches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"patch_id" uuid NOT NULL,
	"status" "device_patch_status" DEFAULT 'pending' NOT NULL,
	"installed_at" timestamp,
	"installed_version" varchar(100),
	"last_checked_at" timestamp,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"rollback_available" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patch_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"patch_id" uuid NOT NULL,
	"policy_id" uuid,
	"status" "patch_approval_status" DEFAULT 'pending' NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp,
	"defer_until" timestamp,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patch_compliance_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"requested_by" uuid,
	"status" "patch_compliance_report_status" DEFAULT 'pending' NOT NULL,
	"format" "patch_compliance_report_format" DEFAULT 'csv' NOT NULL,
	"source" "patch_source",
	"severity" "patch_severity",
	"summary" jsonb,
	"row_count" integer,
	"output_path" text,
	"error_message" text,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patch_compliance_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"snapshot_date" date NOT NULL,
	"total_devices" integer DEFAULT 0 NOT NULL,
	"compliant_devices" integer DEFAULT 0 NOT NULL,
	"non_compliant_devices" integer DEFAULT 0 NOT NULL,
	"critical_missing" integer DEFAULT 0 NOT NULL,
	"important_missing" integer DEFAULT 0 NOT NULL,
	"patches_pending_approval" integer DEFAULT 0 NOT NULL,
	"patches_installed_24h" integer DEFAULT 0 NOT NULL,
	"failed_installs_24h" integer DEFAULT 0 NOT NULL,
	"details_by_category" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patch_job_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"patch_id" uuid NOT NULL,
	"status" "patch_job_result_status" DEFAULT 'pending' NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"exit_code" integer,
	"output" text,
	"error_message" text,
	"reboot_required" boolean DEFAULT false NOT NULL,
	"rebooted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patch_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"policy_id" uuid,
	"name" varchar(255) NOT NULL,
	"patches" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"targets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "patch_job_status" DEFAULT 'scheduled' NOT NULL,
	"scheduled_at" timestamp,
	"started_at" timestamp,
	"completed_at" timestamp,
	"devices_total" integer DEFAULT 0 NOT NULL,
	"devices_completed" integer DEFAULT 0 NOT NULL,
	"devices_failed" integer DEFAULT 0 NOT NULL,
	"devices_pending" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patch_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"targets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sources" "patch_source"[],
	"auto_approve" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"schedule" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reboot_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rollback_on_failure" boolean DEFAULT false NOT NULL,
	"pre_install_script_id" uuid,
	"post_install_script_id" uuid,
	"notify_on_complete" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patch_rollbacks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"patch_id" uuid NOT NULL,
	"original_job_id" uuid,
	"reason" text,
	"status" "patch_rollback_status" DEFAULT 'pending' NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"output" text,
	"error_message" text,
	"initiated_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "patch_source" NOT NULL,
	"external_id" varchar(255) NOT NULL,
	"title" varchar(500) NOT NULL,
	"description" text,
	"severity" "patch_severity",
	"category" varchar(100),
	"os_types" text[],
	"os_versions" text[],
	"architecture" text[],
	"release_date" date,
	"kb_article_url" text,
	"supersedes" text[],
	"superseded_by" text,
	"requires_reboot" boolean DEFAULT false NOT NULL,
	"download_url" text,
	"download_size_mb" integer,
	"install_command" text,
	"uninstall_command" text,
	"detect_script" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_bus_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"event_type" varchar(100) NOT NULL,
	"source" varchar(100) NOT NULL,
	"priority" "event_bus_priority" DEFAULT 'normal' NOT NULL,
	"payload" jsonb NOT NULL,
	"metadata" jsonb,
	"processed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"version" varchar(50) NOT NULL,
	"description" text,
	"author" varchar(255),
	"homepage" text,
	"manifest_url" text,
	"entry_point" text,
	"permissions" jsonb,
	"hooks" jsonb,
	"settings" jsonb,
	"status" "plugin_status" DEFAULT 'active' NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"installed_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"error_message" text,
	"last_active_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "psa_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"provider" "psa_provider" NOT NULL,
	"name" varchar(255) NOT NULL,
	"credentials" jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb,
	"sync_settings" jsonb DEFAULT '{}'::jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_sync_at" timestamp,
	"last_sync_status" varchar(50),
	"last_sync_error" text,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "psa_ticket_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"alert_id" uuid,
	"device_id" uuid,
	"external_ticket_id" varchar(100),
	"external_ticket_url" text,
	"status" varchar(50),
	"last_sync_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"webhook_id" uuid NOT NULL,
	"event_type" varchar(100) NOT NULL,
	"event_id" varchar(100) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "webhook_delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp,
	"response_status" integer,
	"response_body" text,
	"response_time_ms" integer,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"delivered_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"url" text NOT NULL,
	"secret" text,
	"events" text[] DEFAULT '{}' NOT NULL,
	"headers" jsonb,
	"status" "webhook_status" DEFAULT 'active' NOT NULL,
	"retry_policy" jsonb,
	"success_count" integer DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_delivery_at" timestamp,
	"last_success_at" timestamp,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_checkouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"checked_out_to" uuid,
	"checked_out_to_name" varchar(255),
	"checked_out_at" timestamp DEFAULT now() NOT NULL,
	"expected_return_at" timestamp,
	"checked_in_at" timestamp,
	"checked_in_by" uuid,
	"checkout_notes" text,
	"checkin_notes" text,
	"condition" varchar(100),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_branding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"logo_url" text,
	"favicon_url" text,
	"primary_color" varchar(50),
	"secondary_color" varchar(50),
	"accent_color" varchar(50),
	"custom_domain" varchar(255),
	"domain_verified" boolean DEFAULT false NOT NULL,
	"welcome_message" text,
	"support_email" varchar(255),
	"support_phone" varchar(50),
	"footer_text" text,
	"custom_css" text,
	"enable_tickets" boolean DEFAULT true NOT NULL,
	"enable_asset_checkout" boolean DEFAULT true NOT NULL,
	"enable_self_service" boolean DEFAULT true NOT NULL,
	"enable_password_reset" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "portal_branding_org_id_unique" UNIQUE("org_id")
);
--> statement-breakpoint
CREATE TABLE "portal_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"email" varchar(255) NOT NULL,
	"name" varchar(255),
	"password_hash" text,
	"linked_user_id" uuid,
	"receive_notifications" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"portal_user_id" uuid,
	"user_id" uuid,
	"author_name" varchar(255),
	"author_type" varchar(50),
	"content" text NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"ticket_number" varchar(50) NOT NULL,
	"submitted_by" uuid,
	"submitter_email" varchar(255),
	"submitter_name" varchar(255),
	"subject" varchar(255) NOT NULL,
	"description" text,
	"category" varchar(100),
	"status" "ticket_status" DEFAULT 'new' NOT NULL,
	"priority" "ticket_priority" DEFAULT 'normal' NOT NULL,
	"assigned_to" uuid,
	"assigned_team" uuid,
	"device_id" uuid,
	"tags" text[] DEFAULT '{}',
	"custom_fields" jsonb,
	"external_ticket_id" varchar(255),
	"external_ticket_url" text,
	"first_response_at" timestamp,
	"resolved_at" timestamp,
	"closed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tickets_ticket_number_unique" UNIQUE("ticket_number")
);
--> statement-breakpoint
CREATE TABLE "analytics_dashboards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"layout" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capacity_predictions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"device_id" uuid,
	"metric_type" varchar(100) NOT NULL,
	"metric_name" varchar(255) NOT NULL,
	"current_value" double precision NOT NULL,
	"predicted_value" double precision NOT NULL,
	"prediction_date" timestamp NOT NULL,
	"confidence" double precision,
	"growth_rate" double precision,
	"days_to_threshold" integer,
	"threshold_type" varchar(50),
	"model_type" varchar(100),
	"training_data_days" integer,
	"calculated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capacity_thresholds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"metric_type" varchar(100) NOT NULL,
	"metric_name" varchar(255) NOT NULL,
	"warning_threshold" double precision,
	"critical_threshold" double precision,
	"prediction_window" integer,
	"growth_rate_threshold" double precision,
	"target_type" varchar(50),
	"target_ids" uuid[],
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dashboard_widgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dashboard_id" uuid NOT NULL,
	"widget_type" varchar(100) NOT NULL,
	"title" varchar(255) NOT NULL,
	"data_source" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"chart_type" varchar(100),
	"visualization" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"refresh_interval" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "executive_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"period_type" varchar(50) NOT NULL,
	"period_start" timestamp NOT NULL,
	"period_end" timestamp NOT NULL,
	"device_stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"alert_stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"patch_stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sla_stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"trends" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"highlights" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"generated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_queries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"metric_types" text[] DEFAULT '{}',
	"metric_names" text[] DEFAULT '{}',
	"aggregation" varchar(50),
	"group_by" text[] DEFAULT '{}',
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"time_range" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_shared" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sla_compliance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sla_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"period_start" timestamp NOT NULL,
	"period_end" timestamp NOT NULL,
	"uptime_actual" double precision,
	"response_time_actual" double precision,
	"resolution_time_actual" double precision,
	"uptime_compliant" boolean,
	"response_time_compliant" boolean,
	"resolution_time_compliant" boolean,
	"overall_compliant" boolean,
	"total_downtime_minutes" integer,
	"incident_count" integer,
	"excluded_minutes" integer,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"calculated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sla_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"uptime_target" double precision,
	"response_time_target" double precision,
	"resolution_time_target" double precision,
	"measurement_window" varchar(50),
	"exclude_maintenance_windows" boolean DEFAULT false NOT NULL,
	"exclude_weekends" boolean DEFAULT false NOT NULL,
	"target_type" varchar(50),
	"target_ids" uuid[],
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "time_series_metrics" (
	"timestamp" timestamp NOT NULL,
	"org_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"metric_type" varchar(100) NOT NULL,
	"metric_name" varchar(255) NOT NULL,
	"value" double precision NOT NULL,
	"unit" varchar(50),
	"tags" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(100) NOT NULL,
	"name" varchar(255) NOT NULL,
	"version" varchar(50) NOT NULL,
	"description" text,
	"type" "plugin_type" NOT NULL,
	"author" varchar(255),
	"author_url" text,
	"homepage" text,
	"repository" text,
	"license" varchar(100),
	"manifest_url" text,
	"download_url" text,
	"checksum" varchar(128),
	"min_agent_version" varchar(50),
	"min_api_version" varchar(50),
	"dependencies" jsonb,
	"permissions" jsonb,
	"hooks" jsonb,
	"icon_url" text,
	"screenshot_urls" text[] DEFAULT '{}',
	"category" varchar(100),
	"tags" text[] DEFAULT '{}',
	"install_count" integer DEFAULT 0 NOT NULL,
	"rating" real DEFAULT 0 NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL,
	"is_featured" boolean DEFAULT false NOT NULL,
	"is_deprecated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_catalog_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "plugin_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"catalog_id" uuid NOT NULL,
	"version" varchar(50) NOT NULL,
	"status" "plugin_install_status" DEFAULT 'installed' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"permissions" jsonb,
	"sandbox_enabled" boolean DEFAULT true NOT NULL,
	"resource_limits" jsonb,
	"installed_at" timestamp,
	"installed_by" uuid,
	"last_active_at" timestamp,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"level" varchar(20) NOT NULL,
	"message" text NOT NULL,
	"context" jsonb,
	"timestamp" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovered_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"ip_address" "inet" NOT NULL,
	"mac_address" varchar(17),
	"hostname" varchar(255),
	"netbios_name" varchar(255),
	"asset_type" "discovered_asset_type" DEFAULT 'unknown' NOT NULL,
	"status" "discovered_asset_status" DEFAULT 'new' NOT NULL,
	"manufacturer" varchar(255),
	"model" varchar(255),
	"open_ports" jsonb,
	"os_fingerprint" jsonb,
	"snmp_data" jsonb,
	"response_time_ms" real,
	"linked_device_id" uuid,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp,
	"last_job_id" uuid,
	"discovery_methods" "discovery_method"[] DEFAULT '{}',
	"notes" text,
	"tags" text[] DEFAULT '{}',
	"ignored_by" uuid,
	"ignored_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"agent_id" varchar(64),
	"status" "discovery_job_status" DEFAULT 'scheduled' NOT NULL,
	"scheduled_at" timestamp,
	"started_at" timestamp,
	"completed_at" timestamp,
	"hosts_scanned" integer,
	"hosts_discovered" integer,
	"new_assets" integer,
	"errors" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"subnets" text[] DEFAULT '{}' NOT NULL,
	"exclude_ips" text[] DEFAULT '{}' NOT NULL,
	"methods" "discovery_method"[] DEFAULT '{}' NOT NULL,
	"port_ranges" jsonb,
	"snmp_communities" text[] DEFAULT '{}',
	"snmp_credentials" jsonb,
	"schedule" jsonb,
	"deep_scan" boolean DEFAULT false NOT NULL,
	"identify_os" boolean DEFAULT false NOT NULL,
	"resolve_hostnames" boolean DEFAULT false NOT NULL,
	"timeout" integer,
	"concurrency" integer,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "network_topology" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"source_type" varchar(50) NOT NULL,
	"source_id" uuid NOT NULL,
	"target_type" varchar(50) NOT NULL,
	"target_id" uuid NOT NULL,
	"connection_type" varchar(50) NOT NULL,
	"interface_name" varchar(100),
	"vlan" integer,
	"bandwidth" integer,
	"latency" real,
	"last_verified_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mobile_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" varchar(255) NOT NULL,
	"platform" "device_platform" NOT NULL,
	"model" varchar(255),
	"os_version" varchar(100),
	"app_version" varchar(50),
	"fcm_token" text,
	"apns_token" text,
	"notifications_enabled" boolean DEFAULT true NOT NULL,
	"alert_severities" "alert_severity"[] DEFAULT '{}' NOT NULL,
	"quiet_hours" jsonb,
	"last_active_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mobile_devices_device_id_unique" UNIQUE("device_id")
);
--> statement-breakpoint
CREATE TABLE "mobile_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"mobile_device_id" uuid NOT NULL,
	"refresh_token" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"last_used_at" timestamp,
	"ip_address" varchar(45),
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mobile_device_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"title" varchar(255) NOT NULL,
	"body" text,
	"data" jsonb,
	"platform" "device_platform" NOT NULL,
	"message_id" varchar(255),
	"status" varchar(50),
	"sent_at" timestamp,
	"delivered_at" timestamp,
	"read_at" timestamp,
	"error_message" text,
	"alert_id" uuid,
	"event_type" varchar(100),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"window_id" uuid NOT NULL,
	"start_time" timestamp NOT NULL,
	"end_time" timestamp NOT NULL,
	"status" "maintenance_window_status" DEFAULT 'scheduled' NOT NULL,
	"overrides" jsonb,
	"actual_start_time" timestamp,
	"actual_end_time" timestamp,
	"suppressed_alerts" boolean DEFAULT false NOT NULL,
	"suppressed_patches" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"start_time" timestamp NOT NULL,
	"end_time" timestamp NOT NULL,
	"timezone" varchar(50) DEFAULT 'UTC' NOT NULL,
	"recurrence" "maintenance_recurrence" DEFAULT 'once' NOT NULL,
	"recurrence_rule" jsonb,
	"target_type" varchar(50) NOT NULL,
	"site_ids" uuid[],
	"group_ids" uuid[],
	"device_ids" uuid[],
	"suppress_alerts" boolean DEFAULT false NOT NULL,
	"suppress_patching" boolean DEFAULT false NOT NULL,
	"suppress_automations" boolean DEFAULT false NOT NULL,
	"suppress_scripts" boolean DEFAULT false NOT NULL,
	"allowed_alert_severities" "alert_severity"[],
	"allowed_actions" jsonb,
	"status" "maintenance_window_status" DEFAULT 'scheduled' NOT NULL,
	"notify_before" integer,
	"notify_on_start" boolean DEFAULT false NOT NULL,
	"notify_on_end" boolean DEFAULT false NOT NULL,
	"notification_channels" jsonb,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_posture_org_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"captured_at" timestamp DEFAULT now() NOT NULL,
	"overall_score" integer NOT NULL,
	"devices_audited" integer DEFAULT 0 NOT NULL,
	"low_risk_devices" integer DEFAULT 0 NOT NULL,
	"medium_risk_devices" integer DEFAULT 0 NOT NULL,
	"high_risk_devices" integer DEFAULT 0 NOT NULL,
	"critical_risk_devices" integer DEFAULT 0 NOT NULL,
	"patch_compliance_score" integer NOT NULL,
	"encryption_score" integer NOT NULL,
	"av_health_score" integer NOT NULL,
	"firewall_score" integer NOT NULL,
	"open_ports_score" integer NOT NULL,
	"password_policy_score" integer NOT NULL,
	"os_currency_score" integer NOT NULL,
	"admin_exposure_score" integer NOT NULL,
	"top_issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_posture_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"captured_at" timestamp DEFAULT now() NOT NULL,
	"overall_score" integer NOT NULL,
	"risk_level" "security_risk_level" NOT NULL,
	"patch_compliance_score" integer NOT NULL,
	"encryption_score" integer NOT NULL,
	"av_health_score" integer NOT NULL,
	"firewall_score" integer NOT NULL,
	"open_ports_score" integer NOT NULL,
	"password_policy_score" integer NOT NULL,
	"os_currency_score" integer NOT NULL,
	"admin_exposure_score" integer NOT NULL,
	"factor_details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recommendations" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"scan_type" varchar(50) NOT NULL,
	"status" varchar(20) NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"items_scanned" integer,
	"threats_found" integer,
	"duration" integer,
	"initiated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "security_status" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"provider" "security_provider" NOT NULL,
	"provider_version" varchar(50),
	"definitions_version" varchar(100),
	"definitions_date" timestamp,
	"real_time_protection" boolean,
	"last_scan" timestamp,
	"last_scan_type" varchar(50),
	"threat_count" integer DEFAULT 0 NOT NULL,
	"firewall_enabled" boolean,
	"encryption_status" varchar(50),
	"encryption_details" jsonb,
	"local_admin_summary" jsonb,
	"password_policy_summary" jsonb,
	"gatekeeper_enabled" boolean,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_threats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"provider" "security_provider" NOT NULL,
	"threat_name" varchar(200) NOT NULL,
	"threat_type" varchar(100),
	"severity" "threat_severity" NOT NULL,
	"status" "threat_status" NOT NULL,
	"file_path" text,
	"process_name" varchar(200),
	"detected_at" timestamp NOT NULL,
	"resolved_at" timestamp,
	"resolved_by" varchar(100),
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE "deployment_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"status" "deployment_status" DEFAULT 'pending' NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"exit_code" integer,
	"output" text,
	"error_message" text,
	"retry_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "software_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	"vendor" varchar(200),
	"description" text,
	"category" varchar(100),
	"icon_url" text,
	"website_url" text,
	"is_managed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "software_deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"software_version_id" uuid NOT NULL,
	"deployment_type" varchar(20) NOT NULL,
	"target_type" varchar(50) NOT NULL,
	"target_ids" jsonb,
	"schedule_type" varchar(30) NOT NULL,
	"scheduled_at" timestamp,
	"maintenance_window_id" uuid,
	"options" jsonb,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "software_inventory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"catalog_id" uuid,
	"name" varchar(500) NOT NULL,
	"version" varchar(100),
	"vendor" varchar(200),
	"install_date" date,
	"install_location" text,
	"uninstall_string" text,
	"is_managed" boolean DEFAULT false NOT NULL,
	"last_seen" timestamp
);
--> statement-breakpoint
CREATE TABLE "software_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"catalog_id" uuid NOT NULL,
	"version" varchar(100) NOT NULL,
	"release_date" timestamp,
	"release_notes" text,
	"download_url" text,
	"checksum" varchar(128),
	"file_size" bigint,
	"supported_os" jsonb,
	"architecture" varchar(20),
	"silent_install_args" text,
	"silent_uninstall_args" text,
	"pre_install_script" text,
	"post_install_script" text,
	"is_latest" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployment_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"batch_number" integer,
	"status" "deployment_device_status" DEFAULT 'pending' NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"max_retries" integer DEFAULT 3 NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"result" jsonb
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"type" varchar(50) NOT NULL,
	"payload" jsonb NOT NULL,
	"target_type" varchar(20) NOT NULL,
	"target_config" jsonb NOT NULL,
	"schedule" jsonb,
	"rollout_config" jsonb NOT NULL,
	"status" "deployment_status" DEFAULT 'draft' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "backup_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"type" "backup_type" NOT NULL,
	"provider" "backup_provider" NOT NULL,
	"provider_config" jsonb NOT NULL,
	"schedule" jsonb,
	"retention" jsonb,
	"compression" boolean DEFAULT true NOT NULL,
	"encryption" boolean DEFAULT true NOT NULL,
	"encryption_key" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"config_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"status" "backup_status" DEFAULT 'pending' NOT NULL,
	"type" "backup_job_type" DEFAULT 'scheduled' NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"total_size" bigint,
	"transferred_size" bigint,
	"file_count" integer,
	"error_count" integer,
	"error_log" text,
	"snapshot_id" varchar(200)
);
--> statement-breakpoint
CREATE TABLE "backup_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"config_id" uuid NOT NULL,
	"target_type" varchar(50) NOT NULL,
	"target_id" uuid NOT NULL,
	"includes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"excludes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"priority" integer DEFAULT 50 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"snapshot_id" varchar(200) NOT NULL,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"size" bigint,
	"file_count" integer,
	"is_incremental" boolean DEFAULT false NOT NULL,
	"parent_snapshot_id" uuid,
	"expires_at" timestamp,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "restore_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"restore_type" "restore_type" NOT NULL,
	"target_path" text,
	"selected_paths" jsonb DEFAULT '[]'::jsonb,
	"status" "backup_status" DEFAULT 'pending' NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"restored_size" bigint,
	"restored_files" integer,
	"initiated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "snmp_alert_thresholds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"oid" varchar(200) NOT NULL,
	"operator" varchar(10),
	"threshold" varchar(100),
	"severity" "alert_severity" NOT NULL,
	"message" text,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snmp_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"asset_id" uuid,
	"name" varchar(200) NOT NULL,
	"ip_address" varchar(45) NOT NULL,
	"snmp_version" varchar(10) NOT NULL,
	"port" integer DEFAULT 161 NOT NULL,
	"community" varchar(100),
	"auth_protocol" varchar(20),
	"auth_password" text,
	"priv_protocol" varchar(20),
	"priv_password" text,
	"username" varchar(100),
	"polling_interval" integer DEFAULT 300 NOT NULL,
	"template_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_polled" timestamp,
	"last_status" varchar(20),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snmp_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"oid" varchar(200) NOT NULL,
	"name" varchar(100) NOT NULL,
	"value" text,
	"value_type" varchar(20),
	"timestamp" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snmp_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"vendor" varchar(100),
	"device_type" varchar(100),
	"oids" jsonb NOT NULL,
	"is_built_in" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid,
	"type" "notification_type" NOT NULL,
	"priority" "notification_priority" DEFAULT 'normal' NOT NULL,
	"title" varchar(255) NOT NULL,
	"message" text,
	"link" varchar(500),
	"metadata" jsonb,
	"read" boolean DEFAULT false NOT NULL,
	"read_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"type" "policy_type" NOT NULL,
	"status" "policy_status" DEFAULT 'draft' NOT NULL,
	"priority" integer DEFAULT 50 NOT NULL,
	"settings" jsonb NOT NULL,
	"conditions" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"parent_id" uuid,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" uuid NOT NULL,
	"target_type" varchar(50) NOT NULL,
	"target_id" uuid NOT NULL,
	"priority" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_compliance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"last_checked" timestamp,
	"details" jsonb,
	"remediation_attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"type" "policy_type" NOT NULL,
	"category" varchar(100),
	"settings" jsonb NOT NULL,
	"is_built_in" boolean DEFAULT false NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"settings" jsonb NOT NULL,
	"conditions" jsonb,
	"changelog" text,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"targets" jsonb NOT NULL,
	"rules" jsonb NOT NULL,
	"enforcement" "policy_enforcement" DEFAULT 'monitor' NOT NULL,
	"check_interval_minutes" integer DEFAULT 60 NOT NULL,
	"remediation_script_id" uuid,
	"last_evaluated_at" timestamp,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_policy_compliance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"status" "compliance_status" DEFAULT 'pending' NOT NULL,
	"details" jsonb,
	"last_checked_at" timestamp,
	"remediation_attempts" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"triggered_by" varchar(255) NOT NULL,
	"status" "automation_run_status" DEFAULT 'running' NOT NULL,
	"devices_targeted" integer DEFAULT 0 NOT NULL,
	"devices_succeeded" integer DEFAULT 0 NOT NULL,
	"devices_failed" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"logs" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"trigger" jsonb NOT NULL,
	"conditions" jsonb,
	"actions" jsonb NOT NULL,
	"on_failure" "automation_on_failure" DEFAULT 'stop' NOT NULL,
	"notification_targets" jsonb,
	"last_run_at" timestamp,
	"run_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_filters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"conditions" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_field_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"partner_id" uuid,
	"name" varchar(100) NOT NULL,
	"field_key" varchar(100) NOT NULL,
	"type" "custom_field_type" NOT NULL,
	"options" jsonb,
	"required" boolean DEFAULT false NOT NULL,
	"default_value" jsonb,
	"device_types" text[],
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" varchar(20) NOT NULL,
	"platform" varchar(20) NOT NULL,
	"architecture" varchar(20) NOT NULL,
	"download_url" text NOT NULL,
	"checksum" varchar(64) NOT NULL,
	"file_size" bigint,
	"release_notes" text,
	"is_latest" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_versions_version_platform_arch_unique" UNIQUE("version","platform","architecture")
);
--> statement-breakpoint
CREATE TABLE "device_event_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"timestamp" timestamp NOT NULL,
	"level" "event_log_level" NOT NULL,
	"category" "event_log_category" NOT NULL,
	"source" varchar(255) NOT NULL,
	"event_id" varchar(100),
	"message" text NOT NULL,
	"details" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"monthly_budget_cents" integer,
	"daily_budget_cents" integer,
	"max_turns_per_session" integer DEFAULT 50 NOT NULL,
	"allowed_models" jsonb DEFAULT '["claude-sonnet-4-5-20250929"]'::jsonb,
	"messages_per_minute_per_user" integer DEFAULT 20 NOT NULL,
	"messages_per_hour_per_org" integer DEFAULT 200 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ai_budgets_org_id_unique" UNIQUE("org_id")
);
--> statement-breakpoint
CREATE TABLE "ai_cost_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"period" varchar(10) NOT NULL,
	"period_key" varchar(10) NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"total_cost_cents" real DEFAULT 0 NOT NULL,
	"session_count" integer DEFAULT 0 NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"tool_execution_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"role" "ai_message_role" NOT NULL,
	"content" text,
	"content_blocks" jsonb,
	"tool_name" varchar(100),
	"tool_input" jsonb,
	"tool_output" jsonb,
	"tool_use_id" varchar(100),
	"input_tokens" integer,
	"output_tokens" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "ai_session_status" DEFAULT 'active' NOT NULL,
	"title" varchar(255),
	"model" varchar(100) DEFAULT 'claude-sonnet-4-5-20250929' NOT NULL,
	"system_prompt" text,
	"context_snapshot" jsonb,
	"total_input_tokens" integer DEFAULT 0 NOT NULL,
	"total_output_tokens" integer DEFAULT 0 NOT NULL,
	"total_cost_cents" real DEFAULT 0 NOT NULL,
	"turn_count" integer DEFAULT 0 NOT NULL,
	"max_turns" integer DEFAULT 50 NOT NULL,
	"sdk_session_id" varchar(255),
	"last_activity_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_tool_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"message_id" uuid,
	"tool_name" varchar(100) NOT NULL,
	"tool_input" jsonb NOT NULL,
	"tool_output" jsonb,
	"status" "ai_tool_status" DEFAULT 'pending' NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp,
	"command_id" uuid,
	"duration_ms" integer,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "network_monitor_alert_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"monitor_id" uuid NOT NULL,
	"condition" varchar(50) NOT NULL,
	"threshold" varchar(100),
	"severity" "alert_severity" NOT NULL,
	"message" text,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "network_monitor_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"monitor_id" uuid NOT NULL,
	"status" "monitor_status" NOT NULL,
	"response_ms" real,
	"status_code" integer,
	"error" text,
	"details" jsonb,
	"timestamp" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "network_monitors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"asset_id" uuid,
	"name" varchar(200) NOT NULL,
	"monitor_type" "monitor_type" NOT NULL,
	"target" varchar(500) NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"polling_interval" integer DEFAULT 60 NOT NULL,
	"timeout" integer DEFAULT 5 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_checked" timestamp,
	"last_status" "monitor_status" DEFAULT 'unknown' NOT NULL,
	"last_response_ms" real,
	"last_error" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_filesystem_cleanup_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"requested_by" uuid,
	"requested_at" timestamp DEFAULT now() NOT NULL,
	"approved_at" timestamp,
	"plan" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"executed_actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bytes_reclaimed" bigint DEFAULT 0 NOT NULL,
	"status" "filesystem_cleanup_run_status" DEFAULT 'previewed' NOT NULL,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_filesystem_scan_state" (
	"device_id" uuid PRIMARY KEY NOT NULL,
	"last_run_mode" text DEFAULT 'baseline' NOT NULL,
	"last_baseline_completed_at" timestamp,
	"last_disk_used_percent" real,
	"checkpoint" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"aggregate" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"hot_directories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_filesystem_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"captured_at" timestamp DEFAULT now() NOT NULL,
	"trigger" "filesystem_snapshot_trigger" DEFAULT 'on_demand' NOT NULL,
	"partial" boolean DEFAULT false NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"largest_files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"largest_dirs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"temp_accumulation" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"old_downloads" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"unrotated_logs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"trash_usage" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"duplicate_candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cleanup_candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"username" varchar(255) NOT NULL,
	"session_type" "device_session_type" DEFAULT 'console' NOT NULL,
	"os_session_id" varchar(128),
	"login_at" timestamp DEFAULT now() NOT NULL,
	"logout_at" timestamp,
	"duration_seconds" integer,
	"idle_minutes" integer,
	"activity_state" "device_session_activity_state",
	"login_performance_seconds" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_activity_at" timestamp,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "enrollment_keys" ADD CONSTRAINT "enrollment_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_keys" ADD CONSTRAINT "enrollment_keys_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_users" ADD CONSTRAINT "organization_users_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_users" ADD CONSTRAINT "organization_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_users" ADD CONSTRAINT "organization_users_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_users" ADD CONSTRAINT "partner_users_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_users" ADD CONSTRAINT "partner_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_users" ADD CONSTRAINT "partner_users_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_config_state" ADD CONSTRAINT "device_config_state_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_connections" ADD CONSTRAINT "device_connections_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_disks" ADD CONSTRAINT "device_disks_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_group_memberships" ADD CONSTRAINT "device_group_memberships_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_group_memberships" ADD CONSTRAINT "device_group_memberships_group_id_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."device_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_groups" ADD CONSTRAINT "device_groups_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_groups" ADD CONSTRAINT "device_groups_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_hardware" ADD CONSTRAINT "device_hardware_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_metrics" ADD CONSTRAINT "device_metrics_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_network" ADD CONSTRAINT "device_network_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_registry_state" ADD CONSTRAINT "device_registry_state_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_software" ADD CONSTRAINT "device_software_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_enrolled_by_users_id_fk" FOREIGN KEY ("enrolled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_membership_log" ADD CONSTRAINT "group_membership_log_group_id_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."device_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_membership_log" ADD CONSTRAINT "group_membership_log_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_categories" ADD CONSTRAINT "script_categories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_categories" ADD CONSTRAINT "script_categories_parent_id_script_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."script_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_execution_batches" ADD CONSTRAINT "script_execution_batches_script_id_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."scripts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_execution_batches" ADD CONSTRAINT "script_execution_batches_triggered_by_users_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_executions" ADD CONSTRAINT "script_executions_script_id_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."scripts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_executions" ADD CONSTRAINT "script_executions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_executions" ADD CONSTRAINT "script_executions_triggered_by_users_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_tags" ADD CONSTRAINT "script_tags_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_to_tags" ADD CONSTRAINT "script_to_tags_script_id_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."scripts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_to_tags" ADD CONSTRAINT "script_to_tags_tag_id_script_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."script_tags"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_versions" ADD CONSTRAINT "script_versions_script_id_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."scripts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_versions" ADD CONSTRAINT "script_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_correlations" ADD CONSTRAINT "alert_correlations_parent_alert_id_alerts_id_fk" FOREIGN KEY ("parent_alert_id") REFERENCES "public"."alerts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_correlations" ADD CONSTRAINT "alert_correlations_child_alert_id_alerts_id_fk" FOREIGN KEY ("child_alert_id") REFERENCES "public"."alerts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_notifications" ADD CONSTRAINT "alert_notifications_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_notifications" ADD CONSTRAINT "alert_notifications_channel_id_notification_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."notification_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_template_id_alert_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."alert_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_templates" ADD CONSTRAINT "alert_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_rule_id_alert_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."alert_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalation_policies" ADD CONSTRAINT "escalation_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_transfers" ADD CONSTRAINT "file_transfers_session_id_remote_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."remote_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_transfers" ADD CONSTRAINT "file_transfers_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_transfers" ADD CONSTRAINT "file_transfers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_sessions" ADD CONSTRAINT "remote_sessions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_sessions" ADD CONSTRAINT "remote_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_retention_policies" ADD CONSTRAINT "audit_retention_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_providers" ADD CONSTRAINT "sso_providers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_providers" ADD CONSTRAINT "sso_providers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_sessions" ADD CONSTRAINT "sso_sessions_provider_id_sso_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."sso_providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sso_identities" ADD CONSTRAINT "user_sso_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sso_identities" ADD CONSTRAINT "user_sso_identities_provider_id_sso_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."sso_providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_review_items" ADD CONSTRAINT "access_review_items_review_id_access_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."access_reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_review_items" ADD CONSTRAINT "access_review_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_review_items" ADD CONSTRAINT "access_review_items_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_review_items" ADD CONSTRAINT "access_review_items_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_reviews" ADD CONSTRAINT "access_reviews_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_reviews" ADD CONSTRAINT "access_reviews_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_reviews" ADD CONSTRAINT "access_reviews_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_patches" ADD CONSTRAINT "device_patches_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_patches" ADD CONSTRAINT "device_patches_patch_id_patches_id_fk" FOREIGN KEY ("patch_id") REFERENCES "public"."patches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_approvals" ADD CONSTRAINT "patch_approvals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_approvals" ADD CONSTRAINT "patch_approvals_patch_id_patches_id_fk" FOREIGN KEY ("patch_id") REFERENCES "public"."patches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_approvals" ADD CONSTRAINT "patch_approvals_policy_id_patch_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."patch_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_approvals" ADD CONSTRAINT "patch_approvals_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_compliance_reports" ADD CONSTRAINT "patch_compliance_reports_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_compliance_reports" ADD CONSTRAINT "patch_compliance_reports_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_compliance_snapshots" ADD CONSTRAINT "patch_compliance_snapshots_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_job_results" ADD CONSTRAINT "patch_job_results_job_id_patch_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."patch_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_job_results" ADD CONSTRAINT "patch_job_results_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_job_results" ADD CONSTRAINT "patch_job_results_patch_id_patches_id_fk" FOREIGN KEY ("patch_id") REFERENCES "public"."patches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_jobs" ADD CONSTRAINT "patch_jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_jobs" ADD CONSTRAINT "patch_jobs_policy_id_patch_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."patch_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_jobs" ADD CONSTRAINT "patch_jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_policies" ADD CONSTRAINT "patch_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_policies" ADD CONSTRAINT "patch_policies_pre_install_script_id_scripts_id_fk" FOREIGN KEY ("pre_install_script_id") REFERENCES "public"."scripts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_policies" ADD CONSTRAINT "patch_policies_post_install_script_id_scripts_id_fk" FOREIGN KEY ("post_install_script_id") REFERENCES "public"."scripts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_policies" ADD CONSTRAINT "patch_policies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_rollbacks" ADD CONSTRAINT "patch_rollbacks_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_rollbacks" ADD CONSTRAINT "patch_rollbacks_patch_id_patches_id_fk" FOREIGN KEY ("patch_id") REFERENCES "public"."patches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_rollbacks" ADD CONSTRAINT "patch_rollbacks_original_job_id_patch_jobs_id_fk" FOREIGN KEY ("original_job_id") REFERENCES "public"."patch_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_rollbacks" ADD CONSTRAINT "patch_rollbacks_initiated_by_users_id_fk" FOREIGN KEY ("initiated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_bus_events" ADD CONSTRAINT "event_bus_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_instances" ADD CONSTRAINT "plugin_instances_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_instances" ADD CONSTRAINT "plugin_instances_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugins" ADD CONSTRAINT "plugins_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "psa_connections" ADD CONSTRAINT "psa_connections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "psa_connections" ADD CONSTRAINT "psa_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "psa_ticket_mappings" ADD CONSTRAINT "psa_ticket_mappings_connection_id_psa_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."psa_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "psa_ticket_mappings" ADD CONSTRAINT "psa_ticket_mappings_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "psa_ticket_mappings" ADD CONSTRAINT "psa_ticket_mappings_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_checkouts" ADD CONSTRAINT "asset_checkouts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_checkouts" ADD CONSTRAINT "asset_checkouts_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_checkouts" ADD CONSTRAINT "asset_checkouts_checked_out_to_portal_users_id_fk" FOREIGN KEY ("checked_out_to") REFERENCES "public"."portal_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_checkouts" ADD CONSTRAINT "asset_checkouts_checked_in_by_users_id_fk" FOREIGN KEY ("checked_in_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_branding" ADD CONSTRAINT "portal_branding_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_users" ADD CONSTRAINT "portal_users_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_users" ADD CONSTRAINT "portal_users_linked_user_id_users_id_fk" FOREIGN KEY ("linked_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_portal_user_id_portal_users_id_fk" FOREIGN KEY ("portal_user_id") REFERENCES "public"."portal_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_submitted_by_portal_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."portal_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_dashboards" ADD CONSTRAINT "analytics_dashboards_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_dashboards" ADD CONSTRAINT "analytics_dashboards_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capacity_predictions" ADD CONSTRAINT "capacity_predictions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capacity_predictions" ADD CONSTRAINT "capacity_predictions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capacity_thresholds" ADD CONSTRAINT "capacity_thresholds_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_dashboard_id_analytics_dashboards_id_fk" FOREIGN KEY ("dashboard_id") REFERENCES "public"."analytics_dashboards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executive_summaries" ADD CONSTRAINT "executive_summaries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_queries" ADD CONSTRAINT "saved_queries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_queries" ADD CONSTRAINT "saved_queries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_compliance" ADD CONSTRAINT "sla_compliance_sla_id_sla_definitions_id_fk" FOREIGN KEY ("sla_id") REFERENCES "public"."sla_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_compliance" ADD CONSTRAINT "sla_compliance_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_definitions" ADD CONSTRAINT "sla_definitions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_series_metrics" ADD CONSTRAINT "time_series_metrics_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_series_metrics" ADD CONSTRAINT "time_series_metrics_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_installations" ADD CONSTRAINT "plugin_installations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_installations" ADD CONSTRAINT "plugin_installations_catalog_id_plugin_catalog_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."plugin_catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_installations" ADD CONSTRAINT "plugin_installations_installed_by_users_id_fk" FOREIGN KEY ("installed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_logs" ADD CONSTRAINT "plugin_logs_installation_id_plugin_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."plugin_installations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovered_assets" ADD CONSTRAINT "discovered_assets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovered_assets" ADD CONSTRAINT "discovered_assets_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovered_assets" ADD CONSTRAINT "discovered_assets_linked_device_id_devices_id_fk" FOREIGN KEY ("linked_device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovered_assets" ADD CONSTRAINT "discovered_assets_last_job_id_discovery_jobs_id_fk" FOREIGN KEY ("last_job_id") REFERENCES "public"."discovery_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovered_assets" ADD CONSTRAINT "discovered_assets_ignored_by_users_id_fk" FOREIGN KEY ("ignored_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_jobs" ADD CONSTRAINT "discovery_jobs_profile_id_discovery_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."discovery_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_jobs" ADD CONSTRAINT "discovery_jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_jobs" ADD CONSTRAINT "discovery_jobs_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_profiles" ADD CONSTRAINT "discovery_profiles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_profiles" ADD CONSTRAINT "discovery_profiles_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_profiles" ADD CONSTRAINT "discovery_profiles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_topology" ADD CONSTRAINT "network_topology_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_topology" ADD CONSTRAINT "network_topology_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mobile_devices" ADD CONSTRAINT "mobile_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mobile_sessions" ADD CONSTRAINT "mobile_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mobile_sessions" ADD CONSTRAINT "mobile_sessions_mobile_device_id_mobile_devices_id_fk" FOREIGN KEY ("mobile_device_id") REFERENCES "public"."mobile_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_notifications" ADD CONSTRAINT "push_notifications_mobile_device_id_mobile_devices_id_fk" FOREIGN KEY ("mobile_device_id") REFERENCES "public"."mobile_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_notifications" ADD CONSTRAINT "push_notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_occurrences" ADD CONSTRAINT "maintenance_occurrences_window_id_maintenance_windows_id_fk" FOREIGN KEY ("window_id") REFERENCES "public"."maintenance_windows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_windows" ADD CONSTRAINT "maintenance_windows_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_windows" ADD CONSTRAINT "maintenance_windows_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_policies" ADD CONSTRAINT "security_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_posture_org_snapshots" ADD CONSTRAINT "security_posture_org_snapshots_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_posture_snapshots" ADD CONSTRAINT "security_posture_snapshots_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_posture_snapshots" ADD CONSTRAINT "security_posture_snapshots_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_scans" ADD CONSTRAINT "security_scans_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_scans" ADD CONSTRAINT "security_scans_initiated_by_users_id_fk" FOREIGN KEY ("initiated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_status" ADD CONSTRAINT "security_status_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_threats" ADD CONSTRAINT "security_threats_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_results" ADD CONSTRAINT "deployment_results_deployment_id_software_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."software_deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_results" ADD CONSTRAINT "deployment_results_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_deployments" ADD CONSTRAINT "software_deployments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_deployments" ADD CONSTRAINT "software_deployments_software_version_id_software_versions_id_fk" FOREIGN KEY ("software_version_id") REFERENCES "public"."software_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_deployments" ADD CONSTRAINT "software_deployments_maintenance_window_id_maintenance_windows_id_fk" FOREIGN KEY ("maintenance_window_id") REFERENCES "public"."maintenance_windows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_deployments" ADD CONSTRAINT "software_deployments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_inventory" ADD CONSTRAINT "software_inventory_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_inventory" ADD CONSTRAINT "software_inventory_catalog_id_software_catalog_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."software_catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_versions" ADD CONSTRAINT "software_versions_catalog_id_software_catalog_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."software_catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_devices" ADD CONSTRAINT "deployment_devices_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_devices" ADD CONSTRAINT "deployment_devices_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_configs" ADD CONSTRAINT "backup_configs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_jobs" ADD CONSTRAINT "backup_jobs_config_id_backup_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."backup_configs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_jobs" ADD CONSTRAINT "backup_jobs_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_policies" ADD CONSTRAINT "backup_policies_config_id_backup_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."backup_configs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_snapshots" ADD CONSTRAINT "backup_snapshots_job_id_backup_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."backup_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_snapshots" ADD CONSTRAINT "backup_snapshots_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_snapshots" ADD CONSTRAINT "backup_snapshots_parent_snapshot_id_backup_snapshots_id_fk" FOREIGN KEY ("parent_snapshot_id") REFERENCES "public"."backup_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_jobs" ADD CONSTRAINT "restore_jobs_snapshot_id_backup_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."backup_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_jobs" ADD CONSTRAINT "restore_jobs_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_jobs" ADD CONSTRAINT "restore_jobs_initiated_by_users_id_fk" FOREIGN KEY ("initiated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snmp_alert_thresholds" ADD CONSTRAINT "snmp_alert_thresholds_device_id_snmp_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."snmp_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snmp_devices" ADD CONSTRAINT "snmp_devices_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snmp_devices" ADD CONSTRAINT "snmp_devices_asset_id_discovered_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."discovered_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snmp_devices" ADD CONSTRAINT "snmp_devices_template_id_snmp_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."snmp_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snmp_metrics" ADD CONSTRAINT "snmp_metrics_device_id_snmp_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."snmp_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_notifications" ADD CONSTRAINT "user_notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_notifications" ADD CONSTRAINT "user_notifications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_parent_id_policies_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_assignments" ADD CONSTRAINT "policy_assignments_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_compliance" ADD CONSTRAINT "policy_compliance_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_compliance" ADD CONSTRAINT "policy_compliance_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_policies" ADD CONSTRAINT "automation_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_policies" ADD CONSTRAINT "automation_policies_remediation_script_id_scripts_id_fk" FOREIGN KEY ("remediation_script_id") REFERENCES "public"."scripts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_policies" ADD CONSTRAINT "automation_policies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_policy_compliance" ADD CONSTRAINT "automation_policy_compliance_policy_id_automation_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."automation_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_policy_compliance" ADD CONSTRAINT "automation_policy_compliance_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_filters" ADD CONSTRAINT "saved_filters_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_filters" ADD CONSTRAINT "saved_filters_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_event_logs" ADD CONSTRAINT "device_event_logs_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_event_logs" ADD CONSTRAINT "device_event_logs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_budgets" ADD CONSTRAINT "ai_budgets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_cost_usage" ADD CONSTRAINT "ai_cost_usage_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_session_id_ai_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."ai_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tool_executions" ADD CONSTRAINT "ai_tool_executions_session_id_ai_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."ai_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tool_executions" ADD CONSTRAINT "ai_tool_executions_message_id_ai_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."ai_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tool_executions" ADD CONSTRAINT "ai_tool_executions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_monitor_alert_rules" ADD CONSTRAINT "network_monitor_alert_rules_monitor_id_network_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."network_monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_monitor_results" ADD CONSTRAINT "network_monitor_results_monitor_id_network_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."network_monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_monitors" ADD CONSTRAINT "network_monitors_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_monitors" ADD CONSTRAINT "network_monitors_asset_id_discovered_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."discovered_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_filesystem_cleanup_runs" ADD CONSTRAINT "device_filesystem_cleanup_runs_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_filesystem_cleanup_runs" ADD CONSTRAINT "device_filesystem_cleanup_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_filesystem_scan_state" ADD CONSTRAINT "device_filesystem_scan_state_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_filesystem_snapshots" ADD CONSTRAINT "device_filesystem_snapshots_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_sessions" ADD CONSTRAINT "device_sessions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_sessions" ADD CONSTRAINT "device_sessions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "script_categories_org_id_idx" ON "script_categories" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "script_categories_parent_id_idx" ON "script_categories" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "script_categories_org_name_idx" ON "script_categories" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "script_tags_org_id_idx" ON "script_tags" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "script_tags_org_name_idx" ON "script_tags" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "script_templates_category_idx" ON "script_templates" USING btree ("category");--> statement-breakpoint
CREATE INDEX "script_templates_language_idx" ON "script_templates" USING btree ("language");--> statement-breakpoint
CREATE INDEX "script_templates_name_idx" ON "script_templates" USING btree ("name");--> statement-breakpoint
CREATE INDEX "script_to_tags_tag_id_idx" ON "script_to_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "script_versions_script_id_idx" ON "script_versions" USING btree ("script_id");--> statement-breakpoint
CREATE INDEX "script_versions_script_id_version_idx" ON "script_versions" USING btree ("script_id","version");--> statement-breakpoint
CREATE INDEX "alert_correlations_parent_alert_id_idx" ON "alert_correlations" USING btree ("parent_alert_id");--> statement-breakpoint
CREATE INDEX "alert_correlations_child_alert_id_idx" ON "alert_correlations" USING btree ("child_alert_id");--> statement-breakpoint
CREATE INDEX "alert_rules_org_id_idx" ON "alert_rules" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "alert_rules_template_id_idx" ON "alert_rules" USING btree ("template_id");--> statement-breakpoint
CREATE UNIQUE INDEX "device_patches_device_patch_unique" ON "device_patches" USING btree ("device_id","patch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patch_approvals_org_patch_unique" ON "patch_approvals" USING btree ("org_id","patch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patches_source_external_id_unique" ON "patches" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "time_series_metrics_device_timestamp_idx" ON "time_series_metrics" USING btree ("timestamp","device_id");--> statement-breakpoint
CREATE INDEX "time_series_metrics_org_timestamp_idx" ON "time_series_metrics" USING btree ("org_id","timestamp");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_installations_org_catalog_unique" ON "plugin_installations" USING btree ("org_id","catalog_id");--> statement-breakpoint
CREATE UNIQUE INDEX "discovered_assets_org_ip_unique" ON "discovered_assets" USING btree ("org_id","ip_address");--> statement-breakpoint
CREATE INDEX "security_policies_org_id_idx" ON "security_policies" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "security_posture_org_snapshots_org_captured_idx" ON "security_posture_org_snapshots" USING btree ("org_id","captured_at");--> statement-breakpoint
CREATE INDEX "security_posture_org_snapshots_org_score_idx" ON "security_posture_org_snapshots" USING btree ("org_id","overall_score");--> statement-breakpoint
CREATE INDEX "security_posture_snapshots_org_captured_idx" ON "security_posture_snapshots" USING btree ("org_id","captured_at");--> statement-breakpoint
CREATE INDEX "security_posture_snapshots_device_captured_idx" ON "security_posture_snapshots" USING btree ("device_id","captured_at");--> statement-breakpoint
CREATE INDEX "security_posture_snapshots_org_score_idx" ON "security_posture_snapshots" USING btree ("org_id","overall_score");--> statement-breakpoint
CREATE INDEX "security_scans_device_started_idx" ON "security_scans" USING btree ("device_id","started_at");--> statement-breakpoint
CREATE INDEX "security_scans_status_idx" ON "security_scans" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "security_status_device_id_unique" ON "security_status" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "security_status_provider_idx" ON "security_status" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "security_threats_device_detected_idx" ON "security_threats" USING btree ("device_id","detected_at");--> statement-breakpoint
CREATE INDEX "security_threats_status_idx" ON "security_threats" USING btree ("status");--> statement-breakpoint
CREATE INDEX "deployment_results_deployment_id_idx" ON "deployment_results" USING btree ("deployment_id");--> statement-breakpoint
CREATE INDEX "deployment_results_device_id_idx" ON "deployment_results" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "deployment_results_status_idx" ON "deployment_results" USING btree ("status");--> statement-breakpoint
CREATE INDEX "software_catalog_name_idx" ON "software_catalog" USING btree ("name");--> statement-breakpoint
CREATE INDEX "software_catalog_vendor_idx" ON "software_catalog" USING btree ("vendor");--> statement-breakpoint
CREATE INDEX "software_catalog_category_idx" ON "software_catalog" USING btree ("category");--> statement-breakpoint
CREATE INDEX "software_deployments_org_id_idx" ON "software_deployments" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "software_deployments_version_id_idx" ON "software_deployments" USING btree ("software_version_id");--> statement-breakpoint
CREATE INDEX "software_deployments_schedule_idx" ON "software_deployments" USING btree ("schedule_type","scheduled_at");--> statement-breakpoint
CREATE INDEX "software_inventory_device_id_idx" ON "software_inventory" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "software_inventory_catalog_id_idx" ON "software_inventory" USING btree ("catalog_id");--> statement-breakpoint
CREATE INDEX "software_inventory_name_idx" ON "software_inventory" USING btree ("name");--> statement-breakpoint
CREATE INDEX "software_versions_catalog_id_idx" ON "software_versions" USING btree ("catalog_id");--> statement-breakpoint
CREATE INDEX "software_versions_catalog_version_idx" ON "software_versions" USING btree ("catalog_id","version");--> statement-breakpoint
CREATE INDEX "software_versions_latest_idx" ON "software_versions" USING btree ("catalog_id","is_latest");--> statement-breakpoint
CREATE UNIQUE INDEX "deployment_devices_deployment_device_unique" ON "deployment_devices" USING btree ("deployment_id","device_id");--> statement-breakpoint
CREATE INDEX "backup_configs_org_id_idx" ON "backup_configs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "backup_configs_type_idx" ON "backup_configs" USING btree ("type");--> statement-breakpoint
CREATE INDEX "backup_configs_provider_idx" ON "backup_configs" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "backup_configs_active_idx" ON "backup_configs" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "backup_jobs_config_id_idx" ON "backup_jobs" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX "backup_jobs_device_id_idx" ON "backup_jobs" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "backup_jobs_status_idx" ON "backup_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "backup_jobs_started_at_idx" ON "backup_jobs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "backup_policies_config_id_idx" ON "backup_policies" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX "backup_policies_target_idx" ON "backup_policies" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "backup_snapshots_job_id_idx" ON "backup_snapshots" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "backup_snapshots_device_id_idx" ON "backup_snapshots" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "backup_snapshots_snapshot_id_idx" ON "backup_snapshots" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "backup_snapshots_parent_snapshot_id_idx" ON "backup_snapshots" USING btree ("parent_snapshot_id");--> statement-breakpoint
CREATE INDEX "restore_jobs_snapshot_id_idx" ON "restore_jobs" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "restore_jobs_device_id_idx" ON "restore_jobs" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "restore_jobs_status_idx" ON "restore_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "snmp_metrics_device_id_idx" ON "snmp_metrics" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "snmp_metrics_oid_idx" ON "snmp_metrics" USING btree ("oid");--> statement-breakpoint
CREATE INDEX "snmp_metrics_timestamp_idx" ON "snmp_metrics" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "user_notifications_user_id_idx" ON "user_notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_notifications_user_read_idx" ON "user_notifications" USING btree ("user_id","read");--> statement-breakpoint
CREATE INDEX "user_notifications_created_at_idx" ON "user_notifications" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "policies_org_id_idx" ON "policies" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "policies_type_idx" ON "policies" USING btree ("type");--> statement-breakpoint
CREATE INDEX "policies_status_idx" ON "policies" USING btree ("status");--> statement-breakpoint
CREATE INDEX "policy_assignments_policy_id_idx" ON "policy_assignments" USING btree ("policy_id");--> statement-breakpoint
CREATE INDEX "policy_compliance_policy_id_idx" ON "policy_compliance" USING btree ("policy_id");--> statement-breakpoint
CREATE INDEX "policy_compliance_device_id_idx" ON "policy_compliance" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "policy_versions_policy_id_idx" ON "policy_versions" USING btree ("policy_id");--> statement-breakpoint
CREATE INDEX "agent_versions_is_latest_idx" ON "agent_versions" USING btree ("is_latest");--> statement-breakpoint
CREATE INDEX "device_event_logs_device_idx" ON "device_event_logs" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "device_event_logs_org_ts_idx" ON "device_event_logs" USING btree ("org_id","timestamp");--> statement-breakpoint
CREATE INDEX "device_event_logs_cat_level_idx" ON "device_event_logs" USING btree ("category","level");--> statement-breakpoint
CREATE UNIQUE INDEX "device_event_logs_dedup_idx" ON "device_event_logs" USING btree ("device_id","source","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_cost_usage_org_period_idx" ON "ai_cost_usage" USING btree ("org_id","period","period_key");--> statement-breakpoint
CREATE INDEX "ai_messages_session_id_idx" ON "ai_messages" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "ai_messages_role_idx" ON "ai_messages" USING btree ("role");--> statement-breakpoint
CREATE INDEX "ai_sessions_org_id_idx" ON "ai_sessions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "ai_sessions_user_id_idx" ON "ai_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ai_sessions_status_idx" ON "ai_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ai_tool_executions_session_id_idx" ON "ai_tool_executions" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "ai_tool_executions_status_idx" ON "ai_tool_executions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "network_monitor_results_monitor_id_idx" ON "network_monitor_results" USING btree ("monitor_id");--> statement-breakpoint
CREATE INDEX "network_monitor_results_timestamp_idx" ON "network_monitor_results" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "network_monitors_org_id_idx" ON "network_monitors" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "network_monitors_monitor_type_idx" ON "network_monitors" USING btree ("monitor_type");--> statement-breakpoint
CREATE INDEX "network_monitors_is_active_idx" ON "network_monitors" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "idx_device_filesystem_cleanup_runs_device_requested" ON "device_filesystem_cleanup_runs" USING btree ("device_id","requested_at");--> statement-breakpoint
CREATE INDEX "idx_device_filesystem_snapshots_device_captured" ON "device_filesystem_snapshots" USING btree ("device_id","captured_at");--> statement-breakpoint
CREATE INDEX "device_sessions_org_active_idx" ON "device_sessions" USING btree ("org_id","is_active");--> statement-breakpoint
CREATE INDEX "device_sessions_device_active_idx" ON "device_sessions" USING btree ("device_id","is_active");--> statement-breakpoint
CREATE INDEX "device_sessions_device_login_idx" ON "device_sessions" USING btree ("device_id","login_at");--> statement-breakpoint
CREATE INDEX "device_sessions_device_user_idx" ON "device_sessions" USING btree ("device_id","username");