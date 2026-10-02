import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AI_QUALITY_GROUP_BYS, AI_USAGE_GROUP_BYS, type AiSurface, type AiUsageBreakdownDto, type AiUsageRowDto } from '@breeze/shared';
import { fetchWithAuth } from '../../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/i18n/format';
import { useHashState } from '@/lib/useHashState';
import { SURFACE_LABEL_KEYS } from './surfaceLabels';
import AiQualityTable from './AiQualityTable';

type SpendGroupBy = (typeof AI_USAGE_GROUP_BYS)[number];
type QualityGroupBy = (typeof AI_QUALITY_GROUP_BYS)[number];
type View = 'spend' | 'quality';
type Tab = { view: 'spend'; groupBy: SpendGroupBy } | { view: 'quality'; groupBy: QualityGroupBy };

const SPEND_PREFIX = 'usage-by-';
const QUALITY_PREFIX = 'quality-by-';
const DEFAULT_TAB: Tab = { view: 'spend', groupBy: 'model' };

// Literal key maps: the i18n keyUsage test cannot check template keys.
const GROUP_LABEL_KEYS: Record<SpendGroupBy, string> = {
  model: 'aiModels.usage.groupBy.model',
  surface: 'aiModels.usage.groupBy.surface',
  user: 'aiModels.usage.groupBy.user',
  org: 'aiModels.usage.groupBy.org',
};
const QUALITY_GROUP_LABEL_KEYS: Record<QualityGroupBy, string> = {
  model: 'aiModels.quality.groupBy.model',
  surface: 'aiModels.quality.groupBy.surface',
  prompt_profile: 'aiModels.quality.groupBy.prompt_profile',
};

/**
 * useHashState parser (the raw hash arrives without '#'): `usage-by-<g>` is
 * the Spend view (W04), `quality-by-<g>` the Quality view (W11). Anything
 * else falls back to the default.
 */
export const tabFromHash = (hash: string): Tab | undefined => {
  if (hash.startsWith(SPEND_PREFIX)) {
    const g = hash.slice(SPEND_PREFIX.length);
    return (AI_USAGE_GROUP_BYS as readonly string[]).includes(g) ? { view: 'spend', groupBy: g as SpendGroupBy } : undefined;
  }
  if (hash.startsWith(QUALITY_PREFIX)) {
    const g = hash.slice(QUALITY_PREFIX.length);
    return (AI_QUALITY_GROUP_BYS as readonly string[]).includes(g) ? { view: 'quality', groupBy: g as QualityGroupBy } : undefined;
  }
  return undefined;
};
const hashOf = (tab: Tab): string => `${tab.view === 'spend' ? SPEND_PREFIX : QUALITY_PREFIX}${tab.groupBy}`;

const formatRefusals = (r: Pick<AiUsageRowDto, 'refusals' | 'refusalRate'>) =>
  `${formatNumber(r.refusals)} (${formatPercent(r.refusalRate, { maximumFractionDigits: 1 })})`;

/**
 * AI usage from the invocation ledger, in two views: Spend (W04: spend and
 * refusals by served model / feature / technician / organization) and Quality
 * (W11: how conversations went, by chosen model / feature / model family).
 * Read-only. The view and grouping live in the URL hash; the date range
 * defaults to month-to-date (the API applies it when none is sent).
 */
