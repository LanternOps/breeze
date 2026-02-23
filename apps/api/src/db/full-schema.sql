--
-- PostgreSQL database dump
--


-- Dumped from database version 16.12
-- Dumped by pg_dump version 16.12

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: access_review_decision; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.access_review_decision AS ENUM (
    'pending',
    'approved',
    'revoked'
);


--
-- Name: access_review_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.access_review_status AS ENUM (
    'pending',
    'in_progress',
    'completed'
);


--
-- Name: actor_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.actor_type AS ENUM (
    'user',
    'api_key',
    'agent',
    'system'
);


--
-- Name: ai_message_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.ai_message_role AS ENUM (
    'user',
    'assistant',
    'system',
    'tool_use',
    'tool_result'
);


--
-- Name: ai_session_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.ai_session_status AS ENUM (
    'active',
    'closed',
    'expired'
);


--
-- Name: ai_tool_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.ai_tool_status AS ENUM (
    'pending',
    'approved',
    'executing',
    'completed',
    'failed',
    'rejected'
);


--
-- Name: alert_severity; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.alert_severity AS ENUM (
    'critical',
    'high',
    'medium',
    'low',
    'info'
);


--
-- Name: alert_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.alert_status AS ENUM (
    'active',
    'acknowledged',
    'resolved',
    'suppressed'
);


--
-- Name: api_key_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.api_key_status AS ENUM (
    'active',
    'revoked',
    'expired'
);


--
-- Name: audit_result; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.audit_result AS ENUM (
    'success',
    'failure',
    'denied'
);


--
-- Name: automation_on_failure; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.automation_on_failure AS ENUM (
    'stop',
    'continue',
    'notify'
);


--
-- Name: automation_run_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.automation_run_status AS ENUM (
    'running',
    'completed',
    'failed',
    'partial'
);


--
-- Name: automation_trigger_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.automation_trigger_type AS ENUM (
    'schedule',
    'event',
    'webhook',
    'manual'
);


--
-- Name: backup_job_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.backup_job_type AS ENUM (
    'scheduled',
    'manual',
    'incremental'
);


--
-- Name: backup_provider; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.backup_provider AS ENUM (
    'local',
    's3',
    'azure_blob',
    'google_cloud',
    'backblaze'
);


--
-- Name: backup_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.backup_status AS ENUM (
    'pending',
    'running',
    'completed',
    'failed',
    'cancelled',
    'partial'
);


--
-- Name: backup_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.backup_type AS ENUM (
    'file',
    'system_image',
    'database',
    'application'
);


--
-- Name: compliance_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.compliance_status AS ENUM (
    'compliant',
    'non_compliant',
    'pending',
    'error'
);


--
-- Name: connection_protocol; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.connection_protocol AS ENUM (
    'tcp',
    'tcp6',
    'udp',
    'udp6'
);


--
-- Name: custom_field_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.custom_field_type AS ENUM (
    'text',
    'number',
    'boolean',
    'dropdown',
    'date'
);


--
-- Name: deployment_device_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.deployment_device_status AS ENUM (
    'pending',
    'running',
    'completed',
    'failed',
    'skipped'
);


--
-- Name: deployment_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.deployment_status AS ENUM (
    'draft',
    'pending',
    'running',
    'paused',
    'downloading',
    'installing',
    'completed',
    'failed',
    'cancelled',
    'rollback'
);


--
-- Name: device_group_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.device_group_type AS ENUM (
    'static',
    'dynamic'
);


--
-- Name: device_patch_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.device_patch_status AS ENUM (
    'pending',
    'installed',
    'failed',
    'skipped',
    'missing'
);


--
-- Name: device_platform; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.device_platform AS ENUM (
    'ios',
    'android'
);


--
-- Name: device_session_activity_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.device_session_activity_state AS ENUM (
    'active',
    'idle',
    'locked',
    'away',
    'disconnected'
);


--
-- Name: device_session_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.device_session_type AS ENUM (
    'console',
    'rdp',
    'ssh',
    'other'
);


--
-- Name: device_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.device_status AS ENUM (
    'online',
    'offline',
    'maintenance',
    'decommissioned',
    'quarantined'
);


--
-- Name: discovered_asset_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.discovered_asset_status AS ENUM (
    'new',
    'identified',
    'managed',
    'ignored',
    'offline'
);


--
-- Name: discovered_asset_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.discovered_asset_type AS ENUM (
    'workstation',
    'server',
    'printer',
    'router',
    'switch',
    'firewall',
    'access_point',
    'phone',
    'iot',
    'camera',
    'nas',
    'unknown'
);


--
-- Name: discovery_job_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.discovery_job_status AS ENUM (
    'scheduled',
    'running',
    'completed',
    'failed',
    'cancelled'
);


--
-- Name: discovery_method; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.discovery_method AS ENUM (
    'arp',
    'ping',
    'port_scan',
    'snmp',
    'wmi',
    'ssh',
    'mdns',
    'netbios'
);


--
-- Name: event_bus_priority; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.event_bus_priority AS ENUM (
    'low',
    'normal',
    'high',
    'critical'
);


--
-- Name: event_log_category; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.event_log_category AS ENUM (
    'security',
    'hardware',
    'application',
    'system'
);


--
-- Name: event_log_level; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.event_log_level AS ENUM (
    'info',
    'warning',
    'error',
    'critical'
);


--
-- Name: execution_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.execution_status AS ENUM (
    'pending',
    'queued',
    'running',
    'completed',
    'failed',
    'timeout',
    'cancelled'
);


--
-- Name: file_transfer_direction; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.file_transfer_direction AS ENUM (
    'upload',
    'download'
);


--
-- Name: file_transfer_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.file_transfer_status AS ENUM (
    'pending',
    'transferring',
    'completed',
    'failed'
);


--
-- Name: filesystem_cleanup_run_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.filesystem_cleanup_run_status AS ENUM (
    'previewed',
    'executed',
    'failed'
);


--
-- Name: filesystem_snapshot_trigger; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.filesystem_snapshot_trigger AS ENUM (
    'on_demand',
    'threshold'
);


--
-- Name: group_membership_log_action; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.group_membership_log_action AS ENUM (
    'added',
    'removed'
);


--
-- Name: group_membership_log_reason; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.group_membership_log_reason AS ENUM (
    'manual',
    'filter_match',
    'filter_unmatch',
    'pinned',
    'unpinned'
);


--
-- Name: maintenance_recurrence; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.maintenance_recurrence AS ENUM (
    'once',
    'daily',
    'weekly',
    'monthly',
    'custom'
);


--
-- Name: maintenance_window_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.maintenance_window_status AS ENUM (
    'scheduled',
    'active',
    'completed',
    'cancelled'
);


--
-- Name: membership_source; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.membership_source AS ENUM (
    'manual',
    'dynamic_rule',
    'policy'
);


--
-- Name: mfa_method; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.mfa_method AS ENUM (
    'totp',
    'sms'
);


--
-- Name: monitor_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.monitor_status AS ENUM (
    'online',
    'offline',
    'degraded',
    'unknown'
);


--
-- Name: monitor_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.monitor_type AS ENUM (
    'icmp_ping',
    'tcp_port',
    'http_check',
    'dns_check'
);


--
-- Name: notification_channel_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.notification_channel_type AS ENUM (
    'email',
    'slack',
    'teams',
    'webhook',
    'pagerduty',
    'sms'
);


--
-- Name: notification_priority; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.notification_priority AS ENUM (
    'low',
    'normal',
    'high',
    'urgent'
);


--
-- Name: notification_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.notification_type AS ENUM (
    'alert',
    'device',
    'script',
    'automation',
    'system',
    'user',
    'security'
);


--
-- Name: org_access; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.org_access AS ENUM (
    'all',
    'selected',
    'none'
);


--
-- Name: org_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.org_status AS ENUM (
    'active',
    'suspended',
    'trial',
    'churned'
);


--
-- Name: org_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.org_type AS ENUM (
    'customer',
    'internal'
);


--
-- Name: os_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.os_type AS ENUM (
    'windows',
    'macos',
    'linux'
);


--
-- Name: partner_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.partner_type AS ENUM (
    'msp',
    'enterprise',
    'internal'
);


--
-- Name: patch_approval_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.patch_approval_status AS ENUM (
    'pending',
    'approved',
    'rejected',
    'deferred'
);


--
-- Name: patch_compliance_report_format; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.patch_compliance_report_format AS ENUM (
    'csv',
    'pdf'
);


--
-- Name: patch_compliance_report_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.patch_compliance_report_status AS ENUM (
    'pending',
    'running',
    'completed',
    'failed'
);


--
-- Name: patch_job_result_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.patch_job_result_status AS ENUM (
    'pending',
    'running',
    'completed',
    'failed',
    'skipped'
);


--
-- Name: patch_job_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.patch_job_status AS ENUM (
    'scheduled',
    'running',
    'completed',
    'failed',
    'cancelled'
);


--
-- Name: patch_rollback_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.patch_rollback_status AS ENUM (
    'pending',
    'running',
    'completed',
    'failed',
    'cancelled'
);


--
-- Name: patch_severity; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.patch_severity AS ENUM (
    'critical',
    'important',
    'moderate',
    'low',
    'unknown'
);


--
-- Name: patch_source; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.patch_source AS ENUM (
    'microsoft',
    'apple',
    'linux',
    'third_party',
    'custom'
);


--
-- Name: plan_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.plan_type AS ENUM (
    'free',
    'pro',
    'enterprise',
    'unlimited'
);


--
-- Name: plugin_install_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.plugin_install_status AS ENUM (
    'available',
    'installing',
    'installed',
    'updating',
    'uninstalling',
    'error'
);


--
-- Name: plugin_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.plugin_status AS ENUM (
    'active',
    'disabled',
    'error',
    'installing'
);


--
-- Name: plugin_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.plugin_type AS ENUM (
    'integration',
    'automation',
    'reporting',
    'collector',
    'notification',
    'ui'
);


--
-- Name: policy_enforcement; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.policy_enforcement AS ENUM (
    'monitor',
    'warn',
    'enforce'
);


--
-- Name: policy_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.policy_status AS ENUM (
    'draft',
    'active',
    'inactive',
    'archived'
);


--
-- Name: policy_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.policy_type AS ENUM (
    'monitoring',
    'patching',
    'security',
    'backup',
    'maintenance',
    'software',
    'alert',
    'custom'
);


--
-- Name: psa_provider; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.psa_provider AS ENUM (
    'connectwise',
    'autotask',
    'halo',
    'syncro',
    'kaseya',
    'jira',
    'servicenow',
    'freshservice',
    'zendesk',
    'other'
);


--
-- Name: remote_session_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.remote_session_status AS ENUM (
    'pending',
    'connecting',
    'active',
    'disconnected',
    'failed'
);


--
-- Name: remote_session_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.remote_session_type AS ENUM (
    'terminal',
    'desktop',
    'file_transfer'
);


--
-- Name: report_format; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.report_format AS ENUM (
    'csv',
    'pdf',
    'excel'
);


--
-- Name: report_run_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.report_run_status AS ENUM (
    'pending',
    'running',
    'completed',
    'failed'
);


--
-- Name: report_schedule; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.report_schedule AS ENUM (
    'one_time',
    'daily',
    'weekly',
    'monthly'
);


--
-- Name: report_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.report_type AS ENUM (
    'device_inventory',
    'software_inventory',
    'alert_summary',
    'compliance',
    'performance',
    'executive_summary'
);


--
-- Name: restore_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.restore_type AS ENUM (
    'full',
    'selective',
    'bare_metal'
);


--
-- Name: role_scope; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.role_scope AS ENUM (
    'system',
    'partner',
    'organization'
);


--
-- Name: script_language; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.script_language AS ENUM (
    'powershell',
    'bash',
    'python',
    'cmd'
);


--
-- Name: script_run_as; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.script_run_as AS ENUM (
    'system',
    'user',
    'elevated'
);


--
-- Name: security_provider; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.security_provider AS ENUM (
    'windows_defender',
    'bitdefender',
    'sophos',
    'sentinelone',
    'crowdstrike',
    'malwarebytes',
    'eset',
    'kaspersky',
    'other'
);


--
-- Name: security_risk_level; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.security_risk_level AS ENUM (
    'low',
    'medium',
    'high',
    'critical'
);


--
-- Name: software_policy_mode; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.software_policy_mode AS ENUM (
    'allowlist',
    'blocklist',
    'audit'
);


--
-- Name: sso_provider_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.sso_provider_status AS ENUM (
    'active',
    'inactive',
    'testing'
);


--
-- Name: sso_provider_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.sso_provider_type AS ENUM (
    'oidc',
    'saml'
);


--
-- Name: threat_severity; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.threat_severity AS ENUM (
    'low',
    'medium',
    'high',
    'critical'
);


--
-- Name: threat_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.threat_status AS ENUM (
    'detected',
    'quarantined',
    'removed',
    'allowed',
    'failed'
);


--
-- Name: ticket_priority; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.ticket_priority AS ENUM (
    'low',
    'normal',
    'high',
    'urgent'
);


--
-- Name: ticket_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.ticket_status AS ENUM (
    'new',
    'open',
    'pending',
    'on_hold',
    'resolved',
    'closed'
);


--
-- Name: trigger_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.trigger_type AS ENUM (
    'manual',
    'scheduled',
    'alert',
    'policy'
);


--
-- Name: user_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.user_status AS ENUM (
    'active',
    'invited',
    'disabled'
);


--
-- Name: webhook_delivery_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.webhook_delivery_status AS ENUM (
    'pending',
    'delivered',
    'failed',
    'retrying'
);


--
-- Name: webhook_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.webhook_status AS ENUM (
    'active',
    'disabled',
    'error'
);


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: access_review_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.access_review_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    review_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role_id uuid NOT NULL,
    decision public.access_review_decision DEFAULT 'pending'::public.access_review_decision NOT NULL,
    notes text,
    reviewed_at timestamp without time zone,
    reviewed_by uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: access_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.access_reviews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    partner_id uuid,
    org_id uuid,
    name character varying(255) NOT NULL,
    description text,
    status public.access_review_status DEFAULT 'pending'::public.access_review_status NOT NULL,
    reviewer_id uuid,
    due_date timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    completed_at timestamp without time zone
);


--
-- Name: agent_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    version character varying(20) NOT NULL,
    platform character varying(20) NOT NULL,
    architecture character varying(20) NOT NULL,
    download_url text NOT NULL,
    checksum character varying(64) NOT NULL,
    file_size bigint,
    release_notes text,
    is_latest boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: ai_budgets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_budgets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    monthly_budget_cents integer,
    daily_budget_cents integer,
    max_turns_per_session integer DEFAULT 50 NOT NULL,
    allowed_models jsonb DEFAULT '["claude-sonnet-4-5-20250929"]'::jsonb,
    messages_per_minute_per_user integer DEFAULT 20 NOT NULL,
    messages_per_hour_per_org integer DEFAULT 200 NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: ai_cost_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_cost_usage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    period character varying(10) NOT NULL,
    period_key character varying(10) NOT NULL,
    input_tokens integer DEFAULT 0 NOT NULL,
    output_tokens integer DEFAULT 0 NOT NULL,
    total_cost_cents real DEFAULT 0 NOT NULL,
    session_count integer DEFAULT 0 NOT NULL,
    message_count integer DEFAULT 0 NOT NULL,
    tool_execution_count integer DEFAULT 0 NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: ai_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    role public.ai_message_role NOT NULL,
    content text,
    content_blocks jsonb,
    tool_name character varying(100),
    tool_input jsonb,
    tool_output jsonb,
    tool_use_id character varying(100),
    input_tokens integer,
    output_tokens integer,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: ai_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    user_id uuid NOT NULL,
    status public.ai_session_status DEFAULT 'active'::public.ai_session_status NOT NULL,
    title character varying(255),
    model character varying(100) DEFAULT 'claude-sonnet-4-5-20250929'::character varying NOT NULL,
    system_prompt text,
    context_snapshot jsonb,
    total_input_tokens integer DEFAULT 0 NOT NULL,
    total_output_tokens integer DEFAULT 0 NOT NULL,
    total_cost_cents real DEFAULT 0 NOT NULL,
    turn_count integer DEFAULT 0 NOT NULL,
    max_turns integer DEFAULT 50 NOT NULL,
    sdk_session_id character varying(255),
    last_activity_at timestamp without time zone DEFAULT now() NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: ai_tool_executions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_tool_executions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    message_id uuid,
    tool_name character varying(100) NOT NULL,
    tool_input jsonb NOT NULL,
    tool_output jsonb,
    status public.ai_tool_status DEFAULT 'pending'::public.ai_tool_status NOT NULL,
    approved_by uuid,
    approved_at timestamp without time zone,
    command_id uuid,
    duration_ms integer,
    error_message text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    completed_at timestamp without time zone
);


--
-- Name: alert_correlations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alert_correlations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    parent_alert_id uuid NOT NULL,
    child_alert_id uuid NOT NULL,
    correlation_type character varying(50) NOT NULL,
    confidence numeric(3,2),
    metadata jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: alert_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alert_notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    alert_id uuid NOT NULL,
    channel_id uuid NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    sent_at timestamp without time zone,
    error_message text,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: alert_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alert_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    template_id uuid NOT NULL,
    name character varying(200) NOT NULL,
    target_type character varying(50) NOT NULL,
    target_id uuid NOT NULL,
    override_settings jsonb,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: alert_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alert_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid,
    name character varying(200) NOT NULL,
    description text,
    conditions jsonb NOT NULL,
    severity public.alert_severity NOT NULL,
    title_template text NOT NULL,
    message_template text NOT NULL,
    auto_resolve boolean DEFAULT false NOT NULL,
    auto_resolve_conditions jsonb,
    cooldown_minutes integer DEFAULT 5 NOT NULL,
    is_built_in boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alerts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    rule_id uuid NOT NULL,
    device_id uuid NOT NULL,
    org_id uuid NOT NULL,
    status public.alert_status DEFAULT 'active'::public.alert_status NOT NULL,
    severity public.alert_severity NOT NULL,
    title character varying(500) NOT NULL,
    message text,
    context jsonb,
    triggered_at timestamp without time zone DEFAULT now() NOT NULL,
    acknowledged_at timestamp without time zone,
    acknowledged_by uuid,
    resolved_at timestamp without time zone,
    resolved_by uuid,
    resolution_note text,
    suppressed_until timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: analytics_dashboards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analytics_dashboards (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    is_default boolean DEFAULT false NOT NULL,
    is_system boolean DEFAULT false NOT NULL,
    layout jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    key_hash character varying(255) NOT NULL,
    key_prefix character varying(12) NOT NULL,
    scopes jsonb DEFAULT '[]'::jsonb NOT NULL,
    expires_at timestamp without time zone,
    last_used_at timestamp without time zone,
    usage_count integer DEFAULT 0 NOT NULL,
    rate_limit integer DEFAULT 1000 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    status public.api_key_status DEFAULT 'active'::public.api_key_status NOT NULL
);


