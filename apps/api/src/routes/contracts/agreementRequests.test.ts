import { describe, it, expect, vi, beforeEach } from 'vitest';

// Route tests for POST /contracts/agreement-requests/record-signed (#8865 W1c).
// Routes are thin: assert wiring, which DB context each step runs in, the
// org-access 404, multipart parsing and error mapping. The service is mocked
// with importOriginal so the real AgreementRequestServiceError flows through
// the route's `instanceof` mapper.

const h = vi.hoisted(() => ({
  withAuthDbAccessContext: vi.fn(async (_auth: unknown, fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn(<T,>(fn: () => T) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  recordSignedAgreement: vi.fn(),
  loadOrgOwnerPartnerId: vi.fn(),
  loadTemplateVersionRenderData: vi.fn(),
  assertTemplateVersionUsable: vi.fn(),
  writeRouteAudit: vi.fn(),
  // Which context each step ran in — pushed by the wrappers and the steps.
  trace: [] as string[],
  // Which scope / permission guards actually ran for the request.
  guards: [] as string[],
  inAuth: false,
  inSystem: false,
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', {
      user: { id: 'u1' },
      partnerId: 'p1',
      orgId: null,
      scope: 'partner',
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (id: string) => id === ORG_ID,
    });
    await next();
  },
  requireScope: (...scopes: string[]) => async (_c: any, next: any) => { h.guards.push(`scope:${scopes.join(',')}`); return next(); },
  requirePermission: (resource: string, action: string) => async (_c: any, next: any) => { h.guards.push(`perm:${resource}:${action}`); return next(); },
  withAuthDbAccessContext: h.withAuthDbAccessContext,
}));

vi.mock('../../db', async (importActual) => ({
  ...(await importActual<typeof import('../../db')>()),
  runOutsideDbContext: h.runOutsideDbContext,
  withSystemDbAccessContext: h.withSystemDbAccessContext,
}));

vi.mock('../../services/agreementRequestService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/agreementRequestService')>()),
  recordSignedAgreement: h.recordSignedAgreement,
  loadOrgOwnerPartnerId: h.loadOrgOwnerPartnerId,
}));

vi.mock('../../services/contractTemplateRender', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/contractTemplateRender')>()),
  loadTemplateVersionRenderData: h.loadTemplateVersionRenderData,
}));

vi.mock('../../services/contractTemplateService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/contractTemplateService')>()),
  assertTemplateVersionUsable: h.assertTemplateVersionUsable,
}));

vi.mock('../../services/auditEvents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/auditEvents')>()),
  writeRouteAudit: h.writeRouteAudit,
}));

import { contractRoutes } from './index';
import { AgreementRequestServiceError } from '../../services/agreementRequestService';
import { ContractTemplateServiceError } from '../../services/contractTemplateService';
import { QuoteServiceError } from '../../services/quoteTypes';

const ORG_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ORG = '99999999-9999-4999-8999-999999999999';
const VERSION_ID = '22222222-2222-4222-8222-222222222222';
const TEMPLATE_ID = '44444444-4444-4444-8444-444444444444';
const URL = '/agreement-requests/record-signed';

const RENDER_DATA = {
  templateId: TEMPLATE_ID,
  templateVersionId: VERSION_ID,
  sourceType: 'authored',
  bodyHtml: '<p>x</p>',
  fileData: null,
  versionSha256: 'vsha',
  declaredVariables: [],
  templateName: 'MSA',
  versionNumber: 1,
};

const REQUEST_ROW = {
  id: 'req-1',
  orgId: ORG_ID,
  status: 'signed',
  label: 'MSA',
  acceptTokenJti: 'jti-secret',
  acceptTokenIssuedAt: new Date(),
  acceptTokenExpiresAt: new Date(),
  acceptTokenKid: 'kid-1',
  publicResponseJti: 'pjti',
  publicResponseConsumedAt: null,
  publicResponseOutcome: null,
};

function fields(over: Record<string, string | undefined> = {}): Record<string, string> {
  const base: Record<string, string | undefined> = {
    orgId: ORG_ID,
    templateVersionId: VERSION_ID,
    variableValues: JSON.stringify({ 'custom.po': 'PO-1' }),
    signerName: 'Jane Doe',
    signerEmail: 'jane@example.com',
    signedAt: '2026-10-01T15:00:00.000Z',
    method: 'email',
    reference: 'email from Jane',
    ...over,
  };
  return Object.fromEntries(Object.entries(base).filter(([, v]) => v !== undefined)) as Record<string, string>;
}

