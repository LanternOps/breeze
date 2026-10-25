import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the service layer — routes are thin; we assert wiring, query
// forwarding, and error mapping (same technique as templates.test.ts).
// Real ContractDocumentServiceError flows through via importOriginal so
// `instanceof` checks in the route still work.
vi.mock('../../services/contractDocumentService', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/contractDocumentService')>();
  return {
    ...original,
    listContractDocuments: vi.fn(),
    getContractDocumentPdf: vi.fn(),
    linkContractDocument: vi.fn(),
  };
});

// Mock auth middleware to inject an org-scoped actor with contract perms —
// route tests exercise validation + service error mapping, not the
// scope/permission gates themselves (covered elsewhere).
vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', {
      user: { id: 'u1' },
      partnerId: 'p1',
      orgId: null,
      scope: 'organization',
      accessibleOrgIds: ['org-1'],
      canAccessOrg: (id: string) => id === 'org-1',
    });
    await next();
  },
  requireScope: () => async (_c: any, next: any) => next(),
  requirePermission: () => async (_c: any, next: any) => next(),
}));

vi.mock('../../services/sensitiveReadAudit', () => ({
  auditSensitiveRead: vi.fn(),
}));

// The certified copy (#9075 W2c): the renderer is unit-tested on its own; the
// route test pins the wiring (default certified, ?copy=original, fallback).
vi.mock('../../services/agreementCertificate', () => ({
  loadCertifiedAgreementInput: vi.fn(),
  renderCertifiedAgreementPdf: vi.fn(),
}));
vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));

import { contractRoutes } from './index';
import * as svc from '../../services/contractDocumentService';
import { ContractDocumentServiceError } from '../../services/contractDocumentService';
import { auditSensitiveRead } from '../../services/sensitiveReadAudit';
import { loadCertifiedAgreementInput, renderCertifiedAgreementPdf } from '../../services/agreementCertificate';
import { PdfMergeError } from '../../services/pdfMerge';
import { captureException } from '../../services/sentry';

function app() {
  return contractRoutes;
}

const BASE = '/contract-documents';
const DOC_ID = '11111111-1111-1111-1111-111111111111';
const CONTRACT_ID = '22222222-2222-2222-2222-222222222222';
const ORG_ID = '33333333-3333-3333-3333-333333333333';

const LIST_ROW = {
  id: DOC_ID,
  orgId: ORG_ID,
  contractId: null,
  quoteId: 'q1',
  templateId: 't1',
  templateVersionId: 'v1',
  templateName: 'MSA',
  templateVersionNumber: 2,
  signerName: 'Jane Doe',
  signedAt: '2026-06-01T00:00:00Z',
  signerEmail: 'jane@example.test',
  acceptanceOrigin: 'customer',
  acceptanceMethod: 'typed-signature',
  acceptanceReference: null,
  evidenceAvailable: true,
  sourceKind: 'quote',
  agreementRequestId: null,
  mime: 'application/pdf',
  quoteNumber: 'Q-2026-0001',
  byteSize: 1024,
  sha256: 'a'.repeat(64),
  createdAt: '2026-06-01T00:00:00Z',
};

