import { test, expect } from '../fixtures';
import type { Page } from '@playwright/test';
import { clearRefreshState } from '../test-helpers';
import { RuntimeExtensionPage } from '../pages/RuntimeExtensionPage';

/**
 * Task 6 (Plan 03, runtime web extensions) — proves the whole activation
 * chain end to end against real dev servers: a signed extension's page,
 * sidebar nav entry, `device.detail.tabs@1` slot, and
 * `organization.settings.sections@1` slot all come up; the module loader
 * fetches ONLY the same-origin, digest-addressed asset URL; the served CSP
 * forbids `unsafe-eval`; a forged remote `moduleUrl` is refused before any
 * request reaches a foreign origin; and a platform-admin disable/re-enable
 * makes every contribution disappear/reappear without a restart.
 *
 * ── PREREQUISITES (this spec is environment-gated — see the report) ────────
 *
 * 1. A running dev stack reachable at `E2E_BASE_URL`/`.breeze-stack.json`
 *    (same baseline every other `e2e-tests/tests/*.spec.ts` file assumes —
 *    `global-setup.ts` already requires this to run ANY spec).
 *
 * 2. The `e2e-fixture` extension STAGED AND ACTIVE on that stack. Staging is
 *    NOT something this spec (or any Playwright spec) can do on its own:
 *    `reconcileExtensions()` — the only code path that turns an
 *    `extensions.yaml` entry into an active extension — runs ONLY at API
 *    boot (`apps/api/src/index.ts:1601`), never on a file-watch or a
 *    request. The recipe:
 *      a. `pnpm --filter @breeze/e2e-tests run stage:runtime-extension-fixture`
 *         — packs + signs the fixture with the real `@breeze/extension-cli`
 *         and prints the exact `breezectl extensions install` command plus
 *         the artifact URI/digest/publisher-key paths it needs.
 *      b. Run that `breezectl extensions install ...` command against your
 *         dev stack's `extensions.yaml` (`BREEZE_EXTENSIONS_CONFIG`).
 *      c. RESTART the API process so `reconcileExtensions()` picks it up.
 *      d. The extension starts DISABLED (`installed_extensions.enabled`
 *         defaults false on first observe — `stateStore.ts`); enable it
 *         once via `breezectl extensions enable e2e-fixture` (or let the
 *         first test below do it — see "fixture is staged" below).
 *
 * 3. `BREEZE_ADMIN_TOKEN` — a platform-admin access token (the SAME env var
 *    `breezectl` itself reads). The seeded E2E login user
 *    (`E2E_ADMIN_EMAIL`/`seedDefaultAdmin.ts`) is NOT granted
 *    `isPlatformAdmin` by any seed script in this repo, so the disable/
 *    enable calls below deliberately do NOT ride the browser's authed
 *    session — they use a separate `request.newContext()`-style call
 *    against `/api/v1/admin/extensions/...` with this bearer token, exactly
 *    the transport `breezectl extensions enable/disable` uses
 *    (`apps/api/scripts/breezectl.lib.ts`). Without it, this whole suite is
 *    skipped (see `test.skip` below) rather than failing on every test.
 *
 * ── A BLOCKER DISCOVERED WHILE WRITING THIS SPEC (not fixed here — see the
 *    Task 6 report's "Concerns" section) ─────────────────────────────────
 * `apps/api/src/extensions/hostDescriptor.ts:59` hardcodes
 * `HOST_DESCRIPTOR.webSdkVersion: undefined` — deliberately, per Task 2's
 * report ("out of scope per the task"). `checkExtensionCompatibility`
 * (`compatibility.ts:32-38`) unconditionally fails whenever a manifest sets
 * `requires.webSdk` (schema-mandatory the instant `manifest.web` is
 * present — `packages/extension-sdk/src/manifest.ts` superRefine) against
 * an `undefined` host version. Confirmed empirically against THIS fixture's
 * manifest with a throwaway vitest case during this task: `reasons ===
 * ["unsupported web SDK range *"]`. Concretely: step 2c above will reconcile
 * `e2e-fixture` straight to `lifecycleState: 'incompatible'` on the REAL,
 * currently-shipped `HOST_DESCRIPTOR` — this spec cannot go green against a
 * live stack until that one constant is fixed (mirror `HOST_SERVER_SDK_
 * VERSION`'s pattern: pin it to `packages/extension-web-sdk/package.json`'s
 * "version" and update `hostDescriptor.test.ts` accordingly). Left unfixed
 * here because it is outside this task's stated file scope
 * (`apps/api/src/extensions/*`, not `e2e-tests/*`).
 *
 * ── STOCK-IMAGE BUILD PROOF: DEFERRED TO PLAN 05 ────────────────────────────
 * This spec runs the fixture through the real packer/signer and a real dev
 * *server* process, but NOT a stock-built container image — that is Plan
 * 05's (Workspace conformance) job, which does the definitive stock-image
 * conformance anyway (recorded in the plan's "Plan Verification" checklist).
 */

