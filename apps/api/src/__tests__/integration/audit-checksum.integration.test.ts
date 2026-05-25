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
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
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
});
