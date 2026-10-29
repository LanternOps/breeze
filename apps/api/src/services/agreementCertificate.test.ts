import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import PDFKitDocument from 'pdfkit';
import { PDFDocument } from 'pdf-lib';

// The loader reads through the bare db under a system context; the renderer is
// pure. One chained db mock serves the loader tests (results queued in order).
const { dbResults, contexts } = vi.hoisted(() => ({ dbResults: [] as unknown[][], contexts: { open: 0, max: 0 } }));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit', 'innerJoin', 'leftJoin', 'orderBy']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
    if (contexts.open === 0) return Promise.reject(new Error('db read outside a system context')).then(resolve, reject);
    const next = dbResults.shift() ?? [];
    return Promise.resolve(next).then(resolve, reject);
  };
  return {
    db: chain,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: async (fn: () => Promise<unknown>) => {
      contexts.open += 1;
      contexts.max = Math.max(contexts.max, contexts.open);
      try { return await fn(); } finally { contexts.open -= 1; }
    },
  };
});

// Pass-through of the real merge, with a switch to make it fail the way a
// regression in OUR certificate page / pdf-lib would.
const { mergeFault } = vi.hoisted(() => ({ mergeFault: { error: null as Error | null } }));
vi.mock('./pdfMerge', async (importOriginal) => {
  const real = await importOriginal<typeof import('./pdfMerge')>();
  return {
    ...real,
    mergeUploadedContractPdfs: async (...args: Parameters<typeof real.mergeUploadedContractPdfs>) => {
      if (mergeFault.error) throw mergeFault.error;
      return real.mergeUploadedContractPdfs(...args);
    },
  };
});

import {
  buildCertificateContent,
  certificateText,
  loadCertifiedAgreementInput,
  renderCertifiedAgreementPdf,
  type CertifiedAgreementInput,
} from './agreementCertificate';
import { computeAgreementSha256 } from './agreementContentHash';
import { MAX_MERGED_PAGES, PdfMergeError } from './pdfMerge';

const DOC_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const SIGNED_AT = new Date('2027-01-11T09:30:00.000Z');
const CREATED_AT = new Date('2027-01-12T15:45:00.000Z');

// 1×1 PNG / JPEG — the smallest images pdf-lib's embedPng / embedJpg accept.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
const JPEG_1X1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQAASABIAAD/wAALCAABAAEBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P/90ABAAB/9oACAEBAAA/AP38r//Z',
  'base64',
);

async function makePdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) doc.addPage([612, 792]).drawText(`Agreement page ${i + 1}`, { x: 50, y: 700 });
  return Buffer.from(await doc.save());
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function makeInput(pdfData: Buffer, mime: string, over: Partial<CertifiedAgreementInput> = {}): CertifiedAgreementInput {
  const { document: docOver, ...rest } = over;
  return {
    document: {
      id: DOC_ID,
      pdfData,
      mime,
      sha256: sha(pdfData),
      createdAt: CREATED_AT,
      signerName: 'Dana Buyer',
      signerEmail: 'dana@example.com',
      signedAt: SIGNED_AT,
      signerIp: '198.51.100.7',
      signerUserAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      contentSha256: 'c'.repeat(64),
      contentHashVersion: 1,
      acceptanceRenderLocale: 'en',
      ...docOver,
    },
    agreement: { name: 'Business Associate Agreement', templateName: 'Business Associate Agreement', versionNumber: 3 },
    parties: { seller: 'Acme MSP', client: 'Example Clinic LLC' },
    source: { kind: 'request', requestId: REQUEST_ID },
    how: { kind: 'customer', channel: 'emailed_link', method: 'typed-signature' },
    pageSize: 'letter',
    ...rest,
  };
}

/** Every string pdfkit was asked to draw while `fn` ran — what the page prints. */
async function drawnStrings<T>(fn: () => Promise<T>): Promise<{ result: T; drawn: string[] }> {
  const spy = vi.spyOn(PDFKitDocument.prototype, 'text');
  try {
    const result = await fn();
    const drawn = spy.mock.calls.map((call) => String(call[0]));
    return { result, drawn };
  } finally {
    spy.mockRestore();
  }
}

const SIGNED_BY = /signed\s+by/i;

