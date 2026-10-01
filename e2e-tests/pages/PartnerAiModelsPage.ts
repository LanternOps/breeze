import { BasePage } from './BasePage';
import { waitForAppReady } from './hydration';

/**
 * `/settings/partner#ai-provider` — AI Providers & Models (W04, #7602).
 *
 * `SettingsSectionNav` emits `<testIdPrefix>-tab-<key>`; PartnerSettingsPage
 * passes testIdPrefix="partner-settings" with the camelCase TabKey, so the tab
 * is `partner-settings-tab-aiProvider` (the URL hash stays `ai-provider`).
 * Every locator is a `data-testid` (e2e-tests/README.md).
 */
export class PartnerAiModelsPage extends BasePage {
  url = '/settings/partner#ai-provider';
  tab = () => this.page.getByTestId('partner-settings-tab-aiProvider');
  root = () => this.page.getByTestId('ai-models-tab');
  connectionRow = (id: string | null) => this.page.getByTestId(`ai-connection-row-${id ?? 'platform'}`);
  residencySwitch = () => this.page.getByTestId('ai-residency-switch');
  residencyConfirm = () => this.page.getByTestId('ai-residency-confirm');
  residencyConfirmCancel = () => this.page.getByTestId('ai-residency-confirm-cancel');
  offeringEnable = (rowKey: string) => this.page.getByTestId(`ai-offering-enable-${rowKey}`);
  /** Every enable switch on the card, for tests that do not know the row keys. */
  anyOfferingEnable = () => this.page.getByTestId(/^ai-offering-enable-/);
  offeringEdit = (rowKey: string) => this.page.getByTestId(`ai-offering-edit-${rowKey}`);
  offeringDrawer = () => this.page.getByTestId('ai-offering-drawer');
  offeringPremium = () => this.page.getByTestId('ai-offering-premium');
  offeringSave = () => this.page.getByTestId('ai-offering-save');
  offeringDisableConfirm = () => this.page.getByTestId('ai-offering-disable-confirm');
  offeringDisableConfirmSurfaces = () => this.page.getByTestId('ai-offering-disable-confirm-surfaces');
  defaultsSelect = (surface: string) => this.page.getByTestId(`ai-defaults-default-${surface}`);
  defaultsSave = () => this.page.getByTestId('ai-defaults-save');

  async goto() {
    await this.page.goto(this.url);
    await waitForAppReady(this.page, 'ai-models-tab');
  }
}
