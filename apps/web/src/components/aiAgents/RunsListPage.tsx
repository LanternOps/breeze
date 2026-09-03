import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { History } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { formatCurrency } from '@/lib/i18n/format';
import { formatTimeAgo } from '@/lib/formatTime';
import { badgeClass, runStatusTone, verdictTone } from './statusBadge';
import { EmptyState } from '../shared/EmptyState';
import type { AiAgentRunListItemDto, AiAgentRunStatus } from '@breeze/shared';
import { AI_AGENT_RUN_STATUSES } from '@breeze/shared';

// SSR-safe: reading `window` inside an effect (not a `useState` initializer)
// avoids the hydration-mismatch class useHashState.ts documents — this page
// mounts `client:load` (index.astro), so it IS server-rendered first.
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Review finding #2 (agent → runs deep link): the hash form wins over the
 * legacy `?agentId=` query param, per CLAUDE.md's hash-for-transient-UI-state
 * convention — the query param is kept only for whatever already links to it.
 *
 * Review finding #1: a malformed percent-escape (`#agent=%`) makes
 * `decodeURIComponent` throw. Uncaught, that exception fires inside the
 * mount layout effect, before the gated first fetch ever runs — the page
 * renders blank forever. The whole parse is wrapped so a bad hash degrades
 * to "no deep link" instead of taking the page down with it.
 */
function parseAgentIdFromLocation(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const hash = window.location.hash.replace(/^#/, '');
    const hashMatch = /(?:^|&)agent=([^&]*)/.exec(hash);
    if (hashMatch?.[1]) return decodeURIComponent(hashMatch[1]);
    const fromQuery = new URLSearchParams(window.location.search).get('agentId');
    return fromQuery || undefined;
  } catch {
    return undefined;
  }
}

/** Cost is per-run spend, not every viewer wants it on screen by default — a
 *  simple, per-viewer, persisted-but-not-synced preference (no cross-tab/
 *  same-page sync needed: this page has exactly one instance of the toggle,
 *  unlike billingUi.tsx's SHOW_INTERNAL_MARGIN_KEY). */
const SHOW_COST_KEY = 'breeze:ai-agents-runs-show-cost';
function readShowCost(): boolean {
  try {
    return localStorage.getItem(SHOW_COST_KEY) === '1';
  } catch {
    return false;
  }
}

/** `queuedAt`→`finishedAt` span — the list DTO carries no `startedAt` (that's
 *  detail-only), so this includes queue wait time; a duration purely for
 *  in-flight execution isn't available at list granularity. `null` while the
 *  run hasn't finished. Deliberately not i18n'd: "5m 12s" is a measurement
 *  unit string, not translated prose, matching RunDetailPage's formatDuration. */
