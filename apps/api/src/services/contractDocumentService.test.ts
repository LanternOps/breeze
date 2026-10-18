import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inArray, type SQL } from 'drizzle-orm';
import { PgDialect, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';

// Record every contract_documents insert payload so the tests can assert the
// row shape (contract linkage, sha256 over the pdf, byteSize) without a DB. The
// insert chain resolves .returning() to a synthetic id per call.
const insertedValues: Array<Record<string, unknown>> = [];
// Rows the SELECT/UPDATE-path calls should resolve to (used by the
// linkContractDocument tests); createExecutedDocuments leaves this empty and
// keeps its synthetic-insert-id behavior.
const selectResults: unknown[][] = [];
function queueResult(rows: unknown[]) { selectResults.push(rows); }

vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  chain.insert = vi.fn(() => chain);
  chain.values = vi.fn((v: Record<string, unknown>) => {
    insertedValues.push(v);
    return chain;
  });
  chain.returning = vi.fn(() =>
    selectResults.length ? Promise.resolve(selectResults.shift()) : Promise.resolve([{ id: `doc-${insertedValues.length}` }]),
  );
  for (const m of ['select', 'from', 'where', 'limit', 'update', 'set', 'innerJoin', 'leftJoin', 'orderBy']) chain[m] = vi.fn(() => chain);
  // Awaiting the chain (a select's `.limit(1)`) shifts the next queued result.
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(selectResults.shift() ?? []).then(resolve);
  return {
    db: chain,
    // contractTemplateRender (imported transitively) reads these at module load.
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});

import {
  createExecutedDocuments,
  freezeSignedAgreement,
  listContractDocuments,
  buildContractHashParts,
  assertContractRenderDataComplete,
  getContractDocumentPdf,
  linkContractDocument,
  ContractDocumentServiceError,
} from './contractDocumentService';
import { db } from '../db';
import type { AuthContext } from '../middleware/auth';
import { renderContextFromQuote, type AgreementRenderContext, type ContractBlockRenderData } from './contractTemplateRender';
import { QuoteServiceError } from './quoteTypes';
import { captureException } from './sentry';

// Spy on the accept-time unresolved-variable alert without touching real Sentry.
vi.mock('./sentry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sentry')>()),
  captureException: vi.fn(),
}));

const EFFECTIVE = '2026-07-16';

function makeQuote(overrides: Record<string, unknown> = {}) {
  return {
    id: 'q1', orgId: 'org1', partnerId: 'p1', currencyCode: 'USD',
    billToName: 'Acme Co', billToAddress: null, sellerSnapshot: { name: 'MSP LLC' },
    quoteNumber: 'Q-1', title: 'Proposal',
    oneTimeTotal: '100.00', monthlyRecurringTotal: '10.00', annualRecurringTotal: '0.00', total: '110.00',
    expiryDate: '2026-08-01',
    ...overrides,
  } as any;
}

function authoredRenderData(overrides: Partial<ContractBlockRenderData> = {}): ContractBlockRenderData {
  return {
    blockId: 'cb1', templateId: 't1', templateVersionId: 'v1',
    sourceType: 'authored', bodyHtml: '<p>Effective {{dates.effective}} for {{client.name}}.</p>',
    fileData: null, versionSha256: 'a'.repeat(64), declaredVariables: [],
    templateName: 'Master Services Agreement', versionNumber: 1,
    ...overrides,
  };
}

const authoredBlock = { id: 'cb1', blockType: 'contract', content: { templateId: 't1', templateVersionId: 'v1', variableValues: {} } };

// pdfkit flate-compresses content streams and writes WinAnsi Helvetica text as
// hex show-text operands; inflate + hex-decode to get the drawn glyph bytes
// (latin1 so an un-encodable code point's raw hex — e.g. ₹ → 0x20 0xB9 — is
// visible as the garbage it would print). Mirrors quotePdf.test.ts.
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
      out += tm[1] !== undefined
        ? Buffer.from(tm[1].length % 2 ? `${tm[1]}0` : tm[1], 'hex').toString('latin1')
        : tm[2]!.replace(/\\([()\\])/g, '$1');
    }
    out += ' ';
  }
  return out;
}

