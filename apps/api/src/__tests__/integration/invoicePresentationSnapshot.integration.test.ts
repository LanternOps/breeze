import './setup';
import { describe, it, expect, vi, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

// BullMQ side effects (lifecycle events, async PDF render, accounting push) are
// not the snapshot semantics under test — stub them so no socket is opened.
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/quoteEvents', () => ({ emitQuoteEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/accountingSyncWorker', () => ({
  enqueueAccountingInvoicePush: vi.fn().mockResolvedValue(undefined),
  enqueueAccountingInvoiceVoid: vi.fn().mockResolvedValue(undefined),
  enqueueAccountingPaymentPush: vi.fn().mockResolvedValue(true),
  enqueueAccountingPaymentDelete: vi.fn().mockResolvedValue(true),
}));

import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { partners, organizations, users, invoices, quotes } from '../../db/schema';
import * as invoiceSvc from '../../services/invoiceService';
import { createQuote, addManualLine as addQuoteLine } from '../../services/quoteService';
import { sendQuote } from '../../services/quoteLifecycle';
import { acceptQuote } from '../../services/quoteAcceptService';
import { resolveInvoiceBranding } from '../../services/quoteBranding';
import type { InvoiceActor } from '../../services/invoiceTypes';
import type { QuoteActor } from '../../services/quoteTypes';

const RUN = !!process.env.DATABASE_URL;
const MIGRATION = '2026-10-29-100100-invoice-presentation-snapshot.sql';

// Superuser client (the role autoMigrate runs as) with onnotice wired so the
// backfill's RAISE WARNING cumulative count can be asserted.
const notices: string[] = [];
const adminSql = postgres(process.env.DATABASE_URL ?? '', { max: 1, onnotice: (n) => { notices.push(String(n.message)); } });
afterAll(async () => { await adminSql.end({ timeout: 5 }); });
async function runMigration(): Promise<string[]> {
  const migrationSql = readFileSync(join(__dirname, '../../../migrations', MIGRATION), 'utf8');
  notices.length = 0;
  await adminSql.unsafe(migrationSql);
  return notices.filter((m) => m.startsWith('invoice-presentation:'));
}

interface Fixture { partnerId: string; orgId: string; userId: string }

async function seedFixture(opts: { theme?: string; pageSize?: string; partnerTaxRate?: string | null } = {}): Promise<Fixture> {
  const suffix = Math.random().toString(36).slice(2, 10);
  return withSystemDbAccessContext(async () => {
    const [p] = await db.insert(partners).values({
      name: `Pres ${suffix}`, slug: `pres-${suffix}`, type: 'msp', plan: 'pro', status: 'active',
      documentTheme: opts.theme ?? 'condensed', documentPageSize: opts.pageSize ?? 'letter',
      defaultTaxRate: opts.partnerTaxRate ?? null,
    }).returning({ id: partners.id });
    const [o] = await db.insert(organizations).values({
      partnerId: p!.id, name: `Pres Org ${suffix}`, slug: `pres-org-${suffix}`, currencyCode: 'USD',
    }).returning({ id: organizations.id });
    const [u] = await db.insert(users).values({
      partnerId: p!.id, orgId: o!.id, email: `tech-${suffix}@example.test`, name: `Tech ${suffix}`, status: 'active',
    }).returning({ id: users.id });
    return { partnerId: p!.id, orgId: o!.id, userId: u!.id };
  });
}
const invActor = (f: Fixture): InvoiceActor => ({ userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] });
const quoteActor = (f: Fixture): QuoteActor => ({ userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] });
const ctx = (f: Fixture): DbAccessContext => ({
  scope: 'partner', orgId: null, accessibleOrgIds: [f.orgId], accessiblePartnerIds: [f.partnerId], userId: f.userId,
});
const sys = <T,>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);
const as = <T,>(f: Fixture, fn: () => Promise<T>) => withDbAccessContext(ctx(f), fn);

async function setPartner(partnerId: string, patch: Partial<typeof partners.$inferInsert>) {
  await sys(() => db.update(partners).set(patch).where(eq(partners.id, partnerId)));
}
async function invoiceRow(id: string) {
  const [row] = await sys(() => db.select().from(invoices).where(eq(invoices.id, id)));
  return row!;
}
async function draftWithLine(f: Fixture, opts: { taxable?: boolean; unitPrice?: number } = {}) {
  const invoice = await as(f, () => invoiceSvc.createManualInvoice({ orgId: f.orgId }, invActor(f)));
  await as(f, () => invoiceSvc.addManualLine(invoice.id, {
    description: 'Service', quantity: 1, unitPrice: opts.unitPrice ?? 100, taxable: opts.taxable ?? false,
  }, invActor(f)));
  return invoice.id;
}
const branding = (f: Fixture, id: string) => as(f, async () => resolveInvoiceBranding(await invoiceRow(id)));

