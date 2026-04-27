import type { Page } from '@playwright/test';

export class BasePage {
  constructor(protected page: Page) {}

  // Sidebar navigation is shared across every authed page. Test IDs follow
  // the convention `nav-link-<route>`, e.g. nav-link-devices, nav-link-alerts.
  navLink(route: string) {
    return this.page.getByTestId(`nav-link-${route}`);
  }

  accountMenuButton() {
    return this.page.getByTestId('account-menu-button');
  }

  signOutButton() {
    return this.page.getByTestId('account-menu-sign-out');
  }

  async signOut() {
    await this.accountMenuButton().click();
    await this.signOutButton().click();
    await this.page.waitForURL('**/login**');
  }
}
