/**
 * #3205 W07 (#4656) Task 5 — device appendix stamping at issuance.
 *
 * NOTE ON PROVENANCE: this file is newly created for this task (Step 2 of the
 * brief instructs creating it; it was omitted from the brief's top-level
 * "Files" list, which is a documentation gap in the brief, not a signal to
 * skip it — Steps 2/8/9 all name it explicitly). Every fixture below is
 * original, modeled on `seedDraftInvoice`/`seedIssuedInvoice` in
 * `invoicePdf.integration.test.ts` (direct-insert org/invoice seeding) and the
 * quote -> send -> accept sequence in
 * `multiCurrencyWave6QuoteAcceptance.integration.test.ts` (createQuote ->
 * addManualLine -> updateQuote(deposit) -> sendQuote -> acceptQuote).
 *
 * #3205 W07 decision 14a — the appendix choice is FROZEN AT ISSUANCE and stable
 * across every sanctioned re-render. Not "byte-stable forever": the reset-link
 * path legitimately re-renders and rewrites the stored document
 * (invoicePdf.ts mints the public link into the bytes). The PDF-content
 * assertions for that claim are Task 7's job — this file only turns the
 * stamping cases green.
 *
 * Runs under vitest.integration.config.ts against a real Postgres.
 * integration/setup.ts TRUNCATEs core tenant tables before every test.
 */
import './setup';

import zlib from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { db, withSystemDbAccessContext } from '../../db';
import { devices, invoiceDocuments, invoiceLineDevices, invoiceLines, invoices, organizations, partners, sites } from '../../db/schema';
import { issueInvoice } from '../../services/invoiceService';
import type { InvoiceActor } from '../../services/invoiceTypes';
import { renderInvoicePdf } from '../../services/invoicePdf';
import { acceptQuote } from '../../services/quoteAcceptService';
import { sendQuote } from '../../services/quoteLifecycle';
import { addManualLine, createQuote, updateQuote } from '../../services/quoteService';
import type { QuoteActor } from '../../services/quoteTypes';
import { seedGateOrg } from './multiCurrencyWave6GateFixtures';

const RUN = !!process.env.DATABASE_URL;
const runDb = it.runIf(RUN);

// pdfkit Flate-compresses page streams; decode show-text operands before
// asserting customer-visible content (same helper pattern as the currency PDF
// integration suite).
function extractPdfText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  const headerRe = /\/Length\s+(\d+)[\s\S]{0,120}?\/Filter\s+\/FlateDecode[\s\S]{0,40}?stream\r?\n/g;
  let out = '';
  let match: RegExpExecArray | null;
  while ((match = headerRe.exec(raw))) {
    const compressed = Buffer.from(raw.slice(headerRe.lastIndex, headerRe.lastIndex + Number(match[1])), 'latin1');
    let body: string;
    try { body = zlib.inflateSync(compressed).toString('latin1'); } catch { continue; }
    const tokenRe = /<([0-9a-fA-F]+)>|\(((?:[^()\\]|\\.)*)\)/g;
    let token: RegExpExecArray | null;
    while ((token = tokenRe.exec(body))) {
      out += token[1] !== undefined
        ? Buffer.from(token[1].length % 2 ? `${token[1]}0` : token[1], 'hex').toString('latin1')
        : token[2]!.replace(/\\([()\\])/g, '$1');
    }
    out += ' ';
  }
  return out;
}

const ACTOR: InvoiceActor = { userId: null, partnerId: null, accessibleOrgIds: null };

interface DraftFixture { invoiceId: string; partnerId: string; orgId: string; actor: InvoiceActor }

interface EvidenceDevice {
  hostname: string;
  countedAs: 'included' | 'overage' | 'flagged';
}

/** A DRAFT invoice (one customer-visible line, so issueInvoice's
 *  NO_VISIBLE_LINES guard is satisfied) under a partner stamped with the given
 *  invoice_device_appendix default. */
