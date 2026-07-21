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
 */
import '../__tests__/integration/setup';
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { actionIntents } from '../db/schema/actionIntents';
import { reapStaleExecutingIntents } from './intentExpiryReaper';
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
