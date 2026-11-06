import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  from: [] as unknown[],
  system: 0,
  fail: null as Error | null,
  capture: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => {
        h.from.push(table);
        const query: Record<string, unknown> = {
          where: () => query,
          limit: () => query,
          then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            (h.fail ? Promise.reject(h.fail) : Promise.resolve(h.rows)).then(resolve, reject),
        };
        return query;
      },
    }),
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => {
    h.system += 1;
    return fn();
  },
}));

vi.mock('../sentry', () => ({ captureException: h.capture }));

import * as schema from '../../db/schema';
import { INTENT_ORG_OUT_OF_REACH, INTENT_ROW_UNREADABLE, decideIntentOrg, resolveIntentTarget } from './intentTargetOrg';

const ID = '11111111-1111-4111-8111-111111111111';
const ORG_A = '00000000-0000-4000-8000-0000000000a1';
const ORG_B = '00000000-0000-4000-8000-0000000000b1';
const ORG_X = '00000000-0000-4000-8000-0000000000f9';
const PARTNER = '00000000-0000-4000-8000-0000000000c1';
const OTHER_PARTNER = '00000000-0000-4000-8000-0000000000c2';

const reach = { canAccessOrg: (id: string) => id === ORG_A || id === ORG_B, partnerId: PARTNER };

const decide = async (tool: string, input: Record<string, unknown>) => decideIntentOrg(await resolveIntentTarget(tool, input), reach);
const refused = { kind: 'refuse', error: INTENT_ORG_OUT_OF_REACH };

beforeEach(() => {
  h.rows = [];
  h.from = [];
  h.system = 0;
  h.fail = null;
  h.capture.mockReset();
});

