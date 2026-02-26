--
-- PostgreSQL database dump
--

\restrict pG7mrjKd5jh3TbL2FdsVt23GPeUtF6jfPgtkPrKgug12iZCuMsiIhgWnRI7Yry4

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
-- Name: drizzle; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA drizzle;


--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


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
-- Name: agent_log_level; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.agent_log_level AS ENUM (
    'debug',
    'info',
    'warn',
    'error'
);


--
-- Name: ai_approval_mode; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.ai_approval_mode AS ENUM (
    'per_step',
    'action_plan',
    'auto_approve',
    'hybrid_plan'
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
-- Name: ai_plan_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.ai_plan_status AS ENUM (
    'pending',
    'approved',
    'rejected',
    'executing',
    'completed',
    'aborted'
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
-- Name: brain_context_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.brain_context_type AS ENUM (
    'issue',
    'quirk',
    'followup',
    'preference'
);


--
-- Name: change_action; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.change_action AS ENUM (
    'added',
    'removed',
    'modified',
    'updated'
);


--
-- Name: change_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.change_type AS ENUM (
    'software',
    'service',
    'startup',
    'network',
    'scheduled_task',
    'user_account'
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
-- Name: config_assignment_level; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.config_assignment_level AS ENUM (
    'partner',
    'organization',
    'site',
    'device_group',
    'device'
);


--
-- Name: config_feature_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.config_feature_type AS ENUM (
    'patch',
    'alert_rule',
    'backup',
    'security',
    'monitoring',
    'maintenance',
    'compliance',
    'automation',
    'event_log',
    'software_policy'
);


--
-- Name: config_policy_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.config_policy_status AS ENUM (
    'active',
    'inactive',
    'archived'
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
-- Name: discovered_asset_approval_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.discovered_asset_approval_status AS ENUM (
    'pending',
    'approved',
    'dismissed'
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
-- Name: dns_action; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.dns_action AS ENUM (
    'allowed',
    'blocked',
    'redirected'
);


--
-- Name: dns_policy_sync_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.dns_policy_sync_status AS ENUM (
    'pending',
    'synced',
    'error'
);


--
-- Name: dns_policy_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.dns_policy_type AS ENUM (
    'blocklist',
    'allowlist'
);


--
-- Name: dns_provider; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.dns_provider AS ENUM (
    'umbrella',
    'cloudflare',
    'dnsfilter',
    'pihole',
    'opendns',
    'quad9'
);


--
-- Name: dns_threat_category; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.dns_threat_category AS ENUM (
    'malware',
    'phishing',
    'botnet',
    'cryptomining',
    'ransomware',
    'spam',
    'adware',
    'adult_content',
    'gambling',
    'social_media',
    'streaming',
    'unknown'
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
-- Name: initiated_by_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.initiated_by_type AS ENUM (
    'manual',
    'ai',
    'automation',
    'policy',
    'schedule',
    'agent',
    'integration'
);


--
-- Name: ip_assignment_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.ip_assignment_type AS ENUM (
    'dhcp',
    'static',
    'vpn',
    'link-local',
    'unknown'
);


--
-- Name: log_correlation_severity; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.log_correlation_severity AS ENUM (
    'info',
    'warning',
    'error',
    'critical'
);


--
-- Name: log_correlation_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.log_correlation_status AS ENUM (
    'active',
    'resolved',
    'ignored'
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
-- Name: network_event_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.network_event_type AS ENUM (
    'new_device',
    'device_disappeared',
    'device_changed',
    'rogue_device'
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
-- Name: playbook_execution_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.playbook_execution_status AS ENUM (
    'pending',
    'running',
    'waiting',
    'completed',
    'failed',
    'rolled_back',
    'cancelled'
);


--
-- Name: playbook_step_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.playbook_step_type AS ENUM (
    'diagnose',
    'act',
    'wait',
    'verify',
    'rollback'
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
-- Name: trend_direction; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.trend_direction AS ENUM (
    'improving',
    'stable',
    'degrading'
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


--
-- Name: breeze_accessible_org_ids(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.breeze_accessible_org_ids() RETURNS uuid[]
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  raw text;
BEGIN
  raw := current_setting('breeze.accessible_org_ids', true);

  -- "*" means unrestricted org access (system scope).
  IF raw = '*' THEN
    RETURN NULL;
  END IF;

  -- Empty/missing means no org access.
  IF raw IS NULL OR raw = '' THEN
    RETURN ARRAY[]::uuid[];
  END IF;

  RETURN string_to_array(raw, ',')::uuid[];
EXCEPTION
  WHEN others THEN
    -- Fail closed on malformed values.
    RETURN ARRAY[]::uuid[];
END;
$$;


--
-- Name: breeze_current_scope(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.breeze_current_scope() RETURNS text
    LANGUAGE sql STABLE
    AS $$
  SELECT COALESCE(NULLIF(current_setting('breeze.scope', true), ''), 'none');
$$;


--
-- Name: breeze_has_org_access(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.breeze_has_org_access(target_org_id uuid) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT CASE
    WHEN public.breeze_current_scope() = 'system' THEN TRUE
    WHEN target_org_id IS NULL THEN FALSE
    ELSE COALESCE(target_org_id = ANY(public.breeze_accessible_org_ids()), FALSE)
  END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: __drizzle_migrations; Type: TABLE; Schema: drizzle; Owner: -
--

CREATE TABLE drizzle.__drizzle_migrations (
    id integer NOT NULL,
    hash text NOT NULL,
    created_at bigint
);


--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE; Schema: drizzle; Owner: -
--

CREATE SEQUENCE drizzle.__drizzle_migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: drizzle; Owner: -
--

ALTER SEQUENCE drizzle.__drizzle_migrations_id_seq OWNED BY drizzle.__drizzle_migrations.id;


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

ALTER TABLE ONLY public.access_reviews FORCE ROW LEVEL SECURITY;


--
-- Name: agent_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id uuid NOT NULL,
    org_id uuid NOT NULL,
    "timestamp" timestamp with time zone NOT NULL,
    level public.agent_log_level NOT NULL,
    component character varying(100) NOT NULL,
    message text NOT NULL,
    fields jsonb,
    agent_version character varying(50),
    created_at timestamp with time zone DEFAULT now() NOT NULL
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
-- Name: ai_action_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_action_plans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    org_id uuid NOT NULL,
    status public.ai_plan_status DEFAULT 'pending'::public.ai_plan_status NOT NULL,
    steps jsonb NOT NULL,
    current_step_index integer DEFAULT 0 NOT NULL,
    approved_by uuid,
    approved_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
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
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    approval_mode public.ai_approval_mode DEFAULT 'per_step'::public.ai_approval_mode NOT NULL
);

ALTER TABLE ONLY public.ai_budgets FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.ai_cost_usage FORCE ROW LEVEL SECURITY;


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
-- Name: ai_screenshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_screenshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id uuid NOT NULL,
    org_id uuid NOT NULL,
    session_id uuid,
    storage_key character varying(500) NOT NULL,
    width integer NOT NULL,
    height integer NOT NULL,
    size_bytes integer NOT NULL,
    captured_by character varying(50) DEFAULT 'agent'::character varying NOT NULL,
    reason character varying(200),
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
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
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    flagged_at timestamp with time zone,
    flagged_by uuid,
    flag_reason text,
    device_id uuid
);

ALTER TABLE ONLY public.ai_sessions FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.alert_rules FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.alert_templates FORCE ROW LEVEL SECURITY;


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
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    config_policy_id uuid,
    config_item_name character varying(200)
);

ALTER TABLE ONLY public.alerts FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.analytics_dashboards FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.api_keys FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.asset_checkouts FORCE ROW LEVEL SECURITY;


--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid,
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
    checksum character varying(128),
    initiated_by public.initiated_by_type
);

ALTER TABLE ONLY public.audit_logs FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.audit_retention_policies FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.automation_policies FORCE ROW LEVEL SECURITY;


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
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    config_policy_id uuid,
    config_item_name character varying(200)
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
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    config_policy_id uuid,
    config_item_name character varying(200)
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

ALTER TABLE ONLY public.automations FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.backup_configs FORCE ROW LEVEL SECURITY;


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
-- Name: brain_device_context; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.brain_device_context (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    device_id uuid NOT NULL,
    context_type public.brain_context_type NOT NULL,
    summary character varying(255) NOT NULL,
    details jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    resolved_at timestamp with time zone
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

ALTER TABLE ONLY public.capacity_predictions FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.capacity_thresholds FORCE ROW LEVEL SECURITY;


--
-- Name: config_policy_alert_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.config_policy_alert_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feature_link_id uuid NOT NULL,
    name character varying(200) NOT NULL,
    severity public.alert_severity NOT NULL,
    conditions jsonb NOT NULL,
    cooldown_minutes integer DEFAULT 5 NOT NULL,
    auto_resolve boolean DEFAULT false NOT NULL,
    auto_resolve_conditions jsonb,
    title_template text DEFAULT '{{ruleName}} triggered on {{deviceName}}'::text NOT NULL,
    message_template text DEFAULT '{{ruleName}} condition met'::text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: config_policy_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.config_policy_assignments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    config_policy_id uuid NOT NULL,
    level public.config_assignment_level NOT NULL,
    target_id uuid NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    assigned_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: config_policy_automations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.config_policy_automations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feature_link_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    trigger_type character varying(50) NOT NULL,
    cron_expression character varying(100),
    timezone character varying(100),
    event_type character varying(200),
    actions jsonb NOT NULL,
    on_failure public.automation_on_failure DEFAULT 'stop'::public.automation_on_failure NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: config_policy_compliance_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.config_policy_compliance_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feature_link_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    rules jsonb NOT NULL,
    enforcement_level public.policy_enforcement DEFAULT 'monitor'::public.policy_enforcement NOT NULL,
    check_interval_minutes integer DEFAULT 60 NOT NULL,
    remediation_script_id uuid,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: config_policy_event_log_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.config_policy_event_log_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feature_link_id uuid NOT NULL,
    retention_days integer DEFAULT 30 NOT NULL,
    max_events_per_cycle integer DEFAULT 100 NOT NULL,
    collect_categories text[] DEFAULT ARRAY['security'::text, 'hardware'::text, 'application'::text, 'system'::text] NOT NULL,
    minimum_level public.event_log_level DEFAULT 'info'::public.event_log_level NOT NULL,
    collection_interval_minutes integer DEFAULT 5 NOT NULL,
    rate_limit_per_hour integer DEFAULT 12000 NOT NULL,
    enable_full_text_search boolean DEFAULT true NOT NULL,
    enable_correlation boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: config_policy_feature_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.config_policy_feature_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    config_policy_id uuid NOT NULL,
    feature_type public.config_feature_type NOT NULL,
    feature_policy_id uuid,
    inline_settings jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: config_policy_maintenance_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.config_policy_maintenance_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feature_link_id uuid NOT NULL,
    recurrence character varying(20) DEFAULT 'weekly'::character varying NOT NULL,
    duration_hours integer DEFAULT 2 NOT NULL,
    timezone character varying(100) DEFAULT 'UTC'::character varying NOT NULL,
    window_start character varying(30),
    suppress_alerts boolean DEFAULT true NOT NULL,
    suppress_patching boolean DEFAULT false NOT NULL,
    suppress_automations boolean DEFAULT false NOT NULL,
    suppress_scripts boolean DEFAULT false NOT NULL,
    notify_before_minutes integer DEFAULT 15,
    notify_on_start boolean DEFAULT true NOT NULL,
    notify_on_end boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: config_policy_patch_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.config_policy_patch_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feature_link_id uuid NOT NULL,
    sources text[] DEFAULT ARRAY['os'::text] NOT NULL,
    auto_approve boolean DEFAULT false NOT NULL,
    auto_approve_severities text[] DEFAULT '{}'::text[],
    schedule_frequency character varying(20) DEFAULT 'weekly'::character varying NOT NULL,
    schedule_time character varying(10) DEFAULT '02:00'::character varying NOT NULL,
    schedule_day_of_week character varying(10) DEFAULT 'sun'::character varying,
    schedule_day_of_month integer DEFAULT 1,
    reboot_policy character varying(20) DEFAULT 'if_required'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: configuration_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.configuration_policies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    status public.config_policy_status DEFAULT 'active'::public.config_policy_status NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
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

ALTER TABLE ONLY public.custom_field_definitions FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.deployments FORCE ROW LEVEL SECURITY;


--
-- Name: device_boot_metrics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_boot_metrics (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id uuid NOT NULL,
    org_id uuid NOT NULL,
    boot_timestamp timestamp with time zone NOT NULL,
    bios_seconds real,
    os_loader_seconds real,
    desktop_ready_seconds real,
    total_boot_seconds real NOT NULL,
    startup_item_count integer NOT NULL,
    startup_items jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: device_change_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_change_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id uuid NOT NULL,
    org_id uuid NOT NULL,
    fingerprint character varying(64) NOT NULL,
    "timestamp" timestamp without time zone NOT NULL,
    change_type public.change_type NOT NULL,
    change_action public.change_action NOT NULL,
    subject character varying(500) NOT NULL,
    before_value jsonb,
    after_value jsonb,
    details jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.device_change_log FORCE ROW LEVEL SECURITY;


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
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    search_vector tsvector GENERATED ALWAYS AS (((setweight(to_tsvector('english'::regconfig, (COALESCE(source, ''::character varying))::text), 'A'::"char") || setweight(to_tsvector('english'::regconfig, COALESCE(message, ''::text)), 'B'::"char")) || setweight(to_tsvector('english'::regconfig, (COALESCE(event_id, ''::character varying))::text), 'C'::"char"))) STORED
);

ALTER TABLE ONLY public.device_event_logs FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.device_groups FORCE ROW LEVEL SECURITY;


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
-- Name: device_ip_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_ip_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id uuid NOT NULL,
    org_id uuid NOT NULL,
    interface_name character varying(100) NOT NULL,
    ip_address character varying(45) NOT NULL,
    ip_type character varying(4) DEFAULT 'ipv4'::character varying NOT NULL,
    assignment_type public.ip_assignment_type DEFAULT 'unknown'::public.ip_assignment_type NOT NULL,
    mac_address character varying(17),
    subnet_mask character varying(45),
    gateway character varying(45),
    dns_servers text[],
    first_seen timestamp without time zone DEFAULT now() NOT NULL,
    last_seen timestamp without time zone DEFAULT now() NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    deactivated_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.device_ip_history FORCE ROW LEVEL SECURITY;


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
    custom_metrics jsonb,
    disk_activity_available boolean,
    disk_read_bytes bigint,
    disk_write_bytes bigint,
    disk_read_bps bigint,
    disk_write_bps bigint,
    disk_read_ops bigint,
    disk_write_ops bigint
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
-- Name: device_reliability; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_reliability (
    device_id uuid NOT NULL,
    org_id uuid NOT NULL,
    computed_at timestamp without time zone DEFAULT now() NOT NULL,
    reliability_score integer NOT NULL,
    uptime_score integer NOT NULL,
    crash_score integer NOT NULL,
    hang_score integer NOT NULL,
    service_failure_score integer NOT NULL,
    hardware_error_score integer NOT NULL,
    uptime_7d real NOT NULL,
    uptime_30d real NOT NULL,
    uptime_90d real NOT NULL,
    crash_count_7d integer DEFAULT 0 NOT NULL,
    crash_count_30d integer DEFAULT 0 NOT NULL,
    crash_count_90d integer DEFAULT 0 NOT NULL,
    hang_count_7d integer DEFAULT 0 NOT NULL,
    hang_count_30d integer DEFAULT 0 NOT NULL,
    hang_count_90d integer DEFAULT 0 NOT NULL,
    service_failure_count_7d integer DEFAULT 0 NOT NULL,
    service_failure_count_30d integer DEFAULT 0 NOT NULL,
    hardware_error_count_7d integer DEFAULT 0 NOT NULL,
    hardware_error_count_30d integer DEFAULT 0 NOT NULL,
    mtbf_hours real,
    trend_direction public.trend_direction NOT NULL,
    trend_confidence real DEFAULT 0 NOT NULL,
    top_issues jsonb DEFAULT '[]'::jsonb NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT device_reliability_crash_score_check CHECK (((crash_score >= 0) AND (crash_score <= 100))),
    CONSTRAINT device_reliability_hang_score_check CHECK (((hang_score >= 0) AND (hang_score <= 100))),
    CONSTRAINT device_reliability_hardware_error_score_check CHECK (((hardware_error_score >= 0) AND (hardware_error_score <= 100))),
    CONSTRAINT device_reliability_reliability_score_check CHECK (((reliability_score >= 0) AND (reliability_score <= 100))),
    CONSTRAINT device_reliability_service_failure_score_check CHECK (((service_failure_score >= 0) AND (service_failure_score <= 100))),
    CONSTRAINT device_reliability_trend_confidence_check CHECK (((trend_confidence >= (0)::double precision) AND (trend_confidence <= (1)::double precision))),
    CONSTRAINT device_reliability_uptime_30d_check CHECK (((uptime_30d >= (0)::double precision) AND (uptime_30d <= (100)::double precision))),
    CONSTRAINT device_reliability_uptime_7d_check CHECK (((uptime_7d >= (0)::double precision) AND (uptime_7d <= (100)::double precision))),
    CONSTRAINT device_reliability_uptime_90d_check CHECK (((uptime_90d >= (0)::double precision) AND (uptime_90d <= (100)::double precision))),
    CONSTRAINT device_reliability_uptime_score_check CHECK (((uptime_score >= 0) AND (uptime_score <= 100)))
);

ALTER TABLE ONLY public.device_reliability FORCE ROW LEVEL SECURITY;


--
-- Name: device_reliability_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_reliability_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id uuid NOT NULL,
    org_id uuid NOT NULL,
    collected_at timestamp without time zone DEFAULT now() NOT NULL,
    uptime_seconds bigint NOT NULL,
    boot_time timestamp without time zone NOT NULL,
    crash_events jsonb DEFAULT '[]'::jsonb NOT NULL,
    app_hangs jsonb DEFAULT '[]'::jsonb NOT NULL,
    service_failures jsonb DEFAULT '[]'::jsonb NOT NULL,
    hardware_errors jsonb DEFAULT '[]'::jsonb NOT NULL,
    raw_metrics jsonb DEFAULT '{}'::jsonb NOT NULL
);

ALTER TABLE ONLY public.device_reliability_history FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.device_sessions FORCE ROW LEVEL SECURITY;


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
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    last_user character varying(255),
    uptime_seconds integer,
    management_posture jsonb
);

ALTER TABLE ONLY public.devices FORCE ROW LEVEL SECURITY;


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
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    approval_status public.discovered_asset_approval_status DEFAULT 'pending'::public.discovered_asset_approval_status NOT NULL,
    is_online boolean DEFAULT false NOT NULL,
    approved_by uuid,
    approved_at timestamp with time zone,
    dismissed_by uuid,
    dismissed_at timestamp with time zone,
    label character varying(255)
);

ALTER TABLE ONLY public.discovered_assets FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.discovery_jobs FORCE ROW LEVEL SECURITY;


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
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    alert_settings jsonb
);

ALTER TABLE ONLY public.discovery_profiles FORCE ROW LEVEL SECURITY;


--
-- Name: dns_event_aggregations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dns_event_aggregations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    date date NOT NULL,
    device_id uuid,
    domain character varying(500),
    category public.dns_threat_category,
    total_queries integer DEFAULT 0 NOT NULL,
    blocked_queries integer DEFAULT 0 NOT NULL,
    allowed_queries integer DEFAULT 0 NOT NULL,
    integration_id uuid
);

ALTER TABLE ONLY public.dns_event_aggregations FORCE ROW LEVEL SECURITY;


--
-- Name: dns_filter_integrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dns_filter_integrations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    provider public.dns_provider NOT NULL,
    name character varying(200) NOT NULL,
    description text,
    api_key text,
    api_secret text,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    last_sync timestamp without time zone,
    last_sync_status character varying(20),
    last_sync_error text,
    total_events_processed integer DEFAULT 0 NOT NULL,
    created_by uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.dns_filter_integrations FORCE ROW LEVEL SECURITY;


--
-- Name: dns_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dns_policies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    integration_id uuid NOT NULL,
    name character varying(200) NOT NULL,
    description text,
    type public.dns_policy_type NOT NULL,
    domains jsonb DEFAULT '[]'::jsonb NOT NULL,
    categories jsonb DEFAULT '[]'::jsonb NOT NULL,
    sync_status public.dns_policy_sync_status DEFAULT 'pending'::public.dns_policy_sync_status NOT NULL,
    last_synced timestamp without time zone,
    sync_error text,
    is_active boolean DEFAULT true NOT NULL,
    created_by uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.dns_policies FORCE ROW LEVEL SECURITY;


--
-- Name: dns_security_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dns_security_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    integration_id uuid NOT NULL,
    device_id uuid,
    "timestamp" timestamp without time zone NOT NULL,
    domain character varying(500) NOT NULL,
    query_type character varying(10) DEFAULT 'A'::character varying NOT NULL,
    action public.dns_action NOT NULL,
    category public.dns_threat_category,
    threat_type character varying(100),
    threat_score integer,
    source_ip character varying(45),
    source_hostname character varying(255),
    provider_event_id character varying(255) NOT NULL,
    metadata jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.dns_security_events FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.enrollment_keys FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.escalation_policies FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.event_bus_events FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.executive_summaries FORCE ROW LEVEL SECURITY;


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
-- Name: log_correlation_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.log_correlation_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name character varying(200) NOT NULL,
    description text,
    pattern text NOT NULL,
    is_regex boolean DEFAULT false NOT NULL,
    min_occurrences integer DEFAULT 3 NOT NULL,
    min_devices integer DEFAULT 2 NOT NULL,
    time_window integer DEFAULT 300 NOT NULL,
    severity public.log_correlation_severity DEFAULT 'warning'::public.log_correlation_severity NOT NULL,
    alert_on_match boolean DEFAULT true NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    last_matched_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.log_correlation_rules FORCE ROW LEVEL SECURITY;


--
-- Name: log_correlations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.log_correlations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    rule_id uuid NOT NULL,
    pattern text NOT NULL,
    first_seen timestamp without time zone NOT NULL,
    last_seen timestamp without time zone NOT NULL,
    occurrences integer NOT NULL,
    affected_devices jsonb NOT NULL,
    sample_logs jsonb,
    alert_id uuid,
    status public.log_correlation_status DEFAULT 'active'::public.log_correlation_status NOT NULL,
    resolved_at timestamp without time zone,
    resolved_by uuid,
    notes text,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.log_correlations FORCE ROW LEVEL SECURITY;


--
-- Name: log_search_queries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.log_search_queries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name character varying(200) NOT NULL,
    description text,
    filters jsonb NOT NULL,
    created_by uuid,
    is_shared boolean DEFAULT false NOT NULL,
    run_count integer DEFAULT 0 NOT NULL,
    last_run_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.log_search_queries FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.maintenance_windows FORCE ROW LEVEL SECURITY;


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
-- Name: network_baselines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.network_baselines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    site_id uuid NOT NULL,
    subnet character varying(50) NOT NULL,
    last_scan_at timestamp without time zone,
    last_scan_job_id uuid,
    known_devices jsonb DEFAULT '[]'::jsonb NOT NULL,
    scan_schedule jsonb,
    alert_settings jsonb DEFAULT '{"changed": true, "newDevice": true, "disappeared": true, "rogueDevice": false}'::jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.network_baselines FORCE ROW LEVEL SECURITY;


--
-- Name: network_change_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.network_change_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    site_id uuid NOT NULL,
    baseline_id uuid NOT NULL,
    event_type public.network_event_type NOT NULL,
    ip_address inet NOT NULL,
    mac_address character varying(17),
    hostname character varying(255),
    asset_type public.discovered_asset_type,
    previous_state jsonb,
    current_state jsonb,
    detected_at timestamp without time zone DEFAULT now() NOT NULL,
    acknowledged boolean DEFAULT false NOT NULL,
    acknowledged_by uuid,
    acknowledged_at timestamp without time zone,
    alert_id uuid,
    linked_device_id uuid,
    notes text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    profile_id uuid
);

ALTER TABLE ONLY public.network_change_events FORCE ROW LEVEL SECURITY;


--
-- Name: network_known_guests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.network_known_guests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    partner_id uuid NOT NULL,
    mac_address character varying(17) NOT NULL,
    label character varying(255) NOT NULL,
    notes text,
    added_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.network_known_guests FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.network_monitors FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.network_topology FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.notification_channels FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.organization_users FORCE ROW LEVEL SECURITY;


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
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    ring_id uuid
);

ALTER TABLE ONLY public.patch_approvals FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.patch_compliance_reports FORCE ROW LEVEL SECURITY;


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
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    ring_id uuid
);

ALTER TABLE ONLY public.patch_compliance_snapshots FORCE ROW LEVEL SECURITY;


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
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    ring_id uuid,
    config_policy_id uuid
);

ALTER TABLE ONLY public.patch_jobs FORCE ROW LEVEL SECURITY;


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
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    ring_order integer DEFAULT 0 NOT NULL,
    deferral_days integer DEFAULT 0 NOT NULL,
    deadline_days integer,
    grace_period_hours integer DEFAULT 4 NOT NULL,
    categories text[] DEFAULT '{}'::text[] NOT NULL,
    exclude_categories text[] DEFAULT '{}'::text[] NOT NULL,
    category_rules jsonb DEFAULT '[]'::jsonb NOT NULL
);

