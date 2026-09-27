import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '@/lib/i18n';

import AutomationsPage from './AutomationsPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', async () => {
  const actual = await vi.importActual<typeof import('../../stores/auth')>('../../stores/auth');
  return {
    ...actual,
    fetchWithAuth: vi.fn(),
    useAuthStore: () => undefined,
  };
});
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown): Response =>
  ({ ok: true, status: 200, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function renderPage() {
  return render(<I18nextProvider i18n={i18n}><AutomationsPage /></I18nextProvider>);
}

// #7148: at 390px this row was cut mid-word ("Event rules" clipped by 33px)
// with no scroll or More affordance. This surface stayed a plain button row
// (not the shared OverflowTabs component) because an existing test contract
// (AutomationsPage.tabs.test.tsx, plus the reverse trigger-filter mapping it
// drives) depends on `role="button"` + `aria-current="page"` semantics that
// OverflowTabs' ARIA tabs pattern (`role="tab"` + `aria-selected`) doesn't
// provide. The fix is a horizontally scrollable row instead.
describe('AutomationsPage tabs (#7148)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
    fetchMock.mockResolvedValue(json({ data: [] }));
  });

  it('scrolls horizontally instead of clipping tabs off-screen', async () => {
    renderPage();
    const nav = await screen.findByRole('navigation');
    expect(nav.className).toContain('overflow-x-auto');
    for (const button of screen.getAllByRole('button', { name: /./ })) {
      if (!button.hasAttribute('data-testid') || !button.getAttribute('data-testid')?.startsWith('automations-tab-')) continue;
      expect(button.className).toContain('shrink-0');
      expect(button.className).toContain('whitespace-nowrap');
    }
  });

  it('still switches tabs and syncs the URL hash (plain buttons + aria-current preserved)', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('automations-tab-all')).toBeInTheDocument());

    const scheduled = screen.getByRole('button', { name: 'Scheduled' });
    expect(scheduled).toBe(screen.getByTestId('automations-tab-scheduled'));
    scheduled.click();

    await waitFor(() => expect(window.location.hash).toBe('#scheduled'));
    expect(scheduled).toHaveAttribute('aria-current', 'page');
  });
});
