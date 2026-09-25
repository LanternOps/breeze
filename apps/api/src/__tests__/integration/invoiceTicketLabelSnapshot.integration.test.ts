import './setup';
import { describe, it, expect, vi, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

// BullMQ side effects are not the snapshot semantics under test — stub them so
// no socket is opened (same stubs as invoicePresentationSnapshot).
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
import { partners, organizations, users, invoices, invoiceLines, tickets } from '../../db/schema';
import * as invoiceSvc from '../../services/invoiceService';
import { getOrMintInvoiceLink } from '../../services/invoiceLinkToken';
import { invoicesPublicRoutes } from '../../routes/invoicesPublic';
import type { InvoiceActor } from '../../services/invoiceTypes';

// Sweep C4 + settings audit rule 6: the "Ticket #…" label on an invoice line is
// live on a draft (the human internal_number) and frozen onto the line at issue.
const RUN = !!process.env.DATABASE_URL;
const MIGRATION = '2026-10-30-140000-invoice-line-ticket-label-snapshot.sql';

const notices: string[] = [];
const adminSql = postgres(process.env.DATABASE_URL ?? '', { max: 1, onnotice: (n) => { notices.push(String(n.message)); } });
afterAll(async () => { await adminSql.end({ timeout: 5 }); });
async function runMigration(): Promise<string[]> {
  const migrationSql = readFileSync(join(__dirname, '../../../migrations', MIGRATION), 'utf8');
  notices.length = 0;
  await adminSql.unsafe(migrationSql);
  return notices.filter((m) => m.startsWith('invoice-ticket-label:'));
}

interface Fixture { partnerId: string; orgId: string; userId: string }

async function seedFixture(): Promise<Fixture> {
  const suffix = Math.random().toString(36).slice(2, 10);
  return withSystemDbAccessContext(async () => {
    const [p] = await db.insert(partners).values({
      name: `TLabel ${suffix}`, slug: `tlabel-${suffix}`, type: 'msp', plan: 'pro', status: 'active',
    }).returning({ id: partners.id });
    const [o] = await db.insert(organizations).values({
      partnerId: p!.id, name: `TLabel Org ${suffix}`, slug: `tlabel-org-${suffix}`, currencyCode: 'USD',
    }).returning({ id: organizations.id });
    const [u] = await db.insert(users).values({
      partnerId: p!.id, orgId: o!.id, email: `tech-${suffix}@example.test`, name: `Tech ${suffix}`, status: 'active',
    }).returning({ id: users.id });
    return { partnerId: p!.id, orgId: o!.id, userId: u!.id };
  });
}
const invActor = (f: Fixture): InvoiceActor => ({ userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] });
const ctx = (f: Fixture): DbAccessContext => ({
  scope: 'partner', orgId: null, accessibleOrgIds: [f.orgId], accessiblePartnerIds: [f.partnerId], userId: f.userId,
});
const sys = <T,>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);
const as = <T,>(f: Fixture, fn: () => Promise<T>) => withDbAccessContext(ctx(f), fn);

async function seedTicket(f: Fixture, internalNumber: string | null) {
  const suffix = Math.random().toString(36).slice(2, 12).toUpperCase();
  const [t] = await sys(() => db.insert(tickets).values({
    orgId: f.orgId, partnerId: f.partnerId, ticketNumber: `LEG${suffix}`, internalNumber,
    subject: 'Printer jam', source: 'manual', status: 'open',
  }).returning({ id: tickets.id, ticketNumber: tickets.ticketNumber }));
  return t!;
}

/** Draft with one manual line linked to `ticketId`. */
async function draftForTicket(f: Fixture, ticketId: string) {
  const invoice = await as(f, () => invoiceSvc.createManualInvoice({ orgId: f.orgId }, invActor(f)));
  await as(f, () => invoiceSvc.addManualLine(invoice.id, { description: 'Onsite', quantity: 1, unitPrice: 100, taxable: false }, invActor(f)));
  await sys(() => db.update(invoiceLines).set({ ticketId }).where(eq(invoiceLines.invoiceId, invoice.id)));
  return invoice.id;
}

