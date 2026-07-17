import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the service layer — routes are thin; we assert wiring, validation,
// error mapping. Real ContractTemplateServiceError / PartnerWideWriteDeniedError
// classes flow through via importOriginal so `instanceof` checks in the route
// still work (same technique as configurationPolicies/crud.test.ts).
vi.mock('../../services/contractTemplateService', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/contractTemplateService')>();
  return {
    ...original,
    listTemplates: vi.fn(),
    createTemplate: vi.fn(),
    getTemplate: vi.fn(),
    updateTemplate: vi.fn(),
    archiveTemplate: vi.fn(),
    createDraftVersion: vi.fn(),
    createUploadedVersion: vi.fn(),
    getTemplateVersion: vi.fn(),
    publishVersion: vi.fn(),
  };
});

// Mock auth middleware to inject an org-scoped actor (mirrors the brief's
// "org-scoped token" framing for the 403 partner-wide-create test) with
// contract perms. requireScope/requirePermission are pass-throughs — the
// route tests exercise validation + service error mapping, not the
// scope/permission gates themselves (those are covered by auth.test.ts and
// the contractTemplateService unit tests).
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
import * as svc from '../../services/contractTemplateService';
import { ContractTemplateServiceError, PartnerWideWriteDeniedError } from '../../services/contractTemplateService';

function app() {
  // contractRoutes already applies authMiddleware internally
  return contractRoutes;
}

const BASE = '/contract-templates';
const TEMPLATE_ID = '11111111-1111-1111-1111-111111111111';
const VERSION_ID = '22222222-2222-2222-2222-222222222222';
const ORG_ID = '33333333-3333-3333-3333-333333333333';

