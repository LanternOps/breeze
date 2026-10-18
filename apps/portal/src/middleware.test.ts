import { afterEach, describe, expect, it, vi } from 'vitest';

// The portal middleware is authored against Astro's virtual `astro:middleware`
// module; `defineMiddleware` is a typing-only identity wrapper at runtime.
vi.mock('astro:middleware', () => ({ defineMiddleware: (fn: unknown) => fn }));

import { onRequest } from './middleware';
import { withBase } from './lib/basePath';

const SESSION_COOKIE = 'breeze_portal_session=test-session-token';

function accountDisabledFetch() {
  return vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({ error: 'Account is not active', code: 'PORTAL_ACCOUNT_INACTIVE' }),
      { status: 403 }
    )
  );
}

function activeAccountFetch() {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ branding: { name: 'Acme IT' } }), { status: 200 })
  );
}

/** Minimal stand-in for Astro's APIContext, enough for the route guards. */
function contextFor(path: string, { signedIn }: { signedIn: boolean }) {
  const url = new URL(`https://portal.example${withBase(path)}`);
  const request = new Request(url, {
    headers: {
      host: 'portal.example',
      ...(signedIn ? { cookie: SESSION_COOKIE } : {})
    }
  });
  return {
    url,
    request,
    locals: {} as { cspNonce?: string },
    redirect: (location: string, status = 302) =>
      new Response(null, { status, headers: { Location: location } })
  };
}

const next = () => Promise.resolve(new Response('<html>page</html>', {
  headers: { 'Content-Type': 'text/html' }
}));

/** The middleware's declared return type allows `void`; it never returns one. */
async function run(context: ReturnType<typeof contextFor>): Promise<Response> {
  const response = await onRequest(context as never, next);
  if (!(response instanceof Response)) throw new Error('middleware returned no Response');
  return response;
}

