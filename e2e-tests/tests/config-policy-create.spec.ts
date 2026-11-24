import { test, expect } from '../fixtures';
import type { Browser, BrowserContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigPolicyPage } from '../pages/ConfigPolicyPage';

// #12471 (plan W03d, feature #12462 W3): one-page create, inactive until
// activated, the owner default per caller, and the list filtered by where a
// policy applies. Needs the W03a API (read scoping, list filters, `access`).
//
// Callers: the seeded admin (a partner user with access to every
// organization), plus two users seed-config-policy-create.sql adds in the same
// partner: a partner user limited to one organization, and an Org Admin of it.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIMITED_EMAIL = 'cp-limited@breeze.local';
const ORG_EMAIL = 'cp-org@breeze.local';

function pgContainer(): string {
  if (process.env.E2E_PG_CONTAINER) return process.env.E2E_PG_CONTAINER;
  const p = process.env.E2E_STACK_FILE ?? path.resolve(__dirname, '../..', '.breeze-stack.json');
  if (existsSync(p)) {
    const d = JSON.parse(readFileSync(p, 'utf8'));
    if (d.pgContainer) return d.pgContainer;
  }
  return 'breeze-postgres';
}

function seedUsers(): { orgId: string } {
  const out = execFileSync(
    'docker',
    ['exec', '-i', pgContainer(), 'psql', '-U', 'breeze', '-d', 'breeze', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { encoding: 'utf8', input: readFileSync(path.resolve(__dirname, '..', 'seed-config-policy-create.sql'), 'utf8') },
  );
  const orgId = /ORG_ID=([0-9a-f-]{36})/.exec(out)?.[1];
  if (!orgId) throw new Error(`seed did not report ORG_ID:\n${out}`);
  return { orgId };
}

async function loginAs(browser: Browser, baseURL: string, email: string): Promise<BrowserContext> {
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!password) throw new Error('E2E_ADMIN_PASSWORD must be set (the seeded users share the admin password)');
  const ctx = await browser.newContext({ baseURL });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.locator('[data-testid="login-email-input"]').fill(email);
  await page.locator('[data-testid="login-password-input"]').fill(password);
  await page.locator('[data-testid="login-submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
  await page.close();
  return ctx;
}

test.describe.configure({ mode: 'serial' });

test.describe('config policy one-page create (#12471)', () => {
  let policyId = '';
  let policyName = '';
  let seeded: { orgId: string };

  test.beforeAll(() => {
    seeded = seedUsers();
  });

  test('create, set a feature, stage a target, Activate, and see it listed as Active', async ({ authedPage: page }) => {
    test.setTimeout(120_000);
    const policies = new ConfigPolicyPage(page);
    policyName = `E2E create ${Date.now()}`;

    await page.goto(policies.newUrl);
    await expect(policies.createHeader()).toBeVisible({ timeout: 30_000 });
    // A full-access partner user: MSP-managed by default, with the trade stated.
    await expect(policies.managedBySelect()).toHaveValue('__msp__');
    await expect(policies.ownerTrade()).toBeVisible();
    await expect(policies.fixedAtFirstSave()).toBeVisible();
    await expect(policies.statusPill()).toHaveCount(0);

    // Browse a feature and save it: the first Save creates the policy, inactive.
    await policies.createName().fill(policyName);
    await policies.railItem('warranty').click();
    await policies.featureSave().click();
    // The page becomes the policy's own page in place (replaceState, no load).
    await expect(page).toHaveURL(/\/configuration-policies\/[0-9a-f-]{36}#warranty/, { timeout: 30_000 });
    policyId = /\/configuration-policies\/([0-9a-f-]{36})/.exec(page.url())![1];
    await expect(policies.createHeader()).toHaveCount(0);
    await expect(policies.statusPill()).toHaveText(/Inactive/);
    await expect(policies.ownerFixed()).toBeVisible();
    await expect(policies.railItem('warranty')).toContainText(/Set here/);

    // Activate asks where it applies: stage All organizations, then Activate.
    await policies.activate().click();
    await expect(policies.drawer()).toBeVisible();
    await policies.allOrgs().check();
    await expect(policies.activationActivate()).toHaveText(/^Activate · reaches/, { timeout: 15_000 });
    await policies.activationActivate().click();
    await expect(policies.drawer()).toBeHidden({ timeout: 15_000 });
    await expect(policies.statusPill()).toHaveText(/Active/, { timeout: 15_000 });
    await expect(policies.stripTargets().first()).toBeVisible({ timeout: 15_000 });

    // The list (filtered to the switcher's organization, if one is selected)
    // shows it Active, with its target.
    await page.goto(policies.listUrl);
    await expect(policies.row(policyId)).toBeVisible({ timeout: 15_000 });
    await expect(policies.row(policyId)).toContainText('Active');
    await expect(policies.appliesToCell(policyId)).not.toHaveText(/^\s*—\s*$/);
    await expect(policies.notAppliedBadge(policyId)).toHaveCount(0);
  });

  test('Breeze Defaults opens a new policy on that feature', async ({ authedPage: page }) => {
    const policies = new ConfigPolicyPage(page);
    await page.goto('/configuration-policies/defaults');
    await page.locator('a[href="/configuration-policies/new?feature=patch"]').first().click();
    await expect(policies.createHeader()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid="config-policy-feature-panel"][aria-label="Patches"]')).toBeVisible();
    // Browsing creates nothing.
    await expect(page).toHaveURL(/\/configuration-policies\/new/);
  });

  test('a partner user limited to one organization gets it as the owner, never MSP-managed', async ({ browser, baseURL }) => {
    const ctx = await loginAs(browser, baseURL!, LIMITED_EMAIL);
    const page = await ctx.newPage();
    const policies = new ConfigPolicyPage(page);
    await page.goto(policies.newUrl);
    await expect(policies.createHeader()).toBeVisible({ timeout: 30_000 });
    await expect(policies.managedBySelect()).toHaveValue(seeded.orgId, { timeout: 15_000 });
    await expect(policies.managedByMspOption()).toHaveCount(0);
    await expect(policies.ownerTrade()).toHaveCount(0);

    // The admin's All-organizations policy applies to this user's
    // organization: it opens, read-only, with the reason.
    await page.goto(policies.detailUrl(policyId));
    await expect(page.getByTestId('config-policy-read-only')).toBeVisible({ timeout: 15_000 });
    await expect(policies.activate()).toHaveCount(0);
    await ctx.close();
  });

  test('an org user gets their own organization and reads the MSP policy that applies to it', async ({ browser, baseURL }) => {
    const ctx = await loginAs(browser, baseURL!, ORG_EMAIL);
    const page = await ctx.newPage();
    const policies = new ConfigPolicyPage(page);
    await page.goto(policies.newUrl);
    await expect(policies.createHeader()).toBeVisible({ timeout: 30_000 });
    await expect(policies.managedBySelect()).toHaveCount(0);
    await expect(policies.managedByFixed()).toBeVisible();

    await page.goto(policies.listUrl);
    await expect(policies.row(policyId)).toBeVisible({ timeout: 15_000 });
    await page.goto(policies.detailUrl(policyId));
    await expect(page.getByTestId('config-policy-read-only')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('config-policy-edit-details')).toHaveCount(0);
    await ctx.close();
  });

  test('clean up', async ({ authedPage: page }) => {
    const policies = new ConfigPolicyPage(page);
    test.skip(!policyId, 'nothing was created');
    await page.goto(`${policies.listUrl}#org=all&q=${encodeURIComponent(policyName)}`);
    await policies.deleteButton(policyId).click();
    await policies.deleteConfirm().click();
    await expect(policies.row(policyId)).toHaveCount(0, { timeout: 15_000 });
  });
});
