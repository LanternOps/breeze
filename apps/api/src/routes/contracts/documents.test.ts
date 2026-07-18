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

import { contractRoutes } from './index';
import * as svc from '../../services/contractDocumentService';
import { ContractDocumentServiceError } from '../../services/contractDocumentService';

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

  it('GET /:id/pdf streams the PDF bytes with application/pdf content-type', async () => {
    const pdfBytes = Buffer.from('%PDF-1.7\n%%EOF');
    (svc.getContractDocumentPdf as any).mockResolvedValue({
      pdfData: pdfBytes,
      mime: 'application/pdf',
      byteSize: pdfBytes.length,
      sha256: 'a'.repeat(64),
    });
    const res = await app().request(`${BASE}/${DOC_ID}/pdf`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.equals(pdfBytes)).toBe(true);
  });

  it('GET /:id/pdf maps DOCUMENT_NOT_FOUND to 404', async () => {
    (svc.getContractDocumentPdf as any).mockRejectedValue(
      new ContractDocumentServiceError('Contract document not found', 404, 'DOCUMENT_NOT_FOUND'),
    );
    const res = await app().request(`${BASE}/${DOC_ID}/pdf`, { method: 'GET' });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('DOCUMENT_NOT_FOUND');
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
});
