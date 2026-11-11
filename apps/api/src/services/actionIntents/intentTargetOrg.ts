/**
 * #11181: which org an AI tool call's action intent is filed in.
 *
 * An intent's approvers, its stored reason and a durable release's rebuilt authority are
 * all keyed on `action_intents.org_id`. A partner-scope session is bound to one org but
 * reaches others, so a call that changes org B must not be filed in the session's org A:
 * an approver of A would be approving a change to B, and a worker release would refuse.
 *
 * The rule, for both filing paths (the chat gate `createSessionPreToolUse` and
 * `createMcpActionIntent`):
 *  - a call whose ARGUMENT names the org it changes is filed in that org when the call's
 *    reach covers it, and is refused when it does not. It is never filed somewhere else.
 *    Refusing reveals nothing: `canAccessOrg` is a membership test and answers the same
 *    for a foreign org and one that does not exist.
 *  - a call that names its target by ROW ID (#11222, `intentRowTarget.ts`) is filed in the
 *    row's org when reach covers it, and is refused when it does not, or when no such row
 *    exists. The refusal is the same words for both, so a foreign id reveals nothing. A read
 *    that fails refuses too: filing it in the session org is the defect this module exists
 *    to prevent.
 *  - the design tools (`aiDesignIntentTarget.ts`, #11208) keep their own row rule: a row
 *    outside reach stays in the session org with nothing about it on the card, and the
 *    handler answers not found.
 *  - a partner-wide effect (no org argument, `ownerScope: 'partner'`, a partner baseline, an
 *    org-less row of the caller's own partner) stays in the session org. Who may approve it
 *    is `partnerWideEffect.ts`'s business, not this module's.
 *
 * Which arguments name the changed org is a per-action fact of each handler, not a
 * property of the argument's name: many tools take `orgId` only to create or list, and
 * identify the row they change by id (the inventory in the #11181 and #11222 PRs). So the
 * registries are explicit, and `intentTargetOrg.contract.test.ts` requires every Tier-3 tool
 * with an org argument, and every Tier-3 action taking an id, to be classified.
 *
 * Nothing here is an access check of its own. Handlers keep theirs.
 */
import { captureException } from '../sentry';
import { AI_DESIGN_INTENT_TOOLS, resolveAiDesignIntentTarget } from './aiDesignIntentTarget';
import { resolveIntentRowTarget } from './intentRowTarget';

/** The refusal for a named org outside reach: `resolveWritableToolOrgId`'s own wording. */
export const INTENT_ORG_OUT_OF_REACH = 'Access denied to this organization';

/** The refusal when the named row could not be read, so its org is unknown. */
export const INTENT_ROW_UNREADABLE = 'The target of this action could not be read, so it was not filed.';

type ArgumentTarget = {
  /** The input key that names the org the action changes. */
  arg: 'orgId' | 'org_id';
  /** The actions it holds for; `'all'` for a tool with no `action` (or one class for every action). */
  actions: readonly string[] | 'all';
  /** Holds only when this returns true (e.g. not a partner-owned create). */
  when?: (input: Record<string, unknown>) => boolean;
};

const notPartnerOwned = (input: Record<string, unknown>): boolean => input.ownerScope !== 'partner';

/**
 * Tier-3 tool actions whose org argument names the org they change. Each entry was read in
 * the handler: the write resolves its org from this argument (`resolveWritableToolOrgId`,
 * `canAccessOrg`, an org-scoped lookup that refuses a row of another org).
 */