/** Each row was read in the handler; the table is stated here, not read from the registry. */
const CONVERTED: ReadonlyArray<[string, Record<string, unknown>, keyof typeof schema]> = [
  ['manage_invoices', { action: 'issue', invoiceId: ID }, 'invoices'],
  ['manage_invoices', { action: 'void', invoiceId: ID }, 'invoices'],
  ['manage_invoices', { action: 'record_payment', invoiceId: ID }, 'invoices'],
  ['manage_invoices', { action: 'void_payment', paymentId: ID }, 'invoicePayments'],
  ['manage_contracts', { action: 'activate', contractId: ID }, 'contracts'],
  ['manage_contracts', { action: 'pause', contractId: ID }, 'contracts'],
  ['manage_contracts', { action: 'resume', contractId: ID }, 'contracts'],
  ['manage_contracts', { action: 'cancel', contractId: ID }, 'contracts'],
  ['manage_contracts', { action: 'generate_invoice', contractId: ID }, 'contracts'],
  ['manage_quotes', { action: 'send', quoteId: ID }, 'quotes'],
  ['manage_quotes', { action: 'decline', quoteId: ID }, 'quotes'],
  ['manage_quotes', { action: 'create_pay_link', quoteId: ID }, 'quotes'],
  ['manage_accounting_sync', { action: 'push', invoiceId: ID }, 'invoices'],
  ['manage_notification_channels', { action: 'update', channelId: ID }, 'notificationChannels'],
  ['manage_notification_channels', { action: 'delete', channelId: ID }, 'notificationChannels'],
  ['manage_groups', { action: 'update', groupId: ID }, 'deviceGroups'],
  ['manage_groups', { action: 'delete', groupId: ID }, 'deviceGroups'],
  ['manage_groups', { action: 'add_devices', groupId: ID, deviceIds: [ID] }, 'deviceGroups'],
  ['manage_groups', { action: 'remove_devices', groupId: ID, deviceIds: [ID] }, 'deviceGroups'],
  ['manage_pam_rules', { action: 'update_rule', ruleId: ID }, 'pamRules'],
  ['manage_pam_rules', { action: 'delete_rule', ruleId: ID }, 'pamRules'],
  ['manage_pam_rules', { action: 'update_signer_group', signerGroupId: ID }, 'pamSignerGroups'],
  ['manage_pam_rules', { action: 'delete_signer_group', signerGroupId: ID }, 'pamSignerGroups'],
  ['manage_configuration_policy', { action: 'update', policyId: ID }, 'configurationPolicies'],
  ['manage_configuration_policy', { action: 'delete', policyId: ID }, 'configurationPolicies'],
  ['manage_policy_feature_link', { action: 'remove', configPolicyId: ID, featureLinkId: ID }, 'configurationPolicies'],
  ['manage_policy_feature_link', { action: 'add', configPolicyId: ID, featureType: 'maintenance' }, 'configurationPolicies'],
  ['manage_policy_feature_link', { action: 'update', configPolicyId: ID, featureLinkId: ID }, 'configurationPolicies'],
  ['manage_browser_policy', { action: 'update', policyId: ID }, 'browserPolicies'],
  ['manage_browser_policy', { action: 'apply', policyId: ID }, 'browserPolicies'],
  ['manage_deployments', { action: 'start', deploymentId: ID }, 'deployments'],
  ['manage_deployments', { action: 'cancel', deploymentId: ID }, 'deployments'],
  ['manage_delivery', { action: 'update_routing', id: ID }, 'notificationRoutingRules'],
  ['manage_delivery', { action: 'delete_routing', id: ID }, 'notificationRoutingRules'],
  ['manage_delivery', { action: 'update_escalation', id: ID }, 'escalationPolicies'],
  ['manage_delivery', { action: 'delete_escalation', id: ID }, 'escalationPolicies'],
  ['manage_tenant_variables', { action: 'update', variableId: ID }, 'tenantVariables'],
  ['manage_tenant_variables', { action: 'delete', variableId: ID }, 'tenantVariables'],
  ['manage_peripheral_policies', { action: 'update', policyId: ID }, 'peripheralPolicies'],
  ['manage_peripheral_policy', { action: 'update', policy_id: ID }, 'peripheralPolicies'],
  ['manage_peripheral_policy', { action: 'disable', policy_id: ID }, 'peripheralPolicies'],
  ['manage_peripheral_policy', { action: 'add_exception', policy_id: ID }, 'peripheralPolicies'],
  ['manage_peripheral_policy', { action: 'remove_exception', policy_id: ID }, 'peripheralPolicies'],
  ['manage_security_policies', { action: 'update', policyId: ID }, 'securityPolicies'],
  ['manage_software_policies', { action: 'update', policyId: ID }, 'softwarePolicies'],
  ['manage_software_policy', { action: 'update', policyId: ID }, 'softwarePolicies'],
  ['manage_software_policy', { action: 'delete', policyId: ID }, 'softwarePolicies'],
  ['manage_compliance_policies', { action: 'deactivate', policyId: ID, ownerScope: 'organization' }, 'automationPolicies'],
  ['manage_backup_profiles', { action: 'update', profileId: ID }, 'backupProfiles'],
  ['manage_backup_profiles', { action: 'delete', profileId: ID }, 'backupProfiles'],
  ['ioc_hunt', { action: 'import_iocs', ruleSetId: ID }, 'yaraRuleSets'],
  ['configure_network_baseline', { baseline_id: ID, org_id: ORG_X }, 'networkBaselines'],
  ['manage_custom_fields', { action: 'delete_definition', definitionId: ID }, 'customFieldDefinitions'],
  ['manage_dr_plan', { action: 'delete_group', planId: ID, groupId: ID }, 'drPlanGroups'],
  ['execute_dr_plan', { planId: ID }, 'drPlans'],
  ['manage_manual_assets', { action: 'delete', assetId: ID }, 'manualAssets'],
  ['manage_topology_templates', { action: 'publish_version', templateId: ID, versionId: ID }, 'topologyConfigTemplates'],
  ['manage_topology_templates', { action: 'revoke_template', templateId: ID }, 'topologyConfigTemplates'],
  ['manage_automations', { action: 'run', automationId: ID }, 'automations'],
  ['test_webhook', { webhookId: ID }, 'webhooks'],
  ['manage_monitor_definitions', { action: 'update', monitorId: ID }, 'monitorDefinitions'],
  ['manage_monitor_definitions', { action: 'enable', monitorId: ID }, 'monitorDefinitions'],
  ['manage_monitor_definitions', { action: 'disable', monitorId: ID }, 'monitorDefinitions'],
  ['manage_monitor_definitions', { action: 'delete', monitorId: ID }, 'monitorDefinitions'],
  ['trigger_c2c_sync', { configId: ID }, 'c2cBackupConfigs'],
  ['restore_c2c_items', { itemIds: [ID, ORG_X] }, 'c2cBackupItems'],
  ['trigger_vault_sync', { vaultId: ID }, 'localVaults'],
  ['configure_vault', { action: 'update', vaultId: ID }, 'localVaults'],
  ['manage_tickets', { action: 'move_org', ticketId: ID, targetOrgId: ORG_A }, 'tickets'],
  ['manage_tickets', { action: 'merge', ticketId: ID, intoTicketId: ORG_X }, 'tickets'],
  ['manage_tickets', { action: 'comment', ticketId: ID, isPublic: true, content: 'c' }, 'tickets'],
  ['manage_tickets', { action: 'update_status', ticketId: ID, status: 'resolved' }, 'tickets'],
  ['manage_tickets', { action: 'update_fields', ticketId: ID, fields: {} }, 'tickets'],
  ['manage_tickets', { action: 'edit_comment', commentId: ORG_X, expectedTicketId: ID }, 'tickets'],
  ['manage_tickets', { action: 'delete_comment', commentId: ORG_X, expectedTicketId: ID }, 'tickets'],
  ['manage_ticket_attachments', { action: 'delete', ticketId: ID, attachmentId: ORG_X }, 'tickets'],
  ['manage_ticket_forms', { action: 'update', id: ID }, 'ticketForms'],
  ['manage_ticket_forms', { action: 'delete', id: ID }, 'ticketForms'],
  ['manage_ticket_routing_rules', { action: 'update', ruleId: ID }, 'ticketRoutingRules'],
  ['manage_ticket_routing_rules', { action: 'delete', ruleId: ID }, 'ticketRoutingRules'],
  ['manage_ticket_routing_rules', { action: 'reorder', ids: [ID, ORG_X] }, 'ticketRoutingRules'],
  ['manage_ticket_checklist_templates', { action: 'update', id: ID }, 'ticketChecklistTemplates'],
  ['manage_ticket_checklist_templates', { action: 'delete', id: ID }, 'ticketChecklistTemplates'],
  ['manage_ticket_checklist_templates', { action: 'add_item', id: ID }, 'ticketChecklistTemplates'],
  ['manage_ticket_checklist_templates', { action: 'reorder_items', id: ID, itemIds: [ID] }, 'ticketChecklistTemplates'],
  ['manage_ticket_checklist_templates', { action: 'update_item', itemId: ID }, 'ticketChecklistTemplateItems'],
  ['manage_ticket_checklist_templates', { action: 'remove_item', itemId: ID }, 'ticketChecklistTemplateItems'],
  ['manage_pax8_orders', { action: 'preflight', orderId: ID }, 'pax8Orders'],
  ['manage_pax8_orders', { action: 'submit', orderId: ID }, 'pax8Orders'],
  ['manage_pax8_orders', { action: 'reconcile', orderId: ID }, 'pax8Orders'],
  ['manage_pax8_subscriptions', { action: 'link', subscriptionSnapshotId: ID, contractLineId: ORG_X }, 'pax8SubscriptionSnapshots'],
  ['manage_pax8_subscriptions', { action: 'unlink', subscriptionSnapshotId: ID }, 'pax8SubscriptionSnapshots'],
  ['manage_contract_templates', { action: 'create_version', templateId: ID }, 'contractTemplates'],
  ['manage_contract_templates', { action: 'publish', templateId: ID, versionId: ORG_X }, 'contractTemplates'],
  ['manage_contract_templates', { action: 'archive', templateId: ID }, 'contractTemplates'],
  ['manage_contract_documents', { action: 'link', documentId: ID, contractId: ORG_X }, 'contractDocuments'],
  ['manage_report_recipients', { action: 'add', reportId: ID, contactId: ORG_X }, 'reports'],
  ['manage_report_recipients', { action: 'remove', reportId: ID, contactId: ORG_X }, 'reports'],
  ['manage_report_recipients', { action: 'convert', reportId: ID, email: 'a@example.com' }, 'reports'],
  ['execute_containment', { incidentId: ID, deviceId: ORG_X, actionType: 'isolate' }, 'incidents'],
  ['cancel_script_execution', { executionId: ID }, 'scriptExecutions'],
  ['restore_as_vm', { snapshotId: ID, targetDeviceId: ORG_X }, 'backupSnapshots'],
  ['instant_boot_vm', { snapshotId: ID, targetDeviceId: ORG_X }, 'backupSnapshots'],
  ['verify_mssql_backup', { snapshotId: ID }, 'backupSnapshots'],
  ['manage_hyperv_vm', { action: 'start', vmId: ID }, 'hypervVms'],
  ['manage_hyperv_vm', { action: 'stop', vmId: ID }, 'hypervVms'],
  ['manage_hyperv_vm', { action: 'force_stop', vmId: ID }, 'hypervVms'],
  ['manage_hyperv_vm', { action: 'pause', vmId: ID }, 'hypervVms'],
  ['manage_hyperv_vm', { action: 'resume', vmId: ID }, 'hypervVms'],
  ['manage_hyperv_vm', { action: 'save', vmId: ID }, 'hypervVms'],
  ['manage_hyperv_checkpoints', { action: 'create', vmId: ID }, 'hypervVms'],
  ['manage_hyperv_checkpoints', { action: 'delete', vmId: ID }, 'hypervVms'],
  ['manage_hyperv_checkpoints', { action: 'apply', vmId: ID }, 'hypervVms'],
  ['trigger_hyperv_backup', { vmId: ID }, 'hypervVms'],
];

