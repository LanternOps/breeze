import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  for (const m of ['select', 'from', 'where', 'limit', 'update', 'set']) chain[m] = vi.fn(() => chain);
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
  buildContractHashParts,
  assertContractRenderDataComplete,
  getContractDocumentPdf,
  linkContractDocument,
  ContractDocumentServiceError,
} from './contractDocumentService';
import type { AuthContext } from '../middleware/auth';
import type { ContractBlockRenderData } from './contractTemplateRender';
import { QuoteServiceError } from './quoteTypes';

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