beforeEach(() => {
  dbResults.length = 0;
  contexts.open = 0;
  contexts.max = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('renderCertifiedAgreementPdf — determinism and shape', () => {
  it('yields byte-identical output for the same row, whatever the wall clock says', async () => {
    const original = await makePdf(2);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-03-03T03:03:03.000Z'));
    const first = await renderCertifiedAgreementPdf(makeInput(original, 'application/pdf'));
    vi.setSystemTime(new Date('2031-07-07T07:07:07.000Z'));
    const second = await renderCertifiedAgreementPdf(makeInput(original, 'application/pdf'));
    expect(first.equals(second)).toBe(true);
  });

  it('pins CreationDate and ModDate to signed_at', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-03-03T03:03:03.000Z'));
    const out = await renderCertifiedAgreementPdf(makeInput(await makePdf(1), 'application/pdf'));
    const loaded = await PDFDocument.load(out, { updateMetadata: false });
    expect(loaded.getCreationDate()?.toISOString()).toBe(SIGNED_AT.toISOString());
    expect(loaded.getModificationDate()?.toISOString()).toBe(SIGNED_AT.toISOString());
  });

  it('a legacy row with no signed_at pins the dates to created_at', async () => {
    const input = makeInput(await makePdf(1), 'application/pdf', { how: { kind: 'unavailable' } });
    input.document = { ...input.document, signerName: null, signerEmail: null, signedAt: null, signerIp: null, signerUserAgent: null };
    const loaded = await PDFDocument.load(await renderCertifiedAgreementPdf(input), { updateMetadata: false });
    expect(loaded.getCreationDate()?.toISOString()).toBe(CREATED_AT.toISOString());
  });

  it('appends exactly one certificate page to a PDF original', async () => {
    const out = await renderCertifiedAgreementPdf(makeInput(await makePdf(3), 'application/pdf'));
    expect((await PDFDocument.load(out)).getPageCount()).toBe(4);
  });

  it('keeps every original page first, in order, and appends the certificate LAST', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([600, 800]);
    doc.addPage([601, 801]);
    const bytes = Buffer.from(await doc.save());
    const out = await renderCertifiedAgreementPdf(makeInput(bytes, 'application/pdf'));
    const loaded = await PDFDocument.load(out);
    const sizes = loaded.getPages().map((p) => { const s = p.getSize(); return [Math.round(s.width), Math.round(s.height)]; });
    // Originals untouched and first; the certificate takes the last original page's size.
    expect(sizes).toEqual([[600, 800], [601, 801], [601, 801]]);
    const { drawn } = await drawnStrings(() => renderCertifiedAgreementPdf(makeInput(bytes, 'application/pdf')));
    expect(drawn[0]).toBe('Signature certificate');
  });

  it('a landscape (non-document) original gets the certificate on the partner page size', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([792, 612]);
    const out = await renderCertifiedAgreementPdf(makeInput(Buffer.from(await doc.save()), 'application/pdf', { pageSize: 'a4' }));
    const loaded = await PDFDocument.load(out);
    const first = loaded.getPage(0).getSize();
    const last = loaded.getPage(1).getSize();
    expect([Math.round(first.width), Math.round(first.height)]).toEqual([792, 612]);
    expect([Math.round(last.width), Math.round(last.height)]).toEqual([595, 842]);
  });

  it('a PNG original becomes one PDF page, then the certificate', async () => {
    const out = await renderCertifiedAgreementPdf(makeInput(PNG_1X1, 'image/png'));
    const loaded = await PDFDocument.load(out);
    expect(out.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(loaded.getPageCount()).toBe(2);
    // Partner page size Letter → the image page is Letter.
    const { width, height } = loaded.getPage(0).getSize();
    expect([Math.round(width), Math.round(height)]).toEqual([612, 792]);
  });

  it('a JPEG original becomes one PDF page on the partner page size (A4)', async () => {
    const out = await renderCertifiedAgreementPdf(makeInput(JPEG_1X1, 'image/jpeg', { pageSize: 'a4' }));
    const loaded = await PDFDocument.load(out);
    expect(loaded.getPageCount()).toBe(2);
    const { width, height } = loaded.getPage(0).getSize();
    expect([Math.round(width), Math.round(height)]).toEqual([595, 842]);
  });

  it('never changes the stored bytes it was given', async () => {
    const original = await makePdf(2);
    const copy = Buffer.from(original);
    const input = makeInput(original, 'application/pdf');
    await renderCertifiedAgreementPdf(input);
    expect(input.document.pdfData.equals(copy)).toBe(true);
    expect(sha(input.document.pdfData)).toBe(input.document.sha256);
  });

  it('the certificate stays on ONE page even for pathological evidence text', async () => {
    const input = makeInput(await makePdf(1), 'application/pdf', {
      how: { kind: 'on_behalf', recordedByName: 'T'.repeat(400), method: 'other', reference: 'R'.repeat(5000) },
      agreement: { name: 'L'.repeat(800), templateName: 'N'.repeat(800), versionNumber: 1 },
    });
    input.document = { ...input.document, signerName: 'S'.repeat(255), signerUserAgent: 'U'.repeat(4000) };
    const out = await renderCertifiedAgreementPdf(input);
    expect((await PDFDocument.load(out)).getPageCount()).toBe(2);
  });
});

