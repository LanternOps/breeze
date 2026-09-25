import './setup';
import { describe, it, expect, vi, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

// BullMQ side effects are not the snapshot semantics under test — stub them so
// no socket is opened (same stubs as invoiceTicketLabelSnapshot).
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/accountingSyncWorker', () => ({
  enqueueAccountingInvoicePush: vi.fn().mockResolvedValue(undefined),
  enqueueAccountingInvoiceVoid: vi.fn().mockResolvedValue(undefined),
  enqueueAccountingPaymentPush: vi.fn().mockResolvedValue(true),
  enqueueAccountingPaymentDelete: vi.fn().mockResolvedValue(true),
}));

import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { partners, organizations, users, invoices, invoiceLines, tickets, ticketCategories } from '../../db/schema';
import * as invoiceSvc from '../../services/invoiceService';
import { loadInvoiceForRender } from '../../services/invoicePdf';
import { getOrMintInvoiceLink } from '../../services/invoiceLinkToken';
import { invoicesPublicRoutes } from '../../routes/invoicesPublic';
import type { InvoiceActor } from '../../services/invoiceTypes';

// #6955 / #6674 (settings audit rule 6): the ticket SUBJECT and CATEGORY that
// group and label an invoice's lines are live on a draft and frozen onto the
// line at issue — the same contract invoice_lines.ticket_label follows (#6940).
const RUN = !!process.env.DATABASE_URL;
const MIGRATION = '2026-10-31-100300-invoice-line-ticket-header-snapshot.sql';

const notices: string[] = [];
const adminSql = postgres(process.env.DATABASE_URL ?? '', { max: 1, onnotice: (n) => { notices.push(String(n.message)); } });
afterAll(async () => { await adminSql.end({ timeout: 5 }); });
async function runMigration(): Promise<string[]> {
  const migrationSql = readFileSync(join(__dirname, '../../../migrations', MIGRATION), 'utf8');
  notices.length = 0;
  await adminSql.unsafe(migrationSql);
  return notices.filter((m) => m.startsWith('invoice-ticket-header:'));
}

interface Fixture { partnerId: string; orgId: string; userId: string }

async function seedFixture(): Promise<Fixture> {
  const suffix = Math.random().toString(36).slice(2, 10);
  return withSystemDbAccessContext(async () => {
    const [p] = await db.insert(partners).values({
      name: `THdr ${suffix}`, slug: `thdr-${suffix}`, type: 'msp', plan: 'pro', status: 'active',
    }).returning({ id: partners.id });
    const [o] = await db.insert(organizations).values({
      partnerId: p!.id, name: `THdr Org ${suffix}`, slug: `thdr-org-${suffix}`, currencyCode: 'USD',
    }).returning({ id: organizations.id });
    const [u] = await db.insert(users).values({
      partnerId: p!.id, orgId: o!.id, email: `tech-${suffix}@example.test`, name: `Tech ${suffix}`, status: 'active',
    }).returning({ id: users.id });
    return { partnerId: p!.id, orgId: o!.id, userId: u!.id };
  });
}
const invActor = (f: Fixture): InvoiceActor => ({ userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] });
const partnerCtx = (f: Fixture): DbAccessContext => ({
  scope: 'partner', orgId: null, accessibleOrgIds: [f.orgId], accessiblePartnerIds: [f.partnerId], userId: f.userId,
});
/** The authenticated portal's context (routes/portal/auth.ts): org scope, no
 *  partner access — ticket_categories (partner-axis) is invisible here. */
const portalCtx = (f: Fixture): DbAccessContext => ({
  scope: 'organization', orgId: f.orgId, accessibleOrgIds: [f.orgId], accessiblePartnerIds: [], userId: null, currentPartnerId: null,
});
const sys = <T,>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);
const as = <T,>(f: Fixture, fn: () => Promise<T>) => withDbAccessContext(partnerCtx(f), fn);

