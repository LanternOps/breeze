import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { quotes, quoteAcceptances, quoteRecipients } from '../../db/schema/quotes';
import { invoices } from '../../db/schema/invoices';
import { contracts } from '../../db/schema/contracts';
import { organizations } from '../../db/schema/orgs';
import { createPartner, createOrganization, createUser } from './db-utils';
import { createQuote, addManualLine } from '../../services/quoteService';
import { acceptQuote } from '../../services/quoteAcceptService';
import type { QuoteActor } from '../../services/quoteTypes';

const runDb = it.runIf(!!process.env.DATABASE_URL);
function ctxFor(orgId: string, partnerId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [partnerId], userId: null };
}
function actorFor(orgId: string, partnerId: string): QuoteActor {
  return { userId: null, partnerId, accessibleOrgIds: [orgId] };
}

async function seed() {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    // Real billing-profile address so the invoice's frozen bill-to snapshot
    // can be asserted against something non-blank and non-derived-from-name.
    await db.update(organizations).set({
      billingAddressLine1: '742 Evergreen Terrace',
      billingAddressCity: 'Springfield',
      billingAddressRegion: 'IL',
      billingAddressPostalCode: '62701',
      billingAddressCountry: 'US',
    }).where(eq(organizations.id, org.id));
    const [freshOrg] = await db.select().from(organizations).where(eq(organizations.id, org.id));
    // actorUserId is a real FK-checked row, the way the route resolves the
    // authenticated tech recording the acceptance.
    const actorUser = await createUser({ partnerId: partner.id, orgId: org.id, withMembership: false });
    return { partner, org: freshOrg!, actorUser };
  });
}

