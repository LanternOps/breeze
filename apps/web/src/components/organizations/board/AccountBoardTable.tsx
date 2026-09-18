import type { KeyboardEvent, ReactNode } from 'react';
import { GripVertical } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { ActionMenu, type ActionMenuItem } from '@/components/shared/ActionMenu';
import { DataCard, ResponsiveTable } from '@/components/shared/ResponsiveTable';
import { SortableTh } from '@/components/shared/SortableTh';
import { FALLBACK_STATUS_CLASS, statusColors, statusLabelKeys } from '@/lib/orgStatus';
import {
  purgeCountdownDays,
  shouldShowDeviceCount,
  type BoardColumn,
  type BoardRow,
  type BoardSort,
  type ReadinessConnector,
} from '@/lib/orgReadiness';
import type { Organization } from '@/components/settings/organizationTypes';
import type { Organization as StoreOrganization } from '@/stores/orgStore';
import { ReadinessChips } from './ReadinessChips';
import IntegrationBadges from './IntegrationBadges';
import type { ManualOrderApi } from './useManualOrder';

/** `aria-describedby` target for every reorder handle: the page renders one hidden sentence with this id. */
export const REORDER_HINT_ID = 'org-board-reorder-hint';

export interface AccountBoardTableProps {
  rows: BoardRow[];
  /** Capability- and lens-trimmed, in render order (`visibleColumns`). */
  columns: BoardColumn[];
  sort: BoardSort;
  onSortChange: (sort: BoardSort) => void;
  /** Roving tabindex: the one row whose name link, handle and menu trigger are in the Tab order. */
  activeRowId: string | null;
  onRowKeyDown: (event: KeyboardEvent<HTMLAnchorElement>, index: number) => void;
  registerRowRef: (orgId: string, el: HTMLAnchorElement | null) => void;
  onOpenRecord: (org: Organization) => void;
  highlightedOrgId: string | null;
  workspaceOrgId: string | null;
  /** Present only while manual order applies (manual sort, no search, All filter). */
  manualOrder: ManualOrderApi | null;
  menuItemsFor: (row: BoardRow) => ActionMenuItem[];
  /** Archived filter: muted rows, badge + purge countdown, no readiness cells. */
  archivedView: boolean;
  now: Date;
  /** Partner-level connectors from the readiness response; null until the first batch lands or when withheld. */
  connectors?: ReadinessConnector[] | null;
}

const ROW_MENU_TRIGGER_CLASS =
  'inline-flex h-8 w-8 items-center justify-center rounded-md border bg-background text-sm transition hover:bg-muted';

