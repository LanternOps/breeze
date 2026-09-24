/**
 * Route-module MCP coverage (#6141, A-W06).
 * Tools indicate an existing surface, not parity for every endpoint in a module.
 * Gaps are frozen in __tests__/mcp-coverage.test.ts and may only shrink.
 * Keep entries explicit: new route files must make a deliberate coverage choice.
 */
export type McpCoverageEntry =
  | { tools: readonly string[] }
  | { exempt: McpExemptReason; note?: string }
  | { gap: string };

export type McpExemptReason =
  | 'agent_transport'
  | 'identity'
  | 'platform_admin'
  | 'inbound_integration'
  | 'portal'
  | 'addin_surface'
  | 'device_helper'
  | 'mcp_transport'
  | 'internal_plumbing'
  /**
   * A one-time, irreversible-by-default migration an operator runs by hand.
   * Deliberately NOT agent-reachable: the spec gives conversion no AI tool
   * (docs/superpowers/specs/monitoring/2026-09-19-alerting-consolidation-design.md
   * §AI / MCP tools lists no conversion row), the routes are MFA- and
   * governance-gated, and a preview must be read by a human before the
   * matching convert call is made.
   */
  | 'human_only_migration'
  /**
   * Partner-level administration of an EXTERNAL VENDOR CONSOLE connection and
   * the tenant bookkeeping it requires: storing/rotating the vendor login,
   * mapping a discovered vendor customer onto a Breeze organization, and
   * linking a vendor device row to a Breeze device. Deliberately not
   * agent-reachable — these writes decide which tenant a third party's data
   * lands under, and the credential routes are MFA- plus
   * partner-wide-manage-gated. The agent-facing READ surface for backup health
   * is `GET /backup/health` (#6008 W03), which carries its own tools.
   */
  | 'vendor_console_admin'
  /**
   * Caller verification (#6354) — the anti-vishing control itself. Starting,
   * attesting, cancelling or overriding a verification, binding a canonical
   * identity to a contact, and editing the policy floors are all decisions
   * about WHETHER A CALLER IS WHO THEY CLAIM TO BE. An agent-reachable tool
   * here would be the vishing vector the feature exists to close: a
   * prompt-injected or socially-engineered agent could attest a caller's
   * identity, bind an attacker's phone number as canonical, or lower the
   * policy floor, and every downstream control would then read as satisfied.
   * Every write on this router is `organizations:write` + `requireMfa()`
   * precisely so a HUMAN with a second factor is the only actor that can
   * decide one. The read side is deliberately excluded too: the verification
   * record carries challenge and destination provenance material that is
   * classified `excludedSensitive` in the tenant export policy.
   */
  | 'human_only_verification'
  /**
   * Evidence of a customer's agreement attached to an MSP-recorded ("accept on
   * behalf") quote acceptance (#6633) — a signed PDF, PO scan, or email export
   * a dispute reviewer relies on. Accepting on behalf is itself human-only (the
   * spec gives it no AI tool: it commits the customer to an invoice and
   * contracts), and an agent that could attach or replace the supporting file
   * could fabricate the proof behind a money-committing record. Download is
   * excluded with it: the file is internal, never shown to the customer, and
   * is read by a human reviewer from the quote page.
   */
  | 'human_only_legal_evidence'
  /**
   * Rolling back an agent to a prior release. A standing spec exclusion
   * (docs/superpowers/specs/ai-mcp/2026-09-23-ai-full-control-design.md,
   * W05 gap triage): reverting fleet software is an operator decision, not
   * one an AI should be able to trigger.
   */
  | 'human_only_agent_rollback'
  /**
   * A bulk-destructive action (bulk delete/cancel/issue/void/permanent-delete)
   * whose single-item equivalent already has an AI tool. Kept human-only
   * because a bad bulk call is much harder to unwind than a bad single call,
   * and every affected module already has a scoped, reversible path for the
   * AI to use instead (W05 gap triage).
   */
  | 'human_only_bulk_destructive'
  /**
   * The human decision gate of the approvals system itself (passkey
   * assertion-challenge, approve/deny/report-suspicious). An AI that could
   * decide an approval — including one gating its own actions — defeats the
   * four-eyes control the approval exists to provide (W05 gap triage).
   */
  | 'human_only_approval'
  /**
   * AI self-governance surface: BYO LLM provider keys, the unattended
   * script-lane grant/reset, the partner-wide ceiling on that lane, and BYO
   * MCP tool sources with per-tool tier/enable. The AI must never be able to
   * widen its own authority, so none of this is agent-reachable, including
   * read-only views of the current policy/tool-source state (W05 gap triage).
   */
  | 'human_only_ai_governance'
  /**
   * Rewrites which tenant owns data: cross-tenant device move, org archive,
   * org merge. These are tenant-restructure decisions with lock/rewrite
   * machinery behind them, kept human-only pending product confirmation
   * (W05 gap triage).
   */
  | 'human_only_tenant_restructure'
  /**
   * The chat / script-builder session transport itself (sessions, messages,
   * interrupt, approve-plan). This is the plumbing the AI features run over,
   * not a tool surface an AI agent calls (W05 gap triage).
   */
  | 'ai_transport'
  /**
   * The mobile app's aggregate API, analogous to `addin_surface`. Its actions
   * duplicate `manage_alerts` and existing device tools (W05 gap triage).
   */
  | 'mobile_surface'
  /**
   * Machine-to-machine Partner API for external service principals (#3243).
   * Duplicates in-product reads that already have AI tools, and its
   * provisioning writes are service-principal-only by design (W05 gap
   * triage).
   */
  | 'partner_api_surface'
  /**
   * A browser file-transfer flow: CSV import preview/commit, or chunked
   * binary upload. The AI-reachable equivalent is a per-row write (a
   * custom-field set, a catalog version from a URL), not the file transfer
   * itself (W05 gap triage).
   */
  | 'ui_file_transfer'
  /**
   * The partner's own relationship with Breeze: a trust review request, the
   * Breeze billing portal, or a support forward. Not tenant data the AI
   * manages on the partner's behalf (W05 gap triage).
   */
  | 'breeze_account';

