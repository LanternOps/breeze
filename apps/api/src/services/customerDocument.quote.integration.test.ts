/**
 * #9418 W2a — the quote half of the customer-document assembler on real
 * Postgres. The hidden-line filter is SQL and the partner-axis reads depend on
 * RLS, so a mocked DB proves neither: this seeds a sent quote with a hidden
 * line, internal header columns, a partner with a non-English document language
 * and a portal_branding row, then assembles it under the three caller contexts
 * that use it — the logged-in portal user (org scope, no partner access), a
 * staff partner user, and the public link's system context.
 */
import { describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';

import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../db';
import { organizations, partners, users } from '../db/schema';
import { portalBranding } from '../db/schema/portal';
import { quotes, quoteBlocks, quoteLines } from '../db/schema/quotes';
import {
  assembleCustomerQuoteDocument, CustomerDocumentModeError, type CustomerQuoteAssetPaths, type QuoteRow,
} from './customerQuoteDocument';
import { getAccessibleQuoteRow } from './quoteService';

const RUN = !!process.env.DATABASE_URL;
const HIDDEN = 'HIDDEN-QUOTE-LINE-SENTINEL';
const INTERNAL = 'INTERNAL-QUOTE-SENTINEL';
const ASSETS: CustomerQuoteAssetPaths = {
  lineImage: (l) => `/test/line-image/${l.id}`,
  contractFile: (b) => `/test/contract-file/${b}`,
};

interface Fixture {
  partnerId: string; orgId: string; userId: string; sentId: string; draftId: string;
  partnerName: string; logoUrl: string;
}

async function seed(): Promise<Fixture> {
  const suffix = Math.random().toString(36).slice(2, 10);
  return withSystemDbAccessContext(async () => {
    const partnerName = `CustDoc Quotes MSP ${suffix}`;
    const logoUrl = `https://cdn.example.test/q-${suffix}.png`;
    const [p] = await db.insert(partners).values({
      name: partnerName, slug: `custdoc-q-${suffix}`, type: 'msp', plan: 'pro', status: 'active',
      billingEmail: `billing-q-${suffix}@example.test`, billingCompanyName: `Seller ${suffix}`,
      settings: { language: 'pt-BR' }, documentTheme: 'condensed', documentPageSize: 'a4',
    }).returning({ id: partners.id });
    const partnerId = p!.id;
    const [o] = await db.insert(organizations).values({
      partnerId, name: `CustDoc Q Org ${suffix}`, slug: `custdoc-q-org-${suffix}`, currencyCode: 'USD',
    }).returning({ id: organizations.id });
    const orgId = o!.id;
    const [u] = await db.insert(users).values({
      partnerId, orgId, email: `tech-q-${suffix}@example.test`, name: `Tech ${suffix}`, status: 'active',
    }).returning({ id: users.id });
    await db.insert(portalBranding).values({ orgId, logoUrl, primaryColor: '#1d4ed8', supportEmail: `help-${suffix}@example.test` });

    // Sent, with internal columns that must never reach a customer payload and
    // no stamped locale (→ the partner language).
    const [sent] = await db.insert(quotes).values({
      partnerId, orgId, status: 'sent', quoteNumber: `Q-CD-${suffix.slice(0, 4)}`, title: 'Network refresh',
      currencyCode: 'USD', issueDate: '2026-03-01', expiryDate: '2026-03-31',
      subtotal: '150.00', taxTotal: '0.00', total: '150.00', oneTimeTotal: '150.00',
      billToName: 'Acme Dental', declineReason: INTERNAL, sendJobId: INTERNAL, acceptTokenJti: INTERNAL,
      billToTaxId: INTERNAL, sellerSnapshot: { name: 'Frozen seller', address: null, phone: null, email: null, website: null },
      presentationSnapshot: { theme: 'classic', pageSize: 'letter' },
    }).returning({ id: quotes.id });
    const sentId = sent!.id;
    const [pricing] = await db.insert(quoteBlocks).values({
      quoteId: sentId, orgId, blockType: 'line_items', content: { label: 'Pricing' }, sortOrder: 0,
    }).returning({ id: quoteBlocks.id });
    await db.insert(quoteLines).values([
      { quoteId: sentId, orgId, blockId: pricing!.id, sourceType: 'manual', name: 'Firewall', description: 'Rack pair', quantity: '1', unitPrice: '100.00', lineTotal: '100.00', customerVisible: true, sortOrder: 0, unitCost: '70.00' },
      { quoteId: sentId, orgId, blockId: pricing!.id, sourceType: 'manual', name: 'Install', description: 'On site', quantity: '1', unitPrice: '50.00', lineTotal: '50.00', customerVisible: true, sortOrder: 1 },
      { quoteId: sentId, orgId, blockId: pricing!.id, sourceType: 'manual', name: 'Margin adjustment', description: HIDDEN, quantity: '1', unitPrice: '0.00', lineTotal: '0.00', customerVisible: false, sortOrder: 2 },
    ]);

    // Draft: no seller snapshot yet (sending freezes it), a hidden line too.
    const [draft] = await db.insert(quotes).values({
      partnerId, orgId, status: 'draft', currencyCode: 'USD', subtotal: '75.00', taxTotal: '0.00', total: '75.00', oneTimeTotal: '75.00',
    }).returning({ id: quotes.id });
    const draftId = draft!.id;
    await db.insert(quoteLines).values([
      { quoteId: draftId, orgId, sourceType: 'manual', name: 'Backup', description: 'Nightly', quantity: '1', unitPrice: '75.00', lineTotal: '75.00', customerVisible: true, sortOrder: 0 },
      { quoteId: draftId, orgId, sourceType: 'manual', name: 'Hidden draft line', description: HIDDEN, quantity: '1', unitPrice: '0.00', lineTotal: '0.00', customerVisible: false, sortOrder: 1 },
    ]);
    return { partnerId, orgId, userId: u!.id, sentId, draftId, partnerName, logoUrl };
  });
}

/** The logged-in portal's context (routes/portal/auth.ts): org scope, no partner access. */
const portalCtx = (f: Fixture): DbAccessContext => ({
  scope: 'organization', orgId: f.orgId, accessibleOrgIds: [f.orgId], accessiblePartnerIds: [], userId: null, currentPartnerId: null,
});
/** A staff partner user (the customer-view route's caller). */
const staffCtx = (f: Fixture): DbAccessContext => ({
  scope: 'partner', orgId: null, accessibleOrgIds: [f.orgId], accessiblePartnerIds: [f.partnerId], userId: f.userId,
});
const staffActor = (f: Fixture) => ({ userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] });

