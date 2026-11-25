import { test, expect } from '../fixtures';
import { ConfigPolicyPage } from '../pages/ConfigPolicyPage';

// #12622: with an unsaved feature edit on a policy, a sidebar link click asks
// once. Cancel keeps the user on the policy with the edit; Leave goes. Neither
// answer is followed by the browser's own "Leave site?" (beforeunload) prompt.
test.describe.configure({ mode: 'serial' });

test.describe('config policy unsaved-changes guard (#12622)', () => {
  let policyId = '';
  const policyName = `E2E unsaved guard ${Date.now()}`;

  test('a dirty feature: Cancel stays on the policy, Leave goes, each asked once', async ({ authedPage: page }) => {
    test.setTimeout(120_000);
    const policies = new ConfigPolicyPage(page);

    // A saved policy to edit (the steps config-policy-create.spec.ts uses).
    await page.goto(policies.newUrl);
    await expect(policies.createHeader()).toBeVisible({ timeout: 30_000 });
    await expect(policies.managedBySelect()).toHaveValue('__msp__');
    await policies.createName().fill(policyName);
    await policies.railItem('warranty').click();
    await policies.featureSave().click();
    await expect(page).toHaveURL(/\/configuration-policies\/[0-9a-f-]{36}#warranty/, { timeout: 30_000 });
    policyId = /\/configuration-policies\/([0-9a-f-]{36})/.exec(page.url())![1];

    // Open it fresh and leave an unsaved edit in the feature.
    await page.goto(`${policies.detailUrl(policyId)}#warranty`);
    const toggle = page.getByTestId('warranty-tab-alerts-toggle');
    await expect(toggle).toBeVisible({ timeout: 30_000 });
    const edited = (await toggle.getAttribute('aria-checked')) === 'true' ? 'false' : 'true';
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', edited);

    const dialogs: string[] = [];
    let leave = false;
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.type());
      void (leave && dialog.type() === 'confirm' ? dialog.accept() : dialog.dismiss());
    });
    const sitesLink = page.getByTestId('nav-section-fleet-management').getByTestId('nav-sites');

    // Cancel: one confirm, then nothing. Before the fix the beforeunload prompt
    // followed a moment later, so wait that moment before checking.
    await sitesLink.click();
    await expect.poll(() => dialogs).toEqual(['confirm']);
    await page.waitForTimeout(1_000);
    expect(dialogs).toEqual(['confirm']);
    await expect(page).toHaveURL(new RegExp(`/configuration-policies/${policyId}(#|$)`));
    await expect(toggle).toHaveAttribute('aria-checked', edited);

    // Leave: one more confirm, and the sidebar page opens with no beforeunload prompt.
    leave = true;
    await sitesLink.click();
    await page.waitForURL(/\/settings\/sites$/, { timeout: 30_000 });
    expect(dialogs).toEqual(['confirm', 'confirm']);
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
