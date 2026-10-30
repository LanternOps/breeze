import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';

// Public agreement signing link (#9075 W2b; spec §3.2, §3.3, §5). The DB is a
// FIFO chain (only the GET's branding reads touch it directly); the resolver's
// single system read is resolveAgreementRequestLinkOrgGate, mocked per test.
const { dbResults } = vi.hoisted(() => ({ dbResults: [] as unknown[][] }));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit', 'innerJoin']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(dbResults.shift() ?? []).then(resolve);
  return {
    db: chain,
    getCurrentDbAccessContext: () => undefined,
    runOutsideDbContext: <T>(fn: () => T): T => fn(),
    withSystemDbAccessContext: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  };
});

vi.mock('../services/agreementAcceptToken', () => ({
  verifyAgreementAcceptToken: vi.fn(),
  isAgreementAcceptJtiRevoked: vi.fn(),
  revokeAgreementAcceptJti: vi.fn(),
}));
vi.mock('../services/orgMergeProvenance', () => ({ resolveMergedOrgIds: vi.fn() }));
vi.mock('../services/publicLinkOrgGate', async (importActual) => ({
  ...(await importActual<typeof import('../services/publicLinkOrgGate')>()),
  resolveAgreementRequestLinkOrgGate: vi.fn(),
}));
vi.mock('../services/contractTemplateRender', async (importActual) => ({
  ...(await importActual<typeof import('../services/contractTemplateRender')>()),
  loadTemplateVersionRenderData: vi.fn(),
}));
vi.mock('../services/agreementRequestAcceptService', () => ({
  acceptAgreementRequest: vi.fn(),
  declineAgreementRequest: vi.fn(),
  markAgreementRequestViewed: vi.fn(),
}));
vi.mock('../services/agreementEvents', () => ({ emitAgreementEvent: vi.fn() }));
vi.mock('../services/agreementOutcomeNotify', () => ({ notifyAgreementOutcome: vi.fn() }));
vi.mock('../services/agreementSignedCopyEmail', () => ({ sendSignedAgreementCopy: vi.fn() }));
vi.mock('../services/redis', () => ({ getRedis: vi.fn(() => null) }));
vi.mock('../services/rate-limit', () => ({ rateLimiter: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

import {
  isAgreementAcceptJtiRevoked,
  verifyAgreementAcceptToken,
} from '../services/agreementAcceptToken';
import { resolveMergedOrgIds } from '../services/orgMergeProvenance';
import { resolveAgreementRequestLinkOrgGate } from '../services/publicLinkOrgGate';
import { loadTemplateVersionRenderData, type TemplateVersionRenderData } from '../services/contractTemplateRender';
import { markAgreementRequestViewed } from '../services/agreementRequestAcceptService';
import { emitAgreementEvent } from '../services/agreementEvents';
import { captureException } from '../services/sentry';
import { agreementsPublicRoutes } from './agreementsPublic';
import { bySameOriginFramePath, isSameOriginFramePath } from '../middleware/sameOriginFrame';
import { routeReferrerPolicyWins } from '../middleware/routeReferrerPolicy';
import { securityMiddleware } from '../middleware/security';

export const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
export const ORG_ID = '22222222-2222-4222-8222-222222222222';
export const SURVIVOR_ORG_ID = '23232323-2323-4323-8323-232323232323';
export const PARTNER_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_PARTNER_ID = '34343434-3434-4343-8343-343434343434';
const VERSION_ID = '44444444-4444-4444-8444-444444444444';
const TOKEN = 'agreement-token-aaaaaaaaaaaaaaaaaaaa';
const JTI = 'jti-current';
const NOW = Date.now();
const FUTURE = new Date(NOW + 7 * 24 * 3600 * 1000);
const INVALID = { error: 'This link is invalid or has expired' };

function claims(over: Record<string, unknown> = {}) {
  return { requestId: REQUEST_ID, orgId: ORG_ID, partnerId: PARTNER_ID, jti: JTI, ...over };
}

function requestRow(over: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID, orgId: ORG_ID, status: 'sent', templateId: 'tpl', templateVersionId: VERSION_ID,
    contractId: null, label: 'BAA', coverMessage: 'Please sign', variableValues: { 'custom.po': 'PO-9' },
    effectiveDate: '2027-01-10', expiresAt: FUTURE, signedAt: null, declinedAt: null,
    publicLinkRevokedAt: null, acceptTokenJti: JTI, acceptTokenExpiresAt: FUTURE,
    clientNameSnapshot: 'Example Clinic', clientAddressSnapshot: null,
    sellerSnapshot: { name: 'Acme MSP LLC', address: null, phone: null, email: null, website: null },
    renderLocale: 'en', documentLocale: null, createdBy: null,
    ...over,
  };
}

function resolution(over: Record<string, unknown> = {}, rowOver: Record<string, unknown> = {}) {
  return {
    request: requestRow(rowOver),
    partnerId: PARTNER_ID,
    partnerName: 'Acme MSP',
    gate: { orgId: ORG_ID, status: 'active', partnerStatus: 'active', blocked: false },
    ...over,
  };
}

function renderData(over: Partial<TemplateVersionRenderData> = {}): TemplateVersionRenderData {
  return {
    templateId: 'tpl', templateVersionId: VERSION_ID, sourceType: 'authored',
    bodyHtml: '<p>{{client.name}} PO {{custom.po}} <a href="{{custom.po}}">x</a></p>', fileData: null,
    versionSha256: 'vsha',
    declaredVariables: [{ name: 'client.name', kind: 'auto' }, { name: 'custom.po', kind: 'manual' }] as TemplateVersionRenderData['declaredVariables'],
    templateName: 'Business Associate Agreement', versionNumber: 3, ...over,
  };
}

function app() {
  const a = new Hono();
  a.route('/agreements/public', agreementsPublicRoutes);
  return a;
}

const get = (path = '') => app().request(`/agreements/public/${TOKEN}${path}`);

function expectPublicHeaders(res: Response) {
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive');
}

beforeEach(() => {
  process.env.JWT_SECRET ||= 'test-secret-test-secret-test-secret-123';
  vi.clearAllMocks();
  dbResults.length = 0;
  vi.mocked(verifyAgreementAcceptToken).mockResolvedValue(claims());
  vi.mocked(isAgreementAcceptJtiRevoked).mockResolvedValue(false);
  vi.mocked(resolveMergedOrgIds).mockResolvedValue([ORG_ID]);
  vi.mocked(resolveAgreementRequestLinkOrgGate).mockResolvedValue(resolution() as never);
  vi.mocked(loadTemplateVersionRenderData).mockResolvedValue(renderData());
  vi.mocked(markAgreementRequestViewed).mockResolvedValue(true);
});

describe('resolveAgreementLink(): every miss is the SAME 401 (no enumeration)', () => {
  const causes: Array<[string, () => void]> = [
    ['bad signature / wrong kind / expired token', () => vi.mocked(verifyAgreementAcceptToken).mockResolvedValue(null)],
    ['revoked jti (Redis marker; also Redis down — fails closed)', () => vi.mocked(isAgreementAcceptJtiRevoked).mockResolvedValue(true)],
    ['unknown request id', () => vi.mocked(resolveAgreementRequestLinkOrgGate).mockResolvedValue(resolution({ request: null, partnerId: null, partnerName: null, gate: { orgId: null, status: null, partnerStatus: null, blocked: false } }) as never)],
    ['request in another org (not in the merged set)', () => vi.mocked(resolveAgreementRequestLinkOrgGate).mockResolvedValue(resolution({ request: null, partnerId: null, partnerName: null, gate: { orgId: null, status: null, partnerStatus: null, blocked: false } }) as never)],
    ['stale jti (copy-link reissued the credential)', () => vi.mocked(resolveAgreementRequestLinkOrgGate).mockResolvedValue(resolution({}, { acceptTokenJti: 'jti-reissued' }) as never)],
    ['no persisted credential at all', () => vi.mocked(resolveAgreementRequestLinkOrgGate).mockResolvedValue(resolution({}, { acceptTokenJti: null }) as never)],
    ['org re-parented to another partner (partner continuity)', () => vi.mocked(resolveAgreementRequestLinkOrgGate).mockResolvedValue(resolution({ partnerId: OTHER_PARTNER_ID }) as never)],
    ['a draft (never sent)', () => vi.mocked(resolveAgreementRequestLinkOrgGate).mockResolvedValue(resolution({}, { status: 'draft' }) as never)],
  ];

  it.each(causes)('%s → 401 with the identical body and public headers', async (_name, arrange) => {
    arrange();
    const res = await get();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(INVALID);
    expectPublicHeaders(res);
    expect(markAgreementRequestViewed).not.toHaveBeenCalled();
  });

  it('partner continuity is checked even when the org gate would block (401 wins: a stale link never learns tenant status)', async () => {
    vi.mocked(resolveAgreementRequestLinkOrgGate).mockResolvedValue(resolution({
      partnerId: OTHER_PARTNER_ID,
      gate: { orgId: ORG_ID, status: 'archived', partnerStatus: 'active', blocked: true },
    }) as never);
    const res = await get();
    expect(res.status).toBe(401);
  });

  it('resolves through the merged-org set with the token partner as the hard filter', async () => {
    vi.mocked(resolveMergedOrgIds).mockResolvedValue([ORG_ID, SURVIVOR_ORG_ID]);
    vi.mocked(resolveAgreementRequestLinkOrgGate).mockResolvedValue(resolution({}, { orgId: SURVIVOR_ORG_ID }) as never);
    const res = await get();
    expect(res.status).toBe(200);
    expect(resolveMergedOrgIds).toHaveBeenCalledWith(ORG_ID, PARTNER_ID);
    expect(resolveAgreementRequestLinkOrgGate).toHaveBeenCalledWith(REQUEST_ID, [ORG_ID, SURVIVOR_ORG_ID]);
    // The viewed stamp is scoped to the row's CURRENT (survivor) org.
    expect(markAgreementRequestViewed).toHaveBeenCalledWith(REQUEST_ID, SURVIVOR_ORG_ID, expect.any(Date));
  });

  it('a quote accept token is a 401 here (cross-rejection; real verifier, no mock)', async () => {
    const { verifyAgreementAcceptToken: realVerify } = await vi.importActual<typeof import('../services/agreementAcceptToken')>('../services/agreementAcceptToken');
    vi.mocked(verifyAgreementAcceptToken).mockImplementation(realVerify);
    const { createQuoteAcceptToken } = await vi.importActual<typeof import('../services/quoteAcceptToken')>('../services/quoteAcceptToken');
    const { token: quoteToken } = await createQuoteAcceptToken({ quoteId: REQUEST_ID, orgId: ORG_ID, partnerId: PARTNER_ID });
    for (const path of ['', '/file']) {
      const res = await app().request(`/agreements/public/${encodeURIComponent(quoteToken)}${path}`);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual(INVALID);
    }
    expect(resolveAgreementRequestLinkOrgGate).not.toHaveBeenCalled();
  });

  it('and vice versa: an agreement token is a 401 on every quotesPublic route (real verifiers)', async () => {
    const actual = await vi.importActual<typeof import('../services/agreementAcceptToken')>('../services/agreementAcceptToken');
    const { token } = await actual.createAgreementAcceptToken({ requestId: REQUEST_ID, orgId: ORG_ID, partnerId: PARTNER_ID, expiresAt: FUTURE });
    // The 401 below must come from signature/audience rejection, not from the
    // Redis gate failing closed (getRedis is null in this file).
    const quoteTokens = await vi.importActual<typeof import('../services/quoteAcceptToken')>('../services/quoteAcceptToken');
    expect(await quoteTokens.verifyQuoteAcceptToken(token)).toBeNull();
    const { quotesPublicRoutes } = await import('./quotesPublic');
    const q = new Hono();
    q.route('/quotes/public', quotesPublicRoutes);
    const enc = encodeURIComponent(token);
    const id = '66666666-6666-4666-8666-666666666666';
    const routes = (quotesPublicRoutes as unknown as { routes: Array<{ method: string; path: string }> }).routes;
    expect(routes.length).toBeGreaterThan(0);
    for (const r of routes) {
      const path = r.path.replace(':token', enc).replace(/:[a-zA-Z]+/g, id);
      const res = await q.request(`/quotes/public${path}`, r.method === 'POST'
        ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(path.endsWith('/accept') ? { signerName: 'Dana' } : {}) }
        : undefined);
      expect(res.status, `${r.method} ${r.path}`).toBe(401);
    }
  }, 30_000); // dynamic import of the whole quotesPublic module graph
});

describe('resolveAgreementLink(): 410 states carry branding only', () => {
  it('org/partner gate blocked → 410 ORG_UNAVAILABLE', async () => {
    vi.mocked(resolveAgreementRequestLinkOrgGate).mockResolvedValue(resolution({ gate: { orgId: ORG_ID, status: 'active', partnerStatus: 'suspended', blocked: true } }) as never);
    const res = await get();
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: 'This link is no longer available', code: 'ORG_UNAVAILABLE' });
    expectPublicHeaders(res);
  });

  it.each([
    ['voided', { status: 'voided', publicLinkRevokedAt: new Date() }],
    ['revoked link column on an open status', { status: 'sent', publicLinkRevokedAt: new Date() }],
    ['voided with the column somehow unset', { status: 'voided', publicLinkRevokedAt: null }],
  ])('%s → 410 LINK_REVOKED, partner name only', async (_n, rowOver) => {
    vi.mocked(resolveAgreementRequestLinkOrgGate).mockResolvedValue(resolution({}, rowOver) as never);
    const res = await get();
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body).toEqual({ error: 'This agreement request was withdrawn', code: 'LINK_REVOKED', data: { branding: { partnerName: 'Acme MSP' } } });
    expect(markAgreementRequestViewed).not.toHaveBeenCalled();
  });

  it('expired at the instant (now == expires_at) → 410 AGREEMENT_EXPIRED', async () => {
    vi.useFakeTimers({ now: FUTURE });
    try {
      const res = await get();
      expect(res.status).toBe(410);
      expect(await res.json()).toEqual({ error: 'This agreement request has expired', code: 'AGREEMENT_EXPIRED', data: { branding: { partnerName: 'Acme MSP' } } });
    } finally { vi.useRealTimers(); }
  });

  it('1 ms before expires_at still renders', async () => {
    vi.useFakeTimers({ now: new Date(FUTURE.getTime() - 1) });
    try {
      expect((await get()).status).toBe(200);
    } finally { vi.useRealTimers(); }
  });

  it('a request the reaper already expired → 410 AGREEMENT_EXPIRED', async () => {
    vi.mocked(resolveAgreementRequestLinkOrgGate).mockResolvedValue(resolution({}, { status: 'expired' }) as never);
    const res = await get();
    expect(res.status).toBe(410);
    expect((await res.json()).code).toBe('AGREEMENT_EXPIRED');
  });
});

