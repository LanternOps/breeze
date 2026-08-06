/**
 * Real-Postgres proof that `reapStaleExecutingIntents` keys stale-execution
 * detection off `execution_started_at` (COALESCE'd to `decided_at` for rows
 * that predate the column or were never stamped by the release worker —
 * Task 5 wires the stamp, this only adds the column + rekeys the reaper).
 *
 * The mocked unit suite (`intentExpiryReaper.test.ts`) can assert the SQL
 * text was built, but can't prove the `COALESCE(execution_started_at,
 * decided_at) < now() - interval` predicate actually selects the right rows
 * against a real Postgres `now()` — that requires this real-driver test.
 *
 * Also covers `reapExpiredIntents`' status-split deadline (tier3-supervised-
 * four-eyes design §4.2) for the same reason: the mocked unit suite can only
 * assert the SQL text shape, not that Postgres actually excludes/includes the
 * right rows around the "59:59 trap" — an intent approved just before
 * `approval_expires_at` gets a fresh `release_by` lease and must survive a
 * pass even though `approval_expires_at` (which no longer governs an approved
 * row) has since passed.
 */
import '../__tests__/integration/setup';
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { eq, sql, type SQL } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { actionIntents } from '../db/schema/actionIntents';
import { reapStaleExecutingIntents, reapExpiredIntents } from './intentExpiryReaper';
import { transitionIntent } from '../services/actionIntents/intentService';
import { createPartner, createOrganization, createUser } from '../__tests__/integration/db-utils';

describe('reapStaleExecutingIntents (real PG)', () => {
  let orgId: string;
  let requestedByUserId: string;

  // Seeded fresh in beforeEach (not beforeAll) — the shared integration
  // setup.ts TRUNCATEs the core tenant tables on every test's beforeEach, so
  // a beforeAll fixture would be silently wiped before the first it() runs.
  beforeEach(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    orgId = org.id;
    // action_intents_one_actor_chk requires exactly one of
    // requestedByUserId / requestingApiKeyId to be set.
    const user = await createUser({ partnerId: partner.id, orgId: org.id });
    requestedByUserId = user.id;
  });

  async function seedExecuting(fields: { executionStartedAt: Date | null; decidedAt: Date }): Promise<string> {
    return withSystemDbAccessContext(async () => {
      const [row] = await db
        .insert(actionIntents)
        .values({
          orgId,
          requestedByUserId,
          source: 'chat',
          actionName: 'execute_command',
          arguments: {},
          argumentDigest: 'a'.repeat(64),
          targetSummary: 't',
          impactSummary: 'i',
          riskTier: 3,
          idempotencyKey: randomUUID(),
          correlationId: randomUUID(),
          status: 'executing',
          expiresAt: new Date(Date.now() + 3_600_000),
          decidedAt: fields.decidedAt,
          executionStartedAt: fields.executionStartedAt,
          executedAt: null,
        })
        .returning({ id: actionIntents.id });
      return row!.id;
    });
  }

  it('reaps only intents whose COALESCE(execution_started_at, decided_at) is older than the timeout', async () => {
    // STALE_EXECUTING_TIMEOUT_MINUTES is 20 — 60 min ago is well past it,
    // "now" is well within it.
    const old = new Date(Date.now() - 60 * 60_000);
    const recent = new Date();

    // Stale via execution_started_at (decided_at is fresh — proves the
    // reaper no longer keys off decided_at alone).
    const staleId = await seedExecuting({ executionStartedAt: old, decidedAt: recent });
    // Fresh via execution_started_at (decided_at is stale — must NOT be
    // reaped once execution_started_at is stamped, even though decided_at
    // looks old).
    const freshId = await seedExecuting({ executionStartedAt: recent, decidedAt: old });
    // Never stamped (execution_started_at IS NULL) but decided_at is old —
    // must still be reaped via the COALESCE fallback.
    const nullStampButOldDecidedId = await seedExecuting({ executionStartedAt: null, decidedAt: old });

    const n = await withSystemDbAccessContext(() => reapStaleExecutingIntents());
    expect(n).toBe(2); // stale + null-stamp-old-decided; NOT the fresh one

    const read = async (id: string) =>
      withSystemDbAccessContext(async () => {
        const [r] = await db.select().from(actionIntents).where(eq(actionIntents.id, id)).limit(1);
        return r!;
      });

    const staleRow = await read(staleId);
    expect(staleRow.status).toBe('failed');
    expect(staleRow.errorCode).toBe('execution_lost');

    const nullStampRow = await read(nullStampButOldDecidedId);
    expect(nullStampRow.status).toBe('failed');
    expect(nullStampRow.errorCode).toBe('execution_lost');

    const freshRow = await read(freshId);
    expect(freshRow.status).toBe('executing');
    expect(freshRow.errorCode).toBeNull();
  });
});

