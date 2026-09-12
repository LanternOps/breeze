import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    if (!c.req.header('authorization')) return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', { user: { id: 'u1' }, partnerId: 'p1', accessibleOrgIds: ['org1'], scope: 'partner' });
    return next();
  },
  requireScope: () => async (_c: any, next: any) => next(),
  // x-allow carries the comma-separated "resource:action" grants the caller holds.
  requirePermission: (resource: string, action: string) => async (c: any, next: any) =>
    (c.req.header('x-allow') ?? '').split(',').includes(`${resource}:${action}`) ? next() : c.json({ error: 'Forbidden' }, 403),
}));

vi.mock('../middleware/userRateLimit', () => ({
  userRateLimit: () => async (_c: any, next: any) => next(),
}));

const auditMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../services/auditService', () => ({ createAuditLogAsync: auditMock }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

const svc = vi.hoisted(() => ({
  listDocuments: vi.fn(),
  getDocument: vi.fn(),
  uploadDocument: vi.fn(),
  replaceDocument: vi.fn(),
  updateDocument: vi.fn(),
  deleteDocument: vi.fn(),
  streamDocument: vi.fn(),
}));
vi.mock('../services/orgDocumentService', () => ({
  ...svc,
  documentEtag: (sha: string) => `"${sha}"`,
}));

import { authMiddleware } from '../middleware/auth';
import { orgDocumentRoutes } from './orgDocuments';

const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DOC = '11111111-1111-4111-8111-111111111111';
const READ = { authorization: 'Bearer t', 'x-allow': 'documents:read' };
const WRITE = { authorization: 'Bearer t', 'x-allow': 'documents:read,documents:write' };
const ACTOR = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
const pdf = new Uint8Array(Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(32, 1)]));

const app = new Hono();
app.use('*', authMiddleware);
app.route('/', orgDocumentRoutes);

const svcError = (status: number, code: string) => Object.assign(new Error(code), { status, code });
const form = (fields: Record<string, string> = {}, withFile = true) => {
  const f = new FormData();
  if (withFile) f.append('file', new File([pdf], 'runbook.pdf', { type: 'application/pdf' }));
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
};
const view = { id: DOC, orgId: ORG, title: 'Runbook', sha256: 'a'.repeat(64) };