// #5320 — the disabled-account bounce lived only in the landing computation
// ('/', '/login', '/forgot-password') plus a hand-rolled check inside
// quotes/index.astro, so every other signed-in page rendered the API's raw
// "Account is not active" string inline as though it were a load failure.
describe('portal middleware — disabled account guard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const protectedPages = [
    '/security',
    '/tickets',
    '/tickets/42',
    '/dashboard',
    '/invoices',
    '/reports',
    '/backups',
    '/assets',
    '/devices',
    '/profile',
    '/quotes',
    '/quotes/7'
  ];

  it.each(protectedPages)('redirects %s to /account-disabled for a disabled account', async (path) => {
    vi.stubGlobal('fetch', accountDisabledFetch());
    const context = contextFor(path, { signedIn: true });

    const response = await run(context);

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(withBase('/account-disabled'));
  });

  it('renders the account-disabled page itself instead of redirecting onto it', async () => {
    vi.stubGlobal('fetch', accountDisabledFetch());
    const context = contextFor('/account-disabled', { signedIn: true });

    const response = await run(context);

    expect(response.status).toBe(200);
  });

  it('leaves an active account on the page it asked for', async () => {
    vi.stubGlobal('fetch', activeAccountFetch());
    const context = contextFor('/security', { signedIn: true });

    const response = await run(context);

    expect(response.status).toBe(200);
  });

  // Deliberate fail-open, asserted so it stays deliberate: the API is the
  // access-control boundary (it 403s every data call from a disabled account),
  // this guard only decides which copy the customer reads. A branding blip must
  // not bounce healthy customers to "Account disabled".
  it('renders the page when the branding lookup fails outright', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const context = contextFor('/security', { signedIn: true });

    const response = await run(context);

    expect(response.status).toBe(200);
  });

  it('renders the page when the branding lookup times out', async () => {
    const timeoutError = new DOMException('The operation timed out.', 'TimeoutError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeoutError));
    const context = contextFor('/tickets', { signedIn: true });

    const response = await run(context);

    expect(response.status).toBe(200);
  });

  it('sends a signed-out visitor to login without an account-status round trip', async () => {
    const fetchMock = accountDisabledFetch();
    vi.stubGlobal('fetch', fetchMock);
    const context = contextFor('/security', { signedIn: false });

    const response = await run(context);

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(
      withBase('/login?next=%2Fsecurity')
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

it.each(['/autopay/example-token', '/autopay/example-token/stop', '/autopay/return'])(
  '%s is private, anonymous, and read-only during GET', async pathname => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    try {
      const response = await run(contextFor(pathname, { signedIn: false }));
      expect(response.status).toBe(200);
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow, noarchive');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  },
);

it('/trust/<p>/<o> is public-cacheable only for a loaded 200; 404s, degraded shells and previews are no-store', async () => {
  const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
  const runWith = async (path: string, response: Response, trustCacheable: boolean) => {
    const context = contextFor(path, { signedIn: false });
    if (trustCacheable) (context.locals as { trustCacheable?: boolean }).trustCacheable = true;
    const out = await onRequest(context as never, () => Promise.resolve(response));
    if (!(out instanceof Response)) throw new Error('no Response');
    return out;
  };
  const html = () => new Response('<html>page</html>', { headers: { 'Content-Type': 'text/html' } });
  try {
    const page = await runWith('/trust/nw/acme', html(), true);
    expect(page.status).toBe(200);
    expect(page.headers.get('Cache-Control')).toBe('public, max-age=300, stale-while-revalidate=600');
    expect(page.headers.get('X-Frame-Options')).toBe('DENY');
    const notFound = await runWith('/trust/nw/acme', new Response('Not Found', { status: 404 }), true);
    expect(notFound.headers.get('Cache-Control')).toBe('no-store');
    const degraded = await runWith('/trust/nw/acme', html(), false);
    expect(degraded.headers.get('Cache-Control')).toBe('no-store');
    const preview = await run(contextFor('/trust/preview/abc', { signedIn: false }));
    expect(preview.headers.get('Cache-Control')).toBe('no-store');
    expect(preview.headers.get('X-Robots-Tag')).toBe('noindex, nofollow, noarchive');
    expect(preview.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(fetchMock).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});

it('W2: /trust/access/* token pages are never cached, never indexed and send no referrer, even on a loaded 200', async () => {
  const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
  try {
    for (const path of ['/trust/access/verify', '/trust/access/download']) {
      const context = contextFor(path, { signedIn: false });
      (context.locals as { trustCacheable?: boolean }).trustCacheable = true;
      const out = await onRequest(context as never, () => Promise.resolve(new Response('<html>ok</html>', { headers: { 'Content-Type': 'text/html' } })));
      if (!(out instanceof Response)) throw new Error('no Response');
      expect(out.headers.get('Cache-Control'), path).toBe('no-store');
      expect(out.headers.get('X-Robots-Tag'), path).toBe('noindex, nofollow, noarchive');
      expect(out.headers.get('Referrer-Policy'), path).toBe('no-referrer');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});

describe('W03a: /trust/embed/* framing carve-out', () => {
  const ORIGINS = ['https://example.com', 'https://www.example.org'];
  const html = () => new Response('<html>card</html>', { headers: { 'Content-Type': 'text/html' } });
  const runEmbed = async (path: string, response: Response, origins?: string[]) => {
    const context = contextFor(path, { signedIn: false });
    if (origins) (context.locals as { trustEmbedOrigins?: string[] }).trustEmbedOrigins = origins;
    const out = await onRequest(context as never, () => Promise.resolve(response));
    if (!(out instanceof Response)) throw new Error('no Response');
    return out;
  };
  const frameAncestors = (r: Response) => /(?:^|;)\s*frame-ancestors\s+([^;]*)/i.exec(r.headers.get('Content-Security-Policy') ?? '')?.[1]?.trim();
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('embed 200 with origins → CSP frame-ancestors lists them, no X-Frame-Options, no-store, noindex', async () => {
    vi.stubEnv('CSP_STRICT_DEV', '1');
    const out = await runEmbed('/trust/embed/nw/acme', html(), ORIGINS);
    expect(out.status).toBe(200);
    expect(frameAncestors(out)).toBe('https://example.com https://www.example.org');
    expect(out.headers.get('X-Frame-Options')).toBeNull();
    expect(out.headers.get('Cache-Control')).toBe('no-store');
    expect(out.headers.get('X-Robots-Tag')).toBe('noindex');
  });
  it('partner-home embed (/trust/embed/<p>) gets the same carve-out', async () => {
    vi.stubEnv('CSP_STRICT_DEV', '1');
    const out = await runEmbed('/trust/embed/nw', html(), ORIGINS);
    expect(frameAncestors(out)).toBe('https://example.com https://www.example.org');
    expect(out.headers.get('X-Frame-Options')).toBeNull();
  });
  it('embed 200 with origins but CSP deleted (dev without CSP_STRICT_DEV) → X-Frame-Options DENY kept', async () => {
    const out = await runEmbed('/trust/embed/nw/acme', html(), ORIGINS);
    expect(out.headers.get('Content-Security-Policy')).toBeNull();
    expect(out.headers.get('X-Frame-Options')).toBe('DENY');
    expect(out.headers.get('Cache-Control')).toBe('no-store');
  });
  it("embed 200 with no origins → frame-ancestors 'none' + XFO DENY + no-store", async () => {
    vi.stubEnv('CSP_STRICT_DEV', '1');
    for (const origins of [undefined, []]) {
      const out = await runEmbed('/trust/embed/nw/acme', html(), origins);
      expect(frameAncestors(out)).toBe("'none'");
      expect(out.headers.get('X-Frame-Options')).toBe('DENY');
      expect(out.headers.get('Cache-Control')).toBe('no-store');
    }
  });
  it("embed 404 → 'none' + DENY + no-store, even if origins were set", async () => {
    vi.stubEnv('CSP_STRICT_DEV', '1');
    const out = await runEmbed('/trust/embed/nw/acme', new Response('Not Found', { status: 404 }), ORIGINS);
    expect(frameAncestors(out)).toBe("'none'");
    expect(out.headers.get('X-Frame-Options')).toBe('DENY');
    expect(out.headers.get('Cache-Control')).toBe('no-store');
  });
  it("an origin that is not a normalized https origin fails closed ('none' + DENY)", async () => {
    vi.stubEnv('CSP_STRICT_DEV', '1');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await runEmbed('/trust/embed/nw/acme', html(), ["https://example.com; script-src *"]);
    expect(frameAncestors(out)).toBe("'none'");
    expect(out.headers.get('X-Frame-Options')).toBe('DENY');
  });
  it('the full page and the preview stay DENY even when origins leak into locals', async () => {
    vi.stubEnv('CSP_STRICT_DEV', '1');
    for (const path of ['/trust/nw/acme', '/trust/nw', '/trust/preview/abc']) {
      const out = await runEmbed(path, html(), ORIGINS);
      expect(out.headers.get('X-Frame-Options'), path).toBe('DENY');
      expect(frameAncestors(out), path).toBe("'none'");
    }
  });
});

