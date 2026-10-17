import { randomUUID } from 'node:crypto';
import {
  getM365PermissionProfile,
  type M365WriteAction,
  type WriteActionResult,
  type WriteActionFailureCode,
} from '@breeze/shared/m365';
import { and, eq } from 'drizzle-orm';
import { db, withDbAccessContext } from '../../db';
import { m365Connections, type M365ConnectionRow, type M365ConnectionStatus } from '../../db/schema';
import { dbAccessContextFromAuth, type AuthContext } from '../../middleware/auth';
import { requestLikeFromSnapshot, type RequestLike } from '../auditEvents';
import { resolveWritableToolOrgId } from '../aiToolWriteOrg';
import { missingRolesForAction } from './grantReadiness';
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
  // The connection executes, but the customer has not consented to a role
  // this action needs yet (its manifest is behind the code's). The UI offers
  // upgrade consent instead of saying the tenant is disconnected (spec §7.2).
  | 'consent_upgrade_required'
  | 'write_rate_limited'
  | 'executor_unavailable'
  | 'site_scope_denied'
  | 'org_context_required';

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
  license_unavailable: 'No Microsoft 365 licence seat is available for the requested subscription.',
  unsupported_group_type:
    'This group\'s membership is managed by Microsoft 365 (dynamic or role-assignable) and cannot be edited directly.',
  device_not_found: 'The target Intune managed device was not found.',
  user_already_exists: 'A Microsoft 365 user with that sign-in name already exists.',
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
 * -> connection_not_ready) -> app-role check against the authoritative
 * observed grants (consent_upgrade_required on a manifest-stale row,
 * connection_not_ready on a current one; audited) -> write budget
 * (write_rate_limited) -> executor
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

  // Spec §7.2: a connection on an older manifest keeps working for the
  // actions its grants cover; an action needing a role the customer has not
  // consented to yet refuses with its OWN code so the UI can offer upgrade
  // consent instead of saying the tenant is disconnected. Only refuses on an
  // AUTHORITATIVE observation (grantsVerifiedAt set) — a never-reconciled
  // connection falls through and lets Graph answer, which keeps every shipped
  // connection's disable/reset executing unchanged (plan Decision 5).
  const manifest = getM365PermissionProfile(PROFILE);
  const missingRoles = missingRolesForAction(ready, manifest, action.type);
  if (missingRoles && missingRoles.length > 0) {
    // Upgrade consent only exists for a row whose manifest is behind the
    // code's (initiateUpgradeConsent refuses `manifest_current`). A current
    // row missing a role lost it outside the consent flow; prompting an
    // upgrade there would be a dead end, so it is not-ready instead.
    const upgradeable = ready.permissionManifestVersion < manifest.version;
    const code = upgradeable ? 'consent_upgrade_required' as const : 'connection_not_ready' as const;
    recordM365WriteActionEvent(opts?.auditRequest ?? requestLikeFromSnapshot({}), {
      orgId,
      connectionId: ready.id,
      actionType: action.type,
      outcome: code,
      actorId: opts?.actorId,
    });
    return {
      ok: false,
      code,
      message: upgradeable
        ? 'This Microsoft 365 action needs permissions the customer has not approved yet. '
          + 'Re-consent Microsoft 365 for this organization to add them.'
        : 'Microsoft 365 no longer holds a permission this action needs for this organization. '
          + 'Retest the connection, then re-consent if it is still missing.',
    };
  }

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

/**
 * Chat-path entry for the typed Graph write actions. Mirrors
 * readActionService.executeM365ReadAction's prologue (site scope -> org
 * resolution -> the caller's own RLS context) and then runs exactly the
 * ladder of executeM365WriteActionByOrg. Opening the context here from the
 * caller's auth — never a system context — is what keeps a chat write inside
 * the caller's tenant.
 */
export async function executeM365WriteActionForAuth(
  auth: AuthContext,
  action: M365WriteAction,
  inputOrgId?: string,
  auditRequest?: RequestLike,
): Promise<M365WriteActionServiceResult> {
  if (auth.allowedSiteIds) {
    return {
      ok: false,
      code: 'site_scope_denied',
      message: 'Microsoft 365 actions are not available to site-restricted sessions.',
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
  return withDbAccessContext(
    dbAccessContextFromAuth(auth),
    () => executeM365WriteActionByOrg(orgId, action, {
      actorId: auth.user.id,
      ...(auditRequest ? { auditRequest } : {}),
    }),
  );
}