async function webLabel(f: Fixture, id: string) {
  const inv = await as(f, () => invoiceSvc.getInvoice(id, invActor(f)));
  return (inv.lines as Array<{ ticketNumber?: string | null }>)[0]?.ticketNumber ?? null;
}
async function portalLabel(f: Fixture, id: string) {
  const res = await sys(() => invoiceSvc.getCustomerInvoice(id, f.orgId));
  return res.lines[0]?.ticketNumber ?? null;
}
/** The customer's tokenised pay page (GET /invoices/public/:token). */
async function publicLabel(id: string) {
  const [row] = await sys(() => db.select().from(invoices).where(eq(invoices.id, id)));
  const { token } = await sys(() => getOrMintInvoiceLink(row!));
  const res = await invoicesPublicRoutes.request(`/${token}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { lines: Array<{ ticketNumber: string | null }> } };
  return body.data.lines[0]?.ticketNumber ?? null;
}
async function lineLabel(id: string) {
  const [row] = await sys(() => db.select({ ticketLabel: invoiceLines.ticketLabel }).from(invoiceLines).where(eq(invoiceLines.invoiceId, id)));
  return row?.ticketLabel ?? null;
}

describe.runIf(RUN)('invoice line ticket label (sweep C4, settings rule 6)', () => {
  it('a draft shows the live human number (internal_number), not the legacy id', async () => {
    const f = await seedFixture();
    const t = await seedTicket(f, 'T-2026-0101');
    const id = await draftForTicket(f, t.id);
    expect(await lineLabel(id)).toBeNull();
    expect(await webLabel(f, id)).toBe('T-2026-0101');
    expect(await portalLabel(f, id)).toBe('T-2026-0101');
  });

  it('issue snapshots the label; a later ticket renumber does not change the issued invoice', async () => {
    const f = await seedFixture();
    const t = await seedTicket(f, 'T-2026-0102');
    const id = await draftForTicket(f, t.id);
    await as(f, () => invoiceSvc.issueInvoice(id, invActor(f)));
    expect(await lineLabel(id)).toBe('T-2026-0102');

    await sys(() => db.update(tickets).set({ internalNumber: 'T-2026-9999' }).where(eq(tickets.id, t.id)));
    expect(await webLabel(f, id)).toBe('T-2026-0102');
    expect(await portalLabel(f, id)).toBe('T-2026-0102');
    expect(await publicLabel(id)).toBe('T-2026-0102');
  });

  it('a ticket with no internal_number falls back to the legacy ticket_number at issue', async () => {
    const f = await seedFixture();
    const t = await seedTicket(f, null);
    const id = await draftForTicket(f, t.id);
    expect(await webLabel(f, id)).toBe(t.ticketNumber);
    await as(f, () => invoiceSvc.issueInvoice(id, invActor(f)));
    expect(await lineLabel(id)).toBe(t.ticketNumber);
  });
});

describe.runIf(RUN)('backfill migration ' + MIGRATION, () => {
  it('stamps pre-existing issued lines with the legacy label they printed, leaves drafts NULL, and is a counted no-op on re-run', async () => {
    const f = await seedFixture();
    const t = await seedTicket(f, 'T-2026-0201');
    const issued = await draftForTicket(f, t.id);
    await as(f, () => invoiceSvc.issueInvoice(issued, invActor(f)));
    // Simulate an invoice issued before this column existed.
    await sys(() => db.update(invoiceLines).set({ ticketLabel: null }).where(eq(invoiceLines.invoiceId, issued)));
    const draft = await draftForTicket(f, t.id);

    const warnings = await runMigration();
    // Pre-PR invoices printed COALESCE(ticket_number, internal_number) — the legacy id.
    expect(await lineLabel(issued)).toBe(t.ticketNumber);
    expect(await webLabel(f, issued)).toBe(t.ticketNumber);
    expect(await lineLabel(draft)).toBeNull();
    expect(await webLabel(f, draft)).toBe('T-2026-0201');
    const counted = warnings.find((w) => /backfilled ticket_label on \d+ issued invoice lines/.test(w));
    expect(counted).toBeDefined();
    expect(Number(counted!.match(/on (\d+) issued/)![1])).toBeGreaterThanOrEqual(1);

    const again = await runMigration();
    expect(again.filter((w) => /backfilled/.test(w))).toEqual([]);
    expect(await lineLabel(issued)).toBe(t.ticketNumber);
  });
});
