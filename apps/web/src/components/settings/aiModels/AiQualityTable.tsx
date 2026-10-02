import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AiQualityBreakdownDto, AiQualityGroupBy, AiQualityMetricsDto, AiQualityRowDto, AiSurface, PromptProfile } from '@breeze/shared';
import { fetchWithAuth } from '../../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/i18n/format';
import { SURFACE_LABEL_KEYS } from './surfaceLabels';

/** Below this many conversations a row is marked as too small to read much into. */
export const QUALITY_FEW_CONVERSATIONS = 20;

// Literal key maps: the i18n keyUsage test cannot check template keys.
const PROFILE_LABEL_KEYS: Record<PromptProfile, string> = {
  'claude-frontier': 'aiModels.quality.profiles.claude-frontier',
  'claude-standard': 'aiModels.quality.profiles.claude-standard',
  'claude-small': 'aiModels.quality.profiles.claude-small',
  generic: 'aiModels.quality.profiles.generic',
};

const GROUP_HEADER_KEYS: Record<AiQualityGroupBy, string> = {
  model: 'aiModels.quality.groupBy.model',
  surface: 'aiModels.quality.groupBy.surface',
  prompt_profile: 'aiModels.quality.groupBy.prompt_profile',
};

const COLUMNS = [
  ['conversations', 'aiModels.quality.columns.conversations', 'aiModels.quality.help.conversations'],
  ['costPerConversation', 'aiModels.quality.columns.costPerConversation', 'aiModels.quality.help.costPerConversation'],
  ['refusal', 'aiModels.quality.columns.refusalRate', 'aiModels.quality.help.refusalRate'],
  ['failover', 'aiModels.quality.columns.failoverRate', 'aiModels.quality.help.failoverRate'],
  ['flag', 'aiModels.quality.columns.flagRate', 'aiModels.quality.help.flagRate'],
  ['left', 'aiModels.quality.columns.leftRate', 'aiModels.quality.help.leftRate'],
  ['turns', 'aiModels.quality.columns.turnsToResolution', 'aiModels.quality.help.turnsToResolution'],
  ['agents', 'aiModels.quality.columns.agentCompletion', 'aiModels.quality.help.agentCompletion'],
] as const;

const pct = (v: number) => formatPercent(v, { maximumFractionDigits: 1 });

/**
 * The Quality view of the AI usage card (W11): per model, feature or model
 * family, how conversations went. Read-only. The parent owns the date range
 * and the grouping (in the URL hash); this component fetches and renders.
 */