export default function AiUsageBreakdown({ orgId }: { orgId: string | null }) {
  const { t } = useTranslation('settings');
  // SSR-safe: starts at the default, adopts the hash pre-paint and follows hashchange.
  const [tab, setTab] = useHashState<Tab>(DEFAULT_TAB, tabFromHash);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState<AiUsageBreakdownDto | null>(null);
  const [qualityRange, setQualityRange] = useState<{ from: string; to: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const spendGroup: SpendGroupBy = tab.view === 'spend' ? tab.groupBy : 'model';

  useEffect(() => {
    if (tab.view !== 'spend') return;
    // The first commit renders the SSR default before useHashState adopts a
    // deep-linked hash; skip that request rather than fire a wasted one.
    const linked = tabFromHash(window.location.hash.replace(/^#/, '')) ?? DEFAULT_TAB;
    if (linked.view !== tab.view || linked.groupBy !== tab.groupBy) return;
    let cancelled = false;
    const params = new URLSearchParams({ groupBy: tab.groupBy });
    if (orgId) params.set('orgId', orgId);
    // The API requires both ends or neither; neither = month-to-date.
    if (from && to) { params.set('from', from); params.set('to', to); }
    setLoading(true);
    setFailed(false);
    (async () => {
      try {
        const res = await fetchWithAuth(`/ai/models/usage?${params.toString()}`);
        if (res.status === 401) { void navigateTo('/login', { replace: true }); return; }
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as AiUsageBreakdownDto;
        if (!Array.isArray(body.rows) || !body.totals) throw new Error('malformed');
        if (!cancelled) setData(body);
      } catch (err) {
        console.error('[AiUsageBreakdown] failed to load /ai/models/usage', err);
        if (!cancelled) { setFailed(true); setData(null); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [tab.view, tab.groupBy, orgId, from, to]);

  const select = (next: Tab) => {
    setTab(next);
    window.location.hash = hashOf(next);
  };
  const selectView = (view: View) => {
    if (view === tab.view) return;
    select(view === 'spend' ? { view: 'spend', groupBy: 'model' } : { view: 'quality', groupBy: 'model' });
  };

  const shown = tab.view === 'spend' ? (data ? { from: data.from, to: data.to } : null) : qualityRange;
  // Choosing one end pins the other to what is currently shown, so a range is always complete.
  const setRange = (next: { from?: string; to?: string }) => {
    setFrom(next.from ?? (from || shown?.from || ''));
    setTo(next.to ?? (to || shown?.to || ''));
  };

  const labelOf = (row: AiUsageRowDto): string => {
    if (spendGroup === 'surface') {
      const key = SURFACE_LABEL_KEYS[row.key as AiSurface];
      return key ? t(/* i18n-dynamic */ key) : row.label;
    }
    if (spendGroup === 'user' && row.key === 'system') return t('aiModels.usage.system');
    return row.label || row.key;
  };

  const quality = tab.view === 'quality';
  const viewButton = (v: View, label: string) => (
    <button
      key={v}
      type="button"
      aria-pressed={tab.view === v}
      data-testid={`ai-usage-view-${v}`}
      onClick={() => selectView(v)}
      className={`px-3 py-1 text-sm ${tab.view === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
    >
      {label}
    </button>
  );

  return (
    <div className="rounded-lg border bg-card" data-testid="ai-usage-breakdown">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-4">
        <div>
          <h2 className="text-lg font-semibold">{quality ? t('aiModels.quality.title') : t('aiModels.usage.title')}</h2>
          <p className="text-sm text-muted-foreground">
            {quality
              ? (orgId ? t('aiModels.quality.subtitleOrg') : t('aiModels.quality.subtitleAll'))
              : (orgId ? t('aiModels.usage.subtitleOrg') : t('aiModels.usage.subtitleAll'))}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <div role="group" aria-label={t('aiModels.usage.view.label')} className="inline-flex overflow-hidden rounded-md border">
            {viewButton('spend', t('aiModels.usage.view.spend'))}
            {viewButton('quality', t('aiModels.usage.view.quality'))}
          </div>
          <label className="flex items-center gap-1 text-muted-foreground">
            {t('aiModels.usage.from')}
            <input
              type="date"
              data-testid="ai-usage-range-from"
              value={from || shown?.from || ''}
              onChange={(e) => setRange({ from: e.target.value })}
              className="rounded-md border bg-background px-2 py-1 text-sm text-foreground"
            />
          </label>
          <label className="flex items-center gap-1 text-muted-foreground">
            {t('aiModels.usage.to')}
            <input
              type="date"
              data-testid="ai-usage-range-to"
              value={to || shown?.to || ''}
              onChange={(e) => setRange({ to: e.target.value })}
              className="rounded-md border bg-background px-2 py-1 text-sm text-foreground"
            />
          </label>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 border-b px-6 py-2" role="tablist" aria-label={t('aiModels.usage.groupByLabel')}>
        {tab.view === 'spend'
          ? AI_USAGE_GROUP_BYS.map((g) => (
            <button
              key={g}
              type="button"
              role="tab"
              aria-selected={tab.groupBy === g}
              data-testid={`ai-usage-groupby-${g}`}
              onClick={() => select({ view: 'spend', groupBy: g })}
              className={`rounded-md px-3 py-1.5 text-sm ${tab.groupBy === g ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
            >
              {t(/* i18n-dynamic */ GROUP_LABEL_KEYS[g])}
            </button>
          ))
          : AI_QUALITY_GROUP_BYS.map((g) => (
            <button
              key={g}
              type="button"
              role="tab"
              aria-selected={tab.groupBy === g}
              data-testid={`ai-quality-groupby-${g}`}
              onClick={() => select({ view: 'quality', groupBy: g })}
              className={`rounded-md px-3 py-1.5 text-sm ${tab.groupBy === g ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
            >
              {t(/* i18n-dynamic */ QUALITY_GROUP_LABEL_KEYS[g])}
            </button>
          ))}
      </div>

      {tab.view === 'quality' ? (
        <AiQualityTable groupBy={tab.groupBy} orgId={orgId} from={from} to={to} onRange={setQualityRange} />
      ) : failed ? (
        <p className="px-6 py-6 text-sm text-destructive" data-testid="ai-usage-breakdown-error">{t('aiModels.usage.error')}</p>
      ) : loading && !data ? (
        <p className="px-6 py-6 text-sm text-muted-foreground">{t('aiModels.usage.loading')}</p>
      ) : data && data.rows.length === 0 ? (
        <p className="px-6 py-6 text-sm text-muted-foreground" data-testid="ai-usage-breakdown-empty">{t('aiModels.usage.empty')}</p>
      ) : data ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="ai-usage-breakdown-table">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="px-6 py-2 font-medium">{t(/* i18n-dynamic */ GROUP_LABEL_KEYS[spendGroup])}</th>
                <th className="px-3 py-2 text-right font-medium">{t('aiModels.usage.calls')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('aiModels.usage.cost')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('aiModels.usage.inputTokens')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('aiModels.usage.outputTokens')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('aiModels.usage.refusals')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('aiModels.usage.fallbacks')}</th>
                <th className="px-6 py-2 text-right font-medium" data-testid="ai-usage-col-failovers" title={t('aiModels.usage.failoversHelp')}>
                  {t('aiModels.usage.failovers')}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.key} className="border-b last:border-0" data-testid={`ai-usage-breakdown-row-${r.key}`}>
                  <td className="px-6 py-2">
                    {labelOf(r)}
                    {spendGroup === 'model' && r.connectionDisconnected && (
                      <span
                        data-testid={`ai-usage-breakdown-disconnected-${r.key}`}
                        title={t('aiModels.usage.disconnectedHint')}
                        className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                      >
                        {t('aiModels.usage.disconnected')}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatNumber(r.invocations)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(r.costCents / 100)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatNumber(r.inputTokens)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatNumber(r.outputTokens)}</td>
                  <td className="px-3 py-2 text-right tabular-nums" data-testid={`ai-usage-breakdown-refusals-${r.key}`}>{formatRefusals(r)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatNumber(r.fallbacks)}</td>
                  <td className="px-6 py-2 text-right tabular-nums" data-testid={`ai-usage-breakdown-failovers-${r.key}`}>{formatNumber(r.failovers)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t font-medium" data-testid="ai-usage-breakdown-totals">
                <td className="px-6 py-2">{t('aiModels.usage.total')}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatNumber(data.totals.invocations)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(data.totals.costCents / 100)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatNumber(data.totals.inputTokens)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatNumber(data.totals.outputTokens)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatRefusals(data.totals)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatNumber(data.totals.fallbacks)}</td>
                <td className="px-6 py-2 text-right tabular-nums">{formatNumber(data.totals.failovers)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : null}
      <p className="border-t px-6 py-3 text-xs text-muted-foreground">{quality ? t('aiModels.quality.footnote') : t('aiModels.usage.footnote')}</p>
    </div>
  );
}
