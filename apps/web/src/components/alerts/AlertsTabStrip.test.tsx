import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { i18n, loadLocale } from '@/lib/i18n';

vi.mock('../../hooks/useMlFeatureFlags', () => ({
  useMlFeatureFlags: () => ({ isDisabled: () => false }),
}));

import AlertsTabStrip from './AlertsTabStrip';

describe('AlertsTabStrip', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  afterEach(async () => {
    await act(() => i18n.changeLanguage('en'));
  });

  it('localizes all alert section tabs in Brazilian Portuguese', async () => {
    await loadLocale('pt-BR');
    await act(() => i18n.changeLanguage('pt-BR'));

    render(<AlertsTabStrip />);

    expect(screen.getByRole('link', { name: 'Alertas' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Correlações' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Regras' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Canais' })).toBeInTheDocument();
  });
});
