/**
 * #3258 W03 — end-to-end proof that an inbound email attributes to a CONTACT.
 *
 * The unit suites mock the DB, so they can prove the service ASKED for the
 * right things. Only a real Postgres can prove the three claims that actually
 * matter here:
 *
 *  1. The auth table is no longer written on ingest. `portal_users` row count
 *     for the org is ZERO — a mocked suite cannot see a write it doesn't stub.
 *  2. `tickets.requester_contact_id` is really persisted, through the
 *     composite same-org FK. A wrong org would be a constraint violation, not
 *     a failed assertion, so the write itself is the test.
 *  3. The invited portal user then SEES that emailed ticket, via the real
 *     ownership predicate compiled by Postgres.
 *
 * Plus the migration's own idempotency: it must be replayable, because
 * autoMigrate re-applies by filename and a half-applied constraint would
 * abort boot.
 *
 * The whole pipeline runs under `withSystemDbAccessContext` exactly as the
 * worker does (RLS bypassed), so the partner-validated org from
 * `resolveOrgBySenderDomain` plus createFromEmail's re-assertion are the whole
 * tenancy boundary — nothing here re-derives an org from the sender.
 */
import './setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

// The autoresponder is the one outbound boundary this suite stubs: whether the
// acknowledgement is SENT depends on partner mail config that has nothing to do
// with requester attribution. What is asserted is the GATE decision, which is
// exactly what W03 changed (submittedBy-as-proxy -> an explicit flag).
const { autoresponseMock } = vi.hoisted(() => ({ autoresponseMock: vi.fn() }));
vi.mock('../../services/inboundEmail/autoresponder', () => ({
  maybeSendAutoresponse: autoresponseMock,
}));

import { withSystemDbAccessContext } from '../../db';
import {
  contacts,
  customerEmailDomains,
  organizations,
  partnerInboundDomains,
  partners,
  ticketComments,
  ticketEmailInbound,
  tickets,
} from '../../db/schema';
import { portalUsers } from '../../db/schema/portal';
import { portalTicketOwnership } from '../../routes/portal/ticketOwnership';
import { processInboundEmail } from '../../services/inboundEmail/inboundEmailService';
import type { NormalizedInboundEmail } from '../../services/inboundEmail/types';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';
import { randomUUID } from 'node:crypto';
import * as orgMergeModule from '../../services/orgMerge';
import { devices, sites } from '../../db/schema';

const MIGRATION_FILE = join(__dirname, '../../../migrations/2026-10-04-100000-ticket-requester-contact.sql');
// The follow-up that made portal_users.contact_id same-org (#3258). Needed here
// only to RESTORE that constraint after the drift-tolerance test forges a row
// it forbids.
const PORTAL_USER_FK_MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-10-04-100002-portal-users-contact-composite-fk.sql',
);

const uniqueSuffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const admin = () => getTestDb() as any;

const seeded = { partnerIds: [] as string[], orgIds: [] as string[] };

interface Fixture {
  partnerId: string;
  orgId: string;
  /** The partner's own inbound domain — the TO address resolves the partner. */
  inboundDomain: string;
  /** The customer's sender domain, mapped to the org with autoCreateContact on. */
  senderDomain: string;
}

let fx: Fixture;

function buildEmail(overrides: Partial<NormalizedInboundEmail> & { to: string; from: string }): NormalizedInboundEmail {
  return {
    provider: 'mailgun',
    providerMessageId: `<msg-${uniqueSuffix()}@customer.test>`,
    subject: 'Hello support',
    text: 'I need help with my printer.',
    senderAuth: { spf: 'pass', dkim: 'pass', dmarc: 'pass', verified: true },
    attachments: [],
    raw: {},
    ...overrides,
  };
}

beforeEach(async () => {
  autoresponseMock.mockReset();
  const db = admin();
  const suffix = uniqueSuffix();

  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  seeded.partnerIds.push(partner.id);
  seeded.orgIds.push(org.id);

  const inboundDomain = `msp-${suffix}.tickets.test`;
  const senderDomain = `cust-${suffix}.test`;

  await db.insert(partnerInboundDomains).values({
    partnerId: partner.id,
    domain: inboundDomain,
    provider: 'mailgun',
    verificationStatus: 'verified',
  });
  await db.insert(customerEmailDomains).values({
    partnerId: partner.id,
    orgId: org.id,
    domain: senderDomain,
    autoCreateContact: true,
    isActive: true,
  });

  fx = { partnerId: partner.id, orgId: org.id, inboundDomain, senderDomain };
});