ALTER TABLE ONLY public.patch_policies FORCE ROW LEVEL SECURITY;


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
-- Name: playbook_definitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.playbook_definitions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid,
    name character varying(255) NOT NULL,
    description text NOT NULL,
    steps jsonb NOT NULL,
    trigger_conditions jsonb,
    is_built_in boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    category character varying(50),
    required_permissions jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.playbook_definitions FORCE ROW LEVEL SECURITY;


--
-- Name: playbook_executions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.playbook_executions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    device_id uuid NOT NULL,
    playbook_id uuid NOT NULL,
    status public.playbook_execution_status DEFAULT 'pending'::public.playbook_execution_status NOT NULL,
    current_step_index integer DEFAULT 0 NOT NULL,
    steps jsonb DEFAULT '[]'::jsonb NOT NULL,
    context jsonb,
    error_message text,
    rollback_executed boolean DEFAULT false NOT NULL,
    started_at timestamp without time zone,
    completed_at timestamp without time zone,
    triggered_by character varying(50) NOT NULL,
    triggered_by_user_id uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.playbook_executions FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.plugin_installations FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.plugin_instances FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.plugins FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.policies FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.portal_branding FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.portal_users FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.psa_connections FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.reports FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.roles FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.saved_filters FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.saved_queries FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.script_categories FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.script_tags FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.scripts FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.security_policies FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.security_posture_org_snapshots FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.security_posture_snapshots FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.sites FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.sla_compliance FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.sla_definitions FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.snmp_devices FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.software_compliance_status FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.software_deployments FORCE ROW LEVEL SECURITY;


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
    last_seen timestamp without time zone,
    file_hash character varying(128),
    hash_algorithm character varying(10)
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
    target_type character varying(50),
    target_ids jsonb,
    priority integer DEFAULT 50 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    enforce_mode boolean DEFAULT false NOT NULL,
    remediation_options jsonb,
    created_by uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.software_policies FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.software_policy_audit FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.sso_providers FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.tickets FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.time_series_metrics FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.user_notifications FORCE ROW LEVEL SECURITY;


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