describe('GET /:token — view', () => {
  it('renders the frozen snapshot through renderAgreementRequestHtml, stamps viewed from sent, presents viewed', async () => {
    dbResults.push([{ logoUrl: 'https://cdn.example.com/org-logo.png', primaryColor: null }], [{ settings: {} }]);
    const res = await get();
    expect(res.status).toBe(200);
    expectPublicHeaders(res);
    const { data } = await res.json();
    expect(data.request).toMatchObject({ id: REQUEST_ID, status: 'viewed', coverMessage: 'Please sign' });
    expect(data.request).not.toHaveProperty('label'); // staff-internal (#10294)
    expect(data.template).toEqual({ name: 'Business Associate Agreement', versionNumber: 3, sourceType: 'authored' });
    // Frozen client name + manual value substituted; the href value re-sanitized.
    expect(data.html).toContain('Example Clinic PO PO-9');
    expect(data.fileUrl).toBeNull();
    expect(data.parties).toEqual({ partnerName: 'Acme MSP', orgName: 'Example Clinic' });
    expect(data.branding.logoUrl).toBe('https://cdn.example.com/org-logo.png');
    expect(markAgreementRequestViewed).toHaveBeenCalledWith(REQUEST_ID, ORG_ID, expect.any(Date));
    // First view only: the bus hears sent → viewed exactly once.
    expect(emitAgreementEvent).toHaveBeenCalledWith({ type: 'agreement.viewed', requestId: REQUEST_ID, orgId: ORG_ID, partnerId: PARTNER_ID });
    // No internal ids beyond the request id.
    const text = JSON.stringify(data);
    for (const leak of [ORG_ID, PARTNER_ID, VERSION_ID, JTI, 'tpl']) expect(text).not.toContain(leak);
  });

  it('an already-viewed request is not re-stamped and stays viewed', async () => {
    vi.mocked(resolveAgreementRequestLinkOrgGate).mockResolvedValue(resolution({}, { status: 'viewed' }) as never);
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).data.request.status).toBe('viewed');
    expect(markAgreementRequestViewed).not.toHaveBeenCalled();
    expect(emitAgreementEvent).not.toHaveBeenCalled();
  });

  it('a lost stamp race (0 rows) still presents the row status it read', async () => {
    vi.mocked(markAgreementRequestViewed).mockResolvedValue(false);
    expect((await (await get()).json()).data.request.status).toBe('sent');
    expect(emitAgreementEvent).not.toHaveBeenCalled(); // the racing winner emitted it
  });

  it('a failing viewed stamp is logged + captured and never fails the view', async () => {
    vi.mocked(markAgreementRequestViewed).mockRejectedValue(new Error('db down'));
    const res = await get();
    expect(res.status).toBe(200);
    expect(captureException).toHaveBeenCalled();
    expect(emitAgreementEvent).not.toHaveBeenCalled();
  });

  it.each(['signed', 'declined'])('a %s request renders read-only (no stamp) even past its expiry', async (status) => {
    vi.mocked(resolveAgreementRequestLinkOrgGate).mockResolvedValue(resolution({}, {
      status, expiresAt: new Date(NOW - 1000),
      signedAt: status === 'signed' ? new Date('2027-01-11T09:00:00.000Z') : null,
      declinedAt: status === 'declined' ? new Date('2027-01-11T09:00:00.000Z') : null,
    }) as never);
    const res = await get();
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.request.status).toBe(status);
    expect(markAgreementRequestViewed).not.toHaveBeenCalled();
  });

  it('#10294: a signed request names the template as it was at signing, not the renamed live template', async () => {
    vi.mocked(resolveAgreementRequestLinkOrgGate).mockResolvedValue(resolution({}, {
      status: 'signed', expiresAt: new Date(NOW - 1000), signedAt: new Date('2027-01-11T09:00:00.000Z'),
    }) as never);
    vi.mocked(loadTemplateVersionRenderData).mockResolvedValue(renderData({ templateName: 'BAA (renamed)' }));
    // Branding (org, partner), then the signed agreement's frozen name.
    dbResults.push([], [{ settings: {} }], [{ templateNameSnapshot: 'Business Associate Agreement' }]);
    const { data } = await (await get()).json();
    expect(data.template.name).toBe('Business Associate Agreement');
    expect(JSON.stringify(data)).not.toContain('renamed');
  });

  it('an open request still names the live template (nothing is frozen until signing)', async () => {
    vi.mocked(loadTemplateVersionRenderData).mockResolvedValue(renderData({ templateName: 'BAA (renamed)' }));
    const { data } = await (await get()).json();
    expect(data.template.name).toBe('BAA (renamed)');
  });

  it('an uploaded template carries the token-scoped file url and no html', async () => {
    vi.mocked(loadTemplateVersionRenderData).mockResolvedValue(renderData({ sourceType: 'uploaded', bodyHtml: null }));
    const { data } = await (await get()).json();
    expect(data.html).toBeNull();
    expect(data.fileUrl).toBe(`/agreements/public/${TOKEN}/file`);
    expect(loadTemplateVersionRenderData).toHaveBeenCalledWith(VERSION_ID);
  });
});

