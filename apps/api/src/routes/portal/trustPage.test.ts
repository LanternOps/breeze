import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Trust Center W3d: customer org-admin edits of the org's trust page draft.
// The router carries the editor gate; services are mocked, the gate middleware,
// CSRF check and the strict patch schema stay real.

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const PAGE_ID = '33333333-3333-4333-8333-333333333333';
const PARTNER_ID = '44444444-4444-4444-8444-444444444444';

const m = vi.hoisted(() => ({
  decide: vi.fn(),
  apply: vi.fn(),
  preview: vi.fn(),
  schedule: vi.fn(),
  resolveSettings: vi.fn(),
  audit: vi.fn(),
  pageRows: [] as unknown[],
  slugRows: [] as unknown[],
  txSets: [] as Record<string, unknown>[],
  txLockRows: [] as unknown[],
  txReturning: [] as unknown[],
}));

vi.mock('../../services/portal/trustPageEditor', () => ({
  decidePortalTrustPageEditor: m.decide,
  isPortalTrustPageEditor: vi.fn(async (u: unknown) => (await m.decide(u)).allowed),
  PORTAL_TRUST_EDITING_DISABLED: 'PORTAL_TRUST_EDITING_DISABLED',
  PORTAL_TRUST_EDITOR_REQUIRED: 'PORTAL_TRUST_EDITOR_REQUIRED',
}));
vi.mock('../../services/trustPage/draftPatch', async (orig) => ({
  ...(await orig<typeof import('../../services/trustPage/draftPatch')>()),
  applyTrustPageDraftPatch: m.apply,
}));
vi.mock('../../services/trustPage/previewToken', () => ({
  createTrustPreviewToken: m.preview,
  TRUST_PREVIEW_TTL_SECONDS: 900,
}));
vi.mock('../../services/trustPage/servingSet', () => ({ scheduleServingRefreshForPartner: m.schedule }));
vi.mock('../../services/trustPage/publication', async (orig) => ({
  ...(await orig<typeof import('../../services/trustPage/publication')>()),
  resolveTrustPageSettings: m.resolveSettings,
}));

/** Thenable query-builder stand-in: every builder method returns itself; awaiting it yields `result()`. */
function chain(result: () => unknown): unknown {
  const proxy: unknown = new Proxy(function () { /* target */ }, {
    get(_t, prop) {
      if (prop === 'then') return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej);
      return () => proxy;
    },
  });
  return proxy;
}
vi.mock('../../db', () => ({
  db: {
    select: (columns?: Record<string, unknown>) => chain(() => (columns && 'partnerSlug' in columns ? m.slugRows : m.pageRows)),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      select: () => chain(() => m.txLockRows),
      update: () => ({ set: (v: Record<string, unknown>) => { m.txSets.push(v); return chain(() => m.txReturning); } }),
    }),
  },
  withDbAccessContext: (_ctx: unknown, fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: <T,>(fn: () => T): T => fn(),
}));

vi.mock('./helpers', async (orig) => ({
  ...(await orig<typeof import('./helpers')>()),
  writePortalAudit: m.audit,
}));

import { portalTrustPageRoutes } from './trustPage';

const PORTAL_USER = { id: 'pu-1', orgId: ORG_ID, email: 'admin@example.com', name: 'Admin', contactId: 'contact-1', receiveNotifications: true, status: 'active' };
const bearer = (over: Record<string, unknown> = {}) => ({
  'x-test-portal-auth': JSON.stringify({ user: PORTAL_USER, token: 't', authMethod: 'bearer', timezone: 'UTC', partnerId: PARTNER_ID, ...over }),
});
const cookie = () => bearer({ authMethod: 'cookie' });

const PAGE = {
  id: PAGE_ID, orgId: ORG_ID, partnerId: PARTNER_ID, isPartnerHome: false,
  publishedAt: new Date('2026-10-01T00:00:00Z'), publicationRevision: 4,
  securityContactEmail: 'sec@example.com', websiteUrl: 'https://example.com', hiddenControlIds: null,
  showPercentages: null, showDeviceCount: true, showManagedBy: true, searchIndexable: false,
  introHtml: '<p>hi</p>', publicationAuthorizedBy: 'Jane Customer', publicationAuthorizedAt: new Date(),
  publicationAuthorizedByUserId: 'msp-user-1', publishedConfig: { secret: true }, createdByUserId: 'msp-user-1', updatedByUserId: 'msp-user-2',
};

