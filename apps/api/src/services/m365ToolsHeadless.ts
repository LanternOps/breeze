/**
 * Headless dispatch for M365 Tier-3 tools, used by the durable action-intents
 * release worker. Resolves the org's customer-graph-actions connection by the
 * immutable intent.orgId (NO live Delegant/direct-Graph session) via
 * executeM365WriteActionByOrg, which re-checks org-match + active status and
 * fails closed.
 *
 * The action map is the effective allowlist and is pinned to the tier-3
 * m365ToolTiers set by a parity test (m365ToolsHeadless.test.ts). Mirrors the
 * Google equivalent (googleToolsHeadless.ts) 1:1 in structure and semantics.
 */
import { m365WriteActionSchema, type M365WriteActionId } from '@breeze/shared/m365';
import { executeM365WriteActionByOrg } from './m365ControlPlane/writeActionService';

/** Thrown when the org's actions connection is missing/rotated/inactive/rate-limited/executor-down at release. */
export class M365ConnectionUnavailableError extends Error {
  constructor(public readonly toolResult: string) {
    super('Microsoft 365 actions connection unavailable for headless release');
    this.name = 'M365ConnectionUnavailableError';
  }
}

/** Tool name → typed write-action id. This map is the headless allowlist. */
export const M365_HEADLESS_ACTIONS: Record<string, M365WriteActionId> = {
  m365_disable_user: 'm365.user.disable',
  m365_reset_password: 'm365.user.reset_password',
  m365_revoke_sessions: 'm365.user.revoke_sessions',
  m365_remove_license: 'm365.user.license.remove',
  m365_assign_license: 'm365.user.license.assign',
  m365_remove_from_group: 'm365.group.membership.remove',
  m365_add_to_group: 'm365.group.membership.add',
  m365_retire_intune_device: 'm365.intune.device.retire',
  m365_create_user: 'm365.user.create',
  m365_set_auto_reply: 'm365.user.mailbox.auto_reply',
};
// Invariant: keys(M365_HEADLESS_ACTIONS) === tier-3 m365ToolTiers set.
// Enforced by the parity unit test in m365ToolsHeadless.test.ts.

// Refusals that mean "no side effect happened, fail closed as connection
// unavailable" (vs a Graph-level failure, which is a real terminal tool
// error and must be RETURNED, not thrown, so the worker records
// tool_returned_error rather than connection_unavailable).
const CONNECTION_UNAVAILABLE_CODES = new Set([
  'tools_disabled',
  'connection_not_ready',
  'write_rate_limited',
  'executor_unavailable',
  // Authoritative grant observation lacks a role this action needs; refused
  // before any Graph call, so it fails closed exactly like connection_not_ready.
  'consent_upgrade_required',
]);

/**
 * Action id -> the typed action body built from the intent's CAPTURED
 * arguments. Every field is read explicitly; nothing is spread, so a stale or
 * attacker-influenced extra key can never reach Graph (the schema is
 * .strict(), which would turn a spread into a parse failure instead).
 * Exported so the effect-probe adapter builds the same body.
 */
export function buildWriteAction(actionId: M365WriteActionId, input: Record<string, unknown>): unknown {
  const optional = (keys: readonly string[]): Record<string, unknown> =>
    Object.fromEntries(keys.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]));
  switch (actionId) {
    case 'm365.user.disable':
    case 'm365.user.reset_password':
    case 'm365.user.revoke_sessions':
      return { type: actionId, userIdentifier: input.userIdentifier, reason: input.reason };
    case 'm365.user.license.remove':
      return { type: actionId, userIdentifier: input.userIdentifier, skuIds: input.skuIds, reason: input.reason };
    case 'm365.user.license.assign':
      return {
        type: actionId, userIdentifier: input.userIdentifier, skuIds: input.skuIds,
        ...optional(['disabledPlanIds']),
        reason: input.reason,
      };
    case 'm365.group.membership.remove':
    case 'm365.group.membership.add':
      return { type: actionId, groupId: input.groupId, userIdentifier: input.userIdentifier, reason: input.reason };
    case 'm365.intune.device.retire':
      return { type: actionId, managedDeviceId: input.managedDeviceId, reason: input.reason };
    case 'm365.user.create':
      return {
        type: actionId, userPrincipalName: input.userPrincipalName, displayName: input.displayName,
        mailNickname: input.mailNickname, usageLocation: input.usageLocation, reason: input.reason,
      };
    case 'm365.user.mailbox.auto_reply':
      return {
        type: actionId, userIdentifier: input.userIdentifier, status: input.status,
        ...optional([
          'internalReplyMessage', 'externalReplyMessage', 'externalAudience',
          'scheduledStartDateTime', 'scheduledEndDateTime',
        ]),
        reason: input.reason,
      };
    default: {
      const exhaustive: never = actionId;
      throw new Error(`buildWriteAction: unhandled ${String(exhaustive)}`);
    }
  }
}

export function isHeadlessM365Tool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(M365_HEADLESS_ACTIONS, name);
}

/**
 * @param idempotencyKey Passed through as `executeM365WriteActionByOrg`'s
 *   `opts.idempotencyKey`. The release worker passes the immutable
 *   `intent.id` — the natural dedup key for a retried release (see
 *   `writeActionRequestSchema`'s doc comment in
 *   `@breeze/shared/m365/writeActions.ts`). Optional only so this function
 *   remains callable without a worker context (e.g. ad hoc/testing); callers
 *   that have an intent id MUST pass it.
 */
export async function executeM365ToolHeadless(
  actionName: string,
  args: unknown,
  orgId: string,
  idempotencyKey?: string,
): Promise<string> {
  const actionId = M365_HEADLESS_ACTIONS[actionName];
  if (!actionId) {
    throw new Error(`executeM365ToolHeadless: "${actionName}" is not a headless M365 tool`);
  }
  const input = (args ?? {}) as Record<string, unknown>;
  const parsed = m365WriteActionSchema.safeParse(buildWriteAction(actionId, input));
  if (!parsed.success) {
    // Bad captured arguments — a terminal tool error, not a connection issue.
    return JSON.stringify({ error: 'Invalid M365 action arguments for headless execution.' });
  }

  const outcome = await executeM365WriteActionByOrg(orgId, parsed.data, { idempotencyKey });

  if (!outcome.ok) {
    if (CONNECTION_UNAVAILABLE_CODES.has(outcome.code)) {
      // Fail closed: no Graph call was made (or none should be retried inline).
      throw new M365ConnectionUnavailableError(JSON.stringify({ error: outcome.message }));
    }
    // Graph-level failure (user_not_found, graph_error, …) → returned tool error.
    return JSON.stringify({ error: outcome.message });
  }

  // Success body is normalized and passed through sealActionResultSecrets by
  // the release worker before storage (has `success`, so isReturnedToolError
  // treats it as a completion). For reset the temporaryPassword is encrypted
  // at rest in intent.result and revealed once via
  // POST /action-intents/:id/reveal-secret.
  return JSON.stringify(outcome.result);
}