describe('GET /:token/file', () => {
  it('streams the pinned uploaded version inline as a PDF with a sanitized filename', async () => {
    vi.mocked(loadTemplateVersionRenderData).mockResolvedValue(renderData({ sourceType: 'uploaded', bodyHtml: null, fileData: Buffer.from('%PDF-1.7 bytes'), templateName: 'BAA "v3"\r\n' }));
    const res = await get('/file');
    expect(res.status).toBe(200);
    expectPublicHeaders(res);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd.startsWith('inline; filename="')).toBe(true);
    expect(cd).not.toMatch(/[\r\n]/);
    expect(cd).toContain('.pdf');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('%PDF-1.7 bytes');
    expect(loadTemplateVersionRenderData).toHaveBeenCalledWith(VERSION_ID, { includeFileData: true });
  });

  it('an authored template has no file → 404', async () => {
    const res = await get('/file');
    expect(res.status).toBe(404);
  });

  it('a dead link never serves the file', async () => {
    vi.mocked(resolveAgreementRequestLinkOrgGate).mockResolvedValue(resolution({}, { status: 'voided', publicLinkRevokedAt: new Date() }) as never);
    const res = await get('/file');
    expect(res.status).toBe(410);
    expect(loadTemplateVersionRenderData).not.toHaveBeenCalled();
  });
});