/** The portal route's own row read: the quote by id within the caller's org. */
async function portalRow(id: string, orgId: string): Promise<QuoteRow> {
  const [q] = await db.select().from(quotes).where(and(eq(quotes.id, id), eq(quotes.orgId, orgId))).limit(1);
  if (!q) throw new Error('portal row not visible');
  return q;
}

function expectCustomerQuote(f: Fixture, doc: Awaited<ReturnType<typeof assembleCustomerQuoteDocument>>) {
  expect(doc.lines.map((l) => l.name)).toEqual(['Firewall', 'Install']);
  const text = JSON.stringify(doc);
  expect(text).not.toContain(HIDDEN);
  expect(text).not.toContain(INTERNAL);
  for (const l of doc.lines) expect(l).not.toHaveProperty('unitCost');
  // Partner-axis reads returned the partner row (not zero rows under RLS).
  expect(doc.branding.partnerName).toBe(f.partnerName);
  // portal_branding row, read in its own system context keyed on the quote's org.
  expect(doc.branding.logoUrl).toBe(f.logoUrl);
  // The frozen presentation snapshot wins over the partner's live columns.
  expect(doc.branding).toMatchObject({ theme: 'classic', pageSize: 'letter' });
  expect(doc.documentLocale).toBe('pt-BR');
  expect(doc.quote.displayStatus).toBe('viewed');
  expect(doc.quote.sellerSnapshot?.name).toBe('Frozen seller');
  // Totals are derived from the visible lines only.
  expect(doc.quote.dueOnAcceptanceTotal).toBe('150.00');
}

describe.runIf(RUN)('customer-document quote assembler on Postgres (#9418)', () => {
  it('portal-user context: hidden line and internal columns absent, partner-axis reads return rows, partner locale', async () => {
    const f = await seed();
    const doc = await withDbAccessContext(portalCtx(f), async () =>
      assembleCustomerQuoteDocument(await portalRow(f.sentId, f.orgId), 'portal', { assets: ASSETS }));
    expectCustomerQuote(f, doc);
    expect(doc.quote.status).toBe('sent');
  });

  it('portal-user context: a draft is refused by the assembler', async () => {
    const f = await seed();
    await expect(withDbAccessContext(portalCtx(f), async () =>
      assembleCustomerQuoteDocument(await portalRow(f.draftId, f.orgId), 'portal', { assets: ASSETS })))
      .rejects.toBeInstanceOf(CustomerDocumentModeError);
  });

  it('staff context: same, and a draft assembles with the seller sending would freeze', async () => {
    const f = await seed();
    const doc = await withDbAccessContext(staffCtx(f), async () =>
      assembleCustomerQuoteDocument(await getAccessibleQuoteRow(f.sentId, staffActor(f)), 'staff', { assets: ASSETS }));
    expectCustomerQuote(f, doc);

    const draft = await withDbAccessContext(staffCtx(f), async () =>
      assembleCustomerQuoteDocument(await getAccessibleQuoteRow(f.draftId, staffActor(f)), 'staff', { assets: ASSETS }));
    expect(draft.quote).toMatchObject({ status: 'draft', displayStatus: null });
    expect(draft.lines.map((l) => l.name)).toEqual(['Backup']);
    expect(JSON.stringify(draft)).not.toContain(HIDDEN);
    expect(draft.quote.sellerSnapshot?.name).toBeTruthy();
    // No presentation snapshot on a draft: the partner's live theme applies.
    expect(draft.branding).toMatchObject({ theme: 'condensed', pageSize: 'a4' });
    expect(draft.documentLocale).toBe('pt-BR');
  });

  it('a staff caller of ANOTHER partner cannot load the row (RLS), so it never reaches the assembler', async () => {
    const f = await seed();
    const otherPartner: DbAccessContext = {
      scope: 'partner', orgId: null, accessibleOrgIds: [], accessiblePartnerIds: ['00000000-0000-4000-8000-00000000abcd'], userId: f.userId,
    };
    await expect(withDbAccessContext(otherPartner, () =>
      getAccessibleQuoteRow(f.sentId, { userId: f.userId, partnerId: '00000000-0000-4000-8000-00000000abcd', accessibleOrgIds: [] })))
      .rejects.toMatchObject({ status: 404 });
  });

  it('system context (public route): same, with the public status mapping', async () => {
    const f = await seed();
    const doc = await withSystemDbAccessContext(async () => {
      const [q] = await db.select().from(quotes).where(eq(quotes.id, f.sentId)).limit(1);
      return assembleCustomerQuoteDocument(q!, 'public', { assets: ASSETS });
    });
    expectCustomerQuote(f, doc);
    expect(doc.quote.status).toBe('viewed');
  });
});