async function seedDraftInvoice(opts: { invoiceDeviceAppendix: boolean }): Promise<DraftFixture> {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({
        name: `AP ${sfx}`, slug: `ap-${sfx}`, type: 'msp', plan: 'pro', status: 'active',
        invoiceDeviceAppendix: opts.invoiceDeviceAppendix,
      })
      .returning({ id: partners.id });
    const [o] = await db.insert(organizations)
      .values({ currencyCode: 'USD', partnerId: p!.id, name: `AP Org ${sfx}`, slug: `ap-org-${sfx}` })
      .returning({ id: organizations.id });
    const [inv] = await db.insert(invoices).values({
      partnerId: p!.id, orgId: o!.id, status: 'draft', currencyCode: 'USD',
    }).returning({ id: invoices.id });
    await db.insert(invoiceLines).values({
      invoiceId: inv!.id, orgId: o!.id, sourceType: 'manual', name: 'Consulting',
      description: 'Consulting', quantity: '1', unitPrice: '100.00', taxable: false,
      customerVisible: true, lineTotal: '100.00', sortOrder: 0,
    });
    return { invoiceId: inv!.id, partnerId: p!.id, orgId: o!.id, actor: ACTOR };
  });
}

async function seedDraftInvoiceWithEvidence(opts: {
  invoiceDeviceAppendix?: boolean;
  draftOverride?: boolean;
  devices?: EvidenceDevice[];
}): Promise<DraftFixture> {
  const fixture = await seedDraftInvoice({ invoiceDeviceAppendix: opts.invoiceDeviceAppendix ?? false });
  await withSystemDbAccessContext(async () => {
    if (opts.draftOverride !== undefined) {
      await db.update(invoices).set({ deviceAppendix: opts.draftOverride })
        .where(eq(invoices.id, fixture.invoiceId));
    }
    const [line] = await db.select({ id: invoiceLines.id }).from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, fixture.invoiceId)).limit(1);
    const evidence = opts.devices ?? [{ hostname: 'billed-01', countedAs: 'included' as const }];
    if (!evidence.length) return;
    const [site] = await db.insert(sites).values({ orgId: fixture.orgId, name: 'Appendix Site' })
      .returning({ id: sites.id });
    const seededDevices = await db.insert(devices).values(evidence.map((d, i) => ({
      orgId: fixture.orgId, siteId: site!.id, agentId: `appendix-${fixture.invoiceId}-${i}`,
      hostname: d.hostname, status: 'online' as const, deviceRole: 'server', osType: 'linux' as const,
      osVersion: '1', architecture: 'x86_64', agentVersion: '1',
    }))).returning({ id: devices.id, hostname: devices.hostname, deviceRole: devices.deviceRole });
    await db.insert(invoiceLineDevices).values(seededDevices.map((d, i) => ({
      invoiceLineId: line!.id, invoiceId: fixture.invoiceId, orgId: fixture.orgId,
      deviceId: d.id, hostname: d.hostname, deviceRole: d.deviceRole, siteId: site!.id,
      countedAs: evidence[i]!.countedAs,
    })));
  });
  return fixture;
}

async function seedIssuedInvoiceWithEvidence(opts: {
  invoiceDeviceAppendix: boolean;
  draftOverride?: boolean;
  devices?: EvidenceDevice[];
}): Promise<DraftFixture> {
  const fixture = await seedDraftInvoiceWithEvidence(opts);
  await withSystemDbAccessContext(() => issueInvoice(fixture.invoiceId, fixture.actor));
  return fixture;
}

/** A quote with a single deposit-eligible one-time line, sent and ready to
 *  accept — accepting it auto-issues the converted invoice (never through
 *  issueInvoice), the other writer the appendix stamp must cover. */
