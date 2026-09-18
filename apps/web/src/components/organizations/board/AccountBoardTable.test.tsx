import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';
import type { BoardRow } from '@/lib/orgReadiness';
import { AccountBoardTable, type AccountBoardTableProps } from './AccountBoardTable';
import type { ManualOrderApi } from './useManualOrder';

const NOW = new Date('2026-09-13T12:00:00.000Z');
const A_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const B_ID = 'bbbbbbbb-2222-4222-8222-222222222222';

function row(id: string, name: string, extra: Partial<BoardRow> = {}, org: Partial<BoardRow['org']> = {}): BoardRow {
  return {
    org: { id, name, status: 'active', deviceCount: 3, createdAt: '2026-01-01T00:00:00Z', ...org },
    readiness: {
      orgId: id, type: 'customer', status: 'active',
      setup: { sites: 2, devices: 3, lastSeenAt: '2026-09-13T11:00:00.000Z', policyAssigned: true },
      account: { primaryContact: null, billingRoleContact: true, billingAddress: true },
      tickets: { open: 4, awaitingCustomer: 1, slaBreached: 2 },
    },
    state: 'ready',
    chips: { setup: [{ key: 'noSite', tone: 'warning', target: 'sites', href: `/organizations/${id}#sites` }], account: [], accountApplicable: true },
    badges: null,
    ...extra,
  };
}

const manualOrder: ManualOrderApi = {
  reorderPending: false, announcement: '', draggedOrgId: null, dragOverOrgId: null,
  onDragStart: vi.fn(), onDragOver: vi.fn(), onDragLeave: vi.fn(), onDrop: vi.fn(), onDragEnd: vi.fn(), move: vi.fn(),
};

function renderTable(overrides: Partial<AccountBoardTableProps> = {}) {
  const props: AccountBoardTableProps = {
    rows: [row(A_ID, 'Alpha Ltd'), row(B_ID, 'Beta Ltd', {}, { status: 'trial' })],
    columns: ['setup', 'account', 'tickets'],
    sort: 'manual',
    onSortChange: vi.fn(),
    activeRowId: A_ID,
    onRowKeyDown: vi.fn(),
    registerRowRef: vi.fn(),
    onOpenRecord: vi.fn(),
    highlightedOrgId: null,
    workspaceOrgId: B_ID,
    manualOrder,
    menuItemsFor: (r) => [{ id: 'open', label: `Open ${r.org.name}`, href: `/organizations/${r.org.id}` }],
    archivedView: false,
    now: NOW,
    ...overrides,
  };
  render(<AccountBoardTable {...props} />);
  return props;
}
const desktop = () => within(screen.getByTestId('responsive-table-desktop'));
const cards = () => within(screen.getByTestId('responsive-table-cards'));

