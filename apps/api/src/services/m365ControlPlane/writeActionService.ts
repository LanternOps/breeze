import { randomUUID } from 'node:crypto';
import type { M365WriteAction, WriteActionResult, WriteActionFailureCode } from '@breeze/shared/m365';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { m365Connections, type M365ConnectionRow, type M365ConnectionStatus } from '../../db/schema';
import { requestLikeFromSnapshot, type RequestLike } from '../auditEvents';
import {
  createGraphActionsExecutorClient,
  GraphActionsExecutorClientError,
} from './graphActionsExecutorClient';
import { recordM365WriteActionEvent } from './writeActionMetrics';
import {
  isM365GraphActionsEnabledForOrg,
  loadM365CustomerGraphActionsRuntimeConfig,
} from './writeActionRuntimeConfig';
import { consumeM365WriteActionBudget } from './writeActionBudget';

const PROFILE = 'customer-graph-actions' as const;

// Mutations require a healthy connection — active-only, stricter than the
// read side's active/degraded (readActionService.ts). A degraded connection
// may have partial/unverified grants; a *write* must never be attempted
// against one, even though a read may tolerate it. Intentional hardening,
// not an oversight.
const EXECUTABLE_STATUSES = ['active'] as const;

export type M365WriteActionRefusalCode =
  | 'tools_disabled'
  | 'connection_not_ready'
  | 'write_rate_limited'
  | 'executor_unavailable';

export type M365WriteActionServiceResult =
  | { ok: true; result: WriteActionResult }
  | {
      ok: false;
      code: M365WriteActionRefusalCode | WriteActionFailureCode;
      message: string;
      retryAfterSeconds?: number;
    };

/** One plain sentence per executor failure code. Never echoes Graph error detail. */
const FAILURE_MESSAGES: Record<WriteActionFailureCode, string> = {
  credential_unavailable: 'Microsoft 365 credentials are unavailable for this action.',
  application_token_invalid: 'Microsoft 365 application credentials are invalid for this action.',
  user_not_found: 'The target Microsoft 365 user was not found.',
  user_ambiguous: 'The target Microsoft 365 user could not be uniquely resolved.',
  tenant_mismatch: 'The Microsoft 365 connection tenant did not match.',
  graph_permission_missing: 'Breeze lacks the Microsoft Graph permission required for this action.',
  graph_throttled: 'Microsoft Graph is throttling requests for this tenant. Try again shortly.',
  graph_request_timeout: 'The request to Microsoft Graph timed out.',
  graph_transport_failed: 'Could not reach Microsoft Graph.',
  graph_error: 'Microsoft Graph rejected the change.',
  invalid_action: 'The requested Microsoft 365 action is not supported.',
};

type ConnectionNotReadyState = 'missing' | 'wrong-org' | M365ConnectionStatus | 'no-tenant';

function connectionNotReadyState(
  connection: Pick<M365ConnectionRow, 'orgId' | 'status' | 'tenantId'> | undefined,
  orgId: string,
): ConnectionNotReadyState | null {
  if (!connection) return 'missing';
  // Defense-in-depth over RLS + the eq(orgId) filter below: an org mismatch
  // here would mean either filter is broken, so fail closed rather than trust it.
  if (connection.orgId !== orgId) return 'wrong-org';
  if (!EXECUTABLE_STATUSES.includes(connection.status as typeof EXECUTABLE_STATUSES[number])) {
    return connection.status;
  }
  if (connection.tenantId === null) return 'no-tenant';
  return null;
}

