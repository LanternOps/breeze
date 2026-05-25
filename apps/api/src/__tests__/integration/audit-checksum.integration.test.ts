/**
 * Integration test for the audit_logs hash chain.
 *
 * Threat model: `audit_logs.checksum` was declared in the schema since the
 * baseline but never populated, so even though Task 1 made the table
 * append-only at the DB layer, deletion of rows (by a future role with
 * DELETE, by an admin bypassing RLS, or by direct postgres access) would
 * leave NO detectable gap. The chain closes that hole: every row's
 * checksum binds it to the previous row in its per-org chain via SHA-256,
 * so removing any row breaks the chain at the next insert's verifier.
 *
 * The chain key is `org_id` (NULL for system-scoped events). Per-tenant
 * chains keep org-scoped retention pruning from corrupting other orgs'
 * chains and let an auditor verify a single tenant in isolation.
 *
 * These tests run against real Postgres via the `breeze_app` pool wired
 * through `withSystemDbAccessContext`, so the BEFORE INSERT trigger
 * actually fires end-to-end. Each test seeds its own partner+org so the
 * audit_logs.org_id → organizations.id FK is satisfied.
 */
import './setup';
import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { getTestDb } from './setup';
import { createPartner, createOrganization } from './db-utils';

describe('audit_logs checksum chain', () => {
  let orgId: string;

  // Seed in beforeEach because setup.ts's global beforeEach TRUNCATEs all
  // tenant tables (including organizations and audit_logs) before each test,
  // so we need a fresh organization row per test to satisfy the FK.
  beforeEach(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    orgId = org.id;
  });

  it('populates checksum on insert', async () => {
    await withSystemDbAccessContext(async () => {
      const rows = await db.execute(sql`
        INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result)
        VALUES (${orgId}, 'system', gen_random_uuid(), 'chain.test', 'test', 'success')
        RETURNING id, checksum
      `);
      const row = (rows as unknown as Array<{ id: string; checksum: string }>)[0];
      expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it('each subsequent row chains to the previous within an org', async () => {
    await withSystemDbAccessContext(async () => {
      const a = (await db.execute(sql`
        INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result)
        VALUES (${orgId}, 'system', gen_random_uuid(), 'a', 'test', 'success')
        RETURNING checksum
      `)) as unknown as Array<{ checksum: string }>;
      const b = (await db.execute(sql`
        INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result)
        VALUES (${orgId}, 'system', gen_random_uuid(), 'b', 'test', 'success')
        RETURNING checksum, prev_checksum
      `)) as unknown as Array<{ checksum: string; prev_checksum: string }>;
      expect(b[0].prev_checksum).toEqual(a[0].checksum);
      expect(b[0].checksum).not.toEqual(a[0].checksum);
    });
  });

  // The two tests above prove linkage but would still pass with a buggy
  // trigger that ignored row content. The three below assert that the
  // checksum is actually sha256(prev || canonical_payload), and that the
  // verifier function catches DBA-level tampering. They depend on the
  // -c- migration shipping audit_log_canonical_payload() and
  // audit_log_verify_chain().
  it('checksum equals sha256 of the canonical payload (tamper detection)', async () => {
    await withSystemDbAccessContext(async () => {
      const inserted = (await db.execute(sql`
        INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result)
        VALUES (${orgId}, 'system', gen_random_uuid(), 'verify.test', 'test', 'success')
        RETURNING id, prev_checksum, checksum
      `)) as unknown as Array<{ id: string; prev_checksum: string | null; checksum: string }>;
      const row = inserted[0];

      // Re-compute the canonical string via the SQL helper from the migration —
      // this is the authoritative formatter; the trigger and verifier both call
      // it, so the test cannot drift away from production.
      const canonicalRows = (await db.execute(sql`
        SELECT public.audit_log_canonical_payload(
          (SELECT audit_logs FROM audit_logs WHERE id = ${row.id}),
          ${row.prev_checksum}::varchar
        ) AS payload
      `)) as unknown as Array<{ payload: string }>;

      const expected = createHash('sha256').update(canonicalRows[0].payload, 'utf8').digest('hex');
      expect(row.checksum).toEqual(expected);
    });
  });

  it('audit_log_verify_chain returns no breaks on a freshly written chain', async () => {
    await withSystemDbAccessContext(async () => {
      for (const action of ['a', 'b', 'c']) {
        await db.execute(sql`
          INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result)
          VALUES (${orgId}, 'system', gen_random_uuid(), ${action}, 'test', 'success')
        `);
      }
      const breaks = (await db.execute(sql`
        SELECT * FROM public.audit_log_verify_chain(${orgId}::uuid)
      `)) as unknown as Array<{ broken_id: string }>;
      expect(breaks).toEqual([]);
    });
  });

  it('audit_log_verify_chain detects tampering via direct SQL UPDATE', async () => {
    // Seed three rows under the application context so the chain trigger fires.
    const inserted = await withSystemDbAccessContext(async () => {
      return (await db.execute(sql`
        INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result)
        VALUES
          (${orgId}, 'system', gen_random_uuid(), 'a', 'test', 'success'),
          (${orgId}, 'system', gen_random_uuid(), 'b', 'test', 'success'),
          (${orgId}, 'system', gen_random_uuid(), 'c', 'test', 'success')
        RETURNING id
      `)) as unknown as Array<{ id: string }>;
    });

    // Direct UPDATE — only possible because the test runs as a superuser.
    // The point is to simulate a DBA-level attacker bypassing Task 1's defenses.
    // Disable the block_update trigger just for this op, like the backfill does.
    // The append-only triggers REVOKE UPDATE from breeze_app, so we must use the
    // superuser test client (getTestDb) — withSystemDbAccessContext uses breeze_app.
    const sudo = getTestDb();
    await sudo.execute(sql`ALTER TABLE audit_logs DISABLE TRIGGER audit_log_block_update`);
    try {
      await sudo.execute(sql`UPDATE audit_logs SET action = 'tampered' WHERE id = ${inserted[1].id}`);
    } finally {
      await sudo.execute(sql`ALTER TABLE audit_logs ENABLE TRIGGER audit_log_block_update`);
    }

    const breaks = (await sudo.execute(sql`
      SELECT broken_id FROM public.audit_log_verify_chain(${orgId}::uuid)
    `)) as unknown as Array<{ broken_id: string }>;
    expect(breaks.length).toBeGreaterThanOrEqual(1);
    expect(breaks.map(b => b.broken_id)).toContain(inserted[1].id);
  });
});
