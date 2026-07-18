import { randomUUID } from 'node:crypto';
import type { M365ReadAction, ReadActionFailureCode } from '@breeze/shared/m365';
import { and, eq } from 'drizzle-orm';
import { db, withDbAccessContext } from '../../db';
import { m365Connections, type M365ConnectionRow, type M365ConnectionStatus } from '../../db/schema';
import { dbAccessContextFromAuth, type AuthContext } from '../../middleware/auth';
import { requestLikeFromSnapshot } from '../auditEvents';
import { resolveWritableToolOrgId } from '../aiTools';
import {
  createGraphReadExecutorClient,
  GraphReadExecutorClientError,
  type GraphReadExecutorClient,
} from './graphReadExecutorClient';
import { recordM365ReadActionEvent } from './readActionMetrics';
import {
  isM365GraphReadToolsEnabledForOrg,
  loadM365CustomerGraphReadRuntimeConfig,
  type M365CustomerGraphReadRuntimeConfig,
} from './runtimeConfig';
import { consumeM365ReadActionBudget } from './readActionBudget';

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
): Promise<M365ReadActionServiceResult> {
  if (auth.canAccessSite) {
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

  // Request-path read of a tenant-scoped table: runs under the caller's own
  // RLS context, never a system context (see CLAUDE.md tenancy contract).
  const dbContext = dbAccessContextFromAuth(auth);
  const rows = await withDbAccessContext(dbContext, async () => db.select().from(m365Connections).where(and(
    eq(m365Connections.orgId, orgId),
    eq(m365Connections.profile, PROFILE),
  )).limit(1));
  const connection = rows[0];

  const notReady = connectionNotReadyState(connection);
  if (notReady || !connection) {
    return {
      ok: false,
      code: 'connection_not_ready',
      message: connectionNotReadyMessage(notReady ?? 'missing'),
    };
  }

  const budget = await consumeM365ReadActionBudget(connection.id);
  if (!budget.allowed) {
    return {
      ok: false,
      code: 'read_rate_limited',
      message: 'Microsoft 365 Graph read actions are rate limited for this connection. Try again shortly.',
      retryAfterSeconds: budget.retryAfterSeconds,
    };
  }

  const request = requestLikeFromSnapshot({});
  const auditBase = {
    orgId,
    connectionId: connection.id,
    actionType: action.type,
    actorId: auth.user.id,
  };

  let executorResult;
  try {
    const config = loadM365CustomerGraphReadRuntimeConfig();
    const client = runtimeClient(config);
    executorResult = await client.executeReadAction({
      correlationId: randomUUID(),
      // connection.tenantId is non-null here: connectionNotReadyState above
      // already refused the 'no-tenant' case.
      tenantId: connection.tenantId as string,
      action,
    });
  } catch (error) {
    if (!(error instanceof GraphReadExecutorClientError)) throw error;
    recordM365ReadActionEvent(request, {
      ...auditBase,
      outcome: 'executor_unavailable',
      itemCount: 0,
      truncated: false,
    });
    return {
      ok: false,
      code: 'executor_unavailable',
      message: 'Microsoft 365 Graph read is temporarily unavailable. Try again shortly.',
    };
  }

  if (!executorResult.success) {
    recordM365ReadActionEvent(request, {
      ...auditBase,
      outcome: executorResult.errorCode,
      itemCount: 0,
      truncated: false,
    });
    return {
      ok: false,
      code: executorResult.errorCode,
      message: FAILURE_MESSAGES[executorResult.errorCode],
      retryAfterSeconds: executorResult.retryAfterSeconds,
    };
  }

  if (executorResult.kind === 'collection') {
    recordM365ReadActionEvent(request, {
      ...auditBase,
      outcome: 'ok',
      itemCount: executorResult.items.length,
      truncated: executorResult.truncated,
    });
    return { ok: true, kind: 'collection', items: executorResult.items, truncated: executorResult.truncated };
  }

  recordM365ReadActionEvent(request, {
    ...auditBase,
    outcome: 'ok',
    itemCount: 1,
    truncated: false,
  });
  return { ok: true, kind: 'resource', resource: executorResult.resource };
}
