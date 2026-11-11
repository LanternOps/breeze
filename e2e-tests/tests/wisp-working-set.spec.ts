import { test, expect } from '../fixtures';
import type { Page } from '@playwright/test';
import { waitForAppReady } from '../pages/hydration';

/**
 * W04 #10368: run on an isolated worktree stack after W02, with
 * BREEZE_WISP_ENABLED=true and E2E_WISP_ENABLED=1. Seed an entitled
 * partner-scoped user with an ACTIVE partner-wide grant, a ticket in its
 * ceiling (E2E_WISP_TICKET_ID), and an accessible device in that ceiling
 * (E2E_WISP_DEVICE_ID) that is not already linked or a concern subject.
 * The model/provider must be configured for a successful get_device_details.
 * This spec is written here; the orchestrator executes it on the stack.
 * DOM selectors: data-testid only.
 */
const ticketId = process.env.E2E_WISP_TICKET_ID;
const deviceId = process.env.E2E_WISP_DEVICE_ID;

async function revealWorkingSet(page: Page) {
  // #links opens the existing rail drawer on narrow screens; desktop keeps
  // the rail visible. More exposes any item beyond the initial twelve.
  await page.goto('/wisp#links');
  await expect(page.getByTestId('wisp-links-panel')).toBeVisible({ timeout: 60_000 });
  const more = page.getByTestId('wisp-links-more');
  if (await more.isVisible()) await more.click();
}

test.describe('Wisp working set', () => {
  test.skip(!process.env.E2E_WISP_ENABLED || !ticketId || !deviceId,
    'needs an enabled Wisp stack, active partner-wide grant and E2E_WISP_TICKET_ID / E2E_WISP_DEVICE_ID fixtures');

  test('talk pins a ticket without sending, then a focal device read appears in Recent', async ({ authedPage: page }) => {
    test.setTimeout(180_000);
    await page.goto(`/tickets/${ticketId}`);
    await waitForAppReady(page, 'ticket-workbench');
    const subject = (await page.getByTestId('ticket-workbench-subject').textContent())?.trim();
    expect(subject).toBeTruthy();
    let turns = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/ai\/sessions\/[^/]+\/messages(?:\?|$)/.test(request.url())) turns += 1;
    });
    await page.getByTestId('wisp-talk-button').click();
    const input = page.getByTestId('ai-chat-sidebar').getByTestId('ai-chat-input');
    const focus = page.getByTestId('wisp-talk-focus-popover');
    await expect(input.or(focus)).toBeVisible({ timeout: 30_000 });
    if (await focus.isVisible()) await page.getByTestId('wisp-talk-focus-yes').click();
    await expect(input).toHaveValue(`About ${subject}: `);
    await expect(input).toBeFocused();
    expect(turns).toBe(0);

    await revealWorkingSet(page);
    await expect(page.getByTestId('wisp-links-group-pinned')
      .getByTestId(`wisp-link-target-ticket-${ticketId}`)).toBeVisible();
    // The device fixture must be fresh: a pre-existing pin could make a
    // tool call succeed without creating the Recent pill this leg proves.
    await expect(page.getByTestId(`wisp-link-target-device-${deviceId}`)).toHaveCount(0);
    const composer = page.getByTestId('wisp-home-thread').getByTestId('ai-chat-input');
    await expect(composer).toBeEnabled();
    await composer.fill(`Read the details for device ID ${deviceId} using get_device_details. Do not change the device or explicitly pin/link it.`);
    await page.getByTestId('wisp-home-thread').getByTestId('ai-chat-send').click();
    await expect.poll(() => turns).toBe(1);
    await expect(page.getByTestId('wisp-home-thread').getByTestId('ai-chat-stop')).toHaveCount(0, { timeout: 120_000 });
    // The working set refreshes every 30 seconds. Wait for the home read,
    // including the backend auto-link write, rather than sleeping a fixed time.
    await expect(async () => {
      const more = page.getByTestId('wisp-links-more');
      if (await more.isVisible()) await more.click();
      await expect(page.getByTestId('wisp-links-group-recent')
        .getByTestId(`wisp-link-target-device-${deviceId}`)).toBeVisible();
    }).toPass({ timeout: 90_000 });
  });
});
