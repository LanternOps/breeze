/**
 * Provider webhook → connection → reconcile job (spec W01 "Webhooks"). Every
 * provider's webhook route verifies its own signature, extracts its tenant/realm
 * ids, fingerprints them, and calls this — the lookup and enqueue rules live
 * once. Webhooks are doorbells: the reconcile worker's change pull decides what
 * actually changed.
 */
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { findConnectionByRealmFingerprint } from './accountingConnectionService';
import { providerSupports } from './providerRegistry';
import { enqueueAccountingReconcile, type ReconcileEnqueueOptions } from '../../jobs/accountingReconcileWorker';
import type { AccountingProviderId } from './types';
import { assertNoAmbientDbContext } from './dbContextGuard';

export type WebhookRouteOutcome = 'enqueued' | 'enqueue_failed' | 'no_connection' | 'capability_unavailable';

/** Must be called with NO ambient DB context; opens its own short system context for the lookup. */
export async function routeWebhookToConnection(
  provider: AccountingProviderId,
  realmFingerprint: string,
  opts?: ReconcileEnqueueOptions,
): Promise<WebhookRouteOutcome> {
  assertNoAmbientDbContext('routeWebhookToConnection');
  const conn = await withSystemDbAccessContext(
    () => findConnectionByRealmFingerprint(db, provider, realmFingerprint),
  );
  if (!conn) return 'no_connection';
  if (!providerSupports(conn.provider, 'paymentPull')) return 'capability_unavailable';
  // Three arguments exactly when no options were given: the QuickBooks route's
  // enqueue call stays byte-identical (a pinned test).
  const ok = await runOutsideDbContext(() => (opts === undefined
    ? enqueueAccountingReconcile(conn.id, conn.partnerId, 'webhook')
    : enqueueAccountingReconcile(conn.id, conn.partnerId, 'webhook', opts)));
  return ok ? 'enqueued' : 'enqueue_failed';
}
