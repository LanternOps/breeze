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
