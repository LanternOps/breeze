/**
 * AI Scorecard W04 (#5761, refs #4182) — the ESTIMATE band of
 * `/ai-agents/impact`, lifted verbatim out of `ImpactPage.tsx` so the page can
 * host it beside the new measured band.
 *
 * Everything here is a DERIVED estimate (P2-6, #4193): counters multiplied by
 * per-outcome weights. It is never a measurement — that is what
 * `ImpactMeasuredBand` is for, and the two are visually separated for exactly
 * that reason.
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { ChevronRight, TrendingUp } from 'lucide-react';
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
import { formatCurrency, formatNumber, formatPercent } from '@/lib/i18n/format';
import { EmptyState } from '../shared/EmptyState';
import {
  AI_AGENT_IMPACT_BY_ORG_LIMIT,
  AI_AGENT_IMPACT_WINDOWS,
  IMPACT_WEIGHT_KEYS,
} from '@breeze/shared';
import type { AiAgentImpactDto, ImpactWeights } from '@breeze/shared';

// Type-only import: erased at compile time, so this is NOT a runtime cycle with
// ImpactPage, which renders this component.
import type { ImpactChartRow } from './ImpactPage';

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

/*
 * Label helpers shared with ImpactPage's PDF export. They live HERE rather than
 * in a standalone module so the i18n key-usage checker can infer the 'settings'
 * namespace from this file's own useTranslation call; ImpactPage imports them
 * from here, which keeps the page -> band dependency one-directional.
 */
export function estTimeSavedLabel(
  t: (key: string, opts?: Record<string, unknown>) => string,
  seconds: number,
): string {
  const hours = seconds / 3600;
  return t('aiAgentsPage.impact.tiles.estTimeSavedValue', {
    hours: formatNumber(hours, { maximumFractionDigits: 1 }),
    count: hours,
  });
}

export function weightLabel(t: (key: string) => string, key: (typeof IMPACT_WEIGHT_KEYS)[number]): string {
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

export interface ImpactEstimateBandProps {
  dto: AiAgentImpactDto;
  chartRows: ImpactChartRow[];
  /** True whenever any counter is non-zero: gates the tile groups. */
  hasAnyOutcome: boolean;
  /** Gates ONLY the chart panel, never the tile groups. */
  hasChartOutcome: boolean;
  weights: ImpactWeights;
}

export default function ImpactEstimateBand({
  dto,
  chartRows,
  hasAnyOutcome,
  hasChartOutcome,
  weights,
}: ImpactEstimateBandProps) {
  const { t } = useTranslation('settings');

  return (
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
      // At the widest window there is nowhere further to widen into — the
      // MEASURED band learned this same lesson for its own omission copy in
      // #5885 (`insufficient_data` vs `insufficient_followup`, classified on
      // `windowDays === MEASURED_MAX_WINDOW_DAYS`). Mirror it here: never
      // tell the user to widen a window that is already the widest one
      // available.
      description={
        dto.window === AI_AGENT_IMPACT_WINDOWS[AI_AGENT_IMPACT_WINDOWS.length - 1]
          ? t('aiAgentsPage.impact.emptyState.descriptionWidestWindow')
          : t('aiAgentsPage.impact.emptyState.description')
      }
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
  );
}