ALTER TABLE ONLY public.webhooks FORCE ROW LEVEL SECURITY;


--
-- Name: __drizzle_migrations id; Type: DEFAULT; Schema: drizzle; Owner: -
--

ALTER TABLE ONLY drizzle.__drizzle_migrations ALTER COLUMN id SET DEFAULT nextval('drizzle.__drizzle_migrations_id_seq'::regclass);


--
-- Name: __drizzle_migrations __drizzle_migrations_pkey; Type: CONSTRAINT; Schema: drizzle; Owner: -
--

ALTER TABLE ONLY drizzle.__drizzle_migrations
    ADD CONSTRAINT __drizzle_migrations_pkey PRIMARY KEY (id);


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
-- Name: agent_logs agent_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_logs
    ADD CONSTRAINT agent_logs_pkey PRIMARY KEY (id);


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
-- Name: ai_action_plans ai_action_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_action_plans
    ADD CONSTRAINT ai_action_plans_pkey PRIMARY KEY (id);


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
-- Name: ai_screenshots ai_screenshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_screenshots
    ADD CONSTRAINT ai_screenshots_pkey PRIMARY KEY (id);


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
-- Name: brain_device_context brain_device_context_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brain_device_context
    ADD CONSTRAINT brain_device_context_pkey PRIMARY KEY (id);


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
-- Name: config_policy_alert_rules config_policy_alert_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_policy_alert_rules
    ADD CONSTRAINT config_policy_alert_rules_pkey PRIMARY KEY (id);


--
-- Name: config_policy_assignments config_policy_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_policy_assignments
    ADD CONSTRAINT config_policy_assignments_pkey PRIMARY KEY (id);


--
-- Name: config_policy_automations config_policy_automations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_policy_automations
    ADD CONSTRAINT config_policy_automations_pkey PRIMARY KEY (id);


--
-- Name: config_policy_compliance_rules config_policy_compliance_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_policy_compliance_rules
    ADD CONSTRAINT config_policy_compliance_rules_pkey PRIMARY KEY (id);


--
-- Name: config_policy_event_log_settings config_policy_event_log_settings_feature_link_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_policy_event_log_settings
    ADD CONSTRAINT config_policy_event_log_settings_feature_link_id_key UNIQUE (feature_link_id);


--
-- Name: config_policy_event_log_settings config_policy_event_log_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_policy_event_log_settings
    ADD CONSTRAINT config_policy_event_log_settings_pkey PRIMARY KEY (id);


--
-- Name: config_policy_feature_links config_policy_feature_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_policy_feature_links
    ADD CONSTRAINT config_policy_feature_links_pkey PRIMARY KEY (id);


--
-- Name: config_policy_maintenance_settings config_policy_maintenance_settings_feature_link_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_policy_maintenance_settings
    ADD CONSTRAINT config_policy_maintenance_settings_feature_link_id_key UNIQUE (feature_link_id);


--
-- Name: config_policy_maintenance_settings config_policy_maintenance_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_policy_maintenance_settings
    ADD CONSTRAINT config_policy_maintenance_settings_pkey PRIMARY KEY (id);


--
-- Name: config_policy_patch_settings config_policy_patch_settings_feature_link_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_policy_patch_settings
    ADD CONSTRAINT config_policy_patch_settings_feature_link_id_key UNIQUE (feature_link_id);


--
-- Name: config_policy_patch_settings config_policy_patch_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_policy_patch_settings
    ADD CONSTRAINT config_policy_patch_settings_pkey PRIMARY KEY (id);


--
-- Name: configuration_policies configuration_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.configuration_policies
    ADD CONSTRAINT configuration_policies_pkey PRIMARY KEY (id);


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
-- Name: device_boot_metrics device_boot_metrics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_boot_metrics
    ADD CONSTRAINT device_boot_metrics_pkey PRIMARY KEY (id);


--
-- Name: device_change_log device_change_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_change_log
    ADD CONSTRAINT device_change_log_pkey PRIMARY KEY (id);


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
-- Name: device_ip_history device_ip_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_ip_history
    ADD CONSTRAINT device_ip_history_pkey PRIMARY KEY (id);


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
-- Name: device_reliability_history device_reliability_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_reliability_history
    ADD CONSTRAINT device_reliability_history_pkey PRIMARY KEY (id);


--
-- Name: device_reliability device_reliability_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_reliability
    ADD CONSTRAINT device_reliability_pkey PRIMARY KEY (device_id);


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
-- Name: dns_event_aggregations dns_event_aggregations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dns_event_aggregations
    ADD CONSTRAINT dns_event_aggregations_pkey PRIMARY KEY (id);


--
-- Name: dns_filter_integrations dns_filter_integrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dns_filter_integrations
    ADD CONSTRAINT dns_filter_integrations_pkey PRIMARY KEY (id);


--
-- Name: dns_policies dns_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dns_policies
    ADD CONSTRAINT dns_policies_pkey PRIMARY KEY (id);


--
-- Name: dns_security_events dns_security_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dns_security_events
    ADD CONSTRAINT dns_security_events_pkey PRIMARY KEY (id);


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
-- Name: log_correlation_rules log_correlation_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.log_correlation_rules
    ADD CONSTRAINT log_correlation_rules_pkey PRIMARY KEY (id);


--
-- Name: log_correlations log_correlations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.log_correlations
    ADD CONSTRAINT log_correlations_pkey PRIMARY KEY (id);


--
-- Name: log_search_queries log_search_queries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.log_search_queries
    ADD CONSTRAINT log_search_queries_pkey PRIMARY KEY (id);


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
-- Name: network_baselines network_baselines_org_site_subnet_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.network_baselines
    ADD CONSTRAINT network_baselines_org_site_subnet_unique UNIQUE (org_id, site_id, subnet);


--
-- Name: network_baselines network_baselines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.network_baselines
    ADD CONSTRAINT network_baselines_pkey PRIMARY KEY (id);


--
-- Name: network_change_events network_change_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.network_change_events
    ADD CONSTRAINT network_change_events_pkey PRIMARY KEY (id);


--
-- Name: network_known_guests network_known_guests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.network_known_guests
    ADD CONSTRAINT network_known_guests_pkey PRIMARY KEY (id);


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
-- Name: playbook_definitions playbook_definitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_definitions
    ADD CONSTRAINT playbook_definitions_pkey PRIMARY KEY (id);


--
-- Name: playbook_executions playbook_executions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_executions
    ADD CONSTRAINT playbook_executions_pkey PRIMARY KEY (id);


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
-- Name: agent_logs_device_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_logs_device_idx ON public.agent_logs USING btree (device_id);


--
-- Name: agent_logs_level_component_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_logs_level_component_idx ON public.agent_logs USING btree (level, component);


--
-- Name: agent_logs_org_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_logs_org_ts_idx ON public.agent_logs USING btree (org_id, "timestamp");


--
-- Name: agent_logs_timestamp_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_logs_timestamp_idx ON public.agent_logs USING btree ("timestamp");


--
-- Name: agent_versions_is_latest_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_versions_is_latest_idx ON public.agent_versions USING btree (is_latest);


--
-- Name: ai_action_plans_session_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_action_plans_session_id_idx ON public.ai_action_plans USING btree (session_id);


--
-- Name: ai_action_plans_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_action_plans_status_idx ON public.ai_action_plans USING btree (status);


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
-- Name: ai_screenshots_device_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_screenshots_device_id_idx ON public.ai_screenshots USING btree (device_id);


--
-- Name: ai_screenshots_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_screenshots_expires_at_idx ON public.ai_screenshots USING btree (expires_at);


--
-- Name: ai_screenshots_org_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_screenshots_org_id_idx ON public.ai_screenshots USING btree (org_id);


--
-- Name: ai_sessions_device_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_sessions_device_id_idx ON public.ai_sessions USING btree (device_id);


--
-- Name: ai_sessions_flagged_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_sessions_flagged_at_idx ON public.ai_sessions USING btree (flagged_at) WHERE (flagged_at IS NOT NULL);


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
-- Name: apc_config_policy_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX apc_config_policy_id_idx ON public.automation_policy_compliance USING btree (config_policy_id);


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
-- Name: brain_device_context_device_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX brain_device_context_device_active_idx ON public.brain_device_context USING btree (device_id, resolved_at);


--
-- Name: brain_device_context_device_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX brain_device_context_device_id_idx ON public.brain_device_context USING btree (device_id);


--
-- Name: brain_device_context_device_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX brain_device_context_device_type_idx ON public.brain_device_context USING btree (device_id, context_type);


--
-- Name: brain_device_context_org_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX brain_device_context_org_id_idx ON public.brain_device_context USING btree (org_id);


