import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import '@/lib/i18n';
import { AccountBoardTable } from './AccountBoardTable';
import { visibleColumns, type BoardRow, type ReadinessCapabilities } from '@/lib/orgReadiness';

const CAPS: ReadinessCapabilities = {
  sites: true, devices: true, policies: true, contacts: true, portalUsers: true,
  invoices: false, tickets: false, integrations: true, contracts: false, backup: false,
};
const A_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const B_ID = 'bbbbbbbb-2222-4222-8222-222222222222';

function row(id: string, name: string, badges: BoardRow['badges']): BoardRow {
  return {
    org: { id, name, status: 'active', type: 'customer', createdAt: '2026-01-01T00:00:00.000Z' },
    readiness: {
      orgId: id, type: 'customer', status: 'active',
      setup: { sites: 1, devices: 1, lastSeenAt: null, policyAssigned: true },
      account: { primaryContact: null, billingRoleContact: true, billingAddress: true },
      integrations: [],
    },
    state: 'ready',
    chips: { setup: [], account: [], accountApplicable: true },
    badges,
  };
}

function renderTable(lens: 'setup' | 'account' | 'both', capabilities: ReadinessCapabilities) {
  return render(
    <AccountBoardTable
      rows={[row(A_ID, 'Alpha', [{ system: 'pax8', state: 'not_linked', muted: false }]), row(B_ID, 'Beta', [])]}
      columns={visibleColumns(lens, capabilities)}
      sort="manual"
      onSortChange={vi.fn()}
      activeRowId={A_ID}
      onRowKeyDown={vi.fn()}
      registerRowRef={vi.fn()}
      onOpenRecord={vi.fn()}
      highlightedOrgId={null}
      workspaceOrgId={null}
      manualOrder={null}
      menuItemsFor={() => []}
      archivedView={false}
      now={new Date('2026-09-13T12:00:00.000Z')}
      connectors={[{ system: 'pax8', state: 'connected' }]}
    />,
  );
}

const desktop = () => within(screen.getByTestId('responsive-table-desktop'));
const cards = () => within(screen.getByTestId('responsive-table-cards'));

describe('AccountBoardTable — Integrations column', () => {
  it.each(['setup', 'account', 'both'] as const)('renders the column and the badges in the %s lens', (lens) => {
    renderTable(lens, CAPS);
    expect(desktop().getByTestId('org-board-col-integrations')).toHaveTextContent('Integrations');
    expect(desktop().getByTestId(`org-board-badge-${A_ID}-pax8`)).toHaveTextContent('Pax8 not linked');
    expect(desktop().getByTestId(`org-board-nothing-linked-${B_ID}`)).toBeInTheDocument();
  });

  it('hides the column entirely when the caller lacks connected_apps:read', () => {
    renderTable('both', { ...CAPS, integrations: false });
    expect(screen.queryByTestId('org-board-col-integrations')).not.toBeInTheDocument();
    expect(screen.queryByTestId(`org-board-badge-${A_ID}-pax8`)).not.toBeInTheDocument();
  });

  it('renders the badges on the phone cards too, with the card prefix', () => {
    renderTable('both', CAPS);
    const alphaCard = within(screen.getByTestId(`org-board-card-${A_ID}`));
    expect(alphaCard.getByTestId(`org-board-card-badge-${A_ID}-pax8`)).toHaveTextContent('Pax8 not linked');
    expect(alphaCard.getByText('Integrations')).toBeInTheDocument();
  });
});