async function seedCategory(f: Fixture, name: string) {
  const [c] = await sys(() => db.insert(ticketCategories).values({ partnerId: f.partnerId, name }).returning({ id: ticketCategories.id }));
  return c!.id;
}
async function seedTicket(f: Fixture, subject: string, categoryId: string | null) {
  const suffix = Math.random().toString(36).slice(2, 12).toUpperCase();
  const [t] = await sys(() => db.insert(tickets).values({
    orgId: f.orgId, partnerId: f.partnerId, ticketNumber: `LEG${suffix}`, internalNumber: `T-${suffix}`,
    subject, categoryId, source: 'manual', status: 'open',
  }).returning({ id: tickets.id }));
  return t!.id;
}
async function draftForTicket(f: Fixture, ticketId: string) {
  const invoice = await as(f, () => invoiceSvc.createManualInvoice({ orgId: f.orgId }, invActor(f)));
  await as(f, () => invoiceSvc.addManualLine(invoice.id, { description: 'Onsite', quantity: 1, unitPrice: 100, taxable: false }, invActor(f)));
  await sys(() => db.update(invoiceLines).set({ ticketId }).where(eq(invoiceLines.invoiceId, invoice.id)));
  return invoice.id;
}

type Header = { subject: string | null; category: string | null };
const pick = (l?: { ticketSubject?: string | null; ticketCategory?: string | null }): Header =>
  ({ subject: l?.ticketSubject ?? null, category: l?.ticketCategory ?? null });

async function webHeader(f: Fixture, id: string) {
  const inv = await as(f, () => invoiceSvc.getInvoice(id, invActor(f)));
  return pick((inv.lines as Array<{ ticketSubject?: string | null; ticketCategory?: string | null }>)[0]);
}
/** The authenticated portal reads under ORG scope — the #6674 case. The
 *  customer payload carries the category (group badge) but not the subject. */
