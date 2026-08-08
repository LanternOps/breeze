import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Info, Loader2, RefreshCw, Sparkles, XCircle, ChevronRight } from 'lucide-react';
import { cn, formatRelativeTime } from '@/lib/utils';
import { formatNumber } from '@/lib/i18n/format';
import { useHashState } from '@/lib/useHashState';
import { listFindings } from '@/services/fleetFindings';
import type {
  FleetFinding, FleetFindingDetail, FleetFindingKind, FleetFindingSeverity, FleetFindingStatus,
} from '@/services/fleetFindings';
import {
  FINDING_KINDS, FINDING_SEVERITIES, KIND_LABEL_KEYS, SEVERITY_ICONS, SEVERITY_ICON_CLASSES,
  SEVERITY_LABEL_KEYS, STATUS_CHIP_CLASSES, STATUS_LABEL_KEYS,
} from './findingLabels';
import FindingDrawer from './FindingDrawer';

/** The three mutually exclusive status views the feed offers. `active` is the
 *  default and matches the API's own default (open + acknowledged). */
type StatusGroup = 'active' | 'dismissed' | 'resolved';

const STATUS_GROUPS: Record<StatusGroup, FleetFindingStatus[]> = {
  active: ['open', 'acknowledged'],
  dismissed: ['dismissed'],
  resolved: ['resolved'],
};

const PAGE_SIZE = 50;

const STATUS_GROUP_LABEL_KEYS: Record<StatusGroup, string> = {
  active: 'longTail.fleet.FindingsFeed.status.active',
  dismissed: 'longTail.fleet.FindingsFeed.status.dismissed',
  resolved: 'longTail.fleet.FindingsFeed.status.resolved',
};

// ─── Hash-backed selection ──────────────────────────────────────────────

/** Parses the fragment into a finding id. `undefined` means "no selection",
 *  which `useHashState` maps back to the SSR-safe default (null). */
