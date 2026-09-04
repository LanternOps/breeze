import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import {
  ChevronRight,
  Download,
  MoreHorizontal,
  RefreshCw,
  Settings2,
  TrendingUp,
} from 'lucide-react';
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
import { exportReport } from '../reports/reportExport';
import { EmptyState } from '../shared/EmptyState';
import { PageHeader } from '../shared/PageHeader';
import ImpactWeightsDrawer from './ImpactWeightsDrawer';
import {
  AI_AGENT_IMPACT_BY_ORG_LIMIT,
  AI_AGENT_IMPACT_COUNTER_KEYS,
  AI_AGENT_IMPACT_REBUILD_MAX_ORGS,
  AI_AGENT_IMPACT_WINDOWS,
  DEFAULT_IMPACT_WEIGHTS,
  IMPACT_WEIGHT_KEYS,
} from '@breeze/shared';
import type {
  AiAgentImpactBucketDto,
  AiAgentImpactCounterKey,
  AiAgentImpactCounters,
  AiAgentImpactDto,
  AiAgentImpactWindow,
  ImpactWeights,
} from '@breeze/shared';

const DEFAULT_WINDOW: AiAgentImpactWindow = 30;
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 120_000;

// Fallback counters for the (momentary, pre-load) window where the weights
// drawer's props are wired before `dto` has ever resolved — the drawer only
// actually OPENS once the Edit-weights button exists, which itself requires
// `dto`, but the prop must still be a real, typed value at every render.
const ZERO_IMPACT_COUNTERS: AiAgentImpactCounters = Object.fromEntries(
  AI_AGENT_IMPACT_COUNTER_KEYS.map((key) => [key, 0]),
) as AiAgentImpactCounters;

/**
 * Scoped light/dark chart-fill custom properties for the outcomes bar chart.
 * No global `--chart-*` categorical palette exists yet in globals.css (only
 * `--chart-neutral`, for the unrelated "inactive segment" meter convention),
 * so these are defined here rather than invented as a new global contract.
 * Hues are chosen distinctly from the app's status semantics (destructive
 * ~4deg, warning ~36deg, success ~152deg, info ~205deg, primary ~225deg) —
 * "noise flagged" in particular must never land on amber/warning, since
 * amber means warning everywhere else in the product.
 */
const AI_IMPACT_CHART_FILL_CSS = `
  .ai-impact-chart-fills {
    --ai-impact-chart-noise: 265 55% 50%;
    --ai-impact-chart-judged: 300 48% 46%;
    --ai-impact-chart-tickets: 330 55% 48%;
    --ai-impact-chart-fixes: 92 40% 34%;
  }
  .dark .ai-impact-chart-fills {
    --ai-impact-chart-noise: 265 65% 72%;
    --ai-impact-chart-judged: 300 60% 70%;
    --ai-impact-chart-tickets: 330 65% 72%;
    --ai-impact-chart-fixes: 92 45% 58%;
  }
`;

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

// Same literal-key idiom as windowLabel/weightLabel above — the PDF export
// covers all ten counters (six have no tile on this page, e.g.
// suppressionsApplied), so it needs its own complete label set.
function counterMetricLabel(t: (key: string) => string, key: AiAgentImpactCounterKey): string {
  switch (key) {
    case 'alertsJudged':
      return t('aiAgentsPage.impact.pdf.metrics.alertsJudged');
    case 'noiseFlagged':
      return t('aiAgentsPage.impact.pdf.metrics.noiseFlagged');
    case 'suppressionsApplied':
      return t('aiAgentsPage.impact.pdf.metrics.suppressionsApplied');
    case 'ticketsTriaged':
      return t('aiAgentsPage.impact.pdf.metrics.ticketsTriaged');
    case 'draftsSent':
      return t('aiAgentsPage.impact.pdf.metrics.draftsSent');
    case 'fixesProposed':
      return t('aiAgentsPage.impact.pdf.metrics.fixesProposed');
    case 'fixesExecuted':
      return t('aiAgentsPage.impact.pdf.metrics.fixesExecuted');
    case 'fixWatchesHeld':
      return t('aiAgentsPage.impact.pdf.metrics.fixWatchesHeld');
    case 'fixWatchesRecurred':
      return t('aiAgentsPage.impact.pdf.metrics.fixWatchesRecurred');
    case 'narrativesDelivered':
      return t('aiAgentsPage.impact.pdf.metrics.narrativesDelivered');
    default:
      return key;
  }
}

