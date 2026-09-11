import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { readFileSync } from 'node:fs';

const mocks = vi.hoisted(() => ({
  documentsForOrg: vi.fn(),
  portalVisibleDocument: vi.fn(),
  streamDocument: vi.fn(),
}));

const routerState = vi.hoisted(() => ({
  authenticated: true,
  brandingRows: [] as unknown[],
}));

vi.mock('../../services/portal/documentsReadModel', () => ({
  documentsForOrg: mocks.documentsForOrg,
  portalVisibleDocument: mocks.portalVisibleDocument,
}));
vi.mock('../../services/orgDocumentService', async () => {
  const actual = await vi.importActual<typeof import('../../services/orgDocumentService')>(
    '../../services/orgDocumentService');
  return { ...actual, streamDocument: mocks.streamDocument };
});
vi.mock('./auth', async () => {
  const { Hono: MockHono } = await import('hono');
  return {
    authRoutes: new MockHono(),
    portalAuthMiddleware: async (c: {
      json: (body: unknown, status: 401) => Response;
      set: (key: string, value: unknown) => void;
    }, next: () => Promise<void>) => {
      if (!routerState.authenticated) {
        return c.json({ error: 'Authentication required' }, 401);
      }
      c.set('portalAuth', AUTH);
      await next();
    },
  };
});
vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(routerState.brandingRows)),
        })),
      })),
    })),
  },
  runOutsideDbContext: <T,>(fn: () => T): T => fn(),
  withDbAccessContext: <T,>(_context: unknown, fn: () => T): T => fn(),
  withSystemDbAccessContext: <T,>(fn: () => T): T => fn(),
}));

// DeliverableServiceError is a real class, imported rather than mocked so the
// route's `instanceof` catch branch is exercised for real.
import { DeliverableServiceError } from '../../services/serviceDeliverableService';
import { portalDocumentRoutes } from './documents';
import { portalRoutes } from './index';

const ORG_ID = '11111111-1111-4111-8111-111111111111';

const AUTH = {
  user: {
    id: 'portal-user-1',
    orgId: ORG_ID,
    email: 'customer@example.com',
    name: 'Customer',
    contactId: null,
    receiveNotifications: true,
    status: 'active',
  },
  token: 'token',
  authMethod: 'bearer' as const,
  timezone: 'America/Denver',
};

function isolatedApp() {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('portalAuth', AUTH);
    await next();
  });
  hono.route('/', portalDocumentRoutes);
  return hono;
}

beforeEach(() => {
  vi.clearAllMocks();
  routerState.authenticated = true;
  routerState.brandingRows = [];
});

describe('GET /documents', () => {
  it('sends the org listing with private caching and a weak ETag', async () => {
    mocks.documentsForOrg.mockResolvedValue({ asOf: '2026-10-15T12:00:00.000Z', timezone: 'America/Denver', groups: [] });
    const response = await isolatedApp().request('/documents');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('private, max-age=30');
    expect(response.headers.get('etag')).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
    expect(mocks.documentsForOrg).toHaveBeenCalledWith(
      ORG_ID, expect.objectContaining({ timezone: 'America/Denver' }));
  });

  it('returns 304 on a matching ETag', async () => {
    mocks.documentsForOrg.mockResolvedValue({ asOf: 'x', timezone: 'UTC', groups: [] });
    const first = await isolatedApp().request('/documents');
    const etag = first.headers.get('etag')!;
    expect((await isolatedApp().request('/documents', { headers: { 'If-None-Match': etag } })).status).toBe(304);
  });
});