describe('GET /:token/file — framing under the app-wide header stack (#10192)', () => {
  // index.ts wraps every router in secureHeaders (X-Frame-Options) + securityMiddleware (CSP), both path-selected.
  // Mount this router at its real /api/v1 path so a drift between the route and the frame list fails here.
  function appWithHeaders() {
    const OPTIONS = { strictTransportSecurity: 'max-age=31536000; includeSubDomains; preload', xFrameOptions: 'DENY', referrerPolicy: 'strict-origin-when-cross-origin' } as const;
    const a = new Hono();
    a.use('*', routeReferrerPolicyWins(bySameOriginFramePath(
      secureHeaders({ ...OPTIONS }),
      secureHeaders({ ...OPTIONS, xFrameOptions: 'SAMEORIGIN' }),
    )));
    a.use('*', securityMiddleware({ nodeEnv: 'production', sameOriginFrameWhen: isSameOriginFramePath }));
    a.route('/api/v1/agreements/public', agreementsPublicRoutes);
    return a;
  }

  it('the PDF can be framed by the signing page (same origin) and keeps every capability-URL header', async () => {
    vi.mocked(loadTemplateVersionRenderData).mockResolvedValue(renderData({ sourceType: 'uploaded', bodyHtml: null, fileData: Buffer.from('%PDF-1.7 bytes') }));
    const res = await appWithHeaders().request(`/api/v1/agreements/public/${TOKEN}/file`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain("frame-ancestors 'none'");
    expectPublicHeaders(res);
    expect(res.headers.get('content-disposition')?.startsWith('inline;')).toBe(true);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('the JSON view on the same token stays unframeable', async () => {
    const res = await appWithHeaders().request(`/api/v1/agreements/public/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });
});
