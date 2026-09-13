import { randomUUID } from 'node:crypto';
import type { M365ReadAction, ReadActionFailureCode, ReadActionResult } from '@breeze/shared/m365';
import {
  isM365SyncActionId,
  type M365SyncActionResult,
  type M365SyncDomain,
  type M365SyncFailureCode,
} from '@breeze/shared/m365';
import { and, eq } from 'drizzle-orm';
import { db, withDbAccessContext } from '../../db';
import { m365Connections, type M365ConnectionRow, type M365ConnectionStatus } from '../../db/schema';
import { dbAccessContextFromAuth, type AuthContext } from '../../middleware/auth';
import { requestLikeFromSnapshot, type RequestLike } from '../auditEvents';
import { resolveWritableToolOrgId } from '../aiTools';
import {
  createGraphReadExecutorClient,
  GraphReadExecutorClientError,
  type GraphReadExecutorClient,
} from './graphReadExecutorClient';
import { recordM365ReadActionEvent } from './readActionMetrics';
import type { M365ReadActionAuditInput } from './readActionMetrics';
import {
  isM365GraphReadToolsEnabledForOrg,
  loadM365CustomerGraphReadRuntimeConfig,
  type M365CustomerGraphReadRuntimeConfig,
} from './runtimeConfig';
import { consumeM365ReadActionBudget, consumeM365SyncBudget } from './readActionBudget';
import { recordM365SyncExecutorSeconds } from '../m365Sync/metrics'; // added in Task 5

const PROFILE = 'customer-graph-read' as const;
const EXECUTABLE_STATUSES = ['active', 'degraded'] as const;

export type M365ReadActionRefusalCode =
  | 'tools_disabled' | 'site_scope_denied' | 'org_context_required'
  | 'connection_not_ready' | 'read_rate_limited' | 'executor_unavailable';

export type M365ReadActionServiceResult =
  | { ok: true; kind: 'collection'; items: Record<string, unknown>[]; truncated: boolean }
  | { ok: true; kind: 'resource'; resource: Record<string, unknown> }
  | { ok: false; code: M365ReadActionRefusalCode | ReadActionFailureCode; message: string; retryAfterSeconds?: number };

/** One plain sentence per executor failure code. Never echoes Graph error detail. */
const FAILURE_MESSAGES: Record<ReadActionFailureCode, string> = {
  credential_unavailable: 'Microsoft 365 credentials are unavailable — run Retest on the Microsoft 365 card.',
  application_token_invalid: 'Microsoft 365 application credentials are invalid — run Retest on the Microsoft 365 card.',
  graph_permission_missing: 'This action requires Microsoft Graph permissions Breeze does not have — run Retest on the Microsoft 365 card.',
  graph_license_required: 'This tenant does not include Entra ID P1/P2, which Microsoft requires for sign-in logs.',
  graph_not_found: 'The requested Microsoft 365 resource was not found.',
  graph_throttled: 'Microsoft Graph is throttling requests for this tenant. Try again shortly.',
  graph_response_too_large: 'The Microsoft Graph response was too large to return. Narrow the request and try again.',
  graph_request_timeout: 'The request to Microsoft Graph timed out. Try again.',
  graph_transport_failed: 'Could not reach Microsoft Graph. Try again shortly.',
  graph_response_invalid: 'Microsoft Graph returned an unexpected response.',
};

/** Duplicated from connectionService.ts:233-240 (that file's construction is
 * private) rather than exporting a new factory from it, per task decision. */
function runtimeClient(config: M365CustomerGraphReadRuntimeConfig): GraphReadExecutorClient {
  return createGraphReadExecutorClient({
    executorUrl: config.executorUrl,
    executorAudience: config.executorAudience,
    signingPrivateJwk: config.executorSigningPrivateJwk,
    signingKid: config.executorSigningKid,
  });
}

type ConnectionNotReadyState = 'missing' | M365ConnectionStatus | 'no-tenant';

function connectionNotReadyState(
  connection: Pick<M365ConnectionRow, 'status' | 'tenantId'> | undefined,
): ConnectionNotReadyState | null {
  if (!connection) return 'missing';
  if (!EXECUTABLE_STATUSES.includes(connection.status as typeof EXECUTABLE_STATUSES[number])) {
    return connection.status;
  }
  if (connection.tenantId === null) return 'no-tenant';
  return null;
}

const CONNECT_NEXT_STEP = 'Connect Microsoft 365 in Integrations settings.';
const RETEST_NEXT_STEP = 'Run Retest on the Microsoft 365 card.';