function multipart(f: Record<string, string>, file?: Blob | string, filename = 'scan.png'): RequestInit {
  const fd = new FormData();
  for (const [k, v] of Object.entries(f)) fd.append(k, v);
  if (typeof file === 'string') fd.append('file', file);
  else if (file) fd.append('file', file, filename);
  return { method: 'POST', body: fd };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

beforeEach(() => {
  vi.clearAllMocks();
  h.trace.length = 0;
  h.guards.length = 0;
  h.inAuth = false;
  h.inSystem = false;
  h.withAuthDbAccessContext.mockImplementation(async (_auth: unknown, fn: () => Promise<unknown>) => {
    h.inAuth = true;
    try { return await fn(); } finally { h.inAuth = false; }
  });
  h.withSystemDbAccessContext.mockImplementation(async (fn: () => Promise<unknown>) => {
    h.inSystem = true;
    try { return await fn(); } finally { h.inSystem = false; }
  });
  const ctx = () => (h.inSystem ? 'system' : h.inAuth ? 'auth' : 'none');
  h.loadOrgOwnerPartnerId.mockImplementation(async () => { h.trace.push(`org:${ctx()}`); return 'p1'; });
  h.loadTemplateVersionRenderData.mockImplementation(async () => { h.trace.push(`load:${ctx()}`); return RENDER_DATA; });
  h.assertTemplateVersionUsable.mockImplementation(async () => { h.trace.push(`assert:${ctx()}`); });
  h.recordSignedAgreement.mockImplementation(async () => {
    h.trace.push(`record:${ctx()}`);
    return { request: REQUEST_ROW, signedAgreementId: 'sa-1', contentSha256: 'c'.repeat(64) };
  });
});

describe('POST /contracts/agreement-requests/record-signed', () => {
  it('is guarded by partner/organization/system scopes and agreements:write (W2 moves it to agreements:send)', async () => {
    const res = await contractRoutes.request(URL, multipart(fields()));
    expect(res.status).toBe(201);
    expect(h.guards).toEqual(['scope:partner,organization,system', 'perm:agreements:write']);
  });

  it('JSON body instead of multipart → 400 INVALID_MULTIPART, service not called', async () => {
    const res = await contractRoutes.request(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields()),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('INVALID_MULTIPART');
    expect(h.recordSignedAgreement).not.toHaveBeenCalled();
  });

  it('reference missing → 400 VALIDATION_ERROR', async () => {
    const res = await contractRoutes.request(URL, multipart(fields({ reference: undefined })));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_ERROR');
    expect(h.recordSignedAgreement).not.toHaveBeenCalled();
  });

  it('variableValues that is not JSON → 400 VALIDATION_ERROR (never a 500)', async () => {
    const res = await contractRoutes.request(URL, multipart(fields({ variableValues: '{nope' })));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_ERROR');
  });

  it('orgId outside the caller\'s orgs → 404 ORG_NOT_FOUND (never 403), nothing read', async () => {
    const res = await contractRoutes.request(URL, multipart(fields({ orgId: OTHER_ORG })));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('ORG_NOT_FOUND');
    expect(h.loadTemplateVersionRenderData).not.toHaveBeenCalled();
    expect(h.recordSignedAgreement).not.toHaveBeenCalled();
  });

  it('a non-File `file` field → 400 INVALID_FILE', async () => {
    const res = await contractRoutes.request(URL, multipart(fields(), 'not-a-file'));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('INVALID_FILE');
    expect(h.recordSignedAgreement).not.toHaveBeenCalled();
  });

  it('reads org + template in the caller\'s auth context and records under system scope', async () => {
    const res = await contractRoutes.request(URL, multipart(fields()));
    expect(res.status).toBe(201);
    expect(h.trace).toEqual(['org:auth', 'load:auth', 'assert:auth', 'record:system']);
    // The wrapper received the request's own auth.
    expect(h.withAuthDbAccessContext.mock.calls[0]![0]).toMatchObject({ user: { id: 'u1' }, partnerId: 'p1' });
    expect(h.runOutsideDbContext).toHaveBeenCalled();
    expect(h.loadTemplateVersionRenderData).toHaveBeenCalledWith(VERSION_ID, { includeFileData: true });
    expect(h.assertTemplateVersionUsable).toHaveBeenCalledWith(
      { templateId: TEMPLATE_ID, templateVersionId: VERSION_ID },
      { orgId: ORG_ID, partnerId: 'p1' },
    );
  });

  it('VERSION_NOT_FOUND from the loader → 404, service not called', async () => {
    h.loadTemplateVersionRenderData.mockRejectedValueOnce(new ContractTemplateServiceError('nope', 404, 'VERSION_NOT_FOUND'));
    const res = await contractRoutes.request(URL, multipart(fields()));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('VERSION_NOT_FOUND');
    expect(h.recordSignedAgreement).not.toHaveBeenCalled();
  });

  it('archived template from the guard → 422 TEMPLATE_ARCHIVED, service not called', async () => {
    h.assertTemplateVersionUsable.mockRejectedValueOnce(new ContractTemplateServiceError('archived', 422, 'TEMPLATE_ARCHIVED'));
    const res = await contractRoutes.request(URL, multipart(fields()));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('TEMPLATE_ARCHIVED');
    expect(h.recordSignedAgreement).not.toHaveBeenCalled();
  });

  it('happy multipart with a file → 201, service gets renderData + the bytes, audit written, tokens stripped', async () => {
    const res = await contractRoutes.request(
      URL,
      { ...multipart(fields({ method: 'signed_document', reference: 'DocuSign 4F2' }), new Blob([PNG], { type: 'image/png' })), headers: { 'user-agent': 'UA/1.0' } },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data).toMatchObject({ signedAgreementId: 'sa-1', contentSha256: 'c'.repeat(64), request: { id: 'req-1', status: 'signed' } });
    for (const k of ['acceptTokenJti', 'acceptTokenIssuedAt', 'acceptTokenExpiresAt', 'acceptTokenKid', 'publicResponseJti', 'publicResponseConsumedAt', 'publicResponseOutcome']) {
      expect(body.data.request).not.toHaveProperty(k);
    }
    // A file is the record: the template's own bytes are not needed.
    expect(h.loadTemplateVersionRenderData).toHaveBeenCalledWith(VERSION_ID, { includeFileData: false });

    const p = h.recordSignedAgreement.mock.calls[0]![0];
    expect(p.renderData).toBe(RENDER_DATA);
    expect(p.file.buffer.length).toBe(PNG.length);
    expect(Buffer.from(p.file.buffer).equals(Buffer.from(PNG))).toBe(true);
    expect(p.file.filename).toBe('scan.png');
    expect(p.callerPartnerId).toBe('p1');
    expect(p.actorUserId).toBe('u1');
    expect(p.actorUserAgent).toBe('UA/1.0');
    expect(p.input).toMatchObject({ orgId: ORG_ID, method: 'signed_document', reference: 'DocuSign 4F2', variableValues: { 'custom.po': 'PO-1' } });
    expect(p.input.signedAt).toBeInstanceOf(Date);
    expect(p.now).toBeInstanceOf(Date);

    expect(h.writeRouteAudit).toHaveBeenCalledTimes(1);
    expect(h.writeRouteAudit.mock.calls[0]![1]).toMatchObject({
      orgId: ORG_ID,
      action: 'billing.agreement.recorded_on_behalf',
      resourceType: 'agreement_request',
      resourceId: 'req-1',
      details: { method: 'signed_document', reference: 'DocuSign 4F2', signedAgreementId: 'sa-1', external: true, signerName: 'Jane Doe' },
    });
  });

  it('service AGREEMENT_VARIABLES_UNRESOLVED → 422 with that code and message, no audit', async () => {
    h.recordSignedAgreement.mockRejectedValueOnce(
      new AgreementRequestServiceError('Agreement variables unresolved: custom.po', 422, 'AGREEMENT_VARIABLES_UNRESOLVED'),
    );
    const res = await contractRoutes.request(URL, multipart(fields()));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'Agreement variables unresolved: custom.po', code: 'AGREEMENT_VARIABLES_UNRESOLVED' });
    expect(h.writeRouteAudit).not.toHaveBeenCalled();
  });

  it('freeze-raised QuoteServiceError (422) maps to its status/code', async () => {
    h.recordSignedAgreement.mockRejectedValueOnce(new QuoteServiceError('Agreement variables unresolved: x', 422, 'AGREEMENT_VARIABLES_UNRESOLVED'));
    const res = await contractRoutes.request(URL, multipart(fields()));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('AGREEMENT_VARIABLES_UNRESOLVED');
  });

  it('service SIGNED_AT_IN_FUTURE / CONTRACT_NOT_FOUND / 415 / 413 map through', async () => {
    for (const [status, code] of [[400, 'SIGNED_AT_IN_FUTURE'], [404, 'CONTRACT_NOT_FOUND'], [415, 'UNSUPPORTED_FILE_TYPE'], [413, 'FILE_TOO_LARGE']] as const) {
      h.recordSignedAgreement.mockRejectedValueOnce(new AgreementRequestServiceError('x', status, code));
      const res = await contractRoutes.request(URL, multipart(fields()));
      expect(res.status).toBe(status);
      expect((await res.json()).code).toBe(code);
    }
  });

  it('a body over the multipart limit → 413 FILE_TOO_LARGE before parsing', async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 128 * 1024);
    const res = await contractRoutes.request(URL, multipart(fields(), new Blob([big], { type: 'image/png' })));
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe('FILE_TOO_LARGE');
    expect(h.recordSignedAgreement).not.toHaveBeenCalled();
  });

  it('an unexpected error is not swallowed into a mapped 4xx', async () => {
    h.recordSignedAgreement.mockRejectedValueOnce(new Error('boom'));
    const res = await contractRoutes.request(URL, multipart(fields()));
    expect(res.status).toBe(500);
  });
});