async function portalCategory(f: Fixture, id: string) {
  const res = await withDbAccessContext(portalCtx(f), () => invoiceSvc.getCustomerInvoice(id, f.orgId));
  return res.lines[0]?.ticketCategory ?? null;
}
async function pdfHeader(id: string) {
  const r = await sys(() => loadInvoiceForRender(id));
  return pick(r!.lines[0]);
}
async function publicCategory(id: string) {
  const [row] = await sys(() => db.select().from(invoices).where(eq(invoices.id, id)));
  const { token } = await sys(() => getOrMintInvoiceLink(row!));
  const res = await invoicesPublicRoutes.request(`/${token}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { lines: Array<{ ticketCategory: string | null }> } };
  return body.data.lines[0]?.ticketCategory ?? null;
}
async function allHeaders(f: Fixture, id: string) {
  return { web: await webHeader(f, id), pdf: await pdfHeader(id), portal: await portalCategory(f, id), public: await publicCategory(id) };
}
async function lineSnapshot(id: string): Promise<Header> {
  const [row] = await sys(() => db.select({ subject: invoiceLines.ticketSubject, category: invoiceLines.ticketCategory })
    .from(invoiceLines).where(eq(invoiceLines.invoiceId, id)));
  return { subject: row?.subject ?? null, category: row?.category ?? null };
}

describe.runIf(RUN)('invoice line ticket subject/category snapshot (#6955, #6674)', () => {
  it('a draft shows the live subject and category and stores no snapshot', async () => {
    const f = await seedFixture();
    const cat = await seedCategory(f, 'Hardware');
    const t = await seedTicket(f, 'Printer jam', cat);
    const id = await draftForTicket(f, t);
    expect(await lineSnapshot(id)).toEqual({ subject: null, category: null });
    expect(await webHeader(f, id)).toEqual({ subject: 'Printer jam', category: 'Hardware' });
    await sys(() => db.update(tickets).set({ subject: 'Printer on fire' }).where(eq(tickets.id, t)));
    expect(await webHeader(f, id)).toEqual({ subject: 'Printer on fire', category: 'Hardware' });
  });

  it('issue freezes subject + category; rename, recategorise and soft-delete after issue change nothing on any surface', async () => {
    const f = await seedFixture();
    const cat = await seedCategory(f, 'Hardware');
    const other = await seedCategory(f, 'Networking');
    const t = await seedTicket(f, 'Printer jam', cat);
    const id = await draftForTicket(f, t);
    await as(f, () => invoiceSvc.issueInvoice(id, invActor(f)));
    const frozen = { subject: 'Printer jam', category: 'Hardware' };
    expect(await lineSnapshot(id)).toEqual(frozen);

    await sys(() => db.update(tickets).set({ subject: 'Renamed later', categoryId: other }).where(eq(tickets.id, t)));
    await sys(() => db.update(ticketCategories).set({ name: 'Hardware (renamed)' }).where(eq(ticketCategories.id, cat)));
    const expected = { web: frozen, pdf: frozen, portal: 'Hardware', public: 'Hardware' };
    expect(await allHeaders(f, id)).toEqual(expected);

    await sys(() => db.update(tickets).set({ deletedAt: new Date() }).where(eq(tickets.id, t)));
    expect(await allHeaders(f, id)).toEqual(expected);
  });

  it('the org-scoped portal shows the category of an issued invoice (#6674: partner-axis join was blind)', async () => {
    const f = await seedFixture();
    const cat = await seedCategory(f, 'Security');
    const t = await seedTicket(f, 'Phishing email', cat);
    const id = await draftForTicket(f, t);
    await as(f, () => invoiceSvc.issueInvoice(id, invActor(f)));
    expect(await portalCategory(f, id)).toBe('Security');
  });

  it('a ticket with no category row snapshots the legacy free-text category', async () => {
    const f = await seedFixture();
    const t = await seedTicket(f, 'Legacy ticket', null);
    await sys(() => db.update(tickets).set({ category: 'Legacy cat' }).where(eq(tickets.id, t)));
    const id = await draftForTicket(f, t);
    await as(f, () => invoiceSvc.issueInvoice(id, invActor(f)));
    expect(await lineSnapshot(id)).toEqual({ subject: 'Legacy ticket', category: 'Legacy cat' });
  });
});

describe.runIf(RUN)('backfill migration ' + MIGRATION, () => {
  it('stamps pre-existing issued lines with what they rendered, leaves drafts NULL, and is a counted no-op on re-run', async () => {
    const f = await seedFixture();
    const cat = await seedCategory(f, 'Backups');
    const t = await seedTicket(f, 'Restore failed', cat);
    const issued = await draftForTicket(f, t);
    await as(f, () => invoiceSvc.issueInvoice(issued, invActor(f)));
    // Simulate an invoice issued before these columns existed.
    await sys(() => db.update(invoiceLines).set({ ticketSubject: null, ticketCategory: null }).where(eq(invoiceLines.invoiceId, issued)));
    const draft = await draftForTicket(f, t);

    const warnings = await runMigration();
    const frozen = { subject: 'Restore failed', category: 'Backups' };
    expect(await lineSnapshot(issued)).toEqual(frozen);
    expect(await portalCategory(f, issued)).toBe('Backups');
    expect(await lineSnapshot(draft)).toEqual({ subject: null, category: null });
    const counted = warnings.find((w) => /backfilled ticket subject\/category on \d+ issued invoice lines/.test(w));
    expect(counted).toBeDefined();
    expect(Number(counted!.match(/on (\d+) issued/)![1])).toBeGreaterThanOrEqual(1);

    await sys(() => db.update(tickets).set({ subject: 'Renamed after backfill' }).where(eq(tickets.id, t)));
    const again = await runMigration();
    expect(again.filter((w) => /backfilled/.test(w))).toEqual([]);
    expect(await lineSnapshot(issued)).toEqual(frozen);
  });
});
