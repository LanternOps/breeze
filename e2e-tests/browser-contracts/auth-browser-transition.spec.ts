import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const email = process.env.E2E_ADMIN_EMAIL ?? 'admin@breeze.local';
const password = process.env.E2E_ADMIN_PASSWORD ?? 'BreezeAdmin123!';

type LoginAuthority = Readonly<{ accessToken: string; csrf: string }>;

async function cookieValue(context: BrowserContext, name: string): Promise<string> {
  const cookie = (await context.cookies()).find((entry) => entry.name === name);
  if (!cookie?.value) throw new Error(`Missing ${name} cookie`);
  return cookie.value;
}

async function bootstrapAndLogin(context: BrowserContext, page: Page): Promise<LoginAuthority> {
  await page.goto('/health');
  const bootstrap = await context.request.post('/api/v1/auth/browser-binding/bootstrap', {
    headers: { Origin: new URL(page.url()).origin },
  });
  expect(bootstrap.status()).toBe(204);

  const login = await context.request.post('/api/v1/auth/login', {
    headers: {
      'content-type': 'application/json',
      'x-breeze-auth-transition': 'v1',
    },
    data: { email, password },
  });
  expect(login.status()).toBe(200);
  const body = await login.json() as { tokens?: { accessToken?: string } };
  const accessToken = body.tokens?.accessToken;
  if (!accessToken) throw new Error('Login response omitted access token');
  return { accessToken, csrf: await cookieValue(context, 'breeze_csrf_token') };
}

test.describe.configure({ mode: 'serial' });

test('late pre-logout issuer response cannot restore authority', async ({ context, page }) => {
  const initial = await bootstrapAndLogin(context, page);
  let releaseIssuer!: () => void;
  const issuerRelease = new Promise<void>((resolve) => { releaseIssuer = resolve; });
  let issuerFinalized!: (status: number) => void;
  const issuerReady = new Promise<number>((resolve) => { issuerFinalized = resolve; });

  await page.route('**/api/v1/auth/refresh', async (route) => {
    const upstream = await route.fetch();
    issuerFinalized(upstream.status());
    await issuerRelease;
    await route.fulfill({ response: upstream });
  });

  const lateIssuer = page.evaluate(async (csrf) => {
    const response = await fetch('/api/v1/auth/refresh', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        'x-breeze-auth-transition': 'v1',
        'x-breeze-csrf': csrf,
      },
      body: '{}',
    });
    return { status: response.status, body: await response.json() };
  }, initial.csrf);

  await expect(issuerReady).resolves.toBe(200);
  // route.fetch() has completed the upstream refresh before its response is
  // released to page JavaScript. Playwright may already have applied the
  // upstream Set-Cookie headers to the shared context, so read the live CSRF
  // cookie for the independent logout request.
  const logoutCsrf = await cookieValue(context, 'breeze_csrf_token');
  const secondPage = await context.newPage();
  const logout = await context.request.post('/api/v1/auth/logout', {
    headers: {
      origin: new URL(page.url()).origin,
      authorization: `Bearer ${initial.accessToken}`,
      'content-type': 'application/json',
      'x-breeze-auth-transition': 'v1',
      'x-breeze-csrf': logoutCsrf,
    },
    data: {},
  });
  expect(logout.status(), await logout.text()).toBe(200);
  await secondPage.close();

  releaseIssuer();
  const late = await lateIssuer as { status: number; body: { tokens?: { accessToken?: string } } };
  expect(late.status).toBe(200);
  const lateAccess = late.body.tokens?.accessToken;
  expect(lateAccess).toBeTruthy();

  const restoredCsrf = await cookieValue(context, 'breeze_csrf_token');
  const refresh = await context.request.post('/api/v1/auth/refresh', {
    headers: {
      origin: new URL(page.url()).origin,
      'content-type': 'application/json',
      'x-breeze-auth-transition': 'v1',
      'x-breeze-csrf': restoredCsrf,
    },
    data: {},
  });
  expect(refresh.status()).toBe(401);

  const probe = await context.request.get('/api/v1/users/me', {
    headers: { authorization: `Bearer ${lateAccess}` },
  });
  expect(probe.status()).toBe(401);
});

test('CF completion succeeds without cookies and replay is inert', async ({ context, page }) => {
  const authority = await bootstrapAndLogin(context, page);
  const prepared = await context.request.post('/api/v1/auth/cf-access-logout/prepare', {
    headers: {
      origin: new URL(page.url()).origin,
      authorization: `Bearer ${authority.accessToken}`,
      'content-type': 'application/json',
      'x-breeze-auth-transition': 'v1',
      'x-breeze-csrf': authority.csrf,
    },
    data: {},
  });
  expect(prepared.status()).toBe(200);
  const { navigationUrl } = await prepared.json() as { navigationUrl: string };
  const ticket = new URL(navigationUrl, page.url()).searchParams.get('ticket');
  expect(ticket).toBeTruthy();

  await context.clearCookies();
  const navigation = await context.request.get(navigationUrl, { maxRedirects: 0 });
  expect(navigation.status()).toBe(302);
  expect(navigation.headers().location).toContain('/cdn-cgi/access/logout?returnTo=');

  const completionUrl = `/api/v1/auth/cf-access-logout/complete?ticket=${encodeURIComponent(ticket!)}`;
  const completion = await context.request.get(completionUrl, { maxRedirects: 0 });
  expect(completion.status()).toBe(303);
  const successor = await cookieValue(context, 'breeze_auth_binding');

  const replay = await context.request.get(completionUrl, { maxRedirects: 0 });
  // Completion is intentionally idempotent: a network/browser retry redirects
  // again, but must reinstall the same successor rather than rotate once more.
  expect(replay.status()).toBe(303);
  expect(await cookieValue(context, 'breeze_auth_binding')).toBe(successor);
  expect((await context.cookies()).filter((cookie) => cookie.name === 'breeze_auth_binding'))
    .toHaveLength(1);
  expect((await context.cookies()).some((cookie) => cookie.name === 'breeze_refresh_token'))
    .toBe(false);
});
