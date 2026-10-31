import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Portal signed-agreements read model (#9075 W3a). Table-keyed DB mock (see
// agreements.test.ts); the certificate renderer and the audit are spies so the
// order "portal access check FIRST, system-scope loader second" is observable.
const h = vi.hoisted(() => ({
  rows: new Map<unknown, unknown[]>(),
  events: [] as string[],
}));

vi.mock('../../db', () => {
  const makeChain = () => {
    let table: unknown = null;
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn((t: unknown) => { table = t; h.events.push('read'); return chain; });
    for (const m of ['where', 'limit', 'orderBy', 'innerJoin', 'leftJoin']) chain[m] = vi.fn(() => chain);
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(h.rows.get(table) ?? []).then(resolve, reject);
    return chain;
  };
  return {
    db: { select: (...a: unknown[]) => (makeChain().select as (...x: unknown[]) => unknown)(...a) },
    runOutsideDbContext: <T,>(fn: () => T): T => fn(),
    withSystemDbAccessContext: <T,>(fn: () => Promise<T>): Promise<T> => fn(),
  };
});

const m = vi.hoisted(() => ({
  load: vi.fn(),
  render: vi.fn(),
  audit: vi.fn(),
  capture: vi.fn(),
}));
vi.mock('../../services/agreementCertificate', () => ({
  loadCertifiedAgreementInput: (...a: unknown[]) => { h.events.push('loader'); return m.load(...a); },
  renderCertifiedAgreementPdf: m.render,
}));
vi.mock('../../services/sensitiveReadAudit', () => ({ auditPortalSensitiveRead: m.audit }));
vi.mock('../../services/sentry', () => ({ captureException: m.capture }));

import { portalSignedAgreementRoutes } from './signedAgreements';
import { agreementRequests, contractDocuments, contractTemplateVersions } from '../../db/schema/contractDocuments';
import { quotes } from '../../db/schema/quotes';
import { PdfMergeError } from '../../services/pdfMerge';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '99999999-9999-4999-8999-999999999999';
const PARTNER = '33333333-3333-4333-8333-333333333333';
const DOC = '66666666-6666-4666-8666-666666666666';
const VERSION = '22222222-2222-4222-8222-222222222222';
const REQ = '55555555-5555-4555-8555-555555555555';
const QUOTE = '77777777-7777-4777-8777-777777777777';

function app() {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('portalAuth', {
      user: { id: 'pu-1', orgId: ORG, email: 'dana@customer.example', name: 'Dana', contactId: null, receiveNotifications: true, status: 'active' },
      token: 't', authMethod: 'bearer', partnerId: PARTNER, timezone: 'America/Denver',
    });
    await next();
  });
  a.route('/', portalSignedAgreementRoutes);
  return a;
}

const PDF = Buffer.from('%PDF-1.7 original bytes');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CERTIFIED = Buffer.from('%PDF-1.7 certified copy');

beforeEach(() => {
  vi.clearAllMocks();
  h.rows.clear();
  h.events.length = 0;
  m.load.mockResolvedValue({ document: { id: DOC } });
  m.render.mockResolvedValue(CERTIFIED);
});

describe('GET /signed-agreements', () => {
  it('lists both source kinds as metadata, named by request label → template, with the proposal number', async () => {
    h.rows.set(contractDocuments, [
      {
        id: DOC, sourceKind: 'request', templateVersionId: VERSION, agreementRequestId: REQ, quoteId: null,
        mime: 'application/pdf', byteSize: 1200, signerName: 'Dana Buyer', signedAt: new Date('2026-10-21T09:00:00Z'),
        acceptanceOrigin: 'customer', createdAt: new Date('2026-10-21T09:00:01Z'),
      },
      {
        id: 'doc-2', sourceKind: 'quote', templateVersionId: VERSION, agreementRequestId: null, quoteId: QUOTE,
        mime: 'image/png', byteSize: 800, signerName: null, signedAt: null,
        acceptanceOrigin: null, createdAt: new Date('2026-09-01T00:00:00Z'),
      },
    ]);
    h.rows.set(agreementRequests, [{ id: REQ, label: 'HIPAA BAA 2026' }]);
    h.rows.set(quotes, [{ id: QUOTE, quoteNumber: 'Q-1042' }]);
    h.rows.set(contractTemplateVersions, [{ versionId: VERSION, versionNumber: 3, templateName: 'BAA' }]);
    const res = await app().request('/signed-agreements');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.timezone).toBe('America/Denver'); // #10291
    expect(body.data).toEqual([
      {
        id: DOC, name: 'HIPAA BAA 2026', templateName: 'BAA', versionNumber: 3, sourceKind: 'request', quoteNumber: null,
        mime: 'application/pdf', byteSize: 1200, signerName: 'Dana Buyer', signedAt: '2026-10-21T09:00:00.000Z',
        acceptanceOrigin: 'customer', createdAt: '2026-10-21T09:00:01.000Z',
      },
      {
        id: 'doc-2', name: 'BAA', templateName: 'BAA', versionNumber: 3, sourceKind: 'quote', quoteNumber: 'Q-1042',
        mime: 'image/png', byteSize: 800, signerName: null, signedAt: null,
        acceptanceOrigin: null, createdAt: '2026-09-01T00:00:00.000Z',
      },
    ]);
  });

  it('never carries the MSP evidence trail (IP, user agent, on-behalf method/reference, recorder)', async () => {
    h.rows.set(contractDocuments, [{
      id: DOC, sourceKind: 'request', templateVersionId: VERSION, agreementRequestId: null, quoteId: null, mime: 'application/pdf',
      byteSize: 1, signerName: 'X', signedAt: null, acceptanceOrigin: 'on_behalf', createdAt: new Date(),
      // Even if a projection regression selected them, they are not copied out.
      signerIp: '198.51.100.7', signerUserAgent: 'UA', acceptanceMethod: 'wet_ink', acceptanceReference: 'binder 4', recordedByUserId: 'u-1',
    }]);
    const text = await (await app().request('/signed-agreements')).text();
    for (const leaked of ['198.51.100.7', 'wet_ink', 'binder 4', 'u-1', 'signerIp', 'acceptanceReference', 'recordedBy']) {
      expect(text).not.toContain(leaked);
    }
  });

  it('an org with none → [] with no enrichment reads', async () => {
    const res = await app().request('/signed-agreements');
    expect((await res.json()).data).toEqual([]);
    expect(h.events).toEqual(['read']);
  });
});