/**
 * `estTimeSavedValue` needs BOTH a display string and a `count` for
 * i18next's `_one`/`_other` plural family ("1 hour" vs "1.5 hours") — passing
 * only the formatted string left "1 hours" hard-coded regardless of value.
 * Used by all four call sites of this key (the main tile, the by-org table,
 * the PDF export, and — separately, in ImpactWeightsDrawer.tsx — the live
 * re-pricing preview).
 */
function estTimeSavedLabel(
  t: (key: string, opts?: Record<string, unknown>) => string,
  seconds: number,
): string {
  const hours = seconds / 3600;
  return t('aiAgentsPage.impact.tiles.estTimeSavedValue', {
    hours: formatNumber(hours, { maximumFractionDigits: 1 }),
    count: hours,
  });
}

/**
 * Uniform `{ metric, value }` rows for the PDF export — MANDATORY shape, not
 * a style choice: `renderGenericReport` derives its columns solely from
 * `Object.keys(rows[0])`, so a heterogeneous "summary header row" would
 * silently truncate every later row's extra fields
 * (`packages/shared/src/reportPdf/reportPdf.ts:1405`).
 *
 * One row per counter (all ten, not just the seven with a tile), then the
 * estimate, the one actually-measured number (LLM spend), the window,
 * `through`, `rebuiltAt`, and each of the six effective weights that
 * produced the estimate — so the PDF is reproducible evidence of how the
 * number was computed, not just the number itself.
 */
export function buildImpactPdfRows(
  dto: AiAgentImpactDto,
  t: (key: string, opts?: Record<string, unknown>) => string,
): Array<{ metric: string; value: string }> {
  const rows: Array<{ metric: string; value: string }> = [];

  for (const key of AI_AGENT_IMPACT_COUNTER_KEYS) {
    rows.push({ metric: counterMetricLabel(t, key), value: formatNumber(dto.totals[key]) });
  }

  rows.push({
    metric: t('aiAgentsPage.impact.pdf.metrics.estTimeSaved'),
    value: estTimeSavedLabel(t, dto.totals.estSecondsSaved),
  });
  rows.push({
    metric: t('aiAgentsPage.impact.pdf.metrics.llmSpend'),
    value: formatCurrency(dto.totals.llmCents / 100),
  });
  rows.push({ metric: t('aiAgentsPage.impact.pdf.metrics.window'), value: String(dto.window) });
  rows.push({ metric: t('aiAgentsPage.impact.pdf.metrics.through'), value: dto.through });
  rows.push({
    metric: t('aiAgentsPage.impact.pdf.metrics.rebuiltAt'),
    // Pinned to UTC — the PDF as a whole is a UTC document (every bucket is a
    // UTC day, and `generatedAt` in reportExport.ts is stamped `timezone:
    // 'UTC'`), so this cell must not silently switch to the exporting
    // browser's local zone.
    value: dto.rebuiltAt
      ? formatDateTime(dto.rebuiltAt, { timeZone: 'UTC' })
      : t('aiAgentsPage.impact.pdf.neverRebuilt'),
  });

  for (const key of IMPACT_WEIGHT_KEYS) {
    rows.push({
      metric: t('aiAgentsPage.impact.pdf.weightRowLabel', { label: weightLabel(t, key) }),
      // Minutes — the one unit the editor, the disclosure, and this PDF all
      // now speak; the wire value stays seconds (`dto.weights.effective`).
      // maximumFractionDigits: 2, matching the editor's own round-trip
      // precision (`secondsToMinutes` rounds to a hundredth of a minute) —
      // at 1 digit this PDF silently disagreed with what the drawer showed
      // and what was actually saved (e.g. 90s = 1.5min rendered "1.5" fine,
      // but a value like 95s = 1.5833...min rounded to "1.6" here while the
      // drawer's own round-trip kept 1.58).
      value: formatNumber(dto.weights.effective[key] / 60, { maximumFractionDigits: 2 }),
    });
  }

  return rows;
}

