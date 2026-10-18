// Network Proxy dedicated tunnel origin (#8155 W03, plan Task 15).
// Run with playwright.tunnel-origin.config.ts against a worktree stack; its
// global setup turns host mode on and opts the seeded partner in.
//
// The seeded device has no connected agent, so an AUTHENTICATED device request
// ends at the bridge gate (502 "Bridge agent offline") — never 401. That 502
// is the proof the host-mode cookie stuck and every auth step passed.
import type { Page, Response } from '@playwright/test';
import { expect, test } from '../fixtures';
import {
  appBaseUrl,
  setPartnerTunnelOriginOptIn,
  seedProxyTunnel,
  tunnelHost,
  tunnelStatus,
  TUNNEL_SUFFIX,
} from '../helpers/tunnelOriginStack';

const HOST_SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads';

const onTunnel = (id: string, pathname: string) => (r: Response) => {
  const u = new URL(r.url());
  return u.hostname === tunnelHost(id) && u.pathname === pathname;
};

async function openProxyPage(page: Page, id: string): Promise<void> {
  await page.goto(`/remote/proxy/${id}?target=192.0.2.10:80`);
}

test('the iframe loads from the tunnel origin with the host-mode sandbox and authenticates', async ({ authedPage: page }) => {
  const id = seedProxyTunnel();
  const enter = page.waitForResponse(onTunnel(id, '/__bz/enter'));
  const ping = page.waitForResponse(onTunnel(id, '/__bz/ping'));
  const root = page.waitForResponse(onTunnel(id, '/'));
  await openProxyPage(page, id);

  const frame = page.getByTestId('network-proxy-frame');
  await expect(frame).toHaveAttribute('data-proxy-mode', 'host');
  await expect(frame).toHaveAttribute('sandbox', HOST_SANDBOX);
  const src = new URL((await frame.getAttribute('src'))!);
  expect(src.hostname).toBe(tunnelHost(id));
  expect(src.pathname).toBe('/__bz/enter');
  expect([...src.searchParams.keys()]).toEqual(['t']);

  expect((await enter).status()).toBe(200);
  // The partitioned __Host-bzt cookie came back on the same-origin ping...
  expect((await ping).status()).toBe(204);
  // ...and the device page passed auth, admission and every gate up to the bridge.
  const device = await root;
  expect(device.status()).toBe(502);
  expect(await device.text()).toBe('Bridge agent offline');
  expect(device.headers()['content-security-policy']).toMatch(/^frame-ancestors http:\/\/app\.localhost:\d+ 'self'$/);
  // The exchange activated the session; nothing told the user to open a tab.
  expect(tunnelStatus(id)).toBe('active');
  await expect(page.getByTestId('proxy-cookie-blocked-notice')).toHaveCount(0);
});

test('Open in New Tab opens a top-level tunnel tab with its own tab ticket and no opener', async ({ authedPage: page }) => {
  const id = seedProxyTunnel();
  await openProxyPage(page, id);
  const frame = page.getByTestId('network-proxy-frame');
  await expect(frame).toHaveAttribute('data-proxy-mode', 'host');
  const frameSrc = await frame.getAttribute('src');

  const tabTicket = page.waitForResponse((r) =>
    new URL(r.url()).pathname === `/api/v1/tunnels/${id}/http-ticket` && new URL(r.url()).searchParams.get('mode') === 'tab');
  const popupPromise = page.context().waitForEvent('page');
  await page.getByTestId('proxy-open-new-tab').click();
  expect((await tabTicket).status()).toBe(200);
  const popup = await popupPromise;

  const root = await popup.waitForResponse(onTunnel(id, '/'));
  expect(root.status()).toBe(502);
  // The bootstrap page navigates to `/` itself; wait for that commit before evaluating.
  await popup.waitForURL((u) => u.hostname === tunnelHost(id) && u.pathname === '/');
  await popup.waitForLoadState('domcontentloaded');
  expect(await popup.evaluate(() => window.opener)).toBeNull();
  // The iframe keeps its own (frame) ticket.
  await expect(frame).toHaveAttribute('src', frameSrc!);
  await popup.close();
});

