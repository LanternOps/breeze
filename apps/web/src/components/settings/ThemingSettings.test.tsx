import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { i18n } from '../../lib/i18n';
import ThemingSettings from './ThemingSettings';

const mocks = vi.hoisted(() => ({
  saveUserPreferences: vi.fn(),
  applyLocale: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('../../lib/userPreferences', () => ({
  saveUserPreferences: mocks.saveUserPreferences,
}));

vi.mock('../shared/Toast', () => ({
  showToast: mocks.showToast,
}));

// `applyLocale` defaults to the real implementation (so the happy-path pt-BR
// flow below still exercises the actual lazy-chunk load); individual tests
// override it with mockResolvedValueOnce to simulate a locale-load failure
// without needing to break the real dynamic import. `real` is a mutable
// holder (not a plain `let`) so the vi.mock factory below — hoisted above
// this declaration — can safely close over it.
const real = vi.hoisted(() => ({
  applyLocale: undefined as unknown as typeof import('../../lib/i18n')['applyLocale'],
}));
vi.mock('../../lib/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/i18n')>();
  real.applyLocale = actual.applyLocale;
  return {
    ...actual,
    applyLocale: (...args: Parameters<typeof actual.applyLocale>) => mocks.applyLocale(...args),
  };
});

describe('ThemingSettings language fieldset', () => {
  beforeEach(async () => {
    window.localStorage.clear();
    await i18n.changeLanguage('en');
    mocks.saveUserPreferences.mockReset();
    mocks.saveUserPreferences.mockImplementation(async (preferences) => preferences);
    mocks.showToast.mockReset();
    mocks.applyLocale.mockReset();
    mocks.applyLocale.mockImplementation((...args: Parameters<typeof real.applyLocale>) =>
      real.applyLocale(...args)
    );
  });

  it('renders all supported language options', () => {
    render(<ThemingSettings />);
    expect(screen.getByText('Language')).toBeInTheDocument();
    expect(screen.getByText('English')).toBeInTheDocument();
    expect(screen.getByText('Português (Brasil)')).toBeInTheDocument();
    expect(screen.getByText('Español (Latinoamérica)')).toBeInTheDocument();
    expect(screen.getByText('Français (France)')).toBeInTheDocument();
    expect(screen.getByText('Deutsch (Deutschland)')).toBeInTheDocument();
    expect(screen.getByText('Italiano (Italia)')).toBeInTheDocument();
  });

  it('applies and persists pt-BR when selected', async () => {
    const user = userEvent.setup();
    render(<ThemingSettings />);

    await user.click(screen.getByText('Português (Brasil)'));

    expect(mocks.saveUserPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ locale: 'pt-BR' }),
      expect.any(String),
    );
    expect(window.localStorage.getItem('breeze.locale')).toBe('pt-BR');
    expect(await screen.findByText('Preferências de tema salvas.')).toBeInTheDocument();
  });

  it('shows an error toast instead of the success banner when the locale chunk fails to load', async () => {
    mocks.applyLocale.mockResolvedValueOnce({ locale: 'pt-BR', usedFallback: true });

    const user = userEvent.setup();
    render(<ThemingSettings />);

    await user.click(screen.getByText('Português (Brasil)'));

    expect(mocks.saveUserPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ locale: 'pt-BR' }),
      expect.any(String),
    );
    // The preference itself still saved — only the language chunk failed —
    // so the unconditional success banner must not appear.
    expect(screen.queryByText('Theming preferences saved.')).not.toBeInTheDocument();
    expect(screen.queryByText('Preferências de tema salvas.')).not.toBeInTheDocument();

    // The appearance-store `locale` subscriber (wired up once, internally, by
    // '../../lib/i18n' itself) reacts to `applyAppearancePreferences` in
    // real time and isn't affected by this file's `applyLocale` export mock,
    // so by the time the toast fires the real i18n instance may already have
    // switched language — read the expected copy through `i18n.t` rather
    // than hardcoding one locale's string.
    expect(mocks.showToast).toHaveBeenCalledWith({
      type: 'error',
      message: i18n.t('settings:themingSettings.languageLoadFailed'),
    });
  });
});
