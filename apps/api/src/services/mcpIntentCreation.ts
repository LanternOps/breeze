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
import { and, eq, inArray, sql } from 'drizzle-orm';
import { canonicalizeArguments, computeArgumentDigest } from '@breeze/shared/canonicalize';
import type { AuthContext } from '../middleware/auth';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { actionIntents, type ActionIntent } from '../db/schema/actionIntents';
import { oauthClients } from '../db/schema/oauth';
import { apiKeys } from '../db/schema/apiKeys';
import { withAuthDbAccessContext } from '../middleware/auth';
import { ActionIntentError, cancelActionIntent, createActionIntent } from './actionIntents/intentService';
import { validateToolInput } from './aiToolSchemas';
import { rateLimiter } from './rate-limit';
import { getRedis } from './redis';
import {
  mcpIntentCreatesPerHour,
  mcpIntentCreatesPerUserPerHour,
  mcpIntentMaxLivePerPrincipal,
} from './mcpIntentConfig';
import { isMcpOriginIntent, mcpIntentIdempotencyKey, mcpOriginRef } from './mcpIntentEligibility';
import { approvalRequests } from '../db/schema/approvals';
import { revokeApiKey } from './apiKeyRevocation';
import { revokeGrantsDurablyInCurrentDbContext } from '../oauth/grantStatus';
import { writeOAuthRevocationMarkerDurably } from '../oauth/revocationRetry';
import { ACCESS_TOKEN_TTL_SECONDS } from '../oauth/provider';
import { createNotification } from './userNotifications';
import { captureException } from './sentry';
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
      // #9758: the epoch the bearer middleware admitted this OAuth call at;
      // release refuses once the requester's live auth_epoch has moved.
      ...(auth.principal.kind === 'oauth_grant' ? { originAuthEpoch: apiKey.oauthAuthEpoch ?? undefined } : {}),
      maxLiveForOrigin: mcpIntentMaxLivePerPrincipal(),
      // #10027: the MCP gate files a non-read action rated below Tier 3 on a
      // registry-Tier-3 tool (edr_endpoint_action scan); approve it at Tier 3.
      mcpRegistryTierApproval: true,
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * "MCP · <key name | OAuth client name>" for the approval card and push
 * (requesting_client_label, <= 255). OAuth bearers carry the synthetic name
 * 'OAuth bearer', so the registered client name is looked up. Never throws.
 */
export async function resolveMcpClientLabel(apiKey: McpApiKeyContext & { name?: string }): Promise<string> {
  let name = typeof apiKey.name === 'string' && apiKey.name.length > 0 ? apiKey.name : 'API key';
  if (apiKey.oauthClientId) {
    name = 'OAuth client';
    try {
      const [row] = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
        .select({ clientName: sql<string | null>`${oauthClients.metadata}->>'client_name'` })
        .from(oauthClients)
        .where(eq(oauthClients.id, apiKey.oauthClientId!))
        .limit(1)));
      if (row?.clientName) name = row.clientName;
    } catch (err) {
      console.error('[MCP] Failed to resolve OAuth client name for the approval label:', err);
    }
  }
  return `MCP · ${name}`.slice(0, 255);
}

/**
 * The caller's own MCP-origin intent, or null. Ownership = source mcp_api AND
 * the stored origin (kind, id) equals the caller's credential, read under the
 * caller's DB access context. Unknown id, another credential's intent (even
 * the same human's other key), another org's or a chat intent all return
 * null, so callers answer them identically (no existence oracle).
 */
export async function loadOwnedMcpIntent(auth: AuthContext, actionId: unknown): Promise<ActionIntent | null> {
  const ref = mcpOriginRef(auth.principal);
  if (!ref || typeof actionId !== 'string' || !UUID_RE.test(actionId)) return null;
  const sep = ref.indexOf(':');
  const kind = ref.slice(0, sep) as 'api_key' | 'oauth_grant';
  const originId = ref.slice(sep + 1);
  const [row] = await withAuthDbAccessContext(auth, () => db
    .select()
    .from(actionIntents)
    .where(and(
      eq(actionIntents.id, actionId.toLowerCase()),
      eq(actionIntents.source, 'mcp_api'),
      eq(actionIntents.originPrincipalKind, kind),
      eq(actionIntents.originPrincipalId, originId),
    ))
    .limit(1));
  return row ?? null;
}

/**
 * B-W06 (#6160, D-B52): the caller origin credential's LIVE `mcp_api` intents
 * across all orgs — the same predicate (and so the same partial index,
 * action_intents_live_origin_idx) the creation cap counts under. Read under
 * system context exactly like that cap: the filter is the caller's own
 * credential, and only a count leaves the query. 0 when the principal has no
 * origin ref (it can own no intents).
 */
export async function countLiveMcpIntentsForOrigin(auth: AuthContext): Promise<number> {
  const ref = mcpOriginRef(auth.principal);
  if (!ref) return 0;
  const sep = ref.indexOf(':');
  const kind = ref.slice(0, sep) as 'api_key' | 'oauth_grant';
  const originId = ref.slice(sep + 1);
  const [row] = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
    .select({ n: sql<number>`count(*)::int` })
    .from(actionIntents)
    .where(and(
      eq(actionIntents.source, 'mcp_api'),
      eq(actionIntents.originPrincipalKind, kind),
      eq(actionIntents.originPrincipalId, originId),
      inArray(actionIntents.status, ['pending_approval', 'approved', 'executing']),
    ))));
  return row?.n ?? 0;
}

export type CancelOwnedMcpIntentOutcome =
  | { kind: 'not_found' }
  | { kind: 'cancelled'; status: McpActionStatus }
  | { kind: 'not_cancellable'; status: McpActionStatus };

