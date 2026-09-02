import './setup';
import { describe, it, expect, vi, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';
import postgres from 'postgres';

vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/quoteEvents', () => ({ emitQuoteEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { partners, organizations, users, invoices, quotes, quoteBlocks, quoteLines, quoteAcceptances, contractTemplates, contractTemplateVersions } from '../../db/schema';
import * as invoiceSvc from '../../services/invoiceService';
import { createQuote, addManualLine as addQuoteLine } from '../../services/quoteService';
import { sendQuote } from '../../services/quoteLifecycle';
import { acceptQuote } from '../../services/quoteAcceptService';
import { verifyQuoteAcceptanceHash } from '../../services/quoteAcceptanceVerify';
import { loadContractBlockRenderData } from '../../services/contractTemplateRender';
import { buildContractHashParts } from '../../services/contractDocumentService';
import { computeQuoteSha256 } from '../../services/quoteContentHash';
import { resolveQuoteBranding } from '../../services/quoteBranding';
import { renderQuotePdf } from '../../services/quotePdf';
import type { InvoiceActor } from '../../services/invoiceTypes';
import type { QuoteActor } from '../../services/quoteTypes';

const RUN = !!process.env.DATABASE_URL;
const MIGRATION = '2026-09-01-b-document-locale-backfill.sql';
const migrationSql = readFileSync(join(__dirname, '../../../migrations', MIGRATION), 'utf8');

// A dedicated superuser client (the role autoMigrate runs as) with onnotice
// wired, so the migration's RAISE WARNING row counts can be asserted.
const notices: string[] = [];
const adminSql = postgres(process.env.DATABASE_URL ?? '', { max: 1, onnotice: (n) => { notices.push(String(n.message)); } });
afterAll(async () => { await adminSql.end({ timeout: 5 }); });
async function runBackfill(): Promise<string[]> {
  notices.length = 0;
  await adminSql.unsafe(migrationSql);
  return notices.filter((m) => m.startsWith('document-locale:'));
}

interface Fixture { partnerId: string; orgId: string; userId: string }

/** Disjoint tenant per call: `language` partner, EUR org. */
async function seedFixture(language: string): Promise<Fixture> {
  const suffix = Math.random().toString(36).slice(2, 10);
  return withSystemDbAccessContext(async () => {
    const [p] = await db.insert(partners).values({
      name: `Bf ${suffix}`, slug: `bf-${suffix}`, type: 'msp', plan: 'pro', status: 'active',
      currencyCode: 'EUR', settings: { language },
    }).returning({ id: partners.id });
    const [o] = await db.insert(organizations).values({
      partnerId: p!.id, name: `Bf Org ${suffix}`, slug: `bf-org-${suffix}`, currencyCode: 'EUR',
    }).returning({ id: organizations.id });
    const [u] = await db.insert(users).values({
      partnerId: p!.id, orgId: o!.id, email: `tech-${suffix}@example.test`, name: `Tech ${suffix}`, status: 'active',
    }).returning({ id: users.id });
    return { partnerId: p!.id, orgId: o!.id, userId: u!.id };
  });
}
function invActor(f: Fixture): InvoiceActor { return { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] }; }
function quoteActor(f: Fixture): QuoteActor { return { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] }; }
function ctx(f: Fixture): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: [f.orgId], accessiblePartnerIds: [f.partnerId], userId: f.userId };
}
const sys = <T,>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);

async function setPartnerLanguage(partnerId: string, language: string) {
  await sys(() => db.update(partners).set({ settings: { language } }).where(eq(partners.id, partnerId)));
}
async function invoiceRow(id: string) {
  const [row] = await sys(() => db.select({ documentLocale: invoices.documentLocale, status: invoices.status }).from(invoices).where(eq(invoices.id, id)));
  return row!;
}
async function quoteRow(id: string) {
  const [row] = await sys(() => db.select().from(quotes).where(eq(quotes.id, id)));
  return row!;
}
async function acceptanceRow(id: string) {
  const [row] = await sys(() => db.select().from(quoteAcceptances).where(eq(quoteAcceptances.id, id)));
  return row!;
}
/** Simulate a pre-#3777 document: wipe the stamp the current code wrote. */
const unstampInvoice = (id: string) => sys(() => db.update(invoices).set({ documentLocale: null }).where(eq(invoices.id, id)));
const unstampQuote = (id: string) => sys(() => db.update(quotes).set({ documentLocale: null }).where(eq(quotes.id, id)));
const unstampAcceptance = (id: string) => sys(() => db.update(quoteAcceptances).set({ renderLocale: null }).where(eq(quoteAcceptances.id, id)));