describe('AccountBoardTable', () => {
  it('renders the columns it is given, with sortable Organization and Open tickets headers', () => {
    renderTable({ sort: 'tickets' });
    const headers = desktop().getAllByRole('columnheader').map((th) => th.textContent?.trim());
    expect(headers).toEqual(['Manual order', 'Organization', 'Setup', 'Account data', 'Open tickets', 'Row actions']);
    expect(desktop().getByTestId('org-board-sort-tickets').closest('th')).toHaveAttribute('aria-sort', 'descending');
    expect(desktop().getByTestId('org-board-sort-name').closest('th')).toHaveAttribute('aria-sort', 'none');
  });

  it('hides a column that is not in `columns` (lens or capability trimmed)', () => {
    renderTable({ columns: ['setup'] });
    const headers = desktop().getAllByRole('columnheader').map((th) => th.textContent?.trim());
    expect(headers).toEqual(['Manual order', 'Organization', 'Setup', 'Row actions']);
    expect(desktop().queryByTestId(`org-board-tickets-${A_ID}`)).not.toBeInTheDocument();
  });

  it('clicking a sortable header asks for that sort', () => {
    const { onSortChange } = renderTable();
    fireEvent.click(desktop().getByTestId('org-board-sort-name'));
    expect(onSortChange).toHaveBeenCalledWith('name');
    fireEvent.click(desktop().getByTestId('org-board-sort-tickets'));
    expect(onSortChange).toHaveBeenCalledWith('tickets');
  });

  it('the name link is the roving tab stop and every other control on the row follows it', () => {
    renderTable();
    const rowA = desktop().getByTestId(`org-board-row-${A_ID}`);
    const rowB = desktop().getByTestId(`org-board-row-${B_ID}`);
    expect(within(rowA).getByTestId(`org-board-name-${A_ID}`)).toHaveAttribute('tabindex', '0');
    expect(within(rowA).getByTestId('org-board-drag-handle')).toHaveAttribute('tabindex', '0');
    expect(within(rowA).getByTestId(`org-board-more-${A_ID}`)).toHaveAttribute('tabindex', '0');
    expect(within(rowB).getByTestId(`org-board-name-${B_ID}`)).toHaveAttribute('tabindex', '-1');
    expect(within(rowB).getByTestId('org-board-drag-handle')).toHaveAttribute('tabindex', '-1');
    expect(within(rowB).getByTestId(`org-board-more-${B_ID}`)).toHaveAttribute('tabindex', '-1');
    expect(within(rowA).getByTestId(`org-board-name-${A_ID}`)).not.toHaveAttribute('aria-current');
  });

  it('forwards row key presses with the row index, and ArrowDown on the handle moves the org', () => {
    const { onRowKeyDown } = renderTable();
    fireEvent.keyDown(desktop().getByTestId(`org-board-name-${B_ID}`), { key: 'ArrowUp' });
    expect(onRowKeyDown).toHaveBeenCalledWith(expect.anything(), 1);
    fireEvent.keyDown(within(desktop().getByTestId(`org-board-row-${A_ID}`)).getByTestId('org-board-drag-handle'), { key: 'ArrowDown' });
    expect(manualOrder.move).toHaveBeenCalledWith(expect.objectContaining({ id: A_ID }), 1);
  });

  it('shows no handle without manual order', () => {
    renderTable({ manualOrder: null });
    expect(desktop().queryByTestId('org-board-drag-handle')).not.toBeInTheDocument();
  });

  it('a handle in flight is marked busy and the row is not draggable', () => {
    renderTable({ manualOrder: { ...manualOrder, reorderPending: true } });
    const rowA = desktop().getByTestId(`org-board-row-${A_ID}`);
    expect(within(rowA).getByTestId('org-board-drag-handle')).toHaveAttribute('aria-busy', 'true');
    expect(rowA).toHaveAttribute('draggable', 'false');
  });

  it('row click opens the record; chip and menu clicks do not', () => {
    const { onOpenRecord } = renderTable();
    const rowA = desktop().getByTestId(`org-board-row-${A_ID}`);
    fireEvent.click(rowA);
    expect(onOpenRecord).toHaveBeenCalledWith(expect.objectContaining({ id: A_ID }));
    // Both fixture rows share the default `noSite` chip (only `status` is
    // overridden for B), so scope to row A to avoid an ambiguous match.
    fireEvent.click(within(rowA).getByTestId('org-board-chip-noSite'));
    fireEvent.click(desktop().getByTestId(`org-board-more-${B_ID}`));
    expect(onOpenRecord).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('menuitem', { name: 'Open Beta Ltd' })).toHaveAttribute('href', `/organizations/${B_ID}`);
  });

  it('plain left-click on the name opens the record instead of navigating', () => {
    const { onOpenRecord } = renderTable();
    const nameLink = desktop().getByTestId(`org-board-name-${A_ID}`);
    const event = fireEvent.click(nameLink);
    expect(onOpenRecord).toHaveBeenCalledWith(expect.objectContaining({ id: A_ID }));
    expect(onOpenRecord).toHaveBeenCalledTimes(1);
    // preventDefault should have been called, so jsdom reports the click as not "handled" by navigation
    expect(event).toBe(false);
  });

  it('modifier/middle-click on the name does not intercept navigation', () => {
    const { onOpenRecord } = renderTable();
    const nameLink = desktop().getByTestId(`org-board-name-${A_ID}`);
    fireEvent.click(nameLink, { metaKey: true });
    fireEvent.click(nameLink, { ctrlKey: true });
    fireEvent.click(nameLink, { shiftKey: true });
    fireEvent.click(nameLink, { altKey: true });
    fireEvent.click(nameLink, { button: 1 });
    expect(onOpenRecord).not.toHaveBeenCalled();
  });

  it('plain left-click on the card surface name also opens the record (shared renderName)', () => {
    const { onOpenRecord } = renderTable();
    fireEvent.click(cards().getByTestId(`org-board-card-name-${A_ID}`));
    expect(onOpenRecord).toHaveBeenCalledWith(expect.objectContaining({ id: A_ID }));
  });

  it('renders the meta line: exception-only status pill, workspace marker, device and site counts', () => {
    renderTable();
    const rowA = desktop().getByTestId(`org-board-row-${A_ID}`);
    const rowB = desktop().getByTestId(`org-board-row-${B_ID}`);
    expect(within(rowA).queryByText('Active')).not.toBeInTheDocument();
    expect(within(rowB).getByText('Trial')).toBeInTheDocument();
    expect(within(rowB).getByTestId('org-board-workspace-marker')).toHaveTextContent('Workspace');
    expect(within(rowA).queryByTestId('org-board-workspace-marker')).not.toBeInTheDocument();
    expect(within(rowA).getByText('3 devices')).toBeInTheDocument();
    expect(within(rowA).getByText('2 sites')).toBeInTheDocument();
  });

  it('renders the ticket cell with awaiting and SLA lines', () => {
    renderTable();
    const cell = desktop().getByTestId(`org-board-tickets-${A_ID}`);
    expect(cell).toHaveTextContent('4 open');
    expect(cell).toHaveTextContent('1 awaiting customer');
    expect(within(cell).getByText('2 SLA breached').className).toContain('text-destructive');
  });

  it('marks the highlighted row', () => {
    renderTable({ highlightedOrgId: B_ID });
    expect(desktop().getByTestId(`org-board-row-${B_ID}`)).toHaveAttribute('data-highlighted', 'true');
    expect(desktop().getByTestId(`org-board-row-${A_ID}`)).not.toHaveAttribute('data-highlighted');
  });

  it('archived view: muted rows with badge and purge countdown, no readiness cells, no handle', () => {
    renderTable({
      archivedView: true,
      manualOrder: null,
      rows: [
        row(A_ID, 'Gamma LLC', { readiness: undefined, chips: null }, { status: 'archived', archived: true, purgeAt: '2026-10-13T00:00:00.000Z' }),
        row(B_ID, 'Epsilon Corp', { readiness: undefined, chips: null }, { status: 'offboarding', archived: true, offboardingTarget: 'archive', purgeAt: null }),
      ],
    });
    const gamma = desktop().getByTestId(`org-board-row-${A_ID}`);
    expect(within(gamma).getByTestId('org-board-archived-badge')).toHaveTextContent('Archived');
    expect(within(gamma).getByTestId('org-board-archived-purge')).toHaveTextContent('Purges in 30 days');
    const epsilon = desktop().getByTestId(`org-board-row-${B_ID}`);
    expect(within(epsilon).getByTestId('org-board-archived-badge')).toHaveTextContent('Archiving…');
    expect(within(epsilon).getByTestId('org-board-archived-purge')).toHaveTextContent('Kept indefinitely');
    expect(desktop().queryByRole('columnheader', { name: 'Setup' })).not.toBeInTheDocument();
    expect(desktop().queryByTestId('org-board-drag-handle')).not.toBeInTheDocument();
  });

  it('phone cards carry the same rows with a single "Still needed" list and their own test ids', () => {
    renderTable();
    const cardA = cards().getByTestId(`org-board-card-${A_ID}`);
    expect(within(cardA).getByTestId(`org-board-card-name-${A_ID}`)).toHaveAttribute('href', `/organizations/${A_ID}`);
    expect(within(cardA).getByText('Still needed')).toBeInTheDocument();
    expect(within(cardA).getByTestId('org-board-card-chip-noSite')).toBeInTheDocument();
    expect(within(cardA).getByTestId(`org-board-card-more-${A_ID}`)).toBeInTheDocument();
    expect(within(cardA).getByText('4 open')).toBeInTheDocument();
  });
});