--
-- Name: config_assignments_level_target_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX config_assignments_level_target_idx ON public.config_policy_assignments USING btree (level, target_id);


--
-- Name: config_assignments_policy_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX config_assignments_policy_id_idx ON public.config_policy_assignments USING btree (config_policy_id);


--
-- Name: config_assignments_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX config_assignments_unique ON public.config_policy_assignments USING btree (config_policy_id, level, target_id);


--
-- Name: config_feature_links_feature_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX config_feature_links_feature_type_idx ON public.config_policy_feature_links USING btree (feature_type);


--
-- Name: config_feature_links_policy_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX config_feature_links_policy_id_idx ON public.config_policy_feature_links USING btree (config_policy_id);


--
-- Name: config_feature_links_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX config_feature_links_unique ON public.config_policy_feature_links USING btree (config_policy_id, feature_type);


--
-- Name: config_policies_org_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX config_policies_org_id_idx ON public.configuration_policies USING btree (org_id);


--
-- Name: config_policies_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX config_policies_status_idx ON public.configuration_policies USING btree (status);


--
-- Name: cpar_feature_link_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cpar_feature_link_id_idx ON public.config_policy_alert_rules USING btree (feature_link_id);


--
-- Name: cpaut_feature_link_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cpaut_feature_link_id_idx ON public.config_policy_automations USING btree (feature_link_id);


--
-- Name: cpaut_trigger_type_enabled_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cpaut_trigger_type_enabled_idx ON public.config_policy_automations USING btree (trigger_type);


--
-- Name: cpcr_feature_link_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cpcr_feature_link_id_idx ON public.config_policy_compliance_rules USING btree (feature_link_id);


--
-- Name: cpels_feature_link_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cpels_feature_link_id_idx ON public.config_policy_event_log_settings USING btree (feature_link_id);


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
-- Name: device_boot_metrics_device_boot_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_boot_metrics_device_boot_idx ON public.device_boot_metrics USING btree (device_id, boot_timestamp);


--
-- Name: device_boot_metrics_device_boot_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX device_boot_metrics_device_boot_uniq ON public.device_boot_metrics USING btree (device_id, boot_timestamp);


--
-- Name: device_boot_metrics_device_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_boot_metrics_device_created_idx ON public.device_boot_metrics USING btree (device_id, created_at);


--
-- Name: device_boot_metrics_org_device_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_boot_metrics_org_device_idx ON public.device_boot_metrics USING btree (org_id, device_id);


--
-- Name: device_change_log_action_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_change_log_action_idx ON public.device_change_log USING btree (change_action);


--
-- Name: device_change_log_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_change_log_created_at_idx ON public.device_change_log USING btree (created_at);


--
-- Name: device_change_log_device_fingerprint_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX device_change_log_device_fingerprint_uniq ON public.device_change_log USING btree (device_id, fingerprint);


--
-- Name: device_change_log_device_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_change_log_device_id_idx ON public.device_change_log USING btree (device_id);


--
-- Name: device_change_log_device_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_change_log_device_time_idx ON public.device_change_log USING btree (device_id, "timestamp");


--
-- Name: device_change_log_org_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_change_log_org_id_idx ON public.device_change_log USING btree (org_id);


--
-- Name: device_change_log_org_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_change_log_org_time_idx ON public.device_change_log USING btree (org_id, "timestamp");


--
-- Name: device_change_log_timestamp_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_change_log_timestamp_idx ON public.device_change_log USING btree ("timestamp");


--
-- Name: device_change_log_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_change_log_type_idx ON public.device_change_log USING btree (change_type);


--
-- Name: device_connections_device_listening_port_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_connections_device_listening_port_idx ON public.device_connections USING btree (device_id, local_port) WHERE ((remote_addr IS NULL) OR (lower((state)::text) ~~ 'listen%'::text));


--
-- Name: device_connections_device_port_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_connections_device_port_state_idx ON public.device_connections USING btree (device_id, local_port, state);


--
-- Name: device_connections_device_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_connections_device_updated_idx ON public.device_connections USING btree (device_id, updated_at);


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
-- Name: device_event_logs_message_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_event_logs_message_trgm_idx ON public.device_event_logs USING gin (message public.gin_trgm_ops);


--
-- Name: device_event_logs_org_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_event_logs_org_ts_idx ON public.device_event_logs USING btree (org_id, "timestamp");


--
-- Name: device_event_logs_search_vector_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_event_logs_search_vector_idx ON public.device_event_logs USING gin (search_vector);


--
-- Name: device_event_logs_source_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_event_logs_source_trgm_idx ON public.device_event_logs USING gin (source public.gin_trgm_ops);


--
-- Name: device_ip_history_active_assignment_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX device_ip_history_active_assignment_uniq ON public.device_ip_history USING btree (device_id, interface_name, ip_address, ip_type) WHERE (is_active = true);


--
-- Name: device_ip_history_device_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_ip_history_device_id_idx ON public.device_ip_history USING btree (device_id);


--
-- Name: device_ip_history_first_seen_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_ip_history_first_seen_idx ON public.device_ip_history USING btree (first_seen);


--
-- Name: device_ip_history_ip_address_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_ip_history_ip_address_idx ON public.device_ip_history USING btree (ip_address);


--
-- Name: device_ip_history_ip_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_ip_history_ip_time_idx ON public.device_ip_history USING btree (ip_address, first_seen, last_seen);


--
-- Name: device_ip_history_is_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_ip_history_is_active_idx ON public.device_ip_history USING btree (is_active);


--
-- Name: device_ip_history_last_seen_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_ip_history_last_seen_idx ON public.device_ip_history USING btree (last_seen);


--
-- Name: device_ip_history_org_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_ip_history_org_id_idx ON public.device_ip_history USING btree (org_id);


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
-- Name: devices_management_posture_categories_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX devices_management_posture_categories_idx ON public.devices USING gin (((management_posture -> 'categories'::text)));


--
-- Name: devices_management_posture_collected_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX devices_management_posture_collected_idx ON public.devices USING btree (((management_posture ->> 'collectedAt'::text)));


--
-- Name: devices_management_posture_join_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX devices_management_posture_join_type_idx ON public.devices USING btree ((((management_posture -> 'identity'::text) ->> 'joinType'::text)));


--
-- Name: devices_mtls_cert_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX devices_mtls_cert_expires_idx ON public.devices USING btree (mtls_cert_expires_at) WHERE ((mtls_cert_expires_at IS NOT NULL) AND (status <> 'decommissioned'::public.device_status));


--
-- Name: devices_quarantined_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX devices_quarantined_idx ON public.devices USING btree (org_id, status) WHERE (status = 'quarantined'::public.device_status);


--
-- Name: discovered_assets_org_ip_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX discovered_assets_org_ip_unique ON public.discovered_assets USING btree (org_id, ip_address);


--
-- Name: dns_event_agg_device_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dns_event_agg_device_id_idx ON public.dns_event_aggregations USING btree (device_id);


--
-- Name: dns_event_agg_integration_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dns_event_agg_integration_id_idx ON public.dns_event_aggregations USING btree (integration_id);


--
-- Name: dns_event_agg_org_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dns_event_agg_org_date_idx ON public.dns_event_aggregations USING btree (org_id, date DESC);


--
-- Name: dns_event_agg_org_date_integration_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dns_event_agg_org_date_integration_idx ON public.dns_event_aggregations USING btree (org_id, date DESC, integration_id);


--
-- Name: dns_filter_integrations_org_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dns_filter_integrations_org_id_idx ON public.dns_filter_integrations USING btree (org_id);


--
-- Name: dns_filter_integrations_provider_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dns_filter_integrations_provider_idx ON public.dns_filter_integrations USING btree (provider);


--
-- Name: dns_policies_integration_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dns_policies_integration_id_idx ON public.dns_policies USING btree (integration_id);


--
-- Name: dns_policies_org_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dns_policies_org_id_idx ON public.dns_policies USING btree (org_id);


--
-- Name: dns_security_events_action_cat_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dns_security_events_action_cat_idx ON public.dns_security_events USING btree (action, category);


--
-- Name: dns_security_events_device_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dns_security_events_device_id_idx ON public.dns_security_events USING btree (device_id);


--
-- Name: dns_security_events_domain_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dns_security_events_domain_idx ON public.dns_security_events USING btree (domain);


--
-- Name: dns_security_events_integration_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dns_security_events_integration_id_idx ON public.dns_security_events USING btree (integration_id);


--
-- Name: dns_security_events_org_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dns_security_events_org_ts_idx ON public.dns_security_events USING btree (org_id, "timestamp" DESC);


--
-- Name: dns_security_events_provider_evt_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX dns_security_events_provider_evt_uniq ON public.dns_security_events USING btree (integration_id, provider_event_id);


--
-- Name: dns_security_events_provider_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dns_security_events_provider_id_idx ON public.dns_security_events USING btree (integration_id, provider_event_id);


--
-- Name: idx_audit_logs_initiated_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_initiated_by ON public.audit_logs USING btree (initiated_by);


--
-- Name: idx_device_filesystem_cleanup_runs_device_requested; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_filesystem_cleanup_runs_device_requested ON public.device_filesystem_cleanup_runs USING btree (device_id, requested_at);


--
-- Name: idx_device_filesystem_snapshots_device_captured; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_filesystem_snapshots_device_captured ON public.device_filesystem_snapshots USING btree (device_id, captured_at);


--
-- Name: idx_patch_approvals_ring_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_patch_approvals_ring_id ON public.patch_approvals USING btree (ring_id) WHERE (ring_id IS NOT NULL);


--
-- Name: idx_patch_compliance_snapshots_ring_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_patch_compliance_snapshots_ring_id ON public.patch_compliance_snapshots USING btree (ring_id) WHERE (ring_id IS NOT NULL);


--
-- Name: idx_patch_jobs_ring_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_patch_jobs_ring_id ON public.patch_jobs USING btree (ring_id) WHERE (ring_id IS NOT NULL);


--
-- Name: idx_patch_policies_ring_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_patch_policies_ring_order ON public.patch_policies USING btree (org_id, ring_order);


--
-- Name: log_correlation_rules_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX log_correlation_rules_active_idx ON public.log_correlation_rules USING btree (is_active);


--
-- Name: log_correlation_rules_org_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX log_correlation_rules_org_id_idx ON public.log_correlation_rules USING btree (org_id);


--
-- Name: log_correlations_org_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX log_correlations_org_id_idx ON public.log_correlations USING btree (org_id);


--
-- Name: log_correlations_rule_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX log_correlations_rule_id_idx ON public.log_correlations USING btree (rule_id);


--
-- Name: log_correlations_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX log_correlations_status_idx ON public.log_correlations USING btree (status);


--
-- Name: log_search_queries_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX log_search_queries_created_by_idx ON public.log_search_queries USING btree (created_by);


--
-- Name: log_search_queries_org_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX log_search_queries_org_id_idx ON public.log_search_queries USING btree (org_id);


--
-- Name: network_baselines_org_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX network_baselines_org_id_idx ON public.network_baselines USING btree (org_id);


--
-- Name: network_baselines_site_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX network_baselines_site_id_idx ON public.network_baselines USING btree (site_id);


--
-- Name: network_change_events_acknowledged_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX network_change_events_acknowledged_idx ON public.network_change_events USING btree (acknowledged);


--
-- Name: network_change_events_baseline_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX network_change_events_baseline_id_idx ON public.network_change_events USING btree (baseline_id);


--
-- Name: network_change_events_detected_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX network_change_events_detected_at_idx ON public.network_change_events USING btree (detected_at);


--
-- Name: network_change_events_org_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX network_change_events_org_id_idx ON public.network_change_events USING btree (org_id);


--
-- Name: network_change_events_profile_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX network_change_events_profile_id_idx ON public.network_change_events USING btree (profile_id);


--
-- Name: network_change_events_site_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX network_change_events_site_id_idx ON public.network_change_events USING btree (site_id);


--
-- Name: network_known_guests_partner_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX network_known_guests_partner_id_idx ON public.network_known_guests USING btree (partner_id);


