/**
 * #4596 W2 — a ticket-linked billing row cannot disagree with its ticket's org.
 *
 * `time_entries.org_id` and `ticket_parts.org_id` are DENORMALIZED from the
 * parent ticket and were both FK'd at `organizations(id)` alone. Nothing tied
 * either to `tickets.org_id`, so:
 *   - a part could be attached to another tenant's ticket while carrying the
 *     writer's own org_id — org-axis RLS on ticket_parts checks only the row's
 *     OWN org_id and never looks at the ticket;
 *   - a time entry could be attributed to org A while its ticket lived in org B,
 *     which is exactly the mis-attribution invoiceAssembly (selects by org_id)
 *     and the #4547 block-hours drawdown would inherit.
 *
 * The forge fixtures use TWO orgs under the SAME partner on purpose: that
 * isolates the new ticket->org constraint from W1's org->partner constraint
 * and from RLS, so every rejection below must be 23503 on a NAMED constraint,
 * never 42501. The one deliberate 42501 case is the cross-PARTNER ticket_parts
 * write, which documents the correction to the issue as filed: ticket_parts is
 * org-axis (Shape 1) with no partner_id column, so a cross-partner org_id was
 * never writable there and the issue's proposed (org_id, partner_id) composite
 * is not implementable on that table.
 *
 * Both org-move paths rewrite `tickets.org_id` BEFORE the children follow, so
 * both new constraints are DEFERRABLE and both transactions defer them by name.
 * The move regressions live in ticket-move-org.integration.test.ts.
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  timeEntries,
  ticketParts,
  tickets,
  partnerTicketSequences,
  users,
  organizations,
  partners,
} from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

const seededPartnerIds: string[] = [];
const seededOrgIds: string[] = [];
const admin = () => getTestDb() as any;

// Both shapes copied verbatim from the proven fixtures in
// time-entries-rls.integration.test.ts.
function orgCtx(orgId: string, userId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId };
}
function partnerCtx(partnerId: string, orgIds: string[], userId: string): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], userId };
}

async function seed() {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const partner = await createPartner();
  seededPartnerIds.push(partner.id);
  // TWO orgs under the SAME partner — see the file header.
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  seededOrgIds.push(orgA.id, orgB.id);
  const tech = await createUser({ partnerId: partner.id, orgId: null });
  const [ticketA] = await admin()
    .insert(tickets)
    .values({
      orgId: orgA.id,
      partnerId: partner.id,
      ticketNumber: `FK-${unique}`,
      subject: `child-org-fk ${unique}`,
      source: 'manual',
    })
    .returning();
  return { partner, orgA, orgB, tech, ticketA, unique };
}

function partValues(ticketId: string, orgId: string, description: string) {
  return { ticketId, orgId, description, quantity: '1.00', unitPrice: '0', currencyCode: 'USD' as const };
}

function entryValues(partnerId: string, orgId: string, ticketId: string, userId: string, offsetMs = 0) {
  return {
    partnerId,
    orgId,
    ticketId,
    userId,
    startedAt: new Date(Date.now() - 120_000 - offsetMs),
    endedAt: new Date(Date.now() - 60_000 - offsetMs),
    durationMinutes: 1,
    currencyCode: 'USD' as const,
  };
}

afterAll(async () => {
  if (seededPartnerIds.length === 0) return;
  const adminDb = admin();
  const partnerList = sql.join(seededPartnerIds.map((id) => sql`${id}`), sql`, `);
  // audit_logs is append-only (trigger blocks DELETE) but FKs organizations —
  // same session_replication_role idiom as time-entries-rls.integration.test.ts.
  if (seededOrgIds.length > 0) {
    const orgList = sql.join(seededOrgIds.map((id) => sql`${id}`), sql`, `);
    await adminDb.transaction(async (tx: any) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.execute(sql`DELETE FROM audit_logs WHERE org_id IN (${orgList})`);
    });
  }
  await adminDb.delete(timeEntries).where(sql`${timeEntries.partnerId} IN (${partnerList})`);
  await adminDb
    .delete(ticketParts)
    .where(sql`${ticketParts.ticketId} IN (SELECT id FROM tickets WHERE partner_id IN (${partnerList}))`);
  await adminDb.delete(tickets).where(sql`${tickets.partnerId} IN (${partnerList})`);
  await adminDb
    .delete(partnerTicketSequences)
    .where(sql`${partnerTicketSequences.partnerId} IN (${partnerList})`);
  await adminDb.delete(users).where(sql`${users.partnerId} IN (${partnerList})`);
  await adminDb.delete(organizations).where(sql`${organizations.partnerId} IN (${partnerList})`);
  await adminDb.delete(partners).where(sql`${partners.id} IN (${partnerList})`);
});

describe('ticket-child org FKs (#4596 W2)', () => {
  it('ticket_parts: a part cannot carry an org_id its ticket does not have', async () => {
    const { orgB, tech, ticketA } = await seed();
    // orgB's own tenant, writing a part it is fully authorised to own (the RLS
    // WITH CHECK on org_id passes), attached to orgA's ticket.
    await expect(
      withDbAccessContext(orgCtx(orgB.id, tech.id), () =>
        db.insert(ticketParts).values(partValues(ticketA.id, orgB.id, 'forged part')),
      ),
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('time_entries: an entry cannot carry an org_id its ticket does not have', async () => {
    const { partner, orgA, orgB, tech, ticketA } = await seed();
    await expect(
      withDbAccessContext(partnerCtx(partner.id, [orgA.id, orgB.id], tech.id), () =>
        db.insert(timeEntries).values(entryValues(partner.id, orgB.id, ticketA.id, tech.id)),
      ),
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('ticket_parts: another PARTNER\'s org_id in the row itself is refused by RLS (42501)', async () => {
    // The issue as filed said ticket_parts was partner-axis and asked for an
    // (org_id, partner_id) composite FK. It is org-axis (Shape 1) with no
    // partner_id column at all, and the org-axis WITH CHECK already refuses an
    // org_id outside the caller's accessible orgs with 42501. That is why this
    // wave does NOT add the composite the issue proposed for this table — it
    // would be unimplementable and, for this axis, redundant.
    const { orgA, ticketA } = await seed();
    const otherPartner = await createPartner();
    seededPartnerIds.push(otherPartner.id);
    const otherOrg = await createOrganization({ partnerId: otherPartner.id });
    seededOrgIds.push(otherOrg.id);
    const otherTech = await createUser({ partnerId: otherPartner.id, orgId: null });
    await expect(
      withDbAccessContext(orgCtx(otherOrg.id, otherTech.id), () =>
        db.insert(ticketParts).values(partValues(ticketA.id, orgA.id, 'rls-refused part')),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('ticket_parts: the gap DOES reach across partners via the ticket (23503)', async () => {
    // RLS confines the row's OWN org_id (previous test), but says nothing about
    // whose ticket the part hangs off. So a tenant under partner B could attach
    // a part carrying its own, fully-authorised org_id to a ticket owned by
    // partner A — and invoiceAssembly, which selects parts by org_id, would
    // bill it. Only the new composite FK closes this.
    const { ticketA } = await seed();
    const otherPartner = await createPartner();
    seededPartnerIds.push(otherPartner.id);
    const otherOrg = await createOrganization({ partnerId: otherPartner.id });
    seededOrgIds.push(otherOrg.id);
    const otherTech = await createUser({ partnerId: otherPartner.id, orgId: null });
    await expect(
      withDbAccessContext(orgCtx(otherOrg.id, otherTech.id), () =>
        db.insert(ticketParts).values(partValues(ticketA.id, otherOrg.id, 'cross-partner part')),
      ),
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('a matching org_id is accepted on both tables', async () => {
    const { partner, orgA, orgB, tech, ticketA } = await seed();
    const [part] = await withDbAccessContext(orgCtx(orgA.id, tech.id), () =>
      db.insert(ticketParts).values(partValues(ticketA.id, orgA.id, 'ok part')).returning(),
    );
    const [entry] = await withDbAccessContext(partnerCtx(partner.id, [orgA.id, orgB.id], tech.id), () =>
      db.insert(timeEntries).values(entryValues(partner.id, orgA.id, ticketA.id, tech.id)).returning(),
    );
    expect(part!.orgId).toBe(orgA.id);
    expect(entry!.orgId).toBe(orgA.id);
  });

  it('deleting the ticket unlinks the time entry and cascades the part', async () => {
    const { partner, orgA, orgB, tech, ticketA } = await seed();
    await withDbAccessContext(orgCtx(orgA.id, tech.id), () =>
      db.insert(ticketParts).values(partValues(ticketA.id, orgA.id, 'cascade me')),
    );
    const [entry] = await withDbAccessContext(partnerCtx(partner.id, [orgA.id, orgB.id], tech.id), () =>
      db.insert(timeEntries).values(entryValues(partner.id, orgA.id, ticketA.id, tech.id)).returning(),
    );
    await admin().execute(sql`DELETE FROM tickets WHERE id = ${ticketA.id}::uuid`);
    const parts = (await admin().execute(
      sql`SELECT id FROM ticket_parts WHERE ticket_id = ${ticketA.id}::uuid`,
    )) as unknown as unknown[];
    expect(parts).toHaveLength(0);
    // The column-list ON DELETE SET NULL (ticket_id) must NOT null org_id: the
    // labour still belongs to that org after its ticket is gone. A bare
    // composite SET NULL would wipe the attribution.
    const rows = (await admin().execute(sql`
      SELECT ticket_id, org_id FROM time_entries WHERE id = ${entry!.id}::uuid
    `)) as unknown as Array<{ ticket_id: string | null; org_id: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ticket_id).toBeNull();
    expect(rows[0]!.org_id).toBe(orgA.id);
  });

  it('both constraints are DEFERRABLE INITIALLY IMMEDIATE (merge contract)', async () => {
    const rows = (await admin().execute(sql`
      SELECT conname, condeferrable, condeferred FROM pg_constraint
      WHERE conname IN ('time_entries_ticket_org_fk', 'ticket_parts_ticket_org_fk')
      ORDER BY conname
    `)) as unknown as Array<{ conname: string; condeferrable: boolean; condeferred: boolean }>;
    expect(rows.map((r) => r.conname)).toEqual(['ticket_parts_ticket_org_fk', 'time_entries_ticket_org_fk']);
    expect(rows.every((r) => r.condeferrable && !r.condeferred)).toBe(true);
  });
});
