import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '@/lib/i18n';

import AuditBaselinesPage from './AuditBaselinesPage';

vi.mock('./ComplianceDashboard', () => ({ default: () => <div data-testid="compliance-dashboard" /> }));
vi.mock('./BaselineList', () => ({ default: () => <div data-testid="baseline-list" /> }));
vi.mock('./BaselineApplyTab', () => ({ default: () => <div data-testid="baseline-apply-tab" /> }));

function renderPage() {
  return render(<I18nextProvider i18n={i18n}><AuditBaselinesPage /></I18nextProvider>);
}

// #7148: at 390px this 3-tab strip overflowed by 29px, running "Approvals"
// through the container border with no scroll or overflow affordance. Moved
// onto the shared OverflowTabs component, which folds overflow into a
// "More" menu instead of clipping.
describe('AuditBaselinesPage tabs (#7148)', () => {
  beforeEach(() => {
    window.location.hash = '';
  });

  it('uses OverflowTabs (a role="tablist" nav), not a fixed-width row', () => {
    renderPage();
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(screen.getByTestId('audit-baselines-tab-dashboard')).toBeInTheDocument();
  });

  it('switches tabs and syncs the URL hash', async () => {
    renderPage();
    expect(screen.getByTestId('compliance-dashboard')).toBeInTheDocument();

    // jsdom reports 0 for offsetWidth/clientWidth, so OverflowTabs collapses
    // every tab past the first behind "More" (see OverflowTabs.tsx
    // computeVisible) — open it to reach Baselines/Approvals in tests.
    await userEvent.click(screen.getByTestId('audit-baselines-tab-more'));
    await userEvent.click(await screen.findByTestId('audit-baselines-tab-baselines'));

    expect(screen.getByTestId('baseline-list')).toBeInTheDocument();
    expect(window.location.hash).toBe('#baselines');
  });
});