--
-- Name: asset_checkouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_checkouts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    device_id uuid NOT NULL,
    checked_out_to uuid,
    checked_out_to_name character varying(255),
    checked_out_at timestamp without time zone DEFAULT now() NOT NULL,
    expected_return_at timestamp without time zone,
    checked_in_at timestamp without time zone,
    checked_in_by uuid,
    checkout_notes text,
    checkin_notes text,
    condition character varying(100),
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    "timestamp" timestamp without time zone DEFAULT now() NOT NULL,
    actor_type public.actor_type NOT NULL,
    actor_id uuid NOT NULL,
    actor_email character varying(255),
    action character varying(100) NOT NULL,
    resource_type character varying(50) NOT NULL,
    resource_id uuid,
    resource_name character varying(255),
    details jsonb,
    ip_address character varying(45),
    user_agent text,
    result public.audit_result NOT NULL,
    error_message text,
    checksum character varying(128)
);


--
-- Name: audit_retention_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_retention_policies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    retention_days integer DEFAULT 365 NOT NULL,
    archive_to_s3 boolean DEFAULT false NOT NULL,
    last_cleanup_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: automation_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.automation_policies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    enabled boolean DEFAULT true NOT NULL,
    targets jsonb NOT NULL,
    rules jsonb NOT NULL,
    enforcement public.policy_enforcement DEFAULT 'monitor'::public.policy_enforcement NOT NULL,
    check_interval_minutes integer DEFAULT 60 NOT NULL,
    remediation_script_id uuid,
    last_evaluated_at timestamp without time zone,
    created_by uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: automation_policy_compliance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.automation_policy_compliance (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    policy_id uuid NOT NULL,
    device_id uuid NOT NULL,
    status public.compliance_status DEFAULT 'pending'::public.compliance_status NOT NULL,
    details jsonb,
    last_checked_at timestamp without time zone,
    remediation_attempts integer DEFAULT 0 NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: automation_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.automation_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    automation_id uuid NOT NULL,
    triggered_by character varying(255) NOT NULL,
    status public.automation_run_status DEFAULT 'running'::public.automation_run_status NOT NULL,
    devices_targeted integer DEFAULT 0 NOT NULL,
    devices_succeeded integer DEFAULT 0 NOT NULL,
    devices_failed integer DEFAULT 0 NOT NULL,
    started_at timestamp without time zone DEFAULT now() NOT NULL,
    completed_at timestamp without time zone,
    logs jsonb DEFAULT '[]'::jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: automations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.automations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    enabled boolean DEFAULT true NOT NULL,
    trigger jsonb NOT NULL,
    conditions jsonb,
    actions jsonb NOT NULL,
    on_failure public.automation_on_failure DEFAULT 'stop'::public.automation_on_failure NOT NULL,
    notification_targets jsonb,
    last_run_at timestamp without time zone,
    run_count integer DEFAULT 0 NOT NULL,
    created_by uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: backup_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.backup_configs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name character varying(200) NOT NULL,
    type public.backup_type NOT NULL,
    provider public.backup_provider NOT NULL,
    provider_config jsonb NOT NULL,
    schedule jsonb,
    retention jsonb,
    compression boolean DEFAULT true NOT NULL,
    encryption boolean DEFAULT true NOT NULL,
    encryption_key text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: backup_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.backup_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    config_id uuid NOT NULL,
    device_id uuid NOT NULL,
    status public.backup_status DEFAULT 'pending'::public.backup_status NOT NULL,
    type public.backup_job_type DEFAULT 'scheduled'::public.backup_job_type NOT NULL,
    started_at timestamp without time zone,
    completed_at timestamp without time zone,
    total_size bigint,
    transferred_size bigint,
    file_count integer,
    error_count integer,
    error_log text,
    snapshot_id character varying(200)
);


--
-- Name: backup_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.backup_policies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    config_id uuid NOT NULL,
    target_type character varying(50) NOT NULL,
    target_id uuid NOT NULL,
    includes jsonb DEFAULT '[]'::jsonb NOT NULL,
    excludes jsonb DEFAULT '[]'::jsonb NOT NULL,
    priority integer DEFAULT 50 NOT NULL
);


--
-- Name: backup_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.backup_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    device_id uuid NOT NULL,
    snapshot_id character varying(200) NOT NULL,
    "timestamp" timestamp without time zone DEFAULT now() NOT NULL,
    size bigint,
    file_count integer,
    is_incremental boolean DEFAULT false NOT NULL,
    parent_snapshot_id uuid,
    expires_at timestamp without time zone,
    metadata jsonb
);


--
-- Name: capacity_predictions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.capacity_predictions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    device_id uuid,
    metric_type character varying(100) NOT NULL,
    metric_name character varying(255) NOT NULL,
    current_value double precision NOT NULL,
    predicted_value double precision NOT NULL,
    prediction_date timestamp without time zone NOT NULL,
    confidence double precision,
    growth_rate double precision,
    days_to_threshold integer,
    threshold_type character varying(50),
    model_type character varying(100),
    training_data_days integer,
    calculated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: capacity_thresholds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.capacity_thresholds (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    metric_type character varying(100) NOT NULL,
    metric_name character varying(255) NOT NULL,
    warning_threshold double precision,
    critical_threshold double precision,
    prediction_window integer,
    growth_rate_threshold double precision,
    target_type character varying(50),
    target_ids uuid[],
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: custom_field_definitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.custom_field_definitions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid,
    partner_id uuid,
    name character varying(100) NOT NULL,
    field_key character varying(100) NOT NULL,
    type public.custom_field_type NOT NULL,
    options jsonb,
    required boolean DEFAULT false NOT NULL,
    default_value jsonb,
    device_types text[],
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: dashboard_widgets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dashboard_widgets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    dashboard_id uuid NOT NULL,
    widget_type character varying(100) NOT NULL,
    title character varying(255) NOT NULL,
    data_source jsonb DEFAULT '{}'::jsonb NOT NULL,
    chart_type character varying(100),
    visualization jsonb DEFAULT '{}'::jsonb NOT NULL,
    "position" jsonb DEFAULT '{}'::jsonb NOT NULL,
    refresh_interval integer,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: deployment_devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deployment_devices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    deployment_id uuid NOT NULL,
    device_id uuid NOT NULL,
    batch_number integer,
    status public.deployment_device_status DEFAULT 'pending'::public.deployment_device_status NOT NULL,
    retry_count integer DEFAULT 0 NOT NULL,
    max_retries integer DEFAULT 3 NOT NULL,
    started_at timestamp without time zone,
    completed_at timestamp without time zone,
    result jsonb
);


--
-- Name: deployment_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deployment_results (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    deployment_id uuid NOT NULL,
    device_id uuid NOT NULL,
    status public.deployment_status DEFAULT 'pending'::public.deployment_status NOT NULL,
    started_at timestamp without time zone,
    completed_at timestamp without time zone,
    exit_code integer,
    output text,
    error_message text,
    retry_count integer DEFAULT 0 NOT NULL
);


--
-- Name: deployments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deployments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name character varying(200) NOT NULL,
    type character varying(50) NOT NULL,
    payload jsonb NOT NULL,
    target_type character varying(20) NOT NULL,
    target_config jsonb NOT NULL,
    schedule jsonb,
    rollout_config jsonb NOT NULL,
    status public.deployment_status DEFAULT 'draft'::public.deployment_status NOT NULL,
    created_by uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    started_at timestamp without time zone,
    completed_at timestamp without time zone
);


--
-- Name: device_commands; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_commands (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id uuid NOT NULL,
    type character varying(50) NOT NULL,
    payload jsonb,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    created_by uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    executed_at timestamp without time zone,
    completed_at timestamp without time zone,
    result jsonb
);