describe('renderCertifiedAgreementPdf — merge failures are PdfMergeError', () => {
  it('an unreadable original PDF throws PdfMergeError (the caller falls back to the original)', async () => {
    const garbage = Buffer.from('%PDF-1.7\nthis is not really a pdf');
    await expect(renderCertifiedAgreementPdf(makeInput(garbage, 'application/pdf'))).rejects.toBeInstanceOf(PdfMergeError);
  });

  it('an unreadable image throws PdfMergeError', async () => {
    await expect(renderCertifiedAgreementPdf(makeInput(Buffer.from('not a png'), 'image/png'))).rejects.toBeInstanceOf(PdfMergeError);
  });

  it('a failure assembling OUR certificate page is NOT a PdfMergeError (it must not degrade quietly to the original)', async () => {
    const original = await makePdf(1);
    mergeFault.error = new PdfMergeError('An attached contract PDF could not be read: certificate page corrupt');
    try {
      const err = await renderCertifiedAgreementPdf(makeInput(original, 'application/pdf')).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(PdfMergeError);
      expect((err as Error).message).toMatch(/certificate/i);
      mergeFault.error = new TypeError('pdf-lib regression');
      const err2 = await renderCertifiedAgreementPdf(makeInput(original, 'application/pdf')).catch((e: unknown) => e);
      expect(err2).not.toBeInstanceOf(PdfMergeError);
    } finally {
      mergeFault.error = null;
    }
  });

  it('respects MAX_MERGED_PAGES (original + certificate)', async () => {
    const huge = await makePdf(MAX_MERGED_PAGES);
    await expect(renderCertifiedAgreementPdf(makeInput(huge, 'application/pdf')))
      .rejects.toMatchObject({ name: 'PdfMergeError', code: 'CONTRACT_PDF_PAGE_LIMIT_EXCEEDED' });
  });
});

