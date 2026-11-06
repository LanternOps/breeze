/**
 * #11222: the row-identified half of `intentTargetOrg.ts`. Most approval-class writes name
 * the row they change by id and ignore any `orgId`, so the org their intent belongs in is
 * the row's: its approvers, its stored reason and a durable release's rebuilt authority are
 * all keyed on `action_intents.org_id`.
 *
 * `INTENT_ROW_TARGET` holds one entry per tool action, each read in its handler: the input
 * key naming the row, and the table it lives in. `INTENT_ROW_PARTNER_WIDE` and
 * `INTENT_ROW_LEFT` hold the Tier-3 id-taking actions that deliberately have no entry, each
 * with its reason. `intentTargetOrg.contract.test.ts` requires every such action to be in
 * exactly one of these (or to name its org as an argument).
 *
 * The row is read as system, because it may be in an org the session is not bound to. The
 * read answers "where would this intent go", never "may this caller do it": handlers keep
 * their own checks, and a refusal for a foreign row is worded like one for a missing row.
 *
 * Table references are behind thunks so this module stays importable on the chat path and
 * by suites that mock a slice of the schema.
 */
import { eq, sql } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  automationPolicies, automations, backupProfiles, backupSnapshots, browserPolicies, c2cBackupConfigs,
  c2cBackupItems, configurationPolicies, contractDocuments, contractTemplates, contracts, customFieldDefinitions,
  deployments, deviceGroups, drPlanGroups, drPlans, escalationPolicies, hypervVms, incidents, invoicePayments, invoices,
  localVaults, manualAssets, monitorDefinitions, networkBaselines, notificationChannels,
  notificationRoutingRules, pamRules, pamSignerGroups, pax8Orders, pax8SubscriptionSnapshots, peripheralPolicies, quotes,
  reports, scriptExecutions, securityPolicies, softwarePolicies, tenantVariables, ticketChecklistTemplateItems,
  ticketChecklistTemplates, ticketForms, ticketRoutingRules, tickets, topologyConfigTemplates, webhooks, yaraRuleSets,
} from '../../db/schema';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type IntentRowSource = { table: PgTable; id: AnyPgColumn; org: AnyPgColumn; partner?: AnyPgColumn };

/** A table whose row carries its org as `orgId`, and its partner as `partnerId` when it has one. */
function owned<T extends PgTable & { id: AnyPgColumn; orgId: AnyPgColumn }>(table: () => T): () => IntentRowSource {
  return () => {
    const t = table();
    return { table: t, id: t.id, org: t.orgId, partner: (t as unknown as { partnerId?: AnyPgColumn }).partnerId };
  };
}

export type IntentRowEntry = {
  /** The actions this holds for; `'all'` for a tool with no `action`. */
  actions: readonly string[] | 'all';
  /** The input key holding the row's id. */
  arg: string;
  /** The id is the first of an array whose handler refuses a mix of owners. */
  firstOfArray?: true;
  row: () => IntentRowSource;
};

const BACKUP_SNAPSHOT = owned(() => backupSnapshots);
const CONFIG_POLICY = owned(() => configurationPolicies);
const HYPERV_VM = owned(() => hypervVms);
const INVOICE = owned(() => invoices);
const LOCAL_VAULT = owned(() => localVaults);
const PERIPHERAL_POLICY = owned(() => peripheralPolicies);
const SOFTWARE_POLICY = owned(() => softwarePolicies);
const TICKET = owned(() => tickets);