function connectionNotReadyMessage(state: ConnectionNotReadyState): string {
  switch (state) {
    case 'missing':
      return `Microsoft 365 is not connected for this organization. ${CONNECT_NEXT_STEP}`;
    case 'pending-consent':
      return `Microsoft 365 connection setup is not complete (pending admin consent). ${CONNECT_NEXT_STEP}`;
    case 'verifying':
      return `Microsoft 365 connection is still verifying. ${RETEST_NEXT_STEP}`;
    case 'suspended':
      return `Microsoft 365 connection is suspended. ${RETEST_NEXT_STEP}`;
    case 'revoked':
      return `Microsoft 365 connection has been revoked. ${CONNECT_NEXT_STEP}`;
    case 'no-tenant':
      return `Microsoft 365 connection is missing a verified tenant. ${RETEST_NEXT_STEP}`;
    default:
      return `Microsoft 365 connection is not ready. ${RETEST_NEXT_STEP}`;
  }
}

/**
 * The immutable facts a background caller needs to issue one executor call and
 * to fence its own persistence afterwards (spec §5.1). Deliberately a VALUE,
 * not a row handle: the sync worker loads it in Phase A, commits, spends up to
 * 110 s in Graph with no DB context, and re-checks these fields in Phase C.
 *
 * `vaultRef`/`credentialVersion` are carried for caller-side fencing and
 * diagnostics only. The executor holds the sole credential and resolves it from
 * its own configuration — `executeReadAction`/`syncAction` send nothing but
 * `{correlationId, tenantId, action}` — so a NULL here is not a refusal.
 */
export interface M365ConnectionExecutionSnapshot {
  id: string;
  orgId: string;
  tenantId: string;
  consentGeneration: number;
  status: 'active' | 'degraded';
  permissionManifestVersion: number;
  vaultRef: string;
  credentialVersion: string;
}

export function connectionExecutionSnapshot(
  row: Pick<
    M365ConnectionRow,
    'id' | 'orgId' | 'tenantId' | 'consentGeneration' | 'status' | 'permissionManifestVersion' | 'vaultRef' | 'credentialVersion'
  > | undefined,
): M365ConnectionExecutionSnapshot | null {
  if (!row) return null;
  if (connectionNotReadyState(row)) return null;
  if (!row.orgId) return null;
  return {
    id: row.id,
    orgId: row.orgId,
    tenantId: row.tenantId as string,
    consentGeneration: row.consentGeneration,
    status: row.status as 'active' | 'degraded',
    permissionManifestVersion: row.permissionManifestVersion,
    vaultRef: row.vaultRef ?? '',
    credentialVersion: row.credentialVersion ?? '',
  };
}

export type M365SyncCallFailureCode =
  | M365ReadActionRefusalCode
  | M365SyncFailureCode
  | 'sync_capacity';

export type M365SyncCallResult =
  | { ok: true; kind: 'sync'; result: M365SyncActionResult; executorMs: number }
  | { ok: false; code: M365SyncCallFailureCode; message: string; retryAfterSeconds?: number; executorMs: number };

/**
 * Messages for the codes FAILURE_MESSAGES does not cover: the six refusal codes
 * (which the read path answers inline rather than through a map) plus the two
 * sync-only codes. Typed as a total Record over exactly that complement, so
 * adding a member to M365SyncCallFailureCode is a COMPILE error here rather
 * than an "undefined" shown to an operator and written into last_error.
 */
const SYNC_ONLY_MESSAGES: Record<
  Exclude<M365SyncCallFailureCode, ReadActionFailureCode>,
  string
> = {
  sync_capacity: 'The Microsoft 365 sync executor is at capacity. The sync will retry shortly.',
  continuation_invalid: 'The Microsoft 365 sign-in activity page cursor expired. The next run restarts the walk.',
  read_rate_limited: 'Microsoft 365 sync is rate limited for this connection. It will retry shortly.',
  executor_unavailable: 'Microsoft 365 Graph read is temporarily unavailable. Try again shortly.',
  tools_disabled: 'Microsoft 365 tenant sync is not enabled for this organization.',
  site_scope_denied: 'This Microsoft 365 connection is out of scope for the current site.',
  org_context_required: 'A Microsoft 365 sync run requires an organization context.',
  connection_not_ready: 'The Microsoft 365 connection is not ready to run — run Retest on the Microsoft 365 card.',
};

export function syncFailureMessage(code: M365SyncCallFailureCode): string {
  return code in SYNC_ONLY_MESSAGES
    ? SYNC_ONLY_MESSAGES[code as keyof typeof SYNC_ONLY_MESSAGES]
    : FAILURE_MESSAGES[code as ReadActionFailureCode];
}