function parseHashId(raw: string): string | null | undefined {
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Drop the fragment WITHOUT leaving a bare `#` behind (assigning `hash = ''`
 *  leaves one and re-fires hashchange). */
function clearHash(): void {
  if (typeof window === 'undefined') return;
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}

// ─── Component ──────────────────────────────────────────────────────────

interface FindingsFeedProps {
  /** Task 10 owns the remediation picker; the drawer only raises the intent. */
  onRemediate?: (finding: FleetFindingDetail) => void;
}

export default function FindingsFeed({ onRemediate }: FindingsFeedProps) {
  const { t } = useTranslation('common');

  const [findings, setFindings] = useState<FleetFinding[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  const [orgId, setOrgId] = useState<string>('');
  const [kind, setKind] = useState<FleetFindingKind | ''>('');
  const [severity, setSeverity] = useState<FleetFindingSeverity | ''>('');
  const [statusGroup, setStatusGroup] = useState<StatusGroup>('active');
  const [reloadToken, setReloadToken] = useState(0);

  // Org options accumulate across loads: once an org filter is applied the
  // response only carries that org, so deriving the list from the CURRENT page
  // alone would strand the user on their own selection with no way back.
  const [orgOptions, setOrgOptions] = useState<Array<{ id: string; name: string }>>([]);

  // Hash-derived, but adopted post-mount: reading the fragment in a useState
  // initializer is an SSR hydration mismatch (#2421). useHashState also owns
  // the `hashchange` subscription for back/forward navigation.
  const [selectedId, setSelectedId] = useHashState<string | null>(null, parseHashId);

  // A monotonic request id so a slow earlier fetch can't overwrite a newer one.
  const requestSeq = useRef(0);

  // Full (re)load from the top of the result set — every filter change and
  // every reload (refresh button, retry button, a lifecycle change that moves
  // a finding out of the active filter) goes through here, which is what
  // resets any pages accumulated via `loadMore` below.
  useEffect(() => {
    const seq = ++requestSeq.current;
    let cancelled = false;
    setIsLoading(true);
    setIsLoadingMore(false);
    setError(null);
    setLoadMoreError(null);

    listFindings({
      orgId: orgId || undefined,
      kind: kind || undefined,
      severity: severity || undefined,
      statuses: STATUS_GROUPS[statusGroup],
      limit: PAGE_SIZE,
      offset: 0,
    })
      .then((result) => {
        if (cancelled || seq !== requestSeq.current) return;
        setFindings(result.findings);
        setTotal(result.total);
        setOrgOptions((prev) => mergeOrgOptions(prev, result.findings));
      })
      .catch((err: unknown) => {
        if (cancelled || seq !== requestSeq.current) return;
        // Never fall back to an empty list — "we could not load" and "the fleet
        // is clean" are opposite messages and must not be confused.
        setFindings([]);
        setTotal(0);
        setError(
          err instanceof Error && err.message
            ? err.message
            : t('longTail.fleet.FindingsFeed.errors.loadFailed')
        );
      })
      .finally(() => {
        if (cancelled || seq !== requestSeq.current) return;
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [orgId, kind, severity, statusGroup, reloadToken, t]);

  // Appends the next page onto the current list. Uses the same monotonic
  // `requestSeq` counter as the effect above, so a slow load-more that lands
  // after the user has already changed a filter (which bumps the counter via
  // a fresh full load) is discarded instead of corrupting the new view.
  const loadMore = useCallback(() => {
    const seq = ++requestSeq.current;
    setIsLoadingMore(true);
    setLoadMoreError(null);

    listFindings({
      orgId: orgId || undefined,
      kind: kind || undefined,
      severity: severity || undefined,
      statuses: STATUS_GROUPS[statusGroup],
      limit: PAGE_SIZE,
      offset: findings.length,
    })
      .then((result) => {
        if (seq !== requestSeq.current) return;
        setFindings((prev) => [...prev, ...result.findings]);
        setTotal(result.total);
        setOrgOptions((prev) => mergeOrgOptions(prev, result.findings));
      })
      .catch((err: unknown) => {
        if (seq !== requestSeq.current) return;
        // Keep the rows already on screen — a failed next-page fetch is not
        // "we could not load", it just means Load more can be retried.
        setLoadMoreError(
          err instanceof Error && err.message
            ? err.message
            : t('longTail.fleet.FindingsFeed.errors.loadFailed')
        );
      })
      .finally(() => {
        if (seq !== requestSeq.current) return;
        setIsLoadingMore(false);
      });
  }, [orgId, kind, severity, statusGroup, findings.length, t]);

  const selectFinding = useCallback((id: string) => {
    setSelectedId(id);
    window.location.hash = id;
  }, []);

  const closeDrawer = useCallback(() => {
    setSelectedId(null);
    clearHash();
  }, []);

  const applyStatusChange = useCallback((updated: FleetFinding) => {
    if (!STATUS_GROUPS[statusGroup].includes(updated.status)) {
      // The finding's new status (e.g. dismissed) no longer belongs in the
      // active filter view — refetch from the top rather than patching it in
      // place, so the row actually leaves the list and "Showing X of Y" stays
      // accurate instead of showing a stale chip until a manual refresh. The
      // drawer renders off `selectedId`, not `findings`, so it keeps working
      // through the refetch even though it may still be open on this finding.
      setReloadToken((n) => n + 1);
      return;
    }
    setFindings((prev) => prev.map((f) => (f.id === updated.id ? { ...f, ...updated } : f)));
  }, [statusGroup]);

  const selectClasses =
    'rounded-md border bg-background px-2 py-1.5 text-sm text-foreground ' +
    'focus:outline-none focus:ring-2 focus:ring-ring';

  const showEmpty = !isLoading && !error && findings.length === 0;
  const hasMore = findings.length < total;
  // "Fleet is clean" is only true when nothing is narrowing the view — an
  // empty result under an active org/kind/severity/status filter just means
  // the filters exclude everything, not that the fleet has no findings.
  const hasActiveFilters =
    orgId !== '' || kind !== '' || severity !== '' || statusGroup !== 'active';

  const orgSelectOptions = useMemo(
    () => [...orgOptions].sort((a, b) => a.name.localeCompare(b.name)),
    [orgOptions]
  );

  return (
    <div className="rounded-lg border bg-card shadow-xs" data-testid="findings-feed">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Sparkles className="h-5 w-5 text-primary" />
            {t('longTail.fleet.FindingsFeed.title')}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('longTail.fleet.FindingsFeed.description')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setReloadToken((n) => n + 1)}
          data-testid="findings-refresh"
          className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors hover:bg-muted"
        >
          <RefreshCw className={cn('h-4 w-4', isLoading && 'animate-spin')} />
          {t('actions.refresh')}
        </button>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 border-b p-4">
        <select
          value={orgId}
          onChange={(e) => setOrgId(e.target.value)}
          data-testid="findings-filter-org"
          aria-label={t('longTail.fleet.FindingsFeed.filters.orgLabel')}
          className={selectClasses}
        >
          <option value="">{t('longTail.fleet.FindingsFeed.filters.allOrgs')}</option>
          {orgSelectOptions.map((org) => (
            <option key={org.id} value={org.id}>{org.name}</option>
          ))}
        </select>

        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as FleetFindingKind | '')}
          data-testid="findings-filter-kind"
          aria-label={t('longTail.fleet.FindingsFeed.filters.kindLabel')}
          className={selectClasses}
        >
          <option value="">{t('longTail.fleet.FindingsFeed.filters.allKinds')}</option>
          {FINDING_KINDS.map((k) => (
            <option key={k} value={k}>{t(/* i18n-dynamic */ KIND_LABEL_KEYS[k])}</option>
          ))}
        </select>

        <select
          value={severity}
          onChange={(e) => setSeverity(e.target.value as FleetFindingSeverity | '')}
          data-testid="findings-filter-severity"
          aria-label={t('longTail.fleet.FindingsFeed.filters.severityLabel')}
          className={selectClasses}
        >
          <option value="">{t('longTail.fleet.FindingsFeed.filters.allSeverities')}</option>
          {FINDING_SEVERITIES.map((s) => (
            <option key={s} value={s}>{t(/* i18n-dynamic */ SEVERITY_LABEL_KEYS[s])}</option>
          ))}
        </select>

        <div
          className="ml-auto flex items-center gap-1 rounded-md border p-0.5"
          data-testid="findings-filter-status"
          role="group"
          aria-label={t('longTail.fleet.FindingsFeed.filters.statusLabel')}
        >
          {(Object.keys(STATUS_GROUPS) as StatusGroup[]).map((group) => (
            <button
              key={group}
              type="button"
              onClick={() => setStatusGroup(group)}
              data-testid={`findings-status-${group}`}
              aria-pressed={statusGroup === group}
              className={cn(
                'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                statusGroup === group
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted'
              )}
            >
              {t(/* i18n-dynamic */ STATUS_GROUP_LABEL_KEYS[group])}
            </button>
          ))}
        </div>
      </div>

      {/* Error — shown INSTEAD of the empty state so a failure never reads as
          "fleet is clean". The filter bar above stays mounted and usable. */}
      {error && (
        <div
          className="m-4 rounded-lg border border-destructive/40 bg-destructive/10 p-4"
          data-testid="findings-error"
        >
          <div className="flex flex-wrap items-center gap-2 text-destructive">
            <XCircle className="h-4 w-4 shrink-0" />
            <span className="text-sm font-medium">
              {t('longTail.fleet.FindingsFeed.errors.banner')}
            </span>
            <button
              type="button"
              onClick={() => setReloadToken((n) => n + 1)}
              data-testid="findings-retry"
              className="ml-auto flex items-center gap-1 rounded-md border border-destructive/40 px-2 py-1 text-xs transition-colors hover:bg-destructive/10"
            >
              <RefreshCw className="h-3 w-3" />
              {t('actions.retry')}
            </button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{error}</p>
        </div>
      )}

      {isLoading && !error && (
        <div className="flex items-center justify-center p-10" data-testid="findings-loading">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {showEmpty && (
        <div className="flex flex-col items-center gap-2 p-10 text-center" data-testid="findings-empty">
          {hasActiveFilters ? (
            <Info className="h-8 w-8 text-muted-foreground" />
          ) : (
            <Sparkles className="h-8 w-8 text-green-600 dark:text-green-400" />
          )}
          <p className="text-base font-medium">
            {t(
              /* i18n-dynamic */ hasActiveFilters
                ? 'longTail.fleet.FindingsFeed.empty.noMatchesTitle'
                : 'longTail.fleet.FindingsFeed.empty.title'
            )}
          </p>
          <p className="text-sm text-muted-foreground">{t('longTail.fleet.FindingsFeed.empty.body')}</p>
        </div>
      )}

      {!isLoading && !error && findings.length > 0 && (
        <>
          <ul className="divide-y">
            {findings.map((f) => (
              <li key={f.id}>
                <FindingRow finding={f} onSelect={selectFinding} />
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t p-3 text-xs text-muted-foreground">
            <span>
              {t('longTail.fleet.FindingsFeed.showing', {
                shown: formatNumber(findings.length),
                total: formatNumber(total),
              })}
            </span>
            {hasMore && (
              <button
                type="button"
                onClick={loadMore}
                disabled={isLoadingMore}
                data-testid="findings-load-more"
                className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isLoadingMore && <Loader2 className="h-3 w-3 animate-spin" />}
                {t('longTail.fleet.FindingsFeed.loadMore')}
              </button>
            )}
          </div>
          {loadMoreError && (
            <div
              className="flex items-center gap-2 border-t p-3 text-xs text-destructive"
              data-testid="findings-load-more-error"
            >
              <XCircle className="h-3 w-3 shrink-0" />
              <span>{loadMoreError}</span>
            </div>
          )}
        </>
      )}

      {selectedId && (
        <FindingDrawer
          findingId={selectedId}
          onClose={closeDrawer}
          onStatusChange={applyStatusChange}
          onRemediate={onRemediate}
        />
      )}
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────

function FindingRow({ finding, onSelect }: {
  finding: FleetFinding;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation('common');
  const SeverityIcon = SEVERITY_ICONS[finding.severity] ?? Info;

  return (
    <button
      type="button"
      onClick={() => onSelect(finding.id)}
      data-testid={`finding-row-${finding.id}`}
      className="flex w-full items-start gap-3 p-4 text-left transition-colors hover:bg-muted/50"
    >
      <SeverityIcon
        className={cn('mt-0.5 h-5 w-5 shrink-0', SEVERITY_ICON_CLASSES[finding.severity])}
        aria-label={t(/* i18n-dynamic */ SEVERITY_LABEL_KEYS[finding.severity])}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{finding.title}</span>
          <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
            {t(/* i18n-dynamic */ KIND_LABEL_KEYS[finding.kind])}
          </span>
          {finding.orgName && (
            <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
              {finding.orgName}
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span>
            {t('longTail.fleet.FindingsFeed.deviceCount', { count: finding.deviceCount })}
          </span>
          <span>{formatRelativeTime(new Date(finding.lastSeenAt))}</span>
        </div>
      </div>
      <span
        className={cn(
          'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium',
          STATUS_CHIP_CLASSES[finding.status]
        )}
      >
        {t(/* i18n-dynamic */ STATUS_LABEL_KEYS[finding.status])}
      </span>
      <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/60" />
    </button>
  );
}

function mergeOrgOptions(
  previous: Array<{ id: string; name: string }>,
  findings: FleetFinding[]
): Array<{ id: string; name: string }> {
  const byId = new Map(previous.map((o) => [o.id, o]));
  let changed = false;
  for (const f of findings) {
    if (!f.orgName || byId.has(f.orgId)) continue;
    byId.set(f.orgId, { id: f.orgId, name: f.orgName });
    changed = true;
  }
  return changed ? [...byId.values()] : previous;
}
