/**
 * #8972 W1 Task 1.1 (spec §3.2): the tombstone columns and their constraints.
 *
 *   tickets.merged_into_ticket_id  composite FK (merged_into_ticket_id, org_id)
 *                                  → tickets(id, org_id), NO ACTION, DEFERRABLE
 *                                  INITIALLY IMMEDIATE; CHECK <> id
 *   tickets.merged_at              CHECK (merged_into IS NULL) = (merged_at IS NULL)
 *   tickets.merged_by_user_id      → users ON DELETE SET NULL
 *   ticket_comments.merged_from_ticket_id → tickets ON DELETE SET NULL
 */
import './setup';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function insertTicket(orgId: string, partnerId: string): Promise<string> {
  const rows = (await getTestDb().execute(sql`
    INSERT INTO tickets (org_id, partner_id, subject, source, priority, ticket_number)
    VALUES (${orgId}::uuid, ${partnerId}::uuid, 'merge schema', 'api', 'normal', ${`MRG-${crypto.randomUUID().slice(0, 8)}`})
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return rows[0]!.id;
}

function sqlState(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.cause?.code ?? e?.code;
}

async function expectSqlState(p: Promise<unknown>, state: string, constraint?: string) {
  let caught: unknown;
  try {
    await p;
  } catch (err) {
    caught = err;
  }
  expect(caught, 'statement should have failed').toBeDefined();
  expect(sqlState(caught)).toBe(state);
  if (constraint) {
    const e = caught as { constraint_name?: string; cause?: { constraint_name?: string; constraint?: string }; constraint?: string };
    expect(e.cause?.constraint_name ?? e.cause?.constraint ?? e.constraint_name ?? e.constraint).toBe(constraint);
  }
}

async function seedOrg() {
  const partner = await createPartner({ name: 'MergeSchema-Partner' });
  const org = await createOrganization({ partnerId: partner.id, name: 'MergeSchema-Org' });
  return { partner, org };
}

describe('ticket merge schema (#8972 W1, spec §3.2)', () => {
  runDb('rejects self-merge', async () => {
    const { partner, org } = await seedOrg();
    const t = await insertTicket(org.id, partner.id);
    await expectSqlState(getTestDb().execute(sql`
      UPDATE tickets SET merged_into_ticket_id = id, merged_at = now() WHERE id = ${t}::uuid
    `), '23514', 'tickets_merged_into_not_self_chk');
  });

  runDb('rejects merged_at without merged_into', async () => {
    const { partner, org } = await seedOrg();
    const t = await insertTicket(org.id, partner.id);
    await expectSqlState(getTestDb().execute(sql`
      UPDATE tickets SET merged_at = now() WHERE id = ${t}::uuid
    `), '23514', 'tickets_merged_pair_chk');
  });

  runDb('rejects merged_into without merged_at', async () => {
    const { partner, org } = await seedOrg();
    const a = await insertTicket(org.id, partner.id);
    const b = await insertTicket(org.id, partner.id);
    await expectSqlState(getTestDb().execute(sql`
      UPDATE tickets SET merged_into_ticket_id = ${b}::uuid WHERE id = ${a}::uuid
    `), '23514', 'tickets_merged_pair_chk');
  });

  runDb('rejects a cross-org survivor', async () => {
    const { partner, org } = await seedOrg();
    const otherOrg = await createOrganization({ partnerId: partner.id, name: 'MergeSchema-Other' });
    const a = await insertTicket(org.id, partner.id);
    const b = await insertTicket(otherOrg.id, partner.id);
    await expectSqlState(getTestDb().execute(sql`
      UPDATE tickets SET merged_into_ticket_id = ${b}::uuid, merged_at = now() WHERE id = ${a}::uuid
    `), '23503', 'tickets_merged_into_org_fk');
  });

  runDb('accepts a same-org merge and records who merged it', async () => {
    const { partner, org } = await seedOrg();
    const user = await createUser({ partnerId: partner.id });
    const a = await insertTicket(org.id, partner.id);
    const b = await insertTicket(org.id, partner.id);
    await getTestDb().execute(sql`
      UPDATE tickets SET merged_into_ticket_id = ${b}::uuid, merged_at = now(), merged_by_user_id = ${user.id}::uuid
      WHERE id = ${a}::uuid
    `);
    const rows = (await getTestDb().execute(sql`
      SELECT merged_into_ticket_id, merged_by_user_id FROM tickets WHERE id = ${a}::uuid
    `)) as unknown as Array<{ merged_into_ticket_id: string; merged_by_user_id: string }>;
    expect(rows[0]).toEqual({ merged_into_ticket_id: b, merged_by_user_id: user.id });
  });

  runDb('blocks hard delete of a survivor with tombstones', async () => {
    const { partner, org } = await seedOrg();
    const a = await insertTicket(org.id, partner.id);
    const b = await insertTicket(org.id, partner.id);
    await getTestDb().execute(sql`
      UPDATE tickets SET merged_into_ticket_id = ${b}::uuid, merged_at = now() WHERE id = ${a}::uuid
    `);
    await expectSqlState(getTestDb().execute(sql`DELETE FROM tickets WHERE id = ${b}::uuid`), '23503', 'tickets_merged_into_org_fk');
    // Survivor and tombstone together in one statement is fine (same-statement
    // NO ACTION check runs at statement end).
    await getTestDb().execute(sql`DELETE FROM tickets WHERE id IN (${a}::uuid, ${b}::uuid)`);
  });

  runDb('FK is deferrable, initially immediate', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT condeferrable, condeferred, confdeltype, convalidated
        FROM pg_constraint WHERE conname = 'tickets_merged_into_org_fk'
    `)) as unknown as Array<{ condeferrable: boolean; condeferred: boolean; confdeltype: string; convalidated: boolean }>;
    expect(rows).toEqual([{ condeferrable: true, condeferred: false, confdeltype: 'a', convalidated: true }]);
  });

  runDb('merged_from_ticket_id on comments nulls when its ticket is hard-deleted', async () => {
    const { partner, org } = await seedOrg();
    const user = await createUser({ partnerId: partner.id });
    const src = await insertTicket(org.id, partner.id);
    const dst = await insertTicket(org.id, partner.id);
    const rows = (await getTestDb().execute(sql`
      INSERT INTO ticket_comments (ticket_id, user_id, author_type, comment_type, content, is_public, merged_from_ticket_id)
      VALUES (${dst}::uuid, ${user.id}::uuid, 'internal', 'internal', 'moved', false, ${src}::uuid)
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    await getTestDb().execute(sql`DELETE FROM tickets WHERE id = ${src}::uuid`);
    const after = (await getTestDb().execute(sql`
      SELECT merged_from_ticket_id FROM ticket_comments WHERE id = ${rows[0]!.id}::uuid
    `)) as unknown as Array<{ merged_from_ticket_id: string | null }>;
    expect(after).toEqual([{ merged_from_ticket_id: null }]);
  });

  runDb('partial index exists and is valid', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT i.indisvalid, pg_get_expr(i.indpred, i.indrelid) AS pred
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname = 'tickets_merged_into_idx'
    `)) as unknown as Array<{ indisvalid: boolean; pred: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indisvalid).toBe(true);
    expect(rows[0]!.pred).toContain('merged_into_ticket_id IS NOT NULL');
  });
});
