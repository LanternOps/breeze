/**
 * #4596 — the two migrations' CLEANUP blocks, exercised against real drift.
 *
 * Every ordinary CI run applies these migrations to a database with zero
 * drifted rows, so the DO blocks report a truthful "0" and their join logic is
 * never executed. A reversed `IS DISTINCT FROM`, a wrong join column, or a
 * missing partner guard would report the same "0" and pass every other suite
 * in this PR while being silently wrong on a real database. This file forges
 * the drift and replays the cleanup SQL, so the fix is proven, not assumed.
 *
 * The third case is the one that matters most. A `time_entries` row can be
 * INTERNALLY consistent — org_id belongs to its own partner_id, so the W1
 * constraint accepts it and W1's own cleanup leaves it alone — while its
 * TICKET belongs to a different partner's org, because `time_entries` RLS only
 * checks partner_id and the old single-column ticket FK checked no tenancy at
 * all. A naive `SET org_id = t.org_id` re-derive would write another partner's
 * org onto that row and violate `time_entries_org_partner_fk`, which is live
 * and IMMEDIATE by then — aborting the whole W2 file with a 23503 on exactly
 * the data these migrations exist to remediate. W2 therefore severs the
 * cross-partner LINK instead and keeps the (self-consistent) org attribution.
 *
 * Fixtures are written with the admin/superuser handle, deliberately bypassing
 * the app-layer guards and RLS: the point is what the CLEANUP does to rows
 * that should not exist, and no application writer can create them.
 */
import './setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb } from './setup';

const MIGRATIONS_DIR = join(__dirname, '../../../migrations');
const W1_SQL = readFileSync(join(MIGRATIONS_DIR, '2026-10-06-110000-time-entries-org-partner-fk.sql'), 'utf8');
const W2_SQL = readFileSync(join(MIGRATIONS_DIR, '2026-10-06-110100-ticket-child-org-fks.sql'), 'utf8');

const admin = () => getTestDb() as any;
const seededPartnerIds: string[] = [];

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Drops the constraints the given migration adds, runs `body` (which forges
 * drift that the constraints would otherwise refuse), then REPLAYS the
 * migration file verbatim. The replay is the assertion surface: it must
 * succeed, which is only possible if the cleanup actually fixed the row.
 */
