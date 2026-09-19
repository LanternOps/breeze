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
