import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { History } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { formatCurrency } from '@/lib/i18n/format';
import type { AiAgentRunListItemDto, AiAgentRunStatus } from '@breeze/shared';
import { AI_AGENT_RUN_STATUSES } from '@breeze/shared';

interface RunsResponse {
  data: AiAgentRunListItemDto[];
  nextCursor: string | null;
}

interface AgentOption {
  id: string;
  name: string;
}

const PAGE_LIMIT = 25;

function verdictBadgeClass(verdict: string | null): string {
  switch (verdict) {
    case 'remediated':
      return 'bg-emerald-500/10 text-emerald-600';
    case 'partial':
      return 'bg-amber-500/10 text-amber-700';
    case 'needs_attention':
      return 'bg-red-500/10 text-red-600';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

function statusBadgeClass(status: AiAgentRunStatus): string {
  switch (status) {
    case 'completed':
      return 'bg-emerald-500/10 text-emerald-600';
    case 'failed':
      return 'bg-red-500/10 text-red-600';
    case 'running':
      return 'bg-blue-500/10 text-blue-600';
    case 'awaiting_approval':
      return 'bg-amber-500/10 text-amber-700';
    default:
      return 'bg-muted text-muted-foreground';
  }
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
 */
export default function RunsListPage() {
  const { t } = useTranslation('settings');
  // Honor the global Current/All-orgs scope toggle, same as AlertsPage:
  // `fetchWithAuth` auto-injects `?orgId=<currentOrgId>` whenever one org is
  // selected, so a scope change must trigger a refetch or the list keeps
  // showing the previous scope's rows.
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const allOrgs = useOrgStore((s) => s.allOrgs);
  // Fleet (All-organizations) view — show an Organization column so cross-org
  // rows stay legible (mirrors AlertsPage/AlertList's showOrgColumn).
  const isFleetView = !currentOrgId && allOrgs;
  const [runs, setRuns] = useState<AiAgentRunListItemDto[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const [loadMoreError, setLoadMoreError] = useState<string>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  const [agentFilter, setAgentFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<AiAgentRunStatus | ''>('');

  // Monotonic request id — same stale-response guard as DeviceChangeHistoryTab:
  // a fresh page-1 load (filter change) bumps it so a late "Load more" response
  // can detect it's stale and bail before clobbering the new filter's rows.
  const requestIdRef = useRef(0);

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
      } catch {
        // The agent filter is a convenience; a failed load just leaves it at
        // "All agents" — the runs list itself still loads independently.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
    setRuns([]);
    setNextCursor(null);
    void fetchPage(null, false);
  }, [fetchPage]);

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
        <p className="text-sm text-muted-foreground" data-testid="runs-list-empty">
          {agentFilter || statusFilter
            ? t('aiAgentsPage.runs.emptyFiltered')
            : t('aiAgentsPage.runs.empty')}
        </p>
      )}

      {!loading && !error && runs.length > 0 && (
        <div className="overflow-hidden rounded-lg border">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y" data-testid="runs-list-table">
              <thead className="bg-muted/40">
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3">{t('aiAgentsPage.runs.columns.agent')}</th>
                  {isFleetView && <th className="px-4 py-3">{t('common:labels.organization')}</th>}
                  <th className="px-4 py-3">{t('aiAgentsPage.runs.columns.status')}</th>
                  <th className="px-4 py-3">{t('aiAgentsPage.runs.columns.trigger')}</th>
                  <th className="px-4 py-3">{t('aiAgentsPage.runs.columns.verdict')}</th>
                  <th className="px-4 py-3">{t('aiAgentsPage.runs.columns.queued')}</th>
                  <th className="px-4 py-3">{t('aiAgentsPage.runs.columns.finished')}</th>
                  <th className="px-4 py-3">{t('aiAgentsPage.runs.columns.cost')}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {runs.map((run) => (
                  <tr key={run.id} data-testid={`runs-list-row-${run.id}`} className="text-sm hover:bg-muted/30">
                    <td className="px-4 py-3 font-medium">
                      <a
                        href={`/ai-agents/runs/${run.id}`}
                        data-testid={`runs-list-row-link-${run.id}`}
                        className="text-primary hover:underline"
                      >
                        {run.agentName ?? t('aiAgentsPage.runs.noAgent')}
                      </a>
                    </td>
                    {isFleetView && (
                      <td className="px-4 py-3 text-muted-foreground">{run.orgName ?? '—'}</td>
                    )}
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${statusBadgeClass(run.status)}`}
                      >
                        {statusLabel(t, run.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{triggerLabel(t, run.triggerKind)}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${verdictBadgeClass(run.runVerdict)}`}
                      >
                        {verdictLabel(t, run.runVerdict)}
                      </span>
                      {run.profile === 'sweep' && (
                        <span
                          data-testid={`ai-agent-run-profile-sweep-${run.id}`}
                          className="ml-1.5 inline-flex rounded bg-sky-500/10 px-1.5 py-0.5 text-xs font-medium text-sky-700"
                        >
                          {t('aiAgentsPage.runs.profile.sweep')}
                        </span>
                      )}
                      {/* Phase 2 wave P2-3 (#4190) — a narrative-profile run
                          is the weekly org report, not a device outcome; the
                          badge is what tells the two apart in a mixed list. */}
                      {run.profile === 'narrative' && (
                        <span
                          data-testid={`ai-agent-run-profile-narrative-${run.id}`}
                          className="ml-1.5 inline-flex rounded bg-violet-500/10 px-1.5 py-0.5 text-xs font-medium text-violet-700"
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
                          className="ml-1.5 inline-flex rounded bg-teal-500/10 px-1.5 py-0.5 text-xs font-medium text-teal-700"
                        >
                          {t('aiAgentsPage.runs.profile.triage')}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                      {formatDateTime(run.queuedAt)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                      {run.finishedAt ? formatDateTime(run.finishedAt) : '—'}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                      {formatCurrency(run.costCents / 100)}
                    </td>
                  </tr>
                ))}
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
