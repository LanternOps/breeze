import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
// with no scroll or More affordance. Moved onto the shared OverflowTabs
// component, which folds overflow into a "More" menu instead of clipping.
describe('AutomationsPage tabs (#7148)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
    fetchMock.mockResolvedValue(json({ data: [] }));
  });

  it('uses OverflowTabs (a role="tablist" nav)', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole('tablist')).toBeInTheDocument());
    expect(screen.getByTestId('automations-tab-all')).toBeInTheDocument();
  });

  it('switches tabs and syncs the URL hash', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole('tablist')).toBeInTheDocument());

    // jsdom reports 0 for offsetWidth/clientWidth, so OverflowTabs collapses
    // every tab past the first behind "More" (see OverflowTabs.tsx
    // computeVisible) — open it to reach later tabs in tests.
    await userEvent.click(screen.getByTestId('automations-tab-more'));
    await userEvent.click(await screen.findByTestId('automations-tab-scheduled'));

    expect(window.location.hash).toBe('#scheduled');
  });
});
