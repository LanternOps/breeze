/**
 * Which four-eyes actions can reach past one organization, so that a second approver
 * must hold the partner axis. A dependency-free leaf, for the reason
 * `orgWideGovernanceTools.ts` is one: fan-out, decide and release sit in different
 * import graphs, and every other intent should pay for this with one Map lookup. The
 * reads live in `partnerAxisApprover.ts`, loaded only when this says yes.
 *
 * An intent's approvers are keyed on `action_intents.org_id`. An action whose effect
 * spans the partner still files in one org, so that org's `approvals:decide` holders
 * are the wrong population: raising it took `canManagePartnerWidePolicies`, and the
 * second person should clear the same bar.
 *
 * Entries, with what was left out:
 *  - `manage_ai_agent_schedules:delete`: deleting a baseline cascades every org's
 *    override. `create` and `update` are supervised, so nobody else decides them.
 *  - Not `manage_org_portal_settings:set_sensitive_access`: partner-axis at release,
 *    but it changes one org's portal, and that org is the intent's.
 *  - Not `manage_fleet_designs` apply or rollback: both act on one org's design.
 */
export const PARTNER_WIDE_EFFECT_ACTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['manage_ai_agent_schedules', new Set(['delete'])],
]);

/**
 * True when this `(tool, arguments)` is in the registry. Answers "worth reading the
 * row", not "is partner-wide": `intentRequiresPartnerAxisApprover` decides that.
 */
export function mayHavePartnerWideEffect(
  toolName: string,
  args: Record<string, unknown> | null | undefined,
): boolean {
  const action = args?.action;
  return typeof action === 'string' && PARTNER_WIDE_EFFECT_ACTIONS.get(toolName)?.has(action) === true;
}

/** On the approval card, wherever the action was filed from. */
export const PARTNER_LEVEL_APPROVER_NOTE = 'This needs a partner-level approver.';

/** The decide route's and the release's refusal token. */
export const APPROVER_SCOPE_REQUIRED = 'approver_scope_required';

export const APPROVER_SCOPE_REQUIRED_MESSAGE =
  'This approval affects every organization under the partner, so it needs a partner-level approver with access to all organizations.';