describe('certificate content (spec §3.8 table)', () => {
  it('prints the original-bytes sha256 and the content hash + version', async () => {
    const input = makeInput(await makePdf(1), 'application/pdf');
    const text = certificateText(buildCertificateContent(input)).join('\n');
    expect(text).toContain(input.document.sha256);
    expect(text).toContain('c'.repeat(64));
    expect(text).toContain('Verify: the SHA-256 of the original file downloaded from Breeze matches the value above.');
    // …and the page really draws them (not just the content model).
    const { drawn } = await drawnStrings(() => renderCertifiedAgreementPdf(input));
    expect(drawn.join('\n')).toContain(input.document.sha256);
  });

  it('agreement, parties, signer, when/where and source rows come from the evidence snapshot', async () => {
    const input = makeInput(await makePdf(1), 'application/pdf');
    const text = certificateText(buildCertificateContent(input)).join('\n');
    expect(text).toContain('Business Associate Agreement');
    expect(text).toContain('v3');
    expect(text).toContain(DOC_ID);
    expect(text).toContain('Acme MSP');
    expect(text).toContain('Example Clinic LLC');
    expect(text).toContain('Dana Buyer');
    expect(text).toContain('dana@example.com');
    expect(text).toContain('2027-01-11T09:30:00.000Z');
    expect(text).toContain('January 11, 2027');
    expect(text).toContain('198.51.100.7');
    expect(text).toContain(`Agreement request ${REQUEST_ID}`);
  });

  it('the accepted-by name is set in the italic signature face and printed again beneath it', async () => {
    const content = buildCertificateContent(makeInput(await makePdf(1), 'application/pdf'));
    const rows = content.sections.flatMap((s) => s.rows);
    const signature = rows.find((r) => r.style === 'signature');
    expect(signature?.value).toBe('Dana Buyer');
    const sigIdx = rows.indexOf(signature!);
    expect(rows[sigIdx + 1]?.value).toBe('Dana Buyer');
    expect(rows[sigIdx + 1]?.style).toBeUndefined();
  });

  it('quote-sourced: the source row is the quote number; a deleted quote says so', async () => {
    const pdf = await makePdf(1);
    const withQuote = certificateText(buildCertificateContent(makeInput(pdf, 'application/pdf', { source: { kind: 'quote', quoteNumber: 'Q-1042' } }))).join('\n');
    expect(withQuote).toContain('Quote Q-1042');
    const deleted = certificateText(buildCertificateContent(makeInput(pdf, 'application/pdf', { source: { kind: 'quote', quoteNumber: null } }))).join('\n');
    expect(deleted).toContain('Quote (no longer available)');
  });

  it('localizes the signing time with the stored acceptance locale, always in UTC', async () => {
    const input = makeInput(await makePdf(1), 'application/pdf');
    input.document = { ...input.document, acceptanceRenderLocale: 'de-DE' };
    const text = certificateText(buildCertificateContent(input)).join('\n');
    expect(text).toContain('11. Januar 2027');
    expect(text).toContain('UTC');
  });

  it('an unknown locale falls back to English instead of throwing', async () => {
    const input = makeInput(await makePdf(1), 'application/pdf');
    input.document = { ...input.document, acceptanceRenderLocale: 'xx-INVALID-@@' };
    expect(certificateText(buildCertificateContent(input)).join('\n')).toContain('January 11, 2027');
  });
});

