import { inArray, sql } from 'drizzle-orm';
import { db } from '../../../db';
import { accountingConnections as t } from '../../../db/schema';
import type { AccountingProviderId } from '../../accounting/types';
import { accountingHealth, staleAfterMinutes } from '../../integrationStates';
import { PERMISSIONS } from '../../permissions';
import type { HealthObservation } from '../types';
import { defineRowSource, staleArm, toHealthObservation } from './observeRows';

// QuickBooks / Xero (one connection per partner). The token refresh path
// writes reauth_required with canned text; a disconnect deletes the row.
// Staleness (#9127): last_reconcile_at is stamped only by a payment reconcile
// run in which no item failed (advanceReconcileCursor) or by a pull-off run
// that held its cursor (stampReconcileRunAt); last_sync_at is never written.
// The 15-minute sweep reconciles connected rows with either payment switch on,
// so only those can go stale. A row returning to that set (reconnect, realm
// change, a switch turned back on) can read stale until its next run. Opening
// needs two observations, so this shows only when that run is deferred (Xero
// under a low daily budget); accepted (plan D9). The provider lists and the
// error prefix are literals so this module stays free of provider imports;
// accounting.test.ts ties each one to the registry or the service.

const FIX_HREFS = { quickbooks: '/integrations#quickbooks', xero: '/integrations#xero' } as const;

/** Providers the reconcile sweep runs for (providerSupports(p, 'paymentPull')). */
export const RECONCILED_PROVIDERS: readonly AccountingProviderId[] = ['quickbooks', 'xero'];
/**
 * Providers with a daily call budget (limits.rate.dailyPerConnection). The
 * sweep defers them while under 20% of that budget, and every response that
 * reports the remaining daily allowance refreshes that reading for 24 h, so a
 * busy tenant can stay deferred for about a day at a time: the threshold is
 * three such windows.
 */
export const DAILY_BUDGET_PROVIDERS: readonly AccountingProviderId[] = ['xero'];
/** RECONCILE_RUN_ERROR_PREFIX in services/accounting/accountingConnectionService.ts. */
export const RECONCILE_ERROR_PREFIX = 'Payment pull: ';

/** RECONCILE_SWEEP_INTERVAL_MS in jobs/accountingReconcileWorker.ts. */
const RECONCILE_SWEEP_MINUTES = 15;
const STALE_MINUTES = staleAfterMinutes(RECONCILE_SWEEP_MINUTES);
const DAILY_BUDGET_STALE_MINUTES = staleAfterMinutes(24 * 60);

const literalList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

const stale = (now: Date) => sql`(${t.status} = ${sql.raw(`'connected'`)} AND (${t.pullPayments} OR ${t.pushPayments}) AND ${t.provider} IN (${literalList(RECONCILED_PROVIDERS)}) AND ${staleArm({
  lastOk: t.lastReconcileAt,
  createdAt: t.createdAt,
  now,
  minutes: sql`CASE WHEN ${t.provider} IN (${literalList(DAILY_BUDGET_PROVIDERS)}) THEN ${sql.raw(String(DAILY_BUDGET_STALE_MINUTES))} ELSE ${sql.raw(String(STALE_MINUTES))} END`,
  withTimezone: true,
})})`;

export type AccountingRow = {
  id: string;
  partnerId: string;
  provider: string;
  status: string;
  lastError: string | null;
  createdAt: Date;
  /** Computed in SQL (#9127): a reconciled connection past its stale threshold. */
  stale: boolean;
};

export function accountingObservation(row: AccountingRow, now: Date): HealthObservation {
  const xero = row.provider === 'xero';
  const verdict = accountingHealth(row);
  // A stale connection shows only its current reconcile-run error (counts
  // only, never a provider body); any other text on the row predates the stall.
  const staleBreak = verdict.state === 'broken' && verdict.condition === 'sync_stale';
  const reconcileError = row.lastError?.startsWith(RECONCILE_ERROR_PREFIX) ? row.lastError : null;
  return toHealthObservation({
    kind: 'accounting',
    verdict,
    now,
    createdAt: row.createdAt,
    sourceId: row.id,
    partnerId: row.partnerId,
    orgId: null,
    displayName: xero ? 'Xero' : 'QuickBooks',
    rawDetail: staleBreak ? reconcileError : row.lastError,
    fixHref: xero ? FIX_HREFS.xero : FIX_HREFS.quickbooks,
    viewPermission: PERMISSIONS.ACCOUNTING_READ,
    repairPermission: PERMISSIONS.BILLING_MANAGE,
  });
}

export const accountingSource = defineRowSource<AccountingRow>({
  kind: 'accounting',
  intervalMinutes: 15,
  tables: ['accounting_connections'],
  fixHrefs: [FIX_HREFS.quickbooks, FIX_HREFS.xero],
  select: (where, now) => db
    .select({
      id: t.id,
      partnerId: t.partnerId,
      provider: t.provider,
      status: t.status,
      lastError: t.lastError,
      createdAt: t.createdAt,
      stale: sql<boolean>`${stale(now)}`,
    })
    .from(t)
    .where(where),
  brokenWhere: (now) => sql`(${t.status} IN (${sql.raw(`'reauth_required', 'disconnected', 'error'`)}) OR ${stale(now)})`,
  trackedWhere: (ids) => inArray(t.id, ids),
  sourceIdOf: (r) => r.id,
  toObservation: accountingObservation,
});
