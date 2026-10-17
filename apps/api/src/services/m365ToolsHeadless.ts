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
import { callerAction } from './actionIntents/callerTarget';
import { buildAuthContextForIntent } from './actionIntents/actorContext';
import { CallerVerificationValidationError } from './callerVerification/errors';
import type { CallerVerificationAction } from './callerVerification/types';

/** Thrown when the org's actions connection is missing/rotated/inactive/rate-limited/executor-down at release. */
export class M365ConnectionUnavailableError extends Error {
  constructor(public readonly toolResult: string) {
    super('Microsoft 365 actions connection unavailable for headless release');
    this.name = 'M365ConnectionUnavailableError';
  }
}

/** Tool name → typed write-action id. This map is the headless allowlist. */
const HEADLESS_ACTION_MAP = {
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
} as const satisfies Record<string, M365WriteActionId>;

// Compile-time totality: every write action id has a headless tool (the
// `satisfies` above already admits write ids only, so no probe id can appear).
type UncoveredWriteIds = Exclude<M365WriteActionId, (typeof HEADLESS_ACTION_MAP)[keyof typeof HEADLESS_ACTION_MAP]>;
const EVERY_WRITE_ID_HAS_A_TOOL: [UncoveredWriteIds] extends [never] ? true : false = true;
void EVERY_WRITE_ID_HAS_A_TOOL;

export const M365_HEADLESS_ACTIONS: Readonly<Record<string, M365WriteActionId>> = HEADLESS_ACTION_MAP;
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
  const protectedAction = callerAction(actionName);
  if (protectedAction) {
    return executeProtectedM365Headless(protectedAction, input, orgId, idempotencyKey);
  }
  const parsed = m365WriteActionSchema.safeParse(buildWriteAction(actionId, input));
  // The type equality is the runtime proof that only the tool's own mutating
  // arm can pass (buildWriteAction stamps it; a probe arm never can).
  if (!parsed.success || parsed.data.type !== actionId) {
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

/**
 * Caller verification W05 (#6354): headless release of the two protected
 * identity actions. The intent's PINNED connection decides the backend — a
 * direct-Graph or Delegant pin is never switched to the control plane (or vice
 * versa) — and the mutation goes to the pinned object id only. Every backend
 * runs `prepareCallerDispatch` immediately before its outbound call; a typed
 * refusal propagates as `CallerVerificationRequiredError` for the worker to
 * terminalize without retry.
 *
 * `intentId` is the release worker's immutable `intent.id` (it is also the
 * executor idempotency key). Without it the protected action refuses.
 */
async function executeProtectedM365Headless(
  action: CallerVerificationAction,
  input: Record<string, unknown>,
  orgId: string,
  intentId: string | undefined,
): Promise<string> {
  // Lazy: aiToolsM365 imports buildWriteAction from this module.
  const { loadM365MutationContext, m365DisableUserHandler, m365ResetPasswordHandler } = await import('./aiToolsM365');
  let loaded;
  try {
    loaded = await loadM365MutationContext(orgId, action, intentId);
  } catch (error) {
    if (error instanceof CallerVerificationValidationError && error.code === 'connection_not_ready') {
      // The pinned connection is gone/inactive/re-pointed: nothing was sent.
      throw new M365ConnectionUnavailableError(JSON.stringify({ error: error.message }));
    }
    throw error;
  }
  const context = { actionIntentId: loaded.intent.id };

  if (loaded.ctx.backend === 'controlPlane') {
    const reason = typeof input.reason === 'string' ? input.reason : '';
    const parsed = m365WriteActionSchema.safeParse({
      type: action === 'disable_user' ? 'm365.user.disable' : 'm365.user.reset_password',
      oid: loaded.userId,
      reason,
    });
    if (!parsed.success) {
      return JSON.stringify({ error: 'Invalid M365 action arguments for headless execution.' });
    }
    const outcome = await executeM365WriteActionByOrg(orgId, parsed.data, {
      actionIntentId: loaded.intent.id,
      idempotencyKey: loaded.intent.id,
      ...(loaded.intent.requestedByUserId ? { actorId: loaded.intent.requestedByUserId } : {}),
    });
    if (!outcome.ok) {
      if (CONNECTION_UNAVAILABLE_CODES.has(outcome.code)) {
        throw new M365ConnectionUnavailableError(JSON.stringify({ error: outcome.message }));
      }
      return JSON.stringify({ error: outcome.message });
    }
    return JSON.stringify(outcome.result);
  }

  // Direct Graph / Delegant pins dispatch through the same handlers as the
  // live chat path, under the rebuilt requester (the worker already re-proved
  // that actor's current authorization). The broker session id is correlation
  // only — it never creates a step-up or session context.
  const auth = await buildAuthContextForIntent(loaded.intent);
  if (!auth) throw new Error('Intent actor unavailable');
  if (action === 'disable_user') {
    return m365DisableUserHandler(input, auth, loaded.intent.id, context);
  }
  const result = await m365ResetPasswordHandler(input, auth, loaded.intent.id, context);
  if (result.kind === 'error') return result.llmText;
  // `action` is set AFTER the spread so the worker's sealer
  // (sealActionResultSecrets keys on it) always recognises the credential.
  return JSON.stringify({
    ...result.secrets, success: true, forceChangeNextSignIn: true, action: 'm365.user.reset_password',
  });
}
