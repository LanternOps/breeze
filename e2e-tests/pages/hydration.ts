import { expect, type Page } from '@playwright/test';

/**
 * Wait until a `client:load` Astro island has actually attached its React
 * handlers.
 *
 * Astro SSRs the initial React tree into static HTML, so a `data-testid`
 * element can be visible and "actionable" per Playwright's checks well before
 * hydration. A click that lands in that window is silently swallowed (a plain
 * `<button>` has no native action). This is the same race documented inline in
 * `tests/quote-contract-proposal.spec.ts` (and, for the login form, in
 * tickets.spec.ts / pam.spec.ts) — lifted here so every Page Object can key off
 * whatever root testid its page renders first instead of re-copying it.
 */
export async function waitForHydration(page: Page, testId: string): Promise<void> {
  await page.waitForFunction(
    (id) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      return !!el && Object.keys(el).some((k) => k.startsWith('__reactFiber$'));
    },
    testId,
    { timeout: 20_000 },
  );
}

/**
 * The auth overlay is a full-screen `fixed inset-0 z-50` mask that AuthOverlay
 * renders while the session store is initializing or silently recovering a
 * token. It is not an error state — it appears and clears on its own — but
 * while it is up it swallows every click on the page underneath ("subtree
 * intercepts pointer events"), which shows up as a flaky first click after a
 * navigation. The faded-out variant carries `pointer-events-none` and is
 * harmless, so only the blocking one is waited on.
 *
 * The island is matched on its `opts` attribute (which carries the component
 * NAME) rather than `component-url`, so the selector survives a production
 * bundle as well as the dev server.
 */
export async function waitForAuthOverlayClear(page: Page): Promise<void> {
  await expect(
    page.locator('astro-island[opts*="AuthOverlay"] div.fixed:not(.pointer-events-none)'),
  ).toHaveCount(0, { timeout: 30_000 });
}

/** Navigate-and-settle: root testid present, island hydrated, overlay gone. */
export async function waitForAppReady(page: Page, rootTestId: string): Promise<void> {
  await page.getByTestId(rootTestId).waitFor({ timeout: 30_000 });
  await waitForHydration(page, rootTestId);
  await waitForAuthOverlayClear(page);
}