describe('contractDocumentService.createExecutedDocuments', () => {
  beforeEach(() => {
    insertedValues.length = 0;
    vi.clearAllMocks();
  });

  it('inserts one authored contract_documents row linked to the acceptance + FIRST contract, sha256 over the pdf bytes', async () => {
    const ids = await createExecutedDocuments(
      makeQuote(), 'acc1', ['contractA', 'contractB'], [authoredRenderData()], [authoredBlock], EFFECTIVE, 'en',
    );

    expect(ids).toEqual(['doc-1']);
    expect(insertedValues).toHaveLength(1);
    const row = insertedValues[0]!;
    expect(row.orgId).toBe('org1');
    expect(row.quoteId).toBe('q1');
    expect(row.quoteAcceptanceId).toBe('acc1');
    // Deterministic first-created billing contract.
    expect(row.contractId).toBe('contractA');
    expect(row.templateId).toBe('t1');
    expect(row.templateVersionId).toBe('v1');

    // Authored → rendered_html is the substituted body; pdf is a real pdfkit doc.
    expect(row.renderedHtml).toContain('Effective');
    expect(row.renderedHtml).toContain('Acme Co'); // {{client.name}} resolved
    expect(String(row.renderedHtml)).not.toContain('{{'); // no raw tokens leak

    const pdf = row.pdfData as Buffer;
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(row.byteSize).toBe(pdf.length);
    expect(row.sha256).toBe(createHash('sha256').update(pdf).digest('hex'));
  });

  it('re-sanitizes the executed snapshot: a javascript: href variable value never lands in rendered_html or the PDF', async () => {
    // A body with a variable inside an href — a legal write-time shape ({{link}} is
    // a scheme-less relative href). The hostile scheme arrives only via substitution,
    // AFTER write-time sanitization, so the executed snapshot must re-sanitize.
    const hrefRenderData = authoredRenderData({
      bodyHtml: '<p>See <a href="{{link}}">the portal</a></p>',
    });
    const hostileBlock = { id: 'cb1', blockType: 'contract', content: { variableValues: { link: 'javascript:alert(1)' } } };

    await createExecutedDocuments(makeQuote(), 'acc1', ['contractA'], [hrefRenderData], [hostileBlock], EFFECTIVE, 'en');
    const row = insertedValues[0]!;

    // Stored rendered_html carries no live javascript: link.
    expect(String(row.renderedHtml)).not.toContain('javascript:');
    expect(String(row.renderedHtml)).toContain('the portal');
    // The generated PDF has no javascript: URI annotation either.
    const pdf = row.pdfData as Buffer;
    expect(pdf.toString('latin1')).not.toContain('javascript:');
  });

  it('re-sanitizes a protocol-relative //host href variable value in the executed snapshot', async () => {
    const hrefRenderData = authoredRenderData({ bodyHtml: '<p>See <a href="{{link}}">the portal</a></p>' });
    const hostileBlock = { id: 'cb1', blockType: 'contract', content: { variableValues: { link: '//evil.example' } } };
    await createExecutedDocuments(makeQuote(), 'acc1', ['contractA'], [hrefRenderData], [hostileBlock], EFFECTIVE, 'en');
    const row = insertedValues[0]!;
    expect(String(row.renderedHtml)).not.toContain('//evil.example');
    expect((row.pdfData as Buffer).toString('latin1')).not.toContain('//evil.example');
  });

  it('uploaded block stores the file bytes verbatim as the pdf with rendered_html null', async () => {
    const fileData = Buffer.from('%PDF-1.4 uploaded contract bytes');
    await createExecutedDocuments(
      makeQuote(), 'acc1', ['contractA'],
      [authoredRenderData({ blockId: 'cb2', sourceType: 'uploaded', bodyHtml: null, fileData })],
      [{ id: 'cb2', blockType: 'contract', content: {} }], EFFECTIVE, 'en',
    );
    const row = insertedValues[0]!;
    expect(row.renderedHtml).toBeNull();
    expect((row.pdfData as Buffer).equals(fileData)).toBe(true);
    expect(row.sha256).toBe(createHash('sha256').update(fileData).digest('hex'));
  });

  // #3777 review F3: the executed PDF is drawn by pdfkit's WinAnsi Helvetica, so
  // money must go through the pdf-safe formatter (parity with quotePdf /
  // invoicePdf). ₹ (U+20B9) has no WinAnsi slot — pdfkit writes its raw hex,
  // which prints as " ¹" — and fr-FR's U+202F grouping space prints as " /".
  // rendered_html keeps the HTML-form value (what the customer saw on screen).
  it('draws executed-PDF money through the pdf-safe formatter (₹ → INR code form) while rendered_html keeps the symbol', async () => {
    await createExecutedDocuments(
      makeQuote({ currencyCode: 'INR', total: '1000.00' }), 'acc1', ['contractA'],
      [authoredRenderData({ bodyHtml: '<p>Total due {{totals.total}}.</p>' })], [authoredBlock], EFFECTIVE, 'en',
    );
    const row = insertedValues[0]!;
    expect(String(row.renderedHtml)).toContain('₹1,000.00');
    const text = extractPdfText(row.pdfData as Buffer);
    expect(text).toContain('INR');
    expect(text).toContain('1,000.00');
    expect(text).not.toContain('\u00b9'); // the ₹ hex-garbage tail
  });

  it.each([['TRY', 'tr-TR'], ['KRW', 'ko-KR'], ['ILS', 'he-IL']])(
    'never writes a non-WinAnsi currency symbol into the executed PDF (%s %s)', async (currencyCode, renderLocale) => {
      await createExecutedDocuments(
        makeQuote({ currencyCode, total: '1000.00' }), 'acc1', ['contractA'],
        [authoredRenderData({ bodyHtml: '<p>Total {{totals.total}}</p>' })], [authoredBlock], EFFECTIVE, renderLocale,
      );
      const text = extractPdfText(insertedValues[0]!.pdfData as Buffer);
      expect(text).toContain(currencyCode);
      // Every drawn byte must be a WinAnsi code: no raw UTF-16 hex pairs leaked.
      expect(text).toMatch(/1.?000/);
      expect(text).not.toMatch(/[\u0001-\u0008]/);
    },
  );

  it('folds fr-FR narrow no-break grouping spaces in the executed PDF (no " /" garbage between digit groups)', async () => {
    await createExecutedDocuments(
      makeQuote({ currencyCode: 'EUR', total: '1000.00' }), 'acc1', ['contractA'],
      [authoredRenderData({ bodyHtml: '<p>Total {{totals.total}}</p>' })], [authoredBlock], EFFECTIVE, 'fr-FR',
    );
    const row = insertedValues[0]!;
    expect(String(row.renderedHtml)).toContain('1\u202f000,00');
    const text = extractPdfText(row.pdfData as Buffer);
    expect(text).toContain('1\u00a0000,00\u00a0\u0080'); // NBSP groupers + WinAnsi €
    expect(text).not.toContain('1 /000');
  });

  // The loop → freezeSignedAgreement wiring (#8865 W1a review): the block's
  // manual variableValues must reach the executed document, not just the hash.
  // rendered_html pinned exactly; equal to origin/main 3cb835cee1's output for
  // this fixture (verified by a one-off main-vs-branch comparison).
  it('applies the block manual values to rendered_html and the PDF (fr-FR, override beats auto)', async () => {
    const block = { id: 'cb1', blockType: 'contract', content: { templateId: 't1', templateVersionId: 'v1', variableValues: { 'client.name': 'Override SARL', 'custom.po': 'PO-7' } } };
    await createExecutedDocuments(
      makeQuote({ currencyCode: 'EUR', total: '1000.00' }), 'acc1', ['contractA'],
      [authoredRenderData({ bodyHtml: '<p>{{client.name}} {{custom.po}} {{totals.total}} {{dates.effective}}</p>' })], [block], EFFECTIVE, 'fr-FR',
    );
    const row = insertedValues[0]!;
    expect(row.renderedHtml).toBe('<p>Override SARL PO-7 1 000,00 € Jul 16, 2026</p>');
    const text = extractPdfText(row.pdfData as Buffer);
    expect(text).toContain('Override SARL');
    expect(text).toContain('PO-7');
    expect(text).toContain('1 000,00 \u0080');
    expect(text).not.toContain('Acme Co Q'); // auto client.name never drawn in the body
  });

  it('quote accept keeps the unresolved-variable fallback: logs + alerts, blanks html AND pdf, never throws', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const ids = await createExecutedDocuments(
        makeQuote(), 'acc1', ['contractA'],
        [authoredRenderData({ bodyHtml: '<p>Term {{governing_state}} for {{client.name}}</p>' })], [authoredBlock], EFFECTIVE, 'en',
      );
      expect(ids).toEqual(['doc-1']);
      const row = insertedValues[0]!;
      expect(row.renderedHtml).toBe('<p>Term  for Acme Co</p>');
      const text = extractPdfText(row.pdfData as Buffer);
      expect(text).not.toContain('{{');
      expect(text).not.toContain('governing_state');
      expect(errSpy).toHaveBeenCalledWith(
        '[contractDocumentService] unresolved variable(s) at accept-time snapshot',
        { blockId: 'cb1', quoteId: 'q1', missing: ['governing_state'] },
      );
      expect(captureException).toHaveBeenCalledTimes(1);
      expect((vi.mocked(captureException).mock.calls[0]![0] as Error).message).toBe(
        '[contractDocumentService] unresolved variable(s) at accept-time snapshot: blockId=cb1 quoteId=q1 missing=governing_state',
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it('names the block in the no-bytes error for an uploaded block (accept rolls back)', async () => {
    await expect(createExecutedDocuments(
      makeQuote(), 'acc1', ['contractA'],
      [authoredRenderData({ blockId: 'cb9', sourceType: 'uploaded', bodyHtml: null, fileData: null })],
      [{ id: 'cb9', blockType: 'contract', content: {} }], EFFECTIVE, 'en',
    )).rejects.toMatchObject({ status: 500, code: 'CONTRACT_RENDER_DATA_MISSING', message: 'Uploaded contract block cb9 has no stored file to snapshot' });
    expect(insertedValues).toHaveLength(0);
  });

  it('links contract_id to null when no billing contract was created', async () => {
    await createExecutedDocuments(makeQuote(), 'acc1', [], [authoredRenderData()], [authoredBlock], EFFECTIVE, 'en');
    expect(insertedValues[0]!.contractId).toBeNull();
  });

  it('inserts nothing when there is no contract render data', async () => {
    const ids = await createExecutedDocuments(makeQuote(), 'acc1', ['contractA'], [], [], EFFECTIVE, 'en');
    expect(ids).toEqual([]);
    expect(insertedValues).toHaveLength(0);
  });
});

describe('contractDocumentService.freezeSignedAgreement (quote source)', () => {
  beforeEach(() => { insertedValues.length = 0; vi.clearAllMocks(); });
  const ctx: AgreementRenderContext = {
    clientName: 'Acme Co', clientAddress: null, sellerName: 'MSP LLC', currencyCode: 'USD', renderLocale: 'en', effectiveDate: EFFECTIVE,
    quote: { number: 'Q-1', title: 'Proposal', expiryDate: '2026-08-01', totals: { oneTime: '100.00', monthly: '10.00', annual: '0.00', total: '110.00' } },
  };
  const base = {
    source: { kind: 'quote' as const, quoteId: 'q1', quoteAcceptanceId: 'acc1', blockId: 'cb1' }, orgId: 'org1', contractId: 'contractA',
    templateId: 't1', templateVersionId: 'v1', ctx, manualValues: {}, allowUnresolvedFallback: true,
  };
  const authored = (bodyHtml: string) =>
    ({ sourceType: 'authored' as const, bodyHtml, fileData: null, templateName: 'MSA', versionSha256: 'a'.repeat(64) });

  it('inserts one row with quote linkage, rendered_html from the HTML map and sha256 over the pdf', async () => {
    const out = await freezeSignedAgreement({ ...base, render: authored('<p>{{client.name}} {{totals.monthly}}</p>') });
    const row = insertedValues[0]!;
    expect(insertedValues).toHaveLength(1);
    expect(out).toEqual({ id: 'doc-1', sha256: row.sha256 });
    expect(row).toMatchObject({ orgId: 'org1', quoteId: 'q1', quoteAcceptanceId: 'acc1', contractId: 'contractA', templateId: 't1', templateVersionId: 'v1' });
    expect(row.renderedHtml).toContain('Acme Co');
    expect(row.renderedHtml).toContain('$10.00');
    const pdf = row.pdfData as Buffer;
    expect(row.byteSize).toBe(pdf.length);
    expect(row.sha256).toBe(createHash('sha256').update(pdf).digest('hex'));
  });

  it('draws the PDF header parties + effective date from the context', async () => {
    await freezeSignedAgreement({ ...base, render: authored('<p>Body</p>') });
    const text = extractPdfText(insertedValues[0]!.pdfData as Buffer);
    expect(text).toContain('MSP LLC');
    expect(text).toContain('Acme Co');
    expect(text).toContain('Effective Jul 16, 2026');
  });

  it('manual values win over auto values', async () => {
    await freezeSignedAgreement({ ...base, manualValues: { 'client.name': 'Override' }, render: authored('<p>{{client.name}}</p>') });
    expect(insertedValues[0]!.renderedHtml).toContain('Override');
    expect(insertedValues[0]!.renderedHtml).not.toContain('Acme Co');
  });

  it('uploaded render stores fileData verbatim with rendered_html null', async () => {
    const fileData = Buffer.from('%PDF-1.4 x');
    const out = await freezeSignedAgreement({ ...base, render: { sourceType: 'uploaded', bodyHtml: null, fileData, templateName: 'MSA', versionSha256: 'a'.repeat(64) } });
    const row = insertedValues[0]!;
    expect(row.renderedHtml).toBeNull();
    expect((row.pdfData as Buffer).equals(fileData)).toBe(true);
    expect(out.sha256).toBe(createHash('sha256').update(fileData).digest('hex'));
  });

  it('throws CONTRACT_RENDER_DATA_MISSING (500) for an uploaded render with no bytes, inserting nothing', async () => {
    await expect(freezeSignedAgreement({ ...base, render: { sourceType: 'uploaded', bodyHtml: null, fileData: null, templateName: 'MSA', versionSha256: 'a'.repeat(64) } }))
      .rejects.toMatchObject({ status: 500, code: 'CONTRACT_RENDER_DATA_MISSING' });
    expect(insertedValues).toHaveLength(0);
  });

  it('allowUnresolvedFallback: true blanks a raw {{token}} rather than persisting it (quote path, pre-W1 behaviour)', async () => {
    await freezeSignedAgreement({ ...base, render: authored('<p>Term {{governing_state}} for {{client.name}}</p>') });
    const html = String(insertedValues[0]!.renderedHtml);
    expect(html).not.toContain('{{');
    expect(html).toContain('Term  for Acme Co');
  });

  it('allowUnresolvedFallback: false throws 422 AGREEMENT_VARIABLES_UNRESOLVED naming the variables, inserting nothing', async () => {
    const err = await freezeSignedAgreement({ ...base, allowUnresolvedFallback: false, render: authored('<p>{{zeta}} {{alpha}} {{client.name}}</p>') })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuoteServiceError);
    expect(err).toMatchObject({ status: 422, code: 'AGREEMENT_VARIABLES_UNRESOLVED' });
    expect((err as Error).message).toContain('zeta');
    expect((err as Error).message).toContain('alpha');
    expect(insertedValues).toHaveLength(0);
  });

  it('createExecutedDocuments produces byte-identical rows to a direct freezeSignedAgreement call', async () => {
    await createExecutedDocuments(makeQuote(), 'acc1', ['contractA'], [authoredRenderData()], [authoredBlock], EFFECTIVE, 'en');
    const viaLoop = { ...insertedValues[0]! };
    insertedValues.length = 0;
    await freezeSignedAgreement({
      ...base,
      render: { sourceType: 'authored', bodyHtml: authoredRenderData().bodyHtml, fileData: null, templateName: 'Master Services Agreement', versionSha256: 'a'.repeat(64) },
      ctx: renderContextFromQuote(makeQuote(), { effectiveDate: EFFECTIVE, renderLocale: 'en' }),
    });
    const direct = insertedValues[0]!;
    expect(direct.renderedHtml).toBe(viaLoop.renderedHtml);
    // pdfkit stamps CreationDate and derives the trailer /ID from it
    // (PDFSecurity.generateFileID(info)); compare everything but those two.
    const strip = (b: Buffer) => b.toString('latin1')
      .replace(/\/CreationDate \(D:[^)]*\)/, '')
      .replace(/\/ID \[<[0-9a-f]+> <[0-9a-f]+>\]/i, '');
    expect(strip(direct.pdfData as Buffer)).toBe(strip(viaLoop.pdfData as Buffer));
    const { pdfData: _a, sha256: _b, byteSize: _c, ...directRest } = direct;
    const { pdfData: _d, sha256: _e, byteSize: _f, ...loopRest } = viaLoop;
    expect(directRest).toEqual(loopRest);
  });
});

