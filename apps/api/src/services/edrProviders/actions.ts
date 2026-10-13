import { and, eq, sql } from 'drizzle-orm';
import {
  EDR_ENDPOINT_ACTIONS,
  type EdrActionKey,
  type EdrActionRequestedVia,
  type EdrActionStatus,
  type EdrDetectionActionKey,
  type EdrEndpointActionAvailability,
  type EdrEndpointActionKey,
} from '@breeze/shared';
import {
  db,
  hasDbAccessContext,
  runOutsideDbContext,
  withDbAccessContext,
  withSystemDbAccessContext,
} from '../../db';
import {
  edrActions,
  edrConnections,
  edrTenants,
  type EdrConnectionRow,
  type EdrEndpointRow,
  type EdrTenantRow,
} from '../../db/schema';
import { dbAccessContextFromAuth, type AuthContext } from '../../middleware/auth';
import { createAuditLog, createAuditLogAsync } from '../auditService';
import { getRedis } from '../redis';
import { edrActionsEnabled } from '../../config/env';
import { pgErrorCode } from '../../utils/pgErrors';
import { checkEdrActionRateLimit, edrActorKey } from './actionGates';
import { classifyVendorActionError, EdrActionError } from './actionErrors';
import {
  EDR_ACTION_COOLDOWN_MS,
  lockAndRecheckEdrActionTarget,
  resolveEdrActionTarget,
  type ResolvedEdrActionTarget,
} from './actionTargets';
import { buildEdrAdapterContext } from './context';
import { decryptEdrSecret } from './credentials';
import { isSiteRestricted, type EdrSiteRestriction } from './readScope';
import { getEdrProvider } from './registry';
import type { EdrActionRequest, EdrActionTargetFacts, EdrProviderAdapter } from './types';

/*
 * EDR response actions — the ONE door (W03, #8167; spec §4.10).
 *
 * `dispatchEdrAction` is the only code that inserts into `edr_actions` and the
 * only caller of `adapter.performAction` (edrActions.chokepoint.contract.test.ts).
 * Order, each step a test in actions.test.ts:
 *   1. kill switch                       — nothing read;
 *   2. resolve the target under the CALLER's RLS context (that read IS the
 *      authorization) + an explicit org-reach double check;
 *   3. site restriction (stricter than reads: never-linked/detached → 403);
 *   4. connection + tenant loaded under SYSTEM context, keyed only by the ids
 *      on the authorized row (org tokens cannot read the partner-axis tables);
 *      connection gates;
 *   5. capability (`supportsAction`) — refusals write no row;
 *   6. cooldown + Breeze-side rate limit — refusals write no row;
 *   7. insert the `queued` row + audit, COMMITTED before the vendor call;
 *   8. ONE vendor call, outside any DB context, never retried;
 *   9. compare-and-set outcome write (the reconciler may race; CAS makes it harmless).
 * Callers must not hold a DB context (route: SELF_MANAGED_DB_CONTEXT_ROUTES;
 * AI tools: `selfManagedDbContext: true`) — otherwise step 7 could not commit
 * before step 8 and a pooled connection would idle across vendor HTTP (#1105).
 */

export const EDR_TENANT_DENIAL_TTL_MS = 24 * 3600_000;
export { EDR_ACTION_COOLDOWN_MS };
/** Request-path cap on waiting for vendor budget. */
export const EDR_ACTION_VENDOR_MAX_WAIT_MS = 5_000;

export const EDR_ACTIONS_DISABLED_REASON = 'Response actions are disabled on this server';

export interface EdrActionActor {
  /** Caller identity: RLS context + org reach. */
  auth: AuthContext;
  /**
   * Site axis (`EdrSiteRestriction`; for AI agent runs ∩ the run's frozen
   * devices). Acting needs a device in `allowedDeviceIds` when restricted.
   */
  restriction: { allowedDeviceIds: string[] | null; allowedSiteIds: string[] | null };
  requestedVia: Extract<EdrActionRequestedVia, 'ui' | 'ai' | 'api'>;
  /** `users.id` or null — passed EXPLICITLY by the caller, never derived here. */
  requestedBy: string | null;
  aiSessionId: string | null;
  approvalId: string | null;
  /** Free text, ≤500, stored in `payload.reason`. */
  reason: string | null;
}

