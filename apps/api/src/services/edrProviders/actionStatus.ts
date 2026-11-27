import { and, asc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { isEdrStateConfirmedAction, type EdrActionKey, type EdrActionStatus } from '@breeze/shared';
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
 * NEVER RE-SENDS. This file has no path to the adapter send method (pinned by
 * edrActions.chokepoint.contract.test.ts): a `queued` row is settled only from
 * READ-ONLY vendor state (`reconcileAction`), and if that cannot tell, the row
 * is failed for a human to re-issue after a give-up window. A row a remap
 * detached gets only that give-up (`detached_unsettled`), never a vendor read.
 *
 * Three phases, as the sync job: short system tx to load; vendor reads with no
 * DB context; short system tx with compare-and-set writes (a concurrent
 * dispatch outcome write wins).
 *
 * An isolate / un-isolate the vendor ACCEPTED stays `submitted` (#12789): it
 * succeeds only when a LIVE read of the endpoint (`reconcileAction`, taken
 * here, so after the request by construction) shows the requested isolation
 * state, and fails as `isolation_unconfirmed` if none does within the
 * submitted timeout. Stored inventory is never the evidence: a sync stamps
 * `last_inventory_sync_at` when it WRITES, but read the vendor earlier, so a
 * sync that read before the request and wrote after it would speak for a
 * state the request never saw.
 *
 * Every open row is checked each run, not only the oldest page (#12789
 * review): rows are taken least recently checked first (`updated_at`, which a
 * check stamps on a row it leaves open), page by page, until none is left or
 * the run budget is spent. A run that hits the budget leaves the rows it did
 * not reach at the front of the next run.
 */

/** A queued row this young may still be mid-dispatch in a request. */
export const EDR_ACTION_UNKNOWN_GRACE_MS = 120_000;
/** A queued row whose vendor state stays unknowable this long is failed for a human to re-issue. */
export const EDR_ACTION_UNKNOWN_GIVEUP_MS = 30 * 60_000;
/** A submitted vendor task (or an isolation inventory never confirmed) still pending this long is failed. */
export const EDR_ACTION_SUBMITTED_TIMEOUT_MS = 24 * 3600_000;
const BATCH = 50;
/** Wall-clock budget for one run's pages (the job lock is 5 min; the tick is 5 min). */
export const EDR_ACTION_STATUS_RUN_BUDGET_MS = 120_000;
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
  detachedAt: Date | null;
  endpointId: string | null;
}

interface Settlement {
  id: string;
  orgId: string;
  observed: EdrActionStatus;
  status: 'succeeded' | 'failed';
  error: string | null;
  requestedBy: string | null;
  confirmedBy?: 'vendor_read';
}

/** Rebuild the vendor request from the ledger row (`payload.target` was written by dispatch). */
export function requestFromRow(row: Pick<OpenRow, 'action' | 'payload'>): EdrActionRequest | null {
  const target = row.payload?.target as Record<string, unknown> | undefined;
  if (!target || typeof target.kind !== 'string') return null;
  return { action: row.action, target } as EdrActionRequest;
}

const ms = (d: Date | string | null): number | null => (d ? new Date(d).getTime() : null);

/** A vendor read failed: the row stays as it is, but an outage must be visible. */
function logVendorReadFailure(actionId: string, op: string, err: unknown): void {
  const code = (err as { code?: unknown } | null)?.code;
  console.warn(`[EdrActionStatus] ${op} failed for action ${actionId}; left unchanged`, {
    code: typeof code === 'string' ? code : undefined,
    message: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
  });
}

async function settleOne(
  adapter: EdrProviderAdapter,
  ctx: EdrAdapterContext,
  tenant: { vendorTenantId: string; apiHost: string | null } | undefined,
  row: OpenRow,
  now: Date,
): Promise<Omit<Settlement, 'id' | 'orgId' | 'observed' | 'requestedBy'> | null> {
  const age = now.getTime() - (ms(row.requestedAt) ?? now.getTime());

  // A remap detached this row (mapping.ts): its tenant link is gone, so the
  // vendor is not read. It only gets the time-based give-up, for a human to
  // re-issue against the new mapping.
  if (row.detachedAt) {
    return age > EDR_ACTION_UNKNOWN_GIVEUP_MS ? { status: 'failed', error: 'detached_unsettled' } : null;
  }

  if (row.status === 'submitted' && isEdrStateConfirmedAction(row.action)) {
    // Accepted isolate / un-isolate: only the endpoint's state, read live now
    // (after the request), says it took effect. `not_applied` is not a failure:
    // the endpoint may be offline and apply the task when it reconnects.
    const req = requestFromRow(row);
    if (req && tenant && adapter.reconcileAction) {
      try {
        if (await adapter.reconcileAction(ctx, tenant, req) === 'applied') {
          return { status: 'succeeded', error: null, confirmedBy: 'vendor_read' };
        }
      } catch (err) {
        logVendorReadFailure(row.id, 'reconcileAction', err);
      }
    }
    const submittedAge = now.getTime() - (ms(row.submittedAt) ?? ms(row.requestedAt) ?? now.getTime());
    // A vendor task id, if the vendor gave one, can only fail the row early: a
    // finished task is still not the endpoint confirming its isolation state.
    if (row.vendorActionId && tenant && adapter.getActionStatus) {
      try {
        const result = await adapter.getActionStatus(ctx, tenant, row.vendorActionId);
        if (result.status === 'failed') return { status: 'failed', error: 'vendor_task_failed' };
      } catch (err) {
        logVendorReadFailure(row.id, 'getActionStatus', err);
      }
    }
    return submittedAge > EDR_ACTION_SUBMITTED_TIMEOUT_MS ? { status: 'failed', error: 'isolation_unconfirmed' } : null;
  }

  if (row.status === 'submitted') {
    const submittedAge = now.getTime() - (ms(row.submittedAt) ?? ms(row.requestedAt) ?? now.getTime());
    const timedOut = submittedAge > EDR_ACTION_SUBMITTED_TIMEOUT_MS;
    if (!row.vendorActionId || !tenant || !adapter.getActionStatus) {
      return timedOut ? { status: 'failed', error: 'vendor_status_timeout' } : null;
    }
    let result;
    try {
      result = await adapter.getActionStatus(ctx, tenant, row.vendorActionId);
    } catch (err) {
      // Transient: unchanged until the timeout (spec §4.3 terminal-vs-transient rule).
      logVendorReadFailure(row.id, 'getActionStatus', err);
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
    } catch (err) {
      logVendorReadFailure(row.id, 'reconcileAction', err);
      verdict = 'unknown';
    }
  }
  if (verdict === 'applied') return { status: 'succeeded', error: 'reconciled_applied' };
  // Only `applied` settles early. "Not applied yet" is not evidence of "not
  // sent": a vendor task may be pending or the endpoint offline, and failing
  // the row early would release the in-flight slot for a duplicate request.
  if (age <= EDR_ACTION_UNKNOWN_GIVEUP_MS) return null;
  return verdict === 'not_applied'
    ? { status: 'failed', error: 'not_sent_or_rejected' }
    : { status: 'failed', error: 'outcome_unknown_reissue_manually' };
}

export async function pollEdrActionStatus(
  connectionId: string,
  now: Date,
  opts: { budgetMs?: number } = {},
): Promise<{ checked: number; settled: number }> {
  const connection = await withSystemDbAccessContext(async () => {
    const [c] = await db.select().from(edrConnections).where(eq(edrConnections.id, connectionId)).limit(1);
    return c && c.isActive ? c : null;
  }, 'edrActionStatus.connection');
  if (!connection) return { checked: 0, settled: 0 };
  const adapter = getEdrProvider(connection.provider);
  const ctx = buildEdrAdapterContext(adapter, {
    creds: decryptEdrSecret('connection_credentials', connection.id, connection.credentialsEncrypted),
    baseUrl: connection.baseUrl,
    region: connection.region,
  });

  // A row checked in this run is stamped with an `updated_at` at or after this
  // instant (phase 3), so each page reads only rows this run has not reached.
  const runStartedAt = new Date();
  const deadline = Date.now() + (opts.budgetMs ?? EDR_ACTION_STATUS_RUN_BUDGET_MS);
  let checked = 0;
  let settled = 0;
  // A row is read from the vendor at most once per run, even if its stamp did not land.
  const seen = new Set<string>();
  for (;;) {
    const page = await pollPage(connectionId, adapter, ctx, now, runStartedAt, seen);
    checked += page.checked;
    settled += page.settled;
    if (page.loaded < BATCH || page.checked === 0 || Date.now() >= deadline) break;
  }
  return { checked, settled };
}

/** One page: load (system tx) -> vendor reads (no DB) -> CAS writes and check stamps (system tx). */
async function pollPage(
  connectionId: string,
  adapter: EdrProviderAdapter,
  ctx: EdrAdapterContext,
  now: Date,
  runStartedAt: Date,
  seen: Set<string>,
): Promise<{ loaded: number; checked: number; settled: number }> {
  // ---- phase 1 (system tx, short) ----
  const { rows, tenants } = await withSystemDbAccessContext(async () => {
    const page = (await db
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
        detachedAt: edrActions.detachedAt,
        endpointId: edrActions.endpointId,
      })
      .from(edrActions)
      .where(and(
        eq(edrActions.connectionId, connectionId),
        inArray(edrActions.status, ['queued', 'submitted']),
        // Not yet checked in this run.
        lt(edrActions.updatedAt, runStartedAt),
        // Detached rows are loaded only once past the give-up window (they get
        // nothing else), matching the sweep in edrProviderSync.ts.
        or(isNull(edrActions.detachedAt), lt(edrActions.requestedAt, new Date(now.getTime() - EDR_ACTION_UNKNOWN_GIVEUP_MS))),
      ))
      // Least recently checked first: an open row's updated_at is its last check
      // (or the dispatch write that opened it), so no row waits behind a backlog.
      .orderBy(asc(edrActions.updatedAt), asc(edrActions.id))
      .limit(BATCH)) as OpenRow[];
    const tenantIds = [...new Set(page.map((r) => r.tenantId).filter((t): t is string => !!t))];
    const tenantRows = tenantIds.length === 0 ? [] : await db
      .select({ id: edrTenants.id, vendorTenantId: edrTenants.vendorTenantId, apiHost: edrTenants.apiHost })
      .from(edrTenants)
      .where(inArray(edrTenants.id, tenantIds));
    return { rows: page, tenants: new Map(tenantRows.map((t) => [t.id, t])) };
  }, 'edrActionStatus.load');
  const loaded = rows.length;
  const fresh = rows.filter((r) => !seen.has(r.id));
  for (const r of fresh) seen.add(r.id);
  if (fresh.length === 0) return { loaded, checked: 0, settled: 0 };

  // ---- phase 2 (vendor reads, NO DB) ----
  const settlements: Settlement[] = await runOutsideDbContext(async () => {
    const out: Settlement[] = [];
    for (const row of fresh) {
      const t = row.tenantId ? tenants.get(row.tenantId) : undefined;
      const s = await settleOne(adapter, ctx, t && { vendorTenantId: t.vendorTenantId, apiHost: t.apiHost }, row, now);
      if (s) out.push({ ...s, id: row.id, orgId: row.orgId, observed: row.status, requestedBy: row.requestedBy });
    }
    return out;
  });

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
    // Stamp the rows left open as checked, so the next page and the next run
    // reach the rows behind them. Only still-open rows: a concurrent outcome
    // write owns a row it settled.
    const settledIds = new Set(settlements.map((s) => s.id));
    const stillOpen = fresh.filter((r) => !settledIds.has(r.id)).map((r) => r.id);
    if (stillOpen.length > 0) {
      await db.update(edrActions)
        .set({ updatedAt: new Date() })
        .where(and(inArray(edrActions.id, stillOpen), inArray(edrActions.status, ['queued', 'submitted'])))
        .returning({ id: edrActions.id });
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
      details: {
        reconciled: true,
        error: s.error,
        requestedBy: s.requestedBy,
        connectionId,
        ...(s.confirmedBy ? { confirmedBy: s.confirmedBy } : {}),
      },
      result: s.status === 'succeeded' ? 'success' : 'failure',
      initiatedBy: 'automation',
    });
  }
  return { loaded, checked: fresh.length, settled: settledRows.length };
}