afterAll(async () => {
  const db = admin();
  if (seeded.partnerIds.length === 0) return;
  const partnerList = sql.join(seeded.partnerIds.map((id) => sql`${id}`), sql`, `);
  const orgList = sql.join(seeded.orgIds.map((id) => sql`${id}`), sql`, `);

  await db.delete(ticketComments).where(
    sql`${ticketComments.ticketId} IN (SELECT id FROM tickets WHERE partner_id IN (${partnerList}))`,
  );
  await db.delete(ticketEmailInbound).where(sql`${ticketEmailInbound.partnerId} IN (${partnerList})`);
  await db.delete(tickets).where(sql`${tickets.partnerId} IN (${partnerList})`);
  await db.delete(portalUsers).where(sql`${portalUsers.orgId} IN (${orgList})`);
  await db.delete(contacts).where(sql`${contacts.orgId} IN (${orgList})`);
  await db.delete(customerEmailDomains).where(sql`${customerEmailDomains.partnerId} IN (${partnerList})`);
  await db.delete(partnerInboundDomains).where(sql`${partnerInboundDomains.partnerId} IN (${partnerList})`);
  await db.execute(sql`DELETE FROM partner_ticket_sequences WHERE partner_id IN (${partnerList})`);
  await db.execute(sql`DELETE FROM audit_logs WHERE org_id IN (${orgList})`);
  // org merge / device fixtures below reference the orgs; drop them first or
  // the organizations DELETE trips their FKs.
  await db.execute(sql`DELETE FROM org_merge_events WHERE partner_id IN (${partnerList})`);
  await db.delete(devices).where(sql`${devices.orgId} IN (${orgList})`);
  await db.delete(sites).where(sql`${sites.orgId} IN (${orgList})`);
  await db.delete(organizations).where(sql`${organizations.id} IN (${orgList})`);
  await db.delete(partners).where(sql`${partners.id} IN (${partnerList})`);
});

async function ingest(from: string, overrides: Partial<NormalizedInboundEmail> = {}) {
  await withSystemDbAccessContext(() =>
    processInboundEmail(buildEmail({ to: `support@${fx.inboundDomain}`, from, ...overrides })),
  );
}

const orgTickets = () =>
  admin()
    .select({
      id: tickets.id,
      submittedBy: tickets.submittedBy,
      requesterContactId: tickets.requesterContactId,
      submitterEmail: tickets.submitterEmail,
      submitterName: tickets.submitterName,
    })
    .from(tickets)
    .where(eq(tickets.orgId, fx.orgId));

const orgContacts = () =>
  admin()
    .select({ id: contacts.id, email: contacts.email, name: contacts.name, roles: contacts.roles })
    .from(contacts)
    .where(eq(contacts.orgId, fx.orgId));

const orgLogins = () =>
  admin().select({ id: portalUsers.id }).from(portalUsers).where(eq(portalUsers.orgId, fx.orgId));

