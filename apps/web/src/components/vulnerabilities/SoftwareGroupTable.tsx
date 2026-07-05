import { useEffect, useMemo, useState } from 'react';

import { ResponsiveTable, DataCard, CardField } from '../shared/ResponsiveTable';
import HelpTooltip from '../shared/HelpTooltip';
import { SeverityBadge } from './SeverityBadge';
import { KevBadge } from './KevBadge';
import { RISK_EXPLANATION } from './vulnExplanations';
import { VulnEmptyState, type VulnEmptyVariant } from './VulnEmptyState';
import { densityTableClasses, readDensity, subscribeDensity, type Density } from '../../lib/density';
import {
  fetchSoftwareGroups,
  type SoftwareGroup,
  type VulnFleetFilters,
} from '../../lib/api/vulnerabilities';

// Keyboard path into the drawer: the whole row stays mouse-clickable, but the
// primary cell carries a real <button> so keyboard/screen-reader users can
// reach and activate every row.
const ROW_BUTTON =
  'block w-full rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary';

const RETRY_BTN =
  'mt-2 inline-flex items-center rounded-md border border-red-300 px-3 py-1 text-sm font-medium transition hover:bg-red-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary dark:border-red-800 dark:hover:bg-red-900/40';

const SKELETON_BAR = 'h-4 rounded bg-muted motion-safe:animate-pulse';

function fmtRisk(value: number | null): string {
  return value === null ? '—' : String(Math.round(value));
}

function versionRange(versions: string[]): string {
  if (versions.length === 0) return '';
  if (versions.length === 1) return versions[0]!;
  return `${versions[0]} – ${versions[versions.length - 1]}`;
}

function patchLabel(g: SoftwareGroup): string {
  return g.patchReadyFindingCount > 0 ? `Ready · ${g.patchReadyDeviceCount}/${g.deviceCount} devices` : '—';
}

