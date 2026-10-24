import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { clearRefreshState } from '../test-helpers';
import { AuthPage } from '../pages/AuthPage';
import { TicketsPage } from '../pages/TicketsPage';

// #8972 W2: merge the newer ticket into the older one through the dialog, then
// check the survivor's timeline and the tombstone's read-only view.

test.describe.configure({ mode: 'serial' });
test.beforeEach(clearRefreshState);

async function signIn(page: Page): Promise<TicketsPage> {
  const auth = new AuthPage(page);
  // Wait for React hydration via the fiber expando on the login form (see
  // tickets.spec.ts): clicking submit pre-hydration does a native GET submit.
  await page.goto(`${auth.url}?next=${encodeURIComponent('/tickets')}`);
  await auth.page_().waitFor();
  await page.waitForFunction(() => {
    const form = document.querySelector('form');
    return !!form && Object.keys(form).some((k) => k.startsWith('__reactFiber$'));
  });
  await auth.signIn(process.env.E2E_ADMIN_EMAIL!, process.env.E2E_ADMIN_PASSWORD!, /\/tickets(\?|$|#)/);
  const tickets = new TicketsPage(page);
  await tickets.heading().waitFor();
  return tickets;
}

/** Create a ticket in the first org and post one public comment. Returns its uuid. */
async function createTicketWithComment(page: Page, tickets: TicketsPage, subject: string, comment: string): Promise<string> {
  await tickets.createButton().click();
  await tickets.formSubject().waitFor();
  await tickets.formOrg().selectOption({ index: 1 });
  await tickets.formSubject().fill(subject);
  // The create page navigates to /tickets#<T-number>, not the uuid, so the
  // uuid comes from the create POST's response body.
  const created = page.waitForResponse((r) =>
    r.request().method() === 'POST' && /\/tickets\/?$/.test(new URL(r.url()).pathname));
  await tickets.formSubmit().click();
  const id = (await (await created).json()).data.id as string;
  await page.waitForURL(/\/tickets#/);
  await tickets.workbench().waitFor();
  await expect(tickets.workbenchNumber()).toContainText('T-');
  await tickets.composerInput().fill(comment);
  await tickets.composerSend().click();
  await expect(tickets.feed()).toContainText(comment);
  return id;
}

test.describe('ticket merge', () => {
  test('merge the newer ticket into the older one', async ({ cleanPage }) => {
    test.setTimeout(180_000); // login + two creates + two comments + merge + two navigations

    const tickets = await signIn(cleanPage);
    const stamp = Date.now();

    const aId = await createTicketWithComment(cleanPage, tickets, `E2E merge A ${stamp}`, `Comment on A ${stamp}`);
    const aNumber = (await tickets.workbenchNumber().textContent())?.trim();
    const bId = await createTicketWithComment(cleanPage, tickets, `E2E merge B ${stamp}`, `Comment on B ${stamp}`);
    expect(aNumber).toMatch(/^T-/);

    // On B (the newer ticket): Merge into… → pick A → preview → confirm.
    await tickets.mergeOpen().click();
    await tickets.mergePicker().waitFor();
    await tickets.mergeOption(aId).click();
    await expect(tickets.mergePreview()).toBeVisible();
    // Both tickets were created without a requester, so there is nobody to email.
    await expect(tickets.mergeNotify()).not.toBeChecked();
    await expect(tickets.mergeConfirm()).toBeEnabled();
    await tickets.mergeConfirm().click();

    // The workbench lands on the survivor, whose timeline carries both comments.
    await expect(tickets.workbenchNumber()).toHaveText(aNumber!);
    await expect(tickets.feed()).toContainText(`Comment on A ${stamp}`);
    await expect(tickets.feed()).toContainText(`Comment on B ${stamp}`);

    // The tombstone is read-only and points at the survivor.
    await cleanPage.goto(`/tickets/${bId}`);
    await expect(tickets.mergedBanner()).toBeVisible();
    await expect(tickets.mergedBanner()).toContainText(aNumber!);
    await expect(tickets.composerInput()).toHaveCount(0);
    await expect(tickets.mergeOpen()).toHaveCount(0);

    // The closed tab hides the tombstone until "Show merged" is on.
    await tickets.goto();
    await tickets.tab('closed').click();
    await expect(tickets.row(bId)).toHaveCount(0);
    await tickets.showMergedToggle().click();
    await expect(tickets.row(bId)).toBeVisible();
    await expect(tickets.rowMergedChip(bId)).toBeVisible();
  });
});