export const INTENT_ORG_ARGUMENT: Readonly<Record<string, ArgumentTarget>> = {
  // W16 PR A (#6786): the launch tools.
  run_patch_plan: { arg: 'orgId', actions: 'all' },
  create_operator_task: { arg: 'orgId', actions: 'all' },
  launch_specialist: { arg: 'orgId', actions: 'all' },
  // W18 PR B (#6789): the four-eyes sensitive-access write and its supervised sibling.
  manage_org_portal_settings: { arg: 'orgId', actions: ['update', 'set_sensitive_access'] },
  configure_network_baseline: { arg: 'org_id', actions: 'all', when: (input) => input.baseline_id === undefined },
  // An AI sweep runs inside one org, resolved from this argument (`parseSingleOrgRequest`).
  ioc_hunt: { arg: 'orgId', actions: ['sweep'] },
  manage_audit_baselines: { arg: 'orgId', actions: ['create'] },
  manage_backup_verification: { arg: 'orgId', actions: ['run'] },
  manage_billing_catalog: { arg: 'orgId', actions: ['set_org_price', 'remove_org_price'] },
  manage_billing_profiles: { arg: 'orgId', actions: ['set_org_profile', 'clear_org_profile'] },
  manage_billing_settings: { arg: 'orgId', actions: ['update_org'] },
  manage_browser_policy: { arg: 'orgId', actions: ['create'] },
  manage_c2c_configs: { arg: 'orgId', actions: ['create', 'update', 'delete'] },
  manage_configuration_policy: { arg: 'orgId', actions: ['create'], when: notPartnerOwned },
  manage_deliverables: { arg: 'orgId', actions: ['apply_template'] },
  manage_delivery: { arg: 'orgId', actions: ['create_routing', 'set_default', 'create_escalation'], when: notPartnerOwned },
  manage_deployments: { arg: 'orgId', actions: ['create'] },
  manage_groups: { arg: 'orgId', actions: ['create'] },
  manage_notification_channels: { arg: 'orgId', actions: ['create'] },
  manage_organizations: { arg: 'orgId', actions: ['update_org', 'create_site', 'add_contact'] },
  manage_pam_rules: { arg: 'orgId', actions: ['create_rule', 'set_config', 'create_signer_group'] },
  manage_patches: { arg: 'orgId', actions: ['install'] },
  manage_peripheral_policies: { arg: 'orgId', actions: ['create'] },
  manage_peripheral_policy: { arg: 'org_id', actions: ['create'] },
  manage_security_policies: { arg: 'orgId', actions: ['create'], when: notPartnerOwned },
  // orgId must equal the item's org or the handler refuses, so naming it names the target.
  manage_software_catalog: {
    arg: 'orgId',
    actions: ['archive', 'add_version', 'update_version', 'promote_version', 'add_install_method', 'update_install_method', 'delete_install_method'],
  },
  manage_software_deployments: { arg: 'orgId', actions: ['create', 'retry'] },
  manage_software_inventory: { arg: 'orgId', actions: ['approve', 'deny', 'clear'] },
  manage_software_policies: { arg: 'orgId', actions: ['create'], when: notPartnerOwned },
  manage_software_policy: { arg: 'orgId', actions: ['create'] },
  manage_tenant_variables: { arg: 'orgId', actions: ['create'], when: notPartnerOwned },
  manage_ticket_config: { arg: 'orgId', actions: ['update_org_settings'] },
  manage_ticket_forms: { arg: 'orgId', actions: ['create'], when: notPartnerOwned },
  manage_ticket_inbox: { arg: 'orgId', actions: ['convert'] },
  manage_ticket_routing_rules: { arg: 'orgId', actions: ['create'], when: notPartnerOwned },
  s1_isolate_device: { arg: 'orgId', actions: 'all' },
  s1_threat_action: { arg: 'orgId', actions: 'all' },
};

/**
 * Tier-3 tools that take an org argument which does NOT name the org their approval-class
 * actions change (the actions not listed above). Most name a row instead, and are resolved
 * from it (`INTENT_ROW_TARGET`); the rest stay where they are filed today.
 */
export const ORG_ARGUMENT_NOT_TARGET: Readonly<Record<string, string>> = {
  configure_network_baseline: 'an update names its baseline by `baseline_id`; `org_id` is ignored',
  ioc_hunt: '`import_iocs` names its rule set by id; `orgId` is a sweep and list argument',
  manage_ai_agents: '`orgId` is an address that must equal the authorized org (createActionIntent refuses a mismatch)',
  manage_backup_profiles: 'a profile is named by `profileId` and may be partner-wide',
  manage_billing_catalog: 'the catalog item writes are partner-wide',
  manage_billing_profiles: 'the profile and work-type writes are partner-wide',
  manage_billing_settings: '`update_partner` is partner-wide',
  manage_browser_policy: 'update and apply name the policy by `policyId`',
  manage_configuration_policy: 'update and delete name the policy by `policyId`; a partner-owned create is partner-wide',
  manage_contract_documents: '`link` names the document and contract by id; `orgId` is a list filter',
  manage_contract_templates: 'the version writes name the template by `templateId`',
  manage_custom_fields: 'the writes name a field definition or a device',
  manage_delivery: 'updates and deletes name the row by id; a partner-owned create is partner-wide',
  manage_deployments: 'start and cancel name the deployment by id',
  manage_dr_plan: '`delete_group` names the plan and group by id',
  manage_groups: 'the group writes name the group by id',
  manage_invoices: 'the money actions name the invoice by `invoiceId`',
  manage_manual_assets: '`delete` names the asset by id',
  manage_notification_channels: 'update and delete name the channel by id, which may be partner-wide',
  manage_organizations: '`create_org` creates a new organization',
  manage_pam_rules: 'updates and deletes name the rule or signer group by id',
  manage_patches: 'a rollback takes its org from the devices; `setup_auto_approval` is disabled',
  manage_pax8_orders: 'the order actions name the order by id',
  manage_pax8_subscriptions: '`sync` is partner-wide; link and unlink name the snapshot by id',
  manage_peripheral_policies: '`update` names the policy by id',
  manage_peripheral_policy: 'the policy writes name the policy by `policy_id`',
  manage_security_policies: '`update` names the policy by id',
  manage_software_policies: '`update` names the policy by id; a partner-owned create is partner-wide',
  manage_software_policy: 'update and delete name the policy by id',
  manage_tenant_variables: 'update and delete name the variable by id; a partner-owned create is partner-wide',
  manage_ticket_checklist_templates: 'the writes name the template by id; `orgId` is a list filter',
  manage_ticket_config: 'the category, status, priority and domain writes are partner-wide',
  manage_ticket_forms: 'update and delete name the form by id; a partner-owned create is partner-wide',
  manage_ticket_inbox: '`dismiss` names the message by id',
  manage_ticket_routing_rules: 'updates, deletes and reorder name rules by id; `orgIds` scopes a partner-wide rule',
  manage_tickets: 'the writes name tickets and comments by id; `move_org` changes the ticket\'s org and `targetOrgId`',
  manage_topology_templates: 'the version writes name the template by id',
  run_flow: 'an org flow runs in its own org; a partner flow names its run org, resolved by the run-flow gate',
  send_endpoint_message: '`orgId` is a list filter; the audience is `targets`, which may span organizations',
  wisp_specialist_request: 'filed by the coordinator in the request org; release refuses an intent of another org',
};

