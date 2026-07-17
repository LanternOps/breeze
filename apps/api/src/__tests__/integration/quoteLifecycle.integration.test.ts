import './setup';
import { describe, expect, it, vi } from 'vitest';

// Fire-and-forget event bus (markQuoteViewed emits quote.viewed on first view) —
// mocked like emitInvoiceEvent in the invoice integration suites so the test
// never touches a real BullMQ queue.
vi.mock('../../services/quoteEvents', () => ({ emitQuoteEvent: vi.fn().mockResolvedValue(undefined) }));
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { quotes } from '../../db/schema/quotes';
import { organizations } from '../../db/schema/orgs';
import { createPartner, createOrganization } from './db-utils';
import { createQuote, addManualLine } from '../../services/quoteService';
import { sendQuote, markQuoteViewed, declineQuoteByActor } from '../../services/quoteLifecycle';
import type { QuoteActor } from '../../services/quoteTypes';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seed() {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    return { partner, org };
  });
}
function ctxFor(orgId: string, partnerId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [partnerId], userId: null };
}
function actorFor(orgId: string, partnerId: string): QuoteActor {
  return { userId: null, partnerId, accessibleOrgIds: [orgId] };
}

describe('quote lifecycle', () => {
  runDb('sendQuote assigns a number, sets sent + sentAt, returns an accept URL', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id);
    const actor = actorFor(org.id, partner.id);
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    await withDbAccessContext(ctx, () => addManualLine(created.id, { sourceType: 'manual', description: 'Setup', quantity: 1, unitPrice: 100, taxable: false, customerVisible: true, recurrence: 'one_time' } as any, actor));

    const result = await withDbAccessContext(ctx, () => sendQuote(created.id, actor));
    expect(result.quote.status).toBe('sent');
    expect(result.quote.quoteNumber).toMatch(/^Q-\d{4}-\d{4}$/);
    expect(result.quote.sentAt).toBeTruthy();
    expect(result.acceptUrl).toContain('/quote/');
  });

  runDb('sendQuote freezes the org billing address into the quote bill-to snapshot', async () => {
    const { partner, org } = await seed();
    // Save a Billing address on the org (what the customer/org "Billing address" tab writes).
    await withSystemDbAccessContext(() => db.update(organizations).set({
      taxId: 'TAX-777',
      billingAddressLine1: '500 Congress Ave', billingAddressLine2: 'Floor 9',
      billingAddressCity: 'Austin', billingAddressRegion: 'TX',
      billingAddressPostalCode: '78701', billingAddressCountry: 'US',
    }).where(eq(organizations.id, org.id)));

    const ctx = ctxFor(org.id, partner.id);
    const actor = actorFor(org.id, partner.id);
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    await withDbAccessContext(ctx, () => addManualLine(created.id, { sourceType: 'manual', description: 'Setup', quantity: 1, unitPrice: 100, taxable: false, customerVisible: true, recurrence: 'one_time' } as any, actor));

    await withDbAccessContext(ctx, () => sendQuote(created.id, actor));

    const [row] = await withSystemDbAccessContext(() => db.select().from(quotes).where(eq(quotes.id, created.id)).limit(1));
    expect(row!.billToAddress).toEqual({
      line1: '500 Congress Ave', line2: 'Floor 9', city: 'Austin',
      region: 'TX', postalCode: '78701', country: 'US',
    });
    expect(row!.billToName).toBe(org.name); // no draft override → org name
    expect(row!.billToTaxId).toBe('TAX-777');
  });

  runDb('markQuoteViewed flips sent→viewed and stamps first_viewed_at once', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id);
    const actor = actorFor(org.id, partner.id);
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    await withDbAccessContext(ctx, () => sendQuote(created.id, actor));
    await markQuoteViewed(created.id, org.id);
    const [v1] = await withSystemDbAccessContext(() => db.select().from(quotes).where(eq(quotes.id, created.id)));
    expect(v1!.status).toBe('viewed');
    const firstViewed = v1!.firstViewedAt;
    await markQuoteViewed(created.id, org.id); // idempotent
    const [v2] = await withSystemDbAccessContext(() => db.select().from(quotes).where(eq(quotes.id, created.id)));
    expect(v2!.firstViewedAt).toEqual(firstViewed);
    // quote.viewed fires on the FIRST view only — the second (idempotent) view
    // must not re-notify.
    const { emitQuoteEvent } = await import('../../services/quoteEvents');
    expect(vi.mocked(emitQuoteEvent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(emitQuoteEvent)).toHaveBeenCalledWith({ type: 'quote.viewed', quoteId: created.id, orgId: org.id, partnerId: partner.id });
  });

  runDb('declineQuoteByActor sets declined + reason', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id);
    const actor = actorFor(org.id, partner.id);
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    await withDbAccessContext(ctx, () => sendQuote(created.id, actor));
    const declined = await withDbAccessContext(ctx, () => declineQuoteByActor(created.id, 'Budget cut', actor));
    expect(declined.status).toBe('declined');
    expect(declined.declineReason).toBe('Budget cut');
    expect(declined.declinedAt).toBeTruthy();
  });

  // Phase 3 read-time expiry guard: an expired quote is terminal — it can't be
  // declined (nor accepted) even before the sweep flips its status.
  runDb('declineQuoteByActor rejects a quote past its expiry_date', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id);
    const actor = actorFor(org.id, partner.id);
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    await withDbAccessContext(ctx, () => sendQuote(created.id, actor));
    await withSystemDbAccessContext(() => db.update(quotes).set({ expiryDate: '2000-01-01' }).where(eq(quotes.id, created.id)));
    await expect(
      withDbAccessContext(ctx, () => declineQuoteByActor(created.id, 'too late', actor)),
    ).rejects.toMatchObject({ status: 410, code: 'QUOTE_EXPIRED' });
  });

  runDb('sendQuote rejects a non-draft', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id);
    const actor = actorFor(org.id, partner.id);
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    await withDbAccessContext(ctx, () => sendQuote(created.id, actor));
    await expect(withDbAccessContext(ctx, () => sendQuote(created.id, actor))).rejects.toMatchObject({ status: 409 });
  });
});