async function seedAcceptableQuoteWithDeposit(opts: { invoiceDeviceAppendix: boolean }) {
  const fixture = await seedGateOrg('USD');
  await withSystemDbAccessContext(() => db.update(partners)
    .set({ invoiceDeviceAppendix: opts.invoiceDeviceAppendix }).where(eq(partners.id, fixture.partnerId)));
  const actor: QuoteActor = { userId: fixture.userId, partnerId: fixture.partnerId, accessibleOrgIds: [fixture.orgId] } as QuoteActor;
  const quote = await withSystemDbAccessContext(() => createQuote({ orgId: fixture.orgId }, actor));
  await withSystemDbAccessContext(() => addManualLine(quote.id, {
    sourceType: 'manual', name: 'Deposit Line', description: 'Deposit Line', quantity: 1, unitPrice: 1000,
    taxable: false, customerVisible: true, recurrence: 'one_time', depositEligible: true,
  } as never, actor));
  await withSystemDbAccessContext(() => updateQuote(quote.id, { depositType: 'percent', depositPercent: 30 } as never, actor));
  await withSystemDbAccessContext(() => sendQuote(quote.id, actor));
  return {
    quoteId: quote.id, partnerId: fixture.partnerId, orgId: fixture.orgId,
    acceptance: { quoteId: quote.id, signerName: 'Appendix Signer' },
  };
}

describe.runIf(RUN)('device appendix stamping (real DB) #3205 W07', () => {
  runDb('issueInvoice stamps the RESOLVED partner default onto invoices.device_appendix', async () => {
    for (const partnerDefault of [true, false]) {
      const f = await seedDraftInvoice({ invoiceDeviceAppendix: partnerDefault });
      await withSystemDbAccessContext(() => issueInvoice(f.invoiceId, f.actor));
      const [inv] = await withSystemDbAccessContext(() => db.select({ a: invoices.deviceAppendix })
        .from(invoices).where(eq(invoices.id, f.invoiceId)));
      expect(inv!.a).toBe(partnerDefault);        // a concrete boolean, never NULL
    }
  });

  runDb('the quote-acceptance deposit invoice stamps it too (it never goes through issueInvoice)', async () => {
    const f = await seedAcceptableQuoteWithDeposit({ invoiceDeviceAppendix: true });
    const out = await withSystemDbAccessContext(() => acceptQuote(f.acceptance));
    const [inv] = await withSystemDbAccessContext(() => db.select({ a: invoices.deviceAppendix, s: invoices.status })
      .from(invoices).where(eq(invoices.id, out.invoiceId)));
    expect(inv!.s).toBe('sent');
    expect(inv!.a).toBe(true);
  });

  runDb('a per-invoice override set on the DRAFT wins over the partner default at issue', async () => {
    const f = await seedDraftInvoice({ invoiceDeviceAppendix: false });
    await withSystemDbAccessContext(() => db.update(invoices).set({ deviceAppendix: true })
      .where(eq(invoices.id, f.invoiceId)));
    await withSystemDbAccessContext(() => issueInvoice(f.invoiceId, f.actor));
    const [inv] = await withSystemDbAccessContext(() => db.select({ a: invoices.deviceAppendix })
      .from(invoices).where(eq(invoices.id, f.invoiceId)));
    expect(inv!.a).toBe(true);
  });

  runDb('flipping the partner default AFTER issue does not change the stamp', async () => {
    const f = await seedDraftInvoice({ invoiceDeviceAppendix: false });
    await withSystemDbAccessContext(() => issueInvoice(f.invoiceId, f.actor));
    await withSystemDbAccessContext(() => db.update(partners).set({ invoiceDeviceAppendix: true })
      .where(eq(partners.id, f.partnerId)));
    const [inv] = await withSystemDbAccessContext(() => db.select({ a: invoices.deviceAppendix })
      .from(invoices).where(eq(invoices.id, f.invoiceId)));
    expect(inv!.a).toBe(false);
  });
});