describe('contractDocumentService.buildContractHashParts', () => {
  it('produces a hash part per render-data block with its version sha + resolved vars', () => {
    const parts = buildContractHashParts([authoredBlock], [authoredRenderData()], makeQuote(), EFFECTIVE, 'en');
    expect(parts).toHaveLength(1);
    expect(parts[0]!.blockId).toBe('cb1');
    expect(parts[0]!.templateVersionSha256).toBe('a'.repeat(64));
    // Resolved variables fold in the accept-date effective value + quote-derived autos.
    expect(parts[0]!.resolvedVariables['client.name']).toBe('Acme Co');
    expect(parts[0]!.resolvedVariables['dates.effective']).toBeTruthy();
  });

  it('merges manual variableValues over auto values', () => {
    const block = { id: 'cb1', blockType: 'contract', content: { variableValues: { 'client.name': 'Override Inc' } } };
    const parts = buildContractHashParts([block], [authoredRenderData()], makeQuote(), EFFECTIVE, 'en');
    expect(parts[0]!.resolvedVariables['client.name']).toBe('Override Inc');
  });

  // #3777 follow-up: the hash is computed under the PERSISTED acceptance locale,
  // which must beat a (later backfilled) quote.documentLocale — otherwise a
  // legacy acceptance hashed under the old 'en' fallback stops verifying.
  it('formats money in the explicit renderLocale even when the quote carries a different documentLocale', () => {
    const quote = makeQuote({ currencyCode: 'EUR', documentLocale: 'fr-FR', total: '1000.00' });
    const legacy = buildContractHashParts([authoredBlock], [authoredRenderData()], quote, EFFECTIVE, 'en');
    expect(legacy[0]!.resolvedVariables['totals.total']).toBe('€1,000.00');
    const stamped = buildContractHashParts([authoredBlock], [authoredRenderData()], quote, EFFECTIVE, 'fr-FR');
    expect(stamped[0]!.resolvedVariables['totals.total']).toMatch(/^1\u202f000,00\s€$/);
  });
});