export type EdrActionTargetInput =
  | { kind: 'endpoint'; endpointId: string; action: EdrEndpointActionKey; pid?: number }
  | { kind: 'device'; deviceId: string; connectionId?: string; action: EdrEndpointActionKey; pid?: number }
  | { kind: 'detection'; detectionId: string; action: EdrDetectionActionKey };

export interface EdrActionOutcome {
  actionId: string;
  status: EdrActionStatus;
  outcomeUnknown: boolean;
  error: string | null;
  message: string | null;
  httpStatus: 200 | 202 | 422 | 429 | 502;
  retryAfterSeconds?: number;
}

type ConnectionFacts = Pick<EdrConnectionRow, 'actionsEnabled' | 'isActive' | 'status' | 'capabilitiesSnapshot' | 'provider'>;
type TenantFacts = Pick<EdrTenantRow, 'unsupportedActions' | 'unsupportedActionsAt'>;
type EndpointFacts = Pick<EdrEndpointRow, 'vendorEndpointId' | 'osPlatform' | 'isolationState' | 'online'>;

/** Unexpired licence denials only. */
export function liveTenantDenials(tenant: TenantFacts, now: Date = new Date()): EdrActionKey[] {
  if (!tenant.unsupportedActionsAt) return [];
  if (now.getTime() - new Date(tenant.unsupportedActionsAt).getTime() >= EDR_TENANT_DENIAL_TTL_MS) return [];
  return [...(tenant.unsupportedActions ?? [])];
}

function targetFacts(endpoint: EndpointFacts | null, tenant: TenantFacts, connection: ConnectionFacts, now: Date): EdrActionTargetFacts {
  return {
    vendorEndpointId: endpoint?.vendorEndpointId ?? null,
    osPlatform: endpoint?.osPlatform ?? null,
    isolationState: endpoint?.isolationState ?? null,
    online: endpoint?.online ?? null,
    tenantUnsupportedActions: liveTenantDenials(tenant, now),
    connectionCapabilityNotes: connection.capabilitiesSnapshot ?? [],
  };
}

/** Steps 4–5 for one action, with no I/O. `null` = allowed. */
function gateReason(
  adapter: EdrProviderAdapter | null,
  facts: EdrActionTargetFacts,
  connection: ConnectionFacts,
  action: EdrActionKey,
): { code: 'connection_unavailable' | 'connection_actions_disabled' | 'unsupported'; reason: string } | null {
  if (!connection.isActive || connection.status === 'reauth_required') {
    return { code: 'connection_unavailable', reason: 'The EDR connection is inactive or needs its credentials re-entered' };
  }
  if (!connection.actionsEnabled) {
    return { code: 'connection_actions_disabled', reason: 'Response actions are turned off for this EDR connection' };
  }
  if (!adapter || !adapter.capabilities.actions.includes(action)
    || typeof adapter.performAction !== 'function' || typeof adapter.supportsAction !== 'function') {
    return { code: 'unsupported', reason: `Not supported by ${adapter?.label ?? 'this provider'}` };
  }
  const support = adapter.supportsAction(facts, action);
  return support.ok ? null : { code: 'unsupported', reason: support.reason };
}

function adapterOrNull(provider: string): EdrProviderAdapter | null {
  try {
    return getEdrProvider(provider);
  } catch {
    return null;
  }
}

/**
 * What the UI / `GET /edr/endpoints` shows per action, from already-loaded
 * rows (no vendor call). The vendor stays authoritative at dispatch.
 */
