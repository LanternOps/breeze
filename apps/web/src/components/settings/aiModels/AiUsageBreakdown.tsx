import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AI_USAGE_GROUP_BYS, type AiSurface, type AiUsageBreakdownDto, type AiUsageRowDto } from '@breeze/shared';
import { fetchWithAuth } from '../../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/i18n/format';
import { useHashState } from '@/lib/useHashState';
import { SURFACE_LABEL_KEYS } from './surfaceLabels';

type GroupBy = (typeof AI_USAGE_GROUP_BYS)[number];

const HASH_PREFIX = '#usage-by-';
const DEFAULT_GROUP: GroupBy = 'model';

// Literal key maps: the i18n keyUsage test cannot check template keys.
const GROUP_LABEL_KEYS: Record<GroupBy, string> = {
  model: 'aiModels.usage.groupBy.model',
  surface: 'aiModels.usage.groupBy.surface',
  user: 'aiModels.usage.groupBy.user',
  org: 'aiModels.usage.groupBy.org',
};

/** useHashState parser: the raw hash arrives without its leading '#'; anything else falls back to the default. */
const groupFromHash = (hash: string): GroupBy | undefined => {
  const prefix = HASH_PREFIX.slice(1);
  if (!hash.startsWith(prefix)) return undefined;
  const g = hash.slice(prefix.length);
  return (AI_USAGE_GROUP_BYS as readonly string[]).includes(g) ? (g as GroupBy) : undefined;
};

const formatRefusals = (r: Pick<AiUsageRowDto, 'refusals' | 'refusalRate'>) =>
  `${formatNumber(r.refusals)} (${formatPercent(r.refusalRate, { maximumFractionDigits: 1 })})`;

/**
 * Spend and refusal breakdown from the invocation ledger, grouped by served
 * model / feature / technician / organization. Read-only. The grouping lives in
 * the URL hash (#usage-by-*); the date range defaults to month-to-date (the API
 * applies that when no range is sent).
 */
export default function AiUsageBreakdown({ orgId }: { orgId: string | null }) {
  const { t } = useTranslation('settings');
  // SSR-safe: starts at the default, adopts the hash pre-paint and follows hashchange.
  const [groupBy, setGroupBy] = useHashState<GroupBy>(DEFAULT_GROUP, groupFromHash);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState<AiUsageBreakdownDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // The first commit renders the SSR default before useHashState adopts a
    // deep-linked #usage-by-*; skip that request rather than fire a wasted one.
    if ((groupFromHash(window.location.hash.replace(/^#/, '')) ?? DEFAULT_GROUP) !== groupBy) return;
    let cancelled = false;
    const params = new URLSearchParams({ groupBy });
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
  }, [groupBy, orgId, from, to]);

  const selectGroup = (g: GroupBy) => {
    setGroupBy(g);
    window.location.hash = `${HASH_PREFIX.slice(1)}${g}`;
  };

  // Choosing one end pins the other to what is currently shown, so a range is always complete.
  const setRange = (next: { from?: string; to?: string }) => {
    const nf = next.from ?? (from || data?.from || '');
    const nt = next.to ?? (to || data?.to || '');
    setFrom(nf);
    setTo(nt);
  };

  const labelOf = (row: AiUsageRowDto): string => {
    if (groupBy === 'surface') {
      const key = SURFACE_LABEL_KEYS[row.key as AiSurface];
      return key ? t(/* i18n-dynamic */ key) : row.label;
    }
    if (groupBy === 'user' && row.key === 'system') return t('aiModels.usage.system');
    return row.label || row.key;
  };

  return (
    <div className="rounded-lg border bg-card" data-testid="ai-usage-breakdown">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-4">
        <div>
          <h2 className="text-lg font-semibold">{t('aiModels.usage.title')}</h2>
          <p className="text-sm text-muted-foreground">{orgId ? t('aiModels.usage.subtitleOrg') : t('aiModels.usage.subtitleAll')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label className="flex items-center gap-1 text-muted-foreground">
            {t('aiModels.usage.from')}
            <input
              type="date"
              data-testid="ai-usage-range-from"
              value={from || data?.from || ''}
              onChange={(e) => setRange({ from: e.target.value })}
              className="rounded-md border bg-background px-2 py-1 text-sm text-foreground"
            />
          </label>
          <label className="flex items-center gap-1 text-muted-foreground">
            {t('aiModels.usage.to')}
            <input
              type="date"
              data-testid="ai-usage-range-to"
              value={to || data?.to || ''}
              onChange={(e) => setRange({ to: e.target.value })}
              className="rounded-md border bg-background px-2 py-1 text-sm text-foreground"
            />
          </label>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 border-b px-6 py-2" role="tablist" aria-label={t('aiModels.usage.groupByLabel')}>
        {AI_USAGE_GROUP_BYS.map((g) => (
          <button
            key={g}
            type="button"
            role="tab"
            aria-selected={groupBy === g}
            data-testid={`ai-usage-groupby-${g}`}
            onClick={() => selectGroup(g)}
            className={`rounded-md px-3 py-1.5 text-sm ${groupBy === g ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
          >
            {t(/* i18n-dynamic */ GROUP_LABEL_KEYS[g])}
          </button>
        ))}
      </div>

      {failed ? (
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
                <th className="px-6 py-2 font-medium">{t(/* i18n-dynamic */ GROUP_LABEL_KEYS[groupBy])}</th>
                <th className="px-3 py-2 text-right font-medium">{t('aiModels.usage.calls')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('aiModels.usage.cost')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('aiModels.usage.inputTokens')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('aiModels.usage.outputTokens')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('aiModels.usage.refusals')}</th>
                <th className="px-6 py-2 text-right font-medium">{t('aiModels.usage.fallbacks')}</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.key} className="border-b last:border-0" data-testid={`ai-usage-breakdown-row-${r.key}`}>
                  <td className="px-6 py-2">
                    {labelOf(r)}
                    {groupBy === 'model' && r.connectionDisconnected && (
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
                  <td className="px-6 py-2 text-right tabular-nums">{formatNumber(r.fallbacks)}</td>
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
                <td className="px-6 py-2 text-right tabular-nums">{formatNumber(data.totals.fallbacks)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : null}
      <p className="border-t px-6 py-3 text-xs text-muted-foreground">{t('aiModels.usage.footnote')}</p>
    </div>
  );
}
