import { useEffect, useRef, useState } from 'react';
import { Network } from 'lucide-react';
import type { NetworkAssetRowDto, NetworkAssetsDto } from '@breeze/shared';
import { portalApi, type NetworkAssetStatusFilter } from '@/lib/api';
import { cn, formatDateTime } from '@/lib/utils';
import { CELL, EmptyState, ErrorNotice, INPUT, BTN_SECONDARY, ROW, StatusMark, TH } from './ui';

/**
 * Per-asset register for /network (#6641), below the overview ledger.
 *
 * Filters and page live in the URL hash (repo convention for client UI state,
 * never query params) and map 1:1 onto GET /portal/network/assets. There is
 * deliberately no site filter yet: the portal has no site list to choose from
 * and rows carry only `siteName`, not an id (follow-up issue).
 */

const PAGE_SIZE = 50;

const ASSET_TYPES = [
  'workstation', 'server', 'printer', 'router', 'switch', 'firewall', 'access_point',
  'phone', 'iot', 'camera', 'nas', 'website', 'service', 'unknown',
] as const;

const TYPE_LABELS: Record<string, string> = {
  nas: 'NAS',
  iot: 'IoT',
  access_point: 'Access point',
};

function typeLabel(type: string): string {
  return (
    TYPE_LABELS[type] ??
    type.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
  );
}

const STATUS_OPTIONS: ReadonlyArray<{ value: NetworkAssetStatusFilter; label: string }> = [
  { value: 'online', label: 'Online' },
  { value: 'offline', label: 'Offline' },
  // null onlineState = reachability never verified; never called "offline".
  { value: 'unverified', label: 'Unknown' },
];

const PHONE_LABEL =
  'mb-0.5 block text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground sm:hidden';

interface FilterState {
  assetType: string;
  status: string;
  page: number;
}

