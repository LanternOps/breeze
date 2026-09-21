import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import '@/lib/i18n';
import type { BoardRow } from '@/lib/orgReadiness';
import { ReadinessChips } from './ReadinessChips';

const ORG_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const base: BoardRow = {
  org: { id: ORG_ID, name: 'Alpha Ltd', status: 'active', createdAt: '2026-01-01T00:00:00Z' },
  readiness: undefined,
  state: 'ready',
  chips: { setup: [], account: [], accountApplicable: true },
  badges: null,
};

describe('ReadinessChips', () => {
  it('renders a skeleton while the row’s batch is pending', () => {
    render(<ReadinessChips row={{ ...base, state: 'pending', chips: null }} section="setup" />);
    expect(screen.getByTestId('org-board-chips-pending')).toBeInTheDocument();
    expect(screen.queryByTestId('org-board-chips-complete')).not.toBeInTheDocument();
  });

  it('renders Unavailable when the row’s batch failed', () => {
    render(<ReadinessChips row={{ ...base, state: 'failed', chips: null }} section="setup" />);
    expect(screen.getByTestId('org-board-chips-unavailable')).toHaveTextContent('Unavailable');
  });

  it('renders a dash when readiness landed without this org (never Complete)', () => {
    render(<ReadinessChips row={{ ...base, chips: null }} section="setup" />);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByTestId('org-board-chips-complete')).not.toBeInTheDocument();
  });

  it('renders one quiet Complete check when nothing is missing', () => {
    render(<ReadinessChips row={base} section="setup" />);
    expect(screen.getByTestId('org-board-chips-complete')).toHaveTextContent('Complete');
  });

  it('renders a dash, not Complete, for the Account cell of an org the section does not apply to', () => {
    render(<ReadinessChips row={{ ...base, chips: { setup: [], account: [], accountApplicable: false } }} section="account" />);
    expect(screen.getByTitle('Not applicable')).toHaveTextContent('—');
    expect(screen.queryByTestId('org-board-chips-complete')).not.toBeInTheDocument();
  });

  it('renders each chip as an anchor to its repair link, named with the org', () => {
    const row: BoardRow = {
      ...base,
      chips: {
        setup: [
          { key: 'noSite', tone: 'warning', target: 'sites', href: `/organizations/${ORG_ID}#sites` },
          { key: 'staleCheckIn', tone: 'warning', target: 'devices', href: `/organizations/${ORG_ID}#devices`, count: 9 },
        ],
        account: [{ key: 'overdueInvoices', tone: 'destructive', target: 'billing', href: `/organizations/${ORG_ID}#billing`, count: 2 }],
        accountApplicable: true,
      },
    };
    render(<ReadinessChips row={row} section="all" />);
    const noSite = screen.getByRole('link', { name: 'No site for Alpha Ltd' });
    expect(noSite).toHaveAttribute('href', `/organizations/${ORG_ID}#sites`);
    expect(noSite).toHaveAttribute('title', 'Open the Sites tab for Alpha Ltd');
    expect(noSite).toHaveAttribute('data-testid', 'org-board-chip-noSite');
    expect(screen.getByRole('link', { name: 'No agent check-in for 9 days for Alpha Ltd' })).toBeInTheDocument();
    const overdue = screen.getByRole('link', { name: '2 overdue invoices for Alpha Ltd' });
    expect(overdue.className).toContain('text-destructive');
    expect(noSite.className).toContain('text-warning-strong');
  });

  it('honours a custom test-id prefix (phone cards)', () => {
    const row: BoardRow = { ...base, chips: { setup: [{ key: 'noPolicy', tone: 'warning', target: 'policies', href: '/configuration-policies' }], account: [], accountApplicable: true } };
    render(<ReadinessChips row={row} section="setup" testIdPrefix="org-board-card-chip" />);
    expect(screen.getByTestId('org-board-card-chip-noPolicy')).toHaveAttribute('href', '/configuration-policies');
  });
});