--
-- Name: network_known_guests_partner_mac_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX network_known_guests_partner_mac_unique ON public.network_known_guests USING btree (partner_id, mac_address);


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
-- Name: patch_approvals_org_patch_ring_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX patch_approvals_org_patch_ring_unique ON public.patch_approvals USING btree (org_id, patch_id, COALESCE(ring_id, '00000000-0000-0000-0000-000000000000'::uuid));


--
-- Name: patch_compliance_reports_org_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX patch_compliance_reports_org_created_idx ON public.patch_compliance_reports USING btree (org_id, created_at DESC);


--
-- Name: patch_compliance_reports_status_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX patch_compliance_reports_status_created_idx ON public.patch_compliance_reports USING btree (status, created_at DESC);


--
-- Name: patches_source_external_id_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX patches_source_external_id_unique ON public.patches USING btree (source, external_id);


--
-- Name: playbook_definitions_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX playbook_definitions_active_idx ON public.playbook_definitions USING btree (is_active);


--
-- Name: playbook_definitions_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX playbook_definitions_category_idx ON public.playbook_definitions USING btree (category);


--
-- Name: playbook_definitions_org_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX playbook_definitions_org_id_idx ON public.playbook_definitions USING btree (org_id);


--
-- Name: playbook_definitions_scope_name_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX playbook_definitions_scope_name_uniq ON public.playbook_definitions USING btree (COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid), lower((name)::text));


--
-- Name: playbook_executions_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX playbook_executions_created_at_idx ON public.playbook_executions USING btree (created_at);


--
-- Name: playbook_executions_device_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX playbook_executions_device_id_idx ON public.playbook_executions USING btree (device_id);


--
-- Name: playbook_executions_org_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX playbook_executions_org_id_idx ON public.playbook_executions USING btree (org_id);


--
-- Name: playbook_executions_playbook_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX playbook_executions_playbook_id_idx ON public.playbook_executions USING btree (playbook_id);


--
-- Name: playbook_executions_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX playbook_executions_status_idx ON public.playbook_executions USING btree (status);


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
-- Name: reliability_history_device_collected_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reliability_history_device_collected_idx ON public.device_reliability_history USING btree (device_id, collected_at);


--
-- Name: reliability_history_org_collected_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reliability_history_org_collected_idx ON public.device_reliability_history USING btree (org_id, collected_at);


--
-- Name: reliability_org_score_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reliability_org_score_idx ON public.device_reliability USING btree (org_id, reliability_score);


--
-- Name: reliability_score_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reliability_score_idx ON public.device_reliability USING btree (reliability_score);


--
-- Name: reliability_trend_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reliability_trend_idx ON public.device_reliability USING btree (trend_direction);


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
-- Name: security_posture_snapshots_org_device_captured_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX security_posture_snapshots_org_device_captured_idx ON public.security_posture_snapshots USING btree (org_id, device_id, captured_at);


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
-- Name: security_threats_device_status_detected_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX security_threats_device_status_detected_idx ON public.security_threats USING btree (device_id, status, detected_at);


--
-- Name: security_threats_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX security_threats_status_idx ON public.security_threats USING btree (status);


--
-- Name: snmp_devices_asset_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX snmp_devices_asset_id_idx ON public.snmp_devices USING btree (asset_id);


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
-- Name: software_inventory_name_vendor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX software_inventory_name_vendor_idx ON public.software_inventory USING btree (name, vendor);


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
-- Name: agent_logs agent_logs_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_logs
    ADD CONSTRAINT agent_logs_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: agent_logs agent_logs_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_logs
    ADD CONSTRAINT agent_logs_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: ai_action_plans ai_action_plans_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_action_plans
    ADD CONSTRAINT ai_action_plans_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id);


--
-- Name: ai_action_plans ai_action_plans_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_action_plans
    ADD CONSTRAINT ai_action_plans_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: ai_action_plans ai_action_plans_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_action_plans
    ADD CONSTRAINT ai_action_plans_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.ai_sessions(id);


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
-- Name: ai_screenshots ai_screenshots_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_screenshots
    ADD CONSTRAINT ai_screenshots_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: ai_screenshots ai_screenshots_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_screenshots
    ADD CONSTRAINT ai_screenshots_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: ai_screenshots ai_screenshots_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_screenshots
    ADD CONSTRAINT ai_screenshots_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.ai_sessions(id);


--
-- Name: ai_sessions ai_sessions_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_sessions
    ADD CONSTRAINT ai_sessions_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: ai_sessions ai_sessions_flagged_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_sessions
    ADD CONSTRAINT ai_sessions_flagged_by_fkey FOREIGN KEY (flagged_by) REFERENCES public.users(id);


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
-- Name: brain_device_context brain_device_context_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brain_device_context
    ADD CONSTRAINT brain_device_context_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: brain_device_context brain_device_context_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brain_device_context
    ADD CONSTRAINT brain_device_context_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


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
-- Name: config_policy_alert_rules config_policy_alert_rules_feature_link_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_policy_alert_rules
    ADD CONSTRAINT config_policy_alert_rules_feature_link_id_fkey FOREIGN KEY (feature_link_id) REFERENCES public.config_policy_feature_links(id) ON DELETE CASCADE;


--
-- Name: config_policy_assignments config_policy_assignments_assigned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_policy_assignments
    ADD CONSTRAINT config_policy_assignments_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES public.users(id);


--
-- Name: config_policy_assignments config_policy_assignments_config_policy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_policy_assignments
    ADD CONSTRAINT config_policy_assignments_config_policy_id_fkey FOREIGN KEY (config_policy_id) REFERENCES public.configuration_policies(id) ON DELETE CASCADE;


--
-- Name: config_policy_automations config_policy_automations_feature_link_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_policy_automations
    ADD CONSTRAINT config_policy_automations_feature_link_id_fkey FOREIGN KEY (feature_link_id) REFERENCES public.config_policy_feature_links(id) ON DELETE CASCADE;


--
-- Name: config_policy_compliance_rules config_policy_compliance_rules_feature_link_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_policy_compliance_rules
    ADD CONSTRAINT config_policy_compliance_rules_feature_link_id_fkey FOREIGN KEY (feature_link_id) REFERENCES public.config_policy_feature_links(id) ON DELETE CASCADE;


--
-- Name: config_policy_compliance_rules config_policy_compliance_rules_remediation_script_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_policy_compliance_rules
    ADD CONSTRAINT config_policy_compliance_rules_remediation_script_id_fkey FOREIGN KEY (remediation_script_id) REFERENCES public.scripts(id);


--
-- Name: config_policy_event_log_settings config_policy_event_log_settings_feature_link_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_policy_event_log_settings
    ADD CONSTRAINT config_policy_event_log_settings_feature_link_id_fkey FOREIGN KEY (feature_link_id) REFERENCES public.config_policy_feature_links(id) ON DELETE CASCADE;


--
-- Name: config_policy_feature_links config_policy_feature_links_config_policy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_policy_feature_links
    ADD CONSTRAINT config_policy_feature_links_config_policy_id_fkey FOREIGN KEY (config_policy_id) REFERENCES public.configuration_policies(id) ON DELETE CASCADE;


--
-- Name: config_policy_maintenance_settings config_policy_maintenance_settings_feature_link_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_policy_maintenance_settings
    ADD CONSTRAINT config_policy_maintenance_settings_feature_link_id_fkey FOREIGN KEY (feature_link_id) REFERENCES public.config_policy_feature_links(id) ON DELETE CASCADE;


--
-- Name: config_policy_patch_settings config_policy_patch_settings_feature_link_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_policy_patch_settings
    ADD CONSTRAINT config_policy_patch_settings_feature_link_id_fkey FOREIGN KEY (feature_link_id) REFERENCES public.config_policy_feature_links(id) ON DELETE CASCADE;


--
-- Name: configuration_policies configuration_policies_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.configuration_policies
    ADD CONSTRAINT configuration_policies_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: configuration_policies configuration_policies_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.configuration_policies
    ADD CONSTRAINT configuration_policies_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


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
-- Name: device_boot_metrics device_boot_metrics_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_boot_metrics
    ADD CONSTRAINT device_boot_metrics_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: device_boot_metrics device_boot_metrics_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_boot_metrics
    ADD CONSTRAINT device_boot_metrics_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: device_change_log device_change_log_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_change_log
    ADD CONSTRAINT device_change_log_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: device_change_log device_change_log_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_change_log
    ADD CONSTRAINT device_change_log_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


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
-- Name: device_ip_history device_ip_history_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_ip_history
    ADD CONSTRAINT device_ip_history_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE;


--
-- Name: device_ip_history device_ip_history_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_ip_history
    ADD CONSTRAINT device_ip_history_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


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
-- Name: device_reliability device_reliability_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_reliability
    ADD CONSTRAINT device_reliability_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE;


--
-- Name: device_reliability_history device_reliability_history_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_reliability_history
    ADD CONSTRAINT device_reliability_history_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE;


--
-- Name: device_reliability_history device_reliability_history_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_reliability_history
    ADD CONSTRAINT device_reliability_history_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: device_reliability device_reliability_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_reliability
    ADD CONSTRAINT device_reliability_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


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
-- Name: discovered_assets discovered_assets_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discovered_assets
    ADD CONSTRAINT discovered_assets_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id);


--
-- Name: discovered_assets discovered_assets_dismissed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discovered_assets
    ADD CONSTRAINT discovered_assets_dismissed_by_fkey FOREIGN KEY (dismissed_by) REFERENCES public.users(id);


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
-- Name: dns_event_aggregations dns_event_aggregations_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dns_event_aggregations
    ADD CONSTRAINT dns_event_aggregations_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: dns_event_aggregations dns_event_aggregations_integration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dns_event_aggregations
    ADD CONSTRAINT dns_event_aggregations_integration_id_fkey FOREIGN KEY (integration_id) REFERENCES public.dns_filter_integrations(id);


--
-- Name: dns_event_aggregations dns_event_aggregations_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dns_event_aggregations
    ADD CONSTRAINT dns_event_aggregations_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: dns_filter_integrations dns_filter_integrations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dns_filter_integrations
    ADD CONSTRAINT dns_filter_integrations_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: dns_filter_integrations dns_filter_integrations_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dns_filter_integrations
    ADD CONSTRAINT dns_filter_integrations_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: dns_policies dns_policies_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dns_policies
    ADD CONSTRAINT dns_policies_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: dns_policies dns_policies_integration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dns_policies
    ADD CONSTRAINT dns_policies_integration_id_fkey FOREIGN KEY (integration_id) REFERENCES public.dns_filter_integrations(id);


--
-- Name: dns_policies dns_policies_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dns_policies
    ADD CONSTRAINT dns_policies_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: dns_security_events dns_security_events_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dns_security_events
    ADD CONSTRAINT dns_security_events_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: dns_security_events dns_security_events_integration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dns_security_events
    ADD CONSTRAINT dns_security_events_integration_id_fkey FOREIGN KEY (integration_id) REFERENCES public.dns_filter_integrations(id);


--
-- Name: dns_security_events dns_security_events_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dns_security_events
    ADD CONSTRAINT dns_security_events_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


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
-- Name: log_correlation_rules log_correlation_rules_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.log_correlation_rules
    ADD CONSTRAINT log_correlation_rules_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: log_correlations log_correlations_alert_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.log_correlations
    ADD CONSTRAINT log_correlations_alert_id_fkey FOREIGN KEY (alert_id) REFERENCES public.alerts(id);


--
-- Name: log_correlations log_correlations_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.log_correlations
    ADD CONSTRAINT log_correlations_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: log_correlations log_correlations_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.log_correlations
    ADD CONSTRAINT log_correlations_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.users(id);


--
-- Name: log_correlations log_correlations_rule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.log_correlations
    ADD CONSTRAINT log_correlations_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES public.log_correlation_rules(id);


--
-- Name: log_search_queries log_search_queries_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.log_search_queries
    ADD CONSTRAINT log_search_queries_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: log_search_queries log_search_queries_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.log_search_queries
    ADD CONSTRAINT log_search_queries_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


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
-- Name: network_baselines network_baselines_last_scan_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.network_baselines
    ADD CONSTRAINT network_baselines_last_scan_job_id_fkey FOREIGN KEY (last_scan_job_id) REFERENCES public.discovery_jobs(id);


