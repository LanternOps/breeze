import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { EdrActionDto, EdrActionKey, EdrActionRequestedVia, EdrActionStatus } from '@breeze/shared';
import { db } from '../../db';
import { edrActions } from '../../db/schema';
import { edrOrgCondition, type EdrReadScope } from './read';
import { isSiteRestricted } from './readScope';

/*
 * The `edr_actions` ledger read model (W03, #8167). Shape-1 RLS bounds the org
 * axis; this adds the explicit org filter and the ACTION site rule, which is
 * stricter than the detection read rule: a site-restricted caller sees only
 * rows linked to a device in their sites (the same rule dispatch enforces).
 * `payload` (jsonb: free-text reason, vendor ids) is never projected.
 */

export const EDR_ACTIONS_MAX_LIMIT = 200;

export interface ListEdrActionsQuery {
  orgId?: string;
  deviceId?: string;
  endpointId?: string;
  /** `open` = queued + submitted. */
  status?: EdrActionStatus | 'open';
  limit: number;
  offset: number;
}

const DTO_COLUMNS = {
  id: edrActions.id,
  orgId: edrActions.orgId,
  provider: edrActions.provider,
  action: edrActions.action,
  status: edrActions.status,
  requestedVia: edrActions.requestedVia,
  requestedBy: edrActions.requestedBy,
  aiSessionId: edrActions.aiSessionId,
  approvalId: edrActions.approvalId,
  endpointId: edrActions.endpointId,
  detectionId: edrActions.detectionId,
  breezeDeviceId: edrActions.breezeDeviceId,
  error: edrActions.error,
  requestedAt: edrActions.requestedAt,
  submittedAt: edrActions.submittedAt,
  completedAt: edrActions.completedAt,
} as const;

/** WHERE conditions for a ledger read. Exported for the DB-less tests. */
export function buildEdrActionConditions(scope: EdrReadScope, q: ListEdrActionsQuery): SQL[] {
  const conds: SQL[] = [];
  const org = edrOrgCondition(scope.auth, q.orgId, edrActions.orgId);
  if (org) conds.push(org);
  if (isSiteRestricted(scope)) {
    const ids = scope.allowedDeviceIds ?? [];
    conds.push(ids.length > 0 ? inArray(edrActions.breezeDeviceId, ids) : sql`false`);
  }
  if (q.deviceId) conds.push(eq(edrActions.breezeDeviceId, q.deviceId));
  if (q.endpointId) conds.push(eq(edrActions.endpointId, q.endpointId));
  if (q.status === 'open') conds.push(inArray(edrActions.status, ['queued', 'submitted']));
  else if (q.status) conds.push(eq(edrActions.status, q.status));
  return conds;
}

function iso(v: Date | string | null): string | null {
  if (!v) return null;
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

type Row = { [K in keyof typeof DTO_COLUMNS]: unknown };

export function toEdrActionDto(r: Row): EdrActionDto {
  const status = r.status as EdrActionStatus;
  const error = (r.error as string | null) ?? null;
  return {
    id: r.id as string,
    orgId: r.orgId as string,
    provider: r.provider as string,
    action: r.action as EdrActionKey,
    status,
    requestedVia: r.requestedVia as EdrActionRequestedVia,
    requestedBy: (r.requestedBy as string | null) ?? null,
    aiSessionId: (r.aiSessionId as string | null) ?? null,
    approvalId: (r.approvalId as string | null) ?? null,
    endpointId: (r.endpointId as string | null) ?? null,
    detectionId: (r.detectionId as string | null) ?? null,
    breezeDeviceId: (r.breezeDeviceId as string | null) ?? null,
    error,
    outcomeUnknown: status === 'queued' && error === 'dispatch_outcome_unknown',
    requestedAt: iso(r.requestedAt as Date | string) ?? '',
    submittedAt: iso(r.submittedAt as Date | string | null),
    completedAt: iso(r.completedAt as Date | string | null),
  };
}

export async function listEdrActions(
  scope: EdrReadScope,
  q: ListEdrActionsQuery,
): Promise<{ rows: EdrActionDto[]; total: number }> {
  const conds = buildEdrActionConditions(scope, q);
  const where = conds.length > 0 ? and(...conds) : undefined;
  const limit = Math.min(Math.max(1, Math.floor(q.limit) || 1), EDR_ACTIONS_MAX_LIMIT);
  const offset = Math.max(0, Math.floor(q.offset) || 0);
  const [rows, countRows] = await Promise.all([
    db.select(DTO_COLUMNS).from(edrActions).where(where)
      .orderBy(desc(edrActions.requestedAt), desc(edrActions.id)).limit(limit).offset(offset),
    db.select({ n: sql<number>`count(*)::int` }).from(edrActions).where(where),
  ]);
  return { rows: (rows as Row[]).map(toEdrActionDto), total: Number(countRows[0]?.n ?? 0) };
}