export function SoftwareGroupTable({
  filters,
  refreshKey,
  emptyVariant,
  lastDetectedAt,
  onSelectGroup,
  onClearFilters,
}: {
  filters: VulnFleetFilters;
  refreshKey: number;
  /** Zero-rows story, decided by the page (needs filters + stats). */
  emptyVariant: VulnEmptyVariant;
  lastDetectedAt?: string | null;
  onSelectGroup: (groupKey: string) => void;
  onClearFilters: () => void;
}) {
  const [items, setItems] = useState<SoftwareGroup[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  // Table density reflects the account-wide preference (breeze.density) set in
  // the top-bar theme/display menu — same mechanism as DeviceList.
  const [density, setDensity] = useState<Density>(() => readDensity());
  useEffect(() => subscribeDensity(setDensity), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchSoftwareGroups(filters)
      .then((res) => {
        if (cancelled) return;
        setItems(res.items);
        setHasMore(res.hasMore);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load software groups');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filters, refreshKey, retryKey]);

  // Skeleton only on empty loads (first paint / after an error retry). A
  // filter-change refetch keeps the previous rows on screen instead of flashing.
  const showSkeleton = loading && items.length === 0;

  const table = useMemo(
    () => (
      <table className={`min-w-full divide-y ${densityTableClasses(density)}`}>
        <thead className="bg-muted/40">
          <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-3">Software</th>
            <th className="px-4 py-3">Severity</th>
            <th className="px-4 py-3">
              <span className="inline-flex items-center gap-1">
                Risk
                {/* side="bottom": an upward bubble would clip against the
                    ResponsiveTable overflow-x-auto wrapper's top edge. */}
                <HelpTooltip side="bottom" ariaLabel="About the risk score" text={RISK_EXPLANATION} />
              </span>
            </th>
            <th className="px-4 py-3">CVEs</th>
            <th className="px-4 py-3">Devices</th>
            <th className="px-4 py-3">Patch</th>
          </tr>
        </thead>
        {showSkeleton ? (
          <tbody className="divide-y" data-testid="software-group-table-skeleton" aria-hidden="true">
            {Array.from({ length: 5 }).map((_, i) => (
              <tr key={i}>
                <td className="px-4 py-3">
                  <div className={`${SKELETON_BAR} w-40`} />
                  <div className={`${SKELETON_BAR} mt-1.5 h-3 w-24`} />
                </td>
                <td className="px-4 py-3"><div className={`${SKELETON_BAR} h-5 w-16 rounded-full`} /></td>
                <td className="px-4 py-3"><div className={`${SKELETON_BAR} w-8`} /></td>
                <td className="px-4 py-3"><div className={`${SKELETON_BAR} w-8`} /></td>
                <td className="px-4 py-3"><div className={`${SKELETON_BAR} w-8`} /></td>
                <td className="px-4 py-3"><div className={`${SKELETON_BAR} w-24`} /></td>
              </tr>
            ))}
          </tbody>
        ) : (
          <tbody className="divide-y">
            {items.map((g) => (
              <tr
                key={g.groupKey}
                data-testid={`software-group-row-${g.groupKey}`}
                className="cursor-pointer transition hover:bg-muted/40"
                onClick={() => onSelectGroup(g.groupKey)}
              >
                <td className="px-4 py-3 text-sm">
                  <button
                    type="button"
                    data-testid={`software-group-open-${g.groupKey}`}
                    aria-label={`Open ${g.name} vulnerability details`}
                    className={ROW_BUTTON}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectGroup(g.groupKey);
                    }}
                  >
                    <span className="block font-medium">{g.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {[g.vendor, versionRange(g.versions)].filter(Boolean).join(' · ')}
                    </span>
                  </button>
                </td>
                <td className="px-4 py-3 text-sm">
                  <span className="inline-flex items-center gap-1.5">
                    <SeverityBadge severity={g.worstSeverity} />
                    {g.kevCveCount > 0 && <KevBadge />}
                  </span>
                </td>
                <td className="px-4 py-3 text-sm tabular-nums">{fmtRisk(g.maxRiskScore)}</td>
                <td className="px-4 py-3 text-sm tabular-nums">{g.cveCount}</td>
                <td className="px-4 py-3 text-sm tabular-nums">{g.deviceCount}</td>
                <td className="px-4 py-3 text-sm">{patchLabel(g)}</td>
              </tr>
            ))}
          </tbody>
        )}
      </table>
    ),
    [items, onSelectGroup, density, showSkeleton],
  );

  const cards = useMemo(
    () =>
      showSkeleton
        ? Array.from({ length: 3 }).map((_, i) => (
            <div key={i} aria-hidden="true">
              <DataCard>
                <div className={`${SKELETON_BAR} w-36`} />
                <div className="mt-3 space-y-2 border-t pt-3">
                  <div className={`${SKELETON_BAR} w-full`} />
                  <div className={`${SKELETON_BAR} w-2/3`} />
                </div>
              </DataCard>
            </div>
          ))
        : items.map((g) => (
            <DataCard key={g.groupKey} onClick={() => onSelectGroup(g.groupKey)}>
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  aria-label={`Open ${g.name} vulnerability details`}
                  className={`${ROW_BUTTON} min-w-0 flex-1 truncate text-sm font-semibold`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectGroup(g.groupKey);
                  }}
                >
                  {g.name}
                </button>
                <span className="inline-flex shrink-0 items-center gap-1.5">
                  <SeverityBadge severity={g.worstSeverity} />
                  {g.kevCveCount > 0 && <KevBadge />}
                </span>
              </div>
              <div className="mt-3 space-y-2 border-t pt-3">
                <CardField label="Risk"><span className="text-sm tabular-nums" title={RISK_EXPLANATION}>{fmtRisk(g.maxRiskScore)}</span></CardField>
                <CardField label="CVEs"><span className="text-sm tabular-nums">{g.cveCount}</span></CardField>
                <CardField label="Devices"><span className="text-sm tabular-nums">{g.deviceCount}</span></CardField>
                <CardField label="Patch"><span className="text-sm">{patchLabel(g)}</span></CardField>
              </div>
            </DataCard>
          )),
    [items, onSelectGroup, showSkeleton],
  );

  if (error) {
    return (
      <div
        data-testid="software-group-table-error"
        className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300"
      >
        <p>{error}</p>
        <button
          type="button"
          data-testid="software-group-table-retry"
          className={RETRY_BTN}
          onClick={() => setRetryKey((k) => k + 1)}
        >
          Retry
        </button>
      </div>
    );
  }

  if (!loading && items.length === 0) {
    return (
      <VulnEmptyState
        variant={emptyVariant}
        lastDetectedAt={lastDetectedAt}
        onClearFilters={onClearFilters}
        containerTestId="software-group-table-empty"
        clearFiltersTestId="software-group-clear-filters"
      />
    );
  }

  return (
    <div className="space-y-2">
      <ResponsiveTable table={table} cards={cards} />
      {hasMore && (
        <p data-testid="software-group-has-more" className="text-xs text-muted-foreground">
          Showing the top 500 groups by risk — narrow the filters to see the rest.
        </p>
      )}
    </div>
  );
}

export default SoftwareGroupTable;
