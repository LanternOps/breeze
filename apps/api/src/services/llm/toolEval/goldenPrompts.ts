import type { CaptureSurfaceId } from '../toolCapture/surfaces';

export interface GoldenExpectation {
  /** Bare tool name, without an MCP server prefix. */
  tool: string;
  action?: string;
}

export interface GoldenCase {
  id: string;
  prompt: string;
  expect: GoldenExpectation[];
  /** Defaults to ['chat']. */
  surfaces?: CaptureSurfaceId[];
}

export const GOLDEN_CASES: readonly GoldenCase[] = [
  { id: 'g01', prompt: 'Which Windows devices are offline right now?', expect: [{ tool: 'query_devices' }] },
  { id: 'g02', prompt: 'Show me everything about the device named LAB-WS-042.', expect: [{ tool: 'resolve_device_context' }, { tool: 'query_devices' }, { tool: 'get_device_details' }] },
  { id: 'g03', prompt: 'Is CPU on FS-01 pegged? Show the last hour.', expect: [{ tool: 'analyze_metrics' }, { tool: 'resolve_device_context' }] },
  { id: 'g04', prompt: 'How many critical alerts are open across all customers?', expect: [{ tool: 'manage_alerts', action: 'list' }] },
  { id: 'g05', prompt: 'Acknowledge the disk-space alert on ACME-DC1, I am on it.', expect: [{ tool: 'manage_alerts', action: 'acknowledge' }, { tool: 'resolve_device_context' }] },
  { id: 'g06', prompt: 'What alert rules fire for high memory?', expect: [{ tool: 'manage_alert_rules' }] },
  { id: 'g07', prompt: 'Which machines are still missing the September cumulative update?', expect: [{ tool: 'manage_patches', action: 'list' }] },
  { id: 'g08', prompt: 'Approve KB5065431 for the pilot ring.', expect: [{ tool: 'manage_patches', action: 'approve' }, { tool: 'manage_update_rings' }] },
  { id: 'g09', prompt: 'Does anything in the fleet have a known-exploited CVE?', expect: [{ tool: 'get_vulnerability_report' }] },
  { id: 'g10', prompt: 'List the CVEs on WEB-03.', expect: [{ tool: 'get_device_vulnerabilities' }, { tool: 'resolve_device_context' }] },
  { id: 'g11', prompt: 'How are our security controls scoring — AV, firewall, disk encryption?', expect: [{ tool: 'get_security_posture' }] },
  { id: 'g12', prompt: 'Run a CIS benchmark check on the finance server.', expect: [{ tool: 'get_cis_compliance' }, { tool: 'get_cis_device_report' }, { tool: 'resolve_device_context' }] },
  { id: 'g13', prompt: 'Search the logs on PRINT-SRV for spooler crashes today.', expect: [{ tool: 'search_logs' }, { tool: 'resolve_device_context' }] },
  { id: 'g14', prompt: 'Restart the Print Spooler service on PRINT-SRV.', expect: [{ tool: 'manage_services', action: 'restart' }, { tool: 'resolve_device_context' }] },
  { id: 'g15', prompt: 'Run "ipconfig /all" on LAB-WS-042.', expect: [{ tool: 'execute_command' }, { tool: 'resolve_device_context' }] },
  { id: 'g16', prompt: 'Do we have a script that clears the Teams cache?', expect: [{ tool: 'list_scripts' }, { tool: 'search_script_library' }] },
  { id: 'g17', prompt: 'Run the "Clear Teams cache" script on every machine at Northwind.', expect: [{ tool: 'run_script' }, { tool: 'list_scripts' }, { tool: 'query_devices' }] },
  { id: 'g18', prompt: 'What automations are enabled?', expect: [{ tool: 'manage_automations', action: 'list' }] },
  { id: 'g19', prompt: 'What is eating the disk on ACME-DC1?', expect: [{ tool: 'analyze_disk_usage' }, { tool: 'resolve_device_context' }] },
  { id: 'g20', prompt: 'Free up space on ACME-DC1 — temp files, update leftovers, the usual.', expect: [{ tool: 'disk_cleanup' }, { tool: 'analyze_disk_usage' }, { tool: 'resolve_device_context' }] },
  { id: 'g21', prompt: 'Who is logged on to RDS-02 right now?', expect: [{ tool: 'get_active_users' }, { tool: 'resolve_device_context' }] },
  { id: 'g22', prompt: 'Take a screenshot of what the user on KIOSK-1 sees.', expect: [{ tool: 'take_screenshot' }, { tool: 'resolve_device_context' }] },
  { id: 'g23', prompt: 'Did last night\'s backups succeed for Contoso?', expect: [{ tool: 'get_backup_status' }, { tool: 'query_backups' }] },
  { id: 'g24', prompt: 'Restore yesterday\'s copy of the Finance share on FS-01.', expect: [{ tool: 'browse_snapshots' }, { tool: 'restore_snapshot' }, { tool: 'resolve_device_context' }] },
  { id: 'g25', prompt: 'Kick off a backup of SQL-01 now.', expect: [{ tool: 'trigger_backup' }, { tool: 'trigger_mssql_backup' }, { tool: 'resolve_device_context' }] },
  { id: 'g26', prompt: 'Which customers are breaching their backup SLA?', expect: [{ tool: 'get_sla_breaches' }, { tool: 'get_sla_compliance_report' }] },
  { id: 'g27', prompt: 'What new devices showed up on the Contoso network this week?', expect: [{ tool: 'get_network_changes' }, { tool: 'network_discovery' }] },
  { id: 'g28', prompt: 'Scan the 10.20.0.0/24 subnet at Northwind.', expect: [{ tool: 'network_discovery' }] },
  { id: 'g29', prompt: 'What IPs has LAB-WS-042 had this month?', expect: [{ tool: 'get_ip_history' }, { tool: 'resolve_device_context' }] },
  { id: 'g30', prompt: 'Is DNS filtering on for Contoso?', expect: [{ tool: 'get_dns_security' }, { tool: 'manage_dns_policy' }] },
  { id: 'g31', prompt: 'Add the three new laptops to the "Sales" device group.', expect: [{ tool: 'manage_groups', action: 'add_devices' }, { tool: 'manage_groups', action: 'list' }, { tool: 'query_devices' }] },
  { id: 'g32', prompt: 'Tag WEB-03 as "pci".', expect: [{ tool: 'manage_tags' }, { tool: 'resolve_device_context' }] },
  { id: 'g33', prompt: 'Which organizations do we manage?', expect: [{ tool: 'list_organizations' }] },
  { id: 'g34', prompt: 'Open a ticket: Northwind reports slow email since Monday.', expect: [{ tool: 'manage_tickets' }] },
  { id: 'g35', prompt: 'Log 45 minutes on ticket 1042 for the printer fix.', expect: [{ tool: 'manage_tickets', action: 'log_time_entry' }] },
  { id: 'g36', prompt: 'Start my timer on ticket 1042.', expect: [{ tool: 'manage_tickets', action: 'start_timer' }] },
  { id: 'g37', prompt: 'Draft a quote for 25 M365 Business Premium seats for Contoso.', expect: [{ tool: 'manage_quotes' }, { tool: 'search_catalog' }] },
  { id: 'g38', prompt: 'Which invoices are overdue?', expect: [{ tool: 'list_invoices' }, { tool: 'manage_invoices' }] },
  { id: 'g39', prompt: 'When does the Contoso managed-services contract renew?', expect: [{ tool: 'list_contracts' }, { tool: 'get_contract' }, { tool: 'manage_contracts' }] },
  { id: 'g40', prompt: 'What does a Lenovo ThinkPad T14 cost from our distributor?', expect: [{ tool: 'lookup_distributor_product' }] },
  { id: 'g41', prompt: 'Show me the Microsoft 365 users at Contoso without MFA.', expect: [{ tool: 'm365_query_users' }] },
  { id: 'g42', prompt: 'Any risky sign-ins at Contoso in the last 24 hours?', expect: [{ tool: 'm365_query_signins' }] },
  { id: 'g43', prompt: 'Which Contoso devices are non-compliant in Intune?', expect: [{ tool: 'm365_query_intune_devices' }] },
  { id: 'g44', prompt: 'Any open Huntress incidents?', expect: [{ tool: 'get_huntress_incidents' }] },
  { id: 'g45', prompt: 'Isolate WEB-03 in SentinelOne.', expect: [{ tool: 's1_isolate_device' }, { tool: 'resolve_device_context' }] },
  { id: 'g46', prompt: 'What threats has SentinelOne flagged this week?', expect: [{ tool: 'get_s1_threats' }] },
  { id: 'g47', prompt: 'Which configuration policies apply to the Contoso servers?', expect: [{ tool: 'list_configuration_policies' }, { tool: 'get_effective_configuration' }] },
  { id: 'g48', prompt: 'What settings does the "Standard Workstation" policy actually push?', expect: [{ tool: 'get_configuration_policy' }, { tool: 'list_configuration_policies' }] },
  { id: 'g49', prompt: 'Which software is banned by policy but still installed somewhere?', expect: [{ tool: 'get_software_compliance' }, { tool: 'get_compliance_status' }] },
  { id: 'g50', prompt: 'When is the next maintenance window for Northwind?', expect: [{ tool: 'manage_maintenance_windows' }] },
  { id: 'g51', prompt: 'Is the website monitor for the Contoso public site green?', expect: [{ tool: 'query_monitors' }, { tool: 'get_service_monitoring_status' }, { tool: 'list_monitors' }] },
  { id: 'g52', prompt: 'Who changed the firewall policy last week?', expect: [{ tool: 'query_audit_log' }, { tool: 'query_change_log' }] },
  { id: 'g53', prompt: 'Generate a monthly health report for Contoso.', expect: [{ tool: 'generate_report' }, { tool: 'get_executive_summary' }] },
  { id: 'g54', prompt: 'How is the fleet doing overall today?', expect: [{ tool: 'get_fleet_health' }, { tool: 'get_executive_summary' }] },
  { id: 'g55', prompt: 'Which agents are running an old version?', expect: [{ tool: 'query_agent_versions' }] },
  { id: 'g56', prompt: 'Pull the agent logs from LAB-WS-042, it keeps disconnecting.', expect: [{ tool: 'search_agent_logs' }, { tool: 'resolve_device_context' }] },
  { id: 'g57', prompt: 'How do I set up a maintenance window in Breeze?', expect: [{ tool: 'search_documentation' }] },
  { id: 'g58', prompt: 'Run the onboarding playbook for the new Northwind laptops.', expect: [{ tool: 'list_playbooks' }, { tool: 'execute_playbook' }] },
  { id: 'g59', prompt: 'Any USB storage plugged in at Contoso this week?', expect: [{ tool: 'get_peripheral_activity' }] },
  { id: 'g60', prompt: 'Where is Contoso keeping credit-card numbers in files?', expect: [{ tool: 'get_sensitive_data_overview' }] },
  // Spec 2026-09-23 W01 (#6755): one golden case per domain that had no
  // reachable read before this wave wired its L1 reads into chat/agents.
  { id: 'g61', prompt: 'List the Hyper-V VMs running on HV-HOST-01.', expect: [{ tool: 'query_hyperv_vms' }, { tool: 'resolve_device_context' }] },
  { id: 'g62', prompt: 'When was the last good backup of the Payroll database on SQL-01?', expect: [{ tool: 'get_mssql_backup_status' }, { tool: 'query_mssql_instances' }, { tool: 'resolve_device_context' }] },
  { id: 'g63', prompt: 'Is the local backup vault on FS-01 in sync?', expect: [{ tool: 'get_vault_status' }, { tool: 'resolve_device_context' }] },
  { id: 'g64', prompt: 'Did the Microsoft 365 mailbox backups for Contoso run last night?', expect: [{ tool: 'query_c2c_jobs' }] },
  { id: 'g65', prompt: 'Who requested admin elevation on LAB-WS-042 this week?', expect: [{ tool: 'get_elevation_history' }, { tool: 'resolve_device_context' }] },
  { id: 'g66', prompt: 'Which Contoso users have the highest security risk score?', expect: [{ tool: 'get_user_risk_scores' }] },
  { id: 'g67', prompt: 'Who has had a remote session open to KIOSK-1 recently?', expect: [{ tool: 'list_remote_sessions' }, { tool: 'resolve_device_context' }] },
];
