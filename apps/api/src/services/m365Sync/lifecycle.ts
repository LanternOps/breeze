import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  M365_SYNC_DOMAINS,
  M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS,
  type M365SyncDomain,
} from '@breeze/shared/m365';
import { isM365TenantSyncEnabled } from '../../config/env';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  m365CaPolicies,
  m365IntuneDevices,
  m365LicenseSkus,
  m365SyncState,
  m365Users,
} from '../../db/schema';
import { claimAndEnqueue } from './claim';

/**
 * Sign-in domains are excluded from on-demand: their Graph surfaces are
 * app-wide throttled, not per-tenant (spec §4.1), so one technician pressing
 * "Sync now" must not be able to spend the region's budget.
 *
 * `signin_events` (#5784 W05) hits /auditLogs/signIns, a DIFFERENT surface from
 * signin_activity's /users?$select=signInActivity — it has its own token bucket
 * rather than sharing that one — but the same on-demand reasoning applies.
 */
const NON_ON_DEMAND_DOMAINS: ReadonlySet<M365SyncDomain> = new Set(['signin_activity', 'signin_events']);

export const ON_DEMAND_SYNC_DOMAINS: readonly M365SyncDomain[] =
  M365_SYNC_DOMAINS.filter((domain) => !NON_ON_DEMAND_DOMAINS.has(domain));

/**
 * A customer-graph-read consent (first-time or re-consent) verified and the
 * connection is executable (`active` OR `degraded` — a connection missing one
 * optional grant still syncs every other domain). Seeds all six domains due now
 * and claims them at priority 1, so the org tab has data within a tick instead
 * of within six hours; the first `secure_score` run backfills 90 days because
 * its state row has never succeeded.
 *
 * Opens its OWN system context: the consent callback holds none, and the
 * enqueue must happen after the seeding commits.
 *
 * Never throws. A seeding fault must not turn a successful Microsoft consent
 * into a failure redirect, and the ticker's `reconcileEligibleConnections()`
 * re-seeds any executable connection missing its rows on the next tick (§10.2).
 * Callers MUST only invoke this for the customer-graph-read profile: the sync
 * reads through that connection and nothing else.
 */
export async function onConnectionConsented(conn: {
  id: string;
  orgId: string;
  tenantId: string;
  status: 'active' | 'degraded';
}): Promise<void> {
  if (!isM365TenantSyncEnabled()) return;
  try {
    const now = new Date();
    await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      await db.insert(m365SyncState).values(M365_SYNC_DOMAINS.map((domain) => ({
        orgId: conn.orgId,
        connectionId: conn.id,
        domain,
        nextSyncAt: now,
        intervalSeconds: M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS[domain],
      }))).onConflictDoUpdate({
        target: [m365SyncState.orgId, m365SyncState.domain],
        // Re-point at the surviving connection and re-arm. History
        // (last_success_at, last_complete_snapshot_at, last_counts) is NOT
        // reset: a re-consent to the SAME tenant should not make the org tab
        // claim it has never synced. A rebind to a different tenant goes
        // through a disconnect first, which deletes these rows outright.
        set: {
          connectionId: sql`excluded.connection_id`,
          nextSyncAt: sql`excluded.next_sync_at`,
          updatedAt: sql`now()`,
        },
      });
    }, 'm365SyncConsentSeed'));
    await runOutsideDbContext(() => claimAndEnqueue(conn.orgId, [...M365_SYNC_DOMAINS], 1));
  } catch (err) {
    console.error(
      `[m365Sync/lifecycle] Seeding failed for org=${conn.orgId} connection=${conn.id}; `
      + 'the ticker reconciliation will retry:',
      err,
    );
  }
}