/**
 * Authz ladder + execution for one typed Graph write (mutating) action (M365
 * control plane), keyed by orgId rather than a live auth/session.
 *
 * Unlike readActionService.executeM365ReadAction (which takes `auth` and
 * opens `dbAccessContextFromAuth(auth)` itself), this entry takes only the
 * immutable `orgId` and loads the connection under the AMBIENT db context —
 * the caller (the durable action-intents release worker) has already opened
 * `withDbAccessContext(dbAccessContextFromAuth(auth), invoke)` for
 * `intent.orgId` before reaching here. This exactly mirrors the Google
 * headless path (googleToolsHeadless.ts -> aiToolsGoogle.resolveContextByOrg
 * -> googleHelpers.loadGoogleConnection), which also issues a plain
 * `db.select()` relying on the ambient RLS context rather than opening one
 * itself. Opening a system context here would bypass RLS and break tenant
 * isolation — never do that.
 *
 * Ladder (all fail-closed): feature flag (no DB) -> load connection (ambient
 * RLS) -> readiness (missing / wrong-org / status not executable / no-tenant
 * -> connection_not_ready) -> write budget (write_rate_limited) -> executor
 * call (executor_unavailable) -> executor-reported failure -> success. Every
 * outcome from the connection-loaded step onward is audited via
 * recordM365WriteActionEvent; refusals before the connection loads (just the
 * feature flag here) never touch the database or the audit log.
 */
export async function executeM365WriteActionByOrg(
  orgId: string,
  action: M365WriteAction,
  opts?: { actorId?: string; auditRequest?: RequestLike; idempotencyKey?: string },
): Promise<M365WriteActionServiceResult> {
  if (!isM365GraphActionsEnabledForOrg(orgId)) {
    return {
      ok: false,
      code: 'tools_disabled',
      message: 'Microsoft 365 Graph actions are not enabled for this organization.',
    };
  }

  // Ambient RLS context load — see the function doc above. NOT a system
  // context: this must run scoped to whatever org context the caller opened.
  const rows = await db.select().from(m365Connections).where(and(
    eq(m365Connections.orgId, orgId),
    eq(m365Connections.profile, PROFILE),
  )).limit(1);
  const connection = rows[0];

  const notReady = connectionNotReadyState(connection, orgId);
  if (notReady) {
    return {
      ok: false,
      code: 'connection_not_ready',
      message: 'Microsoft 365 is not connected (or not ready) for this organization.',
    };
  }
  // connectionNotReadyState returns non-null for every case where `connection`
  // could be undefined or org-mismatched, so reaching here guarantees it is
  // defined and org-matched.
  const ready = connection as M365ConnectionRow;

  const budget = await consumeM365WriteActionBudget(ready.id);
  if (!budget.allowed) {
    return {
      ok: false,
      code: 'write_rate_limited',
      message: 'Microsoft 365 Graph actions are rate limited for this connection. Try again shortly.',
      retryAfterSeconds: budget.retryAfterSeconds,
    };
  }

  const request = opts?.auditRequest ?? requestLikeFromSnapshot({});
  const auditBase = {
    orgId,
    connectionId: ready.id,
    actionType: action.type,
    actorId: opts?.actorId,
  };

  let result: WriteActionResult;
  try {
    const config = loadM365CustomerGraphActionsRuntimeConfig();
    const client = createGraphActionsExecutorClient({
      executorUrl: config.executorUrl,
      executorAudience: config.executorAudience,
      signingPrivateJwk: config.executorSigningPrivateJwk,
      signingKid: config.executorSigningKid,
    });
    result = await client.executeWriteAction({
      correlationId: randomUUID(),
      // ready.tenantId is non-null here: connectionNotReadyState above
      // already refused the 'no-tenant' case.
      tenantId: ready.tenantId as string,
      // The immutable action_intents.id when the caller is the release
      // worker (see writeActionRequestSchema's doc comment) — the natural
      // dedup key for a retried release. Falls back to a fresh UUID for
      // callers with no intent context.
      idempotencyKey: opts?.idempotencyKey ?? randomUUID(),
      action,
    });
  } catch (error) {
    if (!(error instanceof GraphActionsExecutorClientError)) throw error;
    recordM365WriteActionEvent(request, { ...auditBase, outcome: 'executor_unavailable' });
    return {
      ok: false,
      code: 'executor_unavailable',
      message: 'Microsoft 365 Graph actions are temporarily unavailable. Try again shortly.',
    };
  }

  if (!result.success) {
    recordM365WriteActionEvent(request, { ...auditBase, outcome: result.errorCode });
    return {
      ok: false,
      code: result.errorCode,
      message: FAILURE_MESSAGES[result.errorCode],
      retryAfterSeconds: result.retryAfterSeconds,
    };
  }

  recordM365WriteActionEvent(request, { ...auditBase, outcome: 'ok' });
  return { ok: true, result };
}
