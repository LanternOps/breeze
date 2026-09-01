/**
 * Integration test for audit-log retention pruning (Task 29).
 *
 * Three things only a real Postgres can prove:
 *
 *   1. `pruneExpiredAuditLogs` actually deletes rows older than the
 *      per-org retention policy when both bypass layers are armed.
 *   2. Rows inside the retention window are preserved.
 *   3. Without the bypass GUC, `breeze_app` still cannot DELETE — the
 *      trigger continues to fire for every other code path. Regression
 *      guard against accidentally weakening the append-only invariant.
 */
import './setup';
import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { getTestDb } from './setup';
import { createPartner, createOrganization } from './db-utils';
import { pruneExpiredAuditLogs } from '../../jobs/auditRetention';

describe('audit-log retention pruning', () => {
  let orgId: string;

  // beforeEach because setup.ts TRUNCATEs audit_logs + organizations on
  // every test. We need a fresh FK target each time.
  beforeEach(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    orgId = org.id;
  });

  it('deletes audit rows older than the org retention policy', async () => {
    // Seed via the superuser test client so we don't have to defeat the
    // breeze_app DELETE revoke for the setup phase.
    await getTestDb().execute(sql`
      INSERT INTO audit_retention_policies (org_id, retention_days)
      VALUES (${orgId}, 30)
    `);
    await getTestDb().execute(sql`
      INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result, timestamp)
      VALUES (${orgId}, 'system', gen_random_uuid(), 'old.action', 'test', 'success', now() - interval '60 days')
    `);

    const before = (await getTestDb().execute(
      sql`SELECT count(*)::int AS n FROM audit_logs WHERE org_id = ${orgId}`,
    )) as unknown as Array<{ n: number }>;
    expect(before[0]?.n).toBe(1);

    const stats = await pruneExpiredAuditLogs();
    expect(stats.rowsDeleted).toBeGreaterThanOrEqual(1);
    expect(stats.errors).toBe(0);

    const after = (await getTestDb().execute(
      sql`SELECT count(*)::int AS n FROM audit_logs WHERE org_id = ${orgId}`,
    )) as unknown as Array<{ n: number }>;
    expect(after[0]?.n).toBe(0);
  });

  it('preserves audit rows inside the retention window', async () => {
    await getTestDb().execute(sql`
      INSERT INTO audit_retention_policies (org_id, retention_days)
      VALUES (${orgId}, 90)
    `);
    await getTestDb().execute(sql`
      INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result, timestamp)
      VALUES (${orgId}, 'system', gen_random_uuid(), 'recent.action', 'test', 'success', now() - interval '15 days')
    `);

    await pruneExpiredAuditLogs();

    const after = (await getTestDb().execute(
      sql`SELECT count(*)::int AS n FROM audit_logs WHERE org_id = ${orgId}`,
    )) as unknown as Array<{ n: number }>;
    expect(after[0]?.n).toBe(1);
  });

  it('updates last_cleanup_at on the policy after a successful run', async () => {
    await getTestDb().execute(sql`
      INSERT INTO audit_retention_policies (org_id, retention_days, last_cleanup_at)
      VALUES (${orgId}, 30, NULL)
    `);

    await pruneExpiredAuditLogs();

    const rows = (await getTestDb().execute(sql`
      SELECT last_cleanup_at
      FROM audit_retention_policies
      WHERE org_id = ${orgId}
    `)) as unknown as Array<{ last_cleanup_at: Date | null }>;
    expect(rows[0]?.last_cleanup_at).not.toBeNull();
  });

  it('is idempotent — a second run on the same day deletes nothing', async () => {
    await getTestDb().execute(sql`
      INSERT INTO audit_retention_policies (org_id, retention_days)
      VALUES (${orgId}, 30)
    `);
    await getTestDb().execute(sql`
      INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result, timestamp)
      VALUES (${orgId}, 'system', gen_random_uuid(), 'old', 'test', 'success', now() - interval '60 days')
    `);

    const first = await pruneExpiredAuditLogs();
    expect(first.rowsDeleted).toBeGreaterThanOrEqual(1);

    const second = await pruneExpiredAuditLogs();
    expect(second.rowsDeleted).toBe(0);
    expect(second.errors).toBe(0);
  });

  // Regression guard for the #1002 trusted-anchor rule. NOTE: the name/comment
  // here used to say retention "re-anchors" the chain — it does not, and cannot:
  // migration 2026-06-11-g REVOKEs UPDATE from breeze_audit_admin and
  // audit_log_chain_block_update raises on every UPDATE. Retention deletes a
  // PREFIX and rewrites nothing; the verifier treats the first surviving entry's
  // prev_chain_checksum as the trusted anchor.
  //
  // The load-bearing assertion is the verify_chain call at the end. The
  // prev_checksum check below is only a shape check — the seal trigger
  // (2026-06-11-h) NULLs audit_logs.prev_checksum on EVERY insert, so it would
  // hold even if the prune did nothing.
  it('leaves a verifiable chain after pruning, with no re-anchor', async () => {
    await getTestDb().execute(sql`
      INSERT INTO audit_retention_policies (org_id, retention_days)
      VALUES (${orgId}, 30)
    `);

    // Three rows: two old (will be pruned), one recent (will survive and
    // become the new chain head).
    await getTestDb().execute(sql`
      INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result, timestamp)
      VALUES
        (${orgId}, 'system', gen_random_uuid(), 'a', 'test', 'success', now() - interval '90 days'),
        (${orgId}, 'system', gen_random_uuid(), 'b', 'test', 'success', now() - interval '60 days'),
        (${orgId}, 'system', gen_random_uuid(), 'c', 'test', 'success', now() - interval '5 days')
    `);

    // Sanity: pre-prune the verifier sees a clean chain.
    const preBreaks = (await getTestDb().execute(
      sql`SELECT count(*)::int AS n FROM audit_log_verify_chain(${orgId})`,
    )) as unknown as Array<{ n: number }>;
    expect(preBreaks[0]?.n).toBe(0);

    const stats = await pruneExpiredAuditLogs();
    expect(stats.rowsDeleted).toBe(2);
    expect(stats.errors).toBe(0);

    const survivors = (await getTestDb().execute(sql`
      SELECT prev_checksum FROM audit_logs WHERE org_id = ${orgId}
    `)) as unknown as Array<{ prev_checksum: string | null }>;
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.prev_checksum).toBeNull();

    // The actual point of the test: the verifier must return zero breaks.
    const postBreaks = (await getTestDb().execute(
      sql`SELECT count(*)::int AS n FROM audit_log_verify_chain(${orgId})`,
    )) as unknown as Array<{ n: number }>;
    expect(postBreaks[0]?.n).toBe(0);
  });

  /**
   * Issue #4239 rewrote the prefix bound from `MIN(chain_seq)` over the full
   * `audit_log_chain ⋈ audit_logs` join to an ordered early-stop
   * (`ORDER BY chain_seq LIMIT 1`), and split the DELETE into `LIMIT` batches.
   * The invariant those must not break is the one the prefix-cut design
   * (#1002) exists for: chain_seq is COMMIT order, so timestamps can run
   * old → young → old along the chain, and retention must delete ONLY the
   * leading old prefix.
   */
  describe('chain-prefix invariant under the #4239 rewrite', () => {
    // Each execute() is its own transaction, so statement order == chain_seq order.
    const seed = async (rows: Array<{ action: string; ageDays: number }>) => {
      for (const row of rows) {
        await getTestDb().execute(sql`
          INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result, timestamp)
          VALUES (${orgId}, 'system', gen_random_uuid(), ${row.action}, 'test', 'success',
                  now() - (${row.ageDays}::int * interval '1 day'))
        `);
      }
    };

    const survivors = async () =>
      (await getTestDb().execute(sql`
        SELECT a.action, c.chain_seq::text AS chain_seq
        FROM audit_logs a
        JOIN audit_log_chain c ON c.audit_id = a.id
        WHERE a.org_id = ${orgId}
        ORDER BY c.chain_seq
      `)) as unknown as Array<{ action: string; chain_seq: string }>;

    const chainBreaks = async () => {
      const rows = (await getTestDb().execute(
        sql`SELECT count(*)::int AS n FROM audit_log_verify_chain(${orgId})`,
      )) as unknown as Array<{ n: number }>;
      return rows[0]?.n;
    };

    beforeEach(async () => {
      await getTestDb().execute(sql`
        INSERT INTO audit_retention_policies (org_id, retention_days) VALUES (${orgId}, 30)
      `);
    });

    it('old → young → old in chain order: deletes only the leading old prefix and leaves the chain verifiable', async () => {
      await seed([
        { action: 'old-leading', ageDays: 90 },
        { action: 'young-blocker', ageDays: 5 },
        { action: 'old-straggler', ageDays: 60 },
      ]);
      expect(await chainBreaks()).toBe(0);

      const stats = await pruneExpiredAuditLogs();
      expect(stats.errors).toBe(0);
      // Only the row BELOW the first young entry goes. The 60-day straggler
      // sits behind it in chain order and must survive this cycle — deleting
      // it would punch a permanent hole in the linkage.
      expect(stats.rowsDeleted).toBe(1);

      expect((await survivors()).map((r) => r.action)).toEqual([
        'young-blocker',
        'old-straggler',
      ]);
      expect(await chainBreaks()).toBe(0);
    });

    it('drains a multi-batch prefix completely and stays verifiable', async () => {
      await seed([
        { action: 'old-1', ageDays: 95 },
        { action: 'old-2', ageDays: 94 },
        { action: 'old-3', ageDays: 93 },
        { action: 'old-4', ageDays: 92 },
        { action: 'old-5', ageDays: 91 },
        { action: 'young', ageDays: 1 },
      ]);

      const stats = await pruneExpiredAuditLogs({ batchSize: 2, maxBatches: 50 });

      expect(stats.rowsDeleted).toBe(5);
      expect(stats.orgsWithBacklog).toBe(0);
      // Pins that the DELETE's LIMIT really is batchSize: 5 rows at 2 per batch
      // is 2+2+1 = 3 prefix statements, plus 1 sweep. A statement that bound the
      // ceiling (50) instead would take all 5 in one batch and report 2.
      expect(stats.batches).toBe(4);
      expect((await survivors()).map((r) => r.action)).toEqual(['young']);
      expect(await chainBreaks()).toBe(0);
    });

    it('stopping at the maxBatches ceiling leaves a contiguous suffix, not holes', async () => {
      await seed([
        { action: 'old-1', ageDays: 95 },
        { action: 'old-2', ageDays: 94 },
        { action: 'old-3', ageDays: 93 },
        { action: 'old-4', ageDays: 92 },
        { action: 'old-5', ageDays: 91 },
        { action: 'old-6', ageDays: 90 },
        { action: 'young', ageDays: 1 },
      ]);

      // 2 batches x 2 rows = 4 of the 6 expired rows; the ceiling stops the loop
      // while full batches are still coming back.
      const capped = await pruneExpiredAuditLogs({ batchSize: 2, maxBatches: 2 });
      expect(capped.rowsDeleted).toBe(4);
      expect(capped.orgsWithBacklog).toBe(1);
      expect(capped.errors).toBe(0);

      // The batches must have taken the LOWEST chain_seq values. Anything else
      // (an unordered LIMIT) would leave a gap mid-chain here.
      const remaining = await survivors();
      expect(remaining.map((r) => r.action)).toEqual(['old-5', 'old-6', 'young']);
      expect(await chainBreaks()).toBe(0);

      // The next run continues the prefix rather than being stuck.
      const rest = await pruneExpiredAuditLogs({ batchSize: 2, maxBatches: 50 });
      expect(rest.rowsDeleted).toBe(2);
      expect(rest.orgsWithBacklog).toBe(0);
      expect((await survivors()).map((r) => r.action)).toEqual(['young']);
      expect(await chainBreaks()).toBe(0);
    });

    // The unsealed sweep is the one statement no other test ever makes delete a
    // row: every seeded row gets a chain entry from the deferred seal trigger, so
    // the sweep always matches zero and only its syntax was proven. It runs in
    // SYSTEM scope (accessible_org_ids = '*') against a FORCE-RLS table, so RLS
    // will not catch a mis-scoped predicate — this is the only thing that would.
    it('sweeps unsealed expired rows for the policy org only, leaving other tenants alone', async () => {
      const otherPartner = await createPartner();
      const otherOrg = await createOrganization({ partnerId: otherPartner.id });

      // session_replication_role=replica suppresses the deferred seal trigger, so
      // these rows land in audit_logs with no audit_log_chain entry — the shape
      // the sweep exists for. SET LOCAL keeps it scoped to this transaction.
      await getTestDb().transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role = replica`);
        await tx.execute(sql`
          INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result, timestamp)
          VALUES
            (${orgId}, 'system', gen_random_uuid(), 'unsealed-old', 'test', 'success', now() - interval '90 days'),
            (${orgId}, 'system', gen_random_uuid(), 'unsealed-young', 'test', 'success', now() - interval '2 days'),
            (${otherOrg.id}, 'system', gen_random_uuid(), 'other-org-old', 'test', 'success', now() - interval '90 days')
        `);
      });

      const unsealed = (await getTestDb().execute(sql`
        SELECT count(*)::int AS n FROM audit_logs a
        WHERE NOT EXISTS (SELECT 1 FROM audit_log_chain c WHERE c.audit_id = a.id)
      `)) as unknown as Array<{ n: number }>;
      expect(unsealed[0]?.n).toBe(3); // the fixture really is unsealed

      // Only orgId has a retention policy (this describe's beforeEach).
      const stats = await pruneExpiredAuditLogs();

      expect(stats.errors).toBe(0);
      // Exactly the one expired unsealed row belonging to the policy's org.
      expect(stats.unsealedRowsDeleted).toBe(1);

      const remaining = (await getTestDb().execute(sql`
        SELECT a.action, a.org_id::text AS org_id FROM audit_logs a
        WHERE NOT EXISTS (SELECT 1 FROM audit_log_chain c WHERE c.audit_id = a.id)
        ORDER BY a.action
      `)) as unknown as Array<{ action: string; org_id: string }>;
      // The young row stays (inside the window); the OTHER TENANT's expired row
      // stays because it has no policy and is not this org.
      expect(remaining.map((r) => r.action)).toEqual(['other-org-old', 'unsealed-young']);
      expect(remaining.find((r) => r.action === 'other-org-old')?.org_id).toBe(otherOrg.id);
    });

    it('an org whose rows are all inside the window is untouched and reports no backlog', async () => {
      await seed([
        { action: 'young-1', ageDays: 3 },
        { action: 'young-2', ageDays: 2 },
      ]);

      const stats = await pruneExpiredAuditLogs({ batchSize: 1, maxBatches: 5 });

      expect(stats.rowsDeleted).toBe(0);
      expect(stats.orgsWithBacklog).toBe(0);
      expect((await survivors()).map((r) => r.action)).toEqual(['young-1', 'young-2']);
      expect(await chainBreaks()).toBe(0);
    });
  });

  // Regression guard: the bypass GUC must default to off. Without
  // setting it, `breeze_app` (even with the audit_admin role membership)
  // must still see the trigger fire on DELETE.
  it('without the bypass GUC, breeze_app cannot DELETE even via the admin role', async () => {
    // Seed a stale row.
    await getTestDb().execute(sql`
      INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result, timestamp)
      VALUES (${orgId}, 'system', gen_random_uuid(), 'old', 'test', 'success', now() - interval '60 days')
    `);

    let caught: unknown;
    try {
      await withSystemDbAccessContext(async () => {
        // Role switch alone is not enough — the trigger still fires.
        await db.execute(sql`SET LOCAL ROLE breeze_audit_admin`);
        await db.execute(sql`
          DELETE FROM audit_logs WHERE org_id = ${orgId}
        `);
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    const cause = (caught as { cause?: { message?: string } } | undefined)?.cause;
    expect(cause?.message).toMatch(/audit log is append-only/i);

    const remaining = (await getTestDb().execute(
      sql`SELECT count(*)::int AS n FROM audit_logs WHERE org_id = ${orgId}`,
    )) as unknown as Array<{ n: number }>;
    expect(remaining[0]?.n).toBe(1);
  });
});