async function draftInvoice(f: Fixture) {
  const a = invActor(f);
  const invoice = await withDbAccessContext(ctx(f), () => invoiceSvc.createManualInvoice({ orgId: f.orgId }, a));
  await withDbAccessContext(ctx(f), () => invoiceSvc.addManualLine(invoice.id, { description: 'Service', quantity: 1, unitPrice: 1000, taxable: false }, a));
  return invoice.id;
}
async function legacyIssuedInvoice(f: Fixture) {
  const id = await draftInvoice(f);
  await withDbAccessContext(ctx(f), () => invoiceSvc.issueInvoice(id, invActor(f)));
  await unstampInvoice(id);
  return id;
}
async function draftQuote(f: Fixture, recurrence: 'one_time' | 'monthly' = 'one_time') {
  const a = quoteActor(f);
  const created = await withDbAccessContext(ctx(f), () => createQuote({ orgId: f.orgId, currencyCode: 'EUR' }, a));
  await withDbAccessContext(ctx(f), () => addQuoteLine(created.id, { sourceType: 'manual', description: 'Setup', quantity: 1, unitPrice: 1000, taxable: false, customerVisible: true, recurrence } as any, a));
  return created.id;
}
async function legacySentQuote(f: Fixture, recurrence: 'one_time' | 'monthly' = 'one_time') {
  const id = await draftQuote(f, recurrence);
  await withDbAccessContext(ctx(f), () => sendQuote(id, quoteActor(f)));
  await unstampQuote(id);
  return id;
}

const TEMPLATE_SHA = 'b'.repeat(64);
// {{totals.total}} makes the resolved-variable set (and so the hash) LOCALE-SENSITIVE.
const BODY_HTML = '<h3>MSA</h3><p>Effective {{dates.effective}} for {{client.name}}, total {{totals.total}}.</p>';
async function attachContractBlock(f: Fixture, quoteId: string) {
  await sys(async () => {
    const [template] = await db.insert(contractTemplates)
      .values({ orgId: f.orgId, partnerId: null, name: 'Backfill MSA' }).returning({ id: contractTemplates.id });
    const [version] = await db.insert(contractTemplateVersions).values({
      templateId: template!.id, orgId: f.orgId, partnerId: null, versionNumber: 1,
      status: 'published', sourceType: 'authored', bodyHtml: BODY_HTML,
      sha256: TEMPLATE_SHA, declaredVariables: [], publishedAt: new Date(),
    }).returning({ id: contractTemplateVersions.id });
    await db.insert(quoteBlocks).values({
      quoteId, orgId: f.orgId, blockType: 'contract',
      content: { templateId: template!.id, templateVersionId: version!.id, variableValues: {} }, sortOrder: 1,
    });
  });
}
async function acceptWithContract(quoteId: string) {
  const blocks = await sys(() => db.select({ id: quoteBlocks.id, blockType: quoteBlocks.blockType, content: quoteBlocks.content })
    .from(quoteBlocks).where(eq(quoteBlocks.quoteId, quoteId)).orderBy(quoteBlocks.sortOrder));
  const renderData = await loadContractBlockRenderData(blocks);
  expect(renderData).toHaveLength(1);
  const res = await runOutsideDbContext(() => sys(() => acceptQuote({ quoteId, signerName: 'Jane Buyer', contractRenderData: renderData })));
  return { res, renderData };
}
const verify = (acceptanceId: string) => runOutsideDbContext(() => sys(() => verifyQuoteAcceptanceHash(acceptanceId)));

// pdfkit Flate streams, WinAnsi bytes — same extraction as quotePdf.test.ts /
// documentLocaleStamping. WinAnsi 0x80 is "€"; Intl's no-break space lands as
// U+00A0 — fold both back so assertions read as plain text.
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
    let tm: RegExpExecArray | null;
    while ((tm = tokenRe.exec(body))) {
      if (tm[1] !== undefined) {
        const hex = tm[1].length % 2 ? `${tm[1]}0` : tm[1];
        out += Buffer.from(hex, 'hex').toString('latin1');
      } else {
        out += tm[2]!.replace(/\\([()\\])/g, '$1');
      }
    }
    out += ' ';
  }
  return out.replace(//g, '€').replace(/ /g, ' ');
}