describe('a Tier-3 write that names its target by row id (#11222)', () => {
  describe.each(CONVERTED)('%s %j', (tool, input, table) => {
    it('files in the row\'s org, read as system from the row\'s table', async () => {
      h.rows = [{ orgId: ORG_B, partnerId: PARTNER }];
      await expect(decide(tool, input)).resolves.toEqual({ kind: 'target', orgId: ORG_B });
      expect(h.from).toEqual([schema[table]]);
      expect(h.system).toBe(1);
    });

    it('refuses a row outside reach', async () => {
      h.rows = [{ orgId: ORG_X, partnerId: OTHER_PARTNER }];
      await expect(decide(tool, input)).resolves.toEqual(refused);
    });

    it('refuses a row that does not exist, with the same answer', async () => {
      h.rows = [];
      await expect(decide(tool, input)).resolves.toEqual(refused);
    });
  });

  it('the org comes from the row: an orgId the model adds never moves the intent', async () => {
    h.rows = [{ orgId: ORG_B, partnerId: PARTNER }];
    await expect(decide('manage_invoices', { action: 'void', invoiceId: ID, orgId: ORG_A })).resolves.toEqual({ kind: 'target', orgId: ORG_B });
  });

  it('a malformed id reads nothing and refuses like a missing row', async () => {
    await expect(decide('manage_invoices', { action: 'void', invoiceId: 'not-a-uuid' })).resolves.toEqual(refused);
    await expect(decide('manage_groups', { action: 'update', groupId: `${ID}' OR '1'='1` })).resolves.toEqual(refused);
    expect(h.from).toEqual([]);
  });

  it('no id names no row: the session org keeps it, and the handler answers', async () => {
    await expect(decide('manage_invoices', { action: 'void' })).resolves.toEqual({ kind: 'session' });
    await expect(decide('manage_ticket_routing_rules', { action: 'reorder', ids: [] })).resolves.toEqual({ kind: 'session' });
    expect(h.from).toEqual([]);
  });

  it('an action not in the registry reads nothing', async () => {
    await expect(decide('manage_invoices', { action: 'get', invoiceId: ID })).resolves.toEqual({ kind: 'session' });
    await expect(decide('manage_groups', { action: 'list', groupId: ID })).resolves.toEqual({ kind: 'session' });
    expect(h.from).toEqual([]);
  });

  it('a read that fails refuses rather than filing in the session org, and is reported', async () => {
    h.fail = new Error('connection terminated');
    await expect(decide('manage_invoices', { action: 'void', invoiceId: ID })).resolves.toEqual({ kind: 'refuse', error: INTENT_ROW_UNREADABLE });
    expect(h.capture).toHaveBeenCalledTimes(1);
  });
});

