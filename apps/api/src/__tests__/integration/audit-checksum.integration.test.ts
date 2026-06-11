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
      const row = (rows as unknown as Array<{ id: string; checksum: string }>)[0]!;
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
      expect(b[0]!.prev_checksum).toEqual(a[0]!.checksum);
      expect(b[0]!.checksum).not.toEqual(a[0]!.checksum);
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
      const row = inserted[0]!;

      // Re-compute the canonical string via the SQL helper from the migration —
      // this is the authoritative formatter; the trigger and verifier both call
      // it, so the test cannot drift away from production.
      const canonicalRows = (await db.execute(sql`
        SELECT public.audit_log_canonical_payload(
          (SELECT audit_logs FROM audit_logs WHERE id = ${row.id}),
          ${row.prev_checksum}::varchar
        ) AS payload
      `)) as unknown as Array<{ payload: string }>;

      const expected = createHash('sha256').update(canonicalRows[0]!.payload, 'utf8').digest('hex');
      expect(row.checksum).toEqual(expected);
    });
  });

  // NOTE — the two tests below intentionally insert each audit row in its own
  // `withSystemDbAccessContext` call. Reason: `withSystemDbAccessContext`
  // opens a single Postgres transaction, so multiple inserts inside one
  // wrapper share `transaction_timestamp()`. The BEFORE INSERT chain trigger
  // picks the predecessor row via `ORDER BY timestamp DESC, id DESC LIMIT 1`,
  // while `audit_log_verify_chain` walks `ORDER BY timestamp, id ASC` — they
  // disagree when rows in the same transaction have ids that don't sort in
  // insert order, producing false-positive "breaks" with no actual tampering.
  // Real production audit traffic flows row-per-API-call (separate
  // transactions, distinct timestamps), so this matches the production case.
  // Fixing the chain to handle same-tx batches robustly requires a chain_seq
  // bigserial + per-org advisory lock — tracked as future-task hardening.

  it('audit_log_verify_chain returns no breaks on a freshly written chain', async () => {
    for (const action of ['a', 'b', 'c']) {
      await withSystemDbAccessContext(async () => {
        await db.execute(sql`
          INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result)
          VALUES (${orgId}, 'system', gen_random_uuid(), ${action}, 'test', 'success')
        `);
      });
    }
    await withSystemDbAccessContext(async () => {
      const breaks = (await db.execute(sql`
        SELECT * FROM public.audit_log_verify_chain(${orgId}::uuid)
      `)) as unknown as Array<{ broken_id: string }>;
      expect(breaks).toEqual([]);
    });
  });

  // Regression for the `text::bytea` cast bug (EU upgrade blocked by
  // `invalid input syntax for type bytea`). The canonical payload includes
  // `details::text`, and jsonb renders control chars / quotes / backslashes
  // in string values as backslash escapes (\n, \", \\, \uXXXX). The original
  // trigger/verifier/backfill hashed via `payload::bytea`, which runs the
  // string through bytea's *input parser* — it interprets those escapes and
  // throws on any that aren't a valid bytea escape. Real audit history
  // (Windows paths, multi-line messages, user-agents with quotes) trips it,
  // so the insert itself fails. The fix hashes via convert_to(payload,'UTF8'),
  // which faithfully encodes the bytes. These payloads are backslash-free in
  // every other test, which is why the bug hid until real data hit it.
  it('hashes audit rows whose details contain backslash escapes', async () => {
    const details = {
      path: 'C:\\Users\\admin\\AppData',
      msg: 'line1\nline2\ttabbed',
      quote: 'he said "hi"',
      unicode: 'café',
    };
    await withSystemDbAccessContext(async () => {
      // Without the fix this INSERT throws `invalid input syntax for type bytea`.
      const inserted = (await db.execute(sql`
        INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result, details)
        VALUES (${orgId}, 'system', gen_random_uuid(), 'escape.test', 'test', 'success', ${JSON.stringify(details)}::jsonb)
        RETURNING id, prev_checksum, checksum
      `)) as unknown as Array<{ id: string; prev_checksum: string | null; checksum: string }>;
      const row = inserted[0]!;
      expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);

      // The checksum must be sha256 over the UTF-8 bytes of the canonical
      // payload (what convert_to produces), matching the Node-side hash.
      const canonicalRows = (await db.execute(sql`
        SELECT public.audit_log_canonical_payload(
          (SELECT audit_logs FROM audit_logs WHERE id = ${row.id}),
          ${row.prev_checksum}::varchar
        ) AS payload
      `)) as unknown as Array<{ payload: string }>;
      const expected = createHash('sha256').update(canonicalRows[0]!.payload, 'utf8').digest('hex');
      expect(row.checksum).toEqual(expected);
    });

    // The verifier walks the same convert_to path — it must not throw and must
    // report the chain intact for the backslash-laden row.
    await withSystemDbAccessContext(async () => {
      const breaks = (await db.execute(sql`
        SELECT * FROM public.audit_log_verify_chain(${orgId}::uuid)
      `)) as unknown as Array<{ broken_id: string }>;
      expect(breaks).toEqual([]);
    });
  });

  // Regression for issue #1002: the BEFORE INSERT trigger forks the chain
  // under concurrent same-org inserts. Each transaction reads the SAME latest
  // committed checksum as its `prev` (it can't see the other in-flight
  // transactions' uncommitted rows), so N concurrent inserts all link back to
  // the same predecessor → the per-org chain forks → audit_log_verify_chain
  // reports false-positive breaks even though nothing was tampered.
  //
  // The fix (-a- advisory-lock migration) takes a per-org
  // pg_advisory_xact_lock BEFORE the predecessor SELECT, serializing the
  // read-checksum/assign-prev critical section across concurrent same-org
  // inserts so each picks up the prior committed row in turn.
  //
  // Each insert runs in its own `withSystemDbAccessContext` call (separate
  // pooled connection + transaction), and Promise.all fires them
  // concurrently — this is the production shape (row-per-API-call) that
  // surfaced the fork on the US droplet.
  it('audit_log_verify_chain returns no breaks under concurrent same-org inserts', async () => {
    const N = 25;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        withSystemDbAccessContext(async () => {
          await db.execute(sql`
            INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result)
            VALUES (${orgId}, 'system', gen_random_uuid(), ${'concurrent-' + i}, 'test', 'success')
          `);
        })
      )
    );

    await withSystemDbAccessContext(async () => {
      const count = (await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM audit_logs WHERE org_id = ${orgId}::uuid
      `)) as unknown as Array<{ n: number }>;
      expect(count[0]!.n).toEqual(N);

      const breaks = (await db.execute(sql`
        SELECT broken_id FROM public.audit_log_verify_chain(${orgId}::uuid)
      `)) as unknown as Array<{ broken_id: string }>;
      expect(breaks).toEqual([]);
    });
  });

  it('audit_log_verify_chain detects tampering via direct SQL UPDATE', async () => {
    // Seed three rows each in their own transaction so the chain is
    // unambiguously ordered (see same-tx note above). Each insert returns the
    // new row's id so we can pick the middle row to tamper with.
    const inserted: Array<{ id: string }> = [];
    for (const action of ['a', 'b', 'c']) {
      await withSystemDbAccessContext(async () => {
        const rows = (await db.execute(sql`
          INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result)
          VALUES (${orgId}, 'system', gen_random_uuid(), ${action}, 'test', 'success')
          RETURNING id
        `)) as unknown as Array<{ id: string }>;
        inserted.push(rows[0]!);
      });
    }

    // Direct UPDATE — only possible because the test runs as a superuser.
    // The point is to simulate a DBA-level attacker bypassing Task 1's defenses.
    // Disable the block_update trigger just for this op, like the backfill does.
    // The append-only triggers REVOKE UPDATE from breeze_app, so we must use the
    // superuser test client (getTestDb) — withSystemDbAccessContext uses breeze_app.
    const sudo = getTestDb();
    await sudo.execute(sql`ALTER TABLE audit_logs DISABLE TRIGGER audit_log_block_update`);
    try {
      await sudo.execute(sql`UPDATE audit_logs SET action = 'tampered' WHERE id = ${inserted[1]!.id}`);
    } finally {
      await sudo.execute(sql`ALTER TABLE audit_logs ENABLE TRIGGER audit_log_block_update`);
    }

    const breaks = (await sudo.execute(sql`
      SELECT broken_id FROM public.audit_log_verify_chain(${orgId}::uuid)
    `)) as unknown as Array<{ broken_id: string }>;
    expect(breaks.length).toBeGreaterThanOrEqual(1);
    expect(breaks.map(b => b.broken_id)).toContain(inserted[1]!.id);
  });
});