describe('contract template routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET / lists templates', async () => {
    (svc.listTemplates as any).mockResolvedValue([
      { id: TEMPLATE_ID, name: 'MSA', orgId: ORG_ID, partnerId: null, latestVersion: null },
    ]);
    const res = await app().request(BASE, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].ownerScope).toBe('organization');
    expect(svc.listTemplates).toHaveBeenCalledOnce();
  });

  it('POST / creates an org-owned template', async () => {
    (svc.createTemplate as any).mockResolvedValue({ id: TEMPLATE_ID, name: 'MSA', orgId: ORG_ID, partnerId: null });
    const res = await app().request(BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ownerScope: 'organization', orgId: ORG_ID, name: 'MSA' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(TEMPLATE_ID);
    expect(body.data.ownerScope).toBe('organization');
    expect(body.data.partnerId).toBeNull();
    expect(svc.createTemplate).toHaveBeenCalledOnce();
  });

  // Step 1 requirement: 400 on ownerScope/orgId mismatch — the shared
  // createContractTemplateSchema's superRefine rejects this before the
  // service is ever called.
  it('POST / rejects ownerScope="organization" without orgId (400, no service call)', async () => {
    const res = await app().request(BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ownerScope: 'organization', name: 'MSA' }),
    });
    expect(res.status).toBe(400);
    expect(svc.createTemplate).not.toHaveBeenCalled();
  });

  it('POST / rejects ownerScope="partner" with an orgId set (400, no service call)', async () => {
    const res = await app().request(BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ownerScope: 'partner', orgId: ORG_ID, name: 'MSA' }),
    });
    expect(res.status).toBe(400);
    expect(svc.createTemplate).not.toHaveBeenCalled();
  });

  // Step 1 requirement: 403 when an org-scoped token attempts a partner-wide create.
  it('POST / maps PartnerWideWriteDeniedError to 403 (org-scoped token creating partner-wide)', async () => {
    (svc.createTemplate as any).mockRejectedValue(new PartnerWideWriteDeniedError());
    const res = await app().request(BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ownerScope: 'partner', name: 'Partner-wide MSA' }),
    });
    expect(res.status).toBe(403);
    expect(svc.createTemplate).toHaveBeenCalledOnce();
  });

  it('GET /:id returns template detail with versions, stripping binary fileData', async () => {
    (svc.getTemplate as any).mockResolvedValue({
      id: TEMPLATE_ID,
      name: 'MSA',
      orgId: ORG_ID,
      partnerId: null,
      versions: [
        {
          id: VERSION_ID,
          sourceType: 'authored',
          bodyHtml: '<p>Hi</p>',
          fileData: null,
          status: 'draft',
          orgId: ORG_ID,
          partnerId: null,
        },
        {
          id: 'v2',
          sourceType: 'uploaded',
          bodyHtml: null,
          fileData: Buffer.from('%PDF-1.7'),
          mime: 'application/pdf',
          byteSize: 8,
          status: 'draft',
          orgId: ORG_ID,
          partnerId: null,
        },
      ],
    });
    const res = await app().request(`${BASE}/${TEMPLATE_ID}`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(TEMPLATE_ID);
    expect(body.data.ownerScope).toBe('organization');
    expect(body.data.versions).toHaveLength(2);
    expect(body.data.versions[0].bodyHtml).toBe('<p>Hi</p>');
    expect(body.data.versions[0].ownerScope).toBe('organization');
    expect(body.data.versions[1].fileData).toBeUndefined();
    expect(body.data.versions[1].mime).toBe('application/pdf');
  });

  it('GET /:id maps TEMPLATE_NOT_FOUND to 404', async () => {
    (svc.getTemplate as any).mockRejectedValue(new ContractTemplateServiceError('Contract template not found', 404, 'TEMPLATE_NOT_FOUND'));
    const res = await app().request(`${BASE}/${TEMPLATE_ID}`, { method: 'GET' });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('TEMPLATE_NOT_FOUND');
  });

  it('PATCH /:id updates a template', async () => {
    (svc.updateTemplate as any).mockResolvedValue({ id: TEMPLATE_ID, name: 'Renamed', orgId: ORG_ID, partnerId: null });
    const res = await app().request(`${BASE}/${TEMPLATE_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.name).toBe('Renamed');
    expect(svc.updateTemplate).toHaveBeenCalledWith(expect.anything(), TEMPLATE_ID, { name: 'Renamed' });
  });

  it('POST /:id/archive archives a template', async () => {
    (svc.archiveTemplate as any).mockResolvedValue(undefined);
    const res = await app().request(`${BASE}/${TEMPLATE_ID}/archive`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.ok).toBe(true);
    expect(svc.archiveTemplate).toHaveBeenCalledWith(expect.anything(), TEMPLATE_ID);
  });

  it('POST /:id/versions creates a new authored draft version', async () => {
    (svc.createDraftVersion as any).mockResolvedValue({
      id: VERSION_ID,
      versionNumber: 2,
      sourceType: 'authored',
      bodyHtml: '<p>New draft</p>',
      status: 'draft',
      orgId: ORG_ID,
      partnerId: null,
    });
    const res = await app().request(`${BASE}/${TEMPLATE_ID}/versions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bodyHtml: '<p>New draft</p>' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.versionNumber).toBe(2);
    expect(svc.createDraftVersion).toHaveBeenCalledWith(expect.anything(), TEMPLATE_ID, { bodyHtml: '<p>New draft</p>' });
  });

  it('POST /:id/versions rejects an empty bodyHtml (400, no service call)', async () => {
    const res = await app().request(`${BASE}/${TEMPLATE_ID}/versions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bodyHtml: '' }),
    });
    expect(res.status).toBe(400);
    expect(svc.createDraftVersion).not.toHaveBeenCalled();
  });

  // Step 1 requirement: 409 surfaced from VERSION_IMMUTABLE.
  it('POST /:id/versions/:versionId/publish maps VERSION_IMMUTABLE to 409', async () => {
    (svc.publishVersion as any).mockRejectedValue(
      new ContractTemplateServiceError('Published versions are immutable', 409, 'VERSION_IMMUTABLE')
    );
    const res = await app().request(`${BASE}/${TEMPLATE_ID}/versions/${VERSION_ID}/publish`, { method: 'POST' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('VERSION_IMMUTABLE');
  });

  // Step 1 requirement: publish returns declared_variables scanned from body.
  it('POST /:id/versions/:versionId/publish returns declaredVariables scanned from the body', async () => {
    (svc.publishVersion as any).mockResolvedValue({
      id: VERSION_ID,
      status: 'published',
      sourceType: 'authored',
      bodyHtml: '<p>Dear {{client.name}}, {{special_clause}}</p>',
      sha256: 'abc123',
      declaredVariables: [
        { name: 'client.name', kind: 'auto' },
        { name: 'special_clause', kind: 'manual' },
      ],
      orgId: ORG_ID,
      partnerId: null,
    });
    const res = await app().request(`${BASE}/${TEMPLATE_ID}/versions/${VERSION_ID}/publish`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.declaredVariables).toEqual([
      { name: 'client.name', kind: 'auto' },
      { name: 'special_clause', kind: 'manual' },
    ]);
  });

  it('GET /:id/versions/:versionId returns an authored version with its body', async () => {
    (svc.getTemplateVersion as any).mockResolvedValue({
      id: VERSION_ID,
      sourceType: 'authored',
      bodyHtml: '<p>Body text</p>',
      fileData: null,
      status: 'draft',
      orgId: ORG_ID,
      partnerId: null,
    });
    const res = await app().request(`${BASE}/${TEMPLATE_ID}/versions/${VERSION_ID}`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.bodyHtml).toBe('<p>Body text</p>');
  });

  it('GET /:id/versions/:versionId returns metadata only (no bodyHtml/fileData) for an uploaded version', async () => {
    (svc.getTemplateVersion as any).mockResolvedValue({
      id: VERSION_ID,
      sourceType: 'uploaded',
      bodyHtml: null,
      fileData: Buffer.from('%PDF-1.7'),
      mime: 'application/pdf',
      byteSize: 8,
      status: 'draft',
      orgId: ORG_ID,
      partnerId: null,
    });
    const res = await app().request(`${BASE}/${TEMPLATE_ID}/versions/${VERSION_ID}`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.fileData).toBeUndefined();
    expect(body.data.mime).toBe('application/pdf');
  });

  it('GET /:id/versions/:versionId/file streams the uploaded PDF bytes', async () => {
    const pdfBytes = Buffer.from('%PDF-1.7\n%%EOF');
    (svc.getTemplateVersion as any).mockResolvedValue({
      id: VERSION_ID,
      sourceType: 'uploaded',
      fileData: pdfBytes,
      mime: 'application/pdf',
      byteSize: pdfBytes.length,
    });
    const res = await app().request(`${BASE}/${TEMPLATE_ID}/versions/${VERSION_ID}/file`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.equals(pdfBytes)).toBe(true);
  });

  it('GET /:id/versions/:versionId/file 404s for an authored version (no file)', async () => {
    (svc.getTemplateVersion as any).mockResolvedValue({
      id: VERSION_ID,
      sourceType: 'authored',
      bodyHtml: '<p>x</p>',
      fileData: null,
    });
    const res = await app().request(`${BASE}/${TEMPLATE_ID}/versions/${VERSION_ID}/file`, { method: 'GET' });
    expect(res.status).toBe(404);
  });

  // Step 1 requirement: upload rejects non-PDF.
  it('POST /:id/versions/upload rejects a non-PDF content-type (400, no service call)', async () => {
    const form = new FormData();
    form.append('file', new File([Buffer.from('hello world')], 'notes.txt', { type: 'text/plain' }));
    const res = await app().request(`${BASE}/${TEMPLATE_ID}/versions/upload`, { method: 'POST', body: form });
    expect(res.status).toBe(400);
    expect(svc.createUploadedVersion).not.toHaveBeenCalled();
  });

  it('POST /:id/versions/upload rejects a missing file field (400, no service call)', async () => {
    const form = new FormData();
    form.append('notFile', 'oops');
    const res = await app().request(`${BASE}/${TEMPLATE_ID}/versions/upload`, { method: 'POST', body: form });
    expect(res.status).toBe(400);
    expect(svc.createUploadedVersion).not.toHaveBeenCalled();
  });

  it('POST /:id/versions/upload accepts a declared application/pdf file and delegates to the service', async () => {
    (svc.createUploadedVersion as any).mockResolvedValue({
      id: VERSION_ID,
      sourceType: 'uploaded',
      mime: 'application/pdf',
      byteSize: 14,
      status: 'draft',
      orgId: ORG_ID,
      partnerId: null,
    });
    const form = new FormData();
    form.append('file', new File([Buffer.from('%PDF-1.7\n%%EOF')], 'contract.pdf', { type: 'application/pdf' }));
    const res = await app().request(`${BASE}/${TEMPLATE_ID}/versions/upload`, { method: 'POST', body: form });
    expect(res.status).toBe(200);
    expect(svc.createUploadedVersion).toHaveBeenCalledOnce();
  });

  it('POST /:id/versions/upload surfaces the service-level INVALID_FILE rejection (bad magic bytes) as 400', async () => {
    (svc.createUploadedVersion as any).mockRejectedValue(
      new ContractTemplateServiceError('File is not a valid PDF', 400, 'INVALID_FILE')
    );
    const form = new FormData();
    // Declared as application/pdf so it passes the route's content-type gate,
    // but the bytes don't start with %PDF- — the service's magic-byte check
    // (mocked here) is what actually rejects it, proving the route surfaces it.
    form.append('file', new File([Buffer.from('not really a pdf')], 'fake.pdf', { type: 'application/pdf' }));
    const res = await app().request(`${BASE}/${TEMPLATE_ID}/versions/upload`, { method: 'POST', body: form });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_FILE');
  });
});
