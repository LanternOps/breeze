import type { APIRequestContext, BrowserContext, Page, Request } from '@playwright/test';
import { test, expect } from '../fixtures';
import { clearRefreshState } from '../test-helpers';
import { persistStorageState } from '../auth-state';
import { PartnerAiModelsPage } from '../pages/PartnerAiModelsPage';
import { ScriptAuthoringPage } from '../pages/ScriptAuthoringPage';

/**
 * AI Providers & Models (W04, #7602): the browser slice of the registry UI.
 *
 * Needs at least two enabled, tool-capable platform offerings for the e2e
 * partner; `seedE2eFixtures` adds them through the registry services
 * (ensurePartnerCutover → ensurePlatformOffering), never raw SQL.
 *
 * ONE browser context for the whole file, not the per-test `authedPage`
 * fixture: reloads rotate the shared storageState's refresh token, so a second
 * test's fresh context would replay a stale cookie and trip the API's family
 * reuse-detection (same shape as partner-sending-domains.spec.ts).
 */
test.describe.configure({ mode: 'serial', timeout: 180_000 });
test.beforeEach(clearRefreshState);

/** The app's own bearer token, lifted off one of its API calls (never minted: a refresh would rotate the cookie). */
async function readAccessToken(page: Page): Promise<string> {
  let token: string | null = null;
  const onRequest = (req: Request) => {
    const header = req.headers()['authorization'];
    if (!token && header?.startsWith('Bearer ') && req.url().includes('/api/v1/')) token = header.slice(7);
  };
  page.on('request', onRequest);
  try {
    await page.goto('/');
    await expect.poll(() => token, { message: 'an authenticated /api/v1 request', timeout: 30_000 }).toBeTruthy();
  } finally {
    page.off('request', onRequest);
  }
  return token!;
}

async function firstOrgId(request: APIRequestContext, token: string): Promise<string> {
  const res = await request.get('/api/v1/orgs/organizations', { headers: { authorization: `Bearer ${token}` } });
  expect(res.ok(), `GET organizations → ${res.status()}`).toBeTruthy();
  const body = (await res.json()) as { data?: Array<{ id: string; slug?: string; name?: string }> };
  // The seed's baseline org (db/seed.ts): selected by slug/name, never by list order.
  const seeded = body.data?.find((o) => o.slug === 'default-organization' || o.name === 'Default Organization');
  const id = seeded?.id;
  expect(id, 'the seeded Default Organization').toBeTruthy();
  return id as string;
}

const isEnabledPost = (r: { request(): { method(): string }; url(): string }) =>
  r.request().method() === 'POST' && /\/ai\/models\/offerings\/[^/]+\/enabled$/.test(new URL(r.url()).pathname);

