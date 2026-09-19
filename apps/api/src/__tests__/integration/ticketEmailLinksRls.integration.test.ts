/**
 * ticket_email_links RLS — cross-org forge proof (breeze_app role).
 *
 * Migration under test: 2026-08-22-ticket-email-links.sql
 *
 * Shape 1 (direct org_id, auto-discovered by rls-coverage.integration.test.ts).
 * partner_id is denormalized ONLY for the (partner_id, message_id)
 * idempotency claim — it is NOT an access axis, so this suite proves the
 * *org* boundary, not a partner one (contrast with emailInboundRls, which
 * proves the partner-axis on ticket_email_inbound / partner_inbound_domains).
 *
 * Runs through the REAL postgres.js driver (breeze_app role, rolbypassrls =
 * false), so RLS is genuinely enforced. Proves:
 *   1. an org-A caller cannot INSERT a link row against org-B's ticket
 *      (WITH CHECK on org_id fails; postgres.js surfaces the policy error on
 *      `.cause`, matched against 42501 per the task brief).
 *   2. a link legitimately inserted for org A's own ticket succeeds, and is
 *      invisible to an org-B SELECT.
 *   3. (#4643) moveTicketOrg re-stamps org_id on a link row (ticket-move axis).
 *   4. (#4643) the device move-org rewrite moves a link row via the tickets
 *      join (device-move axis) — same shape as ticketAttachmentsRls's
 *      equivalent pair, proving Postgres executes the statement and RLS
 *      admits the write under a system context, not just that the mocked
 *      unit suites assert the right statement SHAPE.
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { ticketEmailLinks, tickets, organizations, partners, devices, sites, users } from '../../db/schema';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';
import { moveTicketOrg } from '../../services/ticketService';

const seededPartnerIds: string[] = [];
const seededOrgIds: string[] = [];

const uniqueSuffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Seeds two unrelated partner/org/ticket triples (as the privileged test
 * role, bypassing RLS). Org A is the "attacker" context; org B is the
 * victim whose ticket the attacker tries to forge a link against.
 */
async function seedTwoOrgsWithTickets() {
  const adminDb = getTestDb() as any;
  const unique = uniqueSuffix();

  const partnerA = await createPartner();
  const orgA = await createOrganization({ partnerId: partnerA.id });
  const partnerB = await createPartner();
  const orgB = await createOrganization({ partnerId: partnerB.id });

  seededPartnerIds.push(partnerA.id, partnerB.id);
  seededOrgIds.push(orgA.id, orgB.id);

  const [ticketA] = await adminDb
    .insert(tickets)
    .values({
      orgId: orgA.id,
      partnerId: partnerA.id,
      ticketNumber: `TEL-RLS-A-${unique}`,
      subject: 'ticket_email_links RLS test — org A',
      source: 'portal',
    })
    .returning();

  const [ticketB] = await adminDb
    .insert(tickets)
    .values({
      orgId: orgB.id,
      partnerId: partnerB.id,
      ticketNumber: `TEL-RLS-B-${unique}`,
      subject: 'ticket_email_links RLS test — org B',
      source: 'portal',
    })
    .returning();

  const orgAContext: DbAccessContext = {
    scope: 'organization',
    orgId: orgA.id,
    accessibleOrgIds: [orgA.id],
    accessiblePartnerIds: [],
    userId: null,
  };
  const orgBContext: DbAccessContext = {
    scope: 'organization',
    orgId: orgB.id,
    accessibleOrgIds: [orgB.id],
    accessiblePartnerIds: [],
    userId: null,
  };

  return { partnerA, orgA, ticketA, orgAContext, partnerB, orgB, ticketB, orgBContext };
}

/**
 * Returns the postgres.js cause on an RLS rejection, or undefined if the
 * call unexpectedly succeeded. drizzle wraps the top-level message as
 * "Failed query: ..." — the real policy error lands on `.cause`.
 */
async function captureRlsCause(
  fn: () => Promise<unknown>
): Promise<{ code?: string; message?: string } | undefined> {
  try {
    await fn();
    return undefined; // no throw = isolation hole
  } catch (err) {
    return (err as { cause?: { code?: string; message?: string } } | undefined)?.cause;
  }
}

afterAll(async () => {
  if (seededPartnerIds.length === 0) return;
  const adminDb = getTestDb() as any;
  const orgList = sql.join(seededOrgIds.map((id) => sql`${id}`), sql`, `);
  const partnerList = sql.join(seededPartnerIds.map((id) => sql`${id}`), sql`, `);

  // FK order: ticket_email_links (FK ticket_id) -> tickets (FK device_id,
  // for the org-re-stamp fixture's device-linked ticket) -> devices (FK
  // site_id) -> sites -> orgs. The org-re-stamp fixture's actor user is
  // org-nullable MSP staff (orgId: null, partnerId set) so it has no FK into
  // the orgs above, but it does FK partner_id -> partners, so it must go
  // before the partner delete below.
  await adminDb.delete(ticketEmailLinks).where(sql`${ticketEmailLinks.orgId} IN (${orgList})`);
  await adminDb.delete(tickets).where(sql`${tickets.orgId} IN (${orgList})`);
  await adminDb.delete(devices).where(sql`${devices.orgId} IN (${orgList})`);
  await adminDb.delete(sites).where(sql`${sites.orgId} IN (${orgList})`);
  await adminDb.delete(organizations).where(sql`${organizations.id} IN (${orgList})`);
  await adminDb.delete(users).where(sql`${users.partnerId} IN (${partnerList})`);
  await adminDb.delete(partners).where(sql`${partners.id} IN (${partnerList})`);
});

