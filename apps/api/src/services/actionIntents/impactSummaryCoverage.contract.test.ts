/**
 * #12774 contract: the impact line on an approval card says what approving
 * does. Two rules, over every (tool, action) pair that resolves to Tier 3:
 *
 *  1. The line is never a raw action list, identifier or schema fragment. A
 *     catalog description squeezed by the description budget
 *     (aiTools.descriptionBudget.contract.test.ts) is model-facing text, and
 *     `manage_tickets` showed approvers its comma-joined action enum.
 *  2. The pair has its own impact text: an IMPACT_SUMMARY_BUILDERS line, or,
 *     for a single-action tool, its catalog sentence. Pairs that had neither
 *     when this test was written get the generic line naming the tool and
 *     action and sit in IMPACT_SUMMARY_BASELINE, which is FROZEN and
 *     shrink-only: never add an entry. A new approval-gated action ships
 *     with its own impact text.
 *
 * Input-aware Tier 3 (TIER3_INPUT_AWARE_ACTIONS) is classified on argument
 * content, so each such pair is checked with a sample that escalates it.
 *
 * No vi.mock: the real registry, tier tables and builders.
 */
import { describe, expect, it } from 'vitest';

import { TIER3_ACTIONS, TIER3_INPUT_AWARE_ACTIONS, checkGuardrails } from '../aiGuardrails';
import { TOOL_ACTION_INPUT_KEYS } from '../aiToolActionKey';
import { toolActionEnum } from '../aiToolActions';
import { getAllRegisteredToolNames } from '../aiTools';
import { buildImpactSummary, genericImpactSummary, isProseImpactText } from './intentService';

/** One escalating input per TIER3_INPUT_AWARE_ACTIONS entry. */
const INPUT_AWARE_SAMPLES: Record<string, Record<string, unknown>> = {
  'manage_organizations:update_org': { action: 'update_org', orgId: 'o1' },
  'ioc_hunt:sweep': { action: 'sweep' },
  'manage_tickets:comment': { action: 'comment', ticketId: 't1', content: 'Fixed', isPublic: true },
  'manage_tickets:update_status': { action: 'update_status', ticketId: 't1', status: 'resolved' },
  'manage_tickets:update_fields': { action: 'update_fields', ticketId: 't1', fields: { submitterEmail: 'new@example.test' } },
  'manage_policy_feature_link:add': { action: 'add', featureType: 'maintenance' },
  'manage_policy_feature_link:update': { action: 'update', featureType: 'maintenance' },
  'manage_backup_profiles:create': { action: 'create', ownerScope: 'partner' },
  'manage_ticket_checklist_templates:create': { action: 'create', data: { ownerScope: 'partner' } },
  'manage_software_catalog:create': { action: 'create', ownerScope: 'partner' },
  'manage_custom_fields:create_definition': { action: 'create_definition', ownerScope: 'partner' },
  'manage_contract_templates:create': { action: 'create', ownerScope: 'partner' },
  'manage_contract_templates:update': { action: 'update', ownerScope: 'partner' },
  'manage_compliance_policies:deactivate': { action: 'deactivate', ownerScope: 'partner' },
  'manage_security_policies:create': { action: 'create', ownerScope: 'partner' },
};

/**
 * Frozen on 2026-11-27 (#12774): 256 approval-gated actions on 81 tools
 * with no impact text of their own; each shows the generic line. Shrink-only:
 * delete an action when its builder line lands. Never add one.
 */
