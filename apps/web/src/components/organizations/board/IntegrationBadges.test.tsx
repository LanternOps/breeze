import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@/lib/i18n';
import IntegrationBadges from './IntegrationBadges';
import type { BoardRow, IntegrationBadge, ReadinessRowState } from '@/lib/orgReadiness';

const ORG = 'org-1';

function row(badges: IntegrationBadge[] | null, state: ReadinessRowState = 'ready'): BoardRow {
  return {
    org: { id: ORG, name: 'Acme', status: 'active', type: 'customer', createdAt: '2026-01-01T00:00:00.000Z' },
    readiness: undefined,
    state,
    chips: null,
    badges,
  };
}

describe('IntegrationBadges', () => {
  it('renders a skeleton while the batch is in flight and "Unavailable" when it failed', () => {
    const { rerender } = render(<IntegrationBadges row={row(null, 'pending')} />);
    expect(screen.getByTestId('org-board-badges-pending')).toBeInTheDocument();
    rerender(<IntegrationBadges row={row(null, 'failed')} />);
    expect(screen.getByTestId('org-board-badges-unavailable')).toHaveTextContent('Unavailable');
  });

  it('renders a dash when the section is withheld', () => {
    render(<IntegrationBadges row={row(null)} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows "Nothing linked" muted for an empty list', () => {
    render(<IntegrationBadges row={row([])} />);
    expect(screen.getByTestId(`org-board-nothing-linked-${ORG}`)).toHaveTextContent('Nothing linked');
  });

  it('gives the "Nothing linked" testid a distinct prefix per testIdPrefix — the desktop cell and the phone card render the same row simultaneously (ResponsiveTable), so a shared id is a Playwright strict-mode violation', () => {
    const { rerender } = render(<IntegrationBadges row={row([])} />);
    expect(screen.getByTestId(`org-board-nothing-linked-${ORG}`)).toBeInTheDocument();
    rerender(<IntegrationBadges row={row([])} testIdPrefix="org-board-card-badge" />);
    expect(screen.queryByTestId(`org-board-nothing-linked-${ORG}`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`org-board-card-nothing-linked-${ORG}`)).toHaveTextContent('Nothing linked');
  });

  it('renders one badge per system with the state colour, the brand name, and an accessible name carrying the org and reason', () => {
    render(
      <IntegrationBadges
        row={row([
          { system: 'quickbooks', state: 'linked', muted: false },
          { system: 'm365', state: 'pending', reason: 'consent_pending', muted: false },
          { system: 'dns_filter', state: 'error', reason: 'sync_error', muted: false },
          { system: 'external', state: 'identity', label: 'datto_rmm', muted: false },
          { system: 'psa', state: 'not_linked', muted: false },
        ])}
        psaProvider="connectwise"
      />,
    );
    const qbo = screen.getByTestId(`org-board-badge-${ORG}-quickbooks`);
    expect(qbo).toHaveTextContent('QuickBooks');
    expect(qbo).toHaveAttribute('aria-label', 'Acme: QuickBooks, Linked');
    expect(qbo.querySelector('[data-dot]')?.className).toContain('bg-success');
    // Regression: a linked badge with no reason and not muted had no `title`
    // at all — mouse users got zero information on hover. It should fall
    // back to the same text as the accessible name.
    expect(qbo).toHaveAttribute('title', 'Acme: QuickBooks, Linked');

    const m365 = screen.getByTestId(`org-board-badge-${ORG}-m365`);
    expect(m365).toHaveAttribute('aria-label', 'Acme: Microsoft 365, Pending (Waiting for Microsoft consent)');
    expect(m365).toHaveAttribute('title', 'Waiting for Microsoft consent');
    expect(m365.querySelector('[data-dot]')?.className).toContain('bg-warning');

    const dns = screen.getByTestId(`org-board-badge-${ORG}-dns_filter`);
    expect(dns).toHaveTextContent('DNS filter');
    expect(dns.querySelector('[data-dot]')?.className).toContain('bg-destructive');

    const ext = screen.getByTestId(`org-board-badge-${ORG}-external-datto_rmm`);
    expect(ext).toHaveTextContent('datto_rmm');
    expect(ext).toHaveAttribute('aria-label', 'Acme: datto_rmm, Identity only');
    expect(ext).toHaveAttribute('title', 'Acme: datto_rmm, Identity only');

    const psa = screen.getByTestId(`org-board-badge-${ORG}-psa`);
    expect(psa).toHaveTextContent('ConnectWise not linked');
    expect(psa.className).toContain('border-dashed');
  });

  it('a muted badge is dimmed and explains why in its title; the card prefix changes the testids', () => {
    render(<IntegrationBadges row={row([{ system: 'pax8', state: 'error', reason: 'sync_failed', muted: true }])} testIdPrefix="org-board-card-badge" />);
    const badge = screen.getByTestId(`org-board-card-badge-${ORG}-pax8`);
    expect(badge.className).toContain('opacity-60');
    expect(badge).toHaveAttribute('title', 'Pax8 connector is not connected');
  });
});
