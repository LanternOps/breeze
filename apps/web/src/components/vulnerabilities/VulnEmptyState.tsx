import { ScanSearch, ShieldCheck } from 'lucide-react';

import type { FleetVulnStats, VulnFleetFilters } from '../../lib/api/vulnerabilities';

/** The page's baseline filter state — anything else counts as "filtered". */
export const DEFAULT_FILTERS: VulnFleetFilters = {
  search: '',
  severity: '',
  status: 'open',
  kevOnly: false,
  patchAvailable: false,
};

export function isDefaultVulnFilters(filters: VulnFleetFilters): boolean {
  return (
    filters.search === DEFAULT_FILTERS.search &&
    filters.severity === DEFAULT_FILTERS.severity &&
    filters.status === DEFAULT_FILTERS.status &&
    filters.kevOnly === DEFAULT_FILTERS.kevOnly &&
    filters.patchAvailable === DEFAULT_FILTERS.patchAvailable &&
    filters.expiringWithinDays === undefined
  );
}

/**
 * Which zero-rows story to tell:
 *  - 'filtered'  — a non-default filter is active; the filters are the reason.
 *  - 'clean'     — default filters, and scanning HAS produced findings before
 *                  (stats.totalFindings > 0), so zero open findings is a
 *                  genuinely clean fleet. The best possible outcome.
 *  - 'unscanned' — default filters and zero findings EVER: either vulnerability
 *                  scanning was never enabled, or it has genuinely never found
 *                  anything. The copy stays honest about both.
 *  - 'unknown'   — default filters but stats are unavailable (still loading or
 *                  failed), so we cannot make either claim.
 */
export type VulnEmptyVariant = 'filtered' | 'clean' | 'unscanned' | 'unknown';

export function resolveVulnEmptyVariant(
  filters: VulnFleetFilters,
  stats: FleetVulnStats | null,
): VulnEmptyVariant {
  if (!isDefaultVulnFilters(filters)) return 'filtered';
  if (!stats) return 'unknown';
  return stats.totalFindings > 0 ? 'clean' : 'unscanned';
}

const CLEAR_BTN =
  'mt-2 text-sm font-medium text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary';

/**
 * Shared zero-rows treatment for both fleet vulnerability tables. Calm product
 * UI: type + spacing + at most one icon per state, in the same dashed box the
 * tables have always used so the layout doesn't jump between variants.
 */
export function VulnEmptyState({
  variant,
  lastDetectedAt,
  onClearFilters,
  containerTestId,
  clearFiltersTestId,
}: {
  variant: VulnEmptyVariant;
  lastDetectedAt?: string | null;
  onClearFilters: () => void;
  /** Preserved outer testid (`software-group-table-empty` / `vulnerability-table-empty`). */
  containerTestId: string;
  /** Preserved clear-filters testid, distinct per table. */
  clearFiltersTestId: string;
}) {
  return (
    <div
      data-testid={containerTestId}
      className="rounded-md border border-dashed px-4 py-12 text-center text-sm text-muted-foreground"
    >
      {variant === 'filtered' && (
        <div data-testid="vuln-empty-filtered">
          <p>No vulnerabilities match the current filters.</p>
          <button type="button" data-testid={clearFiltersTestId} className={CLEAR_BTN} onClick={onClearFilters}>
            Clear filters
          </button>
        </div>
      )}

      {variant === 'clean' && (
        <div data-testid="vuln-empty-clean" className="mx-auto max-w-md">
          <ShieldCheck aria-hidden="true" className="mx-auto h-8 w-8 text-emerald-600 dark:text-emerald-400" />
          <p className="mt-3 text-base font-semibold text-foreground">No open vulnerabilities across your fleet</p>
          <p className="mt-1">
            Every detected finding has been patched, mitigated, or accepted. New findings will appear here as scans
            run.
          </p>
          {lastDetectedAt && (
            <p className="mt-3 text-xs">
              Last finding detected {new Date(lastDetectedAt).toLocaleDateString()}
            </p>
          )}
        </div>
      )}

      {variant === 'unscanned' && (
        <div data-testid="vuln-empty-unscanned" className="mx-auto max-w-md">
          <ScanSearch aria-hidden="true" className="mx-auto h-8 w-8" />
          <p className="mt-3 text-base font-semibold text-foreground">No vulnerability findings yet</p>
          <p className="mt-1">
            Breeze checks each device&apos;s software and OS inventory against known CVEs and queues anything that
            needs patching, mitigation, or risk acceptance here.
          </p>
          <p className="mt-2">
            Scanning is off by default — enable it on the Vulnerability tab of a configuration policy.
          </p>
          <a
            href="/configuration-policies"
            data-testid="vuln-empty-setup-link"
            className="mt-3 inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary"
          >
            Set up vulnerability scanning
          </a>
        </div>
      )}

      {variant === 'unknown' && (
        // Stats unavailable: no rows to show, but we can't honestly claim
        // "clean" or "not set up" — stay neutral.
        <p data-testid="vuln-empty-unknown">No vulnerabilities to show.</p>
      )}
    </div>
  );
}

export default VulnEmptyState;