const EXTENSION_NAME = 'e2e-fixture';
const DEVICE_ID = process.env.E2E_MACOS_DEVICE_ID ?? '42fc7de0-48f5-48f2-846b-6dd95924baf9';
const ADMIN_TOKEN = process.env.BREEZE_ADMIN_TOKEN;
const API_BASE_URL = (process.env.E2E_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');

async function setEnabled(
  request: import('@playwright/test').APIRequestContext,
  enabled: boolean,
): Promise<void> {
  const verb = enabled ? 'enable' : 'disable';
  const response = await request.post(
    `${API_BASE_URL}/api/v1/admin/extensions/${EXTENSION_NAME}/${verb}`,
    { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } },
  );
  expect(response.ok(), `admin ${verb} call failed: ${response.status()} ${await response.text()}`).toBeTruthy();
}

/** Reads the currently-selected org id out of `useOrgStore`'s persisted
 *  zustand state (`localStorage['breeze-org']`). The app auto-selects the
 *  first (and, in the seeded fixture DB, only) org on login/bootstrap — see
 *  `stores/orgStore.ts`'s `fetchOrganizations` — so polling for this after
 *  a page load is more robust than parsing it out of any particular UI
 *  affordance (the org-switcher `data-testid`s are keyed BY org id, which
 *  would make this circular). */
async function getCurrentOrgId(page: Page): Promise<string> {
  await page.waitForFunction(() => {
    try {
      const raw = window.localStorage.getItem('breeze-org');
      if (!raw) return false;
      const parsed = JSON.parse(raw) as { state?: { currentOrgId?: string | null } };
      return typeof parsed.state?.currentOrgId === 'string' && parsed.state.currentOrgId.length > 0;
    } catch {
      return false;
    }
  });
  return page.evaluate(() => {
    const parsed = JSON.parse(window.localStorage.getItem('breeze-org')!) as {
      state: { currentOrgId: string };
    };
    return parsed.state.currentOrgId;
  });
}

/** Collects every request URL issued by `page` from the moment this is
 *  called. Used both for the positive assertion (the module was fetched
 *  ONLY from `/api/v1/extensions/assets/...`) and the negative one (a
 *  forged remote `moduleUrl` never reaches the network at all). */
function trackRequestUrls(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (req) => urls.push(req.url()));
  return urls;
}

