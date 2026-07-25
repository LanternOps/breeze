/**
 * Proves the mechanism `retryOnTransientLockError` depends on: that a REAL
 * Postgres deadlock (40P01) raised inside a nested Drizzle transaction is
 * recoverable, so the retry can actually re-run the work.
 *
 * Why this needs a real DB rather than reasoning: the retry is only sound if
 * `ROLLBACK TO SAVEPOINT` restores the outer transaction after a deadlock. A
 * deadlock is delivered to the victim as an ordinary statement-level ERROR, so
 * in principle the subtransaction aborts and the outer survives — but "in
 * principle" is exactly the assumption that shipped BREEZE-3, and if it were
 * wrong the retry would fail with 25P02 on every follow-up statement and the
 * agent report would still be lost. See dbSavepointErrorIsolation for the
 * general savepoint-isolation proof; this file pins the 40P01 case specifically.
 *
 * The deadlock is induced deterministically, not by racing: the competitor
 * holds row B and only reaches for row A once pg_locks confirms the
 * code-under-test is genuinely blocked waiting on B.
 */
import './setup';

import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { sites } from '../../db/schema';
import { isTransientLockError, pgErrorCode, retryOnTransientLockError } from '../../utils/pgErrors';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getAppDb, getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function orgCtx(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: null,
  };
}

/** Resolves once some backend is waiting on an ungranted row lock. */
async function waitForBlockedLock(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = (await getTestDb().execute(sql`
      SELECT count(*)::int AS waiting
      FROM pg_locks
      WHERE NOT granted AND locktype IN ('transactionid', 'tuple')
    `)) as unknown as Array<{ waiting: number }>;
    if ((rows[0]?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for a blocked lock — the deadlock setup did not engage');
}

describe('transient lock retry against real Postgres', () => {
  runDb('recovers from a real 40P01 inside a nested transaction and commits on retry', async () => {
    // Two rows in the same org-scoped table, locked in opposite orders by the
    // two sides. Same org for both so a plain org context can read, lock and
    // update either one — the test is about lock ordering, not about RLS.
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const siteA = await createSite({ orgId: org.id, name: 'deadlock-a' });
    const siteB = await createSite({ orgId: org.id, name: 'deadlock-b' });

    const ctx = orgCtx(org.id);

    // The competitor runs on its own breeze_app connection so this is a genuine
    // two-backend deadlock, not a self-conflict.
    const competitor = getAppDb();
    let competitorReachedForA = false;

    const competitorDone = competitor.transaction(async (ctx2) => {
      await ctx2.execute(sql`SELECT set_config('breeze.scope', 'system', true)`);
      // Hold B.
      await ctx2.execute(sql`SELECT id FROM sites WHERE id = ${siteB.id}::uuid FOR UPDATE`);
      // Only now reach for A — after the code under test is provably blocked on
      // B. One of the two backends is then chosen as the deadlock victim.
      await waitForBlockedLock();
      competitorReachedForA = true;
      await ctx2.execute(sql`SELECT id FROM sites WHERE id = ${siteA.id}::uuid FOR UPDATE`);
    });

    let attempts = 0;
    let sawDeadlock = false;

    const result = await withDbAccessContext(ctx, async () => {
      return retryOnTransientLockError('test deadlock', async () => {
        attempts += 1;
        try {
          // Nested drizzle transaction => postgres.js savepoint.
          return await db.transaction(async (tx) => {
            // Hold A, then reach for B (the inversion).
            await tx.execute(sql`SELECT id FROM sites WHERE id = ${siteA.id}::uuid FOR UPDATE`);
            await tx.execute(sql`SELECT id FROM sites WHERE id = ${siteB.id}::uuid FOR UPDATE`);
            // Proves the retry attempt can still WRITE — i.e. the outer
            // transaction really is healthy after the rolled-back savepoint,
            // not merely readable.
            await tx
              .update(sites)
              .set({ name: `deadlock-a-updated-${attempts}` })
              .where(eq(sites.id, siteA.id));
            return 'committed';
          });
        } catch (error) {
          if (isTransientLockError(error)) {
            sawDeadlock = true;
            expect(pgErrorCode(error)).toBe('40P01');
          }
          throw error;
        }
      });
    });

    await competitorDone.catch((error) => {
      // Either side can be the victim; if the competitor lost, that is fine.
      if (!isTransientLockError(error)) throw error;
    });

    expect(competitorReachedForA).toBe(true);
    // The whole point: the work eventually succeeded rather than 500ing.
    expect(result).toBe('committed');

    // And it really committed — read it back on a fresh context.
    const [row] = (await withDbAccessContext(orgCtx(org.id), () =>
      db.select({ name: sites.name }).from(sites).where(eq(sites.id, siteA.id)),
    )) as Array<{ name: string }>;
    expect(row?.name).toBe(`deadlock-a-updated-${attempts}`);

    // If this side happened to win the race there was no deadlock to recover
    // from and the test proved nothing about 40P01 — fail loudly rather than
    // pass vacuously.
    expect(sawDeadlock, 'no 40P01 was observed; the deadlock did not engage').toBe(true);
    expect(attempts).toBeGreaterThan(1);
  }, 60_000);
});
