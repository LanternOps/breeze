/**
 * Compact tool descriptions for constrained tool profiles (#11393 W03,
 * spec 2026-11-06-small-model-tool-profiles §3.4). A small-context model on a
 * `minimal` / `standard` / `custom` profile reads these instead of the full
 * registry description (`createBreezeMcpServer` swaps them in when the
 * exposure's prompt mode is `constrained`); the `full` exposure never reads
 * this file.
 *
 * Rules enforced by toolProfiles.compactDescription.contract.test.ts:
 *  - every curated `minimal`/`standard` registry tool has one, ≤ 200 chars;
 *  - each is no longer than the full description;
 *  - none names ANOTHER tool: a constrained set may not include it, and a
 *    small model pointed at an absent tool invents calls to it.
 * Review rule (not machine-checked): approval, consent and cross-client
 * privacy notes from the full text are kept, since a small model still needs
 * to know what a call will do.
 *
 * One map rather than a field on every `aiTools*.ts` declaration: the set is
 * the curated lists' (toolProfiles.ts), reviewed together.
 */
export const COMPACT_TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  analyze_disk_usage: 'Explain what is using disk space on a device from its latest scan; refresh=true runs a new scan (needs execute permission).',
  analyze_metrics: 'Time-series CPU, RAM, disk and network metrics for one device, with time range and aggregation. The summary covers the whole window.',
  analyze_screen: 'Screenshot a device and describe what is on screen, to troubleshoot what the user sees. Refused where remote access needs user consent.',
  browse_device_event_log: 'Read the live Windows event log of one online device. Actions: list_logs, query, get_event. query and get_event need approval.',
  disk_cleanup: 'Preview (read-only) or execute disk cleanup. Execute deletes approved safe candidates and reports space reclaimed. Actions: preview, execute.',
  execute_command: 'Run a system command on a device. commandType list_processes, file_list and event_logs_list run without approval (audited); others, including file_read, need approval.',
  file_operations: 'File operations on a device. list runs at once; read, write, delete, mkdir and rename need approval. delete moves the item to the agent trash unless permanent: true.',
  find_proven_fixes: 'Fixes proven by outcomes on the same problem (alert, anomaly or device condition) across your clients, with track records. Never another client\'s private details.',
  get_active_users: 'Active user sessions on one device or across the fleet, with session state and a reboot safety signal.',
  get_alert_correlations: 'Read alert correlation. Actions: groups, get (groupId), by_alert (alertId), links, analyze (alertIds), evaluation, explain (groupId; log text is untrusted).',
  get_backup_status: 'Backup health for one device or the whole organization, covering Breeze and synced third-party backups.',
  get_cis_device_report: 'CIS findings for one device: failed checks and evidence from the latest scans.',
  get_device_context: 'Past AI memory about a device: known issues, quirks, follow-ups and preferences. Read it first when asked about a device.',
  get_device_details: 'Details of one device: hardware (incl. RAM slots), OS, network interfaces, disk usage, placement and recent metrics.',
  get_device_events: 'Activity timeline for one device (what ran, changed or failed, and who), newest first. Filter by category, result, initiator, time or text.',
  get_device_hardware_health: 'Hardware health of one device: components, collectors, optional recent events and, with includeReliability, the reliability score\'s factors.',
  get_device_health: 'The Breeze agent\'s latest self-reported health on one device: overall and per-component state with reasons.',
  get_device_software: 'Installed software on one device (name, version, vendor, install date), paged, optional name search.',
  get_device_time_status: 'Windows time sync on one device: expected timezone and its source, findings and recent time events.',
  get_device_vulnerabilities: 'CVE findings on one device with affected software, severity, CVSS, EPSS, risk score, CISA KEV and patch availability.',
  get_fleet_health: 'Device reliability scores, worst first, with uptime, crash and failure metrics. Actions: list (default), history, offenders (deviceId), evaluation, org_summary (orgId).',
  get_org_summary: 'One organization at a glance: devices online, open alerts and tickets, contracts, invoices, sites, contacts, last activity. Sections you lack permission for are omitted.',
  get_script_details: 'Script details: parameters, version history and execution statistics. The script content is omitted unless requested.',
  get_script_execution: 'Status, exit code, stdout/stderr and timing of one script execution. A run timeout means the 60s wait expired, not that the script failed: recheck before editing.',
  get_script_execution_history: 'Past script runs, newest first, for one script (scriptId), one device (deviceId) or both: status, exit code, output and timing.',
  get_security_posture: 'Security control scores for the fleet or one device (AV, firewall, encryption, patch currency) with factors and recommendations. Not CVE findings.',
  get_user_experience_metrics: 'Login performance and session behavior trends for a device or user over time.',
  get_vulnerability_report: 'Fleet CVE findings: severity counts and the highest-risk CVEs with affected-device counts, CVSS and CISA KEV.',
  list_organizations: 'List or search the organizations you can access, with id, name, status and sites. Read-only.',
  list_script_templates: 'Browse script templates for common tasks, to use as starting points.',
  list_scripts: 'Search the organization\'s script library by name, language, OS target or category.',
  list_sites: 'Accessible sites with organization, timezone and device count. Filter by organization or name.',
  list_time_sync_issues: 'Time-sync findings across the accessible Windows fleet. Filter by finding, role, domain, health, organization, site or device; paged.',
  manage_alert_rules: 'Read compiled alert rules and channels. Actions: list_rules, get_rule, test_rule, list_channels, alert_summary.',
  manage_alerts: 'Search and manage alerts. Actions: list, get, acknowledge (mark seen), resolve (close), suppress (silence for a while).',
  manage_delivery: 'Alert delivery routing and escalation; writes need approval. channelIds [] means inbox only. Actions: resolve, list_routing, set_default, list_escalation and their create/update/delete.',
  manage_patches: 'Patches and KBs. Install needs both patchIds and deviceIds. Actions: list, compliance, scan, approve, decline, defer, bulk_approve, install, rollback, device_history.',
  manage_processes: 'List processes with CPU and memory use, or kill one. Before kill, restate the evidence tying the PID to the problem (verified or inferred). Actions: list, kill.',
  manage_services: 'List, start, stop or restart system services on a device. Actions: list, start, stop, restart.',
  manage_tickets: 'Tickets and time entries. Common actions: list, get, create, comment, assign, update_status, update_fields, log_time_entry, start_timer, stop_timer, link_alert, link_device.',
  query_audit_log: 'Search the audit log for recent actions: what happened on devices and who made changes.',
  query_device_workloads: 'Containers and VMs (Docker, Podman, Hyper-V, Proxmox) on one device with per-runtime status and counts, capped. Off until a configuration policy enables it.',
  query_devices: 'Search and filter devices: hostname, OS, status, IP and last seen, sorted by hostname.',
  resolve_device_context: 'Mark a device memory entry resolved when the issue is fixed or the follow-up is done. It stays in history.',
  run_script: 'Run a saved scriptId or a reviewed proposalId on deviceIds or one groupId (max 10 devices). Needs approval. A maintenance-window deferral is not a failure.',
  search_documentation: 'Search the Breeze documentation for how-to guides, feature explanations and reference material.',
  search_logs: 'Search ingested event logs across devices: full text, time range, severity, category, source, device and site filters.',
  take_screenshot: 'Capture the device screen for visual analysis. Refused where remote access needs user consent.',
});