describe('ticket_email_links RLS', () => {
  it('rejects cross-org insert with 42501', async () => {
    const { orgAContext, orgB, partnerB, ticketB } = await seedTwoOrgsWithTickets();

    const cause = await captureRlsCause(() =>
      withDbAccessContext(orgAContext, () =>
        db.insert(ticketEmailLinks).values({
          ticketId: ticketB.id, // forged: belongs to org B
          orgId: orgB.id,
          partnerId: partnerB.id,
          messageId: `<forge-${uniqueSuffix()}@example.test>`,
          origin: 'addin_link',
          visibility: 'public',
        })
      )
    );

    expect(cause).toBeDefined();
    expect(cause?.code).toBe('42501');
    expect(cause?.message).toMatch(
      /new row violates row-level security policy for table "ticket_email_links"/
    );
  });

  it('allows same-org insert and blocks cross-org select', async () => {
    const { orgAContext, orgBContext, orgA, partnerA, ticketA } = await seedTwoOrgsWithTickets();

    const messageId = `<same-org-${uniqueSuffix()}@example.test>`;
    const inserted = await withDbAccessContext(orgAContext, () =>
      db
        .insert(ticketEmailLinks)
        .values({
          ticketId: ticketA.id,
          orgId: orgA.id,
          partnerId: partnerA.id,
          messageId,
          origin: 'addin_link',
          visibility: 'public',
        })
        .returning({ id: ticketEmailLinks.id })
    );
    expect(inserted).toHaveLength(1);

    const ownRows = await withDbAccessContext(orgAContext, () =>
      db
        .select({ id: ticketEmailLinks.id })
        .from(ticketEmailLinks)
        .where(eq(ticketEmailLinks.messageId, messageId))
    );
    expect(ownRows).toHaveLength(1);

    const crossOrgRows = await withDbAccessContext(orgBContext, () =>
      db
        .select({ id: ticketEmailLinks.id })
        .from(ticketEmailLinks)
        .where(eq(ticketEmailLinks.messageId, messageId))
    );
    expect(crossOrgRows).toEqual([]);
  });
});

/**
 * Org re-stamp coverage (#4643). moveTicketOrg only allows a SAME-partner
 * move, so this needs its own two-orgs-one-partner fixture — distinct from
 * seedTwoOrgsWithTickets() above, which deliberately uses two DIFFERENT
 * partners to exercise the RLS org boundary. A device is seeded too so the
 * device-move axis's `WHERE ticket_id IN (SELECT id FROM tickets WHERE
 * device_id = ...)` join has something to resolve through.
 */
async function seedSamePartnerOrgsWithDeviceTicket() {
  const adminDb = getTestDb() as any;
  const unique = uniqueSuffix();

  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: orgA.id });
  const actor = await createUser({ partnerId: partner.id, orgId: null, email: `tel-move-actor-${unique}@example.test` });

  seededPartnerIds.push(partner.id);
  seededOrgIds.push(orgA.id, orgB.id);

  const [device] = await adminDb
    .insert(devices)
    .values({
      orgId: orgA.id,
      siteId: siteA.id,
      agentId: `tel-move-device-${unique}`,
      hostname: `tel-move-host-${unique}`,
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
      ticketNumber: `TEL-MOVE-${unique}`,
      subject: 'ticket_email_links org re-stamp test',
      deviceId: device!.id,
      source: 'portal',
    })
    .returning();

  return { partner, orgA, orgB, device: device!, ticketA: ticketA!, actor };
}

/** Inserts a link row as the RLS-bypassing test superuser. */
async function seedLink(opts: { orgId: string; partnerId: string; ticketId: string }): Promise<string> {
  const adminDb = getTestDb() as any;
  const [row] = await adminDb
    .insert(ticketEmailLinks)
    .values({
      ticketId: opts.ticketId,
      orgId: opts.orgId,
      partnerId: opts.partnerId,
      messageId: `<move-${uniqueSuffix()}@example.test>`,
      origin: 'addin_link',
      visibility: 'public',
    })
    .returning({ id: ticketEmailLinks.id });
  return row!.id;
}

describe('ticket_email_links org re-stamp on move (#4643)', () => {
  it('moveTicketOrg re-stamps org_id on the link row', async () => {
    const f = await seedSamePartnerOrgsWithDeviceTicket();
    const link = await seedLink({ orgId: f.orgA.id, partnerId: f.partner.id, ticketId: f.ticketA.id });

    await withSystemDbAccessContext(() => moveTicketOrg(f.ticketA.id, f.orgB.id, { userId: f.actor.id }));

    const [row] = (await getTestDb().execute(sql`
      SELECT org_id FROM ticket_email_links WHERE id = ${link}::uuid
    `)) as unknown as Array<{ org_id: string }>;
    expect(row?.org_id).toBe(f.orgB.id);
  });

  it('the device move-org rewrite moves a link row via the tickets join', async () => {
    const f = await seedSamePartnerOrgsWithDeviceTicket();
    const link = await seedLink({ orgId: f.orgA.id, partnerId: f.partner.id, ticketId: f.ticketA.id });

    // The statement routes/devices/moveOrg.ts issues inside its transaction.
    // The mocked route test asserts its SHAPE; this proves Postgres executes
    // it and that RLS admits the write under a system context.
    await withSystemDbAccessContext(() =>
      db.execute(sql`
        UPDATE ticket_email_links SET org_id = ${f.orgB.id}::uuid
         WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id = ${f.device.id}::uuid)
      `)
    );

    const [row] = (await getTestDb().execute(sql`
      SELECT org_id FROM ticket_email_links WHERE id = ${link}::uuid
    `)) as unknown as Array<{ org_id: string }>;
    expect(row?.org_id).toBe(f.orgB.id);
  });
});
