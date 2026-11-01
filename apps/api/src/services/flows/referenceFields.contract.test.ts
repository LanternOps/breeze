import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { toolInputSchemas } from '../aiToolSchemas';
import { aiTools } from '../aiTools';
import { FLOW_OWNED_REFERENCE_FIELDS, listFlowEligibleCoreTools } from './catalog';

/**
 * Tool Catalog W03 (#5218), spec §6.3 rule 6. A flow step's literal ids are
 * checked against the flow OWNER at save time only when the validator knows
 * what they name: devices (`deviceArgs`) and FLOW_OWNED_REFERENCE_FIELDS.
 * Every other top-level uuid input of a flow-eligible core tool is listed
 * below, so a NEW id-typed field forces a decision (classify it, or add it
 * here with the reason the tool's own runtime authorization covers it).
 * Shrink-only: classifying an entry removes it from this list.
 */
type Def = { type?: string; format?: string; innerType?: unknown; in?: unknown; element?: unknown; checks?: unknown[]; shape?: unknown };

function def(s: unknown): Def {
  return ((s as { _zod?: { def?: Def } })?._zod?.def ?? {}) as Def;
}

function unwrap(s: unknown): unknown {
  let cur = s;
  for (let i = 0; i < 10; i++) {
    const d = def(cur);
    if (d.type === 'optional' || d.type === 'nullable' || d.type === 'default' || d.type === 'readonly' || d.type === 'prefault') cur = d.innerType;
    else if (d.type === 'pipe') cur = d.in;
    else break;
  }
  return cur;
}

function isUuid(s: unknown): boolean {
  const d = def(unwrap(s));
  if (d.type !== 'string') return false;
  if (d.format === 'uuid' || d.format === 'guid') return true;
  return (d.checks ?? []).some((c) => {
    const cd = def(c) as Def & { format?: string };
    return cd.format === 'uuid' || cd.format === 'guid';
  });
}

function isUuidOrUuidArray(s: unknown): boolean {
  const u = unwrap(s);
  const d = def(u);
  if (d.type === 'array') return isUuid(d.element);
  return isUuid(u);
}

function topLevelShape(schema: z.ZodType): Record<string, unknown> {
  const d = def(unwrap(schema));
  return d.type === 'object' && d.shape && typeof d.shape === 'object' ? (d.shape as Record<string, unknown>) : {};
}

function unclassifiedIdFields(): string[] {
  const out: string[] = [];
  for (const name of listFlowEligibleCoreTools()) {
    const schema = toolInputSchemas[name];
    if (!schema) continue;
    const deviceArgs = new Set(aiTools.get(name)?.deviceArgs ?? []);
    const owned = FLOW_OWNED_REFERENCE_FIELDS[name] ?? {};
    for (const [key, field] of Object.entries(topLevelShape(schema))) {
      if (deviceArgs.has(key) || key in owned) continue;
      if (isUuidOrUuidArray(field)) out.push(`${name}.${key}`);
    }
  }
  return out.sort();
}