describe('an org-less row (#11222)', () => {
  // Tables with no org on the row: partner-wide when the owning partner is the caller's.
  it.each<[string, Record<string, unknown>]>([
    ['manage_notification_channels', { action: 'update', channelId: ID }],
    ['manage_configuration_policy', { action: 'delete', policyId: ID }],
    ['manage_delivery', { action: 'update_routing', id: ID }],
    ['manage_software_policy', { action: 'delete', policyId: ID }],
    ['manage_pax8_subscriptions', { action: 'unlink', subscriptionSnapshotId: ID }],
    ['test_webhook', { webhookId: ID }],
  ])('%s %j: the caller\'s own partner stays in the session org, another partner\'s refuses', async (tool, input) => {
    h.rows = [{ orgId: null, partnerId: PARTNER }];
    await expect(decide(tool, input)).resolves.toEqual({ kind: 'session' });
    h.rows = [{ orgId: null, partnerId: OTHER_PARTNER }];
    await expect(decide(tool, input)).resolves.toEqual(refused);
  });

  it('a row with neither an org nor a partner refuses', async () => {
    h.rows = [{ orgId: null, partnerId: null }];
    await expect(decide('ioc_hunt', { action: 'import_iocs', ruleSetId: ID })).resolves.toEqual(refused);
  });

  it('a caller with no partner never owns a partner-wide row', async () => {
    h.rows = [{ orgId: null, partnerId: PARTNER }];
    const target = await resolveIntentTarget('manage_notification_channels', { action: 'update', channelId: ID });
    expect(decideIntentOrg(target, { canAccessOrg: () => true, partnerId: null })).toEqual(refused);
  });

  it('system scope reaches a partner-wide row', async () => {
    h.rows = [{ orgId: null, partnerId: PARTNER }];
    const target = await resolveIntentTarget('manage_notification_channels', { action: 'update', channelId: ID });
    expect(decideIntentOrg(target, { canAccessOrg: () => true, partnerId: null, scope: 'system' })).toEqual({ kind: 'session' });
  });
});

