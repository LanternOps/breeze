/**
 * ticket_checklist_items org re-stamp on move, BOTH axes (#5783 W01).
 *
 * The table denormalizes org_id from its ticket (shape 1) and has NO device_id,
 * so neither the generic device loop nor `breeze_cascade_device_org_id()`
 * (whose discovery keys on the device_id column) reaches it. Both movers must
 * re-stamp it explicitly:
 *
 *   - ticket axis: TICKET_ORG_DENORMALIZED_TABLES drives moveTicketOrg's loop;
 *   - device axis: CUSTOM_ORG_REWRITE_TABLES + a hand-written UPDATE through
 *     the tickets join in routes/devices/moveOrg.ts.
 *
 * and — because this table's (ticket_id, org_id) FK is the first one that is
 * DEFERRABLE INITIALLY IMMEDIATE — both must ALSO name
 * `ticket_checklist_items_ticket_org_fk` in their SET CONSTRAINTS … DEFERRED
 * statements, or `UPDATE tickets SET org_id` 23503s the instant it completes.
 *
 * Same shape and same reason as ticketOutboxOrgMove.integration.test.ts, which
 * exists because ticket_outbox was in one list and missing from the other
 * (#4743). The mocked unit suites assert statement SHAPE; this proves Postgres
 * actually moves the rows.
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  ticketChecklistItems, tickets, devices, sites, organizations, partners, users,
} from '../../db/schema';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';
import { moveTicketOrg } from '../../services/ticketService';

const seededPartnerIds: string[] = [];
const seededOrgIds: string[] = [];

const uniqueSuffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * moveTicketOrg only allows a SAME-partner move, so this seeds a same-partner
 * two-org fixture with a device-linked ticket — the device is needed so the
 * device axis's `WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id =
 * ...)` join has something to resolve through.
 */
async function seedSamePartnerOrgsWithDeviceTicket() {
  const adminDb = getTestDb() as any;
  const unique = uniqueSuffix();

  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: orgA.id });
  const actor = await createUser({
    partnerId: partner.id, orgId: null, email: `chk-move-actor-${unique}@example.test`,
  });

  seededPartnerIds.push(partner.id);
  seededOrgIds.push(orgA.id, orgB.id);

  const [device] = await adminDb.insert(devices).values({
    orgId: orgA.id,
    siteId: siteA.id,
    agentId: `chk-move-device-${unique}`,
    hostname: `chk-move-host-${unique}`,
    osType: 'windows',
    osVersion: '10.0.19041',
    architecture: 'x64',
    agentVersion: '0.1.0',
  }).returning();

  const [ticketA] = await adminDb.insert(tickets).values({
    orgId: orgA.id,
    partnerId: partner.id,
    ticketNumber: `CHK-MOVE-${unique}`,
    subject: 'ticket_checklist_items org re-stamp test',
    deviceId: device!.id,
    source: 'portal',
  }).returning();

  return { partner, orgA, orgB, device: device!, ticketA: ticketA!, actor, unique };
}

/** Inserts a checklist row as the RLS-bypassing test superuser. */
async function seedChecklistItem(opts: {
  orgId: string; ticketId: string; label?: string; position?: number;
}): Promise<string> {
  const adminDb = getTestDb() as any;
  const [row] = await adminDb.insert(ticketChecklistItems).values({
    orgId: opts.orgId,
    ticketId: opts.ticketId,
    label: opts.label ?? 'Step',
    position: opts.position ?? 0,
  }).returning({ id: ticketChecklistItems.id });
  return row!.id;
}

/**
 * Replays routes/devices/moveOrg.ts's device-axis sequence for this table:
 * defer the composite FK BY NAME, move the device's tickets, then re-stamp the
 * checklist rows through the tickets join — one transaction, that order.
 *
 * Deliberately NOT a single bare child UPDATE: the composite (ticket_id,
 * org_id) FK makes moving the child before its ticket a 23503, so a standalone
 * statement would be testing a sequence the mover never issues.
 */