describe('"How" wording — one case per origin, never "signed by"', () => {
  const cases: Array<[string, CertifiedAgreementInput['how'], string[]]> = [
    ['customer via the emailed link', { kind: 'customer', channel: 'emailed_link', method: 'typed-signature' },
      ['Electronically accepted via emailed link: typed full legal name + consent checkbox']],
    ['customer via the portal', { kind: 'customer', channel: 'portal', method: 'typed-signature' },
      ['Electronically accepted via portal: typed full legal name + consent checkbox']],
    ['recorded on behalf of the client', { kind: 'on_behalf', recordedByName: 'Sam Tech', method: 'purchase_order', reference: 'PO 4471' },
      ['Recorded by Sam Tech on behalf of the client — method purchase order, reference PO 4471']],
    ['externally-signed upload', { kind: 'external_upload', recordedByName: 'Sam Tech', method: 'signed_document', reference: 'wet-ink copy in client folder' },
      ['Signed outside Breeze; copy uploaded by Sam Tech on January 12, 2027',
        'This certificate attests the upload, not the signature on it.',
        'Method signed document, reference wet-ink copy in client folder']],
  ];

  for (const [name, how, expected] of cases) {
    it(name, async () => {
      const input = makeInput(await makePdf(1), 'application/pdf', { how });
      const text = certificateText(buildCertificateContent(input));
      for (const line of expected) expect(text).toContain(line);
      expect(text.join('\n')).not.toMatch(SIGNED_BY);
      expect(text.join('\n')).toMatch(/electronically accepted|recorded by|signed outside breeze/i);
      const { drawn } = await drawnStrings(() => renderCertifiedAgreementPdf(input));
      for (const line of expected) expect(drawn).toContain(line);
      expect(drawn.join('\n')).not.toMatch(SIGNED_BY);
    });
  }

  it('a staff-recorded acceptance is never presented as an electronic acceptance with a typed signature', async () => {
    const content = buildCertificateContent(makeInput(await makePdf(1), 'application/pdf', {
      how: { kind: 'on_behalf', recordedByName: 'Sam Tech', method: 'verbal', reference: 'call T-0231' },
    }));
    const headings = content.sections.map((s) => s.heading);
    expect(headings).not.toContain('Electronically accepted by');
    expect(headings).toContain('Acceptance recorded by staff');
    const rows = content.sections.flatMap((s) => s.rows);
    expect(rows.some((r) => r.style === 'signature')).toBe(false);
    expect(rows.find((r) => r.value === 'Dana Buyer')?.label).toBe('Client signer (as recorded)');
    expect(rows.find((r) => r.value === SIGNED_AT.toISOString())?.label).toBe('Accepted at, as recorded (UTC)');
  });

  it('an external upload names the signer and date as recorded, and when the copy was uploaded', async () => {
    const content = buildCertificateContent(makeInput(await makePdf(1), 'application/pdf', {
      how: { kind: 'external_upload', recordedByName: 'Sam Tech', method: 'signed_document', reference: 'wet ink' },
    }));
    const headings = content.sections.map((s) => s.heading);
    expect(headings).not.toContain('Electronically accepted by');
    expect(headings).toContain('Signed outside Breeze');
    const rows = content.sections.flatMap((s) => s.rows);
    expect(rows.some((r) => r.style === 'signature')).toBe(false);
    expect(rows.find((r) => r.value === 'Dana Buyer')?.label).toBe('Signer (as recorded)');
    expect(rows.find((r) => r.value === SIGNED_AT.toISOString())?.label).toBe('Signed at, as recorded (UTC)');
    expect(rows.find((r) => r.value === CREATED_AT.toISOString())?.label).toBe('Uploaded at (UTC)');
    expect(certificateText(content).join('\n')).not.toMatch(/electronically accepted/i);
  });

  it('on-behalf rows label the IP / user agent as the recorder\'s, not the signer\'s', async () => {
    const input = makeInput(await makePdf(1), 'application/pdf', {
      how: { kind: 'on_behalf', recordedByName: 'Sam Tech', method: 'verbal', reference: 'call notes T-0231' },
    });
    const labels = buildCertificateContent(input).sections.flatMap((s) => s.rows.map((r) => r.label));
    expect(labels).toContain('Recorded from IP');
    expect(labels).not.toContain('Signer IP');
  });

  it('a recorder whose account was removed is named honestly', async () => {
    const text = certificateText(buildCertificateContent(makeInput(await makePdf(1), 'application/pdf', {
      how: { kind: 'on_behalf', recordedByName: null, method: 'email', reference: 'email 2027-01-10' },
    }))).join('\n');
    expect(text).toContain('Recorded by a staff member (account no longer available) on behalf of the client');
  });

  it('a non-typed customer method does not claim a typed name + checkbox', async () => {
    const text = certificateText(buildCertificateContent(makeInput(await makePdf(1), 'application/pdf', {
      how: { kind: 'customer', channel: 'unknown', method: 'docusign' },
    }))).join('\n');
    expect(text).toContain('Electronically accepted online — method docusign');
    expect(text).not.toContain('typed full legal name');
  });
});

