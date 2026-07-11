/**
 * Regression coverage for #2205 — cleanupDatabase() used to be a silent no-op
 * for the tenant-root tables.
 *
 * The bug: `TRUNCATE partners/organizations ... CASCADE` transitively reaches
 * `audit_logs`, whose `audit_log_block_truncate` BEFORE TRUNCATE trigger
 * (migration 2026-05-25-k) unconditionally rejects ANY truncate touching the
 * table — the append-only bypass GUC (`breeze.allow_audit_retention`) only
 * exists for DELETE. The whole TRUNCATE statement failed, cleanupDatabase()'s
 * blanket try/catch swallowed the error, and tenant rows accumulated across
 * every suite in an integration run. It surfaced in the #2202 loginContext
 * suite — the first to assert on GLOBAL partner state.
 *
 * The fix (setup.ts): disable the audit trigger around a single combined
 * TRUNCATE (re-enabled in a finally), and fail loudly on any truncate error
 * instead of swallowing it.
 *
 * These tests prove:
 *   1. Stray partner/organization/audit_logs rows are genuinely removed —
 *      including when an audit row forces the cascade to reach audit_logs.
 *   2. The append-only TRUNCATE guard on audit_logs is re-enabled after
 *      cleanup — prod semantics are untouched.
 *   3. A truncate failure surfaces loudly (no silent swallow) AND still
 *      re-enables the audit trigger via the finally — the two regressions
 *      that would quietly reintroduce #2205.
 *
 * Run:
 *   pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/cleanupDatabase.integration.test.ts
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { cleanupDatabase, getTestDb } from './setup';
import { auditLogs, organizations, partners } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

async function countRows(table: string): Promise<number> {
  const db = getTestDb();
  const result = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}`
  );
  const n = Number(
    (result as unknown as Array<{ n: number }>)[0]?.n ??
    (result as { rows?: Array<{ n: number }> }).rows?.[0]?.n
  );
  if (Number.isNaN(n)) {
    throw new Error(`countRows(${table}): unexpected drizzle result shape — cannot count rows`);
  }
  return n;
}

async function auditTruncateTriggerEnabled(): Promise<string | undefined> {
  const db = getTestDb();
  const trigger = await db.execute<{ tgenabled: string }>(sql`
    SELECT tgenabled FROM pg_trigger
    WHERE tgname = 'audit_log_block_truncate'
      AND tgrelid = 'audit_logs'::regclass
  `);
  return (
    (trigger as unknown as Array<{ tgenabled: string }>)[0]?.tgenabled ??
    (trigger as { rows?: Array<{ tgenabled: string }> }).rows?.[0]?.tgenabled
  );
}

describe('#2205 cleanupDatabase() genuinely resets tenant-root tables', () => {
  it('removes stray partners/organizations rows even when the cascade reaches audit_logs', async () => {
    const db = getTestDb();

    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    // An audit row referencing the org guarantees the TRUNCATE CASCADE set
    // includes audit_logs — exactly the shape that used to make the whole
    // statement fail against the block-truncate trigger.
    await db.insert(auditLogs).values({
      orgId: org.id,
      actorType: 'system',
      actorId: partner.id,
      action: 'test.cleanup-regression',
      resourceType: 'organization',
      resourceId: org.id,
      result: 'success',
    });

    expect(await countRows('partners')).toBeGreaterThan(0);
    expect(await countRows('organizations')).toBeGreaterThan(0);
    expect(await countRows('audit_logs')).toBeGreaterThan(0);

    await cleanupDatabase();

    // GLOBAL zero-row assertions — not scoped to the fixture IDs — so leakage
    // from any earlier suite in the run would also be caught here.
    expect(await countRows('partners')).toBe(0);
    expect(await countRows('organizations')).toBe(0);
    expect(await countRows('audit_logs')).toBe(0);

    // Drizzle-level sanity check through the same client the suites use.
    expect(await db.select({ id: partners.id }).from(partners)).toHaveLength(0);
    expect(await db.select({ id: organizations.id }).from(organizations)).toHaveLength(0);
  });

  it('re-enables the audit_logs append-only TRUNCATE guard after cleanup', async () => {
    const db = getTestDb();

    await cleanupDatabase();

    // The trigger must be back on (origin/local enabled = 'O') …
    expect(await auditTruncateTriggerEnabled()).toBe('O');

    // … and functionally enforced: a TRUNCATE must still be rejected by the
    // trigger. CASCADE is needed to get past the audit_log_chain FK check
    // (which otherwise rejects first with a different, weaker error); the
    // BEFORE TRUNCATE trigger raises before anything is actually truncated.
    let error: unknown;
    try {
      await db.execute(sql`TRUNCATE TABLE audit_logs CASCADE`);
    } catch (err) {
      error = err;
    }
    expect(error).toBeDefined();
    const message = [
      (error as Error | undefined)?.message,
      ((error as { cause?: Error } | undefined)?.cause)?.message,
    ]
      .filter(Boolean)
      .join(' | ');
    expect(message).toMatch(/append-only/);
  });

  it('fails loudly when the truncate is blocked, and still re-enables the audit trigger', async () => {
    const db = getTestDb();

    // Install a throwaway BEFORE TRUNCATE blocker on a mid-list table to make
    // the combined truncate fail for a non-42P01 reason. This pins the two
    // behaviors that would silently reintroduce #2205 if regressed:
    //   a) the error must PROPAGATE (no blanket catch swallowing it),
    //   b) the finally must still re-enable audit_log_block_truncate.
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION test_2205_block_truncate() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'test_2205: simulated truncate failure';
      END;
      $$
    `);
    await db.execute(sql`
      CREATE TRIGGER test_2205_block_truncate BEFORE TRUNCATE ON alerts
        FOR EACH STATEMENT EXECUTE FUNCTION test_2205_block_truncate()
    `);

    try {
      await expect(cleanupDatabase()).rejects.toThrow(/database was not reset/);
      // The finally must have re-enabled the append-only guard even though the
      // truncate failed mid-statement.
      expect(await auditTruncateTriggerEnabled()).toBe('O');
    } finally {
      // Drop the blocker in a finally — leaving it behind would poison the
      // global beforeEach of every subsequent test in the run.
      await db.execute(sql`DROP TRIGGER IF EXISTS test_2205_block_truncate ON alerts`);
      await db.execute(sql`DROP FUNCTION IF EXISTS test_2205_block_truncate()`);
    }

    // Recovery check: with the blocker gone, cleanup works again.
    await cleanupDatabase();
    expect(await countRows('partners')).toBe(0);
    expect(await auditTruncateTriggerEnabled()).toBe('O');
  });
});
