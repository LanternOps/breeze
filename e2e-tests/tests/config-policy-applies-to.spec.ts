import { test, expect } from '../fixtures';
import { clearRefreshState } from '../test-helpers';
import { AuthPage } from '../pages/AuthPage';
import { ConfigPolicyPage } from '../pages/ConfigPolicyPage';

// #12306: a saved policy says where it applies, on its page and in the list.
// Needs an API that sends `appliesTo` (plan W01a).
test.describe.configure({ mode: 'serial' });
test.beforeEach(clearRefreshState);

test.describe('config policy applies-to', () => {
  test('create, see not applied, assign, see it applied', async ({ cleanPage }) => {
    test.setTimeout(120_000);

    const auth = new AuthPage(cleanPage);
    const policies = new ConfigPolicyPage(cleanPage);

    // Same hydration wait as pam.spec.ts.
    await cleanPage.goto(`${auth.url}?next=${encodeURIComponent(policies.newUrl)}`);
    await auth.page_().waitFor();
    await cleanPage.waitForFunction(() => {
      const form = document.querySelector('form');
      return !!form && Object.keys(form).some((k) => k.startsWith('__reactFiber$'));
    });
    await auth.signIn(
      process.env.E2E_ADMIN_EMAIL!,
      process.env.E2E_ADMIN_PASSWORD!,
      /\/configuration-policies\/new(\?|$|#)/,
    );

    // 1. Create an MSP-managed policy, so the drawer shows the organization
    // checklist whatever the admin's org selection. It lands with the drawer open.
    await policies.createModeNew().click();
    await policies.createName().fill(`E2E applies-to ${Date.now()}`);
    await policies.ownerPartner().check();
    await policies.createSubmit().click();
    await cleanPage.waitForURL(/\/configuration-policies\/[0-9a-f-]{36}/);
    const policyId = /\/configuration-policies\/([0-9a-f-]{36})/.exec(cleanPage.url())![1];
    await expect(policies.drawer()).toBeVisible();
    await policies.drawerClose().click();
    await expect(policies.drawer()).toBeHidden();

    // 2. A new policy applies to nothing, and the strip says so.
    await expect(policies.stripNotApplied()).toBeVisible();
    await policies.stripAssign().click();

    // 3. Apply it to one organization; the strip names a target after close.
    await expect(policies.drawer()).toBeVisible();
    const firstOrg = policies.orgScopeOrgCheckboxes().first();
    await firstOrg.waitFor();
    await firstOrg.check();
    await expect(firstOrg).toBeChecked({ timeout: 15_000 });
    await policies.drawerClose().click();
    await expect(policies.stripTargets().first()).toBeVisible({ timeout: 15_000 });
    await expect(policies.stripNotApplied()).toHaveCount(0);

    // 4. The list row shows where it applies, with no Not applied chip.
    await cleanPage.goto(policies.listUrl);
    await expect(policies.appliesToCell(policyId)).toBeVisible({ timeout: 15_000 });
    await expect(policies.notAppliedBadge(policyId)).toHaveCount(0);

    // 5. An old #assignments link opens the drawer.
    await cleanPage.goto(`${policies.detailUrl(policyId)}#assignments`);
    await expect(policies.drawer()).toBeVisible({ timeout: 15_000 });
    await policies.drawerClose().click();

    // Clean up.
    await cleanPage.goto(policies.listUrl);
    await policies.deleteButton(policyId).click();
    await policies.deleteConfirm().click();
    await expect(policies.row(policyId)).toHaveCount(0, { timeout: 15_000 });
  });
});