export interface CallGraphReadExecutorOptions {
  /** 'read' = interactive budget + per-call audit; 'sync' = sync budget, no per-call audit. */
  route: 'read' | 'sync';
  correlationId: string;
  actorId?: string;
  /**
   * route 'sync' only. `m365_sync_executor_seconds` is labelled by DOMAIN, not
   * by action id, so the histogram lines up with `m365_sync_runs_total{domain}`
   * on one dashboard. Falls back to the action id when a caller omits it.
   */
  domain?: M365SyncDomain;
  auditRequest?: RequestLike;
  /**
   * Overrides the per-call recorder. The read route defaults to
   * `recordM365ReadActionEvent`; the sync route defaults to NOTHING, because
   * spec §7 wants exactly one `m365.sync.run` audit event per run and its
   * counts do not exist until Phase C has persisted.
   */
  recordEvent?: (request: RequestLike, input: M365ReadActionAuditInput) => void;
}

/**
 * One typed Graph call on behalf of a connection SNAPSHOT: budget, executor
 * client, metrics, and (read route only) the per-call audit event.
 *
 * Touches NO database. That is the whole point of extracting it — the sync
 * worker calls it inside `runOutsideDbContext` so no pooled connection is
 * pinned idle-in-transaction across a call that may run for 110 s
 * (#1105/#1697). A "by-org" variant that did its own lookup under ambient
 * context could not be wrapped that way at all: contextless DB access is a
 * denial, not a bypass, so the lookup would silently return zero rows.
 *
 * The audit call it does make is fire-and-forget and opens its own
 * runOutsideDbContext + system context (auditService.ts:54-79), so it neither
 * inherits nor holds the caller's context.
 */
export async function callGraphReadExecutor(
  snapshot: M365ConnectionExecutionSnapshot,
  action: M365ReadAction,
  opts: CallGraphReadExecutorOptions,
): Promise<M365ReadActionServiceResult | M365SyncCallResult> {
  const isSync = opts.route === 'sync';
  const request = opts.auditRequest ?? requestLikeFromSnapshot({});
  const auditBase = {
    orgId: snapshot.orgId,
    connectionId: snapshot.id,
    actionType: action.type,
    ...(opts.actorId ? { actorId: opts.actorId } : {}),
  };
  const record = opts.recordEvent ?? (isSync ? undefined : recordM365ReadActionEvent);

  const budget = isSync
    ? await consumeM365SyncBudget(snapshot.id)
    : await consumeM365ReadActionBudget(snapshot.id);
  if (!budget.allowed) {
    const refusal = {
      ok: false as const,
      code: 'read_rate_limited' as const,
      message: isSync
        ? syncFailureMessage('read_rate_limited')
        : 'Microsoft 365 Graph read actions are rate limited for this connection. Try again shortly.',
      retryAfterSeconds: budget.retryAfterSeconds,
    };
    return isSync ? { ...refusal, executorMs: 0 } : refusal;
  }

  const startedAt = Date.now();
  let executorResult;
  try {
    const client = runtimeClient(loadM365CustomerGraphReadRuntimeConfig());
    executorResult = isSync
      ? await client.syncAction({
        correlationId: opts.correlationId,
        tenantId: snapshot.tenantId,
        action: action as Parameters<typeof client.syncAction>[0]['action'],
      })
      : await client.executeReadAction({
        correlationId: opts.correlationId,
        tenantId: snapshot.tenantId,
        action,
      });
  } catch (error) {
    if (!(error instanceof GraphReadExecutorClientError)) throw error;
    const executorMs = Date.now() - startedAt;
    if (isSync) recordM365SyncExecutorSeconds(opts.domain ?? action.type, executorMs / 1000);
    record?.(request, { ...auditBase, outcome: 'executor_unavailable', itemCount: 0, truncated: false });
    const failure = {
      ok: false as const,
      code: 'executor_unavailable' as const,
      message: syncFailureMessage('executor_unavailable'),
    };
    return isSync ? { ...failure, executorMs } : failure;
  }

  const executorMs = Date.now() - startedAt;
  if (isSync) recordM365SyncExecutorSeconds(opts.domain ?? action.type, executorMs / 1000);

  if (!executorResult.success) {
    // The SYNC response discriminates on `code` (W03's GraphReadExecutorFailure);
    // the three interactive operations still discriminate on `errorCode`. Reading
    // the wrong one yields `undefined` with no type error at the `as never` edge,
    // which is why the sync-route test asserts the message has no "undefined".
    const code = isSync
      ? (executorResult as { code: M365SyncFailureCode | 'sync_capacity' }).code
      : (executorResult as { errorCode: ReadActionFailureCode }).errorCode;
    record?.(request, { ...auditBase, outcome: code as never, itemCount: 0, truncated: false });
    if (isSync) {
      return {
        ok: false,
        code: code as M365SyncCallFailureCode,
        message: syncFailureMessage(code as M365SyncCallFailureCode),
        retryAfterSeconds: executorResult.retryAfterSeconds,
        executorMs,
      };
    }
    return {
      ok: false,
      code: code as ReadActionFailureCode,
      message: FAILURE_MESSAGES[code as ReadActionFailureCode],
      retryAfterSeconds: executorResult.retryAfterSeconds,
    };
  }

  if (isSync) {
    const result = executorResult as M365SyncActionResult;
    record?.(request, {
      ...auditBase,
      outcome: 'ok',
      itemCount: result.items.length,
      truncated: result.truncated,
    });
    return { ok: true, kind: 'sync', result, executorMs };
  }

  // Sync branch above always returns, so the remaining outcome is one of the
  // two non-sync executor success shapes (the `success: false` member was
  // already excluded by the `!executorResult.success` check above).
  const readResult = executorResult as Extract<ReadActionResult, { success: true }>;
  if (readResult.kind === 'collection') {
    record?.(request, { ...auditBase, outcome: 'ok', itemCount: readResult.items.length, truncated: readResult.truncated });
    return { ok: true, kind: 'collection', items: readResult.items, truncated: readResult.truncated };
  }
  record?.(request, { ...auditBase, outcome: 'ok', itemCount: 1, truncated: false });
  return { ok: true, kind: 'resource', resource: readResult.resource };
}