describe('an action left in the session org reads no row (#11222)', () => {
  it.each<[string, Record<string, unknown>]>([
    ['confirm_memory', { blockId: ID }],
    ['retract_memory', { blockId: ID }],
    ['manage_support_sessions', { action: 'end', sessionId: ID }],
    ['operator_plan', { taskId: ID }],
    ['remediate_sensitive_data', { action: 'encrypt', findingIds: [ID] }],
    ['manage_accounting_sync', { action: 'push_bulk', invoiceIds: [ID] }],
    ['execute_command', { deviceId: ID, command: 'whoami' }],
  ])('%s %j', async (tool, input) => {
    await expect(decide(tool, input)).resolves.toEqual({ kind: 'session' });
    expect(h.from).toEqual([]);
  });
});

describe('an argument target missed by #11181 (#11222)', () => {
  it.each<[string, Record<string, unknown>]>([
    ['manage_organizations', { action: 'update_org', orgId: ORG_B, name: 'n' }],
    ['ioc_hunt', { action: 'sweep', orgId: ORG_B, ruleSetIds: [ID], scope: { kind: 'all' } }],
    ['manage_security_policies', { action: 'create', orgId: ORG_B, name: 'n' }],
  ])('%s %j files in the named org', async (tool, input) => {
    await expect(decide(tool, input)).resolves.toEqual({ kind: 'target', orgId: ORG_B });
    expect(h.from).toEqual([]);
  });

  it('a partner-owned security policy names no org and stays in the session org', async () => {
    await expect(decide('manage_security_policies', { action: 'create', ownerScope: 'partner', name: 'n' })).resolves.toEqual({ kind: 'session' });
  });

  it('the named org out of reach refuses', async () => {
    await expect(decide('manage_organizations', { action: 'update_org', orgId: ORG_X, name: 'n' })).resolves.toEqual(refused);
  });
});
