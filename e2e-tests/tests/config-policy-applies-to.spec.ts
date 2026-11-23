import { test, expect } from '../fixtures';
import { clearRefreshState } from '../test-helpers';
import { AuthPage } from '../pages/AuthPage';
import { ConfigPolicyPage } from '../pages/ConfigPolicyPage';

// #12306: a saved policy says where it applies, on its page and in the list.
// Needs an API that sends `appliesTo` (plan W01a) and the staged Apply and
// reach routes (W02a, W02b).
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

    // 1. Create an MSP-managed policy (the admin's default owner, #12471),
    // saved inactive and applied nowhere with Don't apply yet.
    await expect(policies.createHeader()).toBeVisible();
    await policies.createName().fill(`E2E applies-to ${Date.now()}`);
    await expect(policies.managedBySelect()).toHaveValue('__msp__');
    await policies.activate().click();
    await policies.activationDontApply().click();
    // The page becomes the policy's own page in place (replaceState, no load).
    await expect(cleanPage).toHaveURL(/\/configuration-policies\/[0-9a-f-]{36}/, { timeout: 30_000 });
    const policyId = /\/configuration-policies\/([0-9a-f-]{36})/.exec(cleanPage.url())![1];
    await expect(policies.drawer()).toBeHidden();

    // 2. A new policy applies to nothing, and the strip says so.
    await expect(policies.stripNotApplied()).toBeVisible();
    await policies.stripAssign().click();

    // 3. Stage a device and a site target on the MSP-managed policy (#12467),
    // see the delta, Apply, and see the strip name a target and count devices.
    await expect(policies.drawer()).toBeVisible();
    await expect(policies.panel()).toBeVisible();
    await expect(policies.legend()).toBeVisible();
    await expect(policies.specificTargets()).toBeChecked();

    // Device: drill into the organization that holds a seeded device.
    await policies.pickerLevel('device').click();
    await policies.pickerOrgOptions().first().waitFor();
    const orgCount = await policies.pickerOrgOptions().count();
    let foundDevice = false;
    for (let i = 0; i < orgCount && !foundDevice; i += 1) {
      await policies.pickerOrgOptions().nth(i).click();
      await policies.pickerSearch().fill('e2e-');
      foundDevice = await policies.pickerOptions().first().waitFor({ timeout: 5_000 }).then(() => true, () => false);
      if (!foundDevice) await policies.pickerChangeOrg().click();
    }
    expect(foundDevice, 'a seeded e2e- device in one of the partner organizations').toBe(true);
    await policies.pickerOptions().first().click();

    // Site: the chosen organization carries over to the Site level.
    await policies.pickerLevel('site').click();
    await policies.pickerOptions().first().waitFor();
    await policies.pickerOptions().first().click();
    await expect(policies.panelRows('added')).toHaveCount(2);

    // The foot states the delta before anything is written.
    await expect(policies.applyButton()).toHaveText(/Apply · adds \d+ devices?, removes 0/, { timeout: 15_000 });
    await policies.applyButton().click();
    // Applied: the draft reloads clean, with the two stored rows.
    await expect(policies.applyButton()).toBeDisabled({ timeout: 15_000 });
    await expect(policies.panelRows('unchanged')).toHaveCount(2);
    await policies.drawerClose().click();
    await expect(policies.drawer()).toBeHidden();
    await expect(policies.stripTargets().first()).toBeVisible({ timeout: 15_000 });
    await expect(policies.stripNotApplied()).toHaveCount(0);
    await expect(policies.stripReach()).toHaveText(/\d+ devices?/, { timeout: 15_000 });

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
