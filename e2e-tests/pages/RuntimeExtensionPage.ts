import type { Page } from '@playwright/test';

/**
 * Page Object for the Task 6 (Plan 03) runtime-extension fixture
 * (`e2e-tests/fixtures/runtime-extension/`, extension name `e2e-fixture`).
 *
 * DEVIATION FROM THE `data-testid`-ONLY CONVENTION (e2e-tests/README.md):
 * the fixture's OWN rendered content is located entirely by `data-testid`
 * (every locator below that points into `#e2e-fixture-*` elements). The
 * three HOST-CHROME entry points this extension surfaces through — the
 * Sidebar "Extensions" nav link, the DeviceDetails tab button
 * (`OverflowTabs`), and the... no, the org-settings tab content IS
 * testid'd (`org-tab-extensions`, pre-existing) — carry no `data-testid` in
 * `apps/web/src/components/{layout/Sidebar,devices/DeviceDetails}.tsx`
 * today, and Task 6's brief scopes this task's file changes to `e2e-tests/`
 * + the fixture only ("modify e2e-tests config only if required. Not
 * apps/web/e2e/"), not `apps/web/src`. Adding testids there is a one-line,
 * low-risk follow-up worth doing in a task that DOES own those files; until
 * then this Page Object locates them by the most stable alternative
 * available — `href` for the nav link (exactly the string
 * `useExtensionNavigation` computes: `/extensions/<name><path>`) and
 * visible label text for the device tab button (`OverflowTabs` renders
 * plain `<button>` text, no role/aria distinguishing it further).
 */
export class RuntimeExtensionPage {
  constructor(
    private page: Page,
    private extensionName = 'e2e-fixture',
    private label = 'E2E Fixture',
  ) {}

  // ---- sidebar nav -----------------------------------------------------

  sidebarNavLink() {
    return this.page.locator(`aside a[href="/extensions/${this.extensionName}"]`).first();
  }

  async gotoViaSidebar(): Promise<void> {
    await this.sidebarNavLink().click();
    await this.pageHeading().waitFor();
  }

  // ---- extension page (/extensions/e2e-fixture) -------------------------

  async goto(): Promise<void> {
    await this.page.goto(`/extensions/${this.extensionName}`);
  }

  pageRoot() {
    return this.page.getByTestId('e2e-fixture-page-root');
  }

  pageHeading() {
    return this.page.getByTestId('e2e-fixture-page-heading');
  }

  pageNotFound() {
    return this.page.getByTestId('extension-page-not-found');
  }

  pageUnavailable() {
    return this.page.getByTestId('extension-element-unavailable');
  }

  // ---- device.detail.tabs@1 slot ----------------------------------------

  /** The tab button in `OverflowTabs` (main row) OR its "More" overflow
   *  entry — whichever is currently rendering it. See class doc comment for
   *  why this isn't a `data-testid` locator. */
  deviceTabButton() {
    return this.page.getByRole('button', { name: this.label, exact: true });
  }

  async openDeviceTab(): Promise<void> {
    const button = this.deviceTabButton();
    if (await button.isVisible().catch(() => false)) {
      await button.click();
      return;
    }
    // Overflowed into the "More" menu.
    await this.page.getByRole('button', { name: /more/i }).click();
    await this.page.getByRole('button', { name: this.label, exact: true }).last().click();
  }

  deviceTabRoot() {
    return this.page.getByTestId('e2e-fixture-device-tab-root');
  }

  // ---- organization.settings.sections@1 slot -----------------------------

  orgSectionTabContent() {
    return this.page.getByTestId('org-tab-extensions');
  }

  orgSectionRoot() {
    return this.page.getByTestId('e2e-fixture-org-section-root');
  }

  /** Navigates the org-settings hash router to the (always-present, see
   *  `OrgSettingsPage.tsx` `TAB_GROUPS`) "extensions" section. */
  async gotoOrgExtensionsSection(orgId: string): Promise<void> {
    await this.page.goto(`/settings/organizations/${orgId}#extensions`);
    await this.orgSectionTabContent().waitFor();
  }
}