describe('contract document routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET / with contractId scopes the list to that contract', async () => {
    (svc.listContractDocuments as any).mockResolvedValue([{ ...LIST_ROW, contractId: CONTRACT_ID }]);
    const res = await app().request(`${BASE}?contractId=${CONTRACT_ID}`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(svc.listContractDocuments).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ contractId: CONTRACT_ID }),
    );
  });

  it('GET /?unattached=true filters to contract_id IS NULL', async () => {
    (svc.listContractDocuments as any).mockResolvedValue([LIST_ROW]);
    const res = await app().request(`${BASE}?unattached=true`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].contractId).toBeNull();
    expect(svc.listContractDocuments).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ unattached: true }),
    );
  });

  it('GET / with no filters lists org-scoped documents', async () => {
    (svc.listContractDocuments as any).mockResolvedValue([LIST_ROW]);
    const res = await app().request(BASE, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(svc.listContractDocuments).toHaveBeenCalledOnce();
  });

  it('GET /:id/pdf?copy=original streams the stored PDF bytes byte-for-byte with application/pdf content-type', async () => {
    const pdfBytes = Buffer.from('%PDF-1.7\n%%EOF');
    (svc.getContractDocumentPdf as any).mockResolvedValue({
      pdfData: pdfBytes,
      mime: 'application/pdf',
      byteSize: pdfBytes.length,
      sha256: 'a'.repeat(64),
      orgId: ORG_ID,
    });
    const res = await app().request(`${BASE}/${DOC_ID}/pdf?copy=original`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.equals(pdfBytes)).toBe(true);
    expect(auditSensitiveRead).toHaveBeenCalledWith(expect.anything(), {
      action: 'contract.document.download',
      orgId: ORG_ID,
      resourceType: 'contract_document',
      resourceId: DOC_ID,
      format: 'original',
      rowCount: 1,
      byteCount: pdfBytes.length,
    });
    expect(res.headers.get('x-agreement-copy')).toBe('original');
    // The original never goes near the certificate renderer.
    expect(loadCertifiedAgreementInput).not.toHaveBeenCalled();
    expect(renderCertifiedAgreementPdf).not.toHaveBeenCalled();
  });

  it('GET /:id/pdf?copy=original names a PDF signed-agreement-<id>-original.pdf, as an attachment, nosniff', async () => {
    const pdfBytes = Buffer.from('%PDF-1.7\n%%EOF');
    (svc.getContractDocumentPdf as any).mockResolvedValue({
      pdfData: pdfBytes, mime: 'application/pdf', byteSize: pdfBytes.length, sha256: 'a'.repeat(64), orgId: ORG_ID,
    });
    const res = await app().request(`${BASE}/${DOC_ID}/pdf?copy=original`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(new RegExp(`^attachment; filename="signed-agreement-${DOC_ID}-original\\.pdf"`));
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('GET /:id/pdf?copy=original names an externally signed PNG by its stored MIME — .png, attachment (never inline)', async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    (svc.getContractDocumentPdf as any).mockResolvedValue({
      pdfData: pngBytes, mime: 'image/png', byteSize: pngBytes.length, sha256: 'b'.repeat(64), orgId: ORG_ID,
    });
    const res = await app().request(`${BASE}/${DOC_ID}/pdf?copy=original`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-disposition')).toMatch(new RegExp(`^attachment; filename="signed-agreement-${DOC_ID}-original\\.png"`));
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await res.arrayBuffer()).equals(pngBytes)).toBe(true);
  });

  it('GET /:id/pdf?copy=original names a JPEG .jpg', async () => {
    const jpgBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
    (svc.getContractDocumentPdf as any).mockResolvedValue({
      pdfData: jpgBytes, mime: 'image/jpeg', byteSize: jpgBytes.length, sha256: 'c'.repeat(64), orgId: ORG_ID,
    });
    const res = await app().request(`${BASE}/${DOC_ID}/pdf?copy=original`, { method: 'GET' });
    expect(res.headers.get('content-disposition')).toMatch(new RegExp(`^attachment; filename="signed-agreement-${DOC_ID}-original\\.jpg"`));
  });

  it('GET /:id/pdf maps DOCUMENT_NOT_FOUND to 404', async () => {
    (svc.getContractDocumentPdf as any).mockRejectedValue(
      new ContractDocumentServiceError('Contract document not found', 404, 'DOCUMENT_NOT_FOUND'),
    );
    const res = await app().request(`${BASE}/${DOC_ID}/pdf`, { method: 'GET' });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('DOCUMENT_NOT_FOUND');
    expect(auditSensitiveRead).not.toHaveBeenCalled();
  });

  it('GET /:id/pdf does not audit a cross-org denial', async () => {
    (svc.getContractDocumentPdf as any).mockRejectedValue(
      new ContractDocumentServiceError('Organization access denied', 403, 'ORG_DENIED'),
    );
    const res = await app().request(`${BASE}/${DOC_ID}/pdf`, { method: 'GET' });
    expect(res.status).toBe(403);
    expect(auditSensitiveRead).not.toHaveBeenCalled();
  });

  it('GET /:id/pdf?copy=original does not audit when response byte preparation fails', async () => {
    (svc.getContractDocumentPdf as any).mockResolvedValue({
      pdfData: Symbol('invalid pdf bytes'),
      mime: 'application/pdf',
      byteSize: 10,
      sha256: 'a'.repeat(64),
      orgId: ORG_ID,
    });

    const res = await app().request(`${BASE}/${DOC_ID}/pdf?copy=original`, { method: 'GET' });

    expect(res.status).toBe(500);
    expect(auditSensitiveRead).not.toHaveBeenCalled();
  });

  it('GET /:id/pdf?copy=original keeps response bytes unchanged when audit delivery is non-blocking', async () => {
    const pdfBytes = Buffer.from('%PDF-1.7\nsame bytes');
    (svc.getContractDocumentPdf as any).mockResolvedValue({
      pdfData: pdfBytes,
      mime: 'application/pdf',
      byteSize: pdfBytes.length,
      sha256: 'a'.repeat(64),
      orgId: ORG_ID,
    });
    vi.mocked(auditSensitiveRead).mockImplementationOnce(() => {
      void Promise.reject(new Error('audit backend unavailable')).catch(() => undefined);
    });

    const res = await app().request(`${BASE}/${DOC_ID}/pdf?copy=original`, { method: 'GET' });

    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(pdfBytes);
  });

  // -------------------------------------------------------------------------
  // ?copy=certified (the default) — #9075 W2c, spec §3.8
  // -------------------------------------------------------------------------

  const STORED = Buffer.from('%PDF-1.7\nstored frozen bytes');
  const CERTIFIED = Buffer.from('%PDF-1.7\ncertified copy with a certificate page');
  const INPUT = { document: { id: DOC_ID }, marker: 'certificate-input' };

  function mockStored(over: Record<string, unknown> = {}) {
    (svc.getContractDocumentPdf as any).mockResolvedValue({
      pdfData: STORED, mime: 'application/pdf', byteSize: STORED.length, sha256: 'a'.repeat(64), orgId: ORG_ID, ...over,
    });
  }

  it('GET /:id/pdf defaults to the certified copy: always a PDF, signed-agreement-<id>.pdf, audited pdf-certified', async () => {
    mockStored({ mime: 'image/png' }); // even a PNG scan's certified copy is a PDF
    vi.mocked(loadCertifiedAgreementInput).mockResolvedValue(INPUT as any);
    vi.mocked(renderCertifiedAgreementPdf).mockResolvedValue(CERTIFIED);
    const res = await app().request(`${BASE}/${DOC_ID}/pdf`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-length')).toBe(String(CERTIFIED.length));
    expect(res.headers.get('content-disposition')).toMatch(new RegExp(`^attachment; filename="signed-agreement-${DOC_ID}\\.pdf"`));
    expect(res.headers.get('x-agreement-copy')).toBe('certified');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await res.arrayBuffer()).equals(CERTIFIED)).toBe(true);
    expect(loadCertifiedAgreementInput).toHaveBeenCalledWith(DOC_ID);
    expect(renderCertifiedAgreementPdf).toHaveBeenCalledWith(INPUT);
    expect(auditSensitiveRead).toHaveBeenCalledWith(expect.anything(), {
      action: 'contract.document.download',
      orgId: ORG_ID,
      resourceType: 'contract_document',
      resourceId: DOC_ID,
      format: 'pdf-certified',
      rowCount: 1,
      byteCount: CERTIFIED.length,
    });
  });

  it('?copy=certified explicitly is the same as the default', async () => {
    mockStored();
    vi.mocked(loadCertifiedAgreementInput).mockResolvedValue(INPUT as any);
    vi.mocked(renderCertifiedAgreementPdf).mockResolvedValue(CERTIFIED);
    const res = await app().request(`${BASE}/${DOC_ID}/pdf?copy=certified`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(CERTIFIED)).toBe(true);
    expect(vi.mocked(auditSensitiveRead).mock.calls[0]![1].format).toBe('pdf-certified');
  });

  it('the audit format differs per variant (certified vs original)', async () => {
    mockStored();
    vi.mocked(loadCertifiedAgreementInput).mockResolvedValue(INPUT as any);
    vi.mocked(renderCertifiedAgreementPdf).mockResolvedValue(CERTIFIED);
    await app().request(`${BASE}/${DOC_ID}/pdf`, { method: 'GET' });
    await app().request(`${BASE}/${DOC_ID}/pdf?copy=original`, { method: 'GET' });
    const formats = vi.mocked(auditSensitiveRead).mock.calls.map((call) => call[1].format);
    expect(formats).toEqual(['pdf-certified', 'original']);
  });

  it('rejects an unknown ?copy value with 400 and reads nothing', async () => {
    const res = await app().request(`${BASE}/${DOC_ID}/pdf?copy=stamped`, { method: 'GET' });
    expect(res.status).toBe(400);
    expect(svc.getContractDocumentPdf).not.toHaveBeenCalled();
  });

  it('access is decided by the caller-scoped read BEFORE the certificate loader runs', async () => {
    (svc.getContractDocumentPdf as any).mockRejectedValue(
      new ContractDocumentServiceError('Contract document not found', 404, 'DOCUMENT_NOT_FOUND'),
    );
    const res = await app().request(`${BASE}/${DOC_ID}/pdf`, { method: 'GET' });
    expect(res.status).toBe(404);
    expect(loadCertifiedAgreementInput).not.toHaveBeenCalled();
    expect(auditSensitiveRead).not.toHaveBeenCalled();
  });

  it('a PdfMergeError falls back to the ORIGINAL bytes, honestly named and audited as original', async () => {
    mockStored();
    vi.mocked(loadCertifiedAgreementInput).mockResolvedValue(INPUT as any);
    vi.mocked(renderCertifiedAgreementPdf).mockRejectedValue(new PdfMergeError('An attached contract PDF could not be read: bad xref'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await app().request(`${BASE}/${DOC_ID}/pdf`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(STORED)).toBe(true);
    expect(res.headers.get('content-disposition')).toMatch(new RegExp(`^attachment; filename="signed-agreement-${DOC_ID}-original\\.pdf"`));
    expect(res.headers.get('x-agreement-copy')).toBe('original');
    expect(vi.mocked(auditSensitiveRead).mock.calls[0]![1].format).toBe('original');
    expect(warn).toHaveBeenCalled();
    expect(captureException).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('any OTHER render failure is a loud 500, not a silent original', async () => {
    mockStored();
    vi.mocked(loadCertifiedAgreementInput).mockResolvedValue(INPUT as any);
    vi.mocked(renderCertifiedAgreementPdf).mockRejectedValue(new Error('document theme font missing: /x/DMSans-Regular.ttf'));
    const res = await app().request(`${BASE}/${DOC_ID}/pdf`, { method: 'GET' });
    expect(res.status).toBe(500);
    expect(auditSensitiveRead).not.toHaveBeenCalled();
  });

  it('a document that vanished between the access check and the certificate read is a 404', async () => {
    mockStored();
    vi.mocked(loadCertifiedAgreementInput).mockResolvedValue(null);
    const res = await app().request(`${BASE}/${DOC_ID}/pdf`, { method: 'GET' });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('DOCUMENT_NOT_FOUND');
    expect(auditSensitiveRead).not.toHaveBeenCalled();
  });

  it('PATCH /:id links a document to a contract', async () => {
    (svc.linkContractDocument as any).mockResolvedValue({ ...LIST_ROW, contractId: CONTRACT_ID });
    const res = await app().request(`${BASE}/${DOC_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contractId: CONTRACT_ID }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.contractId).toBe(CONTRACT_ID);
    expect(svc.linkContractDocument).toHaveBeenCalledWith(expect.anything(), DOC_ID, CONTRACT_ID);
  });

  it('PATCH /:id rejects a cross-org contract (404, no leak of which side failed)', async () => {
    (svc.linkContractDocument as any).mockRejectedValue(
      new ContractDocumentServiceError('Contract not found or belongs to a different organization', 404, 'CONTRACT_NOT_FOUND'),
    );
    const res = await app().request(`${BASE}/${DOC_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contractId: CONTRACT_ID }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('CONTRACT_NOT_FOUND');
  });

  it('PATCH /:id rejects a missing contractId (400, no service call)', async () => {
    const res = await app().request(`${BASE}/${DOC_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(svc.linkContractDocument).not.toHaveBeenCalled();
  });
  it.each([['all'], ['linked'], ['unlinked']])('GET /?linked=%s forwards the filter to the service', async (linked) => {
    (svc.listContractDocuments as any).mockResolvedValue([LIST_ROW]);
    const res = await app().request(`${BASE}?linked=${linked}`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(svc.listContractDocuments).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ linked }),
    );
  });

  it('GET /?linked=bogus is a 400 and never reaches the service', async () => {
    const res = await app().request(`${BASE}?linked=bogus`, { method: 'GET' });
    expect(res.status).toBe(400);
    expect(svc.listContractDocuments).not.toHaveBeenCalled();
  });

  // Back-compat pin (decision 3): an omitted `linked` still means "unlinked",
  // so the pre-Agreements DocumentsTab caller behaves identically. The
  // Agreements page opts INTO the full inventory with linked=all.
  it('GET / with no linked param defaults to unlinked', async () => {
    (svc.listContractDocuments as any).mockResolvedValue([LIST_ROW]);
    await app().request(BASE, { method: 'GET' });
    expect(svc.listContractDocuments).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ linked: 'unlinked' }),
    );
  });

  it('GET /?orgId=… scopes the list to one organization (org-record embed)', async () => {
    (svc.listContractDocuments as any).mockResolvedValue([LIST_ROW]);
    await app().request(`${BASE}?orgId=${ORG_ID}&linked=all`, { method: 'GET' });
    expect(svc.listContractDocuments).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orgId: ORG_ID, linked: 'all' }),
    );
  });
});
