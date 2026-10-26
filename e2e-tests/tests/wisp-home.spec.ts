import { test, expect } from '../fixtures';
import { waitForAppReady } from '../pages/hydration';

/**
 * Breeze AI, the multi-tab chat at /ai/chat (moved from /wisp/chat, which moved
 * from /workspace), and Wisp home (/wisp).
 *
 * Legs (a) and (b) run on any stack: /workspace and /wisp/chat permanently
 * redirect to /ai/chat, which works with Wisp off. /wisp itself shows a lock
 * when the server has Wisp off instead of forwarding to the chat.
 *
 * Leg (c) needs BREEZE_WISP_ENABLED on the stack, a partner-scoped signed-in
 * user, a Wisp entitlement and a seeded ACTIVE Wisp grant, so it is opt-in:
 * set E2E_WISP_ENABLED=1 and E2E_WISP_TICKET_SUBJECT to a seeded ticket's subject.
 *
 * SELECTORS: data-testid only.
 */

test.describe('Breeze AI (/ai/chat)', () => {
  test('/workspace redirects to /ai/chat', async ({ authedPage: page }) => {
    await page.goto('/workspace');
    await page.waitForURL('**/ai/chat');
    await expect(page.getByTestId('workspace-page')).toBeVisible({ timeout: 60_000 });
  });

  test('/wisp/chat#session=x redirects to /ai/chat keeping the fragment', async ({ authedPage: page }) => {
    // Checked at commit: once hydrated, the page rewrites the fragment to the
    // tab it opens (sessionHash.writeSessionHash), and `x` is not a session id.
    await page.goto('/wisp/chat#session=x', { waitUntil: 'commit' });
    await page.waitForURL('**/ai/chat#session=x', { waitUntil: 'commit' });
    await page.goto('/workspace#session=x', { waitUntil: 'commit' });
    await page.waitForURL('**/ai/chat#session=x', { waitUntil: 'commit' });
  });

  test('/ai/chat renders the multi-tab chat page', async ({ authedPage: page }) => {
    // Persisted-tab behaviour (breeze-workspace) is covered in ai-move-conversation.spec.ts;
    // this leg only asserts the page itself renders at its new address.
    await page.goto('/ai/chat');
    await waitForAppReady(page, 'workspace-page');
    await expect(page.getByTestId('workspace-page')).toBeVisible();
  });
});

test.describe('Wisp home (/wisp)', () => {
  test.skip(
    !process.env.E2E_WISP_ENABLED,
    'needs BREEZE_WISP_ENABLED and a seeded active Wisp grant (set E2E_WISP_ENABLED=1)',
  );

  test('shows the conversation column and the rail', async ({ authedPage: page }) => {
    // W01 #10211: the conversation is the page. A fresh grant's empty thread
    // shows Wisp's welcome (its chips stay when a brief exists); a grant whose
    // last session is still live resumes that conversation instead.
    await page.goto('/wisp');
    await expect(page.getByTestId('wisp-home')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('wisp-home-thread')).toBeVisible();
    await expect(
      page.getByTestId('wisp-welcome').or(page.getByTestId('ai-msg-user').first()),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('wisp-home-thread').getByTestId('ai-chat-input')).toBeVisible();
    // The default 1280 px viewport is wide enough for the rail beside the thread.
    await expect(page.getByTestId('wisp-rail')).toBeVisible();
    await expect(page.getByTestId('wisp-needs-you')).toBeVisible();
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
