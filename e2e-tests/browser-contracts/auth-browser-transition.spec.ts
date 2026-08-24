import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const email = process.env.E2E_ADMIN_EMAIL ?? 'admin@breeze.local';
const password = process.env.E2E_ADMIN_PASSWORD ?? 'BreezeAdmin123!';
const testControlSecret = process.env.AUTH_TRANSITION_TEST_CONTROL_SECRET
  ?? 'local-auth-transition-test-control-v1';
const testSecretHeader = 'x-breeze-auth-transition-test-secret';
const testBarrierHeader = 'x-breeze-auth-transition-test-barrier';

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
  const barrierId = `late-issuer-${Date.now()}`;

  const lateIssuer = page.evaluate(async ({ csrf, barrierId, secret }) => {
    const response = await fetch('/api/v1/auth/refresh', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        'x-breeze-auth-transition': 'v1',
        'x-breeze-csrf': csrf,
        'x-breeze-auth-transition-test-barrier': barrierId,
        'x-breeze-auth-transition-test-secret': secret,
      },
      body: '{}',
    });
    return { status: response.status, body: await response.json() };
  }, { csrf: initial.csrf, barrierId, secret: testControlSecret });

  await expect.poll(async () => {
    const status = await context.request.get(
      `/api/v1/auth/__test/auth-transition/barriers/${barrierId}`,
      { headers: { [testSecretHeader]: testControlSecret } },
    );
    return status.status();
  }).toBe(200);

  const secondPage = await context.newPage();
  const logout = await context.request.post('/api/v1/auth/logout', {
    headers: {
      origin: new URL(page.url()).origin,
      authorization: `Bearer ${initial.accessToken}`,
      'content-type': 'application/json',
      'x-breeze-auth-transition': 'v1',
      'x-breeze-csrf': initial.csrf,
    },
    data: {},
  });
  expect(logout.status(), await logout.text()).toBe(200);
  await secondPage.close();

  const release = await context.request.post(
    `/api/v1/auth/__test/auth-transition/barriers/${barrierId}/release`,
    { headers: { [testSecretHeader]: testControlSecret } },
  );
  expect(release.status()).toBe(204);
  const late = await lateIssuer as { status: number; body: { tokens?: { accessToken?: string } } };
  expect(late.status).toBe(409);
  expect(late.body.tokens?.accessToken).toBeUndefined();

  const refresh = await context.request.post('/api/v1/auth/refresh', {
    headers: {
      origin: new URL(page.url()).origin,
      'content-type': 'application/json',
      'x-breeze-auth-transition': 'v1',
      'x-breeze-csrf': initial.csrf,
    },
    data: {},
  });
  expect(refresh.status()).toBe(401);

  const probe = await context.request.get('/api/v1/users/me', {
    headers: { authorization: `Bearer ${initial.accessToken}` },
  });
  expect(probe.status()).toBe(401);
});

test('CF completion succeeds without cookies and replay is inert', async ({ context, page }) => {
  const authority = await bootstrapAndLogin(context, page);
  const beforeCompletion = await context.request.get(
    '/api/v1/auth/__test/auth-transition/binding',
    { headers: { [testSecretHeader]: testControlSecret } },
  );
  expect(beforeCompletion.status()).toBe(200);
  const before = await beforeCompletion.json() as { id: string; generation: number };
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
  const afterCompletion = await context.request.get(
    '/api/v1/auth/__test/auth-transition/binding',
    { headers: { [testSecretHeader]: testControlSecret } },
  );
  expect(afterCompletion.status()).toBe(200);
  const after = await afterCompletion.json() as { id: string; generation: number };
  // Completion creates exactly one fresh successor row. A new row starts at
  // generation 1; replay must neither create another row nor advance it.
  expect(after.id).not.toBe(before.id);
  expect(after.generation).toBe(1);

  const replay = await context.request.get(completionUrl, { maxRedirects: 0 });
  // Completion is intentionally idempotent: a network/browser retry redirects
  // again, but must reinstall the same successor rather than rotate once more.
  expect(replay.status()).toBe(303);
  expect(await cookieValue(context, 'breeze_auth_binding')).toBe(successor);
  const afterReplay = await context.request.get(
    '/api/v1/auth/__test/auth-transition/binding',
    { headers: { [testSecretHeader]: testControlSecret } },
  );
  expect(afterReplay.status()).toBe(200);
  expect(await afterReplay.json()).toMatchObject({ id: after.id, generation: after.generation });
  expect((await context.cookies()).filter((cookie) => cookie.name === 'breeze_auth_binding'))
    .toHaveLength(1);
  expect((await context.cookies()).some((cookie) => cookie.name === 'breeze_refresh_token'))
    .toBe(false);
});
