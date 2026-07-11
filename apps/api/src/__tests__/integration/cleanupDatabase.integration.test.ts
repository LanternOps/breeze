/**
 * Regression coverage for #2205 — cleanupDatabase() used to be a silent no-op
 * for the tenant-root tables.
 *
 * The bug: `TRUNCATE partners/organizations/users ... CASCADE` transitively
 * reaches `audit_logs`, whose `audit_log_block_truncate` BEFORE TRUNCATE
 * trigger (migration 2026-05-25-k) unconditionally rejects ANY truncate
 * touching the table — the append-only bypass GUC
 * (`breeze.allow_audit_retention`) only exists for DELETE. The whole TRUNCATE
 * statement failed, cleanupDatabase()'s blanket try/catch swallowed the error,
 * and tenant rows accumulated across every suite in an integration run. It
 * surfaced in the #2202 loginContext suite — the first to assert on GLOBAL
 * partner state.
 *
 * The fix (setup.ts): disable the audit trigger around the truncate loop
 * (re-enabled in a finally), and only swallow undefined-table (42P01) errors —
 * anything else now fails loudly.
 *
 * These tests prove:
 *   1. Stray partner/organization/audit_logs rows are genuinely removed —
 *      including when an audit row forces the cascade to reach audit_logs.
 *   2. The append-only TRUNCATE guard on audit_logs is re-enabled after
 *      cleanup — prod semantics are untouched.
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
  return Number((result as unknown as Array<{ n: number }>)[0]?.n ?? (result as { rows?: Array<{ n: number }> }).rows?.[0]?.n);
}

describe('#2205 cleanupDatabase() genuinely resets tenant-root tables', () => {
  it('removes stray partners/organizations rows even when the cascade reaches audit_logs', async () => {
    const db = getTestDb();

    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    // An audit row referencing the org guarantees the organizations TRUNCATE
    // CASCADE set includes audit_logs — exactly the shape that used to make
    // the whole statement fail against the block-truncate trigger.
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
    const trigger = await db.execute<{ tgenabled: string }>(sql`
      SELECT tgenabled FROM pg_trigger
      WHERE tgname = 'audit_log_block_truncate'
        AND tgrelid = 'audit_logs'::regclass
    `);
    const tgenabled =
      (trigger as unknown as Array<{ tgenabled: string }>)[0]?.tgenabled ??
      (trigger as { rows?: Array<{ tgenabled: string }> }).rows?.[0]?.tgenabled;
    expect(tgenabled).toBe('O');

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
});