describe('inbound email -> contact requester (#3258 W03)', () => {
  it('an unknown sender at a mapped domain creates ONE contact, ZERO portal_users, and links the ticket', async () => {
    const from = `bob@${fx.senderDomain}`;

    await ingest(from, { fromName: 'Bob Customer' });

    const contactRows = await orgContacts();
    expect(contactRows).toHaveLength(1);
    expect(contactRows[0].email).toBe(from);
    expect(contactRows[0].name).toBe('Bob Customer');
    // Inbound claims no role: emailing demonstrates nothing but emailing.
    expect(contactRows[0].roles).toEqual([]);

    // The whole point of the wave — the auth table is untouched by ingest.
    expect(await orgLogins()).toHaveLength(0);

    const ticketRows = await orgTickets();
    expect(ticketRows).toHaveLength(1);
    expect(ticketRows[0].requesterContactId).toBe(contactRows[0].id);
    expect(ticketRows[0].submittedBy).toBeNull();
    expect(ticketRows[0].submitterEmail).toBe(from);

    expect(autoresponseMock).toHaveBeenCalledTimes(1);
  });

  it('the same sender writing again reuses the contact instead of minting a second', async () => {
    const from = `repeat@${fx.senderDomain}`;

    await ingest(from, { fromName: 'Repeat Customer' });
    await ingest(from.toUpperCase(), { fromName: 'Repeat Customer' });

    const contactRows = await orgContacts();
    expect(contactRows).toHaveLength(1);

    const ticketRows = await orgTickets();
    expect(ticketRows).toHaveLength(2);
    expect(new Set(ticketRows.map((t: any) => t.requesterContactId))).toEqual(new Set([contactRows[0].id]));
    expect(await orgLogins()).toHaveLength(0);
  });

  it('a shared mailbox leaves the link null, keeps the snapshot, and STILL acknowledges', async () => {
    const from = `support@${fx.senderDomain}`;
    // Two real people behind one address — the shape that has no honest answer.
    await admin().insert(contacts).values([
      { orgId: fx.orgId, email: from, name: 'Support One' },
      { orgId: fx.orgId, email: from, name: 'Support Two' },
    ]);

    await ingest(from, { fromName: 'Acme Support' });

    // No third contact invented, and neither existing one picked.
    expect(await orgContacts()).toHaveLength(2);
    expect(await orgLogins()).toHaveLength(0);

    const ticketRows = await orgTickets();
    expect(ticketRows).toHaveLength(1);
    expect(ticketRows[0].requesterContactId).toBeNull();
    expect(ticketRows[0].submittedBy).toBeNull();
    // The snapshot is what the notify worker mails and what threadMatcher
    // binds on: an unresolvable person must not cost the customer their reply.
    expect(ticketRows[0].submitterEmail).toBe(from);
    expect(ticketRows[0].submitterName).toBe('Acme Support');

    // An accepted known sender is acknowledged even when nobody can be named.
    expect(autoresponseMock).toHaveBeenCalledTimes(1);
  });

  it('an invited portal user sees the ticket they emailed in, via the contact link', async () => {
    const from = `linked@${fx.senderDomain}`;
    await ingest(from, { fromName: 'Linked Customer' });

    const [contact] = await orgContacts();
    const [emailedTicket] = await orgTickets();
    expect(emailedTicket.requesterContactId).toBe(contact.id);

    // The invite route's outcome: a login bound to that contact.
    const [login] = await admin()
      .insert(portalUsers)
      .values({ orgId: fx.orgId, email: from, name: 'Linked Customer', contactId: contact.id })
      .returning({ id: portalUsers.id, contactId: portalUsers.contactId });

    // The real predicate, compiled by Postgres — not a shape assertion.
    const visible = await admin()
      .select({ id: tickets.id })
      .from(tickets)
      .where(and(eq(tickets.orgId, fx.orgId), portalTicketOwnership(login)));
    expect(visible.map((t: any) => t.id)).toEqual([emailedTicket.id]);

    // Control: an unlinked login in the same org sees nothing, and the
    // predicate must NOT degenerate into `requester_contact_id = NULL`.
    const [stranger] = await admin()
      .insert(portalUsers)
      .values({ orgId: fx.orgId, email: `stranger-${uniqueSuffix()}@${fx.senderDomain}`, contactId: null })
      .returning({ id: portalUsers.id, contactId: portalUsers.contactId });
    const strangerVisible = await admin()
      .select({ id: tickets.id })
      .from(tickets)
      .where(and(eq(tickets.orgId, fx.orgId), portalTicketOwnership(stranger)));
    expect(strangerVisible).toHaveLength(0);
  });

  it('deleting the contact unlinks the ticket without nulling its org_id', async () => {
    // The column-list `ON DELETE SET NULL (requester_contact_id)`: a bare
    // composite SET NULL would try to null the NOT NULL org_id and fail.
    const from = `deleteme@${fx.senderDomain}`;
    await ingest(from, { fromName: 'Doomed Contact' });
    const [contact] = await orgContacts();

    await admin().delete(contacts).where(eq(contacts.id, contact.id));

    const ticketRows = await orgTickets();
    expect(ticketRows).toHaveLength(1);
    expect(ticketRows[0].requesterContactId).toBeNull();
    const [row] = await admin().select({ orgId: tickets.orgId }).from(tickets).where(eq(tickets.id, ticketRows[0].id));
    expect(row.orgId).toBe(fx.orgId);
  });
});


// ---------------------------------------------------------------------------
// Cross-org movement: the composite FK, and the two paths that re-stamp
// tickets.org_id out from under it (#3258 W03 review C1).
// ---------------------------------------------------------------------------

