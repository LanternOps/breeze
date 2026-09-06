/**
 * Integration test for the BOUNDED audit-chain verifier
 * (migration 2026-10-03-audit-chain-verify-range.sql).
 *
 * audit_log_verify_chain(org) walks the org's whole chain every night, which
 * is O(total rows) and was measured at ~13h/day of random reads on the US
 * production primary. The bounded plan verifies (a) everything after the org's
 * latest anchor and (b) one rolling slice of the historical chain, and must
 * detect the same tamper classes within the slice window.
 *
 * Runs against real Postgres through the `breeze_app` pool
 * (withSystemDbAccessContext) so RLS and the append-only triggers apply.
 * getTestDb() is the privileged harness pool used to FORGE tampers the app
 * role can never perform.
 */
import './setup';
import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { getTestDb } from './setup';
import { createPartner, createOrganization } from './db-utils';

interface BreakRow {
  broken_id: string;
  expected: string | null;
  actual: string | null;
}
interface ChainRow {
  chain_seq: number;
  audit_id: string;
}

async function seedAuditRows(orgId: string, n: number, prefix = 'verify.seed.'): Promise<void> {
  await withSystemDbAccessContext(async () => {
    for (let i = 0; i < n; i++) {
      await db.execute(sql`
        INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result)
        VALUES (${orgId}, 'system', gen_random_uuid(), ${prefix + i}, 'test', 'success')
      `);
    }
  });
}

async function chainRows(orgId: string): Promise<ChainRow[]> {
  const rows = (await getTestDb().execute(sql`
    SELECT chain_seq, audit_id FROM audit_log_chain
    WHERE org_id = ${orgId}::uuid ORDER BY chain_seq
  `)) as unknown as ChainRow[];
  return rows.map((r) => ({ ...r, chain_seq: Number(r.chain_seq) }));
}

async function writeAnchor(orgId: string): Promise<void> {
  await withSystemDbAccessContext(async () => {
    await db.execute(sql`SELECT anchor_seq FROM audit_chain_anchor_head(${orgId}::uuid)`);
  });
}

/** What the nightly job runs (system context, breeze_app role). */
async function verifyIncremental(
  orgId: string,
  slices: number,
  sliceIndex: number,
  blockRows = 1, // one chain_seq per block so tests can reason per row
): Promise<BreakRow[]> {
  return withSystemDbAccessContext(async () => {
    const rows = (await db.execute(sql`
      SELECT broken_id, expected, actual
      FROM audit_log_verify_chain_incremental(
        ${orgId}::uuid, ${slices}::int, ${sliceIndex}::int, ${blockRows}::bigint)
    `)) as unknown as BreakRow[];
    return rows;
  });
}

async function verifyRange(orgId: string, from: number, to: number): Promise<BreakRow[]> {
  return withSystemDbAccessContext(async () => {
    const rows = (await db.execute(sql`
      SELECT broken_id, expected, actual
      FROM audit_log_verify_chain_range(${orgId}::uuid, ${from}::bigint, ${to}::bigint)
    `)) as unknown as BreakRow[];
    return rows;
  });
}

async function verifyFull(orgId: string): Promise<BreakRow[]> {
  return withSystemDbAccessContext(async () => {
    const rows = (await db.execute(sql`
      SELECT broken_id, expected, actual FROM audit_log_verify_chain(${orgId}::uuid)
    `)) as unknown as BreakRow[];
    return rows;
  });
}

/** Superuser forge: edit an audit row's content without touching the chain. */
async function tamperAuditContent(auditId: string): Promise<void> {
  const sudo = getTestDb();
  await sudo.execute(sql`ALTER TABLE audit_logs DISABLE TRIGGER audit_log_block_update`);
  try {
    await sudo.execute(sql`UPDATE audit_logs SET action = 'tampered' WHERE id = ${auditId}::uuid`);
  } finally {
    await sudo.execute(sql`ALTER TABLE audit_logs ENABLE TRIGGER audit_log_block_update`);
  }
}