--
-- Name: network_baselines network_baselines_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.network_baselines
    ADD CONSTRAINT network_baselines_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: network_baselines network_baselines_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.network_baselines
    ADD CONSTRAINT network_baselines_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id);


--
-- Name: network_change_events network_change_events_acknowledged_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.network_change_events
    ADD CONSTRAINT network_change_events_acknowledged_by_fkey FOREIGN KEY (acknowledged_by) REFERENCES public.users(id);


--
-- Name: network_change_events network_change_events_alert_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.network_change_events
    ADD CONSTRAINT network_change_events_alert_id_fkey FOREIGN KEY (alert_id) REFERENCES public.alerts(id);


--
-- Name: network_change_events network_change_events_baseline_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.network_change_events
    ADD CONSTRAINT network_change_events_baseline_id_fkey FOREIGN KEY (baseline_id) REFERENCES public.network_baselines(id);


--
-- Name: network_change_events network_change_events_linked_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.network_change_events
    ADD CONSTRAINT network_change_events_linked_device_id_fkey FOREIGN KEY (linked_device_id) REFERENCES public.devices(id);


--
-- Name: network_change_events network_change_events_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.network_change_events
    ADD CONSTRAINT network_change_events_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: network_change_events network_change_events_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.network_change_events
    ADD CONSTRAINT network_change_events_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.discovery_profiles(id) ON DELETE SET NULL;


--
-- Name: network_change_events network_change_events_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.network_change_events
    ADD CONSTRAINT network_change_events_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id);


--
-- Name: network_known_guests network_known_guests_added_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.network_known_guests
    ADD CONSTRAINT network_known_guests_added_by_fkey FOREIGN KEY (added_by) REFERENCES public.users(id);


--
-- Name: network_known_guests network_known_guests_partner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.network_known_guests
    ADD CONSTRAINT network_known_guests_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES public.partners(id) ON DELETE CASCADE;


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
-- Name: patch_approvals patch_approvals_ring_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patch_approvals
    ADD CONSTRAINT patch_approvals_ring_id_fkey FOREIGN KEY (ring_id) REFERENCES public.patch_policies(id);


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
-- Name: patch_compliance_snapshots patch_compliance_snapshots_ring_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patch_compliance_snapshots
    ADD CONSTRAINT patch_compliance_snapshots_ring_id_fkey FOREIGN KEY (ring_id) REFERENCES public.patch_policies(id);


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
-- Name: patch_jobs patch_jobs_ring_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patch_jobs
    ADD CONSTRAINT patch_jobs_ring_id_fkey FOREIGN KEY (ring_id) REFERENCES public.patch_policies(id);


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
-- Name: playbook_definitions playbook_definitions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_definitions
    ADD CONSTRAINT playbook_definitions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: playbook_definitions playbook_definitions_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_definitions
    ADD CONSTRAINT playbook_definitions_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: playbook_executions playbook_executions_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_executions
    ADD CONSTRAINT playbook_executions_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id);


--
-- Name: playbook_executions playbook_executions_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_executions
    ADD CONSTRAINT playbook_executions_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: playbook_executions playbook_executions_playbook_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_executions
    ADD CONSTRAINT playbook_executions_playbook_id_fkey FOREIGN KEY (playbook_id) REFERENCES public.playbook_definitions(id);


--
-- Name: playbook_executions playbook_executions_triggered_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_executions
    ADD CONSTRAINT playbook_executions_triggered_by_user_id_fkey FOREIGN KEY (triggered_by_user_id) REFERENCES public.users(id);


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
-- Name: access_reviews; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.access_reviews ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_logs agent_logs_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY agent_logs_org_isolation ON public.agent_logs USING (((public.breeze_current_scope() = 'system'::text) OR public.breeze_has_org_access(org_id)));


--
-- Name: ai_action_plans; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_action_plans ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_action_plans ai_action_plans_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ai_action_plans_org_isolation ON public.ai_action_plans USING (((public.breeze_current_scope() = 'system'::text) OR public.breeze_has_org_access(org_id)));


--
-- Name: ai_budgets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_budgets ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_cost_usage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_cost_usage ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_screenshots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_screenshots ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_screenshots ai_screenshots_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ai_screenshots_org_isolation ON public.ai_screenshots USING (((public.breeze_current_scope() = 'system'::text) OR public.breeze_has_org_access(org_id)));


--
-- Name: ai_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: alert_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.alert_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: alert_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.alert_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: alerts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;

--
-- Name: analytics_dashboards; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.analytics_dashboards ENABLE ROW LEVEL SECURITY;

--
-- Name: api_keys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: asset_checkouts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.asset_checkouts ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_retention_policies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.audit_retention_policies ENABLE ROW LEVEL SECURITY;

--
-- Name: automation_policies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.automation_policies ENABLE ROW LEVEL SECURITY;

--
-- Name: automations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.automations ENABLE ROW LEVEL SECURITY;

--
-- Name: backup_configs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.backup_configs ENABLE ROW LEVEL SECURITY;

--
-- Name: brain_device_context; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.brain_device_context ENABLE ROW LEVEL SECURITY;

--
-- Name: brain_device_context brain_device_context_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY brain_device_context_org_isolation ON public.brain_device_context USING (((public.breeze_current_scope() = 'system'::text) OR public.breeze_has_org_access(org_id)));


--
-- Name: access_reviews breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.access_reviews FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: ai_budgets breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.ai_budgets FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: ai_cost_usage breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.ai_cost_usage FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: ai_sessions breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.ai_sessions FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: alert_rules breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.alert_rules FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: alert_templates breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.alert_templates FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: alerts breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.alerts FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: analytics_dashboards breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.analytics_dashboards FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: api_keys breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.api_keys FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: asset_checkouts breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.asset_checkouts FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: audit_logs breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.audit_logs FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: audit_retention_policies breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.audit_retention_policies FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: automation_policies breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.automation_policies FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: automations breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.automations FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: backup_configs breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.backup_configs FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: capacity_predictions breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.capacity_predictions FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: capacity_thresholds breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.capacity_thresholds FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: custom_field_definitions breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.custom_field_definitions FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: deployments breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.deployments FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: device_change_log breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.device_change_log FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: device_event_logs breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.device_event_logs FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: device_groups breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.device_groups FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: device_ip_history breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.device_ip_history FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: device_reliability breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.device_reliability FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: device_reliability_history breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.device_reliability_history FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: device_sessions breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.device_sessions FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: devices breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.devices FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: discovered_assets breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.discovered_assets FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: discovery_jobs breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.discovery_jobs FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: discovery_profiles breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.discovery_profiles FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: dns_event_aggregations breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.dns_event_aggregations FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: dns_filter_integrations breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.dns_filter_integrations FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: dns_policies breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.dns_policies FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: dns_security_events breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.dns_security_events FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: enrollment_keys breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.enrollment_keys FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: escalation_policies breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.escalation_policies FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: event_bus_events breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.event_bus_events FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: executive_summaries breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.executive_summaries FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: log_correlation_rules breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.log_correlation_rules FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: log_correlations breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.log_correlations FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: log_search_queries breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.log_search_queries FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: maintenance_windows breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.maintenance_windows FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: network_baselines breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.network_baselines FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: network_change_events breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.network_change_events FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: network_monitors breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.network_monitors FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: network_topology breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.network_topology FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: notification_channels breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.notification_channels FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: organization_users breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.organization_users FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: patch_approvals breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.patch_approvals FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: patch_compliance_reports breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.patch_compliance_reports FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: patch_compliance_snapshots breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.patch_compliance_snapshots FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: patch_jobs breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.patch_jobs FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: patch_policies breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.patch_policies FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: plugin_installations breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.plugin_installations FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: plugin_instances breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.plugin_instances FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: plugins breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.plugins FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: policies breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.policies FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: portal_branding breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.portal_branding FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: portal_users breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.portal_users FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: psa_connections breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.psa_connections FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: reports breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.reports FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: roles breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.roles FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: saved_filters breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.saved_filters FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: saved_queries breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.saved_queries FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: script_categories breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.script_categories FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: script_tags breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.script_tags FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: scripts breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.scripts FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: security_policies breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.security_policies FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: security_posture_org_snapshots breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.security_posture_org_snapshots FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: security_posture_snapshots breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.security_posture_snapshots FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: sites breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.sites FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: sla_compliance breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.sla_compliance FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: sla_definitions breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.sla_definitions FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: snmp_devices breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.snmp_devices FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: software_compliance_status breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.software_compliance_status FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.devices d
  WHERE ((d.id = software_compliance_status.device_id) AND public.breeze_has_org_access(d.org_id)))));


--
-- Name: software_deployments breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.software_deployments FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: software_policies breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.software_policies FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: software_policy_audit breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.software_policy_audit FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: sso_providers breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.sso_providers FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: tickets breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.tickets FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: time_series_metrics breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.time_series_metrics FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: user_notifications breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.user_notifications FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: webhooks breeze_org_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_delete ON public.webhooks FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: access_reviews breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.access_reviews FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: ai_budgets breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.ai_budgets FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: ai_cost_usage breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.ai_cost_usage FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: ai_sessions breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.ai_sessions FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: alert_rules breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.alert_rules FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: alert_templates breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.alert_templates FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: alerts breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.alerts FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: analytics_dashboards breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.analytics_dashboards FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: api_keys breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.api_keys FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: asset_checkouts breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.asset_checkouts FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: audit_logs breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.audit_logs FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: audit_retention_policies breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.audit_retention_policies FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: automation_policies breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.automation_policies FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: automations breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.automations FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: backup_configs breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.backup_configs FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: capacity_predictions breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.capacity_predictions FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: capacity_thresholds breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.capacity_thresholds FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: custom_field_definitions breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.custom_field_definitions FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: deployments breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.deployments FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: device_change_log breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.device_change_log FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: device_event_logs breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.device_event_logs FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: device_groups breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.device_groups FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: device_ip_history breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.device_ip_history FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: device_reliability breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.device_reliability FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: device_reliability_history breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.device_reliability_history FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: device_sessions breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.device_sessions FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: devices breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.devices FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: discovered_assets breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.discovered_assets FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: discovery_jobs breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.discovery_jobs FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: discovery_profiles breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.discovery_profiles FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: dns_event_aggregations breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.dns_event_aggregations FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: dns_filter_integrations breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.dns_filter_integrations FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: dns_policies breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.dns_policies FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: dns_security_events breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.dns_security_events FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: enrollment_keys breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.enrollment_keys FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: escalation_policies breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.escalation_policies FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: event_bus_events breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.event_bus_events FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: executive_summaries breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.executive_summaries FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: log_correlation_rules breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.log_correlation_rules FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: log_correlations breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.log_correlations FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: log_search_queries breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.log_search_queries FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: maintenance_windows breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.maintenance_windows FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: network_baselines breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.network_baselines FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: network_change_events breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.network_change_events FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: network_monitors breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.network_monitors FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: network_topology breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.network_topology FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: notification_channels breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.notification_channels FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: organization_users breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.organization_users FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: patch_approvals breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.patch_approvals FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: patch_compliance_reports breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.patch_compliance_reports FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: patch_compliance_snapshots breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.patch_compliance_snapshots FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: patch_jobs breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.patch_jobs FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: patch_policies breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.patch_policies FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: plugin_installations breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.plugin_installations FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: plugin_instances breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.plugin_instances FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: plugins breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.plugins FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: policies breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.policies FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: portal_branding breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.portal_branding FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: portal_users breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.portal_users FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: psa_connections breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.psa_connections FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: reports breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.reports FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: roles breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.roles FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: saved_filters breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.saved_filters FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: saved_queries breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.saved_queries FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: script_categories breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.script_categories FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: script_tags breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.script_tags FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: scripts breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.scripts FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: security_policies breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.security_policies FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: security_posture_org_snapshots breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.security_posture_org_snapshots FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: security_posture_snapshots breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.security_posture_snapshots FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: sites breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.sites FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: sla_compliance breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.sla_compliance FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: sla_definitions breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.sla_definitions FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: snmp_devices breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.snmp_devices FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: software_compliance_status breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.software_compliance_status FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.devices d
  WHERE ((d.id = software_compliance_status.device_id) AND public.breeze_has_org_access(d.org_id)))));


