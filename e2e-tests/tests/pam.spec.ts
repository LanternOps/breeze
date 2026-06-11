import { test, expect } from '../fixtures';
import { clearRefreshState } from '../test-helpers';
import { AuthPage } from '../pages/AuthPage';
import { PamPage } from '../pages/PamPage';

test.describe.configure({ mode: 'serial' });
test.beforeEach(clearRefreshState);

test.describe('pam admin', () => {
  test('tabs, rule create and delete', async ({ cleanPage }) => {
    test.setTimeout(120_000);

    const auth = new AuthPage(cleanPage);
    // Same hydration workaround as tickets.spec.ts: wait for the React fiber
    // expando on the login form instead of the unmerged data-hydrated sentinel.
    await cleanPage.goto(`${auth.url}?next=${encodeURIComponent('/pam')}`);
    await auth.page_().waitFor();
    await cleanPage.waitForFunction(() => {
      const form = document.querySelector('form');
      return !!form && Object.keys(form).some((k) => k.startsWith('__reactFiber$'));
    });
    await auth.signIn(process.env.E2E_ADMIN_EMAIL!, process.env.E2E_ADMIN_PASSWORD!, /\/pam(\?|$|#)/);

    const pam = new PamPage(cleanPage);
    await pam.heading().waitFor();

    // Overview is the default tab.
    await pam.statActive().waitFor();

    // Requests tab via hash routing.
    await pam.tabRequests().click();
    await expect(cleanPage).toHaveURL(/#requests$/);
    await pam.filterStatus().waitFor();

    // Audit tab renders its export control.
    await pam.tabAudit().click();
    await pam.auditExportButton().waitFor();

    // Rules tab: create a rule end-to-end against the real API.
    await pam.tabRules().click();
    await pam.addRuleButton().waitFor();

    const before = await pam.ruleRows().count();
    await pam.addRuleButton().click();
    await pam.ruleName().waitFor();
    const ruleName = `E2E signer rule ${Date.now()}`;
    await pam.ruleName().fill(ruleName);
    await pam.ruleSigner().fill('E2E Test Signer');
    await pam.rulePriority().fill('9000');
    await pam.ruleSubmit().click();

    await expect(pam.ruleRows()).toHaveCount(before + 1, { timeout: 15_000 });
    await expect(cleanPage.getByText(ruleName)).toBeVisible();

    // Delete it again to leave the environment clean.
    const row = cleanPage.locator('[data-testid^="pam-rule-row-"]', { hasText: ruleName });
    await row.locator('[data-testid^="pam-rule-delete-"]').click();
    await expect(pam.ruleRows()).toHaveCount(before, { timeout: 15_000 });
  });
});
