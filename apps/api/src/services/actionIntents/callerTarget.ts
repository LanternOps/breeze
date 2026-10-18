/**
 * Caller verification W05 (#6354): canonical targets for the two protected
 * Microsoft 365 identity actions.
 *
 * Exactly two AI tools are gated: `m365_reset_password` and
 * `m365_disable_user`. At intent creation the requested user is resolved
 * through ONE selected Microsoft connection to its canonical
 * (tenant, object id) pair and pinned immutably on the intent together with
 * that connection's id (`target_connection_ref`). Release never re-selects a
 * backend and never re-resolves a UPN: it re-loads the pinned connection and
 * dispatches to the pinned object id only.
 *
 * Backend kinds:
 *   - `direct`        m365_connections profile `legacy-direct` (self-hosted
 *                     client-credentials Graph);
 *   - `controlPlane`  m365_connections profile `customer-graph-actions`
 *                     (Graph actions executor);
 *   - `delegant`      delegant_m365_connections (external broker).
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { m365Connections } from '../../db/schema/m365';
import { delegantM365Connections } from '../../db/schema/delegant';
import { actionIntents, type ActionIntent } from '../../db/schema/actionIntents';
import { CallerVerificationValidationError } from '../callerVerification/errors';
import type { CallerVerificationAction } from '../callerVerification/types';

export type CallerBackendKind = 'direct' | 'controlPlane' | 'delegant';

export interface CallerBackend {
  backend: CallerBackendKind;
  connectionId: string;
  tenantId: string;
  orgId: string;
}

/** The ONLY tools caller verification gates. Everything else returns null. */
export const CALLER_GATED_TOOLS = ['m365_reset_password', 'm365_disable_user'] as const;

export function callerAction(toolName: string): CallerVerificationAction | null {
  return toolName === 'm365_reset_password' ? 'reset_password'
    : toolName === 'm365_disable_user' ? 'disable_user'
      : null;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The canonical object id from a Graph user resource. Never falls back to the
 * identifier the caller supplied (the legacy `data.id ?? identifier` pattern):
 * a missing or non-GUID id refuses.
 */
export function requireResolvedOid(resource: unknown): string {
  const oid = resource && typeof resource === 'object' ? (resource as Record<string, unknown>).id : undefined;
  if (typeof oid !== 'string' || !GUID.test(oid)) {
    throw new CallerVerificationValidationError('subject_unmatched', 'Microsoft did not return a canonical object ID');
  }
  return oid.toLowerCase();
}

export function normalizeTenantId(tenantId: string | null | undefined): string | null {
  return typeof tenantId === 'string' && GUID.test(tenantId) ? tenantId.toLowerCase() : null;
}

/**
 * Load a pinned connection by id under the AMBIENT db context (callers open
 * the org/system scope). Refuses with `connection_not_ready` unless the row
 * belongs to `orgId`, is active, and carries a canonical tenant id.
 */
export async function loadPinnedCallerBackend(orgId: string, connectionId: string): Promise<CallerBackend> {
  if (!GUID.test(connectionId)) {
    throw new CallerVerificationValidationError('connection_not_ready', 'The pinned Microsoft connection is unavailable');
  }
  const [row] = await db.select({
    id: m365Connections.id, orgId: m365Connections.orgId, status: m365Connections.status,
    tenantId: m365Connections.tenantId, profile: m365Connections.profile,
  }).from(m365Connections).where(and(
    eq(m365Connections.id, connectionId), eq(m365Connections.orgId, orgId),
  )).limit(1);
  if (row) {
    const tenantId = normalizeTenantId(row.tenantId);
    if (row.orgId === orgId && row.status === 'active' && tenantId
      && (row.profile === 'legacy-direct' || row.profile === 'customer-graph-actions')) {
      return { backend: row.profile === 'legacy-direct' ? 'direct' : 'controlPlane', connectionId: row.id, tenantId, orgId };
    }
    throw new CallerVerificationValidationError('connection_not_ready', 'The pinned Microsoft connection is unavailable');
  }
  const [broker] = await db.select({
    id: delegantM365Connections.id, orgId: delegantM365Connections.orgId,
    status: delegantM365Connections.status, tenantId: delegantM365Connections.m365TenantId,
  }).from(delegantM365Connections).where(and(
    eq(delegantM365Connections.id, connectionId), eq(delegantM365Connections.orgId, orgId),
  )).limit(1);
  const brokerTenant = normalizeTenantId(broker?.tenantId);
  if (broker && broker.orgId === orgId && broker.status === 'active' && brokerTenant) {
    return { backend: 'delegant', connectionId: broker.id, tenantId: brokerTenant, orgId };
  }
  throw new CallerVerificationValidationError('connection_not_ready', 'The pinned Microsoft connection is unavailable');
}

/**
 * Load the action intent a released protected M365 mutation dispatches for,
 * by id and org, under the AMBIENT db context (the session handler / release
 * worker opens the requester's org scope). `intentId` is the pipeline-supplied
 * `ToolExecutionContext.actionIntentId`, never model input. Returns null when
 * there is no such intent in `orgId`; the caller refuses.
 *
 * Lives here, not in the AI tool file: the intent row is the caller-target
 * pin, not device data — an M365 identity action has no device axis.
 */
export async function loadCallerIntent(orgId: string, intentId: string): Promise<ActionIntent | null> {
  const [intent] = await db.select().from(actionIntents).where(and(
    eq(actionIntents.id, intentId), eq(actionIntents.orgId, orgId),
  )).limit(1);
  return intent ?? null;
}
