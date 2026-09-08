import type { Page } from '@playwright/test';
import { BasePage } from './BasePage';
import { waitForAppReady } from './hydration';

/**
 * Page Object for the unified Devices list (#1322 network arm, #4622 manual
 * assets). Covers only the manual-asset add/edit/delete flow this wave's E2E
 * spec drives — the agent and network arms have no POM here yet.
 */
export class DevicesPage extends BasePage {
  url = '/devices';

  heading = () => this.page.getByTestId('devices-heading');
  addAssetMenuTrigger = () => this.page.getByTestId('devices-page-add-menu-trigger');
  addManualAssetMenuItem = () => this.page.getByTestId('devices-page-add-menu-add-manual-asset');
  manualSegment = () => this.page.getByTestId('device-class-segment-manual');

  manualAssetModal = () => this.page.getByTestId('manual-asset-modal');
  nameInput = () => this.page.getByTestId('manual-asset-name');
  orgSelect = () => this.page.getByTestId('manual-asset-org');
  siteSelect = () => this.page.getByTestId('manual-asset-site');
  submitButton = () => this.page.getByTestId('manual-asset-submit');

  editButton = (id: string) => this.page.getByTestId(`device-${id}-edit-manual`);
  deleteButton = (id: string) => this.page.getByTestId(`device-${id}-delete-manual`);
  confirmDeviceAction = () => this.page.getByTestId('confirm-device-action');

  async goto() {
    await this.page.goto(this.url);
    await waitForAppReady(this.page, 'devices-heading');
  }

  /** Opens the add-manual-asset modal via the split Add menu. */
  async openAddManualAssetModal() {
    await this.addAssetMenuTrigger().click();
    await this.addManualAssetMenuItem().click();
    await this.manualAssetModal().waitFor();
  }

  /**
   * Fills Org (when the page isn't already scoped to one org) and Site (when
   * the org has more than one, so the spec's default-to-only-site path
   * doesn't already fill it) with the first available option — this spec
   * only cares that SOME valid org/site is chosen, not which one.
   */
  async fillOrgAndSiteIfNeeded() {
    const orgSelect = this.orgSelect();
    if ((await orgSelect.evaluate((el) => el.tagName)) === 'SELECT') {
      const options = await orgSelect.locator('option').all();
      if (options.length > 1) {
        const value = await options[1]!.getAttribute('value');
        if (value) await orgSelect.selectOption(value);
      }
    }
    const siteSelect = this.siteSelect();
    const currentSite = await siteSelect.inputValue();
    if (!currentSite) {
      const options = await siteSelect.locator('option').all();
      if (options.length > 1) {
        const value = await options[1]!.getAttribute('value');
        if (value) await siteSelect.selectOption(value);
      }
    }
  }

  /**
   * Submits the create form and returns the created manual asset's id,
   * captured from the `POST /devices/manual` response rather than scraped
   * from the DOM — the list has no name-based selector under the
   * data-testid-only convention.
   */
  async submitCreate(): Promise<string> {
    const [response] = await Promise.all([
      this.page.waitForResponse((r) => r.url().includes('/devices/manual') && r.request().method() === 'POST'),
      this.submitButton().click(),
    ]);
    const body = await response.json();
    return body.id as string;
  }

  async submitUpdate(id: string): Promise<void> {
    await Promise.all([
      this.page.waitForResponse((r) => r.url().includes(`/devices/manual/${id}`) && r.request().method() === 'PATCH'),
      this.submitButton().click(),
    ]);
  }

  async deleteAsset(id: string): Promise<void> {
    await this.deleteButton(id).click();
    await this.confirmDeviceAction().waitFor();
    await Promise.all([
      this.page.waitForResponse((r) => r.url().includes(`/devices/manual/${id}`) && r.request().method() === 'DELETE'),
      this.confirmDeviceAction().click(),
    ]);
  }
}

export function devicesPage(page: Page): DevicesPage {
  return new DevicesPage(page);
}
