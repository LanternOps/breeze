import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { i18n } from '../../lib/i18n';
import ThemingSettings from './ThemingSettings';

const mocks = vi.hoisted(() => ({
  saveUserPreferences: vi.fn(),
}));

vi.mock('../../lib/userPreferences', () => ({
  saveUserPreferences: mocks.saveUserPreferences,
}));

describe('ThemingSettings language fieldset', () => {
  beforeEach(async () => {
    window.localStorage.clear();
    await i18n.changeLanguage('en');
    mocks.saveUserPreferences.mockReset();
    mocks.saveUserPreferences.mockImplementation(async (preferences) => preferences);
  });

  it('renders both supported language options', () => {
    render(<ThemingSettings />);
    expect(screen.getByText('Language')).toBeInTheDocument();
    expect(screen.getByText('English')).toBeInTheDocument();
    expect(screen.getByText('Português (Brasil)')).toBeInTheDocument();
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
  });
});
