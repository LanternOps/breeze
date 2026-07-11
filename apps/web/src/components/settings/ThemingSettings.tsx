import { i18n } from '@/lib/i18n';
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
import '@/lib/i18n';

const themeOptions = [
  { value: 'light' as const, label: i18n.t('settings:themingSettings.light'), Icon: Sun },
  { value: 'dark' as const, label: i18n.t('settings:themingSettings.dark'), Icon: Moon },
  { value: 'system' as const, label: i18n.t('settings:themingSettings.system'), Icon: Monitor },
];

const densityOptions = [
  { value: 'comfortable' as const, label: i18n.t('settings:themingSettings.comfortable'), Icon: Rows3 },
  { value: 'compact' as const, label: i18n.t('settings:themingSettings.compact'), Icon: Rows4 },
  { value: 'dense' as const, label: i18n.t('settings:themingSettings.dense'), Icon: AlignJustify },
];

const fontOptions = [
  { value: 'breeze' as const, label: i18n.t('settings:themingSettings.breezeDefault'), description: i18n.t('settings:themingSettings.plusJakartaSans'), Icon: Type },
  { value: 'system' as const, label: i18n.t('settings:themingSettings.system'), description: i18n.t('settings:themingSettings.oSInterfaceFont'), Icon: Monitor },
];

const timeFormatOptions = [
  { value: '12h' as const, label: i18n.t('settings:themingSettings.hour'), description: i18n.t('settings:themingSettings.pM') },
  { value: '24h' as const, label: i18n.t('settings:themingSettings.hour2'), description: '15:45' },
];

const localeOptions = [
  { value: 'en' as const, labelKey: 'language.englishLabel', defaultLabel: 'English', descriptionKey: 'language.englishDescription', defaultDescription: 'English (United States)' },
  { value: 'pt-BR' as const, labelKey: 'language.ptBRLabel', defaultLabel: 'Português (Brasil)', descriptionKey: 'language.ptBRDescription', defaultDescription: 'Portuguese (Brazil)' },
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
      setAppearanceSuccess(t('themingSettings.themingPreferencesSaved'));
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
            {themeOptions.map(({ value, label, Icon }) => (
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
                <span>{label}</span>
                {themePreference === value && <Check className="h-4 w-4" />}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t('themingSettings.interfaceDensity')}</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {densityOptions.map(({ value, label, Icon }) => (
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
                <span>{label}</span>
                {densityPreference === value && <Check className="h-4 w-4" />}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t('themingSettings.fontSelection')}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {fontOptions.map(({ value, label, description, Icon }) => (
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
                  <span className="block font-medium">{label}</span>
                  <span className="block text-xs text-muted-foreground">{description}</span>
                </span>
                {fontPreference === value && <Check className="h-4 w-4 shrink-0" />}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t('themingSettings.timeFormat')}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {timeFormatOptions.map(({ value, label, description }) => (
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
                  <span className="block font-medium">{label}</span>
                  <span className="block text-xs text-muted-foreground">{description}</span>
                </span>
                {timeFormatPreference === value && <Check className="h-4 w-4 shrink-0" />}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">
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
                onClick={() => void handleAppearanceChange({ locale: value })}
                aria-pressed={localePreference === value}
                disabled={isSavingAppearance}
                className={`flex min-h-14 items-center gap-3 rounded-md border px-3 py-2 text-left text-sm transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60 ${
                  localePreference === value ? 'border-primary bg-primary/10 text-primary' : 'bg-background'
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{t(labelKey, { defaultValue: defaultLabel })}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t(descriptionKey, { defaultValue: defaultDescription })}
                  </span>
                </span>
                {localePreference === value && <Check className="h-4 w-4 shrink-0" />}
              </button>
            ))}
          </div>
        </fieldset>
      </div>

      {appearanceSuccess && (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-600">
          {appearanceSuccess}
        </div>
      )}
      {appearanceError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {appearanceError}
        </div>
      )}
    </section>
  );
}