export const INTENT_ROW_TARGET: Readonly<Record<string, readonly IntentRowEntry[]>> = {
  // Money. `generate_invoice`, `submit` and `push` pin an effect digest; its key is untouched,
  // and each resolver reads its own row by id, so the digest does not depend on the intent's org.
  manage_invoices: [
    { actions: ['issue', 'void', 'record_payment'], arg: 'invoiceId', row: INVOICE },
    { actions: ['void_payment'], arg: 'paymentId', row: owned(() => invoicePayments) },
  ],
  manage_contracts: [{ actions: ['activate', 'pause', 'resume', 'cancel', 'generate_invoice'], arg: 'contractId', row: owned(() => contracts) }],
  manage_quotes: [{ actions: ['send', 'decline', 'create_pay_link'], arg: 'quoteId', row: owned(() => quotes) }],
  manage_accounting_sync: [{ actions: ['push'], arg: 'invoiceId', row: INVOICE }],
  manage_pax8_orders: [{ actions: ['preflight', 'submit', 'reconcile'], arg: 'orderId', row: owned(() => pax8Orders) }],
  // A snapshot of a Pax8 company not yet mapped to an org has no org: the partner's.
  manage_pax8_subscriptions: [{ actions: ['link', 'unlink'], arg: 'subscriptionSnapshotId', row: owned(() => pax8SubscriptionSnapshots) }],
  manage_contract_templates: [{ actions: ['create_version', 'publish', 'archive'], arg: 'templateId', row: owned(() => contractTemplates) }],
  manage_contract_documents: [{ actions: ['link'], arg: 'documentId', row: owned(() => contractDocuments) }],
  manage_report_recipients: [{ actions: ['add', 'remove', 'convert'], arg: 'reportId', row: owned(() => reports) }],

  // Fleet and policy.
  manage_notification_channels: [{ actions: ['update', 'delete'], arg: 'channelId', row: owned(() => notificationChannels) }],
  manage_groups: [{ actions: ['update', 'delete', 'add_devices', 'remove_devices'], arg: 'groupId', row: owned(() => deviceGroups) }],
  manage_pam_rules: [
    { actions: ['update_rule', 'delete_rule'], arg: 'ruleId', row: owned(() => pamRules) },
    { actions: ['update_signer_group', 'delete_signer_group'], arg: 'signerGroupId', row: owned(() => pamSignerGroups) },
  ],
  manage_configuration_policy: [{ actions: ['update', 'delete'], arg: 'policyId', row: CONFIG_POLICY }],
  // The link has no org; the handler authorizes on its parent policy, which the input names.
  manage_policy_feature_link: [{ actions: ['add', 'update', 'remove'], arg: 'configPolicyId', row: CONFIG_POLICY }],
  manage_browser_policy: [{ actions: ['update', 'apply'], arg: 'policyId', row: owned(() => browserPolicies) }],
  manage_deployments: [{ actions: ['start', 'cancel'], arg: 'deploymentId', row: owned(() => deployments) }],
  manage_delivery: [
    { actions: ['update_routing', 'delete_routing'], arg: 'id', row: owned(() => notificationRoutingRules) },
    { actions: ['update_escalation', 'delete_escalation'], arg: 'id', row: owned(() => escalationPolicies) },
  ],
  manage_tenant_variables: [{ actions: ['update', 'delete'], arg: 'variableId', row: owned(() => tenantVariables) }],
  manage_peripheral_policies: [{ actions: ['update'], arg: 'policyId', row: PERIPHERAL_POLICY }],
  manage_peripheral_policy: [{ actions: ['update', 'disable', 'add_exception', 'remove_exception'], arg: 'policy_id', row: PERIPHERAL_POLICY }],
  manage_security_policies: [{ actions: ['update'], arg: 'policyId', row: owned(() => securityPolicies) }],
  manage_software_policies: [{ actions: ['update'], arg: 'policyId', row: SOFTWARE_POLICY }],
  manage_software_policy: [{ actions: ['update', 'delete'], arg: 'policyId', row: SOFTWARE_POLICY }],
  manage_compliance_policies: [{ actions: ['deactivate'], arg: 'policyId', row: owned(() => automationPolicies) }],
  manage_backup_profiles: [{ actions: ['update', 'delete'], arg: 'profileId', row: owned(() => backupProfiles) }],
  ioc_hunt: [{ actions: ['import_iocs'], arg: 'ruleSetId', row: owned(() => yaraRuleSets) }],
  configure_network_baseline: [{ actions: 'all', arg: 'baseline_id', row: owned(() => networkBaselines) }],
  manage_custom_fields: [{ actions: ['delete_definition'], arg: 'definitionId', row: owned(() => customFieldDefinitions) }],
  manage_dr_plan: [{ actions: ['delete_group'], arg: 'groupId', row: owned(() => drPlanGroups) }],
  execute_dr_plan: [{ actions: 'all', arg: 'planId', row: owned(() => drPlans) }],
  manage_manual_assets: [{ actions: ['delete'], arg: 'assetId', row: owned(() => manualAssets) }],
  manage_topology_templates: [{ actions: ['publish_version', 'revoke_template'], arg: 'templateId', row: owned(() => topologyConfigTemplates) }],
  manage_automations: [{ actions: ['run'], arg: 'automationId', row: owned(() => automations) }],
  test_webhook: [{ actions: 'all', arg: 'webhookId', row: owned(() => webhooks) }],
  manage_monitor_definitions: [{ actions: ['update', 'delete', 'enable', 'disable'], arg: 'monitorId', row: owned(() => monitorDefinitions) }],

  // Backup and recovery.
  trigger_c2c_sync: [{ actions: 'all', arg: 'configId', row: owned(() => c2cBackupConfigs) }],
  // Every item must share one config (and so one org), or the handler refuses.
  restore_c2c_items: [{ actions: 'all', arg: 'itemIds', firstOfArray: true, row: owned(() => c2cBackupItems) }],
  trigger_vault_sync: [{ actions: 'all', arg: 'vaultId', row: LOCAL_VAULT }],
  configure_vault: [{ actions: ['update'], arg: 'vaultId', row: LOCAL_VAULT }],
  // The target device must be in the snapshot's org, or the handler refuses.
  restore_as_vm: [{ actions: 'all', arg: 'snapshotId', row: BACKUP_SNAPSHOT }],
  instant_boot_vm: [{ actions: 'all', arg: 'snapshotId', row: BACKUP_SNAPSHOT }],
  verify_mssql_backup: [{ actions: 'all', arg: 'snapshotId', row: BACKUP_SNAPSHOT }],
  manage_hyperv_vm: [{ actions: ['start', 'stop', 'force_stop', 'pause', 'resume', 'save'], arg: 'vmId', row: HYPERV_VM }],
  manage_hyperv_checkpoints: [{ actions: ['create', 'delete', 'apply'], arg: 'vmId', row: HYPERV_VM }],
  trigger_hyperv_backup: [{ actions: 'all', arg: 'vmId', row: HYPERV_VM }],

  // Tickets. `move_org` has two orgs: it is filed where the ticket is today, and the handler
  // checks the destination. `merge` refuses two orgs. A comment has no org of its own, and
  // its handler requires the `expectedTicketId` it belongs to. `comment`, `update_status` and
  // `update_fields` are Tier 3 only on some inputs; below it, nothing is filed or refused.
  manage_tickets: [
    { actions: ['move_org', 'merge', 'comment', 'update_status', 'update_fields'], arg: 'ticketId', row: TICKET },
    { actions: ['edit_comment', 'delete_comment'], arg: 'expectedTicketId', row: TICKET },
  ],
  manage_ticket_attachments: [{ actions: ['delete'], arg: 'ticketId', row: TICKET }],
  manage_ticket_forms: [{ actions: ['update', 'delete'], arg: 'id', row: owned(() => ticketForms) }],
  manage_ticket_routing_rules: [
    { actions: ['update', 'delete'], arg: 'ruleId', row: owned(() => ticketRoutingRules) },
    // The handler refuses rules of more than one owner.
    { actions: ['reorder'], arg: 'ids', firstOfArray: true, row: owned(() => ticketRoutingRules) },
  ],
  manage_ticket_checklist_templates: [
    { actions: ['update', 'delete', 'add_item', 'reorder_items'], arg: 'id', row: owned(() => ticketChecklistTemplates) },
    { actions: ['update_item', 'remove_item'], arg: 'itemId', row: owned(() => ticketChecklistTemplateItems) },
  ],

  // Incident and script.
  execute_containment: [{ actions: 'all', arg: 'incidentId', row: owned(() => incidents) }],
  cancel_script_execution: [{ actions: 'all', arg: 'executionId', row: owned(() => scriptExecutions) }],
};

