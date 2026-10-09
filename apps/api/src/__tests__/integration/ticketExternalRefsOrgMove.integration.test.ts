/**
 * ticket_external_refs org re-stamp on move, BOTH axes (Partner API tickets,
 * design doc §6).
 *
 * The table denormalizes org_id from its ticket (shape 1) and has NO
 * device_id, so neither the generic device loop nor
 * `breeze_cascade_device_org_id()` reaches it. Both movers re-stamp it
 * explicitly:
 *
 *   - ticket axis: TICKET_ORG_DENORMALIZED_TABLES drives moveTicketOrg's loop;
 *   - device axis: CUSTOM_ORG_REWRITE_TABLES + hand-written statements through
 *     the tickets join in services/deviceOrgMove/moveDeviceOrgInTransaction.ts.
 *
 * Like ticket_checklist_items, a ref's org follows its ticket's by a composite
 * (ticket_id, org_id) -> tickets(id, org_id) FK, DEFERRABLE INITIALLY
 * IMMEDIATE, which both movers defer BY NAME (the ticket-axis case below runs
 * the real moveTicketOrg, so a missing name there is a 23503 here). Unlike
 * it, a ref is also pinned to ONE partner by its composite FKs —
 * (principal, partner_id) and (org_id, partner_id), the latter DEFERRABLE
 * INITIALLY IMMEDIATE for org merge. So the device axis has
 * a second case the ticket axis cannot reach (moveTicketOrg refuses a
 * cross-partner move): a CROSS-partner device move must DELETE the ref, or the
 * re-stamp 23503s and aborts the whole move.
 *
 * The mocked unit suites assert statement SHAPE (moveOrg.coverage.test.ts,
 * ticketOrgMoveLockOrder.test.ts only checks the lists agree with each
 * other); this proves Postgres actually moves — or drops — the rows.
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  devices, organizations, partnerApiIdempotencyKeys, partnerServicePrincipals, partners, sites, ticketExternalRefs, tickets, users,
} from '../../db/schema';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';
import { moveTicketOrg } from '../../services/ticketService';

const seededPartnerIds: string[] = [];
const seededOrgIds: string[] = [];

const uniqueSuffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function seedDeviceTicketWithRef() {
  const adminDb = getTestDb() as any;
  const unique = uniqueSuffix();

  const partner = await createPartner();
  const otherPartner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const foreignOrg = await createOrganization({ partnerId: otherPartner.id });
  const siteA = await createSite({ orgId: orgA.id });
  const actor = await createUser({
    partnerId: partner.id, orgId: null, email: `ref-move-actor-${unique}@example.test`,
  });

  seededPartnerIds.push(partner.id, otherPartner.id);
  seededOrgIds.push(orgA.id, orgB.id, foreignOrg.id);

  const [device] = await adminDb.insert(devices).values({
    orgId: orgA.id,
    siteId: siteA.id,
    agentId: `ref-move-device-${unique}`,
    hostname: `ref-move-host-${unique}`,
    osType: 'windows',
    osVersion: '10.0.19041',
    architecture: 'x64',
    agentVersion: '0.1.0',
  }).returning();

  const [ticket] = await adminDb.insert(tickets).values({
    orgId: orgA.id,
    partnerId: partner.id,
    ticketNumber: `REF-MOVE-${unique}`,
    subject: 'ticket_external_refs org re-stamp test',
    deviceId: device!.id,
    source: 'api',
  }).returning();

  const [principal] = await adminDb.insert(partnerServicePrincipals).values({
    partnerId: partner.id,
    name: `Ref move ${unique}`,
    scopes: ['tickets:read', 'tickets:write'],
    createdBy: actor.id,
    updatedBy: actor.id,
  }).returning();

  const [ref] = await adminDb.insert(ticketExternalRefs).values({
    ticketId: ticket!.id,
    orgId: orgA.id,
    partnerId: partner.id,
    partnerServicePrincipalId: principal!.id,
    externalId: `PSA-${unique}`,
  }).returning();

  // Wave 3: an X-Idempotency-Key claim bound to the same ticket.
  const [claim] = await adminDb.insert(partnerApiIdempotencyKeys).values({
    partnerId: partner.id,
    partnerServicePrincipalId: principal!.id,
    orgId: orgA.id,
    ticketId: ticket!.id,
    route: 'tickets.comment',
    idempotencyKey: `key-${unique}`,
    requestFingerprint: 'a'.repeat(64),
  }).returning();

  return {
    partner, otherPartner, orgA, orgB, foreignOrg, actor, unique,
    device: device!, ticket: ticket!, principal: principal!, ref: ref!, claim: claim!,
  };
}

/**
 * Replays the device mover's statement sequence for this table: defer the
 * composite (ticket_id, org_id) FK BY NAME, move the device's tickets (org AND
 * partner, as the mover does), drop the refs that cannot follow to another
 * partner, re-stamp the rest — one transaction, that order.
 */
