import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';

// GET /quotes/public/:token/pdf (#9860) — the Download PDF behind the public
// proposal link. The token is the only authorization, so this file pins every
// way the link can be dead (bad signature / expired, revoked jti, superseded,
// publicLinkRevokedAt, draft, unknown quote, archived org) to a non-2xx that
// never reaches the renderer, plus the capability-URL headers.
//
// DB mock: select().from().where().limit() resolves to the next queued row set,
// consumed FIFO in call order (same pattern as quotesPublic.test.ts).
const { dbResults } = vi.hoisted(() => ({ dbResults: [] as unknown[][] }));
vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'orderBy', 'limit', 'update', 'set', 'returning', 'for']) chain[m] = vi.fn(() => chain);
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      const rows = dbResults.shift() ?? [];
      return Promise.resolve(rows).then(resolve);
    };
    return chain;
  };
  return {
    db: makeChain(),
    getCurrentDbAccessContext: () => undefined,
    runOutsideDbContext: <T>(fn: () => T): T => fn(),
    withSystemDbAccessContext: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  };
});

vi.mock('../services/quoteAcceptToken', () => ({
  verifyQuoteAcceptToken: vi.fn(),
  isQuoteAcceptJtiRevoked: vi.fn(),
  revokeQuoteAcceptJti: vi.fn(),
}));
vi.mock('../services/quoteLifecycle', () => ({ markQuoteViewed: vi.fn() }));
vi.mock('../services/quoteOutcomeNotify', () => ({ notifyQuoteOutcome: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/orgMerge', () => ({ resolveMergedOrgIds: vi.fn(async (orgId: string) => [orgId]) }));
vi.mock('../services/publicLinkOrgGate', async (importActual) => {
  const actual = await importActual<typeof import('../services/publicLinkOrgGate')>();
  return { ...actual, resolveQuoteLinkOrgGate: vi.fn(async () => actual.PUBLIC_LINK_ORG_GATE_OPEN) };
});
// The renderer is the portal route's (shared service); its own output is pinned
// by routes/portal/quotes.test.ts. Here it is a spy so the tests prove WHEN it
// runs — never for a dead link — and what the route does with its bytes.
vi.mock('../services/customerQuotePdf', async (importActual) => {
  const actual = await importActual<typeof import('../services/customerQuotePdf')>();
  return { ...actual, renderCustomerQuotePdf: vi.fn() };
});
const { redisState } = vi.hoisted(() => ({ redisState: { client: null as unknown, allowed: true } }));
vi.mock('../services/redis', () => ({ getRedis: () => redisState.client }));
vi.mock('../services/rate-limit', () => ({
  rateLimiter: vi.fn(async () => ({ allowed: redisState.allowed, remaining: 0, resetAt: new Date() })),
}));
vi.mock('../services/sentry', async (importActual) => {
  const actual = await importActual<typeof import('../services/sentry')>();
  return { ...actual, captureException: vi.fn() };
});

import { quotesPublicRoutes } from './quotesPublic';
import { db } from '../db';
import { verifyQuoteAcceptToken, isQuoteAcceptJtiRevoked } from '../services/quoteAcceptToken';
import { resolveQuoteLinkOrgGate, PUBLIC_LINK_ORG_UNAVAILABLE } from '../services/publicLinkOrgGate';
import { renderCustomerQuotePdf } from '../services/customerQuotePdf';
import { rateLimiter } from '../services/rate-limit';
import { PdfMergeError } from '../services/pdfMerge';
import { captureException } from '../services/sentry';
import { bySameOriginFramePath, isSameOriginFramePath } from '../middleware/sameOriginFrame';
import { routeReferrerPolicyWins } from '../middleware/routeReferrerPolicy';
import { securityMiddleware } from '../middleware/security';

const QUOTE_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = '22222222-2222-2222-2222-222222222222';
const PARTNER_ID = '33333333-3333-3333-3333-333333333333';
const TOKEN = 'a-valid-looking-token-1234567890';
const PDF_BYTES = Buffer.from('%PDF-1.7 public proposal');

const renderMock = renderCustomerQuotePdf as unknown as ReturnType<typeof vi.fn>;
const selectMock = (db as unknown as { select: ReturnType<typeof vi.fn> }).select;

function app() {
  const a = new Hono();
  a.route('/quotes/public', quotesPublicRoutes);
  return a;
}

function quoteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: QUOTE_ID, orgId: ORG_ID, partnerId: PARTNER_ID, status: 'sent', publicLinkRevokedAt: null,
    quoteNumber: 'Q-2026-0042', currencyCode: 'USD', taxRate: null, expiryDate: null,
    depositType: 'none', depositPercent: null, presentationSnapshot: null, documentLocale: null,
    ...overrides,
  };
}

const pdfPath = `/quotes/public/${TOKEN}/pdf`;

function expectCapabilityHeaders(res: Response) {
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive');
}

beforeEach(() => {
  vi.clearAllMocks();
  dbResults.length = 0;
  redisState.client = null;
  redisState.allowed = true;
  (verifyQuoteAcceptToken as ReturnType<typeof vi.fn>).mockResolvedValue({
    quoteId: QUOTE_ID, orgId: ORG_ID, partnerId: PARTNER_ID, jti: 'jti-1',
  });
  (isQuoteAcceptJtiRevoked as ReturnType<typeof vi.fn>).mockResolvedValue(false);
  renderMock.mockResolvedValue(PDF_BYTES);
});

describe('quotesPublic GET /:token/pdf — live link', () => {
  it('streams the proposal PDF as a download with no-store / no-referrer headers', async () => {
    dbResults.push([quoteRow()]);

    const res = await app().request(pdfPath);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="quote-Q-2026-0042.pdf"');
    expect(res.headers.get('content-length')).toBe(String(PDF_BYTES.length));
    expectCapabilityHeaders(res);
    expect(Buffer.from(await res.arrayBuffer()).equals(PDF_BYTES)).toBe(true);
    // Rendered from the row the token resolved — not from anything in the request.
    expect(renderMock).toHaveBeenCalledTimes(1);
    expect(renderMock.mock.calls[0]![0]).toMatchObject({ id: QUOTE_ID, orgId: ORG_ID });
  });

  // The page serves every non-draft, live-link status; so does the PDF (the
  // customer keeps the copy they signed or let lapse).
  it.each([
    ['an expired proposal', { status: 'expired', expiryDate: '2026-01-01' }],
    ['a sent proposal past its expiry date (before the sweep)', { status: 'sent', expiryDate: '2026-01-01' }],
    ['a viewed proposal', { status: 'viewed' }],
    ['a converted proposal (accepted on behalf, link still live)', { status: 'converted' }],
    ['a declined proposal', { status: 'declined' }],
  ])('serves %s, like the page does', async (_label, overrides) => {
    dbResults.push([quoteRow(overrides)]);

    const res = await app().request(pdfPath);

    expect(res.status).toBe(200);
    expect(renderMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the quote id in the filename when the quote has no number', async () => {
    dbResults.push([quoteRow({ quoteNumber: null })]);

    const res = await app().request(pdfPath);

    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="quote-${QUOTE_ID}.pdf"`);
  });

  it('maps an unreadable uploaded contract (PdfMergeError) to its typed 4xx with a customer-safe message, and reports it', async () => {
    dbResults.push([quoteRow()]);
    const parserDetail = 'Failed to parse PDF document (line:0 col:0 offset=0): No PDF header found';
    const err = new PdfMergeError(`An attached contract PDF could not be read: ${parserDetail}`, 422, 'CONTRACT_PDF_UNREADABLE');
    renderMock.mockRejectedValue(err);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await app().request(pdfPath);

    expect(res.status).toBe(422);
    const body = await res.json() as { error: string; code: string };
    expect(body.code).toBe('CONTRACT_PDF_UNREADABLE');
    // The parser's own text never reaches an unauthenticated caller.
    expect(body.error).not.toContain(parserDetail);
    expect(body.error).toBe('This proposal’s PDF is unavailable right now. Please contact the sender.');
    expectCapabilityHeaders(res);
    // A stored-bytes fault is a 4xx, so 5xx alerting never sees it: it must be reported.
    expect(captureException).toHaveBeenCalledWith(err);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('keeps no-store / no-referrer on an unexpected render failure (500 through onError)', async () => {
    dbResults.push([quoteRow()]);
    renderMock.mockRejectedValue(new Error('pdfkit exploded'));
    const a = new Hono();
    a.route('/quotes/public', quotesPublicRoutes);
    a.onError((_err, c) => c.json({ error: 'Internal server error' }, 500));

    const res = await a.request(pdfPath);

    expect(res.status).toBe(500);
    expectCapabilityHeaders(res);
  });
});

describe('quotesPublic GET /:token/pdf — dead links never render', () => {
  it('401s a bad or expired token (signature/exp check fails) before any DB read', async () => {
    (verifyQuoteAcceptToken as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const res = await app().request(pdfPath);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'This link is invalid or has expired' });
    expect(selectMock).not.toHaveBeenCalled();
    expect(renderMock).not.toHaveBeenCalled();
    expectCapabilityHeaders(res);
  });

  it('401s a revoked (spent) token jti before any DB read', async () => {
    (isQuoteAcceptJtiRevoked as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const res = await app().request(pdfPath);

    expect(res.status).toBe(401);
    expect(selectMock).not.toHaveBeenCalled();
    expect(renderMock).not.toHaveBeenCalled();
  });

  it('410s when the owning org is archived (org-lifecycle gate)', async () => {
    (resolveQuoteLinkOrgGate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ orgId: ORG_ID, status: 'archived', partnerStatus: 'active', blocked: true });

    const res = await app().request(pdfPath);

    expect(res.status).toBe(410);
    expect(await res.json()).toEqual(PUBLIC_LINK_ORG_UNAVAILABLE);
    expect(renderMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a superseded quote', quoteRow({ status: 'superseded' })],
    ['a quote whose public link was revoked', quoteRow({ publicLinkRevokedAt: new Date('2026-08-23T12:00:00Z') })],
    ['a draft quote', quoteRow({ status: 'draft' })],
  ])('404s %s without rendering', async (_label, row) => {
    dbResults.push([row]);

    const res = await app().request(pdfPath);

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'Quote not found' });
    expect(renderMock).not.toHaveBeenCalled();
    expectCapabilityHeaders(res);
  });

  it('404s when the token quote is not in the token org set (unknown / cross-tenant)', async () => {
    dbResults.push([]);

    const res = await app().request(pdfPath);

    expect(res.status).toBe(404);
    expect(renderMock).not.toHaveBeenCalled();
  });
});

describe('quotesPublic GET /:token/pdf — render budget', () => {
  it('429s once the per-quote PDF budget is spent, keyed on the resolved quote id', async () => {
    redisState.client = {};
    redisState.allowed = false;
    dbResults.push([quoteRow()]);

    const res = await app().request(pdfPath);

    expect(res.status).toBe(429);
    expect(renderMock).not.toHaveBeenCalled();
    expect(rateLimiter).toHaveBeenCalledWith(redisState.client, `quote-public:pdf:${QUOTE_ID}`, 10, 60);
  });

  it('does not spend the budget on a dead link (gates run first)', async () => {
    redisState.client = {};
    dbResults.push([quoteRow({ status: 'superseded' })]);

    const res = await app().request(pdfPath);

    expect(res.status).toBe(404);
    expect(rateLimiter).not.toHaveBeenCalled();
  });

  it('fails open when the limiter itself throws (renders)', async () => {
    redisState.client = {};
    (rateLimiter as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('redis: connection reset'));
    dbResults.push([quoteRow()]);

    const res = await app().request(pdfPath);

    expect(res.status).toBe(200);
    expect(renderMock).toHaveBeenCalledTimes(1);
  });

  it('fails open when Redis is unavailable (renders)', async () => {
    redisState.client = null;
    dbResults.push([quoteRow()]);

    const res = await app().request(pdfPath);

    expect(res.status).toBe(200);
    expect(rateLimiter).not.toHaveBeenCalled();
  });
});

describe('quotesPublic GET /:token/pdf — under the app-wide header stack', () => {
  // index.ts wraps every router in secureHeaders + securityMiddleware; secureHeaders writes its
  // global Referrer-Policy after next(). Mount at the real /api/v1 path so the route's no-referrer
  // is proven to survive the stack, not just the bare router.
  function appWithHeaders() {
    const OPTIONS = { strictTransportSecurity: 'max-age=31536000; includeSubDomains; preload', xFrameOptions: 'DENY', referrerPolicy: 'strict-origin-when-cross-origin' } as const;
    const a = new Hono();
    a.use('*', routeReferrerPolicyWins(bySameOriginFramePath(
      secureHeaders({ ...OPTIONS }),
      secureHeaders({ ...OPTIONS, xFrameOptions: 'SAMEORIGIN' }),
    )));
    a.use('*', securityMiddleware({ nodeEnv: 'production', sameOriginFrameWhen: isSameOriginFramePath }));
    a.route('/api/v1/quotes/public', quotesPublicRoutes);
    return a;
  }

  it('keeps Referrer-Policy: no-referrer and Cache-Control: no-store on the download', async () => {
    dbResults.push([quoteRow()]);

    const res = await appWithHeaders().request(`/api/v1/quotes/public/${TOKEN}/pdf`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expectCapabilityHeaders(res);
  });
});
