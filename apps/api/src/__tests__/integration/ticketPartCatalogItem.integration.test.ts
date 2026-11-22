/**
 * Ticket parts may reference a catalog item (catalogItemId). The reference must
 * belong to the ticket's partner: the ticket_parts FK only proves the item
 * exists, and catalog_items RLS does not apply under system scope, so the
 * service resolves the item against the ticket org's partner on both the create
 * and the update path.
 */
import './setup';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../services/timeEntryEvents', () => ({ emitTimeEntryEvent: vi.fn().mockResolvedValue(undefined) }));

import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext, withDbAccessContext, type DbAccessContext } from '../../db';
import { partners, organizations, users, tickets, ticketParts } from '../../db/schema';
import { catalogItems } from '../../db/schema/catalog';
import { addTicketPart, updateTicketPart, type TimeEntryActor } from '../../services/timeEntryService';

const runDb = it.runIf(!!process.env.DATABASE_URL);

interface Fixture {
  partnerId: string;
  orgId: string;
  userId: string;
  ticketId: string;
  ownItemId: string;
  otherPartnerItemId: string;
}

async function seedCatalogItem(partnerId: string, name: string): Promise<string> {
  const [row] = await db.insert(catalogItems).values({
    partnerId, itemType: 'hardware', name, billingType: 'one_time', taxable: true, isBundle: false, costCurrency: 'USD',
  }).returning({ id: catalogItems.id });
  return row!.id;
}

async function seedFixture(): Promise<Fixture> {
  const suffix = Math.random().toString(36).slice(2, 10);
  return withSystemDbAccessContext(async () => {
    const [p] = await db.insert(partners).values({
      name: `Parts ${suffix}`, slug: `parts-${suffix}`, type: 'msp', plan: 'pro', status: 'active', currencyCode: 'USD',
    }).returning({ id: partners.id });
    const [other] = await db.insert(partners).values({
      name: `Parts other ${suffix}`, slug: `parts-other-${suffix}`, type: 'msp', plan: 'pro', status: 'active', currencyCode: 'USD',
    }).returning({ id: partners.id });
    const [o] = await db.insert(organizations).values({
      partnerId: p!.id, name: `Parts org ${suffix}`, slug: `parts-org-${suffix}`, currencyCode: 'USD',
    }).returning({ id: organizations.id });
    const [u] = await db.insert(users).values({
      partnerId: p!.id, orgId: o!.id, email: `parts-${suffix}@example.test`, name: `Tech ${suffix}`, status: 'active',
    }).returning({ id: users.id });
    const [t] = await db.insert(tickets).values({
      orgId: o!.id, partnerId: p!.id, ticketNumber: `PRT-${suffix}`, subject: `Parts ticket ${suffix}`, source: 'manual',
    }).returning({ id: tickets.id });
    return {
      partnerId: p!.id, orgId: o!.id, userId: u!.id, ticketId: t!.id,
      ownItemId: await seedCatalogItem(p!.id, 'Own SSD'),
      otherPartnerItemId: await seedCatalogItem(other!.id, 'Other partner SSD'),
    };
  });
}

function actor(f: Fixture): TimeEntryActor {
  return { userId: f.userId, partnerId: f.partnerId, manageAll: true, manageBilling: true, accessibleOrgIds: [f.orgId] };
}
function ctx(f: Fixture): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: [f.orgId], accessiblePartnerIds: [f.partnerId], userId: f.userId };
}

const partInput = (catalogItemId: string | null) => ({
  description: 'SSD', quantity: 1, unitPrice: 50, catalogItemId,
});

async function partsOn(ticketId: string) {
  return withSystemDbAccessContext(() => db.select().from(ticketParts).where(eq(ticketParts.ticketId, ticketId)));
}

describe('ticket part catalog item reference', () => {
  runDb('addTicketPart rejects a catalogItemId owned by a different partner (partner and system scope)', async () => {
    const f = await seedFixture();
    await expect(
      withDbAccessContext(ctx(f), () => addTicketPart(f.ticketId, partInput(f.otherPartnerItemId), actor(f)))
    ).rejects.toMatchObject({ code: 'CATALOG_ITEM_NOT_FOUND', status: 404 });
    await expect(
      withSystemDbAccessContext(() => addTicketPart(f.ticketId, partInput(f.otherPartnerItemId), actor(f)))
    ).rejects.toMatchObject({ code: 'CATALOG_ITEM_NOT_FOUND', status: 404 });
    expect(await partsOn(f.ticketId)).toHaveLength(0);
  });

  runDb('addTicketPart keeps a catalogItemId owned by the ticket partner', async () => {
    const f = await seedFixture();
    const part = await withDbAccessContext(ctx(f), () => addTicketPart(f.ticketId, partInput(f.ownItemId), actor(f)));
    expect(part.catalogItemId).toBe(f.ownItemId);
  });

  runDb('updateTicketPart rejects a catalogItemId owned by a different partner and leaves the part unchanged', async () => {
    const f = await seedFixture();
    const part = await withDbAccessContext(ctx(f), () => addTicketPart(f.ticketId, partInput(f.ownItemId), actor(f)));
    await expect(
      withDbAccessContext(ctx(f), () => updateTicketPart(part.id, { catalogItemId: f.otherPartnerItemId }, actor(f)))
    ).rejects.toMatchObject({ code: 'CATALOG_ITEM_NOT_FOUND', status: 404 });
    await expect(
      withSystemDbAccessContext(() => updateTicketPart(part.id, { catalogItemId: f.otherPartnerItemId }, actor(f)))
    ).rejects.toMatchObject({ code: 'CATALOG_ITEM_NOT_FOUND', status: 404 });
    const [row] = await partsOn(f.ticketId);
    expect(row!.catalogItemId).toBe(f.ownItemId);
  });

  runDb('updateTicketPart still sets an own-partner catalogItemId and clears it with null', async () => {
    const f = await seedFixture();
    const part = await withDbAccessContext(ctx(f), () => addTicketPart(f.ticketId, partInput(null), actor(f)));
    const linked = await withDbAccessContext(ctx(f), () => updateTicketPart(part.id, { catalogItemId: f.ownItemId }, actor(f)));
    expect(linked.catalogItemId).toBe(f.ownItemId);
    const cleared = await withDbAccessContext(ctx(f), () => updateTicketPart(part.id, { catalogItemId: null }, actor(f)));
    expect(cleared.catalogItemId).toBeNull();
  });
});
