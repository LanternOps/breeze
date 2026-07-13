import { expect, test, type BrowserContext, type Route } from '@playwright/test';

const APP_ORIGIN = 'https://example.com';
const IDP_ORIGIN = 'https://example.org';
const COOKIE_NAME = 'breeze_csrf_token';
const C1 = 'a'.repeat(64);
const C2 = 'b'.repeat(64);
const TICKET = 'signed.ticket.with.secret.correlation';

type SameSiteMode = 'Strict' | 'Lax' | 'None';

async function installC1(context: BrowserContext, sameSite: SameSiteMode): Promise<void> {
  await context.addCookies([{
    name: COOKIE_NAME,
    value: C1,
    domain: 'example.com',
    path: '/api/v1/auth',
    httpOnly: false,
    secure: true,
    sameSite,
  }]);
}

test.describe('durable terminal logout browser contract', () => {
  for (const sameSite of ['Strict', 'Lax', 'None'] as const) {
    test(`cross-origin completion is cookie-independent with SameSite=${sameSite}`, async ({ browser }) => {
      const context = await browser.newContext();
      await installC1(context, sameSite);

      let completionCount = 0;
      let completionCookie = '';
      let landingStoredBinding = '';
      const referrers: string[] = [];

      await context.route('**/*', async (route: Route) => {
        const request = route.request();
        const url = new URL(request.url());
        referrers.push(request.headers().referer ?? '');

        if (url.origin === IDP_ORIGIN) {
          await route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: `<script>location.replace(${JSON.stringify(
              `${APP_ORIGIN}/api/v1/auth/cf-access-logout/complete?ticket=${encodeURIComponent(TICKET)}`,
            )})</script>`,
          });
          return;
        }

        if (url.origin === APP_ORIGIN && url.pathname === '/api/v1/auth/cf-access-logout/complete') {
          completionCount += 1;
          if (completionCount === 1) completionCookie = request.headers().cookie ?? '';
          await route.fulfill({
            status: 200,
            contentType: 'text/html',
            headers: completionCount === 1
              ? {
                  'cache-control': 'no-store',
                  'referrer-policy': 'no-referrer',
                  'set-cookie': `${COOKIE_NAME}=${C2}; Path=/api/v1/auth; SameSite=${sameSite}; Secure`,
                }
              : {
                  'cache-control': 'no-store',
                  'referrer-policy': 'no-referrer',
                },
            body: '<script>location.replace("/login?signedOut=1")</script>',
          });
          return;
        }

        if (url.origin === APP_ORIGIN && url.pathname === '/login') {
          const cookies = await context.cookies(`${APP_ORIGIN}/api/v1/auth/`);
          landingStoredBinding = cookies.find((cookie) => cookie.name === COOKIE_NAME)?.value ?? '';
          await route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: '<!doctype html><title>Signed out</title>',
          });
          return;
        }

        await route.abort('failed');
      });

      const page = await context.newPage();
      const completionUrl = `${APP_ORIGIN}/api/v1/auth/cf-access-logout/complete?ticket=${encodeURIComponent(TICKET)}`;
      await page.goto(`${IDP_ORIGIN}/cdn-cgi/access/logout?returnTo=${encodeURIComponent(completionUrl)}`);

      await expect(page).toHaveURL(`${APP_ORIGIN}/login?signedOut=1`);
      expect(completionCount).toBe(1);
      expect(landingStoredBinding).toBe(C2);
      expect(referrers.every((value) => !value.includes(TICKET))).toBe(true);

      if (sameSite === 'Strict') {
        expect(completionCookie).not.toContain(`${COOKIE_NAME}=${C1}`);
      }

      const installed = await context.cookies(`${APP_ORIGIN}/api/v1/auth/`);
      expect(installed.find((cookie) => cookie.name === COOKIE_NAME)?.value).toBe(C2);

      await page.goto(completionUrl);
      await expect(page).toHaveURL(`${APP_ORIGIN}/login?signedOut=1`);
      expect(completionCount).toBe(2);
      const replayCookies = await context.cookies(`${APP_ORIGIN}/api/v1/auth/`);
      expect(replayCookies.find((cookie) => cookie.name === COOKIE_NAME)?.value).toBe(C2);

      await context.close();
    });
  }
});
