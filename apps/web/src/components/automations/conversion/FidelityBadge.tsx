import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { FlowConversionFidelity, FlowConversionFinding } from '@breeze/shared';
import { cn } from '@/lib/utils';

const TONE: Record<FlowConversionFidelity, string> = {
  exact: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  needs_review: 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200',
  unconvertible: 'border-destructive/40 bg-destructive/10 text-destructive',
};

/**
 * "Move to Flows" fidelity (#5221 W06, plan Decision 10): Exact, Needs review,
 * or Can't move yet — the last always names its first blocker in words, never
 * a code.
 */
export function FidelityBadge({
  fidelity,
  findings = [],
}: {
  fidelity: FlowConversionFidelity;
  findings?: readonly FlowConversionFinding[];
}) {
  const { t } = useTranslation('flows');
  const blocker = fidelity === 'unconvertible' ? findings.find((f) => f.severity === 'blocker') : undefined;
  return (
    <span
      data-testid="conversion-fidelity-badge"
      data-fidelity={fidelity}
      className={cn('inline-flex max-w-xs items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium', TONE[fidelity])}
    >
      <span className="shrink-0">{t(/* i18n-dynamic */ `conversion.fidelity.${fidelity}`)}</span>
      {blocker && (
        <span className="truncate font-normal" data-testid="conversion-fidelity-blocker">
          {t('conversion.fidelityBlockerSeparator')}
          {t(/* i18n-dynamic */ `conversion.finding.${blocker.code}.title`)}
        </span>
      )}
    </span>
  );
}