async function runDeviceAxisMove(deviceId: string, targetOrgId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET CONSTRAINTS ticket_external_refs_ticket_org_fk, partner_api_idempotency_keys_ticket_org_fk DEFERRED`);
    await tx.execute(sql`
      UPDATE tickets SET org_id = ${targetOrgId}::uuid,
             partner_id = (SELECT partner_id FROM organizations WHERE id = ${targetOrgId}::uuid)
       WHERE device_id = ${deviceId}::uuid
    `);
    await tx.execute(sql`
      DELETE FROM ticket_external_refs
       WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id = ${deviceId}::uuid)
         AND partner_id IS DISTINCT FROM (SELECT partner_id FROM organizations WHERE id = ${targetOrgId}::uuid)
    `);
    await tx.execute(sql`
      UPDATE ticket_external_refs SET org_id = ${targetOrgId}::uuid
       WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id = ${deviceId}::uuid)
    `);
    await tx.execute(sql`
      DELETE FROM partner_api_idempotency_keys
       WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id = ${deviceId}::uuid)
         AND partner_id IS DISTINCT FROM (SELECT partner_id FROM organizations WHERE id = ${targetOrgId}::uuid)
    `);
    await tx.execute(sql`
      UPDATE partner_api_idempotency_keys SET org_id = ${targetOrgId}::uuid
       WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id = ${deviceId}::uuid)
    `);
  });
}

async function claimRow(claimId: string): Promise<{ org_id: string; partner_id: string } | undefined> {
  const [row] = (await getTestDb().execute(sql`
    SELECT org_id, partner_id FROM partner_api_idempotency_keys WHERE id = ${claimId}
  `)) as unknown as Array<{ org_id: string; partner_id: string }>;
  return row;
}

async function refRow(refId: string): Promise<{ org_id: string; partner_id: string } | undefined> {
  const [row] = (await getTestDb().execute(sql`
    SELECT org_id, partner_id FROM ticket_external_refs WHERE id = ${refId}
  `)) as unknown as Array<{ org_id: string; partner_id: string }>;
  return row;
}

afterAll(async () => {
  if (seededPartnerIds.length === 0) return;
  const adminDb = getTestDb() as any;
  const orgList = sql.join(seededOrgIds.map((id) => sql`${id}`), sql`, `);
  const partnerList = sql.join(seededPartnerIds.map((id) => sql`${id}`), sql`, `);

  await adminDb.delete(partnerApiIdempotencyKeys).where(sql`${partnerApiIdempotencyKeys.partnerId} IN (${partnerList})`);
  await adminDb.delete(ticketExternalRefs).where(sql`${ticketExternalRefs.partnerId} IN (${partnerList})`);
  await adminDb.delete(tickets).where(sql`${tickets.orgId} IN (${orgList})`);
  await adminDb.delete(devices).where(sql`${devices.orgId} IN (${orgList})`);
  await adminDb.delete(sites).where(sql`${sites.orgId} IN (${orgList})`);
  await adminDb.delete(partnerServicePrincipals).where(sql`${partnerServicePrincipals.partnerId} IN (${partnerList})`);
  await adminDb.delete(organizations).where(sql`${organizations.id} IN (${orgList})`);
  await adminDb.delete(users).where(sql`${users.partnerId} IN (${partnerList})`);
  await adminDb.delete(partners).where(sql`${partners.id} IN (${partnerList})`);
});

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('ticket_external_refs and partner_api_idempotency_keys follow their ticket on BOTH org-move axes', () => {
  runDb('the TICKET axis re-stamps org_id and keeps the ref with its principal', async () => {
    const f = await seedDeviceTicketWithRef();

    await withSystemDbAccessContext(() =>
      moveTicketOrg(f.ticket.id, f.orgB.id, { kind: 'user' as const, userId: f.actor.id }),
    );

    expect(await refRow(f.ref.id)).toEqual({ org_id: f.orgB.id, partner_id: f.partner.id });
    expect(await claimRow(f.claim.id)).toEqual({ org_id: f.orgB.id, partner_id: f.partner.id });
  });

  runDb('the DEVICE axis re-stamps org_id through the tickets join inside one partner', async () => {
    const f = await seedDeviceTicketWithRef();

    await withSystemDbAccessContext(() => runDeviceAxisMove(f.device.id, f.orgB.id));

    expect(await refRow(f.ref.id)).toEqual({ org_id: f.orgB.id, partner_id: f.partner.id });
    expect(await claimRow(f.claim.id)).toEqual({ org_id: f.orgB.id, partner_id: f.partner.id });
  });

  runDb('a CROSS-partner device move deletes the ref instead of aborting on the composite FK', async () => {
    const f = await seedDeviceTicketWithRef();

    await withSystemDbAccessContext(() => runDeviceAxisMove(f.device.id, f.foreignOrg.id));

    // The integration of the old partner can never read the ticket again; the
    // ref is gone and its external id is free for that integration to reuse.
    expect(await refRow(f.ref.id)).toBeUndefined();
    expect(await claimRow(f.claim.id)).toBeUndefined();
    const [moved] = (await getTestDb().execute(sql`
      SELECT org_id, partner_id FROM tickets WHERE id = ${f.ticket.id}
    `)) as unknown as Array<{ org_id: string; partner_id: string }>;
    expect(moved).toEqual({ org_id: f.foreignOrg.id, partner_id: f.otherPartner.id });
  });

  runDb('without the delete, the cross-partner re-stamp violates the composite org FK (the delete is load-bearing)', async () => {
    const f = await seedDeviceTicketWithRef();

    let code: string | undefined;
    try {
      await withSystemDbAccessContext(() =>
        db.transaction(async (tx) => {
          await tx.execute(sql`
            UPDATE ticket_external_refs SET org_id = ${f.foreignOrg.id}::uuid WHERE id = ${f.ref.id}::uuid
          `);
        }),
      );
    } catch (err) {
      code = (err as { cause?: { code?: string } } | undefined)?.cause?.code;
    }
    expect(code).toBe('23503');
    expect(await refRow(f.ref.id)).toEqual({ org_id: f.orgA.id, partner_id: f.partner.id });
  });

  runDb('the database refuses a ref whose org differs from its TICKET\'s org, even inside one partner (#7490)', async () => {
    const f = await seedDeviceTicketWithRef();
    const adminDb = getTestDb() as any;
    const [bare] = await adminDb.insert(tickets).values({
      orgId: f.orgA.id,
      partnerId: f.partner.id,
      ticketNumber: `REF-MOVE-ORG-${f.unique}`,
      subject: 'ticket_external_refs ticket/org coherence test',
      source: 'api',
    }).returning();

    // orgB is the same partner as the ticket and the principal: every other
    // FK is satisfiable, so the composite (ticket_id, org_id) FK is the only
    // thing that can refuse it — and does, even for the superuser.
    const drifted = await adminDb.insert(ticketExternalRefs).values({
      ticketId: bare!.id,
      orgId: f.orgB.id,
      partnerId: f.partner.id,
      partnerServicePrincipalId: f.principal.id,
      externalId: `PSA-drifted-${f.unique}`,
    }).then(() => null, (err: unknown) => err);
    const cause = (drifted as { cause?: { code?: string; constraint_name?: string } } | null)?.cause;
    expect(cause?.code).toBe('23503');
    expect(cause?.constraint_name).toBe('ticket_external_refs_ticket_org_fk');

    // And re-pointing an existing ref's org away from its ticket is refused the same way.
    const repointed = await adminDb.execute(sql`
      UPDATE ticket_external_refs SET org_id = ${f.orgB.id}::uuid WHERE id = ${f.ref.id}::uuid
    `).then(() => null, (err: unknown) => err);
    expect((repointed as { cause?: { constraint_name?: string } } | null)?.cause?.constraint_name).toBe('ticket_external_refs_ticket_org_fk');
    expect(await refRow(f.ref.id)).toEqual({ org_id: f.orgA.id, partner_id: f.partner.id });

    // Same rule for an X-Idempotency-Key claim bound to a ticket…
    const driftedClaim = await adminDb.insert(partnerApiIdempotencyKeys).values({
      partnerId: f.partner.id,
      partnerServicePrincipalId: f.principal.id,
      orgId: f.orgB.id,
      ticketId: bare!.id,
      route: 'tickets.comment',
      idempotencyKey: `drifted-${f.unique}`,
      requestFingerprint: 'a'.repeat(64),
    }).then(() => null, (err: unknown) => err);
    expect((driftedClaim as { cause?: { constraint_name?: string } } | null)?.cause?.constraint_name)
      .toBe('partner_api_idempotency_keys_ticket_org_fk');
    // …while a create claim, whose ticket_id is still NULL until the create
    // links it, is not a referencing row yet (MATCH SIMPLE) and is admitted.
    const [unlinked] = await adminDb.insert(partnerApiIdempotencyKeys).values({
      partnerId: f.partner.id,
      partnerServicePrincipalId: f.principal.id,
      orgId: f.orgB.id,
      ticketId: null,
      route: 'tickets.create',
      idempotencyKey: `unlinked-${f.unique}`,
      requestFingerprint: 'a'.repeat(64),
    }).returning({ id: partnerApiIdempotencyKeys.id });
    expect(unlinked?.id).toBeDefined();
  });

  runDb('the database refuses a ref whose principal or organization belongs to another partner', async () => {
    const f = await seedDeviceTicketWithRef();
    const adminDb = getTestDb() as any;
    // A ticket of its own: the seeded one already holds this principal's ref,
    // and (principal, ticket) is unique — that 23505 would mask the FK.
    const [bare] = await adminDb.insert(tickets).values({
      orgId: f.orgA.id,
      partnerId: f.partner.id,
      ticketNumber: `REF-MOVE-BARE-${f.unique}`,
      subject: 'ticket_external_refs tenant coherence test',
      source: 'api',
    }).returning();

    const foreignOrgRef = await adminDb.insert(ticketExternalRefs).values({
      ticketId: bare!.id,
      orgId: f.foreignOrg.id,
      partnerId: f.partner.id,
      partnerServicePrincipalId: f.principal.id,
      externalId: `PSA-foreign-org-${f.unique}`,
    }).then(() => null, (err: unknown) => err);
    expect((foreignOrgRef as { cause?: { code?: string } } | null)?.cause?.code).toBe('23503');

    const foreignPartnerRef = await adminDb.insert(ticketExternalRefs).values({
      ticketId: bare!.id,
      orgId: f.foreignOrg.id,
      partnerId: f.otherPartner.id,
      partnerServicePrincipalId: f.principal.id,
      externalId: `PSA-foreign-partner-${f.unique}`,
    }).then(() => null, (err: unknown) => err);
    expect((foreignPartnerRef as { cause?: { code?: string } } | null)?.cause?.code).toBe('23503');
  });

  runDb('a ref on an UNRELATED ticket in the same org is untouched by the device move', async () => {
    const f = await seedDeviceTicketWithRef();
    const adminDb = getTestDb() as any;
    const [sibling] = await adminDb.insert(tickets).values({
      orgId: f.orgA.id,
      partnerId: f.partner.id,
      ticketNumber: `REF-MOVE-SIBLING-${f.unique}`,
      subject: 'ticket_external_refs org re-stamp test — sibling, no device',
      source: 'api',
    }).returning();
    const [siblingRef] = await adminDb.insert(ticketExternalRefs).values({
      ticketId: sibling!.id,
      orgId: f.orgA.id,
      partnerId: f.partner.id,
      partnerServicePrincipalId: f.principal.id,
      externalId: `PSA-sibling-${f.unique}`,
    }).returning();

    await withSystemDbAccessContext(() => runDeviceAxisMove(f.device.id, f.orgB.id));

    expect((await refRow(f.ref.id))?.org_id).toBe(f.orgB.id);
    expect((await refRow(siblingRef!.id))?.org_id).toBe(f.orgA.id);
  });
});
