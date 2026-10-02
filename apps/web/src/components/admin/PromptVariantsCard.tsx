import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AiPromptVariantReportDto, AiPromptVariantState } from '@breeze/shared';
import { fetchWithAuth } from '@/stores/auth';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/i18n/format';
import '../../lib/i18n';

const STATE_KEYS: Record<AiPromptVariantState, string> = {
  staged: 'admin.aiModels.variants.states.staged',
  candidate: 'admin.aiModels.variants.states.candidate',
  active: 'admin.aiModels.variants.states.active',
  retired: 'admin.aiModels.variants.states.retired',
};
const pct = (v: number | null) => (v === null ? '—' : formatPercent(v, { maximumFractionDigits: 1 }));

/**
 * W11 (#7609): every registered prompt variant beside its base prompt,
 * measured across all partners (read-only). Variants change by PR; the
 * promotion bar is in docs/deploy/ai-prompt-variants.md.
 */
export default function PromptVariantsCard() {
  const { t } = useTranslation('admin');
  const [data, setData] = useState<AiPromptVariantReportDto | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithAuth('/admin/ai/prompt-variants');
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as AiPromptVariantReportDto;
        if (!Array.isArray(body.rows)) throw new Error('malformed');
        if (!cancelled) setData(body);
      } catch (err) {
        console.error('[PromptVariantsCard] failed to load /admin/ai/prompt-variants', err);
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <section className="rounded-lg border bg-white p-4" data-testid="prompt-variants-card">
      <h2 className="text-lg font-semibold">{t('admin.aiModels.variants.title')}</h2>
      <p className="mb-3 text-sm text-gray-600">
        {t('admin.aiModels.variants.subtitle')}
        {data && ` ${t('admin.aiModels.variants.range', { from: data.from, to: data.to })}`}
      </p>
      {failed ? (
        <p className="text-sm text-red-600" data-testid="prompt-variants-error">{t('admin.aiModels.variants.error')}</p>
      ) : !data ? (
        <p className="text-sm text-gray-500">{t('admin.aiModels.variants.loading')}</p>
      ) : data.rows.length === 0 ? (
        <p className="text-sm text-gray-500" data-testid="prompt-variants-empty">{t('admin.aiModels.variants.empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm" data-testid="prompt-variants-table">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-gray-500">
                <th className="px-3 py-2">{t('admin.aiModels.variants.columns.variant')}</th>
                <th className="px-3 py-2">{t('admin.aiModels.variants.columns.state')}</th>
                <th className="px-3 py-2 text-right">{t('admin.aiModels.variants.columns.conversations')}</th>
                <th className="px-3 py-2 text-right">{t('admin.aiModels.variants.columns.flagRate')}</th>
                <th className="px-3 py-2 text-right">{t('admin.aiModels.variants.columns.refusalRate')}</th>
                <th className="px-3 py-2 text-right">{t('admin.aiModels.variants.columns.leftRate')}</th>
                <th className="px-3 py-2 text-right">{t('admin.aiModels.variants.columns.turns')}</th>
                <th className="px-3 py-2 text-right">{t('admin.aiModels.variants.columns.costPerConversation')}</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.key} className="border-b last:border-0" data-testid={`prompt-variants-row-${r.key}`} title={r.variant?.hypothesis}>
                  <td className="px-3 py-2 font-mono text-xs">{r.variant ? r.key : `${r.surface}/${r.profile} — ${t('admin.aiModels.variants.base')}`}</td>
                  <td className="px-3 py-2">
                    {r.variant ? t(/* i18n-dynamic */ STATE_KEYS[r.variant.state]) : '—'}
                    {r.variant?.state === 'candidate' && ` · ${r.variant.canaryPercent}%`}
                    {r.incumbent && (
                      <span className="ml-1 rounded bg-gray-100 px-1 text-xs" data-testid={`prompt-variants-incumbent-${r.key}`}>
                        {t('admin.aiModels.variants.incumbent')}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatNumber(r.metrics.conversations)}
                    {r.lowSample && (
                      <span className="block text-xs text-amber-700" data-testid={`prompt-variants-low-${r.key}`}>
                        {t('admin.aiModels.variants.lowSample', { min: data.minConversations })}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{pct(r.metrics.flagRate)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{pct(r.metrics.refusalRate)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{pct(r.metrics.leftRate)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.metrics.medianTurnsToResolution === null ? '—' : formatNumber(r.metrics.medianTurnsToResolution)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.metrics.costPerConversationCents === null ? '—' : formatCurrency(r.metrics.costPerConversationCents / 100)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
