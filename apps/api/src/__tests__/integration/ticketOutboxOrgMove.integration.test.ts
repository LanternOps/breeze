/**
 * ticket_outbox org re-stamp on move (#4743).
 *
 * ticket_outbox denormalizes org_id from its ticket (Shape 1, direct org_id,
 * RLS auto-discovered by rls-coverage.integration.test.ts — see
 * db/schema/ticketOutbox.ts's header) and has no device_id column. It was
 * already registered in TICKET_ORG_DENORMALIZED_TABLES (ticketService.ts's
 * moveTicketOrg re-stamp loop), so the ticket-move axis already re-stamped
 * it correctly — but it was absent from CUSTOM_ORG_REWRITE_TABLES
 * (routes/devices/core.ts), the list of ticket-child, no-device_id tables
 * that get a dedicated hand-written UPDATE in routes/devices/moveOrg.ts for
 * the device-move axis. A device org-move that re-stamped a device-linked
 * ticket left any live ticket_outbox row for that ticket stranded under the
 * source org — same stranded-org_id / cross-tenant-read class as #4643
 * (ticket_email_links), on a different table.
 *
 * This suite proves BOTH axes actually re-stamp ticket_outbox.org_id against
 * real Postgres under breeze_app RLS — same shape as
 * ticketEmailLinksRls.integration.test.ts's equivalent pair (#4736) — not
 * just that the mocked unit suites (moveOrg.test.ts, ticketService.test.ts)
 * assert the right statement SHAPE.
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { ticketOutbox, tickets, devices, sites, organizations, partners, users } from '../../db/schema';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';
import { moveTicketOrg } from '../../services/ticketService';

const seededPartnerIds: string[] = [];
const seededOrgIds: string[] = [];

const uniqueSuffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * moveTicketOrg only allows a SAME-partner move, so this seeds a
 * same-partner two-org fixture with a device-linked ticket — the device is
 * needed so the device-move axis's
 * `WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id = ...)` join
 * has something to resolve through.
 */
async function seedSamePartnerOrgsWithDeviceTicket() {
  const adminDb = getTestDb() as any;
  const unique = uniqueSuffix();

  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: orgA.id });
  const actor = await createUser({ partnerId: partner.id, orgId: null, email: `to-move-actor-${unique}@example.test` });

  seededPartnerIds.push(partner.id);
  seededOrgIds.push(orgA.id, orgB.id);

  const [device] = await adminDb
    .insert(devices)
    .values({
      orgId: orgA.id,
      siteId: siteA.id,
      agentId: `to-move-device-${unique}`,
      hostname: `to-move-host-${unique}`,
      osType: 'windows',
      osVersion: '10.0.19041',
      architecture: 'x64',
      agentVersion: '0.1.0',
    })
    .returning();

  const [ticketA] = await adminDb
    .insert(tickets)
    .values({
      orgId: orgA.id,
      partnerId: partner.id,
      ticketNumber: `TO-MOVE-${unique}`,
      subject: 'ticket_outbox org re-stamp test',
      deviceId: device!.id,
      source: 'portal',
    })
    .returning();

  return { partner, orgA, orgB, device: device!, ticketA: ticketA!, actor };
}

/** Inserts an outbox row as the RLS-bypassing test superuser. */
async function seedOutboxRow(opts: { orgId: string; ticketId: string }): Promise<number> {
  const adminDb = getTestDb() as any;
  const [row] = await adminDb
    .insert(ticketOutbox)
    .values({
      ticketId: opts.ticketId,
      orgId: opts.orgId,
      eventType: 'ticket.created',
      payload: {},
    })
    .returning({ id: ticketOutbox.id });
  return row!.id;
}

