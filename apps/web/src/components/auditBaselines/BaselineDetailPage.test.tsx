import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '@/lib/i18n';

import BaselineDetailPage from './BaselineDetailPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('./BaselineOverviewTab', () => ({ default: () => <div data-testid="baseline-overview-tab" /> }));
vi.mock('./BaselineComplianceTab', () => ({ default: () => <div data-testid="baseline-compliance-tab" /> }));
vi.mock('./BaselineApplyTab', () => ({ default: () => <div data-testid="baseline-apply-tab" /> }));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown): Response =>
  ({ ok: true, status: 200, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function renderPage() {
  return render(<I18nextProvider i18n={i18n}><BaselineDetailPage baselineId="bl-1" /></I18nextProvider>);
}

// #7148 (filed in a follow-up comment): at 390px this /audit-baselines/[id]
// tab strip has a milder version of the same overflow — the last tab
// ("Apply") runs into the strip's right border. Moved onto the shared
// OverflowTabs component.
describe('BaselineDetailPage tabs (#7148)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue(json({
      data: [{ id: 'bl-1', name: 'CIS Level 1', isActive: true, osType: 'windows', profile: 'workstation' }],
    }));
  });

  it('uses OverflowTabs (a role="tablist" nav)', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole('tablist')).toBeInTheDocument());
    expect(screen.getByTestId('baseline-detail-tab-overview')).toBeInTheDocument();
    expect(screen.getByTestId('baseline-overview-tab')).toBeInTheDocument();
  });

  it('switches tabs', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole('tablist')).toBeInTheDocument());

    // jsdom reports 0 for offsetWidth/clientWidth, so OverflowTabs collapses
    // every tab past the first behind "More" (see OverflowTabs.tsx
    // computeVisible) — open it to reach later tabs in tests.
    await userEvent.click(screen.getByTestId('baseline-detail-tab-more'));
    await userEvent.click(await screen.findByTestId('baseline-detail-tab-apply'));

    expect(screen.getByTestId('baseline-apply-tab')).toBeInTheDocument();
  });
});