function readHash(): FilterState {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const type = params.get('type') ?? '';
  const status = params.get('status') ?? '';
  const page = Number.parseInt(params.get('page') ?? '1', 10);
  return {
    assetType: (ASSET_TYPES as readonly string[]).includes(type) ? type : '',
    status: STATUS_OPTIONS.some((o) => o.value === status) ? status : '',
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

function writeHash(f: FilterState) {
  const params = new URLSearchParams();
  if (f.assetType) params.set('type', f.assetType);
  if (f.status) params.set('status', f.status);
  if (f.page > 1) params.set('page', String(f.page));
  const next = params.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${next ? `#${next}` : ''}`);
}

function StatusCell({ asset }: { asset: NetworkAssetRowDto }) {
  const testId = `portal-network-asset-status-${asset.id}`;
  if (asset.onlineState === 'online') {
    return <StatusMark tone="success" data-testid={testId}>Online</StatusMark>;
  }
  if (asset.onlineState === 'offline') {
    return <StatusMark tone="destructive" data-testid={testId}>Offline</StatusMark>;
  }
  return <StatusMark tone="neutral" data-testid={testId}>Unknown</StatusMark>;
}

const FILTER_SELECT = cn(INPUT, 'mt-0 w-auto min-w-[10rem]');

export function NetworkAssetTable({
  initial,
  timezone = 'UTC',
  error,
}: {
  /** First page, server-rendered. null when that load failed. */
  initial: NetworkAssetsDto | null;
  timezone?: string;
  error?: string | null;
}) {
  const [result, setResult] = useState<NetworkAssetsDto | null>(initial);
  const [failed, setFailed] = useState(Boolean(error) || initial === null);
  const [filters, setFilters] = useState<FilterState>({ assetType: '', status: '', page: 1 });
  const [busy, setBusy] = useState(false);
  const requestSeq = useRef(0);

  async function load(next: FilterState) {
    const seq = ++requestSeq.current;
    setFilters(next);
    writeHash(next);
    setBusy(true);
    const response = await portalApi.getNetworkAssets({
      page: next.page,
      limit: PAGE_SIZE,
      assetType: next.assetType || undefined,
      status: (next.status || undefined) as NetworkAssetStatusFilter | undefined,
    });
    if (seq !== requestSeq.current) return; // a newer request superseded this one
    // A stale/shared #page=99 (or a shrunken total) lands past the last page:
    // the API answers an empty list with the real total. Clamp to the last page
    // rather than showing a "no match" message under a bogus page number.
    if (
      response.data &&
      response.data.dataStatus === 'ok' &&
      response.data.data.length === 0 &&
      response.data.pagination.total > 0 &&
      next.page > 1
    ) {
      void load({ ...next, page: Math.max(1, Math.ceil(response.data.pagination.total / PAGE_SIZE)) });
      return;
    }
    setBusy(false);
    if (response.data && response.data.dataStatus !== 'not_enabled') {
      setResult(response.data);
      setFailed(false);
    } else {
      setFailed(true);
    }
  }

  // A shared/reloaded link carries its filters in the hash; the server render
  // knows nothing of them, so fetch once if they differ from the defaults.
  useEffect(() => {
    const fromHash = readHash();
    if (fromHash.assetType || fromHash.status || fromHash.page > 1) {
      void load(fromHash);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = Boolean(filters.assetType || filters.status);
  const rows = result?.data ?? [];
  const total = result?.pagination.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (initial === null && result === null) {
    return (
      <div data-testid="portal-network-asset-error" className="mt-10">
        {/* The transport error is ours to read, not the customer's. */}
        <ErrorNotice>We couldn&apos;t load your network assets just now. Your IT team can help.</ErrorNotice>
      </div>
    );
  }

  // Nothing discovered at all (unfiltered): the empty state, no filters to play with.
  if (result?.dataStatus === 'no_data' && !filtered && !failed) {
    return (
      <EmptyState
        data-testid="portal-network-asset-empty"
        icon={<Network className="h-10 w-10" strokeWidth={1.5} />}
        title="No network assets have been discovered yet"
      >
        <p className="mt-1 text-sm text-muted-foreground">
          Your IT team has not discovered any devices on your network.
        </p>
      </EmptyState>
    );
  }

  return (
    <div className="mt-10">
      <h2 className="mb-4 font-display text-lg font-semibold text-foreground">Network assets</h2>

      <div className="mb-4 flex flex-wrap items-end gap-4" data-testid="portal-network-filters">
        <label className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Type
          <select
            className={FILTER_SELECT}
            data-testid="portal-network-filter-type"
            value={filters.assetType}
            onChange={(e) => void load({ ...filters, assetType: e.target.value, page: 1 })}
          >
            <option value="">All types</option>
            {ASSET_TYPES.map((t) => (
              <option key={t} value={t}>{typeLabel(t)}</option>
            ))}
          </select>
        </label>
        <label className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Status
          <select
            className={FILTER_SELECT}
            data-testid="portal-network-filter-status"
            value={filters.status}
            onChange={(e) => void load({ ...filters, status: e.target.value, page: 1 })}
          >
            <option value="">All statuses</option>
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        {filtered && (
          <button
            type="button"
            className={BTN_SECONDARY}
            data-testid="portal-network-filter-clear"
            onClick={() => void load({ assetType: '', status: '', page: 1 })}
          >
            Clear filters
          </button>
        )}
      </div>

      {failed ? (
        <div data-testid="portal-network-asset-error">
          <ErrorNotice>We couldn&apos;t load your network assets just now. Your IT team can help.</ErrorNotice>
        </div>
      ) : rows.length === 0 ? (
        <p
          className="border-y border-border/70 py-6 text-center text-sm text-muted-foreground"
          data-testid="portal-network-asset-no-match"
        >
          No network assets match these filters.
        </p>
      ) : (
        <div className={cn('overflow-x-auto', busy && 'opacity-60')} aria-busy={busy}>
          <table className="block w-full sm:table sm:min-w-[72rem]" data-testid="portal-network-asset-table">
            <thead className="hidden border-b border-border sm:table-header-group">
              <tr>
                <th scope="col" className={cn(TH, 'text-left')}>Hostname</th>
                <th scope="col" className={cn(TH, 'text-left')}>IP address</th>
                <th scope="col" className={cn(TH, 'text-left')}>MAC address</th>
                <th scope="col" className={cn(TH, 'text-left')}>Type</th>
                <th scope="col" className={cn(TH, 'text-left')}>Status</th>
                <th scope="col" className={cn(TH, 'text-left')}>Make / model</th>
                <th scope="col" className={cn(TH, 'text-left')}>Site</th>
                <th scope="col" className={cn(TH, 'text-left')}>Last seen</th>
                <th scope="col" className={cn(TH, 'text-left')}>First seen</th>
              </tr>
            </thead>
            <tbody className="block divide-y divide-border/70 sm:table-row-group">
              {rows.map((a) => (
                <tr key={a.id} className={ROW} data-testid={`portal-network-asset-${a.id}`}>
                  <td className={cn(CELL, 'order-1 grow font-semibold text-foreground')}>
                    {a.hostname ?? a.label ?? '—'}
                  </td>
                  <td className={cn(CELL, 'order-3 text-sm text-foreground')}>
                    <span className={PHONE_LABEL}>IP address</span>
                    {a.ipAddress ?? '—'}
                  </td>
                  <td className={cn(CELL, 'order-4 text-sm text-foreground')}>
                    <span className={PHONE_LABEL}>MAC address</span>
                    {a.macAddress ?? '—'}
                  </td>
                  <td className={cn(CELL, 'order-5 text-sm text-foreground')}>
                    <span className={PHONE_LABEL}>Type</span>
                    {typeLabel(a.assetType)}
                  </td>
                  <td className={cn(CELL, 'order-2 text-sm')}>
                    <StatusCell asset={a} />
                  </td>
                  <td className={cn(CELL, 'order-6 text-sm text-foreground')}>
                    <span className={PHONE_LABEL}>Make / model</span>
                    {[a.manufacturer, a.model].filter(Boolean).join(' ') || '—'}
                  </td>
                  <td className={cn(CELL, 'order-7 text-sm text-foreground')}>
                    <span className={PHONE_LABEL}>Site</span>
                    {a.siteName}
                  </td>
                  <td className={cn(CELL, 'order-8 text-sm text-foreground')}>
                    <span className={PHONE_LABEL}>Last seen</span>
                    {a.lastSeenAt ? formatDateTime(a.lastSeenAt, timezone, true) : '—'}
                  </td>
                  <td className={cn(CELL, 'order-9 text-sm text-foreground')}>
                    <span className={PHONE_LABEL}>First seen</span>
                    {formatDateTime(a.firstSeenAt, timezone, true)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!failed && total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 pt-3.5">
          <span
            className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground"
            data-testid="portal-network-asset-count"
          >
            Showing {rows.length} of {total} assets
          </span>
          <span className="flex items-center gap-3">
            <button
              type="button"
              className={BTN_SECONDARY}
              data-testid="portal-network-prev"
              disabled={busy || filters.page <= 1}
              onClick={() => void load({ ...filters, page: filters.page - 1 })}
            >
              Previous
            </button>
            <span className="text-sm text-muted-foreground">
              Page {filters.page} of {lastPage}
            </span>
            <button
              type="button"
              className={BTN_SECONDARY}
              data-testid="portal-network-next"
              disabled={busy || filters.page >= lastPage}
              onClick={() => void load({ ...filters, page: filters.page + 1 })}
            >
              Next
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

export default NetworkAssetTable;
