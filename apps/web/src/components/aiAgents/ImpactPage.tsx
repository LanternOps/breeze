import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { RefreshCw, TrendingUp } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { showToast } from '../shared/Toast';
import { ActionError, runAction } from '@/lib/runAction';
import { useHashState } from '@/lib/useHashState';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/i18n/format';
import { formatDateTime } from '@/lib/dateTimeFormat';
import {
  AI_AGENT_IMPACT_BY_ORG_LIMIT,
  AI_AGENT_IMPACT_REBUILD_MAX_ORGS,
  AI_AGENT_IMPACT_WINDOWS,
  DEFAULT_IMPACT_WEIGHTS,
  IMPACT_WEIGHT_KEYS,
} from '@breeze/shared';
import type {
  AiAgentImpactBucketDto,
  AiAgentImpactDto,
  AiAgentImpactWindow,
  ImpactWeights,
} from '@breeze/shared';

const DEFAULT_WINDOW: AiAgentImpactWindow = 30;
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 120_000;

/** Leading `#` already stripped by useHashState, so this is SSR-safe. */
export function windowFromHash(hash: string): AiAgentImpactWindow | undefined {
  const parsed = Number(hash);
  return (AI_AGENT_IMPACT_WINDOWS as readonly number[]).includes(parsed)
    ? (parsed as AiAgentImpactWindow)
    : undefined;
}

export interface ImpactChartRow {
  day: string;
  noiseFlagged: number;
  alertsJudgedNet: number;
  ticketsTriaged: number;
  fixesExecuted: number;
}

/**
 * The stacked bar's series must be DISJOINT. `noiseFlagged` is a SUBSET of
 * `alertsJudged` (a noise verdict is still a judged alert), so stacking the two
 * raw counters would draw every noise verdict twice and inflate the bar the MSP
 * shows its customer. The non-noise arm is therefore the difference, clamped at
 * zero: the two counters come from different source tables and a late-arriving
 * suppression can leave noise momentarily ahead of judged.
 */
export function buildImpactChartRows(series: AiAgentImpactBucketDto[]): ImpactChartRow[] {
  return series.map((bucket) => ({
    day: bucket.day,
    noiseFlagged: bucket.noiseFlagged,
    alertsJudgedNet: Math.max(0, bucket.alertsJudged - bucket.noiseFlagged),
    ticketsTriaged: bucket.ticketsTriaged,
    fixesExecuted: bucket.fixesExecuted,
  }));
}

/** True when `next` is a strictly later rebuild stamp than `baseline`. */
function hasRebuildAdvanced(next: string | null, baseline: string | null): boolean {
  if (next === null) return false;
  const nextMs = Date.parse(next);
  if (!Number.isFinite(nextMs)) return false;
  if (baseline === null) return true;
  const baselineMs = Date.parse(baseline);
  return !Number.isFinite(baselineMs) || nextMs > baselineMs;
}

// Literal-key label lookups (not dynamic t()) so the keyUsage guard can verify
// every label statically — same idiom as RunsListPage's statusLabel.
function windowLabel(t: (key: string) => string, value: AiAgentImpactWindow): string {
  switch (value) {
    case 7:
      return t('aiAgentsPage.impact.windows.d7');
    case 30:
      return t('aiAgentsPage.impact.windows.d30');
    case 90:
      return t('aiAgentsPage.impact.windows.d90');
    default:
      return String(value);
  }
}

function weightLabel(t: (key: string) => string, key: (typeof IMPACT_WEIGHT_KEYS)[number]): string {
  switch (key) {
    case 'alertJudged':
      return t('aiAgentsPage.impact.weightLabels.alertJudged');
    case 'noiseFlagged':
      return t('aiAgentsPage.impact.weightLabels.noiseFlagged');
    case 'ticketTriaged':
      return t('aiAgentsPage.impact.weightLabels.ticketTriaged');
    case 'draftSent':
      return t('aiAgentsPage.impact.weightLabels.draftSent');
    case 'fixExecuted':
      return t('aiAgentsPage.impact.weightLabels.fixExecuted');
    case 'narrativeDelivered':
      return t('aiAgentsPage.impact.weightLabels.narrativeDelivered');
    default:
      return key;
  }
}

