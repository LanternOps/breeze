import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { FlowAdmissionRefusal, FlowUsageDto } from '@breeze/shared';
import { formatDateTime, formatRelativeTime } from '@/lib/dateTimeFormat';
import { cn } from '@/lib/utils';

type Level = 'ok' | 'high' | 'full';

function levelOf(used: number, cap: number): Level {
  if (cap <= 0 || used >= cap) return 'full';
  return used / cap >= 0.9 ? 'high' : 'ok';
}

const BAR: Record<Level, string> = {
  ok: 'bg-primary',
  high: 'bg-amber-500',
  full: 'bg-destructive',
};

function Bar({ id, label, used, cap }: { id: string; label: string; used: number; cap: number }) {
  const { t, i18n } = useTranslation('flows');
  const level = levelOf(used, cap);
  const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 100;
  const fmt = (n: number) => n.toLocaleString(i18n.language || undefined);
  return (
    <div className="space-y-1" data-testid={`flow-usage-${id}`}>
      <div className="flex justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span>{t('usage.count', { used: fmt(used), cap: fmt(cap) })}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={cap} aria-valuenow={used} aria-label={label}>
        <div className={cn('h-full', BAR[level])} style={{ width: `${pct}%` }} data-level={level} data-testid={`flow-usage-${id}-bar`} />
      </div>
    </div>
  );
}

/**
 * This month's run counts against the effective caps (Tool Catalog W05 #5220,
 * Decision 15). Counts are exact (charged with the run insert); the caps come
 * from `resolveFlowLimits` and are edited on the Flow limits settings page.
 */
export function FlowUsageMeter({ usage }: { usage: FlowUsageDto }) {
  const { t } = useTranslation('flows');
  return (
    <section className="max-w-md space-y-2" data-testid="flow-usage">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">{t('usage.title')}</h2>
        <span className="text-xs text-muted-foreground" data-testid="flow-usage-period">{t('usage.period', { period: usage.periodKey })}</span>
      </div>
      <Bar id="flow" label={t('usage.flowCap')} used={usage.flowRuns} cap={usage.flowCap} />
      <Bar id="owner" label={t('usage.ownerCap')} used={usage.ownerRuns} cap={usage.ownerCap} />
      <a className="text-xs text-primary hover:underline" href="/settings/flow-limits" data-testid="flow-usage-limits-link">
        {t('usage.limitsLink')}
      </a>
    </section>
  );
}

/**
 * The last admission refusal. A monthly cap refuses runs but never pauses the
 * flow (Decision 15), so the banner says the flow stays enabled.
 */
export function FlowRefusalBanner({ refusal }: { refusal: { at: string; code: FlowAdmissionRefusal } | null }) {
  const { t } = useTranslation('flows');
  if (!refusal) return null;
  return (
    <div role="status" className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200" data-testid="flow-refusal-banner">
      {t('usage.refusedBanner', {
        reason: t(/* i18n-dynamic */ `usage.refused.${refusal.code}`),
        time: formatRelativeTime(refusal.at, { fallback: formatDateTime(refusal.at) }),
      })}
    </div>
  );
}