describe('contractDocumentService.assertContractRenderDataComplete', () => {
  it('throws CONTRACT_RENDER_DATA_MISSING (500) when a contract block has no render data', () => {
    try {
      assertContractRenderDataComplete([authoredBlock], []);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(QuoteServiceError);
      expect((err as QuoteServiceError).status).toBe(500);
      expect((err as QuoteServiceError).code).toBe('CONTRACT_RENDER_DATA_MISSING');
    }
  });

  it('throws when renderData is undefined but a contract block exists', () => {
    expect(() => assertContractRenderDataComplete([authoredBlock], undefined)).toThrow(QuoteServiceError);
  });

  it('does not throw when every contract block has render data', () => {
    expect(() => assertContractRenderDataComplete([authoredBlock], [authoredRenderData()])).not.toThrow();
  });

  it('does not throw when there are no contract blocks', () => {
    expect(() => assertContractRenderDataComplete([{ id: 'b1', blockType: 'heading', content: {} }], undefined)).not.toThrow();
  });
});

describe('contractDocumentService.linkContractDocument', () => {
  beforeEach(() => { insertedValues.length = 0; selectResults.length = 0; vi.clearAllMocks(); });

  const auth = { canAccessOrg: () => true } as unknown as AuthContext;

  it('rejects re-linking a document that is already attached to a contract (409 ALREADY_LINKED)', async () => {
    // getDocumentOr404 select → a doc already linked to contract-existing.
    queueResult([{ id: 'doc1', orgId: 'org1', contractId: 'contract-existing', pdfData: Buffer.from('x'), mime: 'application/pdf', byteSize: 1, sha256: 's' }]);

    await expect(linkContractDocument(auth, 'doc1', 'contract-new'))
      .rejects.toMatchObject({ status: 409, code: 'ALREADY_LINKED' });
    // The guard fires before any UPDATE — nothing was re-filed.
    expect(insertedValues).toEqual([]);
  });

  it('links an unattached document (contract_id NULL) to a same-org contract', async () => {
    queueResult([{ id: 'doc1', orgId: 'org1', contractId: null, pdfData: Buffer.from('x'), mime: 'application/pdf', byteSize: 1, sha256: 's' }]); // getDocumentOr404
    queueResult([{ id: 'contract-new', orgId: 'org1' }]); // contract lookup (same org)
    queueResult([{ id: 'doc1', orgId: 'org1', contractId: 'contract-new' }]); // update ... returning

    const updated = await linkContractDocument(auth, 'doc1', 'contract-new');
    expect(updated.contractId).toBe('contract-new');
  });

  it('surfaces a ContractDocumentServiceError type on the already-linked guard', async () => {
    queueResult([{ id: 'doc1', orgId: 'org1', contractId: 'c', pdfData: Buffer.from('x'), mime: 'application/pdf', byteSize: 1, sha256: 's' }]);
    await expect(linkContractDocument(auth, 'doc1', 'c2')).rejects.toBeInstanceOf(ContractDocumentServiceError);
  });
});

