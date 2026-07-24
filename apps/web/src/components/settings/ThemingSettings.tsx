import { useCallback, useEffect, useState } from 'react';
import { AlignJustify, Check, Clock, Monitor, Moon, Rows3, Rows4, Sun, Type } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { UserPreferences } from '../../stores/auth';
import {
  applyAppearancePreferences,
  normalizeDensity,
  normalizeFont,
  normalizeLocale,
  normalizeTheme,
  normalizeTimeFormat,
  readDensity,
  readFontPreference,
  readResolvedLocalePreference,
  readResolvedTimeFormatPreference,
  readThemePreference,
  subscribeDensity,
  subscribeFont,
  subscribeLocale,
  subscribeTimeFormat,
  subscribeTheme,
  type Density,
  type FontPreference,
  type LocalePreference,
  type TimeFormatPreference,
  type ThemePreference,
} from '@/lib/appearance';
import { saveUserPreferences } from '@/lib/userPreferences';
import { applyLocale, i18n } from '@/lib/i18n';
import { showToast } from '../shared/Toast';

const themeOptions = [
  { value: 'light' as const, labelKey: 'themingSettings.light', Icon: Sun },
  { value: 'dark' as const, labelKey: 'themingSettings.dark', Icon: Moon },
  { value: 'system' as const, labelKey: 'themingSettings.system', Icon: Monitor },
];

const densityOptions = [
  { value: 'comfortable' as const, labelKey: 'themingSettings.comfortable', Icon: Rows3 },
  { value: 'compact' as const, labelKey: 'themingSettings.compact', Icon: Rows4 },
  { value: 'dense' as const, labelKey: 'themingSettings.dense', Icon: AlignJustify },
];

const fontOptions = [
  { value: 'breeze' as const, labelKey: 'themingSettings.breezeDefault', descriptionKey: 'themingSettings.plusJakartaSans', Icon: Type },
  { value: 'system' as const, labelKey: 'themingSettings.system', descriptionKey: 'themingSettings.oSInterfaceFont', Icon: Monitor },
];

const timeFormatOptions = [
  { value: '12h' as const, labelKey: 'themingSettings.hour', descriptionKey: 'themingSettings.pM', description: undefined },
  { value: '24h' as const, labelKey: 'themingSettings.hour2', descriptionKey: undefined, description: '15:45' },
];

const localeOptions = [
  { value: 'en' as const, labelKey: 'language.englishLabel', defaultLabel: 'English', descriptionKey: 'language.englishDescription', defaultDescription: 'English (United States)' },
  { value: 'pt-BR' as const, labelKey: 'language.ptBRLabel', defaultLabel: 'Português (Brasil)', descriptionKey: 'language.ptBRDescription', defaultDescription: 'Portuguese (Brazil)' },
  { value: 'es-419' as const, labelKey: 'language.es419Label', defaultLabel: 'Español (Latinoamérica)', descriptionKey: 'language.es419Description', defaultDescription: 'Spanish (Latin America)' },
  { value: 'fr-FR' as const, labelKey: 'language.frFRLabel', defaultLabel: 'Français (France)', descriptionKey: 'language.frFRDescription', defaultDescription: 'French (France)' },
  { value: 'fr-CA' as const, labelKey: 'language.frCALabel', defaultLabel: 'Français (Canada)', descriptionKey: 'language.frCADescription', defaultDescription: 'French (Canada)' },
  { value: 'de-DE' as const, labelKey: 'language.deDELabel', defaultLabel: 'Deutsch (Deutschland)', descriptionKey: 'language.deDEDescription', defaultDescription: 'German (Germany)' },
];

function resolveAppearance(preferences?: UserPreferences | null): Required<UserPreferences> {
  return {
    theme: normalizeTheme(preferences?.theme) ?? readThemePreference(),
    density: normalizeDensity(preferences?.density) ?? readDensity(),
    font: normalizeFont(preferences?.font) ?? readFontPreference(),
    timeFormat: normalizeTimeFormat(preferences?.timeFormat) ?? readResolvedTimeFormatPreference(),
    locale: normalizeLocale(preferences?.locale) ?? readResolvedLocalePreference(),
  };
}

type ThemingSettingsProps = {
  preferences?: UserPreferences | null;
  onSaved?: (preferences: UserPreferences) => void;
};