const eachAction = (tool: string, actions: readonly string[], reason: string): Record<string, string> =>
  Object.fromEntries(actions.map((action) => [`${tool}:${action}`, reason]));

/**
 * Tier-3 id-taking actions whose row has no org at all: the row is the partner's, so the
 * intent stays in the session org. Keyed `tool` for a tool with no `action`, else
 * `tool:action`, so a new action of the tool is not covered by accident.
 */
export const INTENT_ROW_PARTNER_WIDE: Readonly<Record<string, string>> = {
  delete_tenant: 'the row is the caller\'s own partner',
  'manage_accounting_sync:link_mapping': 'the mapping row is the partner\'s, whichever entity it maps',
  'manage_accounting_sync:unlink_mapping': 'the mapping row is the partner\'s, whichever entity it maps',
  'manage_accounting_sync:sync_mapping': 'the mapping row is the partner\'s, whichever entity it maps',
  ...eachAction('manage_billing_catalog', ['update_item', 'archive_item', 'set_price', 'remove_price', 'set_bundle_components'], 'the catalog item writes are partner-wide'),
  ...eachAction('manage_billing_profiles', ['create', 'update', 'archive', 'set_rows', 'clone', 'create_work_type', 'update_work_type'], 'the profile and work-type writes are partner-wide'),
  'manage_billing_settings:update_partner': 'the partner\'s own settings',
  ...eachAction('manage_ticket_config', [
    'create_category', 'update_category', 'delete_category', 'reorder_categories', 'create_status', 'update_status',
    'reorder_statuses', 'set_priorities', 'create_domain', 'update_domain', 'delete_domain',
  ], 'the category, status, priority and domain writes are partner-wide'),
  'manage_ticket_inbox:dismiss': 'an inbound email row is keyed on the partner and has no org',
  ...eachAction('manage_ticket_response_templates', ['create', 'update', 'delete'], 'a response template is keyed on the partner and has no org'),
  ...eachAction('manage_update_rings', ['create', 'update'], 'a ring is keyed on the partner and has no org'),
  'manage_pax8_subscriptions:sync': 'a sync covers the partner\'s whole integration',
  // Tier 3 only for a partner-owned row; an org-owned one stays below it and files nothing.
  'manage_backup_profiles:create': 'Tier 3 only when partner-owned',
  'manage_contract_templates:create': 'Tier 3 only when partner-owned',
  'manage_contract_templates:update': 'Tier 3 only when partner-owned, which the call asserts and the handler checks',
  'manage_custom_fields:create_definition': 'Tier 3 only when partner-owned',
  'manage_software_catalog:create': 'Tier 3 only when partner-owned',
  'manage_ticket_checklist_templates:create': 'Tier 3 only when partner-owned',
};

