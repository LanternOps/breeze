/**
 * MCP-side creation of a Tier-3 action intent (B-W04 #6158, D-B25/D-B27).
 *
 * The MCP route calls this only after every gate a direct Tier-3 call passes
 * today (domain, guardrail tier, scope/admin, production allowlist, MFA,
 * RBAC, per-tool rate limit, execution-org resolution, isMcpIntentEligible).
 * Nothing executes here: the release worker is the only executor.
 *
 * The idempotency key binds the request to the ORIGIN credential
 * (`mcpOriginRef`), the tool and the canonical argument digest, so the same
 * call from the same credential while its intent is live converges on that
 * intent, and a second credential of the same human never does.
 */
import { eq } from 'drizzle-orm';
import { canonicalizeArguments, computeArgumentDigest } from '@breeze/shared/canonicalize';
import type { AuthContext } from '../middleware/auth';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { actionIntents } from '../db/schema/actionIntents';
import { ActionIntentError, createActionIntent } from './actionIntents/intentService';
import { validateToolInput } from './aiToolSchemas';
import { rateLimiter } from './rate-limit';
import { getRedis } from './redis';
import {
  mcpIntentCreatesPerHour,
  mcpIntentCreatesPerUserPerHour,
  mcpIntentMaxLivePerPrincipal,
} from './mcpIntentConfig';
import { mcpIntentIdempotencyKey, mcpOriginRef } from './mcpIntentEligibility';
import { toMcpActionStatus, type McpActionStatus } from './mcpActionStatus';
import type { McpApiKeyContext } from './mcpPrincipalAuth';

export type CreateMcpActionIntentInput = {
  auth: AuthContext;
  apiKey: McpApiKeyContext & { principalType?: string };
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Authoritative execution org from resolveMcpExecutionContext. */
  executionOrgId: string;
  /** B-W03 correlation.requestId — stored as the intent's correlation_id. */
  correlationRequestId: string;
  /** "MCP · <key name | OAuth client name>". */
  clientLabel: string;
  appBaseUrl: string;
};

export type McpIntentRefusalCode =
  | 'too_many_pending_actions'
  | 'rate_limited'
  | 'no_eligible_approvers'
  | 'no_eligible_approvers_site_ceiling'
  | 'invalid_params'
  | 'principal_not_supported';

export type CreateMcpActionIntentOutcome =
  | { kind: 'pending'; status: McpActionStatus; isNew: boolean }
  | { kind: 'terminal_replay'; status: McpActionStatus }
  | { kind: 'refused'; code: McpIntentRefusalCode; message: string };

const REFUSAL_MESSAGES: Record<McpIntentRefusalCode, string> = {
  too_many_pending_actions:
    'Too many actions from this connection are already waiting for approval. Wait for them to be decided, or cancel some with cancel_action.',
  rate_limited: 'Too many actions were filed for approval in the last hour. Try again later.',
  no_eligible_approvers: 'Nobody can approve this action in this organization, so it was not filed.',
  no_eligible_approvers_site_ceiling:
    'Nobody who can approve this action has access to every site it affects, so it was not filed.',
  invalid_params: 'Invalid params',
  principal_not_supported: 'This connection cannot file actions for approval.',
};

const PASSTHROUGH_REFUSALS: ReadonlySet<string> = new Set([
  'too_many_pending_actions',
  'rate_limited',
  'principal_not_supported',
]);

const HOUR_S = 3600;

function refused(code: McpIntentRefusalCode, message = REFUSAL_MESSAGES[code]): CreateMcpActionIntentOutcome {
  return { kind: 'refused', code, message };
}

/** Churn guards (D-B27 step 4): per origin credential AND per requesting human. */
async function chargeCreation(originRef: string, userId: string): Promise<void> {
  const redis = getRedis();
  const perOrigin = await rateLimiter(redis, `mcp-intent-create:origin:${originRef}`, mcpIntentCreatesPerHour(), HOUR_S);
  if (!perOrigin.allowed) throw new ActionIntentError(REFUSAL_MESSAGES.rate_limited, 'rate_limited');
  const perUser = await rateLimiter(redis, `mcp-intent-create:user:${userId}`, mcpIntentCreatesPerUserPerHour(), HOUR_S);
  if (!perUser.allowed) throw new ActionIntentError(REFUSAL_MESSAGES.rate_limited, 'rate_limited');
}

export async function createMcpActionIntent(input: CreateMcpActionIntentInput): Promise<CreateMcpActionIntentOutcome> {
  const { auth, apiKey, toolName, toolInput } = input;
  const originRef = mcpOriginRef(auth.principal);
  // Partner service principals have no origin ref; org service-principal keys
  // are authorized against the principal, not a human, so there is no
  // requester to approve for.
  if (!originRef || apiKey.principalType === 'service' || apiKey.partnerServicePrincipalId) {
    return refused('principal_not_supported');
  }

  const validation = validateToolInput(toolName, toolInput);
  if (!validation.success) return refused('invalid_params');

  // Same canonicalisation createActionIntent stores as argument_digest, over
  // the input as sent (not the schema's parsed defaults).
  const argumentDigest = computeArgumentDigest(canonicalizeArguments(toolInput));

  let snapshot: Awaited<ReturnType<typeof createActionIntent>>;
  try {
    snapshot = await runOutsideDbContext(() => createActionIntent(auth, {
      toolName,
      input: toolInput,
      source: 'mcp_api',
      orgId: input.executionOrgId,
      idempotencyKey: mcpIntentIdempotencyKey(originRef, toolName, argumentDigest),
      correlationId: input.correlationRequestId,
      requestingClientLabel: input.clientLabel.slice(0, 255),
      maxLiveForOrigin: mcpIntentMaxLivePerPrincipal(),
      beforeInsert: () => chargeCreation(originRef, auth.user.id),
    }));
  } catch (err) {
    if (err instanceof ActionIntentError && PASSTHROUGH_REFUSALS.has(err.code)) {
      return refused(err.code as McpIntentRefusalCode);
    }
    throw err;
  }

  // The snapshot omits approval scope and executedAt; read the row once.
  const [row] = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
    .select({
      id: actionIntents.id,
      status: actionIntents.status,
      actionName: actionIntents.actionName,
      approvalScope: actionIntents.approvalScope,
      expiresAt: actionIntents.expiresAt,
      result: actionIntents.result,
      errorCode: actionIntents.errorCode,
      executedAt: actionIntents.executedAt,
    })
    .from(actionIntents)
    .where(eq(actionIntents.id, snapshot.id))
    .limit(1)));
  if (!row) throw new Error(`action intent ${snapshot.id} vanished after creation`);

  // Filed and immediately cancelled for lack of approvers: a refusal, still
  // charged against the churn guards (D-B27).
  if (row.status === 'cancelled'
    && (row.errorCode === 'no_eligible_approvers' || row.errorCode === 'no_eligible_approvers_site_ceiling')) {
    return refused(row.errorCode);
  }

  const status = toMcpActionStatus(row, input.appBaseUrl);
  if (row.status === 'pending_approval' || row.status === 'approved' || row.status === 'executing') {
    // A brand-new row is always pending_approval; a live replay may have moved on.
    return { kind: 'pending', status, isNew: snapshot.replayed !== true };
  }
  return { kind: 'terminal_replay', status };
}
