import { BasePage } from './BasePage';

/**
 * /settings/profile — the "Appearance" (Theming) card, including the
 * Language fieldset. Also exposes the org-switcher trigger in the Header
 * island (pre-existing testid, unrelated component) so specs can assert
 * that a locale switch propagates to islands other than the settings page
 * itself, without a full reload.
 */
export class SettingsAppearancePage extends BasePage {
  url = '/settings/profile';

  languageLegend = () => this.page.getByTestId('theming-language-legend');
  localeOptionEn = () => this.page.getByTestId('locale-option-en');
  localeOptionPtBR = () => this.page.getByTestId('locale-option-pt-BR');
  appearanceSuccess = () => this.page.getByTestId('theming-appearance-success');
  appearanceError = () => this.page.getByTestId('theming-appearance-error');

  // Header island (apps/web/src/components/layout/OrgSwitcher.tsx) — mounted
  // as a sibling Astro island (`<Header client:load transition:persist />`
  // in DashboardLayout.astro), independent from the `<ProfilePage client:load
  // />` island the Language fieldset above lives in.
  orgSwitcherTrigger = () => this.page.getByTestId('org-switcher-trigger');

  async goto() {
    await this.page.goto(this.url);
    await this.languageLegend().waitFor();
  }
}