function formatRunDuration(queuedAt: string, finishedAt: string | null): string {
  if (!finishedAt) return '—';
  const ms = new Date(finishedAt).getTime() - new Date(queuedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * Review finding #1: a relative "Started" value alone isn't enough — the
 * absolute timestamp must be programmatically available (`dateTime`) and
 * exposed to assistive tech, not just sighted users hovering for a `title`
 * tooltip.
 *
 * Review finding #4: `<time>` has no ARIA naming role of its own — it maps to
 * `generic`, and ARIA prohibits a `generic` element from taking an
 * `aria-label`/`aria-labelledby` (naming is stripped, not merely ignored).
 * The absolute timestamp is exposed instead as an `sr-only` text node inside
 * the element, so it's read as part of the element's own content rather than
 * relying on a naming attribute the accessibility tree throws away.
 */
function StartedCell({ queuedAt }: { queuedAt: string }) {
  const absolute = formatDateTime(queuedAt);
  return (
    <time dateTime={queuedAt} title={absolute}>
      {formatTimeAgo(queuedAt)}
      <span className="sr-only"> ({absolute})</span>
    </time>
  );
}

interface RunsResponse {
  data: AiAgentRunListItemDto[];
  nextCursor: string | null;
}

interface AgentOption {
  id: string;
  name: string;
}

const PAGE_LIMIT = 25;

/** Every status NOT in this set is "live" — treat an unrecognized future
 * status as live too, so a run never silently stops updating just because
 * this list predates it. */
const TERMINAL_RUN_STATUSES = new Set<AiAgentRunStatus>([
  'completed', 'failed', 'cancelled', 'expired', 'skipped',
]);
function isLiveRunStatus(status: AiAgentRunStatus): boolean {
  return !TERMINAL_RUN_STATUSES.has(status);
}

const LIST_POLL_INTERVAL_MS = 10_000;
/**
 * Review finding P2-1 (#4187 critique): a run started after the initial page
 * load never appeared, because polling stopped entirely once every visible
 * row was terminal. While unfiltered and on page 1, a run can start at any
 * time (not just while another run is already live), so keep a slow idle
 * poll going even with nothing live on screen — same mechanism, longer
 * cadence.
 */
const LIST_IDLE_POLL_INTERVAL_MS = 30_000;

/**
 * Decorative pulse next to a live row's status badge. The dot itself is
 * `aria-hidden` — it is a sighted-user cue only; the substantive
 * accessibility signal is the `aria-live="polite"` region on the status text
 * itself (screen readers announce the status word changing), plus the
 * sr-only label here so an accessibility tree still names what the dot means
 * for a screen-reader user who tabs to it.
 */
function LiveIndicator({ label }: { label: string }) {
  return (
    <span className="ml-1.5 inline-flex items-center" data-testid="run-live-indicator">
      <span className="relative flex h-2 w-2" aria-hidden="true">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-500 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-sky-500" />
      </span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

// Literal-key label lookups (not dynamic t()) so the keyUsage guard can verify
// every enum label statically — see DeviceChangeHistoryTab's typeLabel/actionLabel.
function statusLabel(t: (key: string) => string, value: AiAgentRunStatus): string {
  switch (value) {
    case 'queued':
      return t('aiAgentsPage.runs.statuses.queued');
    case 'running':
      return t('aiAgentsPage.runs.statuses.running');
    case 'awaiting_approval':
      return t('aiAgentsPage.runs.statuses.awaiting_approval');
    case 'completed':
      return t('aiAgentsPage.runs.statuses.completed');
    case 'failed':
      return t('aiAgentsPage.runs.statuses.failed');
    case 'cancelled':
      return t('aiAgentsPage.runs.statuses.cancelled');
    case 'expired':
      return t('aiAgentsPage.runs.statuses.expired');
    case 'skipped':
      return t('aiAgentsPage.runs.statuses.skipped');
    default:
      return value;
  }
}

function verdictLabel(t: (key: string) => string, value: string | null): string {
  switch (value) {
    case 'remediated':
      return t('aiAgentsPage.runs.verdicts.remediated');
    case 'needs_attention':
      return t('aiAgentsPage.runs.verdicts.needs_attention');
    case 'partial':
      return t('aiAgentsPage.runs.verdicts.partial');
    case 'no_action':
      return t('aiAgentsPage.runs.verdicts.no_action');
    default:
      return t('aiAgentsPage.runs.verdicts.pending');
  }
}

function triggerLabel(t: (key: string) => string, value: string): string {
  switch (value) {
    case 'alert':
      return t('aiAgentsPage.runs.triggers.alert');
    case 'manual':
      return t('aiAgentsPage.runs.triggers.manual');
    case 'schedule':
      return t('aiAgentsPage.runs.triggers.schedule');
    case 'ticket':
      return t('aiAgentsPage.runs.triggers.ticket');
    case 'anomaly':
      return t('aiAgentsPage.runs.triggers.anomaly');
    default:
      return value;
  }
}

/**
 * Wave 6 PR 1 (#3828) — the org-wide execution-trace runs list:
 * `GET /ai/agents/runs`, keyset-paginated on `(queuedAt DESC, id DESC)`.
 * Every row is the safe list-item projection (`AiAgentRunListItemDto`) — no
 * outcome payload, no raw tool input, ever. Row click goes to
 * `/ai-agents/runs/:id` for the full execution trace.
 *
 * The cursor is kept in component state, not the URL — the repo's
 * `window.location.hash`-only rule for transient UI state (CLAUDE.md) extends
 * to pagination cursors, which are exactly that: a "load more" position, not
 * a shareable/bookmarkable view.
 *
 * UI critique fixes: the whole page polls the first page every
 * `LIST_POLL_INTERVAL_MS` while any visible row is still in flight
 * (`hasLiveRun`), merging fresh rows in by id so a "Load more" page beyond
 * the first isn't clobbered; polling pauses while the tab is hidden.
 * When unfiltered, a run started after the initial load is prepended (not
 * just merged by id), and polling never stops outright — it drops to a slow
 * `LIST_IDLE_POLL_INTERVAL_MS` cadence once nothing visible is live, so a
 * brand-new run still surfaces without a manual reload.
 */
export default function RunsListPage() {
  const { t } = useTranslation('settings');
  // Honor the global Current/All-orgs scope toggle, same as AlertsPage:
  // `fetchWithAuth` auto-injects `?orgId=<currentOrgId>` whenever one org is
  // selected, so a scope change must trigger a refetch or the list keeps
  // showing the previous scope's rows.
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const [runs, setRuns] = useState<AiAgentRunListItemDto[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const [loadMoreError, setLoadMoreError] = useState<string>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  const [agentFilter, setAgentFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<AiAgentRunStatus | ''>('');
  const hasActiveFilter = Boolean(agentFilter || statusFilter);

  const clearFilters = useCallback(() => {
    setAgentFilter('');
    setStatusFilter('');
  }, []);

  const [showCost, setShowCost] = useState(false);
  const toggleShowCost = useCallback(() => {
    setShowCost((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SHOW_COST_KEY, next ? '1' : '0');
      } catch {
        // Best-effort — the preference just won't survive a reload.
      }
      return next;
    });
  }, []);

  // Review finding #2 — deep link from the agents list: `?agentId=` and the
  // hash form `#agent=<id>` both pre-select the agent filter, hash winning.
  // Starts at the SSR-safe default ('') and adopts the URL post-mount, before
  // paint, so a deep link lands on the right filter without a flash of the
  // unfiltered list (same rationale as useHashState.ts).
  //
  // `deepLinkResolved` gates the very first fetch (below) so it can never
  // race the deep-link's own `setAgentFilter` — both are set in the same
  // layout-effect pass, so the first fetch effect that's allowed to run
  // always sees the resolved filter, regardless of exactly how React
  // schedules the layout-effect-triggered re-render relative to the mount's
  // passive effects.
  //
  // Review finding #5: `applyDeepLink` now sets the filter unconditionally
  // (falling back to `''`), not just when a value is present — the previous
  // guard meant navigating the hash away (`#agent=a1` → no hash) left the
  // stale filter applied forever, since `hashchange` fired with `fromUrl ===
  // undefined` and the old `if (fromUrl !== undefined)` skipped clearing it.
  //
  // Review finding #5 also moves the cost-preference read into this same
  // layout effect (it used to be a separate passive `useEffect`, so
  // `showCost` flipped true a tick after the deep-link filter resolved,
  // instead of both settling in the same pre-paint pass).
  const [deepLinkResolved, setDeepLinkResolved] = useState(false);
  useIsomorphicLayoutEffect(() => {
    setShowCost(readShowCost());
    const applyDeepLink = () => {
      setAgentFilter(parseAgentIdFromLocation() ?? '');
      setDeepLinkResolved(true);
    };
    applyDeepLink();
    window.addEventListener('hashchange', applyDeepLink);
    return () => window.removeEventListener('hashchange', applyDeepLink);
  }, []);

  // Monotonic request id — same stale-response guard as DeviceChangeHistoryTab:
  // a fresh page-1 load (filter change) bumps it so a late "Load more" response
  // can detect it's stale and bail before clobbering the new filter's rows.
  // The background poll (below) shares this counter too (review finding
  // P2-2, #4187 critique), so an out-of-order poll response — or a poll that
  // resolves after a filter change already started a fresh page-1 load — is
  // detected as stale and discarded rather than regressing the screen.
  const requestIdRef = useRef(0);

  // Guards every setState in the background poll against firing after
  // unmount (review finding P2-2).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Review finding #3: only flips true once the agents list has actually
  // loaded successfully — a fetch failure leaves it false so a deep-linked
  // `agentFilter` is never dropped just because we couldn't confirm it
  // against an incomplete (empty) options list.
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetchWithAuth('/ai/agents');
        if (!response.ok) return;
        const body = (await response.json()) as { data?: unknown };
        if (cancelled || !Array.isArray(body.data)) return;
        setAgents(
          (body.data as Array<{ id: string; name: string }>).map((a) => ({ id: a.id, name: a.name })),
        );
        setAgentsLoaded(true);
      } catch {
        // The agent filter is a convenience; a failed load just leaves it at
        // "All agents" — the runs list itself still loads independently.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Review finding #3: a deep-linked `#agent=<id>` whose id matches nothing
  // in the loaded agents list (a stale link, a deleted/renamed agent, or a
  // partner-wide agent invisible under this caller's RLS context) desyncs
  // the filter — the dropdown falls back to its first option ("All agents")
  // while `agentFilter` state still holds the unmatched id, so every request
  // keeps sending an `agentId` the UI no longer visibly reflects. Once the
  // agents list has genuinely loaded, drop a filter that matches nothing and
  // clear the hash so the URL doesn't keep re-asserting it.
  useEffect(() => {
    if (!agentsLoaded || !agentFilter) return;
    if (agents.some((agent) => agent.id === agentFilter)) return;
    setAgentFilter('');
    if (window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }, [agentsLoaded, agents, agentFilter]);

  const fetchPage = useCallback(
    async (cursor: string | null, append: boolean) => {
      if (!append) requestIdRef.current += 1;
      const requestId = requestIdRef.current;

      if (append) {
        setLoadingMore(true);
        setLoadMoreError(undefined);
      } else {
        setLoading(true);
        setError(undefined);
        setLoadMoreError(undefined);
      }
      try {
        const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
        if (agentFilter) params.set('agentId', agentFilter);
        if (statusFilter) params.set('status', statusFilter);
        if (cursor) params.set('cursor', cursor);

        const response = await fetchWithAuth(`/ai/agents/runs?${params.toString()}`);
        if (requestId !== requestIdRef.current) return;
        if (!response.ok) {
          const message = t('aiAgentsPage.runs.errors.load', { status: response.status });
          if (append) setLoadMoreError(message);
          else setError(message);
          return;
        }
        const body = (await response.json()) as Partial<RunsResponse>;
        if (requestId !== requestIdRef.current) return;
        if (!Array.isArray(body.data)) {
          // A body we cannot read is an error, not zero runs — same lesson as
          // AiAgentsPage's `?? []` regression.
          const message = t('aiAgentsPage.runs.errors.load', { status: response.status });
          if (append) setLoadMoreError(message);
          else setError(message);
          return;
        }
        const page = body.data;
        setRuns((prev) => (append ? [...prev, ...page] : page));
        setNextCursor(body.nextCursor ?? null);
      } catch (err) {
        if (requestId !== requestIdRef.current) return;
        const message = err instanceof Error ? err.message : t('aiAgentsPage.runs.errors.load', { status: 0 });
        if (append) setLoadMoreError(message);
        else setError(message);
      } finally {
        if (append) {
          setLoadingMore(false);
        } else if (requestId === requestIdRef.current) {
          setLoading(false);
        }
      }
    },
    [agentFilter, statusFilter, currentOrgId, t],
  );

  useEffect(() => {
    if (!deepLinkResolved) return;
    setRuns([]);
    setNextCursor(null);
    void fetchPage(null, false);
  }, [fetchPage, deepLinkResolved]);

  /**
   * Background poll: re-fetches page 1 under the current filters.
   *
   * Known ids are merged in place (never replacing the whole array), so an
   * accumulated "Load more" tail past the first page survives a poll tick.
   * When unfiltered, ids in the response that aren't in `runs` yet are
   * genuinely new runs — those are prepended (review finding P2-1) rather
   * than silently dropped, which is what merge-by-id alone did. If the view
   * hasn't been paginated past page 1 (no "Load more" yet), the result is
   * trimmed back to `PAGE_LIMIT` so the page-1 window mirrors what the
   * server just returned; an already-loaded tail beyond page 1 is left
   * alone. Filtered views skip the prepend — a filtered page 1 isn't
   * necessarily "everything newer", so a naive prepend could misorder rows
   * the filter itself is meant to control.
   *
   * Shares `requestIdRef` with `fetchPage` (review finding P2-2): an
   * overlapping or out-of-order response — including one that resolves
   * after a filter change already kicked off a fresh page-1 load — is
   * detected as stale via the id check and discarded. `mountedRef` guards
   * against setting state after unmount.
   *
   * Best-effort — a failed poll just tries again next tick, without
   * disturbing whatever is already on screen.
   */
  const pollListSilently = useCallback(async () => {
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    try {
      const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
      if (agentFilter) params.set('agentId', agentFilter);
      if (statusFilter) params.set('status', statusFilter);
      const response = await fetchWithAuth(`/ai/agents/runs?${params.toString()}`);
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      if (!response.ok) return;
      const body = (await response.json()) as Partial<RunsResponse>;
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      if (!Array.isArray(body.data)) return;
      const page = body.data;
      const unfiltered = !agentFilter && !statusFilter;
      setRuns((prev) => {
        const byId = new Map(page.map((run) => [run.id, run] as const));
        const merged = prev.map((run) => byId.get(run.id) ?? run);
        if (!unfiltered) return merged;
        const knownIds = new Set(prev.map((run) => run.id));
        const freshRows = page.filter((run) => !knownIds.has(run.id));
        if (freshRows.length === 0) return merged;
        const combined = [...freshRows, ...merged];
        return prev.length > PAGE_LIMIT ? combined : combined.slice(0, PAGE_LIMIT);
      });
    } catch {
      // Best-effort background refresh; keep showing the last good data.
    }
  }, [agentFilter, statusFilter]);

  const hasLiveRun = runs.some((run) => isLiveRunStatus(run.status));

  useEffect(() => {
    // Nothing to poll for: a filtered view with nothing live won't change on
    // its own (review finding P2-1 only asks for the idle cadence on the
    // unfiltered page-1 view — a filtered terminal-only result set is inert).
    if (!hasLiveRun && hasActiveFilter) return undefined;
    const intervalMs = hasLiveRun ? LIST_POLL_INTERVAL_MS : LIST_IDLE_POLL_INTERVAL_MS;
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') void pollListSilently();
    }, intervalMs);
    return () => clearInterval(interval);
  }, [hasLiveRun, hasActiveFilter, pollListSilently]);

  const handleRowNavigate = useCallback((runId: string) => {
    window.location.assign(`/ai-agents/runs/${runId}`);
  }, []);

  return (
    <div className="space-y-6" data-testid="runs-list-page">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <History className="h-5 w-5" />
            {t('aiAgentsPage.runs.title')}
          </h1>
          <p className="text-muted-foreground">{t('aiAgentsPage.runs.description')}</p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <select
            data-testid="runs-list-filter-agent"
            aria-label={t('aiAgentsPage.runs.filters.agent')}
            value={agentFilter}
            onChange={(event) => setAgentFilter(event.target.value)}
            className="rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-primary/20"
          >
            <option value="">{t('aiAgentsPage.runs.filters.allAgents')}</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>

          <select
            data-testid="runs-list-filter-status"
            aria-label={t('aiAgentsPage.runs.filters.status')}
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as AiAgentRunStatus | '')}
            className="rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-primary/20"
          >
            <option value="">{t('aiAgentsPage.runs.filters.allStatuses')}</option>
            {AI_AGENT_RUN_STATUSES.map((value) => (
              <option key={value} value={value}>
                {statusLabel(t, value)}
              </option>
            ))}
          </select>

          {hasActiveFilter && (
            <button
              type="button"
              data-testid="runs-list-clear-filters"
              onClick={clearFilters}
              className="text-sm text-muted-foreground hover:text-foreground hover:underline"
            >
              {t('aiAgentsRuns.list.clearFilters')}
            </button>
          )}

          <button
            type="button"
            data-testid="runs-list-toggle-cost"
            aria-pressed={showCost}
            onClick={toggleShowCost}
            className="rounded-md border px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {showCost ? t('aiAgentsRuns.list.hideCost') : t('aiAgentsRuns.list.showCost')}
          </button>
        </div>
      </div>

      {loading && (
        <p className="text-sm text-muted-foreground" data-testid="runs-list-loading">
          {t('aiAgentsPage.runs.loading')}
        </p>
      )}

      {!loading && error && (
        <div
          data-testid="runs-list-error"
          className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center"
        >
          <p className="text-sm text-destructive">{error}</p>
          <button
            type="button"
            onClick={() => void fetchPage(null, false)}
            className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            {t('aiAgentsPage.runs.retry')}
          </button>
        </div>
      )}

      {!loading && !error && runs.length === 0 && (
        <EmptyState
          size="sm"
          headingLevel={2}
          testId="runs-list-empty"
          icon={<History className="h-5 w-5" />}
          title={hasActiveFilter ? t('aiAgentsPage.runs.emptyFiltered') : t('aiAgentsPage.runs.empty')}
          description={
            hasActiveFilter
              ? t('aiAgentsRuns.list.emptyFilteredDescription')
              : t('aiAgentsRuns.list.emptyDescription')
          }
          action={
            hasActiveFilter ? (
              <button
                type="button"
                onClick={clearFilters}
                className="rounded-md border px-4 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {t('aiAgentsRuns.list.clearFilters')}
              </button>
            ) : undefined
          }
          secondary={
            !hasActiveFilter ? (
              <a href="/settings/ai-agents" className="text-primary hover:underline">
                {t('aiAgentsRuns.list.emptyConfigureLink')}
              </a>
            ) : undefined
          }
        />
      )}

      {!loading && !error && runs.length > 0 && (
        <div className="overflow-hidden rounded-lg border">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y" data-testid="runs-list-table">
              <thead className="bg-muted/40">
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3">{t('aiAgentsPage.runs.columns.agent')}</th>
                  {/* Review finding #2: this column's cell renders `orgName`
                      — the list DTO has no device hostname to "target" — so
                      the header says Organization, reusing the shared
                      vocabulary key rather than a private "Target" label
                      that never matched what the column actually shows. */}
                  <th className="px-4 py-3">{t('common:labels.organization')}</th>
                  <th className="px-4 py-3">{t('aiAgentsPage.runs.columns.status')}</th>
                  <th className="px-4 py-3">{t('aiAgentsPage.runs.columns.trigger')}</th>
                  <th className="px-4 py-3">{t('aiAgentsPage.runs.columns.verdict')}</th>
                  <th className="px-4 py-3">{t('aiAgentsRuns.list.columns.started')}</th>
                  <th className="px-4 py-3">{t('aiAgentsRuns.list.columns.duration')}</th>
                  {showCost && <th className="px-4 py-3">{t('aiAgentsPage.runs.columns.cost')}</th>}
                </tr>
              </thead>
              <tbody className="divide-y">
                {runs.map((run) => {
                  const live = isLiveRunStatus(run.status);
                  return (
                    <tr
                      key={run.id}
                      data-testid={`runs-list-row-${run.id}`}
                      className="cursor-pointer text-sm hover:bg-muted/30"
                      onClick={() => handleRowNavigate(run.id)}
                    >
                      <td className="px-4 py-3 font-medium">
                        <a
                          href={`/ai-agents/runs/${run.id}`}
                          data-testid={`runs-list-row-link-${run.id}`}
                          className="text-primary hover:underline"
                          onClick={(event) => event.stopPropagation()}
                        >
                          {run.agentName ?? t('aiAgentsPage.runs.noAgent')}
                        </a>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{run.orgName ?? '—'}</td>
                      <td className="px-4 py-3">
                        <span
                          className={badgeClass(runStatusTone(run.status), { size: 'sm' })}
                          aria-live={live ? 'polite' : undefined}
                        >
                          {statusLabel(t, run.status)}
                        </span>
                        {live && <LiveIndicator label={t('aiAgentsRuns.live.label')} />}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{triggerLabel(t, run.triggerKind)}</td>
                      <td className="px-4 py-3">
                        <span className={badgeClass(verdictTone(run.runVerdict ?? ''), { size: 'sm' })}>
                          {verdictLabel(t, run.runVerdict)}
                        </span>
                        {run.profile === 'sweep' && (
                          <span
                            data-testid={`ai-agent-run-profile-sweep-${run.id}`}
                            className={`ml-1.5 ${badgeClass('info', { size: 'sm' })}`}
                          >
                            {t('aiAgentsPage.runs.profile.sweep')}
                          </span>
                        )}
                        {/* Phase 2 wave P2-3 (#4190) — a narrative-profile
                            run is the weekly org report, not a device
                            outcome; the badge is what tells the two apart in
                            a mixed list. */}
                        {run.profile === 'narrative' && (
                          <span
                            data-testid={`ai-agent-run-profile-narrative-${run.id}`}
                            className={`ml-1.5 ${badgeClass('accent', { size: 'sm' })}`}
                          >
                            {t('aiAgentsPage.runs.profile.narrative')}
                          </span>
                        )}
                        {/* Phase 2 wave P2-4 (#4191, Task 12) — a triage-profile
                            run is a ticket outcome, not a device incident; same
                            "tell the two apart in a mixed list" rationale as
                            the sweep/narrative badges above. */}
                        {run.profile === 'triage' && (
                          <span
                            data-testid={`ai-agent-run-profile-triage-${run.id}`}
                            className={`ml-1.5 ${badgeClass('muted', { size: 'sm' })}`}
                          >
                            {t('aiAgentsPage.runs.profile.triage')}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                        <StartedCell queuedAt={run.queuedAt} />
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                        {formatRunDuration(run.queuedAt, run.finishedAt)}
                      </td>
                      {showCost && (
                        <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                          {formatCurrency(run.costCents / 100)}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!loading && !error && nextCursor && (
        <div className="flex flex-col items-center gap-2">
          {loadMoreError && (
            <p data-testid="runs-list-load-more-error" className="text-sm text-destructive">
              {loadMoreError}
            </p>
          )}
          <button
            type="button"
            data-testid="runs-list-load-more"
            onClick={() => void fetchPage(nextCursor, true)}
            disabled={loadingMore}
            className="rounded-md border px-4 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('aiAgentsPage.runs.loadMore')}
          </button>
        </div>
      )}
    </div>
  );
}