/**
 * The customer-graph-read connection was disconnected. Spec §5.8: delete the
 * org's sync state and every entity row; KEEP the time series
 * (`m365_secure_score_snapshots`, `m365_posture_rollups`) — they carry
 * `tenant_id` and are filtered to the current connection's tenant at read
 * time. Any in-flight job fences at Phase C (its state row is gone).
 *
 * Runs on the caller's AMBIENT system context: `disconnectConnection` already
 * holds one, so these deletes commit in the same transaction as the status flip
 * and a disconnect can never half-happen.
 *
 * Deliberately THROWS on failure and is deliberately NOT flag-gated: a
 * committed disconnect that left a customer's user directory in our database is
 * a privacy defect; a failed disconnect the operator retries is not.
 */
export async function onConnectionDisconnected(conn: { id: string; orgId: string }): Promise<void> {
  // State FIRST, and the order is load-bearing: every sync persist transaction
  // holds FOR SHARE on its state row (domains/persist.ts
  // inOwnedRunTransaction). Deleting the state rows waits for any in-flight
  // chunk to commit and fences every later chunk, so the entity deletes below
  // (each a fresh READ COMMITTED snapshot) also catch rows a racing run wrote.
  await db.delete(m365SyncState).where(eq(m365SyncState.orgId, conn.orgId));
  await db.delete(m365Users).where(eq(m365Users.orgId, conn.orgId));
  await db.delete(m365IntuneDevices).where(eq(m365IntuneDevices.orgId, conn.orgId));
  await db.delete(m365CaPolicies).where(eq(m365CaPolicies.orgId, conn.orgId));
  await db.delete(m365LicenseSkus).where(eq(m365LicenseSkus.orgId, conn.orgId));
}

/**
 * An upgrade-consent promoted the manifest in place. Domains unscheduled for
 * want of a scope (`next_sync_at IS NULL AND last_status = 'needs_consent'`)
 * are re-armed and claimed at priority 1; domains that are already scheduled
 * keep their adaptive cadence (spec §5.7). Idempotent: an approval that granted
 * nothing costs one indexed UPDATE of zero rows.
 *
 * Never throws, for the same reason as consent seeding.
 */
export async function onConnectionUpgraded(conn: { id: string; orgId: string }): Promise<void> {
  if (!isM365TenantSyncEnabled()) return;
  try {
    const now = new Date();
    const rearmed = await runOutsideDbContext(() => withSystemDbAccessContext(async () => db
      .update(m365SyncState)
      .set({ nextSyncAt: now, updatedAt: now })
      .where(and(
        eq(m365SyncState.orgId, conn.orgId),
        isNull(m365SyncState.nextSyncAt),
        eq(m365SyncState.lastStatus, 'needs_consent'),
      ))
      .returning({ domain: m365SyncState.domain }), 'm365SyncUpgradeReseed'));
    const domains = rearmed.map((row) => row.domain as M365SyncDomain);
    if (domains.length > 0) await runOutsideDbContext(() => claimAndEnqueue(conn.orgId, domains, 1));
  } catch (err) {
    console.error(
      `[m365Sync/lifecycle] Upgrade re-seed failed for org=${conn.orgId} connection=${conn.id}:`,
      err,
    );
  }
}

/**
 * The on-demand route's effect: the five non-sign-in domains, priority 1.
 * `claimAndEnqueue` makes them due and claims them in one place, so nothing
 * here duplicates the claim protocol. MFA, the connection check and the rate
 * limit live in the route. Propagates a failure so the route can report it.
 *
 * `runOutsideDbContext` is load-bearing: the route runs inside the request's
 * org-scoped transaction, and `claimAndEnqueue`'s own system context would
 * otherwise NEST into it — the generation bump would not commit until the
 * request ends, while the job is already in Redis, so a fast worker's Phase A
 * would read the old generation and fence itself. Escaping first makes the
 * claim commit before the enqueue, as claim.ts documents.
 */
export async function requestOnDemandSync(input: { orgId: string; connectionId: string }): Promise<void> {
  if (!isM365TenantSyncEnabled()) return;
  await runOutsideDbContext(() => claimAndEnqueue(input.orgId, [...ON_DEMAND_SYNC_DOMAINS], 1));
}
