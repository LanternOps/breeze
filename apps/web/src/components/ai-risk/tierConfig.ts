// ⚠️  This module is a MIRROR of the guardrail tier tables in
// apps/api/src/services/aiGuardrails.ts and is bound to them by the contract
// test apps/api/src/services/aiGuardrailsTierConfig.parity.test.ts (issue
// #2686). That test imports this file directly, so it must stay free of any
// runtime dependency (no lucide-react, no React, no `@/` aliases) — tier icons
// are named here and resolved in TierOverviewMatrix.tsx.
//
// Every `name` in a Tier 1-3 `tools` list must be either `tool_name` or
// `tool_name (action/action/...)` using the REAL guardrail action identifiers,
// because the parity test parses them and asserts
// `checkGuardrails(tool, { action }).tier` equals the tier the entry sits in.
// Prose inside the parentheses ("add/remove devices") will fail the test.

// ── Tool categories for grouping in the UI ──────────────────────────────────
export type ToolCategory =
  | 'Devices & Hardware'
  | 'Network & DNS'
  | 'Security & Compliance'
  | 'Alerts & Notifications'
  | 'Files, Disk & Registry'
  | 'Logs & Audit'
  | 'Services & Processes'
  | 'Scripts & Automation'
  | 'Configuration Policies'
  | 'Fleet Operations'
  | 'Backup & Recovery'
  | 'Monitoring & Analytics'
  | 'Remote Access & Control'
  | 'Integrations'
  | 'Ticketing'
  | 'Billing'
  | 'AI Governance'
  | 'Other';

export interface ToolEntry {
  name: string;
  description: string;
  category: ToolCategory;
}

export type TierIconName = 'eye' | 'shield-check' | 'shield-alert' | 'shield-off';

export interface TierDefinition {
  tier: 1 | 2 | 3 | 4;
  /** `security` locale key (aiRisk.tiers.<id>.label), resolved with t() at render. */
  label: string;
  description: string;
  iconName: TierIconName;
  borderColor: string;
  badgeBg: string;
  badgeText: string;
  tools: ToolEntry[];
}