/**
 * #3777 post-merge review, finding 1: documents issued/sent BEFORE
 * 2026-08-31-a-document-locale.sql carried no snapshot and kept following the
 * partner's mutable language. 2026-09-01-b backfills them ONCE from the partner
 * language (drafts untouched), and stamps each legacy acceptance with the
 * locale its hash was actually computed under ('en' — the pre-#3777 fallback)
 * so an already-signed quote keeps verifying after its quote row is restamped.
 */
describe.runIf(RUN)('document_locale backfill (2026-09-01-b)', () => {
  it('backfills non-draft invoices/quotes from the partner language with counted warnings; drafts stay NULL; re-run is a no-op', async () => {
    const fr = await seedFixture('fr-FR');
    const odd = await seedFixture('xx-YY'); // unsupported language → 'en', exactly like resolvePartnerDocumentLocale
    const frInvoice = await legacyIssuedInvoice(fr);
    const oddInvoice = await legacyIssuedInvoice(odd);
    const frDraftInvoice = await draftInvoice(fr);
    const frQuote = await legacySentQuote(fr);
    const frDraftQuote = await draftQuote(fr);
    expect((await invoiceRow(frInvoice)).documentLocale).toBeNull();
    expect((await quoteRow(frQuote)).documentLocale).toBeNull();

    const warnings = await runBackfill();
    expect(warnings).toEqual([
      'document-locale: backfilled document_locale on 2 non-draft invoices from partner language',
      'document-locale: backfilled document_locale on 1 non-draft quotes from partner language',
    ]);
    expect(await invoiceRow(frInvoice)).toMatchObject({ status: 'sent', documentLocale: 'fr-FR' });
    expect(await invoiceRow(oddInvoice)).toMatchObject({ status: 'sent', documentLocale: 'en' });
    expect(await invoiceRow(frDraftInvoice)).toMatchObject({ status: 'draft', documentLocale: null });
    expect(await quoteRow(frQuote)).toMatchObject({ status: 'sent', documentLocale: 'fr-FR' });
    expect(await quoteRow(frDraftQuote)).toMatchObject({ status: 'draft', documentLocale: null });

    // Idempotent: a second run touches nothing (no counted warnings), even after
    // the partner's language moved on — the snapshot is never re-derived.
    await setPartnerLanguage(fr.partnerId, 'de-DE');
    expect(await runBackfill()).toEqual([]);
    expect((await invoiceRow(frInvoice)).documentLocale).toBe('fr-FR');
    expect((await quoteRow(frQuote)).documentLocale).toBe('fr-FR');
    expect((await quoteRow(frDraftQuote)).documentLocale).toBeNull();
  });

  it("a French partner's legacy sent quote renders French after the backfill, even once the partner switches language", async () => {
    const fr = await seedFixture('fr-FR');
    const quoteId = await legacySentQuote(fr);
    await runBackfill();
    await setPartnerLanguage(fr.partnerId, 'en'); // the mutable setting must no longer matter

    const quote = await quoteRow(quoteId);
    expect(quote.documentLocale).toBe('fr-FR');
    const branding = await sys(() => resolveQuoteBranding(quote));
    expect(branding.locale).toBe('fr-FR');

    const blocks = await sys(() => db.select().from(quoteBlocks).where(eq(quoteBlocks.quoteId, quoteId)).orderBy(quoteBlocks.sortOrder));
    const lines = await sys(() => db.select().from(quoteLines).where(eq(quoteLines.quoteId, quoteId)).orderBy(quoteLines.sortOrder));
    const pdf = await renderQuotePdf(quote as any, blocks as any, lines as any, async () => null, branding);
    const text = extractPdfText(pdf);
    expect(text).toContain('1 000,00 €'); // fr-FR: grouped by space, symbol trailing
    expect(text).not.toContain('€1,000.00');
  });

  it('an already-accepted legacy quote (hashed under the old English fallback) still verifies after its quote row is restamped', async () => {
    const fr = await seedFixture('fr-FR');
    const quoteId = await legacySentQuote(fr, 'monthly');
    await attachContractBlock(fr, quoteId);
    // Legacy accept: neither the quote nor the partner carried a non-English
    // locale at signing, so the hash + executed PDF were computed under 'en'.
    // (Pre-#3777 the accept path hard-coded that fallback; today it follows the
    // partner language, which is what this fixture pins to 'en' for the accept.)
    // Then wipe render_locale to model a pre-backfill row and restore fr-FR.
    await setPartnerLanguage(fr.partnerId, 'en');
    const { res, renderData } = await acceptWithContract(quoteId);
    expect((await acceptanceRow(res.acceptanceId)).renderLocale).toBe('en');
    await unstampAcceptance(res.acceptanceId);
    await setPartnerLanguage(fr.partnerId, 'fr-FR');

    const warnings = await runBackfill();
    expect(warnings).toContain('document-locale: stamped render_locale on 1 legacy quote_acceptances');
    // The converted quote now carries the partner language; the acceptance keeps
    // the locale that was in force at signing.
    expect(await quoteRow(quoteId)).toMatchObject({ status: 'converted', documentLocale: 'fr-FR' });
    expect((await acceptanceRow(res.acceptanceId)).renderLocale).toBe('en');
    await setPartnerLanguage(fr.partnerId, 'de-DE');

    const result = await verify(res.acceptanceId);
    expect(result.renderLocale).toBe('en');
    expect(result.matches).toBe(true);

    // Negative control — proves the locale genuinely moves the hash: recomputing
    // under the quote's NEW stamp would NOT match the stored signature.
    const quote = await quoteRow(quoteId);
    const blocks = await sys(() => db.select().from(quoteBlocks).where(eq(quoteBlocks.quoteId, quoteId)).orderBy(quoteBlocks.sortOrder));
    const lines = await sys(() => db.select().from(quoteLines).where(eq(quoteLines.quoteId, quoteId)).orderBy(quoteLines.sortOrder));
    const effectiveDate = quote.acceptedAt!.toISOString().slice(0, 10);
    const underFr = computeQuoteSha256(quote as any, blocks as any, lines as any, buildContractHashParts(blocks as any, renderData, quote as any, effectiveDate, 'fr-FR'));
    expect(underFr).not.toBe(result.storedSha256);
  });

  // #3777 post-merge review, finding 1: accept-time renderLocale must fall back
  // to the PARTNER language, exactly like the portal/public render the signer
  // saw — not to 'en'. Historical rows are unaffected (they carry a persisted
  // render_locale from this very migration), which is what makes the change safe.
  it('an UNSTAMPED quote is hashed under the partner language it was rendered in, not en', async () => {
    const fr = await seedFixture('fr-FR');
    const quoteId = await legacySentQuote(fr, 'monthly'); // sent then unstamped
    expect((await quoteRow(quoteId)).documentLocale).toBeNull();
    await attachContractBlock(fr, quoteId);

    const { res, renderData } = await acceptWithContract(quoteId);
    expect((await acceptanceRow(res.acceptanceId)).renderLocale).toBe('fr-FR');

    // Verifies under the persisted locale, and the English fallback would NOT
    // have produced this signature — the divergence the finding describes.
    const result = await verify(res.acceptanceId);
    expect(result).toMatchObject({ renderLocale: 'fr-FR', matches: true });
    const quote = await quoteRow(quoteId);
    const blocks = await sys(() => db.select().from(quoteBlocks).where(eq(quoteBlocks.quoteId, quoteId)).orderBy(quoteBlocks.sortOrder));
    const lines = await sys(() => db.select().from(quoteLines).where(eq(quoteLines.quoteId, quoteId)).orderBy(quoteLines.sortOrder));
    const effectiveDate = quote.acceptedAt!.toISOString().slice(0, 10);
    const underEn = computeQuoteSha256(quote as any, blocks as any, lines as any, buildContractHashParts(blocks as any, renderData, quote as any, effectiveDate, 'en'));
    expect(underEn).not.toBe(result.storedSha256);
  });

  it('a quote accepted AFTER stamping persists its fr-FR render locale and verifies under it', async () => {
    const fr = await seedFixture('fr-FR');
    const quoteId = await draftQuote(fr, 'monthly');
    await withDbAccessContext(ctx(fr), () => sendQuote(quoteId, quoteActor(fr)));
    expect((await quoteRow(quoteId)).documentLocale).toBe('fr-FR');
    await attachContractBlock(fr, quoteId);
    const { res } = await acceptWithContract(quoteId);
    expect((await acceptanceRow(res.acceptanceId)).renderLocale).toBe('fr-FR');

    await setPartnerLanguage(fr.partnerId, 'en');
    expect(await runBackfill()).toEqual([]); // nothing left to stamp
    const result = await verify(res.acceptanceId);
    expect(result).toMatchObject({ renderLocale: 'fr-FR', matches: true });
  });
});