export function describeEndpointActions(
  endpoint: EndpointFacts & Pick<EdrEndpointRow, 'breezeDeviceId'>,
  tenant: TenantFacts,
  connection: ConnectionFacts,
  o: { restriction?: EdrSiteRestriction; now?: Date } = {},
): EdrEndpointActionAvailability[] {
  const now = o.now ?? new Date();
  const adapter = adapterOrNull(connection.provider);
  const facts = targetFacts(endpoint, tenant, connection, now);
  const killed = !edrActionsEnabled();
  const siteDenied = o.restriction && isSiteRestricted(o.restriction)
    && !(endpoint.breezeDeviceId && (o.restriction.allowedDeviceIds ?? []).includes(endpoint.breezeDeviceId));
  return EDR_ENDPOINT_ACTIONS.map((action) => {
    if (killed) return { action, available: false, reason: EDR_ACTIONS_DISABLED_REASON };
    if (siteDenied) return { action, available: false, reason: 'This endpoint is not linked to a device in your sites' };
    const gate = gateReason(adapter, facts, connection, action);
    return { action, available: gate === null, reason: gate?.reason ?? null };
  });
}

function toVendorRequest(t: ResolvedEdrActionTarget, action: EdrActionKey, pid: number | undefined): EdrActionRequest | null {
  switch (action) {
    case 'isolate':
    case 'unisolate':
    case 'scan':
    case 'update_agent':
      return t.endpoint ? { action, target: { kind: 'endpoint', vendorEndpointId: t.endpoint.vendorEndpointId } } : null;
    case 'kill_process':
      return t.endpoint && pid ? { action, target: { kind: 'process', vendorEndpointId: t.endpoint.vendorEndpointId, pid } } : null;
    case 'rollback':
    case 'resolve_detection':
    case 'mark_false_positive':
      return t.detection
        ? { action, target: { kind: 'detection', vendorDetectionId: t.detection.vendorDetectionId, vendorKind: t.detection.vendorKind } }
        : null;
    case 'quarantine_restore':
    case 'quarantine_delete':
      return t.detection?.vendorKind === 'quarantine_item'
        ? { action, target: { kind: 'quarantine_item', vendorItemId: t.detection.vendorDetectionId } }
        : null;
    default:
      return null;
  }
}

function secretsOf(creds: unknown): string[] {
  if (!creds || typeof creds !== 'object') return [];
  return Object.values(creds as Record<string, unknown>).filter((v): v is string => typeof v === 'string' && v.length >= 4);
}

async function loadConnectionAndTenant(t: ResolvedEdrActionTarget): Promise<{
  connection: EdrConnectionRow;
  tenant: Pick<EdrTenantRow, 'id' | 'orgId' | 'vendorTenantId' | 'apiHost' | 'unsupportedActions' | 'unsupportedActionsAt' | 'vendorMissingSince'>;
} | null> {
  // SYSTEM context, keyed ONLY by ids read from the row the caller was
  // authorized to see in step 2 — nothing from the request reaches this query.
  return withSystemDbAccessContext(async () => {
    const [connection] = await db
      .select()
      .from(edrConnections)
      .where(and(eq(edrConnections.id, t.connectionId), eq(edrConnections.partnerId, t.partnerId)))
      .limit(1);
    if (!connection) return null;
    const [tenant] = await db
      .select({
        id: edrTenants.id,
        orgId: edrTenants.orgId,
        vendorTenantId: edrTenants.vendorTenantId,
        apiHost: edrTenants.apiHost,
        unsupportedActions: edrTenants.unsupportedActions,
        unsupportedActionsAt: edrTenants.unsupportedActionsAt,
        vendorMissingSince: edrTenants.vendorMissingSince,
      })
      .from(edrTenants)
      .where(and(
        eq(edrTenants.id, t.tenantId),
        eq(edrTenants.orgId, t.orgId),
        eq(edrTenants.connectionId, t.connectionId),
      ))
      .limit(1);
    if (!tenant) return null;
    return { connection, tenant };
  }, 'edrActions.loadConnection');
}

const RECENTLY_REQUESTED_MESSAGE = 'The same action was requested for this target less than a minute ago';