describe('accept on behalf — draft straight to issued invoice', () => {
  runDb('claims the draft, issues the invoice at the quote totals/tax and records provenance', async () => {
    const { partner, org, actorUser } = await seed();
    const ctx = ctxFor(org.id, partner.id);
    const actor = actorFor(org.id, partner.id);

    const created = await withDbAccessContext(ctx, () =>
      createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    await withDbAccessContext(ctx, () => addManualLine(created.id, {
      sourceType: 'manual', description: 'Onboarding', quantity: 1, unitPrice: 250,
      taxable: true, customerVisible: true, recurrence: 'one_time',
    } as never, actor));
    await withDbAccessContext(ctx, () => addManualLine(created.id, {
      sourceType: 'manual', description: 'Managed services', quantity: 5, unitPrice: 99,
      taxable: true, customerVisible: true, recurrence: 'monthly',
    } as never, actor));

    // Pin the quote's tax snapshot at 10%, then move the ORG's live rate to
    // 25% — the invoice must issue at the quote's frozen 10%, never the org's
    // current rate (the whole point of "lock the quote total").
    await withSystemDbAccessContext(() => db.update(quotes).set({ taxRate: '0.10000' }).where(eq(quotes.id, created.id)));
    await withSystemDbAccessContext(() => db.update(organizations).set({ taxRate: '0.25000' }).where(eq(organizations.id, org.id)));

    // NOT sent. The tech closed it on the phone before it ever went out.
    const before = await withSystemDbAccessContext(() =>
      db.select({ status: quotes.status }).from(quotes).where(eq(quotes.id, created.id)));
    expect(before[0]!.status).toBe('draft');

    const res = await withSystemDbAccessContext(() => acceptQuote({
      quoteId: created.id, signerName: 'Dana Buyer', signerEmail: 'dana@customer.example',
      ipAddress: '10.0.0.7', userAgent: 'tech-browser',
      origin: 'on_behalf', method: 'purchase_order', reference: 'PO 4471',
      actorUserId: actorUser.id,
    }));

    const [q] = await withSystemDbAccessContext(() => db.select().from(quotes).where(eq(quotes.id, created.id)));
    expect(q!.status).toBe('converted');
    expect(q!.quoteNumber).toBeTruthy();   // claimed, so it carries its number
    expect(q!.sentAt).toBeTruthy();        // frozen and customer-bound
    // Delivery-free: the customer was never handed anything to click.
    expect(q!.acceptTokenJti).toBeNull();
    expect(q!.publicLinkRevokedAt).toBeNull();
    const recips = await withSystemDbAccessContext(() =>
      db.select().from(quoteRecipients).where(eq(quoteRecipients.quoteId, created.id)));
    expect(recips).toHaveLength(0);

    // The invoice is issued at the QUOTE's frozen totals and tax, not the org's
    // current rate — the charge must equal what was agreed.
    const [inv] = await withSystemDbAccessContext(() =>
      db.select().from(invoices).where(eq(invoices.id, res.invoiceId)));
    expect(inv!.status).toBe('sent');
    expect(inv!.invoiceNumber).toBeTruthy();
    expect(inv!.taxRate).toBe(q!.taxRate);
    expect(inv!.taxRate).toBe('0.10000');
    expect(inv!.subtotal).toBe('250.00');   // only the one-time line
    expect(inv!.total).toBe('275.00');      // 250 + 10% (NOT 312.50, the 25% org rate)

    // The invoice's bill-to is the CLAIM's frozen snapshot of the org's
    // billing profile, not blank — the overlay→invoice linkage.
    expect(inv!.billToName).toBe(org.name);
    expect(inv!.billToAddress).toMatchObject({
      line1: '742 Evergreen Terrace',
      city: 'Springfield',
      region: 'IL',
      postalCode: '62701',
      country: 'US',
    });

    // The recurring line became a draft contract.
    expect(res.contractIds).toHaveLength(1);
    const [contract] = await withSystemDbAccessContext(() =>
      db.select().from(contracts).where(eq(contracts.id, res.contractIds[0]!)));
    expect(contract!.status).toBe('draft');

    const [acc] = await withSystemDbAccessContext(() =>
      db.select().from(quoteAcceptances).where(eq(quoteAcceptances.id, res.acceptanceId)));
    expect(acc!.origin).toBe('on_behalf');
    expect(acc!.method).toBe('purchase_order');
    expect(acc!.reference).toBe('PO 4471');
    expect(acc!.recordedByUserId).toBe(actorUser.id);
    expect(acc!.quoteSha256).toMatch(/^[0-9a-f]{64}$/);
    // No public-link/accept-token machinery was ever minted for this quote.
    expect(q!.acceptTokenIssuedAt).toBeNull();
    expect(q!.acceptTokenExpiresAt).toBeNull();
    expect(q!.acceptTokenKid).toBeNull();

    // An org-scoped context for a DIFFERENT org cannot read this acceptance
    // row (RLS forge check).
    const otherPartner = await withSystemDbAccessContext(() => createPartner());
    const otherOrg = await withSystemDbAccessContext(() => createOrganization({ partnerId: otherPartner.id }));
    const otherCtx = ctxFor(otherOrg.id, otherPartner.id);
    const foreignRead = await withDbAccessContext(otherCtx, () =>
      db.select().from(quoteAcceptances).where(eq(quoteAcceptances.id, res.acceptanceId)));
    expect(foreignRead).toHaveLength(0);
  });

  runDb('refuses a second accept on the same quote (one invoice, not two)', async () => {
    const { partner, org, actorUser } = await seed();
    const ctx = ctxFor(org.id, partner.id);
    const actor = actorFor(org.id, partner.id);
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    await withDbAccessContext(ctx, () => addManualLine(created.id, {
      sourceType: 'manual', description: 'Onboarding', quantity: 1, unitPrice: 250,
      taxable: false, customerVisible: true, recurrence: 'one_time',
    } as never, actor));

    const params = {
      quoteId: created.id, signerName: 'Dana Buyer', signerEmail: null,
      origin: 'on_behalf' as const, method: 'verbal', reference: 'call 2026-09-21', actorUserId: actorUser.id,
    };
    await withSystemDbAccessContext(() => acceptQuote(params));
    await expect(withSystemDbAccessContext(() => acceptQuote(params)))
      .rejects.toMatchObject({ status: 409 });

    const invs = await withSystemDbAccessContext(() =>
      db.select().from(invoices).where(eq(invoices.orgId, org.id)));
    expect(invs).toHaveLength(1);
  });

  runDb('rejects accepting an expired quote (terminal status, not merely closed)', async () => {
    const { partner, org, actorUser } = await seed();
    const ctx = ctxFor(org.id, partner.id);
    const actor = actorFor(org.id, partner.id);
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    await withDbAccessContext(ctx, () => addManualLine(created.id, {
      sourceType: 'manual', description: 'Onboarding', quantity: 1, unitPrice: 100,
      taxable: false, customerVisible: true, recurrence: 'one_time',
    } as never, actor));
    await withSystemDbAccessContext(() => db.update(quotes).set({ status: 'expired' }).where(eq(quotes.id, created.id)));

    await expect(withSystemDbAccessContext(() => acceptQuote({
      quoteId: created.id, signerName: 'Late Larry',
      origin: 'on_behalf', method: 'verbal', reference: 'call', actorUserId: actorUser.id,
    }))).rejects.toMatchObject({ status: 409, code: 'QUOTE_NOT_ACCEPTABLE' });

    const invs = await withSystemDbAccessContext(() =>
      db.select().from(invoices).where(eq(invoices.orgId, org.id)));
    expect(invs).toHaveLength(0);
  });

  runDb('rejects a blank signer name at the service layer', async () => {
    const { partner, org, actorUser } = await seed();
    const ctx = ctxFor(org.id, partner.id);
    const actor = actorFor(org.id, partner.id);
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    await withDbAccessContext(ctx, () => addManualLine(created.id, {
      sourceType: 'manual', description: 'Onboarding', quantity: 1, unitPrice: 100,
      taxable: false, customerVisible: true, recurrence: 'one_time',
    } as never, actor));

    await expect(withSystemDbAccessContext(() => acceptQuote({
      quoteId: created.id, signerName: '   ',
      origin: 'on_behalf', method: 'verbal', reference: 'call', actorUserId: actorUser.id,
    }))).rejects.toMatchObject({ status: 400, code: 'INVALID_SIGNER_NAME' });

    const [q] = await withSystemDbAccessContext(() => db.select().from(quotes).where(eq(quotes.id, created.id)));
    expect(q!.status).toBe('draft'); // untouched by the rejected attempt
  });

  runDb('rejects an on-behalf acceptance row with no reference at the database, not only at the API', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id);
    const actor = actorFor(org.id, partner.id);
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    // The CHECK is the backstop behind the Zod schema: a future caller that
    // skips validation must still not be able to write an evidence-less
    // on-behalf record. Drizzle wraps the real Postgres error in a
    // DrizzleQueryError ("Failed query: ...") — the constraint name and
    // SQLSTATE live on `.cause`, not on the wrapper's own `.message`.
    let caught: any;
    try {
      await withSystemDbAccessContext(() => db.insert(quoteAcceptances).values({
        quoteId: created.id, orgId: org.id, signerName: 'X',
        quoteSha256: 'a'.repeat(64), hashVersion: 2,
        origin: 'on_behalf', method: 'verbal', reference: null, recordedByUserId: null,
      } as never));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.cause?.code).toBe('23514');
    expect(caught.cause?.message ?? caught.message).toMatch(/quote_acceptances_reference_chk/);
  });

  runDb('rejects a customer-origin acceptance row that names a recorder at the database', async () => {
    const { partner, org, actorUser } = await seed();
    const ctx = ctxFor(org.id, partner.id);
    const actor = actorFor(org.id, partner.id);
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    // The inverse backstop: a CUSTOMER row can never claim an MSP recorder —
    // that would misattribute a click the customer actually made.
    let caught: any;
    try {
      await withSystemDbAccessContext(() => db.insert(quoteAcceptances).values({
        quoteId: created.id, orgId: org.id, signerName: 'Jane Buyer',
        quoteSha256: 'b'.repeat(64), hashVersion: 2,
        origin: 'customer', method: 'typed-signature', reference: null,
        recordedByUserId: actorUser.id,
      } as never));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.cause?.code).toBe('23514');
    expect(caught.cause?.message ?? caught.message).toMatch(/quote_acceptances_recorder_chk/);
  });
});