const IMPACT_SUMMARY_BASELINE: Readonly<Record<string, readonly string[]>> = {
  apply_cis_remediation: ['apply', 'rollback'],
  apply_topology_template: ['apply'],
  browse_device_event_log: ['get_event', 'query'],
  computer_control: [
    'double_click', 'key', 'left_click', 'middle_click', 'mouse_move', 'right_click', 'screenshot', 'scroll', 'type',
  ],
  configure_vault: ['create', 'update'],
  disk_cleanup: ['execute'],
  edr_endpoint_action: ['isolate', 'unisolate'],
  execute_command: ['restart_service', 'start_service', 'stop_service'],
  file_operations: ['delete', 'mkdir', 'read', 'rename', 'write'],
  ioc_hunt: ['import_iocs', 'sweep'],
  launch_specialist: ['bulk_ticket_reply', 'operator_recipe', 'patch_plan', 'remediation_research'],
  manage_access_reviews: ['create'],
  manage_accounting_sync: ['link_mapping', 'push', 'push_bulk', 'sync_mapping', 'unlink_mapping'],
  manage_ai_agent_schedules: ['create', 'delete', 'update'],
  manage_ai_agents: ['authorize_supervised_key'],
  manage_audit_baselines: ['create'],
  manage_automations: ['create', 'delete', 'run', 'update'],
  manage_backup_profiles: ['create', 'delete', 'update'],
  manage_billing_catalog: [
    'archive_item', 'remove_org_price', 'remove_price', 'set_bundle_components', 'set_org_price', 'set_price',
    'update_item',
  ],
  manage_billing_profiles: [
    'archive', 'clear_org_profile', 'clone', 'create', 'create_work_type', 'set_org_profile', 'set_rows', 'update',
    'update_work_type',
  ],
  manage_billing_settings: ['update_org', 'update_partner'],
  manage_browser_policy: ['apply', 'create', 'update'],
  manage_compliance_policies: ['deactivate'],
  manage_configuration_policy: ['create', 'delete', 'update'],
  manage_contract_documents: ['link'],
  manage_contract_templates: ['archive', 'create', 'create_version', 'publish', 'update'],
  manage_contracts: ['generate_invoice'],
  manage_custom_fields: ['create_definition', 'delete_definition', 'set_values'],
  manage_deliverables: ['apply_template'],
  manage_delivery: [
    'create_escalation', 'create_routing', 'delete_escalation', 'delete_routing', 'set_default', 'update_escalation',
    'update_routing',
  ],
  manage_deployments: ['cancel', 'create', 'start'],
  manage_device_anomalies: ['promote'],
  manage_device_function: ['set'],
  manage_device_software: ['uninstall', 'update'],
  manage_device_warranty: ['refresh'],
  manage_dr_plan: ['delete_group'],
  manage_fleet_designs: ['apply', 'document', 'rollback', 'run'],
  manage_groups: ['add_devices', 'create', 'delete', 'remove_devices', 'update'],
  manage_hyperv_checkpoints: ['apply', 'create', 'delete'],
  manage_hyperv_vm: ['force_stop', 'pause', 'resume', 'save', 'start', 'stop'],
  manage_maintenance_windows: ['create', 'delete', 'update'],
  manage_manual_assets: ['delete'],
  manage_monitor_definitions: ['attach', 'create', 'delete', 'describe', 'detach', 'disable', 'enable', 'update'],
  manage_notification_channels: ['create', 'delete', 'update'],
  manage_org_portal_settings: ['set_sensitive_access', 'update'],
  manage_organizations: ['add_contact', 'create_org', 'create_site', 'update_org'],
  manage_pam_rules: [
    'create_rule', 'create_signer_group', 'delete_rule', 'delete_signer_group', 'set_config', 'update_rule',
    'update_signer_group',
  ],
  manage_patches: ['setup_auto_approval'],
  manage_peripheral_policies: ['create', 'update'],
  manage_peripheral_policy: ['add_exception', 'create', 'disable', 'remove_exception', 'update'],
  manage_policy_feature_link: ['add', 'remove', 'update'],
  manage_processes: ['kill'],
  manage_quotes: ['create_pay_link', 'decline'],
  manage_recovery_keys: ['collect', 'rotate'],
  manage_report_recipients: ['add', 'convert', 'remove'],
  manage_scheduled_tasks: ['disable', 'enable', 'run'],
  manage_security_policies: ['create', 'update'],
  manage_services: ['restart', 'start', 'stop'],
  manage_software_catalog: [
    'add_install_method', 'add_version', 'archive', 'create', 'delete_install_method', 'promote_version',
    'update_install_method', 'update_version',
  ],
  manage_software_deployments: ['create', 'retry'],
  manage_software_inventory: ['approve', 'clear', 'deny'],
  manage_software_policies: ['create', 'update'],
  manage_software_policy: ['create', 'delete', 'update'],
  manage_startup_items: ['disable', 'enable'],
  manage_support_sessions: ['end'],
  manage_tenant_variables: ['create', 'delete', 'update'],
  manage_ticket_attachments: ['delete'],
  manage_ticket_checklist_templates: [
    'add_item', 'create', 'delete', 'remove_item', 'reorder_items', 'update', 'update_item',
  ],
  manage_ticket_config: [
    'create_category', 'create_domain', 'create_status', 'delete_category', 'delete_domain', 'reorder_categories',
    'reorder_statuses', 'set_priorities', 'update_category', 'update_domain', 'update_org_settings', 'update_status',
  ],
  manage_ticket_forms: ['create', 'delete', 'update'],
  manage_ticket_inbox: ['convert', 'dismiss'],
  manage_ticket_response_templates: ['create', 'delete', 'update'],
  manage_ticket_routing_rules: ['create', 'delete', 'reorder', 'update'],
  manage_topology_templates: ['publish_version', 'revoke_template'],
  manage_update_rings: ['create', 'update'],
  registry_operations: ['create_key', 'delete_key', 'set_value'],
  remediate_sensitive_data: [
    'accept_risk', 'encrypt', 'false_positive', 'mark_remediated', 'quarantine', 'secure_delete',
  ],
  s1_threat_action: ['kill', 'quarantine', 'rollback'],
  security_scan: ['quarantine', 'remove', 'restore', 'scan', 'status'],
  send_endpoint_message: ['send'],
  system_cleanup: ['cancel', 'run'],
};
const BASELINE_KEYS: ReadonlySet<string> = new Set(
  Object.entries(IMPACT_SUMMARY_BASELINE).flatMap(([toolName, actions]) => actions.map((a) => `${toolName}:${a}`)),
);