describe('reapExpiredIntents (real PG) — status-split deadline', () => {
  let orgId: string;
  let requestedByUserId: string;

  beforeEach(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    orgId = org.id;
    const user = await createUser({ partnerId: partner.id, orgId: org.id });
    requestedByUserId = user.id;
  });

  async function seedIntent(fields: {
    status: 'pending_approval' | 'approved';
    // `SQL` is accepted so a fixture can be pinned to POSTGRES'S OWN clock
    // (`now() ± interval '...'`) instead of `Date.now()`. That is what makes
    // the sub-minute boundary test below meaningful: a JS-side timestamp is
    // only as accurate as the node/postgres clock offset, which is exactly
    // the magnitude of error a tight boundary is trying to detect.
    approvalExpiresAt: Date | SQL | null;
    releaseBy: Date | SQL | null;
    expiresAt: Date | SQL;
  }): Promise<string> {
    return withSystemDbAccessContext(async () => {
      const [row] = await db
        .insert(actionIntents)
        .values({
          orgId,
          requestedByUserId,
          source: 'chat',
          actionName: 'execute_command',
          arguments: {},
          argumentDigest: 'a'.repeat(64),
          targetSummary: 't',
          impactSummary: 'i',
          riskTier: 3,
          idempotencyKey: randomUUID(),
          correlationId: randomUUID(),
          status: fields.status,
          expiresAt: fields.expiresAt,
          approvalExpiresAt: fields.approvalExpiresAt,
          releaseBy: fields.releaseBy,
        })
        .returning({ id: actionIntents.id });
      return row!.id;
    });
  }

  const readStatus = async (id: string) =>
    withSystemDbAccessContext(async () => {
      const [r] = await db
        .select({ status: actionIntents.status })
        .from(actionIntents)
        .where(eq(actionIntents.id, id))
        .limit(1);
      return r!.status;
    });

  it('the 59:59 trap: an approved intent past approval_expires_at but with release_by still in the future is NOT reaped', async () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 5 * 60_000);

    // Approved just before its approval deadline: approval_expires_at is
    // already in the past, but release_by (the fresh lease stamped at
    // approval time) still has minutes left. Must survive the sweep.
    const trapId = await seedIntent({
      status: 'approved',
      approvalExpiresAt: past,
      releaseBy: future,
      expiresAt: past,
    });

    const n = await withSystemDbAccessContext(() => reapExpiredIntents());

    expect(n).toBe(0);
    expect(await readStatus(trapId)).toBe('approved');
  });

  it('reaps a pending_approval intent whose approval_expires_at has passed', async () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 3_600_000);

    const id = await seedIntent({
      status: 'pending_approval',
      approvalExpiresAt: past,
      releaseBy: null,
      expiresAt: future,
    });

    const n = await withSystemDbAccessContext(() => reapExpiredIntents());

    expect(n).toBe(1);
    expect(await readStatus(id)).toBe('expired');
  });

  it('reaps an approved intent once release_by has passed', async () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 3_600_000);

    const id = await seedIntent({
      status: 'approved',
      approvalExpiresAt: future,
      releaseBy: past,
      expiresAt: future,
    });

    const n = await withSystemDbAccessContext(() => reapExpiredIntents());

    expect(n).toBe(1);
    expect(await readStatus(id)).toBe('expired');
  });

  it('reaps a legacy pending_approval intent with a NULL approval_expires_at via the expires_at fallback', async () => {
    // A writer that predates (or bypasses) the approval_expires_at backfill:
    // the column is NULL, so the bare `approval_expires_at < now()`
    // predicate this test guards against is NULL (never true in SQL) —
    // without the COALESCE fallback this row would never be reaped.
    const past = new Date(Date.now() - 60_000);

    const id = await seedIntent({
      status: 'pending_approval',
      approvalExpiresAt: null,
      releaseBy: null,
      expiresAt: past,
    });

    const n = await withSystemDbAccessContext(() => reapExpiredIntents());

    expect(n).toBe(1);
    expect(await readStatus(id)).toBe('expired');
  });

  it('does not reap a legacy pending_approval intent with a NULL approval_expires_at whose expires_at fallback is still in the future', async () => {
    const future = new Date(Date.now() + 3_600_000);

    const id = await seedIntent({
      status: 'pending_approval',
      approvalExpiresAt: null,
      releaseBy: null,
      expiresAt: future,
    });

    const n = await withSystemDbAccessContext(() => reapExpiredIntents());

    expect(n).toBe(0);
    expect(await readStatus(id)).toBe('pending_approval');
  });

  it('reaps a legacy approved intent with no release_by via the expires_at fallback', async () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 3_600_000);

    const id = await seedIntent({
      status: 'approved',
      approvalExpiresAt: future,
      releaseBy: null,
      expiresAt: past,
    });

    const n = await withSystemDbAccessContext(() => reapExpiredIntents());

    expect(n).toBe(1);
    expect(await readStatus(id)).toBe('expired');
  });

  it('does not reap a legacy approved intent whose expires_at fallback is still in the future', async () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 3_600_000);

    const id = await seedIntent({
      status: 'approved',
      approvalExpiresAt: past,
      releaseBy: null,
      expiresAt: future,
    });

    const n = await withSystemDbAccessContext(() => reapExpiredIntents());

    expect(n).toBe(0);
    expect(await readStatus(id)).toBe('approved');
  });

  it('boundary: a lease that ended 1 second ago is reaped in the same pass that spares one with 5 seconds left', async () => {
    // Every other fixture in this file carries ±60s to ±60min of slack, so a
    // units or sign error worth a few seconds (or a stray `interval '1
    // minute'` of fudge) would pass every one of them. These two rows are
    // seeded against POSTGRES'S OWN clock, so the assertion is immune to
    // node/postgres clock skew and genuinely pins the comparison to the
    // second — in both directions, in a single pass.
    const past = new Date(Date.now() - 3_600_000);
    const future = new Date(Date.now() + 3_600_000);

    // approval_expires_at is deliberately in the FUTURE on the row that must
    // be reaped and in the PAST on the row that must survive: only a
    // predicate genuinely keyed on release_by produces this pairing.
    const justExpiredId = await seedIntent({
      status: 'approved',
      approvalExpiresAt: future,
      releaseBy: sql`now() - interval '1 second'`,
      expiresAt: future,
    });
    const barelyLiveId = await seedIntent({
      status: 'approved',
      approvalExpiresAt: past,
      releaseBy: sql`now() + interval '5 seconds'`,
      expiresAt: past,
    });

    const n = await withSystemDbAccessContext(() => reapExpiredIntents());

    expect(n).toBe(1);
    expect(await readStatus(justExpiredId)).toBe('expired');
    expect(await readStatus(barelyLiveId)).toBe('approved');
  });
});