/** The org this call's ARGUMENT names as the one it changes, or null. */
export function argumentTargetOrg(toolName: string, input: Record<string, unknown>): string | null {
  const entry = INTENT_ORG_ARGUMENT[toolName];
  if (!entry) return null;
  if (entry.actions !== 'all' && !entry.actions.includes(input.action as string)) return null;
  if (entry.when && !entry.when(input)) return null;
  const orgId = input[entry.arg];
  return typeof orgId === 'string' && orgId.length > 0 ? orgId : null;
}

export type IntentTarget = {
  orgId: string | null;
  /** The owning partner of an org-less row, so the caller can tell its own from another's. */
  partnerId: string | null;
  /** The org came from an argument the caller wrote, not from a stored row. */
  fromArgument: boolean;
  /** Appended to the approval headline, once the target is known to be in reach. */
  cardDetail?: string;
  /** The org came from a row named by id (#11222): out of reach and no row both refuse. */
  fromRow?: true;
  /** The named row could not be read (#11222). */
  unreadable?: true;
};

/**
 * The target a call names, or null when it names none. Reads a row for the design tools
 * and the row-identified writes (as system: the row may be in an org the session is not
 * bound to). A design tool's failed read throws, and the caller decides. A row-identified
 * write's is reported here and refused by `decideIntentOrg`.
 */
export async function resolveIntentTarget(toolName: string, input: Record<string, unknown>): Promise<IntentTarget | null> {
  if (AI_DESIGN_INTENT_TOOLS.has(toolName)) {
    const target = await resolveAiDesignIntentTarget(toolName, input);
    return target ? { fromArgument: false, ...target } : null;
  }
  const orgId = argumentTargetOrg(toolName, input);
  if (orgId) return { orgId, partnerId: null, fromArgument: true };
  try {
    const row = await resolveIntentRowTarget(toolName, input);
    return row ? { ...row, fromArgument: false, fromRow: true } : null;
  } catch (err) {
    console.error('[AI-intents] Failed to read the row an action names:', toolName, err);
    captureException(err);
    return { orgId: null, partnerId: null, fromArgument: false, fromRow: true, unreadable: true };
  }
}

export type IntentOrgDecision =
  | { kind: 'target'; orgId: string; cardDetail?: string }
  | { kind: 'session'; cardDetail?: string }
  | { kind: 'refuse'; error: string };

export type IntentReach = { canAccessOrg: (orgId: string) => boolean; partnerId?: string | null; scope?: string };

/** Where the intent goes, given the call's reach (the session's tool auth, cut to a Wisp ceiling). */
export function decideIntentOrg(target: IntentTarget | null, reach: IntentReach): IntentOrgDecision {
  if (!target) return { kind: 'session' };
  if (target.unreadable) return { kind: 'refuse', error: INTENT_ROW_UNREADABLE };
  if (target.orgId) {
    if (reach.canAccessOrg(target.orgId)) {
      return target.cardDetail ? { kind: 'target', orgId: target.orgId, cardDetail: target.cardDetail } : { kind: 'target', orgId: target.orgId };
    }
    return target.fromArgument || target.fromRow ? { kind: 'refuse', error: INTENT_ORG_OUT_OF_REACH } : { kind: 'session' };
  }
  // A row-identified write's org-less row is partner-wide only for the partner that owns it.
  // A row of another partner, and no row at all, get the same refusal as a foreign org.
  if (target.fromRow) {
    const ownPartner = target.partnerId !== null && (reach.scope === 'system' || target.partnerId === (reach.partnerId ?? null));
    return ownPartner ? { kind: 'session' } : { kind: 'refuse', error: INTENT_ORG_OUT_OF_REACH };
  }
  // An org-less row is partner-wide: the session org keeps it, and its card detail is shown
  // only to a caller of the partner that owns it.
  if (target.cardDetail && target.partnerId !== null && target.partnerId === (reach.partnerId ?? null)) {
    return { kind: 'session', cardDetail: target.cardDetail };
  }
  return { kind: 'session' };
}
