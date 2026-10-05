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

  // --- W06 (#7604): OpenAI-compatible connections ---------------------------
  connectionsCard = () => this.page.getByTestId('ai-connections-card');
  /** Connection rows only (testid `ai-connection-row-<id|platform>`); sub-element testids share the prefix, so they are excluded. */
  anyConnectionRow = () => this.page.getByTestId(/^ai-connection-row-(?!host-)/);
  addConnection = () => this.page.getByTestId('ai-connection-add');
  addConnectionKindOpenAi = () => this.page.getByTestId('ai-connection-add-kind-openai');
  connectionDrawer = () => this.page.getByTestId('ai-connection-drawer');
  openAiName = () => this.page.getByTestId('ai-connection-openai-name');
  openAiBaseUrl = () => this.page.getByTestId('ai-connection-openai-base-url');
  openAiApiKey = () => this.page.getByTestId('ai-connection-openai-api-key');
  connectionSave = () => this.page.getByTestId('ai-connection-save');
  connectionStatus = (id: string) => this.page.getByTestId(`ai-connection-status-${id}`);
  modelsGroup = (connectionId: string) => this.page.getByTestId(`ai-models-group-${connectionId}`);
  /** Offering rows inside one connection's group (testid `ai-offering-row-<offeringId>`). */
  offeringRows = (connectionId: string) => this.modelsGroup(connectionId).getByTestId(/^ai-offering-row-/);
  offeringVerification = (offeringId: string) => this.page.getByTestId(`ai-model-verification-${offeringId}`);
  offeringVerify = () => this.page.getByTestId('ai-offering-verify');
  offeringCancel = () => this.page.getByTestId('ai-offering-cancel');
  offeringPrice = (field: 'input' | 'output' | 'cacheRead' | 'cacheWrite') => this.page.getByTestId(`ai-offering-price-${field}`);

  /** Opens the add-connection chooser and the OpenAI-compatible form. */
  async openAddOpenAiConnection() {
    await this.addConnection().click();
    await this.addConnectionKindOpenAi().click();
    await this.connectionDrawer().waitFor();
  }

  /** Ids of the connection rows currently shown (excludes the platform row). */
  async connectionIds(): Promise<string[]> {
    const ids = await this.anyConnectionRow().evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? ''));
    return ids.map((t) => t.replace('ai-connection-row-', '')).filter((id) => id && id !== 'platform');
  }

  async goto() {
    await this.page.goto(this.url);
    await waitForAppReady(this.page, 'ai-models-tab');
  }
}