function outcomeAudit(status: EdrActionStatus, outcomeUnknown: boolean): string {
  if (outcomeUnknown) return 'edr.action.outcome_unknown';
  return `edr.action.${status}`;
}

/**
 * The single EDR response-action door. Throws `EdrActionError` for every
 * refusal BEFORE a row is written; once a row exists it returns an outcome.
 */
export async function dispatchEdrAction(actor: EdrActionActor, input: EdrActionTargetInput): Promise<EdrActionOutcome> {
  if (hasDbAccessContext()) {
    // A held context would make "commit before the vendor call" impossible.
    throw new Error('dispatchEdrAction must be called outside a DB access context (#1105)');
  }
  // 1. Kill switch.
  if (!edrActionsEnabled()) {
    throw new EdrActionError('actions_disabled', 503, EDR_ACTIONS_DISABLED_REASON);
  }
  const { auth } = actor;
  // An AI operator agent never lands its own id in requested_by (a users FK):
  // it proposes through an action intent and a human's release executes.
  if (auth.principal?.kind === 'ai_agent') {
    throw new EdrActionError('approval_required', 403, 'An AI agent must propose this action for human approval');
  }
  const action: EdrActionKey = input.action;
  const now = new Date();

  // 2. Resolve under the caller's RLS context (+ cooldown read, same context).
  const resolved = await withDbAccessContext(dbAccessContextFromAuth(auth), () => resolveEdrActionTarget(input, now));
  if (!resolved) throw new EdrActionError('target_not_found', 404, 'EDR target not found');
  if (auth.scope !== 'system' && !auth.canAccessOrg(resolved.orgId)) {
    // RLS is not trusted alone: an over-permissive read still 404s.
    throw new EdrActionError('target_not_found', 404, 'EDR target not found');
  }
  if (resolved.detached) {
    throw new EdrActionError('target_detached', 409, 'This EDR finding belongs to a previous tenant mapping and is read-only');
  }

  // 3. Site restriction — acting needs a device in an allowed site.
  if (isSiteRestricted(actor.restriction)) {
    const deviceId = resolved.breezeDeviceId;
    if (!deviceId || !(actor.restriction.allowedDeviceIds ?? []).includes(deviceId)) {
      throw new EdrActionError('site_denied', 403, 'This EDR target is not linked to a device in your sites');
    }
  }

  // 4. Connection + tenant (system context, row ids only) and connection gates.
  const loaded = await loadConnectionAndTenant(resolved);
  if (!loaded) throw new EdrActionError('target_not_found', 404, 'EDR target not found');
  const { connection, tenant } = loaded;
  const adapter = adapterOrNull(connection.provider);
  const facts = targetFacts(resolved.endpoint, tenant, connection, now);

  // 5. Capability — refusals write no row.
  const gate = gateReason(adapter, facts, connection, action);
  if (gate) {
    throw new EdrActionError(gate.code, gate.code === 'unsupported' ? 422 : 409, gate.reason);
  }
  const pid = input.kind === 'detection' ? undefined : input.pid;
  const request = toVendorRequest(resolved, action, pid);
  if (!request) throw new EdrActionError('unsupported', 422, 'This action does not apply to that target');

  // 6. Cooldown, then the Breeze-side rate limit (Redis only; no DB held).
  if (resolved.recentlyRequested) {
    throw new EdrActionError('action_recently_requested', 409, RECENTLY_REQUESTED_MESSAGE);
  }
  const limit = await checkEdrActionRateLimit({
    redis: getRedis(),
    connectionId: connection.id,
    actorKey: edrActorKey({ userId: actor.requestedBy, aiSessionId: actor.aiSessionId }),
    targets: 1,
  });
  if (!limit.ok) {
    throw new EdrActionError('rate_limited', 429, 'Too many EDR actions; try again shortly', limit.retryAfterSeconds);
  }

  // Credentials are decrypted in memory only, after every gate passed.
  let creds: unknown;
  try {
    creds = decryptEdrSecret('connection_credentials', connection.id, connection.credentialsEncrypted);
  } catch {
    throw new EdrActionError('connection_unavailable', 409, 'The EDR connection credentials could not be read; re-enter them');
  }

  // 7. Insert + audit, committed before the vendor call.
  const aiAgentRunId = auth.aiOrigin?.agentRunId ?? null;
  const reason = actor.reason ? actor.reason.slice(0, 500) : null;
  let actionId: string;
  try {
    actionId = await withDbAccessContext(dbAccessContextFromAuth(auth), async () => {
      // The step-6 cooldown read may be stale; re-check under a (target, action) lock in this tx.
      const endpointId = input.kind === 'detection' ? null : resolved.endpoint?.id ?? null;
      const recheck = await lockAndRecheckEdrActionTarget(
        { endpointId, detectionId: resolved.detection?.id ?? null }, action, new Date(),
      );
      if (recheck === 'in_progress') {
        throw new EdrActionError('action_in_progress', 409, 'This action is already in progress for this target');
      }
      if (recheck === 'recently_requested') {
        throw new EdrActionError('action_recently_requested', 409, RECENTLY_REQUESTED_MESSAGE);
      }
      const [row] = await db.insert(edrActions).values({
        connectionId: connection.id,
        partnerId: resolved.partnerId,
        orgId: resolved.orgId,
        tenantId: tenant.id,
        // Detection actions never carry endpoint_id (see actionTargets.ts).
        endpointId,
        detectionId: resolved.detection?.id ?? null,
        breezeDeviceId: resolved.breezeDeviceId,
        provider: connection.provider,
        action,
        requestedBy: actor.requestedBy,
        requestedVia: actor.requestedVia,
        aiSessionId: actor.aiSessionId,
        approvalId: actor.approvalId,
        status: 'queued',
        payload: { reason, target: request.target, ...(aiAgentRunId ? { aiAgentRunId } : {}) },
      }).returning({ id: edrActions.id });
      return row!.id;
    });
  } catch (err) {
    const code = pgErrorCode(err);
    if (code === '23505') {
      throw new EdrActionError('action_in_progress', 409, 'This action is already in progress for this target');
    }
    if (code === '23503') {
      // The composite FKs are the remap fence: tenant remapped / endpoint gone since step 2.
      throw new EdrActionError('target_not_found', 404, 'EDR target not found');
    }
    throw err;
  }

  const auditDetails = {
    provider: connection.provider,
    action,
    connectionId: connection.id,
    endpointId: resolved.endpoint?.id ?? null,
    detectionId: resolved.detection?.id ?? null,
    requestedVia: actor.requestedVia,
    aiSessionId: actor.aiSessionId,
    approvalId: actor.approvalId,
    aiAgentRunId,
  };
  const actorId = actor.requestedBy ?? auth.user.id;
  try {
    await createAuditLog({
      orgId: resolved.orgId,
      actorType: 'user',
      actorId,
      action: 'edr.action.requested',
      resourceType: 'edr_action',
      resourceId: actionId,
      details: auditDetails,
      result: 'success',
      initiatedBy: actor.requestedVia === 'ai' ? 'ai' : 'manual',
    });
  } catch (auditErr) {
    // An action Breeze cannot account for is not taken.
    console.error(`[EdrActions] request audit failed for action ${actionId}; not sent`, auditErr);
    try {
      await withSystemDbAccessContext(() => db.update(edrActions)
        .set({ status: 'failed', error: 'audit_unavailable', completedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(edrActions.id, actionId), eq(edrActions.status, 'queued'))), 'edrActions.auditFailed');
    } catch (cleanupErr) {
      // The row stays queued (no vendor call was made); the reconciler gives it up.
      console.error(`[EdrActions] could not mark action ${actionId} audit_unavailable`, cleanupErr);
    }
    throw new EdrActionError('audit_unavailable', 503, 'The audit log is unavailable; the action was not sent');
  }

  // 8. ONE vendor call, outside any DB context, never retried.
  let result: Awaited<ReturnType<NonNullable<EdrProviderAdapter['performAction']>>> | null = null;
  let thrown: unknown = null;
  try {
    result = await runOutsideDbContext(async () => {
      const ctx = buildEdrAdapterContext(adapter!, {
        creds,
        baseUrl: connection.baseUrl,
        region: connection.region,
        maxWaitMs: EDR_ACTION_VENDOR_MAX_WAIT_MS,
      });
      return adapter!.performAction!(ctx, { vendorTenantId: tenant.vendorTenantId, apiHost: tenant.apiHost }, request, actionId);
    });
  } catch (err) {
    thrown = err;
  }

  // 9. Compare-and-set outcome write. The vendor has already answered, so a
  // failing write must not turn into a raw error (the caller would lose the
  // action id and might re-issue): log it and return what the vendor said. The
  // row stays `queued` and the reconciler settles it from vendor state.
  let outcome: EdrActionOutcome;
  const writeAt = new Date();
  const guardedWrite = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await withSystemDbAccessContext(fn, 'edrActions.outcome');
    } catch (writeErr) {
      console.error(`[EdrActions] outcome write failed for action ${actionId}; left queued for the reconciler`, writeErr);
    }
  };
  if (result) {
    const set = result.status === 'succeeded'
      ? { status: 'succeeded' as const, submittedAt: writeAt, completedAt: writeAt, updatedAt: writeAt }
      : { status: 'submitted' as const, vendorActionId: result.vendorActionId.slice(0, 255), submittedAt: writeAt, updatedAt: writeAt };
    await guardedWrite(() => db.update(edrActions).set(set)
      .where(and(eq(edrActions.id, actionId), eq(edrActions.status, 'queued'))));
    outcome = { actionId, status: result.status, outcomeUnknown: false, error: null, message: null, httpStatus: 200 };
  } else {
    const c = classifyVendorActionError(thrown, secretsOf(creds));
    await guardedWrite(async () => {
      await db.update(edrActions)
        .set(c.rowStatus === 'failed'
          ? { status: 'failed', error: c.code, completedAt: writeAt, updatedAt: writeAt }
          : { error: c.code, updatedAt: writeAt })
        .where(and(eq(edrActions.id, actionId), eq(edrActions.status, 'queued')));
      if (c.recordTenantDenial) {
        await db.update(edrTenants)
          .set({
            unsupportedActions: sql`ARRAY(SELECT DISTINCT unnest(${edrTenants.unsupportedActions} || ARRAY[${action}]::text[]))`,
            unsupportedActionsAt: writeAt,
            updatedAt: writeAt,
          })
          .where(and(eq(edrTenants.id, tenant.id), eq(edrTenants.orgId, resolved.orgId)));
      }
      if (c.markReauth) {
        await db.update(edrConnections)
          .set({ status: 'reauth_required', updatedAt: writeAt })
          .where(eq(edrConnections.id, connection.id));
      }
    });
    outcome = {
      actionId,
      status: c.rowStatus,
      outcomeUnknown: c.rowStatus === 'queued',
      error: c.code,
      message: c.message,
      httpStatus: c.http,
      ...(c.retryAfterSeconds !== undefined ? { retryAfterSeconds: c.retryAfterSeconds } : {}),
    };
  }

  void createAuditLogAsync({
    orgId: resolved.orgId,
    actorType: 'user',
    actorId,
    action: outcomeAudit(outcome.status, outcome.outcomeUnknown),
    resourceType: 'edr_action',
    resourceId: actionId,
    details: { ...auditDetails, status: outcome.status, error: outcome.error },
    result: outcome.outcomeUnknown ? 'dispatched' : outcome.status === 'failed' ? 'failure' : 'success',
    initiatedBy: actor.requestedVia === 'ai' ? 'ai' : 'manual',
  });
  return outcome;
}

export { EdrActionError };