test.describe('Runtime extension activation + disable/enable (Task 6, Plan 03)', () => {
  test.describe.configure({ mode: 'serial' });

  test.skip(
    !ADMIN_TOKEN,
    'BREEZE_ADMIN_TOKEN not set — see this file\'s header comment for the staging prerequisite. ' +
      'This suite is environment-gated: no dev stack was reachable when Task 6 was authored.',
  );

  test.beforeEach(() => clearRefreshState());

  test('fixture is staged and enabled; page + nav + both slots render its content', async ({
    authedPage,
    request,
  }) => {
    const ext = new RuntimeExtensionPage(authedPage);

    // Make sure we start from a known state: enabled. (If staging left it
    // disabled — see header comment step 2d — this call brings it up; if
    // it's already enabled this is a harmless idempotent re-enable.)
    await setEnabled(request, true);

    const urls = trackRequestUrls(authedPage);

    // --- sidebar nav entry ---------------------------------------------
    await authedPage.goto('/');
    await ext.sidebarNavLink().waitFor();
    await ext.gotoViaSidebar();

    // --- page host --------------------------------------------------------
    await expect(ext.pageHeading()).toHaveText('E2E Fixture Extension');
    await expect(authedPage.getByTestId('e2e-fixture-page-extension-name')).toHaveText(EXTENSION_NAME);
    await expect(authedPage.getByTestId('e2e-fixture-page-path')).toHaveText('/');

    // --- module fetched ONLY from the digest-addressed asset route --------
    const assetRequests = urls.filter((u) => u.includes(`/api/v1/extensions/assets/${EXTENSION_NAME}/`));
    expect(assetRequests.length, 'expected the fixture module to be fetched at least once').toBeGreaterThan(0);
    const pageOrigin = new URL(authedPage.url()).origin;
    for (const url of urls) {
      // Every request this page issued must be same-origin. This is the
      // browser-level half of the loader's trust boundary
      // (apps/web/src/lib/extensions/registry.ts `assertSameOriginAssetUrl`)
      // — nothing this extension's presence caused was ever requested from
      // a foreign origin.
      expect(new URL(url).origin, `request to a foreign origin: ${url}`).toBe(pageOrigin);
    }

    // --- device.detail.tabs@1 slot -----------------------------------------
    await authedPage.goto(`/devices/${DEVICE_ID}`);
    await ext.openDeviceTab();
    await expect(ext.deviceTabRoot()).toBeVisible();
    await expect(authedPage.getByTestId('e2e-fixture-device-tab-device-id')).toHaveText(DEVICE_ID);

    // --- organization.settings.sections@1 slot ------------------------------
    const orgId = await getCurrentOrgId(authedPage);
    await ext.gotoOrgExtensionsSection(orgId);
    await expect(ext.orgSectionRoot()).toBeVisible();
    await expect(authedPage.getByTestId('e2e-fixture-org-section-org-id')).toHaveText(orgId);
  });

  test('served CSP forbids unsafe-eval and only allows script-src self (+ the one pinned Cloudflare host)', async ({
    authedPage,
  }) => {
    // Authoritative mechanism for a response actually served by `astro dev`
    // (which is what this spec targets — "Playwright proof ... against dev
    // servers"): `apps/web/src/middleware.ts` / `src/lib/csp.ts`, NOT
    // `astro.config.mjs`'s `security.csp`. Astro's own CSP feature is
    // meta-tag-only for prerendered routes and — per Astro's own docs
    // (`node_modules/astro/dist/types/public/config.d.ts` `security.csp`
    // doc comment) — "isn't supported while working in `dev` mode" at all;
    // confirmed by reading `core/app/dev/app.js`
    // (`shouldInjectCspMetaTags: false` for the dev app) and
    // `runtime/server/render/page.js` (the header-injection branch is only
    // reachable when `shouldInjectCspMetaTags` is true). So in `astro dev`,
    // ONLY `middleware.ts`'s hand-rolled header exists at all — and even
    // that is suppressed by default in dev
    // (`import.meta.env.DEV && !strictDevCsp` deletes the header entirely)
    // unless the dev server is run with `CSP_STRICT_DEV=1`. That is a
    // REQUIRED prerequisite for this test, not just for this spec: without
    // it there is no CSP header on the response to assert on at all.
    const response = await authedPage.goto(`/extensions/${EXTENSION_NAME}`);
    const csp = response?.headers()['content-security-policy'];
    expect(
      csp,
      'No Content-Security-Policy header on the response. Start the web dev server with ' +
        'CSP_STRICT_DEV=1 — astro.config.mjs\'s CSP is inert in `astro dev` (see comment above), ' +
        'and middleware.ts deletes the header entirely in dev unless this flag is set.',
    ).toBeTruthy();

    const scriptSrc = csp!.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src '));
    expect(scriptSrc, 'no script-src directive present').toBeTruthy();
    expect(scriptSrc).not.toContain('unsafe-eval');
    expect(scriptSrc).not.toContain('unsafe-inline');
    // "'self'" plus (at most) the one pinned Cloudflare Insights host —
    // never a wildcard, never another extension-controlled origin.
    const sources = scriptSrc!.split(/\s+/).slice(1);
    expect(sources).toContain("'self'");
    for (const source of sources) {
      expect(['\'self\'', 'https://static.cloudflareinsights.com']).toContain(source);
    }
  });

  test('SECURITY: a forged registry response advertising a remote moduleUrl is never fetched', async ({
    authedPage,
  }) => {
    const FORGED_ORIGIN = 'https://evil.example.test';
    const urls = trackRequestUrls(authedPage);

    await authedPage.route('**/api/v1/extensions/registry', async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as {
        extensions: { name: string; moduleUrl: string }[];
      };
      const forged = body.extensions.map((extension) =>
        extension.name === EXTENSION_NAME
          ? { ...extension, moduleUrl: `${FORGED_ORIGIN}/module.js` }
          : extension,
      );
      await route.fulfill({ response, json: { ...body, extensions: forged } });
    });

    const ext = new RuntimeExtensionPage(authedPage);
    await ext.goto();

    // The loader (`assertSameOriginAssetUrl`) throws SYNCHRONOUSLY before
    // any `import()` is attempted for a non-same-origin `moduleUrl` — so the
    // real content never mounts...
    await expect(ext.pageUnavailable()).toBeVisible();
    await expect(ext.pageRoot()).toHaveCount(0);

    // ...and, the point of this test: the browser never even ATTEMPTED to
    // reach the forged origin. Not "got blocked by CSP" (script-src 'self'
    // would also stop it) — never requested at all, because the loader's
    // same-origin check runs before any fetch/import is issued.
    const requestedForgedOrigin = urls.some((url) => {
      try {
        return new URL(url).origin === FORGED_ORIGIN;
      } catch {
        return false;
      }
    });
    expect(requestedForgedOrigin).toBe(false);

    await authedPage.unroute('**/api/v1/extensions/registry');
  });

  test('disable removes the nav entry, page, and both slot contributions without a restart', async ({
    authedPage,
    request,
  }) => {
    const ext = new RuntimeExtensionPage(authedPage);
    // `getCurrentOrgId` reads `localStorage` on the APP's origin — a fresh
    // `authedPage` starts at `about:blank`, so a navigation must happen
    // first or the wait below would poll a foreign/empty storage forever.
    await authedPage.goto('/');
    const orgId = await getCurrentOrgId(authedPage);

    await setEnabled(request, false);

    // The client has no server push for this (Task 4's documented design:
    // "nothing dispatches refresh-registry on admin-disable" —
    // progress.md's Task 4 Medium finding) — a disable takes effect on the
    // client's NEXT registry fetch, i.e. next navigation/reload, exactly
    // like the server's own live enabled-recheck philosophy.
    await authedPage.goto('/');
    await expect(ext.sidebarNavLink()).toHaveCount(0);

    await authedPage.goto(`/extensions/${EXTENSION_NAME}`);
    await expect(ext.pageNotFound()).toBeVisible();

    await authedPage.goto(`/devices/${DEVICE_ID}`);
    await expect(ext.deviceTabButton()).toHaveCount(0);

    await ext.gotoOrgExtensionsSection(orgId);
    await expect(ext.orgSectionRoot()).toHaveCount(0);
  });

  test('re-enable restores the nav entry, page, and both slot contributions', async ({
    authedPage,
    request,
  }) => {
    const ext = new RuntimeExtensionPage(authedPage);
    await authedPage.goto('/');
    const orgId = await getCurrentOrgId(authedPage);

    await setEnabled(request, true);

    await authedPage.goto('/');
    await ext.sidebarNavLink().waitFor();

    await ext.goto();
    await expect(ext.pageHeading()).toHaveText('E2E Fixture Extension');

    await authedPage.goto(`/devices/${DEVICE_ID}`);
    await ext.openDeviceTab();
    await expect(ext.deviceTabRoot()).toBeVisible();

    await ext.gotoOrgExtensionsSection(orgId);
    await expect(ext.orgSectionRoot()).toBeVisible();
  });
});
