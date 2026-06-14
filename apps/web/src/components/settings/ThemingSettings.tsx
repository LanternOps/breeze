import { useCallback, useEffect, useState } from 'react';
import { AlignJustify, Check, Monitor, Moon, Rows3, Rows4, Sun, Type } from 'lucide-react';
import type { UserPreferences } from '../../stores/auth';
import {
  applyAppearancePreferences,
  normalizeDensity,
  normalizeFont,
  normalizeTheme,
  readDensity,
  readFontPreference,
  readThemePreference,
  subscribeDensity,
  subscribeFont,
  subscribeTheme,
  type Density,
  type FontPreference,
  type ThemePreference,
} from '@/lib/appearance';
import { saveUserPreferences } from '@/lib/userPreferences';

const themeOptions = [
  { value: 'light' as const, label: 'Light', Icon: Sun },
  { value: 'dark' as const, label: 'Dark', Icon: Moon },
  { value: 'system' as const, label: 'System', Icon: Monitor },
];

const densityOptions = [
  { value: 'comfortable' as const, label: 'Comfortable', Icon: Rows3 },
  { value: 'compact' as const, label: 'Compact', Icon: Rows4 },
  { value: 'dense' as const, label: 'Dense', Icon: AlignJustify },
];

const fontOptions = [
  { value: 'breeze' as const, label: 'Breeze default', description: 'Plus Jakarta Sans', Icon: Type },
  { value: 'system' as const, label: 'System', description: 'OS interface font', Icon: Monitor },
];

function resolveAppearance(preferences?: UserPreferences | null): Required<UserPreferences> {
  return {
    theme: normalizeTheme(preferences?.theme) ?? readThemePreference(),
    density: normalizeDensity(preferences?.density) ?? readDensity(),
    font: normalizeFont(preferences?.font) ?? readFontPreference(),
  };
}

type ThemingSettingsProps = {
  preferences?: UserPreferences | null;
  onSaved?: (preferences: UserPreferences) => void;
};

export default function ThemingSettings({ preferences, onSaved }: ThemingSettingsProps) {
  const [themePreference, setThemePreference] = useState<ThemePreference>('system');
  const [densityPreference, setDensityPreference] = useState<Density>('comfortable');
  const [fontPreference, setFontPreference] = useState<FontPreference>('breeze');
  const [appearanceError, setAppearanceError] = useState<string | undefined>();
  const [appearanceSuccess, setAppearanceSuccess] = useState<string | undefined>();
  const [isSavingAppearance, setIsSavingAppearance] = useState(false);

  const syncAppearanceState = useCallback((nextPreferences?: UserPreferences | null) => {
    const next = resolveAppearance(nextPreferences);
    setThemePreference(next.theme);
    setDensityPreference(next.density);
    setFontPreference(next.font);
  }, []);

  useEffect(() => {
    syncAppearanceState(preferences);
  }, [preferences, syncAppearanceState]);

  useEffect(() => {
    const unsubscribeTheme = subscribeTheme(setThemePreference);
    const unsubscribeDensity = subscribeDensity(setDensityPreference);
    const unsubscribeFont = subscribeFont(setFontPreference);

    return () => {
      unsubscribeTheme();
      unsubscribeDensity();
      unsubscribeFont();
    };
  }, []);

  const handleAppearanceChange = async (
    patch: Partial<Pick<Required<UserPreferences>, 'theme' | 'density' | 'font'>>
  ) => {
    const next: Required<UserPreferences> = {
      theme: patch.theme ?? themePreference,
      density: patch.density ?? densityPreference,
      font: patch.font ?? fontPreference,
    };

    setThemePreference(next.theme);
    setDensityPreference(next.density);
    setFontPreference(next.font);
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
      onSaved?.(saved);
      setAppearanceSuccess('Theming preferences saved.');
    } catch (error) {
      setAppearanceError(error instanceof Error ? error.message : 'Failed to save theming preferences');
    } finally {
      setIsSavingAppearance(false);
    }
  };

  return (
    <section className="space-y-6 rounded-lg border bg-card p-6 shadow-sm">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Theming</h2>
        <p className="text-sm text-muted-foreground">Set your display preferences for this account.</p>
      </div>

      <div className="space-y-5">
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Theme</legend>
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
          <legend className="text-sm font-medium">Interface density</legend>
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
          <legend className="text-sm font-medium">Font selection</legend>
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