function Tile({
  testId,
  label,
  value,
  title,
}: {
  testId: string;
  label: string;
  value: string;
  title?: string;
}) {
  return (
    <div data-testid={testId} title={title} className="rounded-lg border bg-card p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

/**
 * Phase 2 wave P2-6 (#4193) — the AI operations impact page: `GET
 * /ai/agents/impact`, a 7/30/90-day estimated-time-saved dashboard over
 * `ai_agent_impact_daily`.
 *
 * Everything on this page except LLM spend is a DERIVED estimate, so the copy
 * says "Estimated time saved" and the actual spend tile sits immediately beside
 * it — the honest pairing the plan requires. The verdict readout is a "positive
 * feedback rate", never "precision" or "accuracy": a thumbs-up is a supervision
 * signal, not ground truth.
 *
 * The window lives in `window.location.hash` (the repo's rule for transient UI
 * state), so a 90-day view survives a reload and is shareable.
 */
export default function ImpactPage() {
  const { t } = useTranslation('settings');
  // Honour the global Current/All-organizations toggle: fetchWithAuth injects
  // `?orgId=` whenever one org is selected, so a scope change must refetch or
  // the page keeps showing the previous scope's totals (same as RunsListPage).
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const [windowDays, setWindowDays] = useHashState<AiAgentImpactWindow>(
    DEFAULT_WINDOW,
    windowFromHash,
  );
  const [dto, setDto] = useState<AiAgentImpactDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [reloadToken, setReloadToken] = useState(0);
  // Non-null while a manual rebuild is being waited on. `rebuiltAt` is the
  // freshness stamp captured BEFORE the POST, so the poll can tell a finished
  // rebuild from the pre-existing rollup.
  const [poll, setPoll] = useState<{ startedAt: number; rebuiltAt: string | null } | null>(null);

  const requestImpact = useCallback(async (): Promise<AiAgentImpactDto> => {
    const response = await fetchWithAuth(`/api/ai/agents/impact?window=${windowDays}`);
    if (!response.ok) throw new Error(`impact_load_failed_${response.status}`);
    const body = (await response.json()) as { data?: AiAgentImpactDto } | null;
    // A body we cannot read is an error, not an all-zero fleet — the same
    // lesson as AiAgentsPage's `?? []` regression.
    if (!body || typeof body !== 'object' || !body.data) throw new Error('impact_load_malformed');
    return body.data;
    // `currentOrgId` is not read here on purpose: fetchWithAuth injects it into
    // the URL itself, so it must still invalidate this callback or the page
    // keeps the previous scope's totals after an org switch.
  }, [windowDays, currentOrgId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    void (async () => {
      try {
        const fresh = await requestImpact();
        if (cancelled) return;
        setDto(fresh);
      } catch {
        if (cancelled) return;
        setError(t('aiAgentsPage.impact.errors.load'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [requestImpact, reloadToken, t]);

  // Rebuild poll. The interval is owned by this effect so React clears it on
  // unmount (and whenever the window changes, which re-creates requestImpact).
  useEffect(() => {
    if (!poll) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const fresh = await requestImpact();
          if (cancelled) return;
          setDto(fresh);
          if (hasRebuildAdvanced(fresh.rebuiltAt, poll.rebuiltAt)) {
            setPoll(null);
            showToast({ message: t('aiAgentsPage.impact.toasts.rebuildComplete'), type: 'success' });
            return;
          }
        } catch {
          // A transient read failure is not a failed rebuild — keep polling
          // until the deadline below decides.
        }
        if (cancelled) return;
        if (Date.now() - poll.startedAt >= POLL_TIMEOUT_MS) {
          setPoll(null);
          showToast({
            message: t('aiAgentsPage.impact.toasts.rebuildStillRunning'),
            type: 'warning',
          });
        }
      })();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [poll, requestImpact, t]);

  const handleRefresh = useCallback(async () => {
    const baselineRebuiltAt = dto?.rebuiltAt ?? null;
    try {
      await runAction({
        request: () => fetchWithAuth('/api/ai/agents/impact/rebuild', { method: 'POST' }),
        errorFallback: t('aiAgentsPage.impact.errors.rebuild'),
        successMessage: t('aiAgentsPage.impact.toasts.rebuildQueued'),
        // The rebuild route refuses with a BARE machine token and no `code`
        // (`too_many_orgs` 409 above AI_AGENT_IMPACT_REBUILD_MAX_ORGS accessible
        // orgs, `org_id_required` 400 for a system-scoped caller), and
        // runAction's fallback chain toasts `body.error` verbatim. Without this
        // mapper the partner with the biggest fleet — exactly the customer this
        // page is for — reads "too_many_orgs" as their error message.
        friendly: (key) => {
          if (key === 'too_many_orgs') {
            return t('aiAgentsPage.impact.errors.tooManyOrgs', {
              limit: AI_AGENT_IMPACT_REBUILD_MAX_ORGS,
            });
          }
          if (key === 'org_id_required') {
            return t('aiAgentsPage.impact.errors.orgIdRequired');
          }
          return undefined;
        },
      });
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({ message: t('aiAgentsPage.impact.errors.rebuild'), type: 'error' });
      }
      return;
    }
    setPoll({ startedAt: Date.now(), rebuiltAt: baselineRebuiltAt });
  }, [dto?.rebuiltAt, t]);

  const weights: ImpactWeights = dto?.weights.effective ?? DEFAULT_IMPACT_WEIGHTS;
  const weightsTooltip = useMemo(
    () =>
      [
        t('aiAgentsPage.impact.weightsTooltipTitle'),
        ...IMPACT_WEIGHT_KEYS.map((key) =>
          t('aiAgentsPage.impact.weightsTooltipLine', {
            label: weightLabel(t, key),
            minutes: formatNumber(weights[key] / 60, { maximumFractionDigits: 1 }),
          }),
        ),
      ].join('\n'),
    [t, weights],
  );

  const chartRows = useMemo(() => buildImpactChartRows(dto?.series ?? []), [dto?.series]);

  return (
    <div className="space-y-6" data-testid="ai-impact-page">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <TrendingUp className="h-5 w-5" />
            {t('aiAgentsPage.impact.title')}
          </h1>
          <p className="text-muted-foreground">{t('aiAgentsPage.impact.description')}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            className="flex items-center gap-1 rounded-md border p-1"
            role="group"
            aria-label={t('aiAgentsPage.impact.windowLabel')}
          >
            {AI_AGENT_IMPACT_WINDOWS.map((value) => (
              <button
                key={value}
                type="button"
                data-testid={`ai-impact-window-${value}`}
                aria-pressed={value === windowDays}
                onClick={() => {
                  setWindowDays(value);
                  window.location.hash = String(value);
                }}
                className={`rounded px-3 py-1 text-sm ${
                  value === windowDays
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                {windowLabel(t, value)}
              </button>
            ))}
          </div>

          <button
            type="button"
            data-testid="ai-impact-refresh"
            onClick={() => void handleRefresh()}
            disabled={poll !== null}
            className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${poll ? 'animate-spin' : ''}`} />
            {poll ? t('aiAgentsPage.impact.refreshing') : t('aiAgentsPage.impact.refresh')}
          </button>
        </div>
      </div>

      {loading && (
        <p className="text-sm text-muted-foreground" data-testid="ai-impact-loading">
          {t('aiAgentsPage.impact.loading')}
        </p>
      )}

      {!loading && error && (
        <div
          data-testid="ai-impact-error"
          className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center"
        >
          <p className="text-sm text-destructive">{error}</p>
          <button
            type="button"
            data-testid="ai-impact-retry"
            onClick={() => setReloadToken((token) => token + 1)}
            className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            {t('aiAgentsPage.impact.retry')}
          </button>
        </div>
      )}

      {!loading && !error && dto && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-7">
            <Tile
              testId="ai-impact-tile-alerts-judged"
              label={t('aiAgentsPage.impact.tiles.alertsJudged')}
              value={formatNumber(dto.totals.alertsJudged)}
            />
            <Tile
              testId="ai-impact-tile-noise-flagged"
              label={t('aiAgentsPage.impact.tiles.noiseFlagged')}
              value={formatNumber(dto.totals.noiseFlagged)}
            />
            <Tile
              testId="ai-impact-tile-tickets-triaged"
              label={t('aiAgentsPage.impact.tiles.ticketsTriaged')}
              value={formatNumber(dto.totals.ticketsTriaged)}
            />
            <Tile
              testId="ai-impact-tile-drafts-sent"
              label={t('aiAgentsPage.impact.tiles.draftsSent')}
              value={formatNumber(dto.totals.draftsSent)}
            />
            <Tile
              testId="ai-impact-tile-fixes-executed"
              label={t('aiAgentsPage.impact.tiles.fixesExecuted')}
              value={formatNumber(dto.totals.fixesExecuted)}
            />
            {/* The estimate and the one actually-measured number on this page
                sit side by side, deliberately — see the plan's honest-labelling
                rule. */}
            <Tile
              testId="ai-impact-tile-est-seconds-saved"
              label={t('aiAgentsPage.impact.tiles.estTimeSaved')}
              value={t('aiAgentsPage.impact.tiles.estTimeSavedValue', {
                hours: formatNumber(dto.totals.estSecondsSaved / 3600, {
                  maximumFractionDigits: 1,
                }),
              })}
              title={weightsTooltip}
            />
            <Tile
              testId="ai-impact-tile-llm-cents"
              label={t('aiAgentsPage.impact.tiles.llmSpend')}
              value={formatCurrency(dto.totals.llmCents / 100)}
            />
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
            <p data-testid="ai-impact-freshness">
              {dto.rebuiltAt
                ? t('aiAgentsPage.impact.freshness', {
                    through: dto.through,
                    rebuiltAt: formatDateTime(dto.rebuiltAt),
                  })
                : t('aiAgentsPage.impact.freshnessNeverRebuilt', { through: dto.through })}
            </p>
            {dto.positiveFeedback.rate !== null && (
              <p data-testid="ai-impact-positive-feedback">
                <span className="font-medium text-foreground">
                  {t('aiAgentsPage.impact.positiveFeedbackRate')}
                </span>{' '}
                {formatPercent(dto.positiveFeedback.rate)}{' '}
                {t('aiAgentsPage.impact.positiveFeedbackDetail', {
                  up: dto.positiveFeedback.up,
                  down: dto.positiveFeedback.down,
                })}
              </p>
            )}
          </div>

          <div className="rounded-lg border p-4">
            <h2 className="mb-3 text-sm font-semibold">{t('aiAgentsPage.impact.chart.title')}</h2>
            {chartRows.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="ai-impact-chart-empty">
                {t('aiAgentsPage.impact.chart.empty')}
              </p>
            ) : (
              <div className="h-72" data-testid="ai-impact-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartRows}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <Tooltip />
                    <Legend />
                    <Bar
                      stackId="outcomes"
                      dataKey="noiseFlagged"
                      name={t('aiAgentsPage.impact.chart.noiseFlagged')}
                      fill="#f59e0b"
                    />
                    <Bar
                      stackId="outcomes"
                      dataKey="alertsJudgedNet"
                      name={t('aiAgentsPage.impact.chart.alertsJudgedNet')}
                      fill="#3b82f6"
                    />
                    <Bar
                      stackId="outcomes"
                      dataKey="ticketsTriaged"
                      name={t('aiAgentsPage.impact.chart.ticketsTriaged')}
                      fill="#14b8a6"
                    />
                    <Bar
                      stackId="outcomes"
                      dataKey="fixesExecuted"
                      name={t('aiAgentsPage.impact.chart.fixesExecuted')}
                      fill="#8b5cf6"
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {dto.byOrg.length > 0 && (
            <div className="overflow-hidden rounded-lg border" data-testid="ai-impact-by-org">
              <h2 className="border-b bg-muted/40 px-4 py-3 text-sm font-semibold">
                {t('aiAgentsPage.impact.byOrg.title')}
              </h2>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y">
                  <thead className="bg-muted/20">
                    <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-3">
                        {t('aiAgentsPage.impact.byOrg.columns.organization')}
                      </th>
                      <th className="px-4 py-3">
                        {t('aiAgentsPage.impact.byOrg.columns.alertsJudged')}
                      </th>
                      <th className="px-4 py-3">
                        {t('aiAgentsPage.impact.byOrg.columns.ticketsTriaged')}
                      </th>
                      <th className="px-4 py-3">
                        {t('aiAgentsPage.impact.byOrg.columns.fixesExecuted')}
                      </th>
                      <th className="px-4 py-3">
                        {t('aiAgentsPage.impact.byOrg.columns.estTimeSaved')}
                      </th>
                      <th className="px-4 py-3">
                        {t('aiAgentsPage.impact.byOrg.columns.llmSpend')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {dto.byOrg.map((row) => (
                      <tr
                        key={row.orgId}
                        data-testid={`ai-impact-by-org-row-${row.orgId}`}
                        className="text-sm"
                      >
                        <td className="px-4 py-3 font-medium">{row.orgName}</td>
                        <td className="px-4 py-3 tabular-nums">{formatNumber(row.alertsJudged)}</td>
                        <td className="px-4 py-3 tabular-nums">
                          {formatNumber(row.ticketsTriaged)}
                        </td>
                        <td className="px-4 py-3 tabular-nums">
                          {formatNumber(row.fixesExecuted)}
                        </td>
                        <td className="px-4 py-3 tabular-nums">
                          {t('aiAgentsPage.impact.tiles.estTimeSavedValue', {
                            hours: formatNumber(row.estSecondsSaved / 3600, {
                              maximumFractionDigits: 1,
                            }),
                          })}
                        </td>
                        <td className="px-4 py-3 tabular-nums">
                          {formatCurrency(row.llmCents / 100)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {dto.byOrgTruncated && (
                <p
                  data-testid="ai-impact-by-org-truncated"
                  className="border-t px-4 py-3 text-xs text-muted-foreground"
                >
                  {t('aiAgentsPage.impact.byOrg.truncated', {
                    limit: AI_AGENT_IMPACT_BY_ORG_LIMIT,
                  })}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