export const DEVICE_TARGETED = 'names a device through `deviceArgs`: MCP resolves the device org, and chat is a separate decision from this row registry';

/**
 * Tier-3 id-taking actions that stay where they file today, each with its reason. Keyed like
 * `INTENT_ROW_PARTNER_WIDE`, except that a device-targeted tool may be keyed whole.
 */
export const INTENT_ROW_LEFT: Readonly<Record<string, string>> = {
  // Several rows, with nothing requiring them to share an org.
  'apply_topology_template:apply': 'a preview token, whose sites may span organizations',
  'manage_accounting_sync:push_bulk': 'an invoice list that may span the partner\'s organizations',
  ...eachAction('remediate_sensitive_data', ['encrypt', 'quarantine', 'secure_delete', 'accept_risk', 'false_positive', 'mark_remediated'], 'a finding list that may span organizations'),
  'send_endpoint_message:send': 'the audience is `targets`, which may span organizations',

  // A row that is not the right place to file.
  'manage_support_sessions:end': 'the row\'s org is the partner\'s hidden support org, which has no approvers; the handler scopes by partner',
  operator_plan: 'filed by plan approval in the task\'s org, and release requires that org',
  'manage_ai_agents:authorize_supervised_key': '`orgId` must equal the authorized org, and createActionIntent refuses a mismatch',
  wisp_specialist_request: 'filed by the coordinator in the request org, and release refuses another',
  run_flow: 'the run-flow gate resolves the flow\'s org',
  diagnose_connectivity: 'a pinned recipe with its own approval path, resolved through its origin device and site',
  // `ai_memory_blocks` is reached only through the memory broker and service (Wisp spec §8.4,
  // memoryBroker.singleCaller.contract.test.ts), and a system read here would be a third door.
  confirm_memory: 'a memory block is read only through the memory service, under the caller\'s RLS (Wisp spec §8.4)',
  retract_memory: 'a memory block is read only through the memory service, under the caller\'s RLS (Wisp spec §8.4)',

  // Two rows the handler does not require to share an org: which one is the target is a design call.
  'manage_monitor_definitions:attach': 'names a monitor and a policy, and a partner-wide monitor can attach to an org policy',
  'manage_monitor_definitions:detach': 'names a monitor and an attachment of a policy that may be another org\'s',

  // No row to read.
  'manage_access_reviews:create': 'creates; the owner comes from the caller',
  'manage_monitor_definitions:create': 'creates; the owner comes from the caller',
  'manage_monitor_definitions:describe': 'a read: it files no row-scoped change',
  'manage_organizations:create_org': 'creates a new organization',

  // Device-targeted.
  'manage_patches:rollback': DEVICE_TARGETED,
  'manage_custom_fields:set_values': DEVICE_TARGETED,
  'configure_vault:create': DEVICE_TARGETED,
  analyze_screen: DEVICE_TARGETED,
  apply_cis_remediation: DEVICE_TARGETED,
  bootstrap_homebrew: DEVICE_TARGETED,
  collect_evidence: DEVICE_TARGETED,
  browse_device_event_log: DEVICE_TARGETED,
  computer_control: DEVICE_TARGETED,
  create_remote_session: DEVICE_TARGETED,
  disk_cleanup: DEVICE_TARGETED,
  edr_endpoint_action: DEVICE_TARGETED,
  execute_command: DEVICE_TARGETED,
  execute_playbook: DEVICE_TARGETED,
  file_operations: DEVICE_TARGETED,
  manage_device_anomalies: DEVICE_TARGETED,
  manage_device_function: DEVICE_TARGETED,
  manage_device_software: DEVICE_TARGETED,
  manage_device_warranty: DEVICE_TARGETED,
  manage_processes: DEVICE_TARGETED,
  manage_recovery_keys: DEVICE_TARGETED,
  manage_scheduled_tasks: DEVICE_TARGETED,
  manage_services: DEVICE_TARGETED,
  manage_startup_items: DEVICE_TARGETED,
  network_discovery: DEVICE_TARGETED,
  registry_operations: DEVICE_TARGETED,
  release_containment: DEVICE_TARGETED,
  remediate_software_violation: DEVICE_TARGETED,
  remediate_vulnerability: DEVICE_TARGETED,
  request_elevation: DEVICE_TARGETED,
  restore_hyperv_vm: DEVICE_TARGETED,
  restore_mssql_database: DEVICE_TARGETED,
  restore_snapshot: DEVICE_TARGETED,
  run_script: DEVICE_TARGETED,
  security_scan: DEVICE_TARGETED,
  system_cleanup: DEVICE_TARGETED,
  take_screenshot: DEVICE_TARGETED,
  trigger_agent_restart: DEVICE_TARGETED,
  trigger_agent_upgrade: DEVICE_TARGETED,
  trigger_backup: DEVICE_TARGETED,
  trigger_mssql_backup: DEVICE_TARGETED,
};

export type IntentRowOwner = { orgId: string | null; partnerId: string | null };

const NO_OWNER: IntentRowOwner = { orgId: null, partnerId: null };

/**
 * The owner of the row this call names, or null when it names none (no entry, or no id, and
 * the handler answers). A row that does not exist, and an id that could not be one, have no
 * owner. Throws when the read fails, and the caller decides.
 */
export async function resolveIntentRowTarget(toolName: string, input: Record<string, unknown>): Promise<IntentRowOwner | null> {
  const entry = INTENT_ROW_TARGET[toolName]?.find((candidate) => candidate.actions === 'all' || candidate.actions.includes(input.action as string));
  if (!entry) return null;
  const raw = entry.firstOfArray && Array.isArray(input[entry.arg]) ? (input[entry.arg] as unknown[])[0] : input[entry.arg];
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (!UUID_RE.test(raw)) return NO_OWNER;

  const { table, id, org, partner } = entry.row();
  const [row] = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
    .select({ orgId: org, partnerId: partner ?? sql`null` })
    .from(table)
    .where(eq(id, raw))
    .limit(1)));
  if (!row) return NO_OWNER;
  return { orgId: (row.orgId as string | null) ?? null, partnerId: (row.partnerId as string | null) ?? null };
}