describe('GET /documents/:id/content', () => {
  const ID = '11111111-1111-4111-8111-111111111111';

  const handle = (sha: string) => ({
    id: ID, contentType: 'application/pdf', byteSize: 3,
    sha256: sha.repeat(64), originalFilename: 'runbook.pdf',
  });

  it("404s a document that is not this org's portal-visible row", async () => {
    mocks.portalVisibleDocument.mockResolvedValue(null);
    const response = await isolatedApp().request(`/documents/${ID}/content`);
    expect(response.status).toBe(404);
    // The visibility predicate runs BEFORE W03's service, which does not know
    // about portal_visible at all.
    expect(mocks.streamDocument).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid document id before touching the read model', async () => {
    const response = await isolatedApp().request('/documents/not-a-uuid/content');
    expect(response.status).toBe(400);
    expect(mocks.portalVisibleDocument).not.toHaveBeenCalled();
  });

  it('streams bytes with a sha256 ETag, a safe disposition and nosniff', async () => {
    mocks.portalVisibleDocument.mockResolvedValue(handle('a'));
    mocks.streamDocument.mockResolvedValue({
      view: {}, contentType: 'application/pdf', originalFilename: 'runbook.pdf',
      sha256: 'a'.repeat(64), body: Buffer.from('abc'), contentLength: 3,
    });
    const response = await isolatedApp().request(`/documents/${ID}/content`);
    expect(response.status).toBe(200);
    expect(mocks.streamDocument).toHaveBeenCalledWith(
      ORG_ID, ID,
      { userId: null, partnerId: null, accessibleOrgIds: [ORG_ID] },
    );
    expect(response.headers.get('etag')).toBe(`"${'a'.repeat(64)}"`);
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(response.headers.get('content-disposition')).toContain('runbook.pdf');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('private, max-age=300');
    expect(await response.text()).toBe('abc');
  });

  it('304s a matching sha256 ETag without opening the bytes', async () => {
    mocks.portalVisibleDocument.mockResolvedValue(handle('b'));
    const response = await isolatedApp().request(`/documents/${ID}/content`,
      { headers: { 'If-None-Match': `"${'b'.repeat(64)}"` } });
    expect(response.status).toBe(304);
    expect(mocks.streamDocument).not.toHaveBeenCalled();
  });

  it('answers a STORAGE_UNAVAILABLE fault with a retryable 503', async () => {
    mocks.portalVisibleDocument.mockResolvedValue(handle('c'));
    mocks.streamDocument.mockRejectedValue(
      new DeliverableServiceError('Document storage is unavailable', 503, 'STORAGE_UNAVAILABLE'));
    const response = await isolatedApp().request(`/documents/${ID}/content`);
    expect(response.status).toBe(503);
  });

  it('does NOT dress an ordinary fault up as a retryable storage outage', async () => {
    // streamDocument also runs two DB reads and an access check. A pool error
    // or a programming bug there must stay a 500 — telling the customer to
    // retry, and hiding the fault from 500-rate monitoring, is worse than the
    // error itself.
    mocks.portalVisibleDocument.mockResolvedValue(handle('c'));
    mocks.streamDocument.mockRejectedValue(new Error('connection terminated'));
    const app = isolatedApp();
    app.onError((_err, c) => c.json({ error: 'Internal' }, 500));
    const response = await app.request(`/documents/${ID}/content`);
    expect(response.status).toBe(500);
  });

  it('logs a metadata row whose bytes are missing instead of a silent 404', async () => {
    mocks.portalVisibleDocument.mockResolvedValue(handle('e'));
    mocks.streamDocument.mockResolvedValue({
      view: {}, contentType: 'application/pdf', originalFilename: 'gone.pdf',
      sha256: 'e'.repeat(64), body: null, contentLength: null,
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await isolatedApp().request(`/documents/${ID}/content`);
    expect(response.status).toBe(404);
    expect(logged).toHaveBeenCalledWith(
      '[portal-documents] object missing for row',
      expect.objectContaining({ documentId: ID }),
    );
    logged.mockRestore();
  });

  it('turns a 404 from the W03 service into a bare 404, not a 500', async () => {
    // A row deleted between the visibility check and the stream.
    mocks.portalVisibleDocument.mockResolvedValue(handle('d'));
    mocks.streamDocument.mockRejectedValue(
      new DeliverableServiceError('Not found', 404, 'NOT_FOUND'));
    const response = await isolatedApp().request(`/documents/${ID}/content`);
    expect(response.status).toBe(404);
  });

  it('never hands back a presigned url', async () => {
    // Spec §8/§11: bytes stream through the API under RLS.
    const source = readFileSync(new URL('./documents.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/presign|getSignedUrl/i);
  });
});

describe('GET /documents through the real portal router', () => {
  it('403s the listing when enable_documents is off', async () => {
    routerState.brandingRows = [{ enableDocuments: false, enableService: true }];
    const response = await portalRoutes.request('/documents', { headers: { Authorization: 'Bearer token' } });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'PORTAL_DOCUMENTS_DISABLED' });
  });

  it('still serves evidence bytes when only enable_service is on', async () => {
    // Spec §8: document evidence is published under enable_service regardless
    // of enable_documents, so the link the Service page renders must resolve.
    routerState.brandingRows = [{ enableDocuments: false, enableService: true }];
    mocks.portalVisibleDocument.mockResolvedValue(null);   // 404, not 403
    const response = await portalRoutes.request(
      `/documents/${ORG_ID}/content`,
      { headers: { Authorization: 'Bearer token' } });
    expect(response.status).toBe(404);
  });

  it('403s the bytes when both flags are off', async () => {
    routerState.brandingRows = [{ enableDocuments: false, enableService: false }];
    const response = await portalRoutes.request(
      `/documents/${ORG_ID}/content`,
      { headers: { Authorization: 'Bearer token' } });
    expect(response.status).toBe(403);
  });

  it('401s the bytes without a portal session', async () => {
    routerState.authenticated = false;
    const response = await portalRoutes.request(`/documents/${ORG_ID}/content`);
    expect(response.status).toBe(401);
  });
});