describe('contractDocumentService.getContractDocumentPdf', () => {
  beforeEach(() => {
    insertedValues.length = 0;
    selectResults.length = 0;
    vi.clearAllMocks();
  });

  it('returns the authorized document organization with the prepared PDF metadata', async () => {
    const canAccessOrg = vi.fn(() => true);
    const auth = { canAccessOrg } as unknown as AuthContext;
    const pdfData = Buffer.from('%PDF-1.7');
    queueResult([{
      id: 'doc1',
      orgId: 'org1',
      pdfData,
      mime: 'application/pdf',
      byteSize: pdfData.length,
      sha256: 'a'.repeat(64),
    }]);

    const result = await getContractDocumentPdf(auth, 'doc1');

    expect(canAccessOrg).toHaveBeenCalledWith('org1');
    expect(result).toEqual({
      orgId: 'org1',
      pdfData,
      mime: 'application/pdf',
      byteSize: pdfData.length,
      sha256: 'a'.repeat(64),
    });
  });

  it('keeps the existing organization authorization gate before returning bytes', async () => {
    const canAccessOrg = vi.fn(() => false);
    const auth = { canAccessOrg } as unknown as AuthContext;
    queueResult([{
      id: 'doc1',
      orgId: 'org-denied',
      pdfData: Buffer.from('%PDF-1.7'),
      mime: 'application/pdf',
      byteSize: 8,
      sha256: 'a'.repeat(64),
    }]);

    await expect(getContractDocumentPdf(auth, 'doc1')).rejects.toMatchObject({
      status: 403,
      code: 'ORG_DENIED',
    });
    expect(canAccessOrg).toHaveBeenCalledWith('org-denied');
  });
});

