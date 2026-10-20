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

  it('matches the frozen list of id fields left to the tool\'s own runtime authorization', () => {
    expect(unclassifiedIdFields()).toMatchInlineSnapshot(`
      [
        "analyze_fleet_metrics.orgId",
        "apply_cis_remediation.baselineId",
        "apply_cis_remediation.baselineResultId",
        "apply_configuration_policy.configPolicyId",
        "apply_configuration_policy.targetId",
        "cancel_script_execution.executionId",
        "configuration_policy_compliance.policyId",
        "delete_tenant.tenant_id",
        "detect_log_correlations.orgId",
        "diagnose_connectivity.origin_device_id",
        "diagnose_connectivity.site_id",
        "disk_cleanup.cleanupRunId",
        "edr_endpoint_action.connectionId",
        "execute_playbook.playbookId",
        "export_dataset.siteId",
        "find_proven_fixes.alertId",
        "find_proven_fixes.anomalyEpisodeId",
        "generate_incident_report.incidentId",
        "generate_report.orgId",
        "generate_report.reportId",
        "generate_report.reportRunId",
        "get_ai_agent_run.runId",
        "get_browser_security.orgId",
        "get_catalog_item.catalogItemId",
        "get_cis_compliance.baselineId",
        "get_cis_compliance.orgId",
        "get_cis_device_report.baselineId",
        "get_compliance_status.policyId",
        "get_configuration_policy.policyId",
        "get_contract.contractId",
        "get_diagnostic_run.run_id",
        "get_diagnostic_run.site_id",
        "get_dns_security.integrationId",
        "get_dr_execution_status.executionId",
        "get_dr_execution_status.planId",
        "get_dr_plan_details.planId",
        "get_edr_status.orgId",
        "get_fleet_device_stats.orgId",
        "get_fleet_findings.orgId",
        "get_fleet_health.orgId",
        "get_fleet_health.siteId",
        "get_huntress_incidents.integrationId",
        "get_huntress_incidents.orgId",
        "get_huntress_status.integrationId",
        "get_huntress_status.orgId",
        "get_hyperv_vm_details.vmId",
        "get_incident_timeline.incidentId",
        "get_interface_history.interface_id",
        "get_interface_history.site_id",
        "get_invoice.invoiceId",
        "get_link_evidence.relationship_id",
        "get_link_evidence.site_id",
        "get_link_health.relationship_id",
        "get_link_health.site_id",
        "get_log_trends.siteIds",
        "get_monitor.monitorId",
        "get_monitor_activity.monitorId",
        "get_network_asset.assetId",
        "get_network_asset_reachability.asset_id",
        "get_network_changes.baseline_id",
        "get_network_changes.org_id",
        "get_network_changes.site_id",
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
        "get_security_posture.orgId",
        "get_site.siteId",
        "get_sla_breaches.configId",
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
        "list_ai_agent_runs.agentId",
        "list_ai_agent_runs.orgId",
        "list_contracts.orgId",
        "list_deliverable_templates.orgId",
        "list_deliverables.contractId",
        "list_deliverables.occurrencesFor",
        "list_deliverables.orgId",
        "list_edr_detections.orgId",
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
        "list_time_entries.orgId",
        "list_time_entries.ticketId",
        "list_time_entries.userId",
        "list_time_sync_issues.orgId",
        "list_time_sync_issues.siteId",
        "m365_query_groups.orgId",
        "m365_query_intune_devices.orgId",
        "m365_query_org.orgId",
        "m365_query_sites.orgId",
        "manage_alert_rules.ruleId",
        "manage_alerts.alertId",
        "manage_automations.automationId",
        "manage_backup_configs.configId",
        "manage_backup_configs.orgId",
        "manage_configuration_policy.orgId",
        "manage_configuration_policy.policyId",
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
        "manage_dns_policy.integrationId",
        "manage_groups.groupId",
        "manage_groups.orgId",
        "manage_groups.siteId",
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
        "manage_monitor_definitions.attachmentId",
        "manage_monitor_definitions.configPolicyId",
        "manage_monitor_definitions.monitorId",
        "manage_monitors.monitorId",
        "manage_monitors.orgId",
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
        "manage_peripheral_policies.orgId",
        "manage_peripheral_policies.policyId",
        "manage_policy_feature_link.configPolicyId",
        "manage_policy_feature_link.featureLinkId",
        "manage_policy_feature_link.featurePolicyId",
        "manage_service_monitors.configPolicyId",
        "manage_software_policies.orgId",
        "manage_software_policies.policyId",
        "manage_ticket_checklist.itemId",
        "manage_ticket_checklist.itemIds",
        "manage_ticket_checklist.orgId",
        "manage_ticket_checklist.templateId",
        "manage_ticket_checklist.ticketId",
        "manage_update_rings.ringId",
        "preview_configuration_change.remove",
        "propose_script.supersedesProposalId",
        "query_analytics.slaId",
        "query_audit_log.resourceId",
        "query_backups.configId",
        "query_devices.siteId",
        "query_psa_status.connectionId",
        "read_artifact.handle",
        "remediate_vulnerability.deviceVulnerabilityIds",
        "remove_configuration_policy_assignment.assignmentId",
        "reset_monitor_escalation.monitorId",
        "resolve_device_context.contextId",
        "run_script.proposalId",
        "s1_isolate_device.orgId",
        "s1_threat_action.orgId",
        "search_logs.siteIds",
        "sync_edr_data.connectionId",
        "sync_edr_data.orgId",
        "sync_huntress_data.integrationId",
        "sync_huntress_data.orgId",
        "system_cleanup.cleanupRunId",
        "system_cleanup.commandId",
        "workspace_run.stdinHandle",
        "workspace_stage.handles",
      ]
    `);
  });
});