/** A committed contact + ticket pair in `orgId`, optionally bound to a device. */
async function seedLinkedTicket(orgId: string, partnerId: string, deviceId: string | null = null) {
  const suffix = uniqueSuffix();
  const [contact] = await admin()
    .insert(contacts)
    .values({ orgId, email: `linked-${suffix}@example.test`, name: 'Linked Person' })
    .returning({ id: contacts.id });
  const [ticket] = await admin()
    .insert(tickets)
    .values({
      orgId,
      partnerId,
      ticketNumber: `LNK-${suffix}`,
      internalNumber: `T-2026-${suffix.slice(-4)}`,
      subject: 'Contact-linked',
      status: 'open',
      source: 'email',
      deviceId,
      submitterEmail: `linked-${suffix}@example.test`,
      submitterName: 'Linked Person',
      requesterContactId: contact.id,
    })
    .returning({ id: tickets.id });
  return { contactId: contact.id, ticketId: ticket.id };
}

describe('tickets_requester_contact_org_fk — the composite same-org FK', () => {
  it('refuses a ticket in org A that names a contact belonging to org B', async () => {
    const otherOrg = await createOrganization({ partnerId: fx.partnerId });
    seeded.orgIds.push(otherOrg.id);
    const [foreign] = await admin()
      .insert(contacts)
      .values({ orgId: otherOrg.id, email: `foreign-${uniqueSuffix()}@example.test`, name: 'Foreign' })
      .returning({ id: contacts.id });

    // The app-layer guard (assertRequesterContactInOrg) is bypassed on purpose:
    // this asserts the DATABASE makes a cross-org requester unrepresentable,
    // which is what makes the guard a nicety rather than the boundary.
    const forge = admin()
      .insert(tickets)
      .values({
        orgId: fx.orgId,
        partnerId: fx.partnerId,
        ticketNumber: `FORGE-${uniqueSuffix()}`,
        internalNumber: `T-2026-${uniqueSuffix().slice(-4)}`,
        subject: 'Cross-tenant requester',
        status: 'open',
        source: 'manual',
        requesterContactId: foreign.id,
      });

    // Drizzle wraps the driver error, so the pg code lives on `cause`. The
    // CONSTRAINT NAME is asserted too: a bare 23503 would also be satisfied by
    // the org_id or partner_id FK, which is not what this test is about.
    await expect(forge).rejects.toMatchObject({
      cause: { code: '23503', constraint_name: 'tickets_requester_contact_org_fk' },
    });
  });
});

describe('device org-move detaches the requester (breeze_cascade_device_org_id)', () => {
  it('moves a device carrying a contact-linked ticket without 23503, and nulls the link', async () => {
    const targetOrg = await createOrganization({ partnerId: fx.partnerId });
    seeded.orgIds.push(targetOrg.id);
    const site = await createSite({ orgId: fx.orgId });
    const suffix = uniqueSuffix();
    const [device] = await admin()
      .insert(devices)
      .values({
        orgId: fx.orgId,
        siteId: site.id,
        agentId: `w03-move-${suffix}`,
        hostname: `w03-${suffix}`,
        osType: 'windows',
        osVersion: '10.0.19041',
        architecture: 'x64',
        agentVersion: '0.1.0',
      })
      .returning({ id: devices.id });
    const { ticketId, contactId } = await seedLinkedTicket(fx.orgId, fx.partnerId, device.id);

    const targetSite = await createSite({ orgId: targetOrg.id });
    // The trigger is the DB-side path EVERY caller goes through (the route in
    // routes/devices/moveOrg.ts only mirrors it). Its generic loop re-stamps
    // tickets.org_id, and that statement is the one the DEFERRABLE INITIALLY
    // IMMEDIATE composite FK checks — so without the detach this UPDATE raises
    // 23503 and the whole device move fails.
    await expect(
      admin().execute(
        sql`UPDATE devices SET org_id = ${targetOrg.id}::uuid, site_id = ${targetSite.id}::uuid WHERE id = ${device.id}::uuid`,
      ),
    ).resolves.toBeDefined();

    const [row] = await admin()
      .select({ orgId: tickets.orgId, requesterContactId: tickets.requesterContactId, submitterEmail: tickets.submitterEmail })
      .from(tickets)
      .where(eq(tickets.id, ticketId));
    expect(row.orgId).toBe(targetOrg.id);
    expect(row.requesterContactId).toBeNull();
    // The SNAPSHOT survives: "who filed this" is still answerable after the
    // move, it just no longer points at a live contact row.
    expect(row.submitterEmail).toBeTruthy();

    // The contact itself stays with its organization.
    const [stillHome] = await admin().select({ orgId: contacts.orgId }).from(contacts).where(eq(contacts.id, contactId));
    expect(stillHome.orgId).toBe(fx.orgId);
  });
});