describe('contractDocumentService.listContractDocuments predicates', () => {
  beforeEach(() => { insertedValues.length = 0; selectResults.length = 0; vi.clearAllMocks(); });

  // The where() argument is a real drizzle SQL tree; rendering it through the
  // pg dialect is what makes these assertions non-vacuous (a stub that merely
  // records "some object was passed" would pass no matter which branch ran).
  async function whereSqlFor(opts: Parameters<typeof listContractDocuments>[1]): Promise<string> {
    const auth = {
      orgCondition: (col: AnyPgColumn) => inArray(col, ['org-1']),
    } as unknown as AuthContext;
    queueResult([]);
    await listContractDocuments(auth, opts);
    const chain = (db as unknown as { where: { mock: { calls: unknown[][] } } }).where;
    const arg = chain.mock.calls.at(-1)![0] as SQL;
    return new PgDialect().sqlToQuery(arg).sql.toLowerCase();
  }

  it('emits IS NOT NULL on contract_id for linked=linked, and IS NULL for unlinked', async () => {
    expect(await whereSqlFor({ linked: 'linked' })).toContain('is not null');
    const unlinked = await whereSqlFor({ linked: 'unlinked' });
    expect(unlinked).toContain('is null');
    expect(unlinked).not.toContain('is not null');
  });

  it('emits no link predicate at all for linked=all', async () => {
    const all = await whereSqlFor({ linked: 'all' });
    expect(all).not.toContain('is null');
    expect(all).not.toContain('is not null');
  });

  it('keeps contractId winning over an explicit linked filter', async () => {
    const sqlText = await whereSqlFor({ contractId: 'ct-1', linked: 'linked' });
    expect(sqlText).toContain('"contract_id" = ');
    // No link predicate at all: contractId already pins the rows.
    expect(sqlText).not.toContain('is null');
    expect(sqlText).not.toContain('is not null');
  });

  it('pins the service-level default for a caller that passes nothing', async () => {
    // The route always supplies `linked` via its Zod default, so this is the
    // contract for any FUTURE direct caller (a worker, an export job): no args
    // means unlinked-only, matching the route rather than the old "no filter".
    const sqlText = await whereSqlFor({});
    expect(sqlText).toContain('is null');
    expect(sqlText).not.toContain('is not null');
  });

  it('projects signer fields from the contract_documents evidence snapshot, not quote_acceptances (#8865 W1b)', async () => {
    const { contractDocuments } = await import('../db/schema/contractDocuments');
    const { quoteAcceptances, quotes } = await import('../db/schema/quotes');
    const auth = { orgCondition: (col: AnyPgColumn) => inArray(col, ['org-1']) } as unknown as AuthContext;
    queueResult([]);
    await listContractDocuments(auth, { linked: 'all' });
    const chain = db as unknown as Record<string, { mock: { calls: unknown[][] } }>;
    const projection = chain.select!.mock.calls.at(-1)![0] as Record<string, unknown>;

    expect(projection.signerName).toBe(contractDocuments.signerName);
    expect(projection.signedAt).toBe(contractDocuments.signedAt);
    expect(projection.signerEmail).toBe(contractDocuments.signerEmail);
    expect(projection.sourceKind).toBe(contractDocuments.sourceKind);
    expect(projection.agreementRequestId).toBe(contractDocuments.agreementRequestId);
    expect(projection.mime).toBe(contractDocuments.mime);
    expect(projection.acceptanceOrigin).toBe(contractDocuments.acceptanceOrigin);
    expect(projection.acceptanceMethod).toBe(contractDocuments.acceptanceMethod);
    expect(projection.acceptanceReference).toBe(contractDocuments.acceptanceReference);
    expect(new PgDialect().sqlToQuery(projection.evidenceAvailable as SQL).sql.toLowerCase())
      .toBe('"contract_documents"."signed_at" is not null');

    // The quote_acceptances join is gone (deleting a quote no longer blanks the
    // signer); the quotes join stays for quoteNumber.
    const joined = chain.leftJoin!.mock.calls.map((c) => c[0]); // mocks cleared in beforeEach
    expect(joined).not.toContain(quoteAcceptances);
    expect(joined).toContain(quotes);
  });

  it('ANDs orgId with the caller org condition rather than substituting for it', async () => {
    const sqlText = await whereSqlFor({ orgId: 'org-2', linked: 'all' });
    // both the access condition (in (...)) and the narrowing equality survive
    expect(sqlText).toContain('in (');
    expect(sqlText).toMatch(/"org_id" = /);
    expect(sqlText).toContain(' and ');
  });
});