/**
 * `transitionIntent(..., { requireNotExpired })` is the release worker's and
 * the inline chat path's claim CAS — its `COALESCE(release_by, expires_at) >
 * now()` predicate is what actually decides whether an APPROVED intent may
 * still be executed. Until now that predicate was asserted only as SQL TEXT
 * (intentService.test.ts); nothing proved Postgres selects the right rows.
 *
 * The `release_by IS NULL` fallback in particular is not an edge case: every
 * intent approved before this deploy has a NULL lease, so at rollout it is
 * the ENTIRE installed base. The reaper side of that fallback was already
 * covered above; this is the RELEASE side.
 */
describe('transitionIntent requireNotExpired (real PG) — the release claim', () => {
  let orgId: string;
  let requestedByUserId: string;

  beforeEach(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    orgId = org.id;
    const user = await createUser({ partnerId: partner.id, orgId: org.id });
    requestedByUserId = user.id;
  });

  async function seedApproved(fields: {
    releaseBy: Date | SQL | null;
    expiresAt: Date | SQL;
  }): Promise<string> {
    return withSystemDbAccessContext(async () => {
      const [row] = await db
        .insert(actionIntents)
        .values({
          orgId,
          requestedByUserId,
          source: 'chat',
          actionName: 'execute_command',
          arguments: {},
          argumentDigest: 'a'.repeat(64),
          targetSummary: 't',
          impactSummary: 'i',
          riskTier: 3,
          idempotencyKey: randomUUID(),
          correlationId: randomUUID(),
          status: 'approved',
          // Already past — an approved intent is no longer governed by its
          // decide-by deadline, so every case below must turn purely on the
          // release lease.
          approvalExpiresAt: new Date(Date.now() - 60_000),
          expiresAt: fields.expiresAt,
          releaseBy: fields.releaseBy,
        })
        .returning({ id: actionIntents.id });
      return row!.id;
    });
  }

  const readStatus = async (id: string) =>
    withSystemDbAccessContext(async () => {
      const [r] = await db
        .select({ status: actionIntents.status })
        .from(actionIntents)
        .where(eq(actionIntents.id, id))
        .limit(1);
      return r!.status;
    });

  it('RELEASES a legacy intent with NULL release_by whose expires_at fallback is still live', async () => {
    const id = await seedApproved({ releaseBy: null, expiresAt: new Date(Date.now() + 3_600_000) });

    const claimed = await transitionIntent(
      id,
      'approved',
      'executing',
      { executedAt: null, executionStartedAt: new Date() },
      { requireNotExpired: 'release' },
    );

    expect(claimed).toBe(true);
    expect(await readStatus(id)).toBe('executing');
  });

  it('REFUSES a legacy intent with NULL release_by once its expires_at fallback has passed', async () => {
    const id = await seedApproved({ releaseBy: null, expiresAt: new Date(Date.now() - 60_000) });

    const claimed = await transitionIntent(
      id,
      'approved',
      'executing',
      { executedAt: null, executionStartedAt: new Date() },
      { requireNotExpired: 'release' },
    );

    expect(claimed).toBe(false);
    // Left untouched for the 30s expiry reaper to terminalize — never
    // half-claimed.
    expect(await readStatus(id)).toBe('approved');
  });

  it('claims on the release lease, not expires_at, when both are set and disagree', async () => {
    // expires_at long past, release_by still live: the fresh lease stamped at
    // approval time is what governs. A predicate that read expires_at (or
    // ANDed the two) would refuse this claim and strand every intent
    // approved near its original deadline.
    const id = await seedApproved({
      releaseBy: new Date(Date.now() + 10 * 60_000),
      expiresAt: new Date(Date.now() - 60_000),
    });

    const claimed = await transitionIntent(
      id,
      'approved',
      'executing',
      { executedAt: null, executionStartedAt: new Date() },
      { requireNotExpired: 'release' },
    );

    expect(claimed).toBe(true);
    expect(await readStatus(id)).toBe('executing');
  });

  it('boundary: claims a lease with 5 seconds left, refuses one that ended 1 second ago (DB-clock relative)', async () => {
    const liveId = await seedApproved({
      releaseBy: sql`now() + interval '5 seconds'`,
      expiresAt: new Date(Date.now() - 3_600_000),
    });
    const deadId = await seedApproved({
      releaseBy: sql`now() - interval '1 second'`,
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const claim = (id: string) =>
      transitionIntent(
        id,
        'approved',
        'executing',
        { executedAt: null, executionStartedAt: new Date() },
        { requireNotExpired: 'release' },
      );

    expect(await claim(liveId)).toBe(true);
    expect(await claim(deadId)).toBe(false);
    expect(await readStatus(liveId)).toBe('executing');
    expect(await readStatus(deadId)).toBe('approved');
  });
});