describe.runIf(RUN)('invoice presentation snapshot (#6227)', () => {
  it('a draft is unstamped and previews the partner live values; issue freezes them', async () => {
    const f = await seedFixture({ theme: 'condensed', pageSize: 'letter' });
    const id = await draftWithLine(f);
    expect(await invoiceRow(id)).toMatchObject({ documentTheme: null, documentPageSize: null });

    // Draft preview follows the partner.
    await setPartner(f.partnerId, { documentTheme: 'classic', documentPageSize: 'a4' });
    expect(await branding(f, id)).toMatchObject({ theme: 'classic', pageSize: 'a4' });

    await setPartner(f.partnerId, { documentTheme: 'condensed', documentPageSize: 'letter' });
    await as(f, () => invoiceSvc.issueInvoice(id, invActor(f)));
    expect(await invoiceRow(id)).toMatchObject({ status: 'sent', documentTheme: 'condensed', documentPageSize: 'letter' });

    // A later partner change does not reflow the issued document.
    await setPartner(f.partnerId, { documentTheme: 'classic', documentPageSize: 'a4' });
    expect(await branding(f, id)).toMatchObject({ theme: 'condensed', pageSize: 'letter' });
  });

  it('issue normalizes an unknown partner value before stamping (column CHECK holds)', async () => {
    const f = await seedFixture({ theme: 'weird', pageSize: 'legal' });
    const id = await draftWithLine(f);
    await as(f, () => invoiceSvc.issueInvoice(id, invActor(f)));
    expect(await invoiceRow(id)).toMatchObject({ documentTheme: 'classic', documentPageSize: 'a4' });
  });

  it('the columns reject values outside classic|condensed and letter|a4', async () => {
    const f = await seedFixture();
    const id = await draftWithLine(f);
    await expect(sys(() => db.update(invoices).set({ documentTheme: 'weird' }).where(eq(invoices.id, id)))).rejects.toThrow();
    await expect(sys(() => db.update(invoices).set({ documentPageSize: 'legal' }).where(eq(invoices.id, id)))).rejects.toThrow();
  });

  it('void + reissue: the replacement draft is unstamped and stamps its OWN values at issue', async () => {
    const f = await seedFixture({ theme: 'condensed', pageSize: 'letter' });
    const id = await draftWithLine(f);
    await as(f, () => invoiceSvc.issueInvoice(id, invActor(f)));
    await setPartner(f.partnerId, { documentTheme: 'classic', documentPageSize: 'a4' });
    const replacement = await as(f, () => invoiceSvc.voidInvoice(id, 'wrong amount', { reissue: true }, invActor(f)));
    const draftId = replacement.invoice.id;
    expect(draftId).not.toBe(id);
    expect(await invoiceRow(draftId)).toMatchObject({ status: 'draft', documentTheme: null, documentPageSize: null });
    // The voided original keeps what it was issued with.
    expect(await invoiceRow(id)).toMatchObject({ status: 'void', documentTheme: 'condensed', documentPageSize: 'letter' });

    await as(f, () => invoiceSvc.issueInvoice(draftId, invActor(f)));
    expect(await invoiceRow(draftId)).toMatchObject({ documentTheme: 'classic', documentPageSize: 'a4' });
  });

  it("quote accept stamps the QUOTE's frozen presentation, not the partner's current one", async () => {
    const f = await seedFixture({ theme: 'condensed', pageSize: 'letter' });
    const a = quoteActor(f);
    const created = await as(f, () => createQuote({ orgId: f.orgId, currencyCode: 'USD' }, a));
    await as(f, () => addQuoteLine(created.id, { sourceType: 'manual', description: 'Onboarding', quantity: 1, unitPrice: 250, taxable: false, customerVisible: true, recurrence: 'one_time' } as any, a));
    await as(f, () => sendQuote(created.id, a));

    await setPartner(f.partnerId, { documentTheme: 'classic', documentPageSize: 'a4' });
    const res = await as(f, () => acceptQuote({ quoteId: created.id, signerName: 'Jane Buyer' }));
    expect(res.invoiceIssued).toBe(true);
    expect(await invoiceRow(res.invoiceId)).toMatchObject({ status: 'sent', documentTheme: 'condensed', documentPageSize: 'letter' });
  });

  it('quote accept falls back to the partner current values for a quote with no presentation snapshot', async () => {
    const f = await seedFixture({ theme: 'condensed', pageSize: 'letter' });
    const a = quoteActor(f);
    const created = await as(f, () => createQuote({ orgId: f.orgId, currencyCode: 'USD' }, a));
    await as(f, () => addQuoteLine(created.id, { sourceType: 'manual', description: 'Onboarding', quantity: 1, unitPrice: 250, taxable: false, customerVisible: true, recurrence: 'one_time' } as any, a));
    await as(f, () => sendQuote(created.id, a));
    // Legacy quote sent before presentation snapshots existed.
    await sys(() => db.update(quotes).set({ presentationSnapshot: null }).where(eq(quotes.id, created.id)));
    await setPartner(f.partnerId, { documentTheme: 'classic', documentPageSize: 'a4' });
    const res = await as(f, () => acceptQuote({ quoteId: created.id, signerName: 'Jane Buyer' }));
    expect(await invoiceRow(res.invoiceId)).toMatchObject({ documentTheme: 'classic', documentPageSize: 'a4' });
  });
});

