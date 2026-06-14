/**
 * Integration test for the audit-chain EXTERNAL ANCHOR (issue #916).
 *
 * Threat model: audit_logs and audit_log_chain both live in the database the
 * app role can write to. A privileged compromise that DELETEs both tables and
 * re-seals a fresh chain leaves audit_log_verify_chain() returning CLEAN —
 * there is no record outside the chain of what the head used to be. The anchor
 * closes that: audit_chain_anchor_head() snapshots the head (seq + checksum +
 * count) into the append-only audit_chain_anchors table, and
 * audit_chain_verify_anchor() flags a live head that moved BACKWARDS / lost its
 * sealed head / had a historical checksum rewritten.
 *
 * These tests run against real Postgres through the `breeze_app` pool
 * (withSystemDbAccessContext) so the append-only triggers and grants fire
 * end-to-end. getTestDb() is the privileged harness pool used to FORGE a
 * tamper the app role could never perform — proving the anchor detects it.
 */
import './setup';
import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { getTestDb } from './setup';
import { createPartner, createOrganization } from './db-utils';

interface HeadRow {
  head_chain_seq: number;
  head_chain_checksum: string | null;
  entry_count: number;
}
interface AnchorRow {
  anchor_seq: number;
  head_chain_seq: number;
  entry_count: number;
  signed: boolean;
}
interface DivergenceRow {
  reason: string;
  anchored_head_seq: number;
  live_head_seq: number;
}

async function seedAuditRows(orgId: string, n: number): Promise<void> {
  await withSystemDbAccessContext(async () => {
    for (let i = 0; i < n; i++) {
      await db.execute(sql`
        INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result)
        VALUES (${orgId}, 'system', gen_random_uuid(), ${'anchor.seed.' + i}, 'test', 'success')
      `);
    }
  });
}

async function readHead(orgId: string): Promise<HeadRow> {
  const rows = (await getTestDb().execute(sql`
    SELECT head_chain_seq, head_chain_checksum, entry_count
    FROM audit_chain_read_head(${orgId}::uuid)
  `)) as unknown as HeadRow[];
  // head_chain_seq / entry_count are pg bigints → returned as strings; coerce
  // so numeric assertions (toBe / toBeGreaterThan) hold.
  const r = rows[0]!;
  return { ...r, head_chain_seq: Number(r.head_chain_seq), entry_count: Number(r.entry_count) };
}

async function writeAnchor(orgId: string): Promise<AnchorRow> {
  return withSystemDbAccessContext(async () => {
    const rows = (await db.execute(sql`
      SELECT anchor_seq, head_chain_seq, entry_count, signed
      FROM audit_chain_anchor_head(${orgId}::uuid)
    `)) as unknown as AnchorRow[];
    const r = rows[0]!;
    return { ...r, anchor_seq: Number(r.anchor_seq), head_chain_seq: Number(r.head_chain_seq), entry_count: Number(r.entry_count) };
  });
}

async function verifyAnchor(orgId: string): Promise<DivergenceRow[]> {
  const rows = (await getTestDb().execute(sql`
    SELECT reason, anchored_head_seq, live_head_seq
    FROM audit_chain_verify_anchor(${orgId}::uuid)
  `)) as unknown as DivergenceRow[];
  return rows.map((r) => ({
    ...r,
    anchored_head_seq: Number(r.anchored_head_seq),
    live_head_seq: Number(r.live_head_seq),
  }));
}

interface SignedAnchorRow {
  anchor_seq: number;
  head_chain_seq: number;
  signed: boolean;
}

/**
 * Write an anchor supplying a signature + the head/count the caller signed.
 * The function stamps the signature only when its re-read of the head still
 * matches p_expected_head_seq / p_expected_entry_count (the TOCTOU guard);
 * otherwise it anchors UNSIGNED. Returns whether the signature was stamped.
 */
async function writeSignedAnchor(
  orgId: string,
  signature: string,
  keyId: string,
  expectedHeadSeq: number,
  expectedEntryCount: number,
): Promise<SignedAnchorRow> {
  return withSystemDbAccessContext(async () => {
    const rows = (await db.execute(sql`
      SELECT anchor_seq, head_chain_seq, signed
      FROM audit_chain_anchor_head(
        ${orgId}::uuid,
        ${signature}::text,
        ${keyId}::varchar,
        ${expectedHeadSeq}::bigint,
        ${expectedEntryCount}::bigint
      )
    `)) as unknown as SignedAnchorRow[];
    const r = rows[0]!;
    return { ...r, anchor_seq: Number(r.anchor_seq), head_chain_seq: Number(r.head_chain_seq) };
  });
}