describe('org document routes (service deliverables W03)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    svc.listDocuments.mockResolvedValue([view]);
    svc.uploadDocument.mockResolvedValue(view);
    svc.replaceDocument.mockResolvedValue({ ...view, id: 'd2' });
    svc.updateDocument.mockResolvedValue(view);
    svc.deleteDocument.mockResolvedValue(undefined);
  });

  it('401 without auth', async () => {
    expect((await app.request(`/${ORG}/documents`)).status).toBe(401);
  });

  it('403 without documents:read', async () => {
    const res = await app.request(`/${ORG}/documents`, { headers: { authorization: 'Bearer t', 'x-allow': 'contracts:read' } });
    expect(res.status).toBe(403);
    expect(svc.listDocuments).not.toHaveBeenCalled();
  });

  it('403 on a mutation with documents:read only', async () => {
    const res = await app.request(`/${ORG}/documents/${DOC}`, { method: 'DELETE', headers: READ });
    expect(res.status).toBe(403);
    expect(svc.deleteDocument).not.toHaveBeenCalled();
  });

  it('404 — not 403 — for an org the caller cannot access', async () => {
    svc.listDocuments.mockRejectedValueOnce(svcError(404, 'NOT_FOUND'));
    const res = await app.request(`/${ORG}/documents`, { headers: READ });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('400 on a non-guid org id', async () => {
    expect((await app.request('/not-a-guid/documents', { headers: READ })).status).toBe(400);
  });

  it('200 { data: [...] } lists heads only by default and forwards filters + actor', async () => {
    const res = await app.request(`/${ORG}/documents?category=runbook`, { headers: READ });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [view] });
    expect(svc.listDocuments).toHaveBeenCalledWith(ORG, { category: 'runbook' }, ACTOR);
  });

  it('includeSuperseded=false is false, not truthy', async () => {
    await app.request(`/${ORG}/documents?includeSuperseded=false`, { headers: READ });
    expect(svc.listDocuments).toHaveBeenCalledWith(ORG, { includeSuperseded: false }, ACTOR);
  });

  it('upload → 201 with the file bytes and validated metadata; portalVisible defaults false', async () => {
    const res = await app.request(`/${ORG}/documents`, { method: 'POST', headers: WRITE, body: form({ title: 'Runbook', category: 'runbook' }) });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: view });
    const [orgId, input, actor] = svc.uploadDocument.mock.calls[0]!;
    expect(orgId).toBe(ORG);
    expect(actor).toEqual(ACTOR);
    expect(input).toMatchObject({ title: 'Runbook', category: 'runbook', portalVisible: false });
    expect(Buffer.isBuffer(input.file.buffer)).toBe(true);
    expect(input.file.buffer.length).toBe(pdf.length);
    expect(input.file.filename).toBe('runbook.pdf');
  });

  it('upload audit event omits the filename (customer PII)', async () => {
    await app.request(`/${ORG}/documents`, { method: 'POST', headers: WRITE, body: form({ title: 'Runbook' }) });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'organization.document.upload', orgId: ORG, resourceId: DOC }));
    expect(JSON.stringify(auditMock.mock.calls[0])).not.toContain('runbook.pdf');
  });

  it('400 INVALID_MULTIPART when the body has no file part', async () => {
    const res = await app.request(`/${ORG}/documents`, { method: 'POST', headers: WRITE, body: form({ title: 'x' }, false) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'INVALID_MULTIPART' });
    expect(svc.uploadDocument).not.toHaveBeenCalled();
  });

  it('400 INVALID_MULTIPART on two file parts', async () => {
    const f = form({ title: 'x' });
    f.append('file2', new File([pdf], 'b.pdf'));
    const res = await app.request(`/${ORG}/documents`, { method: 'POST', headers: WRITE, body: f });
    expect(res.status).toBe(400);
    expect(svc.uploadDocument).not.toHaveBeenCalled();
  });

  it('400 on invalid metadata (missing title)', async () => {
    const res = await app.request(`/${ORG}/documents`, { method: 'POST', headers: WRITE, body: form({}) });
    expect(res.status).toBe(400);
    expect(svc.uploadDocument).not.toHaveBeenCalled();
  });

  for (const [status, code] of [[413, 'FILE_TOO_LARGE'], [415, 'UNSUPPORTED_DOCUMENT_TYPE'], [503, 'STORAGE_UNAVAILABLE']] as const) {
    it(`${status} ${code} surfaces the service status verbatim`, async () => {
      svc.uploadDocument.mockRejectedValueOnce(svcError(status, code));
      const res = await app.request(`/${ORG}/documents`, { method: 'POST', headers: WRITE, body: form({ title: 'x' }) });
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({ code });
      expect(auditMock).not.toHaveBeenCalled();
    });
  }

  it('409 NOT_HEAD when replacing a document that already has a successor', async () => {
    svc.replaceDocument.mockRejectedValueOnce(svcError(409, 'NOT_HEAD'));
    const res = await app.request(`/${ORG}/documents/${DOC}/replace`, { method: 'POST', headers: WRITE, body: form() });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'NOT_HEAD' });
  });

  it('replace forwards ONLY the metadata the caller sent (omitted fields inherit)', async () => {
    const res = await app.request(`/${ORG}/documents/${DOC}/replace`, { method: 'POST', headers: WRITE, body: form({ title: 'v2' }) });
    expect(res.status).toBe(201);
    const [, id, input] = svc.replaceDocument.mock.calls[0]!;
    expect(id).toBe(DOC);
    expect(input.title).toBe('v2');
    expect(input).not.toHaveProperty('portalVisible');
    expect(input).not.toHaveProperty('category');
  });

  it('PATCH → 200 with a JSON body; rejects an empty patch', async () => {
    const ok = await app.request(`/${ORG}/documents/${DOC}`, {
      method: 'PATCH', headers: { ...WRITE, 'content-type': 'application/json' }, body: JSON.stringify({ portalVisible: true }),
    });
    expect(ok.status).toBe(200);
    expect(svc.updateDocument).toHaveBeenCalledWith(ORG, DOC, { portalVisible: true }, ACTOR);
    const bad = await app.request(`/${ORG}/documents/${DOC}`, {
      method: 'PATCH', headers: { ...WRITE, 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(bad.status).toBe(400);
  });

  it('204 on delete, with an audit event', async () => {
    const res = await app.request(`/${ORG}/documents/${DOC}`, { method: 'DELETE', headers: WRITE });
    expect(res.status).toBe(204);
    expect(svc.deleteDocument).toHaveBeenCalledWith(ORG, DOC, ACTOR);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'organization.document.delete', resourceId: DOC }));
  });

  describe('content', () => {
    const stream = (over: Record<string, unknown> = {}) => ({
      view, contentType: 'application/pdf', originalFilename: 'run"book\r\n.pdf', sha256: 'a'.repeat(64),
      notModified: false, body: Buffer.from('%PDF-1'), contentLength: 6, ...over,
    });

    it('sets Content-Type, ETag and Content-Disposition and never a Location/redirect', async () => {
      svc.streamDocument.mockResolvedValueOnce(stream());
      const res = await app.request(`/${ORG}/documents/${DOC}/content`, { headers: READ });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/pdf');
      expect(res.headers.get('etag')).toBe(`"${'a'.repeat(64)}"`);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('cache-control')).toBe('private, max-age=300');
      const cd = res.headers.get('content-disposition')!;
      expect(cd.startsWith('attachment;')).toBe(true);
      expect(cd).not.toMatch(/[\r\n]/);
      expect(res.headers.get('location')).toBeNull();
      expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('%PDF-1');
    });

    it('passes If-None-Match to the service and answers 304 with no body', async () => {
      svc.streamDocument.mockResolvedValueOnce(stream({ notModified: true, body: null, contentLength: null }));
      const etag = `"${'a'.repeat(64)}"`;
      const res = await app.request(`/${ORG}/documents/${DOC}/content`, { headers: { ...READ, 'if-none-match': etag } });
      expect(res.status).toBe(304);
      expect(svc.streamDocument).toHaveBeenCalledWith(ORG, DOC, ACTOR, { ifNoneMatch: etag });
    });

    it('a missing object is a 404, never a redirect', async () => {
      svc.streamDocument.mockResolvedValueOnce(stream({ body: null }));
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await app.request(`/${ORG}/documents/${DOC}/content`, { headers: READ });
      expect(res.status).toBe(404);
      err.mockRestore();
    });

    it('503 when storage is down', async () => {
      svc.streamDocument.mockRejectedValueOnce(svcError(503, 'STORAGE_UNAVAILABLE'));
      const res = await app.request(`/${ORG}/documents/${DOC}/content`, { headers: READ });
      expect(res.status).toBe(503);
    });
  });
});
