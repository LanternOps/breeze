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
 * The deadlock is induced deterministically, not by racing. Each step waits on
 * an explicit barrier, not a fixed sleep. Timeouts are only failure ceilings:
 *
 *   1. The competitor locks row B, then waits.
 *   2. The code-under-test locks row A (inside its savepoint), then waits.
 *   3. The competitor reaches for A and blocks on the code-under-test.
 *   4. Once `pg_blocking_pids` shows that wait between these two backends, the
 *      code-under-test reaches for B, which closes the cycle.
 *
 * Which backend Postgres picks as the victim is fixed as well. The competitor
 * raises its own `deadlock_timeout` to 60 s, so its deadlock check never runs
 * during the test. The code-under-test keeps the 1 s default, and the cycle is
 * already complete when it starts to wait. Its check therefore always finds
 * the cycle, and the code-under-test always receives the 40P01.
 *
 * #12059: the previous version only made the competitor wait. Nothing stopped
 * the code-under-test from locking B first when the competitor's connection
 * was slow to open, so no deadlock happened. The competitor then polled
 * pg_locks for a waiter that never came and timed out after 10 s.
 */
import './setup';

import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { sites } from '../../db/schema';
import { isTransientLockError, pgErrorCode, retryOnTransientLockError } from '../../utils/pgErrors';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

/** Upper bound for any one barrier. It is a ceiling, not a sleep. */
const BARRIER_TIMEOUT_MS = 30_000;

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

/**
 * A one-shot barrier that fails loudly instead of hanging. `fail` releases the
 * waiter with the other side's real error, so a setup failure surfaces at once
 * and is not reported as a barrier timeout 30 s later.
 */
function barrier<T>(name: string) {
  let resolve!: (value: T) => void;
  let fail!: (error: unknown) => void;
  const reached = new Promise<T>((res, rej) => {
    resolve = res;
    fail = rej;
  });
  // A failure nobody waits for is not an unhandled rejection.
  reached.catch(() => undefined);
  return {
    resolve,
    fail,
    wait: async (): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`barrier "${name}" was not reached within ${BARRIER_TIMEOUT_MS} ms`)),
          BARRIER_TIMEOUT_MS,
        );
      });
      try {
        return await Promise.race([reached, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

type Executor = { execute: typeof db.execute };

async function backendPid(conn: Executor): Promise<number> {
  const rows = (await conn.execute(sql`SELECT pg_backend_pid() AS pid`)) as unknown as Array<{ pid: number }>;
  const pid = rows[0]?.pid;
  if (typeof pid !== 'number') throw new Error('could not read pg_backend_pid()');
  return pid;
}

/**
 * Resolves once backend `waiterPid` is waiting on a lock held by `holderPid`.
 * Scoped to these two backends, so no other session on the database can
 * satisfy it by accident.
 */
async function waitUntilBlockedBy(waiterPid: number, holderPid: number): Promise<void> {
  const deadline = Date.now() + BARRIER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const rows = (await getTestDb().execute(sql`
      SELECT ${holderPid}::int = ANY(pg_blocking_pids(${waiterPid}::int)) AS blocked
    `)) as unknown as Array<{ blocked: boolean }>;
    if (rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `backend ${waiterPid} never blocked on backend ${holderPid} within ${BARRIER_TIMEOUT_MS} ms — the deadlock setup did not engage`,
  );
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

    const competitorHoldsB = barrier<number>('competitor holds B');
    const codeHoldsA = barrier<number>('code-under-test holds A');

    // The competitor runs on its own connection, so this is a deadlock between
    // two backends, not a conflict within one session. It uses the superuser
    // client because only a superuser may change deadlock_timeout. RLS plays
    // no part here; the test is about lock order.
    const competitorDone = getTestDb().transaction(async (ctx2) => {
      // Its deadlock check must never run first. Otherwise the competitor
      // could become the victim and the code-under-test would see no 40P01.
      await ctx2.execute(sql`SET LOCAL deadlock_timeout = '60s'`);
      const pid = await backendPid(ctx2);
      // Hold B.
      await ctx2.execute(sql`SELECT id FROM sites WHERE id = ${siteB.id}::uuid FOR UPDATE`);
      competitorHoldsB.resolve(pid);
      // Reach for A only while the code-under-test holds it. This blocks
      // until the victim's savepoint rolls back and releases A.
      await codeHoldsA.wait();
      await ctx2.execute(sql`SELECT id FROM sites WHERE id = ${siteA.id}::uuid FOR UPDATE`);
    });
    // If the competitor fails before it holds B, release the code-under-test
    // with the real error. This also marks the rejection as handled while the
    // code-under-test runs; `await competitorDone` below still rethrows it.
    competitorDone.catch((error) => competitorHoldsB.fail(error));

    let attempts = 0;
    let sawDeadlock = false;

    const result = await withDbAccessContext(ctx, async () => {
      return retryOnTransientLockError('test deadlock', async () => {
        attempts += 1;
        const firstAttempt = attempts === 1;
        try {
          // Nested drizzle transaction => postgres.js savepoint.
          return await db.transaction(async (tx) => {
            if (firstAttempt) {
              // B must already be held, so this side can never lock it first.
              const competitorPid = await competitorHoldsB.wait();
              const pid = await backendPid(tx);
              // Hold A.
              await tx.execute(sql`SELECT id FROM sites WHERE id = ${siteA.id}::uuid FOR UPDATE`);
              codeHoldsA.resolve(pid);
              // Close the cycle only after the competitor is waiting on A.
              await waitUntilBlockedBy(competitorPid, pid);
            } else {
              await tx.execute(sql`SELECT id FROM sites WHERE id = ${siteA.id}::uuid FOR UPDATE`);
            }
            // Reach for B (the inversion). On the first attempt this deadlocks.
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
    }).catch((error: unknown) => {
      // If this side failed before it held A, release the competitor so it
      // rolls back and frees B now, not after its 30 s barrier ceiling.
      codeHoldsA.fail(error);
      throw error;
    });

    // The victim is fixed, so the competitor must finish cleanly.
    await competitorDone;

    // The whole point: the work eventually succeeded rather than 500ing.
    expect(result).toBe('committed');

    // And it really committed — read it back on a fresh context.
    const [row] = (await withDbAccessContext(orgCtx(org.id), () =>
      db.select({ name: sites.name }).from(sites).where(eq(sites.id, siteA.id)),
    )) as Array<{ name: string }>;
    expect(row?.name).toBe(`deadlock-a-updated-${attempts}`);

    // Exactly one 40P01, then one clean retry. Any other count means the
    // setup did not run as designed.
    expect(sawDeadlock, 'no 40P01 was observed; the deadlock did not engage').toBe(true);
    expect(attempts).toBe(2);
  }, 60_000);
});