/**
 * cancel_action: the actual CAS outcome of cancelActionIntent (pending /
 * approved → cancelled), or not_cancellable with the current mapped status
 * when it had already moved on (or lost the race to the worker).
 */
export async function cancelOwnedMcpIntent(
  auth: AuthContext,
  actionId: unknown,
  appBaseUrl: string,
): Promise<CancelOwnedMcpIntentOutcome> {
  const intent = await loadOwnedMcpIntent(auth, actionId);
  if (!intent) return { kind: 'not_found' };
  const result = await cancelActionIntent(auth, intent.id);
  const current = (await loadOwnedMcpIntent(auth, intent.id)) ?? { ...intent, status: result.status };
  const status = toMcpActionStatus(current, appBaseUrl);
  return result.ok ? { kind: 'cancelled', status } : { kind: 'not_cancellable', status };
}

export type McpOriginReportOutcome =
  | { credentialRevoked: true }
  | { credentialRevoked: false; revocationError?: 'revocation_failed' | 'not_found' };

const REPORT_REASON = 'reported suspicious from an approval request';

/**
 * B-W04 (#6158, D-B35, Gate B answer 5): report-suspicious on an approval of
 * an MCP-origin intent targets the ORIGIN credential — within the reporter's
 * authority. The reporter must own it (`requested_by_user_id === reporter`):
 * then the API key is revoked (`revokeApiKey`, `api_key.revoke` audit) or the
 * OAuth grant is revoked (Redis marker + durable stamp, refresh tokens
 * cascaded). Otherwise nothing is revoked and the credential owner plus the
 * intent's fanned-out approvers get a `security` notification naming it.
 *
 * Returns null for any other intent (today's behaviour applies). A revocation
 * failure is captured and reported (`credentialRevoked: false`), never silent.
 */
export async function reportSuspiciousMcpOrigin(
  intentId: string,
  reporterUserId: string,
): Promise<McpOriginReportOutcome | null> {
  const [intent] = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
    .select({
      id: actionIntents.id,
      orgId: actionIntents.orgId,
      source: actionIntents.source,
      originPrincipalKind: actionIntents.originPrincipalKind,
      originPrincipalId: actionIntents.originPrincipalId,
      requestedByUserId: actionIntents.requestedByUserId,
      requestingClientLabel: actionIntents.requestingClientLabel,
      actionName: actionIntents.actionName,
    })
    .from(actionIntents)
    .where(eq(actionIntents.id, intentId))
    .limit(1)));
  if (!intent || !isMcpOriginIntent(intent) || !intent.originPrincipalId) return null;
  const originId = intent.originPrincipalId;

  if (intent.requestedByUserId === reporterUserId) {
    try {
      const revoked = await runOutsideDbContext(() => withSystemDbAccessContext(async (): Promise<boolean> => {
        if (intent.originPrincipalKind === 'api_key') {
          const res = await revokeApiKey(originId, reporterUserId, REPORT_REASON, { includeReasonInAudit: true });
          if (res.revoked) return true;
          // revokeApiKey is a no-op for an already-revoked OR missing key;
          // only the former means the credential is actually dead.
          const [row] = await db
            .select({ status: apiKeys.status })
            .from(apiKeys)
            .where(eq(apiKeys.id, originId))
            .limit(1);
          return row?.status === 'revoked';
        }
        // Same order as oauth/grantRevocation.ts: the eager marker first
        // (queued for retry inside this transaction if Redis is down), then
        // the durable stamp, which is what activeGrantCondition reads.
        await writeOAuthRevocationMarkerDurably(db, {
          userId: reporterUserId,
          markerType: 'grant',
          markerId: originId,
          expiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000),
        });
        await revokeGrantsDurablyInCurrentDbContext({
          grantIds: [originId],
          reason: REPORT_REASON,
          revokedByUserId: reporterUserId,
          cascadeRefreshTokens: true,
        });
        return true;
      }));
      return revoked ? { credentialRevoked: true } : { credentialRevoked: false, revocationError: 'not_found' };
    } catch (err) {
      console.error('[MCP] report-suspicious: origin credential revocation failed for intent', intentId, err);
      captureException(err);
      return { credentialRevoked: false, revocationError: 'revocation_failed' };
    }
  }

  // Not the owner: no revocation authority. Tell the owner and the people who
  // could approve it, naming the credential.
  try {
    const approvers = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
      .select({ userId: approvalRequests.userId })
      .from(approvalRequests)
      .where(eq(approvalRequests.intentId, intentId))));
    const recipients = new Set<string>(approvers.map((r) => r.userId));
    if (intent.requestedByUserId) recipients.add(intent.requestedByUserId);
    const label = intent.requestingClientLabel ?? `MCP ${intent.originPrincipalKind}`;
    for (const userId of recipients) {
      // Per recipient: one failed insert must not silence everyone else.
      await runOutsideDbContext(() => withSystemDbAccessContext(() => createNotification({
        userId,
        orgId: intent.orgId,
        type: 'security',
        priority: 'high',
        title: 'MCP connection reported as suspicious',
        message: `An approval request from ${label} (${intent.actionName}) was reported as suspicious and rejected. `
          + 'Only its owner can revoke the connection; review it under API keys or Connected apps.',
        link: `/approvals#intent-${intentId}`,
        metadata: { intentId, originPrincipalKind: intent.originPrincipalKind, reportedBy: reporterUserId },
        dedupeKey: `mcp-origin-report:${intentId}`,
      }))).catch((err) => {
        console.error('[MCP] report-suspicious: notification failed for a recipient of intent', intentId, err);
        captureException(err);
      });
    }
  } catch (err) {
    console.error('[MCP] report-suspicious: owner/approver notification failed for intent', intentId, err);
    captureException(err);
  }
  return { credentialRevoked: false };
}
