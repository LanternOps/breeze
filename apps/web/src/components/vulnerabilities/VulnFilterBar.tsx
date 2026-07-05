import type { VulnFleetFilters } from '../../lib/api/vulnerabilities';

const SEVERITY_OPTIONS = ['critical', 'high', 'medium', 'low'] as const;
const STATUS_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'mitigated', label: 'Mitigated' },
  { value: 'patched', label: 'Patched' },
  { value: 'all', label: 'All statuses' },
] as const;

const selectCls = 'rounded-md border bg-background px-2 py-1 text-sm';

export function VulnFilterBar({
  filters,
  onChange,
}: {
  filters: VulnFleetFilters;
  onChange: (f: VulnFleetFilters) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <input
        type="search"
        data-testid="vuln-filter-search"
        value={filters.search}
        onChange={(e) => onChange({ ...filters, search: e.target.value })}
        placeholder="Search software or CVE…"
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
          onChange={(e) => onChange({ ...filters, status: e.target.value })}
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
    </div>
  );
}

export default VulnFilterBar;