async function withConstraintsDropped(
  constraints: ReadonlyArray<[table: string, name: string]>,
  body: () => Promise<void>,
  replaySql: string,
): Promise<void> {
  for (const [table, name] of constraints) {
    await admin().execute(sql.raw(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${name}`));
  }
  try {
    await body();
  } finally {
    // Replaying the file re-adds the constraints AND runs the cleanup. If the
    // cleanup is wrong, ADD CONSTRAINT fails its initial validation here.
    await admin().execute(sql.raw(replaySql));
  }
}

async function seedPartnerOrg(label: string) {
  const u = uid();
  const [partner] = await admin().execute(sql`
    INSERT INTO partners (name, slug) VALUES (${`FK-${label}-${u}`}, ${`fk-${label}-${u}`}) RETURNING id
  `);
  seededPartnerIds.push(partner.id);
  const [org] = await admin().execute(sql`
    INSERT INTO organizations (partner_id, name, slug, currency_code)
    VALUES (${partner.id}::uuid, ${`Org-${label}-${u}`}, ${`org-${label}-${u}`}, 'USD') RETURNING id
  `);
  const [user] = await admin().execute(sql`
    INSERT INTO users (partner_id, email, name, password_hash)
    VALUES (${partner.id}::uuid, ${`fk-${label}-${u}@example.test`}, 'FK Tech', 'x') RETURNING id
  `);
  return { partnerId: partner.id as string, orgId: org.id as string, userId: user.id as string, u };
}

async function seedTicket(orgId: string, partnerId: string, u: string) {
  const [ticket] = await admin().execute(sql`
    INSERT INTO tickets (org_id, partner_id, ticket_number, subject, source)
    VALUES (${orgId}::uuid, ${partnerId}::uuid, ${`FKC-${u}`}, ${`cleanup ${u}`}, 'manual') RETURNING id
  `);
  return ticket.id as string;
}

async function insertEntry(v: {
  partnerId: string; orgId: string | null; ticketId: string | null; userId: string;
}) {
  const [row] = await admin().execute(sql`
    INSERT INTO time_entries (partner_id, org_id, ticket_id, user_id, started_at, ended_at, duration_minutes, currency_code)
    VALUES (${v.partnerId}::uuid, ${v.orgId}::uuid, ${v.ticketId}::uuid, ${v.userId}::uuid,
            now() - interval '2 minutes', now() - interval '1 minute', 1, 'USD')
    RETURNING id
  `);
  return row.id as string;
}

async function readEntry(id: string) {
  const rows = (await admin().execute(sql`
    SELECT org_id, ticket_id FROM time_entries WHERE id = ${id}::uuid
  `)) as unknown as Array<{ org_id: string | null; ticket_id: string | null }>;
  return rows[0]!;
}

afterAll(async () => {
  if (seededPartnerIds.length === 0) return;
  const list = sql.join(seededPartnerIds.map((id) => sql`${id}::uuid`), sql`, `);
  await admin().execute(sql`DELETE FROM ticket_parts WHERE ticket_id IN (SELECT id FROM tickets WHERE partner_id IN (${list}))`);
  await admin().execute(sql`DELETE FROM time_entries WHERE partner_id IN (${list})`);
  await admin().execute(sql`DELETE FROM tickets WHERE partner_id IN (${list})`);
  await admin().execute(sql`DELETE FROM partner_ticket_sequences WHERE partner_id IN (${list})`);
  await admin().execute(sql`DELETE FROM users WHERE partner_id IN (${list})`);
  await admin().execute(sql`DELETE FROM organizations WHERE partner_id IN (${list})`);
  await admin().execute(sql`DELETE FROM partners WHERE id IN (${list})`);
});

describe('#4596 migration cleanups, against forged drift', () => {
  it('W1 nulls a time entry whose org belongs to another partner', async () => {
    const a = await seedPartnerOrg('w1a');
    const b = await seedPartnerOrg('w1b');
    let entryId = '';
    await withConstraintsDropped(
      [['time_entries', 'time_entries_org_partner_fk']],
      async () => {
        entryId = await insertEntry({ partnerId: a.partnerId, orgId: b.orgId, ticketId: null, userId: a.userId });
        // Control: the forge really landed, so the assertion below is about
        // the cleanup and not about a row that was never drifted.
        expect((await readEntry(entryId)).org_id).toBe(b.orgId);
      },
      W1_SQL,
    );
    // The replay succeeded (it would have raised 23503 otherwise) and the
    // labour survives with its org attribution cleared — not deleted.
    expect((await readEntry(entryId)).org_id).toBeNull();
  });

  it('W2 re-derives a same-partner disagreement from the parent ticket', async () => {
    const a = await seedPartnerOrg('w2a');
    // A second org under the SAME partner, so W1's constraint stays satisfied
    // throughout and only the ticket disagreement is in play.
    const [org2] = await admin().execute(sql`
      INSERT INTO organizations (partner_id, name, slug, currency_code)
      VALUES (${a.partnerId}::uuid, ${`Org2-${a.u}`}, ${`org2-${a.u}`}, 'USD') RETURNING id
    `);
    const ticketId = await seedTicket(org2.id, a.partnerId, a.u);
    let entryId = '';
    await withConstraintsDropped(
      [['time_entries', 'time_entries_ticket_org_fk'], ['ticket_parts', 'ticket_parts_ticket_org_fk']],
      async () => {
        entryId = await insertEntry({ partnerId: a.partnerId, orgId: a.orgId, ticketId, userId: a.userId });
        expect((await readEntry(entryId)).org_id).toBe(a.orgId);
      },
      W2_SQL,
    );
    const after = await readEntry(entryId);
    expect(after.org_id).toBe(org2.id); // re-derived from the ticket
    expect(after.ticket_id).toBe(ticketId); // link preserved
  });

  it('W2 severs a CROSS-PARTNER ticket link instead of aborting on the W1 constraint', async () => {
    // The regression this test exists for: a naive `SET org_id = t.org_id`
    // would write partner B's org onto a partner A row and 23503 against the
    // already-live time_entries_org_partner_fk, aborting the whole file.
    const a = await seedPartnerOrg('w2x');
    const b = await seedPartnerOrg('w2y');
    const foreignTicket = await seedTicket(b.orgId, b.partnerId, b.u);
    let entryId = '';
    await withConstraintsDropped(
      [['time_entries', 'time_entries_ticket_org_fk'], ['ticket_parts', 'ticket_parts_ticket_org_fk']],
      async () => {
        // Self-consistent on the partner axis (W1 accepts it), but its ticket
        // lives under another partner.
        entryId = await insertEntry({ partnerId: a.partnerId, orgId: a.orgId, ticketId: foreignTicket, userId: a.userId });
        const forged = await readEntry(entryId);
        expect(forged.org_id).toBe(a.orgId);
        expect(forged.ticket_id).toBe(foreignTicket);
      },
      W2_SQL,
    );
    const after = await readEntry(entryId);
    expect(after.ticket_id).toBeNull(); // impossible link severed
    expect(after.org_id).toBe(a.orgId); // billable attribution kept
  });

  it('W2 re-derives a drifted ticket_parts row from its ticket', async () => {
    const a = await seedPartnerOrg('w2p');
    const [org2] = await admin().execute(sql`
      INSERT INTO organizations (partner_id, name, slug, currency_code)
      VALUES (${a.partnerId}::uuid, ${`OrgP-${a.u}`}, ${`orgp-${a.u}`}, 'USD') RETURNING id
    `);
    const ticketId = await seedTicket(org2.id, a.partnerId, a.u);
    let partId = '';
    await withConstraintsDropped(
      [['time_entries', 'time_entries_ticket_org_fk'], ['ticket_parts', 'ticket_parts_ticket_org_fk']],
      async () => {
        const [part] = await admin().execute(sql`
          INSERT INTO ticket_parts (ticket_id, org_id, description, quantity, unit_price, currency_code)
          VALUES (${ticketId}::uuid, ${a.orgId}::uuid, 'drifted part', '1.00', '0', 'USD') RETURNING id
        `);
        partId = part.id;
      },
      W2_SQL,
    );
    const rows = (await admin().execute(
      sql`SELECT org_id FROM ticket_parts WHERE id = ${partId}::uuid`,
    )) as unknown as Array<{ org_id: string }>;
    expect(rows[0]!.org_id).toBe(org2.id);
  });
});