--
-- Name: software_deployments breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.software_deployments FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: software_policies breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.software_policies FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: software_policy_audit breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.software_policy_audit FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: sso_providers breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.sso_providers FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: tickets breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.tickets FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: time_series_metrics breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.time_series_metrics FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: user_notifications breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.user_notifications FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: webhooks breeze_org_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_insert ON public.webhooks FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: access_reviews breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.access_reviews FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: ai_budgets breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.ai_budgets FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: ai_cost_usage breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.ai_cost_usage FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: ai_sessions breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.ai_sessions FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: alert_rules breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.alert_rules FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: alert_templates breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.alert_templates FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: alerts breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.alerts FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: analytics_dashboards breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.analytics_dashboards FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: api_keys breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.api_keys FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: asset_checkouts breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.asset_checkouts FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: audit_logs breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.audit_logs FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: audit_retention_policies breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.audit_retention_policies FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: automation_policies breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.automation_policies FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: automations breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.automations FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: backup_configs breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.backup_configs FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: capacity_predictions breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.capacity_predictions FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: capacity_thresholds breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.capacity_thresholds FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: custom_field_definitions breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.custom_field_definitions FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: deployments breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.deployments FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: device_change_log breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.device_change_log FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: device_event_logs breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.device_event_logs FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: device_groups breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.device_groups FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: device_ip_history breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.device_ip_history FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: device_reliability breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.device_reliability FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: device_reliability_history breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.device_reliability_history FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: device_sessions breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.device_sessions FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: devices breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.devices FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: discovered_assets breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.discovered_assets FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: discovery_jobs breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.discovery_jobs FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: discovery_profiles breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.discovery_profiles FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: dns_event_aggregations breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.dns_event_aggregations FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: dns_filter_integrations breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.dns_filter_integrations FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: dns_policies breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.dns_policies FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: dns_security_events breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.dns_security_events FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: enrollment_keys breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.enrollment_keys FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: escalation_policies breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.escalation_policies FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: event_bus_events breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.event_bus_events FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: executive_summaries breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.executive_summaries FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: log_correlation_rules breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.log_correlation_rules FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: log_correlations breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.log_correlations FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: log_search_queries breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.log_search_queries FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: maintenance_windows breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.maintenance_windows FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: network_baselines breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.network_baselines FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: network_change_events breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.network_change_events FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: network_monitors breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.network_monitors FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: network_topology breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.network_topology FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: notification_channels breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.notification_channels FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: organization_users breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.organization_users FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: patch_approvals breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.patch_approvals FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: patch_compliance_reports breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.patch_compliance_reports FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: patch_compliance_snapshots breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.patch_compliance_snapshots FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: patch_jobs breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.patch_jobs FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: patch_policies breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.patch_policies FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: plugin_installations breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.plugin_installations FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: plugin_instances breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.plugin_instances FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: plugins breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.plugins FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: policies breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.policies FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: portal_branding breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.portal_branding FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: portal_users breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.portal_users FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: psa_connections breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.psa_connections FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: reports breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.reports FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: roles breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.roles FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: saved_filters breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.saved_filters FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: saved_queries breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.saved_queries FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: script_categories breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.script_categories FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: script_tags breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.script_tags FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: scripts breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.scripts FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: security_policies breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.security_policies FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: security_posture_org_snapshots breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.security_posture_org_snapshots FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: security_posture_snapshots breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.security_posture_snapshots FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: sites breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.sites FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: sla_compliance breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.sla_compliance FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: sla_definitions breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.sla_definitions FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: snmp_devices breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.snmp_devices FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: software_compliance_status breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.software_compliance_status FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.devices d
  WHERE ((d.id = software_compliance_status.device_id) AND public.breeze_has_org_access(d.org_id)))));


--
-- Name: software_deployments breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.software_deployments FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: software_policies breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.software_policies FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: software_policy_audit breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.software_policy_audit FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: sso_providers breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.sso_providers FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: tickets breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.tickets FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: time_series_metrics breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.time_series_metrics FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: user_notifications breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.user_notifications FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: webhooks breeze_org_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_select ON public.webhooks FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: access_reviews breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.access_reviews FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: ai_budgets breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.ai_budgets FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: ai_cost_usage breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.ai_cost_usage FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: ai_sessions breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.ai_sessions FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: alert_rules breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.alert_rules FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: alert_templates breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.alert_templates FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: alerts breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.alerts FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: analytics_dashboards breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.analytics_dashboards FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: api_keys breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.api_keys FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: asset_checkouts breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.asset_checkouts FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: audit_logs breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.audit_logs FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: audit_retention_policies breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.audit_retention_policies FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: automation_policies breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.automation_policies FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: automations breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.automations FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: backup_configs breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.backup_configs FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: capacity_predictions breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.capacity_predictions FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: capacity_thresholds breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.capacity_thresholds FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: custom_field_definitions breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.custom_field_definitions FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: deployments breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.deployments FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: device_change_log breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.device_change_log FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: device_event_logs breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.device_event_logs FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: device_groups breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.device_groups FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: device_ip_history breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.device_ip_history FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: device_reliability breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.device_reliability FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: device_reliability_history breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.device_reliability_history FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: device_sessions breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.device_sessions FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: devices breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.devices FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: discovered_assets breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.discovered_assets FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: discovery_jobs breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.discovery_jobs FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: discovery_profiles breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.discovery_profiles FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: dns_event_aggregations breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.dns_event_aggregations FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: dns_filter_integrations breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.dns_filter_integrations FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: dns_policies breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.dns_policies FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: dns_security_events breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.dns_security_events FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: enrollment_keys breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.enrollment_keys FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: escalation_policies breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.escalation_policies FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: event_bus_events breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.event_bus_events FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: executive_summaries breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.executive_summaries FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: log_correlation_rules breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.log_correlation_rules FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: log_correlations breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.log_correlations FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: log_search_queries breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.log_search_queries FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: maintenance_windows breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.maintenance_windows FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: network_baselines breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.network_baselines FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: network_change_events breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.network_change_events FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: network_monitors breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.network_monitors FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: network_topology breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.network_topology FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: notification_channels breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.notification_channels FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: organization_users breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.organization_users FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: patch_approvals breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.patch_approvals FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: patch_compliance_reports breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.patch_compliance_reports FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: patch_compliance_snapshots breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.patch_compliance_snapshots FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: patch_jobs breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.patch_jobs FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: patch_policies breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.patch_policies FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: plugin_installations breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.plugin_installations FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: plugin_instances breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.plugin_instances FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: plugins breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.plugins FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: policies breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.policies FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: portal_branding breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.portal_branding FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: portal_users breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.portal_users FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: psa_connections breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.psa_connections FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: reports breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.reports FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: roles breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.roles FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: saved_filters breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.saved_filters FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: saved_queries breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.saved_queries FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: script_categories breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.script_categories FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: script_tags breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.script_tags FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: scripts breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.scripts FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: security_policies breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.security_policies FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: security_posture_org_snapshots breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.security_posture_org_snapshots FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: security_posture_snapshots breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.security_posture_snapshots FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: sites breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.sites FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: sla_compliance breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.sla_compliance FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: sla_definitions breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.sla_definitions FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: snmp_devices breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.snmp_devices FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: software_compliance_status breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.software_compliance_status FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.devices d
  WHERE ((d.id = software_compliance_status.device_id) AND public.breeze_has_org_access(d.org_id))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.devices d
  WHERE ((d.id = software_compliance_status.device_id) AND public.breeze_has_org_access(d.org_id)))));


--
-- Name: software_deployments breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.software_deployments FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: software_policies breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.software_policies FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: software_policy_audit breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.software_policy_audit FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: sso_providers breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.sso_providers FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: tickets breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.tickets FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: time_series_metrics breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.time_series_metrics FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: user_notifications breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.user_notifications FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: webhooks breeze_org_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_org_isolation_update ON public.webhooks FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: network_known_guests breeze_partner_isolation_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_partner_isolation_delete ON public.network_known_guests FOR DELETE USING (((public.breeze_current_scope() = 'system'::text) OR (EXISTS ( SELECT 1
   FROM public.organizations o
  WHERE ((o.partner_id = network_known_guests.partner_id) AND public.breeze_has_org_access(o.id))))));


--
-- Name: network_known_guests breeze_partner_isolation_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_partner_isolation_insert ON public.network_known_guests FOR INSERT WITH CHECK (((public.breeze_current_scope() = 'system'::text) OR (EXISTS ( SELECT 1
   FROM public.organizations o
  WHERE ((o.partner_id = network_known_guests.partner_id) AND public.breeze_has_org_access(o.id))))));


--
-- Name: network_known_guests breeze_partner_isolation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_partner_isolation_select ON public.network_known_guests FOR SELECT USING (((public.breeze_current_scope() = 'system'::text) OR (EXISTS ( SELECT 1
   FROM public.organizations o
  WHERE ((o.partner_id = network_known_guests.partner_id) AND public.breeze_has_org_access(o.id))))));


--
-- Name: network_known_guests breeze_partner_isolation_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breeze_partner_isolation_update ON public.network_known_guests FOR UPDATE USING (((public.breeze_current_scope() = 'system'::text) OR (EXISTS ( SELECT 1
   FROM public.organizations o
  WHERE ((o.partner_id = network_known_guests.partner_id) AND public.breeze_has_org_access(o.id)))))) WITH CHECK (((public.breeze_current_scope() = 'system'::text) OR (EXISTS ( SELECT 1
   FROM public.organizations o
  WHERE ((o.partner_id = network_known_guests.partner_id) AND public.breeze_has_org_access(o.id))))));


--
-- Name: capacity_predictions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.capacity_predictions ENABLE ROW LEVEL SECURITY;

--
-- Name: capacity_thresholds; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.capacity_thresholds ENABLE ROW LEVEL SECURITY;

--
-- Name: config_policy_alert_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.config_policy_alert_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: config_policy_alert_rules config_policy_alert_rules_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY config_policy_alert_rules_org_isolation ON public.config_policy_alert_rules USING (((public.breeze_current_scope() = 'system'::text) OR (EXISTS ( SELECT 1
   FROM (public.config_policy_feature_links fl
     JOIN public.configuration_policies cp ON ((cp.id = fl.config_policy_id)))
  WHERE ((fl.id = config_policy_alert_rules.feature_link_id) AND public.breeze_has_org_access(cp.org_id))))));


--
-- Name: config_policy_assignments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.config_policy_assignments ENABLE ROW LEVEL SECURITY;

--
-- Name: config_policy_assignments config_policy_assignments_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY config_policy_assignments_org_isolation ON public.config_policy_assignments USING (((public.breeze_current_scope() = 'system'::text) OR (EXISTS ( SELECT 1
   FROM public.configuration_policies cp
  WHERE ((cp.id = config_policy_assignments.config_policy_id) AND public.breeze_has_org_access(cp.org_id))))));


--
-- Name: config_policy_automations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.config_policy_automations ENABLE ROW LEVEL SECURITY;