// Portal auth is mounted in routes/portal/index.ts (trustPage.gate.test.ts covers that wiring); here a
// test header stands in for a validated session, and without it no portalAuth is set at all.
function app() {
  const a = new Hono();
  a.use('/portal/trust-page/*', async (c, next) => {
    const raw = c.req.header('x-test-portal-auth');
    if (raw) c.set('portalAuth', JSON.parse(raw));
    await next();
  });
  a.route('/portal/trust-page', portalTrustPageRoutes);
  return a;
}
const json = (body: unknown) => ({ 'content-type': 'application/json', body: JSON.stringify(body) });
const req = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  app().request(`/portal/trust-page${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

beforeEach(() => {
  vi.clearAllMocks();
  m.decide.mockResolvedValue({ allowed: true, contactId: 'contact-1' });
  m.pageRows = [PAGE];
  m.slugRows = [{ orgSlug: 'acme', partnerSlug: 'msp' }];
  m.txSets = [];
  m.txLockRows = [{ rev: 4, isPartnerHome: false, partnerId: PARTNER_ID, publishedAt: PAGE.publishedAt }];
  m.txReturning = [{ ...PAGE, publishedAt: null, publicationRevision: 5 }];
  m.resolveSettings.mockResolvedValue({
    effective: { values: { showPercentages: false, showDeviceCount: true, hiddenControlIds: [] }, sources: {} },
    template: null,
  });
  m.preview.mockResolvedValue('preview-token');
  m.apply.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...PAGE, ...patch, publicationRevision: 5 }));
});

describe('portal trust page: auth and gate', () => {
  it('GET without a session → 401', async () => {
    const res = await req('GET', '', {});
    expect(res.status).toBe(401);
    expect(m.decide).not.toHaveBeenCalled();
  });

  it('flag off → 403 PORTAL_TRUST_EDITING_DISABLED', async () => {
    m.decide.mockResolvedValue({ allowed: false, code: 'PORTAL_TRUST_EDITING_DISABLED' });
    const res = await req('GET', '', bearer());
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('PORTAL_TRUST_EDITING_DISABLED');
  });

  it('non-admin → 403 PORTAL_TRUST_EDITOR_REQUIRED, on every route', async () => {
    m.decide.mockResolvedValue({ allowed: false, code: 'PORTAL_TRUST_EDITOR_REQUIRED' });
    for (const [method, path, body] of [['GET', ''], ['PUT', '', { expectedRevision: 4, websiteUrl: null }], ['POST', '/preview-token', {}], ['POST', '/unpublish', { confirm: true }]] as const) {
      const res = await req(method, path, bearer(), body);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('PORTAL_TRUST_EDITOR_REQUIRED');
    }
    expect(m.apply).not.toHaveBeenCalled();
    expect(m.preview).not.toHaveBeenCalled();
    expect(m.txSets).toHaveLength(0);
  });

  it('the gate is checked with the session user on every request', async () => {
    await req('GET', '', bearer());
    await req('GET', '', bearer());
    expect(m.decide).toHaveBeenCalledTimes(2);
    expect(m.decide).toHaveBeenCalledWith(expect.objectContaining({ id: 'pu-1', orgId: ORG_ID }));
  });

  it('every response is no-store', async () => {
    const res = await req('GET', '', bearer());
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('GET /portal/trust-page', () => {
  it('no trust page → 200 { page: null } (the portal never creates the row)', async () => {
    m.pageRows = [];
    const res = await req('GET', '', bearer());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { page: null } });
  });

  it('partner-home page → 403 PORTAL_TRUST_EDITOR_REQUIRED', async () => {
    m.pageRows = [{ ...PAGE, isPartnerHome: true }];
    const res = await req('GET', '', bearer());
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('PORTAL_TRUST_EDITOR_REQUIRED');
  });

  it('returns the five fields, publishedAt, publicationRevision, publicPath — and never publishedConfig, authorization or user ids', async () => {
    const res = await req('GET', '', bearer());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.page).toEqual({
      securityContactEmail: 'sec@example.com',
      websiteUrl: 'https://example.com',
      hiddenControlIds: [],
      showPercentages: false,
      showDeviceCount: true,
      publishedAt: PAGE.publishedAt.toISOString(),
      publicationRevision: 4,
      publicPath: '/trust/msp/acme',
    });
    const raw = JSON.stringify(body);
    for (const leak of ['publishedConfig', 'secret', 'publicationAuthorized', 'Jane Customer', 'msp-user-1', 'msp-user-2', 'introHtml', PAGE_ID, PARTNER_ID]) {
      expect(raw).not.toContain(leak);
    }
  });
});

describe('PUT /portal/trust-page', () => {
  it('applies the patch and writes portal audit portal.trust_page.update with the portal user as actor', async () => {
    const res = await req('PUT', '', bearer(), { expectedRevision: 4, securityContactEmail: 'new@example.com' });
    expect(res.status).toBe(200);
    expect(m.apply).toHaveBeenCalledWith(PAGE_ID, { expectedRevision: 4, securityContactEmail: 'new@example.com' }, { kind: 'portal_user', id: 'pu-1' });
    const body = await res.json();
    expect(body.data.page).toMatchObject({ securityContactEmail: 'new@example.com', publicationRevision: 5 });
    expect(JSON.stringify(body)).not.toContain('msp-user');
    expect(m.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: ORG_ID, actorType: 'user', actorId: 'pu-1', actorEmail: 'admin@example.com',
      action: 'portal.trust_page.update', resourceType: 'trust_page', resourceId: PAGE_ID,
      details: { fields: ['securityContactEmail'], publicationRevision: 5 },
    }));
  });

  it('rejects a field outside the portal subset (400) without writing', async () => {
    const res = await req('PUT', '', bearer(), { expectedRevision: 4, introHtml: '<p>x</p>' });
    expect(res.status).toBe(400);
    expect(m.apply).not.toHaveBeenCalled();
  });

  it('a stale revision surfaces as 409 REVISION_MISMATCH', async () => {
    const { TrustPageError } = await import('../../services/trustPage/publication');
    m.apply.mockRejectedValue(new TrustPageError('changed', 409, 'REVISION_MISMATCH'));
    const res = await req('PUT', '', bearer(), { expectedRevision: 3, websiteUrl: null });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('REVISION_MISMATCH');
    expect(m.audit).not.toHaveBeenCalled();
  });

  it('no trust page → 404 NOT_FOUND', async () => {
    m.pageRows = [];
    const res = await req('PUT', '', bearer(), { expectedRevision: 0, websiteUrl: null });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found', code: 'NOT_FOUND' });
  });

  it('PUT without the CSRF header (cookie auth) → 403', async () => {
    const res = await req('PUT', '', cookie(), { expectedRevision: 4, websiteUrl: null });
    expect(res.status).toBe(403);
    expect(m.apply).not.toHaveBeenCalled();
  });
});

describe('POST /portal/trust-page/preview-token', () => {
  it('returns a W1 preview token for this page only', async () => {
    const res = await req('POST', '/preview-token', bearer(), {});
    expect(res.status).toBe(200);
    expect(m.preview).toHaveBeenCalledWith({ pageId: PAGE_ID, orgId: ORG_ID });
    expect((await res.json()).data).toEqual({ token: 'preview-token', expiresInSeconds: 900, previewPath: '/trust/preview/preview-token' });
  });

  it('POST without the CSRF header (cookie auth) → 403', async () => {
    const res = await req('POST', '/preview-token', cookie(), {});
    expect(res.status).toBe(403);
    expect(m.preview).not.toHaveBeenCalled();
  });
});

describe('POST /portal/trust-page/unpublish', () => {
  it('requires { confirm: true }', async () => {
    for (const body of [{}, { confirm: false }, { confirm: 'yes' }]) {
      const res = await req('POST', '/unpublish', bearer(), body);
      expect(res.status).toBe(400);
    }
    expect(m.txSets).toHaveLength(0);
  });

  it('clears published_at, bumps the revision, removes the serving member after commit, audits portal.trust_page.unpublish', async () => {
    const res = await req('POST', '/unpublish', bearer(), { confirm: true });
    expect(res.status).toBe(200);
    expect(m.txSets).toHaveLength(1);
    expect(m.txSets[0]).toMatchObject({ publishedAt: null });
    expect(m.txSets[0]!.publicationRevision).toBeDefined();
    expect(m.txSets[0]).not.toHaveProperty('updatedByUserId');
    expect(m.schedule).toHaveBeenCalledWith(PARTNER_ID, 'trust_page.portal_unpublish');
    expect(m.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'portal.trust_page.unpublish', actorId: 'pu-1', resourceId: PAGE_ID, details: { publicationRevision: 5 },
    }));
    expect((await res.json()).data.page).toMatchObject({ publishedAt: null, publicationRevision: 5 });
  });

  it('an unpublished page is a no-op 200 (no write, no audit)', async () => {
    m.txLockRows = [{ rev: 4, isPartnerHome: false, partnerId: PARTNER_ID, publishedAt: null }];
    const res = await req('POST', '/unpublish', bearer(), { confirm: true });
    expect(res.status).toBe(200);
    expect(m.txSets).toHaveLength(0);
    expect(m.schedule).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it('partner-home page → 403 and nothing is written', async () => {
    m.pageRows = [{ ...PAGE, isPartnerHome: true }];
    const res = await req('POST', '/unpublish', bearer(), { confirm: true });
    expect(res.status).toBe(403);
    expect(m.txSets).toHaveLength(0);
  });
});