describe('audit_chain_anchors external anchor', () => {
  let orgId: string;

  beforeEach(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    orgId = org.id;
  });

  it('snapshots the live chain head into an append-only anchor', async () => {
    await seedAuditRows(orgId, 3);
    const head = await readHead(orgId);
    expect(head.entry_count).toBe(3);
    expect(head.head_chain_seq).toBeGreaterThan(0);

    const anchor = await writeAnchor(orgId);
    expect(anchor.head_chain_seq).toBe(head.head_chain_seq);
    expect(anchor.entry_count).toBe(3);
    expect(anchor.anchor_seq).toBeGreaterThan(0);
  });

  it('reports no divergence while the chain only moves forward', async () => {
    await seedAuditRows(orgId, 2);
    await writeAnchor(orgId);

    // Chain extends forward — anchor is still a valid prefix.
    await seedAuditRows(orgId, 2);
    const div = await verifyAnchor(orgId);
    expect(div).toHaveLength(0);
  });

  it('flags a forged-chain-after-DELETE: head regressed below the anchor', async () => {
    await seedAuditRows(orgId, 5);
    const anchor = await writeAnchor(orgId);
    expect(anchor.entry_count).toBe(5);

    // FORGE the tamper the app role cannot do: delete the newest chain rows so
    // the live head drops below the anchored head. The append-only trigger
    // blocks this for everyone, so we disable it via the privileged harness
    // pool — simulating a full DB takeover that bypasses the in-DB guard. This
    // is exactly the out-of-band deletion the EXTERNAL anchor exists to catch.
    await getTestDb().execute(sql`ALTER TABLE audit_log_chain DISABLE TRIGGER audit_log_chain_block_delete`);
    try {
      await getTestDb().execute(sql`
        DELETE FROM audit_log_chain
        WHERE org_id = ${orgId}
          AND chain_seq >= (
            SELECT chain_seq FROM audit_log_chain WHERE org_id = ${orgId}
            ORDER BY chain_seq DESC LIMIT 1 OFFSET 1
          )
      `);
    } finally {
      await getTestDb().execute(sql`ALTER TABLE audit_log_chain ENABLE TRIGGER audit_log_chain_block_delete`);
    }

    const div = await verifyAnchor(orgId);
    expect(div.length).toBeGreaterThanOrEqual(1);
    const reasons = div.map((d) => d.reason);
    // Either the head seq regressed, or the anchored head row vanished — both
    // are the tamper signal.
    expect(
      reasons.some((r) => r === 'seq_regressed' || r === 'anchored_head_missing'),
    ).toBe(true);
  });

  it('flags a historical entry rewritten in place (checksum_diverged)', async () => {
    await seedAuditRows(orgId, 3);
    const anchor = await writeAnchor(orgId);

    // Forge: rewrite the checksum of the anchored head row. The append-only
    // trigger blocks UPDATE for everyone, so we must drop+recreate the trigger
    // via the privileged pool to simulate a full DB takeover rewriting history.
    await getTestDb().execute(sql`ALTER TABLE audit_log_chain DISABLE TRIGGER audit_log_chain_block_update`);
    try {
      await getTestDb().execute(sql`
        UPDATE audit_log_chain
        SET chain_checksum = repeat('0', 64)
        WHERE org_id = ${orgId} AND chain_seq = ${anchor.head_chain_seq}
      `);
    } finally {
      await getTestDb().execute(sql`ALTER TABLE audit_log_chain ENABLE TRIGGER audit_log_chain_block_update`);
    }

    const div = await verifyAnchor(orgId);
    expect(div.map((d) => d.reason)).toContain('checksum_diverged');
  });

  it('treats a fully-pruned (empty) live chain as benign count_shrank, not seq_regressed', async () => {
    // Anchor a non-empty chain, then FORGE a full retention prune that deletes
    // THROUGH the anchored head (org went fully inactive). The live chain is now
    // empty (head_seq 0 / count 0). A naive seq_regressed check would page a P1;
    // branch (a0) must instead report the benign count_shrank class.
    await seedAuditRows(orgId, 4);
    const anchor = await writeAnchor(orgId);
    expect(anchor.entry_count).toBe(4);
    expect(anchor.head_chain_seq).toBeGreaterThan(0);

    await getTestDb().execute(sql`ALTER TABLE audit_log_chain DISABLE TRIGGER audit_log_chain_block_delete`);
    try {
      await getTestDb().execute(sql`DELETE FROM audit_log_chain WHERE org_id = ${orgId}`);
    } finally {
      await getTestDb().execute(sql`ALTER TABLE audit_log_chain ENABLE TRIGGER audit_log_chain_block_delete`);
    }

    const div = await verifyAnchor(orgId);
    expect(div).toHaveLength(1);
    // Benign retention class — NOT a tamper reason. Without branch (a0) this
    // would be seq_regressed (live_head_seq 0 < anchored head) → false P1.
    expect(div[0]?.reason).toBe('count_shrank');
    expect(div[0]?.live_head_seq).toBe(0);
  });

  it('stamps the signature only when the re-read head matches what was signed (TOCTOU guard)', async () => {
    await seedAuditRows(orgId, 3);
    const head = await readHead(orgId);

    // (1) Signature over the CURRENT head → stamped (signed=true).
    const matched = await writeSignedAnchor(
      orgId,
      'sig-for-current-head',
      'anchor-deadbeefdeadbeef',
      head.head_chain_seq,
      head.entry_count,
    );
    expect(matched.signed).toBe(true);

    // (2) Now the live head ADVANCES (more rows). A signature computed for the
    // OLD head no longer matches the re-read head → the function anchors
    // UNSIGNED rather than attach a stale signature.
    await seedAuditRows(orgId, 2);
    const stale = await writeSignedAnchor(
      orgId,
      'sig-for-stale-head',
      'anchor-deadbeefdeadbeef',
      head.head_chain_seq, // the OLD head the signature was computed over
      head.entry_count,
    );
    expect(stale.signed).toBe(false);
    expect(stale.head_chain_seq).toBeGreaterThan(head.head_chain_seq); // anchored the advanced head
  });

  it('reports no_anchor before the first anchor is written', async () => {
    await seedAuditRows(orgId, 1);
    const div = await verifyAnchor(orgId);
    expect(div).toHaveLength(1);
    expect(div[0]?.reason).toBe('no_anchor');
  });

  it('blocks breeze_app from UPDATE or DELETE on audit_chain_anchors (append-only)', async () => {
    await seedAuditRows(orgId, 1);
    await writeAnchor(orgId);

    // UPDATE must be rejected by the immutable trigger.
    let updateErr: unknown;
    try {
      await withSystemDbAccessContext(async () => {
        await db.execute(sql`
          UPDATE audit_chain_anchors SET entry_count = 999 WHERE org_id = ${orgId}
        `);
      });
    } catch (err) {
      updateErr = err;
    }
    expect(updateErr).toBeDefined();
    expect(
      (updateErr as { cause?: { message?: string } })?.cause?.message ??
        String(updateErr),
    ).toMatch(/append-only|permission denied/i); // both layers (grant REVOKE + trigger) enforce immutability for breeze_app

    // DELETE must also be rejected (no retention GUC set).
    let deleteErr: unknown;
    try {
      await withSystemDbAccessContext(async () => {
        await db.execute(sql`
          DELETE FROM audit_chain_anchors WHERE org_id = ${orgId}
        `);
      });
    } catch (err) {
      deleteErr = err;
    }
    expect(deleteErr).toBeDefined();
    expect(
      (deleteErr as { cause?: { message?: string } })?.cause?.message ??
        String(deleteErr),
    ).toMatch(/append-only|permission denied/i); // both layers (grant REVOKE + trigger) enforce immutability for breeze_app

    // The anchor row is still present and unchanged.
    const remaining = (await getTestDb().execute(sql`
      SELECT count(*)::int AS n FROM audit_chain_anchors WHERE org_id = ${orgId} AND entry_count = 1
    `)) as unknown as Array<{ n: number }>;
    expect(remaining[0]?.n).toBe(1);
  });
});