interface Pair { key: string; toolName: string; action: string | undefined; input: Record<string, unknown> }

function actionInput(toolName: string, action: string | undefined): Record<string, unknown> {
  return action === undefined ? {} : { [TOOL_ACTION_INPUT_KEYS[toolName] ?? 'action']: action };
}

function approvalGatedPairs(): Pair[] {
  const pairs = new Map<string, Pair>();
  const add = (toolName: string, action: string | undefined, input: Record<string, unknown>) => {
    const key = action === undefined ? toolName : `${toolName}:${action}`;
    if (!pairs.has(key) && checkGuardrails(toolName, input).tier === 3) pairs.set(key, { key, toolName, action, input });
  };
  for (const toolName of getAllRegisteredToolNames()) {
    for (const action of toolActionEnum(toolName) ?? [undefined]) add(toolName, action, actionInput(toolName, action));
  }
  for (const [toolName, actions] of Object.entries(TIER3_ACTIONS)) {
    for (const action of actions) add(toolName, action, actionInput(toolName, action));
  }
  for (const [key, input] of Object.entries(INPUT_AWARE_SAMPLES)) {
    const [toolName, action] = key.split(':') as [string, string];
    add(toolName, action, input);
  }
  return [...pairs.values()].sort((a, b) => a.key.localeCompare(b.key));
}

const pairs = approvalGatedPairs();
const summaries = new Map(pairs.map((p) => [p.key, buildImpactSummary(p.toolName, p.input, checkGuardrails(p.toolName, p.input))]));

describe('approval impact lines (#12774)', () => {
  it('finds the approval-gated pairs', () => {
    expect(pairs.length).toBeGreaterThan(200);
  });

  it('every input-aware Tier 3 pair has a sample that resolves to Tier 3', () => {
    expect(Object.keys(INPUT_AWARE_SAMPLES).sort()).toEqual([...TIER3_INPUT_AWARE_ACTIONS].sort());
    for (const [key, input] of Object.entries(INPUT_AWARE_SAMPLES)) {
      const [toolName] = key.split(':') as [string, string];
      // manage_organizations:update_org is static Tier 3; only its approval
      // scope reads input, so isInputAwareTier3 is false for it.
      expect(checkGuardrails(toolName, input).tier, key).toBe(3);
    }
  });

  it('no impact line is an action list, identifier or schema fragment', () => {
    const offenders = pairs.filter((p) => !isProseImpactText(summaries.get(p.key)!)).map((p) => `${p.key}: ${summaries.get(p.key)}`);
    expect(offenders).toEqual([]);
  });

  it('every approval-gated pair outside the frozen baseline has its own impact text', () => {
    const missing = pairs
      .filter((p) => !BASELINE_KEYS.has(p.key))
      .filter((p) => summaries.get(p.key) === genericImpactSummary(p.toolName, p.action))
      .map((p) => p.key);
    expect(missing).toEqual([]);
  });

  it('the baseline only shrinks: every entry is still approval-gated and still generic', () => {
    const byKey = new Map(pairs.map((p) => [p.key, p]));
    const stale = [...BASELINE_KEYS].filter((key) => {
      const p = byKey.get(key);
      return !p || summaries.get(key) !== genericImpactSummary(p.toolName, p.action);
    });
    expect(stale).toEqual([]);
  });

  it('manage_tickets has impact text for every approval-gated action', () => {
    const ticketPairs = pairs.filter((p) => p.toolName === 'manage_tickets');
    expect(ticketPairs.map((p) => p.action).sort()).toEqual(
      ['comment', 'delete_comment', 'edit_comment', 'merge', 'move_org', 'update_fields', 'update_status'],
    );
    for (const p of ticketPairs) {
      expect(BASELINE_KEYS.has(p.key), p.key).toBe(false);
      expect(summaries.get(p.key), p.key).not.toBe(genericImpactSummary(p.toolName, p.action));
    }
  });
});