/** Superuser forge: rewrite a chain row's checksum (breaks its successor's link). */
async function tamperChainChecksum(chainSeq: number): Promise<void> {
  const sudo = getTestDb();
  await sudo.execute(sql`ALTER TABLE audit_log_chain DISABLE TRIGGER audit_log_chain_block_update`);
  try {
    await sudo.execute(sql`
      UPDATE audit_log_chain SET chain_checksum = repeat('0', 64) WHERE chain_seq = ${chainSeq}::bigint
    `);
  } finally {
    await sudo.execute(sql`ALTER TABLE audit_log_chain ENABLE TRIGGER audit_log_chain_block_update`);
  }
}

/** Superuser forge: drop the chain row for one audit row (leaves it unsealed). */
async function unsealAuditRow(chainSeq: number): Promise<void> {
  const sudo = getTestDb();
  await sudo.execute(sql`ALTER TABLE audit_log_chain DISABLE TRIGGER audit_log_chain_block_delete`);
  try {
    await sudo.execute(sql`DELETE FROM audit_log_chain WHERE chain_seq = ${chainSeq}::bigint`);
  } finally {
    await sudo.execute(sql`ALTER TABLE audit_log_chain ENABLE TRIGGER audit_log_chain_block_delete`);
  }
}

describe('audit_log_verify_chain_incremental / _range', () => {
  let orgId: string;

  beforeEach(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    orgId = org.id;
  });

  it('reports clean for an intact chain in every mode', async () => {
    await seedAuditRows(orgId, 4);
    await writeAnchor(orgId);
    await seedAuditRows(orgId, 3, 'verify.after.');
    const rows = await chainRows(orgId);
    expect(rows).toHaveLength(7);

    expect(await verifyFull(orgId)).toEqual([]);
    expect(await verifyRange(orgId, rows[0]!.chain_seq, rows[6]!.chain_seq)).toEqual([]);
    for (let slice = 0; slice < 3; slice++) {
      expect(await verifyIncremental(orgId, 3, slice)).toEqual([]);
    }
  });

  it('falls back to the full walk for an org that has no anchor yet', async () => {
    await seedAuditRows(orgId, 3);
    const rows = await chainRows(orgId);
    await tamperAuditContent(rows[0]!.audit_id);

    const breaks = await verifyIncremental(orgId, 30, 5);
    expect(breaks.map((b) => b.broken_id)).toEqual([rows[0]!.audit_id]);
  });

  it('catches a content edit above the anchor the same night, in every slice', async () => {
    await seedAuditRows(orgId, 4);
    await writeAnchor(orgId);
    await seedAuditRows(orgId, 3, 'verify.after.');
    const rows = await chainRows(orgId);
    const victim = rows[5]!; // sealed after the anchor
    await tamperAuditContent(victim.audit_id);

    for (let slice = 0; slice < 30; slice += 7) {
      const breaks = await verifyIncremental(orgId, 30, slice);
      expect(breaks.map((b) => b.broken_id)).toEqual([victim.audit_id]);
    }
  });

  it('re-proves the anchored head row itself every night', async () => {
    await seedAuditRows(orgId, 3);
    await writeAnchor(orgId);
    const rows = await chainRows(orgId);
    const head = rows[2]!;
    await tamperAuditContent(head.audit_id);

    const breaks = await verifyIncremental(orgId, 30, 0);
    expect(breaks.map((b) => b.broken_id)).toEqual([head.audit_id]);
  });

  it('catches a content edit below the anchor within one pass over the slices', async () => {
    await seedAuditRows(orgId, 10);
    await writeAnchor(orgId);
    await seedAuditRows(orgId, 2, 'verify.after.');
    const rows = await chainRows(orgId);
    const victim = rows[6]!; // historical, below the anchor (rows 0..9)
    await tamperAuditContent(victim.audit_id);

    const slices = 4;
    const hits: number[] = [];
    for (let slice = 0; slice < slices; slice++) {
      const breaks = await verifyIncremental(orgId, slices, slice);
      if (breaks.some((b) => b.broken_id === victim.audit_id)) hits.push(slice);
      // No slice may report anything else.
      expect(breaks.filter((b) => b.broken_id !== victim.audit_id)).toEqual([]);
    }
    expect(hits).toHaveLength(1);
    // The pass with a single slice is a full historical re-scan.
    expect((await verifyIncremental(orgId, 1, 0)).map((b) => b.broken_id)).toEqual([victim.audit_id]);
  });

  it('slice boundaries cover every historical row exactly once', async () => {
    await seedAuditRows(orgId, 11); // prime count → uneven slices
    await writeAnchor(orgId);
    const rows = await chainRows(orgId);
    const historical = rows.slice(0, 10); // everything strictly below the anchored head

    for (const victim of historical) {
      await tamperAuditContent(victim.audit_id);
    }
    const seen = new Map<string, number>();
    for (let slice = 0; slice < 3; slice++) {
      for (const b of await verifyIncremental(orgId, 3, slice)) {
        seen.set(b.broken_id, (seen.get(b.broken_id) ?? 0) + 1);
      }
    }
    expect([...seen.keys()].sort()).toEqual(historical.map((r) => r.audit_id).sort());
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
  });

  it('range seeds the linkage check from the row before the range', async () => {
    await seedAuditRows(orgId, 4);
    const rows = await chainRows(orgId);
    await tamperChainChecksum(rows[1]!.chain_seq);

    // Verifying only row 2: its prev must equal row 1's (now forged) checksum.
    const breaks = await verifyRange(orgId, rows[2]!.chain_seq, rows[2]!.chain_seq);
    expect(breaks.map((b) => b.broken_id)).toEqual([rows[2]!.audit_id]);
    expect(breaks[0]!.expected).toBe('0'.repeat(64));

    // A range that starts at the org's first row treats its prev as trusted.
    expect(await verifyRange(orgId, rows[0]!.chain_seq, rows[0]!.chain_seq)).toEqual([]);
  });

  it('flags an unsealed audit row after the anchor', async () => {
    await seedAuditRows(orgId, 2);
    await writeAnchor(orgId);
    await seedAuditRows(orgId, 2, 'verify.after.');
    const rows = await chainRows(orgId);
    const victim = rows[3]!; // newest
    await unsealAuditRow(victim.chain_seq);

    const breaks = await verifyIncremental(orgId, 30, 0);
    expect(breaks).toEqual([{ broken_id: victim.audit_id, expected: 'sealed', actual: null }]);
  });

  it('flags a backdated unsealed historical row on the slice-0 sweep only', async () => {
    // A row whose event timestamp is far older than its seal: the recent
    // window (b) cannot see it, the exhaustive sweep (d) must.
    await withSystemDbAccessContext(async () => {
      await db.execute(sql`
        INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result, timestamp)
        VALUES (${orgId}, 'system', gen_random_uuid(), 'verify.backdated', 'test', 'success', now() - interval '10 days')
      `);
    });
    await seedAuditRows(orgId, 3);
    await writeAnchor(orgId);
    await seedAuditRows(orgId, 1, 'verify.after.');
    const rows = await chainRows(orgId);
    const victim = rows[0]!;
    await unsealAuditRow(victim.chain_seq);

    const sweep = await verifyIncremental(orgId, 3, 0, 1000);
    expect(sweep).toEqual([{ broken_id: victim.audit_id, expected: 'sealed', actual: null }]);
    expect(await verifyIncremental(orgId, 3, 1, 1000)).toEqual([]);
    expect(await verifyIncremental(orgId, 3, 2, 1000)).toEqual([]);
  });

  it('returns nothing for an inverted or empty range', async () => {
    await seedAuditRows(orgId, 2);
    const rows = await chainRows(orgId);
    expect(await verifyRange(orgId, rows[1]!.chain_seq, rows[0]!.chain_seq)).toEqual([]);
    expect(await verifyRange(orgId, rows[1]!.chain_seq + 1000, rows[1]!.chain_seq + 2000)).toEqual([]);
  });
});