--
-- Name: config_policy_automations config_policy_automations_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY config_policy_automations_org_isolation ON public.config_policy_automations USING (((public.breeze_current_scope() = 'system'::text) OR (EXISTS ( SELECT 1
   FROM (public.config_policy_feature_links fl
     JOIN public.configuration_policies cp ON ((cp.id = fl.config_policy_id)))
  WHERE ((fl.id = config_policy_automations.feature_link_id) AND public.breeze_has_org_access(cp.org_id))))));


--
-- Name: config_policy_compliance_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.config_policy_compliance_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: config_policy_compliance_rules config_policy_compliance_rules_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY config_policy_compliance_rules_org_isolation ON public.config_policy_compliance_rules USING (((public.breeze_current_scope() = 'system'::text) OR (EXISTS ( SELECT 1
   FROM (public.config_policy_feature_links fl
     JOIN public.configuration_policies cp ON ((cp.id = fl.config_policy_id)))
  WHERE ((fl.id = config_policy_compliance_rules.feature_link_id) AND public.breeze_has_org_access(cp.org_id))))));


--
-- Name: config_policy_event_log_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.config_policy_event_log_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: config_policy_event_log_settings config_policy_event_log_settings_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY config_policy_event_log_settings_org_isolation ON public.config_policy_event_log_settings USING (((public.breeze_current_scope() = 'system'::text) OR (EXISTS ( SELECT 1
   FROM (public.config_policy_feature_links fl
     JOIN public.configuration_policies cp ON ((cp.id = fl.config_policy_id)))
  WHERE ((fl.id = config_policy_event_log_settings.feature_link_id) AND public.breeze_has_org_access(cp.org_id))))));


--
-- Name: config_policy_feature_links; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.config_policy_feature_links ENABLE ROW LEVEL SECURITY;

--
-- Name: config_policy_feature_links config_policy_feature_links_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY config_policy_feature_links_org_isolation ON public.config_policy_feature_links USING (((public.breeze_current_scope() = 'system'::text) OR (EXISTS ( SELECT 1
   FROM public.configuration_policies cp
  WHERE ((cp.id = config_policy_feature_links.config_policy_id) AND public.breeze_has_org_access(cp.org_id))))));


--
-- Name: config_policy_maintenance_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.config_policy_maintenance_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: config_policy_maintenance_settings config_policy_maintenance_settings_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY config_policy_maintenance_settings_org_isolation ON public.config_policy_maintenance_settings USING (((public.breeze_current_scope() = 'system'::text) OR (EXISTS ( SELECT 1
   FROM (public.config_policy_feature_links fl
     JOIN public.configuration_policies cp ON ((cp.id = fl.config_policy_id)))
  WHERE ((fl.id = config_policy_maintenance_settings.feature_link_id) AND public.breeze_has_org_access(cp.org_id))))));


--
-- Name: config_policy_patch_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.config_policy_patch_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: config_policy_patch_settings config_policy_patch_settings_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY config_policy_patch_settings_org_isolation ON public.config_policy_patch_settings USING (((public.breeze_current_scope() = 'system'::text) OR (EXISTS ( SELECT 1
   FROM (public.config_policy_feature_links fl
     JOIN public.configuration_policies cp ON ((cp.id = fl.config_policy_id)))
  WHERE ((fl.id = config_policy_patch_settings.feature_link_id) AND public.breeze_has_org_access(cp.org_id))))));


--
-- Name: configuration_policies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.configuration_policies ENABLE ROW LEVEL SECURITY;

--
-- Name: configuration_policies configuration_policies_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY configuration_policies_org_isolation ON public.configuration_policies USING (((public.breeze_current_scope() = 'system'::text) OR public.breeze_has_org_access(org_id)));


--
-- Name: custom_field_definitions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.custom_field_definitions ENABLE ROW LEVEL SECURITY;

--
-- Name: deployments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.deployments ENABLE ROW LEVEL SECURITY;

--
-- Name: device_boot_metrics; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.device_boot_metrics ENABLE ROW LEVEL SECURITY;

--
-- Name: device_boot_metrics device_boot_metrics_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY device_boot_metrics_org_isolation ON public.device_boot_metrics USING (((public.breeze_current_scope() = 'system'::text) OR public.breeze_has_org_access(org_id)));


--
-- Name: device_change_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.device_change_log ENABLE ROW LEVEL SECURITY;

--
-- Name: device_event_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.device_event_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: device_groups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.device_groups ENABLE ROW LEVEL SECURITY;

--
-- Name: device_ip_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.device_ip_history ENABLE ROW LEVEL SECURITY;

--
-- Name: device_reliability; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.device_reliability ENABLE ROW LEVEL SECURITY;

--
-- Name: device_reliability_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.device_reliability_history ENABLE ROW LEVEL SECURITY;

--
-- Name: device_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.device_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: devices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;

--
-- Name: discovered_assets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.discovered_assets ENABLE ROW LEVEL SECURITY;

--
-- Name: discovery_jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.discovery_jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: discovery_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.discovery_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: dns_event_aggregations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dns_event_aggregations ENABLE ROW LEVEL SECURITY;

--
-- Name: dns_filter_integrations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dns_filter_integrations ENABLE ROW LEVEL SECURITY;

--
-- Name: dns_policies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dns_policies ENABLE ROW LEVEL SECURITY;

--
-- Name: dns_security_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dns_security_events ENABLE ROW LEVEL SECURITY;

--
-- Name: enrollment_keys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.enrollment_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: escalation_policies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.escalation_policies ENABLE ROW LEVEL SECURITY;

--
-- Name: event_bus_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.event_bus_events ENABLE ROW LEVEL SECURITY;

--
-- Name: executive_summaries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.executive_summaries ENABLE ROW LEVEL SECURITY;

--
-- Name: log_correlation_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.log_correlation_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: log_correlations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.log_correlations ENABLE ROW LEVEL SECURITY;

--
-- Name: log_search_queries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.log_search_queries ENABLE ROW LEVEL SECURITY;

--
-- Name: maintenance_windows; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.maintenance_windows ENABLE ROW LEVEL SECURITY;

--
-- Name: network_baselines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.network_baselines ENABLE ROW LEVEL SECURITY;

--
-- Name: network_change_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.network_change_events ENABLE ROW LEVEL SECURITY;

--
-- Name: network_known_guests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.network_known_guests ENABLE ROW LEVEL SECURITY;

--
-- Name: network_monitors; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.network_monitors ENABLE ROW LEVEL SECURITY;

--
-- Name: network_topology; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.network_topology ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_channels; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notification_channels ENABLE ROW LEVEL SECURITY;

--
-- Name: organization_users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.organization_users ENABLE ROW LEVEL SECURITY;

--
-- Name: patch_approvals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.patch_approvals ENABLE ROW LEVEL SECURITY;

--
-- Name: patch_compliance_reports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.patch_compliance_reports ENABLE ROW LEVEL SECURITY;

--
-- Name: patch_compliance_snapshots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.patch_compliance_snapshots ENABLE ROW LEVEL SECURITY;

--
-- Name: patch_jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.patch_jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: patch_policies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.patch_policies ENABLE ROW LEVEL SECURITY;

--
-- Name: playbook_definitions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.playbook_definitions ENABLE ROW LEVEL SECURITY;

--
-- Name: playbook_definitions playbook_definitions_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY playbook_definitions_delete ON public.playbook_definitions FOR DELETE USING (((public.breeze_has_org_access(org_id) AND (COALESCE(is_built_in, false) = false)) OR ((public.breeze_current_scope() = 'system'::text) AND (is_built_in = true) AND (org_id IS NULL))));


--
-- Name: playbook_definitions playbook_definitions_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY playbook_definitions_insert ON public.playbook_definitions FOR INSERT WITH CHECK (((public.breeze_has_org_access(org_id) AND (COALESCE(is_built_in, false) = false)) OR ((public.breeze_current_scope() = 'system'::text) AND (is_built_in = true) AND (org_id IS NULL))));


--
-- Name: playbook_definitions playbook_definitions_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY playbook_definitions_select ON public.playbook_definitions FOR SELECT USING (((public.breeze_current_scope() <> 'none'::text) AND (public.breeze_has_org_access(org_id) OR ((is_built_in = true) AND (org_id IS NULL)))));


--
-- Name: playbook_definitions playbook_definitions_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY playbook_definitions_update ON public.playbook_definitions FOR UPDATE USING (((public.breeze_has_org_access(org_id) AND (COALESCE(is_built_in, false) = false)) OR ((public.breeze_current_scope() = 'system'::text) AND (is_built_in = true) AND (org_id IS NULL)))) WITH CHECK (((public.breeze_has_org_access(org_id) AND (COALESCE(is_built_in, false) = false)) OR ((public.breeze_current_scope() = 'system'::text) AND (is_built_in = true) AND (org_id IS NULL))));


--
-- Name: playbook_executions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.playbook_executions ENABLE ROW LEVEL SECURITY;

--
-- Name: playbook_executions playbook_executions_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY playbook_executions_delete ON public.playbook_executions FOR DELETE USING (public.breeze_has_org_access(org_id));


--
-- Name: playbook_executions playbook_executions_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY playbook_executions_insert ON public.playbook_executions FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: playbook_executions playbook_executions_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY playbook_executions_select ON public.playbook_executions FOR SELECT USING (public.breeze_has_org_access(org_id));


--
-- Name: playbook_executions playbook_executions_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY playbook_executions_update ON public.playbook_executions FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));


--
-- Name: plugin_installations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.plugin_installations ENABLE ROW LEVEL SECURITY;

--
-- Name: plugin_instances; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.plugin_instances ENABLE ROW LEVEL SECURITY;

--
-- Name: plugins; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.plugins ENABLE ROW LEVEL SECURITY;

--
-- Name: policies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.policies ENABLE ROW LEVEL SECURITY;

--
-- Name: portal_branding; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.portal_branding ENABLE ROW LEVEL SECURITY;

--
-- Name: portal_users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.portal_users ENABLE ROW LEVEL SECURITY;

--
-- Name: psa_connections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.psa_connections ENABLE ROW LEVEL SECURITY;

--
-- Name: reports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;

--
-- Name: roles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;

--
-- Name: saved_filters; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.saved_filters ENABLE ROW LEVEL SECURITY;

--
-- Name: saved_queries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.saved_queries ENABLE ROW LEVEL SECURITY;

--
-- Name: script_categories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.script_categories ENABLE ROW LEVEL SECURITY;

--
-- Name: script_tags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.script_tags ENABLE ROW LEVEL SECURITY;

--
-- Name: scripts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scripts ENABLE ROW LEVEL SECURITY;

--
-- Name: security_policies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.security_policies ENABLE ROW LEVEL SECURITY;

--
-- Name: security_posture_org_snapshots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.security_posture_org_snapshots ENABLE ROW LEVEL SECURITY;

--
-- Name: security_posture_snapshots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.security_posture_snapshots ENABLE ROW LEVEL SECURITY;

--
-- Name: sites; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sites ENABLE ROW LEVEL SECURITY;

--
-- Name: sla_compliance; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sla_compliance ENABLE ROW LEVEL SECURITY;

--
-- Name: sla_definitions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sla_definitions ENABLE ROW LEVEL SECURITY;

--
-- Name: snmp_devices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.snmp_devices ENABLE ROW LEVEL SECURITY;

--
-- Name: software_compliance_status; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.software_compliance_status ENABLE ROW LEVEL SECURITY;

--
-- Name: software_deployments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.software_deployments ENABLE ROW LEVEL SECURITY;

--
-- Name: software_policies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.software_policies ENABLE ROW LEVEL SECURITY;

--
-- Name: software_policy_audit; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.software_policy_audit ENABLE ROW LEVEL SECURITY;

--
-- Name: sso_providers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sso_providers ENABLE ROW LEVEL SECURITY;

--
-- Name: tickets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;

--
-- Name: time_series_metrics; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.time_series_metrics ENABLE ROW LEVEL SECURITY;

--
-- Name: user_notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: webhooks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.webhooks ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

\unrestrict pG7mrjKd5jh3TbL2FdsVt23GPeUtF6jfPgtkPrKgug12iZCuMsiIhgWnRI7Yry4