export function AccountBoardTable({
  rows,
  columns,
  sort,
  onSortChange,
  activeRowId,
  onRowKeyDown,
  registerRowRef,
  onOpenRecord,
  highlightedOrgId,
  workspaceOrgId,
  manualOrder,
  menuItemsFor,
  archivedView,
  now,
  connectors,
}: AccountBoardTableProps) {
  const { t } = useTranslation('organizations');
  const { t: tSettings } = useTranslation('settings');
  const showSetup = !archivedView && columns.includes('setup');
  const showAccount = !archivedView && columns.includes('account');
  const showIntegrations = !archivedView && columns.includes('integrations');
  const showTickets = !archivedView && columns.includes('tickets');
  const psaProvider = connectors?.find((c) => c.system === 'psa')?.provider;
  const dragEnabled = manualOrder !== null && !manualOrder.reorderPending;
  const rowTabIndex = (org: Organization) => (activeRowId === org.id ? 0 : -1);

  const statusPill = (org: Organization) => {
    const key = org.status as StoreOrganization['status'];
    const label = statusLabelKeys[key] ? tSettings(/* i18n-dynamic */ statusLabelKeys[key]) : org.status;
    return (
      <span className={`inline-flex items-center rounded-full border px-1.5 py-0.5 font-medium leading-none ${statusColors[key] ?? FALLBACK_STATUS_CLASS}`}>
        {label}
      </span>
    );
  };

  const purgeLine = (org: Organization) => {
    const days = purgeCountdownDays(org.purgeAt, now);
    if (days === null) return t('orgBoard.meta.keptIndefinitely');
    if (days <= 0) return t('orgBoard.meta.purgeToday');
    return t('orgBoard.meta.purgeCountdown', { count: days });
  };

  // Only the TABLE row registers the roving ref: both surfaces render in the
  // DOM (the cards are `sm:hidden`), and the last registration would win.
  const renderName = (row: BoardRow, index: number, surface: 'table' | 'card') => (
    <a
      ref={surface === 'table' ? (el) => registerRowRef(row.org.id, el) : undefined}
      href={`/organizations/${row.org.id}`}
      data-testid={surface === 'table' ? `org-board-name-${row.org.id}` : `org-board-card-name-${row.org.id}`}
      tabIndex={rowTabIndex(row.org)}
      title={row.org.name}
      onKeyDown={(event) => onRowKeyDown(event, index)}
      onClick={(event) => {
        event.stopPropagation();
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        onOpenRecord(row.org);
      }}
      className="block max-w-xs truncate text-sm font-medium hover:underline"
    >
      {row.org.name}
    </a>
  );

  const renderMeta = (row: BoardRow) => {
    const org = row.org;
    const sites = row.readiness?.setup.sites;
    return (
      <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {archivedView ? (
          <>
            <span
              data-testid="org-board-archived-badge"
              className={`inline-flex items-center rounded-full border px-1.5 py-0.5 font-medium leading-none ${
                org.status === 'offboarding' ? statusColors.offboarding : statusColors.archived
              }`}
            >
              {org.status === 'offboarding' ? t('orgBoard.meta.archivingBadge') : t('orgBoard.meta.archivedBadge')}
            </span>
            <span data-testid="org-board-archived-purge">{purgeLine(org)}</span>
          </>
        ) : (
          <>
            {/* Exception-only: `active` is the steady state the other pills are exceptions to. */}
            {org.status !== 'active' && statusPill(org)}
            {/* Marker only, never a pin: at most one row carries it, so it reads as a landmark. */}
            {workspaceOrgId === org.id && (
              <span
                data-testid="org-board-workspace-marker"
                className="inline-flex items-center rounded-full border border-primary/30 bg-primary/5 px-1.5 py-0.5 font-medium leading-none text-primary"
              >
                {t('orgBoard.meta.workspace')}
              </span>
            )}
            {shouldShowDeviceCount(org.deviceCount) && <span>{t('orgBoard.meta.devices', { count: org.deviceCount })}</span>}
            {typeof sites === 'number' && <span>{t('orgBoard.meta.sites', { count: sites })}</span>}
          </>
        )}
      </span>
    );
  };

  const renderTickets = (row: BoardRow): ReactNode => {
    if (row.state === 'pending') return <span className="skeleton inline-block h-4 w-10" aria-hidden="true" />;
    if (row.state === 'failed') return <span className="text-xs text-muted-foreground">{t('orgBoard.chips.unavailable')}</span>;
    const tickets = row.readiness?.tickets;
    if (!tickets) return <span className="text-muted-foreground">—</span>;
    return (
      <span className="block" data-testid={`org-board-tickets-${row.org.id}`}>
        <span className={`text-sm tabular-nums ${tickets.open === 0 ? 'text-muted-foreground' : 'font-medium'}`}>
          {t('orgBoard.tickets.open', { count: tickets.open })}
        </span>
        {(tickets.awaitingCustomer > 0 || tickets.slaBreached > 0) && (
          <span className="mt-0.5 flex flex-wrap gap-x-2 text-xs">
            {tickets.awaitingCustomer > 0 && (
              <span className="text-muted-foreground">{t('orgBoard.tickets.awaiting', { count: tickets.awaitingCustomer })}</span>
            )}
            {tickets.slaBreached > 0 && <span className="text-destructive">{t('orgBoard.tickets.sla', { count: tickets.slaBreached })}</span>}
          </span>
        )}
      </span>
    );
  };

  const renderMenu = (row: BoardRow, surface: 'table' | 'card') => (
    <span onClick={(event) => event.stopPropagation()}>
      <ActionMenu
        label={t('orgBoard.rowMenu.label', { name: row.org.name })}
        testId={surface === 'table' ? `org-board-more-${row.org.id}` : `org-board-card-more-${row.org.id}`}
        items={menuItemsFor(row)}
        triggerClassName={ROW_MENU_TRIGGER_CLASS}
        triggerTabIndex={rowTabIndex(row.org)}
      />
    </span>
  );

  // Shown whenever manual order applies; DRAGGING is enabled only while no
  // reorder is in flight. Tying the handle's presence to the in-flight flag
  // unmounted the focused handle on every keyboard move (review of #5708).
  const renderHandle = (row: BoardRow) =>
    manualOrder && (
      <button
        type="button"
        data-testid="org-board-drag-handle"
        aria-label={t('orgBoard.reorder.handle', { name: row.org.name })}
        aria-describedby={REORDER_HINT_ID}
        aria-busy={manualOrder.reorderPending || undefined}
        title={t('orgBoard.reorder.dragToReorder')}
        tabIndex={rowTabIndex(row.org)}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
          event.preventDefault();
          manualOrder.move(row.org, event.key === 'ArrowUp' ? -1 : 1);
        }}
        className="cursor-grab rounded p-0.5 text-muted-foreground/40 transition group-hover:text-muted-foreground group-focus-within:text-muted-foreground active:cursor-grabbing"
      >
        <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    );

  const table = (
    <table className="w-full min-w-[1040px] text-sm" data-testid="org-board-table">
      <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
        <tr>
          {manualOrder && (
            <th className="w-8 px-2 py-3">
              <span className="sr-only">{t('orgBoard.sort.manual')}</span>
            </th>
          )}
          <SortableTh
            namespace="organizations"
            label={t('orgBoard.columns.organization')}
            sortKey="name"
            activeSort={sort === 'name' ? 'name' : null}
            direction="asc"
            onSort={() => onSortChange('name')}
            testId="org-board-sort-name"
          />
          {showSetup && <th className="px-3 py-3 font-medium">{t('orgBoard.columns.setup')}</th>}
          {showAccount && <th className="px-3 py-3 font-medium">{t('orgBoard.columns.account')}</th>}
          {showIntegrations && (
            <th className="px-3 py-3 font-medium" data-testid="org-board-col-integrations">
              {t('orgBoard.columns.integrations')}
            </th>
          )}
          {showTickets && (
            <SortableTh
              namespace="organizations"
              label={t('orgBoard.columns.tickets')}
              sortKey="tickets"
              activeSort={sort === 'tickets' ? 'tickets' : null}
              direction="desc"
              onSort={() => onSortChange('tickets')}
              testId="org-board-sort-tickets"
            />
          )}
          <th className="w-12 px-2 py-3">
            <span className="sr-only">{t('orgBoard.columns.actions')}</span>
          </th>
        </tr>
      </thead>
      <tbody className="divide-y">
        {rows.map((row, index) => {
          const org = row.org;
          const isDragging = manualOrder !== null && manualOrder.draggedOrgId === org.id;
          const isDropTarget = manualOrder !== null && manualOrder.dragOverOrgId === org.id && manualOrder.draggedOrgId !== org.id;
          const highlighted = highlightedOrgId === org.id;
          return (
            /* The <tr> is a whole-row hit area for the mouse; the name link is
               the keyboard and assistive-tech route to the same record. */
            <tr
              key={org.id}
              data-testid={`org-board-row-${org.id}`}
              data-highlighted={highlighted || undefined}
              onClick={() => onOpenRecord(org)}
              draggable={dragEnabled}
              onDragStart={manualOrder && dragEnabled ? (event) => manualOrder.onDragStart(event, org) : undefined}
              onDragOver={manualOrder && dragEnabled ? (event) => manualOrder.onDragOver(event, org) : undefined}
              onDragLeave={manualOrder && dragEnabled ? manualOrder.onDragLeave : undefined}
              onDrop={manualOrder && dragEnabled ? (event) => manualOrder.onDrop(event, org) : undefined}
              onDragEnd={manualOrder && dragEnabled ? manualOrder.onDragEnd : undefined}
              className={`group cursor-pointer align-top transition hover:bg-muted/50 ${archivedView ? 'opacity-70' : ''} ${
                isDragging ? 'opacity-50' : ''
              } ${isDropTarget ? 'border-t-2 border-t-primary' : ''} ${highlighted ? 'bg-primary/5 ring-1 ring-inset ring-primary/40' : ''}`}
            >
              {manualOrder && <td className="px-2 py-3">{renderHandle(row)}</td>}
              <td className="px-3 py-3">
                <div className="min-w-0">
                  {renderName(row, index, 'table')}
                  {renderMeta(row)}
                </div>
              </td>
              {showSetup && (
                <td className="px-3 py-3">
                  <ReadinessChips row={row} section="setup" />
                </td>
              )}
              {showAccount && (
                <td className="px-3 py-3">
                  <ReadinessChips row={row} section="account" />
                </td>
              )}
              {showIntegrations && (
                <td className="px-3 py-3">
                  <IntegrationBadges row={row} psaProvider={psaProvider} />
                </td>
              )}
              {showTickets && <td className="px-3 py-3">{renderTickets(row)}</td>}
              <td className="px-2 py-3 text-right">{renderMenu(row, 'table')}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  const cards = rows.map((row, index) => {
    const org = row.org;
    return (
      <DataCard
        key={org.id}
        onClick={() => onOpenRecord(org)}
        className={`${archivedView ? 'opacity-70' : ''} ${highlightedOrgId === org.id ? 'ring-1 ring-primary/40' : ''}`}
      >
        <div data-testid={`org-board-card-${org.id}`}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              {renderName(row, index, 'card')}
              {renderMeta(row)}
            </div>
            {renderMenu(row, 'card')}
          </div>
          {(showSetup || showAccount) && (
            <div className="mt-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('orgBoard.chips.stillNeeded')}</p>
              <div className="mt-1">
                <ReadinessChips
                  row={row}
                  section={showSetup && showAccount ? 'all' : showSetup ? 'setup' : 'account'}
                  testIdPrefix="org-board-card-chip"
                />
              </div>
            </div>
          )}
          {showIntegrations && (
            <div className="mt-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('orgBoard.columns.integrations')}</p>
              <div className="mt-1">
                <IntegrationBadges row={row} psaProvider={psaProvider} testIdPrefix="org-board-card-badge" />
              </div>
            </div>
          )}
          {showTickets && (
            <div className="mt-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('orgBoard.columns.tickets')}</p>
              <div className="mt-1">{renderTickets(row)}</div>
            </div>
          )}
        </div>
      </DataCard>
    );
  });

  return <ResponsiveTable table={table} cards={cards} />;
}
