import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { EdrActionKey, EdrActionStatus } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { edrActions, edrConnections, edrTenants } from '../../db/schema';
import { createAuditLogAsync } from '../auditService';
import { buildEdrAdapterContext } from './context';
import { decryptEdrSecret } from './credentials';
import { getEdrProvider } from './registry';
import type { EdrActionRequest, EdrAdapterContext, EdrProviderAdapter, EdrReconcileVerdict } from './types';

/*
 * `sync-action-status` (W03, #8167): settles `edr_actions` rows that
 * `dispatchEdrAction` left open — a vendor task still running (`submitted`),
 * or a request whose outcome never came back (`queued`, typically
 * `dispatch_outcome_unknown`, or a crash between insert and vendor call).
 *
 * NEVER RE-SENDS. This file has no path to `performAction` (pinned by
 * edrActions.chokepoint.contract.test.ts): a `queued` row is settled only from
 * READ-ONLY vendor state (`reconcileAction`), and if that cannot tell, the row
 * is failed for a human to re-issue after a give-up window.
 *
 * Three phases, as the sync job: short system tx to load; vendor reads with no
 * DB context; short system tx with compare-and-set writes (a concurrent
 * dispatch outcome write wins).
 */

/** A queued row this young may still be mid-dispatch in a request. */
export const EDR_ACTION_UNKNOWN_GRACE_MS = 120_000;
/** A queued row whose vendor state stays unknowable this long is failed for a human to re-issue. */
export const EDR_ACTION_UNKNOWN_GIVEUP_MS = 30 * 60_000;
/** A submitted vendor task still pending this long is failed. */
export const EDR_ACTION_SUBMITTED_TIMEOUT_MS = 24 * 3600_000;
const BATCH = 50;
const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

interface OpenRow {
  id: string;
  orgId: string;
  tenantId: string | null;
  action: EdrActionKey;
  status: EdrActionStatus;
  vendorActionId: string | null;
  payload: Record<string, unknown> | null;
  requestedAt: Date;
  submittedAt: Date | null;
  requestedBy: string | null;
}

interface Settlement {
  id: string;
  orgId: string;
  observed: EdrActionStatus;
  status: 'succeeded' | 'failed';
  error: string | null;
  requestedBy: string | null;
}

/** Rebuild the vendor request from the ledger row (`payload.target` was written by dispatch). */
export function requestFromRow(row: Pick<OpenRow, 'action' | 'payload'>): EdrActionRequest | null {
  const target = row.payload?.target as Record<string, unknown> | undefined;
  if (!target || typeof target.kind !== 'string') return null;
  return { action: row.action, target } as EdrActionRequest;
}

const ms = (d: Date | string | null): number | null => (d ? new Date(d).getTime() : null);

async function settleOne(
  adapter: EdrProviderAdapter,
  ctx: EdrAdapterContext,
  tenant: { vendorTenantId: string; apiHost: string | null } | undefined,
  row: OpenRow,
  now: Date,
): Promise<Omit<Settlement, 'id' | 'orgId' | 'observed' | 'requestedBy'> | null> {
  const age = now.getTime() - (ms(row.requestedAt) ?? now.getTime());

  if (row.status === 'submitted') {
    const submittedAge = now.getTime() - (ms(row.submittedAt) ?? ms(row.requestedAt) ?? now.getTime());
    const timedOut = submittedAge > EDR_ACTION_SUBMITTED_TIMEOUT_MS;
    if (!row.vendorActionId || !tenant || !adapter.getActionStatus) {
      return timedOut ? { status: 'failed', error: 'vendor_status_timeout' } : null;
    }
    let result;
    try {
      result = await adapter.getActionStatus(ctx, tenant, row.vendorActionId);
    } catch {
      // Transient: unchanged until the timeout (spec §4.3 terminal-vs-transient rule).
      return timedOut ? { status: 'failed', error: 'vendor_status_timeout' } : null;
    }
    if (result.status === 'succeeded') return { status: 'succeeded', error: null };
    if (result.status === 'failed') return { status: 'failed', error: 'vendor_task_failed' };
    return timedOut ? { status: 'failed', error: 'vendor_status_timeout' } : null;
  }

  // queued: crash or unknown outcome. Grace first — dispatch may still be in flight.
  if (age < EDR_ACTION_UNKNOWN_GRACE_MS) return null;
  const req = requestFromRow(row);
  let verdict: EdrReconcileVerdict = 'unknown';
  if (req && tenant && adapter.reconcileAction) {
    try {
      verdict = await adapter.reconcileAction(ctx, tenant, req);
    } catch {
      verdict = 'unknown';
    }
  }
  if (verdict === 'applied') return { status: 'succeeded', error: 'reconciled_applied' };
  if (verdict === 'not_applied') return { status: 'failed', error: 'not_sent_or_rejected' };
  return age > EDR_ACTION_UNKNOWN_GIVEUP_MS ? { status: 'failed', error: 'outcome_unknown_reissue_manually' } : null;
}