export default function AiQualityTable({ groupBy, orgId, from, to, onRange }: {
  groupBy: AiQualityGroupBy;
  orgId: string | null;
  from: string;
  to: string;
  /** Reports the range the API resolved (month-to-date when none was sent). */
  onRange: (range: { from: string; to: string }) => void;
}) {
  const { t } = useTranslation('settings');
  const [data, setData] = useState<AiQualityBreakdownDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<'failed' | 'timeout' | null>(null);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ groupBy });
    if (orgId) params.set('orgId', orgId);
    if (from && to) { params.set('from', from); params.set('to', to); }
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetchWithAuth(`/ai/models/usage/quality?${params.toString()}`);
        if (res.status === 401) { void navigateTo('/login', { replace: true }); return; }
        if (res.status === 503) {
          const body = (await res.json().catch(() => null)) as { code?: string } | null;
          if (body?.code === 'quality_timeout') {
            if (!cancelled) { setError('timeout'); setData(null); }
            return;
          }
        }
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as AiQualityBreakdownDto;
        if (!Array.isArray(body.rows) || !body.totals || !body.sources) throw new Error('malformed');
        if (!cancelled) { setData(body); onRange({ from: body.from, to: body.to }); }
      } catch (err) {
        console.error('[AiQualityTable] failed to load /ai/models/usage/quality', err);
        if (!cancelled) { setError('failed'); setData(null); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // onRange is the parent's state setter (stable).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupBy, orgId, from, to]);

  const labelOf = (row: AiQualityRowDto): string => {
    if (groupBy === 'surface') {
      const key = SURFACE_LABEL_KEYS[row.key as AiSurface];
      return key ? t(/* i18n-dynamic */ key) : row.key;
    }
    if (groupBy === 'prompt_profile') {
      if (row.key === 'unrecorded') return t('aiModels.quality.unrecorded');
      const key = PROFILE_LABEL_KEYS[row.key as PromptProfile];
      return key ? t(/* i18n-dynamic */ key) : row.key;
    }
    if (row.key === 'unattributed') return t('aiModels.quality.unattributed');
    return `${row.label ?? t('aiModels.quality.removedModel')} · ${row.connectionName ?? t('aiModels.quality.platformConnection')}`;
  };

  const notRecorded = t('aiModels.quality.notRecorded');
  const dash = (hint?: string) => <span title={hint}>—</span>;
  const sub = (text: string) => <span className="block text-xs text-muted-foreground">{text}</span>;

  const cells = (m: AiQualityMetricsDto, key: string) => (
    <>
      <td className="px-3 py-2 text-right tabular-nums">
        {formatNumber(m.conversations)}
        {m.conversations > 0 && m.conversations < QUALITY_FEW_CONVERSATIONS && (
          <span className="block text-xs text-muted-foreground" data-testid={`ai-quality-few-${key}`}>{t('aiModels.quality.few')}</span>
        )}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{m.costPerConversationCents === null ? dash() : formatCurrency(m.costPerConversationCents / 100)}</td>
      <td className="px-3 py-2 text-right tabular-nums" data-testid={`ai-quality-refusal-${key}`}>{pct(m.refusalRate)}</td>
      <td className="px-3 py-2 text-right tabular-nums" data-testid={`ai-quality-failover-${key}`}>
        {m.failoverRate === null ? dash(m.failovers === null ? notRecorded : undefined) : pct(m.failoverRate)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums" data-testid={`ai-quality-flag-${key}`}>
        {m.flagRate === null ? dash() : pct(m.flagRate)}
        {m.autoFlagged > 0 && sub(t('aiModels.quality.autoFlagged', { count: m.autoFlagged }))}
      </td>
      <td
        className="px-3 py-2 text-right tabular-nums"
        data-testid={`ai-quality-left-${key}`}
        title={t('aiModels.quality.leftBreakdown', { switched: m.switchedAway, continued: m.continued ?? 0 })}
      >
        {m.leftRate === null ? dash() : pct(m.leftRate)}
        {m.continued === null && sub(t('aiModels.quality.switchesOnly'))}
      </td>
      <td className="px-3 py-2 text-right tabular-nums" data-testid={`ai-quality-turns-${key}`}>
        {m.medianTurnsToResolution === null ? dash() : formatNumber(m.medianTurnsToResolution)}
        {m.resolvedSessions > 0 && sub(t('aiModels.quality.resolvedCount', { count: m.resolvedSessions }))}
      </td>
      <td className="px-6 py-2 text-right tabular-nums" data-testid={`ai-quality-agents-${key}`}>
        {m.agentCompletionRate === null ? dash() : pct(m.agentCompletionRate)}
      </td>
    </>
  );

  return (
    <div data-testid="ai-quality-breakdown">
      {error === 'timeout' ? (
        <p className="px-6 py-6 text-sm text-destructive" data-testid="ai-quality-timeout">{t('aiModels.quality.timeout')}</p>
      ) : error ? (
        <p className="px-6 py-6 text-sm text-destructive" data-testid="ai-quality-error">{t('aiModels.quality.error')}</p>
      ) : loading && !data ? (
        <p className="px-6 py-6 text-sm text-muted-foreground">{t('aiModels.quality.loading')}</p>
      ) : data && data.rows.length === 0 ? (
        <p className="px-6 py-6 text-sm text-muted-foreground" data-testid="ai-quality-empty">{t('aiModels.quality.empty')}</p>
      ) : data ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="ai-quality-table">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="px-6 py-2 font-medium">{t(/* i18n-dynamic */ GROUP_HEADER_KEYS[groupBy])}</th>
                {COLUMNS.map(([id, label, help]) => (
                  <th key={id} className="px-3 py-2 text-right font-medium" title={t(/* i18n-dynamic */ help)}>{t(/* i18n-dynamic */ label)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.key} className="border-b last:border-0" data-testid={`ai-quality-row-${r.key}`}>
                  <td className="px-6 py-2">{labelOf(r)}</td>
                  {cells(r, r.key)}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t font-medium" data-testid="ai-quality-totals">
                <td className="px-6 py-2">{t('aiModels.usage.total')}</td>
                {cells(data.totals, 'total')}
              </tr>
            </tfoot>
          </table>
        </div>
      ) : null}
    </div>
  );
}
