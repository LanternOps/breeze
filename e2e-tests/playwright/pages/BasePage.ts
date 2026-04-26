// e2e-tests/playwright/pages/BasePage.ts
import type { Page } from '@playwright/test';

export class BasePage {
  constructor(protected page: Page) {}

  // Use Playwright's user-facing locators, NOT raw CSS. Bare `p`/`h2`
  // selectors get hijacked by SSR shells (e.g. AiChatSidebar) — see
  // PR #520 for the trail of pain.
  sidebarLink(label: string) {
    return this.page.getByRole('navigation').getByRole('link', { name: label });
  }

  accountMenuButton() {
    return this.page.getByRole('button', { name: 'Account menu' });
  }

  async signOut() {
    await this.accountMenuButton().click();
    await this.page.getByRole('button', { name: 'Sign out' }).click();
    await this.page.waitForURL('**/login**');
  }
}