async function runDeviceAxisMove(deviceId: string, targetOrgId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SET CONSTRAINTS time_entries_ticket_org_fk, ticket_parts_ticket_org_fk, ticket_checklist_items_ticket_org_fk DEFERRED`,
    );
    await tx.execute(sql`
      UPDATE tickets SET org_id = ${targetOrgId}::uuid WHERE device_id = ${deviceId}::uuid
    `);
    await tx.execute(sql`
      UPDATE ticket_checklist_items SET org_id = ${targetOrgId}::uuid
       WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id = ${deviceId}::uuid)
    `);
  });
}

async function orgIdOf(itemId: string): Promise<string | undefined> {
  const [row] = (await getTestDb().execute(sql`
    SELECT org_id FROM ticket_checklist_items WHERE id = ${itemId}
  `)) as unknown as Array<{ org_id: string }>;
  return row?.org_id;
}

afterAll(async () => {
  if (seededPartnerIds.length === 0) return;
  const adminDb = getTestDb() as any;
  const orgList = sql.join(seededOrgIds.map((id) => sql`${id}`), sql`, `);
  const partnerList = sql.join(seededPartnerIds.map((id) => sql`${id}`), sql`, `);

  // FK order: ticket_checklist_items (FK ticket_id) -> tickets (FK device_id)
  // -> devices (FK site_id) -> sites -> orgs. The actor user is org-nullable
  // MSP staff (orgId: null, partnerId set) so it FKs partner_id -> partners
  // only, and must go before the partner delete below.
  await adminDb.delete(ticketChecklistItems).where(sql`${ticketChecklistItems.orgId} IN (${orgList})`);
  await adminDb.delete(tickets).where(sql`${tickets.orgId} IN (${orgList})`);
  await adminDb.delete(devices).where(sql`${devices.orgId} IN (${orgList})`);
  await adminDb.delete(sites).where(sql`${sites.orgId} IN (${orgList})`);
  await adminDb.delete(organizations).where(sql`${organizations.id} IN (${orgList})`);
  await adminDb.delete(users).where(sql`${users.partnerId} IN (${partnerList})`);
  await adminDb.delete(partners).where(sql`${partners.id} IN (${partnerList})`);
});

describe('ticket_checklist_items.org_id follows its ticket on BOTH org-move axes (#5783)', () => {
  it('the TICKET axis re-stamps every row and the deferred FK does not 23503 mid-transaction', async () => {
    const f = await seedSamePartnerOrgsWithDeviceTicket();
    const first = await seedChecklistItem({ orgId: f.orgA.id, ticketId: f.ticketA.id, position: 0 });
    const second = await seedChecklistItem({ orgId: f.orgA.id, ticketId: f.ticketA.id, position: 1 });

    await withSystemDbAccessContext(() =>
      moveTicketOrg(f.ticketA.id, f.orgB.id, { userId: f.actor.id }),
    );

    // The assertion that matters: NOT that the call succeeded, but that EVERY
    // row moved. A missing TICKET_ORG_DENORMALIZED_TABLES entry leaves these on
    // orgA, invisible to the new owner and visible to the old one.
    expect(await orgIdOf(first)).toBe(f.orgB.id);
    expect(await orgIdOf(second)).toBe(f.orgB.id);
  });

  it('the DEVICE axis re-stamps org_id through the tickets join', async () => {
    // Replays the device mover's own statement sequence: SET CONSTRAINTS on
    // this table's composite FK, then UPDATE tickets, then the hand-written
    // child UPDATE through the tickets join — all in ONE transaction. The
    // mocked route test asserts the statements' SHAPE; this proves Postgres
    // executes them, in that order, without a 23503.
    const f = await seedSamePartnerOrgsWithDeviceTicket();
    const itemId = await seedChecklistItem({ orgId: f.orgA.id, ticketId: f.ticketA.id });

    await withSystemDbAccessContext(() => runDeviceAxisMove(f.device.id, f.orgB.id));

    expect(await orgIdOf(itemId)).toBe(f.orgB.id);
  });

  it('a checklist item on an UNRELATED ticket in the same org is untouched by the device move', async () => {
    // Guards against an over-broad UPDATE that drops the tickets-join predicate
    // and re-stamps the whole org.
    const f = await seedSamePartnerOrgsWithDeviceTicket();
    const movedItem = await seedChecklistItem({ orgId: f.orgA.id, ticketId: f.ticketA.id });

    const adminDb = getTestDb() as any;
    const [siblingTicket] = await adminDb.insert(tickets).values({
      orgId: f.orgA.id,
      partnerId: f.partner.id,
      ticketNumber: `CHK-MOVE-SIBLING-${f.unique}`,
      subject: 'ticket_checklist_items org re-stamp test — sibling, no device',
      source: 'portal',
    }).returning();
    const siblingItem = await seedChecklistItem({
      orgId: f.orgA.id, ticketId: siblingTicket!.id,
    });

    await withSystemDbAccessContext(() => runDeviceAxisMove(f.device.id, f.orgB.id));

    expect(await orgIdOf(movedItem)).toBe(f.orgB.id);
    expect(await orgIdOf(siblingItem)).toBe(f.orgA.id);
  });

  it('a NON-deferred composite FK would abort the ticket move — proving the SET CONSTRAINTS entry is load-bearing', async () => {
    // Drives the same statement order moveTicketOrg uses (UPDATE tickets first,
    // children after) WITHOUT deferring this table's constraint. If the FK were
    // not deferrable-and-deferred by the real mover, this is exactly the 23503
    // the mover would raise.
    const f = await seedSamePartnerOrgsWithDeviceTicket();
    await seedChecklistItem({ orgId: f.orgA.id, ticketId: f.ticketA.id });

    let code: string | undefined;
    try {
      await withSystemDbAccessContext(() =>
        db.transaction(async (tx) => {
          await tx.execute(sql`
            UPDATE tickets SET org_id = ${f.orgB.id}::uuid WHERE id = ${f.ticketA.id}::uuid
          `);
        }),
      );
    } catch (err) {
      code = (err as { cause?: { code?: string } } | undefined)?.cause?.code;
    }
    expect(code).toBe('23503');
  });
});