describe('legacy row without evidence', () => {
  it('renders the "Acceptance record unavailable" text, never a fabricated signer', async () => {
    const input = makeInput(await makePdf(1), 'application/pdf', { how: { kind: 'unavailable' }, source: { kind: 'quote', quoteNumber: null } });
    input.document = { ...input.document, signerName: null, signerEmail: null, signedAt: null, signerIp: null, signerUserAgent: null, contentSha256: null, contentHashVersion: null };
    const text = certificateText(buildCertificateContent(input));
    expect(text).toContain('Acceptance record unavailable — this agreement was accepted on January 12, 2027 via quote, but the acceptance evidence was deleted before Breeze retained it.');
    expect(text.join('\n')).not.toContain('Dana Buyer');
    expect(text.join('\n')).not.toMatch(SIGNED_BY);
    expect(text.join('\n')).toContain(input.document.sha256);
    const { drawn, result } = await drawnStrings(() => renderCertifiedAgreementPdf(input));
    expect(drawn.join('\n')).toContain('Acceptance record unavailable');
    expect((await PDFDocument.load(result)).getPageCount()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Loader: one system-scope read; classifies HOW from stored columns only.
// ---------------------------------------------------------------------------

function loaderRow(over: Record<string, unknown> = {}) {
  const pdfData = Buffer.from('%PDF-1.7 frozen');
  return {
    id: DOC_ID,
    pdfData,
    mime: 'application/pdf',
    sha256: sha(pdfData),
    createdAt: CREATED_AT,
    sourceKind: 'request',
    agreementRequestId: REQUEST_ID,
    quoteId: null,
    quoteAcceptanceId: null,
    signerName: 'Dana Buyer',
    signerEmail: 'dana@example.com',
    signedAt: SIGNED_AT,
    signerIp: '198.51.100.7',
    signerUserAgent: 'UA',
    acceptanceOrigin: 'customer',
    acceptanceMethod: 'typed-signature',
    acceptanceReference: null,
    contentSha256: 'c'.repeat(64),
    contentHashVersion: 1,
    acceptanceRenderLocale: 'en',
    templateName: 'BAA',
    versionNumber: 2,
    versionSha256: 'v'.repeat(64),
    requestLabel: null,
    requestSeller: { name: 'Acme MSP' },
    requestClient: 'Example Clinic LLC',
    requestPublicResponseJti: 'jti-1',
    quoteNumber: null,
    quoteSeller: null,
    quoteBillTo: null,
    quoteAcceptanceTokenJti: null,
    quoteAcceptanceExists: false,
    recorderName: null,
    orgName: 'Example Clinic (live name)',
    partnerName: 'Acme MSP (live name)',
    partnerPageSize: 'letter',
    ...over,
  };
}

describe('loadCertifiedAgreementInput', () => {
  it('returns null when the document is gone, reading under a system context', async () => {
    dbResults.push([]);
    await expect(loadCertifiedAgreementInput(DOC_ID)).resolves.toBeNull();
    expect(contexts.max).toBe(1);
  });

  it('request-sourced customer accept through the public link → emailed link; party names from the request snapshot', async () => {
    dbResults.push([loaderRow()]);
    const input = (await loadCertifiedAgreementInput(DOC_ID))!;
    expect(input.how).toEqual({ kind: 'customer', channel: 'emailed_link', method: 'typed-signature' });
    expect(input.parties).toEqual({ seller: 'Acme MSP', client: 'Example Clinic LLC' });
    expect(input.source).toEqual({ kind: 'request', requestId: REQUEST_ID });
    expect(input.agreement).toEqual({ name: 'BAA', templateName: 'BAA', versionNumber: 2 });
    expect(input.pageSize).toBe('letter');
  });

  it('maps every evidence field from the document row itself (never the version hash or a live row)', async () => {
    const row = loaderRow();
    expect(row.versionSha256).not.toBe(row.sha256); // a mix-up would be visible
    dbResults.push([row]);
    const input = (await loadCertifiedAgreementInput(DOC_ID))!;
    expect(input.document).toEqual({
      id: DOC_ID,
      pdfData: row.pdfData,
      mime: 'application/pdf',
      sha256: row.sha256,
      createdAt: CREATED_AT,
      signerName: 'Dana Buyer',
      signerEmail: 'dana@example.com',
      signedAt: SIGNED_AT,
      signerIp: '198.51.100.7',
      signerUserAgent: 'UA',
      contentSha256: 'c'.repeat(64),
      contentHashVersion: 1,
      acceptanceRenderLocale: 'en',
    });
  });

  it('#10294: the agreement is named by its template, never the staff-internal request label', async () => {
    dbResults.push([loaderRow({ requestLabel: 'BAA — 2027 renewal' })]);
    const input = (await loadCertifiedAgreementInput(DOC_ID))!;
    expect(input.agreement.name).toBe(input.agreement.templateName);
    expect(JSON.stringify(buildCertificateContent(input))).not.toContain('2027 renewal');
  });

  it('customer accept without a public-link response → portal', async () => {
    dbResults.push([loaderRow({ requestPublicResponseJti: null })]);
    expect((await loadCertifiedAgreementInput(DOC_ID))!.how).toMatchObject({ kind: 'customer', channel: 'portal' });
  });

  it('quote-sourced: token jti → emailed link; acceptance row without one → portal; acceptance gone → unknown', async () => {
    const quote = { sourceKind: 'quote', agreementRequestId: null, quoteId: 'q1', quoteNumber: 'Q-7', requestSeller: null, requestClient: null, requestPublicResponseJti: null, quoteSeller: { name: 'Acme MSP' }, quoteBillTo: 'Example Clinic LLC' };
    dbResults.push([loaderRow({ ...quote, quoteAcceptanceExists: true, quoteAcceptanceTokenJti: 'q-jti' })]);
    const viaLink = (await loadCertifiedAgreementInput(DOC_ID))!;
    expect(viaLink.how).toMatchObject({ kind: 'customer', channel: 'emailed_link' });
    expect(viaLink.source).toEqual({ kind: 'quote', quoteNumber: 'Q-7' });
    expect(viaLink.parties).toEqual({ seller: 'Acme MSP', client: 'Example Clinic LLC' });
    dbResults.push([loaderRow({ ...quote, quoteAcceptanceExists: true, quoteAcceptanceTokenJti: null })]);
    expect((await loadCertifiedAgreementInput(DOC_ID))!.how).toMatchObject({ channel: 'portal' });
    dbResults.push([loaderRow({ ...quote, quoteId: null, quoteNumber: null, quoteSeller: null, quoteBillTo: null, quoteAcceptanceExists: false })]);
    const gone = (await loadCertifiedAgreementInput(DOC_ID))!;
    expect(gone.how).toMatchObject({ channel: 'unknown' });
    // No snapshot left → the live org / partner names, never blank.
    expect(gone.parties).toEqual({ seller: 'Acme MSP (live name)', client: 'Example Clinic (live name)' });
  });

  it('on-behalf template-based record → on_behalf with the recorder name', async () => {
    dbResults.push([loaderRow({ acceptanceOrigin: 'on_behalf', acceptanceMethod: 'verbal', acceptanceReference: 'call T-0231', recorderName: 'Sam Tech', requestPublicResponseJti: null })]);
    expect((await loadCertifiedAgreementInput(DOC_ID))!.how)
      .toEqual({ kind: 'on_behalf', recordedByName: 'Sam Tech', method: 'verbal', reference: 'call T-0231' });
  });

  it('an externally-signed upload is recognised from its stored external content hash', async () => {
    const bytes = Buffer.from('%PDF-1.7 countersigned scan');
    const versionSha = 'v'.repeat(64);
    const contentSha256 = computeAgreementSha256({ kind: 'external', versionSha, bytesSha256: sha(bytes), mime: 'application/pdf' });
    dbResults.push([loaderRow({
      pdfData: bytes, sha256: sha(bytes), contentSha256, versionSha256: versionSha,
      acceptanceOrigin: 'on_behalf', acceptanceMethod: 'signed_document', acceptanceReference: 'wet ink', recorderName: 'Sam Tech',
    })]);
    expect((await loadCertifiedAgreementInput(DOC_ID))!.how)
      .toEqual({ kind: 'external_upload', recordedByName: 'Sam Tech', method: 'signed_document', reference: 'wet ink' });
  });

  it('an image is always an external upload', async () => {
    dbResults.push([loaderRow({ mime: 'image/png', acceptanceOrigin: 'on_behalf', acceptanceMethod: 'signed_document', recorderName: null })]);
    expect((await loadCertifiedAgreementInput(DOC_ID))!.how).toMatchObject({ kind: 'external_upload', recordedByName: null });
  });

  it('no signed_at → evidence unavailable (legacy back-fill gap)', async () => {
    dbResults.push([loaderRow({ sourceKind: 'quote', signerName: null, signedAt: null, acceptanceOrigin: null, acceptanceMethod: null })]);
    expect((await loadCertifiedAgreementInput(DOC_ID))!.how).toEqual({ kind: 'unavailable' });
  });

  it('partner page size A4 / unknown → resolvePageSize', async () => {
    dbResults.push([loaderRow({ partnerPageSize: 'a4' })]);
    expect((await loadCertifiedAgreementInput(DOC_ID))!.pageSize).toBe('a4');
    dbResults.push([loaderRow({ partnerPageSize: null })]);
    expect((await loadCertifiedAgreementInput(DOC_ID))!.pageSize).toBe('a4');
  });
});