test('Close shows Disconnected only after the DELETE succeeds', async ({ authedPage: page }) => {
  const id = seedProxyTunnel();
  await openProxyPage(page, id);
  await expect(page.getByTestId('network-proxy-frame')).toBeVisible();

  const closeRoute = `**/api/v1/tunnels/${id}`;
  await page.route(closeRoute, (route) => (route.request().method() === 'DELETE'
    ? route.fulfill({ status: 500, body: '{"error":"boom"}', contentType: 'application/json' })
    : route.continue()));
  await page.getByTestId('proxy-close').click();
  // runAction's error toast — visible only because the page now mounts a toast host.
  await expect(page.getByTestId('toast-container')).toContainText('boom');
  await expect(page.getByTestId('proxy-close')).toBeEnabled();
  await expect(page.getByTestId('proxy-session-expired-overlay')).toHaveCount(0);
  expect(tunnelStatus(id)).not.toBe('disconnected');

  await page.unroute(closeRoute);
  await page.getByTestId('proxy-close').click();
  await expect(page.getByTestId('proxy-session-expired-overlay')).toBeVisible();
  expect(tunnelStatus(id)).toBe('disconnected');
});

test('a tunnel host never serves app, web or portal routes', async ({ authedPage: page }) => {
  // Browser navigation, not the Node request context: Node's resolver is not
  // guaranteed to map *.localhost to loopback; Chromium/Firefox do.
  const id = seedProxyTunnel();
  const port = new URL(appBaseUrl()).port;
  for (const pathname of ['/api/v1/auth/me', '/login', '/portal/login', '/settings/partner']) {
    const res = (await page.goto(`http://${tunnelHost(id)}:${port}${pathname}`))!;
    // No ticket, no cookie: the tunnel surface's own 401, never the app's.
    expect(res.status(), pathname).toBe(401);
    expect(await res.text(), pathname).toBe('Unauthorized');
    expect(res.headers()['content-type'], pathname).toMatch(/^text\/plain/);
    expect(res.headers()['content-security-policy'], pathname).toMatch(/^frame-ancestors /);
    expect(res.headers()['cache-control'], pathname).toBe('no-store');
  }
  // Tunnel-domain hosts that miss the wildcards are refused at the edge.
  for (const host of [TUNNEL_SUFFIX, `a.b.c.${TUNNEL_SUFFIX}`]) {
    const res = (await page.goto(`http://${host}:${port}/`))!;
    expect(res.status(), host).toBe(421);
  }
});

test('a partner that opts out gets path mode on the next session', async ({ authedPage: page }) => {
  try {
    // The Partner Settings toggle (plan Task 13b), saved by the page Save.
    await page.goto('/settings/partner#remote-access');
    const toggle = page.getByTestId('partner-network-proxy-dedicated-origin');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    const saved = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/orgs/partners/me' && r.request().method() === 'PATCH');
    await page.getByRole('button', { name: /save settings/i }).click();
    expect((await saved).status()).toBe(200);

    const id = seedProxyTunnel();
    await openProxyPage(page, id);
    const frame = page.getByTestId('network-proxy-frame');
    await expect(frame).toHaveAttribute('data-proxy-mode', 'path');
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-forms allow-popups');
    expect(new URL((await frame.getAttribute('src'))!).pathname).toBe(`/api/v1/tunnel-http/${id}/`);
  } finally {
    setPartnerTunnelOriginOptIn(true);
  }
});

test('a browser that refuses the iframe cookie gets the new-tab notice @3pc-blocked', async ({ authedPage: page }) => {
  const id = seedProxyTunnel();
  const ping = page.waitForResponse(onTunnel(id, '/__bz/ping'));
  await openProxyPage(page, id);
  await expect(page.getByTestId('network-proxy-frame')).toHaveAttribute('data-proxy-mode', 'host');
  // The third-party cookie was refused, so the same-origin ping is unauthenticated.
  expect((await ping).status()).toBe(401);

  // The bootstrap page's postMessage reached the app (exact frame-ancestor
  // target, this iframe's window, this tunnel) and the app offers a new tab.
  const notice = page.getByTestId('proxy-cookie-blocked-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute('data-reason', 'cookie');

  // The top-level tab is first-party, so it works where the iframe could not.
  const popupPromise = page.context().waitForEvent('page');
  await page.getByTestId('proxy-cookie-blocked-open-new-tab').click();
  const popup = await popupPromise;
  const root = await popup.waitForResponse(onTunnel(id, '/'));
  expect(root.status()).toBe(502);
  await popup.close();
});