export default function ThemingSettings({ preferences, onSaved }: ThemingSettingsProps) {
  const { t } = useTranslation('settings');
  const [themePreference, setThemePreference] = useState<ThemePreference>('system');
  const [densityPreference, setDensityPreference] = useState<Density>('comfortable');
  const [fontPreference, setFontPreference] = useState<FontPreference>('breeze');
  const [timeFormatPreference, setTimeFormatPreference] = useState<TimeFormatPreference>(readResolvedTimeFormatPreference);
  const [localePreference, setLocalePreference] = useState<LocalePreference>(readResolvedLocalePreference);
  const [appearanceError, setAppearanceError] = useState<string | undefined>();
  const [appearanceSuccess, setAppearanceSuccess] = useState<string | undefined>();
  const [isSavingAppearance, setIsSavingAppearance] = useState(false);

  const syncAppearanceState = useCallback((nextPreferences?: UserPreferences | null) => {
    const next = resolveAppearance(nextPreferences);
    setThemePreference(next.theme);
    setDensityPreference(next.density);
    setFontPreference(next.font);
    setTimeFormatPreference(next.timeFormat);
    setLocalePreference(next.locale);
  }, []);

  useEffect(() => {
    syncAppearanceState(preferences);
  }, [preferences, syncAppearanceState]);

  useEffect(() => {
    const unsubscribeTheme = subscribeTheme(setThemePreference);
    const unsubscribeDensity = subscribeDensity(setDensityPreference);
    const unsubscribeFont = subscribeFont(setFontPreference);
    const unsubscribeTimeFormat = subscribeTimeFormat(setTimeFormatPreference);
    const unsubscribeLocale = subscribeLocale(setLocalePreference);

    return () => {
      unsubscribeTheme();
      unsubscribeDensity();
      unsubscribeFont();
      unsubscribeTimeFormat();
      unsubscribeLocale();
    };
  }, []);

  const handleAppearanceChange = async (
    patch: Partial<Pick<Required<UserPreferences>, 'theme' | 'density' | 'font' | 'timeFormat' | 'locale'>>
  ) => {
    const next: Required<UserPreferences> = {
      theme: patch.theme ?? themePreference,
      density: patch.density ?? densityPreference,
      font: patch.font ?? fontPreference,
      timeFormat: patch.timeFormat ?? timeFormatPreference,
      locale: patch.locale ?? localePreference,
    };

    setThemePreference(next.theme);
    setDensityPreference(next.density);
    setFontPreference(next.font);
    setTimeFormatPreference(next.timeFormat);
    setLocalePreference(next.locale);
    setAppearanceError(undefined);
    setAppearanceSuccess(undefined);
    applyAppearancePreferences(next);

    try {
      setIsSavingAppearance(true);
      const saved = await saveUserPreferences(next, 'Failed to save theming preferences');
      const resolved = resolveAppearance(saved);
      setThemePreference(resolved.theme);
      setDensityPreference(resolved.density);
      setFontPreference(resolved.font);
      setTimeFormatPreference(resolved.timeFormat);
      setLocalePreference(resolved.locale);
      onSaved?.(saved);
      // The locale subscriber loads language chunks asynchronously. Await the
      // selected locale before deriving the success message so a language
      // switch cannot retain the translator captured by the English render.
      const localeResult = patch.locale ? await applyLocale(resolved.locale) : undefined;
      if (localeResult?.usedFallback) {
        // The preference itself saved fine, but the requested language chunk
        // failed to load and English rendered instead — the unconditional
        // success banner would be a silent lie about what's on screen.
        showToast({ type: 'error', message: i18n.t('settings:themingSettings.languageLoadFailed') });
      } else {
        setAppearanceSuccess(i18n.t('settings:themingSettings.themingPreferencesSaved'));
      }
    } catch (error) {
      setAppearanceError(error instanceof Error ? error.message : t('themingSettings.failedToSaveThemingPreferences'));
    } finally {
      setIsSavingAppearance(false);
    }
  };

  return (
    <section className="space-y-6 rounded-lg border bg-card p-6 shadow-xs">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t('themingSettings.theming')}</h2>
        <p className="text-sm text-muted-foreground">{t('themingSettings.setYourDisplayPreferencesForThisAccount')}</p>
      </div>

      <div className="space-y-5">
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t('themingSettings.theme')}</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {themeOptions.map(({ value, labelKey, Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => void handleAppearanceChange({ theme: value })}
                aria-pressed={themePreference === value}
                disabled={isSavingAppearance}
                className={`flex h-10 items-center justify-center gap-2 rounded-md border px-3 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60 ${
                  themePreference === value ? 'border-primary bg-primary/10 text-primary' : 'bg-background'
                }`}
              >
                <Icon className="h-4 w-4" />
                <span>{t(/* i18n-dynamic */ labelKey)}</span>
                {themePreference === value && <Check className="h-4 w-4" />}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t('themingSettings.interfaceDensity')}</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {densityOptions.map(({ value, labelKey, Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => void handleAppearanceChange({ density: value })}
                aria-pressed={densityPreference === value}
                disabled={isSavingAppearance}
                className={`flex h-10 items-center justify-center gap-2 rounded-md border px-3 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60 ${
                  densityPreference === value ? 'border-primary bg-primary/10 text-primary' : 'bg-background'
                }`}
              >
                <Icon className="h-4 w-4" />
                <span>{t(/* i18n-dynamic */ labelKey)}</span>
                {densityPreference === value && <Check className="h-4 w-4" />}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t('themingSettings.fontSelection')}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {fontOptions.map(({ value, labelKey, descriptionKey, Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => void handleAppearanceChange({ font: value })}
                aria-pressed={fontPreference === value}
                disabled={isSavingAppearance}
                className={`flex min-h-14 items-center gap-3 rounded-md border px-3 py-2 text-left text-sm transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60 ${
                  fontPreference === value ? 'border-primary bg-primary/10 text-primary' : 'bg-background'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{t(/* i18n-dynamic */ labelKey)}</span>
                  <span className="block text-xs text-muted-foreground">{t(/* i18n-dynamic */ descriptionKey)}</span>
                </span>
                {fontPreference === value && <Check className="h-4 w-4 shrink-0" />}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t('themingSettings.timeFormat')}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {timeFormatOptions.map(({ value, labelKey, ...option }) => (
              <button
                key={value}
                type="button"
                onClick={() => void handleAppearanceChange({ timeFormat: value })}
                aria-pressed={timeFormatPreference === value}
                disabled={isSavingAppearance}
                className={`flex min-h-14 items-center gap-3 rounded-md border px-3 py-2 text-left text-sm transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60 ${
                  timeFormatPreference === value ? 'border-primary bg-primary/10 text-primary' : 'bg-background'
                }`}
              >
                <Clock className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{t(/* i18n-dynamic */ labelKey)}</span>
                  <span className="block text-xs text-muted-foreground">{option.descriptionKey ? t(/* i18n-dynamic */ option.descriptionKey) : option.description}</span>
                </span>
                {timeFormatPreference === value && <Check className="h-4 w-4 shrink-0" />}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium" data-testid="theming-language-legend">
            {t('language.title', { defaultValue: 'Language' })}
          </legend>
          <p className="text-xs text-muted-foreground">
            {t('language.description', {
              defaultValue: 'Language for the Breeze console. More languages coming — contributions welcome.',
            })}
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {localeOptions.map(({ value, labelKey, defaultLabel, descriptionKey, defaultDescription }) => (
              <button
                key={value}
                type="button"
                data-testid={`locale-option-${value}`}
                onClick={() => void handleAppearanceChange({ locale: value })}
                aria-pressed={localePreference === value}
                disabled={isSavingAppearance}
                className={`flex min-h-14 items-center gap-3 rounded-md border px-3 py-2 text-left text-sm transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60 ${
                  localePreference === value ? 'border-primary bg-primary/10 text-primary' : 'bg-background'
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{t(/* i18n-dynamic */ labelKey, { defaultValue: defaultLabel })}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t(/* i18n-dynamic */ descriptionKey, { defaultValue: defaultDescription })}
                  </span>
                </span>
                {localePreference === value && <Check className="h-4 w-4 shrink-0" />}
              </button>
            ))}
          </div>
        </fieldset>
      </div>

      {appearanceSuccess && (
        <div
          className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-600"
          data-testid="theming-appearance-success"
        >
          {appearanceSuccess}
        </div>
      )}
      {appearanceError && (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          data-testid="theming-appearance-error"
        >
          {appearanceError}
        </div>
      )}
    </section>
  );
}
