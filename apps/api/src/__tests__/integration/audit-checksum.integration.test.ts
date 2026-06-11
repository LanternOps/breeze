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
import { db, withSystemDbAccessContext, withDbAccessContext, runOutsideDbContext } from '../../db';
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

  // Linkage lives in the audit_log_chain side table since migration
  // 2026-06-11-h (issue #1002): the in-row prev_checksum is now always NULL
  // and each row's seal entry chains to the previous seal for its org.
  // The seal trigger is DEFERRED to COMMIT, so the chain rows are only
  // visible after the inserting transaction commits — hence the second
  // withSystemDbAccessContext for the assertions.
  it('each subsequent row chains to the previous within an org', async () => {
    let aId = '';
    let bId = '';
    await withSystemDbAccessContext(async () => {
      const a = (await db.execute(sql`
        INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result)
        VALUES (${orgId}, 'system', gen_random_uuid(), 'a', 'test', 'success')
        RETURNING id
      `)) as unknown as Array<{ id: string }>;
      aId = a[0]!.id;
      const b = (await db.execute(sql`
        INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result)
        VALUES (${orgId}, 'system', gen_random_uuid(), 'b', 'test', 'success')
        RETURNING id
      `)) as unknown as Array<{ id: string }>;
      bId = b[0]!.id;
    });

    await withSystemDbAccessContext(async () => {
      const seals = (await db.execute(sql`
        SELECT audit_id, prev_chain_checksum, chain_checksum
        FROM audit_log_chain
        WHERE org_id = ${orgId}::uuid
        ORDER BY chain_seq
      `)) as unknown as Array<{
        audit_id: string;
        prev_chain_checksum: string | null;
        chain_checksum: string;
      }>;
      expect(seals.map((s) => s.audit_id)).toEqual([aId, bId]);
      expect(seals[0]!.prev_chain_checksum).toBeNull();
      expect(seals[1]!.prev_chain_checksum).toEqual(seals[0]!.chain_checksum);
      expect(seals[1]!.chain_checksum).not.toEqual(seals[0]!.chain_checksum);
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
  // Same-transaction batches are now handled by the deferred commit-time seal
  // (migration 2026-06-11-h, issue #1002) — covered by the 'multiple same-org
  // inserts in ONE transaction' test below.

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

  // ——— issue #1002 regression suite ———

  // Fork regression: N independent transactions inserting same-org rows
  // concurrently. Pre-fix, each reads the same committed head as `prev` and
  // the chain forks → verify reports false breaks. Post-fix (-h- migration,
  // deferred commit-time sealing) the seal serializes at commit → 0 breaks.
  it('verify_chain returns no breaks under concurrent same-org inserts', async () => {
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
      const breaks = (await db.execute(sql`
        SELECT broken_id FROM public.audit_log_verify_chain(${orgId}::uuid)
      `)) as unknown as Array<{ broken_id: string }>;
      expect(breaks).toEqual([]);
    });
  });

  // Deadlock regression (the bug that killed draft PR #1240): an in-tx audit
  // insert followed — while that tx is still open — by a same-org insert on a
  // SEPARATE pooled connection. With any lock held from insert to commit, the
  // second insert blocks on the first while the first awaits the second: a
  // JS-level deadlock Postgres can't detect (30s test timeout). With deferred
  // sealing the first tx holds nothing until commit, so this completes fast.
  // Generous explicit timeout so a regression fails loudly as a timeout here,
  // not flakily elsewhere.
  it('in-tx insert + separate-connection same-org insert does not deadlock', { timeout: 20_000 }, async () => {
    await expect(
      withDbAccessContext(
        { scope: 'organization', orgId, accessibleOrgIds: [orgId] },
        async () => {
          await db.execute(sql`
            INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result)
            VALUES (${orgId}, 'system', gen_random_uuid(), 'deadlock-caller-tx', 'test', 'success')
          `);
          // Escape the caller tx exactly like logSessionAudit does.
          await runOutsideDbContext(() =>
            withSystemDbAccessContext(async () => {
              await db.execute(sql`
                INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result)
                VALUES (${orgId}, 'system', gen_random_uuid(), 'deadlock-escaped', 'test', 'success')
              `);
            })
          );
          throw new Error('simulated caller rollback');
        }
      )
    ).rejects.toThrow('simulated caller rollback');

    await withSystemDbAccessContext(async () => {
      // The escaped row committed and sealed; the rolled-back row left no
      // orphan seal; the chain stayed clean.
      const rows = (await db.execute(sql`
        SELECT action FROM audit_logs WHERE org_id = ${orgId}::uuid AND action LIKE 'deadlock-%'
      `)) as unknown as Array<{ action: string }>;
      expect(rows.map((r) => r.action)).toEqual(['deadlock-escaped']);

      const breaks = (await db.execute(sql`
        SELECT broken_id FROM public.audit_log_verify_chain(${orgId}::uuid)
      `)) as unknown as Array<{ broken_id: string }>;
      expect(breaks).toEqual([]);
    });
  });

  // Same-transaction multi-row batches were the OTHER documented limitation of
  // the in-row chain. Deferred seals fire per row at commit in insertion order
  // within one lock hold, so batches link correctly.
  it('multiple same-org inserts in ONE transaction seal in order with no breaks', async () => {
    await withSystemDbAccessContext(async () => {
      await db.execute(sql`
        INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result)
        VALUES (${orgId}, 'system', gen_random_uuid(), 'batch-1', 'test', 'success'),
               (${orgId}, 'system', gen_random_uuid(), 'batch-2', 'test', 'success'),
               (${orgId}, 'system', gen_random_uuid(), 'batch-3', 'test', 'success')
      `);
    });

    await withSystemDbAccessContext(async () => {
      const breaks = (await db.execute(sql`
        SELECT broken_id FROM public.audit_log_verify_chain(${orgId}::uuid)
      `)) as unknown as Array<{ broken_id: string }>;
      expect(breaks).toEqual([]);
    });
  });

  // Deleting a chain entry (hiding a row from the chain) is flagged by the
  // unsealed-row sweep.
  it('verify_chain flags an audit row whose chain entry was deleted', async () => {
    let targetId = '';
    await withSystemDbAccessContext(async () => {
      const rows = (await db.execute(sql`
        INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result)
        VALUES (${orgId}, 'system', gen_random_uuid(), 'chain-delete-victim', 'test', 'success')
        RETURNING id
      `)) as unknown as Array<{ id: string }>;
      targetId = rows[0]!.id;
    });

    // Superuser + trigger disable simulates a DBA-level attacker (same pattern
    // as the existing UPDATE-tamper test).
    const sudo = getTestDb();
    await sudo.execute(sql`ALTER TABLE audit_log_chain DISABLE TRIGGER audit_log_chain_block_delete`);
    try {
      await sudo.execute(sql`DELETE FROM audit_log_chain WHERE audit_id = ${targetId}`);
    } finally {
      await sudo.execute(sql`ALTER TABLE audit_log_chain ENABLE TRIGGER audit_log_chain_block_delete`);
    }

    const breaks = (await sudo.execute(sql`
      SELECT broken_id, expected FROM public.audit_log_verify_chain(${orgId}::uuid)
    `)) as unknown as Array<{ broken_id: string; expected: string | null }>;
    // The victim is flagged unsealed; its successor (if any) is flagged for
    // linkage. At minimum the victim appears.
    expect(breaks.map((b) => b.broken_id)).toContain(targetId);
    // Restore chain consistency for subsequent tests in this file: re-seal.
    await sudo.execute(sql`SELECT audit_log_seal_one(a) FROM audit_logs a WHERE a.id = ${targetId}`);
  });

  // breeze_app cannot mutate the chain at all (append-only + REVOKE).
  // Implementation note: we run the mutation attempts OUTSIDE withSystemDbAccessContext
  // so they hit the breeze_app pool directly (no transaction wrapper). Inside a
  // withSystemDbAccessContext transaction, a PostgresError aborts the whole transaction
  // and the outer begin() also rejects, making it impossible to catch just the inner
  // error cleanly. Running outside the context keeps each rejection self-contained.
  // The underlying PostgresError message is "permission denied for table audit_log_chain";
  // Drizzle wraps it in DrizzleQueryError (message: "Failed query: …") with the original
  // in .cause — we walk the cause chain to match "permission denied" precisely.
  it('chain table rejects UPDATE/DELETE from app-level SQL', async () => {
    const expectPermissionDenied = async (promise: Promise<unknown>) => {
      const err = await promise.then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).not.toBeNull();
      // Walk the cause chain: Drizzle wraps the original PostgresError in a
      // DrizzleQueryError whose .cause holds the real "permission denied" message.
      const messages: string[] = [];
      let cur: unknown = err;
      while (cur instanceof Error) {
        messages.push(cur.message);
        cur = (cur as Error & { cause?: unknown }).cause;
      }
      const matched = messages.some((m) => /append-only|permission denied/i.test(m));
      if (!matched) {
        throw new Error(
          `Expected "permission denied" or "append-only" in error chain, got:\n` +
          messages.join('\n  caused by: '),
        );
      }
    };

    // runOutsideDbContext so db resolves to the bare breeze_app pool (no
    // transaction wrapper). This keeps each rejection self-contained.
    await runOutsideDbContext(() =>
      expectPermissionDenied(
        db.execute(sql`UPDATE audit_log_chain SET chain_checksum = 'forged' WHERE org_id = ${orgId}::uuid`),
      )
    );
    await runOutsideDbContext(() =>
      expectPermissionDenied(
        db.execute(sql`DELETE FROM audit_log_chain WHERE org_id = ${orgId}::uuid`),
      )
    );
  });

  // Retention prefix-cut: prune old rows, then the chain must still verify
  // clean WITHOUT any re-anchor — the first surviving entry's prev is the
  // trusted anchor. (Chain order is deterministic here because beforeEach
  // creates a FRESH org per test, so these three rows are the org's only
  // chain entries: olds get the lowest chain_seq, the new row the highest.)
  it('retention prefix-cut prune leaves a clean chain with no re-anchor', async () => {
    // Three rows: two backdated past any cutoff, one current. Timestamps can
    // be set explicitly — the BEFORE trigger no longer rewrites them.
    for (const [action, ts] of [
      ['retain-old-1', "now() - interval '400 days'"],
      ['retain-old-2', "now() - interval '399 days'"],
      ['retain-new', 'now()'],
    ] as const) {
      await withSystemDbAccessContext(async () => {
        await db.execute(sql.raw(`
          INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result, timestamp)
          VALUES ('${orgId}', 'system', gen_random_uuid(), '${action}', 'test', 'success', ${ts})
        `));
      });
    }

    // Prune at 365 days as superuser with the retention GUC (mirrors the
    // audit-admin path; this test pins the SQL semantics, the privsep file
    // pins the role/pool wiring). MUST run inside ONE transaction — SET LOCAL
    // and the DELETE have to share a connection, and separate execute() calls
    // on the pooled client may not (use the drizzle transaction API, never
    // raw BEGIN/COMMIT executes).
    const sudo = getTestDb();
    await sudo.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL breeze.allow_audit_retention = '1'`);
      await tx.execute(sql`
        DELETE FROM audit_logs
        WHERE id IN (
          SELECT c.audit_id FROM audit_log_chain c
          WHERE c.org_id = ${orgId}
            AND c.chain_seq < COALESCE(
              (SELECT MIN(c2.chain_seq) FROM audit_log_chain c2
               JOIN audit_logs a2 ON a2.id = c2.audit_id
               WHERE c2.org_id = ${orgId} AND a2.timestamp >= (now() - interval '365 days')),
              (SELECT MAX(c3.chain_seq) + 1 FROM audit_log_chain c3 WHERE c3.org_id = ${orgId})
            )
        )
      `);
    });

    await withSystemDbAccessContext(async () => {
      const old = (await db.execute(sql`
        SELECT 1 FROM audit_logs WHERE org_id = ${orgId}::uuid AND action LIKE 'retain-old-%'
      `)) as unknown as unknown[];
      expect(old).toHaveLength(0);

      // No re-anchor ran: the surviving head still carries a non-NULL prev
      // pointing at pruned history — and verify must accept it as the anchor.
      const breaks = (await db.execute(sql`
        SELECT broken_id FROM public.audit_log_verify_chain(${orgId}::uuid)
      `)) as unknown as Array<{ broken_id: string }>;
      expect(breaks).toEqual([]);
    });
  });
});