describe('GET /signed-agreements/:documentId/file', () => {
  it('a document of another org (or unknown) → 404 BEFORE the system-scope loader', async () => {
    const res = await app().request(`/signed-agreements/${DOC}/file`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Signed agreement not found', code: 'NOT_FOUND' });
    expect(h.events).not.toContain('loader');
    expect(m.audit).not.toHaveBeenCalled();
  });

  it('a row for another org reaching the handler anyway (a policy regression) → still the 404, no loader', async () => {
    h.rows.set(contractDocuments, [{ id: DOC, orgId: OTHER_ORG, mime: 'application/pdf', pdfData: PDF }]);
    const res = await app().request(`/signed-agreements/${DOC}/file`);
    expect(res.status).toBe(404);
    expect(h.events).not.toContain('loader');
    expect(m.audit).not.toHaveBeenCalled();
  });

  it('default = the certified copy: always a PDF download, X-Agreement-Copy certified, audited with the portal principal', async () => {
    h.rows.set(contractDocuments, [{ id: DOC, orgId: ORG, mime: 'image/png', pdfData: PNG }]);
    const res = await app().request(`/signed-agreements/${DOC}/file`);
    expect(res.status).toBe(200);
    expect(h.events).toEqual(['read', 'loader']);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('x-agreement-copy')).toBe('certified');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;.*signed-agreement-66666666-6666-4666-8666-666666666666\.pdf/);
    expect(res.headers.get('cache-control')).toBe('private, max-age=300');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(CERTIFIED);
    expect(m.audit).toHaveBeenCalledWith(expect.anything(), { id: 'pu-1', email: 'dana@customer.example' }, {
      action: 'contract.document.download', orgId: ORG, partnerId: PARTNER, resourceType: 'contract_document',
      resourceId: DOC, format: 'pdf-certified', rowCount: 1, byteCount: CERTIFIED.byteLength, fallback: false,
    });
  });

  it('?copy=original → the stored bytes byte-for-byte under the stored MIME and extension', async () => {
    h.rows.set(contractDocuments, [{ id: DOC, orgId: ORG, mime: 'image/png', pdfData: PNG }]);
    const res = await app().request(`/signed-agreements/${DOC}/file?copy=original`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-agreement-copy')).toBe('original');
    expect(res.headers.get('content-disposition')).toMatch(/signed-agreement-66666666-6666-4666-8666-666666666666-original\.png/);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
    expect(h.events).not.toContain('loader');
    expect(m.audit.mock.calls[0]![2]).toMatchObject({ format: 'original', byteCount: PNG.byteLength, fallback: false });
  });

  it('an unreadable original (PdfMergeError) degrades to the original: named + audited as such, no-store, captured', async () => {
    h.rows.set(contractDocuments, [{ id: DOC, orgId: ORG, mime: 'application/pdf', pdfData: PDF }]);
    m.render.mockRejectedValue(new PdfMergeError('encrypted', 422, 'CONTRACT_PDF_UNREADABLE'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await app().request(`/signed-agreements/${DOC}/file`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-agreement-copy')).toBe('original');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-disposition')).toMatch(/-original\.pdf/);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PDF);
    // Audited as the original AND as a fallback, so it is never mistaken for an explicit original.
    expect(m.audit.mock.calls[0]![2]).toMatchObject({ format: 'original', fallback: true });
    expect(m.capture).toHaveBeenCalledWith(
      expect.any(PdfMergeError),
      expect.anything(),
      expect.objectContaining({ area: 'agreement-certificate', surface: 'portal', documentId: DOC }),
      { fingerprint: ['agreement-certificate-fallback', 'CONTRACT_PDF_UNREADABLE'] },
    );
    warn.mockRestore();
  });

  it('a certificate bug (not a PdfMergeError) is a loud 500, never a silent original', async () => {
    h.rows.set(contractDocuments, [{ id: DOC, orgId: ORG, mime: 'application/pdf', pdfData: PDF }]);
    m.render.mockRejectedValue(new Error('font missing'));
    const res = await app().request(`/signed-agreements/${DOC}/file`);
    expect(res.status).toBe(500);
    expect(m.audit).not.toHaveBeenCalled();
  });

  it('gone between the access read and the loader → the same 404', async () => {
    h.rows.set(contractDocuments, [{ id: DOC, orgId: ORG, mime: 'application/pdf', pdfData: PDF }]);
    m.load.mockResolvedValue(null);
    const res = await app().request(`/signed-agreements/${DOC}/file`);
    expect(res.status).toBe(404);
    expect(m.audit).not.toHaveBeenCalled();
  });

  it('an unknown copy value → 400', async () => {
    const res = await app().request(`/signed-agreements/${DOC}/file?copy=stamped`);
    expect(res.status).toBe(400);
  });
});
