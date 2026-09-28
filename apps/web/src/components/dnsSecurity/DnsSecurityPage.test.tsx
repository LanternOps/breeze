import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '@/lib/i18n';

import DnsSecurityPage from './DnsSecurityPage';

vi.mock('./DnsSecurityOverviewTab', () => ({ default: () => <div data-testid="dns-overview-tab" /> }));
vi.mock('./DnsSecurityIntegrationsTab', () => ({ default: () => <div data-testid="dns-integrations-tab" /> }));
vi.mock('./DnsSecurityPoliciesTab', () => ({ default: () => <div data-testid="dns-policies-tab" /> }));
vi.mock('./DnsSecurityEventsTab', () => ({ default: () => <div data-testid="dns-events-tab" /> }));

function renderPage() {
  return render(<I18nextProvider i18n={i18n}><DnsSecurityPage /></I18nextProvider>);
}

// #7148: at 390px the last tab sat flush against the screen edge (15px
// overflow, the mildest case in the audit but still clipped with no
// scroll/More affordance). Moved onto the shared OverflowTabs component.
describe('DnsSecurityPage tabs (#7148)', () => {
  beforeEach(() => {
    window.location.hash = '';
  });

  it('uses OverflowTabs (a role="tablist" nav)', () => {
    renderPage();
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(screen.getByTestId('dns-security-tab-overview')).toBeInTheDocument();
    expect(screen.getByTestId('dns-overview-tab')).toBeInTheDocument();
  });

  it('switches tabs and syncs the URL hash', async () => {
    renderPage();
    // jsdom reports 0 for offsetWidth/clientWidth, so OverflowTabs collapses
    // every tab past the first behind "More" (see OverflowTabs.tsx
    // computeVisible) — open it to reach later tabs in tests.
    await userEvent.click(screen.getByTestId('dns-security-tab-more'));
    await userEvent.click(await screen.findByTestId('dns-security-tab-events'));

    expect(screen.getByTestId('dns-events-tab')).toBeInTheDocument();
    expect(window.location.hash).toBe('#events');
  });
});