export const TIER_DEFINITIONS: TierDefinition[] = [
  {
    tier: 1,
    label: 'aiRisk.tiers.tier1.label',
    description: 'Read-only operations that execute automatically without any approval or logging overhead.',
    iconName: 'eye',
    borderColor: 'border-l-green-500',
    badgeBg: 'bg-green-500/15',
    badgeText: 'text-green-700',
    tools: [
      // Devices & Hardware
      { name: 'query_devices', description: 'Search and filter devices', category: 'Devices & Hardware' },
      { name: 'get_device_details', description: 'Get comprehensive device info', category: 'Devices & Hardware' },
      { name: 'get_device_hardware_health', description: 'Get RAID, disk and hardware collector health', category: 'Devices & Hardware' },
      { name: 'query_device_workloads', description: 'List containers and VMs hosted on a device (Docker, Podman, Hyper-V, Proxmox)', category: 'Devices & Hardware' },
      { name: 'get_device_time_status', description: 'Get Windows time sync health and expected timezone', category: 'Devices & Hardware' },
      { name: 'list_device_restore_point_attempts', description: 'List System Restore checkpoints requested before patches, scripts and installs', category: 'Devices & Hardware' },
      { name: 'list_time_sync_issues', description: 'List observed time synchronization findings', category: 'Devices & Hardware' },
      { name: 'analyze_metrics', description: 'Time-series metrics analysis', category: 'Devices & Hardware' },
      { name: 'get_active_users', description: 'Active user sessions', category: 'Devices & Hardware' },
      { name: 'get_user_experience_metrics', description: 'Login performance and session trends', category: 'Devices & Hardware' },
      { name: 'get_fleet_device_stats', description: 'Exact fleet-wide device counts by status', category: 'Devices & Hardware' },
      { name: 'get_fleet_health', description: 'Fleet health overview and aggregates', category: 'Devices & Hardware' },
      { name: 'get_fleet_findings', description: 'Deduplicated fleet hygiene findings', category: 'Devices & Hardware' },
      { name: 'analyze_fleet_metrics', description: 'Fleet-wide metric aggregation from rollups', category: 'Devices & Hardware' },
      { name: 'analyze_boot_performance', description: 'Boot performance analysis from stored boot history', category: 'Devices & Hardware' },
      { name: 'get_device_context', description: 'Brain device context lookup', category: 'Devices & Hardware' },
      // Network & DNS
      { name: 'list_network_assets', description: 'List network assets', category: 'Network & DNS' },
      { name: 'get_network_asset', description: 'Get network asset details', category: 'Network & DNS' },
      { name: 'get_network_changes', description: 'Network change detection', category: 'Network & DNS' },
      { name: 'get_ip_history', description: 'IP address history', category: 'Network & DNS' },
      { name: 'get_network_asset_reachability', description: 'Network asset reachability with source and age', category: 'Network & DNS' },
      { name: 'get_interface_history', description: 'Bounded topology port history', category: 'Network & DNS' },
      { name: 'get_link_health', description: 'Current topology link health per endpoint', category: 'Network & DNS' },
      { name: 'get_topology_impact', description: 'Possible topology impact with cited evidence', category: 'Network & DNS' },
      { name: 'get_recent_network_changes', description: 'Bounded topology change history', category: 'Network & DNS' },
      { name: 'get_topology_monitoring_status', description: 'Recurring topology monitoring status for a site', category: 'Network & DNS' },
      { name: 'get_topology', description: 'Bounded topology graph for a pinned site', category: 'Network & DNS' },
      { name: 'get_link_evidence', description: 'Observations behind one topology link', category: 'Network & DNS' },
      { name: 'get_diagnostic_run', description: 'One topology diagnostic run result', category: 'Network & DNS' },
      { name: 'get_dns_security', description: 'DNS security analysis', category: 'Network & DNS' },
      // Security & Compliance
      { name: 'get_security_posture', description: 'Security posture scores', category: 'Security & Compliance' },
      { name: 'get_trust_page_status', description: 'Public trust page status', category: 'Security & Compliance' },
      { name: 'security_scan (vulnerabilities)', description: 'Query vulnerability data', category: 'Security & Compliance' },
      { name: 'ioc_hunt (list_rule_sets/preview_sweep/list_sweeps/sweep_status)', description: 'Detection rule sets, IOC sweep preview, list and status', category: 'Security & Compliance' },
      // W04 (#6758): reads of staff-written policy config, no approval needed
      { name: 'manage_software_policy (list/get)', description: 'List or read software policies', category: 'Security & Compliance' },
      { name: 'get_software_compliance', description: 'Software compliance checks', category: 'Security & Compliance' },
      { name: 'query_compliance_policies', description: 'List compliance policies', category: 'Security & Compliance' },
      { name: 'get_compliance_status', description: 'Device-level compliance status', category: 'Security & Compliance' },
      // W01 (#6755)
      { name: 'get_elevation_history', description: 'Admin elevation request history', category: 'Security & Compliance' },
      { name: 'get_user_risk_scores', description: 'User security risk scores', category: 'Security & Compliance' },
      { name: 'get_user_risk_detail', description: "One user's risk history", category: 'Security & Compliance' },
      { name: 'get_peripheral_activity', description: 'USB and peripheral device activity', category: 'Security & Compliance' },
      // W01 (#6755) follow-up
      { name: 'get_browser_security', description: 'Browser extensions and browser policy compliance', category: 'Security & Compliance' },
      { name: 'get_sensitive_data_overview', description: 'Sensitive data scan findings (chat only, not agents)', category: 'Security & Compliance' },
      { name: 'get_incident_timeline', description: 'Incident details and timeline', category: 'Security & Compliance' },
      { name: 'generate_incident_report', description: 'Incident report', category: 'Security & Compliance' },
      // Alerts & Notifications
      { name: 'list_incidents', description: 'List incidents', category: 'Alerts & Notifications' },
      { name: 'list_remediation_suggestions', description: 'List remediation suggestions', category: 'Alerts & Notifications' },
      { name: 'find_proven_fixes', description: 'Find fixes proven on the same problem', category: 'Alerts & Notifications' },
      { name: 'manage_alerts (list/get)', description: 'View alerts', category: 'Alerts & Notifications' },
      { name: 'manage_delivery (resolve/list_routing/list_escalation)', description: 'Preview alert delivery and view routing rules and escalation policies', category: 'Alerts & Notifications' },
      { name: 'manage_notification_channels (list)', description: 'List notification channels', category: 'Alerts & Notifications' },
      { name: 'manage_alert_rules (list_rules/get_rule/test_rule)', description: 'View alert rules', category: 'Alerts & Notifications' },
      // Files, Disk & Registry
      { name: 'analyze_disk_usage', description: 'Filesystem analysis from the latest stored scan', category: 'Files, Disk & Registry' },
      { name: 'list_diagnostic_access_grants', description: 'List diagnostic access requests and grants', category: 'Files, Disk & Registry' },
      { name: 'disk_cleanup (preview)', description: 'Preview cleanup candidates', category: 'Files, Disk & Registry' },
      { name: 'system_cleanup (status)', description: 'Read the progress and result of a native cleanup run', category: 'Files, Disk & Registry' },
      // Logs & Audit
      { name: 'query_audit_log', description: 'Search audit logs', category: 'Logs & Audit' },
      { name: 'query_change_log', description: 'Device change log search', category: 'Logs & Audit' },
      { name: 'search_logs', description: 'Event log search', category: 'Logs & Audit' },
      { name: 'get_log_trends', description: 'Log trend analysis', category: 'Logs & Audit' },
      { name: 'search_agent_logs', description: 'Agent diagnostic log search', category: 'Logs & Audit' },
      // Scripts & Automation
      { name: 'search_script_library', description: 'Search scripts and templates', category: 'Scripts & Automation' },
      { name: 'get_script_details', description: 'Script content, versions, and stats', category: 'Scripts & Automation' },
      { name: 'get_script_execution_history', description: 'Past execution results for a script', category: 'Scripts & Automation' },
      { name: 'get_script_execution', description: 'One script execution with its output', category: 'Scripts & Automation' },
      // W01 (#6755)
      { name: 'list_scripts', description: 'List scripts in the library', category: 'Scripts & Automation' },
      { name: 'list_script_templates', description: 'List script templates', category: 'Scripts & Automation' },
      // AI script authoring (behind BREEZE_AI_SCRIPT_AUTHORING_ENABLED). A
      // proposal is inert: nothing runs until run_script consumes it (Tier 3).
      { name: 'propose_script', description: 'Author a script as a proposal for independent review', category: 'Scripts & Automation' },
      { name: 'get_script_proposal', description: 'Read a script proposal, its scan and its review', category: 'Scripts & Automation' },
      { name: 'list_playbooks', description: 'List self-healing playbooks', category: 'Scripts & Automation' },
      { name: 'get_playbook_history', description: 'Playbook execution history', category: 'Scripts & Automation' },
      // Tool Catalog W03 (#5218, behind FLOWS_ENABLED): flow reads.
      { name: 'validate_flow', description: 'Check a flow document without saving it', category: 'Scripts & Automation' },
      { name: 'get_flow', description: 'Read a flow and re-validate it', category: 'Scripts & Automation' },
      { name: 'list_flows', description: 'List flows and drafts', category: 'Scripts & Automation' },
      // Tool Catalog W04 (#5219, behind FLOWS_ENABLED): flow run reads.
      { name: 'list_flow_runs', description: 'List flow runs and their status', category: 'Scripts & Automation' },
      { name: 'get_flow_run', description: 'Read one flow run step by step', category: 'Scripts & Automation' },
      // Configuration Policies
      { name: 'list_configuration_policies', description: 'List config policies', category: 'Configuration Policies' },
      { name: 'get_configuration_policy', description: 'Get config policy details', category: 'Configuration Policies' },
      { name: 'get_effective_configuration', description: 'Effective config resolution', category: 'Configuration Policies' },
      { name: 'preview_configuration_change', description: 'Preview config impact', category: 'Configuration Policies' },
      { name: 'configuration_policy_compliance', description: 'Policy compliance status', category: 'Configuration Policies' },
      // Fleet Operations
      { name: 'manage_deployments (list/get)', description: 'View deployments', category: 'Fleet Operations' },
      { name: 'manage_patches (list/compliance)', description: 'View patches and compliance', category: 'Fleet Operations' },
      { name: 'manage_groups (list/get/preview)', description: 'View device groups', category: 'Fleet Operations' },
      { name: 'manage_maintenance_windows (list/get)', description: 'View maintenance windows', category: 'Fleet Operations' },
      { name: 'manage_automations (list/get/history)', description: 'View automations', category: 'Fleet Operations' },
      { name: 'generate_report (list/data/history/download)', description: 'View and download reports', category: 'Fleet Operations' },
      // Backup & Recovery
      { name: 'query_backups', description: 'List backup configs, jobs, and policies', category: 'Backup & Recovery' },
      { name: 'get_backup_status', description: 'Backup health summary', category: 'Backup & Recovery' },
      { name: 'browse_snapshots', description: 'Browse backup snapshots', category: 'Backup & Recovery' },
      // W01 (#6755): Hyper-V, MSSQL, vault, SLA and C2C reads
      { name: 'get_hyperv_vm_details', description: 'Hyper-V VM details', category: 'Backup & Recovery' },
      { name: 'query_hyperv_vms', description: 'List Hyper-V VMs', category: 'Backup & Recovery' },
      { name: 'get_mssql_backup_status', description: 'SQL Server backup status', category: 'Backup & Recovery' },
      { name: 'query_mssql_instances', description: 'List SQL Server instances', category: 'Backup & Recovery' },
      { name: 'get_vault_status', description: 'Backup vault sync status', category: 'Backup & Recovery' },
      { name: 'get_vm_restore_estimate', description: 'VM restore time estimate', category: 'Backup & Recovery' },
      { name: 'query_backup_sla', description: 'Backup SLA configurations', category: 'Backup & Recovery' },
      { name: 'get_sla_breaches', description: 'Backup SLA breach events', category: 'Backup & Recovery' },
      { name: 'get_sla_compliance_report', description: 'Backup SLA compliance report', category: 'Backup & Recovery' },
      { name: 'query_c2c_jobs', description: 'Cloud-to-cloud backup jobs', category: 'Backup & Recovery' },
      { name: 'search_c2c_items', description: 'Search cloud mailbox/file items', category: 'Backup & Recovery' },
      // W01 (#6755) follow-up: vault, C2C connection and DR reads
      { name: 'query_vaults', description: 'List backup vaults', category: 'Backup & Recovery' },
      { name: 'query_c2c_connections', description: 'Cloud-to-cloud backup connections', category: 'Backup & Recovery' },
      { name: 'query_dr_plans', description: 'List disaster recovery plans', category: 'Backup & Recovery' },
      { name: 'get_dr_plan_details', description: 'Disaster recovery plan details', category: 'Backup & Recovery' },
      // Full-control W03 (#6757)
      { name: 'manage_backup_profiles (list/get)', description: 'List or read backup profiles (what each one backs up)', category: 'Backup & Recovery' },
      { name: 'get_dr_execution_status', description: 'Disaster recovery execution status', category: 'Backup & Recovery' },
      // Monitoring & Analytics
      { name: 'query_monitors', description: 'List monitors with status', category: 'Monitoring & Analytics' },
      { name: 'manage_monitors (get/create/update/delete)', description: 'Monitor details and history; retired writes return guidance', category: 'Monitoring & Analytics' },
      { name: 'query_analytics', description: 'SLA compliance and capacity predictions', category: 'Monitoring & Analytics' },
      { name: 'get_executive_summary', description: 'Executive summary metrics', category: 'Monitoring & Analytics' },
      // Monitor definitions (#5289 Task 8) — distinct from the network-monitor
      // `query_monitors` / `manage_monitors` above: a monitor definition is the
      // authored condition+severity+delivery object that compiles into a
      // managed alert rule/automation.
      { name: 'list_monitors', description: 'List monitor definitions visible to the caller', category: 'Monitoring & Analytics' },
      { name: 'get_monitor', description: 'Get a monitor definition with its policy attachments', category: 'Monitoring & Analytics' },
      // Remote Access & Control
      { name: 'list_remote_sessions', description: 'List remote sessions', category: 'Remote Access & Control' },
      // Integrations
      { name: 'list_org_contacts', description: 'List organization contacts', category: 'Integrations' },
      { name: 'list_sites', description: 'List organization sites', category: 'Integrations' },
      { name: 'get_site', description: 'Get site details', category: 'Integrations' },
      { name: 'query_webhooks', description: 'List webhooks and delivery status', category: 'Integrations' },
      { name: 'query_psa_status', description: 'PSA connection status', category: 'Integrations' },
      { name: 'query_agent_versions', description: 'Agent versions and upgrade status', category: 'Integrations' },
      // Ticketing
      { name: 'list_time_entries', description: 'List tracked time entries', category: 'Ticketing' },
      { name: 'get_running_timer', description: 'Get the current running timer', category: 'Ticketing' },
      { name: 'get_timesheet', description: 'Get a timesheet summary', category: 'Ticketing' },
      { name: 'get_ticket_approval_status', description: 'View a ticket\'s budget and customer-approval status', category: 'Ticketing' },
      { name: 'list_business_calendars', description: 'List business-hours calendars used for SLA deadlines', category: 'Ticketing' },
      { name: 'list_ticket_routing_rules', description: 'List ticket routing rules applied to new tickets', category: 'Ticketing' },
      { name: 'test_ticket_routing_rule', description: 'Dry-run which routing rule would match a sample ticket', category: 'Ticketing' },
      { name: 'manage_ticket_checklist (list/list_templates/get_template)', description: 'View ticket checklist steps and checklist templates', category: 'Ticketing' },
      // Full-control W06 (#6776): PSA configuration and ticket-ops reads.
      { name: 'manage_ticket_config (get_config/get_org_settings/list_categories/list_domains)', description: 'View ticket statuses, priorities, SLA overrides, categories and customer email domains', category: 'Ticketing' },
      { name: 'manage_ticket_checklist_templates (list/get)', description: 'View checklist templates and their steps', category: 'Ticketing' },
      { name: 'manage_ticket_attachments (list)', description: 'List the files attached to a ticket', category: 'Ticketing' },
      { name: 'manage_ticket_forms (list/available)', description: 'View ticket intake forms and the ones an organization can use', category: 'Ticketing' },
      { name: 'manage_ticket_response_templates (list)', description: 'View the partner\'s canned ticket replies', category: 'Ticketing' },
      { name: 'manage_time_suggestions (list)', description: 'See your time-entry suggestions for a day', category: 'Ticketing' },
      // Full-control W07 (#6777): alert correlation + signal triage reads.
      { name: 'get_alert_correlations (groups/get/by_alert/links/analyze/evaluation/explain)', description: 'See which alerts are correlated, how well grouping is working, and root-cause evidence for a group (log text is untrusted)', category: 'Alerts & Notifications' },
      { name: 'manage_device_anomalies (list)', description: 'List unusual metric behaviour detected on a device', category: 'Alerts & Notifications' },
      // Full-control W08 (#6778): network topology reads. Chat and MCP only (not offered to AI agents).
      { name: 'get_topology_graph (graph/nodes/node/relationship/evidence/group_members/expansion/health)', description: 'Read a site\'s network map: devices and links, one device or link in detail, the evidence behind a link, and health (names are untrusted text)', category: 'Network & DNS' },
      { name: 'run_topology_diagnostic (collectors/get)', description: 'See which devices can run a connectivity check and read a check\'s result', category: 'Network & DNS' },
      { name: 'manage_topology_monitoring (list_policies/list_targets/get_settings)', description: 'View a site\'s recurring network checks, probe targets and effective topology settings', category: 'Network & DNS' },
      { name: 'manage_topology_templates (list_templates/list_versions/site_options)', description: 'View topology monitoring templates, their versions, and the published ones a site can apply', category: 'Network & DNS' },
      { name: 'apply_topology_template (status)', description: 'See how a template application is progressing, site by site', category: 'Network & DNS' },
      // Full-control W09 (#6779): SNMP, known-guest and UniFi reads. Known guests and UniFi are chat/MCP only (partner-wide; not offered to AI agents).
      { name: 'manage_snmp_templates (list/get/browse_oids/validate_oids)', description: 'View SNMP monitoring templates (the OIDs polled per device class), search known OIDs and check an OID list (names are untrusted text)', category: 'Network & DNS' },
      { name: 'get_snmp_metrics (history/dashboard)', description: 'Read bucketed SNMP history (interface traffic, uptime and other OIDs) for an asset, or the SNMP dashboard', category: 'Network & DNS' },
      { name: 'manage_known_guests (list)', description: 'View the partner-wide list of known guest MAC addresses that discovery does not flag', category: 'Network & DNS' },
      { name: 'get_unifi_status (status/hosts/collectors/mappings/telemetry/sync_runs/controller_sites)', description: 'Read the partner UniFi integration: connection, consoles, collectors, site mappings, device telemetry and sync history', category: 'Network & DNS' },
      { name: 'get_fleet_health (history/offenders/evaluation/org_summary)', description: 'A device\'s reliability score over time, the services and components behind it, score quality, and an organization rollup', category: 'Devices & Hardware' },
      // AI Governance
      { name: 'list_ai_agents', description: 'List AI agents', category: 'AI Governance' },
      { name: 'read_artifact', description: 'Read a stored tool-result artifact', category: 'AI Governance' },
      { name: 'list_ai_agent_runs', description: 'List AI agent runs', category: 'AI Governance' },
      { name: 'get_ai_agent_run', description: 'Get AI agent run details', category: 'AI Governance' },
      // Full-control W10 (#6780): read-back of what the AI did and plans. The operator-task reads are chat/MCP only (free text from
      // other runs; not offered to AI agents). Text in all of them is untrusted data.
      { name: 'get_device_ai_activity', description: 'Count the scripts and commands the AI dispatched to a device, and show who started one action', category: 'AI Governance' },
      { name: 'list_operator_tasks', description: 'List the multi-step tasks the AI operator is running or has finished (whole organization; not for site-restricted sessions)', category: 'AI Governance' },
      { name: 'get_operator_task', description: 'Read one operator task: steps, timeline, proposed plan and linked runs (credential hand-over details are never shown)', category: 'AI Governance' },
      { name: 'list_ai_agent_schedules', description: 'List when AI agents run on a schedule, with partner baselines and organization overrides', category: 'AI Governance' },
      { name: 'list_fleet_designs', description: 'List completed Fleet Design reports (whole organization; not for site-restricted sessions)', category: 'AI Governance' },
      { name: 'get_fleet_design', description: 'Read one Fleet Design report as markdown (applying it is a separate, approval-gated action)', category: 'AI Governance' },
      // Full-control W11 (#6781): security policy reads. Access reviews and PAM rules are chat/MCP only (not offered to AI agents);
      // device-reported text (hostnames, admin account names, audit deviations) is untrusted data.
      { name: 'get_security_compliance', description: 'Security dashboard, score breakdown, trend, AV/firewall/encryption/password-policy/local-admin status by device', category: 'Security & Compliance' },
      { name: 'manage_security_recommendations (list)', description: 'List security recommendations and their status per organization', category: 'Security & Compliance' },
      { name: 'manage_access_reviews (list/get)', description: 'View user access reviews: members, roles, permissions and recorded decisions (chat/MCP only)', category: 'Security & Compliance' },
      { name: 'manage_audit_baselines (list/compliance/device_results)', description: 'View audit-policy baselines, drift compliance and one device\'s deviations', category: 'Security & Compliance' },
      { name: 'manage_security_policies (list)', description: 'List antivirus/EDR security policy templates', category: 'Security & Compliance' },
      { name: 'manage_recovery_keys (list)', description: 'BitLocker/FileVault key escrow metadata for a device (never the key itself)', category: 'Security & Compliance' },
      { name: 'manage_pam_rules (list_rules/get_config/list_signer_groups)', description: 'View PAM elevation rules, the default verdict and signer groups (chat/MCP only)', category: 'Security & Compliance' },
      // Full-control W12 (#6782): software reads. Package, vendor and version strings are untrusted data.
      { name: 'manage_software_catalog (list/get)', description: 'View the software catalog: packages, versions and winget/Homebrew install methods (download links show the host only)', category: 'Fleet Operations' },
      { name: 'search_packages', description: 'Search winget or Homebrew for a package id', category: 'Fleet Operations' },
      { name: 'manage_software_deployments (list/get/summary/results)', description: 'View software deployments and per-device results', category: 'Fleet Operations' },
      { name: 'get_device_software', description: 'Installed software on one device', category: 'Fleet Operations' },
      { name: 'manage_software_inventory (list/names/devices)', description: 'Software seen across the fleet, with allow/block status and the devices that have it', category: 'Fleet Operations' },
      // Full-control W13 (#6783): device inventory reads. Device-reported text is untrusted data.
      { name: 'get_device_events', description: 'Activity timeline for one device: what ran, changed or failed, and who or what did it (no emails or IP addresses)', category: 'Devices & Hardware' },
      { name: 'get_device_health', description: "The Breeze agent's latest health report for one device", category: 'Devices & Hardware' },
      { name: 'get_process_samples', description: 'A recorded top-process snapshot for one device at a past time', category: 'Devices & Hardware' },
      { name: 'get_management_posture', description: 'Other management products (RMM, antivirus, backup, MDM) detected across the fleet', category: 'Devices & Hardware' },
      { name: 'manage_device_function (get)', description: "One device's function (domain controller, file server, ...)", category: 'Devices & Hardware' },
      { name: 'manage_device_links (list/get/for_device)', description: 'Linked device profiles: multi-boot records of one machine, or a VM host and its guests', category: 'Devices & Hardware' },
      { name: 'manage_manual_assets (list)', description: 'Hand-entered inventory without an agent (spare laptops, phones, printers)', category: 'Devices & Hardware' },
      { name: 'manage_device_warranty (get/expiring)', description: "One device's warranty, or devices whose warranty ends soon", category: 'Devices & Hardware' },
      // Full-control W13 PR B (#6783): secret tenant-variable values are never shown.
      { name: 'manage_tenant_variables (list)', description: 'Tenant variables scripts receive as {{var.key}} (secret values are never shown)', category: 'Scripts & Automation' },
      { name: 'manage_support_sessions (list/get)', description: 'Quick Support sessions and whether their temporary client is online', category: 'Remote Access & Control' },
      // Full-control W14 (#6784): billing lifecycle reads (partner-scoped sessions for rates, settings and device billing).
      { name: 'manage_billing_profiles (list/get/list_work_types/get_org_profile)', description: 'Rate cards with their hourly rates per work type, work types, and the card an organization is billed by', category: 'Billing' },
      { name: 'manage_billing_settings (get_partner/get_org/currency_impact/reporting_totals)', description: 'Invoice defaults and an organization\'s tax, terms and billing contact; preview a currency change; approximate totals across currencies', category: 'Billing' },
      { name: 'manage_contract_templates (list/get/get_version/usage)', description: 'Agreement templates customers sign, their versions, and where each is used', category: 'Billing' },
      { name: 'manage_contract_documents (list)', description: 'Signed agreements and whether each is filed under a contract (no signer email)', category: 'Billing' },
      { name: 'get_device_billing', description: 'Which contract lines bill a device, or why it is not billable', category: 'Billing' },
      // Full-control W14 PR B (#6784): accounting reads (partner-scoped; a search term is filtered in Breeze, never sent).
      { name: 'manage_accounting_sync (status/owed_operations/customers/mappings/income_accounts/remote_candidates)', description: 'QuickBooks or Xero connection status, payment sync backlog, customers, customer and item mappings, and income accounts', category: 'Billing' },
      // Wisp memory (W03 #9909): offered only when Wisp is on, and only under a delegation grant.
      { name: 'recall', description: 'Recall Wisp memory inside the delegation grant', category: 'AI Governance' },
      // Wisp concerns (W05a #9911): offered only when Wisp is on, and only under a delegation grant.
      { name: 'list_concerns', description: 'List the loose ends Wisp is tracking inside the delegation grant', category: 'AI Governance' },
      // Wisp thread links (W08 #9914): offered only when Wisp is on, and only under a delegation grant.
      { name: 'list_links', description: 'List the objects linked to the Wisp thread that you can still see', category: 'AI Governance' },
      // Other
      { name: 'query_custom_fields', description: 'Custom field definitions and values', category: 'Other' },
      { name: 'manage_tags (list)', description: 'List all device tags', category: 'Other' },
      { name: 'manage_saved_filters (list/get)', description: 'List and view saved filters', category: 'Other' },
      // Endpoint messaging (#8742 W02)
      { name: 'send_endpoint_message (list/get)', description: 'List sent end-user messages and their delivery status', category: 'Ticketing' },
    ],
  },
  {
    tier: 2,
    label: 'aiRisk.tiers.tier2.label',
    description:
      'Low-risk mutations and audited reads, always logged to the audit trail. Read-only entries auto-execute in every approval mode; mutations auto-execute except under per-step approval, which asks a quick confirmation.',
    iconName: 'shield-check',
    borderColor: 'border-l-blue-500',
    badgeBg: 'bg-blue-500/15',
    badgeText: 'text-blue-700',
    tools: [
      // Tool Catalog W03 (#5218, behind FLOWS_ENABLED): saves a draft; nothing runs.
      { name: 'draft_flow', description: 'Save a flow as a reviewable draft', category: 'Scripts & Automation' },
      // Tool Catalog W04 (#5219, behind FLOWS_ENABLED): stop a flow run.
      { name: 'cancel_flow_run', description: 'Cancel a flow run that has not finished', category: 'Scripts & Automation' },
      // Security & Compliance — EDR provider framework (#8167 W03)
      { name: 'edr_endpoint_action (scan)', description: 'EDR scan of a device through its linked vendor', category: 'Security & Compliance' },
      { name: 'sync_edr_data', description: 'Queue an immediate EDR vendor sync', category: 'Security & Compliance' },
      // Alerts & Notifications
      { name: 'manage_alerts (acknowledge)', description: 'Acknowledge alerts', category: 'Alerts & Notifications' },
      { name: 'manage_alerts (resolve)', description: 'Resolve alerts', category: 'Alerts & Notifications' },
      { name: 'manage_alerts (suppress)', description: 'Suppress alerts temporarily', category: 'Alerts & Notifications' },
      { name: 'manage_notification_channels (test)', description: 'Test notification channel', category: 'Alerts & Notifications' },
      // Backup & Recovery (full-control W03, #6757)
      { name: 'manage_dr_plan (create_plan/update_plan/add_group/update_group)', description: 'Create or edit a disaster recovery plan and its groups (refused while the plan is running)', category: 'Backup & Recovery' },
      { name: 'manage_backup_profiles (create)', description: 'Create an organization backup profile (a partner-wide profile needs approval)', category: 'Backup & Recovery' },
      { name: 'configure_backup_sla (create/update)', description: 'Create or change a backup SLA (RPO/RTO targets and breach alerts)', category: 'Backup & Recovery' },
      // Monitoring & Analytics (#5290 W03)
      { name: 'get_monitor_activity', description: 'Per-device breach state and recent breach episodes for a monitor', category: 'Monitoring & Analytics' },
      { name: 'reset_monitor_escalation', description: 'Clear a monitor recurrence escalation for one device and resume its automatic responses', category: 'Monitoring & Analytics' },
      // Devices & Hardware
      { name: 'set_device_context', description: 'Set brain device context', category: 'Devices & Hardware' },
      { name: 'resolve_device_context', description: 'Resolve brain device context', category: 'Devices & Hardware' },
      // Live device reads — each runs a command on the device (devices.execute)
      { name: 'analyze_boot_performance (triggerCollection)', description: 'Collect fresh boot metrics from the device', category: 'Devices & Hardware' },
      // Services & Processes — live listings run a command on the device
      { name: 'manage_services (list)', description: 'List services on device', category: 'Services & Processes' },
      { name: 'manage_processes (list)', description: 'List running processes with CPU/memory', category: 'Services & Processes' },
      { name: 'manage_scheduled_tasks (list)', description: 'List Windows scheduled tasks', category: 'Services & Processes' },
      // Network & DNS
      { name: 'acknowledge_network_device', description: 'Acknowledge network device', category: 'Network & DNS' },
      { name: 'manage_dns_policy', description: 'DNS policy management', category: 'Network & DNS' },
      // Remote Access & Control
      { name: 'execute_command (list_processes/file_list/event_logs_list)', description: 'Read-only device commands (process list, directory listings, event log channel list)', category: 'Remote Access & Control' },
      // Files, Disk & Registry
      { name: 'file_operations (list)', description: 'List directory contents on device', category: 'Files, Disk & Registry' },
      { name: 'analyze_disk_usage (refresh)', description: 'Run a fresh filesystem scan on the device', category: 'Files, Disk & Registry' },
      { name: 'system_cleanup (list)', description: 'List OS-native cleaners and their estimated reclaim', category: 'Files, Disk & Registry' },
      { name: 'request_diagnostic_access', description: 'Ask an administrator to approve read-only diagnostic access to specific paths', category: 'Files, Disk & Registry' },
      { name: 'revoke_diagnostic_access', description: 'Withdraw a diagnostic access request or grant', category: 'Files, Disk & Registry' },
      { name: 'diagnostic_list_directory', description: 'List a folder under an administrator-approved read-only grant', category: 'Files, Disk & Registry' },
      { name: 'diagnostic_read_file', description: 'Read part of a file under an administrator-approved read-only grant', category: 'Files, Disk & Registry' },
      { name: 'registry_operations (read_key/get_value)', description: 'Read Windows registry values on device', category: 'Files, Disk & Registry' },
      // Logs & Audit
      { name: 'detect_log_correlations', description: 'Log correlation detection', category: 'Logs & Audit' },
      { name: 'set_agent_log_level', description: 'Set agent log level', category: 'Logs & Audit' },
      { name: 'capture_agent_pprof', description: 'Capture agent pprof profiles', category: 'Logs & Audit' },
      // Configuration Policies
      { name: 'apply_configuration_policy', description: 'Assign config policy', category: 'Configuration Policies' },
      { name: 'remove_configuration_policy_assignment', description: 'Remove config assignment', category: 'Configuration Policies' },
      { name: 'manage_configuration_policy (activate/deactivate)', description: 'Toggle policy status', category: 'Configuration Policies' },
      // Other
      { name: 'manage_tags (add/remove)', description: 'Add or remove device tags', category: 'Other' },
      { name: 'manage_saved_filters (create/delete)', description: 'Create or delete saved filters', category: 'Other' },
      // Fleet Operations
      { name: 'manage_deployments (pause/resume)', description: 'Pause or resume deployments', category: 'Fleet Operations' },
      { name: 'manage_patches (approve/decline/defer)', description: 'Patch approval decisions', category: 'Fleet Operations' },
      { name: 'ioc_hunt (cancel_sweep)', description: 'Cancel an IOC sweep', category: 'Security & Compliance' },
      { name: 'manage_groups (add_devices/remove_devices)', description: 'Manage group membership', category: 'Fleet Operations' },
      { name: 'manage_automations (enable/disable)', description: 'Toggle automation status', category: 'Fleet Operations' },
      { name: 'generate_report (create/update/delete/generate)', description: 'Report management', category: 'Fleet Operations' },
      // Ticketing (P2-4, #4191) — pre-existing gap, manage_tickets had zero
      // entries here before. move_org is listed separately under Tier 3.
      // Full-control W02 (#6756): comment/update_status/update_fields are
      // input-aware. A public comment, resolving (or any custom status), and
      // changing the requester escalate to Tier 3 supervised; internal notes
      // and other updates stay here. edit_comment/delete_comment are Tier 3.
      { name: 'manage_tickets (create/comment/assign/update_status/update_fields/link_alert/unlink_alert/create_from_alert)', description: 'Create tickets, add internal notes, and update tickets (a public comment, resolving, or changing the requester needs approval)', category: 'Ticketing' },
      { name: 'manage_tickets (link_ticket/unlink_ticket)', description: 'Link related tickets in one organization, or remove a link', category: 'Ticketing' },
      { name: 'manage_tickets (log_time_entry/start_timer/stop_timer/update_time_entry)', description: 'Track time against tickets', category: 'Ticketing' },
      { name: 'manage_tickets (link_device/draft)', description: 'AI ticket triage: link a device or store a reply/resolution-note draft', category: 'Ticketing' },
      { name: 'manage_ticket_checklist (add_item/update_item/delete_item/reorder/apply_template)', description: 'Edit ticket checklist steps (ticking a step done stays human-only)', category: 'Ticketing' },
      // Full-control W06 (#6776): ticket operations that stay at Tier 2. Creating a checklist
      // template is Tier 2 for an organization template; a partner-wide one needs approval (input-aware).
      { name: 'manage_tickets (bulk_update)', description: 'Assign, change the status of (not resolve) or set the priority of up to 50 tickets in one organization', category: 'Ticketing' },
      { name: 'manage_ticket_checklist_templates (create)', description: 'Create an organization checklist template (a partner-wide template needs approval)', category: 'Ticketing' },
      { name: 'manage_ticket_inbox (list)', description: 'Review inbound email the router could not place (sender text is untrusted)', category: 'Ticketing' },
      { name: 'manage_ticket_attachments (read_content/attach_from_artifact)', description: 'Read a text attachment, or stage a run artifact on a ticket (a person posts it)', category: 'Ticketing' },
      { name: 'manage_time_suggestions (confirm/dismiss/undo)', description: 'Log, dismiss or restore your own time-entry suggestions', category: 'Ticketing' },
      // Full-control W07 (#6777): acknowledging or resolving a correlation group touches the members of
      // one organization's group (the manage_alerts precedent); the rest are labels and a status on one row.
      { name: 'manage_alert_correlations (acknowledge_group/resolve_group/acknowledge_related)', description: 'Acknowledge or resolve every alert in a correlation group, or an alert and its related alerts', category: 'Alerts & Notifications' },
      { name: 'manage_alert_correlations (feedback/rca_feedback)', description: 'Tell Breeze a correlation was wrong, or a root-cause analysis was helpful', category: 'Alerts & Notifications' },
      { name: 'manage_device_anomalies (dismiss/resolve)', description: 'Dismiss or resolve a detected metric anomaly', category: 'Alerts & Notifications' },
      { name: 'reliability_feedback', description: 'Label a device\'s reliability score: failure confirmed, replaced, or false alarm', category: 'Devices & Hardware' },
      // Full-control W08 (#6778): tenant-internal topology writes with a revision check; a diagnostic start probes from one device.
      { name: 'run_topology_diagnostic (start/cancel)', description: 'Start a fixed gateway, DNS, internet or trace-route check from a device at a site, or stop one', category: 'Network & DNS' },
      { name: 'manage_topology_manual (create_node/update_node/delete_node/create_relationship/delete_relationship)', description: 'Add, change or remove a hand-drawn switch, router, AP or link on a site\'s network map', category: 'Network & DNS' },
      { name: 'manage_topology_monitoring (upsert_policy/delete_policy/upsert_target/delete_target/patch_settings)', description: 'Change a site\'s recurring network checks, probe targets or topology settings (arming a check stays in the topology page)', category: 'Network & DNS' },
      { name: 'manage_topology_templates (create_template/update_template/create_version)', description: 'Draft a topology monitoring template or a new version of one (nothing applies until a version is published)', category: 'Network & DNS' },
      { name: 'apply_topology_template (preview)', description: 'Preview what applying a template would change on named sites', category: 'Network & DNS' },
      // Full-control W09 (#6779): tenant-internal rows (reversible), one agent ping, one queued vendor pull. Each write needs your MFA session.
      { name: 'manage_snmp_templates (create/update/delete)', description: 'Create, change or delete a custom SNMP template (built-ins are read-only; the result keeps the old row so a delete can be undone)', category: 'Network & DNS' },
      { name: 'probe_network_asset', description: 'Check now: ping a discovered asset from an online agent in its site and report reachable or not', category: 'Network & DNS' },
      { name: 'manage_known_guests (add/delete)', description: 'Add or remove a known guest MAC address for every organization of the partner', category: 'Network & DNS' },
      { name: 'trigger_unifi_sync', description: 'Queue a manual sync of the partner UniFi integration', category: 'Network & DNS' },
      // Full-control W11 (#6781): bookkeeping that changes nothing on a device and can be undone or is only recorded.
      { name: 'manage_security_recommendations (complete/dismiss)', description: 'Mark a security recommendation completed or dismissed for one organization (reopen in the web app)', category: 'Security & Compliance' },
      { name: 'manage_access_reviews (decide_item)', description: 'Record keep/revoke on an access review item; nothing changes until a person completes the review (needs your MFA session)', category: 'Security & Compliance' },
      { name: 'manage_audit_baselines (request_apply)', description: 'Request that an audit baseline be applied to devices; a different person approves it in the web app', category: 'Security & Compliance' },
      // Full-control W12 (#6782): reversible, tenant-internal (writes need your MFA session).
      { name: 'manage_software_catalog (create/update/import_package)', description: 'Add a software package to the catalog or edit its name and description (a partner-wide package needs approval)', category: 'Fleet Operations' },
      { name: 'manage_software_deployments (cancel)', description: 'Cancel the pending installs of a software deployment', category: 'Fleet Operations' },
      { name: 'manage_fleet_findings (acknowledge/dismiss/reopen)', description: 'Acknowledge, dismiss or reopen a fleet finding', category: 'Devices & Hardware' },
      { name: 'manage_custom_fields (create_definition/update_definition)', description: 'Create or edit a custom field definition (a partner-wide one needs approval; not offered to AI agents)', category: 'Other' },
      // Full-control W13 (#6783): reversible, tenant-internal device records (writes need your MFA session).
      { name: 'manage_device_links (create/update/dissolve)', description: 'Link device records as boot profiles of one machine or a VM host and its guests, or unlink them (each device keeps its data)', category: 'Devices & Hardware' },
      { name: 'manage_manual_assets (create/update/link/unlink)', description: 'Add, edit, retire or link a hand-entered inventory row', category: 'Devices & Hardware' },
      // Full-control W13 PR B (#6783): live device read (needs your MFA session).
      { name: 'browse_device_event_log (list_logs)', description: "List a Windows device's event logs, read live from its agent", category: 'Services & Processes' },
      // Billing (full-control W02, #6756): quote drafting and new catalog
      // items. 'Billing' because these are the business capability, not tickets.
      { name: 'manage_quotes (create_draft/update/delete_draft/add_block/update_block/delete_block/reorder_blocks/add_manual_line/add_catalog_line/update_line/remove_line/move_line/reorder_lines)', description: 'Draft quotes: blocks and lines on a quote that has not been sent', category: 'Billing' },
      { name: 'manage_billing_catalog (create_item)', description: 'Add a billing catalog item (inert until a quote, invoice, or contract uses it)', category: 'Billing' },
      // Full-control W14 (#6784): an organization-owned agreement template (a partner-wide one needs approval every time).
      { name: 'manage_contract_templates (create/update)', description: 'Create or rename an organization\'s agreement template (nothing is sent or signable until a version is published)', category: 'Billing' },
      // Full-control W14 PR B (#6784): a read that runs without a prompt.
      { name: 'manage_contracts (preview_invoice)', description: 'What the next billing run of a contract would invoice: lines, totals, auto-issue and recipients (nothing is created)', category: 'Billing' },
      // Wisp memory (W03 #9909): remember writes an unconfirmed block.
      { name: 'remember', description: 'Propose a Wisp memory block (lands unconfirmed)', category: 'AI Governance' },
      // Wisp concerns and watches (W05a #9911): grant-bound, inside the delegation ceiling.
      { name: 'raise_concern', description: 'Ask Wisp to track a loose end for one customer', category: 'AI Governance' },
      { name: 'snooze_concern', description: 'Snooze a Wisp concern for up to 30 days', category: 'AI Governance' },
      { name: 'resolve_concern', description: 'Resolve a Wisp concern and remember the outcome', category: 'AI Governance' },
      { name: 'create_watch', description: 'Ask Wisp to check something on a schedule', category: 'AI Governance' },
      // Wisp thread links (W08 #9914): links one object you can see to the thread.
      { name: 'link_entity', description: 'Link a ticket, device, quote or other object to the Wisp thread', category: 'AI Governance' },
      // Wisp specialists (W07a #9913): sweeps and sandbox analysis run on the call.
      { name: 'launch_specialist (sweep/analysis)', description: 'Ask Wisp to hand a sweep or sandbox analysis to a specialist agent', category: 'AI Governance' },
    ],
  },
  {
    tier: 3,
    label: 'aiRisk.tiers.tier3.label',
    description: 'Destructive or mutating operations that require explicit user approval before execution.',
    iconName: 'shield-alert',
    borderColor: 'border-l-amber-500',
    badgeBg: 'bg-amber-500/15',
    badgeText: 'text-amber-700',
    tools: [
      // Services & Processes
      { name: 'manage_services (start/stop/restart)', description: 'Mutate device services', category: 'Services & Processes' },
      { name: 'manage_processes (kill)', description: 'Terminate a running process', category: 'Services & Processes' },
      { name: 'manage_startup_items (enable/disable)', description: 'Manage startup items', category: 'Services & Processes' },
      { name: 'manage_scheduled_tasks (run/disable/enable)', description: 'Mutate scheduled tasks', category: 'Services & Processes' },
      // Remote Access & Control
      { name: 'execute_command (kill_process/start_service/stop_service/restart_service/file_read/list_services/event_logs_query)', description: 'Mutating system commands, file reads, and commands that can return unredacted credential/PII-bearing content (service binary paths, raw event log messages)', category: 'Remote Access & Control' },
      { name: 'run_script', description: 'Run scripts on up to 10 devices', category: 'Remote Access & Control' },
      // #4767 — the cancel tool requests a stop on an in-flight script
      // execution. Noted as missing from this registry in #4990's PR body
      // when the API side (script_cancel command dispatch) shipped; there is
      // no automated check that catches the next tool this registry misses.
      { name: 'cancel_script_execution', description: 'Request a stop on a running script execution', category: 'Remote Access & Control' },
      { name: 'computer_control', description: 'Send input actions to device', category: 'Remote Access & Control' },
      { name: 'create_remote_session', description: 'Create remote terminal or file session', category: 'Remote Access & Control' },
      { name: 'take_screenshot', description: 'Capture device screenshot', category: 'Remote Access & Control' },
      { name: 'analyze_screen', description: 'Analyze captured screenshot', category: 'Remote Access & Control' },
      // Security & Compliance
      { name: 'security_scan (quarantine/remove/restore)', description: 'Threat management actions', category: 'Security & Compliance' },
      { name: 'ioc_hunt (sweep/import_iocs)', description: 'Run a detect-only IOC sweep in one organization (second approver above 25 devices) or import IOCs as detection rules', category: 'Security & Compliance' },
      { name: 'edr_endpoint_action (isolate/unisolate)', description: 'EDR network isolation or release through the linked vendor (release needs a second approver)', category: 'Security & Compliance' },
      { name: 'manage_software_policy (create/update/delete)', description: 'Software policy management', category: 'Security & Compliance' },
      { name: 'remediate_software_violation', description: 'Remediate software violations', category: 'Security & Compliance' },
      // Files, Disk & Registry
      { name: 'file_operations (read/write/delete/mkdir/rename)', description: 'Read or mutate files on device', category: 'Files, Disk & Registry' },
      { name: 'disk_cleanup (execute)', description: 'Execute disk cleanup', category: 'Files, Disk & Registry' },
      { name: 'system_cleanup (run)', description: 'Run OS-native cleaners (Windows Disk Cleanup/DISM, macOS snapshots/Homebrew, Linux caches/journal)', category: 'Files, Disk & Registry' },
      { name: 'system_cleanup (cancel)', description: 'Cancel a running native cleanup run', category: 'Files, Disk & Registry' },
      { name: 'registry_operations (set_value/create_key/delete_key)', description: 'Modify Windows registry', category: 'Files, Disk & Registry' },
      // Network & DNS
      { name: 'network_discovery', description: 'Network discovery scan', category: 'Network & DNS' },
      { name: 'configure_network_baseline', description: 'Configure a recurring network baseline scan (schedules on-site discovery)', category: 'Network & DNS' },
      { name: 'diagnose_connectivity', description: 'One approved topology connectivity check (fresh MFA)', category: 'Network & DNS' },
      // Scripts & Automation
      { name: 'execute_playbook', description: 'Execute self-healing playbook', category: 'Scripts & Automation' },
      // Tool Catalog W04 (#5219, behind FLOWS_ENABLED): starting a flow needs your approval; its sensitive steps still wait for a human.
      { name: 'run_flow', description: 'Start an enabled flow (each sensitive step still waits for approval)', category: 'Scripts & Automation' },
      // Backup & Recovery
      // Full-control W03 (#6757): triggers and Hyper-V power are approved by the
      // requester; restores, instant boot and DR execution need a second approver.
      { name: 'trigger_backup', description: 'Initiate on-demand backup', category: 'Backup & Recovery' },
      { name: 'trigger_hyperv_backup', description: 'Back up a Hyper-V VM now', category: 'Backup & Recovery' },
      { name: 'trigger_mssql_backup', description: 'Back up a SQL Server database now', category: 'Backup & Recovery' },
      { name: 'verify_mssql_backup', description: 'Verify a SQL Server backup on the device (RESTORE VERIFYONLY)', category: 'Backup & Recovery' },
      { name: 'trigger_vault_sync', description: 'Copy a snapshot to the device\'s local vault', category: 'Backup & Recovery' },
      { name: 'trigger_c2c_sync', description: 'Start a cloud-to-cloud backup sync', category: 'Backup & Recovery' },
      { name: 'configure_vault (create/update)', description: 'Create or repoint a local vault (path, type, retention); the device is reconfigured', category: 'Backup & Recovery' },
      { name: 'manage_hyperv_vm (start/stop/force_stop/pause/resume/save)', description: 'Change a Hyper-V VM\'s power state', category: 'Backup & Recovery' },
      { name: 'manage_hyperv_checkpoints (create/delete/apply)', description: 'Create a checkpoint; deleting or applying one needs a second approver', category: 'Backup & Recovery' },
      { name: 'manage_dr_plan (delete_group)', description: 'Delete a group from a disaster recovery plan', category: 'Backup & Recovery' },
      { name: 'manage_backup_profiles (update/delete)', description: 'Change or delete a backup profile (may be partner-wide)', category: 'Backup & Recovery' },
      { name: 'restore_snapshot', description: 'Restore a backup snapshot (second approver)', category: 'Backup & Recovery' },
      { name: 'restore_as_vm', description: 'Restore a snapshot as a new VM or disk image (second approver)', category: 'Backup & Recovery' },
      { name: 'instant_boot_vm', description: 'Boot a snapshot as a VM (second approver)', category: 'Backup & Recovery' },
      { name: 'restore_hyperv_vm', description: 'Restore a Hyper-V VM from backup (second approver)', category: 'Backup & Recovery' },
      { name: 'restore_mssql_database', description: 'Restore a SQL Server database (second approver)', category: 'Backup & Recovery' },
      { name: 'restore_c2c_items', description: 'Restore cloud-to-cloud backup items (second approver)', category: 'Backup & Recovery' },
      { name: 'execute_dr_plan', description: 'Run a DR rehearsal, failover or failback (second approver)', category: 'Backup & Recovery' },
      // Monitoring & Analytics
      { name: 'manage_delivery (create_routing/update_routing/delete_routing/set_default/create_escalation/update_escalation/delete_escalation)', description: 'Manage alert routing, default destinations, and escalation policies (requires approval)', category: 'Alerts & Notifications' },
      { name: 'manage_notification_channels (create/update/delete)', description: 'Create, repoint, or delete a notification channel (the approver sees the destination host)', category: 'Alerts & Notifications' },
      // Monitor definitions (#5289 Task 8): ordinary config-object CRUD
      // (create/update/delete/enable/disable/attach/detach) — supervised, same
      // class as the software/browser/peripheral policy tools.
      { name: 'manage_monitor_definitions', description: 'Create, update, delete, or attach/detach a monitor definition', category: 'Monitoring & Analytics' },
      // Integrations
      { name: 'test_webhook', description: 'Test webhook delivery — sends a real outbound POST; route requires MFA', category: 'Integrations' },
      { name: 'trigger_agent_upgrade', description: 'Queue agent upgrade', category: 'Integrations' },
      { name: 'trigger_agent_restart', description: 'Restart a wedged/silent agent via the watchdog', category: 'Integrations' },
      // Microsoft 365 identity writes (Operator Recipe Library M1) — Tier 3, four-eyes
      { name: 'm365_revoke_sessions', description: 'Revoke all Microsoft 365 sessions for a user', category: 'Integrations' },
      { name: 'm365_remove_license', description: 'Remove Microsoft 365 licenses from a user', category: 'Integrations' },
      { name: 'm365_assign_license', description: 'Assign Microsoft 365 licenses to a user', category: 'Integrations' },
      { name: 'm365_remove_from_group', description: 'Remove a user from a Microsoft 365 group', category: 'Integrations' },
      { name: 'm365_add_to_group', description: 'Add a user to a Microsoft 365 group', category: 'Integrations' },
      { name: 'm365_retire_intune_device', description: 'Retire an Intune device (removes company data; not a full wipe)', category: 'Integrations' },
      { name: 'm365_create_user', description: 'Create a Microsoft 365 user with a one-time temporary password', category: 'Integrations' },
      { name: 'm365_set_auto_reply', description: 'Set or clear a Microsoft 365 mailbox automatic reply', category: 'Integrations' },
      // Configuration Policies
      { name: 'manage_configuration_policy (create/update/delete)', description: 'Create, update, or delete config policies', category: 'Configuration Policies' },
      // Fleet Operations
      { name: 'manage_deployments (create/start/cancel)', description: 'Create, start, or cancel deployments', category: 'Fleet Operations' },
      { name: 'manage_patches (install/rollback)', description: 'Install or rollback patches', category: 'Fleet Operations' },
      { name: 'manage_groups (create/update/delete)', description: 'Create, update, or delete device groups', category: 'Fleet Operations' },
      { name: 'manage_automations (run)', description: 'Run an automation on demand', category: 'Fleet Operations' },
      // Ticketing (P2-4, #4191)
      { name: 'manage_tickets (move_org)', description: 'Move a ticket to a different organization', category: 'Ticketing' },
      { name: 'manage_tickets (edit_comment/delete_comment)', description: 'Edit or delete a ticket comment (customer-visible text, no restore)', category: 'Ticketing' },
      // Billing (full-control W02, #6756)
      { name: 'manage_quotes (send/decline/create_pay_link)', description: 'Send a quote to the customer, record a decline, or create a payment link', category: 'Billing' },
      { name: 'manage_billing_catalog (update_item/archive_item/set_price/remove_price/set_org_price/remove_org_price/set_bundle_components)', description: 'Change catalog items, prices, organization price overrides, and bundles (contract renewals bill live prices)', category: 'Billing' },
      // Full-control W14 (#6784): what every organization (or one) is billed, and the legal documents customers sign.
      { name: 'manage_billing_profiles (create/update/archive/set_rows/clone/create_work_type/update_work_type/set_org_profile/clear_org_profile)', description: 'Change rate cards and work types (every organization of the partner) or which card bills an organization', category: 'Billing' },
      { name: 'manage_billing_settings (update_partner/update_org)', description: 'Change invoice defaults, customer-facing invoice text, or an organization\'s tax, terms and billing contact', category: 'Billing' },
      { name: 'manage_contract_templates (create_version/publish/archive)', description: 'Add a draft version, publish it for signature, or archive an organization\'s agreement template (not offered to AI agents)', category: 'Billing' },
      { name: 'manage_contract_documents (link)', description: 'File a signed agreement under its contract; cannot be undone (not offered to AI agents)', category: 'Billing' },
      // Full-control W14 PR B (#6784): generate and push need a second approver; mapping changes overwrite the provider's record.
      { name: 'manage_contracts (generate_invoice)', description: 'Generate a contract\'s due invoice and, when the contract auto-issues, issue and email it; two people approve, and a changed total refuses (not offered to AI agents)', category: 'Billing' },
      { name: 'manage_accounting_sync (link_mapping/unlink_mapping/sync_mapping)', description: 'Link, unlink or re-sync a customer or item with QuickBooks or Xero; linking and syncing overwrite the provider\'s record (not offered to AI agents)', category: 'Billing' },
      { name: 'manage_accounting_sync (push/push_bulk)', description: 'Push invoices (up to 10) into QuickBooks or Xero; two people approve, and they stay in the books (not offered to AI agents)', category: 'Billing' },
      { name: 'manage_ticket_routing_rules (create/update/reorder/delete)', description: 'Create, change, reorder or delete ticket routing rules', category: 'Ticketing' },
      // Full-control W06 (#6776): PSA configuration. Partner-wide configuration, customer-visible forms,
      // terminal inbox actions and the permanent attachment delete need approval; the four hard deletes
      // (email domain mapping, checklist template, ticket form, canned reply) need a second approver.
      { name: 'manage_ticket_config (update_org_settings/create_category/update_category/delete_category/reorder_categories/create_status/update_status/reorder_statuses/set_priorities/create_domain/update_domain/delete_domain)', description: 'Change ticket categories, statuses, priorities, SLA overrides or customer email domain routing (removing a domain mapping needs a second approver)', category: 'Ticketing' },
      { name: 'manage_ticket_checklist_templates (update/delete/add_item/update_item/remove_item/reorder_items)', description: 'Edit or delete a checklist template and its steps (deleting needs a second approver)', category: 'Ticketing' },
      { name: 'manage_ticket_inbox (convert/dismiss)', description: 'Turn an inbound email into a ticket in an organization, or dismiss it (neither can be undone)', category: 'Ticketing' },
      { name: 'manage_ticket_attachments (delete)', description: 'Permanently delete a ticket attachment', category: 'Ticketing' },
      { name: 'manage_ticket_forms (create/update/delete)', description: 'Create, change or delete a customer-visible ticket intake form (deleting needs a second approver)', category: 'Ticketing' },
      { name: 'manage_ticket_response_templates (create/update/delete)', description: 'Create, change or delete a partner-wide canned reply (deleting needs a second approver)', category: 'Ticketing' },
      // Full-control W07 (#6777): promoting an anomaly raises a real alert, which notifies people.
      { name: 'manage_device_anomalies (promote)', description: 'Promote a detected anomaly to a real alert (notifies the alert channels)', category: 'Alerts & Notifications' },
      // Full-control W08 (#6778): publishing and applying reach partner- or organization-wide monitoring.
      { name: 'manage_topology_templates (publish_version/revoke_template)', description: 'Publish a template version so sites can apply it, or revoke a template for good (disables the checks that use it)', category: 'Network & DNS' },
      { name: 'apply_topology_template (apply)', description: 'Apply a previewed template to sites, replacing their monitoring configuration', category: 'Network & DNS' },
      // Full-control W11 (#6781): access-review completion, the apply-request decision and recovery-key reveal stay human-only
      // (not in any tool). Partner-wide security-policy create and partner-wide compliance-policy deactivate need a second approver.
      { name: 'manage_access_reviews (create)', description: 'Start an access review of every member (cannot be deleted; needs your MFA session)', category: 'Security & Compliance' },
      { name: 'manage_audit_baselines (create)', description: 'Create an audit-policy baseline (an active one starts daily collection on that OS)', category: 'Security & Compliance' },
      { name: 'manage_security_policies (create/update)', description: 'Create or change an antivirus/EDR policy template (partner-wide create needs a second approver)', category: 'Security & Compliance' },
      { name: 'manage_compliance_policies (deactivate)', description: 'Permanently turn off a compliance policy and close its alerts (partner-wide needs a second approver; needs your MFA session)', category: 'Security & Compliance' },
      { name: 'manage_recovery_keys (rotate/collect)', description: 'Rotate a Windows BitLocker recovery key, or re-collect keys from a device', category: 'Security & Compliance' },
      { name: 'manage_pam_rules (create_rule/update_rule/delete_rule/set_config/create_signer_group/update_signer_group/delete_signer_group)', description: 'Change PAM elevation rules, the default verdict or signer groups (never auto-approve; needs your MFA session)', category: 'Security & Compliance' },
      // Full-control W12 (#6782): anything that changes what is installed on a customer machine, now or by an armed
      // auto-install policy. Uninstall and Homebrew install are never offered to AI agents.
      { name: 'manage_software_catalog (archive/add_version/update_version/promote_version/add_install_method/update_install_method/delete_install_method)', description: 'Change which installer a package uses (auto-install policies and automations pick it up), or archive a package', category: 'Fleet Operations' },
      { name: 'manage_software_deployments (create/retry)', description: 'Install a catalog package on up to 100 named devices, or retry failed installs', category: 'Fleet Operations' },
      { name: 'manage_device_software (update/uninstall)', description: 'Update or uninstall an application on one device (uninstall is not offered to AI agents)', category: 'Fleet Operations' },
      { name: 'bootstrap_homebrew', description: 'Install Homebrew on one Mac (not offered to AI agents)', category: 'Fleet Operations' },
      { name: 'manage_software_inventory (approve/deny/clear)', description: 'Add software to, or remove it from, the organization\'s default allowlist or blocklist', category: 'Fleet Operations' },
      { name: 'manage_custom_fields (delete_definition/set_values)', description: 'Delete a custom field (removes every device\'s value) or set values on a device', category: 'Other' },
      // Full-control W13 (#6783): function changes which devices dynamic groups select; a manual-asset delete is
      // permanent; a warranty refresh sends the serial number to the manufacturer.
      { name: 'manage_device_function (set)', description: "Set or clear a device's function, which dynamic groups can target (not offered to AI agents)", category: 'Devices & Hardware' },
      { name: 'manage_manual_assets (delete)', description: 'Permanently delete a hand-entered inventory row (retire it to keep the record)', category: 'Devices & Hardware' },
      { name: 'manage_device_warranty (refresh)', description: "Re-check one device's warranty with its manufacturer (sends the serial number)", category: 'Devices & Hardware' },
      // Full-control W13 PR B (#6783).
      { name: 'browse_device_event_log (query/get_event)', description: 'Read event text from a device\'s live event logs (Security and Application logs can hold credentials)', category: 'Services & Processes' },
      { name: 'manage_tenant_variables (create/update/delete)', description: 'Change the values scripts receive on every device (never secrets or partner-wide variables; not offered to AI agents)', category: 'Scripts & Automation' },
      { name: 'manage_support_sessions (end)', description: 'End a Quick Support session and remove its temporary client', category: 'Remote Access & Control' },
      // Endpoint messaging (#8742 W02): customer-visible text, always approved.
      { name: 'send_endpoint_message (send)', description: 'Send a message to the person at one or more devices', category: 'Ticketing' },
      // AI Governance (P2-5, #4192)
      { name: 'manage_ai_agents (authorize_supervised_key)', description: 'Grant an AI agent a pre-authorized action key', category: 'AI Governance' },
      { name: 'operator_plan', description: 'Approve an AI task plan: one four-eyes decision over an ordered set of provider effects', category: 'AI Governance' },
      // Wisp specialists (W07a #9913): every other kind asks first; an assessment's
      // request for one becomes the wisp_specialist_request approval card.
      { name: 'launch_specialist (operator_recipe/patch_plan/remediation_research/bulk_ticket_reply)', description: 'Ask Wisp to hand an AI task, patch plan, remediation research or one reply to a set of tickets to a specialist', category: 'AI Governance' },
      { name: 'wisp_specialist_request', description: 'Approve a specialist an assessment asked Wisp to run (raised only by the Wisp coordinator)', category: 'AI Governance' },
      // Wisp memory (W03 #9909): human-only — a person confirms or retracts on the memory page; never agent-callable.
      { name: 'confirm_memory', description: 'A person confirms a Wisp memory block', category: 'AI Governance' },
      { name: 'retract_memory', description: 'A person retracts a Wisp memory block', category: 'AI Governance' },
    ],
  },
  {
    tier: 4,
    label: 'aiRisk.tiers.tier4.label',
    description: 'Operations that are never allowed, such as cross-organization data access or unknown tools.',
    iconName: 'shield-off',
    borderColor: 'border-l-red-500',
    badgeBg: 'bg-red-500/15',
    badgeText: 'text-red-700',
    tools: [
      { name: 'Cross-org access', description: 'Any operation targeting resources outside the current organization', category: 'Other' },
      { name: 'Unknown tools', description: 'Any unregistered tool invocation is blocked', category: 'Other' },
    ],
  },
];