describe('org merge KEEPS the requester link', () => {
  let priorDrain: string | undefined;

  beforeEach(() => {
    priorDrain = process.env.ORG_MERGE_FENCE_DRAIN_MS;
    process.env.ORG_MERGE_FENCE_DRAIN_MS = '0';
  });
  afterEach(() => {
    if (priorDrain === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS;
    else process.env.ORG_MERGE_FENCE_DRAIN_MS = priorDrain;
  });

  it('re-tenants contact AND ticket to the survivor with the link intact, device move included', async () => {
    // The merge repoints `devices` (REPOINT_TABLES), which fires
    // breeze_cascade_device_org_id() — the same trigger the device-move case
    // above relies on to DETACH. Here the contact is moving to the survivor
    // alongside the ticket, so detaching would silently destroy the customer's
    // portal ownership of their own history. The trigger's merge-fence gate is
    // what makes these two cases differ, and this is the test that would go
    // red if that gate were dropped.
    const survivor = await createOrganization({ partnerId: fx.partnerId });
    seeded.orgIds.push(survivor.id);
    const site = await createSite({ orgId: fx.orgId });
    const suffix = uniqueSuffix();
    const [device] = await admin()
      .insert(devices)
      .values({
        orgId: fx.orgId,
        siteId: site.id,
        agentId: `w03-merge-${suffix}`,
        hostname: `w03m-${suffix}`,
        osType: 'windows',
        osVersion: '10.0.19041',
        architecture: 'x64',
        agentVersion: '0.1.0',
      })
      .returning({ id: devices.id });
    const { ticketId, contactId } = await seedLinkedTicket(fx.orgId, fx.partnerId, device.id);

    await orgMergeModule.executeOrgMerge({
      loserOrgId: fx.orgId,
      survivorOrgId: survivor.id,
      partnerId: fx.partnerId,
      performedBy: randomUUID(),
      performedByEmail: `merge-actor-${suffix}@example.test`,
    });

    const [ticketRow] = await admin()
      .select({ orgId: tickets.orgId, requesterContactId: tickets.requesterContactId })
      .from(tickets)
      .where(eq(tickets.id, ticketId));
    const [contactRow] = await admin()
      .select({ orgId: contacts.orgId })
      .from(contacts)
      .where(eq(contacts.id, contactId));

    expect(ticketRow.orgId).toBe(survivor.id);
    expect(contactRow.orgId).toBe(survivor.id);
    // The whole point: SAME contact, still linked.
    expect(ticketRow.requesterContactId).toBe(contactId);
  });
});

describe('2026-10-04-100000-ticket-requester-contact.sql', () => {
  it('is idempotent — a second apply is a no-op, not a duplicate-constraint abort', async () => {
    const text = readFileSync(MIGRATION_FILE, 'utf8');
    await admin().execute(sql.raw(text));
    await admin().execute(sql.raw(text));

    const [{ count: fkCount }] = await admin().execute(
      sql`SELECT count(*)::int AS count FROM pg_constraint WHERE conname = 'tickets_requester_contact_org_fk'`,
    );
    expect(fkCount).toBe(1);
    const [{ count: idxCount }] = await admin().execute(
      sql`SELECT count(*)::int AS count FROM pg_indexes WHERE indexname = 'tickets_requester_contact_idx'`,
    );
    expect(idxCount).toBe(1);
  });

  it('backfills requester_contact_id from a portal login that already carries a contact', async () => {
    const email = `backfill-${uniqueSuffix()}@${fx.senderDomain}`;
    const [contact] = await admin()
      .insert(contacts)
      .values({ orgId: fx.orgId, email, name: 'Backfill Target' })
      .returning({ id: contacts.id });
    const [login] = await admin()
      .insert(portalUsers)
      .values({ orgId: fx.orgId, email, name: 'Backfill Target', contactId: contact.id })
      .returning({ id: portalUsers.id });
    // A pre-W03 ticket: a portal login, no contact link.
    const [legacy] = await admin()
      .insert(tickets)
      .values({
        orgId: fx.orgId,
        partnerId: fx.partnerId,
        ticketNumber: `LEGACY-${uniqueSuffix()}`,
        internalNumber: `T-2026-${uniqueSuffix().slice(-4)}`,
        subject: 'Filed before W03',
        status: 'open',
        source: 'portal',
        submittedBy: login.id,
      })
      .returning({ id: tickets.id });

    await admin().execute(sql.raw(readFileSync(MIGRATION_FILE, 'utf8')));

    const [row] = await admin()
      .select({ requesterContactId: tickets.requesterContactId })
      .from(tickets)
      .where(eq(tickets.id, legacy.id));
    expect(row.requesterContactId).toBe(contact.id);
  });

  it('skips a login whose contact lives in ANOTHER org instead of aborting the file', async () => {
    // When THIS migration shipped, portal_users.contact_id was a SINGLE-column
    // FK to contacts(id): nothing in the schema forced the login and its
    // contact into the same org. Such a drifted row makes the backfill propose
    // a pair the composite FK rejects, and a 23503 inside a migration aborts
    // the WHOLE file — on every database that has the drift, with no way to
    // skip it. The `EXISTS ... c.org_id = t.org_id` guard in the backfill is
    // what keeps that from happening, and this is its test.
    //
    // 2026-10-04-100002-portal-users-contact-composite-fk.sql later closed the
    // gap at the source, so the drift is no longer representable and has to be
    // forged with that constraint dropped — which is exactly the state a
    // database replaying migrations in order is in when THIS file runs.
    const otherOrg = await createOrganization({ partnerId: fx.partnerId });
    seeded.orgIds.push(otherOrg.id);
    const suffix = uniqueSuffix();
    const [foreignContact] = await admin()
      .insert(contacts)
      .values({ orgId: otherOrg.id, email: `drift-${suffix}@example.test`, name: 'Drifted' })
      .returning({ id: contacts.id });
    await admin().execute(sql`ALTER TABLE portal_users DROP CONSTRAINT IF EXISTS portal_users_contact_org_fk`);
    let ticketId: string;
    try {
      const [login] = await admin()
        .insert(portalUsers)
        .values({ orgId: fx.orgId, email: `drift-${suffix}@example.test`, name: 'Drifted', contactId: foreignContact.id })
        .returning({ id: portalUsers.id });
      const [ticket] = await admin()
        .insert(tickets)
        .values({
          orgId: fx.orgId,
          partnerId: fx.partnerId,
          ticketNumber: `DRIFT-${suffix}`,
          internalNumber: `T-2026-${suffix.slice(-4)}`,
          subject: 'Drifted login',
          status: 'open',
          source: 'portal',
          submittedBy: login.id,
        })
        .returning({ id: tickets.id });
      ticketId = ticket.id;

      await expect(admin().execute(sql.raw(readFileSync(MIGRATION_FILE, 'utf8')))).resolves.toBeDefined();
    } finally {
      // Restore the constraint for the rest of the shard. Replaying the later
      // migration is the honest way to do it — it nulls the forged link on its
      // way past, which is the cleanup that file exists to perform.
      await admin().execute(sql.raw(readFileSync(PORTAL_USER_FK_MIGRATION_FILE, 'utf8')));
    }

    // Assert the restore landed HERE, at its source. Leaving portal_users
    // unconstrained would blame whichever suite in this shard next touches
    // contact_id — and a replay of 2026-08-19-contacts.sql (whose FK guard is
    // name-only) would quietly resurrect the superseded single-column FK too.
    const restored = (await admin().execute(sql`
      SELECT conname FROM pg_constraint
       WHERE contype = 'f'
         AND conrelid = 'portal_users'::regclass
         AND confrelid = 'contacts'::regclass
       ORDER BY conname
    `)) as unknown as Array<{ conname: string }>;
    expect(restored.map((r) => r.conname)).toEqual(['portal_users_contact_org_fk']);

    const [row] = await admin()
      .select({ requesterContactId: tickets.requesterContactId })
      .from(tickets)
      .where(eq(tickets.id, ticketId!));
    // Left unlinked — recoverable — rather than blocking the deploy.
    expect(row.requesterContactId).toBeNull();
  });
});
