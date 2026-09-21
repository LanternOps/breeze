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
    expect(screen.getByRole('link', { name: 'Monitores' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Regras' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Entrega' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Canais' })).not.toBeInTheDocument();
  });

  it('points the rules tab at the Legacy rules page (#5289) and the delivery tab at /alerts/delivery (W05b)', () => {
    render(<AlertsTabStrip />);
    expect(screen.getByRole('link', { name: 'Monitors' })).toHaveAttribute('href', '/alerts/monitors');
    expect(screen.getByRole('link', { name: 'Rules' })).toHaveAttribute('href', '/alerts/rules');
    expect(screen.getByRole('link', { name: 'Delivery' })).toHaveAttribute('href', '/alerts/delivery');
    expect(screen.queryByRole('link', { name: 'Channels' })).not.toBeInTheDocument();
  });

  it('marks the delivery tab active for /alerts/delivery and for the redirected legacy paths', () => {
    const { unmount } = render(<AlertsTabStrip currentPath="/alerts/delivery" />);
    expect(screen.getByRole('link', { name: 'Delivery' })).toHaveAttribute('aria-current', 'page');
    unmount();
    render(<AlertsTabStrip currentPath="/alerts/channels" />);
    expect(screen.getByRole('link', { name: 'Delivery' })).toHaveAttribute('aria-current', 'page');
  });
});
