import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { SAME_ORIGIN_FRAME_PATHS, bySameOriginFramePath, isSameOriginFramePath } from './sameOriginFrame';
import { securityMiddleware } from './security';

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.payload.sig';
const BLOCK = '66666666-6666-4666-8666-666666666666';

describe('SAME_ORIGIN_FRAME_PATHS (#10192)', () => {
  it('lists exactly the two inline public PDF routes — widening it is a deliberate, reviewed change', () => {
    expect(SAME_ORIGIN_FRAME_PATHS.map((re) => re.source)).toEqual([
      '^\\/api\\/v1\\/agreements\\/public\\/[^/]+\\/file$',
      '^\\/api\\/v1\\/quotes\\/public\\/[^/]+\\/contract-file\\/[^/]+$',
    ]);
    expect(SAME_ORIGIN_FRAME_PATHS.every((re) => re.flags === '')).toBe(true);
  });
});

describe('isSameOriginFramePath', () => {
  it.each([
    [`/api/v1/agreements/public/${TOKEN}/file`, true],
    [`/api/v1/quotes/public/${TOKEN}/contract-file/${BLOCK}`, true],
    // the JSON views and every sibling asset on the same token stay DENY
    [`/api/v1/agreements/public/${TOKEN}`, false],
    [`/api/v1/agreements/public/${TOKEN}/accept`, false],
    [`/api/v1/quotes/public/${TOKEN}`, false],
    [`/api/v1/quotes/public/${TOKEN}/images/${BLOCK}`, false],
    [`/api/v1/quotes/public/${TOKEN}/line-image/${BLOCK}`, false],
    // anchored: no prefix, suffix, extra segment, trailing slash or missing segment
    [`/api/v1/agreements/public/${TOKEN}/file/`, false],
    [`/api/v1/agreements/public/${TOKEN}/file/x`, false],
    [`/api/v1/agreements/public/${TOKEN}/filex`, false],
    ['/api/v1/agreements/public//file', false],
    [`/x/api/v1/agreements/public/${TOKEN}/file`, false],
    [`/api/v1/agreements/public/a/b/file`, false],
    [`/api/v1/quotes/public/${TOKEN}/contract-file`, false],
    [`/api/v1/quotes/public/${TOKEN}/contract-file/`, false],
    [`/api/v1/quotes/public/${TOKEN}/contract-file/${BLOCK}/x`, false],
    // the authenticated surfaces that serve the same bytes are NOT exempt
    [`/api/v1/agreements/${BLOCK}/file`, false],
    [`/api/v1/portal/quotes/${BLOCK}/contract-file/${BLOCK}`, false],
    ['/api/v1/devices', false],
    ['/portal/agreement/x', false],
  ])('%s → %s', (path, expected) => {
    expect(isSameOriginFramePath(path)).toBe(expected);
  });
});

describe('index.ts registration', () => {
  const indexSource = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8');

  it('selects a SAMEORIGIN twin of the app-wide secureHeaders by path, around the trust selector', () => {
    expect(indexSource).toMatch(
      /routeReferrerPolicyWins\(\s*bySameOriginFramePath\(\s*byTrustCrossOriginPath\(\s*secureHeaders\(\{ \.\.\.SECURE_HEADERS_OPTIONS \}\),\s*secureHeaders\(\{ \.\.\.SECURE_HEADERS_OPTIONS, crossOriginResourcePolicy: 'cross-origin' \}\),\s*\),\s*secureHeaders\(\{ \.\.\.SECURE_HEADERS_OPTIONS, xFrameOptions: 'SAMEORIGIN' \}\),\s*\)\s*\)/,
    );
    // The app-wide default stays DENY.
    expect(indexSource).toMatch(/xFrameOptions: 'DENY'/);
  });

  it("passes the same predicate to securityMiddleware so the CSP says frame-ancestors 'self' on exactly those paths", () => {
    expect(indexSource).toMatch(
      /app\.use\('\*', securityMiddleware\(\{[^)]*sameOriginFrameWhen: isSameOriginFramePath[^)]*\}\)\);/,
    );
  });
});

describe('bySameOriginFramePath + securityMiddleware (the index.ts header stack)', () => {
  // Same shape as index.ts: app-wide registrations ahead of the routers. secureHeaders writes after next(), so the
  // route handlers cannot pick their own framing headers — the path selector is the only place this can live.
  const OPTIONS = { strictTransportSecurity: 'max-age=31536000; includeSubDomains; preload', xFrameOptions: 'DENY', referrerPolicy: 'strict-origin-when-cross-origin' } as const;
  const app = new Hono();
  app.use('*', bySameOriginFramePath(
    secureHeaders({ ...OPTIONS }),
    secureHeaders({ ...OPTIONS, xFrameOptions: 'SAMEORIGIN' }),
  ));
  app.use('*', securityMiddleware({ nodeEnv: 'production', sameOriginFrameWhen: isSameOriginFramePath }));
  app.get('/api/v1/agreements/public/:token/file', (c) => {
    // A handler trying to loosen framing further is overwritten — only the selector decides.
    c.header('X-Frame-Options', 'ALLOWALL');
    return c.body('%PDF-1.7', 200, { 'Content-Type': 'application/pdf' });
  });
  app.get('/api/v1/quotes/public/:token/contract-file/:blockId', (c) => c.body('%PDF-1.4', 200, { 'Content-Type': 'application/pdf' }));
  app.get('/api/v1/agreements/public/:token', (c) => c.json({ ok: true }));
  app.get('/api/v1/devices', (c) => c.json({ ok: true }));

  const AGREEMENT_FILE = `/api/v1/agreements/public/${TOKEN}/file`;
  const QUOTE_FILE = `/api/v1/quotes/public/${TOKEN}/contract-file/${BLOCK}`;

  it.each([AGREEMENT_FILE, QUOTE_FILE])('%s is frameable by its own origin only', async (path) => {
    const res = await app.request(path);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
    const csp = res.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain("frame-ancestors 'none'");
    expect(csp.match(/frame-ancestors/g)).toHaveLength(1);
  });

  it.each([`/api/v1/agreements/public/${TOKEN}`, '/api/v1/devices'])('%s keeps DENY and frame-ancestors none', async (path) => {
    const res = await app.request(path);
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  });

  it('only X-Frame-Options and the frame-ancestors directive differ between the branches', async () => {
    const strip = (h: Headers) => Object.fromEntries([...h.entries()].filter(([k]) => !['x-frame-options', 'content-type', 'content-length'].includes(k)));
    const framed = strip((await app.request(AGREEMENT_FILE)).headers);
    const denied = strip((await app.request('/api/v1/devices')).headers);
    const normalizeCsp = (v: string) => v.replace("frame-ancestors 'self'", "frame-ancestors 'none'");
    expect({ ...framed, 'content-security-policy': normalizeCsp(framed['content-security-policy']!) }).toEqual(denied);
  });
});