export async function pollEdrActionStatus(connectionId: string, now: Date): Promise<{ checked: number; settled: number }> {
  // ---- phase 1 (system tx, short) ----
  const loaded = await withSystemDbAccessContext(async () => {
    const [connection] = await db.select().from(edrConnections).where(eq(edrConnections.id, connectionId)).limit(1);
    if (!connection || !connection.isActive) return null;
    const rows = (await db
      .select({
        id: edrActions.id,
        orgId: edrActions.orgId,
        tenantId: edrActions.tenantId,
        action: edrActions.action,
        status: edrActions.status,
        vendorActionId: edrActions.vendorActionId,
        payload: edrActions.payload,
        requestedAt: edrActions.requestedAt,
        submittedAt: edrActions.submittedAt,
        requestedBy: edrActions.requestedBy,
      })
      .from(edrActions)
      .where(and(
        eq(edrActions.connectionId, connectionId),
        inArray(edrActions.status, ['queued', 'submitted']),
        isNull(edrActions.detachedAt),
      ))
      .orderBy(asc(edrActions.requestedAt))
      .limit(BATCH)) as OpenRow[];
    const tenantIds = [...new Set(rows.map((r) => r.tenantId).filter((t): t is string => !!t))];
    const tenants = tenantIds.length === 0 ? [] : await db
      .select({ id: edrTenants.id, vendorTenantId: edrTenants.vendorTenantId, apiHost: edrTenants.apiHost })
      .from(edrTenants)
      .where(inArray(edrTenants.id, tenantIds));
    return { connection, rows, tenants: new Map(tenants.map((t) => [t.id, t])) };
  }, 'edrActionStatus.load');
  if (!loaded || loaded.rows.length === 0) return { checked: 0, settled: 0 };

  // ---- phase 2 (vendor reads, NO DB) ----
  const { connection, rows, tenants } = loaded;
  const settlements: Settlement[] = await runOutsideDbContext(async () => {
    const adapter = getEdrProvider(connection.provider);
    const creds = decryptEdrSecret('connection_credentials', connection.id, connection.credentialsEncrypted);
    const ctx = buildEdrAdapterContext(adapter, { creds, baseUrl: connection.baseUrl, region: connection.region });
    const out: Settlement[] = [];
    for (const row of rows) {
      const t = row.tenantId ? tenants.get(row.tenantId) : undefined;
      const s = await settleOne(adapter, ctx, t && { vendorTenantId: t.vendorTenantId, apiHost: t.apiHost }, row, now);
      if (s) out.push({ ...s, id: row.id, orgId: row.orgId, observed: row.status, requestedBy: row.requestedBy });
    }
    return out;
  });
  if (settlements.length === 0) return { checked: rows.length, settled: 0 };

  // ---- phase 3 (system tx, CAS) ----
  const settledRows = await withSystemDbAccessContext(async () => {
    const won: Settlement[] = [];
    for (const s of settlements) {
      const at = new Date();
      const updated = await db.update(edrActions)
        .set({ status: s.status, error: s.error, completedAt: at, updatedAt: at })
        .where(and(eq(edrActions.id, s.id), eq(edrActions.status, s.observed)))
        .returning({ id: edrActions.id });
      if (updated.length > 0) won.push(s);
    }
    return won;
  }, 'edrActionStatus.settle');

  for (const s of settledRows) {
    void createAuditLogAsync({
      orgId: s.orgId,
      actorType: 'system',
      actorId: SYSTEM_ACTOR_ID,
      action: `edr.action.${s.status}`,
      resourceType: 'edr_action',
      resourceId: s.id,
      details: { reconciled: true, error: s.error, requestedBy: s.requestedBy, connectionId },
      result: s.status === 'succeeded' ? 'success' : 'failure',
      initiatedBy: 'automation',
    });
  }
  return { checked: rows.length, settled: settledRows.length };
}
