import { test, expect } from '../fixtures';
import { clearRefreshState } from '../test-helpers';
import { AuthPage } from '../pages/AuthPage';
import { TicketsPage } from '../pages/TicketsPage';

test.describe.configure({ mode: 'serial' });
test.beforeEach(clearRefreshState);

test.describe('tickets', () => {
  test('create, reply, internal note, resolve', async ({ cleanPage }) => {
    test.setTimeout(120_000); // serial multi-step flow: login + create + reply + note + resolve

    const auth = new AuthPage(cleanPage);
    // Not auth.goto(): its form[data-hydrated="true"] hydration sentinel was
    // never merged into the app code, so that wait always times out. Wait for
    // React hydration via the fiber expando on the login form instead —
    // clicking submit pre-hydration triggers a native GET form submission.
    await cleanPage.goto(`${auth.url}?next=${encodeURIComponent('/tickets')}`);
    await auth.page_().waitFor();
    await cleanPage.waitForFunction(() => {
      const form = document.querySelector('form');
      return !!form && Object.keys(form).some((k) => k.startsWith('__reactFiber$'));
    });
    await auth.signIn(process.env.E2E_ADMIN_EMAIL!, process.env.E2E_ADMIN_PASSWORD!, /\/tickets(\?|$|#)/);

    const tickets = new TicketsPage(cleanPage);
    await tickets.heading().waitFor();

    // Create
    await tickets.createButton().click();
    await tickets.formSubject().waitFor();
    await tickets.formOrg().selectOption({ index: 1 });
    await tickets.formSubject().fill('E2E smoke ticket');
    await tickets.formSubmit().click();
    await cleanPage.waitForURL(/\/tickets#/);
    await tickets.workbench().waitFor();
    await expect(tickets.workbenchNumber()).toContainText('T-');

    // Public reply
    await tickets.composerInput().fill('Public reply from e2e');
    await tickets.composerSend().click();
    await expect(cleanPage.getByTestId('ticket-feed')).toContainText('Public reply from e2e');

    // Internal note shows the safety banner
    await tickets.composerInternalTab().click();
    await expect(tickets.composerInternalBanner()).toBeVisible();
    await tickets.composerInput().fill('Internal note from e2e');
    await tickets.composerSend().click();
    await expect(cleanPage.getByTestId('ticket-feed')).toContainText('Internal note from e2e');

    // Resolve requires a note
    const ticketNumber = (await tickets.workbenchNumber().textContent())?.trim();
    await tickets.statusSelect().selectOption('resolved');
    await tickets.resolveNote().waitFor();
    await tickets.resolveNote().fill('Resolved by e2e');
    await tickets.resolveSubmit().click();
    // Resolving removes the ticket from the open queue, and the page
    // auto-selects the next open ticket — so verify on the closed tab
    // (sorted newest-first; our ticket is the most recently resolved).
    await tickets.tab('closed').click();
    await expect(tickets.workbenchNumber()).toHaveText(ticketNumber!);
    await expect(tickets.statusSelect()).toHaveValue('resolved');
  });
});