describe('flow-eligible core tools: id-typed inputs are classified', () => {
  it('the introspection sees the known classified fields (guards against a vacuous scan)', () => {
    const shape = topLevelShape(toolInputSchemas.run_script!);
    expect(isUuid(shape.scriptId)).toBe(true);
    expect(isUuidOrUuidArray(shape.deviceIds)).toBe(true);
    expect(aiTools.get('run_script')?.deviceArgs).toContain('deviceIds');
  });

  it('every flow-eligible core tool has a Zod input schema (the validator refuses one that does not)', () => {
    expect(listFlowEligibleCoreTools().filter((name) => !toolInputSchemas[name])).toEqual([]);
  });

  // Full-control W02 (#6756) added the PSA/billing write tools' ids
  // (manage_tickets, manage_quotes, manage_billing_catalog,
  // manage_notification_channels, manage_saved_filters, test_webhook): each
  // handler re-checks org/partner/site reach at run time (see the
  // aiTools*WritesScope integration suites). Save-time owner checks for them
  // need new FLOW_OWNED_REFERENCE_FIELDS kinds — a follow-up, flows are flag-off.
  // Full-control W04 (#6758) added the security, incident and device-operation
  // write tools' ids (incidents, elevation requests, findings, policies,
  // baselines, network change events, users) on the same terms, pinned by
  // aiToolsIncidentPamRemoteWritesScope / aiToolsPolicyWritesScope /
  // aiToolsDeviceOpsWritesSiteScope; every tier-3 action needs approval when a
  // flow runs it. create_incident.relatedAlertIds is stored without an
  // org check on both the tool and the route (a recorded follow-up).
  // Full-control W03 (#6757) added the backup/DR/Hyper-V write tools' ids
  // (snapshots, VMs, DR plans/groups, vaults, profiles, SLA and C2C configs) on
  // the same terms: every handler re-checks org/site reach at run time, pinned
  // by aiToolsBackupWritesSiteScope / aiToolsDrHypervWritesScope /
  // aiToolsBackupProfilesScope. Every one of their tier-3 actions also needs
  // approval when a flow runs it.
  // recall / remember (Wisp W03) and the W05a concern tools (list_concerns, raise_concern,
  // snooze_concern, resolve_concern, create_watch) are absent: they refuse outright without
  // auth.wispGrant, which a flow step never carries, so W05 excludes them from flows
  // (FLOW_EXCLUDED_CORE_TOOLS). Same for the W08 link tools (link_entity.id /
  // link_entity.orgId are id-typed, but link_entity never runs in a flow).
  // #10396 added search_agent_logs.orgId: resolveReadableToolOrgScope re-checks
  // it against auth.canAccessOrg at run time and refuses an org outside reach.
  // #10161: manage_tickets.intoTicketId uses findTicketWithAccess for org +
  // device/site authorization of the survivor, as ticketId does for the source.
  // system_cleanup cancel reuses the already-listed cleanupRunId: verifyDeviceAccess
  // gates the device, then cancelSystemCleanupRun scopes the run by device/org/kind.
  it('matches the frozen list of id fields left to the tool\'s own runtime authorization', () => {
    expect(unclassifiedIdFields()).toMatchInlineSnapshot(`
      [
        "acknowledge_network_device.event_id",
        "analyze_fleet_metrics.orgId",
        "apply_cis_remediation.baselineId",
        "apply_cis_remediation.baselineResultId",
        "apply_configuration_policy.configPolicyId",
        "apply_configuration_policy.targetId",
        "assign_security_training.orgId",
        "assign_security_training.userId",
        "cancel_script_execution.executionId",
        "collect_evidence.incidentId",
        "configuration_policy_compliance.policyId",
        "configure_backup_sla.configId",
        "configure_backup_sla.orgId",
        "configure_backup_sla.targetGroups",
        "configure_network_baseline.baseline_id",
        "configure_network_baseline.org_id",
        "configure_network_baseline.site_id",
        "configure_vault.vaultId",
        "create_incident.relatedAlertIds",
        "delete_tenant.tenant_id",
        "detect_log_correlations.orgId",
        "diagnose_connectivity.origin_device_id",
        "diagnose_connectivity.site_id",
        "disk_cleanup.cleanupRunId",
        "edr_endpoint_action.connectionId",
        "execute_containment.incidentId",
        "execute_dr_plan.planId",
        "execute_playbook.playbookId",
        "export_dataset.siteId",
        "find_proven_fixes.alertId",
        "find_proven_fixes.anomalyEpisodeId",
        "generate_incident_report.incidentId",
        "generate_report.orgId",
        "generate_report.reportId",
        "generate_report.reportRunId",
        "get_ai_agent_run.runId",
        "get_alert_correlations.alertId",
        "get_alert_correlations.alertIds",
        "get_alert_correlations.groupId",
        "get_alert_correlations.orgId",
        "get_browser_security.orgId",
        "get_catalog_item.catalogItemId",
        "get_cis_compliance.baselineId",
        "get_cis_compliance.orgId",
        "get_cis_device_report.baselineId",
        "get_compliance_status.policyId",
        "get_configuration_policy.policyId",
        "get_contract.contractId",
        "get_contract.periodId",
        "get_device_ai_activity.sourceId",
        "get_diagnostic_run.run_id",
        "get_diagnostic_run.site_id",
        "get_dns_security.integrationId",
        "get_dr_execution_status.executionId",
        "get_dr_execution_status.planId",
        "get_dr_plan_details.planId",
        "get_edr_status.orgId",
        "get_fleet_design.reportRunId",
        "get_fleet_device_stats.orgId",
        "get_fleet_findings.orgId",
        "get_fleet_health.orgId",
        "get_fleet_health.siteId",
        "get_huntress_agents.integrationId",
        "get_huntress_agents.orgId",
        "get_huntress_incidents.incidentId",
        "get_huntress_incidents.integrationId",
        "get_huntress_incidents.orgId",
        "get_huntress_status.integrationId",
        "get_huntress_status.orgId",
        "get_hyperv_vm_details.vmId",
        "get_incident_timeline.incidentId",
        "get_interface_history.interface_id",
        "get_interface_history.site_id",
        "get_invoice.invoiceId",
        "get_invoice.lineId",
        "get_link_evidence.relationship_id",
        "get_link_evidence.site_id",
        "get_link_health.relationship_id",
        "get_link_health.site_id",
        "get_log_trends.siteIds",
        "get_management_posture.orgId",
        "get_monitor.monitorId",
        "get_monitor_activity.monitorId",
        "get_network_asset.assetId",
        "get_network_asset_reachability.asset_id",
        "get_network_changes.baseline_id",
        "get_network_changes.org_id",
        "get_network_changes.site_id",
        "get_pax8_status.integrationId",
        "get_pax8_status.partnerId",
        "get_peripheral_activity.org_id",
        "get_peripheral_activity.policy_id",
        "get_playbook_history.playbookId",
        "get_quote.quoteId",
        "get_recent_network_changes.site_id",
        "get_s1_status.orgId",
        "get_s1_threats.orgId",
        "get_script_details.scriptId",
        "get_script_execution.executionId",
        "get_script_execution_history.scriptId",
        "get_script_proposal.proposalId",
        "get_security_compliance.orgId",
        "get_security_posture.orgId",
        "get_site.siteId",
        "get_sla_breaches.configId",
        "get_snmp_metrics.assetId",
        "get_snmp_metrics.orgId",
        "get_software_compliance.policyId",
        "get_ticket_approval_status.ticketId",
        "get_timesheet.userId",
        "get_topology.focus_node_id",
        "get_topology.site_id",
        "get_topology_impact.site_id",
        "get_topology_impact.subject_id",
        "get_topology_monitoring_status.site_id",
        "get_trust_page_status.orgId",
        "get_vm_restore_estimate.snapshotId",
        "instant_boot_vm.snapshotId",
        "list_ai_agent_runs.agentId",
        "list_ai_agent_runs.orgId",
        "list_ai_agent_schedules.agentId",
        "list_ai_agent_schedules.orgId",
        "list_business_calendars.orgId",
        "list_contracts.cursor",
        "list_contracts.orgId",
        "list_deliverable_templates.orgId",
        "list_deliverables.contractId",
        "list_deliverables.occurrencesFor",
        "list_deliverables.orgId",
        "list_edr_detections.orgId",
        "list_fleet_designs.orgId",
        "list_incidents.assignedTo",
        "list_incidents.orgId",
        "list_invoices.orgId",
        "list_network_assets.orgId",
        "list_network_assets.siteId",
        "list_org_contacts.orgId",
        "list_org_documents.orgId",
        "list_quotes.orgId",
        "list_remediation_suggestions.orgId",
        "list_sites.orgId",
        "list_ticket_routing_rules.orgId",
        "list_time_entries.orgId",
        "list_time_entries.ticketId",
        "list_time_entries.userId",
        "list_time_sync_issues.orgId",
        "list_time_sync_issues.siteId",
        "m365_query_groups.orgId",
        "m365_query_intune_devices.orgId",
        "m365_query_org.orgId",
        "m365_query_sites.orgId",
        "manage_accounting_sync.entityId",
        "manage_accounting_sync.invoiceId",
        "manage_accounting_sync.invoiceIds",
        "manage_alert_rules.ruleId",
        "manage_alerts.alertId",
        "manage_audit_baselines.baselineId",
        "manage_audit_baselines.orgId",
        "manage_automations.automationId",
        "manage_backup_configs.configId",
        "manage_backup_configs.orgId",
        "manage_backup_profiles.orgId",
        "manage_backup_profiles.profileId",
        "manage_billing_catalog.catalogId",
        "manage_billing_catalog.orgId",
        "manage_billing_profiles.orgId",
        "manage_billing_profiles.profileId",
        "manage_billing_profiles.workTypeId",
        "manage_billing_settings.orgId",
        "manage_browser_policy.orgId",
        "manage_browser_policy.policyId",
        "manage_compliance_policies.policyId",
        "manage_configuration_policy.orgId",
        "manage_configuration_policy.policyId",
        "manage_contract_documents.contractId",
        "manage_contract_documents.documentId",
        "manage_contract_documents.orgId",
        "manage_contract_templates.orgId",
        "manage_contract_templates.templateId",
        "manage_contract_templates.versionId",
        "manage_contracts.contractId",
        "manage_contracts.lineId",
        "manage_deliverables.contractId",
        "manage_deliverables.deliverableId",
        "manage_deliverables.documentId",
        "manage_deliverables.occurrenceId",
        "manage_deliverables.orgId",
        "manage_deliverables.ownerUserId",
        "manage_deliverables.reportRunId",
        "manage_deliverables.setId",
        "manage_delivery.id",
        "manage_delivery.monitorId",
        "manage_delivery.orgId",
        "manage_delivery.siteId",
        "manage_deployments.deploymentId",
        "manage_deployments.orgId",
        "manage_device_anomalies.anomalyId",
        "manage_device_links.groupId",
        "manage_dns_policy.integrationId",
        "manage_dr_plan.dependsOnGroupId",
        "manage_dr_plan.groupId",
        "manage_dr_plan.orgId",
        "manage_dr_plan.planId",
        "manage_fleet_findings.findingId",
        "manage_groups.groupId",
        "manage_groups.orgId",
        "manage_groups.siteId",
        "manage_hyperv_checkpoints.vmId",
        "manage_hyperv_vm.vmId",
        "manage_invoices.bundleId",
        "manage_invoices.catalogItemId",
        "manage_invoices.contractId",
        "manage_invoices.contractLineId",
        "manage_invoices.invoiceId",
        "manage_invoices.lineId",
        "manage_invoices.orgId",
        "manage_invoices.paymentId",
        "manage_invoices.siteId",
        "manage_invoices.ticketId",
        "manage_key_dates.keyDateId",
        "manage_key_dates.orgId",
        "manage_maintenance_windows.groupIds",
        "manage_maintenance_windows.siteIds",
        "manage_maintenance_windows.windowId",
        "manage_manual_assets.assetId",
        "manage_manual_assets.assignedContactId",
        "manage_manual_assets.discoveredAssetId",
        "manage_manual_assets.orgId",
        "manage_manual_assets.siteId",
        "manage_monitor_definitions.attachmentId",
        "manage_monitor_definitions.configPolicyId",
        "manage_monitor_definitions.monitorId",
        "manage_monitors.monitorId",
        "manage_monitors.orgId",
        "manage_notification_channels.channelId",
        "manage_notification_channels.orgId",
        "manage_org_documents.documentId",
        "manage_org_documents.orgId",
        "manage_org_documents.supersedesDocumentId",
        "manage_organizations.orgId",
        "manage_organizations.siteId",
        "manage_patches.configPolicyId",
        "manage_patches.orgId",
        "manage_patches.patchId",
        "manage_patches.patchIds",
        "manage_patches.ringId",
        "manage_pax8_orders.lineId",
        "manage_pax8_orders.orderId",
        "manage_pax8_orders.orgId",
        "manage_pax8_orders.partnerId",
        "manage_pax8_subscriptions.contractLineId",
        "manage_pax8_subscriptions.integrationId",
        "manage_pax8_subscriptions.orgId",
        "manage_pax8_subscriptions.partnerId",
        "manage_pax8_subscriptions.subscriptionSnapshotId",
        "manage_peripheral_policies.orgId",
        "manage_peripheral_policies.policyId",
        "manage_peripheral_policy.org_id",
        "manage_peripheral_policy.policy_id",
        "manage_policy_feature_link.configPolicyId",
        "manage_policy_feature_link.featureLinkId",
        "manage_policy_feature_link.featurePolicyId",
        "manage_quotes.blockId",
        "manage_quotes.blockIds",
        "manage_quotes.catalogItemId",
        "manage_quotes.lineId",
        "manage_quotes.lineIds",
        "manage_quotes.quoteId",
        "manage_saved_filters.filterId",
        "manage_security_policies.orgId",
        "manage_security_policies.policyId",
        "manage_security_recommendations.orgId",
        "manage_service_monitors.configPolicyId",
        "manage_snmp_templates.orgId",
        "manage_snmp_templates.templateId",
        "manage_software_catalog.catalogId",
        "manage_software_catalog.methodId",
        "manage_software_catalog.orgId",
        "manage_software_catalog.versionId",
        "manage_software_deployments.catalogId",
        "manage_software_deployments.deploymentId",
        "manage_software_deployments.maintenanceWindowId",
        "manage_software_deployments.orgId",
        "manage_software_deployments.softwareVersionId",
        "manage_software_inventory.orgId",
        "manage_software_policies.orgId",
        "manage_software_policies.policyId",
        "manage_software_policy.orgId",
        "manage_software_policy.policyId",
        "manage_software_policy.targetIds",
        "manage_support_sessions.sessionId",
        "manage_tenant_variables.orgId",
        "manage_tenant_variables.variableId",
        "manage_ticket_attachments.artifactId",
        "manage_ticket_attachments.attachmentId",
        "manage_ticket_attachments.ticketId",
        "manage_ticket_checklist.itemId",
        "manage_ticket_checklist.itemIds",
        "manage_ticket_checklist.orgId",
        "manage_ticket_checklist.templateId",
        "manage_ticket_checklist.ticketId",
        "manage_ticket_checklist_templates.id",
        "manage_ticket_checklist_templates.itemId",
        "manage_ticket_checklist_templates.itemIds",
        "manage_ticket_checklist_templates.orgId",
        "manage_ticket_config.id",
        "manage_ticket_config.ids",
        "manage_ticket_config.orgId",
        "manage_ticket_forms.id",
        "manage_ticket_forms.orgId",
        "manage_ticket_inbox.id",
        "manage_ticket_inbox.orgId",
        "manage_ticket_response_templates.id",
        "manage_ticket_routing_rules.ids",
        "manage_ticket_routing_rules.matchCategoryId",
        "manage_ticket_routing_rules.orgId",
        "manage_ticket_routing_rules.orgIds",
        "manage_ticket_routing_rules.ruleId",
        "manage_ticket_routing_rules.setAssigneeUserId",
        "manage_ticket_routing_rules.setCategoryId",
        "manage_ticket_routing_rules.setStatusId",
        "manage_tickets.alertId",
        "manage_tickets.assigneeId",
        "manage_tickets.commentId",
        "manage_tickets.expectedTicketId",
        "manage_tickets.intoTicketId",
        "manage_tickets.linkId",
        "manage_tickets.orgId",
        "manage_tickets.targetOrgId",
        "manage_tickets.targetTicketId",
        "manage_tickets.ticketId",
        "manage_tickets.ticketIds",
        "manage_tickets.timeEntryId",
        "manage_update_rings.ringId",
        "preview_configuration_change.remove",
        "probe_network_asset.assetId",
        "propose_script.supersedesProposalId",
        "query_analytics.slaId",
        "query_audit_log.resourceId",
        "query_backups.configId",
        "query_devices.siteId",
        "query_psa_status.connectionId",
        "read_artifact.handle",
        "reliability_feedback.sourceEventId",
        "remediate_sensitive_data.findingIds",
        "remediate_software_violation.policyId",
        "remediate_vulnerability.deviceVulnerabilityIds",
        "remove_configuration_policy_assignment.assignmentId",
        "reset_monitor_escalation.monitorId",
        "resolve_device_context.contextId",
        "restore_c2c_items.itemIds",
        "restore_c2c_items.targetConnectionId",
        "restore_hyperv_vm.snapshotId",
        "restore_mssql_database.snapshotId",
        "restore_snapshot.snapshotId",
        "revoke_elevation.elevationRequestId",
        "run_script.proposalId",
        "s1_isolate_device.orgId",
        "s1_threat_action.orgId",
        "search_agent_logs.orgId",
        "search_logs.siteIds",
        "search_pax8_products.partnerId",
        "sync_edr_data.connectionId",
        "sync_edr_data.orgId",
        "sync_huntress_data.integrationId",
        "sync_huntress_data.orgId",
        "system_cleanup.cleanupRunId",
        "system_cleanup.commandId",
        "test_ticket_routing_rule.categoryId",
        "test_ticket_routing_rule.orgId",
        "test_webhook.webhookId",
        "trigger_backup.configId",
        "trigger_c2c_sync.configId",
        "trigger_hyperv_backup.vmId",
        "trigger_vault_sync.vaultId",
        "verify_mssql_backup.snapshotId",
        "workspace_run.stdinHandle",
        "workspace_stage.handles",
      ]
    `);
  });
});