// ── Rate limit configuration ────────────────────────────────────────────────

/**
 * Display metadata for the AI Risk → Rate Limits tab. The NUMBERS (limit,
 * window) are not here: since #6476 the tab reads the effective limits from
 * `GET /ai/tool-rate-limits`, which applies the org's toolRateLimitMultiplier
 * to TOOL_RATE_LIMITS (apps/api/src/services/aiToolRateLimits.ts). A tool the
 * API returns without a row here still renders, under "Other" with no tier.
 */
export interface RateLimitConfig {
  toolName: string;
  tier: 1 | 2 | 3;
  permission: string;
  category: ToolCategory;
}

// `tier` here is the tool's BASE (registry) tier; per-action escalations
// (e.g. configure_vault create/update -> Tier 3) are listed in TIER_DEFINITIONS.
export const RATE_LIMIT_CONFIGS: RateLimitConfig[] = [
  // Remote Access & Control
  { toolName: 'execute_command', tier: 3, permission: 'devices.execute', category: 'Remote Access & Control' },
  { toolName: 'run_script', tier: 3, permission: 'scripts.execute', category: 'Remote Access & Control' },
  { toolName: 'computer_control', tier: 3, permission: 'devices.execute + remote.access', category: 'Remote Access & Control' },
  { toolName: 'take_screenshot', tier: 3, permission: 'devices.execute', category: 'Remote Access & Control' },
  { toolName: 'analyze_screen', tier: 3, permission: 'devices.execute', category: 'Remote Access & Control' },
  { toolName: 'create_remote_session', tier: 3, permission: 'devices.execute + remote.access', category: 'Remote Access & Control' },
  { toolName: 'set_device_context', tier: 2, permission: 'devices.write', category: 'Devices & Hardware' },
  { toolName: 'request_diagnostic_access', tier: 2, permission: 'devices.execute', category: 'Files, Disk & Registry' },
  { toolName: 'diagnostic_list_directory', tier: 2, permission: 'devices.execute', category: 'Files, Disk & Registry' },
  { toolName: 'diagnostic_read_file', tier: 2, permission: 'devices.execute', category: 'Files, Disk & Registry' },
  { toolName: 'resolve_device_context', tier: 2, permission: 'devices.write', category: 'Devices & Hardware' },
  // Services & Processes
  { toolName: 'manage_services', tier: 3, permission: 'devices.execute', category: 'Services & Processes' },
  { toolName: 'manage_processes', tier: 1, permission: 'devices.execute', category: 'Services & Processes' },
  { toolName: 'manage_startup_items', tier: 3, permission: 'devices.execute', category: 'Services & Processes' },
  { toolName: 'manage_scheduled_tasks', tier: 1, permission: 'devices.execute', category: 'Services & Processes' },
  // Security & Compliance
  { toolName: 'security_scan', tier: 3, permission: 'devices.execute', category: 'Security & Compliance' },
  { toolName: 'ioc_hunt', tier: 1, permission: 'devices.read', category: 'Security & Compliance' },
  // Files, Disk & Registry
  { toolName: 'file_operations', tier: 3, permission: 'devices.execute', category: 'Files, Disk & Registry' },
  { toolName: 'analyze_disk_usage', tier: 1, permission: 'devices.read', category: 'Files, Disk & Registry' },
  { toolName: 'disk_cleanup', tier: 3, permission: 'devices.execute', category: 'Files, Disk & Registry' },
  { toolName: 'system_cleanup', tier: 3, permission: 'devices.execute', category: 'Files, Disk & Registry' },
  { toolName: 'registry_operations', tier: 2, permission: 'devices.execute', category: 'Files, Disk & Registry' },
  // Network & DNS
  { toolName: 'network_discovery', tier: 3, permission: 'devices.execute', category: 'Network & DNS' },
  { toolName: 'diagnose_connectivity', tier: 3, permission: 'devices.execute', category: 'Network & DNS' },
  // Logs & Audit
  { toolName: 'search_logs', tier: 1, permission: 'devices.read', category: 'Logs & Audit' },
  { toolName: 'get_log_trends', tier: 1, permission: 'devices.read', category: 'Logs & Audit' },
  { toolName: 'detect_log_correlations', tier: 2, permission: 'devices.read', category: 'Logs & Audit' },
  { toolName: 'set_agent_log_level', tier: 2, permission: 'devices.execute', category: 'Logs & Audit' },
  { toolName: 'capture_agent_pprof', tier: 2, permission: 'devices.execute', category: 'Logs & Audit' },
  // Configuration Policies
  { toolName: 'get_configuration_policy', tier: 1, permission: 'devices.read', category: 'Configuration Policies' },
  { toolName: 'manage_configuration_policy', tier: 1, permission: 'devices.write', category: 'Configuration Policies' },
  { toolName: 'configuration_policy_compliance', tier: 1, permission: 'devices.read', category: 'Configuration Policies' },
  { toolName: 'apply_configuration_policy', tier: 2, permission: 'devices.write', category: 'Configuration Policies' },
  { toolName: 'remove_configuration_policy_assignment', tier: 2, permission: 'devices.write', category: 'Configuration Policies' },
  // Scripts & Automation
  { toolName: 'execute_playbook', tier: 3, permission: 'devices.execute', category: 'Scripts & Automation' },
  // Other
  { toolName: 'manage_tags', tier: 2, permission: 'devices.write', category: 'Other' },
  // Backup & Recovery
  { toolName: 'trigger_backup', tier: 3, permission: 'devices.execute', category: 'Backup & Recovery' },
  { toolName: 'restore_snapshot', tier: 3, permission: 'devices.execute', category: 'Backup & Recovery' },
  // Monitoring & Analytics
  { toolName: 'manage_monitors', tier: 1, permission: 'devices.read', category: 'Monitoring & Analytics' },
  // Integrations
  { toolName: 'test_webhook', tier: 3, permission: 'organizations.write', category: 'Integrations' },
  { toolName: 'trigger_agent_upgrade', tier: 3, permission: 'devices.execute', category: 'Integrations' },
  { toolName: 'trigger_agent_restart', tier: 3, permission: 'devices.recover_agent', category: 'Integrations' },
  { toolName: 'manage_notification_channels', tier: 1, permission: 'alerts.read', category: 'Alerts & Notifications' },
  { toolName: 'manage_saved_filters', tier: 1, permission: 'devices.read', category: 'Other' },
  // Fleet Operations
  { toolName: 'manage_deployments', tier: 1, permission: 'devices.write', category: 'Fleet Operations' },
  { toolName: 'manage_patches', tier: 1, permission: 'devices.read', category: 'Fleet Operations' },
  { toolName: 'manage_groups', tier: 1, permission: 'devices.write', category: 'Fleet Operations' },
  { toolName: 'manage_maintenance_windows', tier: 1, permission: 'devices.write', category: 'Fleet Operations' },
  { toolName: 'manage_automations', tier: 1, permission: 'automations.write', category: 'Fleet Operations' },
  { toolName: 'manage_alert_rules', tier: 1, permission: 'alerts.write', category: 'Alerts & Notifications' },
  { toolName: 'generate_report', tier: 1, permission: 'reports.read', category: 'Fleet Operations' },
  // The 33 entries below were missing outright (sweep E3, #6932): every
  // rate-limited tool the API returns from GET /ai/tool-rate-limits that has
  // no row here renders under "Other" with tier/permission "—", even though
  // the tool IS registered. tier/permission sourced from the tool's own
  // `registerTool({ tier })` call in services/aiTools*.ts and its entry in
  // services/aiGuardrails.ts's TOOL_PERMISSIONS — completeness (every
  // TOOL_RATE_LIMITS key present) and tier correctness are both enforced by
  // aiGuardrailsTierConfig.parity.test.ts.
  { toolName: 'cancel_script_execution', tier: 3, permission: 'scripts.execute', category: 'Remote Access & Control' },
  // Security & Compliance
  { toolName: 'apply_cis_remediation', tier: 3, permission: 'devices.execute', category: 'Security & Compliance' },
  { toolName: 'get_cis_compliance', tier: 1, permission: 'devices.read', category: 'Security & Compliance' },
  { toolName: 'get_cis_device_report', tier: 1, permission: 'devices.read', category: 'Security & Compliance' },
  { toolName: 'get_trust_page_status', tier: 1, permission: 'organizations.read', category: 'Security & Compliance' },
  { toolName: 'assign_security_training', tier: 2, permission: 'users.write', category: 'Security & Compliance' },
  // Tier 2 without a screenshot; a screenshot (or unreadable evidenceTypes) needs approval (tier 3 supervised)
  { toolName: 'collect_evidence', tier: 3, permission: 'devices.execute', category: 'Security & Compliance' },
  { toolName: 'execute_containment', tier: 3, permission: 'devices.execute + alerts.write', category: 'Security & Compliance' },
  { toolName: 's1_isolate_device', tier: 3, permission: 'devices.execute', category: 'Security & Compliance' },
  { toolName: 's1_threat_action', tier: 3, permission: 'devices.execute', category: 'Security & Compliance' },
  { toolName: 'sync_huntress_data', tier: 2, permission: 'organizations.write', category: 'Security & Compliance' },
  { toolName: 'edr_endpoint_action', tier: 3, permission: 'devices.execute', category: 'Security & Compliance' },
  { toolName: 'sync_edr_data', tier: 2, permission: 'organizations.write', category: 'Security & Compliance' },
  { toolName: 'remediate_software_violation', tier: 3, permission: 'devices.execute', category: 'Security & Compliance' },
  // Full-control W04 (#6758, quorum QW11): device-touching tools that gained a rate limit.
  { toolName: 'manage_browser_policy', tier: 3, permission: 'devices.write / devices.execute (apply)', category: 'Security & Compliance' },
  { toolName: 'manage_peripheral_policy', tier: 3, permission: 'organizations.write', category: 'Devices & Hardware' },
  { toolName: 'remediate_sensitive_data', tier: 3, permission: 'devices.execute', category: 'Security & Compliance' },
  { toolName: 'configure_network_baseline', tier: 3, permission: 'devices.write', category: 'Network & DNS' },
  // Backup & Recovery
  { toolName: 'configure_backup_sla', tier: 2, permission: 'organizations.write', category: 'Backup & Recovery' },
  { toolName: 'configure_vault', tier: 2, permission: 'organizations.write', category: 'Backup & Recovery' },
  { toolName: 'trigger_vault_sync', tier: 3, permission: 'devices.execute', category: 'Backup & Recovery' },
  { toolName: 'execute_dr_plan', tier: 3, permission: 'devices.execute', category: 'Backup & Recovery' },
  { toolName: 'manage_dr_plan', tier: 2, permission: 'devices.write', category: 'Backup & Recovery' },
  { toolName: 'instant_boot_vm', tier: 3, permission: 'devices.execute', category: 'Backup & Recovery' },
  { toolName: 'restore_as_vm', tier: 3, permission: 'devices.execute', category: 'Backup & Recovery' },
  { toolName: 'manage_hyperv_vm', tier: 3, permission: 'devices.execute', category: 'Backup & Recovery' },
  { toolName: 'trigger_hyperv_backup', tier: 3, permission: 'devices.execute', category: 'Backup & Recovery' },
  { toolName: 'restore_hyperv_vm', tier: 3, permission: 'devices.execute', category: 'Backup & Recovery' },
  { toolName: 'manage_hyperv_checkpoints', tier: 2, permission: 'devices.execute', category: 'Backup & Recovery' },
  { toolName: 'trigger_mssql_backup', tier: 3, permission: 'devices.execute', category: 'Backup & Recovery' },
  { toolName: 'restore_mssql_database', tier: 3, permission: 'devices.execute', category: 'Backup & Recovery' },
  { toolName: 'verify_mssql_backup', tier: 3, permission: 'devices.execute', category: 'Backup & Recovery' },
  // Monitoring & Analytics
  { toolName: 'query_monitors', tier: 1, permission: 'devices.read', category: 'Monitoring & Analytics' },
  { toolName: 'manage_service_monitors', tier: 1, permission: 'devices.read', category: 'Monitoring & Analytics' },
  { toolName: 'get_service_monitoring_status', tier: 1, permission: 'devices.read', category: 'Monitoring & Analytics' },
  // Integrations
  { toolName: 'trigger_c2c_sync', tier: 3, permission: 'organizations.write', category: 'Integrations' },
  { toolName: 'restore_c2c_items', tier: 3, permission: 'organizations.write', category: 'Integrations' },
  // Alerts & Notifications
  { toolName: 'manage_delivery', tier: 1, permission: 'alerts.read', category: 'Alerts & Notifications' },
  // AI Governance
  { toolName: 'manage_ai_agents', tier: 3, permission: 'ai_agents.write', category: 'AI Governance' },
  { toolName: 'operator_plan', tier: 3, permission: 'organizations.write', category: 'AI Governance' },
  { toolName: 'remember', tier: 2, permission: 'ai_sessions.use', category: 'AI Governance' },
  { toolName: 'raise_concern', tier: 2, permission: 'ai_sessions.use', category: 'AI Governance' },
  { toolName: 'create_watch', tier: 2, permission: 'ai_sessions.use', category: 'AI Governance' },
  { toolName: 'snooze_concern', tier: 2, permission: 'ai_sessions.use', category: 'AI Governance' },
  { toolName: 'resolve_concern', tier: 2, permission: 'ai_sessions.use', category: 'AI Governance' },
  // Wisp thread links (W08 #9914)
  { toolName: 'link_entity', tier: 2, permission: 'ai_sessions.use', category: 'AI Governance' },
  // Wisp specialists (W07a #9913): sweeps/analysis run on the call; other kinds ask first.
  { toolName: 'launch_specialist', tier: 2, permission: 'ai_sessions.use', category: 'AI Governance' },
  // Other
  { toolName: 'export_dataset', tier: 1, permission: 'devices.read', category: 'Other' },
  // Endpoint messaging (#8742 W02)
  { toolName: 'send_endpoint_message', tier: 3, permission: 'endpoint_messages.send', category: 'Ticketing' },
  // Full-control W06 (#6776): `tier` is the registry tier (1); the per-action classes are in TIER_DEFINITIONS.
  { toolName: 'manage_ticket_config', tier: 1, permission: 'tickets.read / tickets.write / organizations.write (org settings)', category: 'Ticketing' },
  { toolName: 'manage_ticket_checklist_templates', tier: 1, permission: 'tickets.read / tickets.write', category: 'Ticketing' },
  { toolName: 'manage_ticket_inbox', tier: 1, permission: 'tickets.write', category: 'Ticketing' },
  { toolName: 'manage_ticket_attachments', tier: 1, permission: 'tickets.read / tickets.write', category: 'Ticketing' },
  { toolName: 'manage_ticket_forms', tier: 1, permission: 'tickets.read / tickets.write', category: 'Ticketing' },
  { toolName: 'manage_ticket_response_templates', tier: 1, permission: 'tickets.read / tickets.write', category: 'Ticketing' },
  { toolName: 'manage_time_suggestions', tier: 1, permission: 'time_entries.read / time_entries.write', category: 'Ticketing' },
  // Full-control W07 (#6777): `tier` is the registry tier; the per-action classes are in TIER_DEFINITIONS.
  { toolName: 'get_alert_correlations', tier: 1, permission: 'alerts.read', category: 'Alerts & Notifications' },
  { toolName: 'manage_alert_correlations', tier: 2, permission: 'alerts.read / alerts.acknowledge / alerts.write', category: 'Alerts & Notifications' },
  { toolName: 'manage_device_anomalies', tier: 1, permission: 'devices.read / alerts.write', category: 'Alerts & Notifications' },
  { toolName: 'reliability_feedback', tier: 2, permission: 'devices.read', category: 'Devices & Hardware' },
  // Full-control W08 (#6778): `tier` is the registry tier; the per-action classes are in TIER_DEFINITIONS.
  { toolName: 'get_topology_graph', tier: 1, permission: 'topology.read', category: 'Network & DNS' },
  { toolName: 'run_topology_diagnostic', tier: 1, permission: 'topology.read / topology.execute', category: 'Network & DNS' },
  { toolName: 'manage_topology_manual', tier: 2, permission: 'topology.write', category: 'Network & DNS' },
  { toolName: 'manage_topology_monitoring', tier: 1, permission: 'topology.read / topology.write', category: 'Network & DNS' },
  { toolName: 'manage_topology_templates', tier: 1, permission: 'topology.read / topology.write', category: 'Network & DNS' },
  { toolName: 'apply_topology_template', tier: 1, permission: 'topology.read / topology.write', category: 'Network & DNS' },
  // Full-control W09 (#6779): `tier` is the registry tier; the per-action classes are in TIER_DEFINITIONS.
  { toolName: 'manage_snmp_templates', tier: 1, permission: 'devices.read / devices.write', category: 'Network & DNS' },
  { toolName: 'get_snmp_metrics', tier: 1, permission: 'devices.read', category: 'Network & DNS' },
  { toolName: 'probe_network_asset', tier: 2, permission: 'devices.write', category: 'Network & DNS' },
  { toolName: 'manage_known_guests', tier: 1, permission: 'organizations.read / organizations.write', category: 'Network & DNS' },
  { toolName: 'get_unifi_status', tier: 1, permission: 'billing.manage', category: 'Network & DNS' },
  { toolName: 'trigger_unifi_sync', tier: 2, permission: 'billing.manage', category: 'Network & DNS' },
  // Full-control W10 (#6780): all tier 1.
  { toolName: 'get_device_ai_activity', tier: 1, permission: 'devices.read', category: 'AI Governance' },
  { toolName: 'list_operator_tasks', tier: 1, permission: 'ai_agents.read', category: 'AI Governance' },
  { toolName: 'get_operator_task', tier: 1, permission: 'ai_agents.read', category: 'AI Governance' },
  { toolName: 'list_ai_agent_schedules', tier: 1, permission: 'ai_agents.read', category: 'AI Governance' },
  { toolName: 'list_fleet_designs', tier: 1, permission: 'ai_agents.read', category: 'AI Governance' },
  { toolName: 'get_fleet_design', tier: 1, permission: 'ai_agents.read', category: 'AI Governance' },
  // Full-control W11 (#6781): `tier` is the registry tier; the per-action classes are in TIER_DEFINITIONS.
  { toolName: 'get_security_compliance', tier: 1, permission: 'devices.read', category: 'Security & Compliance' },
  { toolName: 'manage_security_recommendations', tier: 1, permission: 'devices.read / devices.write', category: 'Security & Compliance' },
  { toolName: 'manage_access_reviews', tier: 1, permission: 'users.read / users.write', category: 'Security & Compliance' },
  { toolName: 'manage_audit_baselines', tier: 1, permission: 'audit.read / organizations.write / devices.write', category: 'Security & Compliance' },
  { toolName: 'manage_compliance_policies', tier: 3, permission: 'devices.write', category: 'Security & Compliance' },
  { toolName: 'manage_security_policies', tier: 1, permission: 'devices.read / devices.write', category: 'Security & Compliance' },
  { toolName: 'manage_recovery_keys', tier: 1, permission: 'devices.read / devices.execute', category: 'Security & Compliance' },
  { toolName: 'manage_pam_rules', tier: 1, permission: 'devices.read / pam.manage_policy', category: 'Security & Compliance' },
  // Full-control W12 (#6782): `tier` is the registry tier; the per-action classes are in TIER_DEFINITIONS.
  { toolName: 'manage_software_catalog', tier: 1, permission: 'devices.read / devices.write', category: 'Fleet Operations' },
  { toolName: 'search_packages', tier: 1, permission: 'devices.read', category: 'Fleet Operations' },
  { toolName: 'manage_software_deployments', tier: 1, permission: 'devices.read / devices.execute', category: 'Fleet Operations' },
  { toolName: 'get_device_software', tier: 1, permission: 'devices.read', category: 'Fleet Operations' },
  { toolName: 'manage_device_software', tier: 3, permission: 'devices.execute', category: 'Fleet Operations' },
  { toolName: 'manage_software_inventory', tier: 1, permission: 'devices.read / devices.write', category: 'Fleet Operations' },
  { toolName: 'bootstrap_homebrew', tier: 3, permission: 'devices.execute', category: 'Fleet Operations' },
  { toolName: 'manage_fleet_findings', tier: 2, permission: 'devices.write', category: 'Devices & Hardware' },
  { toolName: 'manage_custom_fields', tier: 2, permission: 'devices.write', category: 'Other' },
  // Full-control W13 (#6783): `tier` is the registry tier; the per-action classes are in TIER_DEFINITIONS.
  { toolName: 'get_device_events', tier: 1, permission: 'devices.read', category: 'Devices & Hardware' },
  { toolName: 'get_device_health', tier: 1, permission: 'devices.read', category: 'Devices & Hardware' },
  { toolName: 'get_process_samples', tier: 1, permission: 'devices.read', category: 'Devices & Hardware' },
  { toolName: 'get_management_posture', tier: 1, permission: 'devices.read', category: 'Devices & Hardware' },
  { toolName: 'manage_device_function', tier: 1, permission: 'devices.read / devices.write', category: 'Devices & Hardware' },
  { toolName: 'manage_device_links', tier: 1, permission: 'devices.read / devices.write / devices.delete', category: 'Devices & Hardware' },
  { toolName: 'manage_manual_assets', tier: 1, permission: 'devices.read / devices.write / devices.delete', category: 'Devices & Hardware' },
  { toolName: 'manage_device_warranty', tier: 1, permission: 'devices.read / devices.write', category: 'Devices & Hardware' },
  { toolName: 'browse_device_event_log', tier: 1, permission: 'devices.execute', category: 'Services & Processes' },
  { toolName: 'manage_tenant_variables', tier: 1, permission: 'variables.read / variables.manage', category: 'Scripts & Automation' },
  { toolName: 'manage_support_sessions', tier: 1, permission: 'remote.access', category: 'Remote Access & Control' },
  { toolName: 'manage_billing_profiles', tier: 1, permission: 'billing_profiles.read / billing_profiles.write', category: 'Billing' },
  { toolName: 'manage_billing_settings', tier: 1, permission: 'organizations.read / invoices.read / invoices.write', category: 'Billing' },
  { toolName: 'manage_contract_templates', tier: 1, permission: 'agreements.read / agreements.write', category: 'Billing' },
  { toolName: 'manage_contract_documents', tier: 1, permission: 'agreements.read / agreements.write', category: 'Billing' },
  { toolName: 'manage_contracts', tier: 2, permission: 'contracts.read / contracts.write / contracts.manage', category: 'Billing' },
  { toolName: 'manage_accounting_sync', tier: 1, permission: 'accounting.read / accounting.manage (+ organizations.write + catalog.write, or invoices.write)', category: 'Billing' },
];

