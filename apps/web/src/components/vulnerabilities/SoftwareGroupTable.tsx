import { useEffect, useMemo, useState } from 'react';

import { ResponsiveTable, DataCard, CardField } from '../shared/ResponsiveTable';
import { SeverityBadge } from './SeverityBadge';
import {
  fetchSoftwareGroups,
  type SoftwareGroup,
  type VulnFleetFilters,
} from '../../lib/api/vulnerabilities';

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

const KEV_BADGE = (
  <span className="inline-flex items-center rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">
    KEV
  </span>
);

export function SoftwareGroupTable({
  filters,
  refreshKey,
  onSelectGroup,
  onClearFilters,
}: {
  filters: VulnFleetFilters;
  refreshKey: number;
  onSelectGroup: (groupKey: string) => void;
  onClearFilters: () => void;
}) {
  const [items, setItems] = useState<SoftwareGroup[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
  }, [filters, refreshKey]);

  const table = useMemo(
    () => (
      <table className="min-w-full divide-y">
        <thead className="bg-muted/40">
          <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-3">Software</th>
            <th className="px-4 py-3">Severity</th>
            <th className="px-4 py-3">Risk</th>
            <th className="px-4 py-3">CVEs</th>
            <th className="px-4 py-3">Devices</th>
            <th className="px-4 py-3">Patch</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {items.map((g) => (
            <tr
              key={g.groupKey}
              data-testid={`software-group-row-${g.groupKey}`}
              className="cursor-pointer transition hover:bg-muted/40"
              onClick={() => onSelectGroup(g.groupKey)}
            >
              <td className="px-4 py-3 text-sm">
                <div className="font-medium">{g.name}</div>
                <div className="text-xs text-muted-foreground">
                  {[g.vendor, versionRange(g.versions)].filter(Boolean).join(' · ')}
                </div>
              </td>
              <td className="px-4 py-3 text-sm">
                <span className="inline-flex items-center gap-1.5">
                  <SeverityBadge severity={g.worstSeverity} />
                  {g.kevCveCount > 0 && KEV_BADGE}
                </span>
              </td>
              <td className="px-4 py-3 text-sm tabular-nums">{fmtRisk(g.maxRiskScore)}</td>
              <td className="px-4 py-3 text-sm tabular-nums">{g.cveCount}</td>
              <td className="px-4 py-3 text-sm tabular-nums">{g.deviceCount}</td>
              <td className="px-4 py-3 text-sm">{patchLabel(g)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    ),
    [items, onSelectGroup],
  );

  const cards = useMemo(
    () =>
      items.map((g) => (
        <DataCard key={g.groupKey} onClick={() => onSelectGroup(g.groupKey)}>
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-semibold">{g.name}</span>
            <span className="inline-flex shrink-0 items-center gap-1.5">
              <SeverityBadge severity={g.worstSeverity} />
              {g.kevCveCount > 0 && KEV_BADGE}
            </span>
          </div>
          <div className="mt-3 space-y-2 border-t pt-3">
            <CardField label="Risk"><span className="text-sm tabular-nums">{fmtRisk(g.maxRiskScore)}</span></CardField>
            <CardField label="CVEs"><span className="text-sm tabular-nums">{g.cveCount}</span></CardField>
            <CardField label="Devices"><span className="text-sm tabular-nums">{g.deviceCount}</span></CardField>
            <CardField label="Patch"><span className="text-sm">{patchLabel(g)}</span></CardField>
          </div>
        </DataCard>
      )),
    [items, onSelectGroup],
  );

  if (error) {
    return (
      <div
        data-testid="software-group-table-error"
        className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300"
      >
        {error}
      </div>
    );
  }

  if (!loading && items.length === 0) {
    return (
      <div
        data-testid="software-group-table-empty"
        className="rounded-md border border-dashed px-4 py-12 text-center text-sm text-muted-foreground"
      >
        <p>No vulnerabilities match the current filters.</p>
        <button
          type="button"
          data-testid="software-group-clear-filters"
          className="mt-2 text-sm font-medium text-primary hover:underline"
          onClick={onClearFilters}
        >
          Clear filters
        </button>
      </div>
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
