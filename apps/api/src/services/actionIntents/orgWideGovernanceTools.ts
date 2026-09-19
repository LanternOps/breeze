/**
 * Org-wide GOVERNANCE tool classification.
 *
 * A deliberately dependency-free leaf module (no db, no schema, no tool
 * registry), for the same reason `services/siteCeilingAccess.ts` is one: the
 * four places that must agree on this classification sit in very different
 * import graphs — the approver fan-out (`intentApprovers.ts`), the raise gate
 * (`intentService.ts`), the decide gate (`approvals/decideApprovalRequest.ts`)
 * and the release gate (`revalidateRelease.ts`). Pulling the approver module's
 * DB + schema graph into the release worker's just to read a Map broke
 * `jobs/intentReleaseWorker.test.ts`; a leaf cannot.
 *
 * `intentApprovers.ts` re-exports both symbols, so existing importers (and
 * their `vi.mock('./intentApprovers')` factories) keep working unchanged.
 */

/**
 * Tool → actions whose EFFECT is an org-wide governance grant: an approval
 * that changes what may happen across the WHOLE org, with no per-site slice to
 * narrow it to.
 *
 * This is the approver-side twin of the raiser gate. The raiser of
 * `manage_ai_agents:authorize_supervised_key` is already refused by
 * `canMutateOrgWideGovernance` (services/aiToolsAiAgentGovernance.ts), which
 * is the same predicate every other org-wide governance object's write path
 * uses (webhooks, notification channels, config policies, PAM, backup — see
 * services/siteCeilingAccess.ts). Nothing applied it to the DECIDER of the
 * resulting four-eyes row, so a site-restricted holder of `approvals:decide`
 * could wave through a grant they could never have raised.
 *
 * Note this is only needed for the four_eyes lane. A SUPERVISED
 * agent-originated intent is already covered by the existing rule below:
 * `manage_ai_agents` is not in DEVICE_COMPLETE_TARGET_TOOLS, so its target
 * scope resolves to `{kind:'indirect'}` and
 * `userHasActionAndTargetAuthority` already requires
 * `allowedSiteIds === undefined`. Classifying the action here rather than
 * inventing a second, bespoke check keeps the two lanes on one notion of
 * "org-wide, nothing to narrow".
 *
 * An empty action set means "EVERY action of this tool" — the shape used by
 * the single-action identity-tenant tools below, whose arguments carry no
 * `action` discriminator at all.
 */

/**
 * The mutating M365 / Google Workspace helpdesk tools: whole-tool entries.
 *
 * Each of these acts on the organization's entire identity tenant (an Entra
 * directory, a Google Workspace customer) — disable an account, reset a
 * password or 2SV, rewrite mail forwarding or delegates, move an OU, assign a
 * licence. None of it has a per-site slice, so a site-restricted caller has
 * nothing to be narrowed TO: exactly the "org-wide, nothing to narrow" notion
 * this map already encodes for `authorize_supervised_key`.
 *
 * Their handlers (services/aiToolsM365.ts, services/aiToolsGoogle.ts) already
 * refuse a ceilinged caller via `canMutateOrgWideGovernance`. That was the
 * ONLY ceiling, and these are Tier-3 four-eyes tools: the durable intent is
 * minted in `onPreToolUse` BEFORE the handler runs, and an approved intent is
 * released by the worker straight into the HEADLESS `*Action` functions
 * (services/m365ToolsHeadless.ts, services/googleToolsHeadless.ts), which take
 * no AuthContext and therefore never reach the handler gate. Classifying the
 * tools here is what carries the ceiling across the durable boundary:
 * `createActionIntent` refuses the raise, the fan-out drops ceilinged
 * approvers, `decideApprovalRequest` 403s a ceilinged decider, and
 * `revalidateApprovedIntentForRelease` refuses a requester who has BECOME
 * site-restricted since raising.
 *
 * Kept as an explicit list rather than derived from `TOOL_PERMISSIONS` at
 * runtime so this module stays clear of the tool-registry import graph; the
 * derivation is asserted instead, in
 * `orgWideGovernanceCoverage.contract.test.ts`, which goes red the moment an
 * `m365_*`/`google_*` tool is mapped to `organizations:write` without being
 * listed here.
 */
const IDENTITY_TENANT_WRITE_TOOLS = [
  'm365_disable_user',
  'm365_reset_password',
  'google_add_mail_delegate',
  'google_add_to_group',
  'google_assign_license',
  'google_disable_forwarding',
  'google_move_ou',
  'google_offboard_user',
  'google_remove_from_group',
  'google_remove_license',
  'google_remove_mail_delegate',
  'google_rename_user',
  'google_reset_2sv',
  'google_reset_password',
  'google_restore_user',
  'google_set_forwarding',
  'google_set_vacation',
  'google_share_calendar',
  'google_signout',
  'google_suspend_user',
  'google_update_user',
  'google_wipe_mobile_device',
] as const;

export const ORG_WIDE_GOVERNANCE_TOOL_ACTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['manage_ai_agents', new Set(['authorize_supervised_key'])],
  ...IDENTITY_TENANT_WRITE_TOOLS.map(
    (name) => [name, new Set<string>()] as [string, ReadonlySet<string>],
  ),
]);

/**
 * True when an intent's stored `(actionName, arguments)` names an org-wide
 * governance grant, i.e. one whose decider must clear the site/exact-device
 * ceiling (`canMutateOrgWideGovernance`) exactly as its raiser did.
 */
export function isOrgWideGovernanceIntent(
  toolName: string,
  args: Record<string, unknown> | null | undefined,
): boolean {
  const actions = ORG_WIDE_GOVERNANCE_TOOL_ACTIONS.get(toolName);
  if (!actions) return false;
  if (actions.size === 0) return true;
  const action = args?.action;
  return typeof action === 'string' && actions.has(action);
}
