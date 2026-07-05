import { useEffect, useRef, useState } from 'react';

import type { VulnFleetFilters } from '../../lib/api/vulnerabilities';

const SEARCH_DEBOUNCE_MS = 300;

const SEVERITY_OPTIONS = ['critical', 'high', 'medium', 'low'] as const;
const STATUS_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'mitigated', label: 'Mitigated' },
  { value: 'patched', label: 'Patched' },
  { value: 'all', label: 'All statuses' },
] as const;

const selectCls = 'rounded-md border bg-background px-2 py-1 text-sm';

// Honest, tab-aware placeholder: the software endpoint matches name, vendor
// and CVE ids, but the by-CVE endpoint only matches CVE ids (matching software
// names there would mean joining per-device inventory into the CVE aggregate —
// not a small or index-friendly change), so the placeholder must not promise it.
const SEARCH_PLACEHOLDER: Record<'software' | 'cves', string> = {
  software: 'Search software or CVE…',
  cves: 'Search CVE id…',
};

export function VulnFilterBar({
  filters,
  onChange,
  searchScope = 'software',
}: {
  filters: VulnFleetFilters;
  onChange: (f: VulnFleetFilters) => void;
  /** Active tab — controls what the search placeholder can honestly claim. */
  searchScope?: 'software' | 'cves';
}) {
  // Local echo of the search box so typing is instant while the fetch-driving
  // filter commits on a trailing debounce (one request per pause, not per
  // keystroke — same pattern as TicketsPage). Clearing applies immediately.
  const [searchText, setSearchText] = useState(filters.search);
  // Latest filters/onChange without retriggering the debounce effect: the
  // timer must only reset on *typing*, and a commit must never carry a stale
  // copy of the other (non-debounced) filter fields.
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // External resets (Clear filters, stat-card presets) flow back into the box.
  useEffect(() => {
    setSearchText(filters.search);
  }, [filters.search]);

  useEffect(() => {
    if (searchText === filtersRef.current.search) return;
    const commit = () => onChangeRef.current({ ...filtersRef.current, search: searchText });
    if (searchText === '') {
      // An emptied box applies immediately — clearing a search should feel instant.
      commit();
      return;
    }
    const id = setTimeout(commit, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [searchText]);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <input
        type="search"
        data-testid="vuln-filter-search"
        value={searchText}
        onChange={(e) => setSearchText(e.target.value)}
        placeholder={SEARCH_PLACEHOLDER[searchScope]}
        className="w-56 rounded-md border bg-background px-2 py-1 text-sm"
      />
      <label className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">Severity</span>
        <select
          data-testid="vuln-filter-severity"
          value={filters.severity}
          onChange={(e) => onChange({ ...filters, severity: e.target.value })}
          className={selectCls}
        >
          <option value="">All</option>
          {SEVERITY_OPTIONS.map((s) => (
            <option key={s} value={s}>{s[0]!.toUpperCase() + s.slice(1)}</option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">Status</span>
        <select
          data-testid="vuln-filter-status"
          value={filters.status}
          // Changing status drops the (invisible) expiring-soon window — it is
          // only meaningful for accepted findings and must not silently narrow
          // another status view.
          onChange={(e) => onChange({ ...filters, status: e.target.value, expiringWithinDays: undefined })}
          className={selectCls}
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          data-testid="vuln-filter-kev"
          checked={filters.kevOnly}
          onChange={(e) => onChange({ ...filters, kevOnly: e.target.checked })}
          className="h-4 w-4 rounded border"
        />
        <span>KEV only</span>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          data-testid="vuln-filter-patch"
          checked={filters.patchAvailable}
          onChange={(e) => onChange({ ...filters, patchAvailable: e.target.checked })}
          className="h-4 w-4 rounded border"
        />
        <span>Patch available</span>
      </label>
      {filters.expiringWithinDays !== undefined && (
        // Active-filter chip for the stat-card-driven window: there is no
        // visible control that sets it, so without this chip users would be
        // trapped in an invisible filter.
        <button
          type="button"
          data-testid="vuln-filter-expiring-clear"
          className="inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2.5 py-1 text-xs font-medium transition hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary"
          aria-label={`Clear the expiring within ${filters.expiringWithinDays} days filter`}
          onClick={() => onChange({ ...filters, expiringWithinDays: undefined })}
        >
          Expiring within {filters.expiringWithinDays} days
          <span aria-hidden="true">×</span>
        </button>
      )}
    </div>
  );
}

export default VulnFilterBar;