afterAll(async () => {
  if (seededPartnerIds.length === 0) return;
  const adminDb = getTestDb() as any;
  const orgList = sql.join(seededOrgIds.map((id) => sql`${id}`), sql`, `);
  const partnerList = sql.join(seededPartnerIds.map((id) => sql`${id}`), sql`, `);

  // FK order: ticket_outbox (FK ticket_id) -> tickets (FK device_id) ->
  // devices (FK site_id) -> sites -> orgs. The actor user is org-nullable
  // MSP staff (orgId: null, partnerId set) so it FKs partner_id -> partners
  // only, and must go before the partner delete below.
  await adminDb.delete(ticketOutbox).where(sql`${ticketOutbox.orgId} IN (${orgList})`);
  await adminDb.delete(tickets).where(sql`${tickets.orgId} IN (${orgList})`);
  await adminDb.delete(devices).where(sql`${devices.orgId} IN (${orgList})`);
  await adminDb.delete(sites).where(sql`${sites.orgId} IN (${orgList})`);
  await adminDb.delete(organizations).where(sql`${organizations.id} IN (${orgList})`);
  await adminDb.delete(users).where(sql`${users.partnerId} IN (${partnerList})`);
  await adminDb.delete(partners).where(sql`${partners.id} IN (${partnerList})`);
});

describe('ticket_outbox org re-stamp on move (#4743)', () => {
  it('moveTicketOrg re-stamps org_id on the outbox row (ticket-move axis)', async () => {
    const f = await seedSamePartnerOrgsWithDeviceTicket();
    const rowId = await seedOutboxRow({ orgId: f.orgA.id, ticketId: f.ticketA.id });

    await withSystemDbAccessContext(() => moveTicketOrg(f.ticketA.id, f.orgB.id, { userId: f.actor.id }));

    const [row] = (await getTestDb().execute(sql`
      SELECT org_id FROM ticket_outbox WHERE id = ${rowId}
    `)) as unknown as Array<{ org_id: string }>;
    expect(row?.org_id).toBe(f.orgB.id);
  });

  it('the device move-org rewrite moves an outbox row via the tickets join (device-move axis)', async () => {
    const f = await seedSamePartnerOrgsWithDeviceTicket();
    const rowId = await seedOutboxRow({ orgId: f.orgA.id, ticketId: f.ticketA.id });

    // The statement routes/devices/moveOrg.ts issues inside its transaction.
    // The mocked route test (moveOrg.test.ts) asserts its SHAPE; this proves
    // Postgres executes it and that RLS admits the write under a system
    // context.
    await withSystemDbAccessContext(() =>
      db.execute(sql`
        UPDATE ticket_outbox SET org_id = ${f.orgB.id}::uuid
         WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id = ${f.device.id}::uuid)
      `)
    );

    const [row] = (await getTestDb().execute(sql`
      SELECT org_id FROM ticket_outbox WHERE id = ${rowId}
    `)) as unknown as Array<{ org_id: string }>;
    expect(row?.org_id).toBe(f.orgB.id);
  });

  it('the device move-org rewrite leaves a sibling ticket_outbox row (different ticket) untouched', async () => {
    const f = await seedSamePartnerOrgsWithDeviceTicket();
    const rowId = await seedOutboxRow({ orgId: f.orgA.id, ticketId: f.ticketA.id });

    // A second, device-less ticket in the SAME org as the moved device's
    // ticket, with its own outbox row. Proves the tickets-join subquery is
    // scoped to `device_id = <moved device>` and does not over-broadly
    // rewrite every ticket_outbox row in the source org.
    const adminDb = getTestDb() as any;
    const unique = uniqueSuffix();
    const [siblingTicket] = await adminDb
      .insert(tickets)
      .values({
        orgId: f.orgA.id,
        partnerId: f.partner.id,
        ticketNumber: `TO-MOVE-SIBLING-${unique}`,
        subject: 'ticket_outbox org re-stamp test — sibling, no device',
        source: 'portal',
      })
      .returning();
    const siblingRowId = await seedOutboxRow({ orgId: f.orgA.id, ticketId: siblingTicket!.id });

    await withSystemDbAccessContext(() =>
      db.execute(sql`
        UPDATE ticket_outbox SET org_id = ${f.orgB.id}::uuid
         WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id = ${f.device.id}::uuid)
      `)
    );

    const [movedRow] = (await getTestDb().execute(sql`
      SELECT org_id FROM ticket_outbox WHERE id = ${rowId}
    `)) as unknown as Array<{ org_id: string }>;
    expect(movedRow?.org_id).toBe(f.orgB.id);

    const [siblingRow] = (await getTestDb().execute(sql`
      SELECT org_id FROM ticket_outbox WHERE id = ${siblingRowId}
    `)) as unknown as Array<{ org_id: string }>;
    expect(siblingRow?.org_id).toBe(f.orgA.id);
  });
});