// ── RBAC mappings (flat reference, not rendered in grouped UI) ───────────────

export const RBAC_MAPPINGS: Record<string, string | Record<string, string>> = {
  // Device & metrics
  query_devices: 'devices.read',
  get_device_details: 'devices.read',
  get_device_hardware_health: 'devices.read',
  get_device_time_status: 'devices.read',
  list_device_restore_point_attempts: 'devices.read',
  query_device_workloads: 'devices.read',
  list_time_sync_issues: 'devices.read',
  analyze_metrics: 'devices.read',
  get_active_users: 'devices.read',
  get_user_experience_metrics: 'devices.read',
  get_fleet_device_stats: 'devices.read',
  get_fleet_health: 'devices.read',
  get_fleet_findings: 'devices.read',
  // Full-control W07 (#6777)
  get_alert_correlations: 'alerts.read',
  manage_alert_correlations: {
    acknowledge_group: 'alerts.acknowledge',
    resolve_group: 'alerts.write',
    acknowledge_related: 'alerts.acknowledge',
    feedback: 'alerts.read',
    rca_feedback: 'alerts.read',
  },
  manage_device_anomalies: {
    list: 'devices.read',
    dismiss: 'alerts.write',
    resolve: 'alerts.write',
    promote: 'alerts.write',
  },
  reliability_feedback: 'devices.read',
  // Full-control W08 (#6778): every topology action also needs the devices grant of its capability.
  get_topology_graph: 'topology.read',
  run_topology_diagnostic: { collectors: 'topology.read', get: 'topology.read', start: 'topology.execute', cancel: 'topology.execute' },
  manage_topology_manual: 'topology.write',
  manage_topology_monitoring: {
    list_policies: 'topology.read', list_targets: 'topology.read', get_settings: 'topology.read',
    upsert_policy: 'topology.write', delete_policy: 'topology.write', upsert_target: 'topology.write', delete_target: 'topology.write', patch_settings: 'topology.write',
  },
  manage_topology_templates: {
    list_templates: 'topology.read', list_versions: 'topology.read', site_options: 'topology.read',
    create_template: 'topology.write', update_template: 'topology.write', revoke_template: 'topology.write', create_version: 'topology.write', publish_version: 'topology.write',
  },
  apply_topology_template: { preview: 'topology.write', apply: 'topology.write', status: 'topology.read' },
  // Full-control W09 (#6779): the permission each action needs (a write also needs your MFA session).
  manage_snmp_templates: {
    list: 'devices.read', get: 'devices.read', browse_oids: 'devices.read', validate_oids: 'devices.read',
    create: 'devices.write', update: 'devices.write', delete: 'devices.write',
  },
  get_snmp_metrics: 'devices.read',
  probe_network_asset: 'devices.write',
  manage_known_guests: { list: 'organizations.read', add: 'organizations.write', delete: 'organizations.write' },
  get_unifi_status: 'billing.manage',
  trigger_unifi_sync: 'billing.manage',
  // Full-control W10 (#6780).
  get_device_ai_activity: 'devices.read',
  list_operator_tasks: 'ai_agents.read',
  get_operator_task: 'ai_agents.read',
  list_ai_agent_schedules: 'ai_agents.read',
  list_fleet_designs: 'ai_agents.read',
  get_fleet_design: 'ai_agents.read',
  // Full-control W11 (#6781): the permission each action needs (access-review, compliance and PAM writes also need your MFA session).
  get_security_compliance: 'devices.read',
  manage_security_recommendations: { list: 'devices.read', complete: 'devices.write', dismiss: 'devices.write' },
  manage_access_reviews: { list: 'users.read', get: 'users.read', create: 'users.write', decide_item: 'users.write' },
  manage_audit_baselines: {
    list: 'audit.read', compliance: 'audit.read', device_results: 'audit.read', create: 'organizations.write', request_apply: 'devices.write',
  },
  manage_compliance_policies: 'devices.write',
  manage_security_policies: { list: 'devices.read', create: 'devices.write', update: 'devices.write' },
  manage_recovery_keys: { list: 'devices.read', rotate: 'devices.execute', collect: 'devices.execute' },
  manage_pam_rules: {
    list_rules: 'devices.read', get_config: 'devices.read', list_signer_groups: 'devices.read',
    create_rule: 'pam.manage_policy', update_rule: 'pam.manage_policy', delete_rule: 'pam.manage_policy', set_config: 'pam.manage_policy',
    create_signer_group: 'pam.manage_policy', update_signer_group: 'pam.manage_policy', delete_signer_group: 'pam.manage_policy',
  },
  // Full-control W12 (#6782): every write also needs your MFA session.
  manage_software_catalog: {
    list: 'devices.read', get: 'devices.read', create: 'devices.write', update: 'devices.write', archive: 'devices.write',
    add_version: 'devices.write', update_version: 'devices.write', promote_version: 'devices.write',
    add_install_method: 'devices.write', update_install_method: 'devices.write', delete_install_method: 'devices.write',
    import_package: 'devices.write',
  },
  search_packages: 'devices.read',
  manage_software_deployments: {
    list: 'devices.read', get: 'devices.read', summary: 'devices.read', results: 'devices.read',
    create: 'devices.execute', cancel: 'devices.execute', retry: 'devices.execute',
  },
  get_device_software: 'devices.read',
  manage_device_software: 'devices.execute',
  bootstrap_homebrew: 'devices.execute',
  manage_software_inventory: {
    list: 'devices.read', names: 'devices.read', devices: 'devices.read',
    approve: 'devices.write', deny: 'devices.write', clear: 'devices.write',
  },
  manage_fleet_findings: 'devices.write',
  manage_custom_fields: 'devices.write',
  // Full-control W13 (#6783): every write also needs your MFA session.
  get_device_events: 'devices.read',
  get_device_health: 'devices.read',
  get_process_samples: 'devices.read',
  get_management_posture: 'devices.read',
  manage_device_function: { get: 'devices.read', set: 'devices.write' },
  manage_device_links: {
    list: 'devices.read', get: 'devices.read', for_device: 'devices.read',
    create: 'devices.write', update: 'devices.write', dissolve: 'devices.delete',
  },
  manage_manual_assets: {
    list: 'devices.read', create: 'devices.write', update: 'devices.write', delete: 'devices.delete',
    link: 'devices.write', unlink: 'devices.write',
  },
  manage_device_warranty: { get: 'devices.read', expiring: 'devices.read', refresh: 'devices.write' },
  browse_device_event_log: 'devices.execute',
  manage_tenant_variables: { list: 'variables.read', create: 'variables.manage', update: 'variables.manage', delete: 'variables.manage' },
  manage_support_sessions: 'remote.access',
  manage_billing_profiles: {
    list: 'billing_profiles.read', get: 'billing_profiles.read', list_work_types: 'billing_profiles.read', get_org_profile: 'billing_profiles.read',
    create: 'billing_profiles.write', update: 'billing_profiles.write', archive: 'billing_profiles.write', set_rows: 'billing_profiles.write',
    clone: 'billing_profiles.write', create_work_type: 'billing_profiles.write', update_work_type: 'billing_profiles.write',
    set_org_profile: 'billing_profiles.write', clear_org_profile: 'billing_profiles.write',
  },
  manage_billing_settings: {
    get_partner: 'organizations.read', get_org: 'organizations.read', currency_impact: 'invoices.write',
    reporting_totals: 'invoices.read', update_partner: 'invoices.write', update_org: 'invoices.write',
  },
  manage_contract_templates: {
    list: 'agreements.read', get: 'agreements.read', get_version: 'agreements.read', usage: 'agreements.read',
    create: 'agreements.write', update: 'agreements.write', create_version: 'agreements.write', publish: 'agreements.write', archive: 'agreements.write',
  },
  manage_contract_documents: { list: 'agreements.read', link: 'agreements.write' },
  get_device_billing: 'devices.read + contracts.read',
  manage_accounting_sync: {
    status: 'accounting.read', owed_operations: 'accounting.read', customers: 'accounting.read', mappings: 'accounting.read',
    income_accounts: 'accounting.read', remote_candidates: 'accounting.read',
    link_mapping: 'accounting.manage + organizations.write + catalog.write',
    unlink_mapping: 'accounting.manage + organizations.write + catalog.write',
    sync_mapping: 'accounting.manage + organizations.write + catalog.write',
    push: 'accounting.manage + invoices.write', push_bulk: 'accounting.manage + invoices.write',
  },
  analyze_fleet_metrics: 'devices.read',
  // Stored data needs read; the live-read input flag needs execute.
  analyze_boot_performance: { stored: 'devices.read', triggerCollection: 'devices.execute' },
  analyze_disk_usage: { stored: 'devices.read', refresh: 'devices.execute' },
  manage_processes: { list: 'devices.execute', kill: 'devices.execute' },
  request_diagnostic_access: 'devices.execute',
  list_diagnostic_access_grants: 'devices.read',
  revoke_diagnostic_access: 'devices.read',
  diagnostic_list_directory: 'devices.execute',
  diagnostic_read_file: 'devices.execute',
  // Network
  get_network_changes: 'devices.read',
  get_ip_history: 'devices.read',
  get_network_asset_reachability: 'devices.read',
  get_interface_history: 'topology.read',
  get_link_health: 'topology.read',
  get_topology_impact: 'topology.read',
  get_recent_network_changes: 'topology.read',
  get_topology_monitoring_status: 'topology.read',
  get_topology: 'topology.read',
  get_link_evidence: 'topology.read',
  get_diagnostic_run: 'topology.read',
  get_dns_security: 'devices.read',
  acknowledge_network_device: 'devices.write',
  configure_network_baseline: 'devices.write',
  manage_dns_policy: 'devices.write',
  // Commands
  execute_command: 'devices.execute',
  run_script: 'scripts.execute',
  computer_control: 'devices.execute + remote.access',
  // Alerts
  manage_alerts: {
    list: 'alerts.read',
    get: 'alerts.read',
    acknowledge: 'alerts.acknowledge',
    resolve: 'alerts.write',
    suppress: 'alerts.write',
  },
  // Services & startup
  manage_services: 'devices.execute',
  manage_startup_items: 'devices.execute',
  manage_scheduled_tasks: { list: 'devices.execute', run: 'devices.execute', disable: 'devices.execute', enable: 'devices.execute' },
  // Security
  security_scan: { scan: 'devices.execute', status: 'devices.execute', quarantine: 'devices.execute', remove: 'devices.execute', restore: 'devices.execute', vulnerabilities: 'devices.read' },
  ioc_hunt: { list_rule_sets: 'devices.read', preview_sweep: 'devices.read', list_sweeps: 'devices.read', sweep_status: 'devices.read', sweep: 'devices.execute', cancel_sweep: 'devices.execute', import_iocs: 'devices.write' },
  get_security_posture: 'devices.read',
  get_trust_page_status: 'organizations.read',
  // Tool Catalog W03 (#5218)
  draft_flow: 'automations.write',
  validate_flow: 'automations.read',
  get_flow: 'automations.read',
  list_flows: 'automations.read',
  run_flow: 'automations.write',
  list_flow_runs: 'automations.read',
  get_flow_run: 'automations.read',
  cancel_flow_run: 'automations.write',
  // #8973 W4: business-hours calendars (read-only)
  list_business_calendars: 'tickets.read',
  // #8883 W5: ticket routing rules
  list_ticket_routing_rules: 'tickets.read',
  test_ticket_routing_rule: 'tickets.read',
  // Files & disk
  disk_cleanup: { preview: 'devices.read', execute: 'devices.execute' },
  system_cleanup: { list: 'devices.execute', run: 'devices.execute', cancel: 'devices.execute', status: 'devices.read' },
  file_operations: { list: 'devices.read', read: 'devices.read', write: 'devices.execute', delete: 'devices.execute', mkdir: 'devices.execute', rename: 'devices.execute' },
  // Registry
  registry_operations: { read_key: 'devices.execute', get_value: 'devices.execute', set_value: 'devices.execute', create_key: 'devices.execute', delete_key: 'devices.execute' },
  // Tags & custom fields
  manage_tags: { list: 'devices.read', add: 'devices.write', remove: 'devices.write' },
  query_custom_fields: 'devices.read',
  // Audit & logs
  query_audit_log: 'audit.read',
  query_change_log: 'devices.read',
  search_logs: 'devices.read',
  get_log_trends: 'devices.read',
  detect_log_correlations: 'devices.read',
  search_agent_logs: 'devices.read',
  set_agent_log_level: 'devices.execute',
  capture_agent_pprof: 'devices.execute',
  // Screenshots
  take_screenshot: 'devices.execute',
  analyze_screen: 'devices.execute',
  // Network discovery
  network_discovery: 'devices.execute',
  diagnose_connectivity: 'devices.execute',
  // Brain device context
  get_device_context: 'devices.read',
  set_device_context: 'devices.write',
  resolve_device_context: 'devices.write',
  // Scripts
  search_script_library: 'scripts.read',
  get_script_details: 'scripts.read',
  propose_script: 'scripts.execute',
  get_script_proposal: 'scripts.read',
  // Software & playbooks
  list_playbooks: 'devices.read',
  execute_playbook: 'devices.execute',
  get_playbook_history: 'devices.read',
  get_software_compliance: 'devices.read',
  manage_software_policy: 'devices.execute',
  remediate_software_violation: 'devices.execute',
  // Configuration policies
  list_configuration_policies: 'devices.read',
  get_configuration_policy: 'devices.read',
  get_effective_configuration: 'devices.read',
  preview_configuration_change: 'devices.read',
  configuration_policy_compliance: { summary: 'devices.read', status: 'devices.read' },
  manage_configuration_policy: {
    create: 'devices.write',
    update: 'devices.write',
    activate: 'devices.write',
    deactivate: 'devices.write',
    delete: 'devices.write',
  },
  apply_configuration_policy: 'devices.write',
  remove_configuration_policy_assignment: 'devices.write',
  // Backup & DR
  // Per-action map, matching routes/backup/configs.ts (backup:read),
  // routes/backup/jobs.ts (organizations:read) and routes/configurationPolicies/
  // crud.ts (devices:read).
  query_backups: { list_configs: 'backup.read', list_jobs: 'organizations.read', list_policies: 'devices.read' },
  get_backup_status: 'organizations.read',
  browse_snapshots: 'backup.read',
  trigger_backup: 'devices.execute',
  restore_snapshot: 'devices.execute',
  // Monitoring
  query_monitors: 'devices.read',
  manage_monitors: { get: 'devices.read', create: 'devices.read', update: 'devices.read', delete: 'devices.read' },
  // Analytics
  query_analytics: 'devices.read',
  get_executive_summary: 'devices.read',
  // Integrations
  // Route requires webhooks:read (routes/webhooks.ts GET / and GET /:id/deliveries).
  query_webhooks: 'webhooks.read',
  // Route requires organizations:read (routes/psa.ts:435).
  query_psa_status: 'organizations.read',
  test_webhook: 'organizations.write',
  // Agent management
  query_agent_versions: 'devices.read',
  trigger_agent_upgrade: 'devices.execute',
  trigger_agent_restart: 'devices.execute',
  // Remote sessions
  // remote:access is required on top of the device grant (routes/remote/index.ts:16).
  list_remote_sessions: 'devices.read + remote.access',
  create_remote_session: 'devices.execute + remote.access',
  // Compliance policies
  query_compliance_policies: 'devices.read',
  get_compliance_status: 'devices.read',
  // Notification channels
  manage_notification_channels: { list: 'alerts.read', test: 'alerts.write', create: 'alerts.write', update: 'alerts.write', delete: 'alerts.write' },
  // Saved filters
  manage_saved_filters: { list: 'devices.read', get: 'devices.read', create: 'devices.write', delete: 'devices.write' },
  // Fleet tools
  manage_deployments: {
    list: 'devices.read',
    get: 'devices.read',
    device_status: 'devices.read',
    create: 'devices.write',
    start: 'devices.execute',
    pause: 'devices.execute',
    resume: 'devices.execute',
    cancel: 'devices.execute',
  },
  manage_patches: {
    list: 'devices.read',
    compliance: 'devices.read',
    scan: 'devices.execute',
    approve: 'devices.execute',
    decline: 'devices.execute',
    defer: 'devices.execute',
    bulk_approve: 'devices.execute',
    install: 'devices.execute',
    rollback: 'devices.execute',
  },
  manage_groups: {
    list: 'devices.read',
    get: 'devices.read',
    preview: 'devices.read',
    membership_log: 'devices.read',
    create: 'devices.write',
    update: 'devices.write',
    delete: 'devices.write',
    add_devices: 'devices.write',
    remove_devices: 'devices.write',
  },
  manage_maintenance_windows: {
    list: 'devices.read',
    get: 'devices.read',
    active_now: 'devices.read',
    create: 'devices.write',
    update: 'devices.write',
    delete: 'devices.write',
  },
  manage_automations: {
    list: 'automations.read',
    get: 'automations.read',
    history: 'automations.read',
    create: 'automations.write',
    update: 'automations.write',
    delete: 'automations.write',
    enable: 'automations.write',
    disable: 'automations.write',
    run: 'automations.write',
  },
  manage_alert_rules: {
    list_rules: 'alerts.read',
    get_rule: 'alerts.read',
    create_rule: 'alerts.write',
    update_rule: 'alerts.write',
    delete_rule: 'alerts.write',
    test_rule: 'alerts.read',
    list_channels: 'alerts.read',
    alert_summary: 'alerts.read',
  },
  // AI agent governance
  manage_ai_agents: { authorize_supervised_key: 'ai_agents.write' },
  // Wisp memory (W03 #9909)
  recall: 'ai_sessions.use',
  remember: 'ai_sessions.use',
  confirm_memory: 'ai_sessions.use',
  retract_memory: 'ai_sessions.use',
  // Wisp concerns and watches (W05a #9911)
  list_concerns: 'ai_sessions.use',
  raise_concern: 'ai_sessions.use',
  snooze_concern: 'ai_sessions.use',
  resolve_concern: 'ai_sessions.use',
  create_watch: 'ai_sessions.use',
  // Wisp thread links (W08 #9914)
  link_entity: 'ai_sessions.use',
  list_links: 'ai_sessions.use',
  // Wisp specialists (W07a #9913); wisp_specialist_request is the approval card.
  launch_specialist: 'ai_sessions.use',
  wisp_specialist_request: 'ai_sessions.use',
  generate_report: {
    list: 'reports.read',
    generate: 'reports.export',
    data: 'reports.read',
    create: 'reports.write',
    update: 'reports.write',
    delete: 'reports.write',
    history: 'reports.read',
    download: 'reports.read',
  },
};

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Group tools by category, preserving declaration order. */
export function groupByCategory<T extends { category: ToolCategory }>(
  items: T[],
): Array<{ category: ToolCategory; items: T[] }> {
  const map = new Map<ToolCategory, T[]>();
  for (const item of items) {
    const arr = map.get(item.category);
    if (arr) arr.push(item);
    else map.set(item.category, [item]);
  }
  return Array.from(map.entries()).map(([category, items]) => ({ category, items }));
}
