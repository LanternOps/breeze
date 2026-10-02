/**
 * #7507 — a quote's tax rate is the ONE shared resolver's value (org rate →
 * partner default; exempt → none) and is frozen when the quote becomes
 * customer-visible (send), not when it is created. Clone re-resolves rather
 * than copying the source's frozen rate, and a draft follows the current rate.
 * A quote that has already been sent never moves.
 *
 * Real Postgres on purpose: the send-time resolve runs on the send's own
 * transaction under a partner-scoped RLS context, which a mocked DB cannot
 * evaluate.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { quotes } from '../../db/schema/quotes';
import { organizations, partners } from '../../db/schema/orgs';
import { buildDbAccessContext } from '../../middleware/auth';
import { createPartner, createOrganization } from './db-utils';
import { createQuote, addManualLine, cloneQuote, refreshDraftQuoteTaxRate, reviseQuote, updateQuote } from '../../services/quoteService';
import { sendQuote } from '../../services/quoteLifecycle';
import type { QuoteActor } from '../../services/quoteTypes';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function partnerCtx(partnerId: string, orgId: string): DbAccessContext {
  return buildDbAccessContext({ scope: 'partner', orgId: null, accessibleOrgIds: [orgId], partnerId, userId: null });
}
function actorFor(orgId: string, partnerId: string): QuoteActor {
  return { userId: null, partnerId, accessibleOrgIds: [orgId] };
}

async function seed() {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    return { partner, org };
  });
}

async function setOrgRate(orgId: string, rate: string | null) {
  await withSystemDbAccessContext(() => db.update(organizations).set({ taxRate: rate }).where(eq(organizations.id, orgId)));
}

async function readQuote(id: string) {
  const [row] = await withSystemDbAccessContext(() => db.select().from(quotes).where(eq(quotes.id, id)).limit(1));
  return row!;
}

const taxableLine = (unitPrice: number) => ({
  sourceType: 'manual', description: 'Taxable work', quantity: 1, unitPrice,
  taxable: true, customerVisible: true, recurrence: 'one_time',
}) as never;

describe('quote tax rate resolves when the quote is sent (#7507)', () => {
  runDb('send stamps the rate current at send, not the one current at create', async () => {
    const { partner, org } = await seed();
    const ctx = partnerCtx(partner.id, org.id);
    const actor = actorFor(org.id, partner.id);

    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    await withDbAccessContext(ctx, () => addManualLine(created.id, taxableLine(100), actor));
    expect((await readQuote(created.id)).taxRate).toBeNull(); // no rate anywhere yet

    // The org gets a rate AFTER the draft was created and last edited.
    await setOrgRate(org.id, '0.08250');

    await withDbAccessContext(ctx, () => sendQuote(created.id, actor));
    const sent = await readQuote(created.id);
    expect(sent.status).toBe('sent');
    expect(sent.taxRate).toBe('0.08250');
    expect(sent.taxTotal).toBe('8.25');
    expect(sent.total).toBe('108.25');
  });

  runDb('a sent quote keeps its frozen rate when the org rate changes; a clone resolves the current rate', async () => {
    const { partner, org } = await seed();
    const ctx = partnerCtx(partner.id, org.id);
    const actor = actorFor(org.id, partner.id);
    await setOrgRate(org.id, '0.05000');

    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    await withDbAccessContext(ctx, () => addManualLine(created.id, taxableLine(200), actor));
    await withDbAccessContext(ctx, () => sendQuote(created.id, actor));

    await setOrgRate(org.id, '0.10000');

    const sent = await readQuote(created.id);
    expect(sent.taxRate).toBe('0.05000');
    expect(sent.taxTotal).toBe('10.00');
    expect(sent.total).toBe('210.00');
    // Re-reading a SENT quote through the draft refresh must not touch it.
    expect(await withDbAccessContext(ctx, () => refreshDraftQuoteTaxRate(created.id, actor))).toBe(false);
    expect((await readQuote(created.id)).taxRate).toBe('0.05000');

    const clone = await withDbAccessContext(ctx, () => cloneQuote(created.id, actor));
    const cloned = await readQuote(clone.id);
    expect(cloned.status).toBe('draft');
    expect(cloned.taxRate).toBe('0.10000');
    expect(cloned.taxTotal).toBe('20.00');
    expect(cloned.total).toBe('220.00');
    // The source is still the document the customer was sent.
    expect((await readQuote(created.id)).taxRate).toBe('0.05000');
  });

  runDb('a draft follows the current rate: a line edit and the detail-read refresh both re-resolve it', async () => {
    const { partner, org } = await seed();
    const ctx = partnerCtx(partner.id, org.id);
    const actor = actorFor(org.id, partner.id);
    await withSystemDbAccessContext(() => db.update(partners).set({ defaultTaxRate: '0.07000' }).where(eq(partners.id, partner.id)));

    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    expect(created.taxRate).toBe('0.07000'); // partner default, org has none
    await withDbAccessContext(ctx, () => addManualLine(created.id, taxableLine(100), actor));

    // Org override lands → the next draft mutation picks it up.
    await setOrgRate(org.id, '0.09000');
    await withDbAccessContext(ctx, () => addManualLine(created.id, taxableLine(100), actor));
    let draft = await readQuote(created.id);
    expect(draft.taxRate).toBe('0.09000');
    expect(draft.taxTotal).toBe('18.00');

    // No mutation since the next change → the detail read refreshes it.
    await setOrgRate(org.id, '0.04000');
    expect(await withDbAccessContext(ctx, () => refreshDraftQuoteTaxRate(created.id, actor))).toBe(true);
    draft = await readQuote(created.id);
    expect(draft.taxRate).toBe('0.04000');
    expect(draft.taxTotal).toBe('8.00');
    expect(draft.total).toBe('208.00');
    // Already current → no write.
    expect(await withDbAccessContext(ctx, () => refreshDraftQuoteTaxRate(created.id, actor))).toBe(false);

    // Exempt org → no tax on the draft.
    await withSystemDbAccessContext(() => db.update(organizations).set({ taxExempt: true }).where(eq(organizations.id, org.id)));
    expect(await withDbAccessContext(ctx, () => refreshDraftQuoteTaxRate(created.id, actor))).toBe(true);
    draft = await readQuote(created.id);
    expect(draft.taxRate).toBeNull();
    expect(draft.taxTotal).toBe('0.00');
  });
});

describe('quote tax rate — deposit, reassignment and revision (#7507)', () => {
  runDb('send recomputes the deposit at the send-time rate; a revision of the sent quote resolves the current rate', async () => {
    const { partner, org } = await seed();
    const ctx = partnerCtx(partner.id, org.id);
    const actor = actorFor(org.id, partner.id);

    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    await withDbAccessContext(ctx, () => addManualLine(created.id, taxableLine(100), actor));
    const withDeposit = await withDbAccessContext(ctx, () =>
      updateQuote(created.id, { depositType: 'percent', depositPercent: 50 }, actor));
    expect(withDeposit.depositAmount).toBe('50.00'); // 50% of 100, no tax yet

    await setOrgRate(org.id, '0.10000');
    await withDbAccessContext(ctx, () => sendQuote(created.id, actor));
    const sent = await readQuote(created.id);
    expect(sent.taxRate).toBe('0.10000');
    expect(sent.total).toBe('110.00');
    // The deposit froze on the SAME rate as the totals — 50% of 110, not of 100.
    expect(sent.depositAmount).toBe('55.00');

    await setOrgRate(org.id, '0.20000');
    const revision = await withDbAccessContext(ctx, () => reviseQuote(created.id, actor));
    const revised = await readQuote(revision.id);
    expect(revised.status).toBe('draft');
    expect(revised.revisionOfQuoteId).toBe(created.id);
    expect(revised.taxRate).toBe('0.20000');
    expect(revised.total).toBe('120.00');
    expect((await readQuote(created.id)).taxRate).toBe('0.10000');
  });

  runDb('reassigning a draft to another org resolves the TARGET org rate', async () => {
    const { partner, org } = await seed();
    const orgB = await withSystemDbAccessContext(() => createOrganization({ partnerId: partner.id }));
    await setOrgRate(org.id, '0.05000');
    await setOrgRate(orgB.id, '0.15000');
    const ctx = buildDbAccessContext({ scope: 'partner', orgId: null, accessibleOrgIds: [org.id, orgB.id], partnerId: partner.id, userId: null });
    const actor: QuoteActor = { userId: null, partnerId: partner.id, accessibleOrgIds: [org.id, orgB.id] };

    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    await withDbAccessContext(ctx, () => addManualLine(created.id, taxableLine(100), actor));
    expect((await readQuote(created.id)).taxRate).toBe('0.05000');

    await withDbAccessContext(ctx, () => updateQuote(created.id, { orgId: orgB.id }, actor));
    const moved = await readQuote(created.id);
    expect(moved.orgId).toBe(orgB.id);
    expect(moved.taxRate).toBe('0.15000');
    expect(moved.taxTotal).toBe('15.00');
  });
});