describe.runIf(RUN)('appendix rendering is gated by the STAMP only (#3205 W07)', () => {
  runDb('absent when both flags are false', async () => {
    const f = await seedIssuedInvoiceWithEvidence({ invoiceDeviceAppendix: false });
    const { pdf } = await withSystemDbAccessContext(() => renderInvoicePdf(f.invoiceId));
    expect(extractPdfText(pdf)).not.toContain('Billed devices');
  });

  runDb('present with the partner flag on at issue', async () => {
    const f = await seedIssuedInvoiceWithEvidence({ invoiceDeviceAppendix: true });
    const { pdf } = await withSystemDbAccessContext(() => renderInvoicePdf(f.invoiceId));
    expect(extractPdfText(pdf)).toContain('Billed devices');
  });

  runDb('present with the partner flag off and the per-invoice override on at issue', async () => {
    const f = await seedIssuedInvoiceWithEvidence({ invoiceDeviceAppendix: false, draftOverride: true });
    const { pdf } = await withSystemDbAccessContext(() => renderInvoicePdf(f.invoiceId));
    expect(extractPdfText(pdf)).toContain('Billed devices');
  });

  runDb('ABSENT with the partner flag on and the per-invoice override explicitly false', async () => {
    const f = await seedIssuedInvoiceWithEvidence({ invoiceDeviceAppendix: true, draftOverride: false });
    const { pdf } = await withSystemDbAccessContext(() => renderInvoicePdf(f.invoiceId));
    expect(extractPdfText(pdf)).not.toContain('Billed devices');
  });

  runDb('FREEZE: flipping the partner default after issue does not change a sanctioned re-render', async () => {
    const f = await seedIssuedInvoiceWithEvidence({ invoiceDeviceAppendix: false });
    await withSystemDbAccessContext(() => db.update(partners)
      .set({ invoiceDeviceAppendix: true }).where(eq(partners.id, f.partnerId)));
    // The reset-link path legitimately re-renders and rewrites the stored bytes.
    const { pdf } = await withSystemDbAccessContext(() => renderInvoicePdf(f.invoiceId));
    expect(extractPdfText(pdf)).not.toContain('Billed devices');
    // ...and the mirror case.
    const g = await seedIssuedInvoiceWithEvidence({ invoiceDeviceAppendix: true });
    await withSystemDbAccessContext(() => db.update(partners)
      .set({ invoiceDeviceAppendix: false }).where(eq(partners.id, g.partnerId)));
    const out = await withSystemDbAccessContext(() => renderInvoicePdf(g.invoiceId));
    expect(extractPdfText(out.pdf)).toContain('Billed devices');
  });

  runDb('flagged rows NEVER appear in the rendered bytes (ruling 4)', async () => {
    const f = await seedIssuedInvoiceWithEvidence({
      invoiceDeviceAppendix: true,
      devices: [{ hostname: 'billed-01', countedAs: 'included' }, { hostname: 'flagged-99', countedAs: 'flagged' }],
    });
    const { pdf } = await withSystemDbAccessContext(() => renderInvoicePdf(f.invoiceId));
    const out = extractPdfText(pdf);
    expect(out).toContain('billed-01');
    expect(out).not.toContain('flagged-99');       // not charged -> never on the customer's document
  });

  runDb('FLAGGED-BEFORE-CAP: 1,900 included + 500 flagged prints 1,900 rows and NO truncation line', async () => {
    // The filter is in the SQL, applied BEFORE the 2,001-row cap. Applied after,
    // this line would spend 500 of its cap on rows that are never printed and
    // then falsely claim truncation.
    const f = await seedIssuedInvoiceWithEvidence({
      invoiceDeviceAppendix: true,
      devices: [
        ...Array.from({ length: 1900 }, (_, i) => ({ hostname: `inc-${String(i).padStart(4, '0')}`, countedAs: 'included' as const })),
        ...Array.from({ length: 500 }, (_, i) => ({ hostname: `flg-${String(i).padStart(4, '0')}`, countedAs: 'flagged' as const })),
      ],
    });
    const { pdf } = await withSystemDbAccessContext(() => renderInvoicePdf(f.invoiceId));
    const out = extractPdfText(pdf);
    expect(out).toContain('inc-0000');
    expect(out).toContain('inc-1899');
    expect(out).not.toContain('flg-');
    expect(out).not.toMatch(/more devices/);
  }, 120_000);

  runDb('a DRAFT renders the appendix in preview and still persists nothing', async () => {
    const f = await seedDraftInvoiceWithEvidence({ draftOverride: true });
    const out = await withSystemDbAccessContext(() => renderInvoicePdf(f.invoiceId));
    expect(out.documentId).toBeNull();
    expect(extractPdfText(out.pdf)).toContain('Billed devices');
    const docs = await withSystemDbAccessContext(() => db.select().from(invoiceDocuments)
      .where(eq(invoiceDocuments.invoiceId, f.invoiceId)));
    expect(docs).toEqual([]);
  });
});