describe.runIf(RUN)('draft invoice tax resolves org → partner (#6227, M18)', () => {
  it('a persisted draft for an org with no own rate carries the PARTNER default', async () => {
    const f = await seedFixture({ partnerTaxRate: '0.07000' });
    const id = await draftWithLine(f, { taxable: true, unitPrice: 100 });
    expect(await invoiceRow(id)).toMatchObject({ taxRate: '0.07000', taxTotal: '7.00', total: '107.00' });
  });

  it('an org rate still wins over the partner default on a draft', async () => {
    const f = await seedFixture({ partnerTaxRate: '0.07000' });
    await sys(() => db.update(organizations).set({ taxRate: '0.05000' }).where(eq(organizations.id, f.orgId)));
    const id = await draftWithLine(f, { taxable: true, unitPrice: 100 });
    expect(await invoiceRow(id)).toMatchObject({ taxRate: '0.05000', taxTotal: '5.00' });
  });

  it('a draft created before and issued after a partner rate change stamps the rate current at issue', async () => {
    const f = await seedFixture({ partnerTaxRate: '0.07000' });
    const id = await draftWithLine(f, { taxable: true, unitPrice: 100 });
    expect((await invoiceRow(id)).taxRate).toBe('0.07000');

    // A draft mutation after the change recomputes to the new partner rate.
    await setPartner(f.partnerId, { defaultTaxRate: '0.10000' });
    await as(f, () => invoiceSvc.addManualLine(id, { description: 'More', quantity: 1, unitPrice: 100, taxable: true }, invActor(f)));
    expect(await invoiceRow(id)).toMatchObject({ taxRate: '0.10000', taxTotal: '20.00', total: '220.00' });

    // Issue re-resolves: the rate current AT ISSUE wins, not the draft's last recompute.
    await setPartner(f.partnerId, { defaultTaxRate: '0.12000' });
    await as(f, () => invoiceSvc.issueInvoice(id, invActor(f)));
    expect(await invoiceRow(id)).toMatchObject({ status: 'sent', taxRate: '0.12000', taxTotal: '24.00', total: '224.00' });
  });
});

describe.runIf(RUN)('backfill migration ' + MIGRATION, () => {
  it('stamps legacy non-draft invoices with the partner current (normalized) values, leaves drafts NULL, and is a counted no-op on re-run', async () => {
    const f = await seedFixture({ theme: 'condensed', pageSize: 'letter' });
    const issued = await draftWithLine(f);
    await as(f, () => invoiceSvc.issueInvoice(issued, invActor(f)));
    const draft = await draftWithLine(f);
    // Simulate a pre-#6227 issued invoice.
    await sys(() => db.update(invoices).set({ documentTheme: null, documentPageSize: null }).where(eq(invoices.id, issued)));

    const g = await seedFixture({ theme: 'weird', pageSize: 'legal' });
    const issuedG = await draftWithLine(g);
    await as(g, () => invoiceSvc.issueInvoice(issuedG, invActor(g)));
    await sys(() => db.update(invoices).set({ documentTheme: null, documentPageSize: null }).where(eq(invoices.id, issuedG)));

    const warnings = await runMigration();
    expect(await invoiceRow(issued)).toMatchObject({ documentTheme: 'condensed', documentPageSize: 'letter' });
    expect(await invoiceRow(issuedG)).toMatchObject({ documentTheme: 'classic', documentPageSize: 'a4' });
    expect(await invoiceRow(draft)).toMatchObject({ documentTheme: null, documentPageSize: null });
    // Cumulative count is reported (other suites' rows may be counted too).
    const counted = warnings.find((w) => /backfilled document_theme\/document_page_size on \d+ non-draft invoices/.test(w));
    expect(counted).toBeDefined();
    expect(Number(counted!.match(/on (\d+) non-draft/)![1])).toBeGreaterThanOrEqual(2);

    // Re-run: nothing left to stamp → no count warning, values unchanged.
    await setPartner(f.partnerId, { documentTheme: 'classic', documentPageSize: 'a4' });
    const again = await runMigration();
    expect(again.filter((w) => /backfilled/.test(w))).toEqual([]);
    expect(await invoiceRow(issued)).toMatchObject({ documentTheme: 'condensed', documentPageSize: 'letter' });
  });
});