/**
 * Authz ladder + execution for one typed Graph read action (M365 control
 * plane). Every refusal before the connection row is loaded (site scope, org
 * resolution, feature flag) never touches the database. Once a connection is
 * loaded, an audit + metrics event (recordM365ReadActionEvent) is written for
 * every executor attempt outcome (success, executor-reported failure, or
 * executor_unavailable) — but NOT for the connection_not_ready / read_rate_limited
 * refusals that precede the executor call.
 */
export async function executeM365ReadAction(
  auth: AuthContext,
  action: M365ReadAction,
  inputOrgId?: string,
  auditRequest?: RequestLike,
): Promise<M365ReadActionServiceResult> {
  if (auth.allowedSiteIds) {
    return {
      ok: false,
      code: 'site_scope_denied',
      message: 'Microsoft 365 tools are not available to site-restricted sessions.',
    };
  }

  const resolved = resolveWritableToolOrgId(auth, inputOrgId);
  if (!resolved.orgId) {
    return {
      ok: false,
      code: 'org_context_required',
      message: resolved.error ?? 'Organization context required',
    };
  }
  const orgId = resolved.orgId;

  if (!isM365GraphReadToolsEnabledForOrg(orgId)) {
    return {
      ok: false,
      code: 'tools_disabled',
      message: 'Microsoft 365 Graph read tools are not enabled for this organization.',
    };
  }

  if (isM365SyncActionId(action.type)) {
    return {
      ok: false,
      code: 'tools_disabled',
      message: 'Whole-tenant sync actions are not available to interactive Graph read tools.',
    };
  }

  // Request-path read of a tenant-scoped table: runs under the caller's own
  // RLS context, never a system context (see CLAUDE.md tenancy contract).
  const dbContext = dbAccessContextFromAuth(auth);
  const rows = await withDbAccessContext(dbContext, async () => db.select().from(m365Connections).where(and(
    eq(m365Connections.orgId, orgId),
    eq(m365Connections.profile, PROFILE),
  )).limit(1));
  const connection = rows[0];

  const notReady = connectionNotReadyState(connection);
  if (notReady) {
    return {
      ok: false,
      code: 'connection_not_ready',
      message: connectionNotReadyMessage(notReady),
    };
  }
  // connectionNotReadyState returns 'missing' whenever `connection` is
  // undefined, so reaching here guarantees it is defined.
  const readyConnection = connection as M365ConnectionRow;

  const snapshot = connectionExecutionSnapshot(readyConnection);
  if (!snapshot) {
    // Unreachable: connectionNotReadyState above already refused every
    // non-executable shape. Kept as a fail-closed guard rather than a
    // non-null assertion, since this is the last gate before a Graph call.
    return {
      ok: false,
      code: 'connection_not_ready',
      message: connectionNotReadyMessage('missing'),
    };
  }

  return callGraphReadExecutor(snapshot, action, {
    route: 'read',
    correlationId: randomUUID(),
    actorId: auth.user.id,
    auditRequest,
  }) as Promise<M365ReadActionServiceResult>;
}