export const MCP_COVERAGE: Readonly<Record<string, McpCoverageEntry>> = {
  'accessReviews.ts': { gap: '#6781' },
  'accounting/index.ts': { gap: '#6784' },
  'actionIntents.ts': { exempt: 'identity' },
  'admin/abuse.ts': { exempt: 'platform_admin' },
  'admin/aiKillState.ts': { exempt: 'platform_admin' },
  'admin/aiToolUsage.ts': { exempt: 'platform_admin' },
  'admin/deprecations.ts': { exempt: 'platform_admin' },
  'admin/desktopFinalization.ts': { exempt: 'platform_admin' },
  'admin/exchangeRates.ts': { exempt: 'platform_admin' },
  'admin/llmProviderCatalog.ts': { exempt: 'platform_admin' },
  'admin/monitorConversion.ts': { exempt: 'platform_admin' },
  'admin/sendingDomains.ts': { exempt: 'platform_admin' },
  'admin/systemConnections.ts': { exempt: 'platform_admin' },
  'admin/tenantErasure.ts': { exempt: 'platform_admin' },
  'admin/tenantExport.ts': { exempt: 'platform_admin' },
  'admin/trust.ts': { exempt: 'platform_admin' },
  'admin/trustAct.ts': { exempt: 'platform_admin' },
  'agentRollback.ts': { exempt: 'human_only_agent_rollback', note: 'Spec standing exclusion (docs/superpowers/specs/ai-mcp/2026-09-23-ai-full-control-design.md).' },
  'agentVersions.ts': { tools: ['query_agent_versions', 'trigger_agent_upgrade'] },
  'agentWs.ts': { exempt: 'agent_transport', note: 'Agent WebSocket command and telemetry transport.' },
  'agents/bootPerformance.ts': { exempt: 'agent_transport' },
  'agents/changes.ts': { exempt: 'agent_transport' },
  'agents/commands.ts': { exempt: 'agent_transport' },
  'agents/connections.ts': { exempt: 'agent_transport' },
  'agents/download.ts': { exempt: 'agent_transport' },
  'agents/elevationRequests.ts': { exempt: 'agent_transport' },
  'agents/enrollment.ts': { exempt: 'agent_transport' },
  'agents/eventlogs.ts': { exempt: 'agent_transport' },
  'agents/hardwareHealth.ts': { exempt: 'agent_transport' },
  'agents/heartbeat.ts': { exempt: 'agent_transport' },
  'agents/inventory.ts': { exempt: 'agent_transport' },
  'agents/logs.ts': { exempt: 'agent_transport' },
  'agents/mtls.ts': { exempt: 'agent_transport' },
  'agents/pamObservations.ts': { exempt: 'agent_transport' },
  'agents/pamReconciliation.ts': { exempt: 'agent_transport' },
  'agents/patches.ts': { exempt: 'agent_transport' },
  'agents/peripherals.ts': { exempt: 'agent_transport' },
  'agents/processSample.ts': { exempt: 'agent_transport' },
  'agents/recoveryKeys.ts': { exempt: 'agent_transport' },
  'agents/reliability.ts': { exempt: 'agent_transport' },
  'agents/security.ts': { exempt: 'agent_transport' },
  'agents/sessions.ts': { exempt: 'agent_transport' },
  'agents/state.ts': { exempt: 'agent_transport' },
  'agents/token.ts': { exempt: 'agent_transport' },
  'agents/unifiTelemetry.ts': { exempt: 'agent_transport' },
  'agents/uninstallIntent.ts': { exempt: 'agent_transport' },
  'agents/wingetBootstrap.ts': { exempt: 'agent_transport' },
  'ai.ts': { exempt: 'ai_transport', note: 'Chat session transport (sessions, messages, interrupt, approve-plan); usage/budget/admin sub-routes are AI governance.' },
  'ai/scriptPolicy.ts': { exempt: 'human_only_ai_governance', note: 'Unattended script-lane grant plus lane reset (approvals:decide + step-up) -- the AI must not widen its own authority.' },
  'ai/scriptProposals.ts': { tools: ['propose_script', 'get_script_proposal'] },
  'aiAgentSchedules.ts': { gap: '#6780' },
  'aiAgents.ts': { tools: ['list_ai_agents', 'list_ai_agent_runs', 'get_ai_agent_run', 'manage_ai_agents'] },
  'aiArtifacts.ts': { tools: ['read_artifact'] },
  'aiOperatorTasks.ts': { gap: '#6780' },
  'aiProvider.ts': { exempt: 'human_only_ai_governance', note: 'BYO LLM key and endpoint -- a credential, and the AI must not manage its own model provider.' },
  'alertTemplates/correlations.ts': { gap: '#6777' },
  'alertTemplates/rules.ts': { tools: ['manage_alert_rules'] },
  'alertTemplates/templates.ts': { tools: ['manage_alert_rules'] },
  'alerts/alerts.ts': { tools: ['manage_alerts'] },
  'alerts/channels.ts': { tools: ['manage_notification_channels'] },
  'alerts/correlations.ts': { gap: '#6777' },
  'alerts/delivery.ts': { tools: ['manage_delivery'] },
  'alerts/deliveryRails.ts': { tools: ['manage_delivery'] },
  'alerts/policies.ts': { tools: ['manage_delivery'] },
  'alerts/routing.ts': { tools: ['manage_delivery'] },
  'alerts/rules.ts': { tools: ['manage_alert_rules'] },
  'analytics.ts': { tools: ['query_analytics', 'get_executive_summary'] },
  'apiKeys.ts': { exempt: 'identity' },
  'approvals.ts': { exempt: 'human_only_approval', note: 'The human decision gate itself (passkey assertion-challenge, approve/deny/report-suspicious). An AI that could decide approvals defeats four-eyes.' },
  'auditBaselines.ts': { gap: '#6781' },
  'auditLogs.ts': { tools: ['query_audit_log'] },
  'auth/accountDeletion.ts': { exempt: 'identity' },
  'auth/authTransitionTestControl.ts': { exempt: 'identity' },
  'auth/binding.ts': { exempt: 'identity' },
  'auth/cfAccessRedirectLogin.ts': { exempt: 'identity' },
  'auth/helpers.ts': { exempt: 'identity' },
  'auth/invite.ts': { exempt: 'identity' },
  'auth/login.ts': { exempt: 'identity' },
  'auth/loginContext.ts': { exempt: 'identity' },
  'auth/mfa.ts': { exempt: 'identity' },
  'auth/passkeys.ts': { exempt: 'identity' },
  'auth/password.ts': { exempt: 'identity' },
  'auth/phone.ts': { exempt: 'identity' },
  'auth/register.ts': { exempt: 'identity' },
  'auth/ssoDiscovery.ts': { exempt: 'identity' },
  'auth/testApproval.ts': { exempt: 'identity' },
  'auth/verifyEmail.ts': { exempt: 'identity' },
  'authenticator.ts': { exempt: 'identity' },
  'automations.ts': { tools: ['manage_automations'] },
  'backup/bmr.ts': { gap: '#6792' },
  'backup/bmrRecoveries.ts': { gap: '#6788' },
  'backup/configs.ts': { tools: ['manage_backup_configs'] },
  'backup/dashboard.ts': { tools: ['query_backups', 'get_backup_status'] },
  'backup/encryption.ts': { gap: '#6793' },
  'backup/hyperv.ts': { tools: ['query_hyperv_vms', 'get_hyperv_vm_details', 'manage_hyperv_vm', 'trigger_hyperv_backup', 'restore_hyperv_vm', 'manage_hyperv_checkpoints'] },
  'backup/jobs.ts': { tools: ['query_backups', 'trigger_backup'] },
  'backup/mssql.ts': { tools: ['query_mssql_instances', 'get_mssql_backup_status', 'trigger_mssql_backup', 'restore_mssql_database', 'verify_mssql_backup'] },
  'backup/profiles.ts': { tools: ['manage_backup_profiles'] },
  // #6008 W01 — the external backup-provider (Cove) admin surface; see
  // `vendor_console_admin` above for why none of it is agent-reachable.
  'backup/providerCustomers.ts': { exempt: 'vendor_console_admin', note: 'maps a discovered Cove customer onto a Breeze org' },
  'backup/providerDevices.ts': { exempt: 'vendor_console_admin', note: 'lists provider device rows and links one to a Breeze device' },
  'backup/providers.ts': { exempt: 'vendor_console_admin', note: 'stores and rotates the Cove console credential' },
  'backup/reconcile.ts': { gap: '#6794' },
  'backup/resilienceAuthorization.ts': { exempt: 'internal_plumbing', note: 'Authorization/helper or router composition module; the textual scanner matches context access, not a standalone endpoint.' },
  'backup/restore.ts': { tools: ['restore_snapshot'] },
  'backup/sla.ts': { tools: ['query_backup_sla', 'get_sla_breaches', 'get_sla_compliance_report', 'configure_backup_sla'] },
  'backup/snapshots.ts': { tools: ['browse_snapshots', 'query_backups'] },
  'backup/vault.ts': { tools: ['query_vaults', 'get_vault_status', 'configure_vault', 'trigger_vault_sync'] },
  'backup/verification.ts': { gap: '#6788' },
  'backup/vmrestore.ts': { tools: ['get_vm_restore_estimate', 'restore_as_vm', 'instant_boot_vm'] },
  'backup/vss.ts': { gap: '#6788' },
  'billingProfiles.ts': { gap: '#6784' },
  'browserSecurity.ts': { tools: ['get_browser_security', 'manage_browser_policy'] },
  'c2c/configs.ts': { gap: '#6788' },
  'c2c/connections.ts': { tools: ['query_c2c_connections'] },
  'c2c/items.ts': { tools: ['search_c2c_items', 'restore_c2c_items'] },
  'c2c/jobs.ts': { tools: ['query_c2c_jobs', 'trigger_c2c_sync'] },
  'c2c/m365Auth.ts': { exempt: 'vendor_console_admin' },
  'callerVerification.ts': { exempt: 'human_only_verification' },
  'catalog/bundles.ts': { tools: ['manage_catalog'] },
  'catalog/catalog.ts': { tools: ['search_catalog', 'get_catalog_item', 'manage_catalog'] },
  'catalog/distributors.ts': { tools: ['lookup_distributor_product'] },
  'catalog/enrich.ts': { gap: '#6795' },
  'catalog/pricing.ts': { tools: ['manage_catalog'] },
  'changes.ts': { tools: ['query_change_log'] },
  'cisHardening.ts': { tools: ['get_cis_compliance', 'get_cis_device_report', 'apply_cis_remediation'] },
  'clientAi/admin.ts': { exempt: 'addin_surface' },
  'clientAi/adminOrgs.ts': { exempt: 'addin_surface' },
  'clientAi/adminSessions.ts': { exempt: 'addin_surface' },
  'clientAi/adminTemplates.ts': { exempt: 'addin_surface' },
  'clientAi/adminUsage.ts': { exempt: 'addin_surface' },
  'clientAi/auth.ts': { exempt: 'addin_surface' },
  'clientAi/sessions.ts': { exempt: 'addin_surface' },
  'clientAi/templates.ts': { exempt: 'addin_surface' },
  'config.ts': { exempt: 'internal_plumbing' },
  'configurationPolicies/alertRuleTest.ts': { gap: '#6777' },
  'configurationPolicies/assignments.ts': { tools: ['apply_configuration_policy', 'remove_configuration_policy_assignment'] },
  'configurationPolicies/crud.ts': { tools: ['manage_configuration_policy', 'list_configuration_policies', 'get_configuration_policy'] },
  'configurationPolicies/featureLinks.ts': { tools: ['manage_policy_feature_link', 'manage_service_monitors'] },
  'configurationPolicies/patchJobs.ts': { tools: ['manage_patches'] },
  'configurationPolicies/resolution.ts': { tools: ['get_effective_configuration', 'preview_configuration_change', 'configuration_policy_compliance'] },
  'connectedApps.ts': { exempt: 'identity' },
  'contracts/bulk.ts': { exempt: 'human_only_bulk_destructive', note: 'Bulk delete/cancel; the single-item equivalents already have tools.' },
  'contracts/contracts.ts': { tools: ['list_contracts', 'get_contract', 'manage_contracts'] },
  'contracts/deliverables.ts': { tools: ['list_deliverables'] },
  'contracts/documents.ts': { gap: '#6784' },
  'contracts/generate.ts': { gap: '#6784' },
  'contracts/lifecycle.ts': { tools: ['manage_contracts'] },
  'contracts/lines.ts': { tools: ['manage_contracts'] },
  'contracts/periods.ts': { gap: '#6784' },
  'contracts/reports.ts': { gap: '#6784' },
  'contracts/templates.ts': { gap: '#6784' },
  'customFieldImport.ts': { exempt: 'ui_file_transfer', note: 'CSV import preview/commit -- a browser file flow.' },
  'customFields.ts': { tools: ['query_custom_fields'] },
  'deliverableTemplates.ts': { tools: ['list_deliverable_templates'] },
  'deployments.ts': { tools: ['manage_deployments'] },
  'desktopWs.ts': { exempt: 'internal_plumbing', note: 'WebSocket/HTTP transport for event, remote-session or tunnel traffic.' },
  'devPush.ts': { exempt: 'internal_plumbing' },
  'devices/actuateElevation.ts': { gap: '#6796' },
  'devices/aiOrigin.ts': { gap: '#6780' },
  'devices/alerts.ts': { tools: ['manage_alerts'] },
  'devices/anomalies.ts': { gap: '#6777' },
  'devices/billing.ts': { gap: '#6784' },
  'devices/bootMetrics.ts': { tools: ['analyze_boot_performance', 'manage_startup_items'] },
  'devices/bulkLifecycle.ts': { exempt: 'human_only_bulk_destructive', note: 'Bulk restore / permanent-delete; the single-item equivalents already have tools.' },
  'devices/commands.ts': { tools: ['registry_operations', 'execute_command', 'trigger_agent_restart', 'trigger_agent_upgrade'] },
  'devices/core.ts': { tools: ['query_devices', 'get_device_details', 'get_device_context', 'set_device_context', 'resolve_device_context', 'manage_tags'] },
  'devices/customFieldImport.ts': { exempt: 'ui_file_transfer', note: 'CSV import preview/commit -- a browser file flow.' },
  'devices/customFieldValues.ts': { tools: ['query_custom_fields'] },
  'devices/diagnose.ts': { tools: ['take_screenshot', 'get_device_context'] },
  'devices/diagnosticLogs.ts': { tools: ['search_agent_logs'] },
  'devices/eventlogs.ts': { tools: ['search_logs', 'get_log_trends', 'detect_log_correlations'] },
  'devices/events.ts': { gap: '#6783' },
  'devices/filesystem.ts': { tools: ['analyze_disk_usage', 'disk_cleanup'] },
  // list/run/status are the same OS-native cleanup workflow as the `system_cleanup`
  // AI tool (W05 gap triage). The route's cancel endpoint (#6485 F-5) has no
  // matching `system_cleanup` action yet -- a small future addition, not a
  // fresh MCP_COVERAGE gap.
  'devices/filesystemSystemCleanup.ts': { tools: ['system_cleanup'] },
  'devices/function.ts': { gap: '#6783' },
  'devices/groups.ts': { tools: ['manage_groups'] },
  'devices/hardware.ts': { tools: ['get_ip_history', 'get_device_details'] },
  'devices/hardwareHealth.ts': { tools: ['get_device_hardware_health'] },
  'devices/health.ts': { gap: '#6783' },
  'devices/helpers.ts': { exempt: 'internal_plumbing', note: 'Authorization/helper or router composition module; the textual scanner matches context access, not a standalone endpoint.' },
  'devices/homebrewBootstrap.ts': { gap: '#6782' },
  'devices/links.ts': { gap: '#6783' },
  'devices/manual.ts': { gap: '#6783' },
  'devices/metrics.ts': { tools: ['analyze_metrics', 'analyze_fleet_metrics'] },
  // GET /devices/:id/monitors (#6371 W05c2): the same per-device monitor state
  // is agent-reachable per monitor via get_monitor_activity's deviceId filter.
  'devices/monitors.ts': { tools: ['list_monitors', 'get_monitor_activity', 'reset_monitor_escalation'] },
  'devices/moveOrg.ts': { exempt: 'human_only_tenant_restructure', note: 'Cross-tenant device move -- rewrites which tenant owns the device.' },
  'devices/network.ts': { tools: ['list_network_assets'] },
  'devices/options.ts': { exempt: 'internal_plumbing' },
  'devices/patches.ts': { tools: ['manage_patches'] },
  'devices/posture.ts': { gap: '#6783' },
  'devices/processSamples.ts': { gap: '#6783' },
  'devices/provision.ts': { exempt: 'identity' },
  'devices/removalConfig.ts': { exempt: 'internal_plumbing' },
  'devices/scripts.ts': { tools: ['run_script', 'get_script_execution_history'] },
  'devices/sessions.ts': { tools: ['get_active_users', 'get_user_experience_metrics'] },
  'devices/software.ts': { gap: '#6782' },
  'devices/softwareActions.ts': { gap: '#6782' },
  'devices/stats.ts': { gap: '#6797' },
  'devices/tabCounts.ts': { exempt: 'internal_plumbing' },
  'devices/warranty.ts': { gap: '#6783' },
  'devices/watchdogLogs.ts': { gap: '#6783' },
  'discovery.ts': { tools: ['list_network_assets', 'get_network_asset', 'network_discovery', 'get_network_asset_reachability'] },
  'discoveryAssetProbe.ts': { gap: '#6779' },
  'dnsSecurity.ts': { tools: ['get_dns_security', 'manage_dns_policy'] },
  'docs.ts': { tools: ['search_documentation'] },
  'dr.ts': { tools: ['query_dr_plans', 'get_dr_plan_details', 'get_dr_execution_status', 'execute_dr_plan', 'manage_dr_plan'] },
  'enrollmentKeys.ts': { exempt: 'identity' },
  'eventWs.ts': { exempt: 'internal_plumbing', note: 'WebSocket/HTTP transport for event, remote-session or tunnel traffic.' },
  'extensionsAdmin.ts': { exempt: 'platform_admin', note: 'Extension runtime administration is platform-admin gated.' },
  'extensionsWeb.ts': { exempt: 'internal_plumbing', note: 'Extension frontend registry and signed static asset delivery.' },
  'externalServices.ts': { exempt: 'breeze_account', note: 'The partner\'s Breeze billing portal and support forward.' },
  'filters.ts': { tools: ['manage_saved_filters'] },
  'fleetDesign.ts': { gap: '#6780' },
  'fleetFindings.ts': { tools: ['get_fleet_findings'] },
  'google.ts': { exempt: 'vendor_console_admin' },
  'groups.ts': { tools: ['manage_groups'] },
  'helper/index.ts': { exempt: 'device_helper' },
  'huntress.ts': { tools: ['get_huntress_status', 'get_huntress_incidents', 'sync_huntress_data'] },
  'incidentActions.ts': { tools: ['execute_containment'] },
  'incidents.ts': { tools: ['list_incidents', 'create_incident', 'execute_containment', 'collect_evidence', 'get_incident_timeline', 'generate_incident_report'] },
  'installer.ts': { exempt: 'internal_plumbing' },
  'integrations.ts': { exempt: 'vendor_console_admin' },
  'internal/synthetic.ts': { exempt: 'internal_plumbing', note: 'Internal synthetic monitoring and canary cleanup endpoints.' },
  'invoices/assembly.ts': { tools: ['manage_invoices'] },
  'invoices/bulk.ts': { exempt: 'human_only_bulk_destructive', note: 'Bulk delete/issue/void; the single-item equivalents already have tools.' },
  'invoices/evidence.ts': { gap: '#6784' },
  'invoices/invoices.ts': { tools: ['list_invoices', 'get_invoice', 'manage_invoices'] },
  'invoices/lifecycle.ts': { tools: ['manage_invoices'] },
  'invoices/payments.ts': { tools: ['manage_invoices'] },
  'invoices/pdf.ts': { gap: '#6798' },
  'invoices/settings.ts': { gap: '#6784' },
  'invoices/stripe.ts': { tools: ['manage_invoices'] },
  'invoicesPublic.ts': { exempt: 'portal' },
  'lifecycle.ts': { exempt: 'identity' },
  'logs.ts': { tools: ['search_logs', 'get_log_trends', 'detect_log_correlations'] },
  'm365.ts': { exempt: 'vendor_console_admin' },
  'm365CustomerGraphActions.ts': { exempt: 'vendor_console_admin' },
  'm365CustomerGraphRead.ts': { tools: ['m365_query_users', 'm365_query_signins', 'm365_query_intune_devices', 'm365_query_groups', 'm365_query_org', 'm365_query_sites'] },
  'maintenance.ts': { tools: ['manage_maintenance_windows'] },
  'mcpServer.ts': { exempt: 'mcp_transport' },
  'metrics.ts': { exempt: 'internal_plumbing' },
  'mobile.ts': { exempt: 'mobile_surface', note: 'The mobile app\'s aggregate API, analogous to addin_surface. Its actions duplicate manage_alerts and device tools.' },
  'monitorDefinitions.conversion.ts': { exempt: 'human_only_migration', note: 'Legacy-to-monitor conversion (#6370): preview/convert/revert/retire are MFA- and governance-gated one-time migration actions a technician runs from the UI; the spec assigns them no AI tool.' },
  'monitorDefinitions.ts': { tools: ['list_monitors', 'get_monitor', 'get_monitor_activity', 'reset_monitor_escalation', 'manage_monitor_definitions'] },
  'monitoring.ts': { tools: ['query_monitors', 'get_service_monitoring_status'] },
  'monitoringAssetMetrics.ts': { gap: '#6779' },
  'monitors.ts': { tools: ['query_monitors', 'manage_monitors'] },
  'networkBaselines.ts': { tools: ['configure_network_baseline'] },
  'networkChanges.ts': { tools: ['get_network_changes', 'acknowledge_network_device'] },
  'networkKnownGuests.ts': { gap: '#6779' },
  'notifications.ts': { gap: '#6799' },
  'oauth.ts': { exempt: 'identity' },
  'oauthInteraction.ts': { exempt: 'identity' },
  'oauthWellKnown.ts': { exempt: 'identity' },
  'officeAddin/auth.ts': { exempt: 'addin_surface' },
  'officeAddin/bindingsAdmin.ts': { exempt: 'addin_surface' },
  'officeAddin/emailContext.ts': { exempt: 'addin_surface' },
  'officeAddin/tickets.ts': { exempt: 'addin_surface' },
  'officeAddin/time.ts': { exempt: 'addin_surface' },
  'onedrive.ts': { gap: '#6800' },
  'orgAccountReadiness.ts': { gap: '#6789' },
  'orgArchive.ts': { exempt: 'human_only_tenant_restructure', note: 'Archive/restore an organization -- tenant-restructure decision.' },
  'orgAuditRetentionSettings.ts': { gap: '#6789' },
  // Per-org billing profile read/write/delete; no AI tool surfaces it yet.
  'orgBillingProfile.ts': { gap: '#6784' },
  'orgContacts.ts': { tools: ['list_org_contacts', 'manage_organizations'] },
  'orgDocuments.ts': { tools: ['list_org_documents', 'manage_org_documents'] },
  'orgKeyDates.ts': { tools: ['manage_key_dates'] },
  'orgMerge.ts': { exempt: 'human_only_tenant_restructure', note: 'Org merge preview/merge/run status -- rewrites which tenant owns the data.' },
  'orgPortalSettings.ts': { gap: '#6789' },
  'orgPortalUsers.ts': { gap: '#6789' },
  'orgSummary.ts': { gap: '#6789' },
  'orgTicketSettings.ts': { gap: '#6776' },
  'orgs.ts': { tools: ['list_sites', 'get_site', 'list_organizations', 'manage_organizations'] },
  'packageSearch.ts': { gap: '#6782' },
  'pam.ts': { tools: ['request_elevation', 'revoke_elevation', 'get_elevation_history'] },
  'partner.ts': { gap: '#6801' },
  'partnerAiScriptPolicy.ts': { exempt: 'human_only_ai_governance', note: 'Partner-wide ceiling on the unattended AI lane -- the AI must not widen its own authority.' },
  'partnerApi/alerts.ts': { exempt: 'partner_api_surface', note: 'Machine-to-machine Partner API for service principals (#3243); duplicates in-product reads that already have tools.' },
  'partnerApi/audit.ts': { exempt: 'internal_plumbing', note: 'Authorization/helper or router composition module; the textual scanner matches context access, not a standalone endpoint.' },
  'partnerApi/configuration.ts': { exempt: 'partner_api_surface', note: 'Machine-to-machine Partner API for service principals (#3243); duplicates in-product reads that already have tools.' },
  'partnerApi/contracts.ts': { exempt: 'partner_api_surface', note: 'Machine-to-machine Partner API for service principals (#3243); duplicates in-product reads that already have tools.' },
  'partnerApi/devices.ts': { exempt: 'partner_api_surface', note: 'Machine-to-machine Partner API for service principals (#3243); duplicates in-product reads that already have tools.' },
  'partnerApi/inventory.ts': { exempt: 'partner_api_surface', note: 'Machine-to-machine Partner API for service principals (#3243); duplicates in-product reads that already have tools.' },
  'partnerApi/organizations.ts': { exempt: 'partner_api_surface', note: 'Machine-to-machine Partner API for service principals (#3243); duplicates in-product reads that already have tools.' },
  'partnerApi/provisioning.ts': { exempt: 'partner_api_surface', note: 'Machine-to-machine Partner API for service principals (#3243); duplicates in-product reads that already have tools.' },
  'partnerApi/relationships.ts': { exempt: 'partner_api_surface', note: 'Machine-to-machine Partner API for service principals (#3243); duplicates in-product reads that already have tools.' },
  'partnerLoginBranding.ts': { gap: '#6802' },
  'partnerSendingDomains.ts': { gap: '#6803' },
  'partnerServicePrincipals.ts': { exempt: 'identity' },
  'partnerTrust.ts': { exempt: 'breeze_account', note: 'Trust review request to Breeze -- the partner-Breeze relationship itself.' },
  'patchPlan.ts': { gap: '#6786' },
  'patchPolicies.ts': { gap: '#6804' },
  'patches/appOptions.ts': { exempt: 'internal_plumbing' },
  'patches/approvals.ts': { tools: ['manage_patches'] },
  'patches/compliance.ts': { tools: ['manage_patches'] },
  'patches/list.ts': { tools: ['manage_patches'] },
  'patches/operations.ts': { tools: ['manage_patches'] },
  'pax8.ts': { gap: '#6785' },
  'pax8Orders.ts': { gap: '#6785' },
  'peripheralControl.ts': { tools: ['manage_peripheral_policies', 'get_peripheral_activity', 'manage_peripheral_policy'] },
  'permissionsCatalog.ts': { exempt: 'identity' },
  'playbooks.ts': { tools: ['list_playbooks', 'execute_playbook', 'get_playbook_history'] },
  'plugins.ts': { gap: '#6805' },
  'policyManagement/actions.ts': { gap: '#6781' },
  'policyManagement/compliance.ts': { tools: ['get_compliance_status'] },
  'policyManagement/crud.ts': { tools: ['query_compliance_policies'] },
  'portal/assets.ts': { exempt: 'portal' },
  'portal/auth.ts': { exempt: 'portal' },
  'portal/backups.ts': { exempt: 'portal' },
  'portal/branding.ts': { exempt: 'portal' },
  'portal/dashboard.ts': { exempt: 'portal' },
  'portal/devices.ts': { exempt: 'portal' },
  'portal/documents.ts': { exempt: 'portal' },
  'portal/featureFlags.ts': { exempt: 'portal' },
  'portal/helpers.ts': { exempt: 'portal' },
  'portal/invoices.ts': { exempt: 'portal' },
  'portal/network.ts': { exempt: 'portal' },
  'portal/profile.ts': { exempt: 'portal' },
  'portal/quotes.ts': { exempt: 'portal' },
  'portal/reports.ts': { exempt: 'portal' },
  'portal/security.ts': { exempt: 'portal' },
  'portal/service.ts': { exempt: 'portal' },
  'portal/tickets.ts': { exempt: 'portal' },
  'psa.ts': { tools: ['query_psa_status'] },
  'quotes/acceptanceEvidence.ts': { exempt: 'human_only_legal_evidence', note: 'Upload/download of the evidence file behind an on-behalf quote acceptance (#6633); the acceptance itself has no AI tool by design.' },
  'quotes/bulk.ts': { exempt: 'human_only_bulk_destructive', note: 'Bulk delete/send; the single-item equivalents already have tools.' },
  'quotes/lifecycle.ts': { tools: ['manage_quotes'] },
  'quotes/quotes.ts': { tools: ['list_quotes', 'get_quote', 'manage_quotes'] },
  'quotesPublic.ts': { exempt: 'portal' },
  'reliability.ts': { gap: '#6777' },
  'remediationSuggestions.ts': { tools: ['list_remediation_suggestions'] },
  'remote/index.ts': { exempt: 'internal_plumbing' },
  'remote/sessions.ts': { tools: ['create_remote_session', 'list_remote_sessions'] },
  'remote/supportSessions.ts': { gap: '#6783' },
  'reports/core.ts': { tools: ['generate_report'] },
  'reports/data.ts': { tools: ['generate_report'] },
  'reports/generate.ts': { tools: ['generate_report'] },
  'reports/recipients.ts': { gap: '#6789' },
  'reports/runs.ts': { tools: ['generate_report'] },
  'roles.ts': { gap: '#6789' },
  'scriptAi.ts': { exempt: 'ai_transport' },
  'scriptBundle.ts': { gap: '#6806' },
  'scriptLibrary.ts': { tools: ['search_script_library'] },
  'scripts.ts': { tools: ['list_scripts', 'get_script_details', 'run_script', 'cancel_script_execution', 'get_script_execution_history', 'get_script_execution', 'list_script_templates'] },
  'search.ts': { exempt: 'internal_plumbing' },
  'security/compliance.ts': { gap: '#6781' },
  'security/dashboard.ts': { gap: '#6781' },
  'security/helpers.ts': { exempt: 'internal_plumbing', note: 'Authorization/helper or router composition module; the textual scanner matches context access, not a standalone endpoint.' },
  'security/policies.ts': { gap: '#6781' },
  'security/posture.ts': { tools: ['get_security_posture'] },
  'security/readAuthorization.ts': { exempt: 'internal_plumbing', note: 'Authorization/helper or router composition module; the textual scanner matches context access, not a standalone endpoint.' },
  'security/recommendations.ts': { gap: '#6781' },
  'security/recoveryKeys.ts': { gap: '#6781' },
  'security/scans.ts': { tools: ['security_scan'] },
  'security/status.ts': { gap: '#6781' },
  'security/threats.ts': { tools: ['security_scan'] },
  'sensitiveData.ts': { tools: ['get_sensitive_data_overview', 'remediate_sensitive_data'] },
  'sentinelOne.ts': { tools: ['get_s1_status', 'get_s1_threats', 's1_isolate_device', 's1_threat_action'] },
  'serviceDeliverables.ts': { tools: ['list_deliverables', 'manage_deliverables'] },
  'servicePrincipals.ts': { exempt: 'identity' },
  'snmp.ts': { gap: '#6779' },
  'software.ts': { gap: '#6782' },
  'softwareInstallMethods.ts': { gap: '#6782' },
  'softwareInventory.ts': { gap: '#6782' },
  'softwarePolicies.ts': { tools: ['get_software_compliance', 'manage_software_policy', 'manage_software_policies', 'remediate_software_violation'] },
  'softwareUploads.ts': { exempt: 'ui_file_transfer', note: 'Chunked binary upload -- a browser file flow.' },
  'sso.ts': { exempt: 'identity' },
  'stripeConnect/index.ts': { exempt: 'vendor_console_admin' },
  'supportPublic.ts': { exempt: 'portal' },
  'system.ts': { gap: '#6807' },
  'systemTools/eventLogs.ts': { gap: '#6783' },
  'systemTools/fileBrowser.ts': { tools: ['file_operations'] },
  'systemTools/helpers.ts': { exempt: 'internal_plumbing', note: 'Authorization/helper or router composition module; the textual scanner matches context access, not a standalone endpoint.' },
  'systemTools/index.ts': { exempt: 'internal_plumbing', note: 'Authorization/helper or router composition module; the textual scanner matches context access, not a standalone endpoint.' },
  'systemTools/processes.ts': { tools: ['manage_processes'] },
  'systemTools/registry.ts': { tools: ['registry_operations'] },
  'systemTools/scheduledTasks.ts': { tools: ['manage_scheduled_tasks'] },
  'systemTools/services.ts': { tools: ['manage_services'] },
  'tags.ts': { tools: ['manage_tags'] },
  'tenantVariables.ts': { gap: '#6783' },
  'terminalWs.ts': { exempt: 'internal_plumbing', note: 'WebSocket/HTTP transport for event, remote-session or tunnel traffic.' },
  'thirdPartyCatalog/list.ts': { exempt: 'platform_admin', note: 'Behind platformAdminMiddleware (mis-registered as a gap).' },
  'thirdPartyCatalog/operations.ts': { exempt: 'platform_admin', note: 'Behind platformAdminMiddleware (mis-registered as a gap).' },
  'ticketCategories.ts': { gap: '#6776' },
  'ticketChecklistTemplates.ts': { gap: '#6776' },
  'ticketConfig.ts': { gap: '#6776' },
  'tickets/aiDrafts.ts': { tools: ['manage_tickets'] },
  'tickets/attachments.ts': { gap: '#6776' },
  'tickets/bulk.ts': { gap: '#6776' },
  'tickets/checklist.ts': { tools: ['manage_tickets'] },
  'tickets/emailWebhook.ts': { exempt: 'inbound_integration', note: 'Inbound ticket email delivery callback.' },
  'tickets/export.ts': { gap: '#6808' },
  'tickets/forms.ts': { gap: '#6776' },
  'tickets/index.ts': { exempt: 'internal_plumbing', note: 'Authorization/helper or router composition module; the textual scanner matches context access, not a standalone endpoint.' },
  'tickets/mailboxConnect.ts': { exempt: 'vendor_console_admin' },
  'tickets/moveOrg.ts': { tools: ['manage_tickets'] },
  'tickets/parts.ts': { tools: ['list_time_entries'] },
  'tickets/ticketResponseTemplates.ts': { gap: '#6776' },
  'tickets/tickets.ts': { tools: ['manage_tickets'] },
  'timeEntries/index.ts': { exempt: 'internal_plumbing', note: 'Authorization/helper or router composition module; the textual scanner matches context access, not a standalone endpoint.' },
  'timeEntries/suggestions.ts': { gap: '#6776' },
  'timeEntries/timeEntries.ts': { tools: ['list_time_entries', 'get_running_timer', 'get_timesheet', 'manage_tickets'] },
  'toolSources.ts': { exempt: 'human_only_ai_governance', note: 'BYO MCP tool sources and per-tool tier/enable -- the AI must not widen its own tool authority.' },
  // Collector selection and diagnostic run lifecycle have no registered AI tool.
  'topology/diagnostics.ts': { gap: '#6778' },
  'topology/graphs.ts': { gap: '#6778' },
  'topology/layouts.ts': { exempt: 'internal_plumbing' },
  'topology/manual.ts': { gap: '#6778' },
  'topology/middleware.ts': { exempt: 'internal_plumbing', note: 'Authorization/helper or router composition module; the textual scanner matches context access, not a standalone endpoint.' },
  'topology/mutations.ts': { exempt: 'internal_plumbing', note: 'Authorization/helper or router composition module; the textual scanner matches context access, not a standalone endpoint.' },
  // Shared permission middleware and response/error wrappers register no endpoints.
  'topology/operations.ts': { exempt: 'internal_plumbing' },
  // Topology monitoring policy CRUD has no registered AI tool.
  'topology/policies.ts': { gap: '#6778' },
  'topology/settings.ts': { gap: '#6778' },
  // Topology probe target CRUD has no registered AI tool.
  'topology/targets.ts': { gap: '#6778' },
  // Template application preview, execution and status have no registered AI tool.
  'topology/templateApplications.ts': { gap: '#6778' },
  // The topology template library and version publishing have no registered AI tool.
  'topology/templates.ts': { gap: '#6778' },
  'tunnelHttp.ts': { exempt: 'internal_plumbing', note: 'WebSocket/HTTP transport for event, remote-session or tunnel traffic.' },
  'tunnelWs.ts': { exempt: 'internal_plumbing', note: 'WebSocket/HTTP transport for event, remote-session or tunnel traffic.' },
  'tunnels.ts': { exempt: 'internal_plumbing' },
  'unifi/index.ts': { gap: '#6779' },
  'updateRings.ts': { tools: ['manage_update_rings'] },
  'userRisk.ts': { tools: ['get_fleet_health', 'get_user_risk_scores', 'get_user_risk_detail', 'assign_security_training'] },
  'users.ts': { gap: '#6789' },
  'viewers/download.ts': { exempt: 'internal_plumbing' },
  'vulnerabilities.ts': { tools: ['get_vulnerability_report', 'get_device_vulnerabilities', 'remediate_vulnerability'] },
  'webhooks.ts': { tools: ['query_webhooks', 'test_webhook'] },
  'webhooks/emailProvider.ts': { exempt: 'inbound_integration' },
  'webhooks/quickbooks.ts': { exempt: 'inbound_integration' },
  'webhooks/stripe.ts': { exempt: 'inbound_integration' },
};
