import { test, expect } from '../fixtures';
import { waitForAppReady } from '../pages/hydration';

/**
 * Wisp home (/wisp) and the multi-tab chat that moved to /wisp/chat (#9921, W08).
 *
 * Legs (a) and (b) run on any stack: /workspace permanently redirects to
 * /wisp/chat, which works with Wisp off exactly as the old page did.
 *
 * Leg (c) needs BREEZE_WISP_ENABLED on the stack, a partner-scoped signed-in
 * user, a Wisp entitlement and a seeded ACTIVE Wisp grant, so it is opt-in:
 * set E2E_WISP_ENABLED=1 and E2E_WISP_TICKET_SUBJECT to a seeded ticket's subject.
 *
 * SELECTORS: data-testid only.
 */

test.describe('Wisp chats (/wisp/chat)', () => {
  test('/workspace redirects to /wisp/chat', async ({ authedPage: page }) => {
    await page.goto('/workspace');
    await page.waitForURL('**/wisp/chat');
    await expect(page.getByTestId('workspace-page')).toBeVisible({ timeout: 60_000 });
  });

  test('/wisp/chat renders the multi-tab chat page', async ({ authedPage: page }) => {
    // Persisted-tab behaviour (breeze-workspace) is covered in ai-move-conversation.spec.ts;
    // this leg only asserts the page itself renders at its new address.
    await page.goto('/wisp/chat');
    await waitForAppReady(page, 'workspace-page');
    await expect(page.getByTestId('workspace-page')).toBeVisible();
  });
});

test.describe('Wisp home (/wisp)', () => {
  test.skip(
    !process.env.E2E_WISP_ENABLED,
    'needs BREEZE_WISP_ENABLED and a seeded active Wisp grant (set E2E_WISP_ENABLED=1)',
  );

  test('shows the home sections', async ({ authedPage: page }) => {
    await page.goto('/wisp');
    await expect(page.getByTestId('wisp-home')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('wisp-brief-card')).toBeVisible();
    await expect(page.getByTestId('wisp-needs-you')).toBeVisible();
    await expect(page.getByTestId('wisp-home-thread')).toBeVisible();
    await expect(page.getByTestId('wisp-links-panel')).toBeVisible();
  });

  test('links a ticket from the entity picker', async ({ authedPage: page }) => {
    const subject = process.env.E2E_WISP_TICKET_SUBJECT;
    test.skip(!subject, 'set E2E_WISP_TICKET_SUBJECT to a seeded ticket subject');

    await page.goto('/wisp');
    await expect(page.getByTestId('wisp-links-panel')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('wisp-links-add').click();
    await expect(page.getByTestId('wisp-entity-picker')).toBeVisible();
    await page.getByTestId('wisp-picker-search').fill(subject!);
    await page.locator('[data-testid^="wisp-picker-row-ticket-"]').first().click();
    await expect(page.getByTestId('wisp-link-chip').first()).toBeVisible();
  });
});