--
-- Name: device_config_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_config_state (
    device_id uuid NOT NULL,
    file_path text NOT NULL,
    config_key text NOT NULL,
    config_value text,
    collected_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: device_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_connections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id uuid NOT NULL,
    protocol public.connection_protocol NOT NULL,
    local_addr character varying(45) NOT NULL,
    local_port integer NOT NULL,
    remote_addr character varying(45),
    remote_port integer,
    state character varying(20),
    pid integer,
    process_name character varying(255),
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: device_disks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_disks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id uuid NOT NULL,
    mount_point character varying(255) NOT NULL,
    device character varying(255),
    fs_type character varying(50),
    total_gb real NOT NULL,
    used_gb real NOT NULL,
    free_gb real NOT NULL,
    used_percent real NOT NULL,
    health character varying(50) DEFAULT 'healthy'::character varying,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: device_event_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_event_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id uuid NOT NULL,
    org_id uuid NOT NULL,
    "timestamp" timestamp without time zone NOT NULL,
    level public.event_log_level NOT NULL,
    category public.event_log_category NOT NULL,
    source character varying(255) NOT NULL,
    event_id character varying(100),
    message text NOT NULL,
    details jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: device_filesystem_cleanup_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_filesystem_cleanup_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id uuid NOT NULL,
    requested_by uuid,
    requested_at timestamp without time zone DEFAULT now() NOT NULL,
    approved_at timestamp without time zone,
    plan jsonb DEFAULT '{}'::jsonb NOT NULL,
    executed_actions jsonb DEFAULT '[]'::jsonb NOT NULL,
    bytes_reclaimed bigint DEFAULT 0 NOT NULL,
    status public.filesystem_cleanup_run_status DEFAULT 'previewed'::public.filesystem_cleanup_run_status NOT NULL,
    error text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: device_filesystem_scan_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_filesystem_scan_state (
    device_id uuid NOT NULL,
    last_run_mode text DEFAULT 'baseline'::text NOT NULL,
    last_baseline_completed_at timestamp without time zone,
    last_disk_used_percent real,
    checkpoint jsonb DEFAULT '{}'::jsonb NOT NULL,
    aggregate jsonb DEFAULT '{}'::jsonb NOT NULL,
    hot_directories jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: device_filesystem_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_filesystem_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id uuid NOT NULL,
    captured_at timestamp without time zone DEFAULT now() NOT NULL,
    trigger public.filesystem_snapshot_trigger DEFAULT 'on_demand'::public.filesystem_snapshot_trigger NOT NULL,
    partial boolean DEFAULT false NOT NULL,
    summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    largest_files jsonb DEFAULT '[]'::jsonb NOT NULL,
    largest_dirs jsonb DEFAULT '[]'::jsonb NOT NULL,
    temp_accumulation jsonb DEFAULT '[]'::jsonb NOT NULL,
    old_downloads jsonb DEFAULT '[]'::jsonb NOT NULL,
    unrotated_logs jsonb DEFAULT '[]'::jsonb NOT NULL,
    trash_usage jsonb DEFAULT '[]'::jsonb NOT NULL,
    duplicate_candidates jsonb DEFAULT '[]'::jsonb NOT NULL,
    cleanup_candidates jsonb DEFAULT '[]'::jsonb NOT NULL,
    errors jsonb DEFAULT '[]'::jsonb NOT NULL,
    raw_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: device_group_memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_group_memberships (
    device_id uuid NOT NULL,
    group_id uuid NOT NULL,
    is_pinned boolean DEFAULT false NOT NULL,
    added_at timestamp without time zone DEFAULT now() NOT NULL,
    added_by public.membership_source DEFAULT 'manual'::public.membership_source NOT NULL
);


--
-- Name: device_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    site_id uuid,
    name character varying(255) NOT NULL,
    type public.device_group_type DEFAULT 'static'::public.device_group_type NOT NULL,
    rules jsonb,
    filter_conditions jsonb,
    filter_fields_used text[] DEFAULT '{}'::text[],
    parent_id uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: device_hardware; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_hardware (
    device_id uuid NOT NULL,
    cpu_model character varying(255),
    cpu_cores integer,
    cpu_threads integer,
    ram_total_mb integer,
    disk_total_gb integer,
    gpu_model character varying(255),
    serial_number character varying(100),
    manufacturer character varying(255),
    model character varying(255),
    bios_version character varying(100),
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: device_metrics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_metrics (
    device_id uuid NOT NULL,
    "timestamp" timestamp without time zone NOT NULL,
    cpu_percent real NOT NULL,
    ram_percent real NOT NULL,
    ram_used_mb integer NOT NULL,
    disk_percent real NOT NULL,
    disk_used_gb real NOT NULL,
    network_in_bytes bigint,
    network_out_bytes bigint,
    bandwidth_in_bps bigint,
    bandwidth_out_bps bigint,
    interface_stats jsonb,
    process_count integer,
    custom_metrics jsonb
);


--
-- Name: device_network; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_network (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id uuid NOT NULL,
    interface_name character varying(100) NOT NULL,
    mac_address character varying(17),
    ip_address character varying(45),
    ip_type character varying(4) DEFAULT 'ipv4'::character varying NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    public_ip character varying(45),
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: device_patches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_patches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id uuid NOT NULL,
    patch_id uuid NOT NULL,
    status public.device_patch_status DEFAULT 'pending'::public.device_patch_status NOT NULL,
    installed_at timestamp without time zone,
    installed_version character varying(100),
    last_checked_at timestamp without time zone,
    failure_count integer DEFAULT 0 NOT NULL,
    last_error text,
    rollback_available boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: device_registry_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_registry_state (
    device_id uuid NOT NULL,
    registry_path text NOT NULL,
    value_name text NOT NULL,
    value_data text,
    value_type character varying(64),
    collected_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: device_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    device_id uuid NOT NULL,
    username character varying(255) NOT NULL,
    session_type public.device_session_type DEFAULT 'console'::public.device_session_type NOT NULL,
    os_session_id character varying(128),
    login_at timestamp without time zone DEFAULT now() NOT NULL,
    logout_at timestamp without time zone,
    duration_seconds integer,
    idle_minutes integer,
    activity_state public.device_session_activity_state,
    login_performance_seconds integer,
    is_active boolean DEFAULT true NOT NULL,
    last_activity_at timestamp without time zone,
    metadata text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: device_software; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_software (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id uuid NOT NULL,
    name character varying(500) NOT NULL,
    version character varying(100),
    publisher character varying(255),
    install_date date,
    install_location text,
    is_system boolean DEFAULT false NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.devices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    site_id uuid NOT NULL,
    agent_id character varying(64) NOT NULL,
    agent_token_hash character varying(64),
    mtls_cert_serial_number character varying(128),
    mtls_cert_expires_at timestamp without time zone,
    mtls_cert_issued_at timestamp without time zone,
    mtls_cert_cf_id character varying(128),
    quarantined_at timestamp without time zone,
    quarantined_reason character varying(255),
    hostname character varying(255) NOT NULL,
    display_name character varying(255),
    os_type public.os_type NOT NULL,
    os_version character varying(100) NOT NULL,
    os_build character varying(100),
    architecture character varying(20) NOT NULL,
    agent_version character varying(20) NOT NULL,
    status public.device_status DEFAULT 'offline'::public.device_status NOT NULL,
    last_seen_at timestamp without time zone,
    enrolled_at timestamp without time zone DEFAULT now() NOT NULL,
    enrolled_by uuid,
    tags text[] DEFAULT '{}'::text[],
    custom_fields jsonb DEFAULT '{}'::jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: discovered_assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.discovered_assets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    site_id uuid NOT NULL,
    ip_address inet NOT NULL,
    mac_address character varying(17),
    hostname character varying(255),
    netbios_name character varying(255),
    asset_type public.discovered_asset_type DEFAULT 'unknown'::public.discovered_asset_type NOT NULL,
    status public.discovered_asset_status DEFAULT 'new'::public.discovered_asset_status NOT NULL,
    manufacturer character varying(255),
    model character varying(255),
    open_ports jsonb,
    os_fingerprint jsonb,
    snmp_data jsonb,
    response_time_ms real,
    linked_device_id uuid,
    first_seen_at timestamp without time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp without time zone,
    last_job_id uuid,
    discovery_methods public.discovery_method[] DEFAULT '{}'::public.discovery_method[],
    notes text,
    tags text[] DEFAULT '{}'::text[],
    ignored_by uuid,
    ignored_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: discovery_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.discovery_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    org_id uuid NOT NULL,
    site_id uuid NOT NULL,
    agent_id character varying(64),
    status public.discovery_job_status DEFAULT 'scheduled'::public.discovery_job_status NOT NULL,
    scheduled_at timestamp without time zone,
    started_at timestamp without time zone,
    completed_at timestamp without time zone,
    hosts_scanned integer,
    hosts_discovered integer,
    new_assets integer,
    errors jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: discovery_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.discovery_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    site_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    enabled boolean DEFAULT true NOT NULL,
    subnets text[] DEFAULT '{}'::text[] NOT NULL,
    exclude_ips text[] DEFAULT '{}'::text[] NOT NULL,
    methods public.discovery_method[] DEFAULT '{}'::public.discovery_method[] NOT NULL,
    port_ranges jsonb,
    snmp_communities text[] DEFAULT '{}'::text[],
    snmp_credentials jsonb,
    schedule jsonb,
    deep_scan boolean DEFAULT false NOT NULL,
    identify_os boolean DEFAULT false NOT NULL,
    resolve_hostnames boolean DEFAULT false NOT NULL,
    timeout integer,
    concurrency integer,
    created_by uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: enrollment_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.enrollment_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    site_id uuid,
    name character varying(255) NOT NULL,
    key character varying(64) NOT NULL,
    usage_count integer DEFAULT 0 NOT NULL,
    max_usage integer,
    expires_at timestamp without time zone,
    created_by uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: escalation_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.escalation_policies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    steps jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: event_bus_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_bus_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    event_type character varying(100) NOT NULL,
    source character varying(100) NOT NULL,
    priority public.event_bus_priority DEFAULT 'normal'::public.event_bus_priority NOT NULL,
    payload jsonb NOT NULL,
    metadata jsonb,
    processed_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: executive_summaries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.executive_summaries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    period_type character varying(50) NOT NULL,
    period_start timestamp without time zone NOT NULL,
    period_end timestamp without time zone NOT NULL,
    device_stats jsonb DEFAULT '{}'::jsonb NOT NULL,
    alert_stats jsonb DEFAULT '{}'::jsonb NOT NULL,
    patch_stats jsonb DEFAULT '{}'::jsonb NOT NULL,
    sla_stats jsonb DEFAULT '{}'::jsonb NOT NULL,
    trends jsonb DEFAULT '{}'::jsonb NOT NULL,
    highlights jsonb DEFAULT '{}'::jsonb NOT NULL,
    generated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: file_transfers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.file_transfers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid,
    device_id uuid NOT NULL,
    user_id uuid NOT NULL,
    direction public.file_transfer_direction NOT NULL,
    remote_path text NOT NULL,
    local_filename character varying(500) NOT NULL,
    size_bytes bigint NOT NULL,
    status public.file_transfer_status DEFAULT 'pending'::public.file_transfer_status NOT NULL,
    progress_percent integer DEFAULT 0 NOT NULL,
    error_message text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    completed_at timestamp without time zone
);


--
-- Name: group_membership_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_membership_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    device_id uuid NOT NULL,
    action public.group_membership_log_action NOT NULL,
    reason public.group_membership_log_reason NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: maintenance_occurrences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maintenance_occurrences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    window_id uuid NOT NULL,
    start_time timestamp without time zone NOT NULL,
    end_time timestamp without time zone NOT NULL,
    status public.maintenance_window_status DEFAULT 'scheduled'::public.maintenance_window_status NOT NULL,
    overrides jsonb,
    actual_start_time timestamp without time zone,
    actual_end_time timestamp without time zone,
    suppressed_alerts boolean DEFAULT false NOT NULL,
    suppressed_patches boolean DEFAULT false NOT NULL,
    notes text,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: maintenance_windows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maintenance_windows (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    start_time timestamp without time zone NOT NULL,
    end_time timestamp without time zone NOT NULL,
    timezone character varying(50) DEFAULT 'UTC'::character varying NOT NULL,
    recurrence public.maintenance_recurrence DEFAULT 'once'::public.maintenance_recurrence NOT NULL,
    recurrence_rule jsonb,
    target_type character varying(50) NOT NULL,
    site_ids uuid[],
    group_ids uuid[],
    device_ids uuid[],
    suppress_alerts boolean DEFAULT false NOT NULL,
    suppress_patching boolean DEFAULT false NOT NULL,
    suppress_automations boolean DEFAULT false NOT NULL,
    suppress_scripts boolean DEFAULT false NOT NULL,
    allowed_alert_severities public.alert_severity[],
    allowed_actions jsonb,
    status public.maintenance_window_status DEFAULT 'scheduled'::public.maintenance_window_status NOT NULL,
    notify_before integer,
    notify_on_start boolean DEFAULT false NOT NULL,
    notify_on_end boolean DEFAULT false NOT NULL,
    notification_channels jsonb,
    created_by uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: manual_sql_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.manual_sql_migrations (
    filename text NOT NULL,
    checksum text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mobile_devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mobile_devices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    device_id character varying(255) NOT NULL,
    platform public.device_platform NOT NULL,
    model character varying(255),
    os_version character varying(100),
    app_version character varying(50),
    fcm_token text,
    apns_token text,
    notifications_enabled boolean DEFAULT true NOT NULL,
    alert_severities public.alert_severity[] DEFAULT '{}'::public.alert_severity[] NOT NULL,
    quiet_hours jsonb,
    last_active_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: mobile_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mobile_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    mobile_device_id uuid NOT NULL,
    refresh_token text NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    last_used_at timestamp without time zone,
    ip_address character varying(45),
    revoked_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: network_monitor_alert_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.network_monitor_alert_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    monitor_id uuid NOT NULL,
    condition character varying(50) NOT NULL,
    threshold character varying(100),
    severity public.alert_severity NOT NULL,
    message text,
    is_active boolean DEFAULT true NOT NULL
);


--
-- Name: network_monitor_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.network_monitor_results (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    monitor_id uuid NOT NULL,
    status public.monitor_status NOT NULL,
    response_ms real,
    status_code integer,
    error text,
    details jsonb,
    "timestamp" timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: network_monitors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.network_monitors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    asset_id uuid,
    name character varying(200) NOT NULL,
    monitor_type public.monitor_type NOT NULL,
    target character varying(500) NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    polling_interval integer DEFAULT 60 NOT NULL,
    timeout integer DEFAULT 5 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    last_checked timestamp without time zone,
    last_status public.monitor_status DEFAULT 'unknown'::public.monitor_status NOT NULL,
    last_response_ms real,
    last_error text,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: network_topology; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.network_topology (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    site_id uuid NOT NULL,
    source_type character varying(50) NOT NULL,
    source_id uuid NOT NULL,
    target_type character varying(50) NOT NULL,
    target_id uuid NOT NULL,
    connection_type character varying(50) NOT NULL,
    interface_name character varying(100),
    vlan integer,
    bandwidth integer,
    latency real,
    last_verified_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: notification_channels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_channels (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    type public.notification_channel_type NOT NULL,
    config jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: organization_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization_users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role_id uuid NOT NULL,
    site_ids uuid[],
    device_group_ids uuid[],
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: organizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organizations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    partner_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    slug character varying(100) NOT NULL,
    type public.org_type DEFAULT 'customer'::public.org_type NOT NULL,
    status public.org_status DEFAULT 'active'::public.org_status NOT NULL,
    max_devices integer,
    settings jsonb DEFAULT '{}'::jsonb,
    sso_config jsonb,
    contract_start timestamp without time zone,
    contract_end timestamp without time zone,
    billing_contact jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    deleted_at timestamp without time zone
);


--
-- Name: partner_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.partner_users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    partner_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role_id uuid NOT NULL,
    org_access public.org_access DEFAULT 'none'::public.org_access NOT NULL,
    org_ids uuid[],
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: partners; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.partners (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    slug character varying(100) NOT NULL,
    type public.partner_type DEFAULT 'msp'::public.partner_type NOT NULL,
    plan public.plan_type DEFAULT 'free'::public.plan_type NOT NULL,
    max_organizations integer,
    max_devices integer,
    settings jsonb DEFAULT '{}'::jsonb,
    sso_config jsonb,
    billing_email character varying(255),
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    deleted_at timestamp without time zone
);


--
-- Name: patch_approvals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.patch_approvals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    patch_id uuid NOT NULL,
    policy_id uuid,
    status public.patch_approval_status DEFAULT 'pending'::public.patch_approval_status NOT NULL,
    approved_by uuid,
    approved_at timestamp without time zone,
    defer_until timestamp without time zone,
    notes text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: patch_compliance_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.patch_compliance_reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    requested_by uuid,
    status public.patch_compliance_report_status DEFAULT 'pending'::public.patch_compliance_report_status NOT NULL,
    format public.patch_compliance_report_format DEFAULT 'csv'::public.patch_compliance_report_format NOT NULL,
    source public.patch_source,
    severity public.patch_severity,
    summary jsonb,
    row_count integer,
    output_path text,
    error_message text,
    started_at timestamp without time zone,
    completed_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: patch_compliance_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.patch_compliance_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    snapshot_date date NOT NULL,
    total_devices integer DEFAULT 0 NOT NULL,
    compliant_devices integer DEFAULT 0 NOT NULL,
    non_compliant_devices integer DEFAULT 0 NOT NULL,
    critical_missing integer DEFAULT 0 NOT NULL,
    important_missing integer DEFAULT 0 NOT NULL,
    patches_pending_approval integer DEFAULT 0 NOT NULL,
    patches_installed_24h integer DEFAULT 0 NOT NULL,
    failed_installs_24h integer DEFAULT 0 NOT NULL,
    details_by_category jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: patch_job_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.patch_job_results (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    device_id uuid NOT NULL,
    patch_id uuid NOT NULL,
    status public.patch_job_result_status DEFAULT 'pending'::public.patch_job_result_status NOT NULL,
    started_at timestamp without time zone,
    completed_at timestamp without time zone,
    exit_code integer,
    output text,
    error_message text,
    reboot_required boolean DEFAULT false NOT NULL,
    rebooted_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: patch_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.patch_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    policy_id uuid,
    name character varying(255) NOT NULL,
    patches jsonb DEFAULT '{}'::jsonb NOT NULL,
    targets jsonb DEFAULT '{}'::jsonb NOT NULL,
    status public.patch_job_status DEFAULT 'scheduled'::public.patch_job_status NOT NULL,
    scheduled_at timestamp without time zone,
    started_at timestamp without time zone,
    completed_at timestamp without time zone,
    devices_total integer DEFAULT 0 NOT NULL,
    devices_completed integer DEFAULT 0 NOT NULL,
    devices_failed integer DEFAULT 0 NOT NULL,
    devices_pending integer DEFAULT 0 NOT NULL,
    created_by uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: patch_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.patch_policies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    enabled boolean DEFAULT true NOT NULL,
    targets jsonb DEFAULT '{}'::jsonb NOT NULL,
    sources public.patch_source[],
    auto_approve jsonb DEFAULT '{}'::jsonb NOT NULL,
    schedule jsonb DEFAULT '{}'::jsonb NOT NULL,
    reboot_policy jsonb DEFAULT '{}'::jsonb NOT NULL,
    rollback_on_failure boolean DEFAULT false NOT NULL,
    pre_install_script_id uuid,
    post_install_script_id uuid,
    notify_on_complete boolean DEFAULT false NOT NULL,
    created_by uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: patch_rollbacks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.patch_rollbacks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id uuid NOT NULL,
    patch_id uuid NOT NULL,
    original_job_id uuid,
    reason text,
    status public.patch_rollback_status DEFAULT 'pending'::public.patch_rollback_status NOT NULL,
    started_at timestamp without time zone,
    completed_at timestamp without time zone,
    output text,
    error_message text,
    initiated_by uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: patches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.patches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source public.patch_source NOT NULL,
    external_id character varying(255) NOT NULL,
    title character varying(500) NOT NULL,
    description text,
    severity public.patch_severity,
    category character varying(100),
    os_types text[],
    os_versions text[],
    architecture text[],
    release_date date,
    kb_article_url text,
    supersedes text[],
    superseded_by text,
    requires_reboot boolean DEFAULT false NOT NULL,
    download_url text,
    download_size_mb integer,
    install_command text,
    uninstall_command text,
    detect_script text,
    metadata jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.permissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    resource character varying(100) NOT NULL,
    action character varying(50) NOT NULL,
    description text
);


--
-- Name: plugin_catalog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plugin_catalog (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug character varying(100) NOT NULL,
    name character varying(255) NOT NULL,
    version character varying(50) NOT NULL,
    description text,
    type public.plugin_type NOT NULL,
    author character varying(255),
    author_url text,
    homepage text,
    repository text,
    license character varying(100),
    manifest_url text,
    download_url text,
    checksum character varying(128),
    min_agent_version character varying(50),
    min_api_version character varying(50),
    dependencies jsonb,
    permissions jsonb,
    hooks jsonb,
    icon_url text,
    screenshot_urls text[] DEFAULT '{}'::text[],
    category character varying(100),
    tags text[] DEFAULT '{}'::text[],
    install_count integer DEFAULT 0 NOT NULL,
    rating real DEFAULT 0 NOT NULL,
    is_verified boolean DEFAULT false NOT NULL,
    is_featured boolean DEFAULT false NOT NULL,
    is_deprecated boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: plugin_installations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plugin_installations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    catalog_id uuid NOT NULL,
    version character varying(50) NOT NULL,
    status public.plugin_install_status DEFAULT 'installed'::public.plugin_install_status NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    permissions jsonb,
    sandbox_enabled boolean DEFAULT true NOT NULL,
    resource_limits jsonb,
    installed_at timestamp without time zone,
    installed_by uuid,
    last_active_at timestamp without time zone,
    error_message text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: plugin_instances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plugin_instances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    plugin_id uuid NOT NULL,
    org_id uuid NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: plugin_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plugin_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    installation_id uuid NOT NULL,
    level character varying(20) NOT NULL,
    message text NOT NULL,
    context jsonb,
    "timestamp" timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: plugins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plugins (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    slug character varying(100) NOT NULL,
    version character varying(50) NOT NULL,
    description text,
    author character varying(255),
    homepage text,
    manifest_url text,
    entry_point text,
    permissions jsonb,
    hooks jsonb,
    settings jsonb,
    status public.plugin_status DEFAULT 'active'::public.plugin_status NOT NULL,
    is_system boolean DEFAULT false NOT NULL,
    installed_at timestamp without time zone,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    error_message text,
    last_active_at timestamp without time zone
);


--
-- Name: policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.policies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name character varying(200) NOT NULL,
    description text,
    type public.policy_type NOT NULL,
    status public.policy_status DEFAULT 'draft'::public.policy_status NOT NULL,
    priority integer DEFAULT 50 NOT NULL,
    settings jsonb NOT NULL,
    conditions jsonb,
    version integer DEFAULT 1 NOT NULL,
    parent_id uuid,
    created_by uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: policy_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.policy_assignments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    policy_id uuid NOT NULL,
    target_type character varying(50) NOT NULL,
    target_id uuid NOT NULL,
    priority integer NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: policy_compliance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.policy_compliance (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    policy_id uuid NOT NULL,
    device_id uuid NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    last_checked timestamp without time zone,
    details jsonb,
    remediation_attempts integer DEFAULT 0 NOT NULL
);


--
-- Name: policy_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.policy_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(200) NOT NULL,
    description text,
    type public.policy_type NOT NULL,
    category character varying(100),
    settings jsonb NOT NULL,
    is_built_in boolean DEFAULT false NOT NULL,
    usage_count integer DEFAULT 0 NOT NULL
);


--
-- Name: policy_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.policy_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    policy_id uuid NOT NULL,
    version integer NOT NULL,
    settings jsonb NOT NULL,
    conditions jsonb,
    changelog text,
    created_by uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: portal_branding; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portal_branding (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    logo_url text,
    favicon_url text,
    primary_color character varying(50),
    secondary_color character varying(50),
    accent_color character varying(50),
    custom_domain character varying(255),
    domain_verified boolean DEFAULT false NOT NULL,
    welcome_message text,
    support_email character varying(255),
    support_phone character varying(50),
    footer_text text,
    custom_css text,
    enable_tickets boolean DEFAULT true NOT NULL,
    enable_asset_checkout boolean DEFAULT true NOT NULL,
    enable_self_service boolean DEFAULT true NOT NULL,
    enable_password_reset boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: portal_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portal_users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    email character varying(255) NOT NULL,
    name character varying(255),
    password_hash text,
    linked_user_id uuid,
    receive_notifications boolean DEFAULT true NOT NULL,
    last_login_at timestamp without time zone,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: psa_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.psa_connections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    provider public.psa_provider NOT NULL,
    name character varying(255) NOT NULL,
    credentials jsonb NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb,
    sync_settings jsonb DEFAULT '{}'::jsonb,
    enabled boolean DEFAULT true NOT NULL,
    last_sync_at timestamp without time zone,
    last_sync_status character varying(50),
    last_sync_error text,
    created_by uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: psa_ticket_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.psa_ticket_mappings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    connection_id uuid NOT NULL,
    alert_id uuid,
    device_id uuid,
    external_ticket_id character varying(100),
    external_ticket_url text,
    status character varying(50),
    last_sync_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: push_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.push_notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    mobile_device_id uuid NOT NULL,
    user_id uuid NOT NULL,
    title character varying(255) NOT NULL,
    body text,
    data jsonb,
    platform public.device_platform NOT NULL,
    message_id character varying(255),
    status character varying(50),
    sent_at timestamp without time zone,
    delivered_at timestamp without time zone,
    read_at timestamp without time zone,
    error_message text,
    alert_id uuid,
    event_type character varying(100),
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: remote_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.remote_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id uuid NOT NULL,
    user_id uuid NOT NULL,
    type public.remote_session_type NOT NULL,
    status public.remote_session_status DEFAULT 'pending'::public.remote_session_status NOT NULL,
    webrtc_offer text,
    webrtc_answer text,
    ice_candidates jsonb DEFAULT '[]'::jsonb,
    started_at timestamp without time zone,
    ended_at timestamp without time zone,
    duration_seconds integer,
    bytes_transferred bigint,
    recording_url text,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: report_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    report_id uuid NOT NULL,
    status public.report_run_status DEFAULT 'pending'::public.report_run_status NOT NULL,
    started_at timestamp without time zone,
    completed_at timestamp without time zone,
    output_url text,
    error_message text,
    row_count integer,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    type public.report_type NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    schedule public.report_schedule DEFAULT 'one_time'::public.report_schedule NOT NULL,
    format public.report_format DEFAULT 'csv'::public.report_format NOT NULL,
    last_generated_at timestamp without time zone,
    created_by uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: restore_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.restore_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    snapshot_id uuid NOT NULL,
    device_id uuid NOT NULL,
    restore_type public.restore_type NOT NULL,
    target_path text,
    selected_paths jsonb DEFAULT '[]'::jsonb,
    status public.backup_status DEFAULT 'pending'::public.backup_status NOT NULL,
    started_at timestamp without time zone,
    completed_at timestamp without time zone,
    restored_size bigint,
    restored_files integer,
    initiated_by uuid
);


--
-- Name: role_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role_permissions (
    role_id uuid NOT NULL,
    permission_id uuid NOT NULL,
    constraints jsonb
);


--
-- Name: roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    partner_id uuid,
    org_id uuid,
    parent_role_id uuid,
    scope public.role_scope NOT NULL,
    name character varying(100) NOT NULL,
    description text,
    is_system boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: saved_filters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.saved_filters (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name character varying(200) NOT NULL,
    description text,
    conditions jsonb NOT NULL,
    created_by uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: saved_queries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.saved_queries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    metric_types text[] DEFAULT '{}'::text[],
    metric_names text[] DEFAULT '{}'::text[],
    aggregation character varying(50),
    group_by text[] DEFAULT '{}'::text[],
    filters jsonb DEFAULT '{}'::jsonb NOT NULL,
    time_range jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_shared boolean DEFAULT false NOT NULL,
    created_by uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: script_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.script_categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid,
    name character varying(100) NOT NULL,
    description text,
    icon character varying(50),
    color character varying(7),
    parent_id uuid,
    "order" integer DEFAULT 0 NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: script_execution_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.script_execution_batches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    script_id uuid NOT NULL,
    triggered_by uuid,
    trigger_type public.trigger_type DEFAULT 'manual'::public.trigger_type NOT NULL,
    parameters jsonb,
    devices_targeted integer NOT NULL,
    devices_completed integer DEFAULT 0 NOT NULL,
    devices_failed integer DEFAULT 0 NOT NULL,
    status public.execution_status DEFAULT 'pending'::public.execution_status NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    completed_at timestamp without time zone
);


--
-- Name: script_executions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.script_executions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    script_id uuid NOT NULL,
    device_id uuid NOT NULL,
    triggered_by uuid,
    trigger_type public.trigger_type DEFAULT 'manual'::public.trigger_type NOT NULL,
    parameters jsonb,
    status public.execution_status DEFAULT 'pending'::public.execution_status NOT NULL,
    started_at timestamp without time zone,
    completed_at timestamp without time zone,
    exit_code integer,
    stdout text,
    stderr text,
    error_message text,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: script_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.script_tags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid,
    name character varying(50) NOT NULL,
    color character varying(7)
);


--
-- Name: script_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.script_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(200) NOT NULL,
    description text,
    category character varying(100),
    language public.script_language,
    content text NOT NULL,
    parameters jsonb,
    is_built_in boolean DEFAULT false NOT NULL,
    downloads integer DEFAULT 0 NOT NULL,
    rating numeric(2,1)
);


--
-- Name: script_to_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.script_to_tags (
    script_id uuid NOT NULL,
    tag_id uuid NOT NULL
);


--
-- Name: script_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.script_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    script_id uuid NOT NULL,
    version integer NOT NULL,
    content text NOT NULL,
    changelog text,
    created_by uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: scripts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scripts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid,
    name character varying(255) NOT NULL,
    description text,
    category character varying(100),
    os_types text[] NOT NULL,
    language public.script_language NOT NULL,
    content text NOT NULL,
    parameters jsonb,
    timeout_seconds integer DEFAULT 300 NOT NULL,
    run_as public.script_run_as DEFAULT 'system'::public.script_run_as NOT NULL,
    is_system boolean DEFAULT false NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: security_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.security_policies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: security_posture_org_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.security_posture_org_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    captured_at timestamp without time zone DEFAULT now() NOT NULL,
    overall_score integer NOT NULL,
    devices_audited integer DEFAULT 0 NOT NULL,
    low_risk_devices integer DEFAULT 0 NOT NULL,
    medium_risk_devices integer DEFAULT 0 NOT NULL,
    high_risk_devices integer DEFAULT 0 NOT NULL,
    critical_risk_devices integer DEFAULT 0 NOT NULL,
    patch_compliance_score integer NOT NULL,
    encryption_score integer NOT NULL,
    av_health_score integer NOT NULL,
    firewall_score integer NOT NULL,
    open_ports_score integer NOT NULL,
    password_policy_score integer NOT NULL,
    os_currency_score integer NOT NULL,
    admin_exposure_score integer NOT NULL,
    top_issues jsonb DEFAULT '[]'::jsonb NOT NULL,
    summary jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: security_posture_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.security_posture_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    device_id uuid NOT NULL,
    captured_at timestamp without time zone DEFAULT now() NOT NULL,
    overall_score integer NOT NULL,
    risk_level public.security_risk_level NOT NULL,
    patch_compliance_score integer NOT NULL,
    encryption_score integer NOT NULL,
    av_health_score integer NOT NULL,
    firewall_score integer NOT NULL,
    open_ports_score integer NOT NULL,
    password_policy_score integer NOT NULL,
    os_currency_score integer NOT NULL,
    admin_exposure_score integer NOT NULL,
    factor_details jsonb DEFAULT '{}'::jsonb NOT NULL,
    recommendations jsonb DEFAULT '[]'::jsonb NOT NULL
);


--
-- Name: security_scans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.security_scans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id uuid NOT NULL,
    scan_type character varying(50) NOT NULL,
    status character varying(20) NOT NULL,
    started_at timestamp without time zone,
    completed_at timestamp without time zone,
    items_scanned integer,
    threats_found integer,
    duration integer,
    initiated_by uuid
);


--
-- Name: security_status; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.security_status (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id uuid NOT NULL,
    provider public.security_provider NOT NULL,
    provider_version character varying(50),
    definitions_version character varying(100),
    definitions_date timestamp without time zone,
    real_time_protection boolean,
    last_scan timestamp without time zone,
    last_scan_type character varying(50),
    threat_count integer DEFAULT 0 NOT NULL,
    firewall_enabled boolean,
    encryption_status character varying(50),
    encryption_details jsonb,
    local_admin_summary jsonb,
    password_policy_summary jsonb,
    gatekeeper_enabled boolean,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: security_threats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.security_threats (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id uuid NOT NULL,
    provider public.security_provider NOT NULL,
    threat_name character varying(200) NOT NULL,
    threat_type character varying(100),
    severity public.threat_severity NOT NULL,
    status public.threat_status NOT NULL,
    file_path text,
    process_name character varying(200),
    detected_at timestamp without time zone NOT NULL,
    resolved_at timestamp without time zone,
    resolved_by character varying(100),
    details jsonb
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    ip_address character varying(45),
    user_agent text,
    expires_at timestamp without time zone NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: sites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    address jsonb,
    timezone character varying(50) DEFAULT 'UTC'::character varying NOT NULL,
    contact jsonb,
    settings jsonb DEFAULT '{}'::jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: sla_compliance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sla_compliance (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sla_id uuid NOT NULL,
    org_id uuid NOT NULL,
    period_start timestamp without time zone NOT NULL,
    period_end timestamp without time zone NOT NULL,
    uptime_actual double precision,
    response_time_actual double precision,
    resolution_time_actual double precision,
    uptime_compliant boolean,
    response_time_compliant boolean,
    resolution_time_compliant boolean,
    overall_compliant boolean,
    total_downtime_minutes integer,
    incident_count integer,
    excluded_minutes integer,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    calculated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: sla_definitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sla_definitions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    uptime_target double precision,
    response_time_target double precision,
    resolution_time_target double precision,
    measurement_window character varying(50),
    exclude_maintenance_windows boolean DEFAULT false NOT NULL,
    exclude_weekends boolean DEFAULT false NOT NULL,
    target_type character varying(50),
    target_ids uuid[],
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: snmp_alert_thresholds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.snmp_alert_thresholds (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id uuid NOT NULL,
    oid character varying(200) NOT NULL,
    operator character varying(10),
    threshold character varying(100),
    severity public.alert_severity NOT NULL,
    message text,
    is_active boolean DEFAULT true NOT NULL
);


--
-- Name: snmp_devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.snmp_devices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    asset_id uuid,
    name character varying(200) NOT NULL,
    ip_address character varying(45) NOT NULL,
    snmp_version character varying(10) NOT NULL,
    port integer DEFAULT 161 NOT NULL,
    community character varying(100),
    auth_protocol character varying(20),
    auth_password text,
    priv_protocol character varying(20),
    priv_password text,
    username character varying(100),
    polling_interval integer DEFAULT 300 NOT NULL,
    template_id uuid,
    is_active boolean DEFAULT true NOT NULL,
    last_polled timestamp without time zone,
    last_status character varying(20),
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: snmp_metrics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.snmp_metrics (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id uuid NOT NULL,
    oid character varying(200) NOT NULL,
    name character varying(100) NOT NULL,
    value text,
    value_type character varying(20),
    "timestamp" timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: snmp_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.snmp_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(200) NOT NULL,
    description text,
    vendor character varying(100),
    device_type character varying(100),
    oids jsonb NOT NULL,
    is_built_in boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: software_catalog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.software_catalog (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(200) NOT NULL,
    vendor character varying(200),
    description text,
    category character varying(100),
    icon_url text,
    website_url text,
    is_managed boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: software_compliance_status; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.software_compliance_status (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id uuid NOT NULL,
    policy_id uuid NOT NULL,
    status character varying(20) DEFAULT 'compliant'::character varying NOT NULL,
    last_checked timestamp without time zone NOT NULL,
    violations jsonb,
    remediation_status character varying(20) DEFAULT 'none'::character varying,
    last_remediation_attempt timestamp without time zone,
    remediation_errors jsonb
);


--
-- Name: software_deployments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.software_deployments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    software_version_id uuid NOT NULL,
    deployment_type character varying(20) NOT NULL,
    target_type character varying(50) NOT NULL,
    target_ids jsonb,
    schedule_type character varying(30) NOT NULL,
    scheduled_at timestamp without time zone,
    maintenance_window_id uuid,
    options jsonb,
    created_by uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: software_inventory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.software_inventory (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id uuid NOT NULL,
    catalog_id uuid,
    name character varying(500) NOT NULL,
    version character varying(100),
    vendor character varying(200),
    install_date date,
    install_location text,
    uninstall_string text,
    is_managed boolean DEFAULT false NOT NULL,
    last_seen timestamp without time zone
);


--
-- Name: software_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.software_policies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name character varying(200) NOT NULL,
    description text,
    mode public.software_policy_mode NOT NULL,
    rules jsonb NOT NULL,
    target_type character varying(50) NOT NULL,
    target_ids jsonb,
    priority integer DEFAULT 50 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    enforce_mode boolean DEFAULT false NOT NULL,
    remediation_options jsonb,
    created_by uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: software_policy_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.software_policy_audit (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    policy_id uuid,
    device_id uuid,
    action character varying(50) NOT NULL,
    actor character varying(50) NOT NULL,
    actor_id uuid,
    details jsonb,
    "timestamp" timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: software_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.software_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    catalog_id uuid NOT NULL,
    version character varying(100) NOT NULL,
    release_date timestamp without time zone,
    release_notes text,
    download_url text,
    checksum character varying(128),
    file_size bigint,
    supported_os jsonb,
    architecture character varying(20),
    silent_install_args text,
    silent_uninstall_args text,
    pre_install_script text,
    post_install_script text,
    is_latest boolean DEFAULT false NOT NULL
);


--
-- Name: sso_providers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sso_providers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    type public.sso_provider_type NOT NULL,
    status public.sso_provider_status DEFAULT 'inactive'::public.sso_provider_status NOT NULL,
    issuer character varying(500),
    client_id character varying(255),
    client_secret text,
    authorization_url character varying(500),
    token_url character varying(500),
    userinfo_url character varying(500),
    jwks_url character varying(500),
    scopes character varying(500) DEFAULT 'openid profile email'::character varying,
    entity_id character varying(500),
    sso_url character varying(500),
    certificate text,
    attribute_mapping jsonb DEFAULT '{"name": "name", "email": "email"}'::jsonb,
    auto_provision boolean DEFAULT true NOT NULL,
    default_role_id uuid,
    allowed_domains character varying(1000),
    enforce_sso boolean DEFAULT false NOT NULL,
    created_by uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: sso_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sso_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_id uuid NOT NULL,
    state character varying(64) NOT NULL,
    nonce character varying(64) NOT NULL,
    code_verifier character varying(128),
    redirect_url character varying(500),
    expires_at timestamp without time zone NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: ticket_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ticket_comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ticket_id uuid NOT NULL,
    portal_user_id uuid,
    user_id uuid,
    author_name character varying(255),
    author_type character varying(50),
    content text NOT NULL,
    is_public boolean DEFAULT true NOT NULL,
    attachments jsonb DEFAULT '[]'::jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: tickets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tickets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    ticket_number character varying(50) NOT NULL,
    submitted_by uuid,
    submitter_email character varying(255),
    submitter_name character varying(255),
    subject character varying(255) NOT NULL,
    description text,
    category character varying(100),
    status public.ticket_status DEFAULT 'new'::public.ticket_status NOT NULL,
    priority public.ticket_priority DEFAULT 'normal'::public.ticket_priority NOT NULL,
    assigned_to uuid,
    assigned_team uuid,
    device_id uuid,
    tags text[] DEFAULT '{}'::text[],
    custom_fields jsonb,
    external_ticket_id character varying(255),
    external_ticket_url text,
    first_response_at timestamp without time zone,
    resolved_at timestamp without time zone,
    closed_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: time_series_metrics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.time_series_metrics (
    "timestamp" timestamp without time zone NOT NULL,
    org_id uuid NOT NULL,
    device_id uuid NOT NULL,
    metric_type character varying(100) NOT NULL,
    metric_name character varying(255) NOT NULL,
    value double precision NOT NULL,
    unit character varying(50),
    tags jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: user_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    org_id uuid,
    type public.notification_type NOT NULL,
    priority public.notification_priority DEFAULT 'normal'::public.notification_priority NOT NULL,
    title character varying(255) NOT NULL,
    message text,
    link character varying(500),
    metadata jsonb,
    read boolean DEFAULT false NOT NULL,
    read_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: user_sso_identities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_sso_identities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    provider_id uuid NOT NULL,
    external_id character varying(255) NOT NULL,
    email character varying(255) NOT NULL,
    profile jsonb,
    access_token text,
    refresh_token text,
    token_expires_at timestamp without time zone,
    last_login_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    password_hash text,
    mfa_secret text,
    mfa_enabled boolean DEFAULT false NOT NULL,
    mfa_recovery_codes jsonb,
    phone_number text,
    phone_verified boolean DEFAULT false NOT NULL,
    mfa_method public.mfa_method,
    status public.user_status DEFAULT 'invited'::public.user_status NOT NULL,
    avatar_url text,
    last_login_at timestamp without time zone,
    password_changed_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    setup_completed_at timestamp with time zone
);


--
-- Name: webhook_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webhook_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    webhook_id uuid NOT NULL,
    event_type character varying(100) NOT NULL,
    event_id character varying(100) NOT NULL,
    payload jsonb NOT NULL,
    status public.webhook_delivery_status DEFAULT 'pending'::public.webhook_delivery_status NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_retry_at timestamp without time zone,
    response_status integer,
    response_body text,
    response_time_ms integer,
    error_message text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    delivered_at timestamp without time zone
);


--
-- Name: webhooks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webhooks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    url text NOT NULL,
    secret text,
    events text[] DEFAULT '{}'::text[] NOT NULL,
    headers jsonb,
    status public.webhook_status DEFAULT 'active'::public.webhook_status NOT NULL,
    retry_policy jsonb,
    success_count integer DEFAULT 0 NOT NULL,
    failure_count integer DEFAULT 0 NOT NULL,
    last_delivery_at timestamp without time zone,
    last_success_at timestamp without time zone,
    created_by uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: access_review_items access_review_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_review_items
    ADD CONSTRAINT access_review_items_pkey PRIMARY KEY (id);


--
-- Name: access_reviews access_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_reviews
    ADD CONSTRAINT access_reviews_pkey PRIMARY KEY (id);


--
-- Name: agent_versions agent_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_versions
    ADD CONSTRAINT agent_versions_pkey PRIMARY KEY (id);


--
-- Name: agent_versions agent_versions_version_platform_arch_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_versions
    ADD CONSTRAINT agent_versions_version_platform_arch_unique UNIQUE (version, platform, architecture);


--
-- Name: ai_budgets ai_budgets_org_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_budgets
    ADD CONSTRAINT ai_budgets_org_id_unique UNIQUE (org_id);


--
-- Name: ai_budgets ai_budgets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_budgets
    ADD CONSTRAINT ai_budgets_pkey PRIMARY KEY (id);


--
-- Name: ai_cost_usage ai_cost_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_cost_usage
    ADD CONSTRAINT ai_cost_usage_pkey PRIMARY KEY (id);


--
-- Name: ai_messages ai_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_messages
    ADD CONSTRAINT ai_messages_pkey PRIMARY KEY (id);


--
-- Name: ai_sessions ai_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_sessions
    ADD CONSTRAINT ai_sessions_pkey PRIMARY KEY (id);


--
-- Name: ai_tool_executions ai_tool_executions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_tool_executions
    ADD CONSTRAINT ai_tool_executions_pkey PRIMARY KEY (id);


--
-- Name: alert_correlations alert_correlations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_correlations
    ADD CONSTRAINT alert_correlations_pkey PRIMARY KEY (id);


--
-- Name: alert_notifications alert_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_notifications
    ADD CONSTRAINT alert_notifications_pkey PRIMARY KEY (id);


--
-- Name: alert_rules alert_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_rules
    ADD CONSTRAINT alert_rules_pkey PRIMARY KEY (id);


--
-- Name: alert_templates alert_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_templates
    ADD CONSTRAINT alert_templates_pkey PRIMARY KEY (id);


--
-- Name: alerts alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_pkey PRIMARY KEY (id);


--
-- Name: analytics_dashboards analytics_dashboards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_dashboards
    ADD CONSTRAINT analytics_dashboards_pkey PRIMARY KEY (id);


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: asset_checkouts asset_checkouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_checkouts
    ADD CONSTRAINT asset_checkouts_pkey PRIMARY KEY (id);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: audit_retention_policies audit_retention_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_retention_policies
    ADD CONSTRAINT audit_retention_policies_pkey PRIMARY KEY (id);


--
-- Name: automation_policies automation_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_policies
    ADD CONSTRAINT automation_policies_pkey PRIMARY KEY (id);


--
-- Name: automation_policy_compliance automation_policy_compliance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_policy_compliance
    ADD CONSTRAINT automation_policy_compliance_pkey PRIMARY KEY (id);


--
-- Name: automation_runs automation_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_runs
    ADD CONSTRAINT automation_runs_pkey PRIMARY KEY (id);


--
-- Name: automations automations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automations
    ADD CONSTRAINT automations_pkey PRIMARY KEY (id);


--
-- Name: backup_configs backup_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_configs
    ADD CONSTRAINT backup_configs_pkey PRIMARY KEY (id);


--
-- Name: backup_jobs backup_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_jobs
    ADD CONSTRAINT backup_jobs_pkey PRIMARY KEY (id);


--
-- Name: backup_policies backup_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_policies
    ADD CONSTRAINT backup_policies_pkey PRIMARY KEY (id);


--
-- Name: backup_snapshots backup_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_snapshots
    ADD CONSTRAINT backup_snapshots_pkey PRIMARY KEY (id);


--
-- Name: capacity_predictions capacity_predictions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.capacity_predictions
    ADD CONSTRAINT capacity_predictions_pkey PRIMARY KEY (id);


--
-- Name: capacity_thresholds capacity_thresholds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.capacity_thresholds
    ADD CONSTRAINT capacity_thresholds_pkey PRIMARY KEY (id);


--
-- Name: custom_field_definitions custom_field_definitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_field_definitions
    ADD CONSTRAINT custom_field_definitions_pkey PRIMARY KEY (id);


--
-- Name: dashboard_widgets dashboard_widgets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dashboard_widgets
    ADD CONSTRAINT dashboard_widgets_pkey PRIMARY KEY (id);


--
-- Name: deployment_devices deployment_devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployment_devices
    ADD CONSTRAINT deployment_devices_pkey PRIMARY KEY (id);


--
-- Name: deployment_results deployment_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployment_results
    ADD CONSTRAINT deployment_results_pkey PRIMARY KEY (id);


--
-- Name: deployments deployments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployments
    ADD CONSTRAINT deployments_pkey PRIMARY KEY (id);


--
-- Name: device_commands device_commands_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_commands
    ADD CONSTRAINT device_commands_pkey PRIMARY KEY (id);


--
-- Name: device_config_state device_config_state_device_id_file_path_config_key_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_config_state
    ADD CONSTRAINT device_config_state_device_id_file_path_config_key_pk PRIMARY KEY (device_id, file_path, config_key);


--
-- Name: device_connections device_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_connections
    ADD CONSTRAINT device_connections_pkey PRIMARY KEY (id);


--
-- Name: device_disks device_disks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_disks
    ADD CONSTRAINT device_disks_pkey PRIMARY KEY (id);


--
-- Name: device_event_logs device_event_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_event_logs
    ADD CONSTRAINT device_event_logs_pkey PRIMARY KEY (id);


--
-- Name: device_filesystem_cleanup_runs device_filesystem_cleanup_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_filesystem_cleanup_runs
    ADD CONSTRAINT device_filesystem_cleanup_runs_pkey PRIMARY KEY (id);


--
-- Name: device_filesystem_scan_state device_filesystem_scan_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_filesystem_scan_state
    ADD CONSTRAINT device_filesystem_scan_state_pkey PRIMARY KEY (device_id);


--
-- Name: device_filesystem_snapshots device_filesystem_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_filesystem_snapshots
    ADD CONSTRAINT device_filesystem_snapshots_pkey PRIMARY KEY (id);


--
-- Name: device_group_memberships device_group_memberships_device_id_group_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_group_memberships
    ADD CONSTRAINT device_group_memberships_device_id_group_id_pk PRIMARY KEY (device_id, group_id);


--
-- Name: device_groups device_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_groups
    ADD CONSTRAINT device_groups_pkey PRIMARY KEY (id);


--
-- Name: device_hardware device_hardware_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_hardware
    ADD CONSTRAINT device_hardware_pkey PRIMARY KEY (device_id);


--
-- Name: device_metrics device_metrics_device_id_timestamp_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_metrics
    ADD CONSTRAINT device_metrics_device_id_timestamp_pk PRIMARY KEY (device_id, "timestamp");


--
-- Name: device_network device_network_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_network
    ADD CONSTRAINT device_network_pkey PRIMARY KEY (id);


--
-- Name: device_patches device_patches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_patches
    ADD CONSTRAINT device_patches_pkey PRIMARY KEY (id);


--
-- Name: device_registry_state device_registry_state_device_id_registry_path_value_name_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_registry_state
    ADD CONSTRAINT device_registry_state_device_id_registry_path_value_name_pk PRIMARY KEY (device_id, registry_path, value_name);


--
-- Name: device_sessions device_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_sessions
    ADD CONSTRAINT device_sessions_pkey PRIMARY KEY (id);


--
-- Name: device_software device_software_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_software
    ADD CONSTRAINT device_software_pkey PRIMARY KEY (id);


--
-- Name: devices devices_agent_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_agent_id_unique UNIQUE (agent_id);


--
-- Name: devices devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_pkey PRIMARY KEY (id);


--
-- Name: discovered_assets discovered_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discovered_assets
    ADD CONSTRAINT discovered_assets_pkey PRIMARY KEY (id);


--
-- Name: discovery_jobs discovery_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discovery_jobs
    ADD CONSTRAINT discovery_jobs_pkey PRIMARY KEY (id);


--
-- Name: discovery_profiles discovery_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discovery_profiles
    ADD CONSTRAINT discovery_profiles_pkey PRIMARY KEY (id);


--
-- Name: enrollment_keys enrollment_keys_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrollment_keys
    ADD CONSTRAINT enrollment_keys_key_unique UNIQUE (key);


--
-- Name: enrollment_keys enrollment_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrollment_keys
    ADD CONSTRAINT enrollment_keys_pkey PRIMARY KEY (id);


--
-- Name: escalation_policies escalation_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.escalation_policies
    ADD CONSTRAINT escalation_policies_pkey PRIMARY KEY (id);


--
-- Name: event_bus_events event_bus_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_bus_events
    ADD CONSTRAINT event_bus_events_pkey PRIMARY KEY (id);


--
-- Name: executive_summaries executive_summaries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.executive_summaries
    ADD CONSTRAINT executive_summaries_pkey PRIMARY KEY (id);


--
-- Name: file_transfers file_transfers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_transfers
    ADD CONSTRAINT file_transfers_pkey PRIMARY KEY (id);


--
-- Name: group_membership_log group_membership_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_membership_log
    ADD CONSTRAINT group_membership_log_pkey PRIMARY KEY (id);


--
-- Name: maintenance_occurrences maintenance_occurrences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_occurrences
    ADD CONSTRAINT maintenance_occurrences_pkey PRIMARY KEY (id);


--
-- Name: maintenance_windows maintenance_windows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_windows
    ADD CONSTRAINT maintenance_windows_pkey PRIMARY KEY (id);


--
-- Name: manual_sql_migrations manual_sql_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manual_sql_migrations
    ADD CONSTRAINT manual_sql_migrations_pkey PRIMARY KEY (filename);


--
-- Name: mobile_devices mobile_devices_device_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_devices
    ADD CONSTRAINT mobile_devices_device_id_unique UNIQUE (device_id);


--
-- Name: mobile_devices mobile_devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_devices
    ADD CONSTRAINT mobile_devices_pkey PRIMARY KEY (id);


--
-- Name: mobile_sessions mobile_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_sessions
    ADD CONSTRAINT mobile_sessions_pkey PRIMARY KEY (id);


--
-- Name: network_monitor_alert_rules network_monitor_alert_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.network_monitor_alert_rules
    ADD CONSTRAINT network_monitor_alert_rules_pkey PRIMARY KEY (id);


--
-- Name: network_monitor_results network_monitor_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.network_monitor_results
    ADD CONSTRAINT network_monitor_results_pkey PRIMARY KEY (id);


--
-- Name: network_monitors network_monitors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.network_monitors
    ADD CONSTRAINT network_monitors_pkey PRIMARY KEY (id);


--
-- Name: network_topology network_topology_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.network_topology
    ADD CONSTRAINT network_topology_pkey PRIMARY KEY (id);


--
-- Name: notification_channels notification_channels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_channels
    ADD CONSTRAINT notification_channels_pkey PRIMARY KEY (id);


--
-- Name: organization_users organization_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_users
    ADD CONSTRAINT organization_users_pkey PRIMARY KEY (id);


--
-- Name: organizations organizations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);


--
-- Name: partner_users partner_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_users
    ADD CONSTRAINT partner_users_pkey PRIMARY KEY (id);


--
-- Name: partners partners_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partners
    ADD CONSTRAINT partners_pkey PRIMARY KEY (id);


--
-- Name: partners partners_slug_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partners
    ADD CONSTRAINT partners_slug_unique UNIQUE (slug);


--
-- Name: patch_approvals patch_approvals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patch_approvals
    ADD CONSTRAINT patch_approvals_pkey PRIMARY KEY (id);


--
-- Name: patch_compliance_reports patch_compliance_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patch_compliance_reports
    ADD CONSTRAINT patch_compliance_reports_pkey PRIMARY KEY (id);


--
-- Name: patch_compliance_snapshots patch_compliance_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patch_compliance_snapshots
    ADD CONSTRAINT patch_compliance_snapshots_pkey PRIMARY KEY (id);


--
-- Name: patch_job_results patch_job_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patch_job_results
    ADD CONSTRAINT patch_job_results_pkey PRIMARY KEY (id);


--
-- Name: patch_jobs patch_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patch_jobs
    ADD CONSTRAINT patch_jobs_pkey PRIMARY KEY (id);


--
-- Name: patch_policies patch_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patch_policies
    ADD CONSTRAINT patch_policies_pkey PRIMARY KEY (id);


--
-- Name: patch_rollbacks patch_rollbacks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patch_rollbacks
    ADD CONSTRAINT patch_rollbacks_pkey PRIMARY KEY (id);


--
-- Name: patches patches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patches
    ADD CONSTRAINT patches_pkey PRIMARY KEY (id);


--
-- Name: permissions permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_pkey PRIMARY KEY (id);


--
-- Name: plugin_catalog plugin_catalog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugin_catalog
    ADD CONSTRAINT plugin_catalog_pkey PRIMARY KEY (id);


--
-- Name: plugin_catalog plugin_catalog_slug_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugin_catalog
    ADD CONSTRAINT plugin_catalog_slug_unique UNIQUE (slug);


--
-- Name: plugin_installations plugin_installations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugin_installations
    ADD CONSTRAINT plugin_installations_pkey PRIMARY KEY (id);


--
-- Name: plugin_instances plugin_instances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugin_instances
    ADD CONSTRAINT plugin_instances_pkey PRIMARY KEY (id);


--
-- Name: plugin_logs plugin_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugin_logs
    ADD CONSTRAINT plugin_logs_pkey PRIMARY KEY (id);


--
-- Name: plugins plugins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugins
    ADD CONSTRAINT plugins_pkey PRIMARY KEY (id);


--
-- Name: policies policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policies
    ADD CONSTRAINT policies_pkey PRIMARY KEY (id);


--
-- Name: policy_assignments policy_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_assignments
    ADD CONSTRAINT policy_assignments_pkey PRIMARY KEY (id);


--
-- Name: policy_compliance policy_compliance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_compliance
    ADD CONSTRAINT policy_compliance_pkey PRIMARY KEY (id);


--
-- Name: policy_templates policy_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_templates
    ADD CONSTRAINT policy_templates_pkey PRIMARY KEY (id);


--
-- Name: policy_versions policy_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_versions
    ADD CONSTRAINT policy_versions_pkey PRIMARY KEY (id);


--
-- Name: portal_branding portal_branding_org_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_branding
    ADD CONSTRAINT portal_branding_org_id_unique UNIQUE (org_id);


--
-- Name: portal_branding portal_branding_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_branding
    ADD CONSTRAINT portal_branding_pkey PRIMARY KEY (id);


--
-- Name: portal_users portal_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_users
    ADD CONSTRAINT portal_users_pkey PRIMARY KEY (id);


--
-- Name: psa_connections psa_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.psa_connections
    ADD CONSTRAINT psa_connections_pkey PRIMARY KEY (id);


--
-- Name: psa_ticket_mappings psa_ticket_mappings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.psa_ticket_mappings
    ADD CONSTRAINT psa_ticket_mappings_pkey PRIMARY KEY (id);


--
-- Name: push_notifications push_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_notifications
    ADD CONSTRAINT push_notifications_pkey PRIMARY KEY (id);


--
-- Name: remote_sessions remote_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remote_sessions
    ADD CONSTRAINT remote_sessions_pkey PRIMARY KEY (id);


--
-- Name: report_runs report_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_runs
    ADD CONSTRAINT report_runs_pkey PRIMARY KEY (id);


--
-- Name: reports reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_pkey PRIMARY KEY (id);


--
-- Name: restore_jobs restore_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restore_jobs
    ADD CONSTRAINT restore_jobs_pkey PRIMARY KEY (id);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);


--
-- Name: saved_filters saved_filters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_filters
    ADD CONSTRAINT saved_filters_pkey PRIMARY KEY (id);


--
-- Name: saved_queries saved_queries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_queries
    ADD CONSTRAINT saved_queries_pkey PRIMARY KEY (id);


--
-- Name: script_categories script_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.script_categories
    ADD CONSTRAINT script_categories_pkey PRIMARY KEY (id);


--
-- Name: script_execution_batches script_execution_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.script_execution_batches
    ADD CONSTRAINT script_execution_batches_pkey PRIMARY KEY (id);


--
-- Name: script_executions script_executions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.script_executions
    ADD CONSTRAINT script_executions_pkey PRIMARY KEY (id);


--
-- Name: script_tags script_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.script_tags
    ADD CONSTRAINT script_tags_pkey PRIMARY KEY (id);


--
-- Name: script_templates script_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.script_templates
    ADD CONSTRAINT script_templates_pkey PRIMARY KEY (id);


--
-- Name: script_to_tags script_to_tags_script_id_tag_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.script_to_tags
    ADD CONSTRAINT script_to_tags_script_id_tag_id_pk PRIMARY KEY (script_id, tag_id);


--
-- Name: script_versions script_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.script_versions
    ADD CONSTRAINT script_versions_pkey PRIMARY KEY (id);


--
-- Name: scripts scripts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scripts
    ADD CONSTRAINT scripts_pkey PRIMARY KEY (id);


--
-- Name: security_policies security_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_policies
    ADD CONSTRAINT security_policies_pkey PRIMARY KEY (id);


--
-- Name: security_posture_org_snapshots security_posture_org_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_posture_org_snapshots
    ADD CONSTRAINT security_posture_org_snapshots_pkey PRIMARY KEY (id);


--
-- Name: security_posture_snapshots security_posture_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_posture_snapshots
    ADD CONSTRAINT security_posture_snapshots_pkey PRIMARY KEY (id);


--
-- Name: security_scans security_scans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_scans
    ADD CONSTRAINT security_scans_pkey PRIMARY KEY (id);


--
-- Name: security_status security_status_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_status
    ADD CONSTRAINT security_status_pkey PRIMARY KEY (id);


--
-- Name: security_threats security_threats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_threats
    ADD CONSTRAINT security_threats_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: sites sites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sites
    ADD CONSTRAINT sites_pkey PRIMARY KEY (id);


--
-- Name: sla_compliance sla_compliance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sla_compliance
    ADD CONSTRAINT sla_compliance_pkey PRIMARY KEY (id);


--
-- Name: sla_definitions sla_definitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sla_definitions
    ADD CONSTRAINT sla_definitions_pkey PRIMARY KEY (id);


--
-- Name: snmp_alert_thresholds snmp_alert_thresholds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snmp_alert_thresholds
    ADD CONSTRAINT snmp_alert_thresholds_pkey PRIMARY KEY (id);


--
-- Name: snmp_devices snmp_devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snmp_devices
    ADD CONSTRAINT snmp_devices_pkey PRIMARY KEY (id);


--
-- Name: snmp_metrics snmp_metrics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snmp_metrics
    ADD CONSTRAINT snmp_metrics_pkey PRIMARY KEY (id);


--
-- Name: snmp_templates snmp_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snmp_templates
    ADD CONSTRAINT snmp_templates_pkey PRIMARY KEY (id);


--
-- Name: software_catalog software_catalog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.software_catalog
    ADD CONSTRAINT software_catalog_pkey PRIMARY KEY (id);


--
-- Name: software_compliance_status software_compliance_status_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.software_compliance_status
    ADD CONSTRAINT software_compliance_status_pkey PRIMARY KEY (id);


--
-- Name: software_deployments software_deployments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.software_deployments
    ADD CONSTRAINT software_deployments_pkey PRIMARY KEY (id);


--
-- Name: software_inventory software_inventory_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.software_inventory
    ADD CONSTRAINT software_inventory_pkey PRIMARY KEY (id);


--
-- Name: software_policies software_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.software_policies
    ADD CONSTRAINT software_policies_pkey PRIMARY KEY (id);


--
-- Name: software_policy_audit software_policy_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.software_policy_audit
    ADD CONSTRAINT software_policy_audit_pkey PRIMARY KEY (id);


--
-- Name: software_versions software_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.software_versions
    ADD CONSTRAINT software_versions_pkey PRIMARY KEY (id);


--
-- Name: sso_providers sso_providers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sso_providers
    ADD CONSTRAINT sso_providers_pkey PRIMARY KEY (id);


--
-- Name: sso_sessions sso_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sso_sessions
    ADD CONSTRAINT sso_sessions_pkey PRIMARY KEY (id);


--
-- Name: sso_sessions sso_sessions_state_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sso_sessions
    ADD CONSTRAINT sso_sessions_state_unique UNIQUE (state);


--
-- Name: ticket_comments ticket_comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_comments
    ADD CONSTRAINT ticket_comments_pkey PRIMARY KEY (id);


--
-- Name: tickets tickets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_pkey PRIMARY KEY (id);


--
-- Name: tickets tickets_ticket_number_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_ticket_number_unique UNIQUE (ticket_number);


--
-- Name: user_notifications user_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_notifications
    ADD CONSTRAINT user_notifications_pkey PRIMARY KEY (id);


--
-- Name: user_sso_identities user_sso_identities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sso_identities
    ADD CONSTRAINT user_sso_identities_pkey PRIMARY KEY (id);


--
-- Name: users users_email_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_unique UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: webhook_deliveries webhook_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_pkey PRIMARY KEY (id);


--
-- Name: webhooks webhooks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhooks
    ADD CONSTRAINT webhooks_pkey PRIMARY KEY (id);


--
-- Name: agent_versions_is_latest_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_versions_is_latest_idx ON public.agent_versions USING btree (is_latest);


--
-- Name: ai_cost_usage_org_period_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ai_cost_usage_org_period_idx ON public.ai_cost_usage USING btree (org_id, period, period_key);


--
-- Name: ai_messages_role_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_messages_role_idx ON public.ai_messages USING btree (role);


--
-- Name: ai_messages_session_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_messages_session_id_idx ON public.ai_messages USING btree (session_id);


--
-- Name: ai_sessions_org_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_sessions_org_id_idx ON public.ai_sessions USING btree (org_id);


--
-- Name: ai_sessions_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_sessions_status_idx ON public.ai_sessions USING btree (status);


--
-- Name: ai_sessions_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_sessions_user_id_idx ON public.ai_sessions USING btree (user_id);


--
-- Name: ai_tool_executions_session_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_tool_executions_session_id_idx ON public.ai_tool_executions USING btree (session_id);


--
-- Name: ai_tool_executions_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_tool_executions_status_idx ON public.ai_tool_executions USING btree (status);


--
-- Name: alert_correlations_child_alert_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX alert_correlations_child_alert_id_idx ON public.alert_correlations USING btree (child_alert_id);


--
-- Name: alert_correlations_parent_alert_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX alert_correlations_parent_alert_id_idx ON public.alert_correlations USING btree (parent_alert_id);


--
-- Name: alert_rules_org_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX alert_rules_org_id_idx ON public.alert_rules USING btree (org_id);


--
-- Name: alert_rules_template_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX alert_rules_template_id_idx ON public.alert_rules USING btree (template_id);


--
-- Name: backup_configs_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX backup_configs_active_idx ON public.backup_configs USING btree (is_active);


--
-- Name: backup_configs_org_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX backup_configs_org_id_idx ON public.backup_configs USING btree (org_id);


--
-- Name: backup_configs_provider_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX backup_configs_provider_idx ON public.backup_configs USING btree (provider);


--
-- Name: backup_configs_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX backup_configs_type_idx ON public.backup_configs USING btree (type);


--
-- Name: backup_jobs_config_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX backup_jobs_config_id_idx ON public.backup_jobs USING btree (config_id);


--
-- Name: backup_jobs_device_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX backup_jobs_device_id_idx ON public.backup_jobs USING btree (device_id);


--
-- Name: backup_jobs_started_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX backup_jobs_started_at_idx ON public.backup_jobs USING btree (started_at);


--
-- Name: backup_jobs_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX backup_jobs_status_idx ON public.backup_jobs USING btree (status);


--
-- Name: backup_policies_config_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX backup_policies_config_id_idx ON public.backup_policies USING btree (config_id);


--
-- Name: backup_policies_target_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX backup_policies_target_idx ON public.backup_policies USING btree (target_type, target_id);


--
-- Name: backup_snapshots_device_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX backup_snapshots_device_id_idx ON public.backup_snapshots USING btree (device_id);


--
-- Name: backup_snapshots_job_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX backup_snapshots_job_id_idx ON public.backup_snapshots USING btree (job_id);


--
-- Name: backup_snapshots_parent_snapshot_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX backup_snapshots_parent_snapshot_id_idx ON public.backup_snapshots USING btree (parent_snapshot_id);


--
-- Name: backup_snapshots_snapshot_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX backup_snapshots_snapshot_id_idx ON public.backup_snapshots USING btree (snapshot_id);


--
-- Name: deployment_devices_deployment_device_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX deployment_devices_deployment_device_unique ON public.deployment_devices USING btree (deployment_id, device_id);


--
-- Name: deployment_results_deployment_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deployment_results_deployment_id_idx ON public.deployment_results USING btree (deployment_id);


--
-- Name: deployment_results_device_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deployment_results_device_id_idx ON public.deployment_results USING btree (device_id);


--
-- Name: deployment_results_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deployment_results_status_idx ON public.deployment_results USING btree (status);


--
-- Name: device_event_logs_cat_level_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_event_logs_cat_level_idx ON public.device_event_logs USING btree (category, level);


--
-- Name: device_event_logs_dedup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX device_event_logs_dedup_idx ON public.device_event_logs USING btree (device_id, source, event_id);


--
-- Name: device_event_logs_device_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_event_logs_device_idx ON public.device_event_logs USING btree (device_id);


--
-- Name: device_event_logs_org_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_event_logs_org_ts_idx ON public.device_event_logs USING btree (org_id, "timestamp");


--
-- Name: device_patches_device_patch_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX device_patches_device_patch_unique ON public.device_patches USING btree (device_id, patch_id);


--
-- Name: device_sessions_device_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_sessions_device_active_idx ON public.device_sessions USING btree (device_id, is_active);


--
-- Name: device_sessions_device_login_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_sessions_device_login_idx ON public.device_sessions USING btree (device_id, login_at);


--
-- Name: device_sessions_device_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_sessions_device_user_idx ON public.device_sessions USING btree (device_id, username);


--
-- Name: device_sessions_org_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_sessions_org_active_idx ON public.device_sessions USING btree (org_id, is_active);


--
-- Name: discovered_assets_org_ip_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX discovered_assets_org_ip_unique ON public.discovered_assets USING btree (org_id, ip_address);


--
-- Name: idx_device_filesystem_cleanup_runs_device_requested; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_filesystem_cleanup_runs_device_requested ON public.device_filesystem_cleanup_runs USING btree (device_id, requested_at);


--
-- Name: idx_device_filesystem_snapshots_device_captured; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_filesystem_snapshots_device_captured ON public.device_filesystem_snapshots USING btree (device_id, captured_at);


--
-- Name: network_monitor_results_monitor_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX network_monitor_results_monitor_id_idx ON public.network_monitor_results USING btree (monitor_id);


--
-- Name: network_monitor_results_timestamp_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX network_monitor_results_timestamp_idx ON public.network_monitor_results USING btree ("timestamp");


--
-- Name: network_monitors_is_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX network_monitors_is_active_idx ON public.network_monitors USING btree (is_active);


--
-- Name: network_monitors_monitor_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX network_monitors_monitor_type_idx ON public.network_monitors USING btree (monitor_type);


--
-- Name: network_monitors_org_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX network_monitors_org_id_idx ON public.network_monitors USING btree (org_id);


--
-- Name: patch_approvals_org_patch_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX patch_approvals_org_patch_unique ON public.patch_approvals USING btree (org_id, patch_id);


--
-- Name: patches_source_external_id_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX patches_source_external_id_unique ON public.patches USING btree (source, external_id);


--
-- Name: plugin_installations_org_catalog_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX plugin_installations_org_catalog_unique ON public.plugin_installations USING btree (org_id, catalog_id);


--
-- Name: policies_org_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX policies_org_id_idx ON public.policies USING btree (org_id);


--
-- Name: policies_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX policies_status_idx ON public.policies USING btree (status);


--
-- Name: policies_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX policies_type_idx ON public.policies USING btree (type);


--
-- Name: policy_assignments_policy_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX policy_assignments_policy_id_idx ON public.policy_assignments USING btree (policy_id);


--
-- Name: policy_compliance_device_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX policy_compliance_device_id_idx ON public.policy_compliance USING btree (device_id);


--
-- Name: policy_compliance_policy_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX policy_compliance_policy_id_idx ON public.policy_compliance USING btree (policy_id);


--
-- Name: policy_versions_policy_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX policy_versions_policy_id_idx ON public.policy_versions USING btree (policy_id);


--
-- Name: restore_jobs_device_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX restore_jobs_device_id_idx ON public.restore_jobs USING btree (device_id);


--
-- Name: restore_jobs_snapshot_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX restore_jobs_snapshot_id_idx ON public.restore_jobs USING btree (snapshot_id);


--
-- Name: restore_jobs_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX restore_jobs_status_idx ON public.restore_jobs USING btree (status);


--
-- Name: script_categories_org_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX script_categories_org_id_idx ON public.script_categories USING btree (org_id);


--
-- Name: script_categories_org_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX script_categories_org_name_idx ON public.script_categories USING btree (org_id, name);


--
-- Name: script_categories_parent_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX script_categories_parent_id_idx ON public.script_categories USING btree (parent_id);


--
-- Name: script_tags_org_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX script_tags_org_id_idx ON public.script_tags USING btree (org_id);


--
-- Name: script_tags_org_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX script_tags_org_name_idx ON public.script_tags USING btree (org_id, name);


--
-- Name: script_templates_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX script_templates_category_idx ON public.script_templates USING btree (category);


--
-- Name: script_templates_language_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX script_templates_language_idx ON public.script_templates USING btree (language);


--
-- Name: script_templates_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX script_templates_name_idx ON public.script_templates USING btree (name);


--
-- Name: script_to_tags_tag_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX script_to_tags_tag_id_idx ON public.script_to_tags USING btree (tag_id);


--
-- Name: script_versions_script_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX script_versions_script_id_idx ON public.script_versions USING btree (script_id);


--
-- Name: script_versions_script_id_version_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX script_versions_script_id_version_idx ON public.script_versions USING btree (script_id, version);


--
-- Name: security_policies_org_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX security_policies_org_id_idx ON public.security_policies USING btree (org_id);


--
-- Name: security_posture_org_snapshots_org_captured_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX security_posture_org_snapshots_org_captured_idx ON public.security_posture_org_snapshots USING btree (org_id, captured_at);


--
-- Name: security_posture_org_snapshots_org_score_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX security_posture_org_snapshots_org_score_idx ON public.security_posture_org_snapshots USING btree (org_id, overall_score);


--
-- Name: security_posture_snapshots_device_captured_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX security_posture_snapshots_device_captured_idx ON public.security_posture_snapshots USING btree (device_id, captured_at);


--
-- Name: security_posture_snapshots_org_captured_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX security_posture_snapshots_org_captured_idx ON public.security_posture_snapshots USING btree (org_id, captured_at);


--
-- Name: security_posture_snapshots_org_score_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX security_posture_snapshots_org_score_idx ON public.security_posture_snapshots USING btree (org_id, overall_score);


--
-- Name: security_scans_device_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX security_scans_device_started_idx ON public.security_scans USING btree (device_id, started_at);


--
-- Name: security_scans_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX security_scans_status_idx ON public.security_scans USING btree (status);


--
-- Name: security_status_device_id_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX security_status_device_id_unique ON public.security_status USING btree (device_id);


--
-- Name: security_status_provider_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX security_status_provider_idx ON public.security_status USING btree (provider);


--
-- Name: security_threats_device_detected_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX security_threats_device_detected_idx ON public.security_threats USING btree (device_id, detected_at);


--
-- Name: security_threats_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX security_threats_status_idx ON public.security_threats USING btree (status);


--
-- Name: snmp_metrics_device_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX snmp_metrics_device_id_idx ON public.snmp_metrics USING btree (device_id);


--
-- Name: snmp_metrics_oid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX snmp_metrics_oid_idx ON public.snmp_metrics USING btree (oid);


--
-- Name: snmp_metrics_timestamp_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX snmp_metrics_timestamp_idx ON public.snmp_metrics USING btree ("timestamp");


--
-- Name: software_catalog_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX software_catalog_category_idx ON public.software_catalog USING btree (category);


--
-- Name: software_catalog_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX software_catalog_name_idx ON public.software_catalog USING btree (name);


--
-- Name: software_catalog_vendor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX software_catalog_vendor_idx ON public.software_catalog USING btree (vendor);


--
-- Name: software_compliance_device_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX software_compliance_device_id_idx ON public.software_compliance_status USING btree (device_id);


--
-- Name: software_compliance_device_policy_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX software_compliance_device_policy_unique ON public.software_compliance_status USING btree (device_id, policy_id);


--
-- Name: software_compliance_policy_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX software_compliance_policy_id_idx ON public.software_compliance_status USING btree (policy_id);


--
-- Name: software_compliance_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX software_compliance_status_idx ON public.software_compliance_status USING btree (status);


--
-- Name: software_deployments_org_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX software_deployments_org_id_idx ON public.software_deployments USING btree (org_id);


--
-- Name: software_deployments_schedule_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX software_deployments_schedule_idx ON public.software_deployments USING btree (schedule_type, scheduled_at);


--
-- Name: software_deployments_version_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX software_deployments_version_id_idx ON public.software_deployments USING btree (software_version_id);


--
-- Name: software_inventory_catalog_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX software_inventory_catalog_id_idx ON public.software_inventory USING btree (catalog_id);


--
-- Name: software_inventory_device_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX software_inventory_device_id_idx ON public.software_inventory USING btree (device_id);


--
-- Name: software_inventory_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX software_inventory_name_idx ON public.software_inventory USING btree (name);


--
-- Name: software_policies_active_priority_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX software_policies_active_priority_idx ON public.software_policies USING btree (is_active, priority);


--
-- Name: software_policies_org_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX software_policies_org_id_idx ON public.software_policies USING btree (org_id);


--
-- Name: software_policies_target_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX software_policies_target_type_idx ON public.software_policies USING btree (target_type);


--
-- Name: software_policy_audit_device_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX software_policy_audit_device_id_idx ON public.software_policy_audit USING btree (device_id);


--
-- Name: software_policy_audit_org_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX software_policy_audit_org_id_idx ON public.software_policy_audit USING btree (org_id);


--
-- Name: software_policy_audit_policy_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX software_policy_audit_policy_id_idx ON public.software_policy_audit USING btree (policy_id);


--
-- Name: software_policy_audit_timestamp_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX software_policy_audit_timestamp_idx ON public.software_policy_audit USING btree ("timestamp");


--
-- Name: software_versions_catalog_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX software_versions_catalog_id_idx ON public.software_versions USING btree (catalog_id);


--
-- Name: software_versions_catalog_version_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX software_versions_catalog_version_idx ON public.software_versions USING btree (catalog_id, version);


--
-- Name: software_versions_latest_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX software_versions_latest_idx ON public.software_versions USING btree (catalog_id, is_latest);


--
-- Name: time_series_metrics_device_timestamp_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX time_series_metrics_device_timestamp_idx ON public.time_series_metrics USING btree ("timestamp", device_id);


--
-- Name: time_series_metrics_org_timestamp_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX time_series_metrics_org_timestamp_idx ON public.time_series_metrics USING btree (org_id, "timestamp");


--
-- Name: user_notifications_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_notifications_created_at_idx ON public.user_notifications USING btree (created_at);


--
-- Name: user_notifications_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_notifications_user_id_idx ON public.user_notifications USING btree (user_id);


--
-- Name: user_notifications_user_read_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_notifications_user_read_idx ON public.user_notifications USING btree (user_id, read);


--
-- Name: access_review_items access_review_items_review_id_access_reviews_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_review_items
    ADD CONSTRAINT access_review_items_review_id_access_reviews_id_fk FOREIGN KEY (review_id) REFERENCES public.access_reviews(id) ON DELETE CASCADE;


--
-- Name: access_review_items access_review_items_reviewed_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_review_items
    ADD CONSTRAINT access_review_items_reviewed_by_users_id_fk FOREIGN KEY (reviewed_by) REFERENCES public.users(id);


--
-- Name: access_review_items access_review_items_role_id_roles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_review_items
    ADD CONSTRAINT access_review_items_role_id_roles_id_fk FOREIGN KEY (role_id) REFERENCES public.roles(id);


--
-- Name: access_review_items access_review_items_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_review_items
    ADD CONSTRAINT access_review_items_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: access_reviews access_reviews_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_reviews
    ADD CONSTRAINT access_reviews_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: access_reviews access_reviews_partner_id_partners_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_reviews
    ADD CONSTRAINT access_reviews_partner_id_partners_id_fk FOREIGN KEY (partner_id) REFERENCES public.partners(id);


--
-- Name: access_reviews access_reviews_reviewer_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_reviews
    ADD CONSTRAINT access_reviews_reviewer_id_users_id_fk FOREIGN KEY (reviewer_id) REFERENCES public.users(id);


--
-- Name: ai_budgets ai_budgets_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_budgets
    ADD CONSTRAINT ai_budgets_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: ai_cost_usage ai_cost_usage_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_cost_usage
    ADD CONSTRAINT ai_cost_usage_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: ai_messages ai_messages_session_id_ai_sessions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_messages
    ADD CONSTRAINT ai_messages_session_id_ai_sessions_id_fk FOREIGN KEY (session_id) REFERENCES public.ai_sessions(id);


--
-- Name: ai_sessions ai_sessions_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_sessions
    ADD CONSTRAINT ai_sessions_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: ai_sessions ai_sessions_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_sessions
    ADD CONSTRAINT ai_sessions_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: ai_tool_executions ai_tool_executions_approved_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_tool_executions
    ADD CONSTRAINT ai_tool_executions_approved_by_users_id_fk FOREIGN KEY (approved_by) REFERENCES public.users(id);


--
-- Name: ai_tool_executions ai_tool_executions_message_id_ai_messages_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_tool_executions
    ADD CONSTRAINT ai_tool_executions_message_id_ai_messages_id_fk FOREIGN KEY (message_id) REFERENCES public.ai_messages(id);


--
-- Name: ai_tool_executions ai_tool_executions_session_id_ai_sessions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_tool_executions
    ADD CONSTRAINT ai_tool_executions_session_id_ai_sessions_id_fk FOREIGN KEY (session_id) REFERENCES public.ai_sessions(id);


--
-- Name: alert_correlations alert_correlations_child_alert_id_alerts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_correlations
    ADD CONSTRAINT alert_correlations_child_alert_id_alerts_id_fk FOREIGN KEY (child_alert_id) REFERENCES public.alerts(id);


--
-- Name: alert_correlations alert_correlations_parent_alert_id_alerts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_correlations
    ADD CONSTRAINT alert_correlations_parent_alert_id_alerts_id_fk FOREIGN KEY (parent_alert_id) REFERENCES public.alerts(id);


--
-- Name: alert_notifications alert_notifications_alert_id_alerts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_notifications
    ADD CONSTRAINT alert_notifications_alert_id_alerts_id_fk FOREIGN KEY (alert_id) REFERENCES public.alerts(id);


--
-- Name: alert_notifications alert_notifications_channel_id_notification_channels_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_notifications
    ADD CONSTRAINT alert_notifications_channel_id_notification_channels_id_fk FOREIGN KEY (channel_id) REFERENCES public.notification_channels(id);


--
-- Name: alert_rules alert_rules_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_rules
    ADD CONSTRAINT alert_rules_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: alert_rules alert_rules_template_id_alert_templates_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_rules
    ADD CONSTRAINT alert_rules_template_id_alert_templates_id_fk FOREIGN KEY (template_id) REFERENCES public.alert_templates(id);


--
-- Name: alert_templates alert_templates_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_templates
    ADD CONSTRAINT alert_templates_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: alerts alerts_acknowledged_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_acknowledged_by_users_id_fk FOREIGN KEY (acknowledged_by) REFERENCES public.users(id);


--
-- Name: alerts alerts_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: alerts alerts_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: alerts alerts_resolved_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_resolved_by_users_id_fk FOREIGN KEY (resolved_by) REFERENCES public.users(id);


--
-- Name: alerts alerts_rule_id_alert_rules_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_rule_id_alert_rules_id_fk FOREIGN KEY (rule_id) REFERENCES public.alert_rules(id);


--
-- Name: analytics_dashboards analytics_dashboards_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_dashboards
    ADD CONSTRAINT analytics_dashboards_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: analytics_dashboards analytics_dashboards_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_dashboards
    ADD CONSTRAINT analytics_dashboards_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: api_keys api_keys_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: api_keys api_keys_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: asset_checkouts asset_checkouts_checked_in_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_checkouts
    ADD CONSTRAINT asset_checkouts_checked_in_by_users_id_fk FOREIGN KEY (checked_in_by) REFERENCES public.users(id);


--
-- Name: asset_checkouts asset_checkouts_checked_out_to_portal_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_checkouts
    ADD CONSTRAINT asset_checkouts_checked_out_to_portal_users_id_fk FOREIGN KEY (checked_out_to) REFERENCES public.portal_users(id);


--
-- Name: asset_checkouts asset_checkouts_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_checkouts
    ADD CONSTRAINT asset_checkouts_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: asset_checkouts asset_checkouts_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_checkouts
    ADD CONSTRAINT asset_checkouts_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: audit_logs audit_logs_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: audit_retention_policies audit_retention_policies_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_retention_policies
    ADD CONSTRAINT audit_retention_policies_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: automation_policies automation_policies_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_policies
    ADD CONSTRAINT automation_policies_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: automation_policies automation_policies_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_policies
    ADD CONSTRAINT automation_policies_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: automation_policies automation_policies_remediation_script_id_scripts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_policies
    ADD CONSTRAINT automation_policies_remediation_script_id_scripts_id_fk FOREIGN KEY (remediation_script_id) REFERENCES public.scripts(id);


--
-- Name: automation_policy_compliance automation_policy_compliance_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_policy_compliance
    ADD CONSTRAINT automation_policy_compliance_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: automation_policy_compliance automation_policy_compliance_policy_id_automation_policies_id_f; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_policy_compliance
    ADD CONSTRAINT automation_policy_compliance_policy_id_automation_policies_id_f FOREIGN KEY (policy_id) REFERENCES public.automation_policies(id);


--
-- Name: automation_runs automation_runs_automation_id_automations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_runs
    ADD CONSTRAINT automation_runs_automation_id_automations_id_fk FOREIGN KEY (automation_id) REFERENCES public.automations(id);


--
-- Name: automations automations_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automations
    ADD CONSTRAINT automations_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: automations automations_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automations
    ADD CONSTRAINT automations_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: backup_configs backup_configs_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_configs
    ADD CONSTRAINT backup_configs_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: backup_jobs backup_jobs_config_id_backup_configs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_jobs
    ADD CONSTRAINT backup_jobs_config_id_backup_configs_id_fk FOREIGN KEY (config_id) REFERENCES public.backup_configs(id);


--
-- Name: backup_jobs backup_jobs_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_jobs
    ADD CONSTRAINT backup_jobs_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: backup_policies backup_policies_config_id_backup_configs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_policies
    ADD CONSTRAINT backup_policies_config_id_backup_configs_id_fk FOREIGN KEY (config_id) REFERENCES public.backup_configs(id);


--
-- Name: backup_snapshots backup_snapshots_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_snapshots
    ADD CONSTRAINT backup_snapshots_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: backup_snapshots backup_snapshots_job_id_backup_jobs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_snapshots
    ADD CONSTRAINT backup_snapshots_job_id_backup_jobs_id_fk FOREIGN KEY (job_id) REFERENCES public.backup_jobs(id);


--
-- Name: backup_snapshots backup_snapshots_parent_snapshot_id_backup_snapshots_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_snapshots
    ADD CONSTRAINT backup_snapshots_parent_snapshot_id_backup_snapshots_id_fk FOREIGN KEY (parent_snapshot_id) REFERENCES public.backup_snapshots(id);


--
-- Name: capacity_predictions capacity_predictions_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.capacity_predictions
    ADD CONSTRAINT capacity_predictions_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: capacity_predictions capacity_predictions_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.capacity_predictions
    ADD CONSTRAINT capacity_predictions_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: capacity_thresholds capacity_thresholds_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.capacity_thresholds
    ADD CONSTRAINT capacity_thresholds_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: custom_field_definitions custom_field_definitions_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_field_definitions
    ADD CONSTRAINT custom_field_definitions_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: custom_field_definitions custom_field_definitions_partner_id_partners_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_field_definitions
    ADD CONSTRAINT custom_field_definitions_partner_id_partners_id_fk FOREIGN KEY (partner_id) REFERENCES public.partners(id);


--
-- Name: dashboard_widgets dashboard_widgets_dashboard_id_analytics_dashboards_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dashboard_widgets
    ADD CONSTRAINT dashboard_widgets_dashboard_id_analytics_dashboards_id_fk FOREIGN KEY (dashboard_id) REFERENCES public.analytics_dashboards(id);


--
-- Name: deployment_devices deployment_devices_deployment_id_deployments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployment_devices
    ADD CONSTRAINT deployment_devices_deployment_id_deployments_id_fk FOREIGN KEY (deployment_id) REFERENCES public.deployments(id);


--
-- Name: deployment_devices deployment_devices_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployment_devices
    ADD CONSTRAINT deployment_devices_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: deployment_results deployment_results_deployment_id_software_deployments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployment_results
    ADD CONSTRAINT deployment_results_deployment_id_software_deployments_id_fk FOREIGN KEY (deployment_id) REFERENCES public.software_deployments(id);


--
-- Name: deployment_results deployment_results_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployment_results
    ADD CONSTRAINT deployment_results_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: deployments deployments_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployments
    ADD CONSTRAINT deployments_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: deployments deployments_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployments
    ADD CONSTRAINT deployments_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: device_commands device_commands_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_commands
    ADD CONSTRAINT device_commands_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: device_commands device_commands_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_commands
    ADD CONSTRAINT device_commands_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: device_config_state device_config_state_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_config_state
    ADD CONSTRAINT device_config_state_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: device_connections device_connections_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_connections
    ADD CONSTRAINT device_connections_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: device_disks device_disks_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_disks
    ADD CONSTRAINT device_disks_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: device_event_logs device_event_logs_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_event_logs
    ADD CONSTRAINT device_event_logs_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: device_event_logs device_event_logs_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_event_logs
    ADD CONSTRAINT device_event_logs_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: device_filesystem_cleanup_runs device_filesystem_cleanup_runs_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_filesystem_cleanup_runs
    ADD CONSTRAINT device_filesystem_cleanup_runs_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: device_filesystem_cleanup_runs device_filesystem_cleanup_runs_requested_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_filesystem_cleanup_runs
    ADD CONSTRAINT device_filesystem_cleanup_runs_requested_by_users_id_fk FOREIGN KEY (requested_by) REFERENCES public.users(id);


--
-- Name: device_filesystem_scan_state device_filesystem_scan_state_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_filesystem_scan_state
    ADD CONSTRAINT device_filesystem_scan_state_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: device_filesystem_snapshots device_filesystem_snapshots_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_filesystem_snapshots
    ADD CONSTRAINT device_filesystem_snapshots_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: device_group_memberships device_group_memberships_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_group_memberships
    ADD CONSTRAINT device_group_memberships_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: device_group_memberships device_group_memberships_group_id_device_groups_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_group_memberships
    ADD CONSTRAINT device_group_memberships_group_id_device_groups_id_fk FOREIGN KEY (group_id) REFERENCES public.device_groups(id);


--
-- Name: device_groups device_groups_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_groups
    ADD CONSTRAINT device_groups_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: device_groups device_groups_site_id_sites_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_groups
    ADD CONSTRAINT device_groups_site_id_sites_id_fk FOREIGN KEY (site_id) REFERENCES public.sites(id);


--
-- Name: device_hardware device_hardware_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_hardware
    ADD CONSTRAINT device_hardware_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: device_metrics device_metrics_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_metrics
    ADD CONSTRAINT device_metrics_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: device_network device_network_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_network
    ADD CONSTRAINT device_network_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: device_patches device_patches_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_patches
    ADD CONSTRAINT device_patches_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: device_patches device_patches_patch_id_patches_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_patches
    ADD CONSTRAINT device_patches_patch_id_patches_id_fk FOREIGN KEY (patch_id) REFERENCES public.patches(id);


--
-- Name: device_registry_state device_registry_state_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_registry_state
    ADD CONSTRAINT device_registry_state_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: device_sessions device_sessions_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_sessions
    ADD CONSTRAINT device_sessions_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: device_sessions device_sessions_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_sessions
    ADD CONSTRAINT device_sessions_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: device_software device_software_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_software
    ADD CONSTRAINT device_software_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: devices devices_enrolled_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_enrolled_by_users_id_fk FOREIGN KEY (enrolled_by) REFERENCES public.users(id);


--
-- Name: devices devices_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: devices devices_site_id_sites_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_site_id_sites_id_fk FOREIGN KEY (site_id) REFERENCES public.sites(id);


--
-- Name: discovered_assets discovered_assets_ignored_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discovered_assets
    ADD CONSTRAINT discovered_assets_ignored_by_users_id_fk FOREIGN KEY (ignored_by) REFERENCES public.users(id);


--
-- Name: discovered_assets discovered_assets_last_job_id_discovery_jobs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discovered_assets
    ADD CONSTRAINT discovered_assets_last_job_id_discovery_jobs_id_fk FOREIGN KEY (last_job_id) REFERENCES public.discovery_jobs(id);


--
-- Name: discovered_assets discovered_assets_linked_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discovered_assets
    ADD CONSTRAINT discovered_assets_linked_device_id_devices_id_fk FOREIGN KEY (linked_device_id) REFERENCES public.devices(id);


--
-- Name: discovered_assets discovered_assets_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discovered_assets
    ADD CONSTRAINT discovered_assets_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: discovered_assets discovered_assets_site_id_sites_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discovered_assets
    ADD CONSTRAINT discovered_assets_site_id_sites_id_fk FOREIGN KEY (site_id) REFERENCES public.sites(id);


--
-- Name: discovery_jobs discovery_jobs_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discovery_jobs
    ADD CONSTRAINT discovery_jobs_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: discovery_jobs discovery_jobs_profile_id_discovery_profiles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discovery_jobs
    ADD CONSTRAINT discovery_jobs_profile_id_discovery_profiles_id_fk FOREIGN KEY (profile_id) REFERENCES public.discovery_profiles(id);


--
-- Name: discovery_jobs discovery_jobs_site_id_sites_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discovery_jobs
    ADD CONSTRAINT discovery_jobs_site_id_sites_id_fk FOREIGN KEY (site_id) REFERENCES public.sites(id);


--
-- Name: discovery_profiles discovery_profiles_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discovery_profiles
    ADD CONSTRAINT discovery_profiles_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: discovery_profiles discovery_profiles_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discovery_profiles
    ADD CONSTRAINT discovery_profiles_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: discovery_profiles discovery_profiles_site_id_sites_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discovery_profiles
    ADD CONSTRAINT discovery_profiles_site_id_sites_id_fk FOREIGN KEY (site_id) REFERENCES public.sites(id);


--
-- Name: enrollment_keys enrollment_keys_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrollment_keys
    ADD CONSTRAINT enrollment_keys_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: enrollment_keys enrollment_keys_site_id_sites_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrollment_keys
    ADD CONSTRAINT enrollment_keys_site_id_sites_id_fk FOREIGN KEY (site_id) REFERENCES public.sites(id);


--
-- Name: escalation_policies escalation_policies_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.escalation_policies
    ADD CONSTRAINT escalation_policies_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: event_bus_events event_bus_events_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_bus_events
    ADD CONSTRAINT event_bus_events_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: executive_summaries executive_summaries_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.executive_summaries
    ADD CONSTRAINT executive_summaries_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: file_transfers file_transfers_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_transfers
    ADD CONSTRAINT file_transfers_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: file_transfers file_transfers_session_id_remote_sessions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_transfers
    ADD CONSTRAINT file_transfers_session_id_remote_sessions_id_fk FOREIGN KEY (session_id) REFERENCES public.remote_sessions(id);


--
-- Name: file_transfers file_transfers_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_transfers
    ADD CONSTRAINT file_transfers_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: group_membership_log group_membership_log_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_membership_log
    ADD CONSTRAINT group_membership_log_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: group_membership_log group_membership_log_group_id_device_groups_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_membership_log
    ADD CONSTRAINT group_membership_log_group_id_device_groups_id_fk FOREIGN KEY (group_id) REFERENCES public.device_groups(id);


--
-- Name: maintenance_occurrences maintenance_occurrences_window_id_maintenance_windows_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_occurrences
    ADD CONSTRAINT maintenance_occurrences_window_id_maintenance_windows_id_fk FOREIGN KEY (window_id) REFERENCES public.maintenance_windows(id);


--
-- Name: maintenance_windows maintenance_windows_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_windows
    ADD CONSTRAINT maintenance_windows_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: maintenance_windows maintenance_windows_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_windows
    ADD CONSTRAINT maintenance_windows_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: mobile_devices mobile_devices_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_devices
    ADD CONSTRAINT mobile_devices_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: mobile_sessions mobile_sessions_mobile_device_id_mobile_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_sessions
    ADD CONSTRAINT mobile_sessions_mobile_device_id_mobile_devices_id_fk FOREIGN KEY (mobile_device_id) REFERENCES public.mobile_devices(id);


--
-- Name: mobile_sessions mobile_sessions_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_sessions
    ADD CONSTRAINT mobile_sessions_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: network_monitor_alert_rules network_monitor_alert_rules_monitor_id_network_monitors_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.network_monitor_alert_rules
    ADD CONSTRAINT network_monitor_alert_rules_monitor_id_network_monitors_id_fk FOREIGN KEY (monitor_id) REFERENCES public.network_monitors(id) ON DELETE CASCADE;


--
-- Name: network_monitor_results network_monitor_results_monitor_id_network_monitors_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.network_monitor_results
    ADD CONSTRAINT network_monitor_results_monitor_id_network_monitors_id_fk FOREIGN KEY (monitor_id) REFERENCES public.network_monitors(id) ON DELETE CASCADE;


--
-- Name: network_monitors network_monitors_asset_id_discovered_assets_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.network_monitors
    ADD CONSTRAINT network_monitors_asset_id_discovered_assets_id_fk FOREIGN KEY (asset_id) REFERENCES public.discovered_assets(id);


--
-- Name: network_monitors network_monitors_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.network_monitors
    ADD CONSTRAINT network_monitors_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: network_topology network_topology_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.network_topology
    ADD CONSTRAINT network_topology_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: network_topology network_topology_site_id_sites_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.network_topology
    ADD CONSTRAINT network_topology_site_id_sites_id_fk FOREIGN KEY (site_id) REFERENCES public.sites(id);


--
-- Name: notification_channels notification_channels_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_channels
    ADD CONSTRAINT notification_channels_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: organization_users organization_users_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_users
    ADD CONSTRAINT organization_users_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: organization_users organization_users_role_id_roles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_users
    ADD CONSTRAINT organization_users_role_id_roles_id_fk FOREIGN KEY (role_id) REFERENCES public.roles(id);


--
-- Name: organization_users organization_users_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_users
    ADD CONSTRAINT organization_users_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: organizations organizations_partner_id_partners_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_partner_id_partners_id_fk FOREIGN KEY (partner_id) REFERENCES public.partners(id);


--
-- Name: partner_users partner_users_partner_id_partners_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_users
    ADD CONSTRAINT partner_users_partner_id_partners_id_fk FOREIGN KEY (partner_id) REFERENCES public.partners(id);


--
-- Name: partner_users partner_users_role_id_roles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_users
    ADD CONSTRAINT partner_users_role_id_roles_id_fk FOREIGN KEY (role_id) REFERENCES public.roles(id);


--
-- Name: partner_users partner_users_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_users
    ADD CONSTRAINT partner_users_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: patch_approvals patch_approvals_approved_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patch_approvals
    ADD CONSTRAINT patch_approvals_approved_by_users_id_fk FOREIGN KEY (approved_by) REFERENCES public.users(id);


--
-- Name: patch_approvals patch_approvals_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patch_approvals
    ADD CONSTRAINT patch_approvals_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: patch_approvals patch_approvals_patch_id_patches_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patch_approvals
    ADD CONSTRAINT patch_approvals_patch_id_patches_id_fk FOREIGN KEY (patch_id) REFERENCES public.patches(id);


--
-- Name: patch_approvals patch_approvals_policy_id_patch_policies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patch_approvals
    ADD CONSTRAINT patch_approvals_policy_id_patch_policies_id_fk FOREIGN KEY (policy_id) REFERENCES public.patch_policies(id);


--
-- Name: patch_compliance_reports patch_compliance_reports_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patch_compliance_reports
    ADD CONSTRAINT patch_compliance_reports_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: patch_compliance_reports patch_compliance_reports_requested_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patch_compliance_reports
    ADD CONSTRAINT patch_compliance_reports_requested_by_users_id_fk FOREIGN KEY (requested_by) REFERENCES public.users(id);


--
-- Name: patch_compliance_snapshots patch_compliance_snapshots_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patch_compliance_snapshots
    ADD CONSTRAINT patch_compliance_snapshots_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: patch_job_results patch_job_results_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patch_job_results
    ADD CONSTRAINT patch_job_results_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: patch_job_results patch_job_results_job_id_patch_jobs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patch_job_results
    ADD CONSTRAINT patch_job_results_job_id_patch_jobs_id_fk FOREIGN KEY (job_id) REFERENCES public.patch_jobs(id);


--
-- Name: patch_job_results patch_job_results_patch_id_patches_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patch_job_results
    ADD CONSTRAINT patch_job_results_patch_id_patches_id_fk FOREIGN KEY (patch_id) REFERENCES public.patches(id);


--
-- Name: patch_jobs patch_jobs_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patch_jobs
    ADD CONSTRAINT patch_jobs_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: patch_jobs patch_jobs_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patch_jobs
    ADD CONSTRAINT patch_jobs_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: patch_jobs patch_jobs_policy_id_patch_policies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patch_jobs
    ADD CONSTRAINT patch_jobs_policy_id_patch_policies_id_fk FOREIGN KEY (policy_id) REFERENCES public.patch_policies(id);


--
-- Name: patch_policies patch_policies_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patch_policies
    ADD CONSTRAINT patch_policies_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: patch_policies patch_policies_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patch_policies
    ADD CONSTRAINT patch_policies_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: patch_policies patch_policies_post_install_script_id_scripts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patch_policies
    ADD CONSTRAINT patch_policies_post_install_script_id_scripts_id_fk FOREIGN KEY (post_install_script_id) REFERENCES public.scripts(id);


--
-- Name: patch_policies patch_policies_pre_install_script_id_scripts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patch_policies
    ADD CONSTRAINT patch_policies_pre_install_script_id_scripts_id_fk FOREIGN KEY (pre_install_script_id) REFERENCES public.scripts(id);


--
-- Name: patch_rollbacks patch_rollbacks_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patch_rollbacks
    ADD CONSTRAINT patch_rollbacks_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: patch_rollbacks patch_rollbacks_initiated_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patch_rollbacks
    ADD CONSTRAINT patch_rollbacks_initiated_by_users_id_fk FOREIGN KEY (initiated_by) REFERENCES public.users(id);


--
-- Name: patch_rollbacks patch_rollbacks_original_job_id_patch_jobs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patch_rollbacks
    ADD CONSTRAINT patch_rollbacks_original_job_id_patch_jobs_id_fk FOREIGN KEY (original_job_id) REFERENCES public.patch_jobs(id);


--
-- Name: patch_rollbacks patch_rollbacks_patch_id_patches_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patch_rollbacks
    ADD CONSTRAINT patch_rollbacks_patch_id_patches_id_fk FOREIGN KEY (patch_id) REFERENCES public.patches(id);


--
-- Name: plugin_installations plugin_installations_catalog_id_plugin_catalog_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugin_installations
    ADD CONSTRAINT plugin_installations_catalog_id_plugin_catalog_id_fk FOREIGN KEY (catalog_id) REFERENCES public.plugin_catalog(id);


--
-- Name: plugin_installations plugin_installations_installed_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugin_installations
    ADD CONSTRAINT plugin_installations_installed_by_users_id_fk FOREIGN KEY (installed_by) REFERENCES public.users(id);


--
-- Name: plugin_installations plugin_installations_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugin_installations
    ADD CONSTRAINT plugin_installations_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: plugin_instances plugin_instances_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugin_instances
    ADD CONSTRAINT plugin_instances_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: plugin_instances plugin_instances_plugin_id_plugins_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugin_instances
    ADD CONSTRAINT plugin_instances_plugin_id_plugins_id_fk FOREIGN KEY (plugin_id) REFERENCES public.plugins(id);


--
-- Name: plugin_logs plugin_logs_installation_id_plugin_installations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugin_logs
    ADD CONSTRAINT plugin_logs_installation_id_plugin_installations_id_fk FOREIGN KEY (installation_id) REFERENCES public.plugin_installations(id);


--
-- Name: plugins plugins_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugins
    ADD CONSTRAINT plugins_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: policies policies_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policies
    ADD CONSTRAINT policies_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: policies policies_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policies
    ADD CONSTRAINT policies_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: policies policies_parent_id_policies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policies
    ADD CONSTRAINT policies_parent_id_policies_id_fk FOREIGN KEY (parent_id) REFERENCES public.policies(id);


--
-- Name: policy_assignments policy_assignments_policy_id_policies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_assignments
    ADD CONSTRAINT policy_assignments_policy_id_policies_id_fk FOREIGN KEY (policy_id) REFERENCES public.policies(id);


--
-- Name: policy_compliance policy_compliance_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_compliance
    ADD CONSTRAINT policy_compliance_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: policy_compliance policy_compliance_policy_id_policies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_compliance
    ADD CONSTRAINT policy_compliance_policy_id_policies_id_fk FOREIGN KEY (policy_id) REFERENCES public.policies(id);


--
-- Name: policy_versions policy_versions_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_versions
    ADD CONSTRAINT policy_versions_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: policy_versions policy_versions_policy_id_policies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_versions
    ADD CONSTRAINT policy_versions_policy_id_policies_id_fk FOREIGN KEY (policy_id) REFERENCES public.policies(id);


--
-- Name: portal_branding portal_branding_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_branding
    ADD CONSTRAINT portal_branding_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: portal_users portal_users_linked_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_users
    ADD CONSTRAINT portal_users_linked_user_id_users_id_fk FOREIGN KEY (linked_user_id) REFERENCES public.users(id);


--
-- Name: portal_users portal_users_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_users
    ADD CONSTRAINT portal_users_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: psa_connections psa_connections_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.psa_connections
    ADD CONSTRAINT psa_connections_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: psa_connections psa_connections_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.psa_connections
    ADD CONSTRAINT psa_connections_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: psa_ticket_mappings psa_ticket_mappings_alert_id_alerts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.psa_ticket_mappings
    ADD CONSTRAINT psa_ticket_mappings_alert_id_alerts_id_fk FOREIGN KEY (alert_id) REFERENCES public.alerts(id);


--
-- Name: psa_ticket_mappings psa_ticket_mappings_connection_id_psa_connections_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.psa_ticket_mappings
    ADD CONSTRAINT psa_ticket_mappings_connection_id_psa_connections_id_fk FOREIGN KEY (connection_id) REFERENCES public.psa_connections(id);


--
-- Name: psa_ticket_mappings psa_ticket_mappings_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.psa_ticket_mappings
    ADD CONSTRAINT psa_ticket_mappings_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: push_notifications push_notifications_mobile_device_id_mobile_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_notifications
    ADD CONSTRAINT push_notifications_mobile_device_id_mobile_devices_id_fk FOREIGN KEY (mobile_device_id) REFERENCES public.mobile_devices(id);


--
-- Name: push_notifications push_notifications_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_notifications
    ADD CONSTRAINT push_notifications_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: remote_sessions remote_sessions_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remote_sessions
    ADD CONSTRAINT remote_sessions_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: remote_sessions remote_sessions_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remote_sessions
    ADD CONSTRAINT remote_sessions_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: report_runs report_runs_report_id_reports_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_runs
    ADD CONSTRAINT report_runs_report_id_reports_id_fk FOREIGN KEY (report_id) REFERENCES public.reports(id);


--
-- Name: reports reports_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: reports reports_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: restore_jobs restore_jobs_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restore_jobs
    ADD CONSTRAINT restore_jobs_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: restore_jobs restore_jobs_initiated_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restore_jobs
    ADD CONSTRAINT restore_jobs_initiated_by_users_id_fk FOREIGN KEY (initiated_by) REFERENCES public.users(id);


--
-- Name: restore_jobs restore_jobs_snapshot_id_backup_snapshots_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restore_jobs
    ADD CONSTRAINT restore_jobs_snapshot_id_backup_snapshots_id_fk FOREIGN KEY (snapshot_id) REFERENCES public.backup_snapshots(id);


--
-- Name: role_permissions role_permissions_permission_id_permissions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_permission_id_permissions_id_fk FOREIGN KEY (permission_id) REFERENCES public.permissions(id);


--
-- Name: role_permissions role_permissions_role_id_roles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_role_id_roles_id_fk FOREIGN KEY (role_id) REFERENCES public.roles(id);


--
-- Name: roles roles_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: roles roles_partner_id_partners_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_partner_id_partners_id_fk FOREIGN KEY (partner_id) REFERENCES public.partners(id);


--
-- Name: saved_filters saved_filters_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_filters
    ADD CONSTRAINT saved_filters_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: saved_filters saved_filters_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_filters
    ADD CONSTRAINT saved_filters_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: saved_queries saved_queries_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_queries
    ADD CONSTRAINT saved_queries_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: saved_queries saved_queries_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_queries
    ADD CONSTRAINT saved_queries_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: script_categories script_categories_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.script_categories
    ADD CONSTRAINT script_categories_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: script_categories script_categories_parent_id_script_categories_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.script_categories
    ADD CONSTRAINT script_categories_parent_id_script_categories_id_fk FOREIGN KEY (parent_id) REFERENCES public.script_categories(id);


--
-- Name: script_execution_batches script_execution_batches_script_id_scripts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.script_execution_batches
    ADD CONSTRAINT script_execution_batches_script_id_scripts_id_fk FOREIGN KEY (script_id) REFERENCES public.scripts(id);


--
-- Name: script_execution_batches script_execution_batches_triggered_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.script_execution_batches
    ADD CONSTRAINT script_execution_batches_triggered_by_users_id_fk FOREIGN KEY (triggered_by) REFERENCES public.users(id);


--
-- Name: script_executions script_executions_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.script_executions
    ADD CONSTRAINT script_executions_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: script_executions script_executions_script_id_scripts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.script_executions
    ADD CONSTRAINT script_executions_script_id_scripts_id_fk FOREIGN KEY (script_id) REFERENCES public.scripts(id);


--
-- Name: script_executions script_executions_triggered_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.script_executions
    ADD CONSTRAINT script_executions_triggered_by_users_id_fk FOREIGN KEY (triggered_by) REFERENCES public.users(id);


--
-- Name: script_tags script_tags_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.script_tags
    ADD CONSTRAINT script_tags_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: script_to_tags script_to_tags_script_id_scripts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.script_to_tags
    ADD CONSTRAINT script_to_tags_script_id_scripts_id_fk FOREIGN KEY (script_id) REFERENCES public.scripts(id);


--
-- Name: script_to_tags script_to_tags_tag_id_script_tags_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.script_to_tags
    ADD CONSTRAINT script_to_tags_tag_id_script_tags_id_fk FOREIGN KEY (tag_id) REFERENCES public.script_tags(id);


--
-- Name: script_versions script_versions_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.script_versions
    ADD CONSTRAINT script_versions_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: script_versions script_versions_script_id_scripts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.script_versions
    ADD CONSTRAINT script_versions_script_id_scripts_id_fk FOREIGN KEY (script_id) REFERENCES public.scripts(id);


--
-- Name: scripts scripts_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scripts
    ADD CONSTRAINT scripts_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: scripts scripts_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scripts
    ADD CONSTRAINT scripts_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: security_policies security_policies_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_policies
    ADD CONSTRAINT security_policies_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: security_posture_org_snapshots security_posture_org_snapshots_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_posture_org_snapshots
    ADD CONSTRAINT security_posture_org_snapshots_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: security_posture_snapshots security_posture_snapshots_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_posture_snapshots
    ADD CONSTRAINT security_posture_snapshots_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: security_posture_snapshots security_posture_snapshots_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_posture_snapshots
    ADD CONSTRAINT security_posture_snapshots_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: security_scans security_scans_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_scans
    ADD CONSTRAINT security_scans_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: security_scans security_scans_initiated_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_scans
    ADD CONSTRAINT security_scans_initiated_by_users_id_fk FOREIGN KEY (initiated_by) REFERENCES public.users(id);


--
-- Name: security_status security_status_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_status
    ADD CONSTRAINT security_status_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: security_threats security_threats_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_threats
    ADD CONSTRAINT security_threats_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: sessions sessions_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: sites sites_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sites
    ADD CONSTRAINT sites_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: sla_compliance sla_compliance_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sla_compliance
    ADD CONSTRAINT sla_compliance_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: sla_compliance sla_compliance_sla_id_sla_definitions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sla_compliance
    ADD CONSTRAINT sla_compliance_sla_id_sla_definitions_id_fk FOREIGN KEY (sla_id) REFERENCES public.sla_definitions(id);


--
-- Name: sla_definitions sla_definitions_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sla_definitions
    ADD CONSTRAINT sla_definitions_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: snmp_alert_thresholds snmp_alert_thresholds_device_id_snmp_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snmp_alert_thresholds
    ADD CONSTRAINT snmp_alert_thresholds_device_id_snmp_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.snmp_devices(id);


--
-- Name: snmp_devices snmp_devices_asset_id_discovered_assets_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snmp_devices
    ADD CONSTRAINT snmp_devices_asset_id_discovered_assets_id_fk FOREIGN KEY (asset_id) REFERENCES public.discovered_assets(id);


--
-- Name: snmp_devices snmp_devices_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snmp_devices
    ADD CONSTRAINT snmp_devices_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: snmp_devices snmp_devices_template_id_snmp_templates_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snmp_devices
    ADD CONSTRAINT snmp_devices_template_id_snmp_templates_id_fk FOREIGN KEY (template_id) REFERENCES public.snmp_templates(id);


--
-- Name: snmp_metrics snmp_metrics_device_id_snmp_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snmp_metrics
    ADD CONSTRAINT snmp_metrics_device_id_snmp_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.snmp_devices(id);


--
-- Name: software_compliance_status software_compliance_status_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.software_compliance_status
    ADD CONSTRAINT software_compliance_status_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: software_compliance_status software_compliance_status_policy_id_software_policies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.software_compliance_status
    ADD CONSTRAINT software_compliance_status_policy_id_software_policies_id_fk FOREIGN KEY (policy_id) REFERENCES public.software_policies(id) ON DELETE CASCADE;


--
-- Name: software_deployments software_deployments_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.software_deployments
    ADD CONSTRAINT software_deployments_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: software_deployments software_deployments_maintenance_window_id_maintenance_windows_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.software_deployments
    ADD CONSTRAINT software_deployments_maintenance_window_id_maintenance_windows_ FOREIGN KEY (maintenance_window_id) REFERENCES public.maintenance_windows(id);


--
-- Name: software_deployments software_deployments_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.software_deployments
    ADD CONSTRAINT software_deployments_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: software_deployments software_deployments_software_version_id_software_versions_id_f; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.software_deployments
    ADD CONSTRAINT software_deployments_software_version_id_software_versions_id_f FOREIGN KEY (software_version_id) REFERENCES public.software_versions(id);


--
-- Name: software_inventory software_inventory_catalog_id_software_catalog_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.software_inventory
    ADD CONSTRAINT software_inventory_catalog_id_software_catalog_id_fk FOREIGN KEY (catalog_id) REFERENCES public.software_catalog(id);


--
-- Name: software_inventory software_inventory_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.software_inventory
    ADD CONSTRAINT software_inventory_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: software_policies software_policies_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.software_policies
    ADD CONSTRAINT software_policies_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: software_policies software_policies_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.software_policies
    ADD CONSTRAINT software_policies_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: software_policy_audit software_policy_audit_actor_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.software_policy_audit
    ADD CONSTRAINT software_policy_audit_actor_id_users_id_fk FOREIGN KEY (actor_id) REFERENCES public.users(id);


--
-- Name: software_policy_audit software_policy_audit_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.software_policy_audit
    ADD CONSTRAINT software_policy_audit_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE SET NULL;


--
-- Name: software_policy_audit software_policy_audit_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.software_policy_audit
    ADD CONSTRAINT software_policy_audit_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: software_policy_audit software_policy_audit_policy_id_software_policies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.software_policy_audit
    ADD CONSTRAINT software_policy_audit_policy_id_software_policies_id_fk FOREIGN KEY (policy_id) REFERENCES public.software_policies(id) ON DELETE SET NULL;


--
-- Name: software_versions software_versions_catalog_id_software_catalog_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.software_versions
    ADD CONSTRAINT software_versions_catalog_id_software_catalog_id_fk FOREIGN KEY (catalog_id) REFERENCES public.software_catalog(id);


--
-- Name: sso_providers sso_providers_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sso_providers
    ADD CONSTRAINT sso_providers_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: sso_providers sso_providers_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sso_providers
    ADD CONSTRAINT sso_providers_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: sso_sessions sso_sessions_provider_id_sso_providers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sso_sessions
    ADD CONSTRAINT sso_sessions_provider_id_sso_providers_id_fk FOREIGN KEY (provider_id) REFERENCES public.sso_providers(id);


--
-- Name: ticket_comments ticket_comments_portal_user_id_portal_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_comments
    ADD CONSTRAINT ticket_comments_portal_user_id_portal_users_id_fk FOREIGN KEY (portal_user_id) REFERENCES public.portal_users(id);


--
-- Name: ticket_comments ticket_comments_ticket_id_tickets_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_comments
    ADD CONSTRAINT ticket_comments_ticket_id_tickets_id_fk FOREIGN KEY (ticket_id) REFERENCES public.tickets(id);


--
-- Name: ticket_comments ticket_comments_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_comments
    ADD CONSTRAINT ticket_comments_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: tickets tickets_assigned_to_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_assigned_to_users_id_fk FOREIGN KEY (assigned_to) REFERENCES public.users(id);


--
-- Name: tickets tickets_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: tickets tickets_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: tickets tickets_submitted_by_portal_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_submitted_by_portal_users_id_fk FOREIGN KEY (submitted_by) REFERENCES public.portal_users(id);


--
-- Name: time_series_metrics time_series_metrics_device_id_devices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.time_series_metrics
    ADD CONSTRAINT time_series_metrics_device_id_devices_id_fk FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: time_series_metrics time_series_metrics_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.time_series_metrics
    ADD CONSTRAINT time_series_metrics_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: user_notifications user_notifications_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_notifications
    ADD CONSTRAINT user_notifications_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: user_notifications user_notifications_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_notifications
    ADD CONSTRAINT user_notifications_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_sso_identities user_sso_identities_provider_id_sso_providers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sso_identities
    ADD CONSTRAINT user_sso_identities_provider_id_sso_providers_id_fk FOREIGN KEY (provider_id) REFERENCES public.sso_providers(id);


--
-- Name: user_sso_identities user_sso_identities_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sso_identities
    ADD CONSTRAINT user_sso_identities_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: webhook_deliveries webhook_deliveries_webhook_id_webhooks_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_webhook_id_webhooks_id_fk FOREIGN KEY (webhook_id) REFERENCES public.webhooks(id);


--
-- Name: webhooks webhooks_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhooks
    ADD CONSTRAINT webhooks_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: webhooks webhooks_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhooks
    ADD CONSTRAINT webhooks_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- PostgreSQL database dump complete
--