test.describe('AI Providers & Models', () => {
  let ctx: BrowserContext;
  let authedPage: Page;
  let models: PartnerAiModelsPage;

  test.beforeAll(async ({ browser, workerStorageState }) => {
    ctx = await browser.newContext({ storageState: workerStorageState });
    authedPage = await ctx.newPage();
    models = new PartnerAiModelsPage(authedPage);
  });
  test.afterAll(async ({ workerStorageState }) => {
    if (ctx) await persistStorageState(ctx, workerStorageState);
    await ctx?.close();
  });

  test('1. the tab renders under the new name', async () => {
    await models.goto();
    await expect(models.tab()).toContainText('AI Providers & Models');
    await expect(models.connectionRow(null)).toBeVisible();
  });

  test('2. enabling and disabling a platform model autosaves', async () => {
    await models.goto();
    // Prefer an offering that is no surface's default, so the disable needs no
    // confirmation. If every enabled offering is some default, fall back to the
    // confirm path (submit it) so the POST still fires deterministically.
    const defaults = new Set(
      await authedPage.locator('[data-testid^="ai-defaults-default-"]').evaluateAll(
        (els) => els.map((e) => (e as HTMLSelectElement).value).filter(Boolean),
      ),
    );
    const switches = models.anyOfferingEnable();
    const count = await switches.count();
    const enabledKeys: string[] = [];
    for (let i = 0; i < count; i += 1) {
      if (!(await switches.nth(i).isChecked())) continue;
      enabledKeys.push(((await switches.nth(i).getAttribute('data-testid')) ?? '').replace('ai-offering-enable-', ''));
    }
    const key = enabledKeys.find((k) => !defaults.has(k)) ?? enabledKeys[0];
    expect(key, 'a seeded enabled platform offering').toBeTruthy();

    // A controlled checkbox follows the server snapshot, so click and assert.
    const [off] = await Promise.all([
      authedPage.waitForResponse(isEnabledPost),
      (async () => {
        await models.offeringEnable(key).click();
        if (defaults.has(key)) {
          await expect(models.offeringDisableConfirm()).toBeVisible();
          await authedPage.getByTestId('ai-offering-disable-confirm-submit').click();
        }
      })(),
    ]);
    expect(off.status()).toBe(200);
    await authedPage.reload();
    await models.root().waitFor();
    await expect(models.offeringEnable(key)).not.toBeChecked();

    const [on] = await Promise.all([authedPage.waitForResponse(isEnabledPost), models.offeringEnable(key).click()]);
    expect(on.status()).toBe(200);
    await authedPage.reload();
    await models.root().waitFor();
    await expect(models.offeringEnable(key)).toBeChecked();
  });

  test('3. disabling a model a feature defaults to asks first and lists the feature', async () => {
    await models.goto();
    const chatDefault = await models.defaultsSelect('chat').inputValue();
    expect(chatDefault, 'the seeded chat default').not.toBe('');
    await models.offeringEnable(chatDefault).click();
    await expect(models.offeringDisableConfirm()).toBeVisible();
    await expect(models.offeringDisableConfirmSurfaces()).toContainText('Chat');
    // ConfirmDialog's Cancel button carries no testid; Escape is the same onClose.
    await authedPage.keyboard.press('Escape');
    await expect(models.offeringDisableConfirm()).toBeHidden();
    await expect(models.offeringEnable(chatDefault)).toBeChecked();
  });

  test('4. the offering drawer saves the premium flag', async () => {
    await models.goto();
    const key = await models.defaultsSelect('chat').inputValue();
    const premium = async () => {
      await models.offeringEdit(key).click();
      await expect(models.offeringDrawer()).toBeVisible();
    };
    await premium();
    const wasPremium = await models.offeringPremium().isChecked();
    if (wasPremium) await models.offeringPremium().uncheck(); else await models.offeringPremium().check();
    const [response] = await Promise.all([
      authedPage.waitForResponse((r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname.endsWith(`/ai/models/offerings/${key}`)),
      models.offeringSave().click(),
    ]);
    expect(response.status()).toBe(200);
    await authedPage.reload();
    await models.root().waitFor();
    await premium();
    if (wasPremium) await expect(models.offeringPremium()).not.toBeChecked();
    else await expect(models.offeringPremium()).toBeChecked();
    // Leave the fixture as found.
    if (wasPremium) await models.offeringPremium().check(); else await models.offeringPremium().uncheck();
    await Promise.all([
      authedPage.waitForResponse((r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname.endsWith(`/ai/models/offerings/${key}`)),
      models.offeringSave().click(),
    ]);
  });

  test('5. defaults by feature persist', async () => {
    await models.goto();
    const select = models.defaultsSelect('catalog_enrichment');
    const current = await select.inputValue();
    const options = await select.locator('option').evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value).filter(Boolean));
    const other = options.find((v) => v !== current);
    expect(other, 'a second enabled offering to switch to').toBeTruthy();
    await select.selectOption(other as string);
    const [response] = await Promise.all([
      authedPage.waitForResponse((r) => r.request().method() === 'PUT' && new URL(r.url()).pathname.endsWith('/ai/models/assignments')),
      models.defaultsSave().click(),
    ]);
    expect(response.status()).toBe(200);
    await authedPage.reload();
    await models.root().waitFor();
    await expect(models.defaultsSelect('catalog_enrichment')).toHaveValue(other as string);
    // Leave the fixture as found.
    await models.defaultsSelect('catalog_enrichment').selectOption(current);
    await Promise.all([
      authedPage.waitForResponse((r) => r.request().method() === 'PUT' && new URL(r.url()).pathname.endsWith('/ai/models/assignments')),
      models.defaultsSave().click(),
    ]);
  });

  test('6. requiring residency asks for confirmation and cancel changes nothing', async () => {
    await models.goto();
    let puts = 0;
    authedPage.on('request', (r) => {
      if (r.method() === 'PUT' && new URL(r.url()).pathname.endsWith('/ai/models/residency')) puts += 1;
    });
    await expect(models.residencySwitch()).not.toBeChecked();
    // The switch is controlled by the server snapshot: click, then assert.
    await models.residencySwitch().click();
    const confirm = models.residencyConfirm();
    // Either the impact preview needs confirming, or it was empty and it saved.
    await expect(confirm.or(authedPage.locator('[data-testid="ai-residency-switch"]:checked'))).toBeVisible();
    if (await confirm.isVisible()) {
      await models.residencyConfirmCancel().click();
      await expect(confirm).toBeHidden();
      await expect(models.residencySwitch()).not.toBeChecked();
      expect(puts).toBe(0);
    } else {
      // No impact: it saved directly. Restore the fixture (residency off).
      await expect(models.residencySwitch()).toBeChecked();
      await models.residencySwitch().click();
      await expect(models.residencySwitch()).not.toBeChecked();
    }
  });

  test('7. an organization overrides the partner defaults', async () => {
    const orgId = await firstOrgId(authedPage.request, await readAccessToken(authedPage));
    await authedPage.goto(`/settings/organizations/${orgId}#ai`);
    const card = authedPage.getByTestId('org-model-defaults-card');
    await expect(card).toBeVisible();
    await expect(authedPage.getByTestId('org-model-defaults-inherited-chat')).toContainText('partner default');
    const lock = authedPage.getByTestId('org-model-defaults-lock-choice-chat');
    const was = await lock.isChecked();
    await lock.click(); // controlled by the draft state: click, then assert
    if (was) await expect(lock).not.toBeChecked(); else await expect(lock).toBeChecked();
    const [response] = await Promise.all([
      authedPage.waitForResponse((r) => r.request().method() === 'PUT' && new URL(r.url()).pathname.endsWith(`/ai/models/orgs/${orgId}/assignments`)),
      authedPage.getByTestId('org-model-defaults-save').click(),
    ]);
    expect(response.status()).toBe(200);
    await authedPage.reload();
    await expect(authedPage.getByTestId('org-model-defaults-card')).toBeVisible();
    if (was) await expect(lock).not.toBeChecked(); else await expect(lock).toBeChecked();
    // Leave the fixture as found.
    await lock.click();
    await Promise.all([
      authedPage.waitForResponse((r) => r.request().method() === 'PUT' && new URL(r.url()).pathname.endsWith(`/ai/models/orgs/${orgId}/assignments`)),
      authedPage.getByTestId('org-model-defaults-save').click(),
    ]);
  });

  test('8. the legacy script-reviewer field points to the registry', async () => {
    const authoring = new ScriptAuthoringPage(authedPage);
    await authoring.goto();
    await expect(authedPage.getByTestId('model-defaults-link-script_reviewer').first()).toBeVisible();
    await expect(authedPage.getByTestId('script-reviewer-model')).toHaveCount(0);
  });
});