function Tile({
  testId,
  label,
  value,
  caption,
  disclosure,
  href,
}: {
  testId: string;
  label: string;
  value: string;
  /** Visible one-line explainer, replacing a `title=`-only tooltip. */
  caption?: string;
  /** Extra accessible content rendered below the caption (e.g. a weights disclosure). */
  disclosure?: ReactNode;
  href?: string;
}) {
  const body = (
    <>
      <p className="min-h-[2rem] text-xs font-medium uppercase leading-tight tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {caption && <p className="mt-1 text-xs text-muted-foreground">{caption}</p>}
      {disclosure}
    </>
  );
  if (href) {
    return (
      <a
        data-testid={testId}
        href={href}
        className="group flex items-start justify-between gap-2 rounded-lg border bg-card p-4 transition-colors hover:bg-accent hover:ring-1 hover:ring-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="min-w-0 flex-1">{body}</div>
        <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </a>
    );
  }
  return (
    <div data-testid={testId} className="rounded-lg border bg-card p-4">
      {body}
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

  // Kept in sync with `dto` (effect below) so `handleRefresh` can read the
  // FRESHEST known rebuiltAt right after the trigger POST resolves, instead
  // of a snapshot closed over BEFORE the await. A pre-await read risks being
  // stale — if `dto` updates from some other cause while our POST is still
  // in flight, that update predates OUR rebuild, so using it as the baseline
  // would let the very first poll tick see it as an "advance" and falsely
  // announce that OUR rebuild finished.
  const dtoRebuiltAtRef = useRef<string | null>(null);
  useEffect(() => {
    dtoRebuiltAtRef.current = dto?.rebuiltAt ?? null;
  }, [dto]);

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
    // Baseline captured AFTER the trigger resolved — see dtoRebuiltAtRef's
    // comment above.
    setPoll({ startedAt: Date.now(), rebuiltAt: dtoRebuiltAtRef.current });
  }, [t]);

  // The mobile overflow `<details>` menu (~line 578) has no native
  // "close on selection" behavior — left alone it stays open, floating over
  // whatever the selected action changed underneath it. `open = false`
  // (rather than removeAttribute, which is equivalent but less explicit)
  // closes it exactly like clicking the summary again would.
  const overflowMenuRef = useRef<HTMLDetailsElement>(null);
  const closeOverflowMenu = useCallback(() => {
    if (overflowMenuRef.current) overflowMenuRef.current.open = false;
  }, []);

  const [weightsDrawerOpen, setWeightsDrawerOpen] = useState(false);

  // The drawer re-prices the estimate with no rollup re-run, so on a
  // successful save/reset the page just needs the fresh DTO (same
  // reloadToken mechanism the error-state Retry button uses) — not a
  // rebuild.
  const handleWeightsSaved = useCallback(() => {
    setWeightsDrawerOpen(false);
    setReloadToken((token) => token + 1);
  }, []);

  const handleExportPdf = useCallback(async () => {
    if (!dto) return;
    try {
      await exportReport(buildImpactPdfRows(dto, t), {
        format: 'pdf',
        reportType: 'ai_agent_impact',
        // Pinned to UTC, not the browser's zone — every bucket in this report
        // is a UTC day (see the plan's UTC-everywhere rule).
        timezone: 'UTC',
      });
    } catch {
      showToast({ message: t('aiAgentsPage.impact.errors.exportPdf'), type: 'error' });
    }
  }, [dto, t]);

  const weights: ImpactWeights = dto?.weights.effective ?? DEFAULT_IMPACT_WEIGHTS;

  const chartRows = useMemo(() => buildImpactChartRows(dto?.series ?? []), [dto?.series]);
  // Gates the tile groups AND the page-level EmptyState: true whenever the
  // DTO carries evidence of ANY activity in the window, across every counter
  // (not just the four the bar chart stacks) plus the two derived/measured
  // numbers beside it. A drafts-only or narrative-only agent must not hide
  // non-zero Drafts sent / Estimated time saved / LLM spend behind "no
  // impact yet" just because none of its outcomes happen to be chart series.
  const hasAnyOutcome = useMemo(() => {
    if (!dto) return false;
    const totals = dto.totals;
    return (
      AI_AGENT_IMPACT_COUNTER_KEYS.some((key) => totals[key] > 0) ||
      totals.estSecondsSaved > 0 ||
      totals.llmCents > 0
    );
  }, [dto]);
  // A 30-day window always returns 30 buckets, even when every counter in
  // every bucket is zero — `chartRows.length` is never 0 in practice, so it
  // cannot gate the chart's own empty message. This sums the four DISJOINT
  // series fields actually drawn on the chart (real field names, not the raw
  // DTO totals) — narrower than `hasAnyOutcome` above, which also covers
  // counters the chart never draws (drafts, narratives, suppressions, ...).
  // Gates ONLY the chart panel, never the tile groups or the page EmptyState.
  const hasChartOutcome = useMemo(
    () =>
      chartRows.some(
        (r) => r.noiseFlagged + r.alertsJudgedNet + r.ticketsTriaged + r.fixesExecuted > 0,
      ),
    [chartRows],
  );

  return (
    <div className="space-y-6" data-testid="ai-impact-page">
      <PageHeader
        testId="ai-impact-header"
        icon={<TrendingUp className="h-5 w-5" />}
        title={t('aiAgentsPage.impact.title')}
        description={t('aiAgentsPage.impact.description')}
        actions={
          // Two grouped units — "view controls" (window switcher, freshness,
          // refresh) and "actions" (export/edit weights or the overflow menu
          // that collapses them) — so a width squeeze wraps them as whole
          // blocks instead of splitting a single button off alone (the
          // "orphaned Edit weights at 1440px" review finding: the export
          // button is hidden whenever the window has no outcomes yet, which
          // left Edit weights as the SOLE item in its old flex-wrap slot).
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <div
              className="flex flex-wrap items-center gap-2"
              data-testid="ai-impact-view-controls"
            >
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

              {/* Freshness, labelled and kept next to the window switcher it
                  describes — it used to float unlabelled, disconnected from
                  the control that determines what "through" means. */}
              {dto && (
                <div
                  className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground"
                  data-testid="ai-impact-freshness-wrap"
                >
                  <span className="font-medium text-foreground">
                    {t('aiAgentsPage.impact.freshnessLabel')}
                  </span>
                  <span data-testid="ai-impact-freshness">
                    {dto.rebuiltAt
                      ? t('aiAgentsPage.impact.freshness', {
                          through: dto.through,
                          rebuiltAt: formatDateTime(dto.rebuiltAt),
                        })
                      : t('aiAgentsPage.impact.freshnessNeverRebuilt', { through: dto.through })}
                  </span>
                </div>
              )}

              <button
                type="button"
                data-testid="ai-impact-refresh"
                onClick={() => void handleRefresh()}
                disabled={poll !== null}
                aria-label={poll ? t('aiAgentsPage.impact.refreshing') : t('aiAgentsPage.impact.refresh')}
                className="inline-flex h-9 w-9 items-center justify-center rounded-md border hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw className={`h-4 w-4 ${poll ? 'animate-spin' : ''}`} />
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2" data-testid="ai-impact-actions">
              {/* Two secondary buttons at md+, collapsed into a single overflow
                  menu below md so the actions group never wraps to 2-3 rows. */}
              <div className="hidden items-center gap-2 md:flex">
                {/* Nothing to export on a window with zero outcomes — Edit weights
                    stays available even then, since there's still a methodology
                    to configure ahead of the first outcome. */}
                {dto && hasAnyOutcome && (
                  <button
                    type="button"
                    data-testid="ai-impact-export-pdf"
                    onClick={() => void handleExportPdf()}
                    className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted"
                  >
                    <Download className="h-4 w-4" />
                    {t('aiAgentsPage.impact.exportPdf')}
                  </button>
                )}

                {/* The server 403s a caller without canManagePartnerWidePolicies —
                    hiding the button for that case is a UX convenience, not the
                    real gate. */}
                {dto?.canEditWeights && (
                  <button
                    type="button"
                    data-testid="ai-impact-edit-weights"
                    onClick={() => setWeightsDrawerOpen(true)}
                    className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted"
                  >
                    <Settings2 className="h-4 w-4" />
                    {t('aiAgentsPage.impact.editWeights')}
                  </button>
                )}
              </div>

              {dto && (hasAnyOutcome || dto.canEditWeights) && (
                <details ref={overflowMenuRef} className="relative md:hidden">
                  <summary
                    data-testid="ai-impact-overflow-menu"
                    aria-label={t('aiAgentsPage.impact.moreActions')}
                    className="flex h-9 w-9 cursor-pointer list-none items-center justify-center rounded-md border hover:bg-muted [&::-webkit-details-marker]:hidden"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </summary>
                  <div className="absolute right-0 z-10 mt-1 w-56 rounded-md border bg-popover p-1 shadow-md">
                    {hasAnyOutcome && (
                      <button
                        type="button"
                        data-testid="ai-impact-export-pdf-overflow"
                        onClick={() => {
                          closeOverflowMenu();
                          void handleExportPdf();
                        }}
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                      >
                        <Download className="h-4 w-4" />
                        {t('aiAgentsPage.impact.exportPdf')}
                      </button>
                    )}
                    {dto.canEditWeights && (
                      <button
                        type="button"
                        data-testid="ai-impact-edit-weights-overflow"
                        onClick={() => {
                          closeOverflowMenu();
                          setWeightsDrawerOpen(true);
                        }}
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                      >
                        <Settings2 className="h-4 w-4" />
                        {t('aiAgentsPage.impact.editWeights')}
                      </button>
                    )}
                  </div>
                </details>
              )}
            </div>
          </div>
        }
      />

      <ImpactWeightsDrawer
        open={weightsDrawerOpen}
        effective={weights}
        overrides={dto?.weights.overrides ?? null}
        counters={dto?.totals ?? ZERO_IMPACT_COUNTERS}
        onClose={() => setWeightsDrawerOpen(false)}
        onSaved={handleWeightsSaved}
      />

      {/* aria-live so a screen reader announces the loading -> loaded/error
          transition, same as RunsListPage's async status region. */}
      <div aria-live="polite">
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
      </div>

      {!loading && !error && dto && (
        <>
          {hasAnyOutcome && (
            <div className="space-y-4">
              <div>
                <h2 className="mb-2 text-sm font-semibold text-muted-foreground">
                  {t('aiAgentsPage.impact.tileGroups.judged')}
                </h2>
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
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
                </div>
              </div>

              <div>
                <h2 className="mb-2 text-sm font-semibold text-muted-foreground">
                  {t('aiAgentsPage.impact.tileGroups.executed')}
                </h2>
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
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
                    value={estTimeSavedLabel(t, dto.totals.estSecondsSaved)}
                    caption={t('aiAgentsPage.impact.tiles.estTimeSavedCaption')}
                    disclosure={
                      <details
                        data-testid="ai-impact-est-seconds-saved-disclosure"
                        className="mt-1 text-xs text-muted-foreground"
                      >
                        <summary className="cursor-pointer select-none hover:text-foreground">
                          {t('aiAgentsPage.impact.tiles.howEstimatedToggle')}
                        </summary>
                        <p className="mt-1">{t('aiAgentsPage.impact.weightsTooltipTitle')}</p>
                        <ul className="mt-1 space-y-0.5">
                          {IMPACT_WEIGHT_KEYS.map((key) => (
                            <li key={key}>
                              {t('aiAgentsPage.impact.weightsTooltipLine', {
                                label: weightLabel(t, key),
                                // maximumFractionDigits: 2 — see the PDF row
                                // builder's comment; this disclosure must
                                // agree with the editor's own round-trip
                                // precision, not silently disagree at 1 digit.
                                minutes: formatNumber(weights[key] / 60, {
                                  maximumFractionDigits: 2,
                                }),
                              })}
                            </li>
                          ))}
                        </ul>
                      </details>
                    }
                  />
                  <Tile
                    testId="ai-impact-tile-llm-cents"
                    label={t('aiAgentsPage.impact.tiles.llmSpend')}
                    value={formatCurrency(dto.totals.llmCents / 100)}
                  />
                  {/* P2-6b: a nudge, not a list — the graduation panel re-derives state per
                      read, so the exact rows live there and this only ever links to them. */}
                  {dto.promoteEligibleCount !== null && (
                    <Tile
                      testId="ai-impact-tile-promote-eligible"
                      label={t('aiAgentsPage.impact.tiles.promoteEligible')}
                      value={formatNumber(dto.promoteEligibleCount)}
                      caption={t('aiAgentsPage.impact.tiles.promoteEligibleCaption')}
                      href="/settings/ai-agents"
                    />
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Freshness now lives in the header, beside the window switcher —
              see ai-impact-freshness-wrap. Positive feedback is a separate
              signal (supervision rate, not data recency) and keeps its own
              line here. */}
          {dto.positiveFeedback.rate !== null && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
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
            </div>
          )}

          {hasAnyOutcome ? (
            hasChartOutcome ? (
              <div className="rounded-lg border p-4">
                <h2 className="mb-3 text-sm font-semibold">{t('aiAgentsPage.impact.chart.title')}</h2>
                <div className="ai-impact-chart-fills h-72" data-testid="ai-impact-chart">
                  <style>{AI_IMPACT_CHART_FILL_CSS}</style>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartRows}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis
                        dataKey="day"
                        tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                      />
                      <YAxis
                        tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                        allowDecimals={false}
                      />
                      <Tooltip wrapperClassName="chart-tooltip" />
                      <Legend wrapperStyle={{ color: 'hsl(var(--muted-foreground))' }} />
                      {/* Categorical hues chosen to be distinct from status semantics
                          (danger/warning/success/info) — "noise flagged" in particular
                          must never be amber, since amber means warning everywhere else
                          in the product. */}
                      <Bar
                        stackId="outcomes"
                        dataKey="noiseFlagged"
                        name={t('aiAgentsPage.impact.chart.noiseFlagged')}
                        fill="hsl(var(--ai-impact-chart-noise))"
                      />
                      <Bar
                        stackId="outcomes"
                        dataKey="alertsJudgedNet"
                        name={t('aiAgentsPage.impact.chart.alertsJudgedNet')}
                        fill="hsl(var(--ai-impact-chart-judged))"
                      />
                      <Bar
                        stackId="outcomes"
                        dataKey="ticketsTriaged"
                        name={t('aiAgentsPage.impact.chart.ticketsTriaged')}
                        fill="hsl(var(--ai-impact-chart-tickets))"
                      />
                      <Bar
                        stackId="outcomes"
                        dataKey="fixesExecuted"
                        name={t('aiAgentsPage.impact.chart.fixesExecuted')}
                        fill="hsl(var(--ai-impact-chart-fixes))"
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            ) : (
              // hasAnyOutcome but NOT hasChartOutcome: e.g. a drafts-only or
              // narrative-only agent — real activity, just none of the four
              // series the bar chart stacks. A lighter inline message, not
              // the page EmptyState (the tile groups above already show the
              // real numbers, so this is not an empty page).
              <div
                className="rounded-lg border p-4 text-center text-sm text-muted-foreground"
                data-testid="ai-impact-chart-empty"
              >
                {t('aiAgentsPage.impact.chart.empty')}
              </div>
            )
          ) : (
            <EmptyState
              testId="ai-impact-empty"
              icon={<TrendingUp className="h-7 w-7" />}
              title={t('aiAgentsPage.impact.emptyState.title')}
              description={t('aiAgentsPage.impact.emptyState.description')}
              headingLevel={2}
              action={
                <a
                  href="/settings/ai-agents"
                  data-testid="ai-impact-empty-action"
                  className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
                >
                  {t('aiAgentsPage.impact.emptyState.action')}
                </a>
              }
            />
          )}

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
                          {estTimeSavedLabel(t, row.estSecondsSaved)}
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
