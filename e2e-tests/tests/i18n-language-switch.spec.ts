import { test, expect } from '../fixtures';
import { SettingsAppearancePage } from '../pages/SettingsAppearancePage';

// Exact strings pulled from apps/web/src/locales/{en,pt-BR}/{common,settings}.json.
// settings.json: language.title, themingSettings.themingPreferencesSaved,
// language.englishDescription, language.ptBRDescription.
// common.json: layout.org.selectTitle (org-switcher-trigger `title` attribute).
const EN = {
  languageTitle: 'Language',
  saved: 'Theming preferences saved.',
  englishDescription: 'English (United States)',
  ptBRDescription: 'Portuguese (Brazil)',
  orgSwitcherTitle: 'Select Organization (Cmd+O)',
};

const PT_BR = {
  languageTitle: 'Idioma',
  saved: 'Preferências de tema salvas.',
  englishDescription: 'Inglês (Estados Unidos)',
  ptBRDescription: 'Português (Brasil)',
  orgSwitcherTitle: 'Selecionar organização (Cmd+O)',
};

// The `users.preferences.locale` change made below is real server-side state
// shared by every context that logs in as E2E_ADMIN_EMAIL, so this spec must
// run to completion serially and always leave the account in `en` — see the
// final assertions block.
test.describe.configure({ mode: 'serial' });

test.describe('Cross-island language switching', () => {
  test('pt-BR selection propagates to independent islands, survives reload, and reverts to en', async ({ authedPage }) => {
    test.setTimeout(60_000);
    const settings = new SettingsAppearancePage(authedPage);
    await settings.goto();

    // Force a known baseline regardless of locale state left over from a
    // prior (possibly interrupted) run of this spec.
    await settings.localeOptionEn().click();
    await expect(settings.appearanceSuccess()).toHaveText(EN.saved);
    await expect(settings.languageLegend()).toHaveText(EN.languageTitle);
    await expect(settings.orgSwitcherTrigger()).toHaveAttribute('title', EN.orgSwitcherTitle);

    // --- Switch to pt-BR and save ------------------------------------------------
    await settings.localeOptionPtBR().click();
    await expect(settings.appearanceSuccess()).toHaveText(PT_BR.saved);

    // (a) Island 1 — the settings page content itself (the ProfilePage /
    // ThemingSettings Astro island) re-renders in Portuguese with no reload.
    await expect(settings.languageLegend()).toHaveText(PT_BR.languageTitle);
    await expect(settings.localeOptionEn()).toContainText(PT_BR.englishDescription);
    await expect(settings.localeOptionPtBR()).toContainText(PT_BR.ptBRDescription);

    // Island 2 — the Header island (`<Header client:load transition:persist />`
    // in DashboardLayout.astro), a completely independent Astro island from
    // the settings page content above, also updates with no reload.
    await expect(settings.orgSwitcherTrigger()).toHaveAttribute('title', PT_BR.orgSwitcherTitle);

    // --- (b) Full reload: restoration is deferred until Astro hydration --------
    // finishes (scheduleStoredLocaleAfterHydration), so poll rather than
    // asserting immediately after reload.
    await authedPage.reload();
    await settings.languageLegend().waitFor();
    await settings.orgSwitcherTrigger().waitFor();

    // localStorage-derived state (aria-pressed) is available at first mount.
    await expect(settings.localeOptionPtBR()).toHaveAttribute('aria-pressed', 'true');

    // i18next-derived text/attributes only flip once hydration completes.
    await expect
      .poll(async () => settings.languageLegend().textContent(), { timeout: 15_000 })
      .toBe(PT_BR.languageTitle);
    await expect
      .poll(async () => settings.orgSwitcherTrigger().getAttribute('title'), { timeout: 15_000 })
      .toBe(PT_BR.orgSwitcherTitle);

    // --- (c) Switch back to en and verify both islands again --------------------
    await settings.localeOptionEn().click();
    await expect(settings.appearanceSuccess()).toHaveText(EN.saved);
    await expect(settings.languageLegend()).toHaveText(EN.languageTitle);
    await expect(settings.localeOptionEn()).toContainText(EN.englishDescription);
    await expect(settings.localeOptionPtBR()).toContainText(EN.ptBRDescription);
    await expect(settings.orgSwitcherTrigger()).toHaveAttribute('title', EN.orgSwitcherTitle);
  });
});
